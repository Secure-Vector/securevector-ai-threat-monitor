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

import anyio.to_thread

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

from securevector.app.database.repositories.session_drift import SessionDriftRepository
from securevector.app.services import response_rungs, session_drift
from securevector.app.terminals.auth import TerminalAuth, get_auth, retry_terminals_init
from securevector.app.terminals.executors import ExecutorUnavailable, UnknownExecutor
from securevector.app.terminals.gitinfo import workspace_branch
from securevector.app.terminals.manager import (
    GuardHooksMissing,
    NotLinkable,
    SessionAlreadyLinked,
    TerminalManager,
)
from securevector.app.terminals.pty_host import PtyUnavailable
from securevector.app.terminals import worktree as worktrees

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/terminals", tags=["Agent Terminals"])

HEARTBEAT_SECONDS = 15
CLIENT_TIMEOUT_SECONDS = 45


async def get_manager(request: Request) -> TerminalManager:
    manager: Optional[TerminalManager] = getattr(request.app.state, "terminal_manager", None)
    if manager is None:
        await retry_terminals_init(request.app)
        manager = getattr(request.app.state, "terminal_manager", None)
    if manager is None:
        raise HTTPException(status_code=503, detail="Terminals are not initialised")
    return manager


async def require_read(request: Request, auth: TerminalAuth = Depends(get_auth)) -> None:
    await auth.require_read(request)


async def require_write(request: Request, auth: TerminalAuth = Depends(get_auth)) -> None:
    await auth.require_write(request)


async def _not_a_governed_task(request: Request) -> None:
    """Launching, linking or stopping a session, or removing its worktree,
    is a person's action, from the page or from their own terminal (the CLI
    has no UI token), never from a running task: the caller check."""
    from securevector.app.services import decisions

    await decisions.refuse_governed_caller(request)


def _with_branch(items):
    # Runs in a worker thread (see the callers): every branch lookup is a
    # blocking read of a folder the app does not control.
    # One disk read per distinct folder, not per task: a list of tasks is
    # usually several tasks in the same checkout.
    cache: dict = {}
    for item in items:
        ws = item.get("workspace") or ""
        if ws not in cache:
            cache[ws] = workspace_branch(ws) if ws else None
        item["branch"] = cache[ws]
        # A task in its own worktree is on its own branch.
        if item.get("worktree_branch") and item.get("worktree_state") in (worktrees.ACTIVE, worktrees.KEPT):
            item["branch"] = item["worktree_branch"]
    return items


async def _decorate(manager: TerminalManager, items):
    """Branch (blocking, worker thread) plus governed_at_launch (async DB).

    Also the poll for linked tasks: they have no PTY exit to wait on, so
    every board read is what moves them between working, idle and done.
    The refresh is derived state, never new facts: it only rewrites a linked
    row's own status from audit rows the Guard already wrote, so running it
    under the read dependency is deliberate rather than an oversight.
    """
    items = await manager.refresh_linked(items)
    items = await anyio.to_thread.run_sync(_with_branch, items)
    ungoverned = manager.ungoverned_ids()
    # The in-memory set only covers launches from THIS process, so every task
    # it does not name falls back to the audit trail, finished ones included:
    # how a task launched is a fact about the past, and a restart must not
    # turn an ungoverned launch into a governed-looking one. One query for the
    # whole page, not one per task, because this list is polled every few
    # seconds.
    unknown = [item["id"] for item in items if item["id"] not in ungoverned]
    audited = await manager.store.tasks_with_event("guard_missing", unknown)
    silent = manager.guard_silent()
    for item in items:
        item["governed_at_launch"] = not (item["id"] in ungoverned or item["id"] in audited)
        item["guard_warning"] = silent.get(item["id"])
    await _with_spend(manager, items)
    await _with_delegations(manager, items)
    await _with_counts(manager, items)
    await _with_drift(manager, items)
    await _with_rung(manager, items)
    await _with_setup(manager, items)
    return items


