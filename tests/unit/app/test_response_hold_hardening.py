"""Step-up holds: the hold limit resolves an undecided hold as denied,
decisions come from a person in the app (not from a governed task's
process tree), the decision token never reaches a task environment, and
every decision writes one chained audit row."""

import asyncio
import os
import signal
import socket
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.custom_tools import CustomToolsRepository
from securevector.app.database.repositories.jit_access import JitAccessRepository
from securevector.app.database.repositories.response_rungs import ResponseRungsRepository
from securevector.app.server.routes import jit_access as jit_routes
from securevector.app.services import decisions
from securevector.app.services import response_rungs as rr
from securevector.app.terminals.store import TerminalStore

HARNESS = "claude-code"
TOKEN = jit_routes._UI_TOKEN
POSIX = pytest.mark.skipif(sys.platform == "win32", reason="POSIX process groups")


def _db(tmp_path, monkeypatch=None):
    db = DatabaseConnection(tmp_path / "hold.db")
    asyncio.run(run_migrations(db))
    if monkeypatch is not None:
        monkeypatch.setattr(jit_routes, "get_database", lambda: db)
    return db


def _active(db, sid="s-h", task_id="t-h"):
    asyncio.run(TerminalStore(db).create_task(task_id, executor_id=HARNESS, workspace="/w/app", title=None,
                                              pid=None, session_id=sid))
    asyncio.run(ResponseRungsRepository(db).upsert(
        sid, task_id, HARNESS, "active", rr.RungState(rung=3, peak_rung=3), "2026-10-09T12:00:00", False))


def _age(db, request_id, seconds):
    asyncio.run(db.execute(
        "UPDATE jit_access_requests SET requested_at = datetime('now', ?) WHERE id = ?",
        (f"-{int(seconds)} seconds", request_id)))


def _audit_rows(db, fn):
    return asyncio.run(db.fetch_all(
        "SELECT function_name, action, reason, args_preview, session_id FROM tool_call_audit "
        "WHERE function_name = ?", (fn,)))


def _req(headers=None, client=None, manager=None, server_port=8741):
    return SimpleNamespace(headers=headers or {}, client=client, url=SimpleNamespace(port=server_port),
                           app=SimpleNamespace(state=SimpleNamespace(terminal_manager=manager)))


def _chain_ok(db):
    chain = asyncio.run(CustomToolsRepository(db).verify_audit_chain())
    assert chain["ok"] is True, chain


# --- 1. hold limit -----------------------------------------------------------------------


def test_hold_limit_default_and_reason():
    assert rr.HOLD_LIMIT_S == 300
    assert rr.hold_limit_reason() == "No decision within 5 minutes"


def test_undecided_hold_is_denied_with_reason_and_audit(tmp_path):
    db = _db(tmp_path)
    _active(db)
    old = asyncio.run(rr.file_request(db, "Bash", "Bash", HARNESS, "s-h"))
    fresh = asyncio.run(rr.file_request(db, "WebFetch", "WebFetch", HARNESS, "s-h"))
    _age(db, old["id"], rr.HOLD_LIMIT_S + 5)
    assert asyncio.run(rr.expire_holds(db)) == 1
    row = asyncio.run(JitAccessRepository(db).get_request(old["id"]))
    assert row["status"] == "denied" and row["deny_reason"] == "No decision within 5 minutes"
    assert row["decided_by"] == "timeout"
    assert asyncio.run(JitAccessRepository(db).get_request(fresh["id"]))["status"] == "pending"
    rows = _audit_rows(db, "decision.timeout_deny")
    assert len(rows) == 1
    preview = rows[0]["args_preview"]
    assert "by=hold limit" in preview and "class=step_up:shell" in preview and "task=t-h" in preview
    assert rows[0]["action"] == "block" and rows[0]["session_id"] == "s-h"
    # Idempotent: a second pass finds nothing.
    assert asyncio.run(rr.expire_holds(db)) == 0
    _chain_ok(db)


def test_timed_out_hold_keeps_the_call_denied_and_refuses_a_late_approval(tmp_path, monkeypatch):
    db = _db(tmp_path, monkeypatch)
    _active(db)
    req = asyncio.run(rr.file_request(db, "Bash", "Bash", HARNESS, "s-h"))
    _age(db, req["id"], rr.HOLD_LIMIT_S + 1)
    # A late approval runs the expiry first, so nothing is granted.
    with pytest.raises(HTTPException) as exc:
        asyncio.run(jit_routes.approve_request(req["id"], jit_routes.JitApprove(duration="1h"), _req(),
                                               x_sv_ui_token=TOKEN))
    assert exc.value.status_code == 404
    assert asyncio.run(db.fetch_one("SELECT COUNT(*) AS n FROM jit_access_grants"))["n"] == 0
    # The deny the Guard reads stands: the rung row for the tool is still emitted.
    rows = asyncio.run(rr.step_up_rows(db, "s-h", []))
    assert any(r["tool_id"] == "bash" and r["effect"] == "deny" for r in rows)
    # The next attempt files a fresh request instead of joining the closed one.
    again = asyncio.run(rr.file_request(db, "Bash", "Bash", HARNESS, "s-h"))
    assert again["id"] != req["id"] and again["status"] == "pending"


