"""End-to-end integration test for the SecureVector Guard plugin (Codex).

Mirror of ``test_claude_code_plugin_e2e.py`` but exercises the Codex copy
of the plugin under ``src/securevector/plugins/codex/``. The two plugin
trees share their `lib/` modules verbatim and their hook stdin/stdout
contracts are identical — Codex's hook engine re-uses Claude Code's
event names and `${CLAUDE_PLUGIN_ROOT}` env var (verified empirically
against `openai/codex` source at the time of v4.4.0). The one wire-level
difference this test pins is `runtime_kind="codex"` on the audit row.

Scenarios covered:

  1. Deny path: synced rule with ``effect=deny`` → pre-hook emits
     ``permissionDecision=deny``.
  2. Allow path (no rule).
  3. Allow path (explicit allow rule).
  4. Fail-open when local app unreachable.
  5. PostToolUse audit row stamped with ``runtime_kind=codex``.
  6. Built-in tool short-circuit.

Marked ``integration`` so the default ``-m "not integration"`` unit run
skips this — it needs ``node`` on PATH and starts a real uvicorn server.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional

import pytest

# Module-level marks — see the Claude Code copy for full rationale on
# why `lifespan="off"` + ResourceWarning suppression is load-bearing.
pytestmark = [
    pytest.mark.integration,
    pytest.mark.filterwarnings("ignore::ResourceWarning"),
]


REPO = Path(__file__).resolve().parents[2]
PLUGIN_DIR = REPO / "src" / "securevector" / "plugins" / "codex"
PRE_HOOK = PLUGIN_DIR / "hooks" / "pre-tool-use.js"
POST_HOOK = PLUGIN_DIR / "hooks" / "post-tool-use.js"
SESSION_START_HOOK = PLUGIN_DIR / "hooks" / "session-start.js"
STOP_HOOK = PLUGIN_DIR / "hooks" / "stop.js"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_port(port: int, timeout: float = 5.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return True
        except OSError:
            time.sleep(0.05)
    return False


@pytest.fixture(scope="module")
def live_server(tmp_path_factory):
    if shutil.which("node") is None:
        pytest.skip("node required for plugin e2e tests")
    if not PRE_HOOK.is_file() or not POST_HOOK.is_file():
        pytest.skip(f"plugin hooks not found under {PLUGIN_DIR}")

    tmp_dir = tmp_path_factory.mktemp("codex_plugin_e2e")
    db_path = tmp_dir / "test.db"

    from securevector.app.database import connection as conn_mod
    from securevector.app.database.connection import DatabaseConnection
    from securevector.app.database.migrations import run_migrations

    original_db = conn_mod._db

    pre_db = DatabaseConnection(db_path)
    asyncio.run(run_migrations(pre_db))
    asyncio.run(pre_db.disconnect())

    conn_mod._db = pre_db

    port = _free_port()

    from securevector.app.server.app import create_app
    import uvicorn

    app = create_app(host="127.0.0.1", port=port)
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        lifespan="off",
    )
    server = uvicorn.Server(config)

    def _run() -> None:
        asyncio.run(server.serve())

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()

    if not _wait_for_port(port, timeout=5.0):
        pytest.fail(f"uvicorn did not bind 127.0.0.1:{port} in 5s")

    base_url = f"http://127.0.0.1:{port}"

    # Warm-up: see Claude Code copy for the cold-start aiosqlite race.
    import urllib.request

    warm_deadline = time.time() + 5.0
    while time.time() < warm_deadline:
        try:
            with urllib.request.urlopen(
                f"{base_url}/api/tool-permissions/synced-overrides", timeout=2.0
            ) as r:
                if 200 <= r.status < 300:
                    break
        except Exception:
            time.sleep(0.05)
    else:
        pytest.fail("server did not answer warm-up GET in 5s")

    try:
        yield {"base_url": base_url, "db_path": db_path, "port": port}
    finally:
        server.should_exit = True
        thread.join(timeout=3.0)
        try:
            asyncio.run(pre_db.disconnect())
        except Exception:
            pass
        conn_mod._db = original_db


def _seed_deny_rule(db_path: Path, tool_id: str, reason: str = "policy says no") -> None:
    from securevector.app.database.connection import DatabaseConnection
    from securevector.app.database.repositories.synced_rules import (
        SyncedRulesRepository,
    )
    from tests.fixtures.synced_rules import seed_synced_rules

    async def _go():
        db = DatabaseConnection(db_path)
        try:
            repo = SyncedRulesRepository(db)
            await seed_synced_rules(
                repo,
                [{"tool_id": tool_id, "effect": "deny", "reason": reason}],
            )
        finally:
            await db.disconnect()

    asyncio.run(_go())


def _seed_allow_rule(db_path: Path, tool_id: str) -> None:
    from securevector.app.database.connection import DatabaseConnection
    from securevector.app.database.repositories.synced_rules import (
        SyncedRulesRepository,
    )
    from tests.fixtures.synced_rules import seed_synced_rules

    async def _go():
        db = DatabaseConnection(db_path)
        try:
            repo = SyncedRulesRepository(db)
            await seed_synced_rules(
                repo,
                [{"tool_id": tool_id, "effect": "allow"}],
            )
        finally:
            await db.disconnect()

    asyncio.run(_go())


def _wipe_rules(db_path: Path) -> None:
    from securevector.app.database.connection import DatabaseConnection
    from securevector.app.database.repositories.synced_rules import (
        SyncedRulesRepository,
    )
    from tests.fixtures.synced_rules import seed_synced_rules

    async def _go():
        db = DatabaseConnection(db_path)
        try:
            repo = SyncedRulesRepository(db)
            await seed_synced_rules(repo, [])
        finally:
            await db.disconnect()

    asyncio.run(_go())


def _run_hook(
    hook_path: Path, event: dict, base_url: str, timeout: float = 5.0
) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["node", str(hook_path)],
        input=json.dumps(event),
        env={**os.environ, "SV_BASE_URL": base_url},
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _hook_decision(stdout: str) -> Optional[str]:
    """Return the hook's permissionDecision verbatim. For Codex's implicit
    allow path the field is intentionally absent — caller should compare
    via :func:`_hook_allowed` rather than expecting the literal "allow"."""
    if not stdout.strip():
        return None
    parsed = json.loads(stdout)
    return parsed.get("hookSpecificOutput", {}).get("permissionDecision")


def _hook_allowed(stdout: str) -> bool:
    """True iff the hook output expresses Codex's implicit allow contract:
    a parseable `hookSpecificOutput` block whose `permissionDecision`
    field is absent. Codex rejects bare `permissionDecision: "allow"`
    with `unsupported permissionDecision:allow` (verified empirically
    against `codex-rs/hooks/src/engine/output_parser.rs`), so the wire
    shape for allow is the absence of the field — NOT the literal
    string "allow". A missing `hookSpecificOutput` or stdout that fails
    to parse is treated as not-allowed so a malformed hook can't slip
    through as an unintended allow."""
    if not stdout.strip():
        return False
    try:
        parsed = json.loads(stdout)
    except json.JSONDecodeError:
        return False
    hso = parsed.get("hookSpecificOutput")
    if not isinstance(hso, dict):
        return False
    return "permissionDecision" not in hso


# ─────────────────────────────────────────────────────────────────────────────
# PreToolUse scenarios
# ─────────────────────────────────────────────────────────────────────────────


def test_pretooluse_denies_when_synced_rule_says_deny(live_server):
    _seed_deny_rule(live_server["db_path"], tool_id="server-x:t1")

    proc = _run_hook(
        PRE_HOOK,
        {"tool_name": "mcp__server-x__t1", "tool_input": {"q": "x"}},
        live_server["base_url"],
    )

    assert proc.returncode == 0, proc.stderr
    assert _hook_decision(proc.stdout) == "deny"


def test_pretooluse_allows_when_no_matching_rule(live_server):
    _wipe_rules(live_server["db_path"])

    proc = _run_hook(
        PRE_HOOK,
        {"tool_name": "mcp__server-x__unmatched", "tool_input": {}},
        live_server["base_url"],
    )

    assert proc.returncode == 0, proc.stderr
    # Codex's implicit-allow contract: permissionDecision is absent.
    assert _hook_allowed(proc.stdout), proc.stdout


def test_pretooluse_allows_when_synced_rule_says_allow(live_server):
    _seed_allow_rule(live_server["db_path"], tool_id="server-x:t1")

    proc = _run_hook(
        PRE_HOOK,
        {"tool_name": "mcp__server-x__t1", "tool_input": {}},
        live_server["base_url"],
    )

    assert proc.returncode == 0, proc.stderr
    assert _hook_allowed(proc.stdout), proc.stdout


def test_pretooluse_fails_open_when_local_app_unreachable(live_server):
    """Locked decision #5 — the plugin must never break the host CLI."""
    dead_url = "http://127.0.0.1:1"
    proc = _run_hook(
        PRE_HOOK,
        {"tool_name": "mcp__server-x__t1", "tool_input": {}},
        dead_url,
        timeout=3.0,
    )

    assert proc.returncode == 0, proc.stderr
    assert _hook_allowed(proc.stdout), proc.stdout


