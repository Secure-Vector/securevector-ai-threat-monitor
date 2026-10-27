"""The JIT UI token is handed only to the served web UI page: the page
response sets an HttpOnly, SameSite=Strict cookie, and /api/jit/ui-token
needs that cookie on top of the same-origin checks.

Sync bodies + asyncio.run for setup, like the ingress-token tests.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from securevector.app.database import connection as db_module  # noqa: E402
from securevector.app.database.connection import DatabaseConnection  # noqa: E402
from securevector.app.database.migrations import run_migrations  # noqa: E402
from securevector.app.server.app import create_app  # noqa: E402
from securevector.app.server.routes import jit_access  # noqa: E402

BASE = "http://127.0.0.1:8741"
FORGED = [
    {"Sec-Fetch-Site": "same-origin"},
    {"Origin": BASE},
    {"Referer": BASE + "/"},
    {"User-Agent": "Mozilla/5.0 SecureVectorDesktop/6.0.0"},
]


def _run(check, monkeypatch, tmp_path, base=BASE, peer=("127.0.0.1", 50000)):
    monkeypatch.delenv("SECUREVECTOR_INGRESS_TOKEN", raising=False)
    db = DatabaseConnection(tmp_path / "t.db")
    asyncio.run(run_migrations(db))
    db_module._db = db
    try:
        with TestClient(create_app(), base_url=base, client=peer) as client:
            check(client)
    finally:
        asyncio.run(db.disconnect())


def test_forged_headers_without_the_page_cookie_get_403(tmp_path, monkeypatch):
    def check(client):
        for headers in FORGED:
            res = client.get("/api/jit/ui-token", headers=headers)
            assert res.status_code == 403, headers
    _run(check, monkeypatch, tmp_path)


def test_a_forged_cookie_value_gets_403(tmp_path, monkeypatch):
    def check(client):
        res = client.get("/api/jit/ui-token", headers={"Sec-Fetch-Site": "same-origin",
                                                       "Cookie": f"{jit_access.UI_PAGE_COOKIE}=nope"})
        assert res.status_code == 403
    _run(check, monkeypatch, tmp_path)


def test_the_served_page_sets_the_cookie_and_the_page_gets_the_token(tmp_path, monkeypatch):
    def check(client):
        page = client.get("/")
        assert page.status_code == 200
        cookie = page.headers.get("set-cookie", "")
        assert jit_access.UI_PAGE_COOKIE in cookie
        low = cookie.lower()
        assert "httponly" in low and "samesite=strict" in low and "path=/api/jit" in low
        # Browser fetch from the page: cookie plus same-origin header.
        res = client.get("/api/jit/ui-token", headers={"Sec-Fetch-Site": "same-origin"})
        assert res.status_code == 200 and res.json()["token"] == jit_access._UI_TOKEN
        # Desktop shell web view: cookie plus its user-agent token.
        res = client.get("/api/jit/ui-token", headers={"User-Agent": "Mozilla/5.0 SecureVectorDesktop/6.0.0"})
        assert res.status_code == 200
        # The cookie alone, with no same-origin signal, is still refused.
        assert client.get("/api/jit/ui-token").status_code == 403
        # A client-side route serves the page too, with the cookie.
        assert jit_access.UI_PAGE_COOKIE in client.get("/terminals").headers.get("set-cookie", "")
    _run(check, monkeypatch, tmp_path)


DESKTOP_UA = {"User-Agent": "Mozilla/5.0 AppleWebKit SecureVectorDesktop/6.0.0"}


def test_the_token_is_answered_only_to_a_loopback_peer(tmp_path, monkeypatch):
    """A peer that is not loopback is refused, cookie and same-origin or not."""
    def check(client):
        assert client.get("/").status_code == 200
        for headers in ({"Sec-Fetch-Site": "same-origin"}, DESKTOP_UA):
            res = client.get("/api/jit/ui-token", headers=headers)
            assert res.status_code == 403, headers
            assert res.json()["detail"] == jit_access.LOCAL_ONLY_DETAIL
    _run(check, monkeypatch, tmp_path, base="http://10.0.0.5:8741", peer=("10.0.0.9", 50000))


def test_a_loopback_peer_with_another_host_name_is_refused(tmp_path, monkeypatch):
    def check(client):
        assert client.get("/").status_code == 200
        res = client.get("/api/jit/ui-token", headers={"Sec-Fetch-Site": "same-origin"})
        assert res.status_code == 403
        assert res.json()["detail"] == jit_access.LOCAL_ONLY_DETAIL
    _run(check, monkeypatch, tmp_path, base="http://evil.example:8741")


@pytest.mark.parametrize("base", [BASE, "http://localhost:8741"])
def test_this_machine_page_and_desktop_shell_get_the_token(tmp_path, monkeypatch, base):
    def check(client):
        assert client.get("/").status_code == 200
        for headers in ({"Sec-Fetch-Site": "same-origin"}, DESKTOP_UA):
            res = client.get("/api/jit/ui-token", headers=headers)
            assert res.status_code == 200, headers
            assert res.json()["token"] == jit_access._UI_TOKEN
    _run(check, monkeypatch, tmp_path, base=base)


def test_decision_routes_still_need_the_token(tmp_path, monkeypatch):
    def check(client):
        assert client.post("/api/jit/grants/g-1/revoke", json={}).status_code == 403
        assert client.post("/api/jit/requests/r-1/approve", json={"duration": "once"}).status_code == 403
        assert client.post("/api/confirmations/c-1/cancel").status_code == 403
        assert client.post("/api/confirmations/c-1/code", json={"code": "123456"}).status_code == 403
    _run(check, monkeypatch, tmp_path)


def test_loopback_helpers():
    for ip in ("127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"):
        assert jit_access._loopback_ip(ip), ip
    for ip in ("10.0.0.5", "::ffff:10.0.0.5", "testclient", "", None, "0.0.0.0"):
        assert not jit_access._loopback_ip(ip), ip
    for h in ("localhost", "localhost:8741", "127.0.0.1", "127.0.0.1:8741", "[::1]", "[::1]:8741", "LOCALHOST:8741"):
        assert jit_access._loopback_host_header(h), h
    for h in ("evil.example", "127.0.0.1.evil.example", "10.0.0.5:8741", "localhost:x", "[::1]x", "[::1", "", None,
              "localhost.:8741", "0.0.0.0", "0.0.0.0:8741", "127.1", "127.0.0.1@evil", "127.0.0.1@evil.example:8741",
              "localhost:٨٧٤١", "[::1]:٨٧"):
        assert not jit_access._loopback_host_header(h), h


def test_a_request_with_no_host_header_is_refused():
    from types import SimpleNamespace

    req = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))
    assert not jit_access._asked_on_this_machine(req)
    req = SimpleNamespace(headers={"host": "127.0.0.1:8741"}, client=None)
    assert not jit_access._asked_on_this_machine(req)


def test_desktop_window_opens_loopback_for_wildcard_binds():
    from securevector.app.main import desktop_url

    for host in ("0.0.0.0", "::", "[::]", "", None):
        assert desktop_url(host, 8741) == "http://127.0.0.1:8741", host
    assert desktop_url("127.0.0.1", 8741) == "http://127.0.0.1:8741"
    assert desktop_url("localhost", 8741) == "http://localhost:8741"
    assert desktop_url("::1", 8741) == "http://[::1]:8741"
    # One specific address: the server does not listen on loopback.
    assert desktop_url("192.168.1.20", 8741) == "http://192.168.1.20:8741"
