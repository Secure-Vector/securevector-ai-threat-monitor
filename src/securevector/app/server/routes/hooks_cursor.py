"""
Cursor plugin management API endpoints.

Parallel to ``hooks_claude_code.py``, ``hooks_codex.py``, ``hooks_copilot_cli.py``
and ``hooks.py``. All delegate the shared file-staging plumbing to
``_hooks_common``.

GET  /api/hooks/cursor/status     - Plugin install status
POST /api/hooks/cursor/install    - Stage + auto-install into Cursor
POST /api/hooks/cursor/uninstall  - Remove the plugin (idempotent)

Cursor has a first-class PLUGIN system (cursor.com/docs/plugins): a plugin is a
directory with a ``.cursor-plugin/plugin.json`` manifest that BUNDLES its
components — for us, the nine event-typed hooks under ``hooks/``. Cursor
discovers local plugins at ``~/.cursor/plugins/local/<name>/`` (copied, NOT
symlinked — symlinked local plugins don't load), lists them in Settings →
Plugins, and loads their bundled ``hooks/hooks.json`` automatically. So one
install gives BOTH the plugin entry (Settings → Plugins) AND the active hooks
(Settings → Hooks + enforcement) — the same model as the Claude Code plugin,
whose hooks ship inside the plugin bundle rather than in a separate global file.

The install flow:

  1. Stage the plugin tree (local-app URL substituted) into
     ``~/.securevector/staging/cursor-plugin/`` — the source-of-truth copy.
  2. Copy it to ``~/.cursor/plugins/local/securevector-guard/`` (atomic
     tmp→replace; a real directory, never a symlink), then resolve the
     ``__SV_PLUGIN_ROOT__`` placeholder in the COPIED ``hooks/hooks.json`` to
     that absolute dir (Cursor has no ``${PLUGIN_ROOT}`` variable, and absolute
     command paths are robust regardless of the hook working directory).
  3. MIGRATE off the legacy install model: earlier versions copied to
     ``~/.cursor/securevector-guard/<version>/`` and merged nine entries into
     the global ``~/.cursor/hooks.json``. If those are left in place alongside
     the bundled-plugin hooks, every hook fires TWICE (double audit + double
     scan), so install strips our legacy global ``hooks.json`` entries and
     removes the legacy install root. Foreign hooks.json entries are preserved
     verbatim; a one-shot ``.before-securevector`` backup guards the file.

Hooks are read by Cursor at startup: install/uninstall responses tell the user
to reload Cursor.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import _hooks_common

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hooks/cursor", tags=["Hooks"])

PLUGIN_NAME = "securevector-guard"

# Plugin tree files — must match what lives under
# ``src/securevector/plugins/cursor/``. The Cursor manifest is at
# ``.cursor-plugin/plugin.json`` (a dot-dir — see setup.py:package_data +
# MANIFEST.in for the explicit glob; setuptools ``**/*`` skips dot-dirs).
# Cursor splits enforcement across event-typed hooks, so there are nine hook
# scripts instead of the usual four-five, plus the shared decision/audit libs.
PLUGIN_FILES = [
    ".cursor-plugin/plugin.json",
    "hooks/hooks.json",
    "hooks/session-start.js",
    "hooks/before-shell.js",
    "hooks/before-mcp.js",
    "hooks/after-shell.js",
    "hooks/after-mcp.js",
    "hooks/after-file-edit.js",
    "hooks/before-submit-prompt.js",
    "hooks/before-read-file.js",
    "hooks/stop.js",
    "lib/normalize.js",
    "lib/client.js",
    "lib/redact.js",
    "lib/decide.js",
    "lib/audit.js",
    "favicon.ico",  # plugin logo (manifest `logo` field) — binary; staged verbatim
    "LICENSE",
    "README.md",
    "PRIVACY.md",
]

# Bundled plugin source: src/securevector/app/server/routes/<this> → up 4 → securevector/
BUNDLED_PLUGIN_DIR = (
    Path(__file__).parent.parent.parent.parent / "plugins" / "cursor"
)

SECUREVECTOR_DIR = Path.home() / ".securevector"
STAGING_DIR = SECUREVECTOR_DIR / "staging" / "cursor-plugin"

# Cursor per-user home; presence is the "Cursor detected" signal. Honour
# $CURSOR_HOME for tests / relocation, mirroring $COPILOT_HOME handling.
CURSOR_HOME = Path(os.environ.get("CURSOR_HOME", str(Path.home() / ".cursor")))
# Local-plugin install location Cursor discovers + lists in Settings → Plugins.
# Keyed by plugin NAME (no version subdir): the dir name IS the plugin id.
CURSOR_PLUGINS_LOCAL = CURSOR_HOME / "plugins" / "local"
CURSOR_PLUGIN_DIR = CURSOR_PLUGINS_LOCAL / PLUGIN_NAME
CURSOR_MANIFEST = CURSOR_PLUGIN_DIR / ".cursor-plugin" / "plugin.json"

# --- Legacy (pre-plugin) install locations we migrate away from ---------------
# Earlier versions copied to ~/.cursor/securevector-guard/<version>/ and merged
# entries into the global ~/.cursor/hooks.json. Both are torn down on install so
# the bundled-plugin hooks don't fire twice.
CURSOR_HOOKS_JSON = CURSOR_HOME / "hooks.json"
LEGACY_INSTALL_ROOT = CURSOR_HOME / PLUGIN_NAME

# Marker identifying OUR (legacy global) entries inside hooks.json.
_COMMAND_MARKER = f"/{PLUGIN_NAME}/"
# Placeholder in the staged hooks/hooks.json template.
_ROOT_PLACEHOLDER = "__SV_PLUGIN_ROOT__"


# --- Pydantic response models -----------------------------------------------


class StatusResponse(BaseModel):
    installed: bool
    staging_dir: str
    files_present: list[str]
    cursor_detected: bool = False
    # True when the plugin dir + its manifest exist under plugins/local.
    auto_installed: bool = False
    enabled: bool = False


class InstallResponse(BaseModel):
    ok: bool
    staging_dir: str
    files: list[str]
    auto_installed: bool = False
    enabled: bool = False
    install_path: Optional[str] = None
    commands: list[str] = []
    next_step: Optional[str] = None


class UninstallResponse(BaseModel):
    ok: bool


# --- hooks.json (legacy migration) helpers ------------------------------------


def _backup_once(path: Path) -> None:
    """One-shot pristine snapshot to ``<path>.before-securevector`` before the
    first mutation. Never clobbers an existing backup. Best-effort."""
    if not path.is_file():
        return
    backup = path.with_suffix(path.suffix + ".before-securevector")
    if backup.exists():
        return
    try:
        shutil.copy2(path, backup)
        logger.info("Wrote one-shot backup of pre-SecureVector %s to %s", path.name, backup)
    except OSError as e:
        logger.warning("Could not write backup at %s (continuing): %s", backup, e)


def _read_hooks_json(path: Path) -> dict:
    """Read a global ``~/.cursor/hooks.json``; missing/malformed → fresh
    skeleton (malformed is logged, not fatal)."""
    if not path.is_file():
        return {"version": 1, "hooks": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Cursor hooks.json malformed at %s (%s); starting fresh", path, e)
        return {"version": 1, "hooks": {}}
    if not isinstance(data, dict):
        logger.warning("Cursor hooks.json is not an object; starting fresh")
        return {"version": 1, "hooks": {}}
    data.setdefault("version", 1)
    if not isinstance(data.get("hooks"), dict):
        data["hooks"] = {}
    return data


def _is_our_entry(entry: object) -> bool:
    return (
        isinstance(entry, dict)
        and isinstance(entry.get("command"), str)
        and _COMMAND_MARKER in entry["command"]
    )


def _strip_our_entries(hooks: dict) -> dict:
    """Remove SecureVector entries from every event array; drop emptied keys.
    Everything that isn't ours is preserved verbatim."""
    cleaned: dict = {}
    for event, entries in hooks.items():
        if not isinstance(entries, list):
            cleaned[event] = entries
            continue
        kept = [e for e in entries if not _is_our_entry(e)]
        if kept:
            cleaned[event] = kept
    return cleaned


