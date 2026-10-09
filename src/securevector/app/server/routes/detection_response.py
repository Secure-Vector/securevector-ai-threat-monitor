"""Agent Detection & Response summary route under /api/terminals.

Behind the Agent Terminals UI token, like the config-trust routes: the token
cookie is scoped to /api/terminals, and that prefix is already in the
sv.self.control_api path set. Read only: stored rows and the cached setup
status, no scoring, no writes, no network.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Request

from securevector.app.services import detection_response
from securevector.app.terminals.routes import require_read

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/terminals/detection-response", tags=["Agent Detection & Response"])


def _db(request: Request):
    manager = getattr(request.app.state, "terminal_manager", None)
    if manager is not None:
        return manager.store.db
    from securevector.app.database.connection import get_database
    return get_database()


async def _setup(db):
    try:
        from securevector.app.services import config_trust
        return await config_trust.status(db)
    except Exception:  # noqa: BLE001 - Harden reads as unavailable
        logger.debug("detection response: setup status unavailable", exc_info=True)
        return None


def _registered():
    try:
        from securevector.app.services import mcp_registration
        states = mcp_registration.status()
        return any(v.get("state") == mcp_registration.REGISTERED for v in states.values())
    except Exception:  # noqa: BLE001 - unknown, not "not registered"
        logger.debug("detection response: MCP registration unavailable", exc_info=True)
        return None


@router.get("/summary", dependencies=[Depends(require_read)])
async def summary(request: Request):
    """Detect, Harden and Pre-flight counts, and the sessions to review."""
    db = _db(request)
    return await detection_response.summary(db, setup=await _setup(db), registered=_registered())
