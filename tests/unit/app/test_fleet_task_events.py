"""Fleet task_event rows: outbox kind, allow-list, fleet-only sink, encoders.

Agent Task lifecycle events reach the fleet destination as flat,
metadata-only NDJSON rows. These tests hold the privacy line: only the
Live Runs payload keys leave, only toward the enrollment destination, and
never toward a SIEM.
"""

from __future__ import annotations

import json

import pytest

from securevector.app.database.connection import (
    DatabaseConnection,
    close_database,
    init_database,
)
from securevector.app.database.migrations import (
    apply_initial_schema,
    apply_migration,
    get_current_version,
    run_migrations,
)
from securevector.app.database.repositories import external_forwarders as fwd_repo_module
from securevector.app.database.repositories.external_forwarders import (
    ExternalForwardersRepository,
    ExternalForwardOutboxRepository,
    build_task_event_payload,
    invalidate_siem_enabled_cache,
)
from securevector.app.services import fleet_task_events, siem_ocsf
from securevector.app.terminals import live_runs

KEY = b"a-fixed-test-salt-not-the-real-one"
WORKSPACE = "/Users/tester/clients/acme-corp/pricing-model"
TITLE = "Rewrite the Acme pricing model before Tuesday"
ACTIVITY = "Editing /Users/tester/clients/acme-corp/pricing-model/model.py"
SESSION = "3f6b1d02-9c44-4e1a-8f2b-7c9d0e1a2b3c"


def _task_row(**overrides):
    row = {
        "id": "a1b2c3d4e5f6",
        "executor_id": "claude-code",
        "workspace": WORKSPACE,
        "title": TITLE,
        "status": "working",
        "session_id": SESSION,
        "pid": 40321,
        "exit_code": None,
        "activity": ACTIVITY,
        "origin": "launch",
        "created_at": "2026-09-21T10:00:00.000+00:00",
        "last_activity_at": "2026-09-21T10:04:00.000+00:00",
        "ended_at": None,
        "archived_at": None,
    }
    row.update(overrides)
    return row


def _live_payload(**overrides):
    return live_runs.build_payload(_task_row(**overrides), "spawn", origin="ui", key=KEY)


@pytest.fixture(autouse=True)
def _reset():
    live_runs.set_salt(KEY)
    invalidate_siem_enabled_cache()
    yield
    live_runs.set_sink(None)
    live_runs.set_salt(None)
    invalidate_siem_enabled_cache()


async def _global_db(tmp_path):
    db = await init_database(tmp_path / "fleet.db")
    await run_migrations(db)
    return db


async def _add_destination(db, *, source: str, name: str, enabled: bool = True):
    return await ExternalForwardersRepository(db).create(
        kind="webhook",
        name=name,
        url="https://example.invalid/ingest",
        event_filter="all",
        include_tool_audits=True,
        redaction_level="standard",
        enabled=enabled,
        source=source,
    )


async def _outbox_rows(db):
    return await db.fetch_all(
        "SELECT forwarder_id, kind, payload_json FROM external_forward_outbox ORDER BY id"
    )


# -- migration -------------------------------------------------------------


@pytest.mark.asyncio
async def test_v52_allows_task_event_kind_and_keeps_queued_rows(tmp_path):
    db = DatabaseConnection(tmp_path / "m.db")
    await apply_initial_schema(db)
    for v in range(2, 52):
        await apply_migration(db, v)
    assert await get_current_version(db) == 51
    conn = await db.connect()
    await conn.execute(
        "INSERT INTO external_forwarders (kind, name, url) VALUES ('webhook', 'x', 'https://e.invalid')"
    )
    await conn.execute(
        "INSERT INTO external_forward_outbox (forwarder_id, kind, payload_json) VALUES (1, 'scan', '{}')"
    )
    await conn.commit()
    with pytest.raises(Exception):
        await conn.execute(
            "INSERT INTO external_forward_outbox (forwarder_id, kind, payload_json) "
            "VALUES (1, 'task_event', '{}')"
        )

    await apply_migration(db, 52)
    await apply_migration(db, 52)  # idempotent

    conn = await db.connect()
    await conn.execute(
        "INSERT INTO external_forward_outbox (forwarder_id, kind, payload_json) "
        "VALUES (1, 'task_event', '{}')"
    )
    await conn.commit()
    kinds = [r["kind"] for r in await db.fetch_all("SELECT kind FROM external_forward_outbox ORDER BY id")]
    assert kinds == ["scan", "task_event"]
    with pytest.raises(Exception):
        await conn.execute(
            "INSERT INTO external_forward_outbox (forwarder_id, kind, payload_json) "
            "VALUES (1, 'something_else', '{}')"
        )
    index = await db.fetch_one(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_external_forward_outbox_pending'"
    )
    assert index is not None
    assert await get_current_version(db) == 52
    await db.disconnect()


