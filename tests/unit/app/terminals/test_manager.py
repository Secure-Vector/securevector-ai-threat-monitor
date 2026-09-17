import asyncio
import stat
from pathlib import Path

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.terminals.manager import (
    GuardHooksMissing,
    ManagerSettings,
    TerminalManager,
    status_from_hook,
)
from securevector.app.terminals.pty_host import PtyInfo, Subscriber
from securevector.app.terminals.store import TerminalStore


class FakeHost:
    def __init__(self):
        self.launches = {}
        self.on_exit = {}
        self.writes = []
        self.resizes = []
        self.stopped = []
        self.alive = set()
        self.forgotten = []
        self._pid = 100

    def spawn(self, task_id, launch, rows, cols, on_exit):
        self._pid += 1
        self.launches[task_id] = launch
        self.on_exit[task_id] = on_exit
        self.alive.add(task_id)
        return PtyInfo(task_id=task_id, pid=self._pid, alive=True)

    def write(self, task_id, data):
        self.writes.append((task_id, data))

    def resize(self, task_id, rows, cols):
        self.resizes.append((task_id, rows, cols))

    def attach(self, task_id, loop):
        return b"snapshot", Subscriber(loop, 8)

    def detach(self, task_id, sub):
        pass

    def stop(self, task_id, grace=3.0):
        self.stopped.append(task_id)
        self.alive.discard(task_id)
        self.on_exit[task_id](task_id, -15)

    def snapshot(self, task_id):
        return b"snapshot"

    def list(self):
        return [PtyInfo(t, 0, t in self.alive) for t in self.launches]

    def forget(self, task_id, grace: float = 3.0):
        self.alive.discard(task_id)
        self.forgotten.append(task_id)

    def exit(self, task_id, code):
        self.alive.discard(task_id)
        self.on_exit[task_id](task_id, code)


class ExitDuringSpawnHost(FakeHost):
    """A child that has already exited by the time spawn() returns — the
    real race InProcessPtyHost's reader thread can create for a very
    short-lived process. Exercises the row-before-spawn ordering (item 2)."""

    def __init__(self, exit_code=0):
        super().__init__()
        self._exit_code = exit_code

    def spawn(self, task_id, launch, rows, cols, on_exit):
        info = super().spawn(task_id, launch, rows, cols, on_exit)
        self.alive.discard(task_id)
        on_exit(task_id, self._exit_code)
        return info


class SpawnFailingHost(FakeHost):
    """spawn() always raises — exercises the failed-spawn cleanup path
    (item 3)."""

    def spawn(self, task_id, launch, rows, cols, on_exit):
        raise RuntimeError("boom: pty allocation failed")


