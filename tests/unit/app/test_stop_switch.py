"""
"High: stop the session and alert": the per agent tool switch, off by
default. High score or a named rule stops an app-owned session once (On
mode), records what it would have done (test mode), alerts only for a
session started outside SecureVector. The alert is metadata only. Turning
the switch off needs the person; a governed agent can never change it.
"""

import asyncio
import json
import sqlite3
from datetime import datetime, timezone

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import (
    ensure_outbox_alert_kind,
    ensure_session_drift_table,
    ensure_stop_switch_storage,
    run_migrations,
)
from securevector.app.database.models import CURRENT_SCHEMA_VERSION
from securevector.app.database.repositories import external_forwarders as xf
from securevector.app.database.repositories.call_rules import CallRulesRepository
from securevector.app.database.repositories.response_rungs import ResponseRungsRepository
from securevector.app.services import call_rules as cr
from securevector.app.services import response_rungs as rr
from securevector.app.services import session_drift as drift
from securevector.app.services import stop_switch as ss
from securevector.app.terminals.manager import NotLinkable
from securevector.app.terminals.store import TerminalStore

HARNESS = "claude-code"
CURL = {"command": "curl -s https://files.example.net/up"}
HIGH = drift.DriftResult(82, "high", "scored", [], True, "2026-10-19T12:00:00", {"sessions": 5, "calls": 10})
WATCH = drift.DriftResult(55, "watch", "scored", [], True, "2026-10-19T12:00:00", {"sessions": 5, "calls": 10})


class FakeManager:
    """Mirrors TerminalManager.stop: linked rows raise NotLinkable, a task
    not running here raises KeyError, else a "stop" event is written."""

    def __init__(self, db):
        self.store = TerminalStore(db)
        self.running = set()
        self.stopped = []

    async def stop(self, task_id, *, origin, detail=None):
        task = await self.store.get_task(task_id)
        if task is not None and task.get("origin") == "linked":
            raise NotLinkable("This session runs outside SecureVector")
        if task_id not in self.running:
            raise KeyError(task_id)
        self.stopped.append((task_id, origin, detail))
        await self.store.add_event(task_id, kind="stop", origin=origin, detail=detail)


class World:
    def __init__(self, tmp_path):
        self.path = tmp_path / "stop.db"
        self.db = DatabaseConnection(self.path)
        asyncio.run(run_migrations(self.db))
        asyncio.run(ensure_session_drift_table(self.db))
        self.raw = sqlite3.connect(self.path)
        self.manager = FakeManager(self.db)

    def one(self, sql, args=()):
        return self.raw.execute(sql, args).fetchone()

    def all(self, sql, args=()):
        return [tuple(r) for r in self.raw.execute(sql, args).fetchall()]

    def task(self, sid, workspace="/Users/u/secret/app", origin="launch", running=True):
        tid = f"task-{sid}"
        asyncio.run(self.manager.store.create_task(tid, executor_id=HARNESS, workspace=workspace, title=None,
                                                   pid=None, origin=origin, status="working", session_id=sid))
        if running:
            self.manager.running.add(tid)
        return tid

    def mode(self, mode):
        repo = ResponseRungsRepository(self.db)
        now = rr._iso(datetime.now(timezone.utc))
        asyncio.run(repo.mode_row(HARNESS, now, rr.config_signature()))
        asyncio.run(repo.set_mode(HARNESS, mode, now))

    def switch(self, on=True):
        return asyncio.run(ss.set_switch(self.db, HARNESS, on))

    def holds(self, sid):
        return self.all("SELECT mode, rule FROM response_holds WHERE session_id = ? ORDER BY id", (sid,))

    def stop_row(self, sid):
        return self.one("SELECT trigger, outcome, test_mode FROM session_stops WHERE session_id = ?", (sid,))

    def events(self, tid):
        return self.all("SELECT kind, origin, detail FROM terminal_events WHERE task_id = ? ORDER BY seq", (tid,))

    def forwarder(self, tmp_path):
        return asyncio.run(xf.ExternalForwardersRepository(self.db).create(
            kind="file", name="local", url=str(tmp_path / "siem.jsonl"), redaction_level="full"))

    def alerts(self):
        return [json.loads(r[0]) for r in self.all(
            "SELECT payload_json FROM external_forward_outbox WHERE kind = 'alert' ORDER BY id")]


