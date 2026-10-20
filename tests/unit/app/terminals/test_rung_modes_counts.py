"""Hold events behind the Automatic actions tile: counted as events, per mode
at event time, over seven days; GET /api/terminals/rungs/modes carries them."""

import asyncio
from datetime import datetime, timedelta, timezone

from securevector.app.database.migrations import migrate_to_v62
from securevector.app.database.repositories.response_rungs import ResponseRungsRepository
from securevector.app.services import response_rungs as rr
from tests.unit.app.terminals.test_routes import AUTH, env  # noqa: F401 - fixture

NOW = datetime.now(timezone.utc)


def _hold(db, sid, harness, mode, when=NOW):
    asyncio.run(ResponseRungsRepository(db).record_hold(sid, harness, mode, "step_up", rr._iso(when)))


def test_shadow_hold_is_would_have_not_taken(env):  # noqa: F811
    client, _m, _ws, db = env
    _hold(db, "s1", "claude-code", "shadow")
    body = client.get("/api/terminals/rungs/modes", headers=AUTH).json()
    assert body["would_have"] == 1 and body["taken"] == 0


def test_two_sessions_in_different_tools_both_count(env):  # noqa: F811
    client, _m, _ws, db = env
    _hold(db, "s1", "claude-code", "shadow")
    _hold(db, "s2", "codex", "shadow")
    _hold(db, "s3", "codex", "active")
    body = client.get("/api/terminals/rungs/modes", headers=AUTH).json()
    assert body["would_have"] == 2 and body["taken"] == 1


def test_window_is_seven_days(env):  # noqa: F811
    client, _m, _ws, db = env
    _hold(db, "old", "claude-code", "shadow", NOW - timedelta(days=8))
    _hold(db, "new", "claude-code", "shadow", NOW - timedelta(days=6))
    assert client.get("/api/terminals/rungs/modes", headers=AUTH).json()["would_have"] == 1


def test_session_keeps_test_mode_after_tool_switches_to_on(env):  # noqa: F811
    client, _m, _ws, db = env
    _hold(db, "s1", "claude-code", "shadow")
    asyncio.run(rr.set_mode(db, "claude-code", "shadow"))
    asyncio.run(db.execute("UPDATE rung_modes SET mode = 'active' WHERE harness = 'claude-code'"))
    body = client.get("/api/terminals/rungs/modes", headers=AUTH).json()
    assert body["would_have"] == 1 and body["taken"] == 0


def test_migration_creates_table_and_index(env):  # noqa: F811
    _c, _m, _ws, db = env
    asyncio.run(migrate_to_v62(db))
    asyncio.run(migrate_to_v62(db))
    names = {r["name"] for r in asyncio.run(db.fetch_all("SELECT name FROM sqlite_master"))}
    assert {"response_holds", "idx_response_holds_mode_ts"} <= names
