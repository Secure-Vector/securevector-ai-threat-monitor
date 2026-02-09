"""
Secure credential storage for SecureVector Cloud API key.

Stores API key in a file in the app data directory with restricted permissions.
"""

import json
import logging
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


def _get_credentials_file() -> Path:
    """Get path to credentials file."""
    from securevector.app.utils.platform import user_data_dir
    return Path(user_data_dir()) / ".credentials"


def save_credentials(api_key: str) -> bool:
    """
    Save API key to file storage.
    """
    try:
        creds_file = _get_credentials_file()
        creds_file.parent.mkdir(parents=True, exist_ok=True)

        data = {"api_key": api_key, "v": 1}

        # Write with restricted permissions from the start (no race window)
        fd = os.open(creds_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, json.dumps(data).encode())
        finally:
            os.close(fd)
        return True
    except Exception:
        return False


def get_api_key() -> Optional[str]:
    """
    Get API key from file storage.
    """
    try:
        creds_file = _get_credentials_file()
        if not creds_file.exists():
            return None

        data = json.loads(creds_file.read_text())
        return data.get("api_key")
    except Exception:
        return None


def get_bearer_token() -> Optional[str]:
    """Get bearer token (same as API key)."""
    return get_api_key()


def delete_credentials() -> bool:
    """
    Delete credentials file.
    """
    try:
        creds_file = _get_credentials_file()
        if creds_file.exists():
            creds_file.unlink()
        return True
    except Exception:
        return False


def credentials_configured() -> bool:
    """Check if API key is configured."""
    return get_api_key() is not None