async def _db_at_v51_with_rows(tmp_path):
    db = DatabaseConnection(tmp_path / "r.db")
    await apply_initial_schema(db)
    for v in range(2, 52):
        await apply_migration(db, v)
    conn = await db.connect()
    await conn.execute(
        "INSERT INTO external_forwarders (kind, name, url) VALUES ('webhook', 'x', 'https://e.invalid')"
    )
    await conn.execute(
        "INSERT INTO external_forward_outbox (forwarder_id, kind, payload_json) VALUES (1, 'scan', '{\"a\":1}')"
    )
    await conn.commit()
    return db


_STAGING_DDL = (
    "CREATE TABLE external_forward_outbox_v52 ("
    "id INTEGER PRIMARY KEY AUTOINCREMENT, forwarder_id INTEGER NOT NULL, "
    "kind TEXT NOT NULL CHECK (kind IN ('scan', 'output_scan', 'tool_audit', 'task_event')), "
    "payload_json TEXT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, "
    "attempts INTEGER NOT NULL DEFAULT 0, delivered_at TIMESTAMP, last_error TEXT)"
)


async def _pending_index(db):
    return await db.fetch_one(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_external_forward_outbox_pending'"
    )


@pytest.mark.asyncio
async def test_v52_repair_drops_a_stale_staging_table_when_the_live_one_exists(tmp_path):
    db = await _db_at_v51_with_rows(tmp_path)
    conn = await db.connect()
    await conn.execute(_STAGING_DDL)
    await conn.execute(
        "INSERT INTO external_forward_outbox_v52 (forwarder_id, kind, payload_json) VALUES (1, 'scan', 'stale')"
    )
    await conn.commit()

    await apply_migration(db, 52)

    rows = await db.fetch_all("SELECT kind, payload_json FROM external_forward_outbox")
    assert [(r["kind"], r["payload_json"]) for r in rows] == [("scan", '{"a":1}')]
    staging = await db.fetch_one(
        "SELECT name FROM sqlite_master WHERE name='external_forward_outbox_v52'"
    )
    assert staging is None
    assert await _pending_index(db) is not None
    await db.disconnect()


@pytest.mark.asyncio
async def test_v52_repair_keeps_the_staging_table_when_the_live_one_is_gone(tmp_path):
    """Crash between DROP and RENAME: the staging table is the queue."""
    db = await _db_at_v51_with_rows(tmp_path)
    conn = await db.connect()
    await conn.execute(_STAGING_DDL)
    await conn.execute(
        "INSERT INTO external_forward_outbox_v52 SELECT * FROM external_forward_outbox"
    )
    await conn.execute("DROP TABLE external_forward_outbox")
    await conn.commit()

    await apply_migration(db, 52)

    rows = await db.fetch_all("SELECT kind, payload_json FROM external_forward_outbox")
    assert [(r["kind"], r["payload_json"]) for r in rows] == [("scan", '{"a":1}')]
    assert await _pending_index(db) is not None
    await conn.execute(
        "INSERT INTO external_forward_outbox (forwarder_id, kind, payload_json) VALUES (1, 'task_event', '{}')"
    )
    await db.disconnect()


@pytest.mark.asyncio
async def test_v52_recreates_a_missing_index_and_second_run_is_a_noop(tmp_path):
    """Crash after the rename but before the index: the re-run repairs it."""
    db = await _db_at_v51_with_rows(tmp_path)
    await apply_migration(db, 52)
    conn = await db.connect()
    sql_before = (await db.fetch_one(
        "SELECT sql FROM sqlite_master WHERE name='external_forward_outbox'"
    ))["sql"]
    await conn.execute("DROP INDEX idx_external_forward_outbox_pending")
    await conn.commit()
    assert await _pending_index(db) is None

    await apply_migration(db, 52)

    assert await _pending_index(db) is not None
    sql_after = (await db.fetch_one(
        "SELECT sql FROM sqlite_master WHERE name='external_forward_outbox'"
    ))["sql"]
    assert sql_after == sql_before
    rows = await db.fetch_all("SELECT id, kind FROM external_forward_outbox")
    assert [(r["id"], r["kind"]) for r in rows] == [(1, "scan")]
    versions = await db.fetch_all("SELECT version FROM schema_version WHERE version = 52")
    assert len(versions) == 1
    await db.disconnect()


