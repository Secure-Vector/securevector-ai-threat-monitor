"""Per-run cost enforcement (issue #203) — the decision-path half.

Turns the Cost Optimizer's analysis into control: a per-run tool-call cap and
a loop breaker that ride the existing synced-overrides deny rail, plus the
run-exemption ("stop now, approve to continue") lift on the JIT-grant
contract. The per-run cost/token ceilings live on the proxy path (see
routes/costs.py budget-status) — same settings row, different enforcement
point.

Design constraints, from the issue's locked decisions:
- Everything is off by default (NULL / 0 settings). When nothing is
  configured this module does zero queries.
- Every stop is audited: the plugins write the ordinary ``action='block'``
  audit row with this module's reason string, which is deliberately shaped as
  "<control name>: <observed> vs <limit>" because the blocked ledger groups
  by reason.
- Every stop is promotable: a run exemption is a JIT grant with
  ``tool_id='*'`` scoped to the session. It is consumed HERE (server-side,
  suppressing the deny) and never emitted to plugins as an allow row — a
  wildcard allow would lift policy denies too, which an exemption must not.
- No request modification, no model routing, ever.

The decision path runs under the plugins' 100 ms timeout: one settings read,
and at most two indexed queries per call, only when a control is enabled.
"""

from __future__ import annotations

import logging
import secrets
from typing import Optional

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.repositories.settings import SettingsRepository
from securevector.app.services.cost_optimizer import THRESHOLDS
from securevector.app.utils.trace_id import derive_trace_id

logger = logging.getLogger(__name__)

# Loop breaker constants — published, like every enforcement threshold in the
# product, so the operator can disagree with a number instead of a feeling.
# The rate threshold is the Detect story's session-shape constant; the
# identical-repeat threshold is deliberately far above the retry detector's
# (>=3 with errors) because a breaker acts, and a wrong stop costs more trust
# than a late one.
LOOP_WINDOW_SECONDS = 180
LOOP_REPEAT_LIMIT = 10
LOOP_RATE_PER_MIN = THRESHOLDS["loop_calls_per_min"]

RUN_CAP_PREFIX = "Per-run tool-call cap"
LOOP_PREFIX = "Loop breaker"
COST_CEILING_PREFIX = "Per-run cost ceiling"
TOKEN_CEILING_PREFIX = "Per-run token ceiling"
STOP_PREFIXES = (RUN_CAP_PREFIX, LOOP_PREFIX, COST_CEILING_PREFIX, TOKEN_CEILING_PREFIX)


def _deny_row(tool_id: str, reason: str) -> dict:
    """A synced-overrides row in the exact shape the plugins already index.
    ``source: 'run_limit'`` + wildcard tool_id are the only novelties."""
    return {
        "tool_id": tool_id,
        "effect": "deny",
        "priority": 200,
        "policy_id": "_run_limit",
        "policy_name": "Per-run limit",
        "policy_version": 0,
        "org_name": "Local",
        "reason": reason,
        "source": "run_limit",
        "requestable": False,
    }


async def has_run_exemption(db: DatabaseConnection, runtime_kind: Optional[str],
                            session_id: str) -> bool:
    """An active tool_id='*' JIT grant scoped to this session lifts the caps."""
    row = await db.fetch_one(
        "SELECT id FROM jit_access_grants "
        "WHERE tool_id = '*' AND session_id = ? "
        "AND (runtime_kind IS NULL OR runtime_kind = ?) "
        "AND revoked_at IS NULL "
        "AND (expires_at IS NULL OR expires_at > datetime('now')) "
        "LIMIT 1",
        (session_id, runtime_kind or ""),
    )
    return row is not None


