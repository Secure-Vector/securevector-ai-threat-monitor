"""
Hermes (NousResearch ``hermes-agent``) token-usage API endpoint.

Parallel to the ``hooks_claude_code.py`` / ``hooks_codex.py`` /
``hooks_copilot_cli.py`` token-usage scanners, but for a FRAMEWORK-shape
runtime: Hermes is governed by the ``securevector-sdk-hermes`` package (no
hook plugin), so this module deliberately has NO install/uninstall/status
endpoints — only the local session-usage reader that feeds the dashboard's
combined token chart.

GET /api/hooks/hermes/token-usage - Aggregate token usage across Hermes sessions

Data source: Hermes stores session state in a SQLite DB (not JSONL) —
``$HERMES_HOME/state.db`` (default ``~/.hermes/state.db``), table
``sessions`` with cumulative per-session counters:
``input_tokens`` / ``output_tokens`` / ``cache_read_tokens`` /
``cache_write_tokens``, ``message_count``, ``model``, ``started_at`` /
``ended_at`` (epoch seconds). This is the same store Hermes's own
``/insights`` command reads. Schema verified against hermes-agent 0.18.0
(``hermes_state.py``). The DB is opened read-only over a URI so a live
Hermes session's WAL lock is never disturbed.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
import time
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter

from .hooks_claude_code import (
    DailyTokenUsage,
    ModelUsage,
    TokenUsageResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hooks/hermes", tags=["Hooks"])


def _hermes_state_db() -> Path:
    """Resolve Hermes's state DB, honoring the HERMES_HOME override."""
    home = os.environ.get("HERMES_HOME")
    base = Path(home).expanduser() if home else (Path.home() / ".hermes")
    return base / "state.db"


def _epoch_to_iso(epoch: float | None) -> str | None:
    if not epoch:
        return None
    try:
        return datetime.fromtimestamp(float(epoch)).astimezone().isoformat()
    except (ValueError, OSError, OverflowError):
        return None


def _epoch_to_local_day(epoch: float | None) -> str | None:
    if not epoch:
        return None
    try:
        return datetime.fromtimestamp(float(epoch)).astimezone().strftime("%Y-%m-%d")
    except (ValueError, OSError, OverflowError):
        return None


def _compute_hermes_token_usage_sync() -> TokenUsageResponse:
    """Blocking aggregation over the Hermes sessions table."""
    empty = TokenUsageResponse(
        sessions=0, turns_with_usage=0,
        input_tokens=0, output_tokens=0,
        cache_creation_input_tokens=0, cache_read_input_tokens=0,
        last_activity=None, by_model=[], daily=[],
    )
    db_path = _hermes_state_db()
    if not db_path.is_file():
        return empty

    rows: list[tuple] = []
    try:
        # mode=ro: never create, never write — a live `hermes` process owns
        # the WAL; read-only access can't corrupt or block it. Build the URI
        # via Path.as_uri() so a home dir containing % / ? / # is escaped
        # correctly rather than mis-parsed as URI syntax.
        conn = sqlite3.connect(f"{db_path.as_uri()}?mode=ro", uri=True, timeout=2.0)
        try:
            rows = conn.execute(
                """
                SELECT model, message_count,
                       input_tokens, output_tokens,
                       cache_write_tokens, cache_read_tokens,
                       COALESCE(ended_at, started_at) AS last_ts
                FROM sessions
                WHERE COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) > 0
                """
            ).fetchall()
        finally:
            conn.close()
    except sqlite3.Error as exc:
        # Locked / mid-migration / foreign schema — zeros beat a 500.
        logger.debug("hermes state.db read failed: %s", exc)
        return empty

    sessions = 0
    total_turns = 0
    total = {"input": 0, "output": 0, "cache_create": 0, "cache_read": 0}
    latest_epoch: float | None = None
    model_totals: dict = {}
    day_totals: dict = {}

    for model, msg_count, inp, out, cache_w, cache_r, last_ts in rows:
        sessions += 1
        turns = int(msg_count or 0)
        total_turns += turns
        usage = {
            "input": int(inp or 0),
            "output": int(out or 0),
            "cache_create": int(cache_w or 0),
            "cache_read": int(cache_r or 0),
        }
        if last_ts and (latest_epoch is None or float(last_ts) > latest_epoch):
            latest_epoch = float(last_ts)

        agg = model_totals.setdefault(model or "unknown", {
            "turns": 0, "input": 0, "output": 0,
            "cache_create": 0, "cache_read": 0,
        })
        agg["turns"] += turns
        for k in ("input", "output", "cache_create", "cache_read"):
            agg[k] += usage[k]
            total[k] += usage[k]

        day = _epoch_to_local_day(last_ts)
        if day is not None:
            du = day_totals.setdefault(day, {
                "turns": 0, "input": 0, "output": 0,
                "cache_create": 0, "cache_read": 0,
            })
            du["turns"] += turns
            for k in ("input", "output", "cache_create", "cache_read"):
                du[k] += usage[k]

    by_model = [
        ModelUsage(
            model=model,
            turns=mu["turns"],
            input_tokens=mu["input"],
            output_tokens=mu["output"],
            cache_creation_input_tokens=mu["cache_create"],
            cache_read_input_tokens=mu["cache_read"],
        )
        for model, mu in model_totals.items()
    ]
    by_model.sort(
        key=lambda m: m.input_tokens + m.output_tokens
                    + m.cache_creation_input_tokens + m.cache_read_input_tokens,
        reverse=True,
    )

    daily = sorted(
        (
            DailyTokenUsage(
                day=day,
                turns=du["turns"],
                input_tokens=du["input"],
                output_tokens=du["output"],
                cache_creation_input_tokens=du["cache_create"],
                cache_read_input_tokens=du["cache_read"],
            )
            for day, du in day_totals.items()
        ),
        key=lambda d: d.day,
    )[-30:]

    return TokenUsageResponse(
        sessions=sessions,
        turns_with_usage=total_turns,
        input_tokens=total["input"],
        output_tokens=total["output"],
        cache_creation_input_tokens=total["cache_create"],
        cache_read_input_tokens=total["cache_read"],
        last_activity=_epoch_to_iso(latest_epoch),
        by_model=by_model,
        daily=daily,
    )


# Same short-TTL memo as the CC / Copilot scanners — the dashboard re-requests
# on every navigation and the query is disk-bound.
_HERMES_TOKEN_USAGE_TTL_SECONDS = 60.0
_hermes_token_usage_cache: dict = {"ts": 0.0, "value": None}


@router.get("/token-usage", response_model=TokenUsageResponse)
async def get_hermes_token_usage() -> TokenUsageResponse:
    """Aggregate token usage across all Hermes sessions.

    Reads ``$HERMES_HOME/state.db`` (default ``~/.hermes/state.db``) —
    the SQLite store behind Hermes's own ``/insights``. Missing DB →
    zeros (fresh installs that haven't run a Hermes session).
    """
    now = time.monotonic()
    cached = _hermes_token_usage_cache
    if cached["value"] is not None and (now - cached["ts"]) < _HERMES_TOKEN_USAGE_TTL_SECONDS:
        return cached["value"]
    value = await asyncio.to_thread(_compute_hermes_token_usage_sync)
    cached["ts"] = time.monotonic()
    cached["value"] = value
    return value
