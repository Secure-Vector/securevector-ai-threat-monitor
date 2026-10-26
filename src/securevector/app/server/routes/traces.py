"""Agent Run Trace routes (story #142).

Read-only aggregation that groups the flat tool_call_audit log into agent
**runs** (one per trace_id / runtime session, per the v36 run-boundary rule)
and, per run, an ordered list of **spans** — each an enforced tool call
carrying its allow / block / log_only verdict, risk, reason, and timestamp.

This is the *time* view to the Agent Map's *topology* view: "what did this
agent try to do, turn by turn, and what did we stop?" The enforcement verdict
on each span is something a pure observability tool cannot show.

Pure read over tool_call_audit (+ the v36 trace keys); no migration, no writes.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import PurePath
from typing import Annotated, Optional

from fastapi import APIRouter, HTTPException, Query

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.costs import CostsRepository
from securevector.app.database.repositories.custom_tools import CustomToolsRepository
from securevector.app.database.repositories.settings import SettingsRepository
from securevector.app.server.routes.transcript_generations import (
    _find_codex_rollout,
    _find_transcript,
    apply_cost,
    build_generations,
    build_generations_codex,
)
from securevector.app.services import run_health
from securevector.app.terminals.store import RUNTIME_TO_EXECUTOR

router = APIRouter()
logger = logging.getLogger(__name__)

_HIGH_RISK = {"delete", "admin", "write"}

# Max generation (LLM turn) spans returned per trace. A huge session can have
# thousands; rendering them all un-virtualised is slow, so we cap and disclose.
_GENERATION_CAP = 1500

# Tree view (GET /api/traces/{id}?view=tree): spans per page.
_TREE_LIMIT_DEFAULT = 200
_TREE_LIMIT_MAX = 1000

# action → (outcome, verdict label, traffic-light colour)
_VERDICT = {
    "block": ("blocked", "BLOCKED", "red"),
    "log_only": ("log_only", "LOG", "grey"),
    "allow": ("allow", "ALLOW", "green"),
}


def _ts_key(ts: Optional[str]) -> datetime:
    """Parse a span/generation timestamp into a UTC datetime for merge-sort.

    Two timestamp shapes flow in: tool_call_audit's ``called_at`` (SQLite
    ``CURRENT_TIMESTAMP`` -> ``YYYY-MM-DD HH:MM:SS``, UTC, no zone) and the
    transcript's ISO-8601 ``timestamp`` (``...Z``). Normalise both to
    timezone-aware UTC so tool spans and generation spans interleave in true
    chronological order. Unparseable / missing -> epoch (sorts first) so a
    stray row never crashes the merge.
    """
    if not ts:
        return datetime.min.replace(tzinfo=timezone.utc)
    s = ts.strip()
    try:
        norm = s.replace("Z", "+00:00") if s.endswith("Z") else s
        # SQLite "YYYY-MM-DD HH:MM:SS" — fromisoformat accepts the space sep.
        dt = datetime.fromisoformat(norm)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return datetime.min.replace(tzinfo=timezone.utc)


def _run_risk(
    blocked: int,
    recent_risk: Optional[str],
    detections: int = 0,
    secrets: int = 0,
) -> str:
    """Roll-up ring colour for a run card.

    red = enforcement fired; amber = something was DETECTED (threat detections,
    secrets, or a high-risk tool profile) even though nothing was blocked.
    A run with live detections must never show green — the Map and Traces
    surfaces have to agree on what amber means.
    """
    if blocked > 0:
        return "red"
    if detections > 0 or secrets > 0:
        return "amber"
    if (recent_risk or "").lower() in _HIGH_RISK:
        return "amber"
    return "green"


@router.get("/traces")
async def list_traces(
    window_days: int = Query(7, ge=1, le=90),
    limit: int = Query(50, ge=1, le=500),
    health: Optional[str] = Query(None, pattern="^(loop|failing|wasteful|0)$"),
):
    """List agent runs (traces) in the window, newest first.

    Each run summarises one agent session: span + block counts, time bounds,
    the distinct tools touched, and a roll-up risk ring. Each run also
    carries ``health`` counts ({loop, failing, wasteful}); ``health``
    narrows the list to runs with that kind of finding (applied before the
    limit), and ``health=0`` skips health for callers that do not show it.
    """
    if health == "0":
        runs = await _collect_runs(window_days, limit)
        await _add_terminal_tasks(get_database(), runs)
        return {"window_days": window_days, "runs": runs}
    runs, _ = await _runs_with_health(window_days, limit, health)
    await _add_terminal_tasks(get_database(), runs)
    return {"window_days": window_days, "runs": runs}


async def _add_terminal_tasks(db, runs: list[dict]) -> None:
    """Decorate listed sessions with an exact, compatible, non-archived board task.

    A session id alone is not sufficient: unrelated harnesses can reuse one.
    Read the final page in one query, and leave trace delivery intact when the
    optional Terminal table is absent or temporarily unavailable.
    """
    sessions = list(dict.fromkeys(
        r.get("session_id") for r in runs
        if r.get("session_id") and r.get("runtime_kind") in RUNTIME_TO_EXECUTOR
    ))
    if not sessions:
        return
    try:
        marks = ",".join("?" for _ in sessions)
        rows = await db.fetch_all(
            "SELECT id, title, workspace, origin, executor_id, session_id "
            "FROM terminal_tasks WHERE archived_at IS NULL "
            f"AND session_id IN ({marks}) "
            "ORDER BY created_at DESC, rowid DESC",
            tuple(sessions),
        )
        # A session the task held before a re-link (after /clear) is still
        # the task's: match it through the task's re-link events.
        hist_rows = await db.fetch_all(
            "SELECT t.id, t.title, t.workspace, t.origin, t.executor_id, "
            "e.detail AS session_id FROM terminal_events e "
            "JOIN terminal_tasks t ON t.id = e.task_id "
            "WHERE e.kind = 'session_relinked' AND t.archived_at IS NULL "
            f"AND e.detail IN ({marks}) ORDER BY e.seq DESC",
            tuple(sessions),
        )
    except Exception:  # noqa: BLE001 - optional board data cannot hide traces
        logger.debug("Terminal task lookup unavailable for trace list", exc_info=True)
        return
    matched = {}
    for raw in list(rows) + list(hist_rows):
        task = dict(raw)
        matched.setdefault((task["session_id"], task["executor_id"]), task)
    for run in runs:
        task = matched.get((run.get("session_id"), RUNTIME_TO_EXECUTOR.get(run.get("runtime_kind"))))
        if task:
            ws = task.get("workspace")
            run["terminal_task"] = {
                "id": task.get("id"),
                "title": task.get("title"),
                # Folder name only — the full path never leaves this process.
                "workspace_name": PurePath(ws).name if ws else None,
                "origin": task.get("origin"),
            }


async def _collect_runs(window_days: int, limit: int) -> list:
    """The runs list body: audit runs plus generation-only runs, newest
    first, with egress denies folded in."""
    db = get_database()
    repo = CustomToolsRepository(db)
    rows = await repo.get_trace_runs(window_days=window_days, limit=limit)
    # Per-trace threat/secret roll-up so each card can flag "this session had
    # threats" — the list becomes a triage surface, not just a picker.
    detections = await repo.get_trace_detection_counts(window_days=window_days)

    # 5.3.0: generation rows (model turns) per run, from llm_cost_records.
    # Runs that only have model calls (no tool calls) come from here alone.
    try:
        gen_rows = await CostsRepository(db).get_generation_runs(window_days=window_days, limit=limit)
    except Exception:  # noqa: BLE001 - cost table trouble must not hide tool runs
        gen_rows = []
    gen_by_trace = {g.get("trace_id"): g for g in gen_rows}

    def _usage(g: Optional[dict]) -> dict:
        g = g or {}
        cost = float(g.get("cost") or 0.0)
        return {
            "generations": int(g.get("generations") or 0),
            "tokens": int(g.get("tokens") or 0),
            "cost": round(cost, 6),
            "max_turn_cost": round(float(g.get("max_turn_cost") or 0.0), 6),
            "flagged": int(g.get("flagged") or 0),
            "models": [m for m in (g.get("models") or "").split(",") if m][:4],
        }

    runs = []
    seen = set()
    for r in rows:
        seen.add(r.get("trace_id"))
        blocked = int(r.get("blocked") or 0)
        tools = (r.get("tools") or "")
        det = detections.get(r.get("trace_id")) or {}
        runs.append({
            "trace_id": r.get("trace_id"),
            "runtime_kind": r.get("runtime_kind") or "unknown",
            "session_id": r.get("session_id"),
            "spans": int(r.get("spans") or 0),
            "blocked": blocked,
            "log_only": int(r.get("logged") or 0),
            "detections": int(det.get("detections") or 0),
            "secrets": int(det.get("secrets") or 0),
            "started_at": r.get("started_at"),
            "ended_at": r.get("ended_at"),
            "risk": _run_risk(
                blocked,
                r.get("recent_risk"),
                detections=int(det.get("detections") or 0),
                secrets=int(det.get("secrets") or 0),
            ),
            "tools": [t for t in tools.split(",") if t][:8],
            **_usage(gen_by_trace.get(r.get("trace_id"))),
        })
    for tid, g in gen_by_trace.items():
        if tid in seen:
            continue
        usage = _usage(g)
        runs.append({
            "trace_id": tid,
            "runtime_kind": g.get("runtime_kind") or "unknown",
            "session_id": g.get("session_id"),
            "spans": 0,
            "blocked": 0,
            "log_only": 0,
            "detections": 0,
            "secrets": 0,
            "started_at": g.get("started_at"),
            "ended_at": g.get("ended_at"),
            "risk": "amber" if usage["flagged"] else "green",
            "tools": [],
            **usage,
        })
    runs.sort(key=lambda x: _ts_key(x.get("ended_at")), reverse=True)
    runs = runs[:limit]
    await _add_egress_blocked(db, runs, window_days)
    # allowed / waiting / oldest_waiting_expires_at next to `blocked`.
    from securevector.app.services.observability import add_decision_counts
    await add_decision_counts(db, runs)
    return runs


def _health_key(ts: Optional[str]) -> str:
    """Cache key time for a run: its last span time, normalised so the
    list (SQL text) and the detail (the same rows) agree."""
    return _ts_key(ts).isoformat() if ts else ""


# A health filter looks past the page limit: filter this many newest runs,
# then keep ``limit`` of the matches.
_HEALTH_FILTER_SCAN = 500


async def _runs_with_health(window_days: int, limit: int, health: Optional[str] = None) -> tuple:
    """Runs plus each run's findings. One grouped read of tool_call_audit
    covers every listed run (same_call, cycle, reread, blocked). A run with a
    full result in the cache uses it, marked ``health_stale`` when the run
    has moved on since (kept until the warm-up or an open recomputes it, so
    badges do not vanish mid-run); the rest are ``health_partial``. No
    transcript is read here."""
    want = health if health in ("loop", "failing", "wasteful") else None
    runs = await _collect_runs(window_days, _HEALTH_FILTER_SCAN if want else limit)
    db = get_database()
    try:
        rows_by_trace = await CustomToolsRepository(db).get_health_rows(
            [r.get("trace_id") for r in runs if int(r.get("spans") or 0) > 0],
            prefix_chars=run_health.IDENTITY_PREFIX_CHARS,
        )
    except Exception:  # noqa: BLE001 - health is additive; never hide the runs
        rows_by_trace = {}
    findings_by_trace: dict = {}
    for r in runs:
        tid = r.get("trace_id")
        full = run_health.cached_any(tid, _health_key(r.get("ended_at")))
        if full is not None:
            findings = full.get("findings") or []
            r["health_partial"] = False
            r["health_stale"] = bool(full.get("stale"))
        else:
            calls = run_health.calls_from_spans(rows_by_trace.get(tid) or [])
            findings = run_health.audit_findings(calls, int(r.get("egress_blocked") or 0))
            r["health_partial"] = True
            r["health_stale"] = False
        counts = run_health.counts_of(findings)
        r["health"] = {k: counts[k] for k in ("loop", "failing", "wasteful")}
        findings_by_trace[tid] = findings
    if want:
        runs = [r for r in runs if r["health"].get(want)]
    runs = runs[:limit]
    return runs, {r.get("trace_id"): findings_by_trace.get(r.get("trace_id")) or [] for r in runs}


@router.get("/blocked-ledger")
async def blocked_ledger(window_days: int = Query(7, ge=1, le=90)):
    """The blocked-action ledger — what enforcement prevented, grouped by why.

    Returns a summary (total prevented, tools blocked, agents affected), a
    per-reason breakdown with hit counts, and a per-tool breakdown. This is the
    security-console view no pure-observability tool ships: not "what happened"
    but "what we stopped, and which policy fired."
    """
    db = get_database()
    repo = CustomToolsRepository(db)
    return await repo.get_blocked_ledger(window_days=window_days)


@router.get("/traces/{trace_id}")
async def get_trace(
    trace_id: str,
    view: Annotated[str, Query(pattern="^(full|tree)$")] = "full",
    limit: Annotated[int, Query(ge=1, le=_TREE_LIMIT_MAX)] = _TREE_LIMIT_DEFAULT,
    before: Annotated[Optional[str], Query(max_length=512)] = None,
    after: Annotated[Optional[str], Query(max_length=512)] = None,
    decision: Annotated[Optional[str], Query(pattern="^(block|error|waiting|log_only)$")] = None,
):
    """Return one run's spans.

    ``view=full`` (the default, unchanged): every span with every field, for
    export and for the callers that need it.

    ``view=tree``: one page of spans for the span tree (``decision``: only
    the blocked, failed or waiting calls and their turns), the newest ``limit``
    (or the ``limit`` older than ``before``, or the spans newer than
    ``after``), each cut to what a row needs (see ``_slim_span``), with the
    run totals so badges stay right however few spans are loaded. A span's
    full detail is ``GET /api/traces/{id}/spans/{sk}``.
    """
    full = await _build_trace_cached(trace_id)
    if view == "full":
        return full
    pending = await _pending_requests(trace_id, full.get("session_id")) if decision == "waiting" else None
    return _tree_page(full, limit=limit, before=before, after=after, decision=decision, pending=pending)


async def _pending_requests(trace_id: str, session_id: Optional[str]) -> list:
    """The run's pending approval requests (tool and time only)."""
    try:
        rows = await get_database().fetch_all(
            "SELECT tool_id, function_name, requested_at FROM jit_access_requests "
            "WHERE status = 'pending' AND (trace_id = ? OR (session_id IS NOT NULL AND session_id = ?))",
            (trace_id, session_id or ""),
        )
    except Exception:  # noqa: BLE001 — no table, no waiting calls
        return []
    return [dict(r) for r in rows or []]