async def evaluate_run_limits(db: DatabaseConnection, runtime_kind: str,
                              session_id: str) -> list[dict]:
    """Deny rows for the tool-boundary controls, or [] when nothing trips.

    Called from GET /tool-permissions/synced-overrides when the hook passes a
    session id. Fail-quiet by contract: any error returns [] — enforcement
    must never take the allow path down with it.
    """
    try:
        settings = await SettingsRepository(db).get()
        cap = settings.run_max_tool_calls
        breaker = settings.run_loop_breaker
        if not cap and not breaker:
            return []
        if not settings.tool_permissions_enabled:
            return []  # the kill switch covers enforcement riding its rail
        trace_id = derive_trace_id(runtime_kind, session_id)
        if trace_id is None:
            return []
        if await has_run_exemption(db, runtime_kind, session_id):
            return []

        rows: list[dict] = []
        if cap:
            count_row = await db.fetch_one(
                "SELECT COUNT(*) AS n FROM tool_call_audit WHERE trace_id = ?",
                (trace_id,),
            )
            observed = int((count_row["n"] if count_row else 0) or 0)
            if observed >= cap:
                rows.append(_deny_row(
                    "*",
                    f"{RUN_CAP_PREFIX}: this session has made {observed} tool calls "
                    f"(limit {cap}). Approve continuation under Cost Settings to resume.",
                ))

        if breaker and not rows:
            # Identical-call repetition inside the window: per-tool deny.
            rep = await db.fetch_one(
                "SELECT tool_id, COUNT(*) AS n FROM tool_call_audit "
                "WHERE trace_id = ? AND args_preview IS NOT NULL "
                f"AND called_at >= datetime('now', '-{LOOP_WINDOW_SECONDS} seconds') "
                "GROUP BY tool_id, args_preview "
                "ORDER BY n DESC LIMIT 1",
                (trace_id,),
            )
            if rep and int(rep["n"] or 0) >= LOOP_REPEAT_LIMIT:
                rows.append(_deny_row(
                    rep["tool_id"],
                    f"{LOOP_PREFIX}: {rep['tool_id']} was called {int(rep['n'])} times "
                    f"with identical arguments in the last {LOOP_WINDOW_SECONDS}s "
                    f"(limit {LOOP_REPEAT_LIMIT}). Approve continuation under Cost "
                    f"Settings to resume.",
                ))
            else:
                # Sustained call rate: the session shape, not any single call.
                rate_row = await db.fetch_one(
                    "SELECT COUNT(*) AS n FROM tool_call_audit "
                    "WHERE trace_id = ? "
                    f"AND called_at >= datetime('now', '-{LOOP_WINDOW_SECONDS} seconds')",
                    (trace_id,),
                )
                n = int((rate_row["n"] if rate_row else 0) or 0)
                if n >= LOOP_RATE_PER_MIN * (LOOP_WINDOW_SECONDS / 60):
                    rows.append(_deny_row(
                        "*",
                        f"{LOOP_PREFIX}: {n} tool calls in the last "
                        f"{LOOP_WINDOW_SECONDS}s, a sustained rate above "
                        f"{LOOP_RATE_PER_MIN}/min. Approve continuation under Cost "
                        f"Settings to resume.",
                    ))
        return rows
    except Exception:  # noqa: BLE001 — enforcement degrades, never breaks allow
        logger.debug("run-limit evaluation failed; emitting no rows", exc_info=True)
        return []


async def create_run_exemption(db: DatabaseConnection, runtime_kind: Optional[str],
                               session_id: str) -> dict:
    """One-click 'approve this run to continue': a session-scoped, time-boxed
    JIT grant (tool_id='*'), revocable from the JIT grants list. A companion
    pre-approved request row satisfies the grants FK and doubles as the
    promotion's audit record (who lifted what, for which session, when)."""
    grant_id = "jitgrant_" + secrets.token_hex(10)
    request_id = "jitreq_" + secrets.token_hex(10)
    conn = await db.connect()
    await conn.execute(
        "INSERT INTO jit_access_requests "
        "(id, tool_id, function_name, runtime_kind, session_id, justification, "
        " rule_source, status, decided_at, decided_by) "
        "VALUES (?, '*', 'run_limit_exemption', ?, ?, "
        "'Run-limit continuation approved by the operator', "
        "'local', 'approved', datetime('now'), 'local-ui')",
        (request_id, runtime_kind, session_id),
    )
    await conn.execute(
        "INSERT INTO jit_access_grants "
        "(id, request_id, tool_id, runtime_kind, session_id, duration, "
        " granted_at, expires_at) "
        "VALUES (?, ?, '*', ?, ?, 'session', datetime('now'), "
        "datetime('now', '+24 hours'))",
        (grant_id, request_id, runtime_kind, session_id),
    )
    await conn.commit()
    return {
        "id": grant_id,
        "tool_id": "*",
        "runtime_kind": runtime_kind,
        "session_id": session_id,
        "duration": "session",
    }


async def recent_stops(db: DatabaseConnection, window_days: int = 7,
                       limit: int = 20) -> list[dict]:
    """Recent run-limit stops for the Cost Settings card, one row per session,
    with whether an exemption is already active."""
    like_clauses = " OR ".join("reason LIKE ?" for _ in STOP_PREFIXES)
    rows = await db.fetch_all(
        "SELECT trace_id, runtime_kind, session_id, reason, "
        "COUNT(*) AS stops, MAX(called_at) AS last_at "
        "FROM tool_call_audit "
        f"WHERE action = 'block' AND ({like_clauses}) "
        f"AND called_at >= datetime('now', '-{int(window_days)} days') "
        "GROUP BY trace_id, reason "
        "ORDER BY last_at DESC LIMIT ?",
        tuple(f"{p}%" for p in STOP_PREFIXES) + (limit,),
    )
    out = []
    for r in rows or []:
        d = dict(r)
        d["exempted"] = bool(
            d.get("session_id")
            and await has_run_exemption(db, d.get("runtime_kind"), d["session_id"])
        )
        out.append(d)
    return out
