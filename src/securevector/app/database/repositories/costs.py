"""
Costs repository for LLM cost tracking.

Provides CRUD operations for:
- llm_cost_records: Per-request cost records
- model_pricing: Model pricing reference
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from securevector.app.database.connection import DatabaseConnection

logger = logging.getLogger(__name__)


@dataclass
class CostRecord:
    """Per-request LLM cost record."""

    id: str
    agent_id: str
    provider: str
    model_id: str
    request_id: Optional[str]
    input_tokens: int
    output_tokens: int
    input_cached_tokens: int
    input_cost_usd: float
    output_cost_usd: float
    total_cost_usd: float
    rate_input: Optional[float]
    rate_output: Optional[float]
    pricing_known: bool
    recorded_at: datetime


@dataclass
class ModelPricing:
    """Model pricing entry."""

    id: str
    provider: str
    model_id: str
    display_name: str
    input_per_million: float
    output_per_million: float
    effective_date: Optional[str]
    verified_at: Optional[str]
    source_url: Optional[str]
    updated_at: datetime


@dataclass
class AgentCostSummary:
    """Aggregated cost summary per agent."""

    agent_id: str
    total_requests: int
    total_input_tokens: int
    total_output_tokens: int
    total_cost_usd: float
    providers_used: list
    models_used: list
    first_seen: Optional[str]
    last_seen: Optional[str]
    has_unknown_pricing: bool


class CostsRepository:
    """Repository for LLM cost records and model pricing."""

    def __init__(self, db: DatabaseConnection):
        self.db = db

    async def record_cost(
        self,
        agent_id: str,
        provider: str,
        model_id: str,
        input_tokens: int,
        output_tokens: int,
        input_cost_usd: float,
        output_cost_usd: float,
        total_cost_usd: float,
        rate_input: Optional[float] = None,
        rate_output: Optional[float] = None,
        pricing_known: bool = True,
        request_id: Optional[str] = None,
        input_cached_tokens: int = 0,
        session_id: Optional[str] = None,
    ) -> CostRecord:
        """Record a single LLM request's cost.

        ``session_id`` (v45) is the proxy's stable per-conversation id — it
        turns "spend today" into "spend this run" for the per-run ceilings.
        """
        record_id = str(uuid.uuid4())
        now = datetime.utcnow()

        await self.db.execute(
            """
            INSERT INTO llm_cost_records
            (id, agent_id, provider, model_id, request_id,
             input_tokens, output_tokens, input_cached_tokens,
             input_cost_usd, output_cost_usd, total_cost_usd,
             rate_input, rate_output, pricing_known, recorded_at, session_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record_id, agent_id, provider, model_id, request_id,
                input_tokens, output_tokens, input_cached_tokens,
                input_cost_usd, output_cost_usd, total_cost_usd,
                rate_input, rate_output, 1 if pricing_known else 0,
                now.isoformat(), session_id,
            ),
        )

        return CostRecord(
            id=record_id,
            agent_id=agent_id,
            provider=provider,
            model_id=model_id,
            request_id=request_id,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            input_cached_tokens=input_cached_tokens,
            input_cost_usd=input_cost_usd,
            output_cost_usd=output_cost_usd,
            total_cost_usd=total_cost_usd,
            rate_input=rate_input,
            rate_output=rate_output,
            pricing_known=pricing_known,
            recorded_at=now,
        )

    async def get_agent_summaries(
        self,
        start: Optional[datetime] = None,
        end: Optional[datetime] = None,
        limit: int = 50,
    ) -> list[AgentCostSummary]:
        """Get per-agent cost summaries, optionally filtered by date range."""
        conditions = []
        params = []

        if start:
            conditions.append("recorded_at >= ?")
            params.append(start.isoformat())
        if end:
            conditions.append("recorded_at <= ?")
            params.append(end.isoformat())

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        rows = await self.db.fetch_all(
            f"""
            SELECT
                agent_id,
                COUNT(*) as total_requests,
                SUM(input_tokens) as total_input_tokens,
                SUM(output_tokens) as total_output_tokens,
                SUM(total_cost_usd) as total_cost_usd,
                GROUP_CONCAT(DISTINCT provider) as providers_used,
                GROUP_CONCAT(DISTINCT model_id) as models_used,
                MIN(recorded_at) as first_seen,
                MAX(recorded_at) as last_seen,
                SUM(CASE WHEN pricing_known = 0 THEN 1 ELSE 0 END) as unknown_count
            FROM llm_cost_records
            {where}
            GROUP BY agent_id
            ORDER BY total_cost_usd DESC
            LIMIT ?
            """,
            (*params, limit),
        )

        results = []
        for row in rows:
            providers = [p for p in (row["providers_used"] or "").split(",") if p]
            models = [m for m in (row["models_used"] or "").split(",") if m]
            results.append(
                AgentCostSummary(
                    agent_id=row["agent_id"],
                    total_requests=row["total_requests"],
                    total_input_tokens=row["total_input_tokens"] or 0,
                    total_output_tokens=row["total_output_tokens"] or 0,
                    total_cost_usd=round(row["total_cost_usd"] or 0.0, 6),
                    providers_used=providers,
                    models_used=models,
                    first_seen=row["first_seen"],
                    last_seen=row["last_seen"],
                    has_unknown_pricing=(row["unknown_count"] or 0) > 0,
                )
            )
        return results

    async def list_records(
        self,
        agent_id: Optional[str] = None,
        provider: Optional[str] = None,
        start: Optional[datetime] = None,
        end: Optional[datetime] = None,
        page: int = 1,
        page_size: int = 50,
    ) -> tuple[list[CostRecord], int]:
        """List cost records with pagination and optional filters."""
        conditions = []
        params: list = []

        if agent_id:
            conditions.append("agent_id = ?")
            params.append(agent_id)
        if provider:
            conditions.append("provider = ?")
            params.append(provider)
        if start:
            conditions.append("recorded_at >= ?")
            params.append(start.isoformat())
        if end:
            conditions.append("recorded_at <= ?")
            params.append(end.isoformat())

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        offset = (page - 1) * page_size

        total_row = await self.db.fetch_one(
            f"SELECT COUNT(*) as count FROM llm_cost_records {where}", tuple(params)
        )
        total = total_row["count"] if total_row else 0

        rows = await self.db.fetch_all(
            f"""
            SELECT * FROM llm_cost_records {where}
            ORDER BY recorded_at DESC
            LIMIT ? OFFSET ?
            """,
            (*params, page_size, offset),
        )

        records = []
        for row in rows:
            records.append(self._row_to_cost_record(row))
        return records, total

    async def get_dashboard_summary(self) -> dict:
        """Get compact summary for dashboard widget — today's costs."""
        today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)

        row = await self.db.fetch_one(
            """
            SELECT
                COUNT(*) as today_requests,
                COALESCE(SUM(total_cost_usd), 0.0) as today_cost_usd,
                SUM(CASE WHEN pricing_known = 0 THEN 1 ELSE 0 END) as unknown_count
            FROM llm_cost_records
            WHERE recorded_at >= ?
            """,
            (today_start.isoformat(),),
        )

        top_agent_row = await self.db.fetch_one(
            """
            SELECT agent_id, SUM(total_cost_usd) as cost
            FROM llm_cost_records
            WHERE recorded_at >= ?
            GROUP BY agent_id
            ORDER BY cost DESC
            LIMIT 1
            """,
            (today_start.isoformat(),),
        )

        top_model_row = await self.db.fetch_one(
            """
            SELECT model_id, COUNT(*) as cnt
            FROM llm_cost_records
            WHERE recorded_at >= ?
            GROUP BY model_id
            ORDER BY cnt DESC
            LIMIT 1
            """,
            (today_start.isoformat(),),
        )

        return {
            "today_cost_usd": round(row["today_cost_usd"] if row else 0.0, 4),
            "today_requests": row["today_requests"] if row else 0,
            "top_agent": top_agent_row["agent_id"] if top_agent_row else None,
            "top_model": top_model_row["model_id"] if top_model_row else None,
            "has_unknown_pricing": (row["unknown_count"] or 0) > 0 if row else False,
        }

    async def list_pricing(self, provider: Optional[str] = None) -> list[ModelPricing]:
        """List all model pricing entries, optionally filtered by provider."""
        if provider:
            rows = await self.db.fetch_all(
                "SELECT * FROM model_pricing WHERE provider = ? ORDER BY provider, model_id",
                (provider,),
            )
        else:
            rows = await self.db.fetch_all(
                "SELECT * FROM model_pricing ORDER BY provider, model_id"
            )
        return [self._row_to_pricing(row) for row in rows]

    async def get_pricing(self, provider: str, model_id: str) -> Optional[ModelPricing]:
        """Get pricing for a specific provider/model."""
        pricing_id = f"{provider}/{model_id}"
        row = await self.db.fetch_one(
            "SELECT * FROM model_pricing WHERE id = ?", (pricing_id,)
        )
        return self._row_to_pricing(row) if row else None

    async def update_pricing(
        self,
        provider: str,
        model_id: str,
        input_per_million: float,
        output_per_million: float,
        effective_date: Optional[str] = None,
    ) -> Optional[ModelPricing]:
        """Update pricing rates for a specific model."""
        pricing_id = f"{provider}/{model_id}"

        await self.db.execute(
            """
            UPDATE model_pricing
            SET input_per_million = ?,
                output_per_million = ?,
                effective_date = COALESCE(?, effective_date),
                verified_at = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (
                input_per_million,
                output_per_million,
                effective_date,
                datetime.utcnow().date().isoformat(),
                pricing_id,
            ),
        )
        return await self.get_pricing(provider, model_id)

    async def upsert_pricing(
        self,
        provider: str,
        model_id: str,
        display_name: str,
        input_per_million: float,
        output_per_million: float,
        effective_date: Optional[str] = None,
        verified_at: Optional[str] = None,
        source_url: Optional[str] = None,
    ) -> None:
        """Upsert a pricing entry (used by sync)."""
        pricing_id = f"{provider}/{model_id}"
        await self.db.execute(
            """
            INSERT INTO model_pricing
            (id, provider, model_id, display_name, input_per_million, output_per_million,
             effective_date, verified_at, source_url, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                input_per_million = excluded.input_per_million,
                output_per_million = excluded.output_per_million,
                effective_date = COALESCE(excluded.effective_date, effective_date),
                verified_at = excluded.verified_at,
                source_url = COALESCE(excluded.source_url, source_url),
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                pricing_id, provider, model_id, display_name,
                input_per_million, output_per_million,
                effective_date, verified_at, source_url,
            ),
        )

    # --- Budget methods ---

    async def get_global_budget(self) -> dict:
        """Return global budget settings from app_settings."""
        row = await self.db.fetch_one(
            "SELECT daily_budget_usd, budget_action FROM app_settings WHERE id = 1"
        )
        if not row:
            return {"daily_budget_usd": None, "budget_action": "warn"}
        return {
            "daily_budget_usd": row["daily_budget_usd"],
            "budget_action": row["budget_action"] or "warn",
        }

    async def set_global_budget(self, daily_budget_usd: Optional[float], budget_action: str) -> None:
        """Update global budget settings."""
        await self.db.execute(
            "UPDATE app_settings SET daily_budget_usd = ?, budget_action = ? WHERE id = 1",
            (daily_budget_usd, budget_action),
        )

    async def list_agent_budgets(self) -> list[dict]:
        """List all per-agent budget entries."""
        rows = await self.db.fetch_all(
            "SELECT agent_id, daily_budget_usd, budget_action, created_at, updated_at FROM agent_budgets ORDER BY agent_id"
        )
        return [dict(r) for r in rows]

    async def get_agent_budget(self, agent_id: str) -> Optional[dict]:
        """Get budget for a specific agent. Returns None if not set."""
        row = await self.db.fetch_one(
            "SELECT agent_id, daily_budget_usd, budget_action FROM agent_budgets WHERE agent_id = ?",
            (agent_id,),
        )
        return dict(row) if row else None

    async def set_agent_budget(self, agent_id: str, daily_budget_usd: float, budget_action: str) -> None:
        """Upsert per-agent budget."""
        await self.db.execute(
            """
            INSERT INTO agent_budgets (agent_id, daily_budget_usd, budget_action, created_at, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(agent_id) DO UPDATE SET
                daily_budget_usd = excluded.daily_budget_usd,
                budget_action = excluded.budget_action,
                updated_at = CURRENT_TIMESTAMP
            """,
            (agent_id, daily_budget_usd, budget_action),
        )

    async def delete_agent_budget(self, agent_id: str) -> bool:
        """Delete per-agent budget. Returns True if a row was deleted."""
        cursor = await self.db.execute(
            "DELETE FROM agent_budgets WHERE agent_id = ?", (agent_id,)
        )
        return (cursor.rowcount if cursor else 0) > 0

    async def get_today_spend(self, agent_id: Optional[str] = None) -> float:
        """Return today's total spend in USD, optionally filtered by agent_id."""
        today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        if agent_id:
            row = await self.db.fetch_one(
                "SELECT COALESCE(SUM(total_cost_usd), 0.0) as total FROM llm_cost_records WHERE agent_id = ? AND recorded_at >= ?",
                (agent_id, today_start.isoformat()),
            )
        else:
            row = await self.db.fetch_one(
                "SELECT COALESCE(SUM(total_cost_usd), 0.0) as total FROM llm_cost_records WHERE recorded_at >= ?",
                (today_start.isoformat(),),
            )
        return float(row["total"]) if row else 0.0

    async def get_run_usage(self, session_id: str) -> dict:
        """Spend and token usage for one run (proxy session). No time window —
        the run IS the window. Tokens count everything the provider processed
        (fresh input + cached input + output) so the per-run token ceiling
        tracks usage limits, not just fresh input."""
        row = await self.db.fetch_one(
            "SELECT COALESCE(SUM(total_cost_usd), 0.0) AS spend, "
            "COALESCE(SUM(input_tokens + input_cached_tokens + output_tokens), 0) AS tokens, "
            "COUNT(*) AS requests "
            "FROM llm_cost_records WHERE session_id = ?",
            (session_id,),
        )
        return {
            "spend_usd": float(row["spend"]) if row else 0.0,
            "tokens": int(row["tokens"]) if row else 0,
            "requests": int(row["requests"]) if row else 0,
        }

    # ------------------------------------------------------------------ #
    # Generation spans (model-run tracing, v46)                            #
    # ------------------------------------------------------------------ #

    CACHE_DISCOUNT = {"openai": 0.5, "anthropic": 0.1, "gemini": 0.25}

    async def resolve_rates(self, provider: Optional[str], model_id: str) -> tuple[Optional[float], Optional[float]]:
        """(input_per_million, output_per_million) for a model, or (None, None).

        Exact ``provider/model`` first, then any provider with that model id,
        then a prefix match so dated variants (``gpt-4o-2024-08-06``) and
        Bedrock ids (``anthropic.claude-3-5-sonnet-20241022-v2:0``) still price.
        """
        if not model_id:
            return None, None
        if provider:
            exact = await self.get_pricing(provider, model_id)
            if exact:
                return exact.input_per_million, exact.output_per_million
        rows = await self.db.fetch_all("SELECT model_id, input_per_million, output_per_million FROM model_pricing")
        by_model = {}
        for r in rows or []:
            by_model[str(r["model_id"])] = (float(r["input_per_million"]), float(r["output_per_million"]))
        if model_id in by_model:
            return by_model[model_id]
        bare = model_id.split(".", 1)[-1] if "." in model_id and provider in ("bedrock", "aws") else model_id
        best = None
        for mid, rates in by_model.items():
            if bare.startswith(mid) and (best is None or len(mid) > len(best[0])):
                best = (mid, rates)
        return best[1] if best else (None, None)

    async def record_generation(
        self,
        *,
        trace_id: Optional[str],
        span_id: Optional[str],
        session_id: Optional[str],
        runtime_kind: str,
        provider: Optional[str],
        model_id: str,
        input_tokens: int = 0,
        output_tokens: int = 0,
        input_cached_tokens: int = 0,
        started_at: Optional[str] = None,
        duration_ms: Optional[int] = None,
        parent_span_id: Optional[str] = None,
        request_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        input_preview: Optional[str] = None,
        output_preview: Optional[str] = None,
        finish_reason: Optional[str] = None,
        verdict_action: Optional[str] = None,
        verdict_risk: Optional[int] = None,
        verdict_reason: Optional[str] = None,
    ) -> dict:
        """Upsert one generation span. Idempotent on ``(trace_id, span_id)``.

        Cost is computed here with the same formula the proxy's CostRecorder
        uses, so a traced call and a proxied call price identically.
        """
        rate_in, rate_out = await self.resolve_rates(provider, model_id)
        pricing_known = rate_in is not None and rate_out is not None
        if pricing_known:
            cache_rate = self.CACHE_DISCOUNT.get(provider or "", 1.0)
            uncached = max(0, int(input_tokens) - int(input_cached_tokens))
            input_cost = (uncached / 1_000_000) * rate_in + (int(input_cached_tokens) / 1_000_000) * rate_in * cache_rate
            output_cost = (int(output_tokens) / 1_000_000) * rate_out
        else:
            input_cost = output_cost = 0.0
        total = round(input_cost + output_cost, 8)
        now = datetime.utcnow().isoformat()
        started = started_at or now

        existing = None
        if trace_id and span_id:
            existing = await self.db.fetch_one(
                "SELECT id FROM llm_cost_records WHERE trace_id = ? AND span_id = ?", (trace_id, span_id)
            )
        if existing:
            record_id = existing["id"]
            await self.db.execute(
                """
                UPDATE llm_cost_records SET
                    provider = ?, model_id = ?, input_tokens = ?, output_tokens = ?, input_cached_tokens = ?,
                    input_cost_usd = ?, output_cost_usd = ?, total_cost_usd = ?, rate_input = ?, rate_output = ?,
                    pricing_known = ?, started_at = ?, duration_ms = ?, parent_span_id = ?, request_id = ?,
                    input_preview = ?, output_preview = ?, finish_reason = ?,
                    verdict_action = ?, verdict_risk = ?, verdict_reason = ?
                WHERE id = ?
                """,
                (provider or "unknown", model_id, int(input_tokens), int(output_tokens), int(input_cached_tokens),
                 round(input_cost, 8), round(output_cost, 8), total, rate_in, rate_out,
                 1 if pricing_known else 0, started, duration_ms, parent_span_id, request_id,
                 input_preview, output_preview, finish_reason,
                 verdict_action, verdict_risk, verdict_reason, record_id),
            )
        else:
            record_id = str(uuid.uuid4())
            turn_row = await self.db.fetch_one(
                "SELECT COUNT(*) AS n FROM llm_cost_records WHERE trace_id = ?", (trace_id,)
            ) if trace_id else None
            turn_index = int(turn_row["n"] or 0) if turn_row else 0
            await self.db.execute(
                """
                INSERT INTO llm_cost_records
                (id, agent_id, provider, model_id, request_id,
                 input_tokens, output_tokens, input_cached_tokens,
                 input_cost_usd, output_cost_usd, total_cost_usd,
                 rate_input, rate_output, pricing_known, recorded_at, session_id,
                 trace_id, span_id, parent_span_id, runtime_kind, turn_index, started_at, duration_ms,
                 input_preview, output_preview, finish_reason,
                 verdict_action, verdict_risk, verdict_reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (record_id, agent_id or runtime_kind, provider or "unknown", model_id, request_id,
                 int(input_tokens), int(output_tokens), int(input_cached_tokens),
                 round(input_cost, 8), round(output_cost, 8), total,
                 rate_in, rate_out, 1 if pricing_known else 0, now, session_id,
                 trace_id, span_id, parent_span_id, runtime_kind, turn_index, started, duration_ms,
                 input_preview, output_preview, finish_reason,
                 verdict_action, verdict_risk, verdict_reason),
            )
        return {"id": record_id, "total_cost_usd": total, "pricing_known": pricing_known}

    async def get_trace_generations(self, trace_id: str) -> list[dict]:
        """Stored generation spans for one run, in execution order."""
        rows = await self.db.fetch_all(
            """
            SELECT id, span_id, parent_span_id, request_id, session_id, runtime_kind, provider, model_id,
                   input_tokens, output_tokens, input_cached_tokens, total_cost_usd, pricing_known,
                   COALESCE(started_at, recorded_at) AS started_at, duration_ms, turn_index,
                   input_preview, output_preview, finish_reason,
                   verdict_action, verdict_risk, verdict_reason
            FROM llm_cost_records
            WHERE trace_id = ?
            ORDER BY COALESCE(started_at, recorded_at) ASC, turn_index ASC
            """,
            (trace_id,),
        )
        return [dict(r) for r in rows] if rows else []

    async def get_generation_runs(self, window_days: int = 7, limit: int = 50) -> list[dict]:
        """One row per trace_id over the cost table: tokens, cost, the costliest
        turn, time bounds. Mirrors ``CustomToolsRepository.get_trace_runs``."""
        window_days = max(1, min(int(window_days), 90))
        limit = max(1, min(int(limit), 500))
        rows = await self.db.fetch_all(
            f"""
            SELECT
                trace_id,
                MAX(runtime_kind) AS runtime_kind,
                MAX(session_id) AS session_id,
                COUNT(*) AS generations,
                SUM(input_tokens + input_cached_tokens + output_tokens) AS tokens,
                SUM(total_cost_usd) AS cost,
                MAX(total_cost_usd) AS max_turn_cost,
                MIN(COALESCE(started_at, recorded_at)) AS started_at,
                MAX(COALESCE(started_at, recorded_at)) AS ended_at,
                SUM(CASE WHEN verdict_action = 'log_only' THEN 1 ELSE 0 END) AS flagged,
                GROUP_CONCAT(DISTINCT model_id) AS models
            FROM llm_cost_records
            WHERE trace_id IS NOT NULL AND recorded_at >= datetime('now', '-{window_days} days')
            GROUP BY trace_id
            ORDER BY ended_at DESC
            LIMIT ?
            """,
            (limit,),
        )
        return [dict(r) for r in rows] if rows else []

    async def get_monthly_spend(self, agent_id: Optional[str] = None) -> float:
        """Return this calendar month's total spend in USD, optionally filtered by agent_id."""
        now = datetime.utcnow()
        month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        if agent_id:
            row = await self.db.fetch_one(
                "SELECT COALESCE(SUM(total_cost_usd), 0.0) as total FROM llm_cost_records WHERE agent_id = ? AND recorded_at >= ?",
                (agent_id, month_start.isoformat()),
            )
        else:
            row = await self.db.fetch_one(
                "SELECT COALESCE(SUM(total_cost_usd), 0.0) as total FROM llm_cost_records WHERE recorded_at >= ?",
                (month_start.isoformat(),),
            )
        return float(row["total"]) if row else 0.0

    async def get_daily_spend_for_range(
        self,
        start: datetime,
        end: datetime,
    ) -> list[dict]:
        """Return daily cost totals between start (inclusive) and end (exclusive).

        Returns list of {date: 'YYYY-MM-DD', cost_usd: float} for each day that has records.
        """
        rows = await self.db.fetch_all(
            """
            SELECT
                date(recorded_at) as day,
                COALESCE(SUM(total_cost_usd), 0.0) as cost_usd
            FROM llm_cost_records
            WHERE recorded_at >= ? AND recorded_at < ?
            GROUP BY date(recorded_at)
            ORDER BY day ASC
            """,
            (start.isoformat(), end.isoformat()),
        )
        return [{"date": row["day"], "cost_usd": round(float(row["cost_usd"]), 6)} for row in rows]

    async def get_daily_spend_for_month(self, year: Optional[int] = None, month: Optional[int] = None) -> list[dict]:
        """Return daily cost totals for a given calendar month (defaults to current month)."""
        now = datetime.utcnow()
        y = year or now.year
        m = month or now.month
        month_start = datetime(y, m, 1)
        month_end = datetime(y + 1, 1, 1) if m == 12 else datetime(y, m + 1, 1)
        return await self.get_daily_spend_for_range(month_start, month_end)

    async def get_stale_pricing(self, days: int = 30) -> list[ModelPricing]:
        """Get pricing entries not updated in the last N days."""
        rows = await self.db.fetch_all(
            """
            SELECT * FROM model_pricing
            WHERE updated_at <= datetime('now', ?)
            AND provider != 'ollama'
            ORDER BY updated_at ASC
            """,
            (f"-{days} days",),
        )
        return [self._row_to_pricing(row) for row in rows]

    async def cleanup_old_records(self, retention_days: int) -> int:
        """Delete cost records older than retention_days."""
        cutoff = f"-{retention_days} days"
        cursor = await self.db.execute(
            "DELETE FROM llm_cost_records WHERE recorded_at <= datetime('now', ?)",
            (cutoff,),
        )
        count = cursor.rowcount if cursor else 0
        if count > 0:
            logger.info(f"Cleaned up {count} old cost records")
        return count

    async def delete_records(self, agent_id: Optional[str] = None) -> int:
        """Delete cost records, optionally filtered by agent_id. Returns deleted count."""
        if agent_id:
            cursor = await self.db.execute(
                "DELETE FROM llm_cost_records WHERE agent_id = ?", (agent_id,)
            )
        else:
            cursor = await self.db.execute("DELETE FROM llm_cost_records")
        count = cursor.rowcount if cursor else 0
        logger.info(f"Deleted {count} cost records" + (f" for agent {agent_id}" if agent_id else ""))
        return count

    async def delete_records_by_ids(self, ids: list) -> int:
        """Delete specific cost records by ID list. Returns deleted count."""
        if not ids:
            return 0
        placeholders = ",".join("?" * len(ids))
        cursor = await self.db.execute(
            f"DELETE FROM llm_cost_records WHERE id IN ({placeholders})", ids
        )
        count = cursor.rowcount if cursor else 0
        logger.info(f"Deleted {count} cost records by ID")
        return count

    # --- Private helpers ---

    def _row_to_cost_record(self, row) -> CostRecord:
        recorded_at = row["recorded_at"]
        if isinstance(recorded_at, str):
            try:
                recorded_at = datetime.fromisoformat(recorded_at)
            except ValueError:
                recorded_at = datetime.utcnow()

        return CostRecord(
            id=row["id"],
            agent_id=row["agent_id"],
            provider=row["provider"],
            model_id=row["model_id"],
            request_id=row["request_id"],
            input_tokens=row["input_tokens"] or 0,
            output_tokens=row["output_tokens"] or 0,
            input_cached_tokens=row["input_cached_tokens"] if "input_cached_tokens" in row.keys() else 0,
            input_cost_usd=row["input_cost_usd"] or 0.0,
            output_cost_usd=row["output_cost_usd"] or 0.0,
            total_cost_usd=row["total_cost_usd"] or 0.0,
            rate_input=row["rate_input"],
            rate_output=row["rate_output"],
            pricing_known=bool(row["pricing_known"]),
            recorded_at=recorded_at,
        )

    def _row_to_pricing(self, row) -> ModelPricing:
        updated_at = row["updated_at"]
        if isinstance(updated_at, str):
            try:
                updated_at = datetime.fromisoformat(updated_at)
            except ValueError:
                updated_at = datetime.utcnow()

        return ModelPricing(
            id=row["id"],
            provider=row["provider"],
            model_id=row["model_id"],
            display_name=row["display_name"],
            input_per_million=row["input_per_million"] or 0.0,
            output_per_million=row["output_per_million"] or 0.0,
            effective_date=row["effective_date"],
            verified_at=row["verified_at"],
            source_url=row["source_url"],
            updated_at=updated_at,
        )
