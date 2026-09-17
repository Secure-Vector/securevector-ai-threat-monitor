"""TerminalManager: executors + PtyHost + store + hook events, one object.

Status semantics (from the harness's own hooks, never guessed from output):
  blocked  = a permission prompt is waiting on the human
  working  = tool activity since the last idle
  idle     = Stop event (turn finished, waiting for input)
  done / failed = process exit (code 0 / non-zero)
  interrupted = the app restarted while the task was running
"""

from __future__ import annotations

import asyncio
import collections
import logging
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Mapping, Optional, Tuple

from securevector.app.terminals.executors import EXECUTORS, UnknownExecutor, build_launch
from securevector.app.terminals.pty_host import PtyHost, Subscriber
from securevector.app.terminals.store import TerminalStore, age_seconds, cwd_from_preview
from securevector.app.utils.redaction import redact_secrets

logger = logging.getLogger(__name__)

# Session ids come from the user's clipboard, so they are validated as a
# shape rather than trusted: a Claude Code uuid, a Codex rollout id, and the
# separator-bearing ids other harnesses mint all fit this, and nothing that
# could be read as a path or a shell fragment does.
SESSION_ID_RE = re.compile(r"\A[A-Za-z0-9._:-]{8,128}\Z")

# Liveness thresholds for a linked task. The app owns no process here, so
# "is it alive" is answered by how recently its Guard reported.
LINKED_WORKING_SECONDS = 120
LINKED_IDLE_SECONDS = 1800

# What a linked task's folder says when nothing in the audit trail names one.
UNKNOWN_WORKSPACE = "(unknown folder)"


class GuardHooksMissing(RuntimeError):
    """Kept for the routes/tests import surface. A missing Guard no longer
    refuses a launch: the task runs ungoverned and says so, so nothing raises
    this any more."""


class SessionAlreadyLinked(RuntimeError):
    """This harness session already has a live task on the board."""


class NotLinkable(RuntimeError):
    """An action the app cannot take on a session it does not own."""


@dataclass
class ManagerSettings:
    data_dir: Path
    port: int
    plugin_dir: Callable[[], Optional[Path]]
    plugin_enabled: Callable[[], bool]
    codex_plugin_enabled: Callable[[], bool] = lambda: False
    copilot_cli_plugin_enabled: Callable[[], bool] = lambda: False
    opencode_plugin_enabled: Callable[[], bool] = lambda: False
    parent_env: Mapping[str, str] = field(default_factory=lambda: dict(os.environ))
    default_rows: int = 30
    default_cols: int = 120


def status_from_hook(event: Mapping) -> Tuple[Optional[str], Optional[str]]:
    """Map a relayed hook payload to (status, activity). None = no change."""
    name = event.get("hook_event_name")
    if name in ("PreToolUse", "PostToolUse"):
        tool = str(event.get("tool_name") or "tool")
        preview = str(event.get("tool_input_preview") or "").strip()
        activity = f"{tool}: {preview}" if preview else tool
        return "working", activity
    if name == "UserPromptSubmit":
        return "working", "Prompt submitted"
    if name == "SessionStart":
        return "working", "Session started"
    if name == "Notification":
        kind = str(event.get("notification_type") or "")
        msg = str(event.get("message") or "")
        if "permission" in kind or "permission" in msg.lower():
            return "blocked", msg or "Waiting for permission"
        return None, None
    if name == "Stop":
        return "idle", "Waiting for input"
    return None, None