def test_queue_read_resolves_expired_holds(tmp_path, monkeypatch):
    db = _db(tmp_path, monkeypatch)
    _active(db)
    req = asyncio.run(rr.file_request(db, "Bash", "Bash", HARNESS, "s-h"))
    _age(db, req["id"], rr.HOLD_LIMIT_S + 1)
    out = asyncio.run(jit_routes.list_requests(status=None))
    mine = [i for i in out["items"] if i["id"] == req["id"]][0]
    assert mine["status"] == "denied" and out["pending"] == 0


def test_approval_inside_the_limit_wins_over_expiry(tmp_path):
    db = _db(tmp_path)
    _active(db)
    req = asyncio.run(rr.file_request(db, "Bash", "Bash", HARNESS, "s-h"))
    assert asyncio.run(JitAccessRepository(db).approve_request(req["id"], "1h")) is not None
    _age(db, req["id"], rr.HOLD_LIMIT_S + 60)
    assert asyncio.run(rr.expire_holds(db)) == 0
    assert asyncio.run(JitAccessRepository(db).get_request(req["id"]))["status"] == "approved"


# --- 3. decisions come from a person -----------------------------------------------------


@pytest.mark.parametrize("header", ["x-sv-terminal-hook", "x-sv-terminal-task"])
def test_jit_decisions_refuse_harness_headers(tmp_path, monkeypatch, header):
    db = _db(tmp_path, monkeypatch)
    _active(db)
    req = asyncio.run(rr.file_request(db, "Bash", "Bash", HARNESS, "s-h"))
    for call in (
        lambda: jit_routes.approve_request(req["id"], jit_routes.JitApprove(duration="1h"),
                                           _req({header: "x"}), x_sv_ui_token=TOKEN),
        lambda: jit_routes.deny_request(req["id"], jit_routes.JitDeny(), _req({header: "x"}),
                                        x_sv_ui_token=TOKEN),
    ):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(call())
        assert exc.value.status_code == 403
    assert asyncio.run(JitAccessRepository(db).get_request(req["id"]))["status"] == "pending"


def _route_env(tmp_path, host=None):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from securevector.app.terminals import routes
    from securevector.app.terminals.auth import TerminalAuth

    db = DatabaseConnection(tmp_path / "r.db")
    asyncio.run(run_migrations(db))
    store = TerminalStore(db)
    asyncio.run(store.create_task("t-r", executor_id=HARNESS, workspace="/w/app", title=None, pid=None,
                                  session_id="s-r"))
    manager = type("M", (), {"store": store, "host": host})()
    app = FastAPI()
    app.state.terminal_auth = TerminalAuth(token="t" * 48, port=8741)
    app.state.terminal_manager = manager
    app.include_router(routes.router, prefix="/api")
    client = TestClient(app, base_url="http://127.0.0.1:8741")
    client.get("/api/terminals/session")
    return client, db


def test_terminal_decision_routes_refuse_harness_headers_and_audit_a_person(tmp_path):
    from securevector.app.terminals.auth import HEADER

    client, db = _route_env(tmp_path)
    ui = {HEADER: "1", "Origin": "http://127.0.0.1:8741", "X-SV-UI-Token": TOKEN}
    asyncio.run(ResponseRungsRepository(db).upsert(
        "s-r", "t-r", HARNESS, "active", rr.RungState(rung=3, peak_rung=3), "2026-10-09T12:00:00", False))
    hook = {**ui, "X-SV-Terminal-Hook": "tok"}
    assert client.post("/api/terminals/tasks/t-r/rung/release", headers=hook).status_code == 403
    assert client.post("/api/terminals/tasks/t-r/rung/feedback", headers=hook,
                       json={"feedback": "not_needed"}).status_code == 403
    assert client.post("/api/terminals/tasks/t-r/drift/feedback", headers=hook, json={}).status_code == 403
    assert client.post(f"/api/terminals/rungs/modes/{HARNESS}", headers=hook,
                       json={"mode": "shadow"}).status_code == 403
    # Looks normal now needs the UI token like the other decisions.
    no_token = {HEADER: "1", "Origin": "http://127.0.0.1:8741"}
    assert client.post("/api/terminals/tasks/t-r/drift/feedback", headers=no_token, json={}).status_code == 403
    assert asyncio.run(ResponseRungsRepository(db).get("s-r"))["rung"] == 3

    assert client.post("/api/terminals/tasks/t-r/rung/release", headers=ui).status_code == 200
    assert client.post("/api/terminals/tasks/t-r/rung/feedback", headers=ui,
                       json={"feedback": "not_needed"}).status_code == 200
    rel = _audit_rows(db, "decision.release")
    assert len(rel) == 1 and "by=person via UI" in rel[0]["args_preview"] and "task=t-r" in rel[0]["args_preview"]
    assert len(_audit_rows(db, "decision.not_needed")) == 1
    _chain_ok(db)


