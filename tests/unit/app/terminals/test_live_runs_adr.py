"""Detection and response metadata on Live Runs heartbeat and exit payloads.

Each field is optional, an integer or a closed vocabulary. A value outside
the contract is dropped by the one validator (live_runs.adr_fields) before
it reaches the outbox, and nothing that names a path, host, tool or text
ever rides along.
"""
from __future__ import annotations

import json

import pytest

from securevector.app.database.connection import close_database, init_database
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.external_forwarders import (
    ExternalForwardersRepository,
    build_task_event_payload,
    invalidate_siem_enabled_cache,
)
from securevector.app.services import fleet_task_events, siem_ocsf
from securevector.app.terminals import live_runs

KEY = b"a-fixed-test-salt-not-the-real-one"
SESSION = "3f6b1d02-9c44-4e1a-8f2b-7c9d0e1a2b3c"
TASK_ID = "a1b2c3d4e5f6"
SECRETS = ("/Users/tester", "acme-corp", "evil.example.com", "Bash", "curl", "secret-server",
           "Mod payload", "not approved yet")


def _row(**overrides):
    row = {
        "id": TASK_ID,
        "executor_id": "claude-code",
        "workspace": "/Users/tester/clients/acme-corp/pricing-model",
        "title": "Pricing",
        "status": "working",
        "session_id": SESSION,
        "origin": "launch",
        "created_at": "2026-10-13T10:00:00.000+00:00",
        "last_activity_at": "2026-10-13T10:04:00.000+00:00",
        "ended_at": None,
        "archived_at": None,
        "exit_code": None,
    }
    row.update(overrides)
    return row


FULL = {
    "drift_score": 74,
    "drift_band": "high",
    "drift_top": ["new_hosts", "enumeration", "secrets_reach"],
    "config_state": "changed",
    "config_changed_count": 3,
    "mcp_changed_count": 1,
    "mods_unmanaged_count": 2,
    "rung": 3,
    "rung_mode": "shadow",
    "rung_reason_ids": ["config", "drift"],
    "preflight_checked": 12,
    "preflight_avoided": 4,
}


@pytest.fixture(autouse=True)
def _reset():
    live_runs.set_salt(KEY)
    invalidate_siem_enabled_cache()
    yield
    live_runs.set_sink(None)
    live_runs.set_salt(None)
    invalidate_siem_enabled_cache()


# -- the validator -----------------------------------------------------------


def test_every_field_passes_when_inside_the_contract():
    out = live_runs.adr_fields(FULL, "exit")
    assert out == {**FULL, "drift_top": "new_hosts,enumeration,secrets_reach",
                   "rung_reason_ids": "config,drift"}
    assert set(out) == set(live_runs.ADR_FIELDS)


def test_out_of_range_values_are_dropped_and_counts_clamped():
    out = live_runs.adr_fields({
        "drift_score": 101, "drift_band": "red", "config_state": "pinned",
        "config_changed_count": 10**9, "mcp_changed_count": -1, "mods_unmanaged_count": True,
        "rung": 4, "rung_mode": "Active", "preflight_checked": 999999, "preflight_avoided": 1.5,
    }, "exit")
    assert out == {"config_changed_count": 10000, "preflight_checked": 100000}
    assert live_runs.adr_fields({"rung": -1, "drift_score": -3}, "exit") == {}
    assert live_runs.adr_fields({"rung": 0, "drift_score": 0}, "exit") == {"rung": 0, "drift_score": 0}


def test_drift_top_keeps_only_known_ids_max_three():
    out = live_runs.adr_fields({"drift_top": [
        "persistence", "/etc/passwd", "tool_novelty", "persistence", "Bash",
        "new_hosts", "enumeration",
    ]}, "exit")
    assert out == {"drift_top": "persistence,tool_novelty,new_hosts"}
    assert live_runs.adr_fields({"drift_top": "enumeration,curl evil.example.com"}, "exit") == {
        "drift_top": "enumeration"}
    assert live_runs.adr_fields({"drift_top": ["Bash"]}, "exit") == {}


