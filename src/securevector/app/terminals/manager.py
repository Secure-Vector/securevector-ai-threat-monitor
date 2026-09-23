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
from securevector.app.terminals.session_cwd import resolve_session_cwd, session_last_write
from securevector.app.terminals import live_runs
from securevector.app.terminals.store import (
    RUNNING,
    TerminalStore,
    _plausible_cwd,
    age_seconds,
    cwd_from_preview,
)
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

# How recently the Guard must have reported for a linked row's liveness to be
# called VERIFIED. The release gate asks for "unverified marking with a heartbeat timeout".
# The screen-manifest fallback that phrase was written for was never built, and
# is now moot: every harness that ships in 6.0.0 has hooks. The same hazard
# arrived by a different road though. A linked row's liveness can be derived
# from the transcript file's mtime when the audit trail has gone quiet, and a
# file mtime is not a governance signal: it says the harness is alive, not that
# anything is watching it. A row standing on that evidence is exactly the
# "unverified" case, and this is its heartbeat window.
#
# Deliberately longer than LINKED_WORKING_SECONDS: a session legitimately
# pauses for thought between tool calls, and flapping the badge every time
# someone reads a long file would teach people to ignore it.
GUARD_HEARTBEAT_SECONDS = 300

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
        # Linked task ids whose stored folder has already been offered one
        # repair attempt. The board polls every few seconds, so without this a
        # session whose transcript no longer exists would re-glob the harness
        # stores on every poll, forever.
        self._workspace_repaired: set = set()

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
            outside_hint = ""
            if executor.id == "claude-code":
                # Every Claude Code launch carries this host's additive
                # --settings relay, so a session launched here is governed
                # whether or not the plugin is registered with Claude Code.
                # The plugin answers a different question: it governs sessions
                # started OUTSIDE the app, which this host writes no argv for
                # and so cannot relay any other way.
                governed = True
                guard_label = executor.label
                if self.settings.plugin_dir() is None:
                    outside_hint = (
                        f"Sessions you start in your own terminal are not governed until the "
                        f"{guard_label} Guard plugin is installed."
                    )
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
                hint = outside_hint
            rows.append(
                {
                    "id": executor.id,
                    "label": executor.label,
                    "installed": installed,
                    "governed": governed,
                    # Whether the UI may offer "continue this session here".
                    # A harness without a resume-by-id flag never gets the
                    # offer, so the client does not hard-code harness ids.
                    "supports_resume": bool(executor.resume_argv),
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
        self,
        executor_id: str,
        workspace: str,
        *,
        title: Optional[str],
        origin: str,
        resume_session_id: Optional[str] = None,
    ) -> dict:
        """Start a governed task. With `resume_session_id` the harness reopens
        that conversation instead of starting a fresh one, which is the only
        way a session someone began in their own terminal can end up on a PTY
        this app owns: a live PTY cannot be handed between processes.
        """
        if executor_id not in EXECUTORS:
            raise UnknownExecutor(executor_id)
        if resume_session_id is not None:
            # The same shape the link path enforces, and for the same reason:
            # the id reaches argv, so it is never taken on trust. Validated
            # here rather than in build_launch so a bad id is refused before
            # any task directory or token exists.
            resume_session_id = resume_session_id.strip()
            if not SESSION_ID_RE.match(resume_session_id):
                raise ValueError(
                    "Session id must be 8 to 128 characters of letters, digits, dot, underscore, "
                    "colon, or dash."
                )
            # SESSION_ID_RE admits a leading dash, which is harmless in the
            # link path where the id only ever becomes a row value. Here it
            # becomes an argv word: `--resume` takes an OPTIONAL value, so an
            # id spelled "--dangerously-skip-permissions" would not be consumed
            # as the value at all and would be parsed as a flag of its own.
            if resume_session_id.startswith("-"):
                raise ValueError("Session id must not start with a dash.")
        # A launch is never refused for a missing Guard. It runs ungoverned,
        # writes a guard_missing event, and the session carries a banner until
        # the Guard reports in.
        plugin_dir = None
        inject = None
        if executor_id == "claude-code":
            plugin_dir = self.settings.plugin_dir()
            # A Claude Code LAUNCH is governed by the additive --settings relay
            # file this host writes for every one of them, not by the plugin.
            # The plugin is what governs a session someone starts in their own
            # terminal, where this host writes no argv at all. Deriving
            # `governed` from plugin registration marked every app-launched
            # session ungoverned whenever the plugin was not registered, which
            # is the exact case Agent Sessions exists to cover, and the relay
            # was demonstrably running the whole time.
            governed = True
            # If the plugin is registered but not yet enabled in the user's
            # Claude settings, pass it explicitly; if it is enabled already,
            # passing it as well would run the hooks twice.
            if plugin_dir is not None and not self.settings.plugin_enabled():
                inject = plugin_dir
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
            resume_session_id=resume_session_id,
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
        except Exception as exc:
            self._hook_tokens.pop(task_id, None)
            self._running.discard(task_id)
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
        # Metadata only, and never awaited on this path: a cloud that is slow
        # or gone must not hold up a local launch. No `detail` is passed, and
        # the emitter takes none: the audit detail above carries the working
        # folder, which is exactly what must not leave the machine. Reuses
        # the row just read (needed below for the return value anyway)
        # instead of a second store hit, and only schedules the emit at all
        # when something is listening: with no sink installed -- every
        # install today, since nothing calls `set_sink()` yet -- this would
        # otherwise be a task and a settings read spent purely to no-op.
        if live_runs.has_sink():
            live_runs.emit_nowait(task, "spawn", origin=origin)
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
        # A resume moves an existing harness session onto a PTY this host owns.
        # The linked row that offered the resume names the SAME session_id, so
        # leaving it on the board shows one session twice, once as a live
        # terminal and once as an outside session whose liveness can no longer
        # move. Retire it; the audit it collected is kept, as with any archive.
        if resume_session_id:
            await self._supersede_linked(task_id, resume_session_id, origin=origin)
        # Nothing between the read above and here touches this task's own
        # row (guard_missing and _supersede_linked write events, and the
        # latter mutates a DIFFERENT row); the row fetched for the emit is
        # still current.
        return task

    async def _supersede_linked(self, task_id: str, session_id: str, *, origin: str) -> None:
        """Take the linked row for `session_id` off the board now that this
        host owns a terminal for that same session.

        Only a linked row is retired: a previous LAUNCH of the same session is
        a process this host started and may still be running, and archiving it
        would hide a task that still needs stopping.
        """
        prior = await self.store.task_for_session(session_id)
        if prior is None or prior["id"] == task_id or prior.get("origin") != "linked":
            return
        await self.store.archive_task(prior["id"])
        await self.store.add_event(
            task_id,
            kind="adopted",
            origin=origin,
            detail=f"Continued from linked session {session_id}; the linked row was retired",
        )

    # -- linked sessions ----------------------------------------------------

    async def link_session(
        self,
        executor_id: str,
        session_id: str,
        *,
        workspace: Optional[str] = None,
        title: Optional[str] = None,
        origin: str = "ui",
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
                folder = await self._resolve_linked_workspace(executor_id, session_id)
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
                origin=origin,
                detail=f"Linked {label} session {session_id}",
            )
        task = await self.store.get_task(task_id)
        if task is None:
            raise RuntimeError(f"terminal task {task_id} vanished immediately after linking")
        return task

    async def _resolve_linked_workspace(self, executor_id: str, session_id: str) -> str:
        """The folder this session runs in, best source first.

        The harness's own transcript is asked first because it records the
        folder as a field: that is a fact, where the audit preview is a scrape
        of free text that has returned source code before now. The scrape
        stays as the fallback for harnesses that keep no JSONL transcript, and
        a folder neither source names is said plainly rather than guessed.
        """
        recorded = await self._recorded_session_cwd(executor_id, session_id)
        if recorded:
            return recorded
        try:
            rows = await self.store.list_verdicts(session_id, limit=50)
        except Exception:
            logger.debug("linked workspace lookup failed for %s", str(session_id).replace("\n", " ").replace("\r", " "), exc_info=True)
            return UNKNOWN_WORKSPACE
        for row in rows:
            found = cwd_from_preview(row.get("args_preview"))
            if found:
                return found
        return UNKNOWN_WORKSPACE

    async def _recorded_session_cwd(self, executor_id: str, session_id: str) -> Optional[str]:
        """What the harness's own transcript says, off the event loop.

        resolve_session_cwd globs and reads up to a quarter megabyte, which is
        blocking work, and this runs on a request path.
        """
        try:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(
                None, resolve_session_cwd, executor_id, session_id
            )
        except Exception:
            logger.debug("session cwd lookup failed for %s", str(session_id).replace("\n", " ").replace("\r", " "), exc_info=True)
            return None

    async def _repair_workspace(self, item: dict) -> None:
        """Correct one linked row whose stored folder is not a folder.

        Rows linked before the scrape was shape-checked hold whatever the
        preview happened to contain, source code included, and such a row can
        never be resumed or relaunched. Asking the transcript fixes it in
        place instead of needing a hand-written database update. One attempt
        per task per process (see _workspace_repaired), and any failure leaves
        the row exactly as it was: a listing must not fail over an
        enrichment.
        """
        task_id = item.get("id")
        session_id = item.get("session_id")
        if not task_id or not session_id or task_id in self._workspace_repaired:
            return
        if _plausible_cwd(str(item.get("workspace") or "")) is not None:
            return
        self._workspace_repaired.add(task_id)
        try:
            found = await self._recorded_session_cwd(
                str(item.get("executor_id") or ""), str(session_id)
            )
            if found:
                await self.store.update_workspace(task_id, found)
                item["workspace"] = found
        except Exception:
            logger.debug("workspace repair failed for task %s", task_id, exc_info=True)

    async def unlinked_sessions(self) -> list[dict]:
        """Recent Guard-reported sessions with no task of their own."""
        rows = await self.store.unlinked_sessions()
        for row in rows:
            executor = EXECUTORS.get(row["executor_id"])
            row["label"] = executor.label if executor else row["executor_id"]
        return rows

    def _transcript_age(self, task: Mapping) -> Optional[float]:
        """Seconds since the harness last wrote this session's transcript.

        Best effort and never fatal to a board read: a missing or unreadable
        transcript is simply no signal, exactly as the folder lookup treats it.
        """
        session_id = task.get("session_id")
        if not session_id:
            return None
        try:
            return session_last_write(str(task.get("executor_id") or ""), str(session_id))
        except Exception:
            logger.debug("transcript age failed for task %s", task.get("id"), exc_info=True)
            return None

    def _linked_state(self, task: Mapping, seen: Optional[Mapping]) -> dict:
        """Derive (status, activity, last_activity_at, ended_at) for one
        linked row from what its session has reported."""
        last_any = (seen or {}).get("last_any")
        last_call = (seen or {}).get("last_call")
        last_end = (seen or {}).get("last_end")
        # The harness writes its own transcript whether or not a Guard is
        # relaying, so this sees a live session the audit trail cannot: with
        # the plugin unregistered the audit never moves and a running session
        # would otherwise age into idle and then into done.
        writing = self._transcript_age(task)
        if not last_any:
            # Linked, but the Guard has never reported. The session may have
            # no Guard yet, so this never resolves to done on its own: only a
            # reported session end, or the user removing the row, ends it.
            if writing is not None and writing < LINKED_WORKING_SECONDS:
                return {
                    "status": "working",
                    "activity": "linked, writing its transcript",
                    "last_activity_at": task.get("last_activity_at"),
                    "ended_at": None,
                }
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
        # A reported end wins over a fresh transcript: `claude --resume` on an
        # ended session appends to that same file, so mtime alone would revive
        # a row whose session really did finish.
        if writing is not None and not ended_by_session:
            age = min(age, writing)
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
            # Same pass, not a second one: the rows are already in hand here.
            await self._repair_workspace(item)
            state = self._linked_state(item, seen.get(item.get("session_id") or ""))
            changed = any(item.get(k) != v for k, v in state.items())
            item.update(state)
            # Derived, never stored: it is a fact about a file on disk right
            # now, so persisting it would age into a lie the moment it is read
            # back. Kept off `state` for that reason, and because
            # update_linked_state writes exactly the four columns state names.
            item["transcript_age_seconds"] = self._transcript_age(item)
            item.update(
                self._verification(item, seen.get(item.get("session_id") or ""))
            )
            if changed:
                await self.store.update_linked_state(item["id"], **state)
        return items

    def _verification(self, task: dict, seen: Optional[dict]) -> dict:
        """Is this row's liveness backed by governance, or only by a file?

        Derived on every read, never stored, for the same reason
        `transcript_age_seconds` is: it is a statement about the last few
        minutes, and a stored copy would age into a false claim.

        Three outcomes:
          verified   the Guard reported inside the heartbeat window, so what
                     the row says about this session is backed by governed
                     calls.
          unverified the row is standing on the transcript file's mtime, or on
                     a Guard that has gone quiet past the window. The session
                     may be perfectly healthy; what is missing is anyone
                     watching it. This is the state that must never look the
                     same as "quiet".
          n/a        the session has ended. Nothing is being claimed about now,
                     so there is nothing to verify, and a badge here would be
                     noise on every finished row.
        """
        # RUNNING is the store's own list of live statuses; anything else has
        # ended, and an ended row claims nothing about now.
        if task.get("status") not in RUNNING:
            return {"verified": None, "verified_reason": ""}
        last_call = (seen or {}).get("last_call")
        age = age_seconds(last_call) if last_call else None
        if age is not None and age <= GUARD_HEARTBEAT_SECONDS:
            return {"verified": True, "verified_reason": "the Guard reported recently"}
        if last_call is None:
            return {
                "verified": False,
                # "never reported" and "stopped reporting" are different
                # situations and lead somewhere different: the first is
                # usually a Guard that was never installed, the second a
                # session that went away. The copy has to tell them apart.
                "verified_reason": "the Guard has never reported a call for this session",
            }
        return {
            "verified": False,
            "verified_reason": (
                "the Guard has not reported for over "
                f"{int(GUARD_HEARTBEAT_SECONDS // 60)} minutes"
            ),
        }

    def _on_exit_threadsafe(self, task_id: str, code: Optional[int]) -> None:
        if self._loop is None:
            return
        future = asyncio.run_coroutine_threadsafe(self._on_exit(task_id, code), self._loop)

        def _log_if_failed(fut: "asyncio.Future") -> None:
            # Cancelled at loop shutdown: nothing failed, and .exception()
            # would raise CancelledError from inside the callback.
            if fut.cancelled():
                return
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
        # Before host.stop(), matching the ordering above: the stop is recorded
        # while the row still reads as running, so an exit cannot race it.
        # `task`, fetched above, is that same still-running row: add_event()
        # only appends to the audit trail, it does not touch terminal_tasks,
        # so re-reading here would return identical data at the cost of a
        # second store hit. Only bother scheduling it when something is
        # listening (see the spawn-path comment for why that matters today).
        if live_runs.has_sink():
            live_runs.emit_nowait(task, "stop", origin=origin)
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