@router.get("/trace-spans/lookup")
async def lookup_span(hash: Annotated[str, Query(pattern="^[0-9a-fA-F]{8,128}$")]):
    """The run and span a span hash (a row hash or span id, or the start of
    one) names: one indexed-free scan of the audit table's two id columns,
    instead of the client fetching run after run to look. Newest match wins."""
    q = hash.lower()
    row = await get_database().fetch_one(
        "SELECT trace_id, seq, span_id, row_hash FROM tool_call_audit "
        "WHERE trace_id IS NOT NULL AND (substr(lower(row_hash), 1, ?) = ? OR substr(lower(span_id), 1, ?) = ?) "
        "ORDER BY seq DESC LIMIT 1",
        (len(q), q, len(q), q),
    )
    if not row:
        raise HTTPException(status_code=404, detail="no span with that hash")
    r = dict(row)
    return {"trace_id": r["trace_id"], "sk": f"t:{r['seq']}", "span_id": r.get("span_id"), "row_hash": r.get("row_hash")}


@router.get("/traces/{trace_id}/spans/{span_key}")
async def get_trace_span(trace_id: str, span_key: str):
    """One span's full detail, for the span panel and the copy command.

    ``span_key`` is the span's ``sk`` from the tree view, or its span_id,
    row_hash or request_id."""
    full = await _build_trace_cached(trace_id)
    spans = full.get("spans") or []
    for field in ("sk", "span_id", "row_hash", "request_id"):
        for i, s in enumerate(spans):
            if (_span_key(s) if field == "sk" else s.get(field)) == span_key:
                return {"trace_id": trace_id, "sk": _span_key(s), "span": s}
    raise HTTPException(status_code=404, detail="span not found")


