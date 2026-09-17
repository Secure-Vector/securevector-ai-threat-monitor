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
from securevector.app.terminals.store import TerminalStore
from securevector.app.utils.redaction import redact_secrets

logger = logging.getLogger(__name__)


class GuardHooksMissing(RuntimeError):
    """The Claude Code Guard plugin is not installed; refuse to launch unhooked."""


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
                    f"Enable or reinstall the {guard_label} Guard plugin in "
                    "Integrations before launching a task."
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
        plugin_dir = None
        if executor_id == "claude-code":
            plugin_dir = self.settings.plugin_dir()
            if plugin_dir is None:
                raise GuardHooksMissing("Install the Claude Code Guard plugin before launching a task")
            # If the plugin is already enabled in the user's Claude settings,
            # do not pass --plugin-dir as well: the hooks would run twice.
            inject = None if self.settings.plugin_enabled() else plugin_dir
        else:
            gate, label = self._guard_gate(executor_id)
            if not gate():
                raise GuardHooksMissing(
                    f"Install and enable the {label} Guard plugin before launching a task"
                )
            inject = None
        task_id = uuid.uuid4().hex[:12]
        hook_token = secrets.token_hex(16)
        task_dir = Path(self.settings.data_dir) / "terminals" / "tasks" / task_id
        # ExecutorUnavailable / NotADirectoryError from build_launch propagate
        # unchanged — the routes layer maps them to HTTP statuses. Only
        # UnknownExecutor and GuardHooksMissing are raised by the manager
        # itself, before build_launch ever runs.
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
        task = await self.store.get_task(task_id)
        if task is None:
            raise RuntimeError(f"terminal task {task_id} vanished immediately after spawn")
        return task

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
