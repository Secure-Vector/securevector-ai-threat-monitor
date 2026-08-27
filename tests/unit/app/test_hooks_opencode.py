"""Unit tests for the OpenCode plugin install/uninstall/status route.

OpenCode is the only harness whose plugin is an IN-PROCESS ES module rather
than a set of subprocess hooks, so its install shape differs from every
sibling and these tests pin that difference:

  * there is no host "store" to copy into — the staged directory IS the
    installed plugin, because OpenCode imports it in place;
  * registration is one absolute path appended to the ``plugin`` array in
    ``~/.config/opencode/opencode.json``, and presence in that array IS
    enablement (there is no per-entry ``enabled`` flag);
  * the config may be JSONC, and every unrelated key (``$schema``, ``model``,
    ``provider``, other plugins) must survive install AND uninstall.

Verified against opencode 1.18.23 (anomalyco/opencode).
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from securevector.app.server.routes import hooks_opencode as mod


EXPECTED_FILES = {
    "package.json",
    "index.js",
    "lib/normalize.js",
    "lib/decide.js",
    "lib/client.js",
    "lib/redact.js",
    "LICENSE",
    "README.md",
    "PRIVACY.md",
}


def _read_config(path):
    """Parse an OpenCode config, stripping leading // comment lines (JSONC)."""
    raw = path.read_text()
    body = "\n".join(l for l in raw.splitlines() if not l.strip().startswith("//"))
    return json.loads(body)


@pytest.fixture
def opencode_home(tmp_path, monkeypatch):
    """Point the config/data/staging paths at an isolated tmp tree and force
    the "OpenCode detected" branch so install takes the registering path."""
    cfg_dir = tmp_path / ".config" / "opencode"
    cfg_dir.mkdir(parents=True)
    data_dir = tmp_path / ".local" / "share" / "opencode"
    data_dir.mkdir(parents=True)
    staging = tmp_path / ".securevector" / "staging" / "opencode-plugin"

    monkeypatch.setattr(mod, "STAGING_DIR", staging)
    monkeypatch.setattr(mod, "_opencode_config_dir", lambda: cfg_dir)
    monkeypatch.setattr(mod, "_opencode_config_file", lambda: cfg_dir / "opencode.json")
    monkeypatch.setattr(mod, "_opencode_data_dir", lambda: data_dir)
    monkeypatch.setattr(mod, "_opencode_detected", lambda: True)
    # The traversal guard resolves against the real home; allow the tmp tree.
    monkeypatch.setattr(mod.Path, "home", staticmethod(lambda: tmp_path))
    return cfg_dir


@pytest.fixture
def client(opencode_home):
    app = FastAPI()
    app.include_router(mod.router, prefix="/api")
    return TestClient(app)


def test_install_stages_every_plugin_file(client, opencode_home):
    r = client.post("/api/hooks/opencode/install")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert set(body["files"]) == EXPECTED_FILES
    for name in EXPECTED_FILES:
        assert (mod.STAGING_DIR / name).is_file(), f"{name} was not staged"


def test_install_registers_plugin_path_in_config(client, opencode_home):
    client.post("/api/hooks/opencode/install")
    cfg = _read_config(opencode_home / "opencode.json")
    assert cfg["plugin"] == [str(mod.STAGING_DIR)]


def test_install_is_idempotent_no_duplicate_entry(client, opencode_home):
    client.post("/api/hooks/opencode/install")
    client.post("/api/hooks/opencode/install")
    cfg = _read_config(opencode_home / "opencode.json")
    assert cfg["plugin"] == [str(mod.STAGING_DIR)], "reinstall duplicated the entry"


def test_install_preserves_unrelated_config_and_sibling_plugins(client, opencode_home):
    """A user's model/provider choice and any other plugin must survive."""
    (opencode_home / "opencode.json").write_text(json.dumps({
        "$schema": "https://opencode.ai/config.json",
        "model": "anthropic/claude-sonnet-5",
        "provider": {"anthropic": {"name": "Anthropic"}},
        "plugin": ["some-other-plugin"],
    }, indent=2))
    client.post("/api/hooks/opencode/install")
    cfg = _read_config(opencode_home / "opencode.json")
    assert cfg["$schema"] == "https://opencode.ai/config.json"
    assert cfg["model"] == "anthropic/claude-sonnet-5"
    assert cfg["provider"] == {"anthropic": {"name": "Anthropic"}}
    assert "some-other-plugin" in cfg["plugin"]
    assert str(mod.STAGING_DIR) in cfg["plugin"]