def _atomic_write_json(path: Path, data: dict) -> None:
    """Atomically write JSON with a symlink + traversal guard scoped to
    ``~/.cursor`` / ``~/.securevector`` (plus a configured $CURSOR_HOME)."""
    import tempfile

    resolved_parent = path.parent.resolve(strict=False)
    home = Path.home().resolve(strict=False)
    cursor_root = (home / ".cursor").resolve(strict=False)
    sv_root = (home / ".securevector").resolve(strict=False)
    configured_root = CURSOR_HOME.resolve(strict=False)
    if not (
        resolved_parent.is_relative_to(cursor_root)
        or resolved_parent.is_relative_to(sv_root)
        or resolved_parent.is_relative_to(configured_root)
    ):
        raise PermissionError(
            f"refusing to write outside allowed dirs (~/.cursor or ~/.securevector): "
            f"resolved {resolved_parent} (was {path})"
        )
    if path.is_symlink():
        raise PermissionError(
            f"refusing to write through symlink at {path} (target was {os.readlink(path)})"
        )

    resolved_parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(resolved_parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp_path, resolved_parent / path.name)
    except Exception:
        # Best-effort cleanup of the temp file before re-raising the real
        # write error.
        try:
            os.unlink(tmp_path)
        except OSError:
            # Temp file already gone or can't be removed — swallow this so the
            # original write exception (re-raised below) is what surfaces, not
            # a secondary cleanup error.
            pass
        raise


