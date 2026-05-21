"""End-to-end integration test for the SecureVector Guard plugin.

Drives the canonical Claude Code plugin entry points (``hooks/pre-tool-use.js``
and ``hooks/post-tool-use.js``) via subprocess against a real FastAPI server
listening on a real TCP port, with an isolated tmp-path SQLite DB. This is
the full wire-level path a Claude Code session takes — the unit tests
exercise the pure-logic layer; this test exists to catch any regression in
the bridge between the host's stdin/stdout contract, the JS hooks, and the
local app's REST API.

Scenarios covered (mapping to Task 15 DoD):

  1. Deny path: synced rule with ``effect=deny`` → pre-hook emits
     ``permissionDecision=deny``.
  2. Allow path (no rule): unmatched tool → pre-hook emits
     ``permissionDecision=allow``.
  3. Allow path (allow rule): rule with ``effect=allow`` → pre-hook emits
     ``permissionDecision=allow``.
  4. Fail-open: hook configured to point at a closed port → pre-hook emits
     ``permissionDecision=allow`` (locked decision #5 — never break the host).
  5. PostToolUse audit: post-hook POST lands an audit row with
     ``runtime_kind=claude-code``.
  6. Built-in tool short-circuit: ``tool_name=Bash`` returns allow without
     contacting the server (verified by pointing at dead port).

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

# Module-level marks:
#   * integration — keeps the default `-m "not integration"` unit run skipping
#     this file (it starts a real uvicorn server + spawns node subprocesses).
#   * filterwarnings ignore::ResourceWarning — `lifespan="off"` skips the
#     FastAPI shutdown that would have closed the aiosqlite handle uvicorn's
#     loop opened. We try to close it ourselves in the fixture finally, but
#     on Python 3.9 cross-`asyncio.run()` lock-affinity can prevent the close
#     from succeeding (the bare `except` catches that RuntimeError). The
#     ResourceWarning that CPython then fires on GC would otherwise be
#     escalated to a test failure by `pyproject.toml`'s
#     `filterwarnings = ["error", ...]`. The leaked handle is bounded by the
#     test process lifetime.
pytestmark = [
    pytest.mark.integration,
    pytest.mark.filterwarnings("ignore::ResourceWarning"),
]


REPO = Path(__file__).resolve().parents[2]
PLUGIN_DIR = REPO / "src" / "securevector" / "plugins" / "claude-code"
PRE_HOOK = PLUGIN_DIR / "hooks" / "pre-tool-use.js"
POST_HOOK = PLUGIN_DIR / "hooks" / "post-tool-use.js"


def _free_port() -> int:
    """Pick a free TCP port on 127.0.0.1 by binding+closing a socket."""
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
    """Spin up a uvicorn server on a free port with an isolated tmp DB.

    Skips the whole module if ``node`` is not on PATH (the e2e test would
    have nothing to drive the hooks with).
    """
    if shutil.which("node") is None:
        pytest.skip("node required for plugin e2e tests")
    if not PRE_HOOK.is_file() or not POST_HOOK.is_file():
        pytest.skip(f"plugin hooks not found under {PLUGIN_DIR}")

    tmp_dir = tmp_path_factory.mktemp("guard_plugin_e2e")
    db_path = tmp_dir / "test.db"

    from securevector.app.database import connection as conn_mod
    from securevector.app.database.connection import DatabaseConnection
    from securevector.app.database.migrations import run_migrations

    original_db = conn_mod._db

    # Pre-create + migrate on the test loop. The server reads the singleton
    # via `connection.get_database()`, so pre-setting `_db` to our
    # tmp-path-pinned DatabaseConnection guarantees the server hits the
    # SAME file we seeded — without it, `connection.py`'s already-imported
    # `get_database_path` symbol would still point at the production path.
    pre_db = DatabaseConnection(db_path)
    asyncio.run(run_migrations(pre_db))
    asyncio.run(pre_db.disconnect())

    # Hand off: drop the connection but keep the path-pinned instance so
    # uvicorn's loop opens a fresh aiosqlite handle bound to its own loop.
    conn_mod._db = pre_db

    port = _free_port()

    from securevector.app.server.app import create_app
    import uvicorn

    app = create_app(host="127.0.0.1", port=port)
    # `lifespan="off"` keeps the test fast and skips proxy / cloud-sync /
    # external-forwarder startup — none of which the e2e plugin path needs.
    # Migrations were pre-applied above; the routes will lazy-init the
    # singleton against our tmp DB on first request.
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

    # Warm-up: open-port readiness does NOT mean the FastAPI handler has
    # lazy-inited its aiosqlite connection. The hook's GET runs against a
    # 100 ms client-side timeout (lib/client.js) — if the first server
    # request lands while the WAL pragmas + schema reads are still
    # happening on uvicorn's loop, the hook times out, fail-opens to
    # allow, and the deny test flakes. One synchronous warm-up forces the
    # cold path to complete here, where we can afford the latency.
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
        # Explicitly close the aiosqlite handle uvicorn's loop opened.
        # Without this, GC fires ResourceWarning on the unclosed
        # connection, which `pyproject.toml`'s filterwarnings=["error"]
        # escalates to a session failure.
        try:
            asyncio.run(pre_db.disconnect())
        except Exception:
            pass
        # Restore the original singleton so other tests in the same process
        # aren't affected by our handoff.
        conn_mod._db = original_db


def _seed_deny_rule(db_path: Path, tool_id: str, reason: str = "policy says no") -> None:
    """Seed one deny rule using the Task 14 helper. Wipes the table."""
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
    """Run a hook with `event` as stdin JSON. Returns the completed process."""
    return subprocess.run(
        ["node", str(hook_path)],
        input=json.dumps(event),
        env={**os.environ, "SV_BASE_URL": base_url},
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _hook_decision(stdout: str) -> Optional[str]:
    """Parse PreToolUse output JSON, return permissionDecision or None."""
    if not stdout.strip():
        return None
    parsed = json.loads(stdout)
    return parsed.get("hookSpecificOutput", {}).get("permissionDecision")


# ─────────────────────────────────────────────────────────────────────────────
# PreToolUse scenarios
# ─────────────────────────────────────────────────────────────────────────────


def test_pretooluse_denies_when_synced_rule_says_deny(live_server):
    """Deny path: synced rule with effect=deny → permissionDecision=deny."""
    _seed_deny_rule(live_server["db_path"], tool_id="server-x:t1")

    proc = _run_hook(
        PRE_HOOK,
        {"tool_name": "mcp__server-x__t1", "tool_input": {"q": "x"}},
        live_server["base_url"],
    )

    assert proc.returncode == 0, proc.stderr
    assert _hook_decision(proc.stdout) == "deny"


def test_pretooluse_allows_when_no_matching_rule(live_server):
    """Allow path (no rule): unmatched tool → permissionDecision=allow."""
    _wipe_rules(live_server["db_path"])

    proc = _run_hook(
        PRE_HOOK,
        {"tool_name": "mcp__server-x__unmatched", "tool_input": {}},
        live_server["base_url"],
    )

    assert proc.returncode == 0, proc.stderr
    assert _hook_decision(proc.stdout) == "allow"


def test_pretooluse_allows_when_synced_rule_says_allow(live_server):
    """Allow path (allow rule): rule with effect=allow → permissionDecision=allow.

    Explicit allow at the policy layer is the documented `effect=allow` —
    not the absence of a rule. The wire output is the same as the no-match
    path (Claude Code treats allow as the implicit default), so we
    distinguish them via the deny test above and the audit row content."""
    _seed_allow_rule(live_server["db_path"], tool_id="server-x:t1")

    proc = _run_hook(
        PRE_HOOK,
        {"tool_name": "mcp__server-x__t1", "tool_input": {}},
        live_server["base_url"],
    )

    assert proc.returncode == 0, proc.stderr
    assert _hook_decision(proc.stdout) == "allow"


def test_pretooluse_fails_open_when_local_app_unreachable(live_server):
    """Fail-open: hook configured to point at a closed port → allow.

    The plugin MUST never block the host CLI on local-app unavailability
    (locked decision #5). We use port 1 which is reserved + universally
    closed."""
    dead_url = "http://127.0.0.1:1"
    proc = _run_hook(
        PRE_HOOK,
        {"tool_name": "mcp__server-x__t1", "tool_input": {}},
        dead_url,
        timeout=3.0,
    )

    assert proc.returncode == 0, proc.stderr
    assert _hook_decision(proc.stdout) == "allow"


def test_pretooluse_short_circuits_for_builtin_tools(live_server):
    """Built-in tool (Bash / Edit / Read / etc.): the hook never contacts
    the local app — pointing at a dead port should still yield allow
    promptly."""
    dead_url = "http://127.0.0.1:1"
    proc = _run_hook(
        PRE_HOOK,
        {"tool_name": "Bash", "tool_input": {"command": "ls"}},
        dead_url,
        timeout=3.0,
    )

    assert proc.returncode == 0, proc.stderr
    assert _hook_decision(proc.stdout) == "allow"


# ─────────────────────────────────────────────────────────────────────────────
# PostToolUse audit
# ─────────────────────────────────────────────────────────────────────────────


def _audit_rows_for(db_path: Path) -> list:
    """Direct DB read of the audit log — bypasses the API to keep the
    assertion close to the source-of-truth (the row that actually
    persisted)."""
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


def test_posttooluse_writes_audit_row_with_runtime_kind_claude_code(live_server):
    """PostToolUse audit: post-hook fire-and-forget POST results in an
    audit row that carries `runtime_kind=claude-code`."""
    _seed_deny_rule(live_server["db_path"], tool_id="server-x:t1", reason="audit test")

    before = _audit_rows_for(live_server["db_path"])

    proc = _run_hook(
        POST_HOOK,
        {"tool_name": "mcp__server-x__t1", "tool_input": {"q": "hi"}},
        live_server["base_url"],
    )
    assert proc.returncode == 0, proc.stderr

    # The post-hook is fire-and-forget — it can return before the local
    # app finishes persisting. Poll briefly for the new row.
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
    assert new_row["runtime_kind"] == "claude-code", new_row
    assert new_row["tool_id"] == "server-x:t1", new_row
    assert new_row["function_name"] == "mcp__server-x__t1", new_row
