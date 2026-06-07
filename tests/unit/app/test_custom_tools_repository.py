"""Repository tests for CustomToolsRepository.log_tool_call_audit."""

from __future__ import annotations

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.custom_tools import CustomToolsRepository


async def _build_db(tmp_path) -> DatabaseConnection:
    db = DatabaseConnection(tmp_path / "test.db")
    await run_migrations(db)
    return db


@pytest.mark.asyncio
async def test_log_tool_call_audit_persists_runtime_kind(tmp_path):
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    await repo.log_tool_call_audit(
        tool_id="server-x:tool_a",
        function_name="tool_a",
        action="allow",
        runtime_kind="claude-code",
    )

    conn = await db.connect()
    cur = await conn.execute(
        "SELECT runtime_kind FROM tool_call_audit ORDER BY seq DESC LIMIT 1"
    )
    row = await cur.fetchone()
    assert row["runtime_kind"] == "claude-code"

    await db.disconnect()


@pytest.mark.asyncio
async def test_log_tool_call_audit_defaults_runtime_kind_to_null(tmp_path):
    """Existing callers that don't pass runtime_kind keep writing NULL."""
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    await repo.log_tool_call_audit(
        tool_id="server-x:tool_b",
        function_name="tool_b",
        action="allow",
    )

    conn = await db.connect()
    cur = await conn.execute(
        "SELECT runtime_kind FROM tool_call_audit ORDER BY seq DESC LIMIT 1"
    )
    row = await cur.fetchone()
    assert row["runtime_kind"] is None

    await db.disconnect()


@pytest.mark.asyncio
async def test_runtime_kind_is_not_in_hash_chain(tmp_path):
    """runtime_kind must be metadata, not material — same chain hash regardless of value.

    Hash chain canonical serialization is fixed (see _compute_audit_row_hash) and must
    not change. Two audit rows with identical hash-material fields but different
    runtime_kind values must produce identical row_hash values, matching the v21
    device_id precedent.
    """
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    await repo.log_tool_call_audit(
        tool_id="same:tool",
        function_name="tool",
        action="allow",
        runtime_kind="claude-code",
    )

    conn = await db.connect()
    cur = await conn.execute(
        "SELECT row_hash, called_at FROM tool_call_audit ORDER BY seq DESC LIMIT 1"
    )
    first = await cur.fetchone()

    # Recompute what the hash would be if runtime_kind=None had been passed
    # using the canonical serializer; it must equal the actually-stored row_hash.
    from securevector.app.database.repositories.custom_tools import _compute_audit_row_hash, _AUDIT_GENESIS_HASH
    recomputed = _compute_audit_row_hash(
        prev_hash=_AUDIT_GENESIS_HASH,
        seq=1,
        tool_id="same:tool",
        function_name="tool",
        action="allow",
        risk=None,
        reason=None,
        is_essential=0,
        args_preview=None,
        called_at=first["called_at"],
    )
    assert first["row_hash"] == recomputed

    await db.disconnect()


@pytest.mark.asyncio
async def test_verify_audit_chain_still_passes_with_runtime_kind(tmp_path):
    """The chain verifier must still report OK after writing rows with runtime_kind."""
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    await repo.log_tool_call_audit(
        tool_id="a:one", function_name="one", action="allow",
        runtime_kind="claude-code",
    )
    await repo.log_tool_call_audit(
        tool_id="a:two", function_name="two", action="block",
        runtime_kind=None,
    )
    await repo.log_tool_call_audit(
        tool_id="a:three", function_name="three", action="allow",
        runtime_kind="openclaw",
    )

    result = await repo.verify_audit_chain()
    assert result["ok"] is True
    assert result["total"] == 3

    await db.disconnect()


# ==================== Agent-run trace keys (story #141) ====================


@pytest.mark.asyncio
async def test_trace_keys_derived_from_session_id(tmp_path):
    """A row with a session_id gets a derived trace_id, turn_index 0, NULL parent."""
    from securevector.app.utils.trace_id import derive_trace_id

    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    await repo.log_tool_call_audit(
        tool_id="server-x:tool_a",
        function_name="tool_a",
        action="allow",
        runtime_kind="claude-code",
        session_id="sess-abc",
    )

    conn = await db.connect()
    cur = await conn.execute(
        "SELECT session_id, trace_id, turn_index, parent_span_id "
        "FROM tool_call_audit ORDER BY seq DESC LIMIT 1"
    )
    row = await cur.fetchone()
    assert row["session_id"] == "sess-abc"
    assert row["trace_id"] == derive_trace_id("claude-code", "sess-abc")
    assert row["turn_index"] == 0
    assert row["parent_span_id"] is None

    await db.disconnect()


