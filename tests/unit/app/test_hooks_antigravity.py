"""Unit tests for the Antigravity plugin install/uninstall/status route.

Antigravity's plugin model is discovery by DIRECTORY: a folder under
``~/.gemini/config/plugins/<name>/`` holding a ``plugin.json`` marker and,
beside it, an optional ``hooks.json`` the loader picks up. The first-party docs
name no registry file recording installed or enabled plugins, so, unlike
Copilot CLI (``config.json`` ``installedPlugins[]``) or Codex (a TOML table),
this route writes none and treats presence as enabled. These tests pin that
shape, and would be the first thing to change if a registry is later confirmed
against a live ``agy``.

The other thing pinned here is the hook-root substitution. Antigravity
documents no plugin-root environment variable for a hook command (Claude
Code's ``${CLAUDE_PLUGIN_ROOT}`` has no counterpart), so the installer
rewrites a ``__SV_PLUGIN_ROOT__`` placeholder to the absolute installed path.
If that substitution silently stops happening, every hook command points at a
literal placeholder directory and the Guard is inert while still reporting
itself installed, which is the worst failure a security plugin can have.

Contract verified against antigravity.google/docs/{hooks,plugins,sdk/tools}
on 2026-09-21. NOT yet verified against a live `agy` CLI; see the plugin
README for the resulting open questions.
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from securevector.app.server.routes import hooks_antigravity as mod
from securevector.app.terminals.auth import TerminalAuth

# The install and uninstall routes require a loopback Host and a MATCHING
# Origin, so these tests have to present what the app's own page presents.
# Reads (status) need nothing.
PAGE_HEADERS = {"host": "127.0.0.1:8741", "origin": "http://127.0.0.1:8741"}

EXPECTED_FILES = {
    "plugin.json",
    "hooks.json",
    "hooks/pre-tool-use.js",
    "hooks/post-tool-use.js",
    "hooks/pre-invocation.js",
    "lib/normalize.js",
    "lib/client.js",
    "lib/redact.js",
    "LICENSE",
    "README.md",
    "PRIVACY.md",
}


@pytest.fixture
def gemini_home(tmp_path, monkeypatch):
    """Point the staging and install paths at an isolated tmp tree and force
    the "Antigravity detected" branch so install takes the copying path."""
    home = tmp_path / ".gemini"
    plugins_dir = home / "config" / "plugins"
    plugins_dir.mkdir(parents=True)
    staging = tmp_path / ".securevector" / "staging" / "antigravity-plugin"

    monkeypatch.setattr(mod, "STAGING_DIR", staging)
    monkeypatch.setattr(mod, "GEMINI_HOME", home)
    monkeypatch.setattr(mod, "ANTIGRAVITY_PLUGINS_DIR", plugins_dir)
    monkeypatch.setattr(mod, "ANTIGRAVITY_PLUGIN_DIR", plugins_dir / mod.PLUGIN_NAME)
    monkeypatch.setattr(
        mod, "ANTIGRAVITY_MANIFEST", plugins_dir / mod.PLUGIN_NAME / "plugin.json"
    )
    # The traversal guard resolves against the real home; allow the tmp tree.
    monkeypatch.setattr(mod.Path, "home", staticmethod(lambda: tmp_path))
    return home


@pytest.fixture
def client(gemini_home):
    app = FastAPI()
    app.include_router(mod.router, prefix="/api")
    app.state.terminal_auth = TerminalAuth(token="t" * 48, port=8741)
    return TestClient(app)


def test_install_stages_every_plugin_file(client):
    r = client.post("/api/hooks/antigravity/install", headers=PAGE_HEADERS)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert set(body["files"]) == EXPECTED_FILES
    for name in EXPECTED_FILES:
        assert (mod.STAGING_DIR / name).is_file(), f"{name} was not staged"


def test_install_ships_license_and_privacy(client):
    """A plugin that installs without its LICENSE and PRIVACY.md is not
    distributable. Both must be in PLUGIN_FILES, not merely in the repo."""
    assert "LICENSE" in mod.PLUGIN_FILES
    assert "PRIVACY.md" in mod.PLUGIN_FILES
    client.post("/api/hooks/antigravity/install", headers=PAGE_HEADERS)
    assert (mod.STAGING_DIR / "LICENSE").is_file()
    assert (mod.STAGING_DIR / "PRIVACY.md").is_file()


def test_install_copies_tree_into_the_plugins_dir(client):
    r = client.post("/api/hooks/antigravity/install", headers=PAGE_HEADERS)
    body = r.json()
    assert body["auto_installed"] is True
    assert body["enabled"] is True
    assert body["install_path"] == str(mod.ANTIGRAVITY_PLUGIN_DIR)
    for name in EXPECTED_FILES:
        assert (mod.ANTIGRAVITY_PLUGIN_DIR / name).is_file(), f"{name} not installed"


def test_install_resolves_the_hook_root_placeholder(client):
    """The installed hooks.json must name the absolute installed directory.

    A surviving `__SV_PLUGIN_ROOT__` would leave every hook command pointing at
    a path that does not exist, so the Guard would be inert while status still
    said installed.
    """
    client.post("/api/hooks/antigravity/install", headers=PAGE_HEADERS)
    text = (mod.ANTIGRAVITY_PLUGIN_DIR / "hooks.json").read_text()
    assert mod._ROOT_PLACEHOLDER not in text
    hooks = json.loads(text)["securevector-guard"]
    assert hooks["enabled"] is True
    commands = [
        h["command"]
        for event in ("PreToolUse", "PostToolUse", "PreInvocation")
        for entry in hooks[event]
        for h in entry["hooks"]
    ]
    assert len(commands) == 3
    for cmd in commands:
        assert str(mod.ANTIGRAVITY_PLUGIN_DIR) in cmd, cmd


def test_installed_hooks_register_the_three_documented_events(client):
    """PreToolUse enforces, PostToolUse audits, PreInvocation opens the
    session. PostInvocation and Stop are deliberately unregistered."""
    client.post("/api/hooks/antigravity/install", headers=PAGE_HEADERS)
    hooks = json.loads((mod.ANTIGRAVITY_PLUGIN_DIR / "hooks.json").read_text())
    assert set(hooks) == {"securevector-guard"}
    events = set(hooks["securevector-guard"]) - {"enabled"}
    assert events == {"PreToolUse", "PostToolUse", "PreInvocation"}


def test_install_substitutes_the_local_app_url(client, monkeypatch):
    """Staging rewrites the default loopback URL to the app's actual port, or
    every hook posts its audit rows into the void on a relocated install."""
    monkeypatch.setattr(mod._hooks_common, "resolve_sv_url", lambda: "http://127.0.0.1:9911")
    client.post("/api/hooks/antigravity/install", headers=PAGE_HEADERS)
    hook = (mod.ANTIGRAVITY_PLUGIN_DIR / "hooks" / "pre-tool-use.js").read_text()
    assert "http://127.0.0.1:9911" in hook
    assert "http://127.0.0.1:8741" not in hook


def test_install_is_idempotent(client):
    client.post("/api/hooks/antigravity/install", headers=PAGE_HEADERS)
    r = client.post("/api/hooks/antigravity/install", headers=PAGE_HEADERS)
    assert r.status_code == 200
    # No `.tmp` sibling left behind, and exactly one plugin directory.
    entries = sorted(p.name for p in mod.ANTIGRAVITY_PLUGINS_DIR.iterdir())
    assert entries == [mod.PLUGIN_NAME]


def test_install_preserves_sibling_plugins(client):
    """Another plugin's directory must survive install and uninstall."""
    sibling = mod.ANTIGRAVITY_PLUGINS_DIR / "someone-elses-plugin"
    sibling.mkdir(parents=True)
    (sibling / "plugin.json").write_text('{"name": "someone-elses-plugin"}')

    client.post("/api/hooks/antigravity/install", headers=PAGE_HEADERS)
    assert (sibling / "plugin.json").is_file()
    client.post("/api/hooks/antigravity/uninstall", headers=PAGE_HEADERS)
    assert (sibling / "plugin.json").is_file()