async def _with_rung(manager: TerminalManager, items) -> None:
    """The stored response rung word and mode for the facts line. One read
    of stored rows, no evaluation here; a failure leaves the fields off."""
    ids = [i.get("session_id") for i in items if i.get("session_id")]
    if not ids:
        return
    try:
        from securevector.app.database.repositories.response_rungs import ResponseRungsRepository
        rows = await ResponseRungsRepository(manager.store.db).for_sessions(ids)
    except Exception:  # noqa: BLE001 - the board must render without it
        logger.debug("could not read rung rows for the board", exc_info=True)
        return
    for item in items:
        row = rows.get(item.get("session_id") or "")
        if row:
            item["rung_word"] = response_rungs.RUNG_WORDS.get(int(row["rung"]), "observe")
            item["rung_mode"] = row.get("mode")
            try:
                item["rung_reasons"] = [str(r) for r in json.loads(row.get("reasons_json") or "[]")][:5]
            except (TypeError, ValueError):
                item["rung_reasons"] = []
            item["rung_would_ask"] = int(row.get("would_ask") or 0)


async def _with_drift(manager: TerminalManager, items) -> None:
    """The stored Session Drift Score and band for the facts line. One read
    of stored rows for the page, no scoring here; a failure leaves the
    fields off. Observe only: nothing on the board acts on it."""
    ids = [i.get("session_id") for i in items if i.get("session_id")]
    if not ids:
        return
    try:
        rows = await SessionDriftRepository(manager.store.db).for_sessions(ids)
    except Exception:  # noqa: BLE001 - the board must render without drift
        logger.debug("could not read drift rows for the board", exc_info=True)
        return
    for item in items:
        row = rows.get(item.get("session_id") or "")
        if row and row.get("score") is not None:
            item["drift_score"] = int(row["score"])
            item["drift_band"] = row.get("band")


async def _with_setup(manager: TerminalManager, items) -> None:
    """Agent Config Trust state for the facts line: the latest stored check
    per task, no scan here. A failure leaves the fields off."""
    ids = [i.get("id") for i in items if i.get("id")]
    if not ids:
        return
    try:
        from securevector.app.database.repositories.config_trust import ConfigTrustRepository
        rows = await ConfigTrustRepository(manager.store.db).latest_for_tasks(ids)
    except Exception:  # noqa: BLE001 - the board must render without it
        logger.debug("could not read setup checks for the board", exc_info=True)
        return
    for item in items:
        row = rows.get(item.get("id"))
        if row:
            item["setup_state"] = row.get("state")
            item["setup_changes"] = len(row.get("diff") or [])


async def _with_counts(manager: TerminalManager, items) -> None:
    """Tool calls and blocked calls per session for the board's facts line.
    One grouped read for the page; a failure leaves the fields off."""
    ids = [i.get("session_id") for i in items if i.get("session_id")]
    if not ids:
        return
    try:
        # A task re-linked after /clear counts every session it has held.
        hist = await manager.store.session_histories([i["id"] for i in items if i.get("id")])
        every = ids + [h for v in hist.values() for h in v]
        counts = await manager.store.verdict_counts(list(dict.fromkeys(every)))
    except Exception:  # noqa: BLE001 - the board must render without counts
        logger.debug("could not read verdict counts for the board", exc_info=True)
        return
    for item in items:
        sids = list(dict.fromkeys(
            [item.get("session_id") or ""] + hist.get(item.get("id"), [])
        ))
        rows = [counts[s] for s in sids if s in counts]
        if rows:
            item["tool_calls"] = sum(r["calls"] for r in rows)
            item["blocked_calls"] = sum(r["blocked"] for r in rows)


async def _with_spend(manager: TerminalManager, items) -> None:
    """What each session has cost so far, keyed by the harness session id.

    The release plan asks for cost on the board card and cost so far in the
    verdict rail,
    and both are the same number. One grouped query for the whole page, like
    the governed_at_launch read above: this list is polled every few seconds.

    A row with no priced request is left without the field rather than given a
    0.00, because "nothing has been billed yet" and "this cost nothing" read
    the same at a glance and only one of them is usually true.
    """
    ids = [i.get("session_id") for i in items if i.get("session_id")]
    if not ids:
        return
    try:
        from securevector.app.database.repositories.costs import CostsRepository

        usage = await CostsRepository(manager.store.db).get_run_usage_bulk(ids)
    except Exception:  # noqa: BLE001 - the board must render without pricing
        logger.debug("could not read spend for the board", exc_info=True)
        return
    for item in items:
        row = usage.get(item.get("session_id") or "")
        if row and row.get("requests"):
            item["spend_usd"] = row["spend_usd"]
            item["spend_requests"] = row["requests"]
    # A parent's total over itself and the children listed with it. Read-only
    # and additive: spend_usd above stays the session's own figure.
    by_id = {i.get("id"): i for i in items}
    totals: dict = {}
    for item in items:
        parent = item.get("parent_task_id")
        if parent and parent in by_id and item.get("spend_usd") is not None:
            totals[parent] = totals.get(parent, 0.0) + float(item["spend_usd"])
    for parent, extra in totals.items():
        item = by_id[parent]
        item["spend_total_usd"] = float(item.get("spend_usd") or 0.0) + extra


