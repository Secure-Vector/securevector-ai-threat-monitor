"""Plugin update awareness: update_state, /api/hooks/status-all,
/api/hooks/update-plugins and securevector-app --update-plugins.

Everything runs against a temporary HOME; no real harness folder is read or
written.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from securevector.app.server.routes import (
    _hooks_common,
    hooks_cursor,
    hooks_hermes,
    hooks_opencode,
    hooks_updates,
)
from securevector.app.terminals.auth import TerminalAuth

SUBS = {"http://localhost:8741": "http://127.0.0.1:9999"}
PAGE = {"host": "127.0.0.1:8741", "origin": "http://127.0.0.1:8741"}


@pytest.fixture(autouse=True)
def temp_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(Path, "home", staticmethod(lambda: home))
    monkeypatch.delenv("SV_WEB_PORT", raising=False)
    monkeypatch.setattr(_hooks_common, "_load_server_config", lambda: {})
    return home


def _bundle(tmp_path, version="1.3.0"):
    src = tmp_path / "bundle"
    src.mkdir()
    (src / "plugin.json").write_text(json.dumps({"version": version}))
    (src / "index.js").write_text("const URL = 'http://localhost:8741';\n")
    return src


def _state(src, staging, reader=lambda: None, **kw):
    return _hooks_common.update_state(
        staging_dir=staging, source_dir=src, files=["plugin.json", "index.js"],
        substitutions=SUBS, bundled_version="1.3.0", installed_version_reader=reader, **kw,
    )


# --- update_state -------------------------------------------------------------


def test_not_installed(tmp_path):
    src = _bundle(tmp_path)
    st = _state(src, tmp_path / "staging", reader=lambda: "9.9.9")
    assert st == {
        "installed": False, "files_current": False, "update_available": False,
        "installed_version": None, "bundled_version": "1.3.0",
    }


def test_current(tmp_path):
    src = _bundle(tmp_path)
    staging = tmp_path / "staging"
    _hooks_common.stage_files(staging_dir=staging, source_dir=src, files=["plugin.json", "index.js"], substitutions=SUBS)
    st = _state(src, staging, reader=lambda: _hooks_common.read_manifest_version(staging / "plugin.json"))
    assert st["installed"] and st["files_current"] and not st["update_available"]
    assert st["installed_version"] == "1.3.0"
    # The substituted URL is what the installer wrote; a different one is stale.
    other = _hooks_common.update_state(
        staging_dir=staging, source_dir=src, files=["plugin.json", "index.js"],
        substitutions={"http://localhost:8741": "http://127.0.0.1:1"},
        bundled_version="1.3.0", installed_version_reader=lambda: None,
    )
    assert other["update_available"]


def test_stale_and_stale_copy(tmp_path):
    src = _bundle(tmp_path)
    staging = tmp_path / "staging"
    _hooks_common.stage_files(staging_dir=staging, source_dir=src, files=["plugin.json", "index.js"], substitutions=SUBS)
    copy = tmp_path / "copy"
    _hooks_common.stage_files(staging_dir=copy, source_dir=src, files=["plugin.json", "index.js"], substitutions=SUBS)
    assert not _state(src, staging, copies=(copy, None, tmp_path / "absent"))["update_available"]
    (copy / "index.js").write_text("old\n")
    assert _state(src, staging, copies=(copy,))["update_available"]
    (staging / "plugin.json").write_text(json.dumps({"version": "1.2.0"}))
    st = _state(src, staging, reader=lambda: _hooks_common.read_manifest_version(staging / "plugin.json"))
    assert st["update_available"] and st["installed_version"] == "1.2.0"


def test_installed_override_and_reader_errors(tmp_path):
    src = _bundle(tmp_path)
    staging = tmp_path / "staging"
    _hooks_common.stage_files(staging_dir=staging, source_dir=src, files=["plugin.json", "index.js"], substitutions=SUBS)
    assert _state(src, staging, installed=False)["installed"] is False

    def boom():
        raise RuntimeError("x")

    assert _state(src, staging, reader=boom)["installed_version"] is None


def test_read_manifest_version(tmp_path):
    (tmp_path / "a.json").write_text('{"version": "5.4.1"}')
    (tmp_path / "b.yaml").write_text('name: x\nversion: "1.1.0"  # note\n')
    (tmp_path / "c.json").write_text("not json")
    (tmp_path / "d.json").write_text('{"version": 3}')
    assert _hooks_common.read_manifest_version(tmp_path / "a.json") == "5.4.1"
    assert _hooks_common.read_manifest_version(tmp_path / "b.yaml") == "1.1.0"
    assert _hooks_common.read_manifest_version(tmp_path / "c.json") is None
    assert _hooks_common.read_manifest_version(tmp_path / "d.json") is None
    assert _hooks_common.read_manifest_version(tmp_path / "missing.json") is None
    (tmp_path / "e.json").write_text(json.dumps({"version": "1.0\nINJECTED"}))
    (tmp_path / "f.yaml").write_text("version: 1.0 two\n")
    (tmp_path / "g.json").write_text(json.dumps({"version": "1.0.0", "pad": "x" * 70000}))
    (tmp_path / "h.json").write_text(json.dumps({"version": "1" * 33}))
    for name in ("e.json", "f.yaml", "g.json", "h.json"):
        assert _hooks_common.read_manifest_version(tmp_path / name) is None, name


def test_every_bundled_manifest_has_a_version():
    manifests = {
        "hooks_claude_code": ".claude-plugin/plugin.json",
        "hooks_codex": ".codex-plugin/plugin.json",
        "hooks_copilot_cli": "plugin.json",
        "hooks_cursor": ".cursor-plugin/plugin.json",
        "hooks_antigravity": "plugin.json",
        "hooks_opencode": "package.json",
        "hooks": "openclaw.plugin.json",
        "hooks_hermes": "plugin.yaml",
    }
    assert sorted(manifests) == sorted(n for _r, n in hooks_updates.HARNESSES)
    for name, manifest in manifests.items():
        mod = hooks_updates._module(name)
        assert _hooks_common.read_manifest_version(mod.BUNDLED_PLUGIN_DIR / manifest), name
        assert f'manifest = "{manifest}"' in Path(mod.__file__).read_text(), name


# --- routes -------------------------------------------------------------------


def _client():
    app = FastAPI()
    app.include_router(hooks_updates.router, prefix="/api")
    app.include_router(hooks_opencode.router, prefix="/api")
    app.state.terminal_auth = TerminalAuth(token="t" * 48, port=8741)
    return TestClient(app)


def test_status_all_aggregates_every_harness(monkeypatch):
    fixed = {
        "installed": True, "files_current": False, "update_available": True,
        "installed_version": "1.2.0", "bundled_version": "1.3.0",
    }
    for i, (_runtime, name) in enumerate(hooks_updates.HARNESSES):
        mod = hooks_updates._module(name)
        if i == 0:
            monkeypatch.setattr(mod, "_update_state", lambda: dict(fixed))
        elif i == 1:
            def boom():
                raise OSError("unreadable")
            monkeypatch.setattr(mod, "_update_state", boom)
        else:
            monkeypatch.setattr(mod, "_update_state", lambda: dict(fixed, installed=False, update_available=False))
    body = _client().get("/api/hooks/status-all").json()
    assert [p["runtime"] for p in body["plugins"]] == [r for r, _ in hooks_updates.HARNESSES]
    assert body["update_count"] == 1
    assert body["plugins"][0]["update_available"] is True
    assert body["plugins"][1]["installed"] is False


def _setup_three(monkeypatch, tmp_path, home):
    """opencode stale, hermes current, cursor missing; all under temp HOME."""
    monkeypatch.setattr(hooks_updates, "HARNESSES", [
        ("opencode", "hooks_opencode"), ("hermes", "hooks_hermes"), ("cursor", "hooks_cursor"),
    ])
    monkeypatch.setattr(hooks_opencode.mcp_registration, "register", lambda *a, **k: None)
    # opencode: staged from an older bundle.
    oc = home / ".securevector" / "staging" / "opencode-plugin"
    monkeypatch.setattr(hooks_opencode, "STAGING_DIR", oc)
    monkeypatch.setattr(hooks_opencode, "_opencode_detected", lambda: False)
    monkeypatch.setattr(hooks_opencode, "_is_registered", lambda: True)
    subs = {"http://127.0.0.1:8741": "http://127.0.0.1:8741", "http://localhost:8741": "http://127.0.0.1:8741"}
    _hooks_common.stage_files(staging_dir=oc, source_dir=hooks_opencode.BUNDLED_PLUGIN_DIR,
                              files=hooks_opencode.PLUGIN_FILES, substitutions=subs)
    pkg = json.loads((oc / "package.json").read_text())
    pkg["version"] = "1.2.0"
    (oc / "package.json").write_text(json.dumps(pkg))
    # hermes: current.
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
    monkeypatch.setattr(hooks_hermes, "_enable_state", lambda: (True, False))
    _hooks_common.stage_files(staging_dir=hooks_hermes._plugin_dir(), source_dir=hooks_hermes.BUNDLED_PLUGIN_DIR,
                              files=hooks_hermes.PLUGIN_FILES, substitutions=subs)
    # cursor: never installed.
    monkeypatch.setattr(hooks_cursor, "STAGING_DIR", home / ".securevector" / "staging" / "cursor-plugin")
    return oc


def test_update_plugins_route(monkeypatch, tmp_path, temp_home):
    oc = _setup_three(monkeypatch, tmp_path, temp_home)
    client = _client()
    assert client.get("/api/hooks/status-all").json()["update_count"] == 1
    r = client.post("/api/hooks/update-plugins", headers=PAGE)
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    by = {x["runtime"]: x for x in body["results"]}
    assert by["opencode"] == {"runtime": "opencode", "before_version": "1.2.0", "after_version": "1.3.0", "status": "updated"}
    assert by["hermes"]["status"] == "current"
    assert by["cursor"] == {"runtime": "cursor", "before_version": None, "after_version": None, "status": "not installed"}
    assert json.loads((oc / "package.json").read_text())["version"] == "1.3.0"
    assert not hooks_cursor.STAGING_DIR.exists(), "a plugin that was not installed got installed"
    status = client.get("/api/hooks/opencode/status").json()
    assert status["update_available"] is False and status["installed_version"] == "1.3.0"


def test_update_plugins_route_needs_the_page_origin():
    r = _client().post("/api/hooks/update-plugins", headers={"host": "127.0.0.1:8741", "origin": "https://evil.example"})
    assert r.status_code == 403


def test_one_failure_does_not_stop_the_rest(monkeypatch, tmp_path, temp_home):
    _setup_three(monkeypatch, tmp_path, temp_home)
    monkeypatch.setattr(hooks_updates, "HARNESSES", [("hermes", "hooks_hermes"), ("opencode", "hooks_opencode")])
    (hooks_hermes._plugin_dir() / "cost.py").write_text("old\n")

    async def fail():
        raise RuntimeError("disk full")

    monkeypatch.setattr(hooks_hermes, "install_plugin", fail)
    results = asyncio.run(hooks_updates.update_plugins())
    assert [r["status"] for r in results] == ["failed", "updated"]
    assert results[0]["reason"] == "disk full"
    assert "reason" not in results[1]


def test_staged_but_removed_or_disabled_in_the_harness_is_skipped(monkeypatch, tmp_path, temp_home):
    oc = _setup_three(monkeypatch, tmp_path, temp_home)
    # OpenCode no longer lists it; Hermes has it disabled; Cursor's copy was removed.
    monkeypatch.setattr(hooks_opencode, "_is_registered", lambda: False)
    monkeypatch.setattr(hooks_hermes, "_enable_state", lambda: (True, True))
    (hooks_hermes._plugin_dir() / "cost.py").write_text("old\n")
    cur = hooks_cursor.STAGING_DIR
    _hooks_common.stage_files(staging_dir=cur, source_dir=hooks_cursor.BUNDLED_PLUGIN_DIR,
                              files=hooks_cursor.PLUGIN_FILES, substitutions={})
    monkeypatch.setattr(hooks_cursor, "CURSOR_PLUGIN_DIR", temp_home / ".cursor" / "plugins" / "local" / "securevector-guard")
    for mod in (hooks_opencode, hooks_hermes, hooks_cursor):
        assert mod._update_state()["installed"] is False, mod.__name__
    results = asyncio.run(hooks_updates.update_plugins())
    assert [r["status"] for r in results] == ["not installed"] * 3
    assert json.loads((oc / "package.json").read_text())["version"] == "1.2.0", "a removed plugin was restaged"
    assert not hooks_cursor.CURSOR_PLUGIN_DIR.exists()


def test_claude_code_needs_its_cache_and_enabled(monkeypatch, temp_home):
    from securevector.app.server.routes import hooks_claude_code as cc
    staging = temp_home / ".securevector" / "staging" / "claude-code-plugin"
    monkeypatch.setattr(cc, "STAGING_DIR", staging)
    _hooks_common.stage_files(staging_dir=staging, source_dir=cc.BUNDLED_PLUGIN_DIR, files=cc.PLUGIN_FILES, substitutions={})
    monkeypatch.setattr(cc, "_claude_install_path", lambda: None)
    monkeypatch.setattr(cc, "_is_enabled_in_claude_settings", lambda: True)
    assert cc._update_state()["installed"] is False
    monkeypatch.setattr(cc, "_claude_install_path", lambda: staging)
    monkeypatch.setattr(cc, "_is_enabled_in_claude_settings", lambda: False)
    assert cc._update_state()["installed"] is False
    monkeypatch.setattr(cc, "_is_enabled_in_claude_settings", lambda: True)
    assert cc._update_state()["installed"] is True


@pytest.mark.parametrize("mod_name,dir_attr", [("hooks_cursor", "CURSOR_PLUGIN_DIR"), ("hooks_antigravity", "ANTIGRAVITY_PLUGIN_DIR")])
def test_installed_copy_with_resolved_root_is_compared(monkeypatch, temp_home, mod_name, dir_attr):
    import shutil
    mod = hooks_updates._module(mod_name)
    staging = temp_home / ".securevector" / "staging" / mod_name
    target = temp_home / "harness" / "securevector-guard"
    monkeypatch.setattr(mod, "STAGING_DIR", staging)
    monkeypatch.setattr(mod, dir_attr, target)
    subs = {"http://127.0.0.1:8741": "http://127.0.0.1:8741", "http://localhost:8741": "http://127.0.0.1:8741"}
    _hooks_common.stage_files(staging_dir=staging, source_dir=mod.BUNDLED_PLUGIN_DIR, files=mod.PLUGIN_FILES, substitutions=subs)
    shutil.copytree(staging, target)
    mod._resolve_root_placeholder(target)
    st = mod._update_state()
    assert st["installed"] and st["files_current"] and not st["update_available"]
    hooks_json = next(p for p in target.rglob("hooks.json"))
    hooks_json.write_text(hooks_json.read_text().replace(str(target), "__SV_PLUGIN_ROOT__"))
    assert mod._update_state()["update_available"] is True


def test_a_second_update_run_gets_409(monkeypatch):
    class Busy:
        def locked(self):
            return True
    monkeypatch.setattr(hooks_updates, "_UPDATE_LOCK", Busy())
    r = _client().post("/api/hooks/update-plugins", headers=PAGE)
    assert r.status_code == 409
    assert r.json()["detail"] == "update already running"


def test_startup_log_names_stale_plugins(monkeypatch, tmp_path, temp_home, caplog):
    _setup_three(monkeypatch, tmp_path, temp_home)
    with caplog.at_level("INFO", logger=hooks_updates.logger.name):
        hooks_updates.log_stale_plugins()
    lines = [r.getMessage() for r in caplog.records if "Plugin updates available" in r.getMessage()]
    assert lines == ["Plugin updates available: opencode 1.2.0 -> 1.3.0. "
                     "Run securevector-app --update-plugins or use Connect Agents."]


# --- CLI ----------------------------------------------------------------------


def _fake_results(results):
    async def fake():
        return results
    return fake


def test_cli_prints_one_line_per_harness_and_exits_zero(monkeypatch, capsys):
    from securevector.app import main
    monkeypatch.setattr(hooks_updates, "update_plugins", _fake_results([
        {"runtime": "openclaw", "before_version": "1.2.0", "after_version": "1.3.0", "status": "updated"},
        {"runtime": "hermes", "before_version": "1.1.0", "after_version": "1.1.0", "status": "current"},
        {"runtime": "codex", "before_version": None, "after_version": None, "status": "not installed"},
    ]))
    assert main._handle_update_plugins() == 0
    out = capsys.readouterr().out.splitlines()
    assert out == ["openclaw  1.2.0 -> 1.3.0  updated", "hermes    current", "codex     not installed"]


def test_cli_exits_one_when_an_update_failed(monkeypatch, capsys):
    from securevector.app import main
    monkeypatch.setattr(hooks_updates, "update_plugins", _fake_results([
        {"runtime": "cursor", "before_version": "5.4.0", "after_version": "5.4.0", "status": "failed", "reason": "disk full"},
        {"runtime": "hermes", "before_version": "1.1.0", "after_version": "1.1.0", "status": "current"},
    ]))
    assert main._handle_update_plugins() == 1
    assert "cursor  5.4.0  failed: disk full" in capsys.readouterr().out


def test_cli_flag_is_wired():
    src = (Path(__file__).resolve().parents[3] / "src" / "securevector" / "app" / "main.py").read_text()
    assert '"--update-plugins"' in src
    assert "sys.exit(_handle_update_plugins())" in src
