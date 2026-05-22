"""Built-ins surfaced under /api/tool-permissions/essential (#103).

The endpoint must list registry tools AND the 24 Claude Code built-ins so
the Tool Permissions UI can render them as governable rows. The list of
built-ins is mirrored from `BUILTIN_TOOLS` in
`src/securevector/plugins/claude-code/lib/normalize.js`; the drift-check
test below opens the JS file, parses the Set, and asserts every name has
a Python entry.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from securevector.app.database import connection as conn_mod
from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.synced_rules import SyncedRulesRepository
from securevector.app.server.routes import tool_permissions as tp_routes
from securevector.app.server.routes.tool_permissions import (
    CLAUDE_CODE_BUILTINS,
    router as tp_router,
)
from tests.fixtures.synced_rules import seed_synced_rules


REPO = Path(__file__).resolve().parents[3]
NORMALIZE_JS = REPO / "src" / "securevector" / "plugins" / "claude-code" / "lib" / "normalize.js"


def _builtins_from_js() -> set[str]:
    """Parse normalize.js' BUILTIN_TOOLS Set declaration to its name list."""
    src = NORMALIZE_JS.read_text()
    m = re.search(r"BUILTIN_TOOLS\s*=\s*new\s+Set\(\s*\[(.+?)\]\s*\)", src, re.DOTALL)
    assert m, "could not locate BUILTIN_TOOLS in normalize.js"
    return set(re.findall(r"'([A-Za-z]+)'", m.group(1)))


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Spin up a FastAPI TestClient with an isolated tmp SQLite DB so we
    can seed synced rules without touching the production app data dir.

    Uses ``asyncio.run`` (creates + closes a fresh loop per call) instead
    of ``get_event_loop().run_until_complete``, which raises on Python
    3.13 when no current loop exists. Each call rebinds the singleton's
    ``_db`` to a fresh ``DatabaseConnection`` so the FastAPI route's
    ``get_database()`` resolves to our tmp path.
    """
    import asyncio

    db_path = tmp_path / "test.db"

    async def _setup():
        db = DatabaseConnection(db_path)
        await run_migrations(db)
        await db.disconnect()

    asyncio.run(_setup())

    original_db = conn_mod._db
    # Path-pinned instance — FastAPI's route opens its own aiosqlite handle
    # on first request, bound to whatever loop the TestClient drives.
    conn_mod._db = DatabaseConnection(db_path)

    # Registry is module-cached — reset so the test gets a clean read.
    monkeypatch.setattr(tp_routes, "_essential_registry", None)

    app = FastAPI()
    app.include_router(tp_router, prefix="/api")
    try:
        yield TestClient(app), db_path
    finally:
        conn_mod._db = original_db


def _seed_bash_deny(db_path: Path) -> None:
    import asyncio

    async def _go():
        db = DatabaseConnection(db_path)
        try:
            repo = SyncedRulesRepository(db)
            await seed_synced_rules(
                repo,
                [{"tool_id": "Bash", "effect": "deny", "reason": "policy block"}],
                policy_name="Test Bash Block",
                policy_version=7,
            )
        finally:
            await db.disconnect()

    asyncio.run(_go())


# ─────────────────────────────────────────────────────────────────────────


def test_builtins_table_mirrors_normalize_js():
    """Every name in `BUILTIN_TOOLS` (JS) has a Python entry in
    CLAUDE_CODE_BUILTINS. Drift-check between the two SoTs."""
    js_names = _builtins_from_js()
    py_names = {name for (name, _r, _d) in CLAUDE_CODE_BUILTINS}
    missing_in_py = js_names - py_names
    missing_in_js = py_names - js_names
    assert not missing_in_py, f"Python table missing built-ins present in JS: {missing_in_py}"
    assert not missing_in_js, f"Python table has names absent from JS: {missing_in_js}"


def test_essential_response_includes_24_builtins(client):
    api, _ = client
    resp = api.get("/api/tool-permissions/essential")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    by_id = {t["tool_id"]: t for t in body["tools"]}
    for name, risk, _desc in CLAUDE_CODE_BUILTINS:
        assert name in by_id, f"built-in '{name}' missing from essential response"
        row = by_id[name]
        assert row["category"] == "claude_code", row
        assert row["risk"] == risk, row
        assert row["source"] == "builtin", row
        assert row["default_permission"] == "allow", row
        # Default precedence — no override, no synced, no last_resort.
        assert row["effective_action"] == "allow", row
        assert row["effective_source"] == "default", row


def test_synced_deny_rule_flips_bash_to_deny_with_policy_attribution(client):
    api, db_path = client
    _seed_bash_deny(db_path)

    resp = api.get("/api/tool-permissions/essential")
    assert resp.status_code == 200
    bash = next(t for t in resp.json()["tools"] if t["tool_id"] == "Bash")

    assert bash["effective_action"] == "deny", bash
    assert bash["effective_source"] == "synced", bash
    assert bash["is_synced"] is True, bash
    assert bash["synced_policy_name"] == "Test Bash Block", bash
    assert bash["synced_policy_version"] == 7, bash
    assert "policy block" in (bash["synced_reason"] or ""), bash


def test_builtins_appear_under_claude_code_category(client):
    api, _ = client
    body = api.get("/api/tool-permissions/essential").json()
    cc_rows = [t for t in body["tools"] if t["category"] == "claude_code"]
    assert len(cc_rows) == len(CLAUDE_CODE_BUILTINS), (
        f"expected {len(CLAUDE_CODE_BUILTINS)} claude_code rows, got {len(cc_rows)}"
    )


def test_registry_tools_still_intact(client):
    """Adding built-ins must not displace registry tools.

    The exact category names aren't pinned — the YAML registry can rename
    categories without breaking this test. We just require that the
    response carries non-claude_code rows AND no row's tool_id collides
    with a built-in (registry wins on collision per the loop's skip
    rule).
    """
    api, _ = client
    body = api.get("/api/tool-permissions/essential").json()
    non_builtin = [t for t in body["tools"] if t["category"] != "claude_code"]
    assert len(non_builtin) >= 10, (
        f"expected ≥10 registry tools loaded alongside built-ins; got {len(non_builtin)}"
    )
    builtin_names = {n for (n, _r, _d) in CLAUDE_CODE_BUILTINS}
    colliding = [t["tool_id"] for t in non_builtin if t["tool_id"] in builtin_names]
    assert not colliding, f"registry tool_ids collide with built-in names: {colliding}"


def test_override_endpoints_accept_builtin_tool_ids(client):
    """PUT / DELETE on /overrides/{tool_id} must accept built-in names —
    otherwise every 'Block Bash' click from the UI silently 404s.
    Regression guard for the gap caught in #103 Phase 1 review.
    """
    api, _ = client
    # Block Bash (a built-in, not in the registry)
    put = api.put("/api/tool-permissions/overrides/Bash", json={"action": "block"})
    assert put.status_code == 200, put.text

    # Confirm the override now drives effective_action.
    body = api.get("/api/tool-permissions/essential").json()
    bash = next(t for t in body["tools"] if t["tool_id"] == "Bash")
    assert bash["effective_action"] == "block", bash
    assert bash["effective_source"] == "local", bash
    assert bash["has_override"] is True, bash

    # Reset
    delete = api.delete("/api/tool-permissions/overrides/Bash")
    assert delete.status_code == 200, delete.text

    body = api.get("/api/tool-permissions/essential").json()
    bash = next(t for t in body["tools"] if t["tool_id"] == "Bash")
    assert bash["effective_action"] == "allow", bash  # back to built-in default
    assert bash["effective_source"] == "default", bash
    assert bash["has_override"] is False, bash


def test_override_endpoint_still_rejects_unknown_ids(client):
    """The widened guard must NOT accept arbitrary strings — only
    registry tools + the canonical built-ins list."""
    api, _ = client
    resp = api.put(
        "/api/tool-permissions/overrides/NotARealTool",
        json={"action": "block"},
    )
    assert resp.status_code == 404, resp.text
