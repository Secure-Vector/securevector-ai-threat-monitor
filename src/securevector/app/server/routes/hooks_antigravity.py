"""
Antigravity plugin management API endpoints.

Parallel to ``hooks_cursor.py``, ``hooks_claude_code.py``, ``hooks_codex.py``,
``hooks_copilot_cli.py`` and ``hooks_opencode.py``. All delegate the shared
file-staging plumbing to ``_hooks_common``.

GET  /api/hooks/antigravity/status     - Plugin install status
POST /api/hooks/antigravity/install    - Stage + auto-install into Antigravity
POST /api/hooks/antigravity/uninstall  - Remove the plugin (idempotent)

Antigravity (Google's Gemini-lineage agent, CLI binary ``agy``) has a
first-class PLUGIN system: a plugin is a directory holding a ``plugin.json``
marker and, optionally, a ``hooks.json`` at the same level, which the loader
picks up automatically. So one install yields both the plugin entry and the
active hooks, the same model as the Claude Code and Cursor plugins.

Two install locations are documented, and this module writes the broader one:

  ``~/.gemini/config/plugins/<name>/``        - shared by Antigravity 2.0, the
                                                CLI, and the standalone IDE
  ``~/.gemini/antigravity-cli/plugins/<name>/`` - CLI-only staged location

Installing to the shared location means one install covers every Antigravity
surface the user has, rather than only the CLI.

There is deliberately no registry write. Unlike Copilot CLI (``config.json``
``installedPlugins[]``) or Codex (a TOML table), Antigravity's first-party
docs describe discovery purely by directory presence, and name no file that
records installed or enabled plugins. ``agy plugin disable`` implies some
state exists somewhere, but writing to a file we have not seen would be
guessing at another product's private format. Presence is therefore treated as
enabled, which is what ``hooks_cursor`` does for the same reason. If a
registry is later confirmed empirically, ``_is_installed_enabled`` and the
install path are the two places that need to learn about it.

Hooks are read when Antigravity starts, so install and uninstall responses
tell the user to restart the CLI.
"""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import _hooks_common
from ._plugin_guard import require_local_origin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hooks/antigravity", tags=["Hooks"])

PLUGIN_NAME = "securevector-guard"

# Plugin tree files, which must match what lives under
# ``src/securevector/plugins/antigravity/``. Antigravity puts both the
# ``plugin.json`` marker and ``hooks.json`` at the plugin ROOT (not in a
# dot-dir and not under ``hooks/``), so setup.py's ``**/*`` glob is enough
# here and no explicit dot-dir line is needed.
#
# Three hook scripts rather than the usual four: Antigravity has no
# SessionStart event (PreInvocation carries that work) and no event that
# exposes the user's prompt, so there is no user-prompt-submit equivalent to
# ship. See the plugin README.
PLUGIN_FILES = [
    "plugin.json",
    "hooks.json",
    "hooks/pre-tool-use.js",
    "hooks/post-tool-use.js",
    "hooks/pre-invocation.js",
    "lib/normalize.js",
    "lib/client.js",
    "lib/redact.js",
    "LICENSE",
    "README.md",
    "PRIVACY.md",
]

# Bundled plugin source: src/securevector/app/server/routes/<this> -> up 4 -> securevector/
BUNDLED_PLUGIN_DIR = (
    Path(__file__).parent.parent.parent.parent / "plugins" / "antigravity"
)

SECUREVECTOR_DIR = Path.home() / ".securevector"
STAGING_DIR = SECUREVECTOR_DIR / "staging" / "antigravity-plugin"

# Antigravity per-user home; presence is the "Antigravity detected" signal.
# Honour $GEMINI_HOME for tests and relocation, mirroring $CURSOR_HOME and
# $COPILOT_HOME handling in the sibling modules.
GEMINI_HOME = Path(os.environ.get("GEMINI_HOME", str(Path.home() / ".gemini")))
# The global plugin dir shared by Antigravity 2.0, the CLI, and the IDE.
ANTIGRAVITY_PLUGINS_DIR = GEMINI_HOME / "config" / "plugins"
ANTIGRAVITY_PLUGIN_DIR = ANTIGRAVITY_PLUGINS_DIR / PLUGIN_NAME
ANTIGRAVITY_MANIFEST = ANTIGRAVITY_PLUGIN_DIR / "plugin.json"

# Placeholder in the staged hooks.json template. Antigravity documents no
# plugin-root environment variable for the hook command (Claude Code's
# ${CLAUDE_PLUGIN_ROOT} has no counterpart here), so the absolute installed
# path is substituted at install time instead. That is also more robust: it
# holds regardless of the working directory the hook is spawned in.
_ROOT_PLACEHOLDER = "__SV_PLUGIN_ROOT__"


