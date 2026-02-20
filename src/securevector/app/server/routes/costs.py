"""
Costs API endpoints for LLM cost tracking.

GET  /api/costs/summary          - Per-agent cost summaries
GET  /api/costs/records          - Paginated cost records
GET  /api/costs/pricing          - Model pricing reference
PUT  /api/costs/pricing/{p}/{m}  - Update a model's pricing
GET  /api/costs/export           - Export as CSV
GET  /api/costs/dashboard-summary - Compact widget for dashboard
POST /api/costs/pricing/sync     - On-demand sync from LiteLLM source
"""

import csv
import io
import logging
from datetime import datetime
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.costs import CostsRepository

logger = logging.getLogger(__name__)

router = APIRouter()

LITELLM_PRICING_URL = (
    "https://raw.githubusercontent.com/BerriAI/litellm/main/"
    "model_prices_and_context_window.json"
)

# Map LiteLLM provider keys → our provider names
LITELLM_PROVIDER_MAP = {
    "openai": "openai",
    "anthropic": "anthropic",
    "gemini": "gemini",
    "groq": "groq",
    "mistral": "mistral",
    "cohere": "cohere",
    "ollama": "ollama",
}


# --- Pydantic models ---

class AgentSummaryResponse(BaseModel):
    agent_id: str
    total_requests: int
    total_input_tokens: int
    total_output_tokens: int
    total_cost_usd: float
    providers_used: list[str]
    models_used: list[str]
    first_seen: Optional[str] = None
    last_seen: Optional[str] = None
    has_unknown_pricing: bool = False


class CostSummaryResponse(BaseModel):
    agents: list[AgentSummaryResponse]
    totals: dict
    period: dict
    cost_tracking_enabled: bool = True


class CostRecordResponse(BaseModel):
    id: str
    agent_id: str
    provider: str
    model_id: str
    input_tokens: int
    output_tokens: int
    input_cached_tokens: int = 0
    input_cost_usd: float
    output_cost_usd: float
    total_cost_usd: float
    pricing_known: bool
    recorded_at: str


class CostRecordsResponse(BaseModel):
    items: list[CostRecordResponse]
    total: int
    page: int
    page_size: int


class ModelPricingResponse(BaseModel):
    id: str
    provider: str
    model_id: str
    display_name: str
    input_per_million: float
    output_per_million: float
    effective_date: Optional[str] = None
    verified_at: Optional[str] = None
    source_url: Optional[str] = None
    updated_at: str
    is_stale: bool = False


class PricingListResponse(BaseModel):
    pricing: list[ModelPricingResponse]
    total: int
    providers: list[str]


class UpdatePricingRequest(BaseModel):
    input_per_million: float = Field(..., ge=0)
    output_per_million: float = Field(..., ge=0)
    effective_date: Optional[str] = None


class DashboardSummaryResponse(BaseModel):
    today_cost_usd: float
    today_requests: int
    top_agent: Optional[str] = None
    top_model: Optional[str] = None
    cost_tracking_enabled: bool = True
    has_unknown_pricing: bool = False


class SyncResponse(BaseModel):
    updated: int
    skipped: int
    source: str
    synced_at: str
    changes: list[dict]


class BudgetConfig(BaseModel):
    daily_budget_usd: Optional[float] = None
    budget_action: str = "warn"


class AgentBudgetEntry(BaseModel):
    agent_id: str
    daily_budget_usd: float
    budget_action: str = "warn"
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class BudgetStatusResponse(BaseModel):
    agent_id: str
    today_spend_usd: float
    global_budget_usd: Optional[float]
    agent_budget_usd: Optional[float]
    effective_budget_usd: Optional[float]
    budget_action: str
    over_budget: bool
    warning_threshold: float = 0.8


# --- Endpoints ---