# --- tree view (paged, slim spans) -----------------------------------------

_TREE_TEXT_CAP = 300   # chars kept of any one text field in a tree span
_TREE_LIST_CAP = 50    # items kept of any one list field in a tree span
_TREE_DROP = frozenset({"input_text"})  # full user prompt: span detail only

# The full build of one run is reused while the run is unchanged (same audit
# rows, stored generations and transcript) and for at most _TRACE_MEMO_TTL_S,
# so a page, the next page and a span detail opened together build it once.
_TRACE_MEMO_TTL_S = 30.0
_TRACE_MEMO_MAX = 2
_trace_memo: "OrderedDict[tuple, tuple]" = OrderedDict()


async def _trace_sig(db, trace_id: str, head: Optional[dict]) -> tuple:
    """What changes when a run gains spans: its audit rows, its stored
    generations and its transcript."""
    try:
        a = await db.fetch_one(
            "SELECT COUNT(*) AS n, MAX(seq) AS m FROM tool_call_audit WHERE trace_id = ?", (trace_id,))
        g = await db.fetch_one(
            "SELECT COUNT(*) AS n FROM llm_cost_records WHERE trace_id = ?", (trace_id,))
    except Exception:  # noqa: BLE001 — no signature, no reuse
        return (time.monotonic(),)
    a = dict(a) if a else {}
    g = dict(g) if g else {}
    stamp = ""
    if head:
        stamp = await asyncio.to_thread(transcript_stamp, head.get("runtime_kind"), head.get("session_id"))
    return (a.get("n"), a.get("m"), g.get("n"), stamp)


async def _build_trace_cached(trace_id: str) -> dict:
    """``_build_trace`` reused while the run is unchanged. The result is
    shared: callers must not mutate it."""
    db = get_database()
    key = (id(db), trace_id)
    # Drop expired builds on every call, so a large run is not held in
    # memory after the page that asked for it is gone.
    cutoff = time.monotonic() - _TRACE_MEMO_TTL_S
    for k in [k for k, v in _trace_memo.items() if v[1] < cutoff]:
        _trace_memo.pop(k, None)
    hit = _trace_memo.get(key)
    if hit:
        head = hit[2]
    else:
        try:
            rk, sid = await _run_identity(db, trace_id)
        except Exception:  # noqa: BLE001
            rk, sid = None, None
        head = {"runtime_kind": rk, "session_id": sid}
    # Taken before the build, so rows that land during it force the next
    # call to rebuild rather than hide behind this one.
    sig = await _trace_sig(db, trace_id, head)
    now = time.monotonic()
    if hit and hit[0] == sig and now - hit[1] < _TRACE_MEMO_TTL_S:
        _trace_memo.move_to_end(key)
        return hit[3]
    full = await _build_trace(trace_id)
    _trace_memo[key] = (sig, now, head, full)
    _trace_memo.move_to_end(key)
    while len(_trace_memo) > _TRACE_MEMO_MAX:
        _trace_memo.popitem(last=False)
    return full


def _span_key(s: dict) -> str:
    """A span's stable key for cursors and the single-span route: the audit
    seq for a tool call, the span/request id (else the time) for a turn."""
    if s.get("span_kind") == "generation":
        return "g:" + str(s.get("span_id") or s.get("request_id") or s.get("called_at") or "")
    if s.get("audit_seq") is not None:
        return "t:" + str(s.get("audit_seq"))
    return "t:" + str(s.get("span_id") or s.get("row_hash") or s.get("called_at") or "")


def _cursor(s: dict) -> str:
    return f"{s.get('called_at') or ''}|{_span_key(s)}"