@pytest.fixture
def w(tmp_path, monkeypatch):
    world = World(tmp_path)
    monkeypatch.setattr(ss, "manager_resolver", lambda: world.manager)
    yield world
    world.raw.close()


def _evaluate(w, sid, result=HIGH):
    return asyncio.run(rr.evaluate(w.db, sid, result=result))


# --- storage -----------------------------------------------------------------------------


def test_migration_v64_adds_the_switch_and_the_stop_record_idempotently(w):
    assert CURRENT_SCHEMA_VERSION == 64
    assert w.one("SELECT MAX(version) FROM schema_version")[0] == 64
    cols = {r[1]: r for r in w.raw.execute("PRAGMA table_info(rung_modes)")}
    assert "stop_high" in cols and cols["stop_high"][4] == "0"
    assert w.one("SELECT name FROM sqlite_master WHERE name = 'session_stops'")
    outbox = w.one("SELECT sql FROM sqlite_master WHERE name = 'external_forward_outbox'")[0]
    assert "'alert'" in outbox
    for _ in range(2):
        asyncio.run(ensure_stop_switch_storage(w.db))
        asyncio.run(ensure_outbox_alert_kind(w.db))
    assert w.one("SELECT sql FROM sqlite_master WHERE name = 'external_forward_outbox'")[0] == outbox


def test_switch_is_off_by_default(w):
    w.mode("active")
    tid = w.task("s-def")
    assert asyncio.run(ss.is_on(w.db, HARNESS)) is False
    assert asyncio.run(rr.shadow_progress(w.db, HARNESS, read_only=True))["stop_high"] is False
    _evaluate(w, "s-def")
    assert w.manager.stopped == [] and w.stop_row("s-def") is None
    assert asyncio.run(ss.act(w.db, "s-def", ss.TRIGGER_HIGH)) is None
    assert ("stop", "auto") not in [e[:2] for e in w.events(tid)]


# --- On mode -----------------------------------------------------------------------------


def test_on_and_high_score_stops_an_app_owned_session_once(w, tmp_path):
    w.mode("active")
    w.switch(True)
    w.forwarder(tmp_path)
    tid = w.task("s-hi")
    req = asyncio.run(rr.file_request(w.db, "Bash", "Bash", HARNESS, "s-hi"))
    _evaluate(w, "s-hi", WATCH)
    assert w.manager.stopped == []
    _evaluate(w, "s-hi")
    assert w.manager.stopped == [(tid, "auto", "stopped automatically: high score")]
    assert ("stop", "auto", "stopped automatically: high score") in w.events(tid)
    assert ("active", "stop") in w.holds("s-hi")
    assert w.stop_row("s-hi") == ("high_score", "stopped", 0)
    # Pending approvals for the stopped session close as no longer needed.
    row = w.one("SELECT status, decided_by FROM jit_access_requests WHERE id = ?", (req["id"],))
    assert row == ("expired", "not_needed")
    # Once per session.
    _evaluate(w, "s-hi")
    assert len(w.manager.stopped) == 1 and len(w.alerts()) == 1
    audit = w.one("SELECT function_name, action, reason FROM tool_call_audit WHERE tool_id = ?", (ss.TOOL_ID,))
    assert audit[0] == "stop" and audit[1] == "block" and "high score" in audit[2]


def test_on_and_a_named_rule_firing_stops_the_session(w):
    w.mode("active")
    w.switch(True)
    tid = w.task("s-rule")
    asyncio.run(CallRulesRepository(w.db).mark("s-rule", "2026-10-19T12:00:00.000000", cred=True, outside=False))
    held = asyncio.run(cr.check_network(w.db, "Bash", HARNESS, "s-rule", CURL, verified=True, file=True))
    assert held == cr.RULE_CRED_NET
    assert w.manager.stopped == [(tid, "auto", "stopped automatically: Credential, then network")]
    assert w.stop_row("s-rule") == ("cred_then_net", "stopped", 0)
    assert w.holds("s-rule") == [("active", "cred_then_net"), ("active", "stop")]
    # The request the hold filed closes with the stop.
    assert w.all("SELECT status FROM jit_access_requests WHERE session_id = 's-rule'") == [("expired",)]


