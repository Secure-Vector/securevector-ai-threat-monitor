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
    CODEX_BUILTINS,
    router as tp_router,
)
from tests.fixtures.synced_rules import seed_synced_rules


REPO = Path(__file__).resolve().parents[3]
NORMALIZE_JS = REPO / "src" / "securevector" / "plugins" / "claude-code" / "lib" / "normalize.js"
NORMALIZE_JS_CODEX = REPO / "src" / "securevector" / "plugins" / "codex" / "lib" / "normalize.js"


def _builtins_from_js(path: Path) -> set[str]:
    """Parse a normalize.js' BUILTIN_TOOLS Set declaration to its name list.

    Accepts both CC's PascalCase names (Bash, Read, ...) and Codex's
    snake_case names (exec_command, apply_patch, ...) — pattern is
    permissive on the character class but pinned to the BUILTIN_TOOLS
    block specifically.
    """
    src = path.read_text()
    m = re.search(r"BUILTIN_TOOLS\s*=\s*new\s+Set\(\s*\[(.+?)\]\s*\)", src, re.DOTALL)
    assert m, f"could not locate BUILTIN_TOOLS in {path}"
    return set(re.findall(r"'([A-Za-z_]+)'", m.group(1)))


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
    """Every name in `BUILTIN_TOOLS` (CC normalize.js) has a Python entry
    in CLAUDE_CODE_BUILTINS. Drift between the two SoTs would mean a
    cloud rule silently no-ops in the hook (normalize doesn't return
    the candidate) while the UI happily renders the row."""
    js_names = _builtins_from_js(NORMALIZE_JS)
    py_names = {name for (name, _r, _d) in CLAUDE_CODE_BUILTINS}
    missing_in_py = js_names - py_names
    missing_in_js = py_names - js_names
    assert not missing_in_py, f"Python table missing built-ins present in JS: {missing_in_py}"
    assert not missing_in_js, f"Python table has names absent from JS: {missing_in_js}"


def test_codex_builtins_table_mirrors_codex_normalize_js():
    """Same drift-check for the Codex copy of normalize.js. Codex's
    tool namespace is COMPLETELY DISTINCT from CC's, so the check is
    against `CODEX_BUILTINS` + the Codex plugin's normalize.js."""
    js_names = _builtins_from_js(NORMALIZE_JS_CODEX)
    py_names = {name for (name, _r, _d) in CODEX_BUILTINS}
    missing_in_py = js_names - py_names
    missing_in_js = py_names - js_names
    assert not missing_in_py, (
        f"CODEX_BUILTINS missing built-ins present in Codex normalize.js: {missing_in_py}"
    )
    assert not missing_in_js, (
        f"CODEX_BUILTINS has names absent from Codex normalize.js: {missing_in_js}"
    )


def test_essential_response_includes_24_builtins(client):
    api, _ = client
    resp = api.get("/api/tool-permissions/essential")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    # Key by (tool_id, category) — same tool_id may appear under both
    # claude_code and codex now that both runtimes' built-ins are
    # surfaced as parallel UI rows.
    by_id_cat = {(t["tool_id"], t["category"]): t for t in body["tools"]}
    for name, risk, _desc in CLAUDE_CODE_BUILTINS:
        key = (name, "claude_code")
        assert key in by_id_cat, f"built-in '{name}' missing from essential response"
        row = by_id_cat[key]
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
    bash = next(
        t for t in resp.json()["tools"]
        if t["tool_id"] == "Bash" and t["category"] == "claude_code"
    )

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