def _cursor_index(spans: list, cursor: Optional[str]) -> Optional[int]:
    """Index of the span a cursor names; else, by its time, the index just
    past the last span at or before it (so paging never repeats a span)."""
    if not cursor:
        return None
    ts, _, key = cursor.partition("|")
    for i, s in enumerate(spans):
        if _span_key(s) == key:
            return i
    t = _ts_key(ts or None)
    n = sum(1 for s in spans if _ts_key(s.get("called_at")) <= t)
    return n - 1


def _slim_value(v, cut: list):
    if isinstance(v, str):
        if len(v) > _TREE_TEXT_CAP:
            cut[0] = True
            return v[:_TREE_TEXT_CAP]
        return v
    if isinstance(v, list):
        if len(v) > _TREE_LIST_CAP:
            cut[0] = True
        return [_slim_value(x, cut) for x in v[:_TREE_LIST_CAP]]
    if isinstance(v, dict):
        return {k: _slim_value(x, cut) for k, x in v.items()}
    return v


def _span_failed(s: dict) -> bool:
    return bool(s.get("is_error") or str(s.get("reason") or "").startswith("tool error"))


def _same_tool(name: str, s: dict) -> bool:
    """A transcript tool name and a governed call name the same tool (the
    client's TraceSteps.sameTool: exact, or mcp__server__tool vs server:tool)."""
    if not name:
        return False
    if s.get("function_name") == name or s.get("tool_id") == name:
        return True
    bare = name[5:] if name.startswith("mcp__") else name
    i = bare.find("__")
    if 0 < i < len(bare) - 2:
        if s.get("tool_id") == f"{bare[:i]}:{bare[i + 2:]}" or s.get("function_name") == f"mcp__{bare}":
            return True
    return False


def _failed_indices(spans: list) -> set:
    """Tool calls that failed: an audit row that says so, or (as the client's
    TraceSteps.markFailed pairs them) the turn's transcript result for the
    same tool, in order, was an error that was not a refusal."""
    out = {i for i, s in enumerate(spans) if s.get("span_kind") != "generation" and _span_failed(s)}
    gen = None
    used: dict = {}
    for i, s in enumerate(spans):
        if s.get("span_kind") == "generation":
            gen, used = s, {}
            continue
        results = (gen or {}).get("tool_results") or []
        if not results:
            continue
        names = list(dict.fromkeys(str((r or {}).get("name") or "") for r in results))
        name = next((n for n in names if _same_tool(n, s)), None)
        if name is None:
            continue
        k = used.get(name, 0)
        used[name] = k + 1
        mine = [r for r in results if str((r or {}).get("name") or "") == name]
        r = mine[k] if k < len(mine) else None
        if r and r.get("is_error") and not r.get("denied"):
            out.add(i)
    return out


def _waiting_indices(spans: list, pending: list) -> set:
    """Blocked calls a pending approval request is for: same tool, within a
    minute, nearest first, one request per call (the client's
    RunTrace.matchRequests window)."""
    out: set = set()
    blocks = [(i, s) for i, s in enumerate(spans)
              if s.get("span_kind") != "generation" and s.get("action") == "block"]
    for req in sorted(pending or [], key=lambda r: _ts_key(r.get("requested_at"))):
        at = _ts_key(req.get("requested_at"))
        best = None
        for i, s in blocks:
            if i in out:
                continue
            if s.get("tool_id") != req.get("tool_id") and s.get("function_name") != (req.get("function_name") or req.get("tool_id")):
                continue
            gap = abs((_ts_key(s.get("called_at")) - at).total_seconds())
            if gap <= 60 and (best is None or gap < best[0]):
                best = (gap, i)
        if best:
            out.add(best[1])
    return out


def _slim_span(s: dict, failed: bool = False) -> dict:
    """What a tree row needs: every small field as is, any long text cut to
    _TREE_TEXT_CAP, the full prompt left out. A blocked call keeps its full
    arguments (few, and approvals match on them). ``_cut`` tells the client
    the span detail route has more."""
    cut = [False]
    out = {}
    for k, v in s.items():
        if k in _TREE_DROP:
            if v:
                cut[0] = True
            continue
        if k == "args_preview" and s.get("action") == "block":
            out[k] = v
            continue
        out[k] = _slim_value(v, cut)
    out["sk"] = _span_key(s)
    out["error"] = bool(failed or _span_failed(s))
    out["_slim"] = True
    out["_cut"] = cut[0]
    return out


def _tree_totals(spans: list, failed: set) -> dict:
    """Counts over the whole run, plus the turns' tokens and cost (None when
    no turn has a known price), so a paged view's header and run row match
    the run and not the page."""
    t = {"spans": len(spans), "tool_call": 0, "generation": 0,
         "allow": 0, "block": 0, "log_only": 0, "failed": len(failed),
         "tokens": 0, "cost": None}
    for s in spans:
        if s.get("span_kind") == "generation":
            t["generation"] += 1
            t["tokens"] += int(s.get("input_tokens") or 0) + int(s.get("output_tokens") or 0)
            if s.get("cost") is not None:
                t["cost"] = round((t["cost"] or 0.0) + float(s.get("cost") or 0.0), 6)
            continue
        t["tool_call"] += 1
        a = s.get("action") or "allow"
        t[a if a in ("allow", "block", "log_only") else "allow"] += 1
    return t


# decision= filter of the tree view: the run badges' kinds.
TREE_DECISIONS = ("block", "error", "waiting", "log_only")