def test_rung_reason_ids_are_the_closed_signal_list_max_three():
    out = live_runs.adr_fields({"rung_reason_ids": ["drift", "config", "deny", "drift", "other_id"]}, "exit")
    assert out == {"rung_reason_ids": "drift,config,deny"}
    out = live_runs.adr_fields({"rung_reason_ids": ["Retry after deny", "/tmp/x", "setup change", "deny"]}, "exit")
    assert out == {"rung_reason_ids": "deny"}
    assert live_runs.adr_fields({"rung_reason_ids": "persistence,new_hosts"}, "exit") == {}
    assert live_runs.adr_fields({"rung_reason_ids": []}, "exit") == {}


def test_rung_reason_ids_track_the_response_rung_signals():
    from securevector.app.services import response_rungs

    assert live_runs.RUNG_REASON_IDS == {response_rungs.SIG_DRIFT, response_rungs.SIG_CONFIG,
                                         response_rungs.SIG_DENY}


def test_validator_yields_nothing_for_other_or_missing_events():
    assert live_runs.adr_fields(FULL, "heartbeat") == live_runs.adr_fields(FULL, "exit")
    assert live_runs.adr_fields(FULL, "exit")
    for kind in (None, "", "spawn", "hook", "stop", "bogus"):
        assert live_runs.adr_fields(FULL, kind) == {}


def test_empty_or_malformed_input_yields_nothing():
    assert live_runs.adr_fields(None, "exit") == {}
    assert live_runs.adr_fields("drift_score=5", "exit") == {}
    assert live_runs.adr_fields({k: None for k in live_runs.ADR_FIELDS}, "exit") == {}
    assert live_runs.adr_fields({"drift_band": "", "config_state": "", "drift_top": ""}, "exit") == {}


# -- the payload -------------------------------------------------------------


@pytest.mark.parametrize("kind", ["heartbeat", "exit"])
def test_heartbeat_and_exit_carry_the_fields(kind):
    payload = live_runs.build_payload(_row(), kind, key=KEY, adr=FULL)
    for name in live_runs.ADR_FIELDS:
        assert name in payload
    assert payload["drift_top"] == "new_hosts,enumeration,secrets_reach"


@pytest.mark.parametrize("kind", ["spawn", "stop", "hook", "archived", "interrupted", "attach", "bogus"])
def test_other_events_never_carry_them(kind):
    payload = live_runs.build_payload(_row(), kind, key=KEY, adr=FULL)
    assert not set(payload) & set(live_runs.ADR_FIELDS)


def test_missing_fields_are_omitted_not_sent_empty():
    payload = live_runs.build_payload(_row(), "heartbeat", key=KEY, adr={"drift_score": 12})
    assert payload["drift_score"] == 12
    for name in live_runs.ADR_FIELDS[1:]:
        assert name not in payload
    bare = live_runs.build_payload(_row(), "heartbeat", key=KEY)
    assert not set(bare) & set(live_runs.ADR_FIELDS)


def test_outbox_builder_drops_values_outside_the_contract():
    payload = live_runs.build_payload(_row(), "exit", key=KEY)
    payload.update({"drift_score": 500, "drift_band": "high", "rung_reason_ids": "Retry after deny,deny,x1",
                    "config_state": "/Users/tester"})
    row = build_task_event_payload(payload)
    assert "drift_score" not in row and "config_state" not in row
    assert row["drift_band"] == "high" and row["rung_reason_ids"] == "deny"


def test_outbox_and_encoder_drop_the_fields_when_the_event_is_missing():
    payload = live_runs.build_payload(_row(), "exit", key=KEY, adr=FULL)
    payload["event"] = None
    row = build_task_event_payload(payload)
    assert not set(row) & set(live_runs.ADR_FIELDS)
    line = siem_ocsf.encode_fleet_jsonl([{"kind": "task_event", "payload": payload}]).decode()
    assert not set(json.loads(line)) & set(live_runs.ADR_FIELDS)


