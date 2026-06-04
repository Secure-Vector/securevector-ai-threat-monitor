"""Tool Permissions — global enforcement kill-switch.

The `tool_permissions_enabled` flag on app_settings is exposed in the UI
as the "Enforcement" toggle on the Tool Permissions page. Historically it
gated only the proxy. Plugins (Claude Code / Codex / OpenClaw) consult
`/api/tool-permissions/synced-overrides` as their decision oracle and
ignored the toggle entirely — so the user could "disable" enforcement
in the UI and still see Codex bash calls blocked.

These tests pin the v4.4.1 fix: when the toggle is OFF the endpoint
returns `{synced: [], total: 0}` regardless of how many local or synced
rules exist, which makes every plugin's `decideFromOverrides` fail-open
to allow.

Uses synchronous test bodies + `asyncio.run` for setup because the
repo-wide conftest installs a `pytest_sessionfinish` that
`os._exit`s the runner, which swallows pytest-asyncio fixture
tracebacks and makes async-fixture failures invisible.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from securevector.app.database import connection as db_module  # noqa: E402
from securevector.app.database.connection import DatabaseConnection  # noqa: E402
from securevector.app.database.migrations import run_migrations  # noqa: E402
from securevector.app.database.repositories.settings import (  # noqa: E402
    SettingsRepository,
)
from securevector.app.database.repositories.tool_permissions import (  # noqa: E402
    ToolPermissionsRepository,
)
from securevector.app.server.routes import tool_permissions as routes  # noqa: E402


def _build_app(tmp_path, enforcement_on: bool):
    """Seed a fresh DB with one Bash:block local override and wire it
    to the global singleton the route handler consults. Returns the
    FastAPI app + DB so the caller can shut down."""
    db = DatabaseConnection(tmp_path / "test.db")

    async def _setup():
        await run_migrations(db)
        await ToolPermissionsRepository(db).upsert_override("Bash", "block")
        await SettingsRepository(db).update(tool_permissions_enabled=enforcement_on)

    asyncio.run(_setup())
    db_module._db = db
    app = FastAPI()
    app.include_router(routes.router, prefix="/api")
    return app, db


def _teardown(db):
    asyncio.run(db.disconnect())


def test_synced_overrides_returns_rules_when_enforcement_on(tmp_path):
    app, db = _build_app(tmp_path, enforcement_on=True)
    try:
        with TestClient(app) as client:
            resp = client.get("/api/tool-permissions/synced-overrides")
        assert resp.status_code == 200
        body = resp.json()
        tool_ids = {row["tool_id"] for row in body["synced"]}
        assert "Bash" in tool_ids
        assert body["total"] >= 1
    finally:
        _teardown(db)


def test_synced_overrides_returns_empty_when_enforcement_off(tmp_path):
    """The plugin's fail-open contract treats `{synced: []}` as 'allow
    every tool'. This test pins that the kill-switch produces exactly
    that shape — not a 5xx, not a stripped-rule dict, not a placeholder
    'enforcement_disabled' marker the plugins don't understand."""
    app, db = _build_app(tmp_path, enforcement_on=False)
    try:
        with TestClient(app) as client:
            resp = client.get("/api/tool-permissions/synced-overrides")
        assert resp.status_code == 200
        body = resp.json()
        assert body == {"synced": [], "total": 0}
    finally:
        _teardown(db)


def test_synced_overrides_killswitch_takes_precedence_over_rules(tmp_path):
    """Even with a deny-block rule on Bash present in the DB, the
    response when enforcement is OFF must contain zero entries — no
    leaking the rule through 'source: local' or similar."""
    app, db = _build_app(tmp_path, enforcement_on=False)
    try:
        with TestClient(app) as client:
            resp = client.get("/api/tool-permissions/synced-overrides")
        body = resp.json()
        assert all(row.get("tool_id") != "Bash" for row in body["synced"])
    finally:
        _teardown(db)