def _tree_page(full: dict, *, limit: int, before: Optional[str] = None, after: Optional[str] = None,
               decision: Optional[str] = None, pending: Optional[list] = None) -> dict:
    """One page of the run, oldest first within the page (``order: asc``).

    No cursor: the newest ``limit`` spans. ``before``: the ``limit`` spans
    older than it (``has_more`` while older ones remain). ``after``: the
    cursor span and every span newer than it, or ``gap: true`` and no spans
    when more than ``limit`` arrived (the client then reloads the first
    page). A page that starts inside a model turn reaches back to that turn
    (up to ``limit`` more spans) so its calls keep their turn.

    ``decision`` (block, error, waiting, log_only) narrows the run, over every span
    and not only a page, to the calls of that kind plus the turns they were
    made in; paging then walks that list. ``pending``: the session's pending
    approval requests, for ``waiting``."""
    all_spans = full.get("spans") or []
    failed = _failed_indices(all_spans)
    gen_no: dict = {}
    for i, s in enumerate(all_spans):
        if s.get("span_kind") == "generation":
            gen_no[i] = len(gen_no) + 1
    idx = list(range(len(all_spans)))
    matches = None
    if decision:
        if decision in ("block", "log_only"):
            hit = {i for i, s in enumerate(all_spans)
                   if s.get("span_kind") != "generation" and s.get("action") == decision}
        elif decision == "error":
            hit = set(failed)
        else:
            hit = _waiting_indices(all_spans, pending or [])
        matches = len(hit)
        keep = set(hit)
        last_gen = None
        for i, s in enumerate(all_spans):
            if s.get("span_kind") == "generation":
                last_gen = i
            elif i in hit and last_gen is not None:
                keep.add(last_gen)
        idx = sorted(keep)
    spans = [all_spans[i] for i in idx]
    n = len(spans)
    gap = False
    if after:
        # The cursor span itself comes again: the newest turn may still be
        # growing (tokens, the calls it made), and the client replaces it.
        i = _cursor_index(spans, after)
        start = max(0, i) if i is not None else 0
        end = n
        if end - start > limit:
            gap = True
            start = end
    else:
        end = n
        if before:
            i = _cursor_index(spans, before)
            end = max(0, i if i is not None else n)
        start = max(0, end - limit)
        floor = max(0, start - limit)
        while start > floor and spans[start].get("span_kind") != "generation":
            start -= 1
        if start > 0 and spans[start].get("span_kind") != "generation":
            start = max(0, end - limit)  # no turn within reach: plain page
    out = {k: v for k, v in full.items() if k != "spans"}
    out["view"] = "tree"
    slim = []
    for j in range(start, end):
        i = idx[j]
        sp = _slim_span(all_spans[i], i in failed)
        if i in gen_no:
            sp["gen_no"] = gen_no[i]  # turn numbers count from the run's first
        slim.append(sp)
    out["spans"] = slim
    out["totals"] = _tree_totals(all_spans, failed)
    out["page"] = {
        "limit": limit,
        "order": "asc",
        "returned": end - start,
        "first": not before and not after,
        "has_more": (start > 0) if not after else None,
        "older": start,
        "next_before": _cursor(spans[start]) if start < end and start > 0 and not after else None,
        "newest": _cursor(spans[end - 1]) if end > 0 else (after or None),
        "gap": gap,
        "decision": decision,
        "matches": matches,
    }
    return out


async def _build_trace(trace_id: str, generations: Optional[list] = None):
    """Return the ordered spans for one run — the waterfall body.

    Spans are tool-call audit rows ordered by turn_index, each stamped with the
    enforcement verdict (ALLOW / BLOCKED / LOG) and its colour.
    """
    db = get_database()
    repo = CustomToolsRepository(db)
    rows = await repo.get_trace_spans(trace_id)
    try:
        stored_gen_rows = await CostsRepository(db).get_trace_generations(trace_id)
    except Exception:  # noqa: BLE001
        stored_gen_rows = []
    if not rows and not stored_gen_rows:
        raise HTTPException(status_code=404, detail="trace not found")

    # Correlate each span back to the threat record it came from (shared
    # request_id) so the waterfall can show what caught it — Rule / ML /
    # Rule+ML and the ML score. tool_call_audit doesn't carry that itself.
    detections = await repo.get_detection_sources([r.get("request_id") for r in rows])

    head = rows[0] if rows else stored_gen_rows[0]
    runtime_kind = head.get("runtime_kind") or "unknown"
    session_id = head.get("session_id")

    tool_spans = []
    blocked = 0
    for r in rows:
        action = r.get("action") or "allow"
        outcome, verdict, color = _VERDICT.get(action, _VERDICT["allow"])
        if action == "block":
            blocked += 1
        det = detections.get(r.get("request_id"))
        tool_spans.append({
            "span_kind": "tool_call",
            "tool_id": r.get("tool_id"),
            "function_name": r.get("function_name"),
            "action": action,
            "outcome": outcome,
            "verdict": verdict,
            "color": color,
            "risk": r.get("risk"),
            "reason": r.get("reason"),
            "called_at": r.get("called_at"),
            "args_preview": r.get("args_preview"),
            # Detection source (None when the span isn't tied to a threat).
            "detection_source": det.get("source") if det else None,
            "ml_score": det.get("ml_score") if det else None,
            "detection_rules": det.get("rules") if det else None,
            # Mechanism 1 FP-triage tier (corroborated / ml_uncertain /
            # ml_disagrees) so SOC can deprioritise likely-FPs in Traces, not
            # only on the Threats page.
            "ml_agreement": det.get("ml_agreement") if det else None,
            "span_id": r.get("span_id"),
            "parent_span_id": r.get("parent_span_id"),
            # The audit chain seq: the tree view's stable key for this call.
            "audit_seq": r.get("seq"),
            # The audit row hash: the id this call carries when it is sent to
            # the cloud (siem_ocsf sends it as span_id), shown so a cloud span
            # can be found here.
            "row_hash": r.get("row_hash"),
            # Correlation id so a detection row can deep-link to the underlying
            # threat / secret record ("see what was detected").
            "request_id": r.get("request_id") if det else None,
        })

    # Generation spans — the LLM turns, reconstructed from the session
    # transcript (§2). Additive: a trace with no readable transcript (an SDK
    # framework, an old/pruned session) still returns its tool spans. Claude
    # Code and Codex both persist a parseable transcript with token usage.
    # ``generations`` given: the caller already parsed this session's
    # transcript (the health route parses once and reuses it here).
    parsed_given = generations is not None
    generations = list(generations) if parsed_given else []
    if not parsed_given and runtime_kind in ("claude-code", "codex") and session_id:
        try:
            settings = await SettingsRepository(db).get()
            store_text = bool(getattr(settings, "store_text_content", True))
        except Exception:  # noqa: BLE001 — a settings read must not 500 the trace
            store_text = False
        generations = await parse_generations(runtime_kind, session_id, store_text=store_text)
    if generations:
        if not any(g.get("cost") is not None for g in generations):
            try:
                pricing = await CostsRepository(db).list_pricing()
                price_map = {
                    p.model_id: (p.input_per_million, p.output_per_million)
                    for p in pricing
                }
                apply_cost(generations, price_map)
            except Exception:  # noqa: BLE001 — cost is best-effort; leave None
                pass

    # 5.3.0: stored generation spans (OTLP ingest, Python SDK, LLM proxy)
    # for every runtime. When a transcript-derived generation carries the
    # same request_id as a stored one, the stored row wins so nothing is
    # counted twice.
    stored = [_stored_generation(g) for g in stored_gen_rows]
    if stored:
        stored_rids = {g["request_id"] for g in stored if g.get("request_id")}
        generations = stored + [g for g in generations if g.get("request_id") not in stored_rids]

    # Performance guard: a very long session (e.g. a 47k-line transcript) can
    # yield thousands of LLM turns. Rendering them all un-virtualised is slow,
    # so cap at the most-recent GENERATION_CAP and surface the truncation
    # honestly (never a silent cap — the UI shows "latest N of M"). Tool spans
    # are the security record and are NEVER capped.
    generation_total = len(generations)
    # Trace-level aggregates computed over the FULL set (before the display cap)
    # so the header total is honest even when the waterfall is truncated:
    #   - total cost across every LLM run
    #   - wall-clock bounds across tool calls + LLM runs (a real trace duration;
    #     tool spans are never capped, so the range is complete).
    generation_total_cost = sum((g.get("cost") or 0) for g in generations)
    # Today's slice of that cost (LOCAL calendar day, same boundary the
    # dashboard's "Spend today" uses) so a multi-day session can show both
    # its lifetime figure and the part that matches the dashboard number.
    _local_today = datetime.now().astimezone().date()
    generation_today_cost = sum(
        (g.get("cost") or 0)
        for g in generations
        if _ts_key(g.get("called_at")).astimezone().date() == _local_today
    )
    _all_ts = [s.get("called_at") for s in tool_spans] \
        + [g.get("called_at") for g in generations]
    _all_ts = [t for t in _all_ts if t]
    started_at = min(_all_ts, key=_ts_key) if _all_ts else None
    ended_at = max(_all_ts, key=_ts_key) if _all_ts else None

    generation_truncated = generation_total > _GENERATION_CAP
    if generation_truncated:
        # Keep the most recent CAP by timestamp (transcript order is
        # chronological, so that's the tail).
        generations = generations[-_GENERATION_CAP:]

    # Merge tool + generation spans into one chronological waterfall (the
    # Session -> Trace -> Span view). Stable-sort by parsed timestamp; within
    # an equal timestamp, generations sort before the tool calls they spawned.
    kind_rank = {"generation": 0, "tool_call": 1}
    merged = sorted(
        tool_spans + generations,
        key=lambda s: (_ts_key(s.get("called_at")), kind_rank.get(s.get("span_kind"), 1)),
    )
    for i, s in enumerate(merged):
        s["turn_index"] = i

    egress_blocks = await _egress_blocks(db, trace_id, session_id)

    return {
        "trace_id": trace_id,
        "runtime_kind": runtime_kind,
        "session_id": session_id,
        "spans": merged,
        "span_count": len(merged),
        "tool_call_count": len(tool_spans),
        "generation_count": len(generations),
        "generation_total": generation_total,
        "generation_total_cost": generation_total_cost,
        "generation_today_cost": generation_today_cost,
        "generation_truncated": generation_truncated,
        "started_at": started_at,
        "ended_at": ended_at,
        "blocked": blocked,
        # Egress denies for this run. The hook records them only in
        # egress_audit, so the step view matches them to the calls they
        # stopped. Host and tool only, never a URL path or query.
        "egress_blocks": egress_blocks,
        # Counted apart from `blocked` (tool_call_audit only), so no surface
        # adds the same refusal twice; the list folds it into its `blocked`.
        "egress_blocked": len(egress_blocks),
        # 5.3.0 cost view: spend per model and the turn that cost the most.
        "cost_by_model": _cost_by_model(generations),
        "expensive_turn": _expensive_turn(merged),
    }



