"""Tests for plugin install/uninstall and config management in hooks.py."""

import json
from unittest.mock import patch

import pytest

# The install and uninstall routes now require a loopback Host and a MATCHING
# Origin. They carried no check at all before 2026-09-21, so a page on any
# origin could POST them and remove a Guard the product had installed. These
# tests therefore present what the app's own page presents. Reads are
# unchanged and still need nothing.
PAGE_HEADERS = {"host": "127.0.0.1:8741", "origin": "http://127.0.0.1:8741"}


try:
    from securevector.app.server.routes.hooks import (
        _register_plugin_in_config,
        _cleanup_stale_config_entry,
        PLUGIN_NAME,
    )
except ImportError:
    pytest.skip("aiosqlite or app dependencies not installed", allow_module_level=True)


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
        # The install record carries the bundled OpenClaw plugin version.
        assert config["plugins"]["installs"][PLUGIN_NAME]["version"] == "1.2.0"
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


class TestConversationAccessGrant:
    """OpenClaw 2026.10 hook grant: plugins.entries.<id>.hooks.allowConversationAccess."""

    def _grant(self):
        from securevector.app.server.routes.hooks import _ensure_conversation_access

        return _ensure_conversation_access()

    def test_sets_grant_on_own_entry_and_preserves_other_keys(self, openclaw_dir):
        config_path = openclaw_dir / "openclaw.json"
        config_path.write_text(
            json.dumps(
                {
                    "meta": {"lastTouchedVersion": "2026.10.6"},
                    "plugins": {
                        "allow": [PLUGIN_NAME, "openai"],
                        "entries": {
                            PLUGIN_NAME: {
                                "enabled": True,
                                "config": {"threshold": 70},
                                "hooks": {"other": 1},
                            },
                            "openai": {"enabled": True},
                        },
                    },
                }
            )
        )

        assert self._grant() is True

        config = json.loads(config_path.read_text())
        entry = config["plugins"]["entries"][PLUGIN_NAME]
        assert entry["hooks"] == {"other": 1, "allowConversationAccess": True}
        assert entry["enabled"] is True
        assert entry["config"] == {"threshold": 70}
        # Other plugins get no grant and are otherwise unchanged.
        assert config["plugins"]["entries"]["openai"] == {"enabled": True}
        assert config["plugins"]["allow"] == [PLUGIN_NAME, "openai"]
        assert config["meta"]["lastTouchedVersion"] == "2026.10.6"

    def test_is_idempotent(self, openclaw_dir):
        config_path = openclaw_dir / "openclaw.json"
        config_path.write_text(
            json.dumps({"plugins": {"entries": {PLUGIN_NAME: {"enabled": True}}}})
        )

        assert self._grant() is True
        first = config_path.read_text()
        config_path.with_suffix(".json.bak").unlink()

        assert self._grant() is False
        assert config_path.read_text() == first
        # Nothing changed, so nothing was rewritten or backed up.
        assert not config_path.with_suffix(".json.bak").exists()

    def test_creates_entry_when_missing(self, openclaw_dir):
        config_path = openclaw_dir / "openclaw.json"
        config_path.write_text(
            json.dumps({"plugins": {"installs": {PLUGIN_NAME: {"source": "path"}}}})
        )

        assert self._grant() is True
        entry = json.loads(config_path.read_text())["plugins"]["entries"][PLUGIN_NAME]
        assert entry["hooks"]["allowConversationAccess"] is True

    def test_no_config_file_is_a_noop(self, openclaw_dir):
        assert self._grant() is False
        assert not (openclaw_dir / "openclaw.json").exists()

    def test_uninstall_cleanup_removes_grant(self, openclaw_dir):
        config_path = openclaw_dir / "openclaw.json"
        config_path.write_text(
            json.dumps(
                {
                    "plugins": {
                        "entries": {
                            PLUGIN_NAME: {
                                "enabled": True,
                                "hooks": {"allowConversationAccess": True},
                            },
                            "openai": {
                                "enabled": True,
                                "hooks": {"allowConversationAccess": True},
                            },
                        }
                    }
                }
            )
        )

        _cleanup_stale_config_entry()

        entries = json.loads(config_path.read_text())["plugins"]["entries"]
        assert PLUGIN_NAME not in entries
        # Another plugin's own grant is not ours to remove.
        assert entries["openai"]["hooks"]["allowConversationAccess"] is True

    def _install(self, openclaw_dir, cli_ok):
        import asyncio
        from securevector.app.server.routes import hooks as mod

        def fake_cmd(args):
            if args == ["--version"]:
                return 0, "2026.10.6", ""
            if args[:2] == ["plugins", "install"]:
                if not cli_ok:
                    return 1, "", "failed"
                # The CLI records the install and an enabled entry.
                path = openclaw_dir / "openclaw.json"
                cfg = json.loads(path.read_text()) if path.exists() else {}
                plugins = cfg.setdefault("plugins", {})
                plugins.setdefault("installs", {})[PLUGIN_NAME] = {"source": "path"}
                plugins.setdefault("entries", {})[PLUGIN_NAME] = {"enabled": True}
                path.write_text(json.dumps(cfg))
                return 0, "ok", ""
            return 0, "", ""

        with (
            patch.object(mod, "_ensure_bundled_plugin_dir", return_value=openclaw_dir),
            patch.object(mod, "_resolve_sv_url", return_value="http://127.0.0.1:8741"),
            patch.object(mod, "_stage_plugin_files", return_value=["index.ts"]),
            patch.object(mod, "_run_openclaw_cmd", side_effect=fake_cmd),
        ):
            return asyncio.run(mod.install_plugin(None))

    @pytest.mark.parametrize("cli_ok", [True, False])
    def test_install_writes_grant(self, openclaw_dir, cli_ok):
        config_path = openclaw_dir / "openclaw.json"
        config_path.write_text(json.dumps({"plugins": {"entries": {"openai": {"enabled": True}}}}))

        result = self._install(openclaw_dir, cli_ok)

        assert result["registered"] is True
        entries = json.loads(config_path.read_text())["plugins"]["entries"]
        assert entries[PLUGIN_NAME]["hooks"]["allowConversationAccess"] is True
        assert entries[PLUGIN_NAME]["enabled"] is True
        assert entries["openai"] == {"enabled": True}

    def test_already_installed_gains_grant(self, openclaw_dir):
        import asyncio
        from securevector.app.server.routes import hooks as mod

        staging = openclaw_dir / "plugins" / PLUGIN_NAME
        staging.mkdir(parents=True)
        (staging / "openclaw.plugin.json").write_text("{}")
        (staging / "index.ts").write_text("")
        config_path = openclaw_dir / "openclaw.json"
        config_path.write_text(
            json.dumps(
                {
                    "plugins": {
                        "installs": {PLUGIN_NAME: {"source": "path"}},
                        "entries": {PLUGIN_NAME: {"enabled": True}},
                    }
                }
            )
        )

        with patch.object(mod, "_ensure_bundled_plugin_dir", return_value=openclaw_dir):
            result = asyncio.run(mod.install_plugin(None))

        assert result["status"] == "already_installed"
        entry = json.loads(config_path.read_text())["plugins"]["entries"][PLUGIN_NAME]
        assert entry == {"enabled": True, "hooks": {"allowConversationAccess": True}}


class TestEmbeddedPluginCopies:
    """The embedded copies are written when the packaged plugin files are
    missing, so they must match those files exactly."""

    @pytest.mark.parametrize(
        "attr,filename",
        [
            ("_INDEX_TS", "index.ts"),
            ("_CONFIG_TS", "config.ts"),
            ("_PLUGIN_JSON", "openclaw.plugin.json"),
            ("_PACKAGE_JSON", "package.json"),
        ],
    )
    def test_embedded_copy_matches_packaged_file(self, attr, filename):
        from securevector.app.server.routes import hooks as mod

        packaged = (mod.BUNDLED_PLUGIN_DIR / filename).read_text(encoding="utf-8")
        assert getattr(mod, attr) == packaged, (
            f"{attr} in hooks.py differs from plugins/openclaw/{filename}; "
            "copy the file's contents into it"
        )
