"""Sandbox API routes — launch, monitor, and manage sandboxed agent sessions."""

import logging
from dataclasses import asdict
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from securevector.app.database.connection import get_database
from securevector.app.sandbox.repository import SandboxRepository
from securevector.app.sandbox import runner

logger = logging.getLogger(__name__)

router = APIRouter()


class LaunchRequest(BaseModel):
    command: str
    timeout: str = "5m"
    allow_env: str = ""
    keep: bool = False


class RegisterRequest(BaseModel):
    id: str
    command: str
    pid: Optional[int] = None
    workspace: Optional[str] = None
    agent_type: Optional[str] = None
    started_at: Optional[str] = None


class ReportRequest(BaseModel):
    id: str
    exit_code: Optional[int] = None
    stdout: Optional[str] = None
    stderr: Optional[str] = None
    duration_ms: Optional[int] = None
    timed_out: bool = False
    error: Optional[str] = None


@router.get("/sandbox/sessions")
async def list_sessions(status: Optional[str] = None, limit: int = 100):
    """List all sandbox sessions."""
    try:
        db = get_database()
        repo = SandboxRepository(db)
        sessions = await repo.list_all(status=status, limit=limit)
        return {"sessions": [asdict(s) for s in sessions]}
    except Exception as e:
        logger.error("Failed to list sandbox sessions: %s", e)
        return {"sessions": []}


@router.get("/sandbox/sessions/{session_id}")
async def get_session(session_id: str):
    """Get a single sandbox session."""
    db = get_database()
    repo = SandboxRepository(db)
    session = await repo.get_by_id(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return asdict(session)


@router.post("/sandbox/run")
async def launch_sandbox(req: LaunchRequest):
    """Launch a new sandboxed agent."""
    try:
        session = await runner.launch(
            command=req.command,
            timeout=req.timeout,
            allow_env=req.allow_env,
            keep=req.keep,
        )
        return {"id": session.id, "status": session.status, "pid": session.pid}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        logger.error("Failed to launch sandbox: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/sandbox/register")
async def register_session(req: RegisterRequest):
    """Register a CLI-launched sandbox session so it appears in the UI."""
    from securevector.app.sandbox.models import SandboxSession
    from datetime import datetime

    session = SandboxSession(
        id=req.id,
        command=req.command,
        status="running",
        pid=req.pid,
        workspace=req.workspace,
        agent_type=req.agent_type or runner._detect_agent_type(req.command),
        started_at=req.started_at or datetime.utcnow().isoformat(),
    )
    db = get_database()
    repo = SandboxRepository(db)
    await repo.create(session)
    return {"status": "registered", "id": session.id}


@router.post("/sandbox/report")
async def report_session(req: ReportRequest):
    """Report completion of a CLI-launched sandbox session."""
    from datetime import datetime

    status = "timed_out" if req.timed_out else ("completed" if (req.exit_code or 0) == 0 else "failed")

    db = get_database()
    repo = SandboxRepository(db)
    await repo.update_status(
        session_id=req.id,
        status=status,
        exit_code=req.exit_code,
        stdout=req.stdout[:50000] if req.stdout else None,
        stderr=req.stderr[:50000] if req.stderr else None,
        duration_ms=req.duration_ms,
        finished_at=datetime.utcnow().isoformat(),
        error=req.error,
    )
    return {"status": "reported", "id": req.id}


@router.post("/sandbox/sessions/{session_id}/kill")
async def kill_session(session_id: str):
    """Kill a running sandbox session."""
    killed = await runner.kill_session(session_id)
    if not killed:
        raise HTTPException(status_code=404, detail="Session not running or not found")
    return {"status": "killed", "id": session_id}


@router.delete("/sandbox/sessions/{session_id}")
async def delete_session(session_id: str):
    """Delete a sandbox session record."""
    db = get_database()
    repo = SandboxRepository(db)
    session = await repo.get_by_id(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    await repo.delete(session_id)
    return {"status": "deleted", "id": session_id}
