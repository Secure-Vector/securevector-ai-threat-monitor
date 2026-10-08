"""A session's Tool calls list includes the calls the egress check refused.

The egress row is the record: it is read from egress_audit and returned
beside the tool-call verdicts, never copied into tool_call_audit.
"""

import pytest

from securevector.app.terminals import routes as terminal_routes

from .test_manager import _manager


async def _egress_block(m, session_id, host, rule_id="preset.contained", request_id="req-1"):
    await m.store.db.execute(
        "INSERT INTO egress_audit (host, operation, kind, action, rule_id, confidence, detector, "
        "tool_name, runtime_kind, session_id, request_id, reason) "
        "VALUES (?, 'read', 'url', 'block', ?, 'high', 'test', 'WebFetch', 'claude-code', ?, ?, 'not listed')",
        (host, rule_id, session_id, request_id),
    )


@pytest.mark.asyncio
async def test_verdicts_list_egress_blocks_without_a_second_audit_row(tmp_path):
    m, ws = await _manager(tmp_path)
    task = await m.spawn("claude-code", str(ws), title=None, origin="ui")
    tid, token = task["id"], m.hook_token(task["id"])
    sid = "sess-egress-0001"
    await m.handle_hook_event(tid, token, {"hook_event_name": "SessionStart", "session_id": sid})
    await _egress_block(m, sid, "a.example.com")
    await _egress_block(m, "sess-other-0002", "b.example.com", request_id="req-2")

    out = await terminal_routes.list_verdicts(tid, manager=m)
    assert out["items"] == []
    assert out["session_history"] == []
    blocks = out["egress_blocks"]
    assert len(blocks) == 1
    assert blocks[0]["action"] == "block" and blocks[0]["source"] == "egress"
    assert blocks[0]["hosts"] == ["a.example.com"]
    assert blocks[0]["rule_ids"] == ["preset.contained"]
    assert blocks[0]["reason"] == "Egress blocked: a.example.com (preset.contained)"
    assert blocks[0]["called_at"]
    row = await m.store.db.fetch_one("SELECT COUNT(*) AS n FROM tool_call_audit")
    assert row["n"] == 0