# --- Pydantic response models -----------------------------------------------


class StatusResponse(BaseModel):
    installed: bool
    staging_dir: str
    files_present: list[str]
    antigravity_detected: bool = False
    # True when the plugin dir and its manifest exist under the plugins dir.
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


# --- plugin install helpers ---------------------------------------------------


def _assert_within_allowed_roots(path: Path) -> None:
    """Refuse any write outside ``~/.gemini`` (or a configured $GEMINI_HOME)
    and ``~/.securevector``.

    The install path is assembled from constants rather than from request
    input, so this is defence in depth rather than input validation: it is the
    check that keeps a future edit, or a relocated $GEMINI_HOME pointing
    somewhere unexpected, from turning a plugin install into an arbitrary
    directory overwrite.
    """
    resolved = path.resolve(strict=False)
    home = Path.home().resolve(strict=False)
    allowed = [
        (home / ".gemini").resolve(strict=False),
        (home / ".securevector").resolve(strict=False),
        GEMINI_HOME.resolve(strict=False),
    ]
    if not any(resolved.is_relative_to(root) for root in allowed):
        raise PermissionError(
            "refusing to write outside allowed dirs (~/.gemini or ~/.securevector): "
            f"resolved {resolved} (was {path})"
        )


def _resolve_root_placeholder(plugin_dir: Path) -> None:
    """Resolve ``__SV_PLUGIN_ROOT__`` to the absolute plugin dir inside the
    COPIED ``hooks.json``, so Antigravity runs the bundled scripts by absolute
    path."""
    hooks_json = plugin_dir / "hooks.json"
    text = hooks_json.read_text(encoding="utf-8")
    if _ROOT_PLACEHOLDER in text:
        hooks_json.write_text(text.replace(_ROOT_PLACEHOLDER, str(plugin_dir)), encoding="utf-8")


def _auto_install_to_antigravity() -> Path:
    """Copy the staged tree into ``~/.gemini/config/plugins/securevector-guard/``
    and resolve the hook-root placeholder.

    Atomic: copytree to a ``.tmp`` sibling, remove any prior copy, then
    ``os.replace``. Idempotent, so a reinstall replaces the plugin dir in place
    rather than merging two versions' files.
    """
    _assert_within_allowed_roots(ANTIGRAVITY_PLUGIN_DIR)
    if ANTIGRAVITY_PLUGIN_DIR.is_symlink():
        raise PermissionError(
            f"refusing to install through symlink at {ANTIGRAVITY_PLUGIN_DIR} "
            f"(target was {os.readlink(ANTIGRAVITY_PLUGIN_DIR)})"
        )

    ANTIGRAVITY_PLUGIN_DIR.parent.mkdir(parents=True, exist_ok=True)
    tmp_install = ANTIGRAVITY_PLUGIN_DIR.parent / (ANTIGRAVITY_PLUGIN_DIR.name + ".tmp")
    if tmp_install.exists():
        shutil.rmtree(tmp_install, ignore_errors=True)
    shutil.copytree(STAGING_DIR, tmp_install)
    if ANTIGRAVITY_PLUGIN_DIR.exists():
        shutil.rmtree(ANTIGRAVITY_PLUGIN_DIR, ignore_errors=True)
    os.replace(tmp_install, ANTIGRAVITY_PLUGIN_DIR)

    # Point the bundled hooks at their absolute on-disk location.
    _resolve_root_placeholder(ANTIGRAVITY_PLUGIN_DIR)

    logger.info(
        "Auto-installed Antigravity plugin %s to %s (bundled hooks; restart Antigravity)",
        PLUGIN_NAME, ANTIGRAVITY_PLUGIN_DIR,
    )
    return ANTIGRAVITY_PLUGIN_DIR


def _is_installed_enabled() -> bool:
    """True when the plugin dir exists with its manifest.

    Antigravity's docs describe plugin discovery by directory presence and name
    no registry recording enabled state, so presence is the only signal
    available. If ``agy plugin disable`` turns out to write one, this is the
    function that should learn to read it.
    """
    return ANTIGRAVITY_PLUGIN_DIR.is_dir() and ANTIGRAVITY_MANIFEST.is_file()


# --- Routes -----------------------------------------------------------------