def test_linked_session_alerts_but_is_not_stopped(w, tmp_path):
    w.mode("active")
    w.switch(True)
    w.forwarder(tmp_path)
    tid = w.task("s-lnk", origin="linked", running=False)
    _evaluate(w, "s-lnk")
    assert w.manager.stopped == []
    assert w.stop_row("s-lnk") == ("high_score", "outside", 0)
    assert ("active", "stop") not in w.holds("s-lnk")
    assert any("could not stop: started outside SecureVector" in (e[2] or "") for e in w.events(tid))
    (alert,) = w.alerts()
    assert alert["outcome"] == "outside" and alert["test_mode"] is False


def test_a_task_not_running_here_is_left_for_a_later_trigger(w):
    w.mode("active")
    w.switch(True)
    w.task("s-gone", running=False)
    _evaluate(w, "s-gone")
    assert w.manager.stopped == [] and w.stop_row("s-gone") is None


# --- test mode ---------------------------------------------------------------------------


def test_test_mode_records_would_have_and_does_not_stop(w, tmp_path):
    w.mode("shadow")
    w.switch(True)
    w.forwarder(tmp_path)
    tid = w.task("s-tm")
    _evaluate(w, "s-tm")
    assert w.manager.stopped == []
    assert w.holds("s-tm") == [("shadow", "stop")]
    assert w.stop_row("s-tm") == ("high_score", "would_stop", 1)
    assert any("would have stopped (test mode)" in (e[2] or "") for e in w.events(tid))
    (alert,) = w.alerts()
    assert alert["outcome"] == "would_stop" and alert["test_mode"] is True
    # A stop row is not a held call: the tile's counts leave it out.
    assert asyncio.run(rr.window_counts(w.db))["would_have"] == 0


# --- the alert ---------------------------------------------------------------------------


def test_alert_payload_is_metadata_only_and_folder_is_the_basename(w, tmp_path):
    w.mode("active")
    w.switch(True)
    w.forwarder(tmp_path)
    w.task("s-al", workspace="/Users/u/secret/app")
    _evaluate(w, "s-al")
    (alert,) = w.alerts()
    assert set(alert) <= set(xf._ALERT_ALLOWED)
    assert alert["folder_name"] == "app" and alert["agent_tool"] == HARNESS
    assert alert["session_id"] == "s-al" and alert["rule"] == "high_score" and alert["score"] == 82
    assert alert["held_count"] == 0
    text = json.dumps(alert)
    assert "/Users" not in text and "secret" not in text and "example" not in text
    assert ss.folder_name("C:\\Users\\u\\proj") == "proj"
    assert ss.folder_name("/") is None


def test_alert_allow_list_rejects_extra_keys_and_path_like_values():
    good = {"emitted_at": "2026-10-19T12:00:00Z", "session_id": "s-1", "agent_tool": HARNESS,
            "folder_name": "app", "rule": "high_score", "outcome": "stopped", "test_mode": False,
            "score": 80, "held_count": 2}
    assert xf.build_alert_payload(good) == good
    for extra in ({"path": "/Users/u/app"}, {"host": "files.example.net"}, {"tool_input": "x"},
                  {"args_preview": "curl"}):
        with pytest.raises(ValueError):
            xf.build_alert_payload({**good, **extra})
    for key, bad in (("folder_name", "/Users/u/app"), ("folder_name", "u/app"), ("folder_name", "C:\\app"),
                     ("folder_name", "~"), ("folder_name", ".."), ("session_id", "../etc"),
                     ("agent_tool", "Claude Code /x"), ("rule", "anything"), ("outcome", "killed"),
                     ("score", 101), ("score", "80"), ("test_mode", "yes"), ("emitted_at", "yesterday"),
                     ("held_count", {"n": 1})):
        with pytest.raises(ValueError):
            xf.build_alert_payload({**good, key: bad})
    with pytest.raises(ValueError):
        asyncio.run(xf.ExternalForwardOutboxRepository(None).enqueue_fanout(
            "alert", {**good, "folder_name": "/tmp/x"}, forwarders=[]))
    # SIEM destinations only, never the fleet one.
    assert xf._passes_filter({"source": "user", "event_filter": "audits_only"}, "alert", good)
    assert not xf._passes_filter({"source": "enrollment"}, "alert", good)
    from securevector.app.services import siem_ocsf

    (event,) = siem_ocsf.encode_batch([{"kind": "alert", "payload": good}])
    assert event["finding"]["title"] == "Session stopped" and event["unmapped"]["folder_name"] == "app"


# --- cloud field -------------------------------------------------------------------------