def test_builtins_appear_under_codex_category(client):
    """Codex built-ins surface under category=codex EXCEPT names that
    already exist in the YAML registry (which "wins"). Note: Codex's
    hook engine translates `exec_command`/`shell_command` to "Bash" in
    hook stdin (via HookToolName::bash()), so "Bash" appears in both
    CLAUDE_CODE_BUILTINS and CODEX_BUILTINS by design — a single
    synced rule on tool_id="Bash" governs both runtimes."""
    api, _ = client
    body = api.get("/api/tool-permissions/essential").json()

    all_tool_ids_under_any_category = {t["tool_id"] for t in body["tools"]}
    codex_names = {n for (n, _r, _d) in CODEX_BUILTINS}
    # Every Codex name must appear *somewhere* — either as a Codex row
    # or as a registry-claimed row. Anything missing means a synced
    # rule on that name would silently no-op in the UI.
    missing = codex_names - all_tool_ids_under_any_category
    assert not missing, f"Codex built-in names missing from API response entirely: {missing}"

    codex_rows = [t for t in body["tools"] if t["category"] == "codex"]
    for row in codex_rows:
        assert row["provider"] == "Codex", row
        assert row["source"] == "builtin", row
        assert row["default_permission"] == "allow", row

    # Sanity: "Bash" must surface as a codex-category row — it's the
    # canonical hook-payload name for exec_command + shell_command and
    # is the single most important tool to govern on Codex.
    assert any(
        t["tool_id"] == "Bash" and t["category"] == "codex"
        for t in body["tools"]
    ), "Bash must surface as a codex-category row (the hook-payload name for exec_command)"


def test_codex_and_cc_share_bash_via_hook_translation(client):
    """Codex's hook engine translates `exec_command` + `shell_command`
    to hook-payload name "Bash" via HookToolName::bash(). So "Bash"
    intentionally appears in BOTH CLAUDE_CODE_BUILTINS and
    CODEX_BUILTINS — one synced rule on tool_id="Bash" governs both
    runtimes (CC via its native Bash tool, Codex via the translation).

    Pins this invariant so a future refactor can't silently rename
    Codex's Bash entry to `exec_command` and re-break enforcement
    (which is exactly what the v4.4.0 first-pass shipped)."""
    cc_names = {n for (n, _r, _d) in CLAUDE_CODE_BUILTINS}
    codex_names = {n for (n, _r, _d) in CODEX_BUILTINS}

    # Bash MUST appear in both lists — the shared hook-payload name.
    assert "Bash" in cc_names, "CC must include Bash"
    assert "Bash" in codex_names, (
        "Codex must include Bash — it's the hook-payload name for "
        "exec_command + shell_command (HookToolName::bash())"
    )

    # Codex-native names MUST appear in CODEX_BUILTINS — these come
    # through hook stdin as-is (no translation).
    codex_native = {"apply_patch", "update_plan", "view_image",
                    "web_search", "spawn_agent"}
    missing = codex_native - codex_names
    assert not missing, f"CODEX_BUILTINS missing canonical Codex tools: {missing}"

    # The Codex-native names must NOT appear in CC's list. CC's
    # PascalCase namespace stays distinct.
    cc_native_intrusion = codex_native & cc_names
    assert not cc_native_intrusion, (
        f"CC namespace must not contain Codex-native names: {cc_native_intrusion}"
    )


def test_synced_deny_rule_flips_bash_for_codex(client):
    """A cloud rule denying tool_id="Bash" flips BOTH the CC and Codex
    UI rows to deny — proves the shared-payload-name design works.
    Bash is the most load-bearing Codex tool (covers exec_command +
    shell_command via hook translation)."""
    api, db_path = client
    _seed_bash_deny(db_path)

    resp = api.get("/api/tool-permissions/essential")
    assert resp.status_code == 200
    body = resp.json()

    cc_bash = next(
        t for t in body["tools"]
        if t["tool_id"] == "Bash" and t["category"] == "claude_code"
    )
    codex_bash = next(
        t for t in body["tools"]
        if t["tool_id"] == "Bash" and t["category"] == "codex"
    )
    for row in (cc_bash, codex_bash):
        assert row["effective_action"] == "deny", row
        assert row["effective_source"] == "synced", row
        assert row["is_synced"] is True, row
        assert row["synced_policy_name"] == "Test Bash Block", row