def test_looks_normal_writes_a_decision_row(tmp_path):
    from securevector.app.terminals.auth import HEADER

    client, db = _route_env(tmp_path)
    asyncio.run(db.execute("UPDATE terminal_tasks SET ended_at = '2026-09-01T00:00:00' WHERE id = 't-r'"))
    ui = {HEADER: "1", "Origin": "http://127.0.0.1:8741", "X-SV-UI-Token": TOKEN}
    r = client.post("/api/terminals/tasks/t-r/drift/feedback", headers=ui, json={})
    assert r.status_code == 200, r.text
    rows = _audit_rows(db, "decision.looks_normal")
    assert len(rows) == 1 and "class=drift" in rows[0]["args_preview"] and "task=t-r" in rows[0]["args_preview"]
    _chain_ok(db)


def test_jit_allow_and_deny_write_decision_rows(tmp_path, monkeypatch):
    db = _db(tmp_path, monkeypatch)
    _active(db)
    a = asyncio.run(rr.file_request(db, "Bash", "Bash", HARNESS, "s-h"))
    d = asyncio.run(rr.file_request(db, "WebFetch", "WebFetch", HARNESS, "s-h"))
    asyncio.run(jit_routes.approve_request(a["id"], jit_routes.JitApprove(duration="1h"), _req(),
                                           x_sv_ui_token=TOKEN))
    asyncio.run(jit_routes.deny_request(d["id"], jit_routes.JitDeny(reason="no"), _req(), x_sv_ui_token=TOKEN))
    allow = _audit_rows(db, "decision.allow")
    deny = _audit_rows(db, "decision.deny")
    assert len(allow) == 1 and len(deny) == 1
    assert "by=person via UI" in allow[0]["args_preview"] and "class=step_up:shell" in allow[0]["args_preview"]
    assert "task=t-h" in deny[0]["args_preview"] and deny[0]["action"] == "block"
    # A second approve of the same request is idempotent and writes nothing new.
    asyncio.run(jit_routes.approve_request(a["id"], jit_routes.JitApprove(duration="1h"), _req(),
                                           x_sv_ui_token=TOKEN))
    assert len(_audit_rows(db, "decision.allow")) == 1
    _chain_ok(db)


def _spawn_tree():
    """A governed-task stand-in: its own session, with a grandchild."""
    code = ("import subprocess, sys, time; p = subprocess.Popen(['sleep', '30']); "
            "print(p.pid, flush=True); time.sleep(30)")
    child = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True,
                             start_new_session=True)
    grand = int(child.stdout.readline().strip())
    return child, grand


@POSIX
def test_process_tree_membership():
    child, grand = _spawn_tree()
    try:
        assert decisions.in_tree(grand, {child.pid})
        assert decisions.in_tree(child.pid, {child.pid})
        assert not decisions.in_tree(os.getpid(), {child.pid})
        assert not decisions.in_tree(grand, set())
    finally:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()


def _client_proc(port, *, governed, half_close=False):
    """A process that connects to `port` and holds the connection."""
    extra = "s.sendall(b'x'); s.shutdown(socket.SHUT_WR); " if half_close else ""
    code = (f"import socket, time; s = socket.create_connection(('127.0.0.1', {port})); {extra}"
            "print('ok', flush=True); time.sleep(30)")
    proc = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True,
                            start_new_session=governed)
    assert proc.stdout.readline().strip() == "ok"
    return proc


def _kill(proc, group):
    try:
        if group:
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            proc.kill()
    except OSError:
        pass
    proc.wait()


def _manager_for(pid):
    return SimpleNamespace(host=SimpleNamespace(list=lambda: [SimpleNamespace(pid=pid, alive=True)]))


