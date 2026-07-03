"""Hermes (runtime_kind=hermes) app wiring (#183).

Three surfaces:

1. HERMES_BUILTINS rows under /api/tool-permissions/essential (category
   "hermes") — the governable Bill-of-Tools rows for the framework-shape
   Hermes runtime (decision oracle = the securevector-sdk-hermes package).
2. Cross-repo drift guard: the app-side HERMES_BUILTINS mirrors the SDK's
   table in securevector-sdk-hermes (skipped when the sibling repo isn't
   checked out next to this one).
3. The ~/.hermes/state.db token-usage reader (hooks_hermes).
"""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from securevector.app.database import connection as conn_mod
from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.server.routes import tool_permissions as tp_routes
from securevector.app.server.routes.tool_permissions import (
    HERMES_BUILTINS,
    router as tp_router,
)


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Isolated tmp-DB TestClient (mirrors test_tool_permissions_builtins)."""
    db_path = tmp_path / "test.db"

    async def _setup():
        db = DatabaseConnection(db_path)
        await run_migrations(db)
        await db.disconnect()

    asyncio.run(_setup())

    original_db = conn_mod._db
    conn_mod._db = DatabaseConnection(db_path)
    monkeypatch.setattr(tp_routes, "_essential_registry", None)

    app = FastAPI()
    app.include_router(tp_router, prefix="/api")
    try:
        yield TestClient(app)
    finally:
        conn_mod._db = original_db


# ── 1. essential rows ────────────────────────────────────────────────────

def test_hermes_builtins_table_is_well_formed():
    names = [name for name, _r, _d in HERMES_BUILTINS]
    assert len(names) == len(set(names)), "duplicate tool ids in HERMES_BUILTINS"
    assert len(names) >= 70
    for _name, risk, desc in HERMES_BUILTINS:
        assert risk in ("read", "write", "admin"), (_name, risk)
        assert desc


def test_hermes_builtins_appear_under_hermes_category(client):
    body = client.get("/api/tool-permissions/essential").json()
    hermes_rows = [t for t in body["tools"] if t["category"] == "hermes"]
    registry_ids = {t["tool_id"] for t in body["tools"] if t["category"] != "hermes"
                    and t["source"] != "builtin"}
    expected = [n for n, _r, _d in HERMES_BUILTINS if n not in registry_ids]
    assert len(hermes_rows) == len(expected), (
        f"expected {len(expected)} hermes rows, got {len(hermes_rows)}"
    )
    by_id = {t["tool_id"]: t for t in hermes_rows}
    terminal = by_id["terminal"]
    assert terminal["provider"] == "Hermes"
    assert terminal["risk"] == "admin"
    assert terminal["source"] == "builtin"
    assert terminal["default_permission"] == "allow"
    assert terminal["effective_action"] == "allow"


def test_hermes_runtime_label_registered():
    assert tp_routes._RUNTIME_LABELS.get("hermes") == "Hermes"


def test_hermes_is_a_known_framework_in_detection():
    from securevector.app.server.routes.detection import (
        _FRAMEWORK_LABELS,
        _HARNESS_RUNTIME_KINDS,
    )
    assert _FRAMEWORK_LABELS.get("hermes") == "Hermes"
    assert "hermes" not in _HARNESS_RUNTIME_KINDS  # framework, not harness


def test_hermes_is_a_valid_proxy_integration():
    from securevector.app.utils.config_file import VALID_INTEGRATIONS
    assert "hermes" in VALID_INTEGRATIONS


# ── 2. cross-repo drift vs securevector-sdk-hermes ──────────────────────

SDK_TOOL_ID = (
    Path(__file__).resolve().parents[3].parent
    / "securevector-sdk-hermes" / "src" / "securevector_sdk_hermes" / "tool_id.py"
)


@pytest.mark.skipif(not SDK_TOOL_ID.is_file(), reason="securevector-sdk-hermes not checked out")
def test_hermes_builtins_mirror_the_sdk_table():
    """The SDK's HERMES_BUILTINS (what the guard resolves) and the app's
    (what the UI surfaces as governable rows) must not drift."""
    import ast

    tree = ast.parse(SDK_TOOL_ID.read_text())
    tables: dict[str, list[str]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            tgt = node.targets[0]
            if isinstance(tgt, ast.Name) and isinstance(node.value, ast.Tuple):
                vals = [e.value for e in node.value.elts
                        if isinstance(e, ast.Constant) and isinstance(e.value, str)]
                if vals:
                    tables[tgt.id] = vals
    sdk_names = set(
        tables.get("_CORE_TOOLS", []) + tables.get("_BRIDGE_TOOLS", [])
        + tables.get("_BUNDLED_PLUGIN_TOOLS", [])
    )
    assert sdk_names, "could not parse the SDK's builtin tables"
    app_names = {n for n, _r, _d in HERMES_BUILTINS}
    assert sdk_names == app_names, (
        f"drift — only in SDK: {sorted(sdk_names - app_names)}; "
        f"only in app: {sorted(app_names - sdk_names)}"
    )


# ── 3. token-usage reader ────────────────────────────────────────────────

def _seed_state_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.execute(
        """CREATE TABLE sessions (
            id TEXT PRIMARY KEY, model TEXT, message_count INTEGER,
            input_tokens INTEGER, output_tokens INTEGER,
            cache_read_tokens INTEGER, cache_write_tokens INTEGER,
            started_at REAL, ended_at REAL
        )"""
    )
    conn.executemany(
        "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)",
        [
            ("s1", "hermes-4-405b", 12, 1000, 500, 200, 50, 1751300000.0, 1751303600.0),
            ("s2", "hermes-4-405b", 3, 300, 100, 0, 0, 1751310000.0, None),
            ("s3", "gpt-5", 5, 700, 250, 100, 25, 1751320000.0, 1751321000.0),
            ("s4", "idle-model", 0, 0, 0, 0, 0, 1751330000.0, None),  # excluded
        ],
    )
    conn.commit()
    conn.close()


def test_hermes_token_usage_aggregates_state_db(tmp_path, monkeypatch):
    from securevector.app.server.routes import hooks_hermes

    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    _seed_state_db(hermes_home / "state.db")
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))

    usage = hooks_hermes._compute_hermes_token_usage_sync()
    assert usage.sessions == 3          # zero-token session excluded
    assert usage.turns_with_usage == 20
    assert usage.input_tokens == 2000
    assert usage.output_tokens == 850
    assert usage.cache_read_input_tokens == 300
    assert usage.cache_creation_input_tokens == 75
    assert usage.last_activity is not None
    by_model = {m.model: m for m in usage.by_model}
    assert by_model["hermes-4-405b"].input_tokens == 1300
    assert by_model["gpt-5"].output_tokens == 250
    assert usage.daily, "daily buckets expected"


def test_hermes_token_usage_missing_db_returns_zeros(tmp_path, monkeypatch):
    from securevector.app.server.routes import hooks_hermes

    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "nope"))
    usage = hooks_hermes._compute_hermes_token_usage_sync()
    assert usage.sessions == 0
    assert usage.input_tokens == 0
    assert usage.by_model == []
