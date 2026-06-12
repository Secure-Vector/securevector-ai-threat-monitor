"""Unit tests for the Claude Code plugin install/uninstall/status route.

Verifies the install flow stages the canonical 7-file plugin tree, returns
the two paste-in commands, substitutes the local-app URL, and that the
status + uninstall paths are idempotent.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from fastapi import FastAPI

from securevector.app.server.routes import hooks_claude_code


# Expected files the install path must stage. Must match the canonical
# plugin tree assembled in Task 10 (.claude-plugin/, hooks/, lib/, README).
EXPECTED_FILES = {
    ".claude-plugin/plugin.json",
    "hooks/hooks.json",
    "hooks/pre-tool-use.js",
    "hooks/post-tool-use.js",
    "hooks/user-prompt-submit.js",
    "hooks/session-start.js",
    "hooks/statusline.js",
    "lib/normalize.js",
    "lib/client.js",
    "lib/redact.js",
    "README.md",
    "LICENSE",
    "PRIVACY.md",
}


@pytest.fixture
def app(tmp_path, monkeypatch):
    """Wire the router into a fresh FastAPI app + isolate staging to tmp."""
    staging = tmp_path / "staging" / "claude-code-plugin"
    monkeypatch.setattr(hooks_claude_code, "STAGING_DIR", staging)
    instance = FastAPI()
    instance.include_router(hooks_claude_code.router, prefix="/api")
    return instance


@pytest.fixture
def client(app):
    return TestClient(app)


def test_status_returns_not_installed_on_fresh_start(client):
    r = client.get("/api/hooks/claude-code/status")
    assert r.status_code == 200
    body = r.json()
    assert body["installed"] is False
    assert body["files_present"] == []
    assert isinstance(body["staging_dir"], str)


def test_install_stages_all_plugin_files(client):
    r = client.post("/api/hooks/claude-code/install")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert set(body["files"]) == EXPECTED_FILES, f"got {body['files']}"


def test_install_returns_two_paste_in_commands(client):
    r = client.post("/api/hooks/claude-code/install")
    commands = r.json()["commands"]
    assert len(commands) == 2
    assert commands[0].startswith("/plugin marketplace add ")
    assert commands[1] == "/plugin install securevector-guard"


def test_status_reports_installed_after_install(client):
    client.post("/api/hooks/claude-code/install")
    r = client.get("/api/hooks/claude-code/status")
    body = r.json()
    assert body["installed"] is True
    assert set(body["files_present"]) == EXPECTED_FILES


def test_install_substitutes_local_app_url(client, monkeypatch):
    monkeypatch.setattr(
        hooks_claude_code._hooks_common,
        "resolve_sv_url",
        lambda: "http://127.0.0.1:9999",
    )
    client.post("/api/hooks/claude-code/install")
    # Any file that legitimately contains the placeholder URL should have
    # been substituted. The plugin.json + README are the natural carriers
    # (env / docs); the JS handlers read from env, so they don't carry it.
    # Inspect README — it documents the default URL and should be patched.
    staging = hooks_claude_code.STAGING_DIR
    readme = (staging / "README.md").read_text()
    # The substitution should leave NO 127.0.0.1:8741 in the staged README:
    assert "127.0.0.1:8741" not in readme, (
        "URL substitution failed — staged README still contains the bundled-default URL"
    )
    assert "127.0.0.1:9999" in readme, "expected resolved URL to appear in staged README"


def test_uninstall_removes_staged_tree(client):
    client.post("/api/hooks/claude-code/install")
    r = client.post("/api/hooks/claude-code/uninstall")
    assert r.status_code == 200
    assert r.json()["ok"] is True

    status = client.get("/api/hooks/claude-code/status").json()
    assert status["installed"] is False
    assert status["files_present"] == []


def test_uninstall_is_idempotent(client):
    # Calling uninstall twice in a row (or with nothing installed) must not error.
    r1 = client.post("/api/hooks/claude-code/uninstall")
    r2 = client.post("/api/hooks/claude-code/uninstall")
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json()["ok"] is True
    assert r2.json()["ok"] is True


# ─────────────────────────────────────────────────────────────────────────
# _backup_once — one-shot pristine-state snapshot
#   (parity with hooks_codex._backup_config_toml_once)
# ─────────────────────────────────────────────────────────────────────────


def test_backup_once_writes_pristine_snapshot(tmp_path):
    """First mutation must drop a `<file>.before-securevector` snapshot
    so the user can fully revert their CC config to the pre-SecureVector
    state. Three CC files (installed_plugins.json + known_marketplaces.json
    + settings.json) all run through this same helper."""
    f = tmp_path / "installed_plugins.json"
    f.write_text('{"plugins": {"some-other-plugin": []}}\n')

    hooks_claude_code._backup_once(f)

    backup = f.with_suffix(f.suffix + ".before-securevector")
    assert backup.exists()
    assert backup.read_text() == f.read_text()


def test_backup_once_does_not_clobber_existing_backup(tmp_path):
    """Reinstalls / upgrades must NOT overwrite the pristine backup with
    a current mid-installed snapshot — that would defeat the recovery
    purpose. The backup is one-shot per file."""
    f = tmp_path / "settings.json"
    f.write_text('{"enabledPlugins": {}}\n')
    backup = f.with_suffix(f.suffix + ".before-securevector")
    backup.write_text('{"enabledPlugins": {}}\n')

    # Simulate a reinstall — file has been mutated since first install.
    f.write_text('{"enabledPlugins": {"securevector-guard@securevector-local": true}}\n')

    hooks_claude_code._backup_once(f)

    assert backup.read_text() == '{"enabledPlugins": {}}\n', (
        "must preserve the pristine snapshot across reinstalls"
    )


def test_backup_once_no_op_when_source_missing(tmp_path):
    """No prior file → no backup. An empty backup would be misleading
    (suggests something was there to restore)."""
    f = tmp_path / "missing.json"

    hooks_claude_code._backup_once(f)  # must not raise

    backup = f.with_suffix(f.suffix + ".before-securevector")
    assert not backup.exists()