def _migrate_legacy_global_hooks() -> None:
    """Tear down the pre-plugin install: strip our entries from the global
    ``~/.cursor/hooks.json`` and remove ``~/.cursor/securevector-guard/``. Both
    must go or the bundled-plugin hooks fire a second time. Idempotent + safe on
    a clean machine (no legacy artifacts → no-ops)."""
    # 1. Legacy versioned install root.
    if LEGACY_INSTALL_ROOT.is_dir():
        shutil.rmtree(LEGACY_INSTALL_ROOT, ignore_errors=True)
        logger.info("Removed legacy Cursor install root at %s", LEGACY_INSTALL_ROOT)

    # 2. Legacy global hooks.json entries.
    if not CURSOR_HOOKS_JSON.is_file():
        return
    data = _read_hooks_json(CURSOR_HOOKS_JSON)
    stripped = _strip_our_entries(data["hooks"])
    if stripped != data["hooks"]:
        _backup_once(CURSOR_HOOKS_JSON)
        data["hooks"] = stripped
        try:
            _atomic_write_json(CURSOR_HOOKS_JSON, data)
            logger.info(
                "Migrated: removed legacy %s entries from global %s (plugin now owns the hooks)",
                PLUGIN_NAME, CURSOR_HOOKS_JSON,
            )
        except Exception as e:  # best-effort; not fatal to the plugin install
            logger.warning("Could not rewrite legacy Cursor hooks.json (continuing): %s", e)


# --- plugin install helpers ---------------------------------------------------


def _resolve_root_placeholder(plugin_dir: Path) -> None:
    """Resolve ``__SV_PLUGIN_ROOT__`` → the absolute plugin dir inside the
    COPIED ``hooks/hooks.json`` so Cursor runs the bundled scripts by absolute
    path (robust regardless of the hook working directory)."""
    hooks_json = plugin_dir / "hooks" / "hooks.json"
    text = hooks_json.read_text(encoding="utf-8")
    if _ROOT_PLACEHOLDER in text:
        hooks_json.write_text(text.replace(_ROOT_PLACEHOLDER, str(plugin_dir)), encoding="utf-8")


def _auto_install_to_cursor() -> Path:
    """Copy the staged tree into ``~/.cursor/plugins/local/securevector-guard/``
    (atomic tmp→replace, real dir) and resolve the hook-root placeholder, then
    migrate off the legacy global-hooks install. Idempotent: reinstall replaces
    the plugin dir in place."""
    # 1. Copy plugin files to the local-plugins dir (atomic: tmp → replace).
    CURSOR_PLUGIN_DIR.parent.mkdir(parents=True, exist_ok=True)
    tmp_install = CURSOR_PLUGIN_DIR.parent / (CURSOR_PLUGIN_DIR.name + ".tmp")
    if tmp_install.exists():
        shutil.rmtree(tmp_install, ignore_errors=True)
    shutil.copytree(STAGING_DIR, tmp_install)
    if CURSOR_PLUGIN_DIR.exists():
        shutil.rmtree(CURSOR_PLUGIN_DIR, ignore_errors=True)
    os.replace(tmp_install, CURSOR_PLUGIN_DIR)

    # 2. Point the bundled hooks at their absolute on-disk location.
    _resolve_root_placeholder(CURSOR_PLUGIN_DIR)

    # 3. Migrate away from the legacy global-hooks model (prevents double-fire).
    _migrate_legacy_global_hooks()

    logger.info(
        "Auto-installed Cursor plugin %s → %s (bundled hooks; Settings → Plugins)",
        PLUGIN_NAME, CURSOR_PLUGIN_DIR,
    )
    return CURSOR_PLUGIN_DIR


def _is_installed_enabled() -> bool:
    """True when the local-plugin dir exists with its manifest. A discovered
    local plugin is enabled by default (no separate enable flag for local
    plugins), so presence == enabled."""
    return CURSOR_PLUGIN_DIR.is_dir() and CURSOR_MANIFEST.is_file()


# --- Routes -----------------------------------------------------------------


@router.get("/status", response_model=StatusResponse)
async def plugin_status():
    """Whether the plugin is staged, whether Cursor is installed, and whether
    the local-plugin dir + manifest are present. Read-only."""
    files_present = [f for f in PLUGIN_FILES if (STAGING_DIR / f).is_file()]
    enabled = _is_installed_enabled()
    return StatusResponse(
        installed=len(files_present) == len(PLUGIN_FILES),
        staging_dir=str(STAGING_DIR),
        files_present=files_present,
        cursor_detected=CURSOR_HOME.is_dir(),
        auto_installed=enabled,
        enabled=enabled,
    )