def test_pretooluse_short_circuits_for_builtin_tools(live_server):
    dead_url = "http://127.0.0.1:1"
    proc = _run_hook(
        PRE_HOOK,
        {"tool_name": "Bash", "tool_input": {"command": "ls"}},
        dead_url,
        timeout=3.0,
    )

    assert proc.returncode == 0, proc.stderr
    assert _hook_allowed(proc.stdout), proc.stdout


# ─────────────────────────────────────────────────────────────────────────────
# PostToolUse audit
# ─────────────────────────────────────────────────────────────────────────────


def _audit_rows_for(db_path: Path) -> list:
    import sqlite3

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        cur = conn.execute(
            "SELECT tool_id, function_name, action, runtime_kind FROM tool_call_audit "
            "ORDER BY id DESC"
        )
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


def test_posttooluse_writes_audit_row_with_runtime_kind_codex(live_server):
    """The single load-bearing wire-level distinction from the CC plugin:
    the audit row Codex's PostToolUse stamps must carry
    ``runtime_kind=codex``. SIEM filters, Tool Activity views, and any
    future per-agent dashboards pivot on this column."""
    _seed_deny_rule(live_server["db_path"], tool_id="server-x:t1", reason="audit test")

    before = _audit_rows_for(live_server["db_path"])

    proc = _run_hook(
        POST_HOOK,
        {"tool_name": "mcp__server-x__t1", "tool_input": {"q": "hi"}},
        live_server["base_url"],
    )
    assert proc.returncode == 0, proc.stderr

    deadline = time.time() + 3.0
    rows: list = []
    while time.time() < deadline:
        rows = _audit_rows_for(live_server["db_path"])
        if len(rows) > len(before):
            break
        time.sleep(0.05)

    assert len(rows) > len(before), (
        f"audit row never landed (before={len(before)}, after={len(rows)})"
    )
    new_row = rows[0]
    assert new_row["runtime_kind"] == "codex", new_row
    assert new_row["tool_id"] == "server-x:t1", new_row
    assert new_row["function_name"] == "mcp__server-x__t1", new_row


