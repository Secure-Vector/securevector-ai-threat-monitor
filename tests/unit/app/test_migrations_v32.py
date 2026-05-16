"""Migration v32: runtime_kind column on tool_call_audit."""

from __future__ import annotations

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import (
    apply_initial_schema,
    apply_migration,
    get_current_version,
)


async def _build_db_at_v31(tmp_path) -> DatabaseConnection:
    """Fresh DB migrated through v31 (the version before v32)."""
    db = DatabaseConnection(tmp_path / "test.db")
    await apply_initial_schema(db)
    for v in range(2, 32):
        await apply_migration(db, v)
    assert await get_current_version(db) == 31
    return db


async def _table_columns(db: DatabaseConnection, table: str) -> dict[str, tuple]:
    conn = await db.connect()
    cur = await conn.execute(f"PRAGMA table_info({table})")
    return {row[1]: tuple(row) for row in await cur.fetchall()}


async def _indexes(db: DatabaseConnection, table: str) -> set[str]:
    conn = await db.connect()
    cur = await conn.execute(f"PRAGMA index_list({table})")
    return {row[1] for row in await cur.fetchall()}


@pytest.mark.asyncio
async def test_v32_adds_runtime_kind_column(tmp_path):
    db = await _build_db_at_v31(tmp_path)

    before = await _table_columns(db, "tool_call_audit")
    assert "runtime_kind" not in before

    await apply_migration(db, 32)

    after = await _table_columns(db, "tool_call_audit")
    assert "runtime_kind" in after
    # cid, name, type, notnull, dflt_value, pk
    _, _, col_type, notnull, default, _ = after["runtime_kind"]
    assert col_type == "TEXT"
    assert notnull == 0
    # SQLite stores `DEFAULT NULL` as the literal string 'NULL' in
    # PRAGMA table_info; an implicit default shows as None. Either is fine.
    assert default in (None, "NULL")

    await db.disconnect()


@pytest.mark.asyncio
async def test_v32_creates_runtime_kind_index(tmp_path):
    db = await _build_db_at_v31(tmp_path)
    await apply_migration(db, 32)

    indexes = await _indexes(db, "tool_call_audit")
    assert "idx_tool_call_audit_runtime_kind" in indexes

    await db.disconnect()


@pytest.mark.asyncio
async def test_v32_is_idempotent(tmp_path):
    db = await _build_db_at_v31(tmp_path)
    await apply_migration(db, 32)
    # Re-applying on a DB that already has the column must not raise.
    await apply_migration(db, 32)

    cols = await _table_columns(db, "tool_call_audit")
    assert "runtime_kind" in cols

    await db.disconnect()


@pytest.mark.asyncio
async def test_v32_records_schema_version(tmp_path):
    db = await _build_db_at_v31(tmp_path)
    await apply_migration(db, 32)

    assert await get_current_version(db) == 32

    await db.disconnect()


@pytest.mark.asyncio
async def test_v32_accepts_runtime_kind_insert_and_null(tmp_path):
    db = await _build_db_at_v31(tmp_path)
    await apply_migration(db, 32)
    conn = await db.connect()

    await conn.execute(
        "INSERT INTO tool_call_audit (tool_id, function_name, action, runtime_kind) "
        "VALUES (?, ?, ?, ?)",
        ("svr:tool_a", "tool_a", "allow", "claude-code"),
    )
    await conn.execute(
        "INSERT INTO tool_call_audit (tool_id, function_name, action) "
        "VALUES (?, ?, ?)",
        ("svr:tool_b", "tool_b", "allow"),
    )

    cur = await conn.execute(
        "SELECT runtime_kind FROM tool_call_audit ORDER BY id"
    )
    rows = [row[0] for row in await cur.fetchall()]
    assert rows == ["claude-code", None]

    await db.disconnect()
