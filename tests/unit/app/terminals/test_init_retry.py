"""A failed Agent Terminals start is retried instead of answering 503 until
the app restarts."""

import sqlite3

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.server import app as app_module
from securevector.app.terminals.auth import TerminalAuth, get_auth, load_or_create_token
from securevector.app.terminals.manager import TerminalManager
from securevector.app.terminals.routes import get_manager


def test_routes_retry_a_failed_start_on_the_next_request(tmp_path):
    app = FastAPI()
    app.state.terminal_auth = None
    app.state.terminal_manager = None
    calls = []

    async def reinit():
        calls.append(1)
        if len(calls) == 1:
            return False  # still failing
        app.state.terminal_auth = TerminalAuth(token=load_or_create_token(tmp_path), port=8741)
        app.state.terminal_manager = object()
        return True

    app.state.terminals_reinit = reinit

    @app.get("/x")
    async def x(auth=Depends(get_auth), manager=Depends(get_manager)):
        return {"ok": True}

    c = TestClient(app)
    assert c.get("/x").status_code == 503
    assert c.get("/x").status_code == 200
    assert c.get("/x").status_code == 200
    assert len(calls) == 2  # no retry once initialised


@pytest.mark.asyncio
async def test_init_fails_on_a_locked_database_then_succeeds(tmp_path, monkeypatch):
    db = DatabaseConnection(tmp_path / "t.db")
    await run_migrations(db)
    monkeypatch.setattr(
        "securevector.app.utils.platform.get_app_data_dir", lambda: tmp_path
    )
    real_start = TerminalManager.start
    attempts = []

    async def flaky_start(self, loop):
        attempts.append(1)
        if len(attempts) == 1:
            raise sqlite3.OperationalError("database is locked")
        await real_start(self, loop)

    monkeypatch.setattr(TerminalManager, "start", flaky_start)
    app = FastAPI()
    app.state.port = 8741

    assert await app_module.init_agent_terminals(app, db) is False
    assert app.state.terminal_manager is None and app.state.terminal_auth is None

    assert await app_module.ensure_agent_terminals(app, db) is True
    assert app.state.terminal_manager is not None and app.state.terminal_auth is not None
    app.state.codex_web_observer.cancel()


@pytest.mark.asyncio
async def test_lazy_retry_is_throttled(tmp_path, monkeypatch):
    app = FastAPI()
    app.state.terminal_manager = None
    tries = []

    async def failing(app_, db_):
        tries.append(1)
        return False

    monkeypatch.setattr(app_module, "init_agent_terminals", failing)
    assert await app_module.ensure_agent_terminals(app, None) is False
    assert await app_module.ensure_agent_terminals(app, None) is False
    assert len(tries) == 1  # second call inside the throttle window
    app.state.terminals_last_attempt -= app_module.TERMINALS_LAZY_RETRY_SECONDS + 1
    assert await app_module.ensure_agent_terminals(app, None) is False
    assert len(tries) == 2
