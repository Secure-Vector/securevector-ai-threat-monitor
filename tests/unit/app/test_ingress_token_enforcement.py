"""Inbound ingress-token enforcement (#190, engine v4.9.0+).

When SECUREVECTOR_INGRESS_TOKEN is set, the engine must require it on every
request (Authorization: Bearer <token> or X-Api-Key: <token>); /health stays
open for the load-balancer probe, and an unset token means no app-layer gate
(back-compat). This is the inbound counterpart to the SDK/plugin
SECUREVECTOR_ENGINE_ENDPOINT forwarding — it closes the auth loop for a
publicly-exposed self-host endpoint.

Sync bodies + asyncio.run for setup: the repo conftest installs a
pytest_sessionfinish that os._exit's the runner, which swallows async-fixture
tracebacks.
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

TOKEN = "test-ingress-token-xyz123"
PROTECTED = "/api/system/device-id"   # a non-/health route that needs no DB


def _build_app(tmp_path):
    db = DatabaseConnection(tmp_path / "test.db")
    asyncio.run(run_migrations(db))
    db_module._db = db
    return create_app(), db


def _teardown(db):
    asyncio.run(db.disconnect())


def test_token_set_blocks_without_credential(tmp_path, monkeypatch):
    monkeypatch.setenv("SECUREVECTOR_INGRESS_TOKEN", TOKEN)
    app, db = _build_app(tmp_path)
    try:
        with TestClient(app) as client:
            assert client.get(PROTECTED).status_code == 401
    finally:
        _teardown(db)


def test_token_set_allows_bearer_and_xapikey(tmp_path, monkeypatch):
    monkeypatch.setenv("SECUREVECTOR_INGRESS_TOKEN", TOKEN)
    app, db = _build_app(tmp_path)
    try:
        with TestClient(app) as client:
            assert client.get(PROTECTED, headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 200
            assert client.get(PROTECTED, headers={"X-Api-Key": TOKEN}).status_code == 200
    finally:
        _teardown(db)


def test_token_set_rejects_wrong_credential(tmp_path, monkeypatch):
    monkeypatch.setenv("SECUREVECTOR_INGRESS_TOKEN", TOKEN)
    app, db = _build_app(tmp_path)
    try:
        with TestClient(app) as client:
            assert client.get(PROTECTED, headers={"Authorization": "Bearer wrong"}).status_code == 401
            assert client.get(PROTECTED, headers={"X-Api-Key": "wrong"}).status_code == 401
    finally:
        _teardown(db)


def test_health_stays_open_even_with_token(tmp_path, monkeypatch):
    monkeypatch.setenv("SECUREVECTOR_INGRESS_TOKEN", TOKEN)
    app, db = _build_app(tmp_path)
    try:
        with TestClient(app) as client:
            assert client.get("/health").status_code == 200   # ALB probe must pass
    finally:
        _teardown(db)


def test_no_gate_when_token_unset(tmp_path, monkeypatch):
    monkeypatch.delenv("SECUREVECTOR_INGRESS_TOKEN", raising=False)
    app, db = _build_app(tmp_path)
    try:
        with TestClient(app) as client:
            assert client.get(PROTECTED).status_code == 200   # back-compat: open
    finally:
        _teardown(db)
