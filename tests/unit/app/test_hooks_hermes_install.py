"""Install, uninstall and status for the Hermes cost plugin. Every test runs
against a temp HOME; the real ~/.hermes is never read or written."""

from __future__ import annotations

import os

import pytest
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

from securevector.app.server.routes import hooks_hermes as mod
from securevector.app.terminals.auth import TerminalAuth

PAGE_HEADERS = {"host": "127.0.0.1:8741", "origin": "http://127.0.0.1:8741"}


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("HERMES_HOME", raising=False)
    monkeypatch.setattr(mod.Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setattr(mod._hooks_common, "resolve_sv_url", lambda: "http://127.0.0.1:8741")
    (tmp_path / ".hermes").mkdir()
    assert mod._hermes_home() == tmp_path / ".hermes"
    return tmp_path / ".hermes"


@pytest.fixture
def client(home):
    app = FastAPI()
    app.include_router(mod.router, prefix="/api")
    app.state.terminal_auth = TerminalAuth(token="t" * 48, port=8741)
    return TestClient(app)


def _install(client):
    r = client.post("/api/hooks/hermes/install", headers=PAGE_HEADERS)
    assert r.status_code == 200, r.text
    return r.json()


def _cfg(home):
    return yaml.safe_load((home / "config.yaml").read_text())


def test_fresh_install_copies_plugin_and_enables_it(client, home):
    body = _install(client)
    assert body["ok"] and body["enabled"] and body["auto_installed"]
    target = home / "plugins" / "securevector"
    assert sorted(p.name for p in target.iterdir()) == sorted(mod.PLUGIN_FILES)
    assert yaml.safe_load((target / "plugin.yaml").read_text())["name"] == "securevector"
    assert _cfg(home)["plugins"]["enabled"] == ["securevector"]
    st = client.get("/api/hooks/hermes/status").json()
    assert st["installed"] and st["enabled"] and not st["disabled_in_config"]


def test_existing_config_with_other_plugins_keeps_everything(client, home):
    original = (
        "# my hermes config\n"
        "model:\n"
        "  default: claude-haiku-4-5  # fast\n"
        "plugins:\n"
        "  # plugins I use\n"
        "  enabled:\n"
        "    - disk-cleanup\n"
        "    - \"image_gen/openai\"\n"
        "  disabled:\n"
        "    - securevector\n"
        "    - old-thing\n"
        "display:\n"
        "  skin: default\n"
    )
    (home / "config.yaml").write_text(original)
    _install(client)
    text = (home / "config.yaml").read_text()
    assert "# my hermes config" in text and "# plugins I use" in text and "# fast" in text
    cfg = yaml.safe_load(text)
    assert cfg["plugins"]["enabled"] == ["disk-cleanup", "image_gen/openai", "securevector"]
    assert cfg["plugins"]["disabled"] == ["old-thing"]
    assert cfg["model"] == {"default": "claude-haiku-4-5"} and cfg["display"] == {"skin": "default"}
    backup = home / "config.yaml.before-securevector"
    assert backup.read_text() == original


@pytest.mark.parametrize("original, expected", [
    ("model: x\n", ["securevector"]),
    ("plugins: {}\n", ["securevector"]),
    ("plugins:\n  enabled: []\n  disabled: []\n", ["securevector"]),
    ("plugins:\n  enabled: [a, 'b']\n", ["a", "b", "securevector"]),
    ("plugins:\n  disabled: []\n", ["securevector"]),
    ("plugins:\n  enabled:\n  - a\n  disabled: []\n", ["a", "securevector"]),
])
def test_config_shapes(client, home, original, expected):
    (home / "config.yaml").write_text(original)
    _install(client)
    assert _cfg(home)["plugins"]["enabled"] == expected


def test_install_is_idempotent(client, home):
    (home / "config.yaml").write_text("plugins:\n  enabled:\n    - a\n")
    _install(client)
    first = (home / "config.yaml").read_text()
    _install(client)
    assert (home / "config.yaml").read_text() == first
    assert _cfg(home)["plugins"]["enabled"] == ["a", "securevector"]


def test_uninstall_removes_only_ours(client, home):
    (home / "config.yaml").write_text("plugins:\n  enabled:\n    - a\n")
    other = home / "plugins" / "other"
    other.mkdir(parents=True)
    (other / "plugin.yaml").write_text("name: other\n")
    _install(client)
    r = client.post("/api/hooks/hermes/uninstall", headers=PAGE_HEADERS)
    assert r.status_code == 200 and r.json()["ok"]
    assert not (home / "plugins" / "securevector").exists()
    assert other.is_dir()
    assert _cfg(home)["plugins"]["enabled"] == ["a"]
    # Idempotent.
    assert client.post("/api/hooks/hermes/uninstall", headers=PAGE_HEADERS).status_code == 200
    st = client.get("/api/hooks/hermes/status").json()
    assert not st["installed"] and not st["enabled"]


def test_uninstall_of_the_only_entry_leaves_an_empty_list(client, home):
    _install(client)
    client.post("/api/hooks/hermes/uninstall", headers=PAGE_HEADERS)
    assert _cfg(home)["plugins"]["enabled"] == []


def test_refuses_a_symlinked_plugin_dir_outside_hermes_home(client, home, tmp_path):
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (home / "plugins").mkdir()
    os.symlink(outside, home / "plugins" / "securevector")
    r = client.post("/api/hooks/hermes/install", headers=PAGE_HEADERS)
    assert r.status_code == 400
    assert list(outside.iterdir()) == []


def test_refuses_a_symlinked_config(client, home, tmp_path):
    real = tmp_path / "real.yaml"
    real.write_text("model: x\n")
    os.symlink(real, home / "config.yaml")
    r = client.post("/api/hooks/hermes/install", headers=PAGE_HEADERS)
    assert r.status_code == 400
    assert real.read_text() == "model: x\n"


def test_installs_into_hermes_home_outside_the_user_home(client, home, tmp_path, monkeypatch):
    # HERMES_HOME is where Hermes itself loads plugins from, wherever it is.
    monkeypatch.setattr(mod.Path, "home", staticmethod(lambda: tmp_path / "user"))
    (tmp_path / "user").mkdir()
    opt_home = tmp_path / "opt" / "x" / "homes" / "hermes"
    opt_home.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(opt_home))
    body = _install(client)
    assert body["ok"] is True
    assert body["install_path"] == str(opt_home / "plugins" / "securevector")
    assert (opt_home / "plugins" / "securevector" / "plugin.yaml").is_file()
    assert _cfg(opt_home)["plugins"]["enabled"] == ["securevector"]
    assert not (tmp_path / "user" / ".hermes").exists()
    assert mod._hermes_state_db() == opt_home / "state.db"