@POSIX
@pytest.mark.parametrize("half_close", [False, True])
def test_peer_inside_a_governed_tree_is_refused(half_close):
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(4)
    port = srv.getsockname()[1]
    child = _client_proc(port, governed=True, half_close=half_close)
    outsider = None
    try:
        conn, (host, peer_port) = srv.accept()
        if half_close:
            assert conn.recv(1) == b"x" and conn.recv(1) == b""  # the client has half-closed
        pids = decisions.peer_pids(host, peer_port, port)
        if pids is None:
            pytest.skip("no peer lookup on this platform")
        assert child.pid in pids
        manager = _manager_for(child.pid)
        with pytest.raises(HTTPException) as exc:
            asyncio.run(decisions.refuse_governed_caller(
                _req(client=SimpleNamespace(host=host, port=peer_port), manager=manager, server_port=port)))
        assert exc.value.status_code == 403
        # A process outside the task's tree (the page, say) passes.
        outsider = _client_proc(port, governed=False)
        conn2, (h2, p2) = srv.accept()
        asyncio.run(decisions.refuse_governed_caller(
            _req(client=SimpleNamespace(host=h2, port=p2), manager=manager, server_port=port)))
        conn.close()
        conn2.close()
    finally:
        if outsider is not None:
            _kill(outsider, False)
        srv.close()
        _kill(child, True)


@POSIX
def test_unconfirmed_peer_is_refused_while_a_task_runs(monkeypatch):
    child, _grand = _spawn_tree()
    try:
        manager = _manager_for(child.pid)
        req = _req(client=SimpleNamespace(host="127.0.0.1", port=1), manager=manager)
        for result in (None, set()):
            monkeypatch.setattr(decisions, "peer_pids", lambda *a, r=result: r)
            with pytest.raises(HTTPException) as exc:
                asyncio.run(decisions.refuse_governed_caller(req))
            assert exc.value.status_code == 503 and exc.value.detail == decisions.UNCONFIRMED

        def boom(*a):
            raise subprocess.TimeoutExpired("lsof", 2)

        monkeypatch.setattr(decisions, "peer_pids", boom)
        with pytest.raises(HTTPException) as exc:
            asyncio.run(decisions.refuse_governed_caller(req))
        assert exc.value.status_code == 503
        # No client address at all.
        with pytest.raises(HTTPException) as exc:
            asyncio.run(decisions.refuse_governed_caller(_req(manager=manager)))
        assert exc.value.status_code == 503
        # Windows: the peer check is off by default (token-only); turned on,
        # an unconfirmed peer is refused there too.
        monkeypatch.setattr(decisions.sys, "platform", "win32")
        monkeypatch.delenv("SV_DECISION_PEER_CHECK", raising=False)
        asyncio.run(decisions.refuse_governed_caller(req))
        monkeypatch.setenv("SV_DECISION_PEER_CHECK", "1")
        with pytest.raises(HTTPException) as exc:
            asyncio.run(decisions.refuse_governed_caller(req))
        assert exc.value.status_code == 503
        monkeypatch.undo()
        # With no governed task running there is nothing to confirm.
        asyncio.run(decisions.refuse_governed_caller(_req(manager=SimpleNamespace(host=None))))
    finally:
        _kill(child, True)


def test_peer_on_another_machine_is_not_looked_up(monkeypatch):
    called = []
    monkeypatch.setattr(decisions, "peer_pids", lambda *a: called.append(a) or set())
    req = SimpleNamespace(client=SimpleNamespace(host="192.0.2.10", port=5000), url=SimpleNamespace(port=8741),
                          scope={"server": ("192.0.2.1", 8741)}, headers={})
    assert decisions._peer_in_governed_tree(req, {12345}) is False and not called
    # The address the request arrived on is this machine: looked up, and an
    # empty answer is not confirmed.
    same = SimpleNamespace(client=SimpleNamespace(host="192.0.2.1", port=5000), url=SimpleNamespace(port=8741),
                           scope={"server": ("192.0.2.1", 8741)}, headers={})
    with pytest.raises(Exception):
        decisions._peer_in_governed_tree(same, {12345})
    assert called


def test_lookups_are_capped():
    assert decisions._LOOKUPS._value == 2