async def _with_delegations(manager: TerminalManager, items) -> None:
    """How many delegations each parent has running, done and held. One
    grouped query for the page; a parent with none is left without the field."""
    ids = [i["id"] for i in items if i.get("id")]
    if not ids:
        return
    try:
        marks = ",".join("?" for _ in ids)
        rows = await manager.store.db.fetch_all(
            "SELECT parent_task_id, state, COUNT(*) AS n FROM delegations "
            f"WHERE parent_task_id IN ({marks}) GROUP BY parent_task_id, state",
            tuple(ids),
        )
    except Exception:  # noqa: BLE001 - the board must render without it
        logger.debug("could not read delegation counts for the board", exc_info=True)
        return
    counts: dict = {}
    for r in rows or []:
        c = counts.setdefault(r["parent_task_id"], {"running": 0, "done": 0, "held": 0})
        key = {"running": "running", "pending_approval": "running", "done": "done", "held": "held"}.get(r["state"])
        if key:
            c[key] += int(r["n"])
    for item in items:
        c = counts.get(item.get("id"))
        if c and any(c.values()):
            item["delegations"] = c


# Who asked, recorded on the task's own event trail. NOT the task row's
# `origin`, which is `launch` or `linked` and says how the row came to exist: a
# session started from the CLI is still a launch. An allowlist rather than a
# free string, because the value is written verbatim into the tamper-evident
# event chain and read back into the UI.
ACTORS = frozenset({"ui", "cli", "rung", "delegate", "policy"})


def _actor(value: Optional[str]) -> str:
    """The claim is only as trustworthy as the token that carried it, which is
    the same token the UI uses, so this is descriptive rather than a control.
    Constrained anyway so an unknown value cannot reach the audit trail."""
    if value is None:
        return "ui"
    if value not in ACTORS:
        raise HTTPException(status_code=400, detail="Unknown origin")
    return value


class SpawnRequest(BaseModel):
    # extra="forbid": argv, env, command or any other field is a 422. The
    # host decides how a task runs; the client only names what and where.
    model_config = ConfigDict(extra="forbid")
    executor_id: str = Field(min_length=1, max_length=64)
    workspace: str = Field(min_length=1, max_length=4096)
    title: Optional[str] = Field(default=None, max_length=120)
    # Reopen this harness session instead of starting a fresh one. Still only
    # a name: the host decides what argv that turns into, and refuses the
    # harnesses that cannot reopen a named session.
    resume_session_id: Optional[str] = Field(default=None, max_length=128)
    # Who asked. Omitted by the UI, which is the default.
    origin: Optional[str] = Field(default=None, max_length=16)
    # Run in a new git worktree of the folder instead of the folder itself.
    worktree: bool = False
    # Relaunch of this task: reuse its worktree when it still exists.
    from_task_id: Optional[str] = Field(default=None, max_length=64)


class WorktreeRemoveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # Required when the worktree has changed files: they are discarded.
    confirm: bool = False
    # The changed-file count the person was shown (from the needs_confirm
    # answer). Required with confirm when there are changes; a mismatch
    # means the worktree changed since, and the answer is needs_confirm again.
    dirty_seen: Optional[int] = Field(default=None, ge=0)


class LinkRequest(BaseModel):
    # Same closed shape as SpawnRequest: the client names a harness and a
    # session, never a command or an environment.
    model_config = ConfigDict(extra="forbid")
    executor_id: str = Field(min_length=1, max_length=64)
    session_id: str = Field(min_length=1, max_length=128)
    workspace: Optional[str] = Field(default=None, max_length=4096)
    title: Optional[str] = Field(default=None, max_length=120)
    origin: Optional[str] = Field(default=None, max_length=16)


@router.get("/session")
async def session(request: Request, response: Response, auth: TerminalAuth = Depends(get_auth)):
    return await auth.session_response(request, response)


@router.get("/executors", dependencies=[Depends(require_read)])
async def list_executors(manager: TerminalManager = Depends(get_manager)):
    # installed/governed let the launcher explain WHY an executor cannot be
    # picked instead of failing at spawn time.
    return {"items": manager.executor_status()}


# Kept worktree rows refreshed per board read (each still limited by the
# manager's per-task cache and concurrency cap).
LIST_WORKTREE_REFRESH = 10