def test_hermes_home_resolution_matches_hermes(home, tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", "   ")
    assert mod._hermes_home() == home  # blank falls back to the default
    monkeypatch.setenv("HERMES_HOME", f"  {tmp_path / 'h'}  ")
    assert mod._hermes_home() == tmp_path / "h"
    assert mod._allowed_roots() == [(tmp_path / "h").resolve()]


def test_install_with_hermes_home_never_writes_outside_it(client, home, tmp_path, monkeypatch):
    other = tmp_path / "other-home"
    other.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(other))
    with pytest.raises(mod.HTTPException):
        mod._check_target(home / "config.yaml")


def test_refuses_a_symlinked_hermes_home_from_the_env(client, home, tmp_path, monkeypatch):
    real = tmp_path / "real-opt"
    real.mkdir()
    link = tmp_path / "opt-link"
    os.symlink(real, link)
    monkeypatch.setenv("HERMES_HOME", str(link))
    r = client.post("/api/hooks/hermes/install", headers=PAGE_HEADERS)
    assert r.status_code == 400 and "symlinked Hermes home" in r.json()["detail"]
    assert list(real.iterdir()) == []


def test_inline_plugins_mapping_is_not_rewritten(client, home):
    original = "plugins: {enabled: [a]}\n"
    (home / "config.yaml").write_text(original)
    r = client.post("/api/hooks/hermes/install", headers=PAGE_HEADERS)
    assert r.status_code == 409
    assert "hermes plugins enable securevector" in r.json()["detail"]
    assert (home / "config.yaml").read_text() == original


def test_install_needs_the_app_origin(client):
    assert client.post("/api/hooks/hermes/install").status_code in (401, 403)


def test_not_detected_returns_the_next_step(client, home, monkeypatch):
    monkeypatch.setattr(mod, "_hermes_detected", lambda: False)
    body = _install(client)
    assert body["ok"] is False and "not found" in body["next_step"]
    assert not (home / "plugins").exists()


def test_uninstall_leaves_a_foreign_folder_named_like_ours(client, home):
    foreign = home / "plugins" / "securevector"
    foreign.mkdir(parents=True)
    (foreign / "plugin.yaml").write_text("name: someone-else\n")
    (home / "config.yaml").write_text("plugins:\n  enabled:\n    - securevector\n")
    r = client.post("/api/hooks/hermes/uninstall", headers=PAGE_HEADERS)
    assert r.status_code == 409 and foreign.is_dir()
    # Ownership is checked first: the enable entry is left alone too.
    assert _cfg(home)["plugins"]["enabled"] == ["securevector"]


def test_refuses_a_symlinked_hermes_home(client, home, tmp_path):
    real = tmp_path / "real-hermes"
    real.mkdir()
    home.rmdir()
    os.symlink(real, home)
    r = client.post("/api/hooks/hermes/install", headers=PAGE_HEADERS)
    assert r.status_code == 400 and "symlinked Hermes home" in r.json()["detail"]
    assert list(real.iterdir()) == []