def test_ui_token_route_refuses_a_governed_caller():
    req = SimpleNamespace(
        headers={"sec-fetch-site": "same-origin", "host": "127.0.0.1:8741", "x-sv-terminal-hook": "tok"},
        cookies={jit_routes.UI_PAGE_COOKIE: jit_routes._UI_PAGE_SECRET},
        url=SimpleNamespace(port=8741), client=SimpleNamespace(host="127.0.0.1", port=50000),
        app=SimpleNamespace(state=SimpleNamespace(terminal_manager=None)))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(jit_routes.get_ui_token(req))
    assert exc.value.status_code == 403
    req.headers = {"sec-fetch-site": "same-origin", "host": "127.0.0.1:8741"}
    assert asyncio.run(jit_routes.get_ui_token(req)) == {"token": TOKEN}


def test_policy_change_routes_need_a_person(tmp_path, monkeypatch):
    from securevector.app.server.routes import cloud_settings
    from securevector.app.server.routes import egress as egress_routes
    from securevector.app.server.routes import tool_permissions as tp

    db = _db(tmp_path, monkeypatch)
    monkeypatch.setattr(tp, "get_database", lambda: db)
    monkeypatch.setattr(egress_routes, "get_database", lambda: db)
    hook = _req({"x-sv-terminal-task": "t"})
    calls = [
        lambda r, t: tp.upsert_override("Bash", tp.OverrideRequest(action="block"), http_request=r, x_sv_ui_token=t),
        lambda r, t: tp.delete_override("Bash", http_request=r, x_sv_ui_token=t),
        lambda r, t: tp.delete_custom_tool("x", http_request=r, x_sv_ui_token=t),
        lambda r, t: tp.delete_call_audit_entries(tp.AuditDeleteRequest(ids=[1]), http_request=r, x_sv_ui_token=t),
        lambda r, t: egress_routes.remove_denied_host(egress_routes.DenyHostRequest(host="a.example.com"),
                                                      x_sv_ui_token=t, http_request=r),
        lambda r, t: egress_routes.promote_destination(egress_routes.PromoteRequest(host="a.example.com"),
                                                       x_sv_ui_token=t, http_request=r),
        lambda r, t: cloud_settings.update_delegation_policy(cloud_settings.DelegationPolicyUpdate(),
                                                             x_sv_ui_token=t, http_request=r),
    ]
    for call in calls:
        for r, t in ((_req(), None), (hook, TOKEN)):
            with pytest.raises(HTTPException) as exc:
                asyncio.run(call(r, t))
            assert exc.value.status_code == 403
    # With the token, from a person: the override lands.
    asyncio.run(tp.upsert_override("Bash", tp.OverrideRequest(action="block"), http_request=_req(),
                                   x_sv_ui_token=TOKEN))
    from securevector.app.database.repositories.tool_permissions import ToolPermissionsRepository
    assert asyncio.run(ToolPermissionsRepository(db).get_override("Bash"))["action"] == "block"


def test_deny_reports_only_a_real_change_and_audits_once(tmp_path, monkeypatch):
    db = _db(tmp_path, monkeypatch)
    _active(db)
    req = asyncio.run(rr.file_request(db, "Bash", "Bash", HARNESS, "s-h"))
    repo = JitAccessRepository(db)
    assert asyncio.run(repo.deny_request(req["id"])) is True
    assert asyncio.run(repo.deny_request(req["id"])) is False
    # A hold already resolved by the limit: the person's deny changes nothing
    # and writes no second row.
    other = asyncio.run(rr.file_request(db, "WebFetch", "WebFetch", HARNESS, "s-h"))
    _age(db, other["id"], rr.HOLD_LIMIT_S + 1)
    asyncio.run(rr.expire_holds(db))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(jit_routes.deny_request(other["id"], jit_routes.JitDeny(), _req(), x_sv_ui_token=TOKEN))
    assert exc.value.status_code == 404
    assert len(_audit_rows(db, "decision.deny")) == 0
    assert len(_audit_rows(db, "decision.timeout_deny")) == 1


@POSIX
def test_reaper_group_signal_needs_a_matching_start_time():
    from datetime import datetime, timedelta, timezone

    from securevector.app.terminals import manager as mgr

    proc = subprocess.Popen(["sleep", "30"])
    try:
        now = datetime.now(timezone.utc)
        assert mgr._started_near(proc.pid, now.isoformat()) is True
        assert mgr._started_near(proc.pid, (now - timedelta(days=2)).isoformat()) is False
        assert mgr._started_near(proc.pid, None) is False
    finally:
        proc.kill()
        proc.wait()


