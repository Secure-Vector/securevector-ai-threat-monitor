"""Remote access mode (6.1.0, phase 1).

Off by default. On, a browser on another machine that presents the access
token may approve, deny and revoke approvals, list sessions and stop one;
everything else keeps answering only on this machine.

Sync bodies + asyncio.run for setup, no lifespan (nothing outside tmp_path
is touched): see test_observability_remote_read.py.
"""

from __future__ import annotations

import asyncio
import sqlite3

import pytest
from fastapi.testclient import TestClient

from securevector.app.database import connection as db_module
from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import (
    ensure_cloud_approval_storage,
    ensure_remote_access_column,
    run_migrations,
)
from securevector.app.database.repositories.jit_access import JitAccessRepository
from securevector.app.server import remote_access as ra
from securevector.app.server.app import create_app
from securevector.app.server.routes import jit_access
from securevector.app.services import cloud_approvals
from securevector.app.terminals import routes as terminal_routes
from securevector.app.terminals.auth import TerminalAuth

LOCAL = "http://127.0.0.1:8741"
REMOTE = "https://sv.example.com"
PROXY = ("10.0.0.2", 40000)
BROWSER = "203.0.113.7"
FWD = {"X-Forwarded-Proto": "https", "X-Forwarded-For": BROWSER}
TERM = "/api/" + "terminals"
FP = "b" * 64


class _Store:
    def __init__(self):
        self.tasks = {"t1": {"id": "t1", "status": "running", "origin": "launch"}}

    async def list_tasks(self):
        return [dict(t) for t in self.tasks.values()]

    async def get_task(self, task_id):
        return self.tasks.get(task_id)


class _Manager:
    host = None

    def __init__(self):
        self.store = _Store()
        self.stopped = []

    def running_count(self):
        return 1

    async def stop(self, task_id, *, origin, detail=None):
        self.stopped.append((task_id, origin))


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    ra.reset()
    monkeypatch.delenv("SECUREVECTOR_INGRESS_TOKEN", raising=False)
    monkeypatch.setenv("SV_DECISION_PEER_CHECK", "0")

    async def _same(_manager, items):
        return items

    monkeypatch.setattr(terminal_routes, "_decorate", _same)
    yield
    ra.reset()


@pytest.fixture
def env(tmp_path):
    db = DatabaseConnection(tmp_path / "t.db")
    asyncio.run(run_migrations(db))
    asyncio.run(ensure_cloud_approval_storage(db))
    asyncio.run(ensure_remote_access_column(db))
    prev = db_module._db
    db_module._db = db
    app = create_app(host="0.0.0.0")
    app.state.terminal_auth = TerminalAuth(token="t" * 48, port=8741)
    app.state.terminal_manager = _Manager()
    try:
        yield {"app": app, "db": db, "path": tmp_path / "t.db"}
    finally:
        db_module._db = prev
        asyncio.run(db.disconnect())


def _local(app):
    return TestClient(app, base_url=LOCAL, client=("127.0.0.1", 50000))


def _remote(app, peer=PROXY, base=REMOTE):
    return TestClient(app, base_url=base, client=peer)


def _ui():
    return {"X-SV-UI-Token": jit_access._UI_TOKEN}


def _enable(app, **over):
    body = {"action": "enable", "allowed_address": REMOTE, "proxy_address": "10.0.0.2"}
    body.update(over)
    r = _local(app).post("/api/remote-access", json=body, headers=_ui())
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _sign_in(app, token):
    r = _remote(app).post("/api/remote-access/session", json={"token": token}, headers=FWD)
    assert r.status_code == 200, r.text
    return {**FWD, "X-SV-Remote-Session": r.json()["session_id"]}


def _request(env, *, fp=FP, held_by=None, source="local", tool="Bash"):
    async def make():
        return await JitAccessRepository(env["db"]).create_request(
            tool_id=tool, rule_source=source, runtime_kind="claude-code", session_id="s1",
            call_fingerprint=fp, held_by=held_by)
    return asyncio.run(make())["id"]


def _audit(env, fn_prefix):
    raw = sqlite3.connect(env["path"])
    try:
        return [r[0] for r in raw.execute(
            "SELECT args_preview FROM tool_call_audit WHERE function_name LIKE ? ORDER BY id",
            (fn_prefix + "%",))]
    finally:
        raw.close()


def _row(env, rid):
    raw = sqlite3.connect(env["path"])
    try:
        return raw.execute("SELECT status, decided_by, decision_source FROM jit_access_requests WHERE id = ?",
                           (rid,)).fetchone()
    finally:
        raw.close()


# --- settings routes ------------------------------------------------------------------


