import os

import pytest
from fastapi import Depends, FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from securevector.app.terminals.auth import (
    COOKIE,
    HEADER,
    TerminalAuth,
    get_auth,
    load_or_create_token,
)


def test_token_file_is_created_with_private_permissions(tmp_path):
    t1 = load_or_create_token(tmp_path)
    t2 = load_or_create_token(tmp_path)
    assert t1 == t2 and len(t1) >= 32
    path = tmp_path / "terminals" / "ui-token"
    assert path.exists()
    if os.name == "posix":
        assert oct(path.stat().st_mode & 0o777) == "0o600"
        assert oct(path.parent.stat().st_mode & 0o777) == "0o700"


def test_weak_permissions_on_existing_token_file_are_repaired(tmp_path):
    if os.name != "posix":
        pytest.skip("POSIX file permissions only")
    token = load_or_create_token(tmp_path)
    path = tmp_path / "terminals" / "ui-token"
    os.chmod(path, 0o644)
    token_again = load_or_create_token(tmp_path)
    assert token_again == token
    assert oct(path.stat().st_mode & 0o777) == "0o600"


def test_foreign_owned_token_file_is_rotated_not_crashed(tmp_path, monkeypatch):
    if os.name != "posix":
        pytest.skip("POSIX file ownership only")
    original = load_or_create_token(tmp_path)
    path = tmp_path / "terminals" / "ui-token"
    # Unwritable: if load_or_create_token tried to open-and-truncate this
    # file directly instead of unlinking it first, that open would raise
    # PermissionError. This makes the unlink() call load-bearing for the
    # test rather than incidental.
    os.chmod(path, 0o400)
    real_getuid = os.getuid
    monkeypatch.setattr(os, "getuid", lambda: real_getuid() + 1)
    rotated = load_or_create_token(tmp_path)
    monkeypatch.setattr(os, "getuid", real_getuid)
    assert len(rotated) >= 32
    assert rotated != original
    assert oct(path.stat().st_mode & 0o777) == "0o600"


def test_parent_directory_ownership_failure_raises_runtime_error(tmp_path, monkeypatch):
    if os.name != "posix":
        pytest.skip("POSIX file ownership only")
    real_chmod = os.chmod
    terminals_dir = str(tmp_path / "terminals")

    def fake_chmod(path, mode):
        if str(path) == terminals_dir:
            raise PermissionError("simulated: not our directory")
        return real_chmod(path, mode)

    monkeypatch.setattr(os, "chmod", fake_chmod)
    with pytest.raises(RuntimeError, match="not owned"):
        load_or_create_token(tmp_path)


def test_symlink_at_token_path_raises_runtime_error(tmp_path):
    if os.name != "posix":
        pytest.skip("POSIX symlinks only")
    path = tmp_path / "terminals" / "ui-token"
    path.parent.mkdir(parents=True)
    target = tmp_path / "elsewhere"
    target.write_text("not a real token")
    path.symlink_to(target)
    with pytest.raises(RuntimeError, match="symlink"):
        load_or_create_token(tmp_path)


def test_short_token_file_is_regenerated(tmp_path):
    path = tmp_path / "terminals" / "ui-token"
    path.parent.mkdir(parents=True)
    path.write_text("too-short")
    token = load_or_create_token(tmp_path)
    assert len(token) >= 32
    assert path.read_text().strip() == token


def test_get_auth_returns_503_when_app_has_no_auth():
    app = FastAPI()

    @app.get("/x")
    async def x(auth=Depends(get_auth)):
        return {"ok": True}

    c = TestClient(app)
    r = c.get("/x")
    assert r.status_code == 503


