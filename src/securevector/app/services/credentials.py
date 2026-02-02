"""
Secure credential storage for SecureVector Cloud webapp credentials.

Stores credentials from app.securevector.io securely in OS keychain:
- Windows: Credential Manager
- macOS: Keychain
- Linux: Secret Service (GNOME Keyring, KWallet, etc.)

Users copy their API Key and Bearer Token from the SecureVector Cloud webapp
(app.securevector.io) and enter them in the desktop app Settings page.

Stored credentials:
- API Key: Used for /api/analyze endpoint (X-Api-Key header)
- Bearer Token: Used for /api/threat-analytics/ and /api/rules (Authorization header)
"""

import logging
from typing import Optional

try:
    import keyring
    from keyring.errors import KeyringError

    KEYRING_AVAILABLE = True
except ImportError:
    KEYRING_AVAILABLE = False
    KeyringError = Exception  # type: ignore

logger = logging.getLogger(__name__)

SERVICE_NAME = "securevector-desktop"
API_KEY_ACCOUNT = "api_key"
BEARER_TOKEN_ACCOUNT = "bearer_token"


def is_keyring_available() -> bool:
    """Check if keyring is available and functional."""
    if not KEYRING_AVAILABLE:
        return False
    try:
        # Try to get the backend to verify it's working
        keyring.get_keyring()
        return True
    except Exception:
        return False


def save_credentials(api_key: str, bearer_token: str) -> bool:
    """
    Save both API key and bearer token to OS keychain.

    Args:
        api_key: The API key for X-Api-Key header.
        bearer_token: The bearer token for Authorization header.

    Returns:
        True if saved successfully, False otherwise.
    """
    if not KEYRING_AVAILABLE:
        logger.warning("Keyring not available, cannot save credentials")
        return False

    try:
        keyring.set_password(SERVICE_NAME, API_KEY_ACCOUNT, api_key)
        keyring.set_password(SERVICE_NAME, BEARER_TOKEN_ACCOUNT, bearer_token)
        logger.info("Credentials saved to OS keychain")
        return True
    except KeyringError as e:
        logger.error(f"Failed to save credentials: {e}")
        return False


def get_api_key() -> Optional[str]:
    """
    Retrieve the API key from OS keychain.

    Returns:
        The API key if found, None otherwise.
    """
    if not KEYRING_AVAILABLE:
        return None

    try:
        return keyring.get_password(SERVICE_NAME, API_KEY_ACCOUNT)
    except KeyringError as e:
        # Only log at debug level - this is expected when no credentials configured
        logger.debug(f"No API key configured: {e}")
        return None
    except Exception as e:
        # Log other unexpected errors but don't spam logs
        logger.debug(f"Could not retrieve API key: {e}")
        return None


def get_bearer_token() -> Optional[str]:
    """
    Retrieve the bearer token from OS keychain.

    Returns:
        The bearer token if found, None otherwise.
    """
    if not KEYRING_AVAILABLE:
        return None

    try:
        return keyring.get_password(SERVICE_NAME, BEARER_TOKEN_ACCOUNT)
    except KeyringError as e:
        # Only log at debug level - this is expected when no credentials configured
        logger.debug(f"No bearer token configured: {e}")
        return None
    except Exception as e:
        # Log other unexpected errors but don't spam logs
        logger.debug(f"Could not retrieve bearer token: {e}")
        return None


def credentials_configured() -> bool:
    """
    Check if both credentials are configured.

    Returns:
        True if both API key and bearer token are stored.
    """
    api_key = get_api_key()
    bearer_token = get_bearer_token()
    return api_key is not None and bearer_token is not None


def delete_credentials() -> bool:
    """
    Remove both credentials from OS keychain.

    Returns:
        True if deleted successfully (or didn't exist), False on error.
    """
    if not KEYRING_AVAILABLE:
        logger.warning("Keyring not available, cannot delete credentials")
        return False

    success = True
    try:
        keyring.delete_password(SERVICE_NAME, API_KEY_ACCOUNT)
    except KeyringError:
        # Password might not exist, that's ok
        pass
    except Exception as e:
        logger.error(f"Failed to delete API key: {e}")
        success = False

    try:
        keyring.delete_password(SERVICE_NAME, BEARER_TOKEN_ACCOUNT)
    except KeyringError:
        # Password might not exist, that's ok
        pass
    except Exception as e:
        logger.error(f"Failed to delete bearer token: {e}")
        success = False

    if success:
        logger.info("Credentials removed from OS keychain")
    return success
