"""A re-linked task keeps its whole session history in its views, and a stale
permission wait clears once the agent has moved on."""

import pytest

from securevector.app.terminals import routes as terminal_routes

from .test_manager import _manager

FIRST, SECOND = "sess-first-0001", "sess-second-002"


async def _audit(m, session_id, action="allow", reason="", at="CURRENT_TIMESTAMP"):
    await m.store.db.execute(
        "INSERT INTO tool_call_audit (tool_id, function_name, action, risk, reason, is_essential, "
        f"called_at, session_id, runtime_kind) VALUES ('Bash', 'Bash', ?, 'green', ?, 0, {at}, ?, 'claude-code')",
        (action, reason, session_id),
    )


async def _relinked(tmp_path):
    m, ws = await _manager(tmp_path)
    task = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    tid, token = task["id"], m.hook_token(task["id"])
    await m.handle_hook_event(tid, token, {"hook_event_name": "SessionStart", "session_id": FIRST})
    await m.handle_hook_event(tid, token, {"hook_event_name": "SessionStart", "session_id": SECOND})
    return m, tid, token


@pytest.mark.asyncio
async def test_verdicts_and_counts_cover_session_history(tmp_path):
    m, tid, _ = await _relinked(tmp_path)
    await _audit(m, FIRST, at="'2026-10-08 10:00:00'")
    await _audit(m, FIRST, action="block", at="'2026-10-08 10:01:00'")
    await _audit(m, SECOND, at="'2026-10-08 10:02:00'")

    out = await terminal_routes.list_verdicts(tid, manager=m)
    assert [i["called_at"] for i in out["items"]] == [
        "2026-10-08 10:02:00", "2026-10-08 10:01:00", "2026-10-08 10:00:00"
    ]
    items = [{"id": tid, "session_id": SECOND}]
    await terminal_routes._with_counts(m, items)
    assert items[0]["tool_calls"] == 3 and items[0]["blocked_calls"] == 1


@pytest.mark.asyncio
async def test_egress_blocks_cover_session_history(tmp_path):
    m, tid, _ = await _relinked(tmp_path)
    for n, sid in enumerate((FIRST, SECOND)):
        await m.store.db.execute(
            "INSERT INTO egress_audit (host, operation, kind, action, rule_id, confidence, detector, "
            "tool_name, runtime_kind, session_id, request_id, reason) "
            "VALUES (?, 'read', 'url', 'block', 'r', 'high', 't', 'WebFetch', 'claude-code', ?, ?, 'x')",
            (f"h{n}.example.com", sid, f"req-{n}"),
        )
    out = await terminal_routes.list_verdicts(tid, manager=m)
    assert sorted(b["hosts"][0] for b in out["egress_blocks"]) == ["h0.example.com", "h1.example.com"]


async def _pending(m, session_id, tool="Bash", old=True):
    stamp = "datetime('now','-1 minute')" if old else "CURRENT_TIMESTAMP"
    await m.store.db.execute(
        "INSERT INTO jit_access_requests (id, tool_id, session_id, runtime_kind, rule_source, requested_at) "
        f"VALUES (?, ?, ?, 'claude-code', 'local', {stamp})",
        (f"req-{tool}-{old}", tool, session_id),
    )


async def _status(m, rid):
    return (await m.store.db.fetch_one("SELECT status FROM jit_access_requests WHERE id = ?", (rid,)))["status"]


@pytest.mark.asyncio
@pytest.mark.parametrize("hook", ["PostToolUse", "UserPromptSubmit", "Stop"])
async def test_requests_survive_later_activity(tmp_path, hook):
    m, tid, token = await _relinked(tmp_path)
    await _pending(m, SECOND)
    await m.handle_hook_event(tid, token, {"hook_event_name": hook, "session_id": SECOND, "tool_name": "Bash"})
    assert await _status(m, "req-Bash-True") == "pending"
    assert (await m.store.get_task(tid))["status"] != "blocked"


@pytest.mark.asyncio
async def test_idle_notification_keeps_blocked(tmp_path):
    m, tid, token = await _relinked(tmp_path)
    await m.store.update_status(tid, "blocked", activity="Claude needs your permission")
    await m.handle_hook_event(tid, token, {
        "hook_event_name": "Notification", "session_id": SECOND,
        "notification_type": "idle_prompt", "message": "Claude is waiting for your input",
    })
    assert (await m.store.get_task(tid))["status"] == "blocked"


@pytest.mark.asyncio
async def test_other_notification_does_not_clear_blocked(tmp_path):
    m, tid, token = await _relinked(tmp_path)
    await m.store.update_status(tid, "blocked", activity="Claude needs your permission")
    await m.handle_hook_event(tid, token, {
        "hook_event_name": "Notification", "session_id": SECOND,
        "notification_type": "auth_success", "message": "signed in",
    })
    assert (await m.store.get_task(tid))["status"] == "blocked"