@router.get("/costs/dashboard-summary", response_model=DashboardSummaryResponse)
async def get_dashboard_summary() -> DashboardSummaryResponse:
    """Compact cost summary for the main dashboard widget."""
    try:
        db = get_database()
        repo = CostsRepository(db)
        summary = await repo.get_dashboard_summary()
        return DashboardSummaryResponse(**summary, cost_tracking_enabled=True)
    except Exception as e:
        logger.error(f"Failed to get dashboard summary: {e}")
        return DashboardSummaryResponse(
            today_cost_usd=0.0,
            today_requests=0,
            cost_tracking_enabled=True,
        )


@router.get("/costs/summary", response_model=CostSummaryResponse)
async def get_cost_summary(
    start: Optional[str] = Query(None, description="ISO datetime start filter"),
    end: Optional[str] = Query(None, description="ISO datetime end filter"),
    limit: int = Query(50, ge=1, le=200),
) -> CostSummaryResponse:
    """Per-agent cost summaries."""
    try:
        db = get_database()
        repo = CostsRepository(db)

        start_dt = datetime.fromisoformat(start) if start else None
        end_dt = datetime.fromisoformat(end) if end else None

        agents = await repo.get_agent_summaries(start=start_dt, end=end_dt, limit=limit)

        total_cost = sum(a.total_cost_usd for a in agents)
        total_requests = sum(a.total_requests for a in agents)
        total_input = sum(a.total_input_tokens for a in agents)
        total_output = sum(a.total_output_tokens for a in agents)
        today_spend = await repo.get_today_spend()

        now = datetime.utcnow()
        period_start = start or now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat() + "Z"
        period_end = end or now.isoformat() + "Z"

        return CostSummaryResponse(
            agents=[
                AgentSummaryResponse(
                    agent_id=a.agent_id,
                    total_requests=a.total_requests,
                    total_input_tokens=a.total_input_tokens,
                    total_output_tokens=a.total_output_tokens,
                    total_cost_usd=a.total_cost_usd,
                    providers_used=a.providers_used,
                    models_used=a.models_used,
                    first_seen=a.first_seen,
                    last_seen=a.last_seen,
                    has_unknown_pricing=a.has_unknown_pricing,
                )
                for a in agents
            ],
            totals={
                "total_requests": total_requests,
                "total_cost_usd": round(total_cost, 4),
                "today_spend_usd": round(today_spend, 6),
                "total_input_tokens": total_input,
                "total_output_tokens": total_output,
            },
            period={"start": period_start, "end": period_end},
            cost_tracking_enabled=True,
        )
    except Exception as e:
        logger.error(f"Failed to get cost summary: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/costs/records", response_model=CostRecordsResponse)
async def list_cost_records(
    agent_id: Optional[str] = Query(None),
    provider: Optional[str] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
) -> CostRecordsResponse:
    """Paginated list of individual cost records."""
    try:
        db = get_database()
        repo = CostsRepository(db)

        start_dt = datetime.fromisoformat(start) if start else None
        end_dt = datetime.fromisoformat(end) if end else None

        records, total = await repo.list_records(
            agent_id=agent_id,
            provider=provider,
            start=start_dt,
            end=end_dt,
            page=page,
            page_size=page_size,
        )

        return CostRecordsResponse(
            items=[
                CostRecordResponse(
                    id=r.id,
                    agent_id=r.agent_id,
                    provider=r.provider,
                    model_id=r.model_id,
                    input_tokens=r.input_tokens,
                    output_tokens=r.output_tokens,
                    input_cached_tokens=r.input_cached_tokens,
                    input_cost_usd=r.input_cost_usd,
                    output_cost_usd=r.output_cost_usd,
                    total_cost_usd=r.total_cost_usd,
                    pricing_known=r.pricing_known,
                    recorded_at=r.recorded_at.isoformat() if r.recorded_at else "",
                )
                for r in records
            ],
            total=total,
            page=page,
            page_size=page_size,
        )
    except Exception as e:
        logger.error(f"Failed to list cost records: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/costs/pricing", response_model=PricingListResponse)
