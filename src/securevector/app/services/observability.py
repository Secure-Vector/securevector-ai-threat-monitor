"""Read models for the Observability pages: decision counts per run, one
session's governance summary and the Live grid of running sessions.

Reads only, apart from the lazy expiry of stale approval requests that the
JIT list route also performs on read. Every per-session figure comes from a
grouped query over the whole set of sessions, never from one request per
session, so the Live grid stays cheap with hundreds of sessions running.
"""

from __future__ import annotations

import logging
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional

from securevector.app.services import harness_coverage
from securevector.app.terminals.store import SESSION_BOUNDARY

logger = logging.getLogger(__name__)

# A session counts as running when it did something in this window, or when
# a terminal task holding it is still alive.
LIVE_WINDOW_S = 600
QUIET_AFTER_S = 300
# A blocked call that follows another blocked call to a different target
# within this many seconds reads as a retry by another route.
REPEAT_WINDOW_S = 60
BLOCKED_CALLS_CAP = 200
RUNNING_TASK_STATES = ("starting", "working", "blocked", "idle")

# Rung holds lapse after HOLD_LIMIT_S; every other request after a day.
_PLAIN_REQUEST_HOURS = 24


def _hold_limit_s() -> int:
    from securevector.app.services.response_rungs import HOLD_LIMIT_S
    return int(HOLD_LIMIT_S)


def _expiry_sql() -> str:
    return (f"CASE WHEN rule_source = 'rung' THEN datetime(requested_at, '+{_hold_limit_s()} seconds') "
            f"ELSE datetime(requested_at, '+{_PLAIN_REQUEST_HOURS} hours') END")


# Requests that hold an agent's call or destination. A delegation request
# asks for a new task, not for a call, so it is not counted as waiting.
_WAITING_SQL = "status = 'pending' AND rule_source != 'delegate'"