# -- allow-list --------------------------------------------------------------


def test_allow_list_is_exactly_the_live_run_keys_plus_row_type():
    assert fwd_repo_module._TASK_EVENT_ALLOWED == frozenset(_live_payload()) | {"row_type"}


def test_builder_tags_row_type_and_keeps_every_value():
    live = _live_payload()
    row = build_task_event_payload(live)
    assert row["row_type"] == "task_event"
    assert {k: v for k, v in row.items() if k != "row_type"} == live


@pytest.mark.parametrize("extra", ["title", "workspace", "activity"])
def test_builder_rejects_a_field_off_the_allow_list(extra):
    live = _live_payload()
    live[extra] = "anything"
    with pytest.raises(ValueError, match="forbidden"):
        build_task_event_payload(live)


def test_builder_rejects_a_nested_value():
    live = _live_payload()
    live["status"] = {"text": TITLE}
    with pytest.raises(ValueError):
        build_task_event_payload(live)


@pytest.mark.asyncio
async def test_enqueue_fanout_rejects_an_extra_field(tmp_path):
    db = await _global_db(tmp_path)
    try:
        dest = await _add_destination(db, source="enrollment", name="fleet")
        payload = build_task_event_payload(_live_payload())
        payload["title"] = TITLE
        with pytest.raises(ValueError):
            await ExternalForwardOutboxRepository(db).enqueue_fanout(
                "task_event", payload, forwarders=[dest]
            )
    finally:
        await close_database()


# -- the sink ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_sink_enqueues_only_for_the_enrollment_destination(tmp_path):
    db = await _global_db(tmp_path)
    try:
        fleet = await _add_destination(db, source="enrollment", name="fleet")
        await _add_destination(db, source="user", name="splunk")
        await _add_destination(db, source="enrollment", name="off", enabled=False)

        written = await fleet_task_events.enqueue_task_event(_live_payload())

        assert written == 1
        rows = await _outbox_rows(db)
        assert [(r["forwarder_id"], r["kind"]) for r in rows] == [(fleet["id"], "task_event")]
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_sink_is_a_noop_when_not_enrolled(tmp_path):
    db = await _global_db(tmp_path)
    try:
        await _add_destination(db, source="user", name="splunk")
        assert await fleet_task_events.enqueue_task_event(_live_payload()) == 0
        assert await _outbox_rows(db) == []
        assert await live_runs.fleet_enrolled() is False
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_sink_returns_zero_when_global_forwarding_is_off(tmp_path):
    db = await _global_db(tmp_path)
    try:
        await _add_destination(db, source="enrollment", name="fleet")
        await fwd_repo_module.set_siem_forwarding_enabled(db, False)
        assert await fleet_task_events.enqueue_task_event(_live_payload()) == 0
        assert await _outbox_rows(db) == []
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_cloud_connected_for_an_enrolled_device_with_cloud_connect_off(tmp_path):
    db = await _global_db(tmp_path)
    try:
        from securevector.app.database.repositories.settings import SettingsRepository

        assert not (await SettingsRepository(db).get()).cloud_mode_enabled
        assert await live_runs.cloud_connected() is False
        await _add_destination(db, source="enrollment", name="fleet")
        assert await live_runs.cloud_connected() is True
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_hook_path_with_sink_but_no_enrollment_writes_nothing(tmp_path):
    import asyncio

    from securevector.app.terminals.manager import ManagerSettings, TerminalManager
    from securevector.app.terminals.store import TerminalStore
    from tests.unit.app.terminals.test_manager import FakeHost, _fake_claude_bin

    db = await _global_db(tmp_path)
    try:
        await _add_destination(db, source="user", name="splunk")
        tmp_bin = _fake_claude_bin(tmp_path)
        ws = tmp_path / "proj"
        ws.mkdir()
        settings = ManagerSettings(
            data_dir=tmp_path / "data",
            port=8741,
            plugin_dir=lambda: tmp_path / "plugin",
            plugin_enabled=lambda: False,
            parent_env={"PATH": str(tmp_bin)},
        )
        m = TerminalManager(FakeHost(), TerminalStore(db), settings)
        await m.start(asyncio.get_running_loop())
        task = await m.spawn("claude-code", str(ws), title=TITLE, origin="ui")
        token = m.hook_token(task["id"])

        without_sink = await m.handle_hook_event(task["id"], token, {"hook_event_name": "Stop"})
        fleet_task_events.install()
        with_sink = await m.handle_hook_event(
            task["id"], token, {"hook_event_name": "UserPromptSubmit"}
        )
        await live_runs.drain_pending(timeout=2.0)

        assert without_sink is True and with_sink is True
        assert (await m.store.get_task(task["id"]))["status"] == "working"
        assert await _outbox_rows(db) == []
        await m.stop_heartbeat()
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_siem_destination_never_passes_the_task_event_filter():
    siem = {"id": 7, "source": "user", "event_filter": "all", "include_tool_audits": True}
    fleet = {"id": 8, "source": "enrollment", "event_filter": "threats_only"}
    payload = build_task_event_payload(_live_payload())
    assert fwd_repo_module._passes_filter(siem, "task_event", payload) is False
    assert fwd_repo_module._passes_filter(fleet, "task_event", payload) is True