@router.get("/tasks", dependencies=[Depends(require_read)])
async def list_tasks(manager: TerminalManager = Depends(get_manager)):
    items = await manager.store.list_tasks()
    budget = LIST_WORKTREE_REFRESH
    for i, item in enumerate(items):
        if budget <= 0:
            break
        if item.get("worktree_branch") and item.get("worktree_state") == worktrees.KEPT:
            budget -= 1
            fresh = await manager.refresh_worktree(item["id"])
            if fresh is not None:
                items[i] = fresh
    items = await _decorate(manager, items)
    return {"items": items, "running": manager.running_count()}


@router.post("/tasks", status_code=201, dependencies=[Depends(require_write), Depends(_not_a_governed_task)])
async def spawn_task(body: SpawnRequest, manager: TerminalManager = Depends(get_manager)):
    try:
        task = await manager.spawn(
            body.executor_id,
            body.workspace,
            title=body.title,
            origin=_actor(body.origin),
            resume_session_id=body.resume_session_id,
            worktree=body.worktree,
            from_task_id=body.from_task_id,
        )
        return (await _decorate(manager, [task]))[0]
    except UnknownExecutor as exc:
        raise HTTPException(status_code=400, detail="Unknown executor") from exc
    except worktrees.NotAGitRepository as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except worktrees.WorktreeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    # After UnknownExecutor, which is itself a ValueError: a malformed session
    # id or a harness that cannot reopen one both land here.
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except NotADirectoryError as exc:
        raise HTTPException(status_code=400, detail="Workspace folder does not exist") from exc
    except GuardHooksMissing as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ExecutorUnavailable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except PtyUnavailable as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc


@router.post("/tasks/link", status_code=201, dependencies=[Depends(require_write), Depends(_not_a_governed_task)])
async def link_task(body: LinkRequest, manager: TerminalManager = Depends(get_manager)):
    """Put a harness session started outside the app on the board."""
    try:
        task = await manager.link_session(
            body.executor_id,
            body.session_id,
            workspace=body.workspace,
            title=body.title,
            origin=_actor(body.origin),
        )
        return (await _decorate(manager, [task]))[0]
    except UnknownExecutor as exc:
        raise HTTPException(status_code=400, detail="Unknown executor") from exc
    except SessionAlreadyLinked as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/sessions/unlinked", dependencies=[Depends(require_read)])
async def unlinked_sessions(manager: TerminalManager = Depends(get_manager)):
    """Recent harness sessions the Guard reported that no task claims yet."""
    return {"items": await manager.unlinked_sessions()}


@router.get("/tasks/{task_id}", dependencies=[Depends(require_read)])
async def get_task(task_id: str, manager: TerminalManager = Depends(get_manager)):
    task = await manager.store.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Unknown task")
    if task.get("run_dir"):
        # One task: fresh changed-file and commit counts for its worktree.
        task = await manager.refresh_worktree(task_id) or task
    return (await _decorate(manager, [task]))[0]


@router.get("/git-repo", dependencies=[Depends(require_read)])
async def git_repo(folder: str = ""):
    """For the launch form: can this folder run a task in a worktree?"""
    if not folder or len(folder) > 4096 or "\x00" in folder:
        return {"git": False, "root": None, "worktree_ok": False, "message": worktrees.NOT_A_REPO}
    result = await anyio.to_thread.run_sync(worktrees.check_folder, folder)
    result.setdefault("worktree_ok", False)
    return result


@router.post("/tasks/{task_id}/worktree/remove", dependencies=[Depends(require_write), Depends(_not_a_governed_task)])
async def remove_worktree(task_id: str, body: WorktreeRemoveRequest, request: Request,
                          manager: TerminalManager = Depends(get_manager)):
    """Remove a task's worktree on the person's request. With changed files
    and no `confirm`, nothing is removed and needs_confirm comes back.
    Only a call that would actually remove asks the person on the computer;
    the needs_confirm answer is read only and asks nothing."""
    from securevector.app.services import confirmations, decisions

    if not confirmations.is_replay(request):
        _require_ui_token(request)
        await decisions.refuse_governed_caller(request, manager)
        try:
            held = await manager.worktree_removal_check(task_id, confirm=body.confirm, dirty_seen=body.dirty_seen)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Unknown task") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except worktrees.WorktreeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if held is not None:
            raise HTTPException(status_code=409, detail=held)
        await confirmations.gate(request)
    try:
        result = await manager.remove_worktree(task_id, confirm=body.confirm, origin="ui",
                                               dirty_seen=body.dirty_seen)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown task") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except worktrees.WorktreeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not result.get("removed") and result.get("needs_confirm"):
        raise HTTPException(status_code=409, detail=result)
    return result