async def list_pricing(
    provider: Optional[str] = Query(None),
) -> PricingListResponse:
    """List all model pricing entries."""
    try:
        db = get_database()
        repo = CostsRepository(db)
        entries = await repo.list_pricing(provider=provider)

        stale_threshold = datetime.utcnow()
        providers = sorted({e.provider for e in entries})

        return PricingListResponse(
            pricing=[
                ModelPricingResponse(
                    id=e.id,
                    provider=e.provider,
                    model_id=e.model_id,
                    display_name=e.display_name,
                    input_per_million=e.input_per_million,
                    output_per_million=e.output_per_million,
                    effective_date=e.effective_date,
                    verified_at=e.verified_at,
                    source_url=e.source_url,
                    updated_at=e.updated_at.isoformat() if e.updated_at else "",
                    is_stale=(stale_threshold - e.updated_at).days > 30 if e.updated_at else False,
                )
                for e in entries
            ],
            total=len(entries),
            providers=providers,
        )
    except Exception as e:
        logger.error(f"Failed to list pricing: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/costs/pricing/{provider}/{model_id}", response_model=ModelPricingResponse)
async def update_model_pricing(
    provider: str,
    model_id: str,
    request: UpdatePricingRequest,
) -> ModelPricingResponse:
    """Update pricing rates for a specific model."""
    try:
        db = get_database()
        repo = CostsRepository(db)

        # Try to fetch display_name from existing entry; fall back to model_id
        existing = await repo.get_pricing(provider, model_id)
        display_name = existing.display_name if existing else model_id

        await repo.upsert_pricing(
            provider=provider,
            model_id=model_id,
            display_name=display_name,
            input_per_million=request.input_per_million,
            output_per_million=request.output_per_million,
            effective_date=request.effective_date,
            verified_at=datetime.utcnow().date().isoformat(),
        )

        updated = await repo.get_pricing(provider, model_id)
        if updated is None:
            raise HTTPException(status_code=500, detail=f"Failed to upsert pricing for {provider}/{model_id}")

        # Refresh CostRecorder cache if available
        try:
            from securevector.app.services.cost_recorder import CostRecorder
            # CostRecorder instances are per-proxy; signal cache invalidation via a marker
            # The proxy's CostRecorder will auto-refresh on next pricing miss
            pass
        except Exception:
            pass

        return ModelPricingResponse(
            id=updated.id,
            provider=updated.provider,
            model_id=updated.model_id,
            display_name=updated.display_name,
            input_per_million=updated.input_per_million,
            output_per_million=updated.output_per_million,
            effective_date=updated.effective_date,
            verified_at=updated.verified_at,
            source_url=updated.source_url,
            updated_at=updated.updated_at.isoformat() if updated.updated_at else "",
            is_stale=False,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update pricing: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class DeleteRecordsRequest(BaseModel):
    ids: Optional[list] = None


@router.delete("/costs/records")
async def delete_cost_records(
    agent_id: Optional[str] = Query(None, description="Delete only records for this agent ID"),
    body: Optional[DeleteRecordsRequest] = None,
) -> dict:
    """
    Delete request history records.
    If body.ids provided, deletes specific records by ID.
    If agent_id provided, deletes all records for that agent.
    Otherwise clears all records.
    """
    try:
        db = get_database()
        repo = CostsRepository(db)
        if body and body.ids:
            deleted = await repo.delete_records_by_ids(body.ids)
        else:
            deleted = await repo.delete_records(agent_id=agent_id)
        return {"deleted": deleted, "agent_id": agent_id}
    except Exception as e:
        logger.error(f"Failed to delete cost records: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/costs/export")
async def export_costs_csv(
    agent_id: Optional[str] = Query(None),
    provider: Optional[str] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
) -> StreamingResponse:
    """Export cost records as CSV."""
    try:
        db = get_database()
        repo = CostsRepository(db)

        start_dt = datetime.fromisoformat(start) if start else None
        end_dt = datetime.fromisoformat(end) if end else None

        # Fetch all (large limit for export)
        records, _ = await repo.list_records(
            agent_id=agent_id,
            provider=provider,
            start=start_dt,
            end=end_dt,
            page=1,
            page_size=10000,
        )

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow([
            "recorded_at", "agent_id", "provider", "model_id",
            "input_tokens", "output_tokens",
            "input_cost_usd", "output_cost_usd", "total_cost_usd", "pricing_known",
        ])
        for r in records:
            writer.writerow([
                r.recorded_at.isoformat() if r.recorded_at else "",
                r.agent_id, r.provider, r.model_id,
                r.input_tokens, r.output_tokens,
                r.input_cost_usd, r.output_cost_usd, r.total_cost_usd,
                "yes" if r.pricing_known else "no",
            ])

        date_str = datetime.utcnow().strftime("%Y-%m-%d")
        filename = f"sv-costs-{date_str}.csv"

        output.seek(0)
        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )
    except Exception as e:
        logger.error(f"Failed to export costs: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/costs/pricing/sync", response_model=SyncResponse)
