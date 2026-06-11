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

from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.custom_tools import CustomToolsRepository

router = APIRouter()

_HIGH_RISK = {"delete", "admin", "write"}

# action → (outcome, verdict label, traffic-light colour)
_VERDICT = {
    "block": ("blocked", "BLOCKED", "red"),
    "log_only": ("log_only", "LOG", "grey"),
    "allow": ("allow", "ALLOW", "green"),
}


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

    runs = []
    for r in rows:
        blocked = int(r.get("blocked") or 0)
        tools = (r.get("tools") or "")
        runs.append({
            "trace_id": r.get("trace_id"),
            "runtime_kind": r.get("runtime_kind") or "unknown",
            "session_id": r.get("session_id"),
            "spans": int(r.get("spans") or 0),
            "blocked": blocked,
            "log_only": int(r.get("logged") or 0),
            "started_at": r.get("started_at"),
            "ended_at": r.get("ended_at"),
            "risk": _run_risk(blocked, r.get("recent_risk")),
            "tools": [t for t in tools.split(",") if t][:8],
        })
    return {"window_days": window_days, "runs": runs}


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

    spans = []
    blocked = 0
    # Renumber turn_index sequentially at read time (rows arrive in reliable
    # `seq` order). The stored turn_index is best-effort and can collide under
    # concurrent writes; the display index never does.
    for i, r in enumerate(rows):
        action = r.get("action") or "allow"
        outcome, verdict, color = _VERDICT.get(action, _VERDICT["allow"])
        if action == "block":
            blocked += 1
        det = detections.get(r.get("request_id"))
        spans.append({
            "turn_index": i,
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
        })

    return {
        "trace_id": trace_id,
        "runtime_kind": rows[0].get("runtime_kind") or "unknown",
        "spans": spans,
        "span_count": len(spans),
        "blocked": blocked,
    }
