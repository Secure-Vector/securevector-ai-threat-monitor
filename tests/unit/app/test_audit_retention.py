"""Audit-table retention + truncation-aware verifier tests (#101)."""

from __future__ import annotations

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import (
    CURRENT_SCHEMA_VERSION,
    cleanup_old_audit_records,
    run_migrations,
)
from securevector.app.database.repositories.custom_tools import CustomToolsRepository


async def _build_db(tmp_path) -> DatabaseConnection:
    db = DatabaseConnection(tmp_path / "test.db")
    await run_migrations(db)
    return db


async def _seed_audit_row(repo: CustomToolsRepository, **overrides) -> None:
    """Helper that inserts a single audit row through the canonical
    repository write path (so the hash chain stays well-formed)."""
    args = dict(
        tool_id="server-x:tool_a",
        function_name="tool_a",
        action="allow",
        risk=None,
        reason=None,
        is_essential=False,
        args_preview=None,
    )
    args.update(overrides)
    await repo.log_tool_call_audit(**args)


# --- Migration v33: per-tool query index --------------------------------------


@pytest.mark.asyncio
async def test_v33_creates_tool_id_called_at_index(tmp_path):
    db = await _build_db(tmp_path)
    conn = await db.connect()
    cur = await conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tool_call_audit'"
    )
    names = {row[0] for row in await cur.fetchall()}
    assert "idx_tool_call_audit_tool_time" in names, names


@pytest.mark.asyncio
async def test_schema_version_advances_to_36(tmp_path):
    # v34 — added redaction_events audit log (backs the local Secret
    # Detections page sibling to Tool Inventory).
    # v35 — added redaction_events.runtime_kind for per-row plugin
    # attribution (claude-code / openclaw / langchain / etc.). See
    # migration in models.py.
    # v36 — added agent-run trace keys (trace_id/session_id/turn_index/
    # parent_span_id) on tool_call_audit for the Agent Run Trace + Agent
    # Map views (story #141).
    db = await _build_db(tmp_path)
    assert CURRENT_SCHEMA_VERSION == 36
    row = await db.fetch_one(
        "SELECT MAX(version) AS v FROM schema_version"
    )
    assert row["v"] == 36


# --- Cleanup_old_audit_records --------------------------------------------


@pytest.mark.asyncio
async def test_cleanup_old_audit_records_prunes_rows_older_than_retention(tmp_path):
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    # Insert two rows, then backdate one beyond a 1-day retention window.
    await _seed_audit_row(repo, tool_id="server-x:old", function_name="old")
    await _seed_audit_row(repo, tool_id="server-x:new", function_name="new")
    conn = await db.connect()
    await conn.execute(
        "UPDATE tool_call_audit SET called_at = datetime('now', '-30 days') "
        "WHERE function_name = 'old'"
    )

    deleted = await repo.cleanup_old_audit_records(retention_days=1)
    assert deleted == 1

    cur = await conn.execute("SELECT function_name FROM tool_call_audit")
    remaining = {row[0] for row in await cur.fetchall()}
    assert remaining == {"new"}


@pytest.mark.asyncio
async def test_cleanup_old_audit_records_is_noop_when_nothing_expired(tmp_path):
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)
    await _seed_audit_row(repo)

    deleted = await repo.cleanup_old_audit_records(retention_days=30)
    assert deleted == 0


@pytest.mark.asyncio
async def test_cleanup_old_audit_records_returns_zero_for_invalid_retention(tmp_path):
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)
    await _seed_audit_row(repo)

    assert await repo.cleanup_old_audit_records(retention_days=0) == 0
    assert await repo.cleanup_old_audit_records(retention_days=-5) == 0
    # Row still there
    cur = await (await db.connect()).execute("SELECT COUNT(*) FROM tool_call_audit")
    assert (await cur.fetchone())[0] == 1


@pytest.mark.asyncio
async def test_migrations_cleanup_old_audit_records_wrapper_uses_retention_days(tmp_path):
    """`migrations.cleanup_old_audit_records()` (the module-level wrapper)
    reads retention_days from app_settings and delegates to the repo."""
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    await _seed_audit_row(repo, function_name="old1")
    await _seed_audit_row(repo, function_name="old2")
    await _seed_audit_row(repo, function_name="fresh")
    conn = await db.connect()
    await conn.execute(
        "UPDATE tool_call_audit SET called_at = datetime('now', '-365 days') "
        "WHERE function_name IN ('old1', 'old2')"
    )
    # Force retention to 7 days
    await conn.execute("UPDATE app_settings SET retention_days = 7 WHERE id = 1")
    await conn.commit()

    await cleanup_old_audit_records(db)

    cur = await conn.execute("SELECT function_name FROM tool_call_audit")
    remaining = {row[0] for row in await cur.fetchall()}
    assert remaining == {"fresh"}


# --- Truncation-aware verify_audit_chain --------------------------------------


@pytest.mark.asyncio
async def test_verify_audit_chain_handles_empty_table(tmp_path):
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)
    result = await repo.verify_audit_chain()
    assert result["ok"] is True
    assert result["total"] == 0
    assert result["chain_origin_seq"] is None


@pytest.mark.asyncio
async def test_verify_audit_chain_after_truncation_still_verifies(tmp_path):
    """When retention prunes the OLDEST rows, the verifier accepts the
    new lowest seq's stored prev_hash as the post-truncation anchor and
    confirms the surviving chain is intact."""
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    # Build a 5-row chain.
    for i in range(5):
        await _seed_audit_row(repo, function_name=f"call_{i}")

    pre = await repo.verify_audit_chain()
    assert pre["ok"], pre
    assert pre["total"] == 5
    assert pre["chain_origin_seq"] == 1

    # Prune the oldest 2 rows (seq=1, seq=2).
    conn = await db.connect()
    await conn.execute("DELETE FROM tool_call_audit WHERE seq <= 2")
    await conn.commit()

    post = await repo.verify_audit_chain()
    assert post["ok"], post
    assert post["total"] == 3
    assert post["chain_origin_seq"] == 3, post


@pytest.mark.asyncio
async def test_verify_audit_chain_detects_tampered_row_after_truncation(tmp_path):
    """Tampering with a row's content post-truncation still fails verification."""
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    for i in range(4):
        await _seed_audit_row(repo, function_name=f"call_{i}")
    conn = await db.connect()
    await conn.execute("DELETE FROM tool_call_audit WHERE seq <= 1")
    # Tamper with the function_name of seq=3 (recompute would no longer match
    # the stored row_hash).
    await conn.execute(
        "UPDATE tool_call_audit SET function_name = 'tampered' WHERE seq = 3"
    )
    await conn.commit()

    result = await repo.verify_audit_chain()
    assert result["ok"] is False, result
    assert result["chain_origin_seq"] == 2
    assert result["tampered_at"] == 3
    assert "row_hash" in (result["reason"] or "")
