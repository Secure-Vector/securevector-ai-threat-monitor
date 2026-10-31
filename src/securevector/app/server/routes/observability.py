"""Observability read routes.

Served twice, by the same handlers:

* ``/api/observability/...`` (``read_router``): the same access as the Runs
  and trace routes (``/api/traces``), that is the app-wide ingress token
  middleware and the localhost-only CORS origins in ``server/app.py``, and
  nothing more. The Live grid and the session governance strip use these,
  so they load when the app is opened by its network address.
* ``/api/terminals/observability/...`` (``router``): the original paths,
  behind the Agent Terminals UI token, kept unchanged for one release.

Read only, apart from the lazy expiry of lapsed approval requests that the
JIT list route and ``/api/traces`` also perform. They return no more than
``/api/traces`` and ``/api/jit/requests`` already return to the same caller:
the secret-redacted ``call_preview``, ``args_preview``, and a terminal
task's folder name (never its path). Every state change (approve, deny,
revoke, stop, launch, link) stays on its own guarded route.
"""

from __future__ import annotations

import re
from typing import Optional

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


@router.get("/egress-alerts", dependencies=[Depends(require_read)])
async def egress_alerts(request: Request, since: Optional[str] = Query(None, max_length=40)):
    """Suspicious egress, one alert per (session, host): new host, paste or
    file-sharing host, raw public IP, network right after a credential read,
    or blocked by policy. The last 30 minutes by default (shared with the
    Live grid); `since` (ISO time) reads further back, at most 24 hours, so
    a tab that was hidden catches up."""
    from datetime import datetime, timezone

    from securevector.app.services import egress_alerts as ea

    if since:
        start = observability.parse_ts(since)
        if start is None:
            raise HTTPException(status_code=400, detail="Invalid since")
        now = datetime.now(timezone.utc)
        window = int(min(ea.MAX_SINCE_S, max(ea.WINDOW_S, (now - start).total_seconds() + 60)))
        alerts = await ea.suspicious_egress(_db(request), now=now, window_s=window)
        return {"alerts": alerts, "window_s": window}
    return {"alerts": await ea.shared_alerts(_db(request)), "window_s": ea.WINDOW_S}


# The same four reads with the access the Runs and trace routes have (see
# the module docstring). No terminals dependency: the handlers are read only.
read_router = APIRouter(prefix="/observability", tags=["Observability"])
read_router.add_api_route("/coverage", coverage, methods=["GET"])
read_router.add_api_route("/sessions/{session_id}/governance", session_governance, methods=["GET"])
read_router.add_api_route("/live", live, methods=["GET"])
read_router.add_api_route("/egress-alerts", egress_alerts, methods=["GET"])