def test_off_by_default_and_state_never_carries_the_token(env):
    r = _local(env["app"]).get("/api/remote-access").json()
    assert r["enabled"] is False and r["signed_in"] is False and r["local"] is True
    assert r["bound_loopback_only"] is False
    token = _enable(env["app"])
    assert token.startswith(ra.TOKEN_PREFIX)
    state = _local(env["app"]).get("/api/remote-access").json()
    assert state["enabled"] is True and "token" not in state
    assert token not in str(state)
    raw = sqlite3.connect(env["path"]).execute("SELECT remote_access FROM app_settings").fetchone()[0]
    assert token not in raw and "remote_token_hash" in raw


def test_settings_post_refuses_a_network_address(env):
    _enable(env["app"])
    r = _remote(env["app"]).post("/api/remote-access", json={"action": "disable"},
                                 headers={**FWD, **_ui()})
    assert r.status_code == 403 and r.json()["detail"] == ra.LOCAL_ONLY_DETAIL
    # A non-loopback peer with a loopback Host is still not this machine.
    r = TestClient(env["app"], base_url=LOCAL, client=("10.0.0.9", 1)).post(
        "/api/remote-access", json={"action": "disable"}, headers=_ui())
    assert r.status_code == 403


def test_settings_post_needs_the_ui_token(env):
    r = _local(env["app"]).post("/api/remote-access", json={"action": "enable", "allowed_address": REMOTE,
                                                            "proxy_address": "10.0.0.2"})
    assert r.status_code == 403


def test_enable_refused_when_bound_to_loopback(tmp_path):
    db = DatabaseConnection(tmp_path / "t.db")
    asyncio.run(run_migrations(db))
    prev = db_module._db
    db_module._db = db
    try:
        app = create_app()  # 127.0.0.1
        assert _local(app).get("/api/remote-access").json()["bound_loopback_only"] is True
        r = _local(app).post("/api/remote-access", json={"action": "enable", "allowed_address": REMOTE,
                                                          "proxy_address": "10.0.0.2"}, headers=_ui())
        assert r.status_code == 409 and r.json()["detail"] == ra.NOT_NEEDED_DETAIL
    finally:
        db_module._db = prev
        asyncio.run(db.disconnect())


@pytest.mark.parametrize("address", ["http://sv.example.com", "sv.example.com", "https://", "https://x/path"])
def test_enable_refuses_an_address_that_is_not_https(env, address):
    r = _local(env["app"]).post("/api/remote-access", json={"action": "enable", "allowed_address": address,
                                                            "proxy_address": "10.0.0.2"}, headers=_ui())
    assert r.status_code == 422
    assert _local(env["app"]).get("/api/remote-access").json()["enabled"] is False


def test_enable_needs_a_proxy_address(env):
    r = _local(env["app"]).post("/api/remote-access", json={"action": "enable", "allowed_address": REMOTE,
                                                            "proxy_address": ""}, headers=_ui())
    assert r.status_code == 422
    r = _local(env["app"]).post("/api/remote-access", json={"action": "enable", "allowed_address": REMOTE,
                                                            "proxy_address": "not-an-ip"}, headers=_ui())
    assert r.status_code == 422


# --- sign in --------------------------------------------------------------------------


def test_sign_in_success_and_wrong_token(env):
    token = _enable(env["app"])
    r = _remote(env["app"]).post("/api/remote-access/session", json={"token": "nope"}, headers=FWD)
    assert r.status_code == 401
    headers = _sign_in(env["app"], token)
    state = _remote(env["app"]).get("/api/remote-access", headers=headers).json()
    assert state["signed_in"] is True and state["enabled"] is True and state["local"] is False
    assert "allowed_address" not in state and "proxy_address" not in state
    rows = _audit(env, "remote.sign_in")
    assert any("outcome=wrong_token" in r and f"address={BROWSER}" in r for r in rows)
    assert any("outcome=ok" in r and "source=remote" in r for r in rows)


def test_sign_in_refused_while_off(env):
    r = _remote(env["app"]).post("/api/remote-access/session", json={"token": "x"}, headers=FWD)
    assert r.status_code == 403


def test_five_wrong_tokens_lock_the_address(env):
    token = _enable(env["app"])
    for _ in range(ra.FAIL_LIMIT):
        assert _remote(env["app"]).post("/api/remote-access/session", json={"token": "bad"},
                                        headers=FWD).status_code == 401
    r = _remote(env["app"]).post("/api/remote-access/session", json={"token": token}, headers=FWD)
    assert r.status_code == 429
    assert _audit(env, "remote.lock")
    # Another address is not locked.
    r = _remote(env["app"]).post("/api/remote-access/session", json={"token": token},
                                 headers={**FWD, "X-Forwarded-For": "198.51.100.4"})
    assert r.status_code == 200


def test_lock_ends_after_15_minutes(env, monkeypatch):
    token = _enable(env["app"])
    now = [1_000_000.0]
    monkeypatch.setattr(ra, "_now", lambda: now[0])
    for _ in range(ra.FAIL_LIMIT):
        _remote(env["app"]).post("/api/remote-access/session", json={"token": "bad"}, headers=FWD)
    assert _remote(env["app"]).post("/api/remote-access/session", json={"token": token},
                                    headers=FWD).status_code == 429
    now[0] += ra.LOCK_S + 1
    assert _remote(env["app"]).post("/api/remote-access/session", json={"token": token},
                                    headers=FWD).status_code == 200


