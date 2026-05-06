"""
Secure credential storage for SecureVector Cloud / Org-enrolled sessions.

Stores credentials in a 0600-permission file in the app data directory.
Schema is versioned via the `v` field; loaders accept legacy v1 (raw
api_key only) and the v2 enrolled shape (org binding + Supabase JWT
+ policy bundle signing key) introduced by the active-mcp-and-policy-sync
bundle.
"""

import json
import logging
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import List, Literal, Optional

logger = logging.getLogger(__name__)


TokenType = Literal["svet", "svpk", "legacy"]


def detect_token_type(token: str) -> TokenType:
    """
    Distinguish enrollment tokens, personal API keys, and legacy keys by prefix.

    - `svet_<...>` → org enrollment token (single-use, redeem via /api/v1/devices/enroll)
    - `svpk_<...>` → personal API key (Cloud Connect personal mode)
    - everything else → legacy unprefixed personal API key (grandfathered)
    """
    if not token:
        return "legacy"
    if token.startswith("svet_"):
        return "svet"
    if token.startswith("svpk_"):
        return "svpk"
    return "legacy"


@dataclass
class EnrolledCredentials:
    """v2 credential shape — populated after a successful svet_* redemption."""

    # Org binding
    device_record_id: str
    device_id: str
    org_id: str
    org_name: str
    user_id: str
    user_email: str
    admin_email: Optional[str] = None
    group_memberships: List[str] = field(default_factory=list)

    # Auth
    supabase_jwt: Optional[str] = None
    supabase_refresh_token: Optional[str] = None
    jwt_expires_at: Optional[str] = None  # ISO-8601, set when jwt minted

    # Policy bundle signing
    policy_bundle_signing_key: Optional[str] = None


def _get_credentials_file() -> Path:
    """Get path to credentials file."""
    from securevector.app.utils.platform import user_data_dir
    return Path(user_data_dir(None, None)) / ".credentials"


def _atomic_write(path: Path, payload: dict) -> bool:
    """Write JSON to `path` with 0600 permissions in a single open() call."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, json.dumps(payload).encode())
        finally:
            os.close(fd)
        return True
    except Exception as exc:  # pragma: no cover - depends on FS state
        logger.warning("Failed to write credentials: %s", exc)
        return False


def _load_raw() -> Optional[dict]:
    """Read the raw credentials JSON, or None if missing/unreadable."""
    creds_file = _get_credentials_file()
    if not creds_file.exists():
        return None
    try:
        return json.loads(creds_file.read_text())
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Personal-key path (svpk_* and legacy)
# ---------------------------------------------------------------------------

def save_credentials(api_key: str) -> bool:
    """Save personal API key (legacy v1 shape — `api_key` field only)."""
    return _atomic_write(_get_credentials_file(), {"api_key": api_key, "v": 1})


def get_api_key() -> Optional[str]:
    """Get personal API key from file storage."""
    data = _load_raw()
    if not data:
        return None
    return data.get("api_key")


def get_bearer_token() -> Optional[str]:
    """Get bearer token (same as API key for the personal path)."""
    return get_api_key()


def delete_credentials() -> bool:
    """Delete credentials file. Idempotent — succeeds if already gone."""
    try:
        creds_file = _get_credentials_file()
        if creds_file.exists():
            creds_file.unlink()
        return True
    except Exception:
        return False


def credentials_configured() -> bool:
    """True if any kind of credential is configured (personal or enrolled)."""
    data = _load_raw()
    if not data:
        return False
    return bool(data.get("api_key")) or bool(data.get("enrolled"))


# ---------------------------------------------------------------------------
# Enrolled path (svet_* — active-mcp-and-policy-sync)
# ---------------------------------------------------------------------------

def save_enrolled_credentials(creds: EnrolledCredentials) -> bool:
    """
    Persist the enrolled credential bundle.

    Lives next to the personal `api_key` field — both can coexist for users
    who have a personal subscription AND an org enrollment. Enrollment
    binding always wins for /policy/sync; the personal key continues to be
    used for any non-enrolled cloud calls.
    """
    existing = _load_raw() or {}
    payload = {
        **existing,
        "v": 2,
        "enrolled": asdict(creds),
    }
    return _atomic_write(_get_credentials_file(), payload)


def get_enrolled_credentials() -> Optional[EnrolledCredentials]:
    """Load the enrolled credentials, or None if the device isn't enrolled."""
    data = _load_raw()
    if not data:
        return None
    blob = data.get("enrolled")
    if not blob:
        return None
    try:
        # Filter to known fields so renames don't crash the loader
        known = {f.name for f in EnrolledCredentials.__dataclass_fields__.values()}
        filtered = {k: v for k, v in blob.items() if k in known}
        # Defaults for newly added fields
        if "group_memberships" not in filtered:
            filtered["group_memberships"] = []
        return EnrolledCredentials(**filtered)
    except Exception as exc:
        logger.warning("Failed to deserialise enrolled credentials: %s", exc)
        return None


def is_enrolled() -> bool:
    """True if this device has been redeemed against an org."""
    return get_enrolled_credentials() is not None


def update_supabase_jwt(access_token: str, refresh_token: str, expires_at: Optional[str] = None) -> bool:
    """Refresh the stored Supabase JWT pair after a /auth/token round-trip."""
    creds = get_enrolled_credentials()
    if not creds:
        return False
    creds.supabase_jwt = access_token
    creds.supabase_refresh_token = refresh_token
    if expires_at:
        creds.jwt_expires_at = expires_at
    return save_enrolled_credentials(creds)


def clear_enrolled_credentials() -> bool:
    """
    Remove the enrolled-block while preserving the personal `api_key`.

    Used by graceful unenroll / explicit disconnect-from-org. The personal
    key (if any) survives — the device falls back to personal mode.
    """
    data = _load_raw() or {}
    if "enrolled" in data:
        data.pop("enrolled")
    return _atomic_write(_get_credentials_file(), data)