def _fake_claude_bin(tmp_path) -> Path:
    # build_launch (executors.py) resolves the executor binary to an
    # absolute path via shutil.which and raises ExecutorUnavailable if
    # "claude" is not on the child PATH, so tests need a real, executable
    # stub on disk rather than a bare "claude" string on the PATH.
    tmp_bin = tmp_path / "bin"
    tmp_bin.mkdir(exist_ok=True)
    fake_claude = tmp_bin / "claude"
    fake_claude.write_text("#!/bin/sh\nexit 0\n")
    fake_claude.chmod(fake_claude.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    fake_codex = tmp_bin / "codex"
    fake_codex.write_text("#!/bin/sh\nexit 0\n")
    fake_codex.chmod(fake_codex.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return tmp_bin


async def _manager(
    tmp_path, host=None, plugin_installed=True, plugin_enabled=False, codex_plugin_enabled=False,
    copilot_cli_plugin_enabled=False, opencode_plugin_enabled=False,
    retain_finished=10,
):
    db = DatabaseConnection(tmp_path / "t.db")
    await run_migrations(db)
    ws = tmp_path / "proj"
    ws.mkdir(exist_ok=True)
    tmp_bin = _fake_claude_bin(tmp_path)
    settings = ManagerSettings(
        data_dir=tmp_path / "data",
        port=8741,
        plugin_dir=lambda: (tmp_path / "plugin") if plugin_installed else None,
        plugin_enabled=lambda: plugin_enabled,
        codex_plugin_enabled=lambda: codex_plugin_enabled,
        copilot_cli_plugin_enabled=lambda: copilot_cli_plugin_enabled,
        opencode_plugin_enabled=lambda: opencode_plugin_enabled,
        parent_env={"PATH": str(tmp_bin), "CLAUDECODE": "1"},
    )
    m = TerminalManager(
        host or FakeHost(), TerminalStore(db), settings, retain_finished=retain_finished
    )
    await m.start(asyncio.get_running_loop())
    return m, ws


@pytest.mark.asyncio
async def test_spawn_records_task_and_audit_and_uses_governed_launch(tmp_path):
    m, ws = await _manager(tmp_path)
    task = await m.spawn("claude-code", str(ws), title="Fix tests", origin="ui")
    assert task["status"] == "starting" and task["executor_id"] == "claude-code"
    launch = m.host.launches[task["id"]]
    assert Path(launch.argv[0]).name == "claude" and "--plugin-dir" in launch.argv
    assert "CLAUDECODE" not in launch.env
    assert launch.env["SV_TERMINAL_TASK_ID"] == task["id"]
    events = await m.store.list_events(task["id"])
    assert events[0]["kind"] == "spawn" and events[0]["origin"] == "ui"
    assert m.running_count() == 1


@pytest.mark.asyncio
async def test_spawn_omits_plugin_dir_when_plugin_already_enabled(tmp_path):
    m, ws = await _manager(tmp_path, plugin_enabled=True)
    task = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    assert "--plugin-dir" not in m.host.launches[task["id"]].argv


@pytest.mark.asyncio
async def test_spawn_refuses_without_guard_hooks(tmp_path):
    m, ws = await _manager(tmp_path, plugin_installed=False)
    with pytest.raises(GuardHooksMissing):
        await m.spawn("claude-code", str(ws), title=None, origin="ui")
    assert await m.store.list_tasks() == []


@pytest.mark.asyncio
async def test_codex_spawn_requires_its_own_guard_plugin_and_has_no_claude_flags(tmp_path):
    m, ws = await _manager(tmp_path)
    with pytest.raises(GuardHooksMissing, match="Codex Guard"):
        await m.spawn("codex", str(ws), title=None, origin="ui")
    enabled_root = tmp_path / "enabled"
    enabled_root.mkdir()
    m, ws = await _manager(enabled_root, codex_plugin_enabled=True)
    task = await m.spawn("codex", str(ws), title="Review", origin="ui")
    launch = m.host.launches[task["id"]]
    assert Path(launch.argv[0]).name == "codex"
    assert "--settings" not in launch.argv and "--plugin-dir" not in launch.argv
    assert launch.env["SECUREVECTOR_ENGINE_ENDPOINT"] == "http://127.0.0.1:8741"


@pytest.mark.asyncio
async def test_copilot_cli_spawn_requires_its_guard_plugin(tmp_path):
    m, ws = await _manager(tmp_path)
    with pytest.raises(GuardHooksMissing, match="Copilot CLI Guard"):
        await m.spawn("copilot-cli", str(ws), title=None, origin="ui")
    assert await m.store.list_tasks() == []


@pytest.mark.asyncio
async def test_opencode_spawn_requires_its_guard_plugin(tmp_path):
    m, ws = await _manager(tmp_path)
    with pytest.raises(GuardHooksMissing, match="OpenCode Guard"):
        await m.spawn("opencode", str(ws), title=None, origin="ui")
    assert await m.store.list_tasks() == []


@pytest.mark.asyncio
async def test_executor_status_reports_installed_and_governed(tmp_path):
    m, _ws = await _manager(tmp_path, plugin_installed=True)
    rows = {row["id"]: row for row in m.executor_status()}
    assert set(rows) == {"claude-code", "codex", "copilot-cli", "opencode"}

    claude = rows["claude-code"]
    assert claude["installed"] is True and claude["governed"] is True
    assert claude["hint"] == ""

    # The fake bin dir carries a codex stub, but its Guard plugin is off.
    codex = rows["codex"]
    assert codex["installed"] is True and codex["governed"] is False
    assert codex["hint"] == (
        "Enable or reinstall the Codex Guard plugin in Integrations before launching a task."
    )

    copilot = rows["copilot-cli"]
    assert copilot["installed"] is False and copilot["governed"] is False
    assert copilot["hint"] == "Install GitHub Copilot CLI to launch tasks with it."


@pytest.mark.asyncio
async def test_executor_status_reports_claude_code_ungoverned_without_plugin(tmp_path):
    m, _ws = await _manager(tmp_path, plugin_installed=False)
    claude = {row["id"]: row for row in m.executor_status()}["claude-code"]
    assert claude["installed"] is True and claude["governed"] is False
    assert claude["hint"] == (
        "Enable or reinstall the Claude Code Guard plugin in Integrations "
        "before launching a task."
    )


@pytest.mark.asyncio
async def test_hook_events_drive_status(tmp_path):
    m, ws = await _manager(tmp_path)
    task = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    tid = task["id"]
    token = m.hook_token(tid)
    assert await m.handle_hook_event(tid, "wrong", {"hook_event_name": "Stop"}) is False
    assert await m.handle_hook_event(
        tid, token, {"hook_event_name": "SessionStart", "session_id": "s9"}
    )
    assert (await m.store.get_task(tid))["session_id"] == "s9"
    await m.handle_hook_event(
        tid,
        token,
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input_preview": '{"command": "pytest -q"}',
        },
    )
    t = await m.store.get_task(tid)
    assert t["status"] == "working" and t["activity"] == 'Bash: {"command": "pytest -q"}'
    await m.handle_hook_event(
        tid,
        token,
        {
            "hook_event_name": "Notification",
            "notification_type": "permission_prompt",
            "message": "Claude needs your permission to use Bash",
        },
    )
    assert (await m.store.get_task(tid))["status"] == "blocked"
    await m.handle_hook_event(tid, token, {"hook_event_name": "Stop"})
    assert (await m.store.get_task(tid))["status"] == "idle"


@pytest.mark.asyncio
async def test_activity_preview_is_redacted(tmp_path):
    m, ws = await _manager(tmp_path)
    task = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    await m.handle_hook_event(
        task["id"],
        m.hook_token(task["id"]),
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input_preview": "export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        },
    )
    assert "wJalrXUtnFEMI" not in (await m.store.get_task(task["id"]))["activity"]


