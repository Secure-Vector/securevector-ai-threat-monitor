"""
svconfig.yml config file support.

Reads and writes a human-editable YAML config file in the app data directory.
Values are applied to the database on startup, and the file is kept in sync
whenever settings are changed via the UI.

Config location (platform-specific):
  Linux:   ~/.local/share/securevector/threat-monitor/svconfig.yml
  macOS:   ~/Library/Application Support/SecureVector/ThreatMonitor/svconfig.yml
  Windows: %LOCALAPPDATA%/SecureVector/ThreatMonitor/svconfig.yml
"""

import logging
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

CONFIG_FILENAME = "svconfig.yml"

_TEMPLATE = """\
# SecureVector Configuration
# This file is read on startup and updated automatically when you change settings in the UI.
# You can also edit it manually — changes take effect on next restart.
#
# Config location: {path}

server:
  # Web UI / API server host and port
  # Change these if port 8741 is already in use on your machine.
  host: {server_host}
  port: {server_port}

security:
  # Block detected threats (true) or log/warn only (false)
  block_mode: {block_mode}
  # Scan LLM responses for data leakage and PII
  output_scan: {output_scan}

budget:
  # Daily spend limit in USD (set to null to disable)
  daily_limit: {daily_limit}
  # Warn in logs/headers when spend approaches the configured limit
  warn: {budget_warn}
  # Block requests when the daily budget is exceeded
  block: {budget_block}

tools:
  # Enforce tool permission rules (allow/block based on your rules)
  enforcement: {tools_enforcement}

proxy:
  # -----------------------------------------------------------------------
  # Step 1: Start SecureVector  →  SecureVector proxy starts automatically on port {proxy_port}
  # Step 2: Point your agent at the proxy instead of the LLM provider
  #
  #   Linux / macOS (export):
  #     export OPENAI_BASE_URL=http://127.0.0.1:{proxy_port}/openai/v1
  #     export ANTHROPIC_BASE_URL=http://127.0.0.1:{proxy_port}/anthropic
  #
  #   Windows (PowerShell):
  #     $env:OPENAI_BASE_URL="http://127.0.0.1:{proxy_port}/openai/v1"
  #     $env:ANTHROPIC_BASE_URL="http://127.0.0.1:{proxy_port}/anthropic"
  #
  #   Windows (Command Prompt):
  #     set OPENAI_BASE_URL=http://127.0.0.1:{proxy_port}/openai/v1
  #     set ANTHROPIC_BASE_URL=http://127.0.0.1:{proxy_port}/anthropic
  #
  #   Ollama / OpenWebUI — set API base URL to:
  #     http://127.0.0.1:{proxy_port}/ollama/v1
  #
  #   OpenClaw (default — started automatically with SecureVector):
  #     ANTHROPIC_BASE_URL=http://127.0.0.1:{proxy_port}/anthropic openclaw gateway
  # -----------------------------------------------------------------------
  # Integration — which agent framework is connected
  # Options: openclaw, langchain, langgraph, crewai, ollama
  integration: {proxy_integration}
  # Mode: multi-provider routes all LLM providers automatically (recommended)
  #       single routes to one provider only (provider field required below)
  mode: {proxy_mode}    # or: single
  # Provider — required when mode is "single"
  # Options: openai, anthropic, gemini, groq, mistral, grok, ollama
  provider: {proxy_provider}
  # Proxy listen host and port
  host: {proxy_host}
  port: {proxy_port}
"""


def get_config_path() -> Path:
    from securevector.app.utils.platform import get_app_data_dir
    return get_app_data_dir() / CONFIG_FILENAME


def load_config() -> dict[str, Any]:
    """Load svconfig.yml. Returns empty dict if file doesn't exist or is invalid."""
    path = get_config_path()
    if not path.exists():
        return {}
    try:
        import yaml
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        logger.info(f"Loaded config from {path}")
        return data
    except Exception as e:
        logger.warning(f"Failed to load {path}: {e}")
        return {}


def _fmt_amount(value: Optional[float]) -> str:
    """Format a dollar amount for YAML — null if not set."""
    if value is None:
        return "null"
    return f"{value:.2f}"


VALID_INTEGRATIONS = ("openclaw", "langchain", "langgraph", "crewai", "ollama")
VALID_PROXY_MODES = ("multi-provider", "single")
VALID_PROVIDERS = ("openai", "anthropic", "gemini", "groq", "mistral", "grok", "ollama")
DEFAULT_INTEGRATION = "openclaw"
DEFAULT_PROXY_MODE = "multi-provider"
DEFAULT_PROXY_HOST = "127.0.0.1"
DEFAULT_PROXY_PORT = 8742
DEFAULT_SERVER_HOST = "127.0.0.1"
DEFAULT_SERVER_PORT = 8741