async def sync_pricing_from_source() -> SyncResponse:
    """
    On-demand price sync.

    Phase 1 — YAML re-seed: Applies verified prices from model_pricing.yml
    (source-verified from official provider pages).

    Phase 2 — LiteLLM supplement: For any models NOT in YAML, fetches
    community data from LiteLLM as a best-effort addition.
    """
    import yaml
    from pathlib import Path

    try:
        db = get_database()
        repo = CostsRepository(db)

        existing = await repo.list_pricing()
        existing_map = {f"{e.provider}/{e.model_id}": e for e in existing}

        updated = 0
        skipped = 0
        changes = []
        now_str = datetime.utcnow().date().isoformat()
        yaml_model_keys: set[str] = set()

        # ── Phase 1: Re-apply YAML (source-verified prices) ────────────────
        pricing_paths = [
            Path(__file__).parent.parent.parent.parent.parent / "pricing" / "model_pricing.yml",
            Path(__file__).parent.parent.parent.parent / "pricing" / "model_pricing.yml",
            Path(__file__).parent.parent.parent / "pricing" / "model_pricing.yml",
        ]
        yaml_path = next((p for p in pricing_paths if p.exists()), None)

        if yaml_path:
            with open(yaml_path, "r", encoding="utf-8") as f:
                yaml_data = yaml.safe_load(f)

            for provider_entry in yaml_data.get("providers", []):
                provider = provider_entry.get("provider", "")
                if not provider:
                    continue
                for model in provider_entry.get("models", []):
                    model_id = model.get("model_id", "")
                    if not model_id:
                        continue
                    cache_key = f"{provider}/{model_id}"
                    yaml_model_keys.add(cache_key)
                    new_input = float(model.get("input_per_million", 0))
                    new_output = float(model.get("output_per_million", 0))
                    existing_entry = existing_map.get(cache_key)
                    old_input = existing_entry.input_per_million if existing_entry else 0.0
                    old_output = existing_entry.output_per_million if existing_entry else 0.0
                    await repo.upsert_pricing(
                        provider=provider,
                        model_id=model_id,
                        display_name=model.get("display_name", model_id),
                        input_per_million=new_input,
                        output_per_million=new_output,
                        effective_date=model.get("effective_date"),
                        verified_at=model.get("verified_at", now_str),
                        source_url=provider_entry.get("source_url"),
                    )
                    updated += 1
                    if abs(new_input - old_input) > 0.001 or abs(new_output - old_output) > 0.001:
                        changes.append({
                            "model_id": model_id,
                            "provider": provider,
                            "old_input": old_input,
                            "new_input": new_input,
                            "old_output": old_output,
                            "new_output": new_output,
                            "source": "yaml",
                        })

        # ── Phase 2: LiteLLM supplement (only for unlisted models) ─────────
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(LITELLM_PRICING_URL)
                if resp.status_code == 200:
                    pricing_data = resp.json()
                    for model_key, model_info in pricing_data.items():
                        if not isinstance(model_info, dict):
                            continue
                        litellm_provider = model_info.get("litellm_provider", "")
                        our_provider = LITELLM_PROVIDER_MAP.get(litellm_provider, "")
                        if not our_provider:
                            continue
                        cache_key = f"{our_provider}/{model_key}"
                        # Skip models already covered by YAML
                        if cache_key in yaml_model_keys:
                            skipped += 1
                            continue
                        # Skip models not in our DB at all
                        if cache_key not in existing_map:
                            skipped += 1
                            continue
                        inp = model_info.get("input_cost_per_token")
                        out = model_info.get("output_cost_per_token")
                        if inp is None or out is None:
                            skipped += 1
                            continue
                        new_input = float(inp) * 1_000_000
                        new_output = float(out) * 1_000_000
                        existing_entry = existing_map[cache_key]
                        await repo.upsert_pricing(
                            provider=our_provider,
                            model_id=model_key,
                            display_name=existing_entry.display_name,
                            input_per_million=round(new_input, 4),
                            output_per_million=round(new_output, 4),
                            verified_at=now_str,
                            source_url=existing_entry.source_url,
                        )
                        updated += 1
        except Exception as litellm_err:
            logger.warning(f"LiteLLM supplement fetch failed (non-fatal): {litellm_err}")

        logger.info(f"Pricing sync complete: {updated} updated, {skipped} skipped")

        return SyncResponse(
            updated=updated,
            skipped=skipped,
            source="yaml+litellm",
            synced_at=datetime.utcnow().isoformat() + "Z",
            changes=changes,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Pricing sync failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# --- Budget endpoints ---

@router.get("/costs/budget", response_model=BudgetConfig)
async def get_global_budget() -> BudgetConfig:
    """Get global daily budget settings."""
    try:
        db = get_database()
        repo = CostsRepository(db)
        data = await repo.get_global_budget()
        return BudgetConfig(**data)
    except Exception as e:
        logger.error(f"Failed to get global budget: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/costs/budget", response_model=BudgetConfig)
async def set_global_budget(request: BudgetConfig) -> BudgetConfig:
    """Update global daily budget settings."""
    try:
        if request.budget_action not in ("warn", "block"):
            raise HTTPException(status_code=422, detail="budget_action must be 'warn' or 'block'")
        db = get_database()
        repo = CostsRepository(db)
        await repo.set_global_budget(request.daily_budget_usd, request.budget_action)
        data = await repo.get_global_budget()

        # Sync to securevector.yml
        try:
            from securevector.app.utils.config_file import save_config
            from securevector.app.database.repositories.settings import SettingsRepository
            settings = await SettingsRepository(db).get()
            save_config(
                block_mode=settings.block_threats,
                output_scan=settings.scan_llm_responses,
                budget_warn=(request.budget_action == "warn"),
                budget_block=(request.budget_action == "block"),
                budget_daily_limit=request.daily_budget_usd,
                tools_enforcement=settings.tool_permissions_enabled,
            )
        except Exception as ce:
            logger.warning(f"Could not update securevector.yml: {ce}")

        return BudgetConfig(**data)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to set global budget: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/costs/budget/agents", response_model=list[AgentBudgetEntry])
async def list_agent_budgets() -> list[AgentBudgetEntry]:
    """List all per-agent budget overrides."""
    try:
        db = get_database()
        repo = CostsRepository(db)
        rows = await repo.list_agent_budgets()
        return [AgentBudgetEntry(**r) for r in rows]
    except Exception as e:
        logger.error(f"Failed to list agent budgets: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/costs/budget/agents/{agent_id}", response_model=AgentBudgetEntry)
async def set_agent_budget(agent_id: str, request: BudgetConfig) -> AgentBudgetEntry:
    """Set or update budget for a specific agent."""
    try:
        if request.daily_budget_usd is None or request.daily_budget_usd <= 0:
            raise HTTPException(status_code=422, detail="daily_budget_usd must be a positive number")
        if request.budget_action not in ("warn", "block"):
            raise HTTPException(status_code=422, detail="budget_action must be 'warn' or 'block'")
        db = get_database()
        repo = CostsRepository(db)
        await repo.set_agent_budget(agent_id, request.daily_budget_usd, request.budget_action)
        row = await repo.get_agent_budget(agent_id)
        return AgentBudgetEntry(**row)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to set agent budget: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/costs/budget/agents/{agent_id}")
async def delete_agent_budget(agent_id: str) -> dict:
    """Remove per-agent budget override."""
    try:
        db = get_database()
        repo = CostsRepository(db)
        deleted = await repo.delete_agent_budget(agent_id)
        if not deleted:
            raise HTTPException(status_code=404, detail=f"No budget found for agent: {agent_id}")
        return {"deleted": True, "agent_id": agent_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete agent budget: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/costs/budget-status", response_model=BudgetStatusResponse)
async def get_budget_status(
    agent_id: str = Query(..., description="Agent ID to check"),
) -> BudgetStatusResponse:
    """
    Check whether an agent is within its budget today.
    Used by the proxy before forwarding LLM requests.
    """
    try:
        db = get_database()
        repo = CostsRepository(db)

        global_cfg = await repo.get_global_budget()
        agent_cfg = await repo.get_agent_budget(agent_id)

        if agent_cfg:
            # Named per-agent budget: compare just this agent's own spend
            today_spend = await repo.get_today_spend(agent_id)
            effective_budget = agent_cfg["daily_budget_usd"]
            budget_action = agent_cfg["budget_action"]
        elif global_cfg["daily_budget_usd"] is not None:
            # Global budget = total wallet cap: sum ALL agents' spend today.
            # This handles anonymous agents whose IDs change between sessions
            # (client:IP:PORT → different IDs per connection) by counting everything.
            today_spend = await repo.get_today_spend()
            effective_budget = global_cfg["daily_budget_usd"]
            budget_action = global_cfg["budget_action"]
        else:
            # No budget set — always allow
            today_spend = await repo.get_today_spend(agent_id)
            return BudgetStatusResponse(
                agent_id=agent_id,
                today_spend_usd=round(today_spend, 6),
                global_budget_usd=None,
                agent_budget_usd=None,
                effective_budget_usd=None,
                budget_action="warn",
                over_budget=False,
            )

        over_budget = today_spend >= effective_budget

        return BudgetStatusResponse(
            agent_id=agent_id,
            today_spend_usd=round(today_spend, 6),
            global_budget_usd=global_cfg["daily_budget_usd"],
            agent_budget_usd=agent_cfg["daily_budget_usd"] if agent_cfg else None,
            effective_budget_usd=effective_budget,
            budget_action=budget_action,
            over_budget=over_budget,
        )
    except Exception as e:
        logger.error(f"Failed to get budget status: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/costs/budget/guardian")
async def get_budget_guardian() -> dict:
    """
    Budget guardian summary for the Cost Intelligence overview.
    Returns global budget status + per-agent alerts for agents that have budgets set.
    """
    try:
        db = get_database()
        repo = CostsRepository(db)

        global_cfg = await repo.get_global_budget()
        agent_budgets = await repo.list_agent_budgets()
        global_today = await repo.get_today_spend()

        g_budget = global_cfg.get("daily_budget_usd")
        g_pct = (global_today / g_budget) if g_budget and g_budget > 0 else None

        agent_alerts = []
        for ab in agent_budgets:
            agent_today = await repo.get_today_spend(agent_id=ab["agent_id"])
            budget = ab["daily_budget_usd"]
            pct = agent_today / budget if budget > 0 else 0.0
            agent_alerts.append({
                "agent_id": ab["agent_id"],
                "today_spend_usd": round(agent_today, 6),
                "budget_usd": budget,
                "budget_action": ab["budget_action"],
                "pct_used": round(pct, 4),
                "over_budget": pct >= 1.0,
                "warning": 0.8 <= pct < 1.0,
            })

        return {
            "global_budget_usd": g_budget,
            "global_today_spend_usd": round(global_today, 6),
            "global_budget_action": global_cfg.get("budget_action", "warn"),
            "global_pct_used": round(g_pct, 4) if g_pct is not None else None,
            "global_over_budget": g_pct is not None and g_pct >= 1.0,
            "global_warning": g_pct is not None and 0.8 <= g_pct < 1.0,
            "agent_alerts": agent_alerts,
        }
    except Exception as e:
        logger.error(f"Failed to get budget guardian: {e}")
        raise HTTPException(status_code=500, detail=str(e))