def test_install_preserves_jsonc_comment_header(client, opencode_home):
    cfg_path = opencode_home / "opencode.json"
    cfg_path.write_text('// hand-written config\n// keep me\n{\n  "model": "x"\n}\n')
    client.post("/api/hooks/opencode/install")
    raw = cfg_path.read_text()
    assert raw.startswith("// hand-written config\n// keep me\n"), raw[:80]
    assert _read_config(cfg_path)["model"] == "x"


def test_install_backs_up_pristine_config_once(client, opencode_home):
    cfg_path = opencode_home / "opencode.json"
    cfg_path.write_text('{"model": "original"}')
    backup = cfg_path.with_suffix(cfg_path.suffix + ".before-securevector")
    client.post("/api/hooks/opencode/install")
    assert backup.is_file()
    first = backup.read_text()
    assert json.loads(first)["model"] == "original"
    # A reinstall must NOT clobber the pristine snapshot.
    client.post("/api/hooks/opencode/install")
    assert backup.read_text() == first


def test_status_reports_installed_and_enabled(client, opencode_home):
    before = client.get("/api/hooks/opencode/status").json()
    assert before["installed"] is False
    assert before["enabled"] is False

    client.post("/api/hooks/opencode/install")
    after = client.get("/api/hooks/opencode/status").json()
    assert after["installed"] is True
    assert after["auto_installed"] is True
    assert after["enabled"] is True
    assert after["opencode_detected"] is True
    assert set(after["files_present"]) == EXPECTED_FILES


def test_uninstall_deregisters_and_removes_tree(client, opencode_home):
    client.post("/api/hooks/opencode/install")
    assert mod.STAGING_DIR.is_dir()

    r = client.post("/api/hooks/opencode/uninstall")
    assert r.status_code == 200 and r.json()["ok"] is True
    assert not mod.STAGING_DIR.exists(), "staged tree (the install) was left behind"
    cfg = _read_config(opencode_home / "opencode.json")
    assert str(mod.STAGING_DIR) not in cfg.get("plugin", [])


def test_uninstall_preserves_sibling_plugins(client, opencode_home):
    (opencode_home / "opencode.json").write_text(
        json.dumps({"plugin": ["some-other-plugin"]})
    )
    client.post("/api/hooks/opencode/install")
    client.post("/api/hooks/opencode/uninstall")
    cfg = _read_config(opencode_home / "opencode.json")
    assert cfg["plugin"] == ["some-other-plugin"]


def test_uninstall_is_idempotent(client, opencode_home):
    assert client.post("/api/hooks/opencode/uninstall").json()["ok"] is True
    assert client.post("/api/hooks/opencode/uninstall").json()["ok"] is True


def test_not_detected_falls_back_to_staging_only(client, opencode_home, monkeypatch):
    """With OpenCode absent we still stage, but hand back the manual command
    instead of writing a config for a host that isn't installed."""
    monkeypatch.setattr(mod, "_opencode_detected", lambda: False)
    body = client.post("/api/hooks/opencode/install").json()
    assert body["ok"] is True
    assert body["auto_installed"] is False
    assert body["enabled"] is False
    assert body["commands"], "expected a manual install command"
    assert "opencode plugin" in body["commands"][0]
    assert not (opencode_home / "opencode.json").exists()


def test_malformed_config_is_refused_not_overwritten(client, opencode_home):
    """A config we cannot parse must abort the install rather than be
    clobbered — the user's file is not ours to destroy."""
    cfg_path = opencode_home / "opencode.json"
    cfg_path.write_text("{ this is not json ")
    r = client.post("/api/hooks/opencode/install")
    assert r.status_code == 500
    assert cfg_path.read_text() == "{ this is not json "


def test_spec_matches_staging_handles_url_and_pair_forms():
    """OpenCode normalises path specs to file:// URLs and allows a
    ``[spec, options]`` pair, so dedup/removal must recognise both."""
    staged = str(mod.STAGING_DIR)
    assert mod._spec_matches_staging(staged)
    assert mod._spec_matches_staging(staged + "/")
    assert mod._spec_matches_staging(mod.Path(staged).as_uri())
    assert mod._spec_matches_staging([staged, {"some": "option"}])
    assert not mod._spec_matches_staging("some-other-plugin")
    assert not mod._spec_matches_staging(None)


def test_atomic_write_refuses_path_outside_allowed_roots(tmp_path, monkeypatch):
    """A hostile $OPENCODE_CONFIG must not turn the installer into an
    arbitrary-file writer."""
    monkeypatch.setattr(mod.Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setattr(mod, "_opencode_config_dir", lambda: tmp_path / ".config" / "opencode")
    outside = tmp_path / "evil" / "passwd"
    outside.parent.mkdir(parents=True)
    with pytest.raises(PermissionError):
        mod._atomic_write_config(outside, {"x": 1}, [])