def save_config(
    *,
    block_mode: bool,
    output_scan: bool,
    budget_warn: bool,
    budget_block: bool,
    budget_daily_limit: Optional[float] = None,
    tools_enforcement: bool,
    proxy_integration: str = DEFAULT_INTEGRATION,
    proxy_mode: str = DEFAULT_PROXY_MODE,
    proxy_provider: Optional[str] = None,
    proxy_host: str = DEFAULT_PROXY_HOST,
    proxy_port: int = DEFAULT_PROXY_PORT,
    server_host: str = DEFAULT_SERVER_HOST,
    server_port: int = DEFAULT_SERVER_PORT,
) -> Path:
    """Write current settings to svconfig.yml. Returns the config path."""
    path = get_config_path()
    content = _TEMPLATE.format(
        path=path,
        server_host=server_host,
        server_port=server_port,
        block_mode=str(block_mode).lower(),
        output_scan=str(output_scan).lower(),
        daily_limit=_fmt_amount(budget_daily_limit),
        budget_warn=str(budget_warn).lower(),
        budget_block=str(budget_block).lower(),
        tools_enforcement=str(tools_enforcement).lower(),
        proxy_integration=proxy_integration if proxy_integration in VALID_INTEGRATIONS else DEFAULT_INTEGRATION,
        proxy_mode=proxy_mode if proxy_mode in VALID_PROXY_MODES else DEFAULT_PROXY_MODE,
        proxy_provider=proxy_provider if proxy_provider in VALID_PROVIDERS else "null",
        proxy_host=proxy_host,
        proxy_port=proxy_port,
    )
    try:
        path.write_text(content, encoding="utf-8")
        logger.info(f"Config saved to {path}")
    except Exception as e:
        logger.warning(f"Failed to write config to {path}: {e}")
    return path


def get_server_defaults() -> tuple[str, int]:
    """
    Return (host, port) from svconfig.yml server section.
    Falls back to defaults if the file doesn't exist or the keys are missing.
    """
    config = load_config()
    server = config.get("server", {})
    host = server.get("host", DEFAULT_SERVER_HOST)
    port = server.get("port", DEFAULT_SERVER_PORT)
    try:
        port = int(port)
    except (TypeError, ValueError):
        port = DEFAULT_SERVER_PORT
    return str(host), port


def get_proxy_defaults() -> tuple[str, Optional[int]]:
    """
    Return (host, port) from svconfig.yml proxy section.
    Port is None if not set in config (caller should use its own default).
    Falls back to DEFAULT_PROXY_HOST for host if not set.
    """
    config = load_config()
    proxy = config.get("proxy", {})
    host = proxy.get("host", DEFAULT_PROXY_HOST)
    raw_port = proxy.get("port", None)
    if raw_port is not None:
        try:
            port: Optional[int] = int(raw_port)
        except (TypeError, ValueError):
            port = None
    else:
        port = None
    return str(host), port


async def apply_config_to_db(db) -> None:
    """
    Read svconfig.yml and push values into the database settings.
    Called once on startup. If the file doesn't exist, a default one is created.
    """
    from securevector.app.database.repositories.settings import SettingsRepository
    from securevector.app.database.repositories.costs import CostsRepository

    config = load_config()
    settings_repo = SettingsRepository(db)
    costs_repo = CostsRepository(db)

    security = config.get("security", {})
    budget = config.get("budget", {})
    tools = config.get("tools", {})
    proxy = config.get("proxy", {})

    updates: dict[str, Any] = {}

    if "block_mode" in security:
        updates["block_threats"] = bool(security["block_mode"])
    if "output_scan" in security:
        updates["scan_llm_responses"] = bool(security["output_scan"])
    if "enforcement" in tools:
        updates["tool_permissions_enabled"] = bool(tools["enforcement"])

    # Proxy mode is informational — stored in config, read by proxy startup
    if "mode" in proxy:
        mode = proxy["mode"]
        if mode not in VALID_PROXY_MODES:
            logger.warning(f"Unknown proxy mode '{mode}' in svconfig.yml — using '{DEFAULT_PROXY_MODE}'")

    if updates:
        await settings_repo.update(**updates)
        logger.info(f"Applied config to settings: {list(updates.keys())}")

    # Apply budget from config
    if "warn" in budget or "block" in budget or "daily_limit" in budget:
        budget_block = bool(budget.get("block", False))
        action = "block" if budget_block else "warn"
        daily_limit = budget.get("daily_limit")
        if daily_limit is not None:
            try:
                daily_limit = float(daily_limit)
            except (TypeError, ValueError):
                daily_limit = None
        try:
            await costs_repo.set_global_budget(daily_limit, action)
            logger.info(f"Applied budget from config: daily_limit={daily_limit}, action={action}")
        except Exception as e:
            logger.warning(f"Could not apply budget config: {e}")

    # Always ensure the config file exists (create default if missing or incomplete)
    if not config or "server" not in config:
        try:
            settings = await settings_repo.get()
            try:
                budget_data = await costs_repo.get_global_budget() or {}
            except Exception:
                budget_data = {}
            budget_action = budget_data.get("budget_action", "warn")
            daily = budget_data.get("daily_budget_usd")
            _proxy = config.get("proxy", {})
            _server = config.get("server", {})
            save_config(
                block_mode=settings.block_threats,
                output_scan=settings.scan_llm_responses,
                budget_warn=(budget_action == "warn"),
                budget_block=(budget_action == "block"),
                budget_daily_limit=daily if daily and daily > 0 else None,
                tools_enforcement=settings.tool_permissions_enabled,
                proxy_integration=_proxy.get("integration", DEFAULT_INTEGRATION),
                proxy_mode=_proxy.get("mode", DEFAULT_PROXY_MODE),
                proxy_host=_proxy.get("host", DEFAULT_PROXY_HOST),
                proxy_port=int(_proxy.get("port", DEFAULT_PROXY_PORT)),
                server_host=_server.get("host", DEFAULT_SERVER_HOST),
                server_port=int(_server.get("port", DEFAULT_SERVER_PORT)),
            )
        except Exception as e:
            logger.warning(f"Could not create default config: {e}")