# ─────────────────────────────────────────────────────────────────────────────
# Session lifecycle hooks (SessionStart / Stop) — added in v4.4.0
# ─────────────────────────────────────────────────────────────────────────────


def test_session_start_writes_audit_row_with_session_sentinel(live_server):
    """SessionStart hook fires once at Codex session open. Writes a
    `__session_start__` audit row tagged action=log_only,
    runtime_kind=codex, with a branded SecureVector Guard reason —
    forensic timelines pivot on this sentinel to find clean session
    boundaries. Locked decision: action MUST be `log_only` (the
    call-audit endpoint validates against ^(block|allow|log_only)$);
    lifecycle semantics live in `function_name`, not `action`."""
    if not SESSION_START_HOOK.is_file():
        pytest.skip(f"session-start.js not present at {SESSION_START_HOOK}")

    before = _audit_rows_for(live_server["db_path"])

    proc = _run_hook(
        SESSION_START_HOOK,
        {"session_id": "test-session-abc-123"},
        live_server["base_url"],
    )
    assert proc.returncode == 0, proc.stderr

    # session-start.js fires the audit POST as fire-and-forget; poll.
    deadline = time.time() + 3.0
    rows: list = []
    while time.time() < deadline:
        rows = _audit_rows_for(live_server["db_path"])
        if len(rows) > len(before):
            break
        time.sleep(0.05)

    assert len(rows) > len(before), (
        f"session_start audit row never landed (before={len(before)}, after={len(rows)})"
    )
    new_row = rows[0]
    assert new_row["runtime_kind"] == "codex", new_row
    assert new_row["function_name"] == "__session_start__", new_row
    assert new_row["tool_id"] == "__session_start__", new_row
    # action MUST be a value the backend accepts; log_only is the
    # semantically-nearest "informational, no enforcement" sentinel.
    assert new_row["action"] == "log_only", new_row

    # Stdout must be Codex's implicit-allow shape for SessionStart —
    # `hookSpecificOutput` present with no `permissionDecision` /
    # `additionalContext` keys. additionalContext is deliberately
    # omitted so SecureVector text doesn't leak into the model's
    # context window every session.
    parsed = json.loads(proc.stdout) if proc.stdout.strip() else {}
    hso = parsed.get("hookSpecificOutput", {})
    assert hso.get("hookEventName") == "SessionStart", parsed
    assert "permissionDecision" not in hso, parsed
    assert "additionalContext" not in hso, parsed


