"""Shared plumbing for plugin install/uninstall routes.

Lifted out of ``hooks.py`` (which serves the OpenClaw plugin today) so the
same plumbing can serve additional agent-runtime plugins in the same shape
— each runtime gets its own thin route module that delegates here for
URL resolution, bundled-source verification, and staging-dir file copy.

Functions in this module are intentionally generic: they take their config
(paths, file lists, substitutions) as arguments rather than hard-coding
any particular plugin's layout.
"""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger(__name__)


def _load_server_config() -> dict:
    """Return the server section of the local app's config file.

    Wrapped in a function so tests can monkey-patch it cleanly.
    Returns {} when the config file is missing or unreadable.
    """
    try:
        from securevector.app.utils.config_file import load_config
        cfg = load_config()
        return cfg.get("server", {}) or {}
    except Exception as e:
        logger.debug("Could not load svconfig, using defaults: %s", e)
        return {}


def resolve_sv_url() -> str:
    """Resolve the local app's base URL from svconfig + env vars.

    Lookup order:
      1. ``SV_WEB_PORT`` env var (fallback default 8741)
      2. ``server.host`` / ``server.port`` in the svconfig file (overrides env)
    """
    sv_port = os.environ.get("SV_WEB_PORT", "8741")
    sv_host = "127.0.0.1"
    server_cfg = _load_server_config()
    if server_cfg:
        sv_host = server_cfg.get("host", sv_host)
        sv_port = str(server_cfg.get("port", sv_port))
    return f"http://{sv_host}:{sv_port}"


def ensure_bundled_dir(
    bundled_dir: Path,
    files: list[str],
    regenerate_cb: Optional[Callable[[Path], None]] = None,
) -> Path:
    """Return ``bundled_dir`` if it has all expected files; otherwise regenerate.

    If every file in ``files`` exists under ``bundled_dir`` the directory
    is returned as-is. Otherwise — and only if a ``regenerate_cb`` is
    provided — the directory is created and the callback is invoked with
    the directory path so it can populate plugin-specific files
    (templates, etc.). The callback is the per-plugin extension point.

    If files are missing and no callback is provided, the directory is
    returned regardless and the caller is expected to handle the gap.
    """
    if bundled_dir.is_dir() and all((bundled_dir / f).is_file() for f in files):
        return bundled_dir

    if regenerate_cb is not None:
        logger.info(
            "Bundled plugin dir missing or incomplete at %s, regenerating...",
            bundled_dir,
        )
        bundled_dir.mkdir(parents=True, exist_ok=True)
        regenerate_cb(bundled_dir)
        logger.info("Regenerated bundled plugin files at %s", bundled_dir)

    return bundled_dir


def _atomic_write(dst: Path, data: bytes) -> None:
    """Write ``data`` to ``dst`` via a temp file in the same folder and a
    rename, so a reader never sees a half-written file and an existing
    symlink at ``dst`` is replaced rather than followed."""
    mode = 0o644
    if dst.is_file() and not dst.is_symlink():
        mode = dst.stat().st_mode & 0o777  # keep an existing file's mode
    fd, tmp = tempfile.mkstemp(prefix="." + dst.name + ".", suffix=".tmp", dir=str(dst.parent))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        try:
            os.chmod(tmp, mode)
        except OSError:
            pass
        os.replace(tmp, dst)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def stage_files(
    *,
    staging_dir: Path,
    source_dir: Path,
    files: list[str],
    substitutions: dict[str, str],
) -> list[str]:
    """Copy ``files`` from ``source_dir`` to ``staging_dir`` with substitutions.

    For each filename in ``files``, the file is read from ``source_dir``,
    every key in ``substitutions`` is replaced with its value, and the
    result is written to ``staging_dir``. Missing source files are
    logged but do not abort the rest of the copy.

    Binary files (e.g. a plugin ``logo``/``favicon.ico``) are NOT valid UTF-8
    text; a text read+rewrite would corrupt them. Such files are detected by a
    ``UnicodeDecodeError`` on read and copied byte-for-byte instead (no
    substitution — binary assets never contain the loopback URL). Text files
    are unchanged by this fallback.

    Returns the list of filenames that were successfully written.
    """
    staging_dir.mkdir(parents=True, exist_ok=True)

    written: list[str] = []
    for filename in files:
        src = source_dir / filename
        dst = staging_dir / filename
        if not src.is_file():
            logger.warning("Plugin file not found: %s", src)
            continue
        # A symlinked folder would send the write elsewhere: refuse it. A
        # symlinked destination file is replaced by our real file below
        # (os.replace swaps the link itself, never its target).
        if dst.parent != staging_dir and dst.parent.is_symlink():
            logger.warning("Refusing to write plugin file through a symlinked folder: %s", dst)
            continue
        # Create any nested parent directories the file path requires
        # (e.g. .claude-plugin/, hooks/, lib/ under the staging root).
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            content = src.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            # Binary asset (image, etc.) — copy verbatim, no substitution.
            _atomic_write(dst, src.read_bytes())
            written.append(filename)
            continue
        for needle, replacement in substitutions.items():
            content = content.replace(needle, replacement)
        _atomic_write(dst, content.encode("utf-8"))
        written.append(filename)
    return written