def test_response_action_stopped_reaches_the_cloud_payload(w):
    from securevector.app.services import siem_ocsf
    from securevector.app.terminals import live_runs

    w.mode("active")
    w.switch(True)
    tid = w.task("s-cl")
    _evaluate(w, "s-cl")
    task = asyncio.run(w.manager.store.get_task(tid))
    adr = asyncio.run(live_runs.collect_adr(task, w.db))
    assert adr.get("response_action") == "stopped"
    assert live_runs.adr_fields({"response_action": "stopped"}, "heartbeat") == {"response_action": "stopped"}
    assert live_runs.adr_fields({"response_action": "killed"}, "exit") == {}
    assert live_runs.adr_fields({"response_action": "stopped"}, "spawn") == {}
    payload = xf.build_task_event_payload({"event": "exit", "task_id": tid, "response_action": "stopped"})
    assert payload["response_action"] == "stopped"
    row = siem_ocsf._fleet_task_event_row(payload)
    assert row["response_action"] == "stopped"


# --- routes ------------------------------------------------------------------------------


@pytest.fixture
def approvals(tmp_path, monkeypatch):
    from securevector.app.database.repositories import custom_tools
    from securevector.app.services import confirmations as cf

    monkeypatch.setenv("SV_NATIVE_APPROVALS", "1")
    db = DatabaseConnection(tmp_path / "routes.db")
    asyncio.run(run_migrations(db))
    monkeypatch.setattr(cf, "_database", lambda: db)
    monkeypatch.setattr(cf, "_notify", lambda code, summary: None)
    monkeypatch.setattr(cf.secrets, "randbelow", lambda n: 123456)
    monkeypatch.setattr(custom_tools, "_AUDIT_WRITE_LOCK", asyncio.Lock() if _has_loop() else _lock())
    cf._store.clear()
    cf._fails.clear()
    cf.detach_shell()
    yield db
    cf._store.clear()
    cf._fails.clear()


def _has_loop():
    try:
        asyncio.Lock()
        return True
    except RuntimeError:
        return False


def _lock():
    asyncio.set_event_loop(asyncio.new_event_loop())
    return asyncio.Lock()


def _client(db):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from securevector.app.services import confirmations as cf
    from securevector.app.terminals import routes
    from securevector.app.terminals.auth import TerminalAuth

    store = TerminalStore(db)
    app = FastAPI()
    app.state.port = 8741
    app.state.terminal_auth = TerminalAuth(token="t" * 48, port=8741)
    app.state.terminal_manager = type("M", (), {"store": store, "host": None})()
    app.include_router(routes.router, prefix="/api")
    cf.install(app)
    return TestClient(app, base_url="http://127.0.0.1:8741")


def _headers():
    from securevector.app.server.routes.jit_access import _UI_TOKEN
    from securevector.app.terminals.auth import HEADER

    return {HEADER: "1", "Origin": "http://127.0.0.1:8741", "X-SV-UI-Token": _UI_TOKEN}


def test_turning_on_needs_no_approval_and_off_needs_the_person(approvals):
    db = approvals
    url = f"/api/terminals/rungs/stop/{HARNESS}"
    with _client(db) as client:
        client.get("/api/terminals/session")
        hdr = _headers()
        r = client.post(url, headers=hdr, json={"on": True})
        assert r.status_code == 200 and r.json() == {"harness": HARNESS, "stop_high": True}
        assert asyncio.run(ss.is_on(db, HARNESS)) is True
        # Off answers 202 and changes nothing until the person confirms.
        r = client.post(url, headers=hdr, json={"on": False})
        assert r.status_code == 202, r.text
        assert r.json()["summary"] == "Turn off stop the session and alert for Claude Code"
        assert asyncio.run(ss.is_on(db, HARNESS)) is True
        ok = client.post(f"/api/confirmations/{r.json()['confirmation_id']}/code",
                         headers={"X-SV-UI-Token": hdr["X-SV-UI-Token"]}, json={"code": "123456"})
        assert ok.status_code == 200 and ok.json()["status"] == "confirmed", ok.text
        assert asyncio.run(ss.is_on(db, HARNESS)) is False
        assert client.post("/api/terminals/rungs/stop/nope", headers=hdr, json={"on": True}).status_code == 404
        assert client.post(url, headers=hdr, json={"on": True, "x": 1}).status_code == 422
        # The UI token is required for on too.
        no_token = {k: v for k, v in hdr.items() if k != "X-SV-UI-Token"}
        assert client.post(url, headers=no_token, json={"on": True}).status_code == 403
    rows = sqlite3.connect(db.db_path).execute(
        "SELECT function_name FROM tool_call_audit WHERE function_name LIKE 'stop_switch.%' ORDER BY id").fetchall()
    assert [r[0] for r in rows] == ["stop_switch.on", "stop_switch.off"]


