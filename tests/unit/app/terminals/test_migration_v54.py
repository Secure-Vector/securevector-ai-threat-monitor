"""v54 widens terminal_tasks.status to accept 'stopped' without losing rows,
the columns later migrations added, or the indexes."""

import sqlite3

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import (
    MIGRATION_V48_SQL,
    migrate_to_v54,
    run_migrations,
)


async def _legacy_db(tmp_path):
    db = DatabaseConnection(tmp_path / "t.db")
    await run_migrations(db)
    conn = await db.connect()
    # Rebuild the pre-v54 shape: the v48 table plus the v49/v50 columns.
    await conn.execute("DROP TABLE terminal_tasks")
    await conn.executescript(MIGRATION_V48_SQL)
    await conn.execute("ALTER TABLE terminal_tasks ADD COLUMN archived_at TIMESTAMP")
    await conn.execute(
        "ALTER TABLE terminal_tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'launch'"
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_terminal_tasks_origin ON terminal_tasks (origin, archived_at)"
    )
    await conn.execute(
        "INSERT INTO terminal_tasks (id, executor_id, workspace, status, exit_code, origin) "
        "VALUES ('a1', 'codex', '/w', 'failed', 143, 'linked')"
    )
    await conn.commit()
    return db, conn


@pytest.mark.asyncio
async def test_v54_accepts_stopped_and_keeps_rows_columns_and_indexes(tmp_path):
    db, conn = await _legacy_db(tmp_path)
    with pytest.raises(sqlite3.IntegrityError):
        await conn.execute("UPDATE terminal_tasks SET status = 'stopped' WHERE id = 'a1'")
    await conn.rollback()

    await migrate_to_v54(db)
    await migrate_to_v54(db)  # idempotent

    await conn.execute("UPDATE terminal_tasks SET status = 'stopped' WHERE id = 'a1'")
    await conn.commit()
    row = await db.fetch_one("SELECT * FROM terminal_tasks WHERE id = 'a1'")
    assert row["status"] == "stopped" and row["exit_code"] == 143 and row["origin"] == "linked"
    names = {
        r["name"]
        for r in await db.fetch_all(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'terminal_tasks'"
        )
    }
    assert {"idx_terminal_tasks_status", "idx_terminal_tasks_session", "idx_terminal_tasks_origin"} <= names
    with pytest.raises(sqlite3.IntegrityError):
        await conn.execute("UPDATE terminal_tasks SET status = 'bogus' WHERE id = 'a1'")
    await db.disconnect()
