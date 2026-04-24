"""
Per-forwarder secret storage.

The `external_forwarders` SQLite row stores a ``secret_ref`` (opaque
UUID), never the raw credential. This module resolves a ``secret_ref``
to its plaintext value at send time and back. Storage is a single
``.forwarder-secrets.json`` file in the app data directory, created
0o600 and held in-process via the same pattern as ``credentials.py``
(no OS keychain dependency — works identically on every platform where
the desktop app runs).

Why separate from ``credentials.py``:
  - Credentials module stores exactly one API key (the cloud key) —
    single-value shape. Forwarders need a keyed map (one entry per
    destination).
  - Lifecycle differs: a forwarder secret vanishes when the forwarder
    row is deleted; the cloud key lives until the user explicitly
    disconnects.

Threat model this protects against:
  - SQLite exfil alone → attacker gets URLs and names, no tokens.
  - File exfil of the secrets file alone → attacker gets tokens but
    no URLs / context.
  - Both → equivalent to running on the host, which is outside scope
    (the cloud_sync_forwarder's off-host shipping is the mitigation
    for "attacker on host").
"""

from __future__ import annotations

import json
import logging
import os
import secrets as _secrets
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_FILE_MODE = 0o600
_DIR_MODE = 0o700


def _secrets_file() -> Path:
    from securevector.app.utils.platform import user_data_dir
    return Path(user_data_dir(None, None)) / ".forwarder-secrets.json"


def _read_all() -> dict[str, str]:
    path = _secrets_file()
    if not path.exists():
        return {}
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception as e:
        logger.error(f"forwarder_secrets: failed to read store: {e}")
        return {}


def _write_all(store: dict[str, str]) -> bool:
    path = _secrets_file()
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=_DIR_MODE)
        # Restricted perms from the start (no race window).
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, _FILE_MODE)
        try:
            os.write(fd, json.dumps(store, separators=(",", ":")).encode("utf-8"))
        finally:
            os.close(fd)
        return True
    except Exception as e:
        logger.error(f"forwarder_secrets: failed to write store: {e}")
        return False


def save_secret(value: str) -> Optional[str]:
    """Persist a secret and return its `secret_ref` (opaque UUID-ish token)."""
    if not value:
        return None
    ref = "sv_fwd_" + _secrets.token_urlsafe(24)
    store = _read_all()
    store[ref] = value
    if not _write_all(store):
        return None
    return ref


def get_secret(secret_ref: str) -> Optional[str]:
    if not secret_ref:
        return None
    return _read_all().get(secret_ref)


def update_secret(secret_ref: str, value: str) -> bool:
    if not secret_ref:
        return False
    store = _read_all()
    if secret_ref not in store:
        return False
    store[secret_ref] = value
    return _write_all(store)


def delete_secret(secret_ref: str) -> bool:
    if not secret_ref:
        return True
    store = _read_all()
    if secret_ref not in store:
        return True
    store.pop(secret_ref, None)
    return _write_all(store)
