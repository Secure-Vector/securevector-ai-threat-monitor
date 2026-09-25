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
import threading
import time
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Optional

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

router = APIRouter()
logger = logging.getLogger(__name__)

_HIGH_RISK = {"delete", "admin", "write"}

# Max generation (LLM turn) spans returned per trace. A huge session can have
# thousands; rendering them all un-virtualised is slow, so we cap and disclose.
_GENERATION_CAP = 1500

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
        return {"window_days": window_days, "runs": await _collect_runs(window_days, limit)}
    runs, _ = await _runs_with_health(window_days, limit, health)
    return {"window_days": window_days, "runs": runs}


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
    await _add_egress_blocked(db, runs)
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
async def get_trace(trace_id: str):
    """Return the ordered spans for one run (see _build_trace)."""
    return await _build_trace(trace_id)


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

_PARSE_CACHE_MAX = 40  # a full warm-up pass (20 runs) fits with room for opens
_parse_cache: "OrderedDict[tuple, list]" = OrderedDict()
_parse_lock = threading.Lock()


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
    """Blocking: parse (or reuse) one session's generations. Cached by
    (path, mtime, size, flags), bounded; callers get their own copies."""
    path = _transcript_path(runtime_kind, session_id)
    key = None
    stamp = ""
    if path is not None:
        try:
            st = path.stat()
            stamp = str(st.st_mtime_ns)
            key = (str(path), st.st_mtime_ns, st.st_size, store_text, with_analysis)
        except OSError:
            key = None
    gens = None
    if key is not None:
        with _parse_lock:
            gens = _parse_cache.get(key)
            if gens is not None:
                _parse_cache.move_to_end(key)
    if gens is None:
        gens = (
            build_generations_codex(session_id, store_text=store_text, with_analysis=with_analysis)
            if runtime_kind == "codex"
            else build_generations(session_id, store_text=store_text, with_analysis=with_analysis)
        ) or []
        if key is not None:
            with _parse_lock:
                _parse_cache[key] = gens
                while len(_parse_cache) > _PARSE_CACHE_MAX:
                    _parse_cache.popitem(last=False)
    return [dict(g) for g in gens], stamp


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


async def _egress_calls_by_trace(db, session_ids) -> dict:
    """{trace_id: [refused call, ...]} for these sessions, each call in one run."""
    sids = [s for s in dict.fromkeys(session_ids or []) if s]
    if not sids:
        return {}
    try:
        from securevector.app.database.repositories.egress import EgressRepository
        calls = await EgressRepository(db).blocked_calls(sids)
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


async def _add_egress_blocked(db, runs: list) -> None:
    """Fold each run's egress denies into its blocked count and risk.

    A hook's egress deny is recorded only in egress_audit (never as a
    tool_call_audit block), so `blocked` from the audit rows alone reads 0 for
    a run whose only refusal was a destination. One query covers every listed
    run; each refused call counts once, in the run `_assign_egress` gives it.
    `egress_blocked` keeps that part visible on its own."""
    by_trace = await _egress_calls_by_trace(db, [r.get("session_id") for r in runs])
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