@pytest.mark.asyncio
async def test_turn_index_increments_per_run_independently(tmp_path):
    """turn_index is monotonic within a run; a second run starts back at 0."""
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    for i in range(3):
        await repo.log_tool_call_audit(
            tool_id=f"a:{i}", function_name=str(i), action="allow",
            runtime_kind="claude-code", session_id="run-1",
        )
    # A different session is a different run.
    await repo.log_tool_call_audit(
        tool_id="b:0", function_name="other", action="allow",
        runtime_kind="claude-code", session_id="run-2",
    )

    conn = await db.connect()
    cur = await conn.execute(
        "SELECT session_id, trace_id, turn_index FROM tool_call_audit ORDER BY seq ASC"
    )
    rows = await cur.fetchall()

    run1 = [r for r in rows if r["session_id"] == "run-1"]
    run2 = [r for r in rows if r["session_id"] == "run-2"]
    assert [r["turn_index"] for r in run1] == [0, 1, 2]
    assert [r["turn_index"] for r in run2] == [0]
    # All rows in one run share one trace_id; the two runs differ.
    assert len({r["trace_id"] for r in run1}) == 1
    assert run1[0]["trace_id"] != run2[0]["trace_id"]

    await db.disconnect()


@pytest.mark.asyncio
async def test_trace_id_null_without_session_id(tmp_path):
    """No session_id → orphan single-span run: trace_id and turn_index stay NULL."""
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    await repo.log_tool_call_audit(
        tool_id="x:y", function_name="y", action="allow", runtime_kind="claude-code",
    )

    conn = await db.connect()
    cur = await conn.execute(
        "SELECT trace_id, turn_index FROM tool_call_audit ORDER BY seq DESC LIMIT 1"
    )
    row = await cur.fetchone()
    assert row["trace_id"] is None
    assert row["turn_index"] is None

    await db.disconnect()


@pytest.mark.asyncio
async def test_trace_keys_are_not_in_hash_chain(tmp_path):
    """trace keys must be metadata, not material — same row_hash regardless of session.

    Mirrors test_runtime_kind_is_not_in_hash_chain (device_id / runtime_kind
    precedent). A row written WITH session-derived trace keys must hash to
    exactly what the canonical serializer produces with none of them.
    """
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    await repo.log_tool_call_audit(
        tool_id="same:tool", function_name="tool", action="allow",
        runtime_kind="claude-code", session_id="sess-xyz",
    )

    conn = await db.connect()
    cur = await conn.execute(
        "SELECT row_hash, called_at FROM tool_call_audit ORDER BY seq DESC LIMIT 1"
    )
    first = await cur.fetchone()

    from securevector.app.database.repositories.custom_tools import (
        _compute_audit_row_hash,
        _AUDIT_GENESIS_HASH,
    )
    recomputed = _compute_audit_row_hash(
        prev_hash=_AUDIT_GENESIS_HASH,
        seq=1,
        tool_id="same:tool",
        function_name="tool",
        action="allow",
        risk=None,
        reason=None,
        is_essential=0,
        args_preview=None,
        called_at=first["called_at"],
    )
    assert first["row_hash"] == recomputed

    await db.disconnect()


@pytest.mark.asyncio
async def test_verify_audit_chain_passes_with_trace_keys(tmp_path):
    """The chain verifier still reports OK after writing rows with trace keys."""
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    await repo.log_tool_call_audit(
        tool_id="a:1", function_name="1", action="allow",
        runtime_kind="claude-code", session_id="s1",
    )
    await repo.log_tool_call_audit(
        tool_id="a:2", function_name="2", action="block",
        runtime_kind="codex", session_id="s1",
    )
    await repo.log_tool_call_audit(
        tool_id="a:3", function_name="3", action="allow",
    )

    result = await repo.verify_audit_chain()
    assert result["ok"] is True
    assert result["total"] == 3

    await db.disconnect()