@router.get("/status", response_model=StatusResponse)
async def plugin_status():
    """Whether the plugin is staged, whether Antigravity is installed, and
    whether the plugin dir and manifest are present. Read-only."""
    files_present = [f for f in PLUGIN_FILES if (STAGING_DIR / f).is_file()]
    enabled = _is_installed_enabled()
    return StatusResponse(
        installed=len(files_present) == len(PLUGIN_FILES),
        staging_dir=str(STAGING_DIR),
        files_present=files_present,
        antigravity_detected=GEMINI_HOME.is_dir(),
        auto_installed=enabled,
        enabled=enabled,
    )


@router.post("/install", response_model=InstallResponse, dependencies=[Depends(require_local_origin)])
async def install_plugin():
    """Stage the plugin tree (URL-substituted), then, if Antigravity is
    installed, copy it to ``~/.gemini/config/plugins/securevector-guard/`` so
    the loader finds the manifest and its bundled hooks. Idempotent."""
    _hooks_common.ensure_bundled_dir(BUNDLED_PLUGIN_DIR, PLUGIN_FILES)
    sv_url = _hooks_common.resolve_sv_url()
    # Clear any prior staging first: stage_files is additive and the whole
    # staging dir is copied into the install location, so a file dropped from
    # PLUGIN_FILES across versions would otherwise linger in staging and ship.
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
        "Staged %d Antigravity plugin file(s) for %s at %s (sv_url=%s)",
        len(files_written), PLUGIN_NAME, STAGING_DIR, sv_url,
    )

    # Defence in depth: zero files means the bundled plugin assets are missing
    # from the installed package (a wheel built without the plugin's non-Python
    # files; see setup.py:package_data + MANIFEST.in).
    if not files_written:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Antigravity plugin staging produced 0 files from {BUNDLED_PLUGIN_DIR}. "
                "Bundled plugin assets are missing from the installed package: verify "
                "setup.py:package_data and MANIFEST.in include plugins/antigravity/**/*."
            ),
        )

    if GEMINI_HOME.is_dir():
        try:
            install_path = _auto_install_to_antigravity()
        except Exception as e:  # surface, but do not lose the staged copy
            logger.exception("Antigravity auto-install failed; staged copy is intact")
            raise HTTPException(
                status_code=500,
                detail=(
                    f"Staged the plugin but failed to install into Antigravity: {e}. "
                    f"You can run: agy plugin install {STAGING_DIR}"
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
                "Installed as an Antigravity plugin. Restart Antigravity, then "
                "confirm with: agy plugin list"
            ),
        )

    # Fallback: Antigravity not detected, staged only. The documented install
    # command is handed back so the user can finish once they have the CLI.
    return InstallResponse(
        ok=True,
        staging_dir=str(STAGING_DIR),
        files=files_written,
        auto_installed=False,
        enabled=False,
        install_path=None,
        commands=[f"agy plugin install {STAGING_DIR}"],
        next_step=(
            "Antigravity was not detected (~/.gemini is absent). Install Antigravity, "
            "then run this install again to register the plugin."
        ),
    )


@router.post("/uninstall", response_model=UninstallResponse, dependencies=[Depends(require_local_origin)])
async def uninstall_plugin():
    """Remove the plugin everywhere we wrote it: the staged tree and the
    installed plugin dir. Idempotent.

    There is no registry entry to deregister, because install writes none. See
    the module docstring.

    Unlike the four Terminals executors, this uninstall does not consult the
    session board: Antigravity is not a Terminals executor in 6.0.0 (the scope
    guard in CLAUDE.md names Claude Code, Codex, Copilot CLI, and OpenCode), so
    no board session can be stranded by removing its Guard. If Antigravity ever
    becomes an executor, this route must gain the same ``block_uninstall``
    check its siblings carry, and
    tests/unit/app/terminals/test_plugin_routes_auth.py will fail until it
    does.
    """
    # 1. Staged source-of-truth tree.
    if STAGING_DIR.is_dir():
        shutil.rmtree(STAGING_DIR, ignore_errors=True)
        logger.info("Removed staged Antigravity plugin tree at %s", STAGING_DIR)

    # 2. Installed plugin dir.
    if ANTIGRAVITY_PLUGIN_DIR.is_dir() and not ANTIGRAVITY_PLUGIN_DIR.is_symlink():
        _assert_within_allowed_roots(ANTIGRAVITY_PLUGIN_DIR)
        shutil.rmtree(ANTIGRAVITY_PLUGIN_DIR, ignore_errors=True)
        logger.info("Removed Antigravity plugin at %s", ANTIGRAVITY_PLUGIN_DIR)

    return UninstallResponse(ok=True)