def test_ui_token_never_reaches_a_task_environment():
    from securevector.app.terminals.executors import build_child_env

    parent = {"PATH": "/usr/bin", "ANTHROPIC_SNEAK": TOKEN, "AWS_X": f"pre{jit_routes._UI_PAGE_SECRET}post",
              "LC_ALL": "C"}
    env = build_child_env(parent, task_id="t1", port=8741, hook_token="h" * 32)
    assert "ANTHROPIC_SNEAK" not in env and "AWS_X" not in env
    assert env["LC_ALL"] == "C" and env["SV_TERMINAL_HOOK_TOKEN"] == "h" * 32
    for value in env.values():
        assert TOKEN not in value and jit_routes._UI_PAGE_SECRET not in value


# --- 2. stop ends the whole process group ----------------------------------------------


@POSIX
@pytest.mark.asyncio
async def test_stop_kills_a_grandchild_that_ignores_sigterm(tmp_path):
    from securevector.app.terminals.pty_host import InProcessPtyHost, Launch

    host = InProcessPtyHost()
    exits = []
    # Ignores HUP as well, so the terminal closing does not end it either.
    script = "(trap '' TERM HUP; exec sleep 47) & echo bgpid:$! ; sleep 30"
    host.spawn("hold-1", Launch(argv=["/bin/sh", "-c", script], env={"PATH": "/usr/bin:/bin"}, cwd=str(tmp_path)),
               rows=24, cols=80, on_exit=lambda tid, code: exits.append(code))
    snapshot, sub = host.attach("hold-1", asyncio.get_running_loop())
    out = snapshot
    deadline = time.monotonic() + 3.0
    while b"bgpid:" not in out and time.monotonic() < deadline:
        try:
            chunk = await asyncio.wait_for(sub.queue.get(), timeout=0.2)
        except asyncio.TimeoutError:
            continue
        if chunk:
            out += chunk
    host.detach("hold-1", sub)
    assert b"bgpid:" in out
    bg = int(out.split(b"bgpid:")[1].split(b"\r")[0].split(b"\n")[0].strip())
    await asyncio.sleep(0.2)  # let the trap take effect before the stop
    host.stop("hold-1", grace=0.5)

    def gone():
        try:
            os.kill(bg, 0)
        except ProcessLookupError:
            return True
        return False

    deadline = time.monotonic() + 3.0
    while not gone() and time.monotonic() < deadline:
        await asyncio.sleep(0.05)
    try:
        assert gone(), "a child that ignores SIGTERM survived Stop"
    finally:
        if not gone():
            os.kill(bg, signal.SIGKILL)


# --- Guard install and uninstall, platform lookups, reaper -------------------------------


def test_guard_install_routes_refuse_a_governed_task(monkeypatch):
    from securevector.app.server.routes import _plugin_guard

    port = 8741
    ok = {"host": f"127.0.0.1:{port}", "origin": f"http://127.0.0.1:{port}"}
    req = SimpleNamespace(headers=ok, client=None, url=SimpleNamespace(port=port),
                          app=SimpleNamespace(state=SimpleNamespace(port=port, terminal_manager=None)))
    asyncio.run(_plugin_guard.require_local_origin(req))
    req.headers = {**ok, "x-sv-terminal-task": "t"}
    with pytest.raises(HTTPException) as exc:
        asyncio.run(_plugin_guard.require_local_origin(req))
    assert exc.value.status_code == 403 and exc.value.detail == decisions.REFUSED
    seen = []

    async def refuse(request, manager=None):
        seen.append(request)
        raise HTTPException(status_code=403, detail=decisions.REFUSED)

    monkeypatch.setattr(decisions, "refuse_governed_caller", refuse)
    req.headers = ok
    with pytest.raises(HTTPException):
        asyncio.run(_plugin_guard.require_local_origin(req))
    assert seen == [req]


def test_peer_check_flag(monkeypatch):
    monkeypatch.delenv("SV_DECISION_PEER_CHECK", raising=False)
    monkeypatch.setattr(decisions.sys, "platform", "darwin")
    assert decisions.peer_check_enabled() is True
    monkeypatch.setattr(decisions.sys, "platform", "win32")
    assert decisions.peer_check_enabled() is False
    monkeypatch.setenv("SV_DECISION_PEER_CHECK", "on")
    assert decisions.peer_check_enabled() is True
    monkeypatch.setattr(decisions.sys, "platform", "linux")
    monkeypatch.setenv("SV_DECISION_PEER_CHECK", "0")
    assert decisions.peer_check_enabled() is False


def _nport(port):
    return ((port & 0xFF) << 8) | (port >> 8)


