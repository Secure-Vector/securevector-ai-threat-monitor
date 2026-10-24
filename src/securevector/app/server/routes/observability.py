"""Observability read routes under /api/terminals/observability.

Behind the Agent Terminals UI token, like the detection-response summary:
the token cookie is scoped to /api/terminals, so a route outside that prefix
would never receive it from the browser. Read only, apart from the lazy
expiry of lapsed approval requests that the JIT list route also performs.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from securevector.app.services import harness_coverage, observability
from securevector.app.terminals.routes import require_read

router = APIRouter(prefix="/terminals/observability", tags=["Observability"])

_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


def _db(request: Request):
    manager = getattr(request.app.state, "terminal_manager", None)
    if manager is not None:
        return manager.store.db
    from securevector.app.database.connection import get_database
    return get_database()


@router.get("/coverage", dependencies=[Depends(require_read)])
async def coverage():
    """What each agent runtime's Guard checks, and what it does not."""
    return {"runtimes": harness_coverage.table()}


@router.get("/sessions/{session_id}/governance", dependencies=[Depends(require_read)])
async def session_governance(session_id: str, request: Request):
    """One session's governance strip: decisions, destinations, cost,
    findings, score, coverage and approvals."""
    if not _SESSION_ID_RE.match(session_id or ""):
        raise HTTPException(status_code=400, detail="Invalid session id")
    body = await observability.session_governance(_db(request), session_id)
    if body is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return body


@router.get("/live", dependencies=[Depends(require_read)])
async def live(
    request: Request,
    group: str = Query("none", pattern="^(host|project|harness|none)$"),
    limit: int = Query(200, ge=1, le=500),
):
    """Running sessions with attention counters, sorted for triage."""
    return await observability.live_sessions(_db(request), group=group, limit=limit)
