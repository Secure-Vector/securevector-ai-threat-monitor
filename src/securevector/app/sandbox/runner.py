"""Sandbox runner — spawns sv-sandbox Go binary as subprocess.

Uses asyncio.create_subprocess_exec with explicit argument lists
(not shell=True) to prevent command injection.
"""

import asyncio
import json
import logging
import os
import shlex
import shutil
import uuid
from datetime import datetime
from typing import Optional

from securevector.app.database.connection import get_database
from securevector.app.sandbox.models import SandboxSession
from securevector.app.sandbox.repository import SandboxRepository

logger = logging.getLogger(__name__)

# Track running processes: session_id -> asyncio.subprocess.Process
_running: dict[str, asyncio.subprocess.Process] = {}


def _find_binary() -> Optional[str]:
    """Locate the sv-sandbox binary."""
    # 1. SV_SANDBOX_PATH env var
    env_path = os.environ.get("SV_SANDBOX_PATH")
    if env_path and os.path.isfile(env_path):
        return env_path

    # 2. Relative to repo: runner/bin/sv-sandbox
    for base in [os.getcwd(), os.path.dirname(os.path.abspath(__file__))]:
        for rel in ["runner/bin/sv-sandbox", "../runner/bin/sv-sandbox",
                     "../../runner/bin/sv-sandbox", "../../../runner/bin/sv-sandbox",
                     "../../../../runner/bin/sv-sandbox"]:
            candidate = os.path.normpath(os.path.join(base, rel))
            if os.path.isfile(candidate):
                return candidate

    # 3. System PATH
    return shutil.which("sv-sandbox")


def _detect_agent_type(command: str) -> str:
    cmd = command.strip().lower()
    if cmd.startswith("openclaw"):
        return "OpenClaw"
    if cmd.startswith("claude"):
        return "Claude"
    if cmd.startswith("codex"):
        return "Codex"
    if cmd.startswith("python") or cmd.startswith("python3"):
        return "Python"
    if cmd.startswith("node"):
        return "Node.js"
    return "Custom"


def _split_command(command: str) -> list[str]:
    """Split a command string into args, respecting quotes."""
    try:
        return shlex.split(command)
    except ValueError:
        return command.split()


async def launch(
    command: str,
    timeout: str = "5m",
    allow_env: str = "",
    keep: bool = False,
) -> SandboxSession:
    """Launch a command inside sv-sandbox and track it."""
    binary = _find_binary()
    if not binary:
        raise RuntimeError(
            "sv-sandbox binary not found. Build it: cd runner && make build"
        )

    session_id = str(uuid.uuid4())[:12]
    agent_type = _detect_agent_type(command)

    # Build sv-sandbox argument list (no shell interpretation)
    args = [binary, "--json", "--timeout", timeout]
    if allow_env:
        args.extend(["--allow-env", allow_env])
    if keep:
        args.append("--keep")
    args.append("--")
    args.extend(_split_command(command))

    logger.info("Launching sandbox session %s: %s", session_id, command)

    # Spawn subprocess using exec (not shell) to prevent injection
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    session = SandboxSession(
        id=session_id,
        command=command,
        status="running",
        pid=proc.pid,
        agent_type=agent_type,
        started_at=datetime.utcnow().isoformat(),
    )

    # Save to DB
    db = get_database()
    repo = SandboxRepository(db)
    await repo.create(session)

    # Track process
    _running[session_id] = proc

    # Start background task to wait for completion
    asyncio.create_task(_wait_for_completion(session_id, proc))

    return session


async def _wait_for_completion(session_id: str, proc: asyncio.subprocess.Process):
    """Wait for subprocess to finish and update DB."""
    try:
        stdout_bytes, stderr_bytes = await proc.communicate()
        stdout_str = stdout_bytes.decode("utf-8", errors="replace") if stdout_bytes else ""
        stderr_str = stderr_bytes.decode("utf-8", errors="replace") if stderr_bytes else ""

        # Try to parse JSON output from sv-sandbox --json
        result = {}
        try:
            result = json.loads(stdout_str)
        except (json.JSONDecodeError, ValueError):
            pass

        exit_code = result.get("exit_code", proc.returncode or 0)
        timed_out = result.get("timed_out", False)
        duration_ms = result.get("duration_ms", 0)
        workspace = result.get("workspace", "")
        error = result.get("error", "")
        out = result.get("stdout", stdout_str)
        err = result.get("stderr", stderr_str)

        if timed_out:
            status = "timed_out"
        elif exit_code == 0:
            status = "completed"
        else:
            status = "failed"

        db = get_database()
        repo = SandboxRepository(db)
        await repo.update_status(
            session_id=session_id,
            status=status,
            exit_code=exit_code,
            stdout=out[:50000] if out else None,
            stderr=err[:50000] if err else None,
            duration_ms=duration_ms,
            finished_at=datetime.utcnow().isoformat(),
            error=error or None,
        )

        if workspace:
            await db.execute(
                "UPDATE sandbox_sessions SET workspace = ? WHERE id = ?",
                (workspace, session_id),
            )
            conn = await db.connect()
            await conn.commit()

        logger.info("Sandbox session %s %s (exit=%s, %dms)", session_id, status, exit_code, duration_ms)

    except Exception as e:
        logger.error("Error waiting for sandbox session %s: %s", session_id, e)
        try:
            db = get_database()
            repo = SandboxRepository(db)
            await repo.update_status(
                session_id=session_id,
                status="failed",
                finished_at=datetime.utcnow().isoformat(),
                error=str(e),
            )
        except Exception:
            pass
    finally:
        _running.pop(session_id, None)


async def kill_session(session_id: str) -> bool:
    """Kill a running sandbox session."""
    proc = _running.get(session_id)
    if not proc:
        return False

    try:
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            proc.kill()
    except ProcessLookupError:
        pass

    db = get_database()
    repo = SandboxRepository(db)
    await repo.update_status(
        session_id=session_id,
        status="killed",
        finished_at=datetime.utcnow().isoformat(),
    )
    _running.pop(session_id, None)
    return True


def get_running_sessions() -> list[str]:
    """Return IDs of currently running sessions."""
    return list(_running.keys())