@router.post("/tasks/{task_id}/worktree/open", dependencies=[Depends(require_write)])
async def open_worktree(task_id: str, request: Request, manager: TerminalManager = Depends(get_manager)):
    """Reveal the task's worktree folder in the platform file manager."""
    _require_ui_token(request)
    task =await manager.store.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Unknown task")
    folder = manager.worktree_folder(task)
    if folder is None:
        raise HTTPException(status_code=409, detail="This task has no worktree folder on disk.")
    argv = worktrees.open_folder_argv(folder)
    if argv is None:
        raise HTTPException(status_code=501, detail="Opening a folder is not supported on this system.")

    def _run() -> int:
        import subprocess

        return subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=10, check=False).returncode

    try:
        await anyio.to_thread.run_sync(_run)
    except Exception as exc:  # noqa: BLE001 - shown as a plain failure
        raise HTTPException(status_code=500, detail="The folder could not be opened.") from exc
    return {"ok": True, "folder": folder}


@router.post("/tasks/{task_id}/stop", dependencies=[Depends(require_write), Depends(_not_a_governed_task)])
async def stop_task(
    task_id: str,
    origin: Optional[str] = None,
    manager: TerminalManager = Depends(get_manager),
):
    if await manager.store.get_task(task_id) is None:
        raise HTTPException(status_code=404, detail="Unknown task")
    try:
        await manager.stop(task_id, origin=_actor(origin))
    except NotLinkable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except KeyError:
        pass  # already gone from the host; the row is authoritative
    return {"ok": True}


