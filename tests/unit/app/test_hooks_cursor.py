"""Unit tests for the Cursor plugin install/uninstall/status route.

Cursor's plugin model (cursor.com/docs/plugins): a plugin is a directory with a
``.cursor-plugin/plugin.json`` manifest that bundles its hooks. Local plugins
live at ``~/.cursor/plugins/local/<name>/`` (copied, not symlinked), are listed
in Settings → Plugins, and their bundled ``hooks/hooks.json`` loads
automatically. So one install gives BOTH the plugin entry and the active hooks
— the Claude Code model.

These tests cover: the auto-install path (copy to the local-plugin dir + resolve
the hook-root placeholder), MIGRATION off the legacy global-``hooks.json``
install (so hooks don't double-fire), idempotent reinstall, surgical uninstall,
the Cursor-absent staging-only fallback, and URL substitution.
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from securevector.app.server.routes import hooks_cursor as mod


EXPECTED_FILES = set(mod.PLUGIN_FILES)

EXPECTED_EVENTS = {
    "sessionStart",
    "beforeShellExecution",
    "beforeMCPExecution",
    "afterShellExecution",
    "afterMCPExecution",
    "afterFileEdit",
    "beforeSubmitPrompt",
    "beforeReadFile",
    "stop",
}


@pytest.fixture
def cursor_home(tmp_path, monkeypatch):
    """Point every Cursor path constant at an isolated tmp home that EXISTS
    (so install takes the auto-install branch). The derived constants are
    computed at import from CURSOR_HOME, so each must be patched explicitly."""
    home = tmp_path / ".cursor"
    home.mkdir()
    plugin_dir = home / "plugins" / "local" / mod.PLUGIN_NAME
    staging = tmp_path / ".securevector" / "staging" / "cursor-plugin"
    monkeypatch.setattr(mod, "CURSOR_HOME", home)
    monkeypatch.setattr(mod, "CURSOR_PLUGINS_LOCAL", home / "plugins" / "local")
    monkeypatch.setattr(mod, "CURSOR_PLUGIN_DIR", plugin_dir)
    monkeypatch.setattr(mod, "CURSOR_MANIFEST", plugin_dir / ".cursor-plugin" / "plugin.json")
    monkeypatch.setattr(mod, "CURSOR_HOOKS_JSON", home / "hooks.json")
    monkeypatch.setattr(mod, "LEGACY_INSTALL_ROOT", home / mod.PLUGIN_NAME)
    monkeypatch.setattr(mod, "STAGING_DIR", staging)
    return home


@pytest.fixture
def client(cursor_home):
    app = FastAPI()
    app.include_router(mod.router, prefix="/api")
    return TestClient(app)


def _hooks(home):
    return json.loads((home / "hooks.json").read_text())


def test_status_not_installed_fresh(client):
    r = client.get("/api/hooks/cursor/status")
    assert r.status_code == 200
    body = r.json()
    assert body["installed"] is False
    assert body["files_present"] == []
    assert body["cursor_detected"] is True
    assert body["auto_installed"] is False
    assert body["enabled"] is False


def test_install_creates_local_plugin_with_bundled_hooks(client, cursor_home):
    r = client.post("/api/hooks/cursor/install")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["auto_installed"] is True
    assert body["enabled"] is True
    assert set(body["files"]) == EXPECTED_FILES
    assert "Settings → Plugins" in body["next_step"]
    assert "Reload Cursor" in body["next_step"]

    plugin_dir = cursor_home / "plugins" / "local" / mod.PLUGIN_NAME
    # Manifest where Cursor looks for it, and the bundled hook scripts.
    assert (plugin_dir / ".cursor-plugin" / "plugin.json").is_file()
    assert (plugin_dir / "hooks" / "before-shell.js").is_file()

    # The bundled hooks.json has all nine events, the placeholder resolved to
    # the absolute plugin dir (no template residue).
    bundled = json.loads((plugin_dir / "hooks" / "hooks.json").read_text())
    assert bundled["version"] == 1
    assert set(bundled["hooks"].keys()) == EXPECTED_EVENTS
    for event, entries in bundled["hooks"].items():
        assert len(entries) == 1, event
        cmd = entries[0]["command"]
        assert "__SV_PLUGIN_ROOT__" not in cmd
        assert str(plugin_dir) in cmd

    # Install does NOT create a global hooks.json — the plugin owns the hooks.
    assert not (cursor_home / "hooks.json").exists()

    # Status agrees.
    s = client.get("/api/hooks/cursor/status").json()
    assert s["installed"] is True
    assert s["auto_installed"] is True
    assert s["enabled"] is True


def test_install_migrates_off_legacy_global_hooks(client, cursor_home):
    """A machine upgraded from the old global-hooks install must end up with
    the legacy entries + versioned dir GONE (else hooks fire twice), while any
    foreign global-hooks entries survive untouched."""
    legacy_root = cursor_home / mod.PLUGIN_NAME / "4.5.0"
    legacy_root.mkdir(parents=True)
    (legacy_root / "marker").write_text("old")
    pristine = {
        "version": 1,
        "hooks": {
            "beforeShellExecution": [
                {"command": "/usr/local/bin/my-own-hook.sh", "timeout": 5},
                {"command": f"node \"{cursor_home}/securevector-guard/4.5.0/hooks/before-shell.js\"", "timeout": 10},
            ],
            "stop": [
                {"command": f"node \"{cursor_home}/securevector-guard/4.5.0/hooks/stop.js\"", "timeout": 10},
            ],
        },
    }
    (cursor_home / "hooks.json").write_text(json.dumps(pristine))

    assert client.post("/api/hooks/cursor/install").status_code == 200

    # Legacy versioned dir gone.
    assert not (cursor_home / mod.PLUGIN_NAME).exists()
    # Legacy global entries stripped; foreign entry preserved; emptied key dropped.
    data = _hooks(cursor_home)
    assert data["hooks"]["beforeShellExecution"] == [
        {"command": "/usr/local/bin/my-own-hook.sh", "timeout": 5}
    ]
    assert "stop" not in data["hooks"]
    # The one-shot backup captured the pre-migration file.
    backup = cursor_home / "hooks.json.before-securevector"
    assert json.loads(backup.read_text()) == pristine

    # And the plugin itself installed.
    assert (cursor_home / "plugins" / "local" / mod.PLUGIN_NAME / ".cursor-plugin" / "plugin.json").is_file()


def test_reinstall_is_idempotent(client, cursor_home):
    """Two installs leave a single clean plugin dir (replaced in place)."""
    assert client.post("/api/hooks/cursor/install").status_code == 200
    assert client.post("/api/hooks/cursor/install").status_code == 200
    plugin_dir = cursor_home / "plugins" / "local" / mod.PLUGIN_NAME
    assert plugin_dir.is_dir()
    # No leftover .tmp staging dir beside it.
    assert not (plugin_dir.parent / (plugin_dir.name + ".tmp")).exists()
    bundled = json.loads((plugin_dir / "hooks" / "hooks.json").read_text())
    for event, entries in bundled["hooks"].items():
        assert len(entries) == 1, f"{event} has {len(entries)} entries"


def test_uninstall_removes_plugin_and_legacy_and_is_idempotent(client, cursor_home):
    # Pre-existing foreign global hook + a legacy SV entry to prove uninstall
    # tears down legacy artifacts too, surgically.
    foreign = {"command": "/usr/local/bin/my-own-hook.sh"}
    (cursor_home / "hooks.json").write_text(json.dumps({
        "version": 1,
        "hooks": {
            "beforeShellExecution": [
                foreign,
                {"command": f"node \"{cursor_home}/securevector-guard/4.5.0/hooks/before-shell.js\""},
            ],
        },
    }))
    assert client.post("/api/hooks/cursor/install").status_code == 200
    assert client.post("/api/hooks/cursor/uninstall").json()["ok"] is True

    # Plugin dir gone.
    assert not (cursor_home / "plugins" / "local" / mod.PLUGIN_NAME).exists()
    # Legacy SV global entry gone, foreign survives.
    data = _hooks(cursor_home)
    assert data["hooks"]["beforeShellExecution"] == [foreign]

    s = client.get("/api/hooks/cursor/status").json()
    assert s["installed"] is False
    assert s["enabled"] is False

    # Second uninstall is a no-op, not an error.
    assert client.post("/api/hooks/cursor/uninstall").json()["ok"] is True


def test_install_without_cursor_stages_only(tmp_path, monkeypatch):
    """When CURSOR_HOME is absent, install stages the tree and reports
    auto_installed=False with guidance, writing nothing else."""
    home = tmp_path / ".cursor"  # NOT created
    plugin_dir = home / "plugins" / "local" / mod.PLUGIN_NAME
    staging = tmp_path / ".securevector" / "staging" / "cursor-plugin"
    monkeypatch.setattr(mod, "CURSOR_HOME", home)
    monkeypatch.setattr(mod, "CURSOR_PLUGINS_LOCAL", home / "plugins" / "local")
    monkeypatch.setattr(mod, "CURSOR_PLUGIN_DIR", plugin_dir)
    monkeypatch.setattr(mod, "CURSOR_MANIFEST", plugin_dir / ".cursor-plugin" / "plugin.json")
    monkeypatch.setattr(mod, "CURSOR_HOOKS_JSON", home / "hooks.json")
    monkeypatch.setattr(mod, "LEGACY_INSTALL_ROOT", home / mod.PLUGIN_NAME)
    monkeypatch.setattr(mod, "STAGING_DIR", staging)
    app = FastAPI()
    app.include_router(mod.router, prefix="/api")
    client = TestClient(app)

    r = client.post("/api/hooks/cursor/install")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["auto_installed"] is False
    assert body["enabled"] is False
    assert "not detected" in body["next_step"]
    assert (staging / "hooks" / "hooks.json").is_file()
    assert not home.exists()


def test_staged_files_carry_substituted_url(client, cursor_home):
    """stage_files rewrites the default loopback URL in every staged file (here
    the resolved URL IS the default, so the default survives staging — the
    substitution plumbing itself is covered by test_hooks_common.py)."""
    assert client.post("/api/hooks/cursor/install").status_code == 200
    staged = (mod.STAGING_DIR / "lib" / "client.js").read_text()
    assert "http://127.0.0.1:" in staged
