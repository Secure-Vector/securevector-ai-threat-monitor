"""
Costs repository for LLM cost tracking.

Provides CRUD operations for:
- llm_cost_records: Per-request cost records
- model_pricing: Model pricing reference
"""

import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from securevector.app.utils.trace_text import sanitize_trace_text
from securevector.app.database.connection import DatabaseConnection
from securevector.app.utils.log_text import log_safe

# Provider names that mean Amazon Bedrock, as harnesses report them, and the
# cross-region inference prefixes a Bedrock model id may start with.
BEDROCK_PROVIDERS = ("bedrock", "aws", "amazon-bedrock", "amazon_bedrock")
BEDROCK_REGION_PREFIXES = ("us", "eu", "apac", "global", "us-gov", "jp", "au", "ca")

logger = logging.getLogger(__name__)

# Providers that serve Claude models under their own name. Their usage
# reports ``input_tokens`` WITHOUT the cached tokens (Anthropic convention);
# OpenAI and Gemini report cached tokens INSIDE the prompt count.
VERTEX_PROVIDERS = ("vertex", "vertex-ai", "vertex_ai", "google-vertex", "google-vertex-anthropic", "anthropic-vertex")

# Cached-token multipliers on the input rate, used when a model has no
# explicit cache rates in the pricing table.
CACHE_READ_FALLBACK = {"openai": 0.5, "anthropic": 0.1, "gemini": 0.25}
# Anthropic: a 5-minute cache write is 1.25x the input rate, a read 0.1x.
ANTHROPIC_CACHE_WRITE_MULTIPLIER = 1.25

_BEDROCK_VERSION_SUFFIX = re.compile(r"-v\d+:\d+(?::\d+k)?$")
_DATE_SUFFIX = re.compile(r"[-@](?:\d{8}|latest)$")
# What may follow a pricing key in a longer id of the same model: a date
# (``-20251001``, ``-2024-08-06``), a Google ``-001`` version, ``@``, ``:`` or a
# ``-vN`` version.
_VARIANT_SUFFIX = re.compile(r"(?:-\d{8}(?!\d)|-\d{3}(?!\d)|-\d{4}-\d{2}-\d{2}(?!\d)|@|:|-v\d)")


@dataclass
class RateCard:
    """USD per 1M tokens for one model. Cache rates are None when unknown."""

    input: float
    output: float
    cache_read: Optional[float] = None
    cache_write: Optional[float] = None


def is_claude_model(model_id: Optional[str]) -> bool:
    return "claude" in (model_id or "").lower()


def is_anthropic_family(provider: Optional[str], model_id: Optional[str]) -> bool:
    """Anthropic itself, or a Claude model served by Bedrock, Vertex or a proxy."""
    return (provider or "").lower() == "anthropic" or is_claude_model(model_id)


def input_includes_cached(provider: Optional[str], model_id: Optional[str]) -> bool:
    """Whether a provider's ``input_tokens`` already counts the cached tokens.

    Anthropic, Bedrock (Converse reports ``inputTokens`` apart from
    ``cacheReadInputTokens``) and Claude on Vertex count them apart.
    """
    p = (provider or "").lower()
    if p == "anthropic" or p in BEDROCK_PROVIDERS:
        return False
    if p in VERTEX_PROVIDERS and is_claude_model(model_id):
        return False
    return True


def model_id_candidates(model_id: Optional[str]) -> list[str]:
    """Pricing keys to try for a model id, most specific first.

    ``us.anthropic.claude-haiku-4-5-20251001-v1:0`` (Bedrock, any region or
    ``global.`` prefix), ``anthropic.claude-opus-5-5``, ``anthropic/claude-x``
    and Vertex ``claude-x@20250805`` all reduce to the first-party id.
    """
    mid = (model_id or "").strip()
    out: list[str] = []

    def add(v: str) -> None:
        if v and v not in out:
            out.append(v)

    add(mid)
    if mid.lower().startswith("anthropic/"):
        mid = mid[len("anthropic/"):]
        add(mid)
    parts = mid.split(".")
    if len(parts) > 1 and parts[0].lower() in BEDROCK_REGION_PREFIXES:
        parts = parts[1:]
    if len(parts) > 1 and parts[0].lower() == "anthropic":
        parts = parts[1:]
    mid = ".".join(parts)
    add(mid)
    mid = _BEDROCK_VERSION_SUFFIX.sub("", mid)
    add(mid)
    if "@" in mid:
        add(mid.replace("@", "-"))
    add(_DATE_SUFFIX.sub("", mid))
    return out