@router.post("/tasks/{task_id}/archive", dependencies=[Depends(require_write)])
async def archive_task(task_id: str, manager: TerminalManager = Depends(get_manager)):
    try:
        archived = await manager.archive_task(task_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not archived:
        raise HTTPException(status_code=404, detail="Unknown task")
    # Archiving never touches a worktree; say when one is still on disk so
    # the page can offer to remove it.
    task = await manager.store.get_task(task_id)
    kept = bool(task and manager.worktree_folder(task))
    return {
        "ok": True,
        "worktree_kept": kept,
        "run_dir": task.get("run_dir") if kept else None,
        "worktree_branch": task.get("worktree_branch") if kept else None,
    }


@router.post("/stop-all", dependencies=[Depends(require_write), Depends(_not_a_governed_task)])
async def stop_all(
    origin: Optional[str] = None, manager: TerminalManager = Depends(get_manager)
):
    await manager.stop_all(origin=_actor(origin))
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
    history = await manager.store.session_history(task_id)
    # Current id plus the ids it held before a re-link, newest first.
    sids = list(dict.fromkeys([task["session_id"], *reversed(history)]))
    items = await manager.store.list_verdicts(sids)
    return {
        "items": items,
        "session_id": task["session_id"],
        "session_history": history,
        "egress_blocks": await _egress_blocks(manager, sids),
    }


async def _egress_blocks(manager: TerminalManager, session_ids) -> list:
    """Calls the egress check refused in this session, shaped like a verdict
    row (action block, source egress) so the Tool calls list can show them.

    Read from egress_audit, one row per refused call, never copied into
    tool_call_audit: the egress row is the record and is not written twice.
    Kept apart from `items` so the counts that already add egress denies from
    the destinations read do not count them a second time. Best effort.
    """
    try:
        from securevector.app.database.repositories.egress import EgressRepository

        rows = await EgressRepository(manager.store.db).blocked_calls(
            [session_ids] if isinstance(session_ids, str) else list(session_ids), limit=200
        )
    except Exception:  # noqa: BLE001 - the list must render without them
        logger.debug("could not read egress blocks for the verdict list", exc_info=True)
        return []
    out = []
    for r in rows:
        hosts = r.get("hosts") or []
        rules = r.get("rule_ids") or []
        tool = r.get("tool_name") or "network call"
        out.append({
            "tool_id": tool,
            "function_name": tool,
            "action": "block",
            "source": "egress",
            "risk": None,
            "hosts": hosts,
            "rule_ids": rules,
            "reason": "Egress blocked: " + ", ".join(hosts)
                      + (f" ({', '.join(rules)})" if rules else ""),
            "called_at": r.get("called_at"),
        })
    return out


# -- Session Drift Score (observe only) ---------------------------------------
#
# Two reads and one write. The write records "looks normal" and nothing else:
# no route here blocks, stops or prompts, and the score changes no verdict.

DRIFT_BATCH_MAX = 200


@router.get("/tasks/{task_id}/drift", dependencies=[Depends(require_read)])
async def task_drift(task_id: str, manager: TerminalManager = Depends(get_manager)):
    """Score the task's session now (summary open) and return the number,
    band, top three features in plain words and the baseline behind it.

    A GET that writes: it rescores and overwrites the session's
    `session_drift` row (keeping its "looks normal" mark), the same derived
    write the warm loop makes every 60 s. Derived state only, never a new
    fact and never a verdict, which is why it sits under the read token.
    The response also carries `ended` so the page offers "Looks normal" only
    for a session that has finished."""
    task = await manager.store.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Unknown task")
    sid = task.get("session_id")
    if not sid:
        return session_drift.payload(
            session_drift.DriftResult(None, None, session_drift.STATUS_NO_SESSION, [], False, "")
        )
    result = await session_drift.score_for(sid, db=manager.store.db, task=task)
    row = await SessionDriftRepository(manager.store.db).get(sid)
    return {**session_drift.payload(result, (row or {}).get("feedback")), "ended": bool(task.get("ended_at"))}


@router.get("/tasks/{task_id}/preflight", dependencies=[Depends(require_read)])
async def task_preflight(task_id: str, manager: TerminalManager = Depends(get_manager)):
    """Pre-flight checks for the task's sessions: counts, match rate and the
    last ten checks (kind, decision, age). No targets."""
    from securevector.app.services import policy_check

    task = await manager.store.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Unknown task")
    return await policy_check.preflight_summary(manager.store.db, task)


@router.get("/drift", dependencies=[Depends(require_read)])
async def drift_batch(task_ids: str = "", manager: TerminalManager = Depends(get_manager)):
    """Stored score and band per task, for the sidebar. Reads stored rows only."""
    ids = [i for i in (task_ids or "").split(",") if i][:DRIFT_BATCH_MAX]
    tasks = [t for t in [await manager.store.get_task(i) for i in ids] if t]
    rows = await SessionDriftRepository(manager.store.db).for_sessions(
        [t["session_id"] for t in tasks if t.get("session_id")]
    )
    items = {}
    for t in tasks:
        row = rows.get(t.get("session_id") or "")
        if row:
            items[t["id"]] = {"score": row.get("score"), "band": row.get("band"), "status": row.get("status")}
    return {"items": items}


class DriftFeedback(BaseModel):
    model_config = ConfigDict(extra="forbid")
    feedback: str = Field(default=session_drift.FEEDBACK_NORMAL, pattern="^normal$")


@router.post("/tasks/{task_id}/drift/feedback", dependencies=[Depends(require_write)])
async def drift_feedback(
    task_id: str,
    request: Request,
    body: Optional[DriftFeedback] = None,
    manager: TerminalManager = Depends(get_manager),
):
    """Record "looks normal": the session joins the baseline for later
    sessions and counts toward the published false-flag rate. A decision,
    so it needs the per-run UI token like the other decision routes."""
    await _require_person(request, manager)
    task = await manager.store.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Unknown task")
    sid = task.get("session_id")
    if not sid:
        raise HTTPException(status_code=409, detail="This task has no governed session")
    # Only a finished session can be marked normal.
    if not task.get("ended_at") or await manager.store.db.fetch_one(
        "SELECT 1 FROM terminal_tasks WHERE session_id = ? AND ended_at IS NULL LIMIT 1", (sid,)
    ):
        raise HTTPException(status_code=409, detail="Session is still running; mark it normal after it ends")
    repo = SessionDriftRepository(manager.store.db)
    if await repo.get(sid) is None:
        await session_drift.score_for(sid, db=manager.store.db, task=task)
    await repo.set_feedback(sid, session_drift.FEEDBACK_NORMAL)
    session_drift.clear_cache()
    from securevector.app.services import decisions
    await decisions.audit(manager.store.db, "looks_normal", session_id=sid, task_id=task_id,
                          klass="drift", harness=task.get("executor_id"))
    return {"ok": True, "feedback": session_drift.FEEDBACK_NORMAL}


@router.get("/tasks/{task_id}/rung", dependencies=[Depends(require_read)])
async def task_rung(task_id: str, manager: TerminalManager = Depends(get_manager)):
    """The task's response rung as last recorded. Read only: the warm loop
    and the exit pass write it; in shadow mode nothing here is applied."""
    from securevector.app.database.repositories.response_rungs import ResponseRungsRepository

    task = await manager.store.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Unknown task")
    repo = ResponseRungsRepository(manager.store.db)
    row = await repo.get_for_task(task_id)
    if row is None and task.get("session_id"):
        row = await repo.get(task["session_id"])
    return response_rungs.payload(row)


@router.get("/rungs/modes", dependencies=[Depends(require_read)])
async def rung_modes(manager: TerminalManager = Depends(get_manager)):
    """Mode and shadow progress for every harness seen so far."""
    from securevector.app.database.repositories.response_rungs import ResponseRungsRepository

    out = []
    for row in await ResponseRungsRepository(manager.store.db).all_modes():
        out.append(await response_rungs.shadow_progress(manager.store.db, row["harness"], read_only=True))
    return {"modes": out, **await response_rungs.window_counts(manager.store.db)}


@router.get("/rungs/modes/{harness}", dependencies=[Depends(require_read)])
async def rung_mode(harness: str, manager: TerminalManager = Depends(get_manager)):
    """One harness: mode, shadow progress and what shadow would have stepped up."""
    from securevector.app.services.config_trust_scan import HARNESS_LABELS

    if harness not in HARNESS_LABELS:
        raise HTTPException(status_code=404, detail="Unknown harness")
    db = manager.store.db
    return {**await response_rungs.shadow_progress(db, harness, read_only=True),
            "would_have": await response_rungs.shadow_would_have(db, harness, read_only=True)}


async def _task_session(manager: TerminalManager, task_id: str) -> str:
    task = await manager.store.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Unknown task")
    sid = task.get("session_id")
    if not sid:
        raise HTTPException(status_code=409, detail="This task has no governed session")
    return sid


def _require_ui_token(request: Request) -> None:
    """The per-run UI token the approval routes use, on top of require_write."""
    from securevector.app.server.routes.jit_access import _require_ui_token as check

    check(request.headers.get("x-sv-ui-token"))


async def _require_person(request: Request, manager) -> None:
    """The UI token, and the request is not from a governed task (see
    services/decisions.py for what that check covers and its limits)."""
    from securevector.app.services import confirmations, decisions

    if confirmations.is_replay(request):
        return
    _require_ui_token(request)
    await decisions.refuse_governed_caller(request, manager)
    await confirmations.gate(request)


@router.post("/tasks/{task_id}/rung/release", dependencies=[Depends(require_write)])
async def task_rung_release(task_id: str, request: Request, manager: TerminalManager = Depends(get_manager)):
    """Back to observe for this session: pinned to rung 1, its rung grants
    revoked and its pending rung requests cancelled. One call."""
    await _require_person(request, manager)
    sid = await _task_session(manager, task_id)
    row = await response_rungs.release_session(manager.store.db, sid, origin="ui")
    if row is None:
        raise HTTPException(status_code=409, detail="No rung is recorded for this session yet")
    from securevector.app.services import decisions
    await decisions.audit(manager.store.db, "release", session_id=sid, task_id=task_id,
                          klass="step_up", harness=row.get("harness"))
    return response_rungs.payload(row)


class RungFeedback(BaseModel):
    model_config = ConfigDict(extra="forbid")
    feedback: Optional[str] = Field(default=None, pattern="^not_needed$")


@router.post("/tasks/{task_id}/rung/feedback", dependencies=[Depends(require_write)])
async def task_rung_feedback(task_id: str, body: RungFeedback, request: Request,
                             manager: TerminalManager = Depends(get_manager)):
    """Mark a step-up "Not needed" (or clear the mark)."""
    await _require_person(request, manager)
    sid = await _task_session(manager, task_id)
    await response_rungs.set_feedback(manager.store.db, sid, body.feedback)
    from securevector.app.services import decisions
    await decisions.audit(manager.store.db, body.feedback or "feedback_cleared", session_id=sid,
                          task_id=task_id, klass="step_up")
    return {"ok": True, "feedback": body.feedback}


class RungModeChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Optional[str] = Field(default=None, pattern="^(shadow|active)$")
    end_shadow_early: Optional[bool] = None


@router.post("/rungs/modes/{harness}", dependencies=[Depends(require_write)])
async def set_rung_mode(harness: str, body: RungModeChange, request: Request,
                        manager: TerminalManager = Depends(get_manager)):
    """Switch one harness between shadow and active, or end shadow early.
    Also needs the per-run UI token the approval routes use. Active is
    refused until the shadow period is complete or ended early."""
    from securevector.app.services.config_trust_scan import HARNESS_LABELS

    await _require_person(request, manager)
    if harness not in HARNESS_LABELS:
        raise HTTPException(status_code=404, detail="Unknown harness")
    if (body.mode is None) == (not body.end_shadow_early):
        raise HTTPException(status_code=422, detail="Send either a mode or end_shadow_early")
    db = manager.store.db
    if body.end_shadow_early:
        return await response_rungs.end_shadow_early(db, harness)
    try:
        return await response_rungs.set_mode(db, harness, body.mode)
    except response_rungs.ModeError as e:
        raise HTTPException(status_code=409, detail=str(e))


class StopSwitchChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    on: bool


@router.post("/rungs/stop/{harness}", dependencies=[Depends(require_write)])
async def set_stop_switch(harness: str, body: StopSwitchChange, request: Request,
                          manager: TerminalManager = Depends(get_manager)):
    """The "High: stop the session and alert" switch for one agent tool.
    Turning it on raises protection, so it needs the UI token only; turning
    it off needs the person's approval. A governed agent can do neither."""
    from securevector.app.services import confirmations, decisions, stop_switch
    from securevector.app.services.config_trust_scan import HARNESS_LABELS

    # An unknown agent tool is refused before any approval prompt.
    if harness not in HARNESS_LABELS:
        raise HTTPException(status_code=404, detail="Unknown harness")
    if body.on:
        if not confirmations.is_replay(request):
            _require_ui_token(request)
            await decisions.refuse_governed_caller(request, manager)
    else:
        await _require_person(request, manager)
    return await stop_switch.set_switch(manager.store.db, harness, body.on)


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
    await retry_terminals_init(websocket.app)
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
                logger.debug("terminal ws pump task failed for %s", str(task_id).replace("\n", " ").replace("\r", " "), exc_info=result)
        manager.detach(task_id, sub)
        try:
            await manager.store.add_event(task_id, kind="detach", origin="ui")
        except Exception:
            logger.debug("detach audit failed for %s", str(task_id).replace("\n", " ").replace("\r", " "), exc_info=True)
        try:
            await websocket.close()
        except Exception:
            pass


# -- governed delegation ------------------------------------------------------


def _delegation_ui_view(row: dict) -> dict:
    """The UI's view of one delegation: the caller's view plus the parent,
    timestamps and, for a held result, what flagged it. The held text itself
    is not included."""
    from securevector.app.services import delegation

    out = delegation.view(row)
    out["parent_task_id"] = row.get("parent_task_id")
    out["created_at"] = row.get("created_at")
    out["ended_at"] = row.get("ended_at")
    if row.get("state") == "held":
        try:
            out["flags"] = (json.loads(row.get("result_flag") or "{}") or {}).get("reasons") or []
        except ValueError:
            out["flags"] = []
    return out


@router.get("/tasks/{task_id}/delegations", dependencies=[Depends(require_read)])
async def task_delegations(task_id: str, manager: TerminalManager = Depends(get_manager)):
    """Delegations this task asked for, newest first."""
    from securevector.app.services import delegation

    rows = await delegation.for_parent(manager.store.db, task_id)
    out = []
    for row in rows:
        row = await delegation.refresh(manager.store.db, manager, row, quick=True)
        out.append(_delegation_ui_view(row))
    return {"items": out}


@router.post("/delegations/{delegation_id}/release", dependencies=[Depends(require_write)])
async def delegation_release(delegation_id: str, request: Request,
                             manager: TerminalManager = Depends(get_manager)):
    """Hand a held result to the task that asked for it."""
    await _require_person(request, manager)
    from securevector.app.services import delegation

    out = await delegation.release(manager.store.db, manager, delegation_id)
    if out is None:
        raise HTTPException(status_code=404, detail="No held result for this delegation")
    return out


@router.post("/delegations/{delegation_id}/discard", dependencies=[Depends(require_write)])
async def delegation_discard(delegation_id: str, request: Request,
                             manager: TerminalManager = Depends(get_manager)):
    """Drop a held result; the task that asked gets no text."""
    await _require_person(request, manager)
    from securevector.app.services import delegation

    out = await delegation.discard(manager.store.db, manager, delegation_id)
    if out is None:
        raise HTTPException(status_code=404, detail="No held result for this delegation")
    return out
