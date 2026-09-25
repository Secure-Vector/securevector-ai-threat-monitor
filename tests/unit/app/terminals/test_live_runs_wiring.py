"""Live Runs emits from the task manager: every transition, once, plus a heartbeat.

A capture sink stands in for the fleet transport. The payloads it receives
are the same metadata-only dicts the fleet sink would queue.
"""

import asyncio

import pytest

from securevector.app.terminals import live_runs
from securevector.app.terminals.manager import TerminalManager
from tests.unit.app.terminals.test_manager import FakeHost, _manager, _until_done

KEY = b"a-fixed-test-salt-not-the-real-one"


def _tid(task_id):
    return live_runs._digest(task_id, domain="task", key=KEY)


@pytest.fixture
def sent(monkeypatch):
    captured = []

    async def sink(payload):
        captured.append(payload)

    async def connected():
        return True

    live_runs.set_salt(KEY)
    monkeypatch.setattr(live_runs, "cloud_connected", connected)
    monkeypatch.setattr(live_runs, "fleet_enrolled", connected)
    live_runs.set_sink(sink)
    yield captured
    live_runs.set_sink(None)
    live_runs.set_salt(None)


async def _drain():
    for _ in range(10):
        pending = list(live_runs._pending)
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_hook_emits_once_per_status_change(tmp_path, sent):
    m, ws = await _manager(tmp_path)
    try:
        task = await m.spawn("claude-code", str(ws), title="Secret client work", origin="ui")
        tid, token = task["id"], m.hook_token(task["id"])
        tool = {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input_preview": "ls"}
        await m.handle_hook_event(tid, token, tool)
        await m.handle_hook_event(tid, token, tool)
        await m.handle_hook_event(tid, token, {"hook_event_name": "UserPromptSubmit"})
        await m.handle_hook_event(tid, token, {"hook_event_name": "Stop"})
        await m.handle_hook_event(tid, token, {"hook_event_name": "Stop"})
        await _drain()
        assert [(p["event"], p["status"]) for p in sent] == [
            ("spawn", "starting"),
            ("hook", "working"),
            ("hook", "idle"),
        ]
        assert all(p["task_id"] == _tid(tid) for p in sent)
        assert sent[1]["event_origin"] == "hook"
    finally:
        await m.stop_heartbeat()


@pytest.mark.asyncio
async def test_stop_exit_and_archive_each_emit(tmp_path, sent):
    m, ws = await _manager(tmp_path)
    try:
        task = await m.spawn("claude-code", str(ws), title=None, origin="ui")
        tid = task["id"]
        await m.stop(tid, origin="ui")
        await _until_done_or_failed(m.store, tid)
        assert await m.archive_task(tid) is True
        await _drain()
        events = [p["event"] for p in sent]
        assert events == ["spawn", "stop", "exit", "archived"]
        exit_event = sent[2]
        assert exit_event["event_origin"] == "process"
        assert exit_event["status"] == "failed" and exit_event["exit_code"] == -15
        assert exit_event["ended_at"] is not None
        assert sent[3]["archived_at"] is not None
    finally:
        await m.stop_heartbeat()


@pytest.mark.asyncio
async def test_clean_exit_emits_done(tmp_path, sent):
    m, ws = await _manager(tmp_path)
    try:
        task = await m.spawn("claude-code", str(ws), title=None, origin="ui")
        m.host.exit(task["id"], 0)
        await _until_done(m.store, task["id"])
        await _drain()
        assert (sent[-1]["event"], sent[-1]["status"], sent[-1]["exit_code"]) == ("exit", "done", 0)
    finally:
        await m.stop_heartbeat()


@pytest.mark.asyncio
async def test_startup_interrupted_is_emitted(tmp_path, monkeypatch):
    m, ws = await _manager(tmp_path)  # no sink yet: nothing is sent
    task = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    assert m._heartbeat is None

    captured = []

    async def sink(payload):
        captured.append(payload)

    async def connected():
        return True

    monkeypatch.setattr(live_runs, "cloud_connected", connected)
    live_runs.set_salt(KEY)
    live_runs.set_sink(sink)
    try:
        m2 = TerminalManager(FakeHost(), m.store, m.settings)
        await m2.start(asyncio.get_running_loop())
        await _drain()
        assert [(p["event"], p["event_origin"], p["status"], p["task_id"]) for p in captured] == [
            ("interrupted", "startup", "interrupted", _tid(task["id"]))
        ]
        await m2.stop_heartbeat()
    finally:
        live_runs.set_sink(None)
        live_runs.set_salt(None)


@pytest.mark.asyncio
async def test_heartbeat_loop_beats_for_running_tasks_and_stops(tmp_path, sent):
    m, ws = await _manager(tmp_path)
    assert m._heartbeat is not None and not m._heartbeat.done()
    await m.stop_heartbeat()
    assert m._heartbeat is None

    task = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    m.start_heartbeat(interval=0.02)
    handle = m._heartbeat
    m.start_heartbeat(interval=0.02)  # a second call does not start a second loop
    assert m._heartbeat is handle
    await asyncio.sleep(0.15)
    await _drain()
    beats = [p for p in sent if p["event"] == "heartbeat"]
    assert len(beats) >= 2
    assert all(b["task_id"] == _tid(task["id"]) and b["status"] == "starting" for b in beats)

    await m.stop_heartbeat()
    assert handle.cancelled() or handle.done()
    count = len(sent)
    await asyncio.sleep(0.08)
    await _drain()
    assert len(sent) == count


@pytest.mark.asyncio
async def test_heartbeat_skips_finished_tasks(tmp_path, sent):
    m, ws = await _manager(tmp_path)
    await m.stop_heartbeat()
    task = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    m.host.exit(task["id"], 0)
    await _until_done(m.store, task["id"])
    m.start_heartbeat(interval=0.02)
    try:
        await asyncio.sleep(0.1)
        await _drain()
        assert not [p for p in sent if p["event"] == "heartbeat"]
    finally:
        await m.stop_heartbeat()


def test_heartbeat_is_a_known_event_kind():
    assert "heartbeat" in live_runs.EVENT_KINDS
    assert live_runs.HEARTBEAT_SECONDS == 60.0


async def _until_done_or_failed(store, task_id, timeout=5.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if (await store.get_task(task_id))["status"] in ("done", "failed"):
            return
        await asyncio.sleep(0.02)
    raise AssertionError(f"task {task_id} never finished")


@pytest.mark.asyncio
async def test_heartbeat_sends_nothing_when_not_enrolled(tmp_path, sent, monkeypatch):
    async def not_enrolled():
        return False

    monkeypatch.setattr(live_runs, "fleet_enrolled", not_enrolled)
    m, ws = await _manager(tmp_path)
    await m.stop_heartbeat()
    await m.spawn("claude-code", str(ws), title=None, origin="ui")
    m.start_heartbeat(interval=0.02)
    try:
        await asyncio.sleep(0.1)
        await _drain()
        assert not [p for p in sent if p["event"] == "heartbeat"]
    finally:
        await m.stop_heartbeat()


@pytest.mark.asyncio
async def test_emitted_at_follows_transition_order_not_run_order(monkeypatch):
    """A hook emit scheduled before the exit is stamped earlier, even when
    the exit's emit happens to run first."""
    captured = []
    gate = asyncio.Event()
    calls = []

    async def connected():
        # The first emit (the hook) is held up before its payload is built.
        calls.append(1)
        if len(calls) == 1:
            await gate.wait()
        return True

    async def sink(payload):
        captured.append(payload)

    monkeypatch.setattr(live_runs, "cloud_connected", connected)
    live_runs.set_salt(KEY)
    live_runs.set_sink(sink)
    try:
        row = {"id": "a1b2c3d4e5f6", "executor_id": "claude-code", "status": "working"}
        hook = live_runs.emit_nowait(row, "hook", origin="hook")
        await asyncio.sleep(0.01)
        exited = live_runs.emit_nowait(dict(row, status="done", exit_code=0), "exit", origin="process")
        await asyncio.wait_for(exited, 1.0)
        gate.set()
        await asyncio.wait_for(hook, 1.0)
        assert [p["event"] for p in captured] == ["exit", "hook"]
        by_event = {p["event"]: p for p in captured}
        assert by_event["hook"]["emitted_at"] < by_event["exit"]["emitted_at"]
    finally:
        live_runs.set_sink(None)
        live_runs.set_salt(None)


@pytest.mark.asyncio
async def test_drain_pending_waits_for_scheduled_emits(monkeypatch):
    captured = []

    async def connected():
        return True

    async def slow_sink(payload):
        await asyncio.sleep(0.05)
        captured.append(payload)

    monkeypatch.setattr(live_runs, "cloud_connected", connected)
    live_runs.set_salt(KEY)
    live_runs.set_sink(slow_sink)
    try:
        row = {"id": "a1b2c3d4e5f6", "executor_id": "claude-code", "status": "working"}
        for _ in range(3):
            live_runs.emit_nowait(row, "stop", origin="shutdown")
        assert captured == []
        await live_runs.drain_pending(timeout=2.0)
        assert len(captured) == 3
        assert not [t for t in live_runs._pending if not t.done()]
    finally:
        live_runs.set_sink(None)
        live_runs.set_salt(None)


def test_shutdown_stops_the_heartbeat_before_stopping_tasks_and_drains_before_uninstall():
    from pathlib import Path

    src = (
        Path(__file__).resolve().parents[4] / "src/securevector/app/server/app.py"
    ).read_text(encoding="utf-8")
    assert src.index("stop_heartbeat()") < src.index('stop_all(origin="shutdown")')
    assert src.index("drain_pending(") < src.index("fleet_task_events.uninstall()")