def test_stop_writes_session_end_audit_row(live_server):
    """Stop hook fires at Codex turn/session boundaries. Writes a
    `__session_end__` audit row with action=log_only and the branded
    reason. Note: Codex's Stop may fire per-turn rather than only at
    session close — this test pins the per-fire behaviour; clients
    reconstruct true sessions by adjacency to the matching
    `__session_start__` row, not by counting Stop fires."""
    if not STOP_HOOK.is_file():
        pytest.skip(f"stop.js not present at {STOP_HOOK}")

    before = _audit_rows_for(live_server["db_path"])

    proc = _run_hook(
        STOP_HOOK,
        {"session_id": "test-session-abc-123"},
        live_server["base_url"],
    )
    assert proc.returncode == 0, proc.stderr

    deadline = time.time() + 3.0
    rows: list = []
    while time.time() < deadline:
        rows = _audit_rows_for(live_server["db_path"])
        if len(rows) > len(before):
            break
        time.sleep(0.05)

    assert len(rows) > len(before), (
        f"session_end audit row never landed (before={len(before)}, after={len(rows)})"
    )
    new_row = rows[0]
    assert new_row["runtime_kind"] == "codex", new_row
    assert new_row["function_name"] == "__session_end__", new_row
    assert new_row["tool_id"] == "__session_end__", new_row
    assert new_row["action"] == "log_only", new_row

    # Codex's `stop.command.output` schema is `additionalProperties: false`
    # and defines NO `hookSpecificOutput` field (unlike PreToolUse /
    # SessionStart). Emitting one is rejected at runtime with "hook
    # returned invalid stop hook JSON output". The valid proceed signal
    # is an empty object — assert we emit exactly that and never leak a
    # hookSpecificOutput key back in.
    parsed = json.loads(proc.stdout) if proc.stdout.strip() else {}
    assert "hookSpecificOutput" not in parsed, parsed
    assert parsed == {}, parsed
