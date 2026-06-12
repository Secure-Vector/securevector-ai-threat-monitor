"""Unit tests for the GitHub Copilot CLI plugin install/uninstall/status route.

Covers the auto-install path (write directly into Copilot's store +
``config.json`` registry, enabled) and the CLI-absent staging-only fallback,
plus JSONC header / sibling-plugin preservation and idempotency — parity with
``test_hooks_claude_code.py``.

Copilot's on-disk layout (verified against CLI v1.0.60):
  * files → ``<COPILOT_HOME>/installed-plugins/_direct/copilot-cli-plugin/``
  * registry → ``<COPILOT_HOME>/config.json`` (JSONC) → ``installedPlugins[]``
"""

from __future__ import annotations

import json
import re

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from securevector.app.server.routes import hooks_copilot_cli as mod


EXPECTED_FILES = {
    "plugin.json",
    "hooks/hooks.json",
    "hooks/pre-tool-use.js",
    "hooks/post-tool-use.js",
    "hooks/user-prompt-submit.js",
    "hooks/session-start.js",
    "lib/normalize.js",
    "lib/client.js",
    "lib/redact.js",
    "LICENSE",
    "README.md",
    "PRIVACY.md",
}


def _read_config(path):
    """Parse Copilot's JSONC config.json (strip leading // comment lines)."""
    raw = path.read_text()
    body = "\n".join(l for l in raw.splitlines() if not l.strip().startswith("//"))
    return json.loads(body)


@pytest.fixture
def copilot_home(tmp_path, monkeypatch):
    """Point every Copilot path constant at an isolated tmp home that EXISTS
    (so install takes the auto-install branch). Staging is also isolated."""
    home = tmp_path / ".copilot"
    home.mkdir()
    staging = tmp_path / ".securevector" / "staging" / "copilot-cli-plugin"
    monkeypatch.setattr(mod, "COPILOT_HOME", home)
    monkeypatch.setattr(mod, "COPILOT_CONFIG_JSON", home / "config.json")
    monkeypatch.setattr(
        mod, "COPILOT_CACHE_DIR",
        home / "installed-plugins" / "_direct" / "copilot-cli-plugin",
    )
    monkeypatch.setattr(
        mod, "COPILOT_PLUGIN_DATA_DIR",
        home / "plugin-data" / "_direct" / "securevector-guard",
    )
    monkeypatch.setattr(mod, "STAGING_DIR", staging)
    return home


@pytest.fixture
def client(copilot_home):
    app = FastAPI()
    app.include_router(mod.router, prefix="/api")
    return TestClient(app)


def test_status_not_installed_fresh(client):
    r = client.get("/api/hooks/copilot-cli/status")
    assert r.status_code == 200
    body = r.json()
    assert body["installed"] is False
    assert body["auto_installed"] is False
    assert body["enabled"] is False
    assert body["copilot_detected"] is True  # tmp home exists


def test_install_auto_installs_and_enables(client, copilot_home):
    r = client.post("/api/hooks/copilot-cli/install")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["auto_installed"] is True
    assert body["enabled"] is True
    assert body["commands"] == []  # no paste-in command on the auto path
    assert set(body["files"]) == EXPECTED_FILES

    # Files copied into Copilot's store.
    cache = copilot_home / "installed-plugins" / "_direct" / "copilot-cli-plugin"
    assert (cache / "plugin.json").is_file()
    assert (cache / "hooks" / "pre-tool-use.js").is_file()

    # Registered + enabled in config.json.
    cfg = _read_config(copilot_home / "config.json")
    entries = [p for p in cfg["installedPlugins"] if p["name"] == "securevector-guard"]
    assert len(entries) == 1
    assert entries[0]["enabled"] is True
    assert entries[0]["cache_path"] == str(cache)


