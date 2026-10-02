"""Fleet model generation rows and tool-row step booleans.

Each model turn of a governed run reaches the fleet destination as one flat,
metadata-only row grouped with the run's tool rows. These tests hold the
privacy line (no text, no tool names), the grouping identity, the gate, the
dedupe and the per-pass cap.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from securevector.app.database.connection import close_database, init_database
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories import external_forwarders as fwd_repo_module
from securevector.app.database.repositories.custom_tools import CustomToolsRepository
from securevector.app.database.repositories.external_forwarders import (
    ExternalForwardersRepository,
    ExternalForwardOutboxRepository,
    build_generation_payload,
    invalidate_siem_enabled_cache,
)
from securevector.app.services import fleet_generations, siem_ocsf
from securevector.app.utils.trace_id import derive_trace_id

SESSION = "7d1e2f30-1111-4c2d-9e8f-abcdefabcdef"
SECRET_TEXT = "ssh-key and the Acme pricing plan"


def _gen(i: int, at: datetime, **over):
    g = {
        "span_kind": "generation",
        "model": "claude-opus-4-1",
        "input_tokens": 100 + i,
        "output_tokens": 20,
        "cache_read_tokens": 5,
        "cache_creation_tokens": 3,
        "stop_reason": "tool_use",
        "called_at": at.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "request_id": f"req_{i:04d}",
        "cost": 0.0123,
        "input_preview": SECRET_TEXT,
        "output_preview": SECRET_TEXT,
        "input_hash": "deadbeefdeadbeef",
        "tool_results": [{"name": "Bash", "is_error": False, "tool_use_id": "t1"}],
        "tools_called": ["Bash", "Read"],
        "tool_use_names": ["Bash", "Read", "Bash"],
        "tool_calls": [{"name": "Bash", "args_hash": "x"}],
        "duration_ms": 1500,
        "duration_estimated": True,
        "turn_start": "tool_result",
    }
    g.update(over)
    return g


@pytest.fixture(autouse=True)
def _reset():
    invalidate_siem_enabled_cache()
    fleet_generations.reset_state()
    yield
    invalidate_siem_enabled_cache()
    fleet_generations.reset_state()


async def _db(tmp_path):
    db = await init_database(tmp_path / "gen.db")
    await run_migrations(db)
    return db


async def _destination(db, *, source="enrollment", include_tool_audits=True):
    fwd = await ExternalForwardersRepository(db).create(
        kind="webhook", name=f"{source}-dest", url="https://example.invalid/ingest",
        event_filter="all", include_tool_audits=include_tool_audits,
        redaction_level="standard", enabled=True, source=source,
    )
    conn = await db.connect()
    # Registered an hour ago, so the run below was forwarded.
    await conn.execute(
        "UPDATE external_forwarders SET created_at = datetime('now', '-1 hour')"
    )
    await conn.commit()
    return fwd


async def _tool_call(db, **over):
    kw = dict(action="allow", risk="read", reason="ok", runtime_kind="claude-code",
              session_id=SESSION, request_id=None)
    kw.update(over)
    await CustomToolsRepository(db).log_tool_call_audit("Bash", "Bash", kw.pop("action"), **kw)


async def _rows(db, kind):
    rows = await db.fetch_all(
        "SELECT payload_json FROM external_forward_outbox WHERE kind = ? ORDER BY id", (kind,)
    )
    return [json.loads(r["payload_json"]) for r in rows]


def _fake_parse(monkeypatch, gens, stamp="1"):
    async def fake(runtime_kind, session_id):
        assert runtime_kind == "claude-code" and session_id == SESSION
        return [dict(g) for g in gens], stamp
    monkeypatch.setattr(fleet_generations, "_load_generations", fake)


# -- row builder / encoder ---------------------------------------------------


def test_row_has_exactly_the_contract_fields_and_no_text():
    trace = derive_trace_id("claude-code", SESSION)
    at = datetime(2026, 9, 30, 10, 0, tzinfo=timezone.utc)
    row = fleet_generations.build_generation_row(
        _gen(1, at), trace_id=trace, session_id=SESSION, runtime_kind="claude-code", device_id="dev1",
    )
    payload = build_generation_payload(row)
    wire = siem_ocsf._fleet_generation_row(payload)
    assert set(wire) == {
        "ocsf_version", "category", "timestamp", "device_id", "harness", "agent",
        "trace_id", "session_id", "span_id", "duration_ms", "duration_estimated",
        "turn_start", "model_id", "tokens_in", "tokens_out", "tokens_cache_read",
        "tokens_cache_write", "cost_usd", "tool_use_count",
    }
    assert wire["category"] == "model_generation"
    assert wire["timestamp"] == "2026-09-30T10:00:00.000Z"
    assert wire["trace_id"] == trace and wire["session_id"] == SESSION
    assert wire["agent"] == f"run-{trace[:12]}" and wire["harness"] == "claude-code"
    assert (wire["tokens_in"], wire["tokens_out"], wire["tokens_cache_read"], wire["tokens_cache_write"]) == (101, 20, 5, 3)
    assert wire["tool_use_count"] == 3
    assert wire["cost_usd"] == 0.0123 and wire["duration_ms"] == 1500
    assert wire["duration_estimated"] is True and wire["turn_start"] == "tool_result"
    blob = json.dumps(wire)
    for leak in (SECRET_TEXT, "Bash", "Read", "deadbeef", "req_0001"):
        assert leak not in blob
    assert "tool_use" not in [v for v in wire.values() if isinstance(v, str)]
    # Stable span id.
    again = fleet_generations.build_generation_row(
        _gen(1, at), trace_id=trace, session_id=SESSION, runtime_kind="claude-code", device_id="dev1",
    )
    assert again["span_id"] == row["span_id"] and len(row["span_id"]) == 32


def test_span_id_falls_back_without_a_request_id():
    at = datetime(2026, 9, 30, 10, 0, tzinfo=timezone.utc)
    a = fleet_generations.generation_span_id("t1", _gen(1, at, request_id=None))
    b = fleet_generations.generation_span_id("t1", _gen(2, at + timedelta(seconds=1), request_id=None))
    assert a != b and a == fleet_generations.generation_span_id("t1", _gen(1, at, request_id=None))


@pytest.mark.parametrize("model,expected", [
    ("claude-opus-4-1", "claude-opus-4-1"),
    ("openai/gpt-5.1:latest", "openai/gpt-5.1:latest"),
    ("x" * 64, "x" * 64),
    ("x" * 65, None),
    ("model with spaces", None),
    ("<synthetic>", None),
    ("", None),
    (None, None),
    ({"a": 1}, None),
])
def test_model_id_is_sanitised(model, expected):
    assert fleet_generations.sanitize_model_id(model) == expected


def test_missing_values_become_safe_defaults():
    row = fleet_generations.build_generation_row(
        {"model": "m", "input_tokens": -5, "duration_ms": None, "turn_start": "other", "cost": None},
        trace_id=None, session_id=None, runtime_kind="codex", device_id=None,
    )
    assert row["tokens_in"] == 0 and row["tool_use_count"] == 0
    assert row["duration_ms"] is None and row["duration_estimated"] is False
    assert row["turn_start"] is None and row["cost_usd"] is None and row["agent"] == "codex"


def test_generation_payload_rejects_extra_fields_and_nested_values():
    with pytest.raises(ValueError):
        build_generation_payload({"span_id": "a", "input_preview": "x"})
    with pytest.raises(ValueError):
        build_generation_payload({"span_id": "a", "tool_use_count": [1]})


def test_generation_never_passes_a_siem_filter():
    assert not fwd_repo_module._passes_filter({"source": "user", "event_filter": "all"}, "generation", {})
    assert fwd_repo_module._passes_filter({"source": "enrollment"}, "generation", {})
    assert siem_ocsf.encode_batch([{"kind": "generation", "payload": {"span_id": "a"}}]) == []


# -- tool-row booleans -------------------------------------------------------


@pytest.mark.asyncio
async def test_tool_rows_carry_is_error_and_flagged(tmp_path):
    db = await _db(tmp_path)
    try:
        await _destination(db)
        await _tool_call(db, action="allow", reason="ok")
        await _tool_call(db, action="allow", reason="tool error: exit 1")
        await _tool_call(db, action="log_only", reason="logged")
        await _tool_call(db, action="block", reason="denied by policy")
        payloads = await _rows(db, "tool_audit")
        assert [(p["is_error"], p["flagged"]) for p in payloads] == [
            (False, False), (True, False), (False, True), (False, False)]
        wire = siem_ocsf.encode_fleet_jsonl([{"kind": "tool_audit", "payload": p} for p in payloads])
        lines = [json.loads(x) for x in wire.decode().splitlines()]
        assert [(r["is_error"], r["flagged"]) for r in lines] == [
            (False, False), (True, False), (False, True), (False, False)]
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_tool_row_is_flagged_by_a_detection_on_its_request_id(tmp_path, monkeypatch):
    db = await _db(tmp_path)
    try:
        await _destination(db)

        async def fake_sources(self, request_ids):
            return {rid: {"source": "rule", "rules": ["r1"]} for rid in request_ids if rid == "hit"}
        monkeypatch.setattr(CustomToolsRepository, "get_detection_sources", fake_sources)
        await _tool_call(db, request_id="hit")
        await _tool_call(db, request_id="miss")
        assert [p["flagged"] for p in await _rows(db, "tool_audit")] == [True, False]
    finally:
        await close_database()


# -- the pass: identity, gate, dedupe, cap -----------------------------------


@pytest.mark.asyncio
async def test_pass_queues_rows_grouped_with_the_tool_rows_and_dedupes(tmp_path, monkeypatch):
    db = await _db(tmp_path)
    try:
        await _destination(db)
        await _destination(db, source="user")
        await _tool_call(db)
        now = datetime.now(timezone.utc)
        _fake_parse(monkeypatch, [
            _gen(1, now - timedelta(minutes=30)),
            _gen(2, now - timedelta(minutes=20)),
            _gen(3, now - timedelta(seconds=10)),   # still settling
            _gen(4, now - timedelta(hours=3)),      # before enrollment
        ])
        assert await fleet_generations.forward_generations_once(db, now=now) == 2
        gens = await _rows(db, "generation")
        assert len(gens) == 2  # fleet only, never the SIEM destination
        tool = (await _rows(db, "tool_audit"))[0]
        for g in gens:
            assert g["trace_id"] == tool["trace_id"] and g["session_id"] == tool["session_id"]
            assert g["device_id"] == tool["device_id"] and g["harness"] == tool["runtime_kind"]
        fleet_tool = siem_ocsf._fleet_tool_activity_row(tool)
        assert {siem_ocsf._fleet_generation_row(g)["agent"] for g in gens} == {fleet_tool["agent"]}

        # Second pass: nothing new (the stamp skip and the markers).
        assert await fleet_generations.forward_generations_once(db, now=now) == 0
        fleet_generations.reset_state()
        assert await fleet_generations.forward_generations_once(db, now=now) == 0
        # The settling turn goes once it has settled, and only it.
        later = now + timedelta(minutes=5)
        assert await fleet_generations.forward_generations_once(db, now=later) == 1
        assert len(await _rows(db, "generation")) == 3
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_pass_is_a_noop_when_not_enrolled(tmp_path, monkeypatch):
    db = await _db(tmp_path)
    try:
        await _destination(db, source="user")
        await _tool_call(db)
        now = datetime.now(timezone.utc)
        _fake_parse(monkeypatch, [_gen(1, now - timedelta(minutes=30))])
        assert await fleet_generations.forward_generations_once(db, now=now) == 0
        assert await _rows(db, "generation") == []
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_pass_is_a_noop_when_forwarding_or_tool_activity_is_off(tmp_path, monkeypatch):
    db = await _db(tmp_path)
    try:
        fwd = await _destination(db)
        await _tool_call(db)
        now = datetime.now(timezone.utc)
        _fake_parse(monkeypatch, [_gen(1, now - timedelta(minutes=30))])
        await fwd_repo_module.set_siem_forwarding_enabled(db, False)
        assert await fleet_generations.forward_generations_once(db, now=now) == 0
        await fwd_repo_module.set_siem_forwarding_enabled(db, True)
        await ExternalForwardersRepository(db).update(fwd["id"] if isinstance(fwd, dict) else fwd,
                                                     include_tool_audits=False)
        assert await fleet_generations.forward_generations_once(db, now=now) == 0
        assert await _rows(db, "generation") == []
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_pass_is_capped_and_resumes_next_pass(tmp_path, monkeypatch):
    db = await _db(tmp_path)
    try:
        await _destination(db)
        await _tool_call(db)
        now = datetime.now(timezone.utc)
        _fake_parse(monkeypatch, [_gen(i, now - timedelta(minutes=50) + timedelta(seconds=i))
                                  for i in range(12)])
        assert await fleet_generations.forward_generations_once(db, now=now, max_rows=5) == 5
        assert await fleet_generations.forward_generations_once(db, now=now, max_rows=5) == 5
        assert await fleet_generations.forward_generations_once(db, now=now, max_rows=5) == 2
        assert await fleet_generations.forward_generations_once(db, now=now, max_rows=5) == 0
        spans = [g["span_id"] for g in await _rows(db, "generation")]
        assert len(spans) == len(set(spans)) == 12
    finally:
        await close_database()


# -- v53 migration -------------------------------------------------------------

from securevector.app.database.connection import DatabaseConnection  # noqa: E402
from securevector.app.database.migrations import (  # noqa: E402
    apply_initial_schema,
    apply_migration,
    get_current_version,
)

_V53_STAGING_DDL = (
    "CREATE TABLE external_forward_outbox_v53 ("
    "id INTEGER PRIMARY KEY AUTOINCREMENT, forwarder_id INTEGER NOT NULL, "
    "kind TEXT NOT NULL CHECK (kind IN ('scan', 'output_scan', 'tool_audit', 'task_event', 'generation')), "
    "payload_json TEXT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, "
    "attempts INTEGER NOT NULL DEFAULT 0, delivered_at TIMESTAMP, last_error TEXT)"
)


async def _db_at_v52_with_rows(tmp_path):
    db = DatabaseConnection(tmp_path / "v53.db")
    await apply_initial_schema(db)
    for v in range(2, 53):
        await apply_migration(db, v)
    assert await get_current_version(db) == 52
    conn = await db.connect()
    await conn.execute(
        "INSERT INTO external_forwarders (kind, name, url) VALUES ('webhook', 'x', 'https://e.invalid')"
    )
    await conn.execute(
        "INSERT INTO external_forward_outbox (forwarder_id, kind, payload_json, delivered_at) "
        "VALUES (1, 'scan', '{\"a\":1}', '2026-09-30 10:00:00')"
    )
    await conn.execute(
        "INSERT INTO external_forward_outbox (forwarder_id, kind, payload_json) "
        "VALUES (1, 'task_event', '{\"b\":2}')"
    )
    await conn.commit()
    return db


async def _v53_rows(db):
    rows = await db.fetch_all(
        "SELECT id, kind, payload_json, delivered_at FROM external_forward_outbox ORDER BY id"
    )
    return [(r["id"], r["kind"], r["payload_json"], r["delivered_at"]) for r in rows]


_V52_ROWS = [
    (1, "scan", '{"a":1}', "2026-09-30 10:00:00"),
    (2, "task_event", '{"b":2}', None),
]


async def _insert_generation(db):
    conn = await db.connect()
    await conn.execute(
        "INSERT INTO external_forward_outbox (forwarder_id, kind, payload_json) "
        "VALUES (1, 'generation', '{}')"
    )
    await conn.commit()


async def _v53_index(db):
    return await db.fetch_one(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_external_forward_outbox_pending'"
    )


@pytest.mark.asyncio
async def test_v53_keeps_rows_and_allows_generation_and_is_idempotent(tmp_path):
    db = await _db_at_v52_with_rows(tmp_path)
    with pytest.raises(Exception):
        await _insert_generation(db)

    await apply_migration(db, 53)
    sql_once = (await db.fetch_one(
        "SELECT sql FROM sqlite_master WHERE name='external_forward_outbox'"
    ))["sql"]
    await apply_migration(db, 53)  # second run is a no-op

    assert await _v53_rows(db) == _V52_ROWS
    assert (await db.fetch_one(
        "SELECT sql FROM sqlite_master WHERE name='external_forward_outbox'"
    ))["sql"] == sql_once
    await _insert_generation(db)
    assert [r[1] for r in await _v53_rows(db)] == ["scan", "task_event", "generation"]
    assert await _v53_index(db) is not None
    assert await db.fetch_one(
        "SELECT name FROM sqlite_master WHERE name='fleet_generation_sent'"
    ) is not None
    assert len(await db.fetch_all("SELECT version FROM schema_version WHERE version = 53")) == 1
    assert await get_current_version(db) == 53
    await db.disconnect()


@pytest.mark.asyncio
async def test_v53_repair_drops_a_stale_staging_table_when_the_live_one_exists(tmp_path):
    db = await _db_at_v52_with_rows(tmp_path)
    conn = await db.connect()
    await conn.execute(_V53_STAGING_DDL)
    await conn.execute(
        "INSERT INTO external_forward_outbox_v53 (forwarder_id, kind, payload_json) "
        "VALUES (1, 'scan', 'stale')"
    )
    await conn.commit()

    await apply_migration(db, 53)

    assert await _v53_rows(db) == _V52_ROWS
    assert await db.fetch_one(
        "SELECT name FROM sqlite_master WHERE name='external_forward_outbox_v53'"
    ) is None
    assert await _v53_index(db) is not None
    await _insert_generation(db)
    await db.disconnect()


@pytest.mark.asyncio
async def test_v53_repair_keeps_the_staging_table_when_the_live_one_is_gone(tmp_path):
    """Crash between DROP and RENAME: the staging table is the queue."""
    db = await _db_at_v52_with_rows(tmp_path)
    conn = await db.connect()
    await conn.execute(_V53_STAGING_DDL)
    await conn.execute(
        "INSERT INTO external_forward_outbox_v53 SELECT * FROM external_forward_outbox"
    )
    await conn.execute("DROP TABLE external_forward_outbox")
    await conn.commit()

    await apply_migration(db, 53)

    assert await _v53_rows(db) == _V52_ROWS
    assert await _v53_index(db) is not None
    await _insert_generation(db)
    await db.disconnect()


@pytest.mark.asyncio
async def test_v53_mid_script_failure_leaves_the_original_table_intact(tmp_path):
    db = await _db_at_v52_with_rows(tmp_path)
    conn = await db.connect()
    real = conn.executescript

    async def _failing(script):
        # Fail after the staging table is created and filled, before the drop.
        return await real(script.replace(
            "DROP TABLE external_forward_outbox;", "SELECT no_such_function();", 1
        ))

    conn.executescript = _failing
    try:
        with pytest.raises(Exception):
            await apply_migration(db, 53)
    finally:
        conn.executescript = real

    assert await _v53_rows(db) == _V52_ROWS
    assert "'generation'" not in (await db.fetch_one(
        "SELECT sql FROM sqlite_master WHERE name='external_forward_outbox'"
    ))["sql"]
    assert await db.fetch_one(
        "SELECT name FROM sqlite_master WHERE name='external_forward_outbox_v53'"
    ) is None
    assert await get_current_version(db) == 52

    await apply_migration(db, 53)  # a clean re-run then succeeds
    assert await _v53_rows(db) == _V52_ROWS
    await _insert_generation(db)
    await db.disconnect()