def test_status_reports_installed_and_enabled(client):
    before = client.get("/api/hooks/antigravity/status").json()
    assert before["installed"] is False
    assert before["enabled"] is False
    assert before["antigravity_detected"] is True

    client.post("/api/hooks/antigravity/install", headers=PAGE_HEADERS)
    after = client.get("/api/hooks/antigravity/status").json()
    assert after["installed"] is True
    assert after["auto_installed"] is True
    assert after["enabled"] is True
    assert set(after["files_present"]) == EXPECTED_FILES


def test_uninstall_removes_both_copies_and_is_idempotent(client):
    client.post("/api/hooks/antigravity/install", headers=PAGE_HEADERS)
    assert mod.ANTIGRAVITY_PLUGIN_DIR.is_dir()

    r = client.post("/api/hooks/antigravity/uninstall", headers=PAGE_HEADERS)
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert not mod.ANTIGRAVITY_PLUGIN_DIR.exists()
    assert not mod.STAGING_DIR.exists()

    # Second call on a clean machine must not raise.
    assert client.post("/api/hooks/antigravity/uninstall", headers=PAGE_HEADERS).status_code == 200


def test_install_stages_only_when_antigravity_is_absent(client, monkeypatch, tmp_path):
    """No ~/.gemini means stage and hand back the documented install command,
    rather than creating a directory tree for a product that is not there."""
    monkeypatch.setattr(mod, "GEMINI_HOME", tmp_path / "no-such-gemini-home")
    r = client.post("/api/hooks/antigravity/install", headers=PAGE_HEADERS)
    body = r.json()
    assert body["ok"] is True
    assert body["auto_installed"] is False
    assert body["enabled"] is False
    assert body["commands"] == [f"agy plugin install {mod.STAGING_DIR}"]


def test_writes_outside_the_allowed_roots_are_refused(tmp_path, monkeypatch):
    """Defence in depth on the one function that removes and replaces a
    directory tree."""
    monkeypatch.setattr(mod.Path, "home", staticmethod(lambda: tmp_path))
    with pytest.raises(PermissionError):
        mod._assert_within_allowed_roots(tmp_path / "somewhere" / "else")
    # Both allowed roots pass.
    mod._assert_within_allowed_roots(tmp_path / ".gemini" / "config" / "plugins" / "x")
    mod._assert_within_allowed_roots(tmp_path / ".securevector" / "staging" / "x")


def test_plugin_tree_intact_on_disk():
    """Every file the install handler stages must exist in source, or install
    quietly ships a partial plugin."""
    from pathlib import Path

    tree = Path(__file__).resolve().parents[3] / "src" / "securevector" / "plugins" / "antigravity"
    for rel in mod.PLUGIN_FILES:
        assert (tree / rel).is_file(), f"missing Antigravity plugin file: {rel}"