@pytest.fixture
def client(tmp_path):
    auth = TerminalAuth(token=load_or_create_token(tmp_path), port=8741)
    app = FastAPI()
    app.state.terminal_auth = auth

    @app.get("/api/terminals/session")
    async def session(request=Depends(auth.session_response)):
        return request

    @app.get("/api/terminals/tasks", dependencies=[Depends(auth.require_read)])
    async def read():
        return {"ok": True}

    @app.post("/api/terminals/tasks", dependencies=[Depends(auth.require_write)])
    async def write():
        return {"ok": True}

    # Lives under /api/terminals like the rest of the surface: the auth
    # cookie is scoped to that path (see auth.COOKIE_PATH), so a websocket
    # route outside it would never receive the cookie in a real browser.
    @app.websocket("/api/terminals/ws")
    async def ws(websocket: WebSocket):
        if not auth.check_ws(websocket):
            await websocket.close(code=4001)
            return
        await websocket.accept()
        await websocket.send_json({"ok": True})
        await websocket.close()

    return TestClient(app, base_url="http://127.0.0.1:8741"), auth


def test_session_sets_httponly_cookie(client):
    c, auth = client
    r = c.get("/api/terminals/session", headers={"Origin": "http://127.0.0.1:8741"})
    assert r.status_code == 200
    cookie = r.headers["set-cookie"]
    assert f"{COOKIE}=" in cookie and "HttpOnly" in cookie and "samesite=strict" in cookie.lower()
    assert r.headers["cache-control"] == "no-store"
    assert c.cookies.get(COOKIE) == auth.token


def test_read_requires_cookie_and_header(client):
    c, auth = client
    assert c.get("/api/terminals/tasks").status_code == 403
    c.get("/api/terminals/session")
    # Cookie alone doesn't unlock reads either: SameSite=strict is scoped to
    # the whole site, not one origin, so a same-site <img>/form GET carries
    # the cookie automatically but can't set a custom header -- only
    # same-origin fetch/XHR (what the UI actually uses) can.
    assert c.get("/api/terminals/tasks").status_code == 403
    assert c.get("/api/terminals/tasks", headers={HEADER: "1"}).status_code == 200


def test_write_requires_origin(client):
    c, auth = client
    c.get("/api/terminals/session")
    # Writes additionally require a matching Origin.
    assert c.post("/api/terminals/tasks").status_code == 403
    assert c.post("/api/terminals/tasks", headers={HEADER: "1"}).status_code == 403
    assert (
        c.post(
            "/api/terminals/tasks", headers={HEADER: "1", "Origin": "http://evil.test"}
        ).status_code
        == 403
    )
    assert (
        c.post(
            "/api/terminals/tasks", headers={HEADER: "1", "Origin": "http://127.0.0.1:8741"}
        ).status_code
        == 200
    )
    assert (
        c.post(
            "/api/terminals/tasks", headers={HEADER: "1", "Origin": "http://localhost:8741"}
        ).status_code
        == 200
    )


def test_bad_host_header_is_rejected(client):
    c, _ = client
    c.get("/api/terminals/session")
    r = c.get("/api/terminals/tasks", headers={"Host": "attacker.example:8741", HEADER: "1"})
    assert r.status_code == 403


def test_portless_host_is_rejected(client):
    c, _ = client
    c.get("/api/terminals/session")
    r = c.get("/api/terminals/tasks", headers={"Host": "127.0.0.1", HEADER: "1"})
    assert r.status_code == 403


def test_ipv6_loopback_host_is_accepted(client):
    c, _ = client
    r = c.get(
        "/api/terminals/session",
        headers={"Host": "[::1]:8741", "Origin": "http://[::1]:8741"},
    )
    assert r.status_code == 200
    r = c.get("/api/terminals/tasks", headers={"Host": "[::1]:8741", HEADER: "1"})
    assert r.status_code == 200


def test_null_origin_is_rejected(client):
    c, _ = client
    c.get("/api/terminals/session")
    r = c.post("/api/terminals/tasks", headers={HEADER: "1", "Origin": "null"})
    assert r.status_code == 403


def test_wrong_cookie_value_is_rejected(client):
    c, _ = client
    c.cookies.set(COOKIE, "0" * 48)
    assert c.get("/api/terminals/tasks", headers={HEADER: "1"}).status_code == 403


