"""Observability reads by the app's network address.

The four read routes are also served under /api/observability with exactly
the access /api/traces has (the app-wide ingress token middleware, nothing
route-level), so the Live grid loads at http://<ip>:8741. The original
/api/terminals/observability routes and every control stay behind their
own locks.

Sync bodies + asyncio.run for setup, no lifespan (nothing outside tmp_path
is touched): see test_ingress_token_enforcement.py.
"""

from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from securevector.app.database import connection as db_module
from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.server.app import create_app
from securevector.app.terminals.auth import HEADER, TerminalAuth

TOKEN = "obs-remote-ingress-token-123"
REMOTE = "http://10.0.0.5:8741"
LOCAL = "http://127.0.0.1:8741"
NEW = ["/api/observability/coverage", "/api/observability/live", "/api/observability/egress-alerts",
       "/api/observability/sessions/s1/governance"]
OLD_PREFIX = "/api/" + "terminals/observability"


def _ts(ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=ago)).strftime("%Y-%m-%d %H:%M:%S")


@pytest.fixture
def app_db(tmp_path):
    db = DatabaseConnection(tmp_path / "t.db")
    asyncio.run(run_migrations(db))
    raw = sqlite3.connect(tmp_path / "t.db")
    raw.execute(
        "INSERT INTO tool_call_audit (tool_id, function_name, action, reason, args_preview, called_at, "
        "seq, row_hash, runtime_kind, session_id, trace_id, span_id) VALUES "
        "('Bash', 'Bash', 'allow', NULL, 'ls', ?, 1, 'h1', 'claude-code', 's1', 'tr-s1', 'sp1')",
        (_ts(30),),
    )
    raw.commit()
    raw.close()
    prev = db_module._db
    db_module._db = db
    app = create_app()
    app.state.terminal_auth = TerminalAuth(token="t" * 48, port=8741)
    try:
        yield app
    finally:
        db_module._db = prev
        asyncio.run(db.disconnect())


def test_new_reads_answer_by_network_address(app_db, monkeypatch):
    monkeypatch.delenv("SECUREVECTOR_INGRESS_TOKEN", raising=False)
    client = TestClient(app_db, base_url=REMOTE)
    for path in NEW:
        r = client.get(path)
        assert r.status_code == 200, (path, r.status_code, r.text[:200])
    live = client.get("/api/observability/live").json()
    assert [s["session_id"] for s in live["sessions"]] == ["s1"]
    assert client.get("/api/observability/sessions/s1/governance").json()["session_id"] == "s1"
    # Input checks are the handlers', unchanged.
    assert client.get("/api/observability/sessions/bad%20id/governance").status_code == 400
    assert client.get("/api/observability/live?group=nope").status_code == 422


@pytest.mark.parametrize("path", NEW)
def test_new_reads_are_guarded_exactly_like_traces(app_db, monkeypatch, path):
    monkeypatch.setenv("SECUREVECTOR_INGRESS_TOKEN", TOKEN)
    for base in (REMOTE, LOCAL):
        client = TestClient(app_db, base_url=base)
        cases = [
            {},
            {"Authorization": "Bearer wrong"},
            {"X-Api-Key": "wrong"},
            {"Authorization": f"Bearer {TOKEN}"},
            {"X-Api-Key": TOKEN},
        ]
        for headers in cases:
            want = client.get("/api/traces", headers=headers).status_code
            got = client.get(path, headers=headers).status_code
            assert got == want, (base, path, headers, got, want)
        assert client.get(path).status_code == 401
        assert client.get(path, headers={"X-Api-Key": TOKEN}).status_code == 200


def test_old_terminals_routes_unchanged(app_db, monkeypatch):
    monkeypatch.delenv("SECUREVECTOR_INGRESS_TOKEN", raising=False)
    # By network address: refused, with or without the header.
    remote = TestClient(app_db, base_url=REMOTE)
    assert remote.get(OLD_PREFIX + "/live", headers={HEADER: "1"}).status_code == 403
    assert remote.get(OLD_PREFIX + "/coverage").status_code == 403
    # On loopback without the session cookie: refused.
    bare = TestClient(app_db, base_url=LOCAL)
    assert bare.get(OLD_PREFIX + "/coverage", headers={HEADER: "1"}).status_code == 403
    # On loopback with the session cookie and header: served as before.
    local = TestClient(app_db, base_url=LOCAL)
    assert local.get("/api/" + "terminals/session").status_code == 200
    for tail in ("/coverage", "/live", "/egress-alerts", "/sessions/s1/governance"):
        assert local.get(OLD_PREFIX + tail, headers={HEADER: "1"}).status_code == 200, tail


def test_controls_still_refused_by_network_address(app_db, monkeypatch):
    monkeypatch.delenv("SECUREVECTOR_INGRESS_TOKEN", raising=False)
    remote = TestClient(app_db, base_url=REMOTE)
    auth = {HEADER: "1", "Origin": REMOTE}
    # Session controls: the terminals lock answers before anything runs.
    assert remote.post("/api/" + "terminals/tasks/t1/stop", headers=auth).status_code == 403
    assert remote.post("/api/" + "terminals/tasks", headers=auth, json={}).status_code == 403
    assert remote.get("/api/" + "terminals/session").status_code == 403
    # Approve and deny: still need the UI token, which this caller lacks.
    assert remote.post("/api/jit/requests/rq-1/approve", json={"duration": "once"}).status_code == 403
    assert remote.post("/api/jit/requests/rq-1/deny", json={}).status_code == 403
    assert remote.post("/api/jit/grants/g-1/revoke", json={}).status_code == 403
    # No write route was added under the new prefix.
    for path in NEW:
        assert remote.post(path, json={}).status_code == 405, path
