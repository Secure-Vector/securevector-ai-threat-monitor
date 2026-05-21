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
