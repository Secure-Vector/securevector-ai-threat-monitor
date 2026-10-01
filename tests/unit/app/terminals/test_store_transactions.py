"""Agent Terminals init must survive the shared-connection transaction races
seen after a restart ("cannot rollback - no transaction is active")."""

import asyncio
import sqlite3

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.synced_rules import SyncedRulesRepository
from securevector.app.terminals.store import TerminalStore


async def _db(tmp_path) -> DatabaseConnection:
    db = DatabaseConnection(tmp_path / "t.db")
    await run_migrations(db)
    return db


def _rules(n: int = 20) -> list[dict]:
    return [{"tool_id": f"tool_{i}", "effect": "deny", "priority": i} for i in range(n)]


@pytest.mark.asyncio
async def test_audit_chain_and_policy_apply_interleave_without_failing(tmp_path):
    # Cloud sync applies a bundle on the same shared connection while the
    # terminals board restore writes its audit events. Before the fix the
    # bundle apply issued a bare BEGIN that nested inside (or rolled back)
    # the audit transaction, and init died on a failed ROLLBACK.
    db = await _db(tmp_path)
    store = TerminalStore(db)
    repo = SyncedRulesRepository(db)

    async def events():
        for i in range(30):
            await store.add_event(f"t{i}", kind="interrupted", origin="startup")

    async def applies():
        for v in range(1, 11):
            await repo.replace_bundle(
                bundle_id=f"b{v}",
                policy_id="p",
                policy_name="P",
                policy_version=v,
                org_id="org",
                org_name=None,
                rules=_rules(),
            )

    await asyncio.gather(events(), applies())
    assert (await store.verify_chain())["ok"] is True
    rows = await db.fetch_all("SELECT COUNT(*) AS n FROM terminal_events")
    assert rows[0]["n"] == 30
    rows = await db.fetch_all("SELECT COUNT(*) AS n FROM synced_tool_rules")
    assert rows[0]["n"] == 20


@pytest.mark.asyncio
async def test_failed_rollback_never_masks_the_real_error(tmp_path):
    # SQLite rolls a transaction back on its own for some errors; the old
    # unconditional ROLLBACK then raised and replaced the real exception.
    db = await _db(tmp_path)
    with pytest.raises(ValueError, match="the real error"):
        async with db.transaction() as conn:
            await conn.execute("ROLLBACK")  # what SQLite does on SQLITE_BUSY
            raise ValueError("the real error")
    conn = await db.connect()
    assert not conn.in_transaction


@pytest.mark.asyncio
async def test_locked_database_reports_locked_not_cannot_rollback(tmp_path):
    db = await _db(tmp_path)
    conn = await db.connect()
    await conn.execute("PRAGMA busy_timeout = 50")
    other = sqlite3.connect(tmp_path / "t.db", isolation_level=None)
    try:
        other.execute("BEGIN IMMEDIATE")
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            async with db.transaction():
                pass
        assert not conn.in_transaction
    finally:
        other.execute("ROLLBACK")
        other.close()


@pytest.mark.asyncio
async def test_add_event_waits_out_a_brief_writer_from_another_process(tmp_path):
    # The previous app process finishing its shutdown holds the write lock
    # for a moment; busy_timeout must cover it so the board restore succeeds.
    db = await _db(tmp_path)
    store = TerminalStore(db)
    await store.add_event("t0", kind="created", origin="ui")
    other = sqlite3.connect(tmp_path / "t.db", isolation_level=None)
    other.execute("BEGIN IMMEDIATE")
    other.execute(
        "INSERT INTO terminal_events (task_id, kind, origin, detail, prev_hash, row_hash, created_at) "
        "SELECT 'x', 'k', 'o', NULL, NULL, 'h', 'now' WHERE 0"
    )
    loop = asyncio.get_running_loop()
    loop.call_later(0.3, lambda: (other.execute("COMMIT"), other.close()))
    seq = await store.add_event("t1", kind="interrupted", origin="startup")
    assert seq > 0
    assert (await store.verify_chain())["ok"] is True


@pytest.mark.asyncio
async def test_commit_by_another_caller_mid_transaction_is_not_an_error(tmp_path):
    # Repositories on the shared connection call conn.commit() directly; if
    # one lands inside an open transaction the statements are already
    # durable and the closing COMMIT must not fail.
    db = await _db(tmp_path)
    async with db.transaction() as conn:
        await conn.execute(
            "INSERT INTO terminal_events (task_id, kind, origin, detail, prev_hash, row_hash, created_at) "
            "VALUES ('t', 'k', 'o', NULL, NULL, 'h', 'now')"
        )
        await conn.commit()
    rows = await db.fetch_all("SELECT COUNT(*) AS n FROM terminal_events")
    assert rows[0]["n"] == 1
