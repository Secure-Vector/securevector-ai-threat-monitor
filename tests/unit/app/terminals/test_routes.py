import asyncio
import stat
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.terminals import routes
from securevector.app.terminals.auth import HEADER, TerminalAuth
from securevector.app.terminals.executors import ExecutorUnavailable
from securevector.app.terminals.manager import ManagerSettings, TerminalManager
from securevector.app.terminals.store import TerminalStore
from tests.unit.app.terminals.test_manager import FakeHost

ORIGIN = "http://127.0.0.1:8741"
# Every authenticated route (read or write) requires the custom header; only
# state-changing routes additionally require Origin. Sending both covers
# both cases, matching what a real browser request from the app's own UI
# would carry.
AUTH = {HEADER: "1", "Origin": ORIGIN}


def _fake_claude_bin(tmp_path: Path) -> Path:
    # build_launch (executors.py) resolves the executor binary to an
    # absolute path via shutil.which and raises ExecutorUnavailable if
    # "claude" is not on the child PATH, so tests need a real, executable
    # stub on disk rather than a bare "claude" string on the PATH.
    tmp_bin = tmp_path / "bin"
    tmp_bin.mkdir(exist_ok=True)
    fake_claude = tmp_bin / "claude"
    fake_claude.write_text("#!/bin/sh\nexit 0\n")
    fake_claude.chmod(fake_claude.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return tmp_bin


@pytest.fixture
def env(tmp_path):
    ws = tmp_path / "proj"
    ws.mkdir()
    db = DatabaseConnection(tmp_path / "t.db")
    asyncio.run(run_migrations(db))
    store = TerminalStore(db)
    tmp_bin = _fake_claude_bin(tmp_path)
    manager = TerminalManager(
        FakeHost(),
        store,
        ManagerSettings(
            data_dir=tmp_path / "data",
            port=8741,
            plugin_dir=lambda: tmp_path / "plugin",
            plugin_enabled=lambda: True,
            parent_env={"PATH": str(tmp_bin)},
        ),
    )
    app = FastAPI()
    app.state.terminal_auth = TerminalAuth(token="t" * 48, port=8741)
    app.state.terminal_manager = manager
    app.include_router(routes.router, prefix="/api")
    client = TestClient(app, base_url=ORIGIN)
    client.get("/api/terminals/session")
    # Bind the manager to the TestClient's loop via a request-time hook.
    return client, manager, str(ws), db


def test_executors_list_includes_governed_harnesses(env):
    client, *_ = env
    r = client.get("/api/terminals/executors", headers=AUTH)
    assert r.status_code == 200
    items = r.json()["items"]
    assert [i["id"] for i in items] == ["claude-code", "codex", "copilot-cli", "opencode"]
    assert items[0]["label"] == "Claude Code" and items[1]["label"] == "Codex"
    for item in items:
        assert set(item) == {"id", "label", "installed", "governed", "supports_resume", "hint"}
        assert isinstance(item["installed"], bool)
        assert isinstance(item["governed"], bool)
        assert isinstance(item["supports_resume"], bool)
        assert isinstance(item["hint"], str)
    # The fixture installs the Claude Code Guard plugin and a `claude` stub.
    assert items[0]["installed"] is True and items[0]["governed"] is True
    # OpenCode's --continue reopens the most recent session, not a named one,
    # so the UI must never offer to continue a specific session with it.
    assert [i["id"] for i in items if i["supports_resume"]] == [
        "claude-code",
        "codex",
        "copilot-cli",
    ]


def test_executors_list_without_ui_header_is_forbidden(env):
    client, *_ = env
    r = client.get("/api/terminals/executors")
    assert r.status_code == 403


def test_spawn_list_stop(env):
    client, manager, ws, _ = env
    r = client.post(
        "/api/terminals/tasks",
        json={"executor_id": "claude-code", "workspace": ws, "title": "T"},
        headers=AUTH,
    )
    assert r.status_code == 201, r.text
    task = r.json()
    assert task["status"] == "starting" and task["workspace"] == ws
    r = client.get("/api/terminals/tasks", headers=AUTH)
    assert [t["id"] for t in r.json()["items"]] == [task["id"]]
    assert r.json()["running"] == 1
    r = client.post(f"/api/terminals/tasks/{task['id']}/stop", headers=AUTH)
    assert r.status_code == 200
    r = client.get(f"/api/terminals/tasks/{task['id']}/events", headers=AUTH)
    assert [e["kind"] for e in r.json()["items"]][:2] == ["spawn", "stop"]


def test_task_rows_carry_a_branch_key(env):
    client, _, ws, _ = env
    r = client.post(
        "/api/terminals/tasks",
        json={"executor_id": "claude-code", "workspace": ws},
        headers=AUTH,
    )
    assert r.status_code == 201, r.text
    task_id = r.json()["id"]
    # The fixture workspace is a plain tmp folder, not a checkout, so the
    # branch is present but null rather than absent.
    items = client.get("/api/terminals/tasks", headers=AUTH).json()["items"]
    assert [t["branch"] for t in items] == [None]
    assert client.get(f"/api/terminals/tasks/{task_id}", headers=AUTH).json()["branch"] is None


def test_task_rows_carry_governed_at_launch(env):
    client, manager, ws, _ = env
    governed_id = client.post(
        "/api/terminals/tasks",
        json={"executor_id": "claude-code", "workspace": ws},
        headers=AUTH,
    ).json()["id"]
    # Same manager, Guard plugin now gone: the next launch is ungoverned.
    manager.settings.plugin_dir = lambda: None
    r = client.post(
        "/api/terminals/tasks",
        json={"executor_id": "claude-code", "workspace": ws},
        headers=AUTH,
    )
    assert r.status_code == 201, r.text
    ungoverned_id = r.json()["id"]

    rows = {t["id"]: t for t in client.get("/api/terminals/tasks", headers=AUTH).json()["items"]}
    assert rows[governed_id]["governed_at_launch"] is True
    assert rows[ungoverned_id]["governed_at_launch"] is False
    one = client.get(f"/api/terminals/tasks/{ungoverned_id}", headers=AUTH).json()
    assert one["governed_at_launch"] is False

    # The in-memory set is not the only source: a restart-equivalent clear
    # still reads the ungoverned launch off the audit trail.
    manager.ungoverned_ids().clear()
    rows = {t["id"]: t for t in client.get("/api/terminals/tasks", headers=AUTH).json()["items"]}
    assert rows[ungoverned_id]["governed_at_launch"] is False
    assert rows[governed_id]["governed_at_launch"] is True


def test_a_finished_ungoverned_task_still_reports_governed_at_launch_false(env):
    client, manager, ws, _ = env
    manager.settings.plugin_dir = lambda: None
    task_id = client.post(
        "/api/terminals/tasks",
        json={"executor_id": "claude-code", "workspace": ws},
        headers=AUTH,
    ).json()["id"]
    # The harness exits: the task is finished, but how it launched does not change.
    asyncio.run(manager.store.set_exit(task_id, 0))

    row = client.get(f"/api/terminals/tasks/{task_id}", headers=AUTH).json()
    assert row["status"] == "done"
    assert row["governed_at_launch"] is False

    # Same answer after a restart, when the in-memory set is empty.
    manager.ungoverned_ids().clear()
    row = client.get(f"/api/terminals/tasks/{task_id}", headers=AUTH).json()
    assert row["governed_at_launch"] is False
    items = {t["id"]: t for t in client.get("/api/terminals/tasks", headers=AUTH).json()["items"]}
    assert items[task_id]["governed_at_launch"] is False


def test_task_rows_report_the_workspace_branch(env):
    client, _, ws, _ = env
    git = Path(ws) / ".git"
    git.mkdir()
    (git / "HEAD").write_text("ref: refs/heads/feat/x\n", encoding="utf-8")
    r = client.post(
        "/api/terminals/tasks",
        json={"executor_id": "claude-code", "workspace": ws},
        headers=AUTH,
    )
    assert r.status_code == 201, r.text
    task_id = r.json()["id"]
    items = client.get("/api/terminals/tasks", headers=AUTH).json()["items"]
    assert [t["branch"] for t in items] == ["feat/x"]
    assert client.get(f"/api/terminals/tasks/{task_id}", headers=AUTH).json()["branch"] == "feat/x"


def test_spawn_rejects_client_supplied_argv_or_env(env):
    client, _, ws, _ = env
    for extra in ({"argv": ["bash"]}, {"env": {"X": "1"}}, {"command": "rm -rf /"}):
        r = client.post(
            "/api/terminals/tasks",
            json={"executor_id": "claude-code", "workspace": ws, **extra},
            headers=AUTH,
        )
        assert r.status_code == 422, extra


def test_spawn_rejects_unknown_executor_and_bad_workspace(env):
    client, _, ws, _ = env
    r = client.post(
        "/api/terminals/tasks", json={"executor_id": "bash", "workspace": ws}, headers=AUTH
    )
    assert r.status_code == 400
    r = client.post(
        "/api/terminals/tasks",
        json={"executor_id": "claude-code", "workspace": ws + "/nope"},
        headers=AUTH,
    )
    assert r.status_code == 400


def test_spawn_without_guard_hooks_succeeds_and_is_audited(env):
    client, manager, ws, _ = env
    manager.settings.plugin_dir = lambda: None
    r = client.post(
        "/api/terminals/tasks", json={"executor_id": "claude-code", "workspace": ws}, headers=AUTH
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["governed_at_launch"] is False
    events = client.get(
        f"/api/terminals/tasks/{body['id']}/events", headers=AUTH
    ).json()["items"]
    assert [e["detail"] for e in events if e["kind"] == "guard_missing"]


def test_spawn_without_ui_auth_is_forbidden(env):
    client, _, ws, _ = env
    r = client.post("/api/terminals/tasks", json={"executor_id": "claude-code", "workspace": ws})
    assert r.status_code == 403


def test_read_route_without_ui_header_is_forbidden(env):
    client, *_ = env
    # A stray Origin/cookie is not enough; the custom header must be present
    # on every authenticated route, reads included.
    r = client.get("/api/terminals/tasks")
    assert r.status_code == 403


def test_events_for_unknown_task_is_404(env):
    client, *_ = env
    r = client.get("/api/terminals/tasks/does-not-exist/events", headers=AUTH)
    assert r.status_code == 404


def test_hook_events_endpoint_uses_per_task_token_not_cookie(env):
    client, manager, ws, _ = env
    task = client.post(
        "/api/terminals/tasks", json={"executor_id": "claude-code", "workspace": ws}, headers=AUTH
    ).json()
    token = manager.hook_token(task["id"])
    bare = TestClient(
        client.app, base_url=ORIGIN
    )  # no cookie, no Origin: this is how the hook calls
    r = bare.post(
        f"/api/terminals/tasks/{task['id']}/events",
        json={"hook_event_name": "Stop"},
        headers={"X-SV-Terminal-Hook": token},
    )
    assert r.status_code == 204
    assert client.get(f"/api/terminals/tasks/{task['id']}", headers=AUTH).json()["status"] == "idle"
    r = bare.post(
        f"/api/terminals/tasks/{task['id']}/events",
        json={"hook_event_name": "Stop"},
        headers={"X-SV-Terminal-Hook": "wrong"},
    )
    assert r.status_code == 403


def test_hook_events_non_ascii_token_is_403_not_500(env):
    """Starlette decodes headers as latin-1, so a non-ASCII token would raise
    TypeError inside secrets.compare_digest on two mismatched str/bytes types
    if the route didn't encode both sides first. Should be a 403, not a 500.

    httpx's TestClient refuses to send a plain str header value containing
    non-ASCII codepoints (it insists on ascii-encoding str header values), so
    the only way to put raw non-ASCII bytes on the wire here is to pass the
    header value as `bytes` directly, which httpx forwards unmodified; the
    ASGI server then decodes it as latin-1, same as a real non-ASCII byte
    sequence arriving over HTTP.
    """
    client, manager, ws, _ = env
    task = client.post(
        "/api/terminals/tasks", json={"executor_id": "claude-code", "workspace": ws}, headers=AUTH
    ).json()
    bare = TestClient(client.app, base_url=ORIGIN)
    r = bare.post(
        f"/api/terminals/tasks/{task['id']}/events",
        json={"hook_event_name": "Stop"},
        headers={"X-SV-Terminal-Hook": "café-token-éè".encode("utf-8")},
    )
    assert r.status_code == 403


def test_verdicts_come_from_tool_call_audit_by_session(env):
    client, manager, ws, db = env
    task = client.post(
        "/api/terminals/tasks", json={"executor_id": "claude-code", "workspace": ws}, headers=AUTH
    ).json()
    bare = TestClient(client.app, base_url=ORIGIN)
    bare.post(
        f"/api/terminals/tasks/{task['id']}/events",
        json={"hook_event_name": "SessionStart", "session_id": "sess-1"},
        headers={"X-SV-Terminal-Hook": manager.hook_token(task["id"])},
    )
    asyncio.run(
        db.execute(
            "INSERT INTO tool_call_audit (tool_id, function_name, action, risk, reason, is_essential, "
            "args_preview, runtime_kind, session_id) VALUES ('bash', 'Bash', 'block', 'red', 'rm on root', 0, "
            "'rm -rf /', 'claude-code', 'sess-1')"
        )
    )
    r = client.get(f"/api/terminals/tasks/{task['id']}/verdicts", headers=AUTH)
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1 and items[0]["action"] == "block" and items[0]["function_name"] == "Bash"


def test_ui_input_cannot_approve_a_pending_jit_request(env):
    """The 'y cannot pass hard deny' guarantee: keystrokes only reach the PTY.
    A pending JIT request for the same session stays pending no matter what
    is typed; only the JIT approve route (UI token, separate audit) can move it."""
    client, manager, ws, db = env
    task = client.post(
        "/api/terminals/tasks", json={"executor_id": "claude-code", "workspace": ws}, headers=AUTH
    ).json()
    asyncio.run(
        db.execute(
            "INSERT INTO jit_access_requests (id, tool_id, function_name, runtime_kind, session_id, rule_source) "
            "VALUES ('req1', 'bash', 'Bash', 'claude-code', 'sess-1', 'local')"
        )
    )
    asyncio.run(manager.input(task["id"], b"y\r"))
    row = asyncio.run(db.fetch_one("SELECT status FROM jit_access_requests WHERE id='req1'"))
    assert row["status"] == "pending"
    assert manager.host.writes == [(task["id"], b"y\r")]


class UnavailableHost(FakeHost):
    """host.spawn() raises ExecutorUnavailable, as InProcessPtyHost's spawn
    would if a race let the binary disappear between build_launch's which()
    check and the actual exec. Exercises the routes-layer 409 mapping added
    beyond the plan text, and confirms the manager's cleanup path still
    audits the failure even though the exception type is not one of
    UnknownExecutor / GuardHooksMissing / PtyUnavailable."""

    def spawn(self, task_id, launch, rows, cols, on_exit):
        raise ExecutorUnavailable("claude went away mid-launch")


def test_spawn_refusal_is_audited_and_returns_409(tmp_path):
    ws = tmp_path / "proj"
    ws.mkdir()
    db = DatabaseConnection(tmp_path / "t2.db")
    asyncio.run(run_migrations(db))
    store = TerminalStore(db)
    manager = TerminalManager(
        UnavailableHost(),
        store,
        ManagerSettings(
            data_dir=tmp_path / "data",
            port=8742,
            plugin_dir=lambda: tmp_path / "plugin",
            plugin_enabled=lambda: True,
            parent_env={"PATH": str(_fake_claude_bin(tmp_path))},
        ),
    )
    app = FastAPI()
    origin = "http://127.0.0.1:8742"
    app.state.terminal_auth = TerminalAuth(token="t" * 48, port=8742)
    app.state.terminal_manager = manager
    app.include_router(routes.router, prefix="/api")
    client = TestClient(app, base_url=origin)
    client.get("/api/terminals/session")

    r = client.post(
        "/api/terminals/tasks",
        json={"executor_id": "claude-code", "workspace": str(ws)},
        headers={HEADER: "1", "Origin": origin},
    )
    assert r.status_code == 409
    assert "claude went away mid-launch" in r.json()["detail"]

    tasks = asyncio.run(store.list_tasks())
    assert len(tasks) == 1
    assert tasks[0]["status"] == "failed"
    events = asyncio.run(store.list_events(tasks[0]["id"]))
    assert [e["kind"] for e in events] == ["spawn_failed"]
    assert "ExecutorUnavailable" in events[0]["detail"]


def test_stop_all_stops_every_running_task(tmp_path):
    """The env fixture never binds manager to a loop, so FakeHost's
    synchronous on_exit callback (fired from stop()'s worker thread) has
    nowhere to schedule _on_exit and status never moves off "starting" (see
    ManagerSettings.start() / TerminalManager._on_exit_threadsafe). That is
    fine for the other route tests, none of which assert on post-stop
    status. This test does, so it binds the manager the way app startup
    really does, via an ASGI startup hook running on the same loop the
    TestClient uses to execute requests."""
    ws = tmp_path / "proj"
    ws.mkdir()
    db = DatabaseConnection(tmp_path / "t3.db")
    asyncio.run(run_migrations(db))
    store = TerminalStore(db)
    manager = TerminalManager(
        FakeHost(),
        store,
        ManagerSettings(
            data_dir=tmp_path / "data",
            port=8743,
            plugin_dir=lambda: tmp_path / "plugin",
            plugin_enabled=lambda: True,
            parent_env={"PATH": str(_fake_claude_bin(tmp_path))},
        ),
    )
    app = FastAPI()
    origin = "http://127.0.0.1:8743"
    app.state.terminal_auth = TerminalAuth(token="t" * 48, port=8743)
    app.state.terminal_manager = manager
    app.include_router(routes.router, prefix="/api")

    @app.on_event("startup")
    async def _bind_manager_loop():
        await manager.start(asyncio.get_running_loop())

    headers = {HEADER: "1", "Origin": origin}
    with TestClient(app, base_url=origin) as client:
        client.get("/api/terminals/session")
        ids = []
        for _ in range(2):
            r = client.post(
                "/api/terminals/tasks",
                json={"executor_id": "claude-code", "workspace": str(ws)},
                headers=headers,
            )
            assert r.status_code == 201, r.text
            ids.append(r.json()["id"])
        assert client.get("/api/terminals/tasks", headers=headers).json()["running"] == 2

        r = client.post("/api/terminals/stop-all", headers=headers)
        assert r.status_code == 200

        # FakeHost.stop() fires on_exit synchronously from a worker thread,
        # which only schedules the manager's _on_exit coroutine onto its loop
        # (asyncio.run_coroutine_threadsafe); it doesn't block until that
        # coroutine completes. Poll instead of a fixed sleep so the test isn't
        # flaky under load or artificially slow when it finishes early.
        deadline = time.monotonic() + 2.0
        body = client.get("/api/terminals/tasks", headers=headers).json()
        while body["running"] != 0 and time.monotonic() < deadline:
            time.sleep(0.02)
            body = client.get("/api/terminals/tasks", headers=headers).json()
        assert body["running"] == 0
        statuses = {t["id"]: t["status"] for t in body["items"]}
        # -15 (SIGTERM) is not a clean exit, so store.set_exit records
        # "failed", matching test_manager.py's test_exit_marks_done_and_stop_marks_stopped.
        for task_id in ids:
            assert statuses[task_id] == "failed"


# --- linked sessions -------------------------------------------------------


def _stamp(minutes_ago: int) -> str:
    from datetime import datetime, timedelta, timezone

    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )


def _seed_audit(db, *, session_id, function_name, called_at, runtime_kind="codex"):
    asyncio.run(
        db.execute(
            "INSERT INTO tool_call_audit "
            "(tool_id, function_name, action, risk, reason, is_essential, args_preview, "
            "called_at, session_id, runtime_kind) "
            "VALUES (?, ?, 'allow', NULL, NULL, 0, NULL, ?, ?, ?)",
            (function_name, function_name, called_at, session_id, runtime_kind),
        )
    )


def test_link_route_puts_an_outside_session_on_the_board(env):
    client, _manager, ws, _db = env
    r = client.post(
        "/api/terminals/tasks/link",
        json={"executor_id": "codex", "session_id": "sess-abc12345", "workspace": ws},
        headers=AUTH,
    )
    assert r.status_code == 201, r.text
    task = r.json()
    assert task["origin"] == "linked" and task["pid"] is None
    assert task["session_id"] == "sess-abc12345"
    # _decorate still runs: branch and governed_at_launch are present.
    assert "branch" in task and task["governed_at_launch"] is True

    listed = client.get("/api/terminals/tasks", headers=AUTH).json()["items"]
    assert [t["origin"] for t in listed] == ["linked"]
    one = client.get(f"/api/terminals/tasks/{task['id']}", headers=AUTH).json()
    assert one["origin"] == "linked"


def test_link_route_validates_and_refuses_duplicates(env):
    client, *_ = env
    bad = client.post(
        "/api/terminals/tasks/link",
        json={"executor_id": "codex", "session_id": "short"},
        headers=AUTH,
    )
    assert bad.status_code == 400

    unknown = client.post(
        "/api/terminals/tasks/link",
        json={"executor_id": "nope", "session_id": "sess-abc12345"},
        headers=AUTH,
    )
    assert unknown.status_code == 400

    extra = client.post(
        "/api/terminals/tasks/link",
        json={"executor_id": "codex", "session_id": "sess-abc12345", "argv": ["sh"]},
        headers=AUTH,
    )
    assert extra.status_code == 422

    first = client.post(
        "/api/terminals/tasks/link",
        json={"executor_id": "codex", "session_id": "sess-abc12345"},
        headers=AUTH,
    )
    assert first.status_code == 201
    again = client.post(
        "/api/terminals/tasks/link",
        json={"executor_id": "codex", "session_id": "sess-abc12345"},
        headers=AUTH,
    )
    assert again.status_code == 409


def test_stop_is_refused_for_a_linked_task(env):
    client, *_ = env
    task = client.post(
        "/api/terminals/tasks/link",
        json={"executor_id": "codex", "session_id": "sess-abc12345"},
        headers=AUTH,
    ).json()
    r = client.post(f"/api/terminals/tasks/{task['id']}/stop", headers=AUTH)
    assert r.status_code == 409
    assert r.json()["detail"] == "This session runs outside SecureVector"


def test_unlinked_sessions_route_lists_only_unclaimed_recent_sessions(env):
    client, _manager, _ws, db = env
    _seed_audit(db, session_id="sess-free1234", function_name="Bash", called_at=_stamp(2))
    _seed_audit(db, session_id="sess-taken123", function_name="Read", called_at=_stamp(1))

    rows = client.get("/api/terminals/sessions/unlinked", headers=AUTH).json()["items"]
    assert {r["session_id"] for r in rows} == {"sess-free1234", "sess-taken123"}
    assert rows[0]["session_id"] == "sess-taken123"  # newest first
    assert rows[0]["label"] == "Codex"

    client.post(
        "/api/terminals/tasks/link",
        json={"executor_id": "codex", "session_id": "sess-taken123"},
        headers=AUTH,
    )
    rows = client.get("/api/terminals/sessions/unlinked", headers=AUTH).json()["items"]
    assert [r["session_id"] for r in rows] == ["sess-free1234"]


def test_listing_the_board_moves_a_stale_linked_task_to_done(env):
    client, _manager, _ws, db = env
    task = client.post(
        "/api/terminals/tasks/link",
        json={"executor_id": "codex", "session_id": "sess-abc12345"},
        headers=AUTH,
    ).json()
    _seed_audit(db, session_id="sess-abc12345", function_name="Bash", called_at=_stamp(45))

    listed = client.get("/api/terminals/tasks", headers=AUTH).json()["items"]
    row = next(t for t in listed if t["id"] == task["id"])
    assert row["status"] == "done" and row["ended_at"] is not None
