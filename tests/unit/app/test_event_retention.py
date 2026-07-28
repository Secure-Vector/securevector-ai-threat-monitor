"""Retention for the append-only event tables.

redaction_events, tool_call_log and threat_intel_records previously had no
cleanup at all, so they grew for the life of an install. These lock in that
they age out on the same `app_settings.retention_days` knob as the cost and
audit tables, and that recent rows are never touched.
"""

from __future__ import annotations

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import (
    _EVENT_RETENTION_TABLES,
    cleanup_old_event_records,
    run_migrations,
)


async def _build_db(tmp_path) -> DatabaseConnection:
    db = DatabaseConnection(tmp_path / "retention.db")
    await run_migrations(db)
    return db


async def _row_count(db: DatabaseConnection, table: str) -> int:
    row = await db.fetch_one(f"SELECT COUNT(*) AS n FROM {table}")
    return int(row["n"])


# Minimal valid row per table (every NOT NULL column), with the timestamp
# left as a placeholder the caller fills in.
_ROW_TEMPLATES = {
    "redaction_events": (
        "INSERT INTO redaction_events "
        "(pattern_id, secret_type, direction, redaction_hash, redacted_at) "
        "VALUES ('aws-key', 'AWS key', 'outgoing', 'sha256:x', {ts})"
    ),
    "tool_call_log": (
        "INSERT INTO tool_call_log (tool_id, called_at) VALUES ('Bash', {ts})"
    ),
    "threat_intel_records": (
        "INSERT INTO threat_intel_records "
        "(id, text_hash, text_length, is_threat, risk_score, confidence, "
        " matched_rules, processing_time_ms, created_at) "
        "VALUES (hex(randomblob(8)), 'sha256:y', 10, 1, 90, 0.9, '[]', 5, {ts})"
    ),
}


async def _insert(db: DatabaseConnection, table: str, ts_sql: str) -> None:
    await db.execute(_ROW_TEMPLATES[table].format(ts=ts_sql))


@pytest.mark.asyncio
@pytest.mark.parametrize("table,ts_col", _EVENT_RETENTION_TABLES)
async def test_old_rows_are_pruned_and_recent_rows_survive(tmp_path, table, ts_col):
    db = await _build_db(tmp_path)
    await db.execute("UPDATE app_settings SET retention_days = 30 WHERE id = 1")

    # One row well past retention, one from today.
    await _insert(db, table, "datetime('now', '-90 days')")
    await _insert(db, table, "datetime('now')")
    assert await _row_count(db, table) == 2

    await cleanup_old_event_records(db)

    assert await _row_count(db, table) == 1, f"{table}: old row should be pruned"
    row = await db.fetch_one(f"SELECT {ts_col} AS ts FROM {table}")
    assert row["ts"] is not None


@pytest.mark.asyncio
async def test_cleanup_respects_a_longer_retention_setting(tmp_path):
    """A 365-day setting must keep a 90-day-old row."""
    db = await _build_db(tmp_path)
    await db.execute("UPDATE app_settings SET retention_days = 365 WHERE id = 1")
    await _insert(db, "redaction_events", "datetime('now', '-90 days')")

    await cleanup_old_event_records(db)

    assert await _row_count(db, "redaction_events") == 1


@pytest.mark.asyncio
async def test_cleanup_never_raises(tmp_path):
    """Runs on every startup, so it must be best-effort: a dropped table
    cannot be allowed to abort migrations."""
    db = await _build_db(tmp_path)
    await db.execute("DROP TABLE redaction_events")

    await cleanup_old_event_records(db)  # must not raise