# A runtime's 30-day medians move slowly: reuse them for this long.
_BASELINE_TTL_S = 600
_baseline_memo: dict = {}


async def _runtime_baseline(db, runtime_kind: Optional[str]) -> dict:
    """This runtime's own medians over the last 30 days, memoised per
    (database, runtime) for _BASELINE_TTL_S."""
    if not runtime_kind:
        return {"runs": 0}
    key = (id(db), runtime_kind)
    hit = _baseline_memo.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < _BASELINE_TTL_S:
        return dict(hit[1])
    out = await _runtime_baseline_read(db, runtime_kind)
    _baseline_memo[key] = (now, out)
    if len(_baseline_memo) > 64:
        _baseline_memo.pop(next(iter(_baseline_memo)))
    return dict(out)


async def _runtime_baseline_read(db, runtime_kind: str) -> dict:
    """Governed calls per run from tool_call_audit, model turns and cost per
    run from llm_cost_records. Two grouped reads; best effort."""
    out: dict = {"runs": 0}
    try:
        out.update(await CustomToolsRepository(db).get_runtime_call_medians(runtime_kind, 30))
    except Exception:  # noqa: BLE001
        pass
    try:
        rows = await db.fetch_all(
            """
            SELECT COUNT(*) AS turns, SUM(total_cost_usd) AS cost
            FROM llm_cost_records
            WHERE runtime_kind = ? AND trace_id IS NOT NULL
              AND recorded_at >= datetime('now', '-30 days')
            GROUP BY trace_id
            """,
            (runtime_kind,),
        )
        if rows and len(rows) >= run_health.RUNAWAY_MIN_BASELINE_RUNS:
            out["median_turns"] = run_health.median([r["turns"] for r in rows])
            out["median_cost"] = run_health.median([float(r["cost"] or 0) for r in rows])
            out["runs"] = max(int(out.get("runs") or 0), len(rows))
    except Exception:  # noqa: BLE001
        pass
    return out


# --- transcript parsing, off the event loop and parsed once -----------------

# Parsing is incremental and shared across callers: services/transcript_cache
# keeps each transcript's parser state and reads only what was appended, so
# a live session's growing transcript is not parsed from the start on every
# request. Callers get their own copies.


def _transcript_path(runtime_kind: Optional[str], session_id: Optional[str]):
    if not session_id or runtime_kind not in ("claude-code", "codex"):
        return None
    try:
        return _find_codex_rollout(session_id) if runtime_kind == "codex" else _find_transcript(session_id)
    except Exception:  # noqa: BLE001
        return None


def transcript_stamp(runtime_kind: Optional[str], session_id: Optional[str]) -> str:
    """The transcript's mtime (ns) as text, '' when there is none."""
    path = _transcript_path(runtime_kind, session_id)
    try:
        return str(path.stat().st_mtime_ns) if path is not None else ""
    except OSError:
        return ""


def _parse_with_stamp(runtime_kind, session_id, store_text: bool, with_analysis: bool) -> tuple:
    """Blocking: one session's generations (incremental, shared parse) and
    the transcript's mtime stamp. Callers get their own copies."""
    path = _transcript_path(runtime_kind, session_id)
    stamp = ""
    kw = {"store_text": store_text, "with_analysis": with_analysis}
    if path is not None:
        try:
            stamp = str(path.stat().st_mtime_ns)
            kw["path"] = path
        except OSError:
            pass
    gens = (
        build_generations_codex(session_id, **kw)
        if runtime_kind == "codex"
        else build_generations(session_id, **kw)
    ) or []
    return gens, stamp


async def parse_generations(runtime_kind, session_id, *, store_text: bool, with_analysis: bool = False) -> list:
    gens, _ = await asyncio.to_thread(_parse_with_stamp, runtime_kind, session_id, store_text, with_analysis)
    return gens


