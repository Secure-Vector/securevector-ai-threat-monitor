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


# ============================================================================
# Autostart / Launch on Login
# ============================================================================

AUTOSTART_APP_NAME = "SecureVector Threat Monitor"


def _get_executable_path() -> str:
    """Get the path to the securevector-app executable."""
    # When installed via pip, the entry point script is in the Python scripts dir
    if sys.platform == "win32":
        # On Windows, look for securevector-app.exe in Scripts folder
        scripts_dir = Path(sys.executable).parent / "Scripts"
        exe_path = scripts_dir / "securevector-app.exe"
        if exe_path.exists():
            return str(exe_path)
        # Fallback: use python -m
        return f'"{sys.executable}" -m securevector.app.main'
    else:
        # On Unix, the entry point is typically in the same dir as python
        bin_dir = Path(sys.executable).parent
        exe_path = bin_dir / "securevector-app"
        if exe_path.exists():
            return str(exe_path)
        # Fallback: use python -m
        return f"{sys.executable} -m securevector.app.main"


def enable_autostart() -> bool:
    """
    Enable autostart on login for the current platform.

    Returns:
        True if successful, False otherwise.
    """
    try:
        if sys.platform == "win32":
            return _enable_autostart_windows()
        elif sys.platform == "darwin":
            return _enable_autostart_macos()
        else:
            return _enable_autostart_linux()
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"Failed to enable autostart: {e}")
        return False


def disable_autostart() -> bool:
    """
    Disable autostart on login for the current platform.

    Returns:
        True if successful, False otherwise.
    """
    try:
        if sys.platform == "win32":
            return _disable_autostart_windows()
        elif sys.platform == "darwin":
            return _disable_autostart_macos()
        else:
            return _disable_autostart_linux()
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"Failed to disable autostart: {e}")
        return False


def is_autostart_enabled() -> bool:
    """
    Check if autostart is currently enabled.

    Returns:
        True if autostart is enabled, False otherwise.
    """
    try:
        if sys.platform == "win32":
            return _is_autostart_enabled_windows()
        elif sys.platform == "darwin":
            return _is_autostart_enabled_macos()
        else:
            return _is_autostart_enabled_linux()
    except Exception:
        return False


# Windows implementation
def _enable_autostart_windows() -> bool:
    """Enable autostart via Windows Registry."""
    import winreg
    key_path = r"Software\Microsoft\Windows\CurrentVersion\Run"
    exe_path = _get_executable_path()

    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_SET_VALUE) as key:
        winreg.SetValueEx(key, AUTOSTART_APP_NAME, 0, winreg.REG_SZ, exe_path)
    return True


def _disable_autostart_windows() -> bool:
    """Disable autostart via Windows Registry."""
    import winreg
    key_path = r"Software\Microsoft\Windows\CurrentVersion\Run"

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_SET_VALUE) as key:
            winreg.DeleteValue(key, AUTOSTART_APP_NAME)
    except FileNotFoundError:
        pass  # Already not set
    return True


def _is_autostart_enabled_windows() -> bool:
    """Check if autostart is enabled via Windows Registry."""
    import winreg
    key_path = r"Software\Microsoft\Windows\CurrentVersion\Run"

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_READ) as key:
            winreg.QueryValueEx(key, AUTOSTART_APP_NAME)
            return True
    except FileNotFoundError:
        return False


# macOS implementation
def _get_macos_plist_path() -> Path:
    """Get path to macOS LaunchAgent plist."""
    return Path.home() / "Library" / "LaunchAgents" / "io.securevector.threatmonitor.plist"


def _enable_autostart_macos() -> bool:
    """Enable autostart via macOS LaunchAgent."""
    plist_path = _get_macos_plist_path()
    plist_path.parent.mkdir(parents=True, exist_ok=True)

    exe_path = _get_executable_path()

    # Create plist content
    plist_content = f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>io.securevector.threatmonitor</string>
    <key>ProgramArguments</key>
    <array>
        <string>{exe_path}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>
'''
    plist_path.write_text(plist_content)
    return True


def _disable_autostart_macos() -> bool:
    """Disable autostart via macOS LaunchAgent."""
    plist_path = _get_macos_plist_path()
    if plist_path.exists():
        plist_path.unlink()
    return True


def _is_autostart_enabled_macos() -> bool:
    """Check if autostart is enabled via macOS LaunchAgent."""
    return _get_macos_plist_path().exists()


# Linux implementation
def _get_linux_autostart_path() -> Path:
    """Get path to Linux autostart .desktop file."""
    autostart_dir = Path.home() / ".config" / "autostart"
    return autostart_dir / "securevector-threat-monitor.desktop"


def _enable_autostart_linux() -> bool:
    """Enable autostart via XDG autostart."""
    desktop_path = _get_linux_autostart_path()
    desktop_path.parent.mkdir(parents=True, exist_ok=True)

    exe_path = _get_executable_path()

    # Create .desktop file
    desktop_content = f'''[Desktop Entry]
Type=Application
Name=SecureVector Threat Monitor
Comment=AI Threat Monitoring Dashboard
Exec={exe_path}
Icon=securevector
Terminal=false
Categories=Security;Development;
StartupNotify=false
X-GNOME-Autostart-enabled=true
'''
    desktop_path.write_text(desktop_content)
    return True


def _disable_autostart_linux() -> bool:
    """Disable autostart via XDG autostart."""
    desktop_path = _get_linux_autostart_path()
    if desktop_path.exists():
        desktop_path.unlink()
    return True


def _is_autostart_enabled_linux() -> bool:
    """Check if autostart is enabled via XDG autostart."""
    return _get_linux_autostart_path().exists()