@pytest.mark.asyncio
async def test_exit_marks_done_and_stop_marks_stopped(tmp_path):
    m, ws = await _manager(tmp_path)
    a = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    b = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    m.host.exit(a["id"], 0)
    await asyncio.sleep(0.05)
    assert (await m.store.get_task(a["id"]))["status"] == "done"
    await m.stop(b["id"], origin="ui")
    await asyncio.sleep(0.05)
    tb = await m.store.get_task(b["id"])
    assert tb["status"] == "failed" and tb["exit_code"] == -15
    kinds = [e["kind"] for e in await m.store.list_events(b["id"])]
    assert kinds == ["spawn", "stop", "exit"]
    assert m.running_count() == 0


@pytest.mark.asyncio
async def test_finished_sessions_are_retired_from_the_host_once_the_limit_is_passed(tmp_path):
    """Finished sessions stay in the host's memory (ring buffer + all) until
    retained-count is exceeded, then the oldest is forgotten. The store row
    (and its audit trail) is untouched either way -- only the host's
    in-memory session is released."""
    host = FakeHost()
    m, ws = await _manager(tmp_path, host=host, retain_finished=2)
    a = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    b = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    c = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    host.exit(a["id"], 0)
    await asyncio.sleep(0.05)
    assert host.forgotten == []
    host.exit(b["id"], 0)
    await asyncio.sleep(0.05)
    assert host.forgotten == []
    host.exit(c["id"], 0)
    await asyncio.sleep(0.05)
    # a was the oldest finished task: once a third finishes, it alone is
    # forgotten from the host. b and c (the two newest) remain attachable.
    assert host.forgotten == [a["id"]]
    for task_id in (a["id"], b["id"], c["id"]):
        assert (await m.store.get_task(task_id))["status"] == "done"


@pytest.mark.asyncio
async def test_stop_all_and_restore_on_startup(tmp_path):
    m, ws = await _manager(tmp_path)
    a = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    await m.stop_all(origin="quit")
    await asyncio.sleep(0.05)
    assert m.host.stopped == [a["id"]]
    # Simulate a crash: a row left running, then a fresh manager on the same DB.
    await m.store.create_task(
        "ghost", executor_id="claude-code", workspace=str(ws), title=None, pid=None
    )
    m2 = TerminalManager(FakeHost(), m.store, m.settings)
    await m2.start(asyncio.get_running_loop())
    ghost = await m.store.get_task("ghost")
    assert ghost["status"] == "interrupted"
    assert [e["kind"] for e in await m.store.list_events("ghost")] == ["interrupted"]


@pytest.mark.asyncio
async def test_input_is_audited_per_line_without_content(tmp_path):
    m, ws = await _manager(tmp_path)
    t = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    await m.input(t["id"], b"y")
    await m.input(t["id"], b"es\r")
    await m.input(t["id"], b"secret")
    events = [e for e in await m.store.list_events(t["id"]) if e["kind"] == "input"]
    assert len(events) == 1
    assert events[0]["detail"] == "line submitted, 4 bytes"
    assert m.host.writes == [(t["id"], b"y"), (t["id"], b"es\r"), (t["id"], b"secret")]


