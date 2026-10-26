"""Worktree isolation for launched tasks, against real temporary git repos."""

import asyncio
import os
import subprocess
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import ensure_worktree_columns, migrate_to_v61, run_migrations
from securevector.app.services import delegation, policy_check
from securevector.app.terminals import routes
from securevector.app.terminals import worktree as worktrees
from securevector.app.terminals.auth import HEADER, TerminalAuth
from securevector.app.terminals.manager import ManagerSettings, TerminalManager
from securevector.app.terminals.store import TerminalStore, cwd_from_preview
from tests.unit.app.terminals.test_manager import FakeHost, SpawnFailingHost, _fake_claude_bin

ORIGIN = "http://127.0.0.1:8741"
AUTH = {HEADER: "1", "Origin": ORIGIN}


def _git(repo, *args):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
    out = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-C", str(repo), *args],
                         capture_output=True, text=True, env=env, timeout=30)
    assert out.returncode == 0, out.stderr
    return out.stdout.strip()


def _repo(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    _git(path, "init", "-q", "-b", "main")
    (path / "README.md").write_text("hello\n")
    (path / "sub").mkdir()
    (path / "sub" / "a.txt").write_text("a\n")
    (path / ".gitignore").write_text(".mcp.json\n.claude/settings.local.json\n.env\n")
    _git(path, "add", "-A")
    _git(path, "commit", "-q", "-m", "init")
    return path


def _branches(repo) -> set:
    return set(_git(repo, "branch", "--format=%(refname:short)").split())


@pytest.fixture(autouse=True)
def _clean_map():
    worktrees.clear()
    yield
    worktrees.clear()


async def _manager(tmp_path, host=None, db=None):
    db = db or DatabaseConnection(tmp_path / "t.db")
    await run_migrations(db)
    tmp_bin = _fake_claude_bin(tmp_path)
    settings = ManagerSettings(
        data_dir=tmp_path / "data", port=8741,
        plugin_dir=lambda: tmp_path / "plugin", plugin_enabled=lambda: True,
        parent_env={"PATH": str(tmp_bin)},
    )
    m = TerminalManager(host or FakeHost(), TerminalStore(db), settings)
    await m.start(asyncio.get_running_loop())
    return m


async def _until_state(m, task_id, state, timeout=10.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        row = await m.store.get_task(task_id)
        if row.get("worktree_state") == state:
            return row
        await asyncio.sleep(0.02)
    raise AssertionError(f"worktree of {task_id} never reached {state}")


async def _spawn_wt(m, folder, **kw):
    return await m.spawn("claude-code", str(folder), title=None, origin="ui", worktree=True, **kw)


# --- storage ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_v61_columns_and_idempotent(tmp_path):
    db = DatabaseConnection(tmp_path / "t.db")
    await run_migrations(db)
    await ensure_worktree_columns(db)
    await migrate_to_v61(db)
    cols = {r["name"] for r in await db.fetch_all("PRAGMA table_info(terminal_tasks)")}
    assert {"run_dir", "worktree_branch", "worktree_base", "worktree_state"} <= cols
    row = await db.fetch_one("SELECT MAX(version) AS v FROM schema_version")
    assert row["v"] == 67


# --- create and end --------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_then_clean_end_is_kept_and_nothing_deleted(tmp_path):
    repo = _repo(tmp_path / "proj")
    m = await _manager(tmp_path)
    task = await _spawn_wt(m, repo)
    tid = task["id"]
    run_dir = task["run_dir"]
    assert task["workspace"] == os.path.realpath(repo)
    assert m.host.launches[tid].cwd == run_dir
    assert run_dir == os.path.realpath(tmp_path / "data" / "terminals" / "tasks" / tid / "worktree")
    assert task["worktree_branch"] == f"sv/task-{tid}" and task["worktree_state"] == "active"
    assert task["worktree_base"] == _git(repo, "rev-parse", "HEAD")
    assert (Path(run_dir) / "README.md").read_text() == "hello\n"
    m.host.exit(tid, 0)
    row = await _until_state(m, tid, "kept")
    assert row["worktree_dirty"] == 0 and row["worktree_commits"] == 0
    assert os.path.isdir(run_dir) and f"sv/task-{tid}" in _branches(repo)
    kinds = [e["kind"] for e in await m.store.list_events(tid)]
    assert "worktree" in kinds and "worktree_kept" in kinds


@pytest.mark.asyncio
async def test_uncommitted_source_changes_are_not_carried_over(tmp_path):
    repo = _repo(tmp_path / "proj")
    (repo / "README.md").write_text("local edit\n")
    m = await _manager(tmp_path)
    task = await _spawn_wt(m, repo)
    assert (Path(task["run_dir"]) / "README.md").read_text() == "hello\n"


@pytest.mark.asyncio
async def test_dirty_end_is_kept_with_counts_and_remove_needs_confirm(tmp_path):
    repo = _repo(tmp_path / "proj")
    m = await _manager(tmp_path)
    task = await _spawn_wt(m, repo)
    tid, run_dir = task["id"], task["run_dir"]
    (Path(run_dir) / "new.txt").write_text("x\n")
    (Path(run_dir) / "README.md").write_text("changed\n")
    m.host.exit(tid, 0)
    row = await _until_state(m, tid, "kept")
    assert row["worktree_dirty"] == 2 and row["worktree_commits"] == 0
    refused = await m.remove_worktree(tid, confirm=False)
    assert refused["removed"] is False and refused["needs_confirm"] is True
    assert (Path(run_dir) / "new.txt").exists()
    done = await m.remove_worktree(tid, confirm=True, dirty_seen=refused["dirty"])
    assert done["removed"] is True and done["branch_deleted"] is True
    assert not os.path.exists(run_dir) and f"sv/task-{tid}" not in _branches(repo)
    assert (await m.store.get_task(tid))["worktree_state"] == "removed"
    # The source folder is untouched.
    assert (repo / "README.md").read_text() == "hello\n" and not (repo / "new.txt").exists()


@pytest.mark.asyncio
async def test_commits_only_end_kept_and_remove_keeps_branch(tmp_path):
    repo = _repo(tmp_path / "proj")
    m = await _manager(tmp_path)
    task = await _spawn_wt(m, repo)
    tid, run_dir = task["id"], task["run_dir"]
    (Path(run_dir) / "feature.txt").write_text("f\n")
    _git(run_dir, "add", "feature.txt")
    _git(run_dir, "commit", "-q", "-m", "feature")
    m.host.exit(tid, 0)
    row = await _until_state(m, tid, "kept")
    assert row["worktree_dirty"] == 0 and row["worktree_commits"] == 1
    out = await m.remove_worktree(tid, confirm=False)
    assert out["removed"] is True and out["branch_kept"] is True and out["branch_deleted"] is False
    assert "kept" in out["message"]
    assert not os.path.exists(run_dir) and f"sv/task-{tid}" in _branches(repo)


@pytest.mark.asyncio
async def test_clean_remove_deletes_worktree_and_branch(tmp_path):
    repo = _repo(tmp_path / "proj")
    m = await _manager(tmp_path)
    task = await _spawn_wt(m, repo)
    tid = task["id"]
    m.host.exit(tid, 0)
    await _until_state(m, tid, "kept")
    out = await m.remove_worktree(tid, confirm=False)
    assert out["removed"] is True and out["branch_deleted"] is True
    assert not os.path.exists(task["run_dir"]) and f"sv/task-{tid}" not in _branches(repo)
    assert "worktree_removed" in [e["kind"] for e in await m.store.list_events(tid)]


@pytest.mark.asyncio
async def test_running_task_worktree_cannot_be_removed(tmp_path):
    repo = _repo(tmp_path / "proj")
    m = await _manager(tmp_path)
    task = await _spawn_wt(m, repo)
    with pytest.raises(ValueError):
        await m.remove_worktree(task["id"], confirm=True)
    assert os.path.isdir(task["run_dir"])


@pytest.mark.asyncio
async def test_subfolder_runs_in_the_same_subfolder_of_the_worktree(tmp_path):
    repo = _repo(tmp_path / "proj")
    m = await _manager(tmp_path)
    task = await _spawn_wt(m, repo / "sub")
    assert task["workspace"] == os.path.realpath(repo / "sub")
    assert task["run_dir"].endswith("/worktree/sub")
    assert (Path(task["run_dir"]) / "a.txt").exists()
    assert worktrees.source_for(task["run_dir"]) == os.path.realpath(repo / "sub")
    assert worktrees.source_for(str(Path(task["run_dir"]).parent / "README.md")) == os.path.realpath(
        repo / "README.md")


@pytest.mark.asyncio
async def test_non_git_folder_is_refused(tmp_path):
    plain = tmp_path / "plain"
    plain.mkdir()
    m = await _manager(tmp_path)
    with pytest.raises(worktrees.NotAGitRepository) as exc:
        await _spawn_wt(m, plain)
    assert "Not a git repository" in str(exc.value)
    assert await m.store.list_tasks() == []
    assert worktrees.check_folder(str(plain))["git"] is False


# --- governance parity -----------------------------------------------------------


@pytest.mark.asyncio
async def test_governance_parity_between_folder_and_worktree(tmp_path, monkeypatch):
    repo = _repo(tmp_path / "proj")
    m = await _manager(tmp_path)
    task = await _spawn_wt(m, repo)
    src, run_dir = os.path.realpath(repo), task["run_dir"]

    # Policy: the caller's folder, its hash, and the decision.
    in_place = await policy_check.caller_from_headers(None, {}, "claude-code", src + "/sub")
    in_wt = await policy_check.caller_from_headers(None, {}, "claude-code", run_dir + "/sub")
    assert in_wt.cwd == in_place.cwd == src + "/sub"
    assert policy_check._cwd_hash(in_wt.cwd) == policy_check._cwd_hash(in_place.cwd)
    db = m.store.db
    a = await policy_check.check(db, in_place, "Bash", {"command": "ls"}, None)
    b = await policy_check.check(db, in_wt, "Bash", {"command": "ls"}, None)
    assert (a["decision"], a["reason"]) == (b["decision"], b["reason"])

    # Drift baseline is keyed on the task's workspace: the source.
    assert task["workspace"] == src
    assert cwd_from_preview(f"cwd={run_dir}") == src

    # Config Trust checks the source folder.
    seen = []
    from securevector.app.services import config_trust

    def fake_check(db, **kw):
        seen.append(kw["workspace"])
        return None

    monkeypatch.setattr(config_trust, "session_check", fake_check)
    monkeypatch.setattr(config_trust, "schedule", lambda coro: None)
    m.settings.config_trust = True
    m._config_check(task["id"], "claude-code", run_dir, "start")
    m._config_check(task["id"], "claude-code", src, "start")
    token = m.hook_token(task["id"])
    await m.handle_hook_event(task["id"], token, {"hook_event_name": "SessionStart",
                                                  "session_id": "sess-12345678", "cwd": run_dir})
    assert seen == [src, src, src]

    # Delegation folder scope.
    assert delegation.resolve_folder(run_dir + "/sub", src, []) == delegation.resolve_folder(src + "/sub", src, [])
    assert delegation.resolve_folder("sub", src, []) == src + "/sub"


# --- safety ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_repository_post_checkout_hook_does_not_run(tmp_path):
    repo = _repo(tmp_path / "proj")
    marker = tmp_path / "HOOK_RAN"
    hook = repo / ".git" / "hooks" / "post-checkout"
    hook.write_text(f"#!/bin/sh\ntouch '{marker}'\n")
    hook.chmod(0o755)
    m = await _manager(tmp_path)
    await _spawn_wt(m, repo)
    assert not marker.exists()


@pytest.mark.asyncio
async def test_crash_mid_spawn_leaves_no_worktree_or_branch(tmp_path):
    repo = _repo(tmp_path / "proj")
    m = await _manager(tmp_path, host=SpawnFailingHost())
    with pytest.raises(RuntimeError):
        await _spawn_wt(m, repo)
    assert _branches(repo) == {"main"}
    tasks_dir = tmp_path / "data" / "terminals" / "tasks"
    assert not list(tasks_dir.glob("*/worktree"))
    assert _git(repo, "worktree", "list", "--porcelain").count("worktree ") == 1


@pytest.mark.asyncio
async def test_startup_sweep_keeps_active_worktrees_and_never_deletes(tmp_path):
    repo = _repo(tmp_path / "proj")
    db = DatabaseConnection(tmp_path / "t.db")
    m = await _manager(tmp_path, db=db)
    task = await _spawn_wt(m, repo)
    (Path(task["run_dir"]) / "wip.txt").write_text("wip\n")
    # A second task whose worktree the person removed earlier.
    other = await _spawn_wt(m, repo)
    m.host.exit(other["id"], 0)
    await _until_state(m, other["id"], "kept")
    await m.remove_worktree(other["id"], confirm=True)
    # The app dies with the first task still running: a new manager starts.
    worktrees.clear()
    m2 = await _manager(tmp_path, db=db)
    row = await m2.store.get_task(task["id"])
    assert row["worktree_state"] == "kept"
    assert (Path(task["run_dir"]) / "wip.txt").read_text() == "wip\n"
    assert f"sv/task-{task['id']}" in _branches(repo)
    # Paths are registered again for source_for.
    assert worktrees.source_for(task["run_dir"]) == os.path.realpath(repo)


def test_config_copy_only_the_two_ignored_files(tmp_path):
    repo = _repo(tmp_path / "proj")
    (repo / ".mcp.json").write_text('{"mcpServers": {}}')
    (repo / ".claude").mkdir()
    (repo / ".claude" / "settings.local.json").write_text("{}")
    (repo / ".claude" / "other.json").write_text("{}")
    (repo / ".env").write_text("SECRET=1\n")
    created = worktrees.create(str(repo), tmp_path / "task1", "aaaaaaaaaaaa")
    run = Path(created.run_dir)
    assert sorted(created.copied) == [".claude/settings.local.json", ".mcp.json"]
    assert (run / ".mcp.json").read_text() == '{"mcpServers": {}}'
    assert not (run / ".env").exists() and not (run / ".claude" / "other.json").exists()
    assert oct((run / ".mcp.json").stat().st_mode & 0o777) == oct(0o600)


def test_config_copy_skips_tracked_files_and_outside_links(tmp_path):
    repo = _repo(tmp_path / "proj")
    outside = tmp_path / "outside.json"
    outside.write_text('{"secret": 1}')
    os.symlink(outside, repo / ".mcp.json")
    (repo / ".claude").mkdir()
    (repo / ".claude" / "settings.local.json").write_text("{}")
    # Not ignored any more: tracked files reach the worktree through git.
    (repo / ".gitignore").write_text(".mcp.json\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "track local settings")
    (repo / ".claude" / "settings.local.json").write_text('{"changed": 1}')
    created = worktrees.create(str(repo), tmp_path / "task2", "bbbbbbbbbbbb")
    run = Path(created.run_dir)
    assert created.copied == []
    assert not os.path.lexists(run / ".mcp.json")
    assert (run / ".claude" / "settings.local.json").read_text() == "{}"


def test_existing_branch_is_never_touched(tmp_path):
    repo = _repo(tmp_path / "proj")
    _git(repo, "branch", "sv/task-cccccccccccc")
    with pytest.raises(worktrees.WorktreeError):
        worktrees.create(str(repo), tmp_path / "task3", "cccccccccccc")
    assert "sv/task-cccccccccccc" in _branches(repo)


# --- relaunch --------------------------------------------------------------------


@pytest.mark.asyncio
async def test_relaunch_reuses_the_worktree(tmp_path):
    repo = _repo(tmp_path / "proj")
    m = await _manager(tmp_path)
    first = await _spawn_wt(m, repo)
    m.host.exit(first["id"], 0)
    await _until_state(m, first["id"], "kept")
    again = await m.spawn("claude-code", str(repo), title=None, origin="ui", from_task_id=first["id"])
    assert m.host.launches[again["id"]].cwd == first["run_dir"]
    assert again["run_dir"] == first["run_dir"]
    assert again["worktree_branch"] == first["worktree_branch"]
    assert (await m.store.get_task(again["id"]))["worktree_state"] == "active"
    m.host.exit(again["id"], 0)
    await _until_state(m, again["id"], "kept")
    # Once removed, a relaunch runs in the source folder.
    await m.remove_worktree(again["id"], confirm=True)
    third = await m.spawn("claude-code", str(repo), title=None, origin="ui", from_task_id=first["id"])
    assert m.host.launches[third["id"]].cwd == os.path.realpath(repo)
    assert third["run_dir"] is None


# --- routes ----------------------------------------------------------------------


def test_routes_launch_get_remove_and_archive(tmp_path):
    repo = _repo(tmp_path / "proj")
    plain = tmp_path / "plain"
    plain.mkdir()
    db = DatabaseConnection(tmp_path / "t.db")
    asyncio.run(run_migrations(db))
    manager = TerminalManager(
        FakeHost(), TerminalStore(db),
        ManagerSettings(data_dir=tmp_path / "data", port=8741, plugin_dir=lambda: tmp_path / "plugin",
                        plugin_enabled=lambda: True, parent_env={"PATH": str(_fake_claude_bin(tmp_path))}),
    )
    app = FastAPI()
    app.state.terminal_auth = TerminalAuth(token="t" * 48, port=8741)
    app.state.terminal_manager = manager
    app.include_router(routes.router, prefix="/api")

    @app.on_event("startup")
    async def _bind_manager_loop():
        await manager.start(asyncio.get_running_loop())

    with TestClient(app, base_url=ORIGIN) as client:
        _route_flow(client, repo, plain)


def _route_flow(client, repo, plain):
    import time

    from securevector.app.server.routes.jit_access import _UI_TOKEN

    client.get("/api/terminals/session")

    r = client.get("/api/terminals/git-repo", params={"folder": str(plain)}, headers=AUTH)
    assert r.json()["git"] is False and r.json()["message"] == worktrees.NOT_A_REPO
    r = client.get("/api/terminals/git-repo", params={"folder": str(repo)}, headers=AUTH)
    assert r.json()["git"] is True and r.json()["worktree_ok"] is True

    r = client.post("/api/terminals/tasks", headers=AUTH,
                    json={"executor_id": "claude-code", "workspace": str(plain), "worktree": True})
    assert r.status_code == 400 and "Not a git repository" in r.json()["detail"]

    r = client.post("/api/terminals/tasks", headers=AUTH,
                    json={"executor_id": "claude-code", "workspace": str(repo), "worktree": True})
    assert r.status_code == 201, r.text
    task = r.json()
    tid = task["id"]
    assert task["branch"] == f"sv/task-{tid}" and task["worktree_state"] == "active"
    (Path(task["run_dir"]) / "x.txt").write_text("x")
    # No count read while the task runs.
    r = client.get(f"/api/terminals/tasks/{tid}", headers=AUTH)
    assert r.json()["worktree_dirty"] is None

    client.post(f"/api/terminals/tasks/{tid}/stop", headers=AUTH)
    deadline = time.monotonic() + 10
    while client.get(f"/api/terminals/tasks/{tid}", headers=AUTH).json()["worktree_state"] != "kept":
        assert time.monotonic() < deadline, "worktree never kept"
        time.sleep(0.02)
    r = client.get(f"/api/terminals/tasks/{tid}", headers=AUTH)
    assert r.json()["worktree_dirty"] == 1 and r.json()["worktree_commits"] == 0
    r = client.post(f"/api/terminals/tasks/{tid}/archive", headers=AUTH)
    assert r.json()["worktree_kept"] is True and r.json()["run_dir"] == task["run_dir"]
    assert os.path.isdir(task["run_dir"])

    url = f"/api/terminals/tasks/{tid}/worktree/remove"
    assert client.post(url, headers=AUTH, json={"confirm": True}).status_code == 403
    ui = {**AUTH, "X-SV-UI-Token": _UI_TOKEN}
    r = client.post(url, headers=ui, json={})
    assert r.status_code == 409 and r.json()["detail"]["needs_confirm"] is True
    assert "Ignored files such as build output are deleted too." in r.json()["detail"]["message"]
    assert os.path.isdir(task["run_dir"])
    opened = f"/api/terminals/tasks/{tid}/worktree/open"
    assert client.post(opened, headers=AUTH).status_code == 403
    # A confirm without the count shown is asked again.
    assert client.post(url, headers=ui, json={"confirm": True}).status_code == 409
    r = client.post(url, headers=ui, json={"confirm": True, "dirty_seen": 1})
    assert r.status_code == 200 and r.json()["removed"] is True
    assert not os.path.exists(task["run_dir"])
    assert client.post(opened, headers=ui).status_code == 409


# --- hardening -------------------------------------------------------------------


def test_filter_drivers_do_not_run_on_create_or_counts(tmp_path):
    repo = _repo(tmp_path / "proj")
    (repo / ".gitattributes").write_text("*.md filter=x\n")
    _git(repo, "add", ".gitattributes")
    _git(repo, "commit", "-q", "-m", "attrs")
    (repo / ".git" / "info").mkdir(exist_ok=True)
    (repo / ".git" / "info" / "attributes").write_text("*.txt filter=y\n")
    marks = tmp_path / "marks"
    marks.mkdir()
    for name in ("x", "y"):
        _git(repo, "config", f"filter.{name}.smudge", f"touch '{marks}/{name}-smudge'; cat")
        _git(repo, "config", f"filter.{name}.clean", f"touch '{marks}/{name}-clean'; cat")
        _git(repo, "config", f"filter.{name}.process", f"touch '{marks}/{name}-process'")
    created = worktrees.create(str(repo), tmp_path / "task", "dddddddddddd")
    (Path(created.run_dir) / "README.md").write_text("changed\n")
    (Path(created.run_dir) / "sub" / "a.txt").write_text("changed\n")
    found = worktrees.counts(created.source_root, created.root, created.branch, created.base)
    assert found["dirty"] == 2
    assert list(marks.iterdir()) == []


def test_git_too_old_refuses_worktrees(tmp_path, monkeypatch):
    repo = _repo(tmp_path / "proj")
    monkeypatch.setattr(worktrees, "_ATTR_SOURCE_OK", False)
    with pytest.raises(worktrees.WorktreeError) as exc:
        worktrees.create(str(repo), tmp_path / "task", "eeeeeeeeeeee")
    assert str(exc.value) == worktrees.GIT_TOO_OLD
    assert worktrees.check_folder(str(repo))["message"] == worktrees.GIT_TOO_OLD
    assert not (tmp_path / "task" / "worktree").exists()


@pytest.mark.asyncio
async def test_hooks_folder_is_an_empty_app_folder(tmp_path):
    await _manager(tmp_path)
    hooks = worktrees._hooks_dir()
    assert Path(hooks) == tmp_path / "data" / "terminals" / "git-hooks-empty"
    assert os.listdir(hooks) == []


def test_unreadable_changes_need_confirm(tmp_path, monkeypatch):
    repo = _repo(tmp_path / "proj")
    created = worktrees.create(str(repo), tmp_path / "task", "ffffffffffff")
    monkeypatch.setattr(worktrees, "counts", lambda *a: {"dirty": None, "commits": 0})
    out = worktrees.remove(created.source_root, created.root, created.branch, created.base, confirm=False)
    assert out["removed"] is False and out["needs_confirm"] is True
    assert "Ignored files" in out["message"] and "—" not in out["message"]
    assert os.path.isdir(created.root)


@pytest.mark.asyncio
async def test_child_run_dir_refuses_a_link_out_of_the_worktree(tmp_path):
    repo = _repo(tmp_path / "proj")
    outside = tmp_path / "outside"
    outside.mkdir()
    m = await _manager(tmp_path)
    parent = await _spawn_wt(m, repo)
    wt_sub = Path(parent["run_dir"]) / "sub"
    for f in wt_sub.iterdir():
        f.unlink()
    wt_sub.rmdir()
    os.symlink(outside, wt_sub)
    with pytest.raises(worktrees.WorktreeError):
        m.child_run_dir(await m.store.get_task(parent["id"]), str(repo / "sub"))
    assert m.child_run_dir(await m.store.get_task(parent["id"]), str(repo)) == parent["run_dir"]


@pytest.mark.asyncio
async def test_relaunch_refuses_a_run_dir_that_links_out(tmp_path):
    repo = _repo(tmp_path / "proj")
    outside = tmp_path / "outside"
    (outside / "sub").mkdir(parents=True)
    m = await _manager(tmp_path)
    first = await _spawn_wt(m, repo / "sub")
    m.host.exit(first["id"], 0)
    await _until_state(m, first["id"], "kept")
    wt_sub = Path(first["run_dir"])
    for f in wt_sub.iterdir():
        f.unlink()
    wt_sub.rmdir()
    os.symlink(outside / "sub", wt_sub)
    with pytest.raises(worktrees.WorktreeError):
        await m.spawn("claude-code", str(repo / "sub"), title=None, origin="ui", from_task_id=first["id"])
    assert outside.name not in str(list(m.host.launches.values())[-1].cwd)


@pytest.mark.asyncio
async def test_remove_marks_removing_so_relaunch_and_delegation_do_not_reuse(tmp_path, monkeypatch):
    import threading

    repo = _repo(tmp_path / "proj")
    m = await _manager(tmp_path)
    first = await _spawn_wt(m, repo)
    m.host.exit(first["id"], 0)
    await _until_state(m, first["id"], "kept")
    gate, entered = threading.Event(), threading.Event()
    real_remove = worktrees.remove

    def slow_remove(*a, **kw):
        entered.set()
        assert gate.wait(10)
        return real_remove(*a, **kw)

    monkeypatch.setattr(worktrees, "remove", slow_remove)
    removal = asyncio.ensure_future(m.remove_worktree(first["id"], confirm=True))
    loop = asyncio.get_running_loop()
    assert await loop.run_in_executor(None, entered.wait, 10)
    row = await m.store.get_task(first["id"])
    assert row["worktree_state"] == "removing"
    again = await m.spawn("claude-code", str(repo), title=None, origin="ui", from_task_id=first["id"])
    assert m.host.launches[again["id"]].cwd == os.path.realpath(repo) and again["run_dir"] is None
    with pytest.raises(worktrees.WorktreeError):
        m.child_run_dir(row, str(repo))
    gate.set()
    out = await removal
    assert out["removed"] is True
    assert (await m.store.get_task(first["id"]))["worktree_state"] == "removed"


@pytest.mark.asyncio
async def test_failed_remove_restores_kept(tmp_path, monkeypatch):
    repo = _repo(tmp_path / "proj")
    m = await _manager(tmp_path)
    task = await _spawn_wt(m, repo)
    m.host.exit(task["id"], 0)
    await _until_state(m, task["id"], "kept")

    def broken(*a, **kw):
        raise worktrees.WorktreeError("git could not remove the worktree")

    monkeypatch.setattr(worktrees, "remove", broken)
    with pytest.raises(worktrees.WorktreeError):
        await m.remove_worktree(task["id"], confirm=True)
    row = await m.store.get_task(task["id"])
    assert row["worktree_state"] == "kept" and row["worktree_dirty"] == 0
    assert os.path.isdir(task["run_dir"])


@pytest.mark.asyncio
async def test_refresh_is_cached_and_skipped_while_running(tmp_path, monkeypatch):
    from securevector.app.terminals import manager as manager_module

    repo = _repo(tmp_path / "proj")
    m = await _manager(tmp_path)
    task = await _spawn_wt(m, repo)
    calls = []
    real_counts = worktrees.counts

    def counting(*a):
        calls.append(a)
        return real_counts(*a)

    monkeypatch.setattr(worktrees, "counts", counting)
    (Path(task["run_dir"]) / "x.txt").write_text("x")
    await m.refresh_worktree(task["id"])
    assert calls == []  # running: no read
    m.host.exit(task["id"], 0)
    row = await _until_state(m, task["id"], "kept")
    assert row["worktree_dirty"] == 1 and len(calls) == 1  # the exit check
    (Path(task["run_dir"]) / "y.txt").write_text("y")
    assert (await m.refresh_worktree(task["id"]))["worktree_dirty"] == 1  # cached
    assert len(calls) == 1
    monkeypatch.setattr(manager_module, "WORKTREE_REFRESH_S", 0.0)
    assert (await m.refresh_worktree(task["id"]))["worktree_dirty"] == 2


def test_counts_never_enter_a_submodule(tmp_path):
    sub_src = _repo(tmp_path / "subsrc")
    repo = _repo(tmp_path / "proj")
    _git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", str(sub_src), "s")
    _git(repo, "commit", "-q", "-m", "submodule")
    marker = tmp_path / "MARKER"
    s = repo / "s"
    _git(s, "config", "filter.ev.clean", f"touch '{marker}'; cat")
    gitdir = Path(_git(s, "rev-parse", "--absolute-git-dir"))
    (gitdir / "info").mkdir(exist_ok=True)
    (gitdir / "info" / "attributes").write_text("* filter=ev\n")
    (s / "README.md").write_text("changed in the submodule\n")
    worktrees.counts(str(repo), str(repo), "main", _git(repo, "rev-parse", "HEAD"))
    created = worktrees.create(str(repo), tmp_path / "task", "abababababab")
    worktrees.counts(created.source_root, created.root, created.branch, created.base)
    assert not marker.exists()
    assert list((Path(created.root) / "s").iterdir()) == []


def test_lfs_style_required_filter_is_refused_up_front(tmp_path):
    repo = _repo(tmp_path / "proj")
    _git(repo, "config", "filter.lfs.required", "true")
    _git(repo, "config", "filter.lfs.smudge", "git-lfs smudge -- %f")
    (repo / ".gitattributes").write_text("*.bin filter=lfs diff=lfs merge=lfs -text\n")
    _git(repo, "add", ".gitattributes")
    _git(repo, "commit", "-q", "-m", "track binaries with lfs")
    with pytest.raises(worktrees.WorktreeError) as exc:
        worktrees.create(str(repo), tmp_path / "task", "acacacacacac")
    assert str(exc.value) == worktrees.LFS_UNSUPPORTED
    assert "—" not in worktrees.LFS_UNSUPPORTED
    assert worktrees.check_folder(str(repo))["message"] == worktrees.LFS_UNSUPPORTED
    assert not (tmp_path / "task" / "worktree").exists()
    assert "sv/task-acacacacacac" not in _branches(repo)


@pytest.mark.asyncio
async def test_remove_after_a_clean_end_rechecks_and_keeps_a_new_untracked_file(tmp_path):
    repo = tmp_path / "plain-repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    (repo / "README.md").write_text("hello\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "init")
    m = await _manager(tmp_path)
    task = await _spawn_wt(m, repo)
    m.host.exit(task["id"], 1)
    row = await _until_state(m, task["id"], "kept")
    assert row["worktree_dirty"] == 0 and row["worktree_commits"] == 0
    (Path(task["run_dir"]) / "hello.txt").write_text("keep me\n")
    out = await m.remove_worktree(task["id"], confirm=False)
    assert out["removed"] is False and out["needs_confirm"] is True and out["dirty"] == 1
    # A confirm given against the stale clean card does not discard it either.
    for seen in (None, 0):
        out = await m.remove_worktree(task["id"], confirm=True, dirty_seen=seen)
        assert out["removed"] is False and out["needs_confirm"] is True and out["dirty"] == 1
    assert (Path(task["run_dir"]) / "hello.txt").read_text() == "keep me\n"
    assert f"sv/task-{task['id']}" in _branches(repo)
    assert (await m.store.get_task(task["id"]))["worktree_state"] == "kept"


@pytest.mark.asyncio
async def test_board_list_refreshes_kept_worktree_counts(tmp_path, monkeypatch):
    from securevector.app.terminals import manager as manager_module

    repo = _repo(tmp_path / "proj")
    m = await _manager(tmp_path)
    task = await _spawn_wt(m, repo)
    m.host.exit(task["id"], 0)
    await _until_state(m, task["id"], "kept")
    (Path(task["run_dir"]) / "late.txt").write_text("late\n")
    monkeypatch.setattr(manager_module, "WORKTREE_REFRESH_S", 0.0)
    body = await routes.list_tasks(m)
    row = {i["id"]: i for i in body["items"]}[task["id"]]
    assert row["worktree_dirty"] == 1



def test_a_required_filter_only_in_global_config_does_not_make_the_repo_lfs(tmp_path, monkeypatch):
    # `git lfs install` writes filter.lfs.required=true to the global config on
    # every machine with LFS installed (CI runners included). Without the
    # repository routing files through that filter, worktrees stay available.
    home = tmp_path / "home"
    home.mkdir()
    (home / ".gitconfig").write_text(
        "[filter \"lfs\"]\n\trequired = true\n\tsmudge = git-lfs smudge -- %f\n\tclean = git-lfs clean -- %f\n")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(home / ".config"))
    repo = _repo(tmp_path / "proj")
    assert worktrees.has_required_filter(str(repo)) is False
    assert worktrees.check_folder(str(repo))["worktree_ok"] is True
    created = worktrees.create(str(repo), tmp_path / "task", "adadadadadad")
    assert Path(created.root).is_dir()
    # The same global config plus an info/attributes rule makes it an LFS checkout.
    info = Path(_git(repo, "rev-parse", "--git-path", "info/attributes"))
    info = info if info.is_absolute() else repo / info
    info.parent.mkdir(parents=True, exist_ok=True)
    info.write_text("*.psd filter=lfs\n")
    assert worktrees.has_required_filter(str(repo)) is True