def test_a_symlinked_plugin_file_is_replaced_by_ours(client, home, tmp_path):
    _install(client)
    victim = tmp_path / "victim.py"
    victim.write_text("keep")
    target = home / "plugins" / "securevector" / "cost.py"
    target.unlink()
    os.symlink(victim, target)
    _install(client)
    assert not target.is_symlink() and target.is_file()
    assert "def build_record" in target.read_text()
    assert victim.read_text() == "keep"


def test_stage_files_replaces_symlinked_destinations_and_keeps_modes(tmp_path):
    src, dst = tmp_path / "src", tmp_path / "dst"
    src.mkdir(); dst.mkdir()
    (src / "a.js").write_text("url http://127.0.0.1:8741")
    (src / "b.js").write_text("b")
    victim = tmp_path / "victim"
    victim.write_text("keep")
    os.symlink(victim, dst / "b.js")
    (dst / "a.js").write_text("old")
    os.chmod(dst / "a.js", 0o700)
    written = mod._hooks_common.stage_files(
        staging_dir=dst, source_dir=src, files=["a.js", "b.js"],
        substitutions={"http://127.0.0.1:8741": "http://127.0.0.1:9"},
    )
    assert written == ["a.js", "b.js"]
    assert (dst / "a.js").read_text() == "url http://127.0.0.1:9"
    assert (dst / "a.js").stat().st_mode & 0o777 == 0o700
    # The link to a file outside the folder is gone, replaced by our file.
    assert not (dst / "b.js").is_symlink() and (dst / "b.js").read_text() == "b"
    assert victim.read_text() == "keep"
    assert not [p for p in dst.iterdir() if p.name.endswith(".tmp")]


def test_stage_files_refuses_a_symlinked_subfolder(tmp_path):
    src, dst, outside = tmp_path / "src", tmp_path / "dst", tmp_path / "outside"
    (src / "lib").mkdir(parents=True); dst.mkdir(); outside.mkdir()
    (src / "lib" / "x.js").write_text("x")
    os.symlink(outside, dst / "lib")
    written = mod._hooks_common.stage_files(
        staging_dir=dst, source_dir=src, files=["lib/x.js"], substitutions={},
    )
    assert written == [] and list(outside.iterdir()) == []


def test_staged_plugin_points_at_the_app_url(client, home, monkeypatch):
    monkeypatch.setattr(mod._hooks_common, "resolve_sv_url", lambda: "http://127.0.0.1:9123")
    _install(client)
    src = (home / "plugins" / "securevector" / "cost.py").read_text()
    assert 'DEFAULT_ENDPOINT = "http://127.0.0.1:9123"' in src


def test_install_leaves_a_foreign_folder_named_like_ours(client, home):
    foreign = home / "plugins" / "securevector"
    foreign.mkdir(parents=True)
    (foreign / "plugin.yaml").write_text("name: someone-else\n")
    (foreign / "main.py").write_text("keep")
    r = client.post("/api/hooks/hermes/install", headers=PAGE_HEADERS)
    assert r.status_code == 409
    assert (foreign / "plugin.yaml").read_text() == "name: someone-else\n"
    assert sorted(p.name for p in foreign.iterdir()) == ["main.py", "plugin.yaml"]
    assert not (home / "config.yaml").exists()


def test_install_leaves_an_unknown_folder_without_a_manifest(client, home):
    foreign = home / "plugins" / "securevector"
    foreign.mkdir(parents=True)
    (foreign / "notes.txt").write_text("keep")
    assert client.post("/api/hooks/hermes/install", headers=PAGE_HEADERS).status_code == 409
    assert client.post("/api/hooks/hermes/uninstall", headers=PAGE_HEADERS).status_code == 409
    assert (foreign / "notes.txt").read_text() == "keep"


def test_a_partial_install_is_ours(client, home):
    partial = home / "plugins" / "securevector"
    partial.mkdir(parents=True)
    (partial / "cost.py").write_text("old")
    _install(client)
    assert sorted(p.name for p in partial.iterdir()) == sorted(mod.PLUGIN_FILES)
    (partial / "plugin.yaml").unlink()
    r = client.post("/api/hooks/hermes/uninstall", headers=PAGE_HEADERS)
    assert r.status_code == 200 and not partial.exists()


def test_backup_skips_a_symlinked_backup_path(home, tmp_path):
    cfg = home / "config.yaml"
    cfg.write_text("plugins: {}\n")
    elsewhere = tmp_path / "elsewhere.yaml"
    backup = home / "config.yaml.before-securevector"
    os.symlink(elsewhere, backup)  # dangling: exists() is False
    mod._backup_once(cfg)
    assert not elsewhere.exists() and backup.is_symlink()
