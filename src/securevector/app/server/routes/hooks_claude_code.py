"""
Claude Code plugin management API endpoints.

Parallel to ``hooks.py`` (which serves the OpenClaw plugin); both modules
delegate the shared file-staging plumbing to ``_hooks_common``.

GET  /api/hooks/claude-code/status     - Plugin install status
POST /api/hooks/claude-code/install    - Stage plugin tree + return paste-in commands
POST /api/hooks/claude-code/uninstall  - Remove staged tree (idempotent)

The install flow stages the canonical 7-file plugin tree into
``~/.securevector/staging/claude-code-plugin/`` with the local-app URL
substituted, then returns two commands for the user to paste into a
Claude Code session:

    /plugin marketplace add <staging-dir>
    /plugin install securevector-guard
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from . import _hooks_common

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hooks/claude-code", tags=["Hooks"])

PLUGIN_NAME = "securevector-guard"

# Canonical 7-file plugin tree assembled in Task 10. The relative paths
# here MUST match what lives under src/securevector/plugins/claude-code/.
PLUGIN_FILES = [
    ".claude-plugin/plugin.json",
    "hooks/hooks.json",
    "hooks/pre-tool-use.js",
    "hooks/post-tool-use.js",
    "lib/normalize.js",
    "lib/client.js",
    "README.md",
]

# Bundled plugin source directory (shipped with the package).
# Path: src/securevector/app/server/routes/<this file> → up 4 → securevector/
BUNDLED_PLUGIN_DIR = (
    Path(__file__).parent.parent.parent.parent / "plugins" / "claude-code"
)

# Staging directory. Lives under ~/.securevector/ to keep all of our
# host-side artifacts colocated. The user pastes
# `/plugin marketplace add <STAGING_DIR>` into Claude Code.
SECUREVECTOR_DIR = Path.home() / ".securevector"
STAGING_DIR = SECUREVECTOR_DIR / "staging" / "claude-code-plugin"


# --- Pydantic response models -----------------------------------------------


class StatusResponse(BaseModel):
    installed: bool
    staging_dir: str
    files_present: list[str]


class InstallResponse(BaseModel):
    ok: bool
    staging_dir: str
    files: list[str]
    commands: list[str]


class UninstallResponse(BaseModel):
    ok: bool


# --- Routes -----------------------------------------------------------------


@router.get("/status", response_model=StatusResponse)
async def plugin_status():
    """Return whether the plugin is staged + the list of present files.

    Read-only. Treats partial installs as not-installed (all-or-nothing
    from the user's perspective).
    """
    files_present = [f for f in PLUGIN_FILES if (STAGING_DIR / f).is_file()]
    return StatusResponse(
        installed=len(files_present) == len(PLUGIN_FILES),
        staging_dir=str(STAGING_DIR),
        files_present=files_present,
    )


@router.post("/install", response_model=InstallResponse)
async def install_plugin():
    """Stage the plugin tree + return the two paste-in commands.

    Idempotent — reinstalling overwrites the staged files. URL substitution
    keeps the staged README pointing at the current local-app URL even if
    the user changed their app port.
    """
    # Confirm the bundled source exists. We don't supply a regenerate_cb
    # because the canonical plugin tree ships in the wheel via MANIFEST.in
    # / pyproject.toml (Task 13). If files are missing we still proceed —
    # stage_files will warn and skip; the InstallResponse reports the truth.
    _hooks_common.ensure_bundled_dir(BUNDLED_PLUGIN_DIR, PLUGIN_FILES)

    sv_url = _hooks_common.resolve_sv_url()
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
        "Staged %d plugin file(s) for %s at %s (sv_url=%s)",
        len(files_written), PLUGIN_NAME, STAGING_DIR, sv_url,
    )

    return InstallResponse(
        ok=True,
        staging_dir=str(STAGING_DIR),
        files=files_written,
        commands=[
            f"/plugin marketplace add {STAGING_DIR}",
            f"/plugin install {PLUGIN_NAME}",
        ],
    )


@router.post("/uninstall", response_model=UninstallResponse)
async def uninstall_plugin():
    """Remove the staged plugin tree. Idempotent — no-op when absent."""
    if STAGING_DIR.is_dir():
        shutil.rmtree(STAGING_DIR, ignore_errors=True)
        logger.info("Removed staged plugin tree at %s", STAGING_DIR)
    return UninstallResponse(ok=True)