@pytest.mark.asyncio
async def test_attach_nudges_repaint_on_first_resize(tmp_path):
    m, ws = await _manager(tmp_path)
    t = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    snapshot, sub = m.attach(t["id"], asyncio.get_running_loop())
    assert snapshot == b"snapshot"
    m.resize(t["id"], 40, 120, first=True)
    assert m.host.resizes == [(t["id"], 40, 121), (t["id"], 40, 120)]
    m.resize(t["id"], 40, 100, first=False)
    assert m.host.resizes[-1] == (t["id"], 40, 100)
    m.detach(t["id"], sub)


# -- status_from_hook (direct) ----------------------------------------------


def test_status_from_hook_tool_use_includes_preview():
    status, activity = status_from_hook(
        {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input_preview": "ls -la"}
    )
    assert (status, activity) == ("working", "Bash: ls -la")


def test_status_from_hook_tool_use_without_preview_falls_back_to_tool_name():
    status, activity = status_from_hook({"hook_event_name": "PostToolUse", "tool_name": "Read"})
    assert (status, activity) == ("working", "Read")


def test_status_from_hook_user_prompt_submit():
    assert status_from_hook({"hook_event_name": "UserPromptSubmit"}) == (
        "working",
        "Prompt submitted",
    )


def test_status_from_hook_session_start():
    assert status_from_hook({"hook_event_name": "SessionStart"}) == ("working", "Session started")


def test_status_from_hook_notification_permission_prompt_not_truncated():
    long_msg = "permission needed: " + "x" * 250
    status, activity = status_from_hook(
        {
            "hook_event_name": "Notification",
            "notification_type": "permission_prompt",
            "message": long_msg,
        }
    )
    assert status == "blocked"
    # store.update_status is responsible for truncation, not status_from_hook.
    assert activity == long_msg
    assert len(activity) > 200


def test_status_from_hook_notification_without_permission_is_ignored():
    assert status_from_hook(
        {"hook_event_name": "Notification", "notification_type": "info", "message": "unrelated"}
    ) == (None, None)


def test_status_from_hook_stop_is_idle():
    assert status_from_hook({"hook_event_name": "Stop"}) == ("idle", "Waiting for input")


def test_status_from_hook_unknown_event_is_ignored():
    assert status_from_hook({"hook_event_name": "SomethingElse"}) == (None, None)


# -- _reap (direct) -----------------------------------------------------------


@pytest.mark.asyncio
async def test_reap_ignores_a_pid_that_is_not_alive(tmp_path):
    m, ws = await _manager(tmp_path)
    import subprocess

    proc = subprocess.Popen(["/bin/sh", "-c", "exit 0"])
    proc.wait()
    dead_pid = proc.pid  # reaped; os.kill(dead_pid, 0) must raise OSError
    task = {"id": "ghost-task", "pid": dead_pid, "executor_id": "claude-code"}
    m._reap(task)  # must not raise, and must not signal anything


@pytest.mark.asyncio
async def test_reap_ignores_missing_pid_or_unknown_executor(tmp_path):
    m, ws = await _manager(tmp_path)
    m._reap({"id": "t1", "pid": None, "executor_id": "claude-code"})
    m._reap({"id": "t2", "pid": 123456, "executor_id": "not-a-real-executor"})


# -- spawn/exit race + failed-spawn cleanup (items 2, 3) ---------------------


@pytest.mark.asyncio
async def test_spawn_survives_exit_racing_ahead_of_row_and_pid(tmp_path):
    """A child that exits before host.spawn() even returns must not lose the
    exit: the store row is created (and the task marked running) before
    host.spawn() runs, so _on_exit always finds a row to update."""
    host = ExitDuringSpawnHost(exit_code=0)
    m, ws = await _manager(tmp_path, host=host)
    task = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    await asyncio.sleep(0.05)
    t = await m.store.get_task(task["id"])
    assert t["status"] == "done"
    assert t["exit_code"] == 0
    assert m.running_count() == 0
    assert m.hook_token(task["id"]) is None


@pytest.mark.asyncio
async def test_spawn_cleans_up_and_reraises_on_failed_spawn(tmp_path):
    host = SpawnFailingHost()
    m, ws = await _manager(tmp_path, host=host)
    with pytest.raises(RuntimeError):
        await m.spawn("claude-code", str(ws), title=None, origin="ui")
    assert m.running_count() == 0
    tasks = await m.store.list_tasks()
    assert len(tasks) == 1
    assert tasks[0]["status"] == "failed"
    assert m.hook_token(tasks[0]["id"]) is None
    events = await m.store.list_events(tasks[0]["id"])
    kinds = [e["kind"] for e in events]
    # No "spawn" event is ever written on this path: the manager only emits
    # "spawn" after host.spawn() and store.update_pid() both succeed, so a
    # spawn that fails produces exactly one audit event.
    assert kinds == ["spawn_failed"]
    assert "RuntimeError" in events[0]["detail"]
