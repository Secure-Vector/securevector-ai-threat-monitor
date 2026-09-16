"""HTTP surface and per-task WebSocket for Agent Terminals under
/api/terminals.

The WebSocket (attach/detach to a running task's PTY) is wired on the same
router as the REST routes below, not in a separate module.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import secrets
from typing import Optional

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from pydantic import BaseModel, ConfigDict, Field

from securevector.app.terminals.auth import TerminalAuth, get_auth
from securevector.app.terminals.executors import EXECUTORS, ExecutorUnavailable, UnknownExecutor
from securevector.app.terminals.manager import GuardHooksMissing, TerminalManager
from securevector.app.terminals.pty_host import PtyUnavailable

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/terminals", tags=["Agent Terminals"])

HEARTBEAT_SECONDS = 15
CLIENT_TIMEOUT_SECONDS = 45


def get_manager(request: Request) -> TerminalManager:
    manager: Optional[TerminalManager] = getattr(request.app.state, "terminal_manager", None)
    if manager is None:
        raise HTTPException(status_code=503, detail="Terminals are not initialised")
    return manager


async def require_read(request: Request, auth: TerminalAuth = Depends(get_auth)) -> None:
    await auth.require_read(request)


async def require_write(request: Request, auth: TerminalAuth = Depends(get_auth)) -> None:
    await auth.require_write(request)


class SpawnRequest(BaseModel):
    # extra="forbid": argv, env, command or any other field is a 422. The
    # host decides how a task runs; the client only names what and where.
    model_config = ConfigDict(extra="forbid")
    executor_id: str = Field(min_length=1, max_length=64)
    workspace: str = Field(min_length=1, max_length=4096)
    title: Optional[str] = Field(default=None, max_length=120)


@router.get("/session")
async def session(request: Request, response: Response, auth: TerminalAuth = Depends(get_auth)):
    return await auth.session_response(request, response)


@router.get("/executors", dependencies=[Depends(require_read)])
async def list_executors():
    return {"items": [{"id": e.id, "label": e.label} for e in EXECUTORS.values()]}


@router.get("/tasks", dependencies=[Depends(require_read)])
async def list_tasks(manager: TerminalManager = Depends(get_manager)):
    items = await manager.store.list_tasks()
    return {"items": items, "running": manager.running_count()}


@router.post("/tasks", status_code=201, dependencies=[Depends(require_write)])
async def spawn_task(body: SpawnRequest, manager: TerminalManager = Depends(get_manager)):
    try:
        return await manager.spawn(body.executor_id, body.workspace, title=body.title, origin="ui")
    except UnknownExecutor as exc:
        raise HTTPException(status_code=400, detail="Unknown executor") from exc
    except NotADirectoryError as exc:
        raise HTTPException(status_code=400, detail="Workspace folder does not exist") from exc
    except GuardHooksMissing as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ExecutorUnavailable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except PtyUnavailable as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc


@router.get("/tasks/{task_id}", dependencies=[Depends(require_read)])
async def get_task(task_id: str, manager: TerminalManager = Depends(get_manager)):
    task = await manager.store.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Unknown task")
    return task


@router.post("/tasks/{task_id}/stop", dependencies=[Depends(require_write)])
async def stop_task(task_id: str, manager: TerminalManager = Depends(get_manager)):
    if await manager.store.get_task(task_id) is None:
        raise HTTPException(status_code=404, detail="Unknown task")
    try:
        await manager.stop(task_id, origin="ui")
    except KeyError:
        pass  # already gone from the host; the row is authoritative
    return {"ok": True}


@router.post("/tasks/{task_id}/archive", dependencies=[Depends(require_write)])
async def archive_task(task_id: str, manager: TerminalManager = Depends(get_manager)):
    try:
        archived = await manager.store.archive_task(task_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not archived:
        raise HTTPException(status_code=404, detail="Unknown task")
    return {"ok": True}


@router.post("/stop-all", dependencies=[Depends(require_write)])
async def stop_all(manager: TerminalManager = Depends(get_manager)):
    await manager.stop_all(origin="ui")
    return {"ok": True}


@router.get("/tasks/{task_id}/events", dependencies=[Depends(require_read)])
async def list_events(task_id: str, manager: TerminalManager = Depends(get_manager)):
    if await manager.store.get_task(task_id) is None:
        raise HTTPException(status_code=404, detail="Unknown task")
    return {"items": await manager.store.list_events(task_id)}


@router.get("/tasks/{task_id}/verdicts", dependencies=[Depends(require_read)])
async def list_verdicts(task_id: str, manager: TerminalManager = Depends(get_manager)):
    task = await manager.store.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Unknown task")
    if not task.get("session_id"):
        return {"items": [], "session_id": None}
    items = await manager.store.list_verdicts(task["session_id"])
    return {"items": items, "session_id": task["session_id"]}


@router.post("/tasks/{task_id}/events", status_code=204)
async def hook_event(
    task_id: str, request: Request, manager: TerminalManager = Depends(get_manager)
):
    """Called by the hook relay inside the task. Authenticated by the
    per-task token only; no cookie, no Origin (it is not a browser)."""
    token = request.headers.get("x-sv-terminal-hook", "")
    # Validate the token before touching the body: an unauthenticated caller
    # should never get JSON-parsing feedback about what the endpoint expects.
    expected = manager.hook_token(task_id)
    # A header value can carry non-ASCII bytes (Starlette decodes headers as
    # latin-1); encode explicitly rather than let compare_digest raise
    # TypeError, which would surface as a 500 instead of a 403.
    token_bytes = token.encode("utf-8", "surrogateescape")
    if not expected or not secrets.compare_digest(token_bytes, expected.encode("utf-8")):
        raise HTTPException(status_code=403, detail="Bad task token")
    try:
        event = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Body must be JSON") from exc
    if not isinstance(event, dict):
        raise HTTPException(status_code=400, detail="Body must be a JSON object")
    if not await manager.handle_hook_event(task_id, token, event):
        raise HTTPException(status_code=403, detail="Bad task token")
    return Response(status_code=204)


# -- WebSocket ---------------------------------------------------------------


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


@router.websocket("/tasks/{task_id}/ws")
async def task_socket(websocket: WebSocket, task_id: str):
    auth: Optional[TerminalAuth] = getattr(websocket.app.state, "terminal_auth", None)
    manager: Optional[TerminalManager] = getattr(websocket.app.state, "terminal_manager", None)
    if auth is None or manager is None or not auth.check_ws(websocket):
        await websocket.close(code=4001)
        return
    task = await manager.store.get_task(task_id)
    if task is None:
        await websocket.close(code=4004)
        return
    await websocket.accept()
    loop = asyncio.get_running_loop()
    try:
        snapshot, sub = manager.attach(task_id, loop)
    except KeyError:
        # Row exists but the host no longer has it (finished before this
        # process, or restored as interrupted). Replay nothing, report the
        # row's own exit code rather than a hardcoded None, so a task that
        # exited 0 is not misreported as "exit code null" to the client.
        await websocket.send_json({"t": "replay", "data": ""})
        await websocket.send_json({"t": "exit", "code": task.get("exit_code")})
        await websocket.close()
        return

    # Everything from here on must run inside try/finally so a client that
    # disconnects right after attach (before or during the replay send, or
    # before the pump tasks are even created) still reaches manager.detach()
    # below and does not leak the subscriber. `stop` and `tasks` are defined
    # up front so the finally block can always reference them safely.
    stop = asyncio.Event()
    tasks = []
    try:
        await manager.store.add_event(task_id, kind="attach", origin="ui")
        await websocket.send_json({"t": "replay", "data": _b64(snapshot)})

        first_resize = True
        last_client_frame = loop.time()

        async def pump_output() -> None:
            while not stop.is_set():
                chunk = await sub.queue.get()
                if chunk is None:
                    task = await manager.store.get_task(task_id)
                    await websocket.send_json({"t": "exit", "code": (task or {}).get("exit_code")})
                    stop.set()
                    return
                if sub.dropped:
                    await websocket.send_json({"t": "dropped", "n": sub.dropped})
                    sub.dropped = 0
                await websocket.send_json({"t": "out", "data": _b64(chunk)})

        async def pump_input() -> None:
            nonlocal first_resize, last_client_frame
            while not stop.is_set():
                raw = await websocket.receive_text()
                last_client_frame = loop.time()
                try:
                    frame = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(frame, dict):
                    continue
                kind = frame.get("t")
                if kind == "input":
                    try:
                        data = base64.b64decode(frame.get("data", ""), validate=True)
                    except (ValueError, TypeError):
                        continue
                    if data:
                        await manager.input(task_id, data)
                elif kind == "resize":
                    try:
                        rows = int(frame.get("rows", 24))
                        cols = int(frame.get("cols", 80))
                    except (TypeError, ValueError):
                        continue
                    manager.resize(
                        task_id,
                        max(2, min(rows, 500)),
                        max(2, min(cols, 1000)),
                        first=first_resize,
                    )
                    first_resize = False
                # "pong" only refreshes last_client_frame.

        async def pump_heartbeat() -> None:
            # Independent of pump_output: a task that writes continuously
            # would otherwise never hit an idle branch to ping or reap a
            # half-open client, since the old design only checked liveness
            # inside pump_output's own read-timeout branch.
            while not stop.is_set():
                await asyncio.sleep(HEARTBEAT_SECONDS)
                if stop.is_set():
                    return
                if loop.time() - last_client_frame > CLIENT_TIMEOUT_SECONDS:
                    await websocket.close(code=4008)
                    stop.set()
                    return
                await websocket.send_json({"t": "ping"})

        tasks = [
            asyncio.create_task(pump_output()),
            asyncio.create_task(pump_input()),
            asyncio.create_task(pump_heartbeat()),
        ]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        except WebSocketDisconnect:
            pass
    finally:
        stop.set()
        for t in tasks:
            t.cancel()
        # Wait for every pump task to actually finish unwinding before
        # detaching/closing. The plan's sketch cancels and moves on
        # immediately; without this gather, a cancelled task can still be
        # pending when the handler coroutine returns, which showed up as
        # rare, traceback-less test flakes under the TestClient's portal
        # threads (a task destroyed mid-cancellation rather than a clean
        # CancelledError unwind).
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException) and not isinstance(result, asyncio.CancelledError):
                logger.debug("terminal ws pump task failed for %s", task_id, exc_info=result)
        manager.detach(task_id, sub)
        try:
            await manager.store.add_event(task_id, kind="detach", origin="ui")
        except Exception:
            logger.debug("detach audit failed for %s", task_id, exc_info=True)
        try:
            await websocket.close()
        except Exception:
            pass
