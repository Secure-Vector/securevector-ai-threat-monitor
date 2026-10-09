"""Agent Config Trust routes under /api/terminals/config-trust.

Behind the Agent Terminals UI token (cookie plus header; writes also need a
matching Origin). They sit under the terminals path because the token cookie
is scoped to /api/terminals, and that prefix is already in the
sv.self.control_api path set, so an agent cannot call them. Reads scan
files; the one network action is the opt-in HTTP tools/list probe.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from securevector.app.services import config_trust
from securevector.app.services.config_trust_scan import HARNESS_LABELS
from securevector.app.terminals.routes import require_read, require_write

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/terminals/config-trust", tags=["Agent Config Trust"])


def _db(request: Request):
    port = getattr(request.app.state, "port", None)
    if port:
        config_trust.APP_PORT = int(port)
    manager = getattr(request.app.state, "terminal_manager", None)
    if manager is not None:
        return manager.store.db
    from securevector.app.database.connection import get_database
    return get_database()


def _harness(value: Optional[str]) -> str:
    if value not in HARNESS_LABELS:
        raise HTTPException(status_code=400, detail="Unknown harness")
    return value


def _workspace(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    path = os.path.expanduser(value.strip())
    if not os.path.isabs(path) or not os.path.isdir(path):
        raise HTTPException(status_code=400, detail="Folder not found")
    return path


class RepoCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")
    workspace: str = Field(..., max_length=4096)
    harness: str = Field(..., max_length=32)


class PinRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    harness: str = Field(..., max_length=32)
    workspace: Optional[str] = Field(None, max_length=4096)
    target: str = Field("setup", max_length=16)
    key: Optional[str] = Field(None, max_length=512)
    # What the user was shown: the view hash for "setup", else the item's
    # current hash. A mismatch means the files moved since; nothing is pinned.
    expected: str = Field(..., min_length=1, max_length=128)


class ProbeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    harness: str = Field(..., max_length=32)
    server: str = Field(..., max_length=256)
    workspace: Optional[str] = Field(None, max_length=4096)
    enable: Optional[bool] = None


@router.get("/status", dependencies=[Depends(require_read)])
async def trust_status(request: Request, fresh: bool = False):
    """Your agent setup: every harness at user scope, counts, risky items first."""
    return await config_trust.status(_db(request), fresh=bool(fresh is True))


@router.get("/harness/{harness}", dependencies=[Depends(require_read)])
async def trust_harness(harness: str, request: Request):
    """One harness's Setup trust card: surfaces, MCP servers with per-tool state, mods."""
    return await config_trust.evaluate(_db(request), _harness(harness), None)


@router.get("/sessions/{task_id}", dependencies=[Depends(require_read)])
async def trust_session(task_id: str, request: Request):
    db = _db(request)
    manager = getattr(request.app.state, "terminal_manager", None)
    task = await manager.store.get_task(task_id) if manager is not None else None
    if task is None:
        raise HTTPException(status_code=404, detail="Unknown task")
    return await config_trust.session_summary(db, task_id, task.get("session_id"))


@router.post("/repo-check", dependencies=[Depends(require_write)])
async def trust_repo_check(body: RepoCheck, request: Request):
    """Folder verdict before the first prompt: trusted, new or changed, top reasons."""
    return await config_trust.repo_check(_db(request), _harness(body.harness), _workspace(body.workspace))


@router.get("/mcp", dependencies=[Depends(require_read)])
async def trust_mcp(request: Request):
    data = await config_trust.status(_db(request))
    return {"servers": [dict(s, harness=v["harness"]) for v in data["harnesses"] for s in v["servers"]]}


@router.get("/mods", dependencies=[Depends(require_read)])
async def trust_mods(request: Request):
    view = await config_trust.evaluate(_db(request), "claude-code", None)
    return {"mods": view["mods"], "posture": view["posture"]}


@router.post("/pins", dependencies=[Depends(require_write)])
async def trust_pin(body: PinRequest, request: Request):
    """Approve: re-pin the setup, one surface, one server or one mod."""
    try:
        return await config_trust.approve(_db(request), _harness(body.harness), _workspace(body.workspace),
                                          target=body.target, key=body.key, expected=body.expected)
    except config_trust.StaleView as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/probe", dependencies=[Depends(require_write)])
async def trust_probe(body: ProbeRequest, request: Request):
    """Turn the read-only tools/list probe on or off for one HTTP server, and
    run it once when on. Stdio servers are refused: they are never started."""
    from securevector.app.database.repositories.config_trust import ConfigTrustRepository
    from securevector.app.services.config_trust_scan import workspace_id

    db = _db(request)
    harness = _harness(body.harness)
    ws = _workspace(body.workspace)
    view = await config_trust.evaluate(db, harness, ws, audit=False)
    srv = next((s for s in view["servers"] if s["name"] == body.server), None)
    if srv is None:
        raise HTTPException(status_code=404, detail="Unknown server")
    if not srv["probe_allowed"]:
        raise HTTPException(status_code=400, detail="Only HTTP servers can be probed. Stdio servers are never started.")
    ws_hash, _ = workspace_id(ws)
    repo = ConfigTrustRepository(db)
    scan = await config_trust._scan(harness, ws)
    definition = next((s.definition_hash for s in scan.servers if s.name == body.server), None)
    if body.enable is not None:
        await repo.set_probe(harness, "user" if ws is None else "project", ws_hash, body.server, body.enable,
                             definition_hash=definition)
        if not body.enable:
            return {"ok": True, "probe_opt_in": False}
    try:
        result = await config_trust.probe(db, harness, body.server, ws)
    except PermissionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {**result, "probe_opt_in": True}