def test_windows_tcp_owner_table_parsing():
    import struct

    rows4 = [(5, 0x0100007F, _nport(50001), 0x0100007F, _nport(8741), 4321),
             (5, 0x0100007F, _nport(8741), 0x0100007F, _nport(50001), 999),
             (5, 0x0100007F, _nport(50001), 0x0100007F, _nport(9999), 777)]
    buf4 = struct.pack("<I", len(rows4)) + b"".join(struct.pack("<6I", *r) for r in rows4)
    assert decisions.parse_tcp_owner_table(buf4, False, 50001, 8741) == {4321}
    assert decisions.parse_tcp_owner_table(buf4, False, 50001, None) == {4321, 777}
    assert decisions.parse_tcp_owner_table(buf4[:-10], False, 50001, None) == {4321}
    lo = b"\x00" * 15 + b"\x01"
    rows6 = [(lo, 0, _nport(50002), lo, 0, _nport(8741), 5, 2468)]
    buf6 = struct.pack("<I", 1) + b"".join(struct.pack("<16sII16sIIII", *r) for r in rows6)
    assert decisions.parse_tcp_owner_table(buf6, True, 50002, 8741) == {2468}
    assert decisions.parse_tcp_owner_table(b"", True, 1, None) == set()


def test_windows_parent_map_from_a_snapshot():
    procs = [(10, 4), (20, 10), (30, 20)]

    class FakeKernel32:
        i = 0
        closed = False

        def CreateToolhelp32Snapshot(self, flags, pid):
            return 77

        def _fill(self, ref):
            if self.i >= len(procs):
                return 0
            entry = ref._obj
            entry.th32ProcessID, entry.th32ParentProcessID = procs[self.i]
            self.i += 1
            return 1

        def Process32FirstW(self, snap, ref):
            return self._fill(ref)

        def Process32NextW(self, snap, ref):
            return self._fill(ref)

        def CloseHandle(self, snap):
            self.closed = True

    k = FakeKernel32()
    table = decisions._win_ppid_map(k)
    assert table == {10: 4, 20: 10, 30: 20} and k.closed
    assert decisions.in_tree(30, {10}, table) is True
    assert decisions.in_tree(30, {99}, table) is False


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux /proc")
def test_linux_unreadable_fd_falls_back_to_same_user_candidates(monkeypatch):
    real_listdir = os.listdir

    def listdir(path):
        if path.startswith("/proc/") and path.endswith("/fd"):
            raise PermissionError(path)
        return real_listdir(path)

    with socket.socket() as srv:
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        cli = socket.create_connection(srv.getsockname())
        conn, _ = srv.accept()
        try:
            monkeypatch.setattr(decisions.os, "listdir", listdir)
            pids = decisions._proc_peer_pids(cli.getsockname()[1], srv.getsockname()[1])
            # Every candidate is this user's; the app itself is left out.
            assert pids and os.getpid() not in pids
        finally:
            conn.close()
            cli.close()


def test_reaper_sends_nothing_on_a_start_time_mismatch(monkeypatch):
    from securevector.app.terminals import manager as mgr

    executor = next(iter(mgr.EXECUTORS.values()))
    sent = []
    monkeypatch.setattr(mgr.sys, "platform", "darwin")
    monkeypatch.setattr(mgr.os, "kill", lambda pid, sig: sent.append(("kill", sig)) if sig else None)
    monkeypatch.setattr(mgr.os, "killpg", lambda pid, sig: sent.append(("killpg", sig)))
    monkeypatch.setattr(mgr.subprocess, "run",
                        lambda *a, **k: SimpleNamespace(stdout=f"/usr/bin/{executor.binary}\n"))
    monkeypatch.setattr(mgr, "_started_near", lambda pid, created: False)
    task = {"id": "t", "pid": 424242, "executor_id": executor.id, "created_at": "2026-10-01T00:00:00"}
    mgr.TerminalManager._reap(None, task)
    assert sent == []
    monkeypatch.setattr(mgr, "_started_near", lambda pid, created: True)
    monkeypatch.setattr(mgr.os, "getpgid", lambda pid: pid)
    mgr.TerminalManager._reap(None, task)
    assert sent == [("killpg", signal.SIGTERM)]


# --- writes that change what agents may do ------------------------------------------------

