"""The JIT UI token is handed only to the served web UI page: the page
response sets an HttpOnly, SameSite=Strict cookie, and /api/jit/ui-token
needs that cookie on top of the same-origin checks.

Sync bodies + asyncio.run for setup, like the ingress-token tests.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

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


def _run(check, monkeypatch, tmp_path):
    monkeypatch.delenv("SECUREVECTOR_INGRESS_TOKEN", raising=False)
    db = DatabaseConnection(tmp_path / "t.db")
    asyncio.run(run_migrations(db))
    db_module._db = db
    try:
        with TestClient(create_app(), base_url=BASE) as client:
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