def test_install_preserves_jsonc_header_and_siblings(client, copilot_home):
    # Pre-seed a config.json with the managed comment header + another plugin.
    cfg_path = copilot_home / "config.json"
    cfg_path.write_text(
        "// User settings belong in settings.json.\n"
        "// This file is managed automatically.\n"
        '{\n  "installedPlugins": [\n'
        '    {"name": "someone-else", "enabled": true}\n'
        '  ],\n  "firstLaunchAt": "2026-03-11T00:00:00.000Z"\n}\n'
    )
    client.post("/api/hooks/copilot-cli/install")

    raw = cfg_path.read_text()
    # Comment header preserved.
    assert raw.splitlines()[0].startswith("//")
    cfg = _read_config(cfg_path)
    names = {p["name"] for p in cfg["installedPlugins"]}
    assert names == {"someone-else", "securevector-guard"}  # sibling untouched
    assert cfg["firstLaunchAt"] == "2026-03-11T00:00:00.000Z"  # field preserved


def test_install_writes_one_shot_backup(client, copilot_home):
    cfg_path = copilot_home / "config.json"
    cfg_path.write_text('{\n  "installedPlugins": []\n}\n')
    client.post("/api/hooks/copilot-cli/install")
    backup = cfg_path.with_suffix(".json.before-securevector")
    assert backup.exists()
    # One-shot: a reinstall must not clobber the pristine snapshot.
    first = backup.read_text()
    client.post("/api/hooks/copilot-cli/install")
    assert backup.read_text() == first


def test_install_is_idempotent_single_entry(client, copilot_home):
    client.post("/api/hooks/copilot-cli/install")
    client.post("/api/hooks/copilot-cli/install")
    cfg = _read_config(copilot_home / "config.json")
    entries = [p for p in cfg["installedPlugins"] if p["name"] == "securevector-guard"]
    assert len(entries) == 1  # upsert, not append


def test_status_reflects_auto_installed_after_install(client):
    client.post("/api/hooks/copilot-cli/install")
    body = client.get("/api/hooks/copilot-cli/status").json()
    assert body["auto_installed"] is True
    assert body["enabled"] is True
    assert body["installed"] is True


def test_uninstall_deregisters_and_removes_store(client, copilot_home):
    client.post("/api/hooks/copilot-cli/install")
    r = client.post("/api/hooks/copilot-cli/uninstall")
    assert r.status_code == 200
    assert r.json()["ok"] is True

    cfg = _read_config(copilot_home / "config.json")
    assert all(p["name"] != "securevector-guard" for p in cfg["installedPlugins"])
    cache = copilot_home / "installed-plugins" / "_direct" / "copilot-cli-plugin"
    assert not cache.exists()


def test_uninstall_preserves_other_plugins(client, copilot_home):
    cfg_path = copilot_home / "config.json"
    cfg_path.write_text(
        '{\n  "installedPlugins": [\n'
        '    {"name": "someone-else", "enabled": true}\n  ]\n}\n'
    )
    client.post("/api/hooks/copilot-cli/install")
    client.post("/api/hooks/copilot-cli/uninstall")
    cfg = _read_config(cfg_path)
    names = {p["name"] for p in cfg["installedPlugins"]}
    assert names == {"someone-else"}  # sibling survives our uninstall


def test_uninstall_is_idempotent(client):
    r1 = client.post("/api/hooks/copilot-cli/uninstall")
    r2 = client.post("/api/hooks/copilot-cli/uninstall")
    assert r1.json()["ok"] is True
    assert r2.json()["ok"] is True


def test_install_fallback_when_copilot_absent(tmp_path, monkeypatch):
    """When COPILOT_HOME doesn't exist, install stages only + returns the
    documented `copilot plugin install <dir>` command (auto_installed False)."""
    missing_home = tmp_path / "no-copilot"
    staging = tmp_path / ".securevector" / "staging" / "copilot-cli-plugin"
    monkeypatch.setattr(mod, "COPILOT_HOME", missing_home)
    monkeypatch.setattr(mod, "STAGING_DIR", staging)
    app = FastAPI()
    app.include_router(mod.router, prefix="/api")
    c = TestClient(app)

    body = c.post("/api/hooks/copilot-cli/install").json()
    assert body["ok"] is True
    assert body["auto_installed"] is False
    assert body["enabled"] is False
    assert len(body["commands"]) == 1
    assert body["commands"][0].startswith("copilot plugin install ")
    assert not missing_home.exists()  # we never created Copilot's home