class TerminalManager:
    def __init__(
        self,
        host: PtyHost,
        store: TerminalStore,
        settings: ManagerSettings,
        *,
        retain_finished: int = 10,
    ) -> None:
        self.host = host
        self.store = store
        self.settings = settings
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._hook_tokens: dict = {}
        self._running: set = set()
        self._input_bytes: dict = {}
        self._retain_finished = retain_finished
        self._finished: "collections.deque" = collections.deque()
        # Task ids launched while their Guard plugin was not relaying hooks.
        # In-memory only; routes fall back to the guard_missing audit event so
        # a restart does not turn an ungoverned task into a governed-looking one.
        self._ungoverned: set = set()
        # link_session reads "is this session already on the board" and then
        # inserts; two links submitted at once would both pass the read and
        # both insert. Lazy-initialised for the same reason as
        # TerminalStore._lock (see store.py): on Python 3.9 asyncio.Lock()
        # eagerly touches the event loop, and a manager may be constructed
        # from sync code before one exists.
        self._link_lock: Optional[asyncio.Lock] = None

    # -- lifecycle ----------------------------------------------------------

    async def start(self, loop: asyncio.AbstractEventLoop) -> None:
        """Bind the event loop, then restore the board: anything still marked
        running belonged to a previous process and is now interrupted."""
        self._loop = loop
        interrupted = await self.store.mark_running_interrupted()
        for task in interrupted:
            await self.store.add_event(
                task["id"],
                kind="interrupted",
                origin="startup",
                detail="app restarted while the task was running",
            )
            # _reap does blocking os.kill / subprocess.run(timeout=2); keep it
            # off the event loop.
            await loop.run_in_executor(None, self._reap, task)

    def _reap(self, task: Mapping) -> None:
        """Startup reaper. Only signals a pid that is alive AND still runs the
        executor binary, so a reused pid is never touched."""
        pid = task.get("pid")
        if not pid or sys.platform == "win32":
            return
        executor = EXECUTORS.get(task.get("executor_id") or "")
        if executor is None:
            return
        try:
            os.kill(pid, 0)
        except OSError:
            return
        try:
            comm = subprocess.run(
                ["ps", "-o", "comm=", "-p", str(pid)], capture_output=True, text=True, timeout=2
            ).stdout.strip()
        except Exception:
            return
        if os.path.basename(comm) != executor.binary:
            return
        try:
            os.kill(pid, signal.SIGTERM)
            logger.info("Reaped orphaned task %s (pid %s)", task["id"], pid)
        except OSError:
            pass

    def _guard_gate(self, executor_id: str) -> Tuple[Callable[[], bool], str]:
        """The per-executor "its Guard plugin relays hook events" predicate.

        An executor with no entry here has no Guard integration at all, so its
        gate is permanently closed: a launch would be unhooked and ungoverned.
        """
        gates = {
            "codex": (self.settings.codex_plugin_enabled, "Codex"),
            "copilot-cli": (self.settings.copilot_cli_plugin_enabled, "Copilot CLI"),
            "opencode": (self.settings.opencode_plugin_enabled, "OpenCode"),
        }
        if executor_id not in gates:
            return (lambda: False), EXECUTORS[executor_id].label
        return gates[executor_id]

    def executor_status(self) -> list[dict]:
        """One row per allowlisted executor: installed (binary on the child
        PATH) and governed (its Guard plugin relays this app's hook events)."""
        # Resolve against the child PATH only, exactly as build_launch does.
        # Falling back to this process' PATH would report an executor as
        # installed that the launched task could never find.
        child_path = self.settings.parent_env.get("PATH") or ""
        rows: list[dict] = []
        for executor in EXECUTORS.values():
            installed = bool(child_path) and shutil.which(executor.binary, path=child_path) is not None
            if executor.id == "claude-code":
                # The manager injects --plugin-dir when the plugin is installed
                # but not yet enabled, so "installed" is the governance bar here.
                governed = self.settings.plugin_dir() is not None
                guard_label = executor.label
            else:
                gate, guard_label = self._guard_gate(executor.id)
                governed = bool(gate())
            if not installed:
                hint = f"Install {executor.label} to launch tasks with it."
            elif not governed:
                # "Enable or reinstall": an upgraded-but-not-restaged plugin
                # reads as enabled yet carries no relay, so "enable" alone
                # would point the user at a toggle that is already on.
                hint = (
                    f"{guard_label} Guard is not enabled. Tasks launch "
                    "ungoverned until you install it."
                )
            else:
                hint = ""
            rows.append(
                {
                    "id": executor.id,
                    "label": executor.label,
                    "installed": installed,
                    "governed": governed,
                    "hint": hint,
                }
            )
        return rows

    def ungoverned_ids(self) -> set:
        """Task ids that were launched without their Guard plugin relaying."""
        return self._ungoverned

    def running_count(self) -> int:
        return len(self._running)

    def hook_token(self, task_id: str) -> Optional[str]:
        return self._hook_tokens.get(task_id)

    # -- spawn / stop -------------------------------------------------------

    async def spawn(
        self, executor_id: str, workspace: str, *, title: Optional[str], origin: str
    ) -> dict:
        if executor_id not in EXECUTORS:
            raise UnknownExecutor(executor_id)
        # A launch is never refused for a missing Guard. It runs ungoverned,
        # writes a guard_missing event, and the session carries a banner until
        # the Guard reports in.
        plugin_dir = None
        inject = None
        if executor_id == "claude-code":
            plugin_dir = self.settings.plugin_dir()
            governed = plugin_dir is not None
            # If the plugin is already enabled in the user's Claude settings,
            # do not pass --plugin-dir as well: the hooks would run twice.
            if governed:
                inject = None if self.settings.plugin_enabled() else plugin_dir
        else:
            gate, _guard_label = self._guard_gate(executor_id)
            governed = bool(gate())
        task_id = uuid.uuid4().hex[:12]
        hook_token = secrets.token_hex(16)
        task_dir = Path(self.settings.data_dir) / "terminals" / "tasks" / task_id
        # ExecutorUnavailable / NotADirectoryError from build_launch propagate
        # unchanged — the routes layer maps them to HTTP statuses. Only
        # UnknownExecutor is raised by the manager itself, before
        # build_launch ever runs.
        launch = build_launch(
            executor_id,
            workspace=Path(workspace),
            task_dir=task_dir,
            port=self.settings.port,
            task_id=task_id,
            hook_token=hook_token,
            parent_env=self.settings.parent_env,
            plugin_dir=inject,
        )
        self._hook_tokens[task_id] = hook_token
        # The store row is created BEFORE host.spawn() runs, with pid=None.
        # InProcessPtyHost's reader thread can call on_exit almost as soon as
        # spawn() starts the child (a fast-exiting process races the caller),
        # and _on_exit_threadsafe only actually runs on the loop at our next
        # await. If the row didn't exist yet at that point, set_exit's UPDATE
        # would silently affect zero rows and the exit would be lost. Row-
        # first (then fill in the pid once spawn returns) makes that race
        # harmless: _on_exit always finds a row to update.
        created = False
        spawned = False
        try:
            await self.store.create_task(
                task_id, executor_id=executor_id, workspace=str(launch.cwd), title=title, pid=None
            )
            created = True
            # Also mark running before spawn, for the same reason: if on_exit
            # fires before this line would otherwise run, _on_exit's discard
            # must not be a no-op followed by a stale add.
            self._running.add(task_id)
            info = self.host.spawn(
                task_id,
                launch,
                self.settings.default_rows,
                self.settings.default_cols,
                self._on_exit_threadsafe,
            )
            spawned = True
        except Exception as exc:
            self._hook_tokens.pop(task_id, None)
            self._running.discard(task_id)
            if spawned:
                self.host.forget(task_id)
            if created:
                await self.store.set_exit(task_id, None)
            detail = redact_secrets(f"{type(exc).__name__}: {exc}", "outgoing")[0]
            await self.store.add_event(task_id, kind="spawn_failed", origin=origin, detail=detail)
            raise
        await self.store.update_pid(task_id, info.pid)
        await self.store.add_event(
            task_id, kind="spawn", origin=origin, detail=f"{executor_id} in {launch.cwd}"
        )
        if not governed:
            self._ungoverned.add(task_id)
            await self.store.add_event(
                task_id,
                kind="guard_missing",
                origin=origin,
                detail=(
                    f"Launched without the {EXECUTORS[executor_id].label} Guard plugin; "
                    "the task is ungoverned until it is installed"
                ),
            )
        task = await self.store.get_task(task_id)
        if task is None:
            raise RuntimeError(f"terminal task {task_id} vanished immediately after spawn")
        return task

    # -- linked sessions ----------------------------------------------------

    async def link_session(
        self,
        executor_id: str,
        session_id: str,
        *,
        workspace: Optional[str] = None,
        title: Optional[str] = None,
    ) -> dict:
        """Put a harness session that runs outside the app on the board.

        The app spawns nothing and owns no PTY here: the row exists so the
        session's verdicts, traces, egress, context and approvals have a
        place to be read, and its liveness is rederived from the audit trail
        the Guard already writes.
        """
        if executor_id not in EXECUTORS:
            raise UnknownExecutor(executor_id)
        session_id = (session_id or "").strip()
        if not SESSION_ID_RE.match(session_id):
            raise ValueError(
                "Session id must be 8 to 128 characters of letters, digits, dot, underscore, "
                "colon, or dash."
            )
        if self._link_lock is None:
            self._link_lock = asyncio.Lock()
        async with self._link_lock:
            existing = await self.store.task_for_session(session_id)
            if existing is not None:
                raise SessionAlreadyLinked("This session is already on the board.")
            folder = (workspace or "").strip()
            if not folder:
                folder = await self._resolve_linked_workspace(session_id)
            task_id = uuid.uuid4().hex[:12]
            await self.store.create_task(
                task_id,
                executor_id=executor_id,
                workspace=folder,
                title=(title or None),
                pid=None,
                origin="linked",
                status="working",
                session_id=session_id,
                activity="linked",
            )
            label = EXECUTORS[executor_id].label
            await self.store.add_event(
                task_id,
                kind="linked",
                origin="ui",
                detail=f"Linked {label} session {session_id}",
            )
        task = await self.store.get_task(task_id)
        if task is None:
            raise RuntimeError(f"terminal task {task_id} vanished immediately after linking")
        return task

    async def _resolve_linked_workspace(self, session_id: str) -> str:
        """The most recent folder the Guard reported for this session.

        No hook forwards a cwd today, so this reads what the audit rows
        happen to preview and otherwise says so plainly rather than guessing
        a path the session may never have run in.
        """
        try:
            rows = await self.store.list_verdicts(session_id, limit=50)
        except Exception:
            logger.debug("linked workspace lookup failed for %s", session_id, exc_info=True)
            return UNKNOWN_WORKSPACE
        for row in rows:
            found = cwd_from_preview(row.get("args_preview"))
            if found:
                return found
        return UNKNOWN_WORKSPACE

    async def unlinked_sessions(self) -> list[dict]:
        """Recent Guard-reported sessions with no task of their own."""
        rows = await self.store.unlinked_sessions()
        for row in rows:
            executor = EXECUTORS.get(row["executor_id"])
            row["label"] = executor.label if executor else row["executor_id"]
        return rows

    def _linked_state(self, task: Mapping, seen: Optional[Mapping]) -> dict:
        """Derive (status, activity, last_activity_at, ended_at) for one
        linked row from what its session has reported."""
        last_any = (seen or {}).get("last_any")
        last_call = (seen or {}).get("last_call")
        last_end = (seen or {}).get("last_end")
        if not last_any:
            # Linked, but the Guard has never reported. The session may have
            # no Guard yet, so this never resolves to done on its own: only a
            # reported session end, or the user removing the row, ends it.
            waited = age_seconds(task.get("created_at")) or 0.0
            status = "working" if waited < LINKED_IDLE_SECONDS else "idle"
            return {
                "status": status,
                "activity": "linked, waiting for the Guard",
                "last_activity_at": task.get("last_activity_at"),
                "ended_at": None,
            }
        ended_by_session = bool(last_end) and (not last_call or str(last_end) >= str(last_call))
        age = age_seconds(last_any)
        if age is None:
            age = 0.0
        if ended_by_session:
            return {
                "status": "done",
                "activity": "session ended",
                "last_activity_at": last_any,
                "ended_at": last_end,
            }
        if age < LINKED_WORKING_SECONDS:
            status = "working"
        elif age < LINKED_IDLE_SECONDS:
            status = "idle"
        else:
            return {
                "status": "done",
                "activity": "linked",
                "last_activity_at": last_any,
                "ended_at": last_any,
            }
        return {
            "status": status,
            "activity": "linked",
            "last_activity_at": last_any,
            "ended_at": None,
        }

    async def refresh_linked(self, items: list[dict]) -> list[dict]:
        """Rederive liveness for every linked row in `items`, in place.

        There is no PTY exit to wait for, so the board read IS the poll: one
        query covers every linked row on the page, and the store is written
        only when something actually moved.
        """
        linked = [
            item
            for item in items
            if item.get("origin") == "linked" and item.get("archived_at") is None
        ]
        if not linked:
            return items
        session_ids = [item["session_id"] for item in linked if item.get("session_id")]
        seen = await self.store.session_activity(session_ids)
        for item in linked:
            state = self._linked_state(item, seen.get(item.get("session_id") or ""))
            changed = any(item.get(k) != v for k, v in state.items())
            item.update(state)
            if changed:
                await self.store.update_linked_state(item["id"], **state)
        return items

    def _on_exit_threadsafe(self, task_id: str, code: Optional[int]) -> None:
        if self._loop is None:
            return
        future = asyncio.run_coroutine_threadsafe(self._on_exit(task_id, code), self._loop)

        def _log_if_failed(fut: "asyncio.Future") -> None:
            exc = fut.exception()
            if exc is not None:
                logger.exception("_on_exit failed for task %s", task_id, exc_info=exc)

        future.add_done_callback(_log_if_failed)

    async def _on_exit(self, task_id: str, code: Optional[int]) -> None:
        self._running.discard(task_id)
        self._hook_tokens.pop(task_id, None)
        self._input_bytes.pop(task_id, None)
        # The audit trail is authoritative for finished tasks; the set is a cache.
        self._ungoverned.discard(task_id)
        await self.store.set_exit(task_id, code)
        await self.store.add_event(
            task_id, kind="exit", origin="process", detail=f"exit code {code}"
        )
        # Bound how many finished sessions the host keeps alive: each one
        # holds a ring buffer up to the host's ring capacity, so an
        # unbounded backlog of finished tasks is a slow memory leak. The
        # store row (and its audit trail) is untouched; only the host's
        # in-memory session (PTY ring buffer) is released.
        self._finished.append(task_id)
        while len(self._finished) > self._retain_finished:
            old_id = self._finished.popleft()
            try:
                # grace=0: forget() only terminates when session.alive is
                # still True, and _reader() always sets alive = False before
                # invoking on_exit (which is what appended old_id to
                # _finished in the first place) -- the terminate path is
                # unreachable here, so there is nothing to wait out.
                self.host.forget(old_id, grace=0)
            except Exception:
                logger.debug("failed to forget retired task %s", old_id, exc_info=True)

    async def stop(self, task_id: str, *, origin: str) -> None:
        task = await self.store.get_task(task_id)
        if task is not None and task.get("origin") == "linked":
            # There is no process here to signal: the harness belongs to the
            # user's own terminal. Saying so beats a Stop that silently
            # does nothing.
            raise NotLinkable("This session runs outside SecureVector")
        if task_id not in self._running:
            raise KeyError(task_id)
        # Audit the stop request before host.stop() runs: host.stop() can
        # trigger on_exit on the host's own thread, which races
        # run_coroutine_threadsafe against this coroutine's own next await.
        # Writing "stop" first keeps it ordered before "exit" regardless of
        # which of the two callbacks the loop happens to run first.
        await self.store.add_event(task_id, kind="stop", origin=origin)
        await asyncio.get_running_loop().run_in_executor(None, self.host.stop, task_id)

    async def stop_all(self, *, origin: str) -> None:
        for task_id in list(self._running):
            try:
                await self.stop(task_id, origin=origin)
            except KeyError:
                continue

    # -- hook events --------------------------------------------------------

    async def handle_hook_event(self, task_id: str, token: str, event: Mapping) -> bool:
        expected = self._hook_tokens.get(task_id)
        # A header value can carry non-ASCII bytes (Starlette decodes headers
        # as latin-1); encode explicitly rather than let compare_digest raise
        # TypeError, which would surface as a 500 instead of a false result.
        token_bytes = (token or "").encode("utf-8", "surrogateescape")
        if not expected or not secrets.compare_digest(token_bytes, expected.encode("utf-8")):
            return False
        session_id = event.get("session_id")
        if session_id:
            task = await self.store.get_task(task_id)
            if task and not task.get("session_id"):
                await self.store.set_session(task_id, str(session_id))
        status, activity = status_from_hook(event)
        if status is None:
            return True
        if activity:
            activity = redact_secrets(activity, "outgoing")[0]
        await self.store.update_status(task_id, status, activity=activity)
        await self.store.add_event(
            task_id,
            kind="hook",
            origin="hook",
            detail=f"{event.get('hook_event_name')} -> {status}",
        )
        return True

    # -- attached terminal ----------------------------------------------------

    def attach(self, task_id: str, loop: asyncio.AbstractEventLoop) -> Tuple[bytes, Subscriber]:
        return self.host.attach(task_id, loop)

    def detach(self, task_id: str, sub: Subscriber) -> None:
        self.host.detach(task_id, sub)

    def resize(self, task_id: str, rows: int, cols: int, *, first: bool) -> None:
        if first:
            # Two SIGWINCHs one column apart force full-screen programs to
            # repaint, so a reattached client sees the live screen, not just
            # the replayed tail.
            self.host.resize(task_id, rows, cols + 1)
        self.host.resize(task_id, rows, cols)

    async def input(self, task_id: str, data: bytes) -> None:
        """Keystrokes go to the PTY and nowhere else. The audit trail records
        that a line was submitted and how long it was, never its content."""
        self.host.write(task_id, data)
        self._input_bytes[task_id] = self._input_bytes.get(task_id, 0) + len(data)
        if b"\r" in data or b"\n" in data:
            n = self._input_bytes.pop(task_id, 0)
            await self.store.add_event(
                task_id, kind="input", origin="ui", detail=f"line submitted, {n} bytes"
            )