def lookup_rate_card(provider: Optional[str], model_id: Optional[str], table: dict) -> Optional[RateCard]:
    """Find a model's rates in ``table`` keyed ``(provider, model_id)``.

    Exact provider first, then any provider, for each candidate id; then the
    longest pricing key the id starts with, when what follows the key is only
    a date, ``@``, ``:`` or a ``-vN`` version (``claude-opus-5-6`` does not
    price as ``claude-opus-5``). A provider with its own keys, and Ollama,
    only prefix-match their own keys.
    """
    if not model_id or not table:
        return None
    by_model: dict = {}
    for (prov, mid), card in table.items():
        by_model.setdefault(mid, card)
    cands = model_id_candidates(model_id)
    for cand in cands:
        if provider and (provider, cand) in table:
            return table[(provider, cand)]
        if cand in by_model:
            return by_model[cand]
    bares = list(cands)
    if (provider or "") in BEDROCK_PROVIDERS:
        # Other Bedrock vendors (``meta.``, ``amazon.``) carry a vendor prefix.
        for c in cands:
            parts = c.split(".")
            if len(parts) > 1:
                bares.append(".".join(parts[1:]))
    own = {mid: card for (prov, mid), card in table.items() if prov == provider}
    pool = own if (own or (provider or "").lower() == "ollama") else by_model
    best = None
    for bare in bares:
        for mid, card in pool.items():
            if bare.startswith(mid) and (len(bare) == len(mid) or _VARIANT_SUFFIX.match(bare, len(mid))):
                if best is None or len(mid) > len(best[0]):
                    best = (mid, card)
    return best[1] if best else None


def compute_cost(
    provider: Optional[str],
    model_id: Optional[str],
    card: RateCard,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
    includes_cached: Optional[bool] = None,
) -> tuple[float, float]:
    """(input_cost_usd, output_cost_usd). Input cost covers cache reads and writes.

    ``includes_cached`` overrides the provider convention when the sender
    knows how its ``input_tokens`` were counted.
    """
    if includes_cached is None:
        includes_cached = input_includes_cached(provider, model_id)
    read = int(cache_read_tokens or 0)
    write = int(cache_write_tokens or 0)
    uncached = int(input_tokens or 0)
    if includes_cached:
        uncached = max(0, uncached - read - write)
    claude = is_anthropic_family(provider, model_id)
    if card.cache_read is not None:
        read_rate = card.cache_read
    else:
        read_rate = card.input * (CACHE_READ_FALLBACK["anthropic"] if claude
                                  else CACHE_READ_FALLBACK.get((provider or "").lower(), 1.0))
    if card.cache_write is not None:
        write_rate = card.cache_write
    else:
        write_rate = card.input * (ANTHROPIC_CACHE_WRITE_MULTIPLIER if claude else 1.0)
    input_cost = (uncached * card.input + read * read_rate + write * write_rate) / 1_000_000
    output_cost = (int(output_tokens or 0) * card.output) / 1_000_000
    return input_cost, output_cost


