"""
GitHub Copilot CLI plugin management API endpoints.

Parallel to ``hooks_claude_code.py``, ``hooks_codex.py``, and ``hooks.py``.
All delegate the shared file-staging plumbing to ``_hooks_common``.

GET  /api/hooks/copilot-cli/status     - Plugin install status
POST /api/hooks/copilot-cli/install    - Stage plugin tree + return paste-in command
POST /api/hooks/copilot-cli/uninstall  - Remove the staged tree (idempotent)

The install flow stages the plugin tree (with the local-app URL substituted)
into ``~/.securevector/staging/copilot-cli-plugin/`` — that directory IS the
plugin (``plugin.json`` at its root), so the user installs it with the
documented local-path form::

    copilot plugin install ~/.securevector/staging/copilot-cli-plugin

We deliberately do NOT auto-copy into Copilot's own plugin store: unlike
Codex (config.toml) and Claude Code (plugins/cache), Copilot CLI's installed-
plugin layout under ``~/.copilot/installed-plugins/`` and its registration
mechanism are not documented for out-of-band writes as of 2026-06. The
documented + supported path is ``copilot plugin install <local-dir>``, so we
stage + hand the user that one command (the same shape as the Claude Code
paste-in fallback). Revisit auto-install once GitHub documents the store layout.

⚠️ EMPIRICAL-VERIFY (tracked on story #148, undocumented by GitHub as of 2026-06):
  - ``hooks/hooks.json`` references hook scripts via ``${COPILOT_PLUGIN_ROOT}``.
    GitHub documents ``COPILOT_PLUGIN_DATA`` (a per-plugin *data* dir) but not a
    plugin *root* var; confirm the var Copilot expands for an installed local
    plugin's hook ``command`` against a pinned CLI build before relying on it.
  - The exact ``toolName`` string MCP tools present as (only the 10 built-ins
    are documented) — affects ``lib/normalize.js`` matching for MCP tools.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import _hooks_common

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hooks/copilot-cli", tags=["Hooks"])

PLUGIN_NAME = "securevector-guard"

# Plugin tree files — must match what lives under
# ``src/securevector/plugins/copilot-cli/``. Note: Copilot's manifest is
# ``plugin.json`` at the ROOT (not ``.codex-plugin/`` / ``.claude-plugin/``),
# and there is no statusline emitter or Stop probe.
PLUGIN_FILES = [
    "plugin.json",
    "hooks/hooks.json",
    "hooks/pre-tool-use.js",
    "hooks/post-tool-use.js",
    "hooks/user-prompt-submit.js",
    "hooks/session-start.js",
    "lib/normalize.js",
    "lib/client.js",
    "lib/redact.js",
    "LICENSE",
    "README.md",
    "PRIVACY.md",
]

# Bundled plugin source: src/securevector/app/server/routes/<this> → up 4 → securevector/
BUNDLED_PLUGIN_DIR = (
    Path(__file__).parent.parent.parent.parent / "plugins" / "copilot-cli"
)

# Staging dir IS the plugin dir (plugin.json at its root) for `copilot plugin install <dir>`.
SECUREVECTOR_DIR = Path.home() / ".securevector"
STAGING_DIR = SECUREVECTOR_DIR / "staging" / "copilot-cli-plugin"

# Copilot CLI per-user home; presence is the "Copilot detected" signal for the
# dashboard nudge. Copilot honours $COPILOT_HOME to relocate this base.
import os  # noqa: E402  (local import keeps the dependency surface obvious)
COPILOT_HOME = Path(os.environ.get("COPILOT_HOME", str(Path.home() / ".copilot")))


# --- Pydantic response models -----------------------------------------------


class StatusResponse(BaseModel):
    installed: bool
    staging_dir: str
    files_present: list[str]
    copilot_detected: bool = False


class InstallResponse(BaseModel):
    ok: bool
    staging_dir: str
    files: list[str]
    commands: list[str]
    next_step: Optional[str] = None


class UninstallResponse(BaseModel):
    ok: bool


# --- Routes -----------------------------------------------------------------


@router.get("/status", response_model=StatusResponse)
async def plugin_status():
    """Whether the plugin is staged + the list of present files. Read-only;
    partial installs read as not-installed (all-or-nothing to the user)."""
    files_present = [f for f in PLUGIN_FILES if (STAGING_DIR / f).is_file()]
    return StatusResponse(
        installed=len(files_present) == len(PLUGIN_FILES),
        staging_dir=str(STAGING_DIR),
        files_present=files_present,
        copilot_detected=COPILOT_HOME.is_dir(),
    )


@router.post("/install", response_model=InstallResponse)
async def install_plugin():
    """Stage the plugin tree (URL-substituted) + return the paste-in install
    command. Idempotent — reinstall overwrites the staged files and keeps the
    hooks pointing at the current local-app URL even if the port changed."""
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
        "Staged %d Copilot CLI plugin file(s) for %s at %s (sv_url=%s)",
        len(files_written), PLUGIN_NAME, STAGING_DIR, sv_url,
    )

    # Defense-in-depth: zero files means the bundled plugin assets are missing
    # from the installed package (wheel built without the plugin's non-Python
    # files — see setup.py:package_data + MANIFEST.in).
    if not files_written:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Copilot CLI plugin staging produced 0 files from {BUNDLED_PLUGIN_DIR}. "
                "Bundled plugin assets are missing from the installed package — verify "
                "setup.py:package_data and MANIFEST.in include plugins/copilot-cli/**/*."
            ),
        )

    return InstallResponse(
        ok=True,
        staging_dir=str(STAGING_DIR),
        files=files_written,
        commands=[f"copilot plugin install {STAGING_DIR}"],
        next_step=(
            "Run the command above in your terminal, then start a new Copilot CLI "
            "session. Copilot will load the plugin's hooks on next launch."
        ),
    )


@router.post("/uninstall", response_model=UninstallResponse)
async def uninstall_plugin():
    """Remove the staged plugin tree. Idempotent. (The user removes the
    installed copy with ``copilot plugin uninstall securevector-guard``;
    Copilot's store layout isn't documented for out-of-band removal.)"""
    if STAGING_DIR.is_dir():
        shutil.rmtree(STAGING_DIR, ignore_errors=True)
        logger.info("Removed staged Copilot CLI plugin tree at %s", STAGING_DIR)
    return UninstallResponse(ok=True)
