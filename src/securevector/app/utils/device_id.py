"""
Stable per-device identifier for SecureVector installs.

Stamped on every scan and audit row so the customer can slice activity
by device in their SOC / SIEM dashboards. Designed to be:

  - Stable across app restarts
  - Stable across app reinstalls on the same machine (the common case
    that a one-file generated UUID gets wrong)
  - Different per physical device
  - Non-identifying when it leaves the box — we SHA-256 the raw
    machine UUID with a namespace prefix so the wire format is
    ``sv-<24 hex chars>`` and the raw OS identifier never reaches a
    log file or an outbound event

Resolution order (first hit wins):

  1. Cached file at ``{app_data_dir}/.device_id``. Preserved across
     app reinstalls as long as the user does not also wipe the app
     data dir. Returned verbatim if present.
  2. OS-provided stable machine identifier, hashed into an sv- prefix
     and written to the cache file:
       - macOS   → ``ioreg`` IOPlatformUUID
       - Linux   → ``/etc/machine-id`` (fallback ``/var/lib/dbus/machine-id``)
       - Windows → ``HKLM\\SOFTWARE\\Microsoft\\Cryptography\\MachineGuid``
     This layer is what makes the ID survive reinstalls — the OS
     identifier outlives the app install.
  3. Random UUID4, hashed and cached to file. Only reached when the
     OS refuses to give us an identifier (extremely rare on macOS /
     Windows; possible on some containerised Linux setups).

Nothing here phones home — the OS identifier is read locally,
hashed locally, never transmitted as raw bytes.
"""

from __future__ import annotations

import hashlib
import logging
import os
import platform
import subprocess
import uuid
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_FILE_NAME = ".device_id"
_PREFIX = "sv-"
_HASH_NAMESPACE = "securevector-device-v1"
_HASH_LEN = 24  # hex chars of SHA-256, keeps the ID short but collision-safe

# Process-local cache so every caller isn't re-reading the file.
_CACHED_ID: Optional[str] = None


def _data_file() -> Path:
    from securevector.app.utils.platform import user_data_dir
    return Path(user_data_dir(None, None)) / _FILE_NAME


def _hash_id(raw: str) -> str:
    """Namespaced SHA-256, truncated to 24 hex chars. The namespace
    prefix prevents collisions if we ever start hashing other values
    with the same salt-less approach elsewhere."""
    digest = hashlib.sha256(f"{_HASH_NAMESPACE}:{raw}".encode("utf-8")).hexdigest()
    return _PREFIX + digest[:_HASH_LEN]


def _read_os_machine_id() -> Optional[str]:
    """Platform-specific read of the OS's stable machine identifier.

    Returns the raw value — caller hashes. Returns None when the
    identifier is unavailable; caller falls back to a random UUID.
    Any exception during read is swallowed so a quirky environment
    doesn't block app boot.
    """
    try:
        system = platform.system()
        if system == "Darwin":
            # `ioreg` output includes a line like:
            #   "IOPlatformUUID" = "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
            out = subprocess.check_output(
                ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=2,
            )
            for line in out.splitlines():
                if "IOPlatformUUID" in line:
                    parts = line.split("=", 1)
                    if len(parts) == 2:
                        value = parts[1].strip().strip('"').strip()
                        if value:
                            return value
        elif system == "Linux":
            for candidate in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
                try:
                    with open(candidate, "r", encoding="utf-8") as f:
                        value = f.read().strip()
                        if value:
                            return value
                except FileNotFoundError:
                    continue
                except OSError:
                    continue
        elif system == "Windows":  # pragma: no cover — platform-dependent
            try:
                import winreg
                key = winreg.OpenKey(
                    winreg.HKEY_LOCAL_MACHINE,
                    r"SOFTWARE\Microsoft\Cryptography",
                )
                try:
                    value, _ = winreg.QueryValueEx(key, "MachineGuid")
                finally:
                    winreg.CloseKey(key)
                if value:
                    return str(value).strip()
            except Exception:
                return None
    except Exception as e:  # defensive — never block on identifier fetch
        logger.debug(f"device_id: failed to read OS machine ID: {e}")
    return None


def _read_cache_file() -> Optional[str]:
    try:
        path = _data_file()
        if path.exists():
            value = path.read_text(encoding="utf-8").strip()
            if value.startswith(_PREFIX):
                return value
    except Exception as e:
        logger.debug(f"device_id: cache read failed: {e}")
    return None


def _write_cache_file(value: str) -> None:
    try:
        path = _data_file()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, value.encode("utf-8"))
        finally:
            os.close(fd)
    except Exception as e:
        logger.debug(f"device_id: cache write failed (non-fatal): {e}")


def get_device_id() -> str:
    """Return the stable device identifier for this install.

    Deterministic across restarts and reinstalls on the same machine.
    Cached in-process after the first call so the hot path stays free
    of file I/O and subprocess calls.
    """
    global _CACHED_ID
    if _CACHED_ID:
        return _CACHED_ID

    existing = _read_cache_file()
    if existing:
        _CACHED_ID = existing
        return existing

    os_id = _read_os_machine_id()
    if os_id:
        device_id = _hash_id(os_id)
        logger.info("device_id: derived from OS machine identifier (stable across reinstalls)")
    else:
        device_id = _hash_id(str(uuid.uuid4()))
        logger.info("device_id: generated random UUID (OS machine ID unavailable — install-scoped only)")

    _write_cache_file(device_id)
    _CACHED_ID = device_id
    return device_id


def reset_cached_device_id() -> None:
    """Test hook. Drops the in-process cache so the next get_device_id()
    call re-reads from disk / OS."""
    global _CACHED_ID
    _CACHED_ID = None