async def _run_identity(db, trace_id: str) -> tuple:
    """(runtime_kind, session_id) for a run, from its audit rows or its
    stored generations."""
    for sql in (
        "SELECT runtime_kind, session_id FROM tool_call_audit WHERE trace_id = ? LIMIT 1",
        "SELECT runtime_kind, session_id FROM llm_cost_records WHERE trace_id = ? LIMIT 1",
    ):
        try:
            row = await db.fetch_one(sql, (trace_id,))
        except Exception:  # noqa: BLE001
            row = None
        if row:
            return row["runtime_kind"], row["session_id"]
    return None, None


async def compute_health(trace_id: str) -> dict:
    """Full findings for one run, cached under (last tool span time,
    transcript mtime, generation count). The transcript is parsed once, off
    the event loop, and that one parse feeds both the trace detail and the
    analysis."""
    db = get_database()
    runtime_kind, session_id = await _run_identity(db, trace_id)
    gens: list = []
    stamp = ""
    if runtime_kind in ("claude-code", "codex") and session_id:
        try:
            gens, stamp = await asyncio.to_thread(_parse_with_stamp, runtime_kind, session_id, False, True)
        except Exception:  # noqa: BLE001 - transcript trouble leaves the audit findings
            gens, stamp = [], ""
    detail = await _build_trace(trace_id, generations=gens)
    baseline = await _runtime_baseline(db, detail.get("runtime_kind"))
    result = run_health.analyze_run(detail, gens, baseline)
    tool_times = [s.get("called_at") for s in detail.get("spans") or []
                  if s.get("span_kind") == "tool_call" and s.get("called_at")]
    key_time = max(tool_times, key=_ts_key) if tool_times else detail.get("ended_at")
    run_health.remember(trace_id, (_health_key(key_time), stamp, len(gens)), result)
    return result


@router.get("/traces/{trace_id}/health")
async def get_trace_health(trace_id: str):
    """Health findings for one run: loops, failures, waste and blocks, each
    with why it matters, what to do and the steps it refers to."""
    result = await compute_health(trace_id)
    return {"trace_id": trace_id, **result}


# --- proactive warm-up ----------------------------------------------------------

async def warm_health_once(now: Optional[datetime] = None) -> list:
    """One warm-up pass: full health for runs active in the last 2 hours
    whose cache key moved (newest first, capped). Returns the trace ids it
    recomputed. Cheap when idle: an unchanged run costs one stat."""
    runs = await _collect_runs(1, 200)
    now = now or datetime.now(timezone.utc)
    recent = run_health.recent_runs(runs, now, _ts_key)
    stamps = await asyncio.to_thread(
        lambda: {r.get("trace_id"): transcript_stamp(r.get("runtime_kind"), r.get("session_id")) for r in recent})
    todo = run_health.select_warm_runs(recent, stamps, _health_key)
    done = []
    for tid in todo:
        try:
            await compute_health(tid)
            done.append(tid)
        except Exception:  # noqa: BLE001 - one bad run never stops the pass
            logger.debug("run health warm-up failed for %s", tid, exc_info=True)
    return done


async def run_health_warmer(interval: float = run_health.WARM_INTERVAL_SECONDS,
                            first_delay: float = run_health.WARM_FIRST_DELAY_SECONDS) -> None:
    """Background loop started by the app lifespan and cancelled on shutdown.
    The first pass runs soon after startup, so a restart does not leave the
    Health view on partial results for a minute."""
    delay = first_delay
    while True:
        await asyncio.sleep(delay)
        delay = interval
        try:
            await warm_health_once()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.debug("run health warm-up pass failed", exc_info=True)
        # Same cadence, after the warm-up so its transcript parses are cached:
        # queue model generation rows for an enrolled fleet destination
        # (no-op when not enrolled or forwarding is off).
        try:
            from securevector.app.services import fleet_generations
            await fleet_generations.forward_generations_once()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.debug("fleet generation pass failed", exc_info=True)
        # Same cadence: rescore running governed sessions' Session Drift Score.
        # Observe only; the stored row is read by the board and the summary.
        try:
            from securevector.app.services import session_drift
            await session_drift.warm_once()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.debug("session drift pass failed", exc_info=True)
        # Step-up holds nobody decided within the hold limit resolve as
        # denied. Readers of the queue and the approve route also run this,
        # so the limit holds between passes too.
        try:
            from securevector.app.services import response_rungs
            await response_rungs.expire_holds(get_database())
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.debug("step-up hold expiry failed", exc_info=True)
        # Agent Config Trust: stat-gated setup recheck for running sessions
        # and user scope, relay-observed MCP tools, due opt-in probes.
        try:
            from securevector.app.services import config_trust
            await config_trust.recheck_once(get_database())
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.debug("config trust recheck failed", exc_info=True)


@router.get("/run-health")
async def list_run_health(
    window_days: int = Query(7, ge=1, le=90),
    limit: int = Query(200, ge=1, le=500),
    warm: bool = Query(False),
):
    """Findings across runs in the window, for the Health view and the
    dashboard. Same single pass as the runs list: audit-derived findings for
    every run, full findings where a run's health was already computed.
    ``warm=true`` first runs one warm-up pass on demand (runs active in the
    last 2 hours, at most 20, unchanged ones skipped)."""
    if warm is True:  # a direct call sees the Query default object, not a bool
        try:
            await warm_health_once()
        except Exception:  # noqa: BLE001 - a failed warm still answers
            logger.debug("on-demand run health warm-up failed", exc_info=True)
    runs, by_trace = await _runs_with_health(window_days, limit)
    findings = []
    partial = 0
    for r in runs:
        if r.get("health_partial"):
            partial += 1
        for f in by_trace.get(r.get("trace_id")) or []:
            findings.append({
                **f,
                "trace_id": r.get("trace_id"),
                "session_id": r.get("session_id"),
                "runtime_kind": r.get("runtime_kind"),
                "ended_at": r.get("ended_at"),
            })
    counts = run_health.counts_of(findings)
    return {"window_days": window_days, "findings": findings, "counts": counts,
            "runs": len(runs), "partial_runs": partial}

# How far outside a run's window a deny may still belong to it. The hook calls
# /api/egress/evaluate after the harness hands it the call, and that row is
# written before the answer, so it lands within about a second of the call.
# The run's own bounds come from second-precision audit rows; 5 s covers both
# roundings plus a slow local app without reaching into a neighbouring run.
_EGRESS_PAD_S = 5


async def _session_run_windows(db, session_ids) -> list[dict]:
    """Every run of these sessions with its time bounds: tool-call rows and
    stored generations merged per trace_id. The list and the detail both
    read windows from here, so they assign each deny the same way."""
    merged: dict = {}
    sources = []
    try:
        sources.append(await CustomToolsRepository(db).get_run_windows_for_sessions(session_ids))
    except Exception:  # noqa: BLE001
        pass
    try:
        sources.append(await CostsRepository(db).get_run_windows_for_sessions(session_ids))
    except Exception:  # noqa: BLE001
        pass
    for rows in sources:
        for r in rows:
            tid = r.get("trace_id")
            if not tid:
                continue
            w = merged.setdefault(tid, {"trace_id": tid, "session_id": r.get("session_id"),
                                        "runtime_kind": r.get("runtime_kind"),
                                        "start": None, "end": None})
            for k, pick in (("start", min), ("end", max)):
                v = r.get("started_at" if k == "start" else "ended_at")
                if v:
                    t = _ts_key(v)
                    w[k] = t if w[k] is None else pick(w[k], t)
    return [w for w in merged.values() if w["start"] is not None and w["end"] is not None]


