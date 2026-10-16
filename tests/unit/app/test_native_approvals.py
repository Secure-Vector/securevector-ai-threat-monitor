"""Native approvals: a decision route answers 202 and nothing is applied
until the person confirms on this computer (the desktop shell's prompt, or
a code shown on the computer in web-only mode)."""

import asyncio
import logging
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.jit_access import JitAccessRepository
from securevector.app.database.repositories.response_rungs import ResponseRungsRepository
from securevector.app.database.repositories.settings import SettingsRepository
from securevector.app.server.routes import cloud_settings
from securevector.app.server.routes import jit_access as jit_routes
from securevector.app.services import confirmations as cf
from securevector.app.services import response_rungs as rr
from securevector.app.terminals.store import TerminalStore

HARNESS = "claude-code"
TOKEN = jit_routes._UI_TOKEN
UI = {"X-SV-UI-Token": TOKEN}
SETTINGS = "/api/" + "settings"
CODE = 123456
_ORIG_NOTIFY = cf._notify


def _fresh_lock():
    """A lock for one test. Python 3.9 binds a Lock to the current loop at
    construction and has none set once asyncio.run() has finished, so give
    it one; later Pythons bind lazily and need nothing."""
    try:
        return asyncio.Lock()
    except RuntimeError:
        asyncio.set_event_loop(asyncio.new_event_loop())
        return asyncio.Lock()


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, tmp_path):
    monkeypatch.setenv("SV_NATIVE_APPROVALS", "1")
    # Audit rows never reach the real database, even from tests without _db.
    base = DatabaseConnection(tmp_path / "base.db")
    asyncio.run(run_migrations(base))
    monkeypatch.setattr(cf, "_database", lambda: base)
    # The audit write lock is module level; give each test's loops a fresh one.
    from securevector.app.database.repositories import custom_tools
    monkeypatch.setattr(custom_tools, "_AUDIT_WRITE_LOCK", _fresh_lock())
    cf._store.clear()
    cf._fails.clear()
    cf.detach_shell()
    shown = []
    monkeypatch.setattr(cf, "_notify", lambda code, summary: shown.append((code, summary)))
    monkeypatch.setattr(cf.secrets, "randbelow", lambda n: CODE)
    yield shown
    cf.detach_shell()
    cf._store.clear()
    cf._fails.clear()


def _db(tmp_path, monkeypatch):
    db = DatabaseConnection(tmp_path / "na.db")
    asyncio.run(run_migrations(db))
    monkeypatch.setattr(jit_routes, "get_database", lambda: db)
    monkeypatch.setattr(cloud_settings, "get_database", lambda: db)
    monkeypatch.setattr(cf, "_database", lambda: db)
    return db


def _app():
    app = FastAPI()
    app.include_router(jit_routes.router, prefix="/api")
    app.include_router(cloud_settings.router, prefix="/api")
    cf.install(app)
    return app


def _pending_jit(db):
    asyncio.run(TerminalStore(db).create_task("t-n", executor_id=HARNESS, workspace="/w/app", title=None,
                                              pid=None, session_id="s-n"))
    asyncio.run(ResponseRungsRepository(db).upsert(
        "s-n", "t-n", HARNESS, "active", rr.RungState(rung=3, peak_rung=3), "2026-10-09T12:00:00", False))
    return asyncio.run(rr.file_request(db, "Bash", "Bash", HARNESS, "s-n"))


def _rows(db, fn):
    return asyncio.run(db.fetch_all(
        "SELECT function_name, args_preview FROM tool_call_audit WHERE function_name = ?", (fn,)))


def _status(db, request_id):
    return asyncio.run(JitAccessRepository(db).get_request(request_id))["status"]


