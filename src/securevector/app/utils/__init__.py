"""
Utility modules for the SecureVector desktop application.

This package contains cross-platform utilities for:
- Platform-specific paths and directories
- System notifications
- Other OS-specific functionality
"""

from securevector.app.utils.platform import (
    get_app_data_dir,
    get_database_path,
    get_custom_rules_dir,
    get_settings_path,
)

__all__ = [
    "get_app_data_dir",
    "get_database_path",
    "get_custom_rules_dir",
    "get_settings_path",
]