def test_a_governed_caller_can_never_change_the_switch(approvals):
    db = approvals
    url = f"/api/terminals/rungs/stop/{HARNESS}"
    with _client(db) as client:
        client.get("/api/terminals/session")
        hdr = {**_headers(), "x-sv-terminal-task": "task-x", "x-sv-terminal-hook": "tok"}
        assert client.post(url, headers=hdr, json={"on": True}).status_code == 403
        assert client.post(url, headers=hdr, json={"on": False}).status_code == 403
    assert asyncio.run(ss.is_on(db, HARNESS)) is False


# --- review round ------------------------------------------------------------------------

SETTLING = drift.DriftResult(80, "high", drift.STATUS_PARTIAL, [], True, "2026-10-19T12:00:00",
                             {"sessions": 1, "calls": 4})


def test_stop_rows_are_not_counted_as_held_calls(w):
    w.mode("active")
    w.switch(True)
    w.task("s-cnt")
    _evaluate(w, "s-cnt")
    assert ("active", "stop") in w.holds("s-cnt")
    assert asyncio.run(rr.window_counts(w.db)) == {"would_have": 0, "taken": 0, "window_days": 7}
    asyncio.run(ResponseRungsRepository(w.db).record_hold("s-cnt", HARNESS, "active", "cred_then_net"))
    assert asyncio.run(rr.window_counts(w.db))["taken"] == 1


def test_a_settling_score_never_stops_but_a_named_rule_still_does(w, tmp_path):
    w.mode("active")
    w.switch(True)
    w.forwarder(tmp_path)
    tid = w.task("s-set")
    _evaluate(w, "s-set", SETTLING)
    assert w.manager.stopped == []
    assert w.holds("s-set") == [("shadow", "stop")]
    assert w.stop_row("s-set") == (ss.TRIGGER_SETTLING, "would_stop", 1)
    assert any("would have stopped (score still settling)" in (e[2] or "") for e in w.events(tid))
    (alert,) = w.alerts()
    assert alert["outcome"] == "would_stop" and alert["test_mode"] is True and alert["rule"] == "high_score"
    _evaluate(w, "s-set", SETTLING)
    assert len(w.alerts()) == 1
    # A named rule firing later still stops the session, once.
    asyncio.run(CallRulesRepository(w.db).mark("s-set", "2026-10-19T12:00:00.000000", cred=True, outside=False))
    asyncio.run(cr.check_network(w.db, "Bash", HARNESS, "s-set", CURL, verified=True, file=True))
    assert w.manager.stopped == [(tid, "auto", "stopped automatically: Credential, then network")]
    assert w.stop_row("s-set") == ("cred_then_net", "stopped", 0)
    _evaluate(w, "s-set")
    assert len(w.manager.stopped) == 1


def test_a_failure_after_the_claim_never_strands_it(w, monkeypatch):
    w.mode("active")
    w.switch(True)
    tid = w.task("s-err")

    async def boom(*a, **k):
        raise RuntimeError("audit down")

    # Before the stop: the claim is released, a later trigger acts.
    monkeypatch.setattr(ss, "_stop", boom)
    with pytest.raises(RuntimeError):
        asyncio.run(ss.act(w.db, "s-err", ss.TRIGGER_HIGH))
    assert w.stop_row("s-err") is None
    monkeypatch.undo()
    monkeypatch.setattr(ss, "manager_resolver", lambda: w.manager)
    # After the stop: the stop is recorded even though a later step failed.
    monkeypatch.setattr(ss, "_audit", boom)
    with pytest.raises(RuntimeError):
        asyncio.run(ss.act(w.db, "s-err", ss.TRIGGER_HIGH))
    assert w.manager.stopped and w.manager.stopped[0][0] == tid
    assert w.stop_row("s-err") == ("high_score", "stopped", 0)
    assert ss._OUTCOMES == {}


