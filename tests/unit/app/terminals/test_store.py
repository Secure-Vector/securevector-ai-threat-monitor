import asyncio

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.terminals.store import TerminalStore


async def _store(tmp_path) -> TerminalStore:
    db = DatabaseConnection(tmp_path / "t.db")
    await run_migrations(db)
    return TerminalStore(db)


@pytest.mark.asyncio
async def test_migration_creates_tables(tmp_path):
    db = DatabaseConnection(tmp_path / "t.db")
    version = await run_migrations(db)
    assert version >= 48
    rows = await db.fetch_all(
        "SELECT name FROM sqlite_master WHERE name IN ('terminal_tasks','terminal_events')"
    )
    assert {r["name"] for r in rows} == {"terminal_tasks", "terminal_events"}


@pytest.mark.asyncio
async def test_task_lifecycle(tmp_path):
    store = await _store(tmp_path)
    await store.create_task(
        "t1", executor_id="claude-code", workspace="/w", title="Fix tests", pid=123
    )
    task = await store.get_task("t1")
    assert task["status"] == "starting" and task["pid"] == 123
    await store.set_session("t1", "sess-1")
    await store.update_status("t1", "working", activity="Bash: ls -la")
    await store.set_exit("t1", 0)
    task = await store.get_task("t1")
    assert task["session_id"] == "sess-1" and task["status"] == "done" and task["exit_code"] == 0
    assert task["activity"] == "Bash: ls -la"
    assert task["ended_at"] is not None


@pytest.mark.asyncio
async def test_list_tasks_newest_first_and_running_filter(tmp_path):
    store = await _store(tmp_path)
    await store.create_task("a", executor_id="claude-code", workspace="/w", title=None, pid=1)
    await store.create_task("b", executor_id="claude-code", workspace="/w", title=None, pid=2)
    await store.set_exit("a", 1)
    ids = [t["id"] for t in await store.list_tasks()]
    assert ids == ["b", "a"]
    assert [t["id"] for t in await store.list_tasks(running_only=True)] == ["b"]


@pytest.mark.asyncio
async def test_archive_hides_finished_task_but_keeps_its_audit(tmp_path):
    store = await _store(tmp_path)
    await store.create_task("finished", executor_id="claude-code", workspace="/w", title=None, pid=1)
    await store.set_exit("finished", 0)
    await store.add_event("finished", kind="exit", origin="pty", detail="0")

    assert await store.archive_task("finished") is True
    assert await store.list_tasks() == []
    assert (await store.get_task("finished"))["archived_at"] is not None
    assert [event["kind"] for event in await store.list_events("finished")] == ["exit", "archived"]


@pytest.mark.asyncio
async def test_archive_refuses_a_running_task(tmp_path):
    store = await _store(tmp_path)
    await store.create_task("running", executor_id="claude-code", workspace="/w", title=None, pid=1)
    with pytest.raises(ValueError, match="Stop the task"):
        await store.archive_task("running")


@pytest.mark.asyncio
async def test_mark_running_interrupted(tmp_path):
    store = await _store(tmp_path)
    await store.create_task("a", executor_id="claude-code", workspace="/w", title=None, pid=1)
    await store.create_task("b", executor_id="claude-code", workspace="/w", title=None, pid=2)
    await store.set_exit("b", 0)
    interrupted = await store.mark_running_interrupted()
    assert [t["id"] for t in interrupted] == ["a"]
    assert interrupted[0]["status"] == "interrupted"
    assert interrupted[0]["ended_at"] is not None
    assert (await store.get_task("a"))["status"] == "interrupted"
    assert (await store.get_task("b"))["status"] == "done"


@pytest.mark.asyncio
async def test_events_are_hash_chained_and_verifiable(tmp_path):
    store = await _store(tmp_path)
    await store.create_task("a", executor_id="claude-code", workspace="/w", title=None, pid=1)
    await store.add_event("a", kind="spawn", origin="ui", detail="claude-code in /w")
    await store.add_event("a", kind="input", origin="ui", detail="line 1, 4 bytes")
    events = await store.list_events("a")
    assert [e["kind"] for e in events] == ["spawn", "input"]
    assert events[0]["prev_hash"] is None
    assert events[1]["prev_hash"] == events[0]["row_hash"]
    assert await store.verify_chain() == {"ok": True, "checked": 2, "first_bad_seq": None}
    await store.db.execute("UPDATE terminal_events SET detail='tampered' WHERE seq=1")
    result = await store.verify_chain()
    assert result["ok"] is False and result["first_bad_seq"] == 1


@pytest.mark.asyncio
async def test_add_event_concurrent_calls_keep_chain_intact(tmp_path):
    store = await _store(tmp_path)
    await store.create_task("a", executor_id="claude-code", workspace="/w", title=None, pid=1)
    await asyncio.gather(
        *(store.add_event("a", kind="input", origin="ui", detail=f"line {i}") for i in range(8))
    )
    events = await store.list_events("a")
    assert [e["seq"] for e in events] == list(range(1, 9))
    assert await store.verify_chain() == {"ok": True, "checked": 8, "first_bad_seq": None}


@pytest.mark.asyncio
async def test_set_exit_none_is_failed_with_no_exit_code(tmp_path):
    store = await _store(tmp_path)
    await store.create_task("a", executor_id="claude-code", workspace="/w", title=None, pid=1)
    await store.set_exit("a", None)
    task = await store.get_task("a")
    assert task["status"] == "failed"
    assert task["exit_code"] is None


@pytest.mark.asyncio
async def test_update_status_truncates_activity_to_200_chars(tmp_path):
    store = await _store(tmp_path)
    await store.create_task("a", executor_id="claude-code", workspace="/w", title=None, pid=1)
    await store.update_status("a", "working", activity="x" * 300)
    task = await store.get_task("a")
    assert len(task["activity"]) == 200


@pytest.mark.asyncio
async def test_list_verdicts_filters_by_session_and_orders_newest_first(tmp_path):
    store = await _store(tmp_path)
    await store.db.execute(
        "INSERT INTO tool_call_audit (tool_id, function_name, action, risk, reason, is_essential, "
        "args_preview, runtime_kind, session_id) VALUES ('bash', 'Bash', 'allow', 'green', 'ok', 0, "
        "'ls', 'claude-code', 'sess-1')"
    )
    await store.db.execute(
        "INSERT INTO tool_call_audit (tool_id, function_name, action, risk, reason, is_essential, "
        "args_preview, runtime_kind, session_id) VALUES ('bash', 'Bash', 'block', 'red', 'rm on root', 0, "
        "'rm -rf /', 'claude-code', 'sess-1')"
    )
    await store.db.execute(
        "INSERT INTO tool_call_audit (tool_id, function_name, action, risk, reason, is_essential, "
        "args_preview, runtime_kind, session_id) VALUES ('bash', 'Bash', 'allow', 'green', 'ok', 0, "
        "'ls', 'claude-code', 'sess-other')"
    )
    items = await store.list_verdicts("sess-1")
    assert [i["action"] for i in items] == ["block", "allow"]
    assert await store.list_verdicts("sess-1", limit=1) == items[:1]
    assert await store.list_verdicts("sess-does-not-exist") == []