def _wait(client, cid, until=("confirmed", "denied", "expired"), timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        v = client.get(f"/api/confirmations/{cid}", headers=UI).json()
        if v["status"] in until:
            return v
        time.sleep(0.05)
    raise AssertionError("confirmation did not settle")


# --- lifecycle ---------------------------------------------------------------------------


def _fake_request(path="/api/x"):
    return SimpleNamespace(scope={"type": "http", "method": "POST", "path": path, "headers": []})


def test_lifecycle_create_expire_and_deny():
    conf = cf.create(_fake_request(), b"{}", "Do a thing")
    assert conf.method == cf.METHOD_CODE and conf.status == "pending"
    assert conf.code_digest is not None and str(CODE).encode() not in conf.code_digest
    assert cf.view(conf)["status"] == "pending" and "result" not in cf.view(conf)
    old = cf.create(_fake_request(), b'{"n": 2}', "Old", now=time.monotonic() - cf.TTL_SECONDS - 1)
    assert cf.get(old.id).status == "expired"
    with pytest.raises(Exception) as exc:
        asyncio.run(cf.submit_code(old.id, str(CODE)))
    assert exc.value.status_code == 409
    assert cf.deny(conf.id) is True and cf.get(conf.id).status == "denied"
    assert cf.deny(conf.id) is False


def test_pending_confirmations_are_capped_per_route_and_in_total():
    for i in range(cf.MAX_PENDING_PER_ROUTE):
        cf.create(_fake_request("/api/same"), f'{{"n": {i}}}'.encode(), "x")
    with pytest.raises(Exception) as exc:
        cf.create(_fake_request("/api/same"), b'{"n": 99}', "x")
    assert exc.value.status_code == 429
    for i in range(cf.MAX_PENDING - cf.MAX_PENDING_PER_ROUTE):
        cf.create(_fake_request(f"/api/r{i}"), b"", "x")
    with pytest.raises(Exception) as exc:
        cf.create(_fake_request("/api/other"), b"", "x")
    assert exc.value.status_code == 429


def test_a_duplicate_pending_request_returns_the_same_confirmation(_fresh):
    a = cf.create(_fake_request(), b'{"x": 1}', "x")
    b = cf.create(_fake_request(), b'{"x": 1}', "x")
    c = cf.create(_fake_request(), b'{"x": 2}', "x")
    assert a.id == b.id and c.id != a.id
    assert len(_fresh) <= 2  # no second code for the duplicate


def test_jit_approve_answers_202_and_applies_only_after_the_code(tmp_path, monkeypatch, _fresh):
    db = _db(tmp_path, monkeypatch)
    req = _pending_jit(db)
    with TestClient(_app(), base_url="http://127.0.0.1:8741") as client:
        r = client.post(f"/api/jit/requests/{req['id']}/approve", headers=UI, json={"duration": "1h"})
        assert r.status_code == 202, r.text
        body = r.json()
        assert body["method"] == "code" and body["expires_in"] == 120
        assert body["summary"] == "Allow Claude Code to run: Bash"
        assert _fresh and _fresh[0][1] == body["summary"]
        cid = body["confirmation_id"]
        assert _status(db, req["id"]) == "pending" and not _rows(db, "decision.allow")
        assert client.get(f"/api/confirmations/{cid}", headers=UI).json()["status"] == "pending"
        # The status and code routes need the UI token too.
        assert client.get(f"/api/confirmations/{cid}").status_code == 403
        assert client.post(f"/api/confirmations/{cid}/code", json={"code": str(CODE)}).status_code == 403

        wrong = client.post(f"/api/confirmations/{cid}/code", headers=UI, json={"code": "000000"})
        assert wrong.status_code == 400 and "4 tries left" in wrong.json()["detail"]
        assert _status(db, req["id"]) == "pending"

        ok = client.post(f"/api/confirmations/{cid}/code", headers=UI, json={"code": str(CODE)})
        assert ok.status_code == 200, ok.text
        out = ok.json()
        assert out["status"] == "confirmed" and out["confirmed_by"] == "code"
        assert out["result"]["status_code"] == 200 and out["result"]["body"]["grant"]["tool_id"] == "Bash"
        assert _status(db, req["id"]) == "approved"

        # Single use.
        again = client.post(f"/api/confirmations/{cid}/code", headers=UI, json={"code": str(CODE)})
        assert again.status_code == 409
    allow = _rows(db, "decision.allow")
    assert len(allow) == 1 and "method=code" in allow[0]["args_preview"]
    assert len(_rows(db, "decision.confirmation_created")) == 1
    confirmed = _rows(db, "decision.confirmation_confirmed")
    assert len(confirmed) == 1 and "method=code" in confirmed[0]["args_preview"]


def test_attempt_limit_denies_and_nothing_is_applied(tmp_path, monkeypatch):
    db = _db(tmp_path, monkeypatch)
    req = _pending_jit(db)
    with TestClient(_app(), base_url="http://127.0.0.1:8741") as client:
        cid = client.post(f"/api/jit/requests/{req['id']}/approve", headers=UI,
                          json={"duration": "1h"}).json()["confirmation_id"]
        codes = [client.post(f"/api/confirmations/{cid}/code", headers=UI, json={"code": "111111"}).status_code
                 for _ in range(cf.MAX_ATTEMPTS)]
        assert codes == [400] * (cf.MAX_ATTEMPTS - 1) + [429]
        assert client.get(f"/api/confirmations/{cid}", headers=UI).json()["status"] == "denied"
        late = client.post(f"/api/confirmations/{cid}/code", headers=UI, json={"code": str(CODE)})
        assert late.status_code == 409
    assert _status(db, req["id"]) == "pending" and not _rows(db, "decision.allow")
    assert len(_rows(db, "decision.confirmation_denied")) == 1


def test_wrong_codes_across_confirmations_pause_the_code_path(tmp_path, monkeypatch):
    _db(tmp_path, monkeypatch)
    monkeypatch.setattr(cf, "FAIL_LIMIT", 3)
    ids = [cf.create(_fake_request(), b"", "x").id for _ in range(2)]
    for cid, n in ((ids[0], 2), (ids[1], 1)):
        for _ in range(n):
            with pytest.raises(Exception):
                asyncio.run(cf.submit_code(cid, "222222"))
    with pytest.raises(Exception) as exc:
        asyncio.run(cf.submit_code(ids[1], str(CODE)))
    assert exc.value.status_code == 429


def test_settings_write_confirmed_through_the_shell(tmp_path, monkeypatch):
    db = _db(tmp_path, monkeypatch)
    asked = []
    cf.attach_shell(lambda summary, timeout=None: asked.append(summary) or (True, "touch_id"))
    with TestClient(_app(), base_url="http://127.0.0.1:8741") as client:
        r = client.put(SETTINGS, headers=UI, json={"retention_days": 7})
        assert r.status_code == 202 and r.json()["method"] == "shell"
        v = _wait(client, r.json()["confirmation_id"])
        assert v["status"] == "confirmed" and v["confirmed_by"] == "touch_id"
        assert v["result"]["status_code"] == 200 and v["result"]["body"]["retention_days"] == 7
    assert asked == ["Change settings: retention_days to 7"]
    assert asyncio.run(SettingsRepository(db).get()).retention_days == 7
    assert "method=touch_id" in _rows(db, "decision.confirmation_confirmed")[0]["args_preview"]


def test_settings_write_declined_in_the_shell_changes_nothing(tmp_path, monkeypatch):
    db = _db(tmp_path, monkeypatch)
    before = asyncio.run(SettingsRepository(db).get()).retention_days
    cf.attach_shell(lambda summary, timeout=None: (False, "dialog"))
    with TestClient(_app(), base_url="http://127.0.0.1:8741") as client:
        r = client.put(SETTINGS, headers=UI, json={"retention_days": before + 3})
        assert r.status_code == 202
        cid = r.json()["confirmation_id"]
        assert _wait(client, cid)["status"] == "denied"
        # A shell confirmation cannot be answered with a code.
        assert client.post(f"/api/confirmations/{cid}/code", headers=UI,
                           json={"code": str(CODE)}).status_code == 409
    assert asyncio.run(SettingsRepository(db).get()).retention_days == before


def test_bulk_approve_confirms_once_with_the_count(tmp_path, monkeypatch):
    from securevector.app.server.routes import config_trust as ct_routes
    from securevector.app.terminals import routes as t_routes
    from securevector.app.terminals.auth import HEADER, TerminalAuth

    db = _db(tmp_path, monkeypatch)
    applied = []

    async def approve(_db, harness, workspace, *, target, key, expected):
        applied.append((harness, expected))
        return {"harness": harness}

    monkeypatch.setattr(ct_routes.config_trust, "approve", approve)
    monkeypatch.setattr(ct_routes, "_db", lambda request: db)
    asked = []
    cf.attach_shell(lambda summary, timeout=None: asked.append(summary) or (True, "dialog"))
    app = FastAPI()
    app.state.terminal_auth = TerminalAuth(token="t" * 48, port=8741)
    app.include_router(t_routes.router, prefix="/api")
    app.include_router(ct_routes.router, prefix="/api")
    cf.install(app)
    items = [{"harness": "claude-code", "expected": "h1"}, {"harness": "codex", "expected": "h2"}]
    with TestClient(app, base_url="http://127.0.0.1:8741") as client:
        client.get("/api/terminals/session")
        hdr = {**UI, HEADER: "1", "Origin": "http://127.0.0.1:8741"}
        r = client.post("/api/terminals/config-trust/pins/batch", headers=hdr, json={"items": items})
        assert r.status_code == 202, r.text
        assert r.json()["summary"] == "Trust the changed config of 2 agent tools (Claude Code, Codex)"
        v = _wait(client, r.json()["confirmation_id"])
        # A count the client claims is not accepted.
        assert client.post("/api/terminals/config-trust/pins/batch", headers=hdr,
                           json={"items": items, "changes": 5}).status_code == 422
    assert v["result"]["body"]["approved"] == 2
    assert applied == [("claude-code", "h1"), ("codex", "h2")]
    assert asked == ["Trust the changed config of 2 agent tools (Claude Code, Codex)"]


def test_flag_off_applies_directly_and_warns(tmp_path, monkeypatch, caplog):
    db = _db(tmp_path, monkeypatch)
    monkeypatch.setenv("SV_NATIVE_APPROVALS", "0")
    with caplog.at_level(logging.WARNING):
        cf.warn_if_off()
    assert "SV_NATIVE_APPROVALS is off" in caplog.text
    with TestClient(_app(), base_url="http://127.0.0.1:8741") as client:
        r = client.put(SETTINGS, headers=UI, json={"retention_days": 9})
    assert r.status_code == 200
    assert asyncio.run(SettingsRepository(db).get()).retention_days == 9
    assert not cf._store


def test_shell_channel_is_not_an_http_route(tmp_path, monkeypatch):
    from securevector.app.server.app import create_app

    _db(tmp_path, monkeypatch)
    paths = list(create_app(host="127.0.0.1", port=8741).openapi()["paths"])
    conf_paths = sorted(p for p in paths if "confirmation" in p)
    assert conf_paths == ["/api/confirmations/{conf_id}", "/api/confirmations/{conf_id}/cancel",
                          "/api/confirmations/{conf_id}/code"]
    assert not any("shell" in p for p in paths if p.startswith("/api/confirm"))
    # A client cannot claim to be the confirmed replay with a header.
    cf.attach_shell(lambda summary, timeout=None: (False, "dialog"))
    with TestClient(_app(), base_url="http://127.0.0.1:8741") as client:
        first = client.put(SETTINGS, headers=UI, json={"retention_days": 4}).json()["confirmation_id"]
        r = client.put(SETTINGS, headers={**UI, cf.SCOPE_KEY: first}, json={"retention_days": 4})
        assert r.status_code == 202
        assert client.post(f"/api/confirmations/{first}/shell", headers=UI, json={}).status_code in (404, 405)


def test_web_mode_code_never_reaches_a_log_file(tmp_path, monkeypatch):
    db = _db(tmp_path, monkeypatch)
    log_file = tmp_path / "app.log"
    handler = logging.FileHandler(log_file)
    root = logging.getLogger()
    old_level = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    try:
        req = _pending_jit(db)
        with TestClient(_app(), base_url="http://127.0.0.1:8741") as client:
            cid = client.post(f"/api/jit/requests/{req['id']}/approve", headers=UI,
                              json={"duration": "1h"}).json()["confirmation_id"]
            client.post(f"/api/confirmations/{cid}/code", headers=UI, json={"code": "999999"})
            assert client.post(f"/api/confirmations/{cid}/code", headers=UI,
                               json={"code": str(CODE)}).status_code == 200
    finally:
        root.removeHandler(handler)
        root.setLevel(old_level)
        handler.close()
    assert str(CODE) not in log_file.read_text()
    rows = asyncio.run(db.fetch_all("SELECT args_preview, reason FROM tool_call_audit"))
    assert all(str(CODE) not in (r["args_preview"] or "") + (r["reason"] or "") for r in rows)


def test_macos_notification_keeps_the_code_off_the_argument_list(monkeypatch):
    calls = []
    monkeypatch.setattr(cf.sys, "platform", "darwin")
    monkeypatch.setattr(cf.shutil, "which", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(cf.subprocess, "run", lambda argv, **kw: calls.append((argv, kw)))
    _ORIG_NOTIFY("654321", 'Say "hi"')
    argv, kw = calls[0]
    assert argv == ["osascript", "-"] and "654321" not in " ".join(argv)
    assert b"654321" in kw["input"] and b'\\"hi\\"' in kw["input"]


def test_shell_prompt_prefers_owner_authentication_then_the_dialog(monkeypatch):
    from securevector.app import desktop_shell

    monkeypatch.setattr(desktop_shell, "_local_authentication", lambda: None)
    import itertools

    ticks = itertools.count(0.0, 1.0)  # every answer looks deliberate (one second apart)
    mk = lambda w, la: desktop_shell.make_confirm_prompt(w, la=la, alert=lambda *a: None,  # noqa: E731
                                                         clock=lambda: next(ticks))

    class Window:
        def __init__(self, answer):
            self.answer, self.asked = answer, []

        def create_confirmation_dialog(self, title, message):
            self.asked.append((title, message))
            return self.answer

    w = Window(True)
    # Without Touch ID or the Cancel-default alert the answer is no; the
    # pywebview dialog (OK is its Return default) never decides.
    assert mk(w, None)("Allow X") == (False, "dialog") and not w.asked

    class Ctx:
        def __init__(self, can, ok):
            self.can, self.ok = can, ok

        def alloc(self):
            return self

        def init(self):
            return self

        def canEvaluatePolicy_error_(self, policy, err):  # noqa: N802
            return self.can, None

        def evaluatePolicy_localizedReason_reply_(self, policy, reason, reply):  # noqa: N802
            assert policy == desktop_shell.LA_POLICY_DEVICE_OWNER and reason == "Allow X"
            reply(self.ok, None)

    la_yes = SimpleNamespace(LAContext=Ctx(True, True))
    la_no = SimpleNamespace(LAContext=Ctx(True, False))
    la_none = SimpleNamespace(LAContext=Ctx(False, True))
    w2 = Window(False)
    assert mk(w2, la_yes)("Allow X") == (True, "touch_id")
    assert mk(w2, la_no)("Allow X") == (False, "touch_id")
    assert not w2.asked
    assert mk(w2, la_none)("Allow X") == (False, "dialog")
    assert w2.asked == []


# --- review round: more routes, audit gaps, flooding, summaries, early answers ------------


def _terminal_app(db):
    from securevector.app.server.routes import config_trust as ct_routes
    from securevector.app.server.routes import hooks_claude_code
    from securevector.app.terminals import routes as t_routes
    from securevector.app.terminals.auth import TerminalAuth

    store = TerminalStore(db)
    asyncio.run(store.create_task("t-g", executor_id=HARNESS, workspace="/w/app", title=None, pid=None,
                                  session_id="s-g"))
    app = FastAPI()
    app.state.port = 8741
    app.state.terminal_auth = TerminalAuth(token="t" * 48, port=8741)
    app.state.terminal_manager = type("M", (), {"store": store, "host": None})()
    app.include_router(t_routes.router, prefix="/api")
    app.include_router(ct_routes.router, prefix="/api")
    app.include_router(hooks_claude_code.router, prefix="/api")
    app.include_router(cloud_settings.router, prefix="/api")
    cf.install(app)
    return app


def test_terminal_guard_delegation_and_cloud_routes_answer_202(tmp_path, monkeypatch):
    from securevector.app.terminals.auth import HEADER

    db = _db(tmp_path, monkeypatch)
    calls = [
        ("/api/terminals/rungs/modes/claude-code", {"mode": "active"}, "Turn automatic actions on for Claude Code"),
        ("/api/terminals/tasks/t-g/rung/release", {}, "Release the step-up for session t-g"),
        ("/api/terminals/delegations/d-1/release", {}, "Hand the held result of delegation d-1 to its task"),
        ("/api/terminals/delegations/d-1/discard", {}, "Discard the held result of delegation d-1"),
        ("/api/hooks/claude-code/install", None, "Install the Guard for Claude Code"),
        ("/api/" + "settings/cloud/credentials", {"api_key": "svpk_secret"},
         "Connect SecureVector Cloud with new credentials"),
    ]
    with TestClient(_terminal_app(db), base_url="http://127.0.0.1:8741") as client:
        client.get("/api/terminals/session")
        hdr = {**UI, HEADER: "1", "Origin": "http://127.0.0.1:8741"}
        for path, body, text in calls:
            r = client.post(path, headers=hdr, json=body) if body is not None else client.post(path, headers=hdr)
            assert r.status_code == 202, (path, r.status_code, r.text)
            assert r.json()["summary"] == text, path
        # Cloud credentials now need the UI token like their siblings.
        no_token = {k: v for k, v in hdr.items() if k != "X-SV-UI-Token"}
        assert client.post("/api/" + "settings/cloud/credentials", headers=no_token,
                           json={"api_key": "x"}).status_code == 403
    assert all("svpk_secret" not in c.summary for c in cf._store.values())


def test_forged_scope_header_is_ignored(tmp_path, monkeypatch):
    _db(tmp_path, monkeypatch)
    with TestClient(_app(), base_url="http://127.0.0.1:8741") as client:
        first = client.put(SETTINGS, headers=UI, json={"retention_days": 4}).json()["confirmation_id"]
        cf._store[first].status = "applying"  # even while a real replay runs
        r = client.put(SETTINGS, headers={**UI, cf.SCOPE_KEY: first, "sv-confirmation": first},
                       json={"retention_days": 5})
        assert r.status_code == 202


def test_expiry_writes_an_audit_row(tmp_path, monkeypatch):
    db = _db(tmp_path, monkeypatch)
    conf = cf.create(_fake_request(), b'{"e": 1}', "Expire me", now=time.monotonic() - cf.TTL_SECONDS - 1)
    assert cf.get(conf.id).status == "expired"
    rows = _rows(db, "decision.confirmation_expired")
    assert len(rows) == 1 and f"request={conf.id}" in rows[0]["args_preview"]


def test_deny_writes_its_row_without_a_server_loop(tmp_path, monkeypatch):
    db = _db(tmp_path, monkeypatch)
    conf = cf.create(_fake_request(), b'{"d": 1}', "Deny me")
    loop = asyncio.new_event_loop()
    loop.close()
    conf.loop = loop  # the server's loop has gone away
    assert cf.deny(conf.id, "dialog") is True
    rows = _rows(db, "decision.confirmation_denied")
    assert len(rows) == 1 and "method=dialog" in rows[0]["args_preview"]


def test_cancel_route_denies_and_nothing_applies(tmp_path, monkeypatch):
    db = _db(tmp_path, monkeypatch)
    req = _pending_jit(db)
    with TestClient(_app(), base_url="http://127.0.0.1:8741") as client:
        cid = client.post(f"/api/jit/requests/{req['id']}/approve", headers=UI,
                          json={"duration": "1h"}).json()["confirmation_id"]
        assert client.post(f"/api/confirmations/{cid}/cancel").status_code == 403
        r = client.post(f"/api/confirmations/{cid}/cancel", headers=UI)
        assert r.status_code == 200 and r.json()["status"] == "denied"
        assert client.post(f"/api/confirmations/{cid}/code", headers=UI,
                           json={"code": str(CODE)}).status_code == 409
    assert _status(db, req["id"]) == "pending"
    rows = _rows(db, "decision.confirmation_denied")
    assert len(rows) == 1 and "method=page" in rows[0]["args_preview"]


def test_duplicate_requests_share_one_confirmation_and_the_route_cap(tmp_path, monkeypatch):
    _db(tmp_path, monkeypatch)
    with TestClient(_app(), base_url="http://127.0.0.1:8741") as client:
        a = client.put(SETTINGS, headers=UI, json={"retention_days": 1}).json()["confirmation_id"]
        b = client.put(SETTINGS, headers=UI, json={"retention_days": 1}).json()["confirmation_id"]
        assert a == b
        client.put(SETTINGS, headers=UI, json={"retention_days": 2})
        client.put(SETTINGS, headers=UI, json={"retention_days": 3})
        assert client.put(SETTINGS, headers=UI, json={"retention_days": 4}).status_code == 429


def test_summaries_come_from_the_request():
    assert cf.describe("PUT", "/api/tool-permissions/overrides/Bash",
                       b'{"action": "block", "runtime_kind": "codex"}') == "Set Bash to block for Codex"
    assert cf.describe("DELETE", "/api/tool-permissions/overrides/Bash", b"",
                       b"runtime_kind=claude-code") == "Remove the Bash rule for Claude Code"
    assert cf.describe("PUT", SETTINGS, b'{"block_threats": true, "retention_days": 30}') == \
        "Change settings: block_threats to on, retention_days to 30"
    assert cf.describe("PUT", "/api/settings/llm", b'{"api_key": "sk-123", "model": "m"}') == \
        "Change AI review settings: api_key to (hidden), model to m"
    assert cf.describe("POST", "/api/terminals/config-trust/pins/batch",
                       b'{"items": [{"harness": "codex"}], "changes": 99}') == \
        "Trust the changed config of 1 agent tool (Codex)"


def test_flag_off_is_ignored_outside_pytest(monkeypatch, caplog):
    import sys as _sys

    monkeypatch.setenv("SV_NATIVE_APPROVALS", "0")
    monkeypatch.setitem(cf._ignored_warned, "value", False)
    assert cf.enabled() is False  # under pytest
    monkeypatch.delitem(_sys.modules, "pytest")
    with caplog.at_level(logging.WARNING):
        assert cf.enabled() is True
    assert "SV_NATIVE_APPROVALS=0 was ignored" in caplog.text


def test_linux_notification_never_carries_the_code(monkeypatch):
    calls = []
    monkeypatch.setattr(cf.sys, "platform", "linux")
    monkeypatch.setattr(cf.shutil, "which", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(cf.subprocess, "run", lambda argv, **kw: calls.append((argv, kw)))
    _ORIG_NOTIFY("654321", "Change settings")
    assert calls and all("654321" not in " ".join(argv) and "input" not in kw for argv, kw in calls)


def test_global_lockout_is_audited_and_explained(tmp_path, monkeypatch, capsys):
    db = _db(tmp_path, monkeypatch)
    monkeypatch.setattr(cf, "FAIL_LIMIT", 3)
    ids = [cf.create(_fake_request(f"/api/l{i}"), b"", "x").id for i in range(2)]
    codes = []
    for cid in (ids[0], ids[0], ids[1]):
        with pytest.raises(Exception) as exc:
            asyncio.run(cf.submit_code(cid, "222222"))
        codes.append((exc.value.status_code, exc.value.detail))
    assert codes[-1] == (429, cf.LOCKOUT_TEXT)
    assert cf.LOCKOUT_TEXT in capsys.readouterr().out
    assert len(_rows(db, "decision.confirmation_lockout")) == 1


def test_an_early_answer_is_asked_again_and_a_second_one_is_no():
    from securevector.app import desktop_shell

    def run(durations, answers):
        now = {"t": 0.0}
        asked = []

        def ask(remaining):
            asked.append(remaining)
            now["t"] += durations[len(asked) - 1]
            return answers[len(asked) - 1], "dialog"

        out = desktop_shell.ask_with_early_answer_guard(ask, 120.0, clock=lambda: now["t"])
        return out, len(asked)

    # Return pressed at once (0.1 s): asked again, then a deliberate Allow.
    assert run([0.1, 2.0], [True, True]) == ((True, "dialog"), 2)
    # Two early answers: not confirmed.
    assert run([0.1, 0.2], [True, True]) == ((False, "dialog"), 2)
    # A deliberate first answer stands.
    assert run([1.5], [True]) == ((True, "dialog"), 1)
    assert run([1.5], [False]) == ((False, "dialog"), 1)


def test_macos_alert_defaults_to_cancel_in_source():
    import inspect

    from securevector.app import desktop_shell

    src = inspect.getsource(desktop_shell.cancel_default_alert)
    assert src.index('addButtonWithTitle_("Cancel")') < src.index('addButtonWithTitle_("Allow")')
    assert 'allow.setKeyEquivalent_("")' in src
    # At expiry the modal is aborted only when it is this alert.
    assert "app.modalWindow() == alert.window()" in src and "app.abortModal()" in src


def test_windows_and_linux_desktop_use_a_code_shown_by_the_shell(tmp_path, monkeypatch):
    from securevector.app import desktop_shell

    db = _db(tmp_path, monkeypatch)
    shown = []
    cf.attach_shell(show_code=lambda code, summary: shown.append(cf.code_text(code, summary)))
    with TestClient(_app(), base_url="http://127.0.0.1:8741") as client:
        r = client.put(SETTINGS, headers=UI, json={"retention_days": 6})
        assert r.status_code == 202 and r.json()["method"] == "code"
        cid = r.json()["confirmation_id"]
        for _ in range(100):
            if shown:
                break
            time.sleep(0.02)
        assert shown == [f"SecureVector confirmation code: {CODE}. Type it on the page to allow: "
                         "Change settings: retention_days to 6"]
        assert asyncio.run(SettingsRepository(db).get()).retention_days != 6
        ok = client.post(f"/api/confirmations/{cid}/code", headers=UI, json={"code": str(CODE)})
        assert ok.status_code == 200 and ok.json()["confirmed_by"] == "code"
    assert asyncio.run(SettingsRepository(db).get()).retention_days == 6

    # The shell's dialog only shows the text: its answer decides nothing.
    class Window:
        asked = []

        def create_confirmation_dialog(self, title, message):
            self.asked.append(message)
            return True

    w = Window()
    assert desktop_shell.make_code_display(w)("654321", "Allow Codex to run: Bash") is None
    assert w.asked == ["SecureVector confirmation code: 654321. Type it on the page to allow: "
                       "Allow Codex to run: Bash"]


def test_dirty_worktree_removal_creates_exactly_one_confirmation(tmp_path, monkeypatch):
    from securevector.app.terminals import routes as t_routes
    from securevector.app.terminals.auth import HEADER, TerminalAuth

    db = _db(tmp_path, monkeypatch)
    removed = []

    class Manager:
        store = TerminalStore(db)
        host = None

        async def worktree_removal_check(self, task_id, *, confirm, dirty_seen=None):
            if confirm and dirty_seen == 2:
                return None
            return {"removed": False, "needs_confirm": True, "dirty": 2, "commits": 0,
                    "message": "2 uncommitted files will be lost."}

        async def remove_worktree(self, task_id, *, confirm, origin="ui", dirty_seen=None):
            removed.append((task_id, confirm, dirty_seen))
            return {"removed": True, "message": "Worktree removed."}

    app = FastAPI()
    app.state.terminal_auth = TerminalAuth(token="t" * 48, port=8741)
    app.state.terminal_manager = Manager()
    app.include_router(t_routes.router, prefix="/api")
    cf.install(app)
    cf.attach_shell(lambda summary, timeout=None: (True, "touch_id"))
    with TestClient(app, base_url="http://127.0.0.1:8741") as client:
        client.get("/api/terminals/session")
        hdr = {**UI, HEADER: "1", "Origin": "http://127.0.0.1:8741"}
        url = "/api/terminals/tasks/t-w/worktree/remove"
        probe = client.post(url, headers=hdr, json={"confirm": False})
        assert probe.status_code == 409 and probe.json()["detail"]["needs_confirm"] is True
        stale = client.post(url, headers=hdr, json={"confirm": True, "dirty_seen": 1})
        assert stale.status_code == 409
        assert not cf._store
        r = client.post(url, headers=hdr, json={"confirm": True, "dirty_seen": 2})
        assert r.status_code == 202
        assert r.json()["summary"] == "Remove the worktree of session t-w, including changed files"
        v = _wait(client, r.json()["confirmation_id"])
        assert v["result"]["status_code"] == 200
    assert len(cf._store) == 1 and removed == [("t-w", True, 2)]