@router.post("/install", response_model=InstallResponse)
async def install_plugin():
    """Stage the plugin tree (URL-substituted), then — if Cursor is installed —
    copy it to ``~/.cursor/plugins/local/securevector-guard/`` so Cursor lists
    it in Settings → Plugins and loads its bundled hooks. Idempotent."""
    _hooks_common.ensure_bundled_dir(BUNDLED_PLUGIN_DIR, PLUGIN_FILES)
    sv_url = _hooks_common.resolve_sv_url()
    # Clear any prior staging first: stage_files is additive, and we copytree the
    # whole staging dir into the install location — so a file dropped from
    # PLUGIN_FILES across versions (e.g. the old root plugin.json, replaced by
    # .cursor-plugin/plugin.json) would otherwise linger in staging and ship.
    if STAGING_DIR.exists():
        shutil.rmtree(STAGING_DIR, ignore_errors=True)
    files_written = _hooks_common.stage_files(
        staging_dir=STAGING_DIR,
        source_dir=BUNDLED_PLUGIN_DIR,
        files=PLUGIN_FILES,
        substitutions={
            "http://127.0.0.1:8741": sv_url,
            "http://localhost:8741": sv_url,
        },
    )

    logger.info(
        "Staged %d Cursor plugin file(s) for %s at %s (sv_url=%s)",
        len(files_written), PLUGIN_NAME, STAGING_DIR, sv_url,
    )

    # Defense-in-depth: zero files means the bundled plugin assets are missing
    # from the installed package (wheel built without the plugin's non-Python
    # files — see setup.py:package_data + MANIFEST.in, incl. the .cursor-plugin
    # dot-dir which setuptools ``**/*`` skips).
    if not files_written:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Cursor plugin staging produced 0 files from {BUNDLED_PLUGIN_DIR}. "
                "Bundled plugin assets are missing from the installed package — verify "
                "setup.py:package_data and MANIFEST.in include plugins/cursor/**/* "
                "AND plugins/cursor/.cursor-plugin/*."
            ),
        )

    if CURSOR_HOME.is_dir():
        try:
            install_path = _auto_install_to_cursor()
        except Exception as e:  # surface, but don't lose the staged copy
            logger.exception("Cursor auto-install failed; staged copy is intact")
            raise HTTPException(
                status_code=500,
                detail=(
                    f"Staged the plugin but failed to install into Cursor: {e}. "
                    f"You can copy {STAGING_DIR} to "
                    f"~/.cursor/plugins/local/{PLUGIN_NAME}/ manually."
                ),
            )
        return InstallResponse(
            ok=True,
            staging_dir=str(STAGING_DIR),
            files=files_written,
            auto_installed=True,
            enabled=True,
            install_path=str(install_path),
            commands=[],
            next_step=(
                "Installed as a Cursor plugin. Reload Cursor (Cmd+Shift+P → "
                "\"Developer: Reload Window\", or restart) — it then appears in "
                "Settings → Plugins and its hooks activate (Settings → Hooks)."
            ),
        )

    # Fallback: Cursor not installed — staged only.
    return InstallResponse(
        ok=True,
        staging_dir=str(STAGING_DIR),
        files=files_written,
        auto_installed=False,
        enabled=False,
        install_path=None,
        commands=[],
        next_step=(
            "Cursor was not detected (~/.cursor is absent). Install Cursor, "
            "then run this install again to register the plugin."
        ),
    )


@router.post("/uninstall", response_model=UninstallResponse)
async def uninstall_plugin():
    """Remove the plugin everywhere we wrote it: the staged tree, the local
    plugin dir under ~/.cursor/plugins/local, and any legacy global-hooks
    artifacts. Idempotent."""
    # 1. Staged source-of-truth tree.
    if STAGING_DIR.is_dir():
        shutil.rmtree(STAGING_DIR, ignore_errors=True)
        logger.info("Removed staged Cursor plugin tree at %s", STAGING_DIR)

    # 2. Installed local-plugin dir.
    if CURSOR_PLUGIN_DIR.is_dir():
        shutil.rmtree(CURSOR_PLUGIN_DIR, ignore_errors=True)
        logger.info("Removed Cursor plugin at %s", CURSOR_PLUGIN_DIR)

    # 3. Tear down any legacy global-hooks install (versioned dir + hooks.json
    #    entries). Reuses the install-time migration — it only removes OUR
    #    artifacts and preserves foreign hooks.json entries.
    _migrate_legacy_global_hooks()

    return UninstallResponse(ok=True)
