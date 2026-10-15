"""Approvals still waiting for a session close when the session stops or is removed.

Owner decision 2026-10-14: a step-up hold or an ordinary request for a task
that exited or was archived moves out of pending as "no longer needed",
with one audit row each, so nothing can be approved for a session that no
longer runs. Requests for other sessions are left alone.
"""

import asyncio

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.jit_access import JitAccessRepository
from securevector.app.services import response_rungs

from .test_manager import _manager

SID = "sess-close-0001"
OTHER = "sess-other-0002"


async def _file(db, session_id):
    jit = JitAccessRepository(db)
    hold = await jit.create_request(tool_id="Bash", rule_source=response_rungs.RUNG_SOURCE,
                                    function_name="Bash", runtime_kind="claude-code",
                                    session_id=session_id, justification="Session at step-up")
    plain = await jit.create_request(tool_id="WebFetch", rule_source="local", function_name="WebFetch",
                                     runtime_kind="claude-code", session_id=session_id)
    return hold["id"], plain["id"]


async def _status(db, rid):
    return dict(await db.fetch_one("SELECT status, decided_by FROM jit_access_requests WHERE id = ?", (rid,)))


async def _audit_rows(db, session_id):
    rows = await db.fetch_all(
        "SELECT * FROM tool_call_audit WHERE tool_id = 'sv.decision' "
        "AND function_name = 'decision.not_needed' AND session_id = ?",
        (session_id,),
    )
    return [dict(r) for r in rows or []]


async def _until_closed(db, rid, timeout=5.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if (await _status(db, rid))["status"] != "pending":
            return
        await asyncio.sleep(0.02)
    raise AssertionError(f"request {rid} stayed pending")


async def _linked(m, ws):
    task = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    tid, token = task["id"], m.hook_token(task["id"])
    await m.handle_hook_event(tid, token, {"hook_event_name": "SessionStart", "session_id": SID})
    return tid


def _assert_closed(st):
    assert st == {"status": "expired", "decided_by": "not_needed"}


@pytest.mark.asyncio
async def test_exit_closes_pending_hold_and_request(tmp_path):
    m, ws = await _manager(tmp_path)
    db = m.store.db
    tid = await _linked(m, ws)
    hold, plain = await _file(db, SID)
    other_hold, other_plain = await _file(db, OTHER)
    m.host.exit(tid, 0)
    await _until_closed(db, hold)
    await _until_closed(db, plain)
    _assert_closed(await _status(db, hold))
    _assert_closed(await _status(db, plain))
    audits = await _audit_rows(db, SID)
    assert len(audits) == 2
    previews = " ".join(a["args_preview"] for a in audits)
    assert "class=hold" in previews and "class=jit" in previews and f"task={tid}" in previews
    # Another session's requests stay pending and get no audit row.
    assert (await _status(db, other_hold))["status"] == "pending"
    assert (await _status(db, other_plain))["status"] == "pending"
    assert await _audit_rows(db, OTHER) == []


@pytest.mark.asyncio
async def test_archive_closes_pending_hold_and_request(tmp_path):
    m, ws = await _manager(tmp_path)
    db = m.store.db
    tid = await _linked(m, ws)
    m.host.exit(tid, 0)
    for _ in range(250):
        if (await m.store.get_task(tid))["status"] == "done":
            break
        await asyncio.sleep(0.02)
    await asyncio.sleep(0.1)  # let the exit pass finish before filing late asks
    hold, plain = await _file(db, SID)
    other_hold, other_plain = await _file(db, OTHER)
    assert await m.archive_task(tid) is True
    _assert_closed(await _status(db, hold))
    _assert_closed(await _status(db, plain))
    assert len(await _audit_rows(db, SID)) == 2
    assert (await _status(db, other_hold))["status"] == "pending"
    assert (await _status(db, other_plain))["status"] == "pending"


@pytest.mark.asyncio
async def test_close_with_nothing_pending_returns_zero(tmp_path):
    db = DatabaseConnection(tmp_path / "t.db")
    await run_migrations(db)
    task = {"id": "task-1", "session_id": SID, "executor_id": "claude-code"}
    assert await response_rungs.close_pending_for_task(db, task, reason="ended") == 0
    assert await response_rungs.close_pending_for_task(db, {}, reason="archived") == 0
    assert await response_rungs.close_pending_for_task(db, None, reason="ended") == 0


@pytest.mark.asyncio
async def test_close_never_raises_without_a_table(tmp_path):
    db = DatabaseConnection(tmp_path / "bare.db")
    task = {"id": "task-1", "session_id": SID, "executor_id": "claude-code"}
    assert await response_rungs.close_pending_for_task(db, task, reason="ended") == 0


async def _until_done(m, tid):
    for _ in range(250):
        if (await m.store.get_task(tid))["status"] == "done":
            break
        await asyncio.sleep(0.02)
    await asyncio.sleep(0.1)


@pytest.mark.asyncio
async def test_exit_closes_requests_of_relinked_history(tmp_path):
    m, ws = await _manager(tmp_path)
    db = m.store.db
    task = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    tid, token = task["id"], m.hook_token(task["id"])
    await m.handle_hook_event(tid, token, {"hook_event_name": "SessionStart", "session_id": OTHER})
    await m.handle_hook_event(tid, token, {"hook_event_name": "SessionStart", "session_id": SID})
    old_hold, old_plain = await _file(db, OTHER)
    hold, plain = await _file(db, SID)
    m.host.exit(tid, 0)
    for rid in (old_hold, old_plain, hold, plain):
        await _until_closed(db, rid)
        _assert_closed(await _status(db, rid))
    assert len(await _audit_rows(db, OTHER)) == 2
    assert len(await _audit_rows(db, SID)) == 2


@pytest.mark.asyncio
async def test_archive_leaves_a_live_resumed_session_alone(tmp_path):
    m, ws = await _manager(tmp_path)
    db = m.store.db
    tid = await _linked(m, ws)
    m.host.exit(tid, 0)
    await _until_done(m, tid)
    # Another task resumed the same session and is still running.
    await m.store.create_task(
        "resumed", executor_id="claude-code", workspace=str(ws), title=None, pid=None,
        origin="linked", status="working", session_id=SID,
    )
    hold, plain = await _file(db, SID)
    assert await m.archive_task(tid) is True
    assert (await _status(db, hold))["status"] == "pending"
    assert (await _status(db, plain))["status"] == "pending"
    assert await _audit_rows(db, SID) == []


@pytest.mark.asyncio
async def test_archiving_a_running_linked_task_leaves_requests_pending(tmp_path):
    m, ws = await _manager(tmp_path)
    db = m.store.db
    await m.store.create_task(
        "adopted", executor_id="claude-code", workspace=str(ws), title=None, pid=None,
        origin="linked", status="working", session_id=SID,
    )
    hold, plain = await _file(db, SID)
    assert await m.archive_task("adopted") is True
    assert (await _status(db, hold))["status"] == "pending"
    assert (await _status(db, plain))["status"] == "pending"
    assert await _audit_rows(db, SID) == []