PERSON_WRITES = [
    ("PUT", "/api/settings"), ("PUT", "/api/settings/llm"),
    ("DELETE", "/api/costs/records"), ("PUT", "/api/costs/budget"),
    ("PUT", "/api/costs/budget/agents/{agent_id}"), ("DELETE", "/api/costs/budget/agents/{agent_id}"),
    ("PUT", "/api/costs/run-limits"), ("POST", "/api/costs/run-limits/exempt"),
    ("POST", "/api/skill-permissions"), ("PUT", "/api/skill-permissions/policy-config"),
    ("PUT", "/api/skill-permissions/{perm_id}"), ("DELETE", "/api/skill-permissions/{perm_id}"),
    ("POST", "/api/skill-permissions/reset"), ("POST", "/api/skill-permissions/import"),
    ("POST", "/api/skill-permissions/publishers"), ("DELETE", "/api/skill-permissions/publishers/{pub_id}"),
    ("DELETE", "/api/threat-intel"), ("DELETE", "/api/threat-intel/{record_id}"),
    ("POST", "/api/v1/cloud-forwarding"),
    ("POST", "/api/siem-forwarders"), ("PUT", "/api/siem-forwarders/global-settings"),
    ("PUT", "/api/siem-forwarders/{forwarder_id}"), ("DELETE", "/api/siem-forwarders/{forwarder_id}"),
    ("POST", "/api/siem-forwarders/{forwarder_id}/reset-breaker"),
    ("POST", "/api/proxy/stop"), ("POST", "/api/proxy/revert"),
    ("POST", "/api/threat-intel/{record_id}/disposition"), ("POST", "/api/rules/sync/apply"),
    ("DELETE", "/api/settings/cloud/credentials"), ("PUT", "/api/settings/cloud/mode"),
]


def _person_routers():
    from securevector.app.server.routes import (cloud_settings, costs, device_admin, llm, proxy, rules,
                                                siem_forwarders, skill_permissions, threat_intel)

    return [m.router for m in (cloud_settings, costs, device_admin, llm, proxy, rules, siem_forwarders,
                               skill_permissions, threat_intel)]


def _person_app():
    from fastapi import FastAPI

    app = FastAPI()
    for router in _person_routers():
        app.include_router(router, prefix="/api")
    app.state.terminal_manager = None
    return app


def test_every_listed_write_calls_require_person():
    import inspect

    routes = {(m, "/api" + r.path): r.endpoint for router in _person_routers() for r in router.routes
              for m in getattr(r, "methods", ())}
    for key in PERSON_WRITES:
        assert key in routes, key
        assert "require_person" in inspect.getsource(routes[key]), key


@pytest.mark.parametrize("method,path", [
    ("DELETE", "/api/threat-intel/x"), ("DELETE", "/api/costs/budget/agents/a"),
    ("POST", "/api/skill-permissions/reset"), ("POST", "/api/proxy/stop"),
    ("DELETE", "/api/siem-forwarders/1"), ("DELETE", "/api/skill-permissions/publishers/1"),
    ("POST", "/api/proxy/revert"), ("DELETE", "/api/settings/cloud/credentials"),
])
def test_person_writes_refuse_without_a_token_or_from_a_task(method, path):
    from fastapi.testclient import TestClient

    c = TestClient(_person_app())
    assert c.request(method, path).status_code == 403
    r = c.request(method, path, headers={"X-SV-UI-Token": TOKEN, "x-sv-terminal-task": "t"})
    assert r.status_code == 403 and r.json()["detail"] == decisions.REFUSED


def test_spawn_and_link_refuse_a_governed_task():
    from securevector.app.terminals import routes as troutes

    with pytest.raises(HTTPException) as exc:
        asyncio.run(troutes._not_a_governed_task(_req({"x-sv-terminal-hook": "h"})))
    assert exc.value.status_code == 403
    asyncio.run(troutes._not_a_governed_task(_req()))
    deps = {r.path: [d.dependency for d in r.dependencies] for r in troutes.router.routes
            if "POST" in getattr(r, "methods", ())}
    for path in ("/terminals/tasks", "/terminals/tasks/link", "/terminals/tasks/{task_id}/stop",
                 "/terminals/stop-all", "/terminals/tasks/{task_id}/worktree/remove"):
        key = next(k for k in deps if k.endswith(path))
        assert troutes._not_a_governed_task in deps[key]


def test_loopback_covers_every_loopback_form():
    for host in ("127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1", "localhost"):
        assert decisions._is_loopback(host), host
    for host in ("192.0.2.1", "::ffff:192.0.2.1", "example.com", ""):
        assert not decisions._is_loopback(host), host


def test_startup_warns_when_the_check_is_off_on_posix(monkeypatch, caplog):
    import logging

    monkeypatch.setattr(decisions.sys, "platform", "linux")
    monkeypatch.setenv("SV_DECISION_PEER_CHECK", "0")
    with caplog.at_level(logging.WARNING, logger=decisions.logger.name):
        decisions.warn_if_peer_check_off()
    assert "SV_DECISION_PEER_CHECK is off" in caplog.text
    caplog.clear()
    monkeypatch.delenv("SV_DECISION_PEER_CHECK")
    decisions.warn_if_peer_check_off()
    assert not caplog.text
