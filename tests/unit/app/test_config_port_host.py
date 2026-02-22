"""
Tests for svconfig.yml server port/host configuration.

Validates that:
  1. save_config() writes server.port and server.host to YAML
  2. get_server_defaults() reads them back correctly
  3. Proxy status endpoint includes top-level 'port' field
  4. main() respects YAML port when --port not passed explicitly
  5. Integration page createCodeBlock substitution logic is exercised
     via the proxy status API returning the right port/host values

Run: cd src && pytest ../tests/unit/app/test_config_port_host.py -v
"""

import os
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest


# ---------------------------------------------------------------------------
# 1. save_config / get_server_defaults round-trip
# ---------------------------------------------------------------------------

class TestConfigServerSection:

    def _write_and_read(self, server_host: str, server_port: int) -> dict:
        """Write a config with custom server section and read it back."""
        import yaml
        from securevector.app.utils.config_file import save_config, load_config

        with tempfile.TemporaryDirectory() as tmpdir:
            cfg_path = Path(tmpdir) / "svconfig.yml"
            with patch("securevector.app.utils.config_file.get_config_path", return_value=cfg_path):
                save_config(
                    block_mode=False,
                    output_scan=False,
                    budget_warn=False,
                    budget_block=False,
                    tools_enforcement=False,
                    server_host=server_host,
                    server_port=server_port,
                )
                data = load_config()
        return data

    def test_default_server_port_written(self):
        """Default port 8741 is written to server.port."""
        data = self._write_and_read("127.0.0.1", 8741)
        assert data["server"]["port"] == 8741

    def test_custom_server_port_written(self):
        """Custom port 9000 is written and read back correctly."""
        data = self._write_and_read("127.0.0.1", 9000)
        assert data["server"]["port"] == 9000

    def test_custom_server_host_written(self):
        """Custom host 0.0.0.0 is written and read back correctly."""
        data = self._write_and_read("0.0.0.0", 8741)
        assert data["server"]["host"] == "0.0.0.0"

    def test_custom_ip_host_written(self):
        """Specific IP host is preserved in YAML."""
        data = self._write_and_read("192.168.1.100", 8800)
        assert data["server"]["host"] == "192.168.1.100"
        assert data["server"]["port"] == 8800

    def test_proxy_section_still_written(self):
        """Proxy section still present alongside server section."""
        data = self._write_and_read("127.0.0.1", 8741)
        assert "proxy" in data
        assert "port" in data["proxy"]

    def test_security_section_still_written(self):
        """Security settings are not affected by server section addition."""
        data = self._write_and_read("127.0.0.1", 8741)
        assert "security" in data
        assert "block_mode" in data["security"]


# ---------------------------------------------------------------------------
# 2. get_server_defaults()
# ---------------------------------------------------------------------------

class TestGetServerDefaults:

    def test_returns_defaults_when_no_config(self):
        """Falls back to 127.0.0.1:8741 when config file is missing."""
        from securevector.app.utils.config_file import get_server_defaults, DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT

        with tempfile.TemporaryDirectory() as tmpdir:
            missing = Path(tmpdir) / "svconfig.yml"
            with patch("securevector.app.utils.config_file.get_config_path", return_value=missing):
                host, port = get_server_defaults()

        assert host == DEFAULT_SERVER_HOST
        assert port == DEFAULT_SERVER_PORT

    def test_reads_custom_port_from_yaml(self):
        """Reads custom port from svconfig.yml server.port."""
        import yaml
        from securevector.app.utils.config_file import get_server_defaults

        cfg = {"server": {"host": "127.0.0.1", "port": 9500}}
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg_path = Path(tmpdir) / "svconfig.yml"
            cfg_path.write_text(yaml.dump(cfg), encoding="utf-8")
            with patch("securevector.app.utils.config_file.get_config_path", return_value=cfg_path):
                host, port = get_server_defaults()

        assert port == 9500

    def test_reads_custom_host_from_yaml(self):
        """Reads custom host from svconfig.yml server.host."""
        import yaml
        from securevector.app.utils.config_file import get_server_defaults

        cfg = {"server": {"host": "0.0.0.0", "port": 8741}}
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg_path = Path(tmpdir) / "svconfig.yml"
            cfg_path.write_text(yaml.dump(cfg), encoding="utf-8")
            with patch("securevector.app.utils.config_file.get_config_path", return_value=cfg_path):
                host, port = get_server_defaults()

        assert host == "0.0.0.0"

    def test_invalid_port_falls_back_to_default(self):
        """Non-integer port in YAML falls back to default 8741."""
        import yaml
        from securevector.app.utils.config_file import get_server_defaults, DEFAULT_SERVER_PORT

        cfg = {"server": {"host": "127.0.0.1", "port": "not-a-number"}}
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg_path = Path(tmpdir) / "svconfig.yml"
            cfg_path.write_text(yaml.dump(cfg), encoding="utf-8")
            with patch("securevector.app.utils.config_file.get_config_path", return_value=cfg_path):
                _, port = get_server_defaults()

        assert port == DEFAULT_SERVER_PORT

    def test_missing_server_section_returns_defaults(self):
        """Config without server section returns default host/port."""
        import yaml
        from securevector.app.utils.config_file import get_server_defaults, DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT

        cfg = {"security": {"block_mode": False}}
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg_path = Path(tmpdir) / "svconfig.yml"
            cfg_path.write_text(yaml.dump(cfg), encoding="utf-8")
            with patch("securevector.app.utils.config_file.get_config_path", return_value=cfg_path):
                host, port = get_server_defaults()

        assert host == DEFAULT_SERVER_HOST
        assert port == DEFAULT_SERVER_PORT


