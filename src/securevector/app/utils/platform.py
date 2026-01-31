"""
Platform-specific utilities for the SecureVector desktop application.

Provides cross-platform paths for:
- Application data directory
- Database file location
- Custom rules directory
- Settings file

Uses platformdirs for OS-appropriate paths:
- Windows: %LOCALAPPDATA%/SecureVector/ThreatMonitor/
- macOS: ~/Library/Application Support/SecureVector/ThreatMonitor/
- Linux: ~/.local/share/securevector/threat-monitor/
"""

import os
import sys
from pathlib import Path
from typing import Optional

try:
    from platformdirs import user_data_dir
except ImportError:
    # Fallback if platformdirs not installed
    def user_data_dir(appname: str, appauthor: str) -> str:
        """Fallback implementation for user data directory."""
        if sys.platform == "win32":
            base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
            return os.path.join(base, appauthor, appname)
        elif sys.platform == "darwin":
            return os.path.expanduser(f"~/Library/Application Support/{appauthor}/{appname}")
        else:
            return os.path.expanduser(f"~/.local/share/{appname.lower()}")


# Application identifiers
APP_NAME = "ThreatMonitor"
APP_AUTHOR = "SecureVector"

# File names
DATABASE_FILENAME = "threat_intel.db"
SETTINGS_FILENAME = "settings.json"
RULE_OVERRIDES_FILENAME = "rule_overrides.json"
CUSTOM_RULES_DIR_NAME = "custom_rules"


def get_app_data_dir() -> Path:
    """
    Get the application data directory.

    Returns:
        Path to the app data directory, created if it doesn't exist.

    Platform-specific locations:
        - Windows: %LOCALAPPDATA%/SecureVector/ThreatMonitor/
        - macOS: ~/Library/Application Support/SecureVector/ThreatMonitor/
        - Linux: ~/.local/share/securevector/threat-monitor/
    """
    if sys.platform == "linux":
        # Use lowercase with hyphens for Linux (XDG convention)
        data_dir = Path.home() / ".local" / "share" / "securevector" / "threat-monitor"
    else:
        data_dir = Path(user_data_dir(APP_NAME, APP_AUTHOR))

    # Ensure directory exists
    data_dir.mkdir(parents=True, exist_ok=True)

    return data_dir


def get_database_path() -> Path:
    """
    Get the path to the SQLite database file.

    Returns:
        Path to threat_intel.db
    """
    return get_app_data_dir() / DATABASE_FILENAME


def get_custom_rules_dir() -> Path:
    """
    Get the directory for custom rules.

    Returns:
        Path to custom_rules directory, created if it doesn't exist.
    """
    rules_dir = get_app_data_dir() / CUSTOM_RULES_DIR_NAME
    rules_dir.mkdir(parents=True, exist_ok=True)
    return rules_dir


def get_settings_path() -> Path:
    """
    Get the path to the settings file.

    Returns:
        Path to settings.json
    """
    return get_app_data_dir() / SETTINGS_FILENAME


def get_rule_overrides_path() -> Path:
    """
    Get the path to the rule overrides file.

    Returns:
        Path to rule_overrides.json
    """
    return get_app_data_dir() / RULE_OVERRIDES_FILENAME


def get_log_dir() -> Path:
    """
    Get the directory for log files.

    Returns:
        Path to logs directory, created if it doesn't exist.
    """
    log_dir = get_app_data_dir() / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir


def ensure_app_directories() -> dict[str, Path]:
    """
    Ensure all application directories exist and return their paths.

    Returns:
        Dictionary with paths to all app directories and files.
    """
    return {
        "data_dir": get_app_data_dir(),
        "database": get_database_path(),
        "custom_rules": get_custom_rules_dir(),
        "settings": get_settings_path(),
        "rule_overrides": get_rule_overrides_path(),
        "logs": get_log_dir(),
    }