@pytest.mark.asyncio
async def test_collect_gives_up_after_the_timeout(monkeypatch):
    import asyncio

    async def hang(task, db, mods):
        await asyncio.sleep(10)

    monkeypatch.setattr(live_runs, "_collect_adr", hang)
    assert await live_runs.collect_adr(_row(), db=object(), timeout=0.05) == {}


@pytest.mark.asyncio
async def test_emit_without_metadata_after_a_timeout(monkeypatch):
    import asyncio

    captured = []

    async def connected():
        return True

    async def hang(task, db, mods):
        await asyncio.sleep(10)

    async def sink(payload):
        captured.append(payload)

    monkeypatch.setattr(live_runs, "cloud_connected", connected)
    monkeypatch.setattr(live_runs, "_collect_adr", hang)
    monkeypatch.setattr(live_runs, "ADR_COLLECT_TIMEOUT_SECONDS", 0.05)
    live_runs.set_sink(sink)
    assert await live_runs.emit(_row(), "heartbeat")
    assert captured and not set(captured[0]) & set(live_runs.ADR_FIELDS)


def test_outbox_builder_strips_the_fields_from_other_events():
    payload = live_runs.build_payload(_row(), "hook", key=KEY)
    payload.update({"drift_score": 50, "rung": 2})
    row = build_task_event_payload(payload)
    assert not set(row) & set(live_runs.ADR_FIELDS)
    line = siem_ocsf.encode_fleet_jsonl([{"kind": "task_event", "payload": payload}]).decode()
    assert not set(json.loads(line)) & set(live_runs.ADR_FIELDS)


def test_fleet_encoder_projects_the_fields_only_when_present():
    with_adr = build_task_event_payload(live_runs.build_payload(_row(), "exit", key=KEY, adr=FULL))
    without = build_task_event_payload(live_runs.build_payload(_row(), "spawn", key=KEY))
    lines = siem_ocsf.encode_fleet_jsonl([
        {"kind": "task_event", "payload": with_adr},
        {"kind": "task_event", "payload": without},
    ]).decode().splitlines()
    first, second = (json.loads(x) for x in lines)
    assert first["rung"] == 3 and first["drift_band"] == "high"
    assert first["rung_reason_ids"] == "config,drift"
    assert not set(second) & set(live_runs.ADR_FIELDS)


# -- collecting from the local services ---------------------------------------


async def _seed(db):
    conn = await db.connect()
    feats = json.dumps([
        {"id": "new_hosts", "value": 1.0, "weight": 20, "skipped": False, "counts": {"hosts": 4}},
        {"id": "enumeration", "value": 0.5, "weight": 15, "skipped": False, "counts": {}},
        {"id": "tool_novelty", "value": 0.0, "weight": 20, "skipped": False, "counts": {}},
    ])
    await conn.execute(
        "INSERT INTO session_drift (session_id, task_id, harness, workspace, score, band, status, "
        "features_json, computed_at) VALUES (?, ?, 'claude-code', '/Users/tester/acme-corp', 72, 'high', "
        "'scored', ?, '2026-10-13T10:05:00')",
        (SESSION, TASK_ID, feats),
    )
    diff = json.dumps([
        {"target": "server", "server": "secret-server", "type": "mcp", "state": "changed",
         "severity": "red", "text": "New MCP server secret-server, not approved yet."},
        {"target": "surface", "key": "hooks:user", "type": "hooks", "state": "changed",
         "severity": "red", "text": "Hooks changed in /Users/tester/.claude/settings.json."},
    ])
    await conn.execute(
        "INSERT INTO config_checks (session_id, task_id, harness, phase, setup_hash, state, diff_json, "
        "checked_at) VALUES (?, ?, 'claude-code', 'mid', 'h', 'changed', ?, '2026-10-13T10:05:00')",
        (SESSION, TASK_ID, diff),
    )
    for key, managed in (("m1", 0), ("m2", 0), ("m3", 1)):
        await conn.execute(
            "INSERT INTO mod_inventory (mod_key, managed, first_seen, last_seen) VALUES (?, ?, 'x', 'x')",
            (key, managed),
        )
    await conn.execute(
        "INSERT INTO session_rungs (session_id, task_id, harness, rung, mode, reasons_json) "
        "VALUES (?, ?, 'claude-code', 2, 'active', ?)",
        (SESSION, TASK_ID, json.dumps(["config", "drift"])),
    )
    await conn.execute(
        "INSERT INTO logical_sessions (handle, harness, task_id, harness_session_id, binding, created_at, "
        "last_seen_at) VALUES ('h1', 'claude-code', ?, ?, 'verified', 'x', 'x')",
        (TASK_ID, SESSION),
    )
    for jti, decision, after in (("j1", "allow", 0), ("j2", "deny", 0), ("j3", "deny", 1)):
        await conn.execute(
            "INSERT INTO policy_decisions (jti, session, task_id, action_kind, tool_name, action_hash, "
            "target_hash, decision, reason, issued_at, attempted_after_deny) "
            "VALUES (?, 'h1', ?, 'shell', 'Bash', 'a', 't', ?, 'curl evil.example.com', "
            "'2026-10-13T10:01:00', ?)",
            (jti, TASK_ID, decision, after),
        )
    await conn.commit()