def test_non_ascii_cookie_is_rejected_without_raising(client):
    # httpx's Headers rejects any non-ASCII value at construction time (both
    # Latin-1-range and full-Unicode characters), so a genuine non-ASCII
    # cookie can't be sent end-to-end through TestClient in this environment.
    # Exercise the primitive directly instead: it must return False (leading
    # to a 403 at the call sites), never raise, for a non-ASCII value.
    _, auth = client
    assert auth._cookie_ok({COOKIE: "café" + "0" * 40}) is False
    assert auth._cookie_ok({COOKIE: "\U0001f525" + "0" * 40}) is False


def test_websocket_positive_case_connects(client):
    # Starlette's TestClient builds every websocket_connect request against
    # a hardcoded "ws://testserver" base (see starlette.testclient), not
    # base_url, so the Host header must be set explicitly here to exercise
    # the same origin the fixture's base_url uses, and the session cookie
    # -- scoped to the real "127.0.0.1"/"localhost" domains -- never gets
    # auto-attached by httpx's cookie jar for a "testserver" request, so it
    # must be passed explicitly too.
    c, auth = client
    c.get("/api/terminals/session")
    cookie_header = f"{COOKIE}={auth.token}"
    with c.websocket_connect(
        "/api/terminals/ws",
        headers={
            "Origin": "http://127.0.0.1:8741",
            "Host": "127.0.0.1:8741",
            "Cookie": cookie_header,
        },
    ) as ws:
        assert ws.receive_json() == {"ok": True}


def test_websocket_rejects_missing_cookie(client):
    c, _ = client
    with pytest.raises(WebSocketDisconnect) as exc:
        with c.websocket_connect(
            "/api/terminals/ws",
            headers={"Origin": "http://127.0.0.1:8741", "Host": "127.0.0.1:8741"},
        ) as ws:
            ws.receive_json()
    assert exc.value.code == 4001


def test_websocket_rejects_missing_origin(client):
    c, auth = client
    c.get("/api/terminals/session")
    cookie_header = f"{COOKIE}={auth.token}"
    with pytest.raises(WebSocketDisconnect) as exc:
        with c.websocket_connect(
            "/api/terminals/ws",
            headers={"Host": "127.0.0.1:8741", "Cookie": cookie_header},
        ) as ws:
            ws.receive_json()
    assert exc.value.code == 4001


def test_websocket_rejects_evil_origin(client):
    c, auth = client
    c.get("/api/terminals/session")
    cookie_header = f"{COOKIE}={auth.token}"
    with pytest.raises(WebSocketDisconnect) as exc:
        with c.websocket_connect(
            "/api/terminals/ws",
            headers={
                "Origin": "http://evil.test",
                "Host": "127.0.0.1:8741",
                "Cookie": cookie_header,
            },
        ) as ws:
            ws.receive_json()
    assert exc.value.code == 4001


def test_websocket_missing_cookie_check_is_load_bearing(client, monkeypatch):
    # Mutation check: if check_ws stopped looking at the cookie, the
    # "missing cookie" negative case above would start passing for the
    # wrong reason. Prove the test actually depends on that check by
    # temporarily neutering it, confirming the connection now succeeds,
    # then restoring the real check and reconfirming rejection.
    c, auth = client
    real_check_ws = auth.check_ws

    def check_ws_ignoring_cookie(websocket):
        return auth._host_ok(websocket.headers) and auth._origin_ok(
            websocket.headers, required=True
        )

    monkeypatch.setattr(auth, "check_ws", check_ws_ignoring_cookie)
    with c.websocket_connect(
        "/api/terminals/ws",
        headers={"Origin": "http://127.0.0.1:8741", "Host": "127.0.0.1:8741"},
    ) as ws:
        assert ws.receive_json() == {"ok": True}

    monkeypatch.setattr(auth, "check_ws", real_check_ws)
    with pytest.raises(WebSocketDisconnect) as exc:
        with c.websocket_connect(
            "/api/terminals/ws",
            headers={"Origin": "http://127.0.0.1:8741", "Host": "127.0.0.1:8741"},
        ) as ws:
            ws.receive_json()
    assert exc.value.code == 4001