def _assign_egress(calls: list, windows: list) -> dict:
    """Give each refused call to exactly one run: the run whose unpadded
    window holds it; else the nearest run within _EGRESS_PAD_S; else, when
    the session has a single run (one run is one session, utils/trace_id.py),
    that run, since the deny can belong to no other; else none. Only runs of
    the call's session (and runtime, when both are known) are candidates.
    Returns {(session_id, call_key): trace_id}."""
    out: dict = {}
    for c in calls:
        sid = c.get("session_id")
        rk = c.get("runtime_kind")
        cands = [w for w in windows if w["session_id"] == sid
                 and not (rk and w.get("runtime_kind") and w["runtime_kind"] != rk)]
        if not cands:
            continue
        t = _ts_key(c.get("called_at"))
        inside = [w for w in cands if w["start"] <= t <= w["end"]]
        if inside:
            pick = max(inside, key=lambda w: w["start"])  # the later run when windows overlap
        else:
            def gap(w):
                return (w["start"] - t).total_seconds() if t < w["start"] else (t - w["end"]).total_seconds()
            near = [w for w in cands if gap(w) <= _EGRESS_PAD_S]
            if near:
                pick = min(near, key=lambda w: (gap(w), -w["start"].timestamp()))
            elif len(cands) == 1:
                pick = cands[0]
            else:
                continue
        out[(sid, c.get("call_key"))] = pick["trace_id"]
    return out


async def _egress_calls_by_trace(db, session_ids, window_days: Optional[int] = None) -> dict:
    """{trace_id: [refused call, ...]} for these sessions, each call in one run.
    `window_days` limits the refusals to the runs list's window."""
    sids = [s for s in dict.fromkeys(session_ids or []) if s]
    if not sids:
        return {}
    try:
        from securevector.app.database.repositories.egress import EgressRepository
        calls = await EgressRepository(db).blocked_calls(sids, window_days=window_days)
    except Exception:  # noqa: BLE001 — egress is additive; never 500 a trace read
        return {}
    if not calls:
        return {}
    windows = await _session_run_windows(db, sids)
    owner = _assign_egress(calls, windows)
    by_trace: dict = {}
    for c in sorted(calls, key=lambda c: _ts_key(c.get("called_at"))):
        tid = owner.get((c.get("session_id"), c.get("call_key")))
        if tid:
            by_trace.setdefault(tid, []).append(c)
    return by_trace


async def _add_egress_blocked(db, runs: list, window_days: Optional[int] = None) -> None:
    """Fold each run's egress denies into its blocked count and risk.

    A hook's egress deny is recorded only in egress_audit (never as a
    tool_call_audit block), so `blocked` from the audit rows alone reads 0 for
    a run whose only refusal was a destination. One query covers every listed
    run; each refused call counts once, in the run `_assign_egress` gives it.
    `egress_blocked` keeps that part visible on its own. Only refusals inside
    `window_days` (the list's own window) count, never all-time ones."""
    by_trace = await _egress_calls_by_trace(db, [r.get("session_id") for r in runs], window_days)
    for r in runs:
        n = len(by_trace.get(r.get("trace_id"), []))
        r["egress_blocked"] = n
        if n:
            r["blocked"] = int(r.get("blocked") or 0) + n
            r["risk"] = "red"


async def _egress_blocks(db, trace_id, session_id) -> list[dict]:
    """This run's refused calls (host, tool and rule only), assigned exactly
    as the runs list assigns them."""
    if not session_id:
        return []
    calls = (await _egress_calls_by_trace(db, [session_id])).get(trace_id, [])
    return [{"called_at": c.get("called_at"), "tool_name": c.get("tool_name"),
             "hosts": c.get("hosts") or [], "rule_ids": c.get("rule_ids") or []} for c in calls]


def _stored_generation(g: dict) -> dict:
    """Shape a llm_cost_records row like a transcript-derived generation."""
    tokens_in = int(g.get("input_tokens") or 0)
    cached = int(g.get("input_cached_tokens") or 0)
    known = bool(g.get("pricing_known"))
    action = g.get("verdict_action")
    verdict = None
    if action:
        outcome, label, color = _VERDICT.get(action, _VERDICT["allow"])
        verdict = {"action": action, "label": label, "color": color,
                   "risk": g.get("verdict_risk"), "reason": g.get("verdict_reason")}
    return {
        "span_kind": "generation",
        "model": g.get("model_id") or "unknown",
        "provider": g.get("provider"),
        "input_tokens": tokens_in,
        "output_tokens": int(g.get("output_tokens") or 0),
        "cache_read_tokens": cached,
        "cache_creation_tokens": 0,
        "stop_reason": g.get("finish_reason"),
        "finish_reason": g.get("finish_reason"),
        "called_at": g.get("started_at"),
        "duration_ms": g.get("duration_ms"),
        "request_id": g.get("request_id"),
        "span_id": g.get("span_id"),
        "parent_span_id": g.get("parent_span_id"),
        "cost": round(float(g.get("total_cost_usd") or 0.0), 6) if known else None,
        "pricing_known": known,
        "input_preview": g.get("input_preview"),
        "output_preview": g.get("output_preview"),
        "input_truncated": False,
        "output_truncated": False,
        "verdict": verdict,
        "source": "stored",
    }


def _cost_by_model(generations: list[dict]) -> list[dict]:
    acc: dict = {}
    for g in generations:
        m = g.get("model") or "unknown"
        row = acc.setdefault(m, {"model": m, "cost": 0.0, "tokens": 0, "generations": 0})
        row["cost"] += float(g.get("cost") or 0.0)
        row["tokens"] += int(g.get("input_tokens") or 0) + int(g.get("output_tokens") or 0)
        row["generations"] += 1
    out = sorted(acc.values(), key=lambda r: r["cost"], reverse=True)
    for r in out:
        r["cost"] = round(r["cost"], 6)
    return out


def _expensive_turn(merged: list[dict]) -> Optional[dict]:
    best = None
    for sp in merged:
        if sp.get("span_kind") != "generation":
            continue
        c = float(sp.get("cost") or 0.0)
        if c > 0 and (best is None or c > best["cost"]):
            best = {"turn_index": sp.get("turn_index"), "cost": round(c, 6), "model": sp.get("model")}
    return best
