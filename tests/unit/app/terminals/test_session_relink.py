"""A task follows its harness into a new session.

Claude Code `/clear` starts a new session id inside the same terminal and
announces it with SessionStart. The task re-links to the new id, keeps the
old one in its history, and the old id is not offered as an unlinked session.
"""

import pytest

from securevector.app.terminals.store import SESSION_RELINKED

from .test_manager import _manager


async def _audit(m, session_id, runtime_kind="claude-code"):
    await m.store.db.execute(
        "INSERT INTO tool_call_audit (tool_id, function_name, action, risk, reason, is_essential, "
        "called_at, session_id, runtime_kind) "
        "VALUES ('Bash', 'Bash', 'allow', 'green', '', 0, CURRENT_TIMESTAMP, ?, ?)",
        (session_id, runtime_kind),
    )


@pytest.mark.asyncio
async def test_session_start_with_new_id_relinks_and_keeps_history(tmp_path):
    m, ws = await _manager(tmp_path)
    task = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    tid, token = task["id"], m.hook_token(task["id"])
    first, second = "sess-first-0001", "sess-second-002"

    await m.handle_hook_event(tid, token, {"hook_event_name": "SessionStart", "session_id": first})
    assert (await m.store.get_task(tid))["session_id"] == first

    await m.handle_hook_event(tid, token, {"hook_event_name": "SessionStart", "session_id": second})
    assert (await m.store.get_task(tid))["session_id"] == second
    assert await m.store.session_history(tid) == [first]
    events = [e for e in await m.store.list_events(tid) if e["kind"] == SESSION_RELINKED]
    assert len(events) == 1 and events[0]["detail"] == first
    assert (await m.store.verify_chain()).get("ok", True)

    # Same id again is a no-op, not a second history entry.
    await m.handle_hook_event(tid, token, {"hook_event_name": "SessionStart", "session_id": second})
    assert await m.store.session_history(tid) == [first]


@pytest.mark.asyncio
async def test_only_session_start_moves_the_task(tmp_path):
    m, ws = await _manager(tmp_path)
    task = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    tid, token = task["id"], m.hook_token(task["id"])
    await m.handle_hook_event(tid, token, {"hook_event_name": "SessionStart", "session_id": "sess-first-0001"})
    await m.handle_hook_event(
        tid, token, {"hook_event_name": "PreToolUse", "session_id": "sess-other-0003", "tool_name": "Bash"}
    )
    assert (await m.store.get_task(tid))["session_id"] == "sess-first-0001"
    # A malformed id on SessionStart is ignored too.
    await m.handle_hook_event(tid, token, {"hook_event_name": "SessionStart", "session_id": "bad id; --"})
    assert (await m.store.get_task(tid))["session_id"] == "sess-first-0001"
    # And a wrong token changes nothing.
    assert await m.handle_hook_event(
        tid, "wrong", {"hook_event_name": "SessionStart", "session_id": "sess-evil-00004"}
    ) is False
    assert (await m.store.get_task(tid))["session_id"] == "sess-first-0001"
    assert await m.store.session_history(tid) == []


@pytest.mark.asyncio
async def test_relink_only_moves_its_own_task_and_old_session_is_not_offered(tmp_path):
    m, ws = await _manager(tmp_path)
    a = await m.spawn("claude-code", str(ws), title="a", origin="ui")
    b = await m.spawn("claude-code", str(ws), title="b", origin="ui")
    await m.handle_hook_event(a["id"], m.hook_token(a["id"]),
                              {"hook_event_name": "SessionStart", "session_id": "sess-a-old-0001"})
    await m.handle_hook_event(b["id"], m.hook_token(b["id"]),
                              {"hook_event_name": "SessionStart", "session_id": "sess-b-0000002"})
    await _audit(m, "sess-a-old-0001")
    await _audit(m, "sess-loose-00009")  # control: a truly unlinked session
    await m.handle_hook_event(a["id"], m.hook_token(a["id"]),
                              {"hook_event_name": "SessionStart", "session_id": "sess-a-new-0003"})
    assert (await m.store.get_task(a["id"]))["session_id"] == "sess-a-new-0003"
    assert (await m.store.get_task(b["id"]))["session_id"] == "sess-b-0000002"
    # The new session resolves to task a only; b is untouched.
    owner = await m.store.task_for_session("sess-a-new-0003")
    assert owner and owner["id"] == a["id"]
    offered = {s["session_id"] for s in await m.store.unlinked_sessions()}
    assert "sess-a-old-0001" not in offered
    assert "sess-loose-00009" in offered


@pytest.mark.asyncio
async def test_relink_to_a_session_held_by_another_task_is_refused(tmp_path, caplog):
    m, ws = await _manager(tmp_path)
    a = await m.spawn("claude-code", str(ws), title="a", origin="ui")
    b = await m.spawn("claude-code", str(ws), title="b", origin="ui")
    ta, tb = m.hook_token(a["id"]), m.hook_token(b["id"])
    await m.handle_hook_event(a["id"], ta, {"hook_event_name": "SessionStart", "session_id": "sess-a-0000001"})
    await m.handle_hook_event(b["id"], tb, {"hook_event_name": "SessionStart", "session_id": "sess-b-0000001"})
    # Current session of another task.
    await m.handle_hook_event(a["id"], ta, {"hook_event_name": "SessionStart", "session_id": "sess-b-0000001"})
    assert (await m.store.get_task(a["id"]))["session_id"] == "sess-a-0000001"
    # A session in another task's history.
    await m.handle_hook_event(b["id"], tb, {"hook_event_name": "SessionStart", "session_id": "sess-b-0000002"})
    await m.handle_hook_event(a["id"], ta, {"hook_event_name": "SessionStart", "session_id": "sess-b-0000001"})
    assert (await m.store.get_task(a["id"]))["session_id"] == "sess-a-0000001"
    assert await m.store.session_history(a["id"]) == []
    assert "refused session re-link" in caplog.text