@pytest.mark.asyncio
async def test_collect_reads_each_source_and_leaks_nothing(tmp_path):
    db = await init_database(tmp_path / "adr.db")
    try:
        await run_migrations(db)
        await _seed(db)
        raw = await live_runs.collect_adr(_row(), db=db)
        out = live_runs.adr_fields(raw, "exit")
        assert out == {
            "drift_score": 72, "drift_band": "high", "drift_top": "new_hosts,enumeration",
            "config_state": "changed", "config_changed_count": 2, "mcp_changed_count": 1,
            "mods_unmanaged_count": 2, "rung": 2, "rung_mode": "active", "rung_reason_ids": "config,drift",
            "preflight_checked": 3, "preflight_avoided": 1,
        }
        blob = json.dumps(live_runs.build_payload(_row(), "exit", key=KEY, adr=raw))
        for secret in SECRETS:
            assert secret not in blob
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_collect_omits_what_it_cannot_compute(tmp_path):
    db = await init_database(tmp_path / "empty.db")
    try:
        await run_migrations(db)
        out = live_runs.adr_fields(await live_runs.collect_adr(_row(), db=db), "exit")
        # No setup check yet reads as unknown; everything else is absent.
        assert out == {"config_state": "unknown"}
        out = live_runs.adr_fields(await live_runs.collect_adr(_row(id=None, session_id=None), db=db), "exit")
        assert out == {}
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_emit_attaches_fields_to_heartbeat_only(tmp_path):
    db = await init_database(tmp_path / "fleet.db")
    try:
        await run_migrations(db)
        await _seed(db)
        await ExternalForwardersRepository(db).create(
            kind="webhook", name="fleet", url="https://example.invalid/ingest", event_filter="all",
            include_tool_audits=True, redaction_level="standard", enabled=True, source="enrollment",
        )
        fleet_task_events.install()
        assert await live_runs.emit(_row(), "heartbeat")
        assert await live_runs.emit(_row(), "hook", origin="hook")
        rows = await db.fetch_all("SELECT payload_json FROM external_forward_outbox ORDER BY id")
        beat, hook = (json.loads(r["payload_json"]) for r in rows)
        assert beat["drift_score"] == 72 and beat["rung"] == 2 and beat["preflight_avoided"] == 1
        assert not set(hook) & set(live_runs.ADR_FIELDS)
        blob = "\n".join(r["payload_json"] for r in rows)
        for secret in SECRETS:
            assert secret not in blob
    finally:
        await close_database()