def test_registry_tools_still_intact(client):
    """Adding built-ins must not displace registry tools.

    The exact category names aren't pinned — the YAML registry can
    rename categories without breaking this test. The invariant we
    actually care about: CC built-in names never collide with registry
    names (CC's PascalCase namespace is distinct), and the response
    carries a healthy count of non-builtin rows.

    Codex built-in names CAN overlap with registry tool names (Codex
    re-uses `apply_patch` and `web_search` from the OpenClaw vocab),
    and that's by design — the registry wins on collision and the
    underlying synced-rule lookup still covers Codex sessions because
    normalize.js returns the candidate.
    """
    api, _ = client
    body = api.get("/api/tool-permissions/essential").json()
    builtin_categories = {"claude_code", "codex"}
    non_builtin = [t for t in body["tools"] if t["category"] not in builtin_categories]
    assert len(non_builtin) >= 10, (
        f"expected ≥10 registry tools loaded alongside built-ins; got {len(non_builtin)}"
    )
    # CC's PascalCase namespace MUST stay disjoint from the registry.
    cc_names = {n for (n, _r, _d) in CLAUDE_CODE_BUILTINS}
    colliding_cc = [t["tool_id"] for t in non_builtin if t["tool_id"] in cc_names]
    assert not colliding_cc, (
        f"registry tool_ids collide with CC built-in names: {colliding_cc}"
    )


def test_override_endpoints_accept_builtin_tool_ids(client):
    """PUT / DELETE on /overrides/{tool_id} must accept built-in names —
    otherwise every 'Block Bash' click from the UI silently 404s.
    Regression guard for the gap caught in #103 Phase 1 review.
    """
    api, _ = client
    # Block Bash — appears in BOTH CC and Codex built-ins by design
    # (Codex's hook engine translates exec_command/shell_command to
    # "Bash" via HookToolName::bash()). The same override governs
    # both runtimes.
    put = api.put("/api/tool-permissions/overrides/Bash", json={"action": "block"})
    assert put.status_code == 200, put.text

    body = api.get("/api/tool-permissions/essential").json()
    cc_bash = next(
        t for t in body["tools"]
        if t["tool_id"] == "Bash" and t["category"] == "claude_code"
    )
    codex_bash = next(
        t for t in body["tools"]
        if t["tool_id"] == "Bash" and t["category"] == "codex"
    )
    for row in (cc_bash, codex_bash):
        assert row["effective_action"] == "block", row
        assert row["effective_source"] == "local", row
        assert row["has_override"] is True, row

    # Also exercise a Codex-native name (one that does NOT exist in
    # CC's list) — `apply_patch` is Codex's canonical file-mutation
    # tool. Blocking it only affects Codex sessions.
    put_codex = api.put(
        "/api/tool-permissions/overrides/apply_patch", json={"action": "block"},
    )
    assert put_codex.status_code == 200, put_codex.text

    # Reset both
    api.delete("/api/tool-permissions/overrides/Bash")
    api.delete("/api/tool-permissions/overrides/apply_patch")

    body = api.get("/api/tool-permissions/essential").json()
    cc_bash = next(
        t for t in body["tools"]
        if t["tool_id"] == "Bash" and t["category"] == "claude_code"
    )
    assert cc_bash["effective_action"] == "allow", cc_bash
    assert cc_bash["effective_source"] == "default", cc_bash
    assert cc_bash["has_override"] is False, cc_bash


def test_override_endpoint_still_rejects_unknown_ids(client):
    """The widened guard must NOT accept arbitrary strings — only
    registry tools + the canonical built-ins list."""
    api, _ = client
    resp = api.put(
        "/api/tool-permissions/overrides/NotARealTool",
        json={"action": "block"},
    )
    assert resp.status_code == 404, resp.text
