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
    ) -> CostRecord:
        """Record a single LLM request's cost."""
        record_id = str(uuid.uuid4())
        now = datetime.utcnow()

        await self.db.execute(
            """
            INSERT INTO llm_cost_records
            (id, agent_id, provider, model_id, request_id,
             input_tokens, output_tokens, input_cached_tokens,
             input_cost_usd, output_cost_usd, total_cost_usd,
             rate_input, rate_output, pricing_known, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record_id, agent_id, provider, model_id, request_id,
                input_tokens, output_tokens, input_cached_tokens,
                input_cost_usd, output_cost_usd, total_cost_usd,
                rate_input, rate_output, 1 if pricing_known else 0,
                now.isoformat(),
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