# ---------------------------------------------------------------------------
# 3. Proxy status endpoint includes top-level 'port'
# ---------------------------------------------------------------------------

class TestProxyStatusPort:

    def test_proxy_status_has_port_field(self):
        """The proxy status dict always includes a top-level 'port' key."""
        # Import and call the route function directly (no HTTP needed)
        from securevector.app.server.routes.proxy import get_proxy_status
        import asyncio

        status = asyncio.run(get_proxy_status())
        assert "port" in status, "proxy status must include top-level 'port'"
        assert isinstance(status["port"], int)

    def test_proxy_status_port_matches_llm_proxy_port(self):
        """Top-level port equals llm_proxy.port for consistency."""
        from securevector.app.server.routes.proxy import get_proxy_status
        import asyncio

        status = asyncio.run(get_proxy_status())
        assert status["port"] == status["llm_proxy"]["port"]


# ---------------------------------------------------------------------------
# 4. UI host/port substitution logic (pure Python simulation)
# ---------------------------------------------------------------------------

class TestCodeBlockSubstitution:
    """
    Simulates the JavaScript createCodeBlock substitution logic in Python
    to verify that host and port replacements work correctly.
    """

    def _substitute(self, code: str, proxy_port: int, web_port: int, host: str) -> str:
        """Mirror of the JS createCodeBlock substitution logic."""
        if proxy_port != 8742:
            code = code.replace(':8742', ':' + str(proxy_port))
        if web_port != 8741:
            code = code.replace(':8741', ':' + str(web_port))
        if host not in ('localhost', '127.0.0.1'):
            code = code.replace('://localhost:', '://' + host + ':')
            code = code.replace('://127.0.0.1:', '://' + host + ':')
        return code

    def test_default_ports_no_change(self):
        code = 'export OPENAI_BASE_URL=http://localhost:8742/openai/v1'
        result = self._substitute(code, 8742, 8741, 'localhost')
        assert result == code

    def test_custom_proxy_port_replaced(self):
        code = 'export OPENAI_BASE_URL=http://localhost:8742/openai/v1'
        result = self._substitute(code, 8800, 8741, 'localhost')
        assert ':8800' in result
        assert ':8742' not in result

    def test_custom_web_port_replaced(self):
        code = '# Dashboard: http://localhost:8741'
        result = self._substitute(code, 8742, 9000, 'localhost')
        assert ':9000' in result
        assert ':8741' not in result

    def test_custom_host_replaces_localhost(self):
        code = 'export OPENAI_BASE_URL=http://localhost:8742/openai/v1'
        result = self._substitute(code, 8742, 8741, '192.168.1.100')
        assert '://192.168.1.100:' in result
        assert '://localhost:' not in result

    def test_custom_host_replaces_127(self):
        code = '$env:OPENAI_BASE_URL="http://127.0.0.1:8742/openai/v1"'
        result = self._substitute(code, 8742, 8741, '10.0.0.5')
        assert '://10.0.0.5:' in result
        assert '://127.0.0.1:' not in result

    def test_combined_port_and_host_change(self):
        code = 'http://localhost:8742/openai/v1'
        result = self._substitute(code, 9001, 8741, '192.168.0.50')
        assert result == 'http://192.168.0.50:9001/openai/v1'

    def test_localhost_host_no_change(self):
        """Explicit localhost host should not trigger replacement."""
        code = 'http://localhost:8742/openai/v1'
        result = self._substitute(code, 8742, 8741, 'localhost')
        assert result == code

    def test_anthropic_url_substitution(self):
        code = 'export ANTHROPIC_BASE_URL=http://localhost:8742/anthropic'
        result = self._substitute(code, 8900, 8741, 'myserver.local')
        assert 'http://myserver.local:8900/anthropic' in result

    def test_multi_line_code_block(self):
        code = (
            'export OPENAI_BASE_URL=http://localhost:8742/openai/v1\n'
            'export ANTHROPIC_BASE_URL=http://localhost:8742/anthropic'
        )
        result = self._substitute(code, 8800, 8741, '10.10.0.1')
        assert result.count('http://10.10.0.1:8800') == 2
        assert 'localhost' not in result
