"""Tests for plugin install/uninstall and config management in hooks.py."""

import json
import shutil
from pathlib import Path
from unittest.mock import patch

import pytest

from securevector.app.server.routes.hooks import (
    _register_plugin_in_config,
    _cleanup_stale_config_entry,
    PLUGIN_NAME,
)


@pytest.fixture
def openclaw_dir(tmp_path):
    """Create a temporary .openclaw directory and patch OPENCLAW_DIR."""
    with patch("securevector.app.server.routes.hooks.OPENCLAW_DIR", tmp_path), \
         patch("securevector.app.server.routes.hooks.STAGING_DIR", tmp_path / "plugins" / PLUGIN_NAME):
        yield tmp_path


class TestRegisterPluginInConfig:
    """Tests for _register_plugin_in_config — direct config registration."""

    def test_creates_config_if_missing(self, openclaw_dir):
        config_path = openclaw_dir / "openclaw.json"
        assert not config_path.exists()

        result = _register_plugin_in_config("/path/to/securevector-guard")
        assert result is True
        assert config_path.exists()

        config = json.loads(config_path.read_text())
        assert PLUGIN_NAME in config["plugins"]["entries"]
        assert "/path/to/securevector-guard" in config["plugins"]["load"]["paths"]
        assert PLUGIN_NAME in config["plugins"]["installs"]

    def test_preserves_existing_plugins(self, openclaw_dir):
        config_path = openclaw_dir / "openclaw.json"
        existing = {
            "meta": {"lastTouchedVersion": "2026.4.9"},
            "agents": {"defaults": {"model": {"primary": "openai/gpt-4o-mini"}}},
            "channels": {"telegram": {"enabled": True, "botToken": "secret"}},
            "plugins": {
                "entries": {
                    "openai": {"enabled": True},
                    "telegram": {"enabled": True},
                },
                "load": {
                    "paths": ["/some/other/plugin"]
                },
                "installs": {
                    "some-plugin": {"source": "npm", "version": "1.0.0"}
                },
            },
        }
        config_path.write_text(json.dumps(existing))

        result = _register_plugin_in_config("/path/to/securevector-guard")
        assert result is True

        config = json.loads(config_path.read_text())

        # Existing plugins preserved
        assert config["plugins"]["entries"]["openai"] == {"enabled": True}
        assert config["plugins"]["entries"]["telegram"] == {"enabled": True}
        assert "/some/other/plugin" in config["plugins"]["load"]["paths"]
        assert "some-plugin" in config["plugins"]["installs"]

        # Our plugin added
        assert config["plugins"]["entries"][PLUGIN_NAME] == {"enabled": True}
        assert "/path/to/securevector-guard" in config["plugins"]["load"]["paths"]
        assert PLUGIN_NAME in config["plugins"]["installs"]

        # Non-plugin config untouched
        assert config["meta"]["lastTouchedVersion"] == "2026.4.9"
        assert config["agents"]["defaults"]["model"]["primary"] == "openai/gpt-4o-mini"
        assert config["channels"]["telegram"]["botToken"] == "secret"

    def test_does_not_duplicate_paths(self, openclaw_dir):
        config_path = openclaw_dir / "openclaw.json"
        config_path.write_text(json.dumps({"plugins": {"load": {"paths": ["/path/to/securevector-guard"]}}}))

        _register_plugin_in_config("/path/to/securevector-guard")

        config = json.loads(config_path.read_text())
        paths = config["plugins"]["load"]["paths"]
        assert paths.count("/path/to/securevector-guard") == 1

    def test_overwrites_own_entry_on_reinstall(self, openclaw_dir):
        config_path = openclaw_dir / "openclaw.json"
        config_path.write_text(json.dumps({
            "plugins": {
                "entries": {PLUGIN_NAME: {"enabled": False}},
                "installs": {PLUGIN_NAME: {"version": "0.9.0"}},
            }
        }))

        _register_plugin_in_config("/new/path")

        config = json.loads(config_path.read_text())
        assert config["plugins"]["entries"][PLUGIN_NAME] == {"enabled": True}
        assert config["plugins"]["installs"][PLUGIN_NAME]["version"] == "1.0.0"
        assert config["plugins"]["installs"][PLUGIN_NAME]["sourcePath"] == "/new/path"

    def test_creates_backup(self, openclaw_dir):
        config_path = openclaw_dir / "openclaw.json"
        original = {"existing": "data"}
        config_path.write_text(json.dumps(original))

        _register_plugin_in_config("/path/to/plugin")

        backup = config_path.with_suffix(".json.bak")
        assert backup.exists()
        assert json.loads(backup.read_text()) == original


class TestCleanupStaleConfigEntry:
    """Tests for _cleanup_stale_config_entry — removes only our entries."""

    def test_removes_securevector_entries_only(self, openclaw_dir):
        config_path = openclaw_dir / "openclaw.json"
        config_path.write_text(json.dumps({
            "plugins": {
                "entries": {
                    "openai": {"enabled": True},
                    "telegram": {"enabled": True},
                    PLUGIN_NAME: {"enabled": True},
                },
                "load": {
                    "paths": [
                        "/other/plugin",
                        "/home/user/.openclaw/plugins/securevector-guard",
                    ]
                },
                "installs": {
                    "other-plugin": {"version": "1.0.0"},
                    PLUGIN_NAME: {"sourcePath": "/path/to/securevector-guard"},
                },
            }
        }))

        _cleanup_stale_config_entry()

        config = json.loads(config_path.read_text())

        # Other plugins preserved
        assert "openai" in config["plugins"]["entries"]
        assert "telegram" in config["plugins"]["entries"]
        assert "/other/plugin" in config["plugins"]["load"]["paths"]
        assert "other-plugin" in config["plugins"]["installs"]

        # Our entries removed
        assert PLUGIN_NAME not in config["plugins"]["entries"]
        assert not any("securevector-guard" in p for p in config["plugins"]["load"]["paths"])
        assert PLUGIN_NAME not in config["plugins"]["installs"]

    def test_no_crash_when_config_missing(self, openclaw_dir):
        # Should not raise
        _cleanup_stale_config_entry()

    def test_no_crash_when_no_plugins_section(self, openclaw_dir):
        config_path = openclaw_dir / "openclaw.json"
        config_path.write_text(json.dumps({"agents": {}}))

        _cleanup_stale_config_entry()

        config = json.loads(config_path.read_text())
        assert config == {"agents": {}}

    def test_creates_backup_before_modifying(self, openclaw_dir):
        config_path = openclaw_dir / "openclaw.json"
        original = {"plugins": {"entries": {PLUGIN_NAME: {"enabled": True}}}}
        config_path.write_text(json.dumps(original))

        _cleanup_stale_config_entry()

        backup = config_path.with_suffix(".json.bak")
        assert backup.exists()
        assert json.loads(backup.read_text()) == original

    def test_no_write_when_nothing_to_clean(self, openclaw_dir):
        config_path = openclaw_dir / "openclaw.json"
        original = {"plugins": {"entries": {"openai": {"enabled": True}}}}
        config_path.write_text(json.dumps(original))

        _cleanup_stale_config_entry()

        # No backup created since nothing changed
        backup = config_path.with_suffix(".json.bak")
        assert not backup.exists()