@pytest.mark.asyncio
async def test_emit_through_the_installed_sink_reaches_the_outbox(tmp_path):
    db = await _global_db(tmp_path)
    try:
        await _add_destination(db, source="enrollment", name="fleet")
        fleet_task_events.install()
        assert live_runs.has_sink()
        # Enrolled from the command line: Cloud Connect mode is off, yet the
        # fleet destination is what makes the device count as connected.
        assert await live_runs.cloud_connected() is True
        assert await live_runs.emit(_task_row(), "hook", origin="hook") is True
        rows = await _outbox_rows(db)
        assert len(rows) == 1 and rows[0]["kind"] == "task_event"
        fleet_task_events.uninstall()
        assert not live_runs.has_sink()
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_no_raw_path_title_or_activity_in_the_enqueued_payload(tmp_path):
    db = await _global_db(tmp_path)
    try:
        await _add_destination(db, source="enrollment", name="fleet")
        fleet_task_events.install()
        for kind, status in (("spawn", "starting"), ("hook", "blocked"), ("exit", "failed")):
            assert await live_runs.emit(_task_row(status=status, exit_code=1), kind, origin="ui")
        rows = await _outbox_rows(db)
        assert len(rows) == 3
        blob = "\n".join(r["payload_json"] for r in rows)
        for secret in (WORKSPACE, "acme", TITLE, ACTIVITY, "model.py", SESSION, "40321"):
            assert secret not in blob
        for r in rows:
            payload = json.loads(r["payload_json"])
            assert set(payload) == fwd_repo_module._TASK_EVENT_ALLOWED
            assert payload["row_type"] == "task_event"
    finally:
        await close_database()


# -- encoders -------------------------------------------------------------------


def test_encode_fleet_jsonl_emits_a_flat_task_event_line():
    payload = build_task_event_payload(_live_payload())
    body = siem_ocsf.encode_fleet_jsonl([{"id": 1, "kind": "task_event", "payload": payload}])
    lines = body.decode("utf-8").split("\n")
    assert len(lines) == 1
    line = json.loads(lines[0])
    assert line == payload
    assert line["row_type"] == "task_event"
    assert list(line)[0] == "row_type"
    assert all(not isinstance(v, (dict, list)) for v in line.values())


def test_encode_fleet_jsonl_drops_keys_outside_the_contract():
    payload = build_task_event_payload(_live_payload())
    tampered = dict(payload, title=TITLE, row_type="tool_activity")
    line = json.loads(
        siem_ocsf.encode_fleet_jsonl([{"id": 1, "kind": "task_event", "payload": tampered}])
    )
    assert "title" not in line and line["row_type"] == "task_event"


def test_siem_encoders_skip_task_event_rows():
    payload = build_task_event_payload(_live_payload())
    batch = [{"id": 1, "kind": "task_event", "payload": payload}]
    assert siem_ocsf.encode_batch(batch, redaction="standard") == []
    assert siem_ocsf.encode_batch(batch, redaction="full") == []
