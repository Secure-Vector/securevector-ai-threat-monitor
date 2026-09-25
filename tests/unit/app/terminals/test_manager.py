import asyncio
import stat
from pathlib import Path

import pytest
from datetime import datetime, timedelta, timezone

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.terminals import manager as manager_module
from securevector.app.terminals.executors import UnknownExecutor
from securevector.app.terminals.manager import (
    ManagerSettings,
    NotLinkable,
    SessionAlreadyLinked,
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


def _stub_binary(tmp_path, name: str) -> None:
    """Put one more executable stub on the child PATH built by
    _fake_claude_bin, so build_launch's which() check passes for it."""
    tmp_bin = tmp_path / "bin"
    tmp_bin.mkdir(exist_ok=True)
    stub = tmp_bin / name
    stub.write_text("#!/bin/sh\nexit 0\n")
    stub.chmod(stub.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


async def _until_done(store, task_id, timeout=5.0):
    """Wait until the exit handler has marked ``task_id`` done. A fixed sleep
    races the handler's database writes on a slow CI runner."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if (await store.get_task(task_id))["status"] == "done":
            return
        await asyncio.sleep(0.02)
    raise AssertionError(f"task {task_id} never reached done")


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
async def test_claude_code_launch_is_governed_by_the_relay_without_the_plugin(tmp_path):
    """The --settings relay this host writes is what governs a launch.

    The plugin governs sessions started OUTSIDE the app, where this host
    writes no argv. Reporting a launch as ungoverned because the plugin is
    unregistered marked the one always-relayed path as the unsafe one.
    """
    m, ws = await _manager(tmp_path, plugin_installed=False)
    task = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    argv = m.host.launches[task["id"]].argv
    assert "--settings" in argv, "the relay is what governs, so it must be on the command line"
    assert "--plugin-dir" not in argv, "nothing is registered to inject"
    assert task["id"] not in m.ungoverned_ids()
    events = await m.store.list_events(task["id"])
    assert not [e for e in events if e["kind"] == "guard_missing"]


@pytest.mark.asyncio
async def test_spawn_with_guard_hooks_records_no_guard_missing_event(tmp_path):
    m, ws = await _manager(tmp_path, plugin_installed=True)
    task = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    assert task["id"] not in m.ungoverned_ids()
    events = await m.store.list_events(task["id"])
    assert not [e for e in events if e["kind"] == "guard_missing"]


@pytest.mark.asyncio
async def test_codex_spawn_without_its_guard_plugin_is_ungoverned_and_has_no_claude_flags(tmp_path):
    m, ws = await _manager(tmp_path)
    ungoverned = await m.spawn("codex", str(ws), title=None, origin="ui")
    assert ungoverned["id"] in m.ungoverned_ids()
    events = await m.store.list_events(ungoverned["id"])
    assert [e["detail"] for e in events if e["kind"] == "guard_missing"]
    enabled_root = tmp_path / "enabled"
    enabled_root.mkdir()
    m, ws = await _manager(enabled_root, codex_plugin_enabled=True)
    task = await m.spawn("codex", str(ws), title="Review", origin="ui")
    launch = m.host.launches[task["id"]]
    assert Path(launch.argv[0]).name == "codex"
    assert "--settings" not in launch.argv and "--plugin-dir" not in launch.argv
    assert launch.env["SECUREVECTOR_ENGINE_ENDPOINT"] == "http://127.0.0.1:8741"


@pytest.mark.asyncio
async def test_copilot_cli_spawn_without_its_guard_plugin_is_ungoverned(tmp_path):
    m, ws = await _manager(tmp_path)
    _stub_binary(tmp_path, "copilot")
    task = await m.spawn("copilot-cli", str(ws), title=None, origin="ui")
    assert task["id"] in m.ungoverned_ids()
    events = await m.store.list_events(task["id"])
    assert any("Copilot CLI Guard" in e["detail"] for e in events if e["kind"] == "guard_missing")


@pytest.mark.asyncio
async def test_opencode_spawn_without_its_guard_plugin_is_ungoverned(tmp_path):
    m, ws = await _manager(tmp_path)
    _stub_binary(tmp_path, "opencode")
    task = await m.spawn("opencode", str(ws), title=None, origin="ui")
    assert task["id"] in m.ungoverned_ids()
    events = await m.store.list_events(task["id"])
    assert any("OpenCode Guard" in e["detail"] for e in events if e["kind"] == "guard_missing")


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
        "Codex Guard is not enabled. Tasks launch ungoverned until you install it."
    )

    copilot = rows["copilot-cli"]
    assert copilot["installed"] is False and copilot["governed"] is False
    assert copilot["hint"] == "Install GitHub Copilot CLI to launch tasks with it."


@pytest.mark.asyncio
async def test_claude_code_status_is_governed_and_names_what_the_plugin_is_for(tmp_path):
    m, _ws = await _manager(tmp_path, plugin_installed=False)
    claude = {row["id"]: row for row in m.executor_status()}["claude-code"]
    assert claude["installed"] is True and claude["governed"] is True
    # Not silence: the plugin is still worth installing, just not for this.
    assert claude["hint"] == (
        "Sessions you start in your own terminal are not governed until the "
        "Claude Code Guard plugin is installed."
    )


@pytest.mark.asyncio
async def test_claude_code_status_says_nothing_once_the_plugin_is_registered(tmp_path):
    m, _ws = await _manager(tmp_path, plugin_installed=True)
    claude = {row["id"]: row for row in m.executor_status()}["claude-code"]
    assert claude["installed"] is True and claude["governed"] is True
    assert claude["hint"] == ""


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
    await _until_done(m.store, a["id"])
    assert host.forgotten == []
    host.exit(b["id"], 0)
    await _until_done(m.store, b["id"])
    assert host.forgotten == []
    host.exit(c["id"], 0)
    await _until_done(m.store, c["id"])
    # Retirement runs after the task is marked done, so poll for it.
    loop = asyncio.get_running_loop()
    deadline = loop.time() + 5.0
    while not host.forgotten and loop.time() < deadline:
        await asyncio.sleep(0.02)
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


# --- linked sessions -------------------------------------------------------


def _stamp(minutes_ago: int) -> str:
    from datetime import datetime, timedelta, timezone

    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )


async def _audit(manager, *, session_id, function_name, called_at, runtime_kind="codex"):
    await manager.store.db.execute(
        "INSERT INTO tool_call_audit "
        "(tool_id, function_name, action, risk, reason, is_essential, args_preview, "
        "called_at, session_id, runtime_kind) "
        "VALUES (?, ?, 'allow', NULL, NULL, 0, NULL, ?, ?, ?)",
        (function_name, function_name, called_at, session_id, runtime_kind),
    )


@pytest.mark.asyncio
async def test_link_session_creates_a_linked_task_and_audits_it(tmp_path):
    m, _ws = await _manager(tmp_path)
    task = await m.link_session("codex", "sess-abc12345", workspace="/repo", title="Outside run")

    assert task["origin"] == "linked" and task["pid"] is None
    assert task["status"] == "working" and task["activity"] == "linked"
    assert task["session_id"] == "sess-abc12345" and task["workspace"] == "/repo"
    assert task["title"] == "Outside run"
    kinds = [e["kind"] for e in await m.store.list_events(task["id"])]
    assert kinds == ["linked"]
    detail = (await m.store.list_events(task["id"]))[0]["detail"]
    assert detail == "Linked Codex session sess-abc12345"


@pytest.mark.asyncio
async def test_link_session_without_a_folder_says_so_rather_than_guessing(tmp_path):
    m, _ws = await _manager(tmp_path)
    task = await m.link_session("codex", "sess-abc12345", workspace=None, title=None)
    assert task["workspace"] == "(unknown folder)"


@pytest.mark.asyncio
async def test_link_session_rejects_unknown_executors_and_bad_session_ids(tmp_path):
    m, _ws = await _manager(tmp_path)
    with pytest.raises(UnknownExecutor):
        await m.link_session("nope", "sess-abc12345", workspace=None, title=None)
    for bad in ("short", "has space", "has/slash", "x" * 129, ""):
        with pytest.raises(ValueError):
            await m.link_session("codex", bad, workspace=None, title=None)


@pytest.mark.asyncio
async def test_link_session_refuses_a_session_already_on_the_board(tmp_path):
    m, _ws = await _manager(tmp_path)
    await m.link_session("codex", "sess-abc12345", workspace=None, title=None)
    with pytest.raises(SessionAlreadyLinked):
        await m.link_session("codex", "sess-abc12345", workspace=None, title=None)


@pytest.mark.asyncio
async def test_stop_refuses_a_linked_task(tmp_path):
    m, _ws = await _manager(tmp_path)
    task = await m.link_session("codex", "sess-abc12345", workspace=None, title=None)
    with pytest.raises(NotLinkable):
        await m.stop(task["id"], origin="ui")


@pytest.mark.asyncio
async def test_refresh_linked_walks_working_then_idle_then_done(tmp_path):
    m, _ws = await _manager(tmp_path)
    task = await m.link_session("codex", "sess-abc12345", workspace="/repo", title=None)
    sid = task["session_id"]

    await _audit(m, session_id=sid, function_name="Bash", called_at=_stamp(1))
    (row,) = await m.refresh_linked([dict(await m.store.get_task(task["id"]))])
    assert row["status"] == "working" and row["ended_at"] is None

    await m.store.db.execute("DELETE FROM tool_call_audit")
    await _audit(m, session_id=sid, function_name="Bash", called_at=_stamp(10))
    (row,) = await m.refresh_linked([dict(await m.store.get_task(task["id"]))])
    assert row["status"] == "idle" and row["ended_at"] is None

    await m.store.db.execute("DELETE FROM tool_call_audit")
    await _audit(m, session_id=sid, function_name="Bash", called_at=_stamp(45))
    (row,) = await m.refresh_linked([dict(await m.store.get_task(task["id"]))])
    assert row["status"] == "done" and row["ended_at"] is not None
    # The derived state is persisted, not just decorated onto the response.
    assert (await m.store.get_task(task["id"]))["status"] == "done"


@pytest.mark.asyncio
async def test_refresh_linked_ends_the_task_on_a_reported_session_end(tmp_path):
    m, _ws = await _manager(tmp_path)
    task = await m.link_session("codex", "sess-abc12345", workspace="/repo", title=None)
    sid = task["session_id"]
    await _audit(m, session_id=sid, function_name="Bash", called_at=_stamp(3))
    await _audit(m, session_id=sid, function_name="__session_end__", called_at=_stamp(1))

    (row,) = await m.refresh_linked([dict(await m.store.get_task(task["id"]))])
    assert row["status"] == "done" and row["activity"] == "session ended"
    assert row["ended_at"] is not None


@pytest.mark.asyncio
async def test_a_linked_session_with_no_guard_waits_then_idles_but_never_ends(tmp_path):
    m, _ws = await _manager(tmp_path)
    task = await m.link_session("codex", "sess-abc12345", workspace="/repo", title=None)

    (row,) = await m.refresh_linked([dict(await m.store.get_task(task["id"]))])
    assert row["status"] == "working"
    assert row["activity"] == "linked, waiting for the Guard"
    assert row["ended_at"] is None

    await m.store.db.execute(
        "UPDATE terminal_tasks SET created_at = datetime('now', '-45 minutes') WHERE id = ?",
        (task["id"],),
    )
    (row,) = await m.refresh_linked([dict(await m.store.get_task(task["id"]))])
    assert row["status"] == "idle" and row["ended_at"] is None


@pytest.mark.asyncio
async def test_refresh_linked_leaves_launched_tasks_untouched(tmp_path):
    m, ws = await _manager(tmp_path)
    launched = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    (row,) = await m.refresh_linked([dict(launched)])
    assert row["status"] == "starting" and row["origin"] == "launch"


@pytest.mark.asyncio
async def test_unlinked_sessions_carry_their_harness_label(tmp_path):
    m, _ws = await _manager(tmp_path)
    await _audit(m, session_id="sess-loose1234", function_name="Bash", called_at=_stamp(2))
    rows = await m.unlinked_sessions()
    assert [r["session_id"] for r in rows] == ["sess-loose1234"]
    assert rows[0]["label"] == "Codex" and rows[0]["executor_id"] == "codex"


@pytest.mark.asyncio
async def test_two_concurrent_links_for_one_session_make_exactly_one_row(tmp_path):
    m, _ws = await _manager(tmp_path)
    results = await asyncio.gather(
        m.link_session("codex", "sess-abc12345", workspace=None, title=None),
        m.link_session("codex", "sess-abc12345", workspace=None, title=None),
        return_exceptions=True,
    )
    created = [r for r in results if isinstance(r, dict)]
    refused = [r for r in results if isinstance(r, SessionAlreadyLinked)]
    assert len(created) == 1 and len(refused) == 1
    rows = await m.store.list_linked_tasks()
    assert [r["session_id"] for r in rows] == ["sess-abc12345"]


@pytest.mark.asyncio
async def test_session_id_pattern_rejects_a_trailing_newline(tmp_path):
    m, _ws = await _manager(tmp_path)
    # "$" would accept a trailing newline, letting a pasted value carry one
    # into the row and past the duplicate check.
    with pytest.raises(ValueError):
        await m.link_session("codex", "sess-abc12345\nx x", workspace=None, title=None)


@pytest.mark.asyncio
async def test_spawn_with_a_resume_id_reopens_that_session_on_a_pty_the_app_owns(tmp_path):
    m, ws = await _manager(tmp_path)
    task = await m.spawn(
        "claude-code", str(ws), title=None, origin="ui", resume_session_id="sess-abc12345"
    )
    launch = m.host.launches[task["id"]]
    # The id reaches argv, and only after the flags this host adds for its own
    # governance: a resumed session is governed exactly like a fresh one.
    assert launch.argv[-2:] == ["--resume", "sess-abc12345"]
    assert "--settings" in launch.argv


@pytest.mark.asyncio
async def test_continuing_a_linked_session_retires_the_linked_row(tmp_path):
    """One session, one row.

    A resume moves an existing harness session onto a PTY this host owns. The
    linked row that offered it names the same session_id, so leaving it up
    shows the session twice: once as a live terminal, and once as an outside
    session whose liveness can no longer move, because the audit trail it was
    derived from now belongs to the launched row.
    """
    m, ws = await _manager(tmp_path)
    linked = await m.link_session(
        "claude-code", "sess-abc12345", workspace=str(ws), title="Outside"
    )
    launched = await m.spawn(
        "claude-code", str(ws), title=None, origin="ui", resume_session_id="sess-abc12345"
    )

    live = {t["id"] for t in await m.store.list_tasks()}
    assert linked["id"] not in live, "the linked row is superseded, not duplicated"
    assert launched["id"] in live
    # Archived, never deleted: the audit the linked row collected is kept.
    assert (await m.store.get_task(linked["id"])) is not None
    events = await m.store.list_events(launched["id"])
    assert [e for e in events if e["kind"] == "adopted"]


@pytest.mark.asyncio
async def test_a_resume_leaves_an_unrelated_linked_session_alone(tmp_path):
    m, ws = await _manager(tmp_path)
    other = await m.link_session(
        "claude-code", "sess-other9999", workspace=str(ws), title="Someone else"
    )
    await m.spawn(
        "claude-code", str(ws), title=None, origin="ui", resume_session_id="sess-abc12345"
    )

    live = {t["id"] for t in await m.store.list_tasks()}
    assert other["id"] in live, "only the row for the resumed session is retired"


@pytest.mark.asyncio
async def test_a_plain_launch_retires_nothing(tmp_path):
    m, ws = await _manager(tmp_path)
    linked = await m.link_session(
        "claude-code", "sess-abc12345", workspace=str(ws), title="Outside"
    )
    await m.spawn("claude-code", str(ws), title=None, origin="ui")

    live = {t["id"] for t in await m.store.list_tasks()}
    assert linked["id"] in live, "a fresh session is a different session"


@pytest.mark.asyncio
async def test_spawn_rejects_a_malformed_resume_id_before_anything_is_launched(tmp_path):
    m, ws = await _manager(tmp_path)
    for bad in ("short", "sess-abc12345\nx x", "; rm -rf /", "--dangerously-skip-permissions", ""):
        with pytest.raises(ValueError):
            await m.spawn("claude-code", str(ws), title=None, origin="ui", resume_session_id=bad)
    # Nothing was spawned and no row was created: the id never reached argv.
    assert m.host.launches == {}
    assert await m.store.list_tasks() == []


@pytest.mark.asyncio
async def test_spawn_refuses_resume_for_a_harness_that_cannot_reopen_a_named_session(tmp_path):
    m, ws = await _manager(tmp_path, opencode_plugin_enabled=True)
    # OpenCode is not silently launched fresh: the person asked for a specific
    # conversation, and --continue would take whichever one happens to be last.
    with pytest.raises(ValueError):
        await m.spawn(
            "opencode", str(ws), title=None, origin="ui", resume_session_id="sess-abc12345"
        )


# --- where a linked task's folder comes from -------------------------------


async def _audit_with_preview(manager, *, session_id, preview, called_at):
    await manager.store.db.execute(
        "INSERT INTO tool_call_audit "
        "(tool_id, function_name, action, risk, reason, is_essential, args_preview, "
        "called_at, session_id, runtime_kind) "
        "VALUES ('Bash', 'Bash', 'allow', NULL, NULL, 0, ?, ?, ?, 'codex')",
        (preview, called_at, session_id),
    )


@pytest.mark.asyncio
async def test_linked_workspace_prefers_the_harness_record_over_the_preview_scrape(
    tmp_path, monkeypatch
):
    m, _ws = await _manager(tmp_path)
    await _audit_with_preview(
        m, session_id="sess-abc12345", preview="cwd=/scraped/folder", called_at=_stamp(1)
    )
    monkeypatch.setattr(
        manager_module, "resolve_session_cwd", lambda executor_id, sid: "/recorded/folder"
    )
    task = await m.link_session("codex", "sess-abc12345", workspace=None, title=None)
    # The transcript records the folder as a field; the preview only happens
    # to spell one out, so the transcript wins whenever it has an answer.
    assert task["workspace"] == "/recorded/folder"


@pytest.mark.asyncio
async def test_linked_workspace_falls_back_to_the_scrape_then_to_saying_so(
    tmp_path, monkeypatch
):
    m, _ws = await _manager(tmp_path)
    monkeypatch.setattr(manager_module, "resolve_session_cwd", lambda executor_id, sid: None)
    await _audit_with_preview(
        m, session_id="sess-abc12345", preview="cwd=/scraped/folder", called_at=_stamp(1)
    )
    scraped = await m.link_session("codex", "sess-abc12345", workspace=None, title=None)
    assert scraped["workspace"] == "/scraped/folder"

    bare = await m.link_session("codex", "sess-abc12346", workspace=None, title=None)
    assert bare["workspace"] == "(unknown folder)"


@pytest.mark.asyncio
async def test_a_linked_row_holding_source_code_repairs_itself_on_the_next_board_read(
    tmp_path, monkeypatch
):
    m, _ws = await _manager(tmp_path)
    # What the unchecked scrape used to store: the marker matched inside a
    # file the agent was editing.
    task = await m.link_session(
        "claude-code",
        "sess-abc12345",
        workspace="def main():\n    return subprocess.run(argv, cwd=str(workspace))",
        title=None,
    )
    calls = []

    def _recorded(executor_id, session_id):
        calls.append((executor_id, session_id))
        return "/Users/someone/repo"

    monkeypatch.setattr(manager_module, "resolve_session_cwd", _recorded)
    (row,) = await m.refresh_linked([dict(await m.store.get_task(task["id"]))])

    assert row["workspace"] == "/Users/someone/repo"
    assert (await m.store.get_task(task["id"]))["workspace"] == "/Users/someone/repo"
    assert calls == [("claude-code", "sess-abc12345")]


@pytest.mark.asyncio
async def test_a_workspace_repair_that_finds_nothing_is_not_retried_on_every_poll(
    tmp_path, monkeypatch
):
    m, _ws = await _manager(tmp_path)
    task = await m.link_session("codex", "sess-abc12345", workspace=None, title=None)
    calls = []

    def _nothing(executor_id, session_id):
        calls.append((executor_id, session_id))
        return None

    monkeypatch.setattr(manager_module, "resolve_session_cwd", _nothing)
    for _ in range(3):
        (row,) = await m.refresh_linked([dict(await m.store.get_task(task["id"]))])

    # The board polls every few seconds; a session whose transcript is gone
    # must not re-glob the harness stores forever.
    assert len(calls) == 1
    assert row["workspace"] == "(unknown folder)"


@pytest.mark.asyncio
async def test_a_failing_repair_leaves_the_row_and_the_listing_alone(tmp_path, monkeypatch):
    m, _ws = await _manager(tmp_path)
    task = await m.link_session("codex", "sess-abc12345", workspace="not a folder", title=None)

    def _boom(executor_id, session_id):
        raise OSError("harness store went away")

    monkeypatch.setattr(manager_module, "resolve_session_cwd", _boom)
    (row,) = await m.refresh_linked([dict(await m.store.get_task(task["id"]))])
    assert row["workspace"] == "not a folder"
    assert row["status"] in ("working", "idle")


@pytest.mark.asyncio
async def test_a_writing_transcript_keeps_a_linked_row_alive_without_a_guard(tmp_path, monkeypatch):
    """The Guard is not the only thing that knows a session is running.

    Liveness is otherwise derived from `tool_call_audit`, which only moves
    while a Guard plugin is relaying. With the plugin unregistered a session
    that is running right now ages into idle and then into done, and the
    confirm before a resume has nothing to go on but the person's word.
    """
    m, ws = await _manager(tmp_path)
    linked = await m.link_session(
        "claude-code", "sess-writing01", workspace=str(ws), title="Outside"
    )
    # Older than the idle cutoff, so without the transcript this row is idle.
    await m.store.update_linked_state(
        linked["id"], status="idle", activity="linked", last_activity_at=None, ended_at=None
    )
    monkeypatch.setattr(manager_module, "session_last_write", lambda *_a, **_k: 3.0)

    items = await m.refresh_linked([dict(linked, origin="linked", archived_at=None)])

    assert items[0]["status"] == "working"
    assert items[0]["transcript_age_seconds"] == 3.0


@pytest.mark.asyncio
async def test_a_stale_transcript_does_not_revive_a_reported_session(tmp_path, monkeypatch):
    """Freshness is a signal; staleness is not the opposite signal.

    Derivation is exercised directly here: a row with no audit at all is
    "working" on its creation time whatever the transcript says, so going
    through refresh_linked would pass without touching this branch.
    """
    m, _ws = await _manager(tmp_path)
    old = (datetime.now(timezone.utc) - timedelta(seconds=99_000)).isoformat()
    monkeypatch.setattr(manager_module, "session_last_write", lambda *_a, **_k: 99_000.0)

    state = m._linked_state(
        {"id": "T1", "executor_id": "claude-code", "session_id": "sess-stale0001"},
        {"last_any": old},
    )

    assert state["status"] != "working"


@pytest.mark.asyncio
async def test_a_writing_transcript_outranks_a_quiet_audit_trail(tmp_path, monkeypatch):
    m, _ws = await _manager(tmp_path)
    old = (datetime.now(timezone.utc) - timedelta(seconds=99_000)).isoformat()
    monkeypatch.setattr(manager_module, "session_last_write", lambda *_a, **_k: 2.0)

    state = m._linked_state(
        {"id": "T1", "executor_id": "claude-code", "session_id": "sess-live00001"},
        {"last_any": old},
    )

    assert state["status"] == "working", "the session is running; only our telemetry stopped"


@pytest.mark.asyncio
async def test_a_reported_end_beats_a_transcript_that_is_still_moving(tmp_path, monkeypatch):
    """`claude --resume` appends to the transcript of the session it reopened,
    so mtime alone would revive a row whose session really did end."""
    m, _ws = await _manager(tmp_path)
    ended = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat()
    monkeypatch.setattr(manager_module, "session_last_write", lambda *_a, **_k: 1.0)

    state = m._linked_state(
        {"id": "T1", "executor_id": "claude-code", "session_id": "sess-ended0001"},
        {"last_any": ended, "last_end": ended},
    )

    assert state["status"] == "done"


@pytest.mark.asyncio
async def test_an_unreadable_transcript_is_no_signal_not_an_error(tmp_path, monkeypatch):
    """Best effort, exactly as the folder lookup is: a board read must never
    fail because a file on disk could not be stat'd."""
    m, ws = await _manager(tmp_path)
    linked = await m.link_session(
        "claude-code", "sess-boom00001", workspace=str(ws), title="Outside"
    )

    def _boom(*_a, **_k):
        raise OSError("nope")

    monkeypatch.setattr(manager_module, "session_last_write", _boom)

    items = await m.refresh_linked([dict(linked, origin="linked", archived_at=None)])

    assert items[0]["transcript_age_seconds"] is None



def test_failed_tool_call_counts_as_activity():
    status, activity = status_from_hook({"hook_event_name": "PostToolUseFailure", "tool_name": "Bash",
                                         "tool_input_preview": "pytest"})
    assert (status, activity) == ("working", "Bash: pytest")
    from securevector.app.terminals.executors import RELAY_EVENTS
    assert "PostToolUseFailure" in RELAY_EVENTS
