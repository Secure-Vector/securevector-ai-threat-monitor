"""TerminalManager: executors + PtyHost + store + hook events, one object.

Status semantics (from the harness's own hooks, never guessed from output):
  blocked  = a permission prompt is waiting on the human
  working  = tool activity since the last idle
  idle     = Stop event (turn finished, waiting for input)
  done / failed = process exit (code 0 / non-zero)
  stopped = the app signalled the process (user Stop) and it died of that
            signal (SIGTERM/SIGINT/SIGHUP/SIGKILL, 143/130/129/137 or -N)
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
import time
import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Mapping, Optional, Tuple

from securevector.app.terminals.executors import EXECUTORS, UnknownExecutor, build_launch
from securevector.app.terminals.pty_host import PtyHost, Subscriber
from securevector.app.terminals.session_cwd import resolve_session_cwd, session_last_write
from securevector.app.terminals import live_runs
from securevector.app.terminals import worktree as worktrees
from securevector.app.services import session_drift
from securevector.app.terminals.store import (
    RUNNING,
    SESSION_RELINKED,
    TerminalStore,
    _plausible_cwd,
    age_seconds,
    cwd_from_preview,
)
from securevector.app.utils.redaction import redact_secrets

logger = logging.getLogger(__name__)

# Exit codes a process reports when it dies of (or exits on) a stop signal:
# shell-style 128+N from a harness that traps it, or -N from the PTY host when
# the signal killed it. SIGHUP covers the PTY closing, SIGKILL the host's
# escalation after its grace period.
# How far a harness's start may sit from its task row's created_at for the
# startup reaper to treat the pid as that task's (spawn and the row write
# happen moments apart).
_REAP_START_WINDOW_S = 120


def _process_start(pid: int) -> Optional[float]:
    """Epoch seconds a process started, from ps, or None."""
    try:
        text = subprocess.run(["ps", "-o", "lstart=", "-p", str(int(pid))], capture_output=True,
                              text=True, timeout=2, env={**os.environ, "LC_ALL": "C"}).stdout.strip()
        return time.mktime(time.strptime(" ".join(text.split()), "%a %b %d %H:%M:%S %Y"))
    except Exception:  # noqa: BLE001
        return None


def _started_near(pid: int, created_at: Optional[str]) -> bool:
    if not created_at:
        return False
    try:
        created = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
    except ValueError:
        return False
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    started = _process_start(pid)
    return started is not None and abs(started - created.timestamp()) <= _REAP_START_WINDOW_S


def _stop_signal_exits(sig_module=signal) -> frozenset:
    # getattr: Windows has no SIGHUP or SIGKILL, and importing must not fail there.
    sigs = (getattr(sig_module, n, None) for n in ("SIGHUP", "SIGINT", "SIGKILL", "SIGTERM"))
    return frozenset(
        code for sig in sigs if sig is not None for code in (128 + int(sig), -int(sig))
    )


_STOP_SIGNAL_EXITS = _stop_signal_exits()

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


# terminal_events.kind on a linked task whose folder came only from an audit
# preview (the agent's own report, possibly a tool argument), so it is shown
# as reported and never used to resume until a person names the folder.
FOLDER_REPORTED = "folder_reported"
# Linked harnesses whose folder this app can only scrape from audit previews.
FOLDER_FROM_PREVIEW_ONLY = frozenset({"govrun", "hermes", "openclaw"})


# A board read refreshes a stopped task's worktree counts at most this often.
WORKTREE_REFRESH_S = 10.0


# Overall cap on one heartbeat tick's detection and response reads.
HEARTBEAT_ADR_BUDGET_SECONDS = 3.0

class GuardHooksMissing(RuntimeError):
    """Kept for the routes/tests import surface. A missing Guard no longer
    refuses a launch: the task runs ungoverned and says so, so nothing raises
    this any more."""


class SessionAlreadyLinked(RuntimeError):
    """This harness session already has a live task on the board."""


# Delegated prompt delivery: how often the child's screen is looked at,
# how long a dialog waiting for the person may hold the prompt, and what
# counts as a drawn, still screen for a harness with no ready hook.
PROMPT_POLL_S = 0.25
WAITING_TIMEOUT_S = 600.0
QUIET_MIN_BYTES = 2048
QUIET_SECONDS = 1.5
# A delegated child of a ready-hook harness whose screen has settled at its
# input with no SessionStart this long after: its Guard is not running there,
# so the delegation ends and nothing is typed.
HOOKS_SILENT_S = 20.0
# After a delegated prompt is delivered, or a launched session's first line
# is submitted, its Guard should report a hook (SessionStart,
# UserPromptSubmit or PreToolUse) within this many seconds.
GUARD_REPORT_S = 30.0
# A harness whose Guard reports only once a message is submitted (OpenCode's
# session.created) reports within a few seconds of a paste it took. No hook
# this long after a quiet paste: the prompt is sent once more, and the Guard
# check runs its full GUARD_REPORT_S from that second send.
PROMPT_RESUBMIT_S = 10.0
# More output than this after the paste means the session is working, so it
# is never sent a second time.
RESUBMIT_BUSY_BYTES = 8192
# Full-screen resets: screen bytes before the last one are no longer shown.
_SCREEN_RESETS = (b"\x1b[2J", b"\x1b[?1049h", b"\x1bc")


class FolderOutOfScope(RuntimeError):
    """A delegated launch whose folder no longer passes its scope check."""


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
    # Agent Config Trust setup checks at start, on SessionStart and at exit.
    # Off unless the app turns it on, so a bare manager never scans a home.
    config_trust: bool = False


def status_from_hook(event: Mapping) -> Tuple[Optional[str], Optional[str]]:
    """Map a relayed hook payload to (status, activity). None = no change."""
    name = event.get("hook_event_name")
    if name in ("PreToolUse", "PostToolUse", "PostToolUseFailure"):
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
        # Tasks the app itself asked to stop. Only these may read a signal
        # exit as "stopped"; any other signal death stays "failed".
        self._stop_requested: set[str] = set()
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
        # Last status sent to Live Runs per task, so a hook that repeats the
        # current status does not send a second event for it.
        self._live_status: dict = {}
        self._heartbeat: Optional["asyncio.Task"] = None
        # Delegation: a prompt waiting for its child's first SessionStart or
        # idle hook (task_id -> text), the fallback timers that deliver it
        # anyway, and the child task ids this process launched by delegation.
        self._pending_prompts: dict = {}
        self._prompt_timers: dict = {}
        self._delegated: set = set()
        # Delegated tasks whose ready hook arrived while a dialog waiting for
        # the person was on screen; their prompt goes once it is answered.
        self._hook_seen: set = set()
        # Tasks whose Guard sent no hook after their first prompt: task id
        # -> the card warning. Cleared by the next hook event.
        self._guard_silent: dict = {}
        # Delegated prompts that may be sent once more if their paste brings
        # no hook (executors with prompt_resubmit): task id -> text.
        self._resubmit: dict = {}
        self._input_checked: set = set()
        # Worktree claims: task id -> worktree root it runs in, taken under
        # _wt_lock at spawn and checked by removal under the same lock, so a
        # relaunch or delegation cannot start in a worktree being removed.
        self._wt_claims: dict = {}
        self._wt_lock: Optional[asyncio.Lock] = None
        # Last fresh count read per task (monotonic seconds), for GET reads.
        self._wt_refreshed: dict = {}
        self._wt_refresh_sem: Optional[asyncio.Semaphore] = None
        worktrees.configure(settings.data_dir)

    # -- lifecycle ----------------------------------------------------------

    async def start(self, loop: asyncio.AbstractEventLoop) -> None:
        """Bind the event loop, then restore the board: anything still marked
        running belonged to a previous process and is now interrupted."""
        self._loop = loop
        await self.store.mark_running_interrupted()
        # Select the work by state, not by what this call just marked: if an
        # earlier start failed part way (add_event raised), its remaining
        # tasks are already interrupted but have no event and were not
        # reaped, and this retry finishes them.
        interrupted = await self.store.interrupted_without_event()
        for task in interrupted:
            await self.store.add_event(
                task["id"],
                kind="interrupted",
                origin="startup",
                detail="app restarted while the task was running",
            )
            if live_runs.has_sink():
                live_runs.emit_nowait(task, "interrupted", origin="startup")
            # _reap does blocking os.kill / subprocess.run(timeout=2); keep it
            # off the event loop.
            await loop.run_in_executor(None, self._reap, task)
        await self._sweep_worktrees(loop)
        if live_runs.has_sink():
            self.start_heartbeat()

    async def _sweep_worktrees(self, loop: asyncio.AbstractEventLoop) -> None:
        """A worktree left 'active' by a process that is gone is kept, never
        deleted. Paths are registered for source_for, and git's bookkeeping
        is pruned only in repositories that have a removed task worktree."""
        try:
            await self.store.mark_active_worktrees_kept()
            for row in await self.store.worktree_tasks((worktrees.ACTIVE, worktrees.KEPT)):
                paths = self._worktree_paths(row)
                if paths is not None:
                    worktrees.register(*paths)
            sources = set()
            for row in await self.store.worktree_tasks((worktrees.REMOVED,)):
                paths = self._worktree_paths(row)
                if paths is not None:
                    sources.add(paths[1])
            for source_root in sources:
                await loop.run_in_executor(None, worktrees.prune, source_root)
        except Exception:
            logger.warning("worktree startup sweep failed", exc_info=True)

    # -- Live Runs heartbeat --------------------------------------------------

    def start_heartbeat(self, interval: Optional[float] = None) -> None:
        """Start the single heartbeat loop if it is not already running."""
        if self._heartbeat is not None and not self._heartbeat.done():
            return
        period = live_runs.HEARTBEAT_SECONDS if interval is None else interval
        self._heartbeat = asyncio.get_running_loop().create_task(
            self._heartbeat_loop(period), name="live-runs-heartbeat"
        )

    async def stop_heartbeat(self) -> None:
        """Cancel the heartbeat loop and wait for it to finish."""
        handle, self._heartbeat = self._heartbeat, None
        if handle is None or handle.done():
            return
        handle.cancel()
        try:
            await handle
        except asyncio.CancelledError:
            pass

    async def _heartbeat_loop(self, period: float) -> None:
        """Re-announce every task this process is running, once per period.

        Only launched tasks this process owns: a linked session's liveness
        is derived from its audit trail, not from a process held here.
        Never raises out of a tick, so one bad read does not end the loop.
        """
        while True:
            await asyncio.sleep(period)
            if not live_runs.has_sink() or not self._running:
                continue
            # One enrollment check per tick: an install that is not enrolled
            # pays one small read a minute and schedules nothing.
            if not await live_runs.fleet_enrolled():
                continue
            await self._heartbeat_tick()

    async def _heartbeat_tick(self) -> None:
        """One beat for every running task. The metadata reads run
        concurrently, each capped by the collector and all of them by
        HEARTBEAT_ADR_BUDGET_SECONDS; a task that misses the budget beats
        without the fields. Never raises."""
        stamp = datetime.now(timezone.utc)
        # Device-wide, so read once per tick rather than once per task.
        mods = await live_runs.unmanaged_mod_count(self.store.db)

        async def one(task_id: str):
            try:
                task = await self.store.get_task(task_id)
            except Exception:
                logger.debug("heartbeat read failed for %s", task_id, exc_info=True)
                return None
            if task is None or task.get("archived_at") is not None:
                return None
            box["tasks"][task_id] = task
            box["adr"][task_id] = await live_runs.collect_adr(task, self.store.db, mods_unmanaged=mods)
            return task_id

        box: dict = {"tasks": {}, "adr": {}}
        ids = list(self._running)
        try:
            await asyncio.wait_for(
                asyncio.gather(*(one(t) for t in ids), return_exceptions=True),
                HEARTBEAT_ADR_BUDGET_SECONDS,
            )
        except Exception:
            logger.debug("heartbeat metadata budget exceeded", exc_info=True)
        if not live_runs.has_sink():
            return
        for task_id in ids:
            task = box["tasks"].get(task_id)
            if task is not None:
                live_runs.emit_nowait(task, "heartbeat", adr=box["adr"].get(task_id, {}), now=stamp)

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
        # A process that did not start when the task did is a later process
        # on a reused pid: leave it alone.
        if not _started_near(pid, task.get("created_at")):
            logger.info("Startup reaper left pid %s alone: it is not task %s", pid, task.get("id"))
            return
        try:
            # The harness was spawned as its own group leader: signal the
            # group so its children go too, unless it is this app's own group.
            if os.getpgid(pid) == pid and pid != os.getpgrp():
                os.killpg(pid, signal.SIGTERM)
            else:
                os.kill(pid, signal.SIGTERM)
            logger.info("Reaped orphaned task %s (pid %s)", task["id"], pid)
        except OSError:
            pass

    # Executors whose Guard can relay a launched task's hook events. The rest
    # (GovRun, Hermes, OpenClaw) have no gate below: a launch of one is
    # ungoverned whatever their Guard's install state, because a gate that
    # opened on "plugin installed" would mark a task governed that no hook
    # ever reaches, and its card would then read as a silent Guard.
    _RELAY_GATED = frozenset({"claude-code", "codex", "copilot-cli", "opencode"})

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
            elif not governed and executor.id not in self._RELAY_GATED:
                # GovRun, Hermes and OpenClaw: their Guard writes the audit
                # trail, but nothing relays this app's per-task hook events,
                # so "install the Guard" would be advice that cannot help.
                hint = (
                    f"Tasks launched here show as ungoverned: the {executor.label} "
                    "Guard records tool calls but does not report to a task the "
                    "app started. Sessions it reports can be linked from "
                    "Running outside SecureVector."
                )
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
                    # False when no Guard can relay a launched task's hooks,
                    # so the UI offers no Guard install that could not help.
                    "guard_relay": executor.id in self._RELAY_GATED,
                    "hint": hint,
                }
            )
        return rows

    def would_be_governed(self, executor_id: str) -> bool:
        """The same governed/ungoverned decision spawn makes for a launch of
        this executor."""
        if executor_id not in EXECUTORS:
            return False
        if executor_id == "claude-code":
            return True
        gate, _label = self._guard_gate(executor_id)
        return bool(gate())

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
        parent_task_id: Optional[str] = None,
        folder_check: Optional[Callable[[str], bool]] = None,
        initial_prompt: Optional[str] = None,
        worktree: bool = False,
        from_task_id: Optional[str] = None,
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
            # A folder scraped from an audit preview may be a tool argument,
            # not where the session runs. It is never used as a launch folder
            # until a person names it: relinking with an explicit folder does.
            linked = await self.store.task_for_session(resume_session_id)
            if linked is not None and await self.store.tasks_with_event(
                FOLDER_REPORTED, [linked["id"]]
            ):
                raise ValueError(
                    "This session's folder was reported by the agent, not confirmed. "
                    "Unlink it, then link it again with its folder: sv-monitor session link "
                    f"{linked.get('executor_id')} <session> --folder <path>"
                )
            # A resumed delegated session stays a child of its parent.
            if parent_task_id is None:
                parent_task_id = await self.store.parent_for_session(resume_session_id)
        # A relaunch of a row whose folder only the agent reported would start
        # a harness in a folder no person named, the same hazard as resume.
        if from_task_id and await self.store.tasks_with_event(FOLDER_REPORTED, [from_task_id]):
            prior = await self.store.get_task(from_task_id)
            raise ValueError(
                "This session's folder was reported by the agent, not confirmed. "
                "Unlink it, then link it again with its folder: sv-monitor session link "
                f"{(prior or {}).get('executor_id')} <session> --folder <path>"
            )
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
        # In an executor: build_launch may probe the harness binary
        # (`--help`, cached per build), which must not stall the event loop.
        launch = await asyncio.get_running_loop().run_in_executor(None, lambda: build_launch(
            executor_id,
            workspace=Path(workspace),
            task_dir=task_dir,
            port=self.settings.port,
            task_id=task_id,
            hook_token=hook_token,
            parent_env=self.settings.parent_env,
            plugin_dir=inject,
            resume_session_id=resume_session_id,
            initial_prompt=initial_prompt,
        ))
        # Worktree isolation: the process runs in the worktree, every record
        # keeps the source folder. A relaunch or resume reuses the earlier
        # task's worktree when it still exists.
        source_cwd = str(launch.cwd)
        created_wt: Optional[worktrees.Created] = None
        child_dir: Optional[str] = None
        async with self._worktree_lock():
            reused = await self._reusable_worktree(from_task_id, resume_session_id, source_cwd)
            if parent_task_id is not None and reused is None and not worktree:
                # A child of a worktree task runs in the parent's worktree, never
                # in the person's source folder. Refused when that worktree is gone.
                parent_row = await self.store.get_task(parent_task_id)
                child_dir = self.child_run_dir(parent_row, source_cwd)
                if child_dir is not None:
                    self._wt_claims[task_id] = self._worktree_paths(parent_row)[0]
            if reused is not None:
                self._wt_claims[task_id] = reused["_root"]
        if reused is None and worktree:
            created_wt = await asyncio.get_running_loop().run_in_executor(
                None, worktrees.create, source_cwd, task_dir, task_id
            )
        if created_wt is not None:
            self._wt_claims[task_id] = os.path.realpath(created_wt.root)
        if reused is not None:
            launch = replace(launch, cwd=reused["run_dir"])
        elif created_wt is not None:
            launch = replace(launch, cwd=created_wt.run_dir)
        elif child_dir is not None:
            launch = replace(launch, cwd=child_dir)
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
            if parent_task_id is not None:
                await self.store.create_task(
                    task_id, executor_id=executor_id, workspace=source_cwd, title=title, pid=None,
                    parent_task_id=parent_task_id,
                )
                self._delegated.add(task_id)
            else:
                await self.store.create_task(
                    task_id, executor_id=executor_id, workspace=source_cwd, title=title, pid=None
                )
            created = True
            if created_wt is not None:
                await self.store.set_worktree(
                    task_id, run_dir=created_wt.run_dir, branch=created_wt.branch,
                    base=created_wt.base, state=worktrees.ACTIVE,
                )
            elif reused is not None:
                await self.store.set_worktree(
                    task_id, run_dir=reused["run_dir"], branch=reused["worktree_branch"],
                    base=reused["worktree_base"], state=worktrees.ACTIVE,
                )
                await self.store.set_worktree_state(task_id, worktrees.ACTIVE)
            elif child_dir is not None:
                # Shown by the UI; no branch, so this row can never remove it.
                await self.store.set_run_dir(task_id, child_dir)
            # A delegated launch re-checks its folder scope right before the
            # process starts, so the folder that runs is the folder approved.
            if parent_task_id is not None and folder_check is not None and not folder_check(source_cwd):
                raise FolderOutOfScope("The folder is no longer inside the approved scope.")
            # Also mark running before spawn, for the same reason: if on_exit
            # fires before this line would otherwise run, _on_exit's discard
            # must not be a no-op followed by a stale add.
            if child_dir is not None:
                # Re-checked right before the start: the path must still
                # resolve to itself inside the parent's worktree.
                claimed = self._wt_claims.get(task_id)
                if (not claimed or os.path.realpath(child_dir) != child_dir
                        or not worktrees.inside_real(child_dir, claimed)):
                    raise worktrees.WorktreeError(
                        "That folder leaves the requesting task's worktree through a link.")
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
            self._wt_claims.pop(task_id, None)
            if created_wt is not None:
                # Only what this spawn just created: its worktree and branch.
                await asyncio.get_running_loop().run_in_executor(
                    None, worktrees.discard, created_wt.source_root, created_wt.root, created_wt.branch
                )
                if created:
                    await self.store.set_worktree_state(task_id, worktrees.REMOVED)
            elif reused is not None and created:
                await self.store.set_worktree_state(task_id, worktrees.KEPT)
            if created:
                await self.store.set_exit(task_id, None)
            detail = redact_secrets(f"{type(exc).__name__}: {exc}", "outgoing")[0]
            await self.store.add_event(task_id, kind="spawn_failed", origin=origin, detail=detail)
            raise
        await self.store.update_pid(task_id, info.pid)
        await self.store.add_event(
            task_id, kind="spawn", origin=origin, detail=f"{executor_id} in {source_cwd}"
        )
        if created_wt is not None:
            copied = f"; copied {', '.join(created_wt.copied)}" if created_wt.copied else ""
            await self.store.add_event(
                task_id, kind="worktree", origin=origin,
                detail=f"Running in worktree {created_wt.branch} from {created_wt.base[:12]}{copied}",
            )
        elif reused is not None:
            await self.store.add_event(
                task_id, kind="worktree", origin=origin,
                detail=f"Reusing worktree {reused['worktree_branch']}",
            )
        if initial_prompt is not None:
            import hashlib

            data = initial_prompt.encode("utf-8")
            await self.store.add_event(
                task_id, kind="delegate_prompt", origin="delegate",
                detail=f"sha256={hashlib.sha256(data).hexdigest()} length={len(data)} trigger=argv",
            )
        task = await self.store.get_task(task_id)
        if task is None:
            raise RuntimeError(f"terminal task {task_id} vanished immediately after spawn")
        self._config_check(task_id, executor_id, source_cwd, "start")
        # Metadata only, and never awaited on this path: a cloud that is slow
        # or gone must not hold up a local launch. No `detail` is passed, and
        # the emitter takes none: the audit detail above carries the working
        # folder, which is exactly what must not leave the machine. Reuses
        # the row just read (needed below for the return value anyway)
        # instead of a second store hit, and only schedules the emit at all
        # when something is listening: with no sink installed (any process
        # that did not start the app, tests included) this would otherwise
        # be a task and a settings read spent purely to no-op.
        if live_runs.has_sink():
            self._live_status[task_id] = task.get("status")
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
                    if executor_id in self._RELAY_GATED
                    else f"Launched ungoverned: the {EXECUTORS[executor_id].label} "
                    "Guard does not report to a task the app started"
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
        if await self.store.archive_task(prior["id"]):
            await self._emit_archived(prior["id"], origin=origin)
        await self.store.add_event(
            task_id,
            kind="adopted",
            origin=origin,
            detail=f"Continued from linked session {session_id}; the linked row was retired",
        )

    async def archive_task(self, task_id: str, *, origin: str = "ui") -> bool:
        """Take a finished task off the board (the store keeps its audit)."""
        archived = await self.store.archive_task(task_id)
        if archived:
            await self._close_approvals(task_id, "archived")
            await self._revoke_host_grants(task_id)
            await self._emit_archived(task_id, origin=origin)
        return archived

    async def _close_approvals(self, task_id: str, reason: str) -> None:
        """Approvals still waiting for a stopped or removed task close as no
        longer needed, for its current session and every earlier one."""
        try:
            from securevector.app.services import response_rungs

            task = await self.store.get_task(task_id)
            # A linked row can be archived while its session still runs:
            # archiving stops nothing, so its approvals stay open.
            if not task or task.get("status") in RUNNING:
                return
            sids = [task.get("session_id")] + await self.store.session_history(task_id)
            closable = []
            for sid in dict.fromkeys(s for s in sids if s):
                # A resumed task shares the session id; while it runs, the
                # session is live and its approvals are its own.
                others = await self.store.tasks_claiming_session(sid, exclude_task_id=task_id)
                if any(o.get("status") in RUNNING for o in others):
                    continue
                closable.append(sid)
            if not closable:
                return
            await response_rungs.close_pending_for_task(
                self.store.db, {**task, "session_id": closable[0]}, reason=reason,
                extra_session_ids=closable[1:],
            )
        except Exception:
            logger.debug("could not close approvals for an ended task", exc_info=True)

    async def _revoke_host_grants(self, task_id: str) -> None:
        """A task's egress host grants end with it: its current session and
        every session it held before a re-link. Best effort; the 24h cap on
        the grant rows remains the backstop."""
        try:
            from securevector.app.database.repositories.jit_access import (
                JitAccessRepository,
            )

            task = await self.store.get_task(task_id)
            sids = [task.get("session_id")] if task else []
            sids += await self.store.session_history(task_id)
            n = await JitAccessRepository(self.store.db).revoke_session_host_grants(sids)
            if n:
                logger.info("revoked %d egress host grant(s) for an ended task", n)
        except Exception:
            logger.debug("could not revoke host grants for an ended task", exc_info=True)

    async def _emit_archived(self, task_id: str, *, origin: str) -> None:
        self._live_status.pop(task_id, None)
        if not live_runs.has_sink():
            return
        try:
            task = await self.store.get_task(task_id)
        except Exception:
            return
        live_runs.emit_nowait(task, "archived", origin=origin)

    # -- linked sessions ----------------------------------------------------

    async def link_session(
        self,
        executor_id: str,
        session_id: str,
        *,
        workspace: Optional[str] = None,
        title: Optional[str] = None,
        origin: str = "ui",
        folder_confirmed: bool = False,
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
            reported = False
            if executor_id in FOLDER_FROM_PREVIEW_ONLY and not folder_confirmed:
                # These harnesses keep no transcript this app reads, so the
                # only folder on offer is the audit preview scrape. A folder
                # equal to it (the board pre-fills it) is still the agent's
                # report, not a person's.
                scraped = await self._resolve_linked_workspace(executor_id, session_id)
                if not folder:
                    folder = scraped
                reported = scraped != UNKNOWN_WORKSPACE and folder == scraped
            if not folder:
                folder = await self._resolve_linked_workspace(executor_id, session_id)
            folder = worktrees.source_for(folder)
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
            if reported:
                await self.store.add_event(
                    task_id, kind=FOLDER_REPORTED, origin=origin, detail=folder
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
            found = await loop.run_in_executor(
                None, resolve_session_cwd, executor_id, session_id
            )
            return worktrees.source_for(found)
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
        self._wt_claims.pop(task_id, None)
        self._wt_refreshed.pop(task_id, None)
        self._hook_tokens.pop(task_id, None)
        self._input_bytes.pop(task_id, None)
        # The audit trail is authoritative for finished tasks; the set is a cache.
        self._ungoverned.discard(task_id)
        self._guard_silent.pop(task_id, None)
        self._input_checked.discard(task_id)
        stop_requested = task_id in self._stop_requested
        self._stop_requested.discard(task_id)
        self._pending_prompts.pop(task_id, None)
        self._resubmit.pop(task_id, None)
        self._hook_seen.discard(task_id)
        timer = self._prompt_timers.pop(task_id, None)
        if timer is not None:
            timer.cancel()
        # Detection and response metadata for the exit event is read before
        # the task is marked ended (bounded by the collector's timeout), so
        # nothing that follows the exit, such as an archive, can overtake it.
        # The values reflect state at send time.
        adr = None
        # Stamped before the read, so an archive that lands meanwhile still
        # carries the later emitted_at.
        stamp = datetime.now(timezone.utc)
        if live_runs.has_sink():
            try:
                adr = await live_runs.collect_adr(await self.store.get_task(task_id) or {}, self.store.db)
            except Exception:
                adr = None
        await self.store.set_exit(
            task_id, code, stopped=stop_requested and code in _STOP_SIGNAL_EXITS
        )
        await self.store.add_event(
            task_id, kind="exit", origin="process", detail=f"exit code {code}"
        )
        if live_runs.has_sink():
            try:
                exited = await self.store.get_task(task_id)
            except Exception:
                exited = None
            if exited is not None and exited.get("archived_at") is None:
                live_runs.emit_nowait(exited, "exit", origin="process", adr=adr, now=stamp)
        await self._close_approvals(task_id, "ended")
        await self._revoke_host_grants(task_id)
        # A parent that exits takes the tasks it delegated with it.
        try:
            await self._stop_children(task_id, origin="process")
        except Exception:
            logger.warning("stopping delegated tasks failed for %s", task_id)
        # Score the session once at exit, in the background. Observe only: it
        # writes a session_drift row and never touches this exit path.
        session_drift.schedule_for_task(self.store.db, task_id)
        if self.settings.config_trust:
            exited_task = await self.store.get_task(task_id)
            if exited_task:
                self._config_check(task_id, exited_task.get("executor_id"), exited_task.get("workspace"),
                                   "exit", exited_task.get("session_id"))
        await self._worktree_ended(task_id)
        self._live_status.pop(task_id, None)
        self._notify_delegation(task_id)
        try:
            from securevector.app.services import delegation

            delegation.forget_task(task_id)
        except Exception:
            logger.debug("delegation cleanup failed for %s", task_id, exc_info=True)
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

    async def stop(self, task_id: str, *, origin: str, detail: Optional[str] = None) -> None:
        task = await self.store.get_task(task_id)
        if task is not None and task.get("origin") == "linked":
            # There is no process here to signal: the harness belongs to the
            # user's own terminal. Saying so beats a Stop that silently
            # does nothing.
            raise NotLinkable("This session runs outside SecureVector")
        if task_id not in self._running:
            raise KeyError(task_id)
        # A parent's stop also stops the tasks it delegated that still run.
        await self._stop_children(task_id, origin=origin)
        # Audit the stop request before host.stop() runs: host.stop() can
        # trigger on_exit on the host's own thread, which races
        # run_coroutine_threadsafe against this coroutine's own next await.
        # Writing "stop" first keeps it ordered before "exit" regardless of
        # which of the two callbacks the loop happens to run first.
        # Marked before any await, so an exit that races the audit write
        # below still reads as the user's stop.
        self._stop_requested.add(task_id)
        await self.store.add_event(task_id, kind="stop", origin=origin, detail=detail)
        # Before host.stop(), matching the ordering above: the stop is recorded
        # while the row still reads as running, so an exit cannot race it.
        # `task`, fetched above, is that same still-running row: add_event()
        # only appends to the audit trail, it does not touch terminal_tasks,
        # so re-reading here would return identical data at the cost of a
        # second store hit. Only bother scheduling it when something is
        # listening (see the spawn-path comment for why that matters).
        if live_runs.has_sink():
            live_runs.emit_nowait(task, "stop", origin=origin)
        try:
            await asyncio.get_running_loop().run_in_executor(None, self.host.stop, task_id)
        except BaseException:
            self._stop_requested.discard(task_id)
            raise

    async def _stop_children(self, parent_task_id: str, *, origin: str) -> None:
        try:
            children = await self.store.children_of(parent_task_id)
        except Exception:
            logger.debug("child lookup failed for %s", parent_task_id, exc_info=True)
            return
        for child in children:
            child_id = child.get("id")
            if child_id not in self._running:
                continue
            # One child's failure never blocks the parent's own stop.
            try:
                await self.store.add_event(child_id, kind="parent_stopped", origin=origin, detail=parent_task_id)
                await self.stop(child_id, origin=origin)
            except (KeyError, NotLinkable):
                continue
            except Exception:
                logger.warning("stopping delegated task %s failed for %s", child_id, parent_task_id,
                               exc_info=True)

    # -- delegation -----------------------------------------------------------

    def deliver_prompt(self, task_id: str, text: str, *, ready_timeout_s: Optional[float] = 60.0,
                       quiet: bool = False) -> None:
        """Queue `text` for a delegated task. It is pasted into the PTY once,
        followed by Enter, when the task is ready: its first SessionStart or
        idle hook, or, with `quiet`, once its screen is drawn and still.

        While the child's screen shows a dialog that waits for the person
        (a folder trust or update prompt), the delegation is marked waiting
        for the user and the wait grows to WAITING_TIMEOUT_S. Nothing is typed
        into such a dialog. With no readiness by the deadline the prompt is
        dropped and the delegation service is told."""
        if not isinstance(text, str) or not text:
            return
        self._pending_prompts[task_id] = text
        loop = self._loop
        if loop is None:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None
        if loop is not None and ready_timeout_s is not None:
            watcher = asyncio.ensure_future(self._watch_prompt(task_id, ready_timeout_s, quiet), loop=loop)
            watcher.add_done_callback(lambda f: f.cancelled() or f.exception())
            self._prompt_timers[task_id] = watcher

    async def _watch_prompt(self, task_id: str, timeout_s: float, quiet: bool) -> None:
        from securevector.app.services import delegation

        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_s
        waiting = False
        silent_noted = False
        settled_at = None
        last_len, last_change = -1, loop.time()
        while task_id in self._pending_prompts:
            now = loop.time()
            snap = self._screen(task_id)
            if len(snap) != last_len:
                last_len, last_change = len(snap), now
            dialog = delegation.user_dialog(snap)
            if dialog and not waiting:
                waiting = True
                deadline = max(deadline, now + WAITING_TIMEOUT_S)
                try:
                    await delegation.on_waiting_for_user(self, task_id, dialog)
                except Exception:
                    logger.warning("delegation waiting note failed for %s", task_id)
            ready_after_dialog = task_id in self._hook_seen
            if (quiet or ready_after_dialog) and not dialog and len(snap) >= (
                    QUIET_MIN_BYTES if quiet else 0) and now - last_change >= QUIET_SECONDS:
                self._prompt_timers.pop(task_id, None)
                await self._deliver_now(task_id, "quiet" if quiet else "hook")
                return
            # Ready-hook harness: settled at its input with no hook. Its Guard
            # is not running, so nothing is typed and the delegation ends.
            if settled_at is None and not dialog and len(snap) >= QUIET_MIN_BYTES \
                    and now - last_change >= QUIET_SECONDS:
                settled_at = now
            if dialog:
                settled_at = None
            if (not quiet and settled_at is not None and not silent_noted and task_id not in self._hook_seen
                    and now - settled_at >= HOOKS_SILENT_S):
                silent_noted = True
                self._prompt_timers.pop(task_id, None)
                if self._pending_prompts.pop(task_id, None) is not None:
                    await delegation.on_prompt_not_ready(
                        self, task_id, delegation.guard_not_running_reason(await self._executor_of(task_id)))
                return
            if now >= deadline:
                if quiet and not dialog and len(snap) >= QUIET_MIN_BYTES and not waiting:
                    self._prompt_timers.pop(task_id, None)
                    await self._deliver_now(task_id, "quiet")
                    return
                self._prompt_timers.pop(task_id, None)
                if self._pending_prompts.pop(task_id, None) is not None:
                    await self._prompt_not_ready(task_id)
                return
            await asyncio.sleep(min(PROMPT_POLL_S, max(0.0, deadline - now)))

    async def _resubmits(self, task_id: str) -> bool:
        from securevector.app.terminals.executors import EXECUTORS

        executor = EXECUTORS.get(await self._executor_of(task_id) or "")
        return bool(executor and executor.prompt_resubmit)

    async def _executor_of(self, task_id: str) -> Optional[str]:
        task = await self.store.get_task(task_id)
        return task.get("executor_id") if task else None

    def guard_silent(self) -> dict:
        """Running tasks whose Guard did not report after their first
        prompt: {task_id: card warning}."""
        return {t: w for t, w in self._guard_silent.items() if t in self._running}

    def _schedule_guard_check(self, task_id: str, after_seq: Optional[int], *, delegated: bool) -> None:
        try:
            fut = asyncio.ensure_future(self._guard_check(task_id, after_seq, delegated))
            fut.add_done_callback(lambda f: f.cancelled() or f.exception())
        except RuntimeError:
            pass

    async def _guard_check(self, task_id: str, after_seq: Optional[int], delegated: bool) -> None:
        """No hook within GUARD_REPORT_S of the first prompt: the session is
        running without its Guard reporting. The card says so; a delegated
        child is also stopped and its delegation fails."""
        from securevector.app.services import delegation

        if delegated and task_id in self._resubmit:
            await asyncio.sleep(PROMPT_RESUBMIT_S)
            held = self._resubmit.pop(task_id, None)
            if task_id not in self._running:
                return
            if await self._hook_since(task_id, after_seq):
                return
            if held is not None and self._output_since(task_id, held[1]) <= RESUBMIT_BUSY_BYTES:
                await self._resubmit_prompt(task_id, held[0])
        await asyncio.sleep(GUARD_REPORT_S)
        if task_id not in self._running:
            return
        if await self._hook_since(task_id, after_seq):
            return
        warning = delegation.guard_silent_reason(await self._executor_of(task_id))
        self._guard_silent[task_id] = warning
        try:
            await self.store.update_status(task_id, "blocked", activity=warning)
        except Exception:
            logger.debug("guard warning status failed for %s", task_id, exc_info=True)
        if delegated:
            await delegation.on_guard_silent(self, task_id, warning)
            try:
                await self.stop(task_id, origin="policy")
            except (KeyError, NotLinkable):
                pass

    async def _hook_since(self, task_id: str, after_seq: Optional[int]) -> bool:
        events = await self.store.list_events(task_id, limit=2000)
        return any(e.get("kind") == "hook" and (after_seq is None or int(e.get("seq") or 0) > int(after_seq))
                   for e in events)

    def _output_mark(self, task_id: str) -> tuple:
        snap = self._screen(task_id)
        return len(snap), snap[-256:]

    def _output_since(self, task_id: str, mark: tuple) -> int:
        """Bytes of screen output since `mark`. Once the ring has wrapped
        its length stops growing, so the end of the mark is looked up."""
        length, tail = mark
        snap = self._screen(task_id)
        if len(snap) > length and snap[length - len(tail):length] == tail:
            return len(snap) - length
        if not tail:
            return len(snap)
        at = snap.rfind(tail)
        return len(snap) if at < 0 else len(snap) - (at + len(tail))

    async def _resubmit_prompt(self, task_id: str, text: str) -> None:
        """Send a delegated prompt once more after its paste brought no hook.
        Still on screen (the Enter was lost): Enter only. Gone (the paste was
        lost): pasted again, then Enter."""
        import hashlib

        from securevector.app.services.delegation import DIALOG_TAIL_BYTES, _ANSI_RE, paste_text

        def letters(raw: bytes) -> str:
            return re.sub(r"[^a-z]", "", _ANSI_RE.sub(b" ", raw).decode("utf-8", "ignore").lower())

        data = paste_text(text).encode("utf-8")
        screen = self._screen(task_id)
        # Only what is still drawn: output before the last full-screen reset
        # (a redraw after a self-update, say) is stale echo.
        cut = max(screen.rfind(r) for r in _SCREEN_RESETS)
        if cut >= 0:
            screen = screen[cut:]
        tail = letters(screen[-DIALOG_TAIL_BYTES:])
        words = letters(data)
        shown = bool(words) and (words[:40] in tail or words[-40:] in tail) or bool(
            re.search(r"\[pasted ~?\d+ lines?\]", _ANSI_RE.sub(b" ", screen[-DIALOG_TAIL_BYTES:])
                      .decode("utf-8", "ignore").lower()))
        try:
            if shown:
                self.host.write(task_id, b"\r")
            else:
                self.host.write(task_id, b"\x1b[200~" + data + b"\x1b[201~")
                await asyncio.sleep(0.05)
                self.host.write(task_id, b"\r")
        except Exception:
            logger.debug("prompt resubmit failed for %s", task_id, exc_info=True)
            return
        await self.store.add_event(
            task_id, kind="delegate_prompt", origin="delegate",
            detail=f"sha256={hashlib.sha256(data).hexdigest()} length={len(data)} trigger=resubmit",
        )

    def _screen(self, task_id: str) -> bytes:
        try:
            return self.host.snapshot(task_id) or b""
        except Exception:
            return b""

    async def _prompt_not_ready(self, task_id: str) -> None:
        from securevector.app.services import delegation

        await delegation.on_prompt_not_ready(self, task_id)

    async def _deliver_now(self, task_id: str, trigger: str) -> bool:
        text = self._pending_prompts.pop(task_id, None)
        self._hook_seen.discard(task_id)
        timer = self._prompt_timers.pop(task_id, None)
        if timer is not None:
            timer.cancel()
        if text is None or task_id not in self._running:
            return False
        import hashlib

        from securevector.app.services.delegation import paste_text

        data = paste_text(text).encode("utf-8")
        # Bracketed paste, so the harness takes the prompt as typed text;
        # Enter as its own write after it.
        mark = self._output_mark(task_id)
        self.host.write(task_id, b"\x1b[200~" + data + b"\x1b[201~")
        await asyncio.sleep(0.05)
        self.host.write(task_id, b"\r")
        seq = await self.store.add_event(
            task_id, kind="delegate_prompt", origin="delegate",
            detail=f"sha256={hashlib.sha256(data).hexdigest()} length={len(data)} trigger={trigger}",
        )
        if trigger == "quiet" and await self._resubmits(task_id):
            self._resubmit[task_id] = (text, mark)
        self._schedule_guard_check(task_id, seq, delegated=True)
        try:
            from securevector.app.services import delegation

            await delegation.on_prompt_delivered(self, task_id)
        except Exception:
            logger.warning("delegation delivery note failed for %s", task_id)
        return True

    def _notify_delegation(self, task_id: str) -> None:
        """Tell the delegation service a delegated task went idle or exited.
        Background and best effort; the hook and exit paths never wait."""
        if task_id not in self._delegated:
            return
        try:
            from securevector.app.services import delegation

            fut = asyncio.ensure_future(delegation.on_child_event(self, task_id))
            fut.add_done_callback(lambda f: f.cancelled() or f.exception())
        except Exception:
            logger.debug("delegation notify failed for %s", task_id, exc_info=True)

    async def stop_all(self, *, origin: str) -> None:
        for task_id in list(self._running):
            try:
                await self.stop(task_id, origin=origin)
            except KeyError:
                continue

    # -- hook events --------------------------------------------------------

    def _config_check(self, task_id: str, executor_id: Optional[str], workspace: Optional[str],
                      phase: str, session_id: Optional[str] = None) -> None:
        """Agent Config Trust: one read-only setup check, scheduled off this
        path so a launch or a hook never waits on it. Observe only."""
        if not self.settings.config_trust or not executor_id:
            return
        workspace = worktrees.source_for(workspace)
        from securevector.app.services import config_trust
        config_trust.schedule(config_trust.session_check(
            self.store.db, harness=executor_id, workspace=workspace, phase=phase,
            task_id=task_id, session_id=session_id,
        ))

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
            elif (
                task
                and event.get("hook_event_name") == "SessionStart"
                and str(session_id) != task.get("session_id")
                and SESSION_ID_RE.match(str(session_id))
            ):
                # The harness started a new session inside this same task
                # (Claude Code /clear). Only SessionStart may move the task,
                # and only through its own per-task token. The id it left stays on the
                # task's trail, so its traces and verdicts remain its own.
                old = str(task.get("session_id"))
                # A session id already held (now, or before a re-link) by
                # another task on the board stays with that task.
                others = await self.store.tasks_claiming_session(
                    str(session_id), exclude_task_id=task_id
                )
                if others:
                    logger.warning(
                        "refused session re-link: the session is held by another task"
                    )
                else:
                    await self.store.set_session(task_id, str(session_id))
                    await self.store.add_event(
                        task_id, kind=SESSION_RELINKED, origin="hook", detail=old,
                    )
        if event.get("hook_event_name") == "SessionStart":
            task = await self.store.get_task(task_id)
            if task:
                cwd = event.get("cwd") if isinstance(event.get("cwd"), str) else None
                cwd = worktrees.source_for(cwd)
                self._config_check(task_id, task.get("executor_id"), cwd or task.get("workspace"), "start",
                                   task.get("session_id"))
        self._guard_silent.pop(task_id, None)
        self._resubmit.pop(task_id, None)
        if task_id in self._pending_prompts and event.get("hook_event_name") in ("SessionStart", "Stop"):
            try:
                from securevector.app.services import delegation

                if delegation.user_dialog(self._screen(task_id)):
                    # Never typed into a dialog; the watcher sends it once
                    # the person has answered.
                    self._hook_seen.add(task_id)
                else:
                    await self._deliver_now(task_id, str(event.get("hook_event_name")))
            except Exception:
                logger.warning("delegated prompt delivery failed for %s", task_id)
            # Delivery is the event that ends startup, not the end of a turn.
            if event.get("hook_event_name") == "Stop":
                return True
        status, activity = status_from_hook(event)
        if status is None:
            return True
        if activity:
            activity = redact_secrets(activity, "outgoing")[0]
        # Live Runs: one event per actual status change. The last status sent
        # is remembered per task; with nothing remembered yet (sink installed
        # after spawn), the stored status before this update stands in.
        # Emitting is best effort: a failed read here never breaks the hook.
        changed = False
        tracking = live_runs.has_sink()
        if tracking:
            try:
                previous = self._live_status.get(task_id)
                if previous is None:
                    before = await self.store.get_task(task_id)
                    previous = before.get("status") if before else None
                changed = previous != status
            except Exception:
                logger.debug("live runs: status read failed for %s", task_id, exc_info=True)
        await self.store.update_status(task_id, status, activity=activity)
        if tracking:
            # Only once the new status is stored, so a failed write cannot
            # suppress the event for the retry.
            self._live_status[task_id] = status
        await self.store.add_event(
            task_id,
            kind="hook",
            origin="hook",
            detail=f"{event.get('hook_event_name')} -> {status}",
        )
        if changed and live_runs.has_sink():
            try:
                current = await self.store.get_task(task_id)
            except Exception:
                current = None
            live_runs.emit_nowait(current, "hook", origin="hook")
        if status == "idle":
            self._notify_delegation(task_id)
        return True

    # -- worktrees ------------------------------------------------------------

    def _worktree_paths(self, task: Optional[Mapping]) -> Optional[Tuple[str, str]]:
        """(worktree root, source top level) for a task row with a worktree.
        The root is always <data_dir>/terminals/tasks/<creating task>/worktree;
        the creating task is named by the branch, so a relaunch that reuses a
        worktree resolves to the same root."""
        if not task:
            return None
        branch = str(task.get("worktree_branch") or "")
        run_dir = task.get("run_dir")
        if not run_dir or not branch.startswith(worktrees.BRANCH_PREFIX):
            return None
        owner = branch[len(worktrees.BRANCH_PREFIX):]
        if not re.fullmatch(r"[0-9a-f]{12}", owner):
            return None
        root = os.path.realpath(
            Path(self.settings.data_dir) / "terminals" / "tasks" / owner / worktrees.WORKTREE_DIRNAME
        )
        source_root = worktrees.split_source(
            str(task.get("workspace") or ""), os.path.normpath(str(run_dir)), root
        )
        if not source_root:
            return None
        return root, source_root

    def _worktree_lock(self) -> asyncio.Lock:
        if self._wt_lock is None:
            self._wt_lock = asyncio.Lock()
        return self._wt_lock

    @staticmethod
    def _worktree_gone(task: Mapping) -> bool:
        return task.get("worktree_state") in (worktrees.REMOVED, worktrees.REMOVING)

    async def _reusable_worktree(self, from_task_id: Optional[str], resume_session_id: Optional[str],
                                 source_cwd: str) -> Optional[dict]:
        """The earlier task's worktree row, when a relaunch or resume should
        run in it again: same source folder, folder still on disk and inside
        the worktree once links are resolved, not removed or being removed,
        and no running task in it. Called under _worktree_lock()."""
        prior = None
        if from_task_id:
            prior = await self.store.get_task(from_task_id)
        elif resume_session_id:
            prior = await self.store.task_for_session(resume_session_id)
        if not prior or not prior.get("run_dir") or self._worktree_gone(prior):
            return None
        if os.path.realpath(str(prior.get("workspace") or "")) != os.path.realpath(source_cwd):
            return None
        paths = self._worktree_paths(prior)
        if paths is None or not os.path.isdir(str(prior["run_dir"])):
            return None
        run_dir = os.path.realpath(str(prior["run_dir"]))
        if not worktrees.inside_real(run_dir, paths[0]):
            raise worktrees.WorktreeError("The worktree folder leaves the worktree through a link.")
        if await self._worktree_busy(prior):
            raise worktrees.WorktreeError("Another running task is using this worktree.")
        worktrees.register(*paths)
        return dict(prior, run_dir=run_dir, _root=paths[0])

    def child_run_dir(self, parent: Optional[Mapping], folder: str) -> Optional[str]:
        """Where a delegated child of `parent` runs for the (source) `folder`:
        the same subpath in the parent's worktree, links resolved. None when
        the parent has no worktree or the folder is outside the parent's
        repository. Raises WorktreeError when the parent's worktree was
        removed, is being removed, is missing, or the path leaves it."""
        if not parent or not parent.get("run_dir"):
            return None
        paths = self._worktree_paths(parent)
        if paths is None:
            return None
        if self._worktree_gone(parent) or not os.path.isdir(paths[0]):
            raise worktrees.WorktreeError("The requesting task's worktree was removed, so it cannot delegate.")
        root, source_root = paths
        rel = os.path.relpath(os.path.realpath(folder), source_root)
        if rel == ".." or rel.startswith(".." + os.sep):
            return None
        target = os.path.realpath(root if rel == "." else os.path.join(root, rel))
        if not worktrees.inside_real(target, root):
            raise worktrees.WorktreeError("That folder leaves the requesting task's worktree through a link.")
        if not os.path.isdir(target):
            raise worktrees.WorktreeError("That folder does not exist in the requesting task's worktree.")
        return target

    async def _worktree_busy(self, task: Mapping) -> bool:
        branch = task.get("worktree_branch")
        if not branch:
            return False
        paths = self._worktree_paths(task)
        root = paths[0] if paths else None
        if root and root in self._wt_claims.values():
            return True
        for running_id in list(self._running):
            row = await self.store.get_task(running_id)
            if not row:
                continue
            if row.get("worktree_branch") == branch:
                return True
            # A delegated child running inside this worktree.
            run_dir = row.get("run_dir")
            if root and run_dir:
                real = os.path.realpath(str(run_dir))
                if real == root or real.startswith(root + os.sep):
                    return True
        return False

    async def _worktree_ended(self, task_id: str) -> None:
        """At exit: count changed files and commits, mark the worktree kept.
        Nothing is removed."""
        try:
            task = await self.store.get_task(task_id)
            paths = self._worktree_paths(task)
            if paths is None or self._worktree_gone(task):
                return
            root, source_root = paths
            found = await asyncio.get_running_loop().run_in_executor(
                None, worktrees.counts, source_root, root, task["worktree_branch"], task.get("worktree_base") or "",
            )
            await self.store.set_worktree_state(
                task_id, worktrees.KEPT, dirty=found["dirty"], commits=found["commits"]
            )
            self._wt_refreshed[task_id] = asyncio.get_running_loop().time()
            await self.store.add_event(
                task_id, kind="worktree_kept", origin="process",
                detail=(f"Worktree {task['worktree_branch']} kept: "
                        f"{found['dirty']} changed file{'' if found['dirty'] == 1 else 's'}, "
                        f"{found['commits']} commit{'' if found['commits'] == 1 else 's'}"),
            )
        except Exception:
            logger.warning("worktree end check failed for %s", task_id, exc_info=True)

    async def refresh_worktree(self, task_id: str) -> Optional[dict]:
        """Fresh counts for one task's worktree (read only), stored on its row.
        At most one read per task every WORKTREE_REFRESH_S, none while a task
        runs in the worktree (the exit check counts then), and at most two at
        a time across the app."""
        task = await self.store.get_task(task_id)
        paths = self._worktree_paths(task)
        if paths is None or self._worktree_gone(task):
            return task
        loop = asyncio.get_running_loop()
        last = self._wt_refreshed.get(task_id)
        if last is not None and loop.time() - last < WORKTREE_REFRESH_S:
            return task
        if await self._worktree_busy(task):
            return task
        if self._wt_refresh_sem is None:
            self._wt_refresh_sem = asyncio.Semaphore(2)
        if self._wt_refresh_sem.locked():
            return task
        root, source_root = paths
        async with self._wt_refresh_sem:
            self._wt_refreshed[task_id] = loop.time()
            try:
                found = await loop.run_in_executor(
                    None, worktrees.counts, source_root, root, task["worktree_branch"],
                    task.get("worktree_base") or "",
                )
            except worktrees.WorktreeError:
                return task
        current = await self.store.get_task(task_id)
        if current is None or self._worktree_gone(current) or await self._worktree_busy(current):
            return current
        await self.store.set_worktree_state(
            task_id, current.get("worktree_state") or worktrees.KEPT, dirty=found["dirty"], commits=found["commits"]
        )
        return await self.store.get_task(task_id)

    async def worktree_removal_check(self, task_id: str, *, confirm: bool,
                                     dirty_seen: Optional[int] = None) -> Optional[dict]:
        """Read only: the needs_confirm answer `remove_worktree` would give
        with these arguments, or None when it would remove. Raises like it
        for an unknown task or a task without a worktree."""
        task = await self.store.get_task(task_id)
        if task is None:
            raise KeyError(task_id)
        paths = self._worktree_paths(task)
        if paths is None:
            raise ValueError("This task has no worktree.")
        root, source_root = paths
        branch, base = task["worktree_branch"], task.get("worktree_base") or ""
        return await asyncio.get_running_loop().run_in_executor(
            None, lambda: worktrees.check_removal(source_root, root, branch, base, confirm=bool(confirm),
                                                  dirty_seen=dirty_seen))

    async def remove_worktree(self, task_id: str, *, confirm: bool, origin: str = "ui",
                              dirty_seen: Optional[int] = None) -> dict:
        """Remove a task's worktree, only on the person's explicit request.
        Marked 'removing' under the worktree lock first, so a relaunch or a
        delegation cannot start in it meanwhile; restored on any failure."""
        async with self._worktree_lock():
            task = await self.store.get_task(task_id)
            if task is None:
                raise KeyError(task_id)
            paths = self._worktree_paths(task)
            if paths is None:
                raise ValueError("This task has no worktree.")
            if task.get("worktree_state") == worktrees.REMOVED:
                raise ValueError("The worktree was already removed.")
            if task.get("worktree_state") == worktrees.REMOVING:
                raise ValueError("The worktree is already being removed.")
            if await self._worktree_busy(task):
                raise ValueError("Stop the task before removing its worktree.")
            previous = task.get("worktree_state") or worktrees.KEPT
            await self.store.set_worktree_state(
                task_id, worktrees.REMOVING, dirty=task.get("worktree_dirty"), commits=task.get("worktree_commits")
            )
        root, source_root = paths
        branch, base = task["worktree_branch"], task.get("worktree_base") or ""
        result = None
        try:
            result = await asyncio.get_running_loop().run_in_executor(
                None, lambda: worktrees.remove(source_root, root, branch, base, confirm=bool(confirm),
                                         dirty_seen=dirty_seen)
            )
        finally:
            if not (result and result.get("removed")):
                await self.store.set_worktree_state(
                    task_id, previous,
                    dirty=(result or {}).get("dirty", task.get("worktree_dirty")),
                    commits=(result or {}).get("commits", task.get("worktree_commits")),
                )
        if not result.get("removed"):
            return result
        self._wt_refreshed.pop(task_id, None)
        await self.store.set_worktree_state(
            task_id, worktrees.REMOVED, dirty=result.get("dirty"), commits=result.get("commits")
        )
        await self.store.add_event(task_id, kind="worktree_removed", origin=origin,
                                   detail=result.get("message"))
        return result

    def worktree_folder(self, task: Optional[Mapping]) -> Optional[str]:
        """The folder to reveal for a task's worktree, when it exists."""
        if self._worktree_paths(task) is None or task.get("worktree_state") == worktrees.REMOVED:
            return None
        run_dir = str(task.get("run_dir"))
        return run_dir if os.path.isdir(run_dir) else None

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
            seq = await self.store.add_event(
                task_id, kind="input", origin="ui", detail=f"line submitted, {n} bytes"
            )
            if task_id not in self._input_checked and task_id not in self._ungoverned:
                self._input_checked.add(task_id)
                self._schedule_guard_check(task_id, seq, delegated=False)