def test_session_expiry_and_idle(env, monkeypatch):
    token = _enable(env["app"])
    now = [1_000_000.0]
    monkeypatch.setattr(ra, "_now", lambda: now[0])
    headers = _sign_in(env["app"], token)
    poll = {**headers, "X-SV-Poll": "1"}
    # Background polls (X-SV-Poll: 1) do not keep a session alive.
    for _ in range(3):
        now[0] += ra.SESSION_IDLE_S // 3
        _remote(env["app"]).get(TERM + "/tasks", headers=poll)
    now[0] += 5
    assert _remote(env["app"]).get(TERM + "/tasks", headers=poll).status_code == 401
    # A request the person makes does, a GET included.
    headers = _sign_in(env["app"], token)
    now[0] += ra.SESSION_IDLE_S - 5
    assert _remote(env["app"]).get(TERM + "/tasks", headers=headers).status_code == 200
    now[0] += ra.SESSION_IDLE_S - 5
    assert _remote(env["app"]).get(TERM + "/tasks", headers={**headers, "X-SV-Poll": "1"}).status_code == 200
    # Kept busy, a session still ends after 12 hours.
    for _ in range(int(ra.SESSION_TTL_S // (ra.SESSION_IDLE_S - 60)) + 1):
        now[0] += ra.SESSION_IDLE_S - 60
        r = _remote(env["app"]).get(TERM + "/tasks", headers=headers)
    assert r.status_code == 401


def test_rotate_and_disable_sign_everyone_out(env):
    token = _enable(env["app"])
    headers = _sign_in(env["app"], token)
    r = _local(env["app"]).post("/api/remote-access", json={"action": "rotate"}, headers=_ui())
    new = r.json()["token"]
    assert new != token
    assert _remote(env["app"]).get(TERM + "/tasks", headers=headers).status_code == 401
    assert _remote(env["app"]).post("/api/remote-access/session", json={"token": token},
                                    headers=FWD).status_code == 401
    headers = _sign_in(env["app"], new)
    _local(env["app"]).post("/api/remote-access", json={"action": "disable"}, headers=_ui())
    r = _remote(env["app"]).get(TERM + "/tasks", headers=headers)
    assert r.status_code == 403 and r.json()["detail"] == ra.OFF_DETAIL


def test_sign_out_ends_the_session(env):
    headers = _sign_in(env["app"], _enable(env["app"]))
    assert _remote(env["app"]).post("/api/remote-access/session/end", headers=headers).status_code == 200
    assert _remote(env["app"]).get(TERM + "/tasks", headers=headers).status_code == 401
    assert _audit(env, "remote.sign_out")


# --- Host allowlist and HTTPS ---------------------------------------------------------


def test_host_allowlist_only_while_on(env):
    other = TestClient(env["app"], base_url="http://evil.example", client=("127.0.0.1", 1))
    assert other.get("/api/remote-access").status_code == 200
    _enable(env["app"])
    r = other.get("/api/remote-access")
    assert r.status_code == 403 and r.json() == {"detail": "Host not allowed"}
    assert other.get("/health").status_code == 200
    assert _local(env["app"]).get("/api/remote-access").status_code == 200
    assert TestClient(env["app"], base_url="http://localhost:9999",
                      client=("127.0.0.1", 1)).get("/api/remote-access").status_code == 200
    assert _remote(env["app"]).get("/api/remote-access", headers=FWD).status_code == 200
    # The allowed address has no port: only the https default (443) or none.
    assert _remote(env["app"], base="https://sv.example.com:443").get(
        "/api/remote-access", headers=FWD).status_code == 200
    assert _remote(env["app"], base="https://sv.example.com:8443").get(
        "/api/remote-access", headers=FWD).status_code == 403


def test_host_allowlist_with_a_port_is_exact(env):
    _enable(env["app"], allowed_address="https://sv.example.com:8443")
    assert _remote(env["app"], base="https://sv.example.com:8443").get(
        "/api/remote-access", headers=FWD).status_code == 200
    assert _remote(env["app"], base="https://sv.example.com:9443").get(
        "/api/remote-access", headers=FWD).status_code == 403


def test_remote_requests_need_https_through_the_listed_proxy(env):
    _enable(env["app"])
    # No forwarded proto.
    r = _remote(env["app"]).get("/api/remote-access")
    assert r.status_code == 403 and r.json()["detail"] == ra.HTTPS_DETAIL
    # Plain http through the proxy.
    r = _remote(env["app"]).get("/api/remote-access", headers={"X-Forwarded-Proto": "http"})
    assert r.status_code == 403
    # https claimed by a peer that is not a listed proxy.
    r = _remote(env["app"], peer=("10.9.9.9", 1)).get("/api/remote-access", headers=FWD)
    assert r.status_code == 403
    assert _remote(env["app"]).get("/api/remote-access", headers=FWD).status_code == 200
    # A loopback peer with a loopback Host is unaffected.
    assert _local(env["app"]).get("/api/remote-access").status_code == 200


def test_off_changes_nothing_for_network_reads(env):
    r = TestClient(env["app"], base_url="http://10.0.0.5:8741", client=("10.0.0.9", 1)).get(
        "/api/remote-access")
    assert r.status_code == 200


# --- approvals from another machine ---------------------------------------------------


def test_remote_approve_once_records_source_and_approver(env):
    headers = _sign_in(env["app"], _enable(env["app"]))
    rid = _request(env)
    r = _remote(env["app"]).post(f"/api/jit/requests/{rid}/approve", json={"duration": "once"}, headers=headers)
    assert r.status_code == 200, r.text
    status, by, source = _row(env, rid)
    assert (status, by, source) == ("approved", f"remote:{BROWSER}", "remote")
    assert any("outcome=ok" in a and "path=/api/jit/requests/" in a for a in _audit(env, "remote.approve"))
    grants = _remote(env["app"]).get("/api/jit/grants", headers=headers).json()["items"]
    assert grants[0]["decision_source"] == "remote" and grants[0]["decided_by"] == f"remote:{BROWSER}"


@pytest.mark.parametrize("duration", ["15m", "1h", "session"])
def test_remote_approve_longer_than_once_is_422(env, duration):
    headers = _sign_in(env["app"], _enable(env["app"]))
    rid = _request(env)
    r = _remote(env["app"]).post(f"/api/jit/requests/{rid}/approve", json={"duration": duration},
                                 headers=headers)
    assert r.status_code == 422 and r.json()["detail"] == ra.DURATION_DETAIL
    assert _row(env, rid)[0] == "pending"


def test_remote_approve_follows_the_device_allowance(env):
    headers = _sign_in(env["app"], _enable(env["app"]))
    asyncio.run(cloud_approvals.set_settings(env["db"], {"allowance": ["once", "15m"]}))
    rid = _request(env)
    r = _remote(env["app"]).post(f"/api/jit/requests/{rid}/approve", json={"duration": "15m"}, headers=headers)
    assert r.status_code == 200, r.text


def test_remote_approve_once_needs_the_fingerprint(env):
    headers = _sign_in(env["app"], _enable(env["app"]))
    rid = _request(env, fp=None)
    r = _remote(env["app"]).post(f"/api/jit/requests/{rid}/approve", json={"duration": "once"}, headers=headers)
    assert r.status_code == 422


@pytest.mark.parametrize("rule", ["cred_then_net", "outside_then_reach"])
def test_device_only_rules_are_refused_remotely_but_deny_works(env, rule):
    headers = _sign_in(env["app"], _enable(env["app"]))
    rid = _request(env, held_by=rule)
    r = _remote(env["app"]).post(f"/api/jit/requests/{rid}/approve", json={"duration": "once"}, headers=headers)
    assert r.status_code == 403 and r.json()["detail"] == ra.DEVICE_ONLY_DETAIL
    r = _remote(env["app"]).post(f"/api/jit/requests/{rid}/deny", json={}, headers=headers)
    assert r.status_code == 200
    assert _row(env, rid)[0] == "denied" and _row(env, rid)[2] == "remote"


def test_approve_and_revoke_need_reauth_deny_does_not(env, monkeypatch):
    token = _enable(env["app"])
    now = [1_000_000.0]
    monkeypatch.setattr(ra, "_now", lambda: now[0])
    headers = _sign_in(env["app"], token)
    rid, rid2 = _request(env), _request(env, tool="Write")
    now[0] += ra.REAUTH_S + 1
    keep_alive = _remote(env["app"]).get("/api/remote-access", headers=headers).json()
    assert keep_alive["reauth_fresh"] is False
    r = _remote(env["app"]).post(f"/api/jit/requests/{rid}/approve", json={"duration": "once"}, headers=headers)
    assert r.status_code == 401 and r.json()["detail"] == ra.REAUTH_DETAIL
    assert _remote(env["app"]).post(f"/api/jit/requests/{rid2}/deny", json={}, headers=headers).status_code == 200
    # Wrong token on re-entry counts toward the limit.
    assert _remote(env["app"]).post("/api/remote-access/reauth", json={"token": "bad"},
                                    headers=headers).status_code == 401
    assert _remote(env["app"]).post("/api/remote-access/reauth", json={"token": token},
                                    headers=headers).status_code == 200
    r = _remote(env["app"]).post(f"/api/jit/requests/{rid}/approve", json={"duration": "once"}, headers=headers)
    assert r.status_code == 200
    grant = r.json()["grant"]["id"]
    now[0] += ra.REAUTH_S + 1
    _remote(env["app"]).get("/api/remote-access", headers=headers)
    r = _remote(env["app"]).post(f"/api/jit/grants/{grant}/revoke", json={}, headers=headers)
    assert r.status_code == 401
    _remote(env["app"]).post("/api/remote-access/reauth", json={"token": token}, headers=headers)
    r = _remote(env["app"]).post(f"/api/jit/grants/{grant}/revoke", json={}, headers=headers)
    assert r.status_code == 200 and r.json() == {"revoked": True}
    assert any("outcome=ok" in a for a in _audit(env, "remote.revoke"))
    assert any("outcome=reauth_required" in a for a in _audit(env, "remote.approve"))


def test_decisions_without_a_remote_session_still_need_the_ui_token(env):
    _enable(env["app"])
    rid = _request(env)
    r = _remote(env["app"]).post(f"/api/jit/requests/{rid}/approve", json={"duration": "once"}, headers=FWD)
    assert r.status_code == 403
    r = _remote(env["app"]).post(f"/api/jit/requests/{rid}/approve", json={"duration": "once"},
                                 headers={**FWD, "X-SV-Remote-Session": "0" * 64})
    assert r.status_code == 401
    assert _row(env, rid)[0] == "pending"


# --- terminals: list and stop only ----------------------------------------------------


def test_list_and_stop_with_a_remote_session(env):
    headers = _sign_in(env["app"], _enable(env["app"]))
    r = _remote(env["app"]).get(TERM + "/tasks", headers=headers)
    assert r.status_code == 200 and r.json()["items"][0]["id"] == "t1"
    r = _remote(env["app"]).post(TERM + "/tasks/t1/stop", headers=headers)
    assert r.status_code == 200
    assert env["app"].state.terminal_manager.stopped == [("t1", "ui")]
    assert any("outcome=ok" in a and f"address={BROWSER}" in a for a in _audit(env, "remote.stop"))


def test_list_and_stop_without_a_remote_session_are_refused(env):
    _enable(env["app"])
    assert _remote(env["app"]).get(TERM + "/tasks", headers=FWD).status_code == 403
    assert _remote(env["app"]).post(TERM + "/tasks/t1/stop", headers=FWD).status_code == 403
    assert env["app"].state.terminal_manager.stopped == []


@pytest.mark.parametrize("method,path", [
    ("get", "/tasks/t1"), ("get", "/executors"), ("get", "/sessions/unlinked"),
    ("post", "/tasks"), ("post", "/tasks/link"), ("post", "/stop-all"),
    ("post", "/tasks/t1/archive"), ("get", "/tasks/t1/events"), ("get", "/session"),
])
def test_every_other_terminals_route_refuses_a_remote_session(env, method, path):
    headers = _sign_in(env["app"], _enable(env["app"]))
    client = _remote(env["app"])
    r = getattr(client, method)(TERM + path, headers=headers, **({"json": {}} if method == "post" else {}))
    assert r.status_code == 403, (path, r.status_code)
    assert env["app"].state.terminal_manager.stopped == []


def test_spawn_with_a_valid_body_is_refused_remotely(env):
    headers = _sign_in(env["app"], _enable(env["app"]))
    r = _remote(env["app"]).post(TERM + "/tasks", json={"executor": "claude-code", "workspace": "/tmp"},
                                 headers=headers)
    assert r.status_code == 403


def test_local_list_keeps_the_terminals_lock(env):
    # No remote session, no terminals cookie: refused as before.
    assert _local(env["app"]).get(TERM + "/tasks").status_code == 403


# --- with the ingress token (self-host) -----------------------------------------------


INGRESS = "ingress-token-for-tests-123"


def test_ingress_token_and_remote_session_work_together(env, monkeypatch):
    token = _enable(env["app"])
    monkeypatch.setenv("SECUREVECTOR_INGRESS_TOKEN", INGRESS)
    gate = {"Authorization": "Bearer " + INGRESS}
    r = _remote(env["app"]).post("/api/remote-access/session", json={"token": token}, headers={**FWD, **gate})
    assert r.status_code == 200, r.text
    headers = {**FWD, **gate, "X-SV-Remote-Session": r.json()["session_id"]}
    rid = _request(env)
    r = _remote(env["app"]).post(f"/api/jit/requests/{rid}/approve", json={"duration": "once"}, headers=headers)
    assert r.status_code == 200, r.text
    assert _row(env, rid)[2] == "remote"
    # X-Api-Key carries the ingress token just as well.
    rid2 = _request(env, tool="Write")
    alt = {**FWD, "X-Api-Key": INGRESS, "X-SV-Remote-Session": headers["X-SV-Remote-Session"]}
    assert _remote(env["app"]).post(f"/api/jit/requests/{rid2}/deny", json={}, headers=alt).status_code == 200


def test_remote_session_without_the_ingress_token_is_stopped_by_the_gate(env, monkeypatch):
    headers = _sign_in(env["app"], _enable(env["app"]))
    monkeypatch.setenv("SECUREVECTOR_INGRESS_TOKEN", INGRESS)
    rid = _request(env)
    r = _remote(env["app"]).post(f"/api/jit/requests/{rid}/approve", json={"duration": "once"}, headers=headers)
    assert r.status_code == 401 and r.json() == {"error": "Unauthorized"}
    assert _remote(env["app"]).get("/api/remote-access", headers=headers).status_code == 401
    assert _remote(env["app"]).post("/api/remote-access/session", json={"token": "x"}, headers=headers).status_code == 401
    assert _row(env, rid)[0] == "pending"


# --- review follow-ups ----------------------------------------------------------------


def test_a_loopback_proxy_address_is_refused(env):
    for proxy in ("127.0.0.1", "127.0.0.0/8", "::1", "::ffff:127.0.0.1", "10.0.0.2, 127.0.0.5", "0.0.0.0/0"):
        r = _local(env["app"]).post("/api/remote-access", json={"action": "enable", "allowed_address": REMOTE,
                                                                "proxy_address": proxy}, headers=_ui())
        assert r.status_code == 422, proxy
        assert r.json()["detail"] == ra.LOOPBACK_PROXY_DETAIL
    _enable(env["app"])
    r = _local(env["app"]).post("/api/remote-access", json={"action": "update", "proxy_address": "127.0.0.1"},
                                headers=_ui())
    assert r.status_code == 422


def test_same_host_proxy_rewriting_host_is_never_local(env):
    """nginx on this machine, pointed at the private IP but without
    proxy_set_header Host: peer 10.0.0.2, Host 127.0.0.1."""
    _enable(env["app"])
    proxied = TestClient(env["app"], base_url=LOCAL, client=PROXY)
    fwd = {"X-Forwarded-For": BROWSER, "X-Forwarded-Proto": "https"}
    r = proxied.get("/api/jit/ui-token", headers={**fwd, "Sec-Fetch-Site": "same-origin"})
    assert r.status_code == 403 and r.json()["detail"] == ra.PROXY_HOST_DETAIL
    r = proxied.post(TERM + "/tasks", json={"executor": "claude-code", "workspace": "/tmp"}, headers=fwd)
    assert r.status_code == 403
    assert proxied.get(TERM + "/tasks", headers=fwd).status_code == 403
    assert proxied.get(TERM + "/session", headers=fwd).status_code == 403
    # A loopback peer carrying a forwarding header is never local either.
    loop = TestClient(env["app"], base_url=LOCAL, client=("127.0.0.1", 41000))
    r = loop.get("/api/jit/ui-token", headers={"X-Forwarded-For": BROWSER, "Sec-Fetch-Site": "same-origin"})
    assert r.status_code == 403
    assert loop.get("/api/remote-access", headers={"X-Real-IP": BROWSER}).status_code == 403
    # Correctly configured (original Host passed), the list needs a session.
    assert _remote(env["app"]).get(TERM + "/tasks", headers=fwd).status_code == 403


def test_local_hooks_keep_working_while_on(env):
    """Agent hooks on this machine: peer 127.0.0.1, loopback Host, no
    forwarding headers."""
    _enable(env["app"])
    hook = TestClient(env["app"], base_url=LOCAL, client=("127.0.0.1", 42000))
    r = hook.post("/analyze", json={"text": "hello"})
    assert r.status_code == 200, r.text
    r = hook.post("/api/jit/requests", json={"tool_id": "Bash", "session_id": "s9"})
    # Reached the route: Bash is not denied, so nothing needs requesting.
    assert r.status_code == 409 and r.json()["detail"]["error"] == "not_denied", r.text
    assert hook.get("/api/jit/requests").status_code == 200


def test_loopback_helper_while_on(env):
    from types import SimpleNamespace

    from securevector.app.server.loopback import asked_on_this_machine

    _enable(env["app"])
    _local(env["app"]).get("/api/remote-access")  # cache loaded
    req = lambda peer, headers: SimpleNamespace(client=SimpleNamespace(host=peer), headers=headers)  # noqa: E731
    assert asked_on_this_machine(req("127.0.0.1", {"host": "127.0.0.1:8741"}))
    assert asked_on_this_machine(req("::1", {"host": "localhost:8741"}))
    assert not asked_on_this_machine(req("::1", {"host": "localhost:8741", "x-forwarded-host": "a"}))
    assert not asked_on_this_machine(req("::1", {"host": "localhost:8741", "forwarded": "for=1.2.3.4"}))
    assert not asked_on_this_machine(req("10.0.0.2", {"host": "127.0.0.1:8741"}))


def test_a_loopback_caller_cannot_use_a_session(env):
    token = _enable(env["app"])
    headers = _sign_in(env["app"], token)
    sid = headers["X-SV-Remote-Session"]
    rid = _request(env)
    r = _local(env["app"]).post(f"/api/jit/requests/{rid}/approve", json={"duration": "once"},
                                headers={"X-SV-Remote-Session": sid})
    assert r.status_code == 403 and r.json()["detail"] == ra.LOCAL_SESSION_DETAIL
    r = _local(env["app"]).post("/api/remote-access/session", json={"token": token})
    assert r.status_code == 403
    r = _local(env["app"]).post("/api/remote-access/reauth", json={"token": token},
                                headers={"X-SV-Remote-Session": sid})
    assert r.status_code == 403
    assert _row(env, rid)[0] == "pending"


def test_spoofed_forwarded_for_gets_no_extra_tries(env):
    token = _enable(env["app"])
    for i in range(ra.FAIL_LIMIT):
        # The client writes its own X-Forwarded-For; the proxy appends the real one.
        spoof = {**FWD, "X-Forwarded-For": f"198.51.100.{i}, {BROWSER}"}
        assert _remote(env["app"]).post("/api/remote-access/session", json={"token": "bad"},
                                        headers=spoof).status_code == 401
    r = _remote(env["app"]).post("/api/remote-access/session", json={"token": token},
                                 headers={**FWD, "X-Forwarded-For": f"198.51.100.99, {BROWSER}"})
    assert r.status_code == 429
    # Forwarded headers from a peer that is not a listed proxy are not trusted.
    assert ra.remote_address("10.9.9.9", {"x-forwarded-for": "1.2.3.4"}, ra.cached_state()) == "10.9.9.9"


def test_two_hop_proxy_keys_per_client(env):
    _enable(env["app"], proxy_address="10.0.0.2, 10.0.0.3")
    state = ra.cached_state()
    assert ra.remote_address("10.0.0.2", {"x-forwarded-for": "203.0.113.5, 10.0.0.3"}, state) == "203.0.113.5"
    assert ra.remote_address("10.0.0.2", {"x-forwarded-for": "10.0.0.3"}, state) == "10.0.0.2"


def test_tracked_addresses_are_capped(env, monkeypatch):
    monkeypatch.setattr(ra, "MAX_TRACKED", 5)
    for i in range(20):
        ra._failures[f"a{i}"] = [1.0]
        ra._cap_failures()
        ra._locks[f"a{i}"] = 1.0
        ra._cap_locks()
    assert len(ra._failures) == 5 and len(ra._locks) == 5 and "a19" in ra._failures


def test_ipv4_mapped_proxy_peer(env):
    token = _enable(env["app"])
    r = _remote(env["app"], peer=("::ffff:10.0.0.2", 1)).post(
        "/api/remote-access/session", json={"token": token}, headers=FWD)
    assert r.status_code == 200


def test_delegation_approve_is_refused_remotely(env):
    headers = _sign_in(env["app"], _enable(env["app"]))
    rid = _request(env, source="delegate", tool="delegate:codex")
    r = _remote(env["app"]).post(f"/api/jit/requests/{rid}/approve", json={"duration": "once"}, headers=headers)
    assert r.status_code == 403 and r.json()["detail"] == ra.DEVICE_ONLY_DETAIL
    assert any("outcome=device_only" in a for a in _audit(env, "remote.approve"))


def test_websocket_with_a_bad_host_is_closed_1008(env):
    from starlette.websockets import WebSocketDisconnect

    _enable(env["app"])
    client = TestClient(env["app"], base_url="http://evil.example", client=("10.0.0.9", 1))
    with pytest.raises(WebSocketDisconnect) as info:
        with client.websocket_connect(TERM + "/tasks/t1/ws"):
            pass
    assert info.value.code == 1008


def test_failed_remote_actions_are_audited(env):
    headers = _sign_in(env["app"], _enable(env["app"]))
    _remote(env["app"]).post("/api/jit/requests/nope/approve", json={"duration": "once"}, headers=headers)
    _remote(env["app"]).post("/api/jit/requests/nope/deny", json={}, headers=headers)
    _remote(env["app"]).post("/api/jit/grants/nope/revoke", json={}, headers=headers)
    env["app"].state.terminal_manager.store.tasks.pop("t1")
    _remote(env["app"]).post(TERM + "/tasks/t1/stop", headers=headers)
    assert any("outcome=not_found" in a for a in _audit(env, "remote.approve"))
    assert any("outcome=not_found" in a for a in _audit(env, "remote.deny"))
    assert any("outcome=not_found" in a for a in _audit(env, "remote.revoke"))
    assert any("outcome=not_found" in a for a in _audit(env, "remote.stop"))


def test_remote_revoke_writes_a_decision_row(env):
    headers = _sign_in(env["app"], _enable(env["app"]))
    rid = _request(env)
    grant = _remote(env["app"]).post(f"/api/jit/requests/{rid}/approve", json={"duration": "once"},
                                     headers=headers).json()["grant"]["id"]
    assert _remote(env["app"]).post(f"/api/jit/grants/{grant}/revoke", json={}, headers=headers).status_code == 200
    raw = sqlite3.connect(env["path"])
    rows = [r[0] for r in raw.execute("SELECT args_preview FROM tool_call_audit WHERE function_name = 'decision.revoke'")]
    raw.close()
    assert rows and f"by=remote:{BROWSER}" in rows[0]


def test_analyze_and_otlp_are_covered_while_on(env):
    _enable(env["app"])
    other = TestClient(env["app"], base_url="http://evil.example", client=("10.0.0.9", 1))
    assert other.post("/analyze", json={"text": "hi"}).status_code == 403
    assert other.post("/v1/traces", content=b"{}").status_code == 403
    plain = TestClient(env["app"], base_url=REMOTE, client=("10.0.0.9", 1))
    assert plain.post("/analyze", json={"text": "hi"}).json()["detail"] == ra.HTTPS_DETAIL


def test_a_zero_row_update_does_not_turn_the_mode_on(env):
    raw = sqlite3.connect(env["path"])
    raw.execute("DELETE FROM app_settings")
    raw.commit()
    raw.close()
    r = _local(env["app"]).post("/api/remote-access", json={"action": "enable", "allowed_address": REMOTE,
                                                            "proxy_address": "10.0.0.2"}, headers=_ui())
    assert r.status_code == 409
    assert ra.cached_state()["remote_access_enabled"] is False


def test_recovery_switch_keeps_the_mode_off(env, monkeypatch):
    _enable(env["app"])
    monkeypatch.setenv("SECUREVECTOR_REMOTE_ACCESS", "off")
    ra.reset()
    assert _local(env["app"]).get("/api/remote-access").json()["enabled"] is False


def test_storage_step_is_idempotent_on_an_existing_database(tmp_path):
    db = DatabaseConnection(tmp_path / "old.db")
    asyncio.run(run_migrations(db))
    asyncio.run(ensure_cloud_approval_storage(db))
    raw = sqlite3.connect(tmp_path / "old.db")
    cols = [r[1] for r in raw.execute("PRAGMA table_info(app_settings)")]
    raw.close()
    assert "remote_access" not in cols  # an existing database before this step
    asyncio.run(ensure_remote_access_column(db))
    asyncio.run(ensure_remote_access_column(db))
    raw = sqlite3.connect(tmp_path / "old.db")
    cols = [r[1] for r in raw.execute("PRAGMA table_info(app_settings)")]
    raw.close()
    asyncio.run(db.disconnect())
    assert cols.count("remote_access") == 1


def test_a_signed_in_remote_browser_may_only_turn_the_mode_off(env, monkeypatch):
    token = _enable(env["app"])
    now = [1_000_000.0]
    monkeypatch.setattr(ra, "_now", lambda: now[0])
    headers = _sign_in(env["app"], token)
    for action in ({"action": "rotate"}, {"action": "update", "allowed_address": REMOTE},
                   {"action": "enable", "allowed_address": REMOTE, "proxy_address": "10.0.0.2"}):
        r = _remote(env["app"]).post("/api/remote-access", json=action, headers=headers)
        assert r.status_code == 403, action
    # Without a session: refused as before.
    assert _remote(env["app"]).post("/api/remote-access", json={"action": "disable"}, headers=FWD).status_code == 403
    now[0] += ra.REAUTH_S + 1
    r = _remote(env["app"]).post("/api/remote-access", json={"action": "disable"}, headers=headers)
    assert r.status_code == 401 and r.json()["detail"] == ra.REAUTH_DETAIL
    assert _remote(env["app"]).post("/api/remote-access/reauth", json={"token": token},
                                    headers=headers).status_code == 200
    r = _remote(env["app"]).post("/api/remote-access", json={"action": "disable"}, headers=headers)
    assert r.status_code == 200 and r.json()["enabled"] is False
    assert _local(env["app"]).get("/api/remote-access").json()["enabled"] is False
    rows = _audit(env, "settings.remote_access.disable")
    assert any("outcome=ok" in a and f"address={BROWSER}" in a for a in rows)
    assert any("outcome=reauth_required" in a for a in rows)



def test_loopback_proxies_read_from_storage_are_dropped():
    raw = {"remote_access_enabled": True, "remote_allowed_address": REMOTE,
           "remote_proxy_address": ["127.0.0.1/32", "::1/128", "::ffff:127.0.0.1/128", "10.0.0.2/32", "junk"],
           "remote_token_hash": "ab", "remote_token_salt": "cd"}
    state = ra.normalize_state(raw)
    assert state["remote_proxy_address"] == ["10.0.0.2/32"]
    assert state["remote_access_enabled"] is True
    raw["remote_proxy_address"] = ["127.0.0.0/8"]
    state = ra.normalize_state(raw)
    assert state["remote_proxy_address"] == [] and state["remote_access_enabled"] is False
