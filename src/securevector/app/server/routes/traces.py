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

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.costs import CostsRepository
from securevector.app.database.repositories.custom_tools import CustomToolsRepository
from securevector.app.database.repositories.settings import SettingsRepository
from securevector.app.server.routes.transcript_generations import (
    apply_cost,
    build_generations,
    build_generations_codex,
)

router = APIRouter()

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


def _run_risk(blocked: int, recent_risk: Optional[str]) -> str:
    if blocked > 0:
        return "red"
    if (recent_risk or "").lower() in _HIGH_RISK:
        return "amber"
    return "green"


@router.get("/traces")
async def list_traces(
    window_days: int = Query(7, ge=1, le=90),
    limit: int = Query(50, ge=1, le=500),
):
    """List agent runs (traces) in the window, newest first.

    Each run summarises one agent session: span + block counts, time bounds,
    the distinct tools touched, and a roll-up risk ring.
    """
    db = get_database()
    repo = CustomToolsRepository(db)
    rows = await repo.get_trace_runs(window_days=window_days, limit=limit)
    # Per-trace threat/secret roll-up so each card can flag "this session had
    # threats" — the list becomes a triage surface, not just a picker.
    detections = await repo.get_trace_detection_counts(window_days=window_days)

    runs = []
    for r in rows:
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
            "risk": _run_risk(blocked, r.get("recent_risk")),
            "tools": [t for t in tools.split(",") if t][:8],
        })
    return {"window_days": window_days, "runs": runs}


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
    """Return the ordered spans for one run — the waterfall body.

    Spans are tool-call audit rows ordered by turn_index, each stamped with the
    enforcement verdict (ALLOW / BLOCKED / LOG) and its colour.
    """
    db = get_database()
    repo = CustomToolsRepository(db)
    rows = await repo.get_trace_spans(trace_id)
    if not rows:
        raise HTTPException(status_code=404, detail="trace not found")

    # Correlate each span back to the threat record it came from (shared
    # request_id) so the waterfall can show what caught it — Rule / ML /
    # Rule+ML and the ML score. tool_call_audit doesn't carry that itself.
    detections = await repo.get_detection_sources([r.get("request_id") for r in rows])

    runtime_kind = rows[0].get("runtime_kind") or "unknown"
    session_id = rows[0].get("session_id")

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
            # Correlation id so a detection row can deep-link to the underlying
            # threat / secret record ("see what was detected").
            "request_id": r.get("request_id") if det else None,
        })

    # Generation spans — the LLM turns, reconstructed from the session
    # transcript (§2). Additive: a trace with no readable transcript (an SDK
    # framework, an old/pruned session) still returns its tool spans. Claude
    # Code and Codex both persist a parseable transcript with token usage.
    generations: list[dict] = []
    if runtime_kind in ("claude-code", "codex") and session_id:
        try:
            settings = await SettingsRepository(db).get()
            store_text = bool(getattr(settings, "store_text_content", True))
        except Exception:  # noqa: BLE001 — a settings read must not 500 the trace
            store_text = False
        generations = (
            build_generations_codex(session_id, store_text=store_text)
            if runtime_kind == "codex"
            else build_generations(session_id, store_text=store_text)
        )
        if generations:
            try:
                pricing = await CostsRepository(db).list_pricing()
                price_map = {
                    p.model_id: (p.input_per_million, p.output_per_million)
                    for p in pricing
                }
                apply_cost(generations, price_map)
            except Exception:  # noqa: BLE001 — cost is best-effort; leave None
                pass

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
        "generation_truncated": generation_truncated,
        "started_at": started_at,
        "ended_at": ended_at,
        "blocked": blocked,
    }