def parse_ts(ts: Any) -> Optional[datetime]:
    if not ts:
        return None
    s = str(ts).strip()
    try:
        dt = datetime.fromisoformat(s[:-1] + "+00:00" if s.endswith("Z") else s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def iso(ts: Any) -> Optional[str]:
    dt = parse_ts(ts)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ") if dt else None


def _newest(*values: Any) -> Optional[str]:
    dts = [d for d in (parse_ts(v) for v in values) if d]
    return max(dts).strftime("%Y-%m-%dT%H:%M:%SZ") if dts else None


def _oldest(*values: Any) -> Optional[str]:
    dts = [d for d in (parse_ts(v) for v in values) if d]
    return min(dts).strftime("%Y-%m-%dT%H:%M:%SZ") if dts else None


def _marks(items: Iterable[Any]) -> str:
    return ",".join("?" for _ in items)


async def expire_stale(db) -> None:
    """The same lazy expiry the JIT list route runs, so a count never
    includes a request that has already lapsed."""
    try:
        from securevector.app.database.repositories.jit_access import JitAccessRepository
        from securevector.app.services import response_rungs

        await JitAccessRepository(db).expire_stale_requests()
        await response_rungs.expire_holds(db)
    except Exception:  # noqa: BLE001 - counts still read; expiry retries next time
        logger.debug("approval expiry unavailable", exc_info=True)


async def _safe_all(db, sql: str, args: tuple = ()) -> list[dict]:
    try:
        rows = await db.fetch_all(sql, args)
    except Exception:  # noqa: BLE001 - an optional table never fails the page
        logger.debug("observability read failed: %s", sql.split("\n")[0], exc_info=True)
        return []
    return [dict(r) for r in rows or []]


# ------------------------------------------------------------ run decisions


async def add_decision_counts(db, runs: list[dict]) -> None:
    """Add allowed, waiting and oldest_waiting_expires_at to each run.

    ``blocked`` is already on the run. ``waiting`` counts pending requests
    filed for that run's trace, or for its session when the request carries
    no trace id. One query per table covers the whole page."""
    tids = [r.get("trace_id") for r in runs if r.get("trace_id")]
    sids = list(dict.fromkeys(r.get("session_id") for r in runs if r.get("session_id")))
    allowed: dict = {}
    if tids:
        rows = await _safe_all(
            db,
            "SELECT trace_id, SUM(CASE WHEN action = 'allow' THEN 1 ELSE 0 END) AS allowed "
            f"FROM tool_call_audit WHERE trace_id IN ({_marks(tids)}) "
            f"AND tool_id NOT IN ({_marks(SESSION_BOUNDARY)}) GROUP BY trace_id",
            (*tids, *SESSION_BOUNDARY),
        )
        allowed = {r["trace_id"]: int(r.get("allowed") or 0) for r in rows}
    pending: list[dict] = []
    if tids or sids:
        await expire_stale(db)
        pending = await _safe_all(
            db,
            f"SELECT trace_id, session_id, requested_at, {_expiry_sql()} AS expires_at FROM jit_access_requests "
            f"WHERE {_WAITING_SQL} AND (trace_id IN ({_marks(tids) or 'NULL'}) "
            f"OR (trace_id IS NULL AND session_id IN ({_marks(sids) or 'NULL'})))",
            (*tids, *sids),
        )
    by_run: dict = {}
    for p in pending:
        owner = p.get("trace_id") or _owning_run(runs, p.get("session_id"), p.get("requested_at"))
        if owner:
            by_run.setdefault(owner, []).append(p)
    for r in runs:
        tid = r.get("trace_id")
        mine = by_run.get(tid, []) if tid else []
        r["allowed"] = allowed.get(tid, 0)
        r["waiting"] = len(mine)
        r["oldest_waiting_expires_at"] = _oldest(*(p.get("expires_at") for p in mine))


def _owning_run(runs: list[dict], session_id: Optional[str], requested_at: Any) -> Optional[str]:
    """The one run a request without a trace id belongs to: the run of its
    session whose time window holds requested_at, else the session's newest
    run. Never more than one, so a request is counted once."""
    if not session_id:
        return None
    mine = [r for r in runs if r.get("session_id") == session_id and r.get("trace_id")]
    if not mine:
        return None
    at = parse_ts(requested_at)
    floor = datetime.min.replace(tzinfo=timezone.utc)
    if at is not None:
        for r in mine:
            start, end = parse_ts(r.get("started_at")), parse_ts(r.get("ended_at"))
            if start and end and start <= at <= end:
                return r["trace_id"]
    return max(mine, key=lambda r: parse_ts(r.get("ended_at")) or floor)["trace_id"]


# A requestable deny writes a block row and files a request for the same
# call; a request within this many seconds of a block of the same tool (or
# host) in the same session is that call, not a second one.
_SAME_CALL_S = 60


async def waiting_by_session(db, sids: list) -> dict:
    """{session_id: {"waiting", "unmatched", "oldest"}} for waiting requests.

    ``waiting`` counts every waiting request. ``unmatched`` leaves out the
    requests whose call is already counted as a block row (same session,
    same tool or host, within _SAME_CALL_S), so a call total never counts
    one denied call twice. The session summary and the Live grid both use
    this one definition."""
    if not sids:
        return {}
    m = _marks(sids)
    pending = await _safe_all(
        db,
        f"SELECT id, session_id, tool_id, function_name, requested_at, {_expiry_sql()} AS expires_at "
        f"FROM jit_access_requests WHERE {_WAITING_SQL} AND session_id IN ({m})",
        tuple(sids),
    )
    if not pending:
        return {}
    psids = list(dict.fromkeys(p["session_id"] for p in pending))
    pm = _marks(psids)
    floor = min((parse_ts(p.get("requested_at")) for p in pending if parse_ts(p.get("requested_at"))),
                default=datetime.now(timezone.utc)) - timedelta(seconds=_SAME_CALL_S)
    since = floor.strftime("%Y-%m-%d %H:%M:%S")
    marks: dict = {}
    for b in await _safe_all(
        db,
        "SELECT id, session_id, tool_id, function_name, called_at AS at FROM tool_call_audit "
        f"WHERE action = 'block' AND session_id IN ({pm}) AND called_at >= ?",
        (*psids, since),
    ):
        keys = {str(b.get("tool_id") or "").lower(), str(b.get("function_name") or "").lower()} - {""}
        marks.setdefault(b["session_id"], []).append({"id": ("t", b["id"]), "keys": keys, "at": b["at"]})
    for b in await _safe_all(
        db,
        "SELECT id, session_id, host, timestamp AS at FROM egress_audit "
        f"WHERE action = 'block' AND host IS NOT NULL AND session_id IN ({pm}) AND timestamp >= ?",
        (*psids, since),
    ):
        marks.setdefault(b["session_id"], []).append(
            {"id": ("e", b["id"]), "keys": {"egress:" + str(b["host"]).lower()}, "at": b["at"]})
    out: dict = {}
    used: set = set()
    for p in sorted(pending, key=lambda p: str(p.get("requested_at") or "")):
        sid = p["session_id"]
        row = out.setdefault(sid, {"waiting": 0, "unmatched": 0, "oldest": None})
        row["waiting"] += 1
        row["oldest"] = _oldest(row["oldest"], p.get("expires_at"))
        keys = {str(p.get("tool_id") or "").lower(), str(p.get("function_name") or "").lower()} - {""}
        at = parse_ts(p.get("requested_at"))
        match = None
        for mk in marks.get(sid, []):
            bt = parse_ts(mk["at"])
            if (mk["id"] not in used and mk["keys"] & keys and at and bt
                    and abs((at - bt).total_seconds()) <= _SAME_CALL_S):
                match = mk
                break
        if match:
            used.add(match["id"])
        else:
            row["unmatched"] += 1
    return out


# -------------------------------------------------------- session summary


def _repeat_flags(calls: list[dict]) -> None:
    """Mark a blocked call that follows another blocked call to a different
    target within REPEAT_WINDOW_S. ``calls`` is oldest first."""
    prev = None
    for c in calls:
        c["repeat_attempt"] = False
        t = parse_ts(c.get("called_at"))
        if prev is not None and t is not None:
            pt = parse_ts(prev.get("called_at"))
            if (pt is not None and timedelta(0) <= t - pt <= timedelta(seconds=REPEAT_WINDOW_S)
                    and c.get("_target") != prev.get("_target")):
                c["repeat_attempt"] = True
        prev = c


async def _task_for_session(db, session_id: str, harness: Optional[str]) -> Optional[dict]:
    probe = [{"session_id": session_id, "runtime_kind": harness}]
    try:
        from securevector.app.server.routes.traces import _add_terminal_tasks
        await _add_terminal_tasks(db, probe)
    except Exception:  # noqa: BLE001
        logger.debug("terminal task lookup failed", exc_info=True)
    return probe[0].get("terminal_task")


async def _findings(db, session_id: str) -> dict:
    from securevector.app.services.detection_source import classify_matched_rules, is_secret_detection

    rows = await _safe_all(
        db,
        "SELECT request_id, threat_type, matched_rules FROM threat_intel_records "
        "WHERE is_threat = 1 AND (session_id = ? OR request_id IN ("
        "SELECT request_id FROM tool_call_audit WHERE session_id = ? AND request_id IS NOT NULL))",
        (session_id, session_id),
    )
    seen: set = set()
    threats = secrets = 0
    for r in rows:
        key = r.get("request_id") or id(r)
        if key in seen:
            continue
        seen.add(key)
        threats += 1
        info = classify_matched_rules(r.get("matched_rules"))
        if is_secret_detection(r.get("threat_type"), info.get("rules") if info else None):
            secrets += 1
    return {"threats": threats, "secrets": secrets}


async def _approvals(db, session_id: str) -> dict:
    from securevector.app.database.repositories.jit_access import _shape

    grants = await _safe_all(
        db,
        "SELECT g.*, r.call_preview AS call_preview FROM jit_access_grants g "
        "LEFT JOIN jit_access_requests r ON r.id = g.request_id "
        "WHERE g.session_id = ? AND ((g.revoked_at IS NULL "
        "AND (g.expires_at IS NULL OR g.expires_at > datetime('now'))) OR g.used_at IS NOT NULL) "
        "ORDER BY g.granted_at DESC LIMIT 100",
        (session_id,),
    )
    active = []
    for g in grants:
        s = _shape(g) or {}
        active.append({
            "id": s.get("id"), "tool_id": s.get("tool_id"), "duration": s.get("duration"),
            "granted_at": iso(s.get("granted_at")), "expires_at": iso(s.get("expires_at")),
            "state": s.get("state") or "active",
            "call_preview": s.get("call_preview") if s.get("duration") == "once" else None,
            "used_at": iso(s.get("used_at")),
        })
    pending = await _safe_all(
        db,
        f"SELECT id, tool_id, function_name, rule_source, requested_at, call_preview, "
        f"{_expiry_sql()} AS expires_at FROM jit_access_requests "
        f"WHERE {_WAITING_SQL} AND session_id = ? ORDER BY requested_at ASC",
        (session_id,),
    )
    return {
        "grants": active,
        "pending": [{"id": p["id"], "tool_id": p.get("tool_id"), "function_name": p.get("function_name"),
                     "kind": "hold" if p.get("rule_source") == "rung" else "request",
                     "requested_at": iso(p.get("requested_at")), "expires_at": iso(p.get("expires_at")),
                     "call_preview": p.get("call_preview")} for p in pending],
    }


async def transcript_usage(db, harness: Optional[str], session_id: Optional[str]) -> Optional[dict]:
    """Tokens and models from the session's parsed model turns, for a
    session with no cost records (the proxy did not see it). Reuses the
    traces route's cached parse; never a price, so no cost is invented.
    None when there is no readable transcript."""
    if harness not in ("claude-code", "codex") or not session_id:
        return None
    try:
        from securevector.app.database.repositories.settings import SettingsRepository
        from securevector.app.server.routes.traces import parse_generations
        try:
            store_text = bool(getattr(await SettingsRepository(db).get(), "store_text_content", True))
        except Exception:  # noqa: BLE001 - same fallback the traces route uses
            store_text = False
        gens = await parse_generations(harness, session_id, store_text=store_text)
    except Exception:  # noqa: BLE001 - usage is best effort
        logger.debug("transcript usage unavailable", exc_info=True)
        return None
    if not gens:
        return None
    tokens = sum(int(g.get("input_tokens") or 0) + int(g.get("output_tokens") or 0) for g in gens)
    models = list(dict.fromkeys(str(g.get("model")) for g in gens if g.get("model")))
    return {"tokens": tokens, "models": models}


# Live polls every few seconds and a running transcript changes between
# polls, so the parse cache keyed by mtime misses. Token totals are kept
# here per session for a short while instead, and one Live request parses
# only a bounded number of sessions it has not seen; the rest fill on later
# polls (tokens null, tokens_pending true).
TOKENS_TTL_S = 30.0
TOKENS_CACHE_MAX = 500
LIVE_PARSE_MAX = 25
LIVE_PARSE_BUDGET_S = 0.1
_tokens_cache: "OrderedDict[str, tuple]" = OrderedDict()


def _tokens_cached(session_id: str, now_m: float):
    """(state, usage, expires) from the per-session token cache: state is
    "fresh", "stale" (expired, still served while it waits for a refresh)
    or "none" (never seen)."""
    e = _tokens_cache.get(session_id)
    if e is None:
        return "none", None, None
    _tokens_cache.move_to_end(session_id)
    return ("fresh" if e[0] >= now_m else "stale"), e[1], e[0]


def _tokens_store(session_id: str, usage: Optional[dict], now_m: float) -> None:
    _tokens_cache[session_id] = (now_m + TOKENS_TTL_S, usage)
    _tokens_cache.move_to_end(session_id)
    while len(_tokens_cache) > TOKENS_CACHE_MAX:
        _tokens_cache.popitem(last=False)


def _cost_total(items: list) -> tuple:
    """(total usd, sessions with a recorded cost). The total is None when no
    session in the set has one: an unknown cost is never a known $0."""
    known = [s for s in items if s.get("cost_source") == "proxy" and s.get("cost_usd") is not None]
    if not known:
        return None, 0
    return round(sum(float(s["cost_usd"]) for s in known), 6), len(known)


def _cost_block(c: dict, usage: Optional[dict]) -> dict:
    """The summary's cost: from cost records ("proxy") when there are any,
    else tokens from the transcript with no price ("transcript"). A cost
    that was not recorded is null, never 0."""
    if int(c.get("n") or 0) > 0:
        models = [m for m in (c.get("models") or "").split(",") if m]
        return {"usd": round(float(c.get("usd") or 0.0), 6), "tokens": int(c.get("tokens") or 0),
                "models": models, "source": "proxy"}
    if usage:
        return {"usd": None, "tokens": int(usage["tokens"]), "models": usage["models"], "source": "transcript"}
    return {"usd": None, "tokens": 0, "models": [], "source": None}


async def session_governance(db, session_id: str) -> Optional[dict]:
    """Everything the governance strip shows for one session, or None when
    nothing is recorded for it."""
    from securevector.app.database.repositories.egress import EgressRepository
    from securevector.app.server.routes.traces import _egress_calls_by_trace

    await expire_stale(db)
    audit = await _safe_all(
        db,
        "SELECT MAX(runtime_kind) AS harness, MIN(called_at) AS first, MAX(called_at) AS last, "
        "SUM(CASE WHEN action = 'allow' THEN 1 ELSE 0 END) AS allowed, "
        "SUM(CASE WHEN action = 'log_only' THEN 1 ELSE 0 END) AS logged, "
        "SUM(CASE WHEN action = 'block' THEN 1 ELSE 0 END) AS blocked "
        f"FROM tool_call_audit WHERE session_id = ? AND tool_id NOT IN ({_marks(SESSION_BOUNDARY)})",
        (session_id, *SESSION_BOUNDARY),
    )
    a = audit[0] if audit else {}
    cost_rows = await _safe_all(
        db,
        "SELECT MAX(runtime_kind) AS harness, MIN(COALESCE(started_at, recorded_at)) AS first, "
        "MAX(COALESCE(started_at, recorded_at)) AS last, SUM(total_cost_usd) AS usd, "
        "SUM(input_tokens + input_cached_tokens + output_tokens) AS tokens, "
        "GROUP_CONCAT(DISTINCT model_id) AS models, COUNT(*) AS n "
        "FROM llm_cost_records WHERE session_id = ?",
        (session_id,),
    )
    c = cost_rows[0] if cost_rows else {}
    eg_rows = await _safe_all(
        db, "SELECT MIN(timestamp) AS first, MAX(timestamp) AS last, MAX(runtime_kind) AS harness "
            "FROM egress_audit WHERE session_id = ?", (session_id,))
    e = eg_rows[0] if eg_rows else {}
    pending_n = await _safe_all(
        db, f"SELECT COUNT(*) AS n FROM jit_access_requests WHERE {_WAITING_SQL} AND session_id = ?",
        (session_id,))
    if not (a.get("first") or c.get("n") or e.get("first") or (pending_n and pending_n[0].get("n"))):
        return None

    harness = a.get("harness") or c.get("harness") or e.get("harness")
    task = await _task_for_session(db, session_id, harness)
    coverage = harness_coverage.coverage(harness)

    trace_rows = await _safe_all(
        db,
        "SELECT trace_id, MAX(t) AS last FROM ("
        "SELECT trace_id, called_at AS t FROM tool_call_audit WHERE session_id = ? AND trace_id IS NOT NULL "
        "UNION ALL SELECT trace_id, COALESCE(started_at, recorded_at) FROM llm_cost_records "
        "WHERE session_id = ? AND trace_id IS NOT NULL) GROUP BY trace_id",
        (session_id, session_id),
    )
    trace_rows.sort(key=lambda r: parse_ts(r.get("last")) or datetime.min.replace(tzinfo=timezone.utc),
                    reverse=True)

    # Blocked calls: tool-call blocks plus refused destinations, oldest first
    # for the repeat check, returned newest first.
    blocked_audit = await _safe_all(
        db,
        "SELECT span_id, row_hash, trace_id, tool_id, args_preview, reason, called_at "
        "FROM tool_call_audit WHERE session_id = ? AND action = 'block' "
        "ORDER BY seq DESC LIMIT ?",
        (session_id, BLOCKED_CALLS_CAP),
    )
    blocked: list[dict] = []
    for b in blocked_audit:
        blocked.append({
            "span_id": b.get("span_id") or b.get("row_hash"), "trace_id": b.get("trace_id"),
            "tool_id": b.get("tool_id"), "args_preview": b.get("args_preview"),
            "reason": b.get("reason"), "rule": None, "kind": "tool",
            "called_at": iso(b.get("called_at")),
            "_target": f"tool:{b.get('tool_id')}:{b.get('args_preview') or ''}",
        })
    # Every refused call of the session, run or no run (the same count the
    # Live grid reads); the run it belongs to when one holds it.
    try:
        egress_calls = await EgressRepository(db).blocked_calls([session_id])
    except Exception:  # noqa: BLE001
        egress_calls = []
    try:
        egress_by_trace = await _egress_calls_by_trace(db, [session_id])
    except Exception:  # noqa: BLE001
        egress_by_trace = {}
    owner = {c.get("call_key"): tid for tid, calls in egress_by_trace.items() for c in calls}
    egress_blocked = 0
    for call in egress_calls:
        egress_blocked += 1
        hosts = call.get("hosts") or []
        blocked.append({
            "span_id": call.get("call_key"), "trace_id": owner.get(call.get("call_key")),
            "tool_id": call.get("tool_name"),
            "args_preview": ", ".join(hosts) or None, "reason": "Destination refused",
            "rule": ",".join(call.get("rule_ids") or []) or None, "kind": "egress",
            "called_at": iso(call.get("called_at")), "hosts": hosts,
            "_target": "host:" + ",".join(hosts),
        })
    blocked.sort(key=lambda x: parse_ts(x.get("called_at")) or datetime.min.replace(tzinfo=timezone.utc))
    _repeat_flags(blocked)
    for b in blocked:
        b.pop("_target", None)
    blocked.reverse()
    blocked = blocked[:BLOCKED_CALLS_CAP]

    approvals = await _approvals(db, session_id)
    w = (await waiting_by_session(db, [session_id])).get(session_id) or {}
    waiting = int(w.get("waiting") or 0)
    allowed = int(a.get("allowed") or 0)
    logged = int(a.get("logged") or 0)
    blocked_n = int(a.get("blocked") or 0) + egress_blocked

    # Egress hosts with their state in this session.
    try:
        dests = await EgressRepository(db).session_destinations(session_id, limit=200)
    except Exception:  # noqa: BLE001
        dests = []
    waiting_hosts = {str(p.get("tool_id") or "")[len("egress:"):].lower()
                     for p in approvals["pending"] if str(p.get("tool_id") or "").startswith("egress:")}
    hosts = []
    for d in dests:
        host = str(d.get("host") or "")
        status = ("waiting" if host.lower() in waiting_hosts
                  else "blocked" if int(d.get("blocked") or 0) > 0 else "allowed")
        hosts.append({"host": host, "calls": int(d.get("calls") or 0), "status": status})
    for h in sorted(waiting_hosts - {x["host"].lower() for x in hosts}):
        hosts.append({"host": h, "calls": 0, "status": "waiting"})

    score = None
    if coverage.get("enforced") == "before_call":
        # The stored row first, the same one the Live grid reads, so the two
        # never disagree; recompute only when nothing is stored yet.
        stored = await _safe_all(
            db, "SELECT score, band, status FROM session_drift WHERE session_id = ?", (session_id,))
        if stored and stored[0].get("score") is not None:
            row = stored[0]
            score = {"score": int(row["score"]), "band": row.get("band"), "status": row.get("status")}
        else:
            try:
                from securevector.app.services import session_drift
                res = await session_drift.score_for(session_id, db=db, store=False)
                score = {"score": res.score, "band": res.band, "status": res.status}
            except Exception:  # noqa: BLE001 - the strip shows no score rather than fail
                logger.debug("session score unavailable", exc_info=True)

    return {
        "session_id": session_id,
        "harness": harness,
        "project": (task or {}).get("workspace_name"),
        "terminal_task": task,
        "host": None,
        "user": None,
        "started_at": _oldest(a.get("first"), c.get("first"), e.get("first")),
        "last_activity_at": _newest(a.get("last"), c.get("last"), e.get("last")),
        "runs": {"count": len(trace_rows), "trace_ids": [r["trace_id"] for r in trace_rows]},
        "tool_calls": {"total": allowed + logged + blocked_n + int(w.get("unmatched") or 0),
                       "allowed": allowed, "logged": logged, "waiting": waiting, "blocked": blocked_n},
        "blocked_calls": blocked,
        "egress": {"hosts": hosts, "visible": bool(coverage.get("egress_visible"))},
        "cost": _cost_block(c, None if int(c.get("n") or 0) > 0
                            else await transcript_usage(db, harness, session_id)),
        "findings": await _findings(db, session_id),
        "score": score,
        "coverage": coverage,
        "approvals": approvals,
    }


# --------------------------------------------------------------- live grid


def _group_key(s: dict, group: str) -> str:
    if group == "host":
        return s.get("host") or "unknown"
    if group == "project":
        return s.get("project") or "unknown"
    if group == "harness":
        return s.get("harness") or "unknown"
    return "all"


def _sort_key(s: dict, now: datetime):
    last = parse_ts(s.get("last_activity_at"))
    exp = parse_ts(s.get("oldest_waiting_expires_at"))
    return (
        0 if s["waiting"] else 1,
        exp.timestamp() if exp else 0.0,
        0 if s["blocked"] else 1,
        -(s["score"] if isinstance(s.get("score"), (int, float)) else -1),
        -(last.timestamp() if last else 0.0),
    )


def _rollup(items: list[dict]) -> dict:
    scores = [s["score"] for s in items if isinstance(s.get("score"), (int, float))]
    return {
        "running": len(items),
        "waiting": sum(s["waiting"] for s in items),
        "blocked_sessions": sum(1 for s in items if s["blocked"]),
        "blocked": sum(s["blocked"] for s in items),
        "cost_usd": _cost_total(items)[0],
        "cost_known_sessions": _cost_total(items)[1],
        "tokens": sum(s["tokens"] or 0 for s in items),
        "max_score": max(scores) if scores else None,
    }


async def live_sessions(db, group: str = "none", limit: int = 200, now: Optional[datetime] = None) -> dict:
    """Running sessions with their attention counters, in aggregate SQL."""
    now = now or datetime.now(timezone.utc)
    cutoff = (now - timedelta(seconds=LIVE_WINDOW_S)).strftime("%Y-%m-%d %H:%M:%S")
    await expire_stale(db)

    # 1. Which sessions are running.
    recent = await _safe_all(
        db,
        # UNION removes duplicates; a DISTINCT per branch would steer SQLite
        # to scan the session index instead of the time range.
        "SELECT session_id FROM tool_call_audit WHERE called_at >= ? AND session_id IS NOT NULL "
        "UNION SELECT session_id FROM llm_cost_records WHERE recorded_at >= ? AND session_id IS NOT NULL "
        "UNION SELECT session_id FROM egress_audit WHERE timestamp >= ? AND session_id IS NOT NULL",
        (cutoff, cutoff, cutoff),
    )
    tasks = await _safe_all(
        db,
        f"SELECT session_id, executor_id FROM terminal_tasks WHERE archived_at IS NULL "
        f"AND session_id IS NOT NULL AND status IN ({_marks(RUNNING_TASK_STATES)})",
        RUNNING_TASK_STATES,
    )
    sids = list(dict.fromkeys([r["session_id"] for r in recent] + [t["session_id"] for t in tasks]))
    sids = sids[:2000]
    sessions: dict = {sid: {
        "session_id": sid, "harness": None, "project": None, "host": None,
        "started_at": None, "last_activity_at": None, "quiet_seconds": None,
        "tool_calls": {"total": 0, "allowed": 0, "logged": 0, "waiting": 0, "blocked": 0},
        "_unmatched": 0,
        "waiting": 0, "oldest_waiting_expires_at": None, "blocked": 0,
        "score": None, "cost_usd": None, "tokens": 0, "cost_source": None, "tokens_pending": False,
    } for sid in sids}
    if sids:
        m = _marks(sids)
        # 2. Tool-call counts and bounds.
        for r in await _safe_all(
            db,
            "SELECT session_id, MAX(runtime_kind) AS harness, MIN(called_at) AS first, MAX(called_at) AS last, "
            "SUM(CASE WHEN action = 'allow' AND tool_id NOT IN (?, ?) THEN 1 ELSE 0 END) AS allowed, "
            "SUM(CASE WHEN action = 'log_only' THEN 1 ELSE 0 END) AS logged, "
            "SUM(CASE WHEN action = 'block' THEN 1 ELSE 0 END) AS blocked "
            f"FROM tool_call_audit WHERE session_id IN ({m}) GROUP BY session_id",
            (*SESSION_BOUNDARY, *sids),
        ):
            s = sessions[r["session_id"]]
            s["harness"] = r.get("harness")
            s["started_at"], s["last_activity_at"] = r.get("first"), r.get("last")
            s["tool_calls"]["allowed"] = int(r.get("allowed") or 0)
            s["tool_calls"]["logged"] = int(r.get("logged") or 0)
            s["blocked"] = int(r.get("blocked") or 0)
        # 3. Cost and tokens.
        for r in await _safe_all(
            db,
            "SELECT session_id, MAX(runtime_kind) AS harness, MIN(COALESCE(started_at, recorded_at)) AS first, "
            "MAX(COALESCE(started_at, recorded_at)) AS last, SUM(total_cost_usd) AS usd, "
            "SUM(input_tokens + input_cached_tokens + output_tokens) AS tokens "
            f"FROM llm_cost_records WHERE session_id IN ({m}) GROUP BY session_id",
            tuple(sids),
        ):
            s = sessions[r["session_id"]]
            s["harness"] = s["harness"] or r.get("harness")
            s["started_at"] = _oldest(s["started_at"], r.get("first"))
            s["last_activity_at"] = _newest(s["last_activity_at"], r.get("last"))
            s["cost_usd"] = round(float(r.get("usd") or 0.0), 6)
            s["tokens"] = int(r.get("tokens") or 0)
            s["cost_source"] = "proxy"
        # 4. Refused destinations, one per call.
        from securevector.app.database.repositories.egress import EgressRepository
        key = EgressRepository._CALL_KEY_SQL
        for r in await _safe_all(
            db,
            f"SELECT session_id, MAX(runtime_kind) AS harness, MIN(timestamp) AS first, MAX(timestamp) AS last, "
            f"COUNT(DISTINCT CASE WHEN action = 'block' AND host IS NOT NULL THEN {key} END) AS blocked "
            f"FROM egress_audit WHERE session_id IN ({m}) GROUP BY session_id",
            tuple(sids),
        ):
            s = sessions[r["session_id"]]
            s["harness"] = s["harness"] or r.get("harness")
            s["started_at"] = _oldest(s["started_at"], r.get("first"))
            s["last_activity_at"] = _newest(s["last_activity_at"], r.get("last"))
            s["blocked"] += int(r.get("blocked") or 0)
        # 5. Waiting requests with the oldest expiry.
        for sid, w in (await waiting_by_session(db, sids)).items():
            s = sessions[sid]
            s["waiting"] = w["waiting"]
            s["_unmatched"] = w["unmatched"]
            s["oldest_waiting_expires_at"] = w["oldest"]
        # 6. Stored scores (computed by the drift scorer, never here).
        scores = {r["session_id"]: r for r in await _safe_all(
            db, f"SELECT session_id, score FROM session_drift WHERE session_id IN ({m})", tuple(sids))}
        # 7. Projects from linked terminal tasks, one query.
        probe = [{"session_id": sid, "runtime_kind": s["harness"]} for sid, s in sessions.items()]
        task_exec = {t["session_id"]: t.get("executor_id") for t in tasks}
        for p in probe:
            if not p["runtime_kind"] and task_exec.get(p["session_id"]):
                p["runtime_kind"] = task_exec[p["session_id"]]
                sessions[p["session_id"]]["harness"] = p["runtime_kind"]
        try:
            from securevector.app.server.routes.traces import _add_terminal_tasks
            await _add_terminal_tasks(db, probe)
        except Exception:  # noqa: BLE001
            logger.debug("terminal task lookup failed", exc_info=True)
        for p in probe:
            s = sessions[p["session_id"]]
            s["project"] = (p.get("terminal_task") or {}).get("workspace_name")
            cov = harness_coverage.coverage(s["harness"])
            s["coverage"] = harness_coverage.label(s["harness"])
            s["coverage_level"] = cov["level"]
            sc = scores.get(s["session_id"])
            if cov.get("enforced") == "before_call" and sc and sc.get("score") is not None:
                s["score"] = int(sc["score"])
        # 8. No cost records: tokens from the transcript, cost not recorded.
        # Cached totals first, an expired one served until it is refreshed.
        # At most LIVE_PARSE_MAX parses (or LIVE_PARSE_BUDGET_S) per request:
        # never-seen sessions first, then the stalest expired ones, so every
        # session fills within a few polls and none starves.
        now_m = time.monotonic()
        never, stale = [], []
        for s in sessions.values():
            if s.get("cost_source") is not None or s["harness"] not in ("claude-code", "codex"):
                continue
            state, usage, expires = _tokens_cached(s["session_id"], now_m)
            if state == "none":
                never.append(s)
                continue
            if usage:
                s["tokens"] = int(usage["tokens"])
                s["cost_source"] = "transcript"
            if state == "stale":
                stale.append((expires, s))
        stale.sort(key=lambda x: x[0])
        parsed = 0
        never_ids = {id(s) for s in never}
        for s in never + [x[1] for x in stale]:
            if parsed >= LIVE_PARSE_MAX or time.monotonic() - now_m > LIVE_PARSE_BUDGET_S:
                if id(s) in never_ids:
                    s["tokens"] = None
                    s["tokens_pending"] = True
                continue
            usage = await transcript_usage(db, s["harness"], s["session_id"])
            parsed += 1
            _tokens_store(s["session_id"], usage, time.monotonic())
            if usage:
                s["tokens"] = int(usage["tokens"])
                s["cost_source"] = "transcript"

    out = []
    for s in sessions.values():
        s["started_at"] = iso(s["started_at"])
        s["last_activity_at"] = iso(s["last_activity_at"])
        last = parse_ts(s["last_activity_at"])
        s["quiet_seconds"] = max(0, int((now - last).total_seconds())) if last else None
        tc = s["tool_calls"]
        tc["waiting"], tc["blocked"] = s["waiting"], s["blocked"]
        tc["total"] = tc["allowed"] + tc["logged"] + tc["blocked"] + s.pop("_unmatched", 0)
        out.append(s)
    out.sort(key=lambda s: _sort_key(s, now))
    # Counters and group rollups cover every running session; the list
    # itself stops at `limit`.
    everything, out = out, out[:max(1, int(limit))]
    shown = {s["session_id"] for s in out}

    counters = {
        "running": len(everything),
        "waiting": sum(s["waiting"] for s in everything),
        "blocked_sessions": sum(1 for s in everything if s["blocked"]),
        "score_70_plus": sum(1 for s in everything if isinstance(s.get("score"), int) and s["score"] >= 70),
        "quiet_over_5m": sum(1 for s in everything if (s.get("quiet_seconds") or 0) > QUIET_AFTER_S),
        "cost_usd": _cost_total(everything)[0],
        "cost_known_sessions": _cost_total(everything)[1],
        "tokens": sum(s["tokens"] or 0 for s in everything),
        "coverage_partial": sum(1 for s in everything if s.get("coverage_level") == "partial"),
        "coverage_not_enforced": sum(1 for s in everything if s.get("coverage_level") == "not_enforced"),
    }
    body: dict = {"group": group, "sessions": out, "counters": counters, "limit": int(limit)}
    if group in ("host", "project", "harness"):
        groups: dict = {}
        for s in everything:
            groups.setdefault(_group_key(s, group), []).append(s)
        body["groups"] = [{"key": k, "session_ids": [s["session_id"] for s in v if s["session_id"] in shown],
                           "rollup": _rollup(v)} for k, v in groups.items()]
    return body