def pricing_table(rows) -> dict:
    """``{(provider, model_id): RateCard}`` from model_pricing rows or ModelPricing entries."""
    table: dict = {}
    for r in rows:
        get = (lambda k, r=r: getattr(r, k, None)) if not hasattr(r, "keys") else \
            (lambda k, r=r: r[k] if k in r.keys() else None)
        try:
            card = RateCard(
                input=float(get("input_per_million") or 0.0),
                output=float(get("output_per_million") or 0.0),
                cache_read=None if get("cache_read_per_million") is None else float(get("cache_read_per_million")),
                cache_write=None if get("cache_write_per_million") is None else float(get("cache_write_per_million")),
            )
        except (TypeError, ValueError):
            continue
        table[(str(get("provider")), str(get("model_id")))] = card
    return table


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
    input_cache_write_tokens: int = 0


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
    cache_read_per_million: Optional[float] = None
    cache_write_per_million: Optional[float] = None


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
    total_cache_read_tokens: int = 0
    total_cache_write_tokens: int = 0


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
        input_cache_write_tokens: int = 0,
    ) -> CostRecord:
        """Record a single LLM request's cost.

        ``session_id`` (v45) is the proxy's stable per-conversation id — it
        turns "spend today" into "spend this run" for the per-run ceilings.

        A record with a ``request_id`` already stored for the same agent is
        not written again; the stored record is returned instead.
        """
        if request_id:
            existing = await self.db.fetch_one(
                "SELECT * FROM llm_cost_records WHERE agent_id = ? AND request_id = ? LIMIT 1",
                (agent_id, request_id),
            )
            if existing:
                return self._row_to_cost_record(existing)
        record_id = str(uuid.uuid4())
        now = datetime.utcnow()

        await self.db.execute(
            """
            INSERT INTO llm_cost_records
            (id, agent_id, provider, model_id, request_id,
             input_tokens, output_tokens, input_cached_tokens,
             input_cost_usd, output_cost_usd, total_cost_usd,
             rate_input, rate_output, pricing_known, recorded_at, session_id,
             input_cache_write_tokens)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record_id, agent_id, provider, model_id, request_id,
                input_tokens, output_tokens, input_cached_tokens,
                input_cost_usd, output_cost_usd, total_cost_usd,
                rate_input, rate_output, 1 if pricing_known else 0,
                now.isoformat(), session_id, int(input_cache_write_tokens or 0),
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
            input_cache_write_tokens=int(input_cache_write_tokens or 0),
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
                SUM(input_cached_tokens) as total_cache_read_tokens,
                SUM(input_cache_write_tokens) as total_cache_write_tokens,
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
                    total_cache_read_tokens=row["total_cache_read_tokens"] or 0,
                    total_cache_write_tokens=row["total_cache_write_tokens"] or 0,
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
        cache_read_per_million: Optional[float] = None,
        cache_write_per_million: Optional[float] = None,
    ) -> None:
        """Upsert a pricing entry (used by sync)."""
        pricing_id = f"{provider}/{model_id}"
        await self.db.execute(
            """
            INSERT INTO model_pricing
            (id, provider, model_id, display_name, input_per_million, output_per_million,
             effective_date, verified_at, source_url, updated_at,
             cache_read_per_million, cache_write_per_million)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                input_per_million = excluded.input_per_million,
                output_per_million = excluded.output_per_million,
                cache_read_per_million = excluded.cache_read_per_million,
                cache_write_per_million = excluded.cache_write_per_million,
                effective_date = COALESCE(excluded.effective_date, effective_date),
                verified_at = excluded.verified_at,
                source_url = COALESCE(excluded.source_url, source_url),
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                pricing_id, provider, model_id, display_name,
                input_per_million, output_per_million,
                effective_date, verified_at, source_url,
                cache_read_per_million, cache_write_per_million,
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

    async def get_run_usage_bulk(self, session_ids: list[str]) -> dict[str, dict]:
        """`get_run_usage` for many runs in one query.

        The Agent Sessions board polls every few seconds and can hold a dozen
        rows, so per-row queries would be a dozen round trips per tick against
        a database that is also taking hook writes. Sessions with no priced
        request are simply absent from the result; the caller decides whether
        that reads as "nothing yet" or "0.00".
        """
        ids = [s for s in dict.fromkeys(session_ids or []) if s]
        if not ids:
            return {}
        placeholders = ",".join("?" for _ in ids)
        rows = await self.db.fetch_all(
            "SELECT session_id, "
            "COALESCE(SUM(total_cost_usd), 0.0) AS spend, "
            "COALESCE(SUM(input_tokens + input_cached_tokens + output_tokens), 0) AS tokens, "
            "COUNT(*) AS requests "
            f"FROM llm_cost_records WHERE session_id IN ({placeholders}) "
            "GROUP BY session_id",
            tuple(ids),
        )
        return {
            r["session_id"]: {
                "spend_usd": float(r["spend"] or 0.0),
                "tokens": int(r["tokens"] or 0),
                "requests": int(r["requests"] or 0),
            }
            for r in (rows or [])
        }

    # ------------------------------------------------------------------ #
    # Generation spans (model-run tracing, v46)                            #
    # ------------------------------------------------------------------ #

    CACHE_DISCOUNT = {"openai": 0.5, "anthropic": 0.1, "gemini": 0.25}

    async def resolve_rate_card(self, provider: Optional[str], model_id: str) -> Optional[RateCard]:
        """Full rates (input, output, cache read, cache write) for a model, or None.

        Region-prefixed Bedrock ids, ``anthropic.`` ids, ``-vN:M`` and date
        suffixes resolve to the first-party pricing key
        (see ``model_id_candidates``).
        """
        if not model_id:
            return None
        rows = await self.db.fetch_all("SELECT * FROM model_pricing")
        return lookup_rate_card(provider, model_id, pricing_table(rows or []))

    async def resolve_rates(self, provider: Optional[str], model_id: str) -> tuple[Optional[float], Optional[float]]:
        """(input_per_million, output_per_million) for a model, or (None, None)."""
        card = await self.resolve_rate_card(provider, model_id)
        return (card.input, card.output) if card else (None, None)

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
        input_cache_write_tokens: int = 0,
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
        # Redact always, then cap at 8 KB, for every producer (OTLP, SDK,
        # transcript import, proxy). None stays None: the "not stored" marker.
        input_preview, _ = sanitize_trace_text(input_preview, direction="outgoing")
        output_preview, _ = sanitize_trace_text(output_preview, direction="llm_response")
        card = await self.resolve_rate_card(provider, model_id)
        rate_in, rate_out = (card.input, card.output) if card else (None, None)
        pricing_known = card is not None
        if pricing_known:
            input_cost, output_cost = compute_cost(
                provider, model_id, card, int(input_tokens), int(output_tokens),
                int(input_cached_tokens), int(input_cache_write_tokens or 0))
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
                    input_cache_write_tokens = ?,
                    input_cost_usd = ?, output_cost_usd = ?, total_cost_usd = ?, rate_input = ?, rate_output = ?,
                    pricing_known = ?, started_at = ?, duration_ms = ?, parent_span_id = ?, request_id = ?,
                    input_preview = ?, output_preview = ?, finish_reason = ?,
                    verdict_action = ?, verdict_risk = ?, verdict_reason = ?
                WHERE id = ?
                """,
                (provider or "unknown", model_id, int(input_tokens), int(output_tokens), int(input_cached_tokens),
                 int(input_cache_write_tokens or 0),
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
                 verdict_action, verdict_risk, verdict_reason, input_cache_write_tokens)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (record_id, agent_id or runtime_kind, provider or "unknown", model_id, request_id,
                 int(input_tokens), int(output_tokens), int(input_cached_tokens),
                 round(input_cost, 8), round(output_cost, 8), total,
                 rate_in, rate_out, 1 if pricing_known else 0, now, session_id,
                 trace_id, span_id, parent_span_id, runtime_kind, turn_index, started, duration_ms,
                 input_preview, output_preview, finish_reason,
                 verdict_action, verdict_risk, verdict_reason, int(input_cache_write_tokens or 0)),
            )
        return {"id": record_id, "total_cost_usd": total, "pricing_known": pricing_known}

    async def get_trace_generations(self, trace_id: str) -> list[dict]:
        """Stored generation spans for one run, in execution order."""
        rows = await self.db.fetch_all(
            """
            SELECT id, span_id, parent_span_id, request_id, session_id, runtime_kind, provider, model_id,
                   input_tokens, output_tokens, input_cached_tokens, input_cache_write_tokens,
                   total_cost_usd, pricing_known,
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

    async def get_run_windows_for_sessions(self, session_ids) -> list[dict]:
        """Each run's time bounds over its stored generations, for these
        sessions. Mirrors ``CustomToolsRepository.get_run_windows_for_sessions``."""
        ids = [s for s in dict.fromkeys(session_ids or []) if s][:500]
        if not ids:
            return []
        marks = ", ".join("?" for _ in ids)
        rows = await self.db.fetch_all(
            f"""
            SELECT trace_id, MAX(session_id) AS session_id, MAX(runtime_kind) AS runtime_kind,
                   MIN(COALESCE(started_at, recorded_at)) AS started_at,
                   MAX(COALESCE(started_at, recorded_at)) AS ended_at
            FROM llm_cost_records
            WHERE session_id IN ({marks}) AND trace_id IS NOT NULL
            GROUP BY trace_id
            """,
            tuple(ids),
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
        logger.info(f"Deleted {count} cost records" + (f" for agent {log_safe(agent_id)}" if agent_id else ""))
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
            input_cache_write_tokens=(row["input_cache_write_tokens"] or 0)
            if "input_cache_write_tokens" in row.keys() else 0,
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
            cache_read_per_million=row["cache_read_per_million"]
            if "cache_read_per_million" in row.keys() else None,
            cache_write_per_million=row["cache_write_per_million"]
            if "cache_write_per_million" in row.keys() else None,
        )