def test_notification_text_is_passed_as_data(monkeypatch):
    text = 'Claude Code in a"pp: <b>stopped</b> & "quoted"'
    monkeypatch.setattr(ss.sys, "platform", "darwin")
    argv = ss.notify_argv(text)
    assert argv == ["osascript", "-e", "on run argv", "-e",
                    'display notification (item 1 of argv) with title "SecureVector"', "-e", "end run", "--", text]
    monkeypatch.setattr(ss.sys, "platform", "linux")
    assert ss.notify_argv(text) == ["notify-send", "--", "SecureVector",
                                    'Claude Code in a"pp: &lt;b&gt;stopped&lt;/b&gt; &amp; "quoted"']
    monkeypatch.setattr(ss.sys, "platform", "win32")
    assert ss.notify_argv(text) is None


def test_unknown_agent_tool_is_refused_before_any_approval_prompt(approvals):
    from securevector.app.services import confirmations as cf

    with _client(approvals) as client:
        client.get("/api/terminals/session")
        r = client.post("/api/terminals/rungs/stop/nope", headers=_headers(), json={"on": False})
        assert r.status_code == 404
    assert cf._store == {}


def test_alerts_skip_the_burst_guard(w, tmp_path):
    fwd = w.forwarder(tmp_path)
    good = {"emitted_at": "2026-10-19T12:00:00Z", "session_id": "s-1", "agent_tool": HARNESS,
            "rule": "high_score", "outcome": "stopped", "test_mode": False}
    limited = {**fwd, "rate_limit_per_minute": 1, "source": "user"}
    repo = xf.ExternalForwardOutboxRepository(w.db)
    written = [asyncio.run(repo.enqueue_fanout("alert", {**good, "session_id": f"s-{i}"}, forwarders=[limited]))
               for i in range(5)]
    assert written == [1, 1, 1, 1, 1]


def _outbox_sql(w):
    return (w.one("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'external_forward_outbox'")
            or [""])[0]


def test_an_interrupted_v64_rebuild_is_repaired(w):
    # A leftover staging table beside the live one is dropped.
    w.raw.execute("CREATE TABLE external_forward_outbox_v64 (id INTEGER PRIMARY KEY)")
    w.raw.commit()
    asyncio.run(ensure_outbox_alert_kind(w.db))
    assert w.one("SELECT name FROM sqlite_master WHERE name = 'external_forward_outbox_v64'") is None
    assert "'alert'" in _outbox_sql(w)
    # The live table gone and only the staged copy left: it is renamed back,
    # rows and index kept.
    fid = w.raw.execute("INSERT INTO external_forwarders (kind, name, url) VALUES ('file', 'f', '/tmp/x.jsonl')") \
        .lastrowid
    w.raw.execute("INSERT INTO external_forward_outbox (forwarder_id, kind, payload_json) VALUES (?, 'alert', '{}')",
                  (fid,))
    w.raw.execute("ALTER TABLE external_forward_outbox RENAME TO external_forward_outbox_v64")
    w.raw.execute("DROP INDEX IF EXISTS idx_external_forward_outbox_pending")
    w.raw.commit()
    asyncio.run(ensure_outbox_alert_kind(w.db))
    assert w.one("SELECT name FROM sqlite_master WHERE name = 'external_forward_outbox_v64'") is None
    assert "'alert'" in _outbox_sql(w)
    assert w.one("SELECT COUNT(*) FROM external_forward_outbox WHERE kind = 'alert'")[0] == 1
    assert w.one("SELECT name FROM sqlite_master WHERE name = 'idx_external_forward_outbox_pending'")
    # An old table without 'alert' in its check is widened, rows kept.
    w.raw.executescript("""
        ALTER TABLE external_forward_outbox RENAME TO old_outbox;
        CREATE TABLE external_forward_outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT, forwarder_id INTEGER NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('scan', 'output_scan', 'tool_audit', 'task_event', 'generation')),
            payload_json TEXT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            attempts INTEGER NOT NULL DEFAULT 0, delivered_at TIMESTAMP, last_error TEXT);
        INSERT INTO external_forward_outbox (forwarder_id, kind, payload_json)
            SELECT forwarder_id, 'scan', payload_json FROM old_outbox;
        DROP TABLE old_outbox;
    """)
    asyncio.run(ensure_outbox_alert_kind(w.db))
    assert "'alert'" in _outbox_sql(w)
    assert w.one("SELECT COUNT(*) FROM external_forward_outbox")[0] == 1
