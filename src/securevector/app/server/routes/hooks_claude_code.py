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

import asyncio
import copy
import json
import logging
import os
import shutil
import tempfile
from datetime import datetime, timezone
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
    # UserPromptSubmit hook — scans incoming chat messages for
    # prompt-injection / jailbreak content. Without this, the plugin
    # only sees tool inputs (Pre/PostToolUse), so direct prompt-injection
    # in user chat ("ignore previous instructions and …") never reaches
    # the rule engine.
    "hooks/user-prompt-submit.js",
    # Temporary v4.2.x diagnostic probe: captures Stop-event payloads
    # to ~/.securevector/cost-probes/ so we can determine empirically
    # whether Claude Code exposes token usage to plugins. Removed once
    # the cost-tracking gap is resolved (or confirmed unresolvable).
    "hooks/stop-hook-probe.js",
    "lib/normalize.js",
    "lib/client.js",
    # Shared secret-redaction helpers — imported by post-tool-use.js
    # and user-prompt-submit.js so both hooks mask the same surfaces.
    "lib/redact.js",
    "README.md",
]

# Bundled plugin source directory (shipped with the package).
# Path: src/securevector/app/server/routes/<this file> → up 4 → securevector/
BUNDLED_PLUGIN_DIR = (
    Path(__file__).parent.parent.parent.parent / "plugins" / "claude-code"
)

# Staging directory. Lives under ~/.securevector/ to keep all of our
# host-side artifacts colocated. This is the intermediate location we
# build the plugin tree at before copying into Claude Code's own cache.
# Kept around so the legacy paste-in flow still works if auto-install
# can't reach Claude Code's config dir.
SECUREVECTOR_DIR = Path.home() / ".securevector"
STAGING_DIR = SECUREVECTOR_DIR / "staging" / "claude-code-plugin"

# Claude Code config locations (per-user, OS-agnostic for macOS/Linux —
# Windows would resolve %APPDATA%\.claude but that path isn't tested
# yet, so we only auto-install when this directory exists).
CLAUDE_PLUGINS_DIR = Path.home() / ".claude" / "plugins"
CLAUDE_INSTALLED_PLUGINS_JSON = CLAUDE_PLUGINS_DIR / "installed_plugins.json"
CLAUDE_KNOWN_MARKETPLACES_JSON = CLAUDE_PLUGINS_DIR / "known_marketplaces.json"
CLAUDE_PLUGIN_CACHE_ROOT = CLAUDE_PLUGINS_DIR / "cache"
# Claude Code's user-scope settings file. Holds enabledPlugins, statusLine,
# etc. We touch ONLY the `enabledPlugins[<our-key>]` field; every other
# value (other plugins, statusLine config, etc.) is preserved verbatim.
CLAUDE_SETTINGS_JSON = Path.home() / ".claude" / "settings.json"

# Hidden marketplace slug. Empirical finding (2026-05-18): Claude Code's
# plugin loader silently skips installed_plugins.json entries whose key
# lacks an `@<marketplace>` suffix — so a "no marketplace" install does
# not load. We bundle one private marketplace `securevector-local` that
# contains only this plugin; the user never sees the slug — it lives in
# known_marketplaces.json and is referenced in installed_plugins.json,
# but the UI says "Installed & enabled."
MARKETPLACE_SLUG = "securevector-local"
INSTALL_KEY = f"{PLUGIN_NAME}@{MARKETPLACE_SLUG}"


# --- Pydantic response models -----------------------------------------------


class StatusResponse(BaseModel):
    installed: bool
    staging_dir: str
    files_present: list[str]
    auto_installed: bool = False
    claude_install_path: Optional[str] = None
    enabled: bool = False


class InstallResponse(BaseModel):
    ok: bool
    staging_dir: str
    files: list[str]
    commands: list[str]
    auto_installed: bool = False
    claude_install_path: Optional[str] = None
    enabled: bool = False
    next_step: Optional[str] = None


class UninstallResponse(BaseModel):
    ok: bool


class ModelUsage(BaseModel):
    """Per-model token usage from Claude Code session transcripts."""
    model: str
    turns: int
    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int
    cache_read_input_tokens: int


class DailyTokenUsage(BaseModel):
    """Per-day token usage rolled up from session transcript timestamps.

    Day key is ISO-8601 ``YYYY-MM-DD`` in the host's LOCAL timezone — the
    UI groups by user-visible date, not UTC, to match what `/cost` and
    other CC surfaces show. Sparse days (no CC activity) are omitted;
    the frontend fills empty buckets when rendering the 7-day chart.
    """
    day: str
    turns: int
    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int
    cache_read_input_tokens: int


class TokenUsageResponse(BaseModel):
    """Aggregate token usage across all Claude Code session transcripts.

    Source: ``~/.claude/projects/<slug>/<session-id>.jsonl`` — Claude Code
    persists every turn's `usage` block to this transcript on disk. This
    is the same data Claude Code's `/cost` command consumes; we read it
    locally without any hook event so token visibility works even while
    the upstream hook-API doesn't surface usage.

    NOTE: We deliberately do NOT compute or surface a dollar cost for
    the Claude Code plugin. Most users are on flat-rate subscriptions
    (Max / Team / Enterprise); a "list-price equivalent" figure either
    misleads them (subscription bills aren't per-token) or requires us
    to take a position on pricing tables we don't control. Tokens are
    the honest, source-of-truth view; for cost, point users at their
    Anthropic console.
    """
    sessions: int
    turns_with_usage: int
    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int
    cache_read_input_tokens: int
    last_activity: str | None  # ISO timestamp of most-recent turn with usage
    by_model: list[ModelUsage]
    daily: list[DailyTokenUsage]  # last 7 days, oldest → newest, sparse


# --- Auto-install helpers ---------------------------------------------------


import re

# Conservative semver-shaped regex. Matches `4.2.0`, `4.2.0-rc.1`,
# `1.0.0+build.42`. Refuses path-traversal payloads like `../etc` or
# anything with slashes / control chars. Bundled plugins always use
# semver — anything else is a defect upstream and we'd rather fail
# loud than write outside the cache.
_VERSION_RE = re.compile(r"^[0-9]+(?:\.[0-9]+){0,3}(?:[-+][A-Za-z0-9.+-]+)?$")


def _read_staged_plugin_version() -> str:
    """Read the plugin's `version` from its plugin.json. Best-effort —
    falls back to `"0.0.0"` if the file is missing or malformed so the
    install path still resolves to *some* version directory.

    Validates the version string against `_VERSION_RE` so a malicious
    plugin.json with `version: "../../etc"` can't produce an install
    path outside the cache. Anything failing validation is rewritten
    to `"0.0.0"` and logged.
    """
    pj = STAGING_DIR / ".claude-plugin" / "plugin.json"
    try:
        data = json.loads(pj.read_text(encoding="utf-8"))
        v = data.get("version")
        if isinstance(v, str) and v and _VERSION_RE.match(v):
            return v
        if isinstance(v, str) and v:
            logger.warning(
                "plugin.json version %r failed semver validation; "
                "falling back to 0.0.0 to prevent path-traversal", v,
            )
    except (OSError, ValueError, KeyError):
        pass
    return "0.0.0"


def _atomic_write_json(path: Path, data: dict) -> None:
    """Write JSON atomically with symlink + traversal guard.

    Resolves the destination through any symlinks first, refuses to
    write if the resolved path leaves the user's home directory, then
    uses `tempfile + os.replace` so a crash mid-write can't leave
    Claude Code with a half-truncated config file.

    This addresses the security reviewer's HIGH findings on:
    - Symlink follow: `os.replace` would silently rewrite the target
      of any symlink at the destination path; the resolve check
      catches obviously hostile symlinks.
    - Path-traversal via attacker-controlled `path` arg: we refuse to
      write anywhere outside `~/.claude/` or `~/.securevector/`.
    """
    # Resolve symlinks + canonicalise the parent. `strict=False` keeps
    # this working even when the file itself doesn't exist yet — only
    # the directory chain needs to resolve.
    #
    # Tightened scope: refuse writes outside the two documented
    # surfaces (`~/.claude/` for CC integration, `~/.securevector/` for
    # our own staging). The earlier `home`-only guard permitted writes
    # to `~/.ssh/authorized_keys`, `~/.aws/credentials`, etc. via any
    # attacker-controlled `path`. Two narrow allowlists eliminate that.
    resolved_parent = path.parent.resolve(strict=False)
    home = Path.home().resolve(strict=False)
    claude_root = (home / ".claude").resolve(strict=False)
    sv_root = (home / ".securevector").resolve(strict=False)
    if not (
        resolved_parent.is_relative_to(claude_root)
        or resolved_parent.is_relative_to(sv_root)
    ):
        raise PermissionError(
            f"refusing to write outside allowed dirs (~/.claude or "
            f"~/.securevector): resolved {resolved_parent} (was {path})"
        )
    # If the destination itself exists AND is a symlink, refuse — we
    # could be tricked into rewriting an arbitrary target on the same
    # filesystem. Caller can delete the symlink first if they really
    # want to replace it.
    if path.is_symlink():
        raise PermissionError(
            f"refusing to write through symlink at {path} "
            f"(target was {os.readlink(path)})"
        )

    resolved_parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix=path.name + ".", suffix=".tmp", dir=str(resolved_parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4)
            f.write("\n")
        # Use the resolved destination so we never follow a symlink
        # introduced after the check.
        os.replace(tmp_path, resolved_parent / path.name)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _load_installed_plugins() -> dict:
    """Load Claude Code's installed_plugins.json, returning a v2-shaped
    default if absent. Tolerates a missing-version field by defaulting
    to 2."""
    if not CLAUDE_INSTALLED_PLUGINS_JSON.exists():
        return {"version": 2, "plugins": {}}
    # Critical safety: if the file exists but is malformed (interrupted
    # prior write, manual edit gone wrong), we must NOT silently treat
    # it as empty — that would let our auto-install merge into a blank
    # dict and overwrite EVERY other installed plugin. Raise so the
    # caller decides whether to abort the install or surface an error.
    try:
        raw = CLAUDE_INSTALLED_PLUGINS_JSON.read_text(encoding="utf-8")
    except OSError:
        raise
    try:
        data = json.loads(raw)
    except ValueError as e:
        raise ValueError(
            f"installed_plugins.json is malformed at {CLAUDE_INSTALLED_PLUGINS_JSON}. "
            f"Refusing to load to prevent overwriting other plugins' entries. "
            f"User must repair the file before reinstalling. Cause: {e}"
        )
    if not isinstance(data, dict):
        raise ValueError(
            f"installed_plugins.json must be a JSON object; got {type(data).__name__}"
        )
    data.setdefault("version", 2)
    data.setdefault("plugins", {})
    if not isinstance(data["plugins"], dict):
        raise ValueError(
            "installed_plugins.json::plugins must be an object; refusing to overwrite"
        )
    return data


def _load_known_marketplaces() -> dict:
    """Load known_marketplaces.json or an empty default. Preserves every
    other marketplace entry — we only merge our own slug.

    Same safety contract as `_load_installed_plugins`: malformed JSON
    raises rather than returning a blank dict, so we never overwrite
    other marketplace registrations.
    """
    if not CLAUDE_KNOWN_MARKETPLACES_JSON.exists():
        return {}
    try:
        raw = CLAUDE_KNOWN_MARKETPLACES_JSON.read_text(encoding="utf-8")
    except OSError:
        raise
    try:
        data = json.loads(raw)
    except ValueError as e:
        raise ValueError(
            f"known_marketplaces.json is malformed at "
            f"{CLAUDE_KNOWN_MARKETPLACES_JSON}. Refusing to load to prevent "
            f"overwriting other marketplace entries. Cause: {e}"
        )
    if not isinstance(data, dict):
        raise ValueError(
            f"known_marketplaces.json must be a JSON object; got {type(data).__name__}"
        )
    return data


# Schema-trimmed marketplace.json. Empirical finding: top-level `$schema`
# and `description` are flagged by `claude plugin validate` as unrecognised
# keys, so omitted. Plugin `source: "./"` makes the marketplace root and
# the plugin root the same directory — fine for a single-plugin local
# marketplace. plugin.json must NOT declare its hooks path (CC auto-loads
# `hooks/hooks.json` and rejects a duplicate manifest declaration).
def _build_marketplace_manifest() -> dict:
    return {
        "name": MARKETPLACE_SLUG,
        "owner": {"name": "SecureVector", "url": "https://securevector.io"},
        "plugins": [
            {
                "name": PLUGIN_NAME,
                "description": (
                    "Real-time policy enforcement and tamper-evident audit "
                    "for MCP tool calls."
                ),
                "source": "./",
                "category": "security",
                "homepage": "https://securevector.io",
            }
        ],
    }


def _auto_install_to_claude_cache(version: str) -> Optional[Path]:
    """Install the plugin into Claude Code's plugin cache and register it
    in installed_plugins.json + known_marketplaces.json.

    Returns the install path on success, ``None`` if Claude Code's plugin
    config dir doesn't exist (user hasn't run Claude Code yet, or it's
    installed at a non-standard location).

    Layout written:
      * `<staging>/.claude-plugin/marketplace.json` — declares the
        hidden marketplace. The staging dir doubles as marketplace root
        AND plugin root since we ship a single plugin.
      * `~/.claude/plugins/cache/<slug>/<plugin>/<version>/` — plugin
        files copied from staging. Mirrors CC's marketplace-install
        cache layout so the loader treats us identically to a real
        marketplace plugin.
      * `~/.claude/plugins/known_marketplaces.json` — adds the slug
        with `source: directory`. Preserves every other marketplace.
      * `~/.claude/plugins/installed_plugins.json` — adds the
        `<plugin>@<slug>` install entry. Preserves every other plugin.
    """
    if not CLAUDE_PLUGINS_DIR.is_dir():
        logger.info(
            "Skipping auto-install: %s does not exist (Claude Code likely "
            "not installed at the default location)", CLAUDE_PLUGINS_DIR,
        )
        return None

    # Track which side effects have committed so we can roll them back
    # on partial failure. The 4-step write isn't collectively atomic;
    # if a later step throws, the user is left with `known_marketplaces`
    # referencing a cache dir that doesn't exist (or vice versa). On
    # exception, we reverse-execute the completed steps before re-raising.
    rollback_marketplace_manifest = False
    install_path = CLAUDE_PLUGIN_CACHE_ROOT / MARKETPLACE_SLUG / PLUGIN_NAME / version
    rollback_cache_dir = False
    rollback_marketplaces_json = False
    rollback_installed_plugins_json = False
    installed_plugins_before: dict | None = None

    try:
        # 1. Write the marketplace manifest into the staging dir. It lives
        #    alongside plugin.json under `.claude-plugin/`. CC accepts the
        #    same `.claude-plugin/` folder hosting BOTH manifests when the
        #    marketplace is a single-plugin local install.
        marketplace_manifest_path = (
            STAGING_DIR / ".claude-plugin" / "marketplace.json"
        )
        marketplace_manifest_path.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write_json(marketplace_manifest_path, _build_marketplace_manifest())
        rollback_marketplace_manifest = True

        # 2. Copy the plugin tree into the cache. Copy via a `.tmp`
        #    sibling first then atomically rename — prevents CC's loader
        #    from seeing a half-populated `<version>/` dir mid-copy.
        tmp_install_path = install_path.parent / f"{install_path.name}.tmp"
        if tmp_install_path.exists():
            shutil.rmtree(tmp_install_path, ignore_errors=True)
        if install_path.exists():
            shutil.rmtree(install_path, ignore_errors=True)
        install_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(STAGING_DIR, tmp_install_path)
        os.replace(str(tmp_install_path), str(install_path))
        rollback_cache_dir = True

        now_iso = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        )

        # 3. Register the marketplace. Format matches what
        #    `claude plugin marketplace add <dir>` writes.
        markets = _load_known_marketplaces()
        markets_before = {k: v for k, v in markets.items() if k != MARKETPLACE_SLUG}
        markets[MARKETPLACE_SLUG] = {
            "source": {"source": "directory", "path": str(STAGING_DIR)},
            "installLocation": str(STAGING_DIR),
            "lastUpdated": now_iso,
        }
        _atomic_write_json(CLAUDE_KNOWN_MARKETPLACES_JSON, markets)
        rollback_marketplaces_json = True

        # 4. Register the plugin install. Preserve installedAt across
        #    re-installs so the "first installed" timestamp doesn't reset.
        data = _load_installed_plugins()
        # Snapshot for rollback: deepcopy because the inner list of
        # install records would otherwise share refs with `data` and the
        # mutation on the next line would also mutate the snapshot.
        installed_plugins_before = copy.deepcopy(data)
        existing = data["plugins"].get(INSTALL_KEY)
        if isinstance(existing, list) and existing:
            prior = existing[0] if isinstance(existing[0], dict) else {}
            installed_at = prior.get("installedAt", now_iso)
        else:
            installed_at = now_iso
        data["plugins"][INSTALL_KEY] = [
            {
                "scope": "user",
                "installPath": str(install_path),
                "version": version,
                "installedAt": installed_at,
                "lastUpdated": now_iso,
            }
        ]
        _atomic_write_json(CLAUDE_INSTALLED_PLUGINS_JSON, data)
        rollback_installed_plugins_json = True
        logger.info(
            "Auto-installed %s v%s into %s and registered marketplace %s",
            PLUGIN_NAME, version, install_path, MARKETPLACE_SLUG,
        )
        return install_path

    except Exception:
        logger.exception(
            "Auto-install partial failure — rolling back %s",
            {
                "marketplace_manifest": rollback_marketplace_manifest,
                "cache_dir": rollback_cache_dir,
                "marketplaces_json": rollback_marketplaces_json,
                "installed_plugins_json": rollback_installed_plugins_json,
            },
        )
        # Reverse order: roll back the most recently committed step first.
        if rollback_installed_plugins_json and installed_plugins_before is not None:
            try:
                _atomic_write_json(CLAUDE_INSTALLED_PLUGINS_JSON, installed_plugins_before)
            except Exception:
                logger.exception("Rollback of installed_plugins.json failed")
        if rollback_marketplaces_json:
            try:
                _atomic_write_json(CLAUDE_KNOWN_MARKETPLACES_JSON, markets_before)
            except Exception:
                logger.exception("Rollback of known_marketplaces.json failed")
        if rollback_cache_dir and install_path.exists():
            try:
                shutil.rmtree(install_path, ignore_errors=True)
            except Exception:
                logger.exception("Rollback of cache dir failed")
        # marketplace_manifest is inside STAGING_DIR which is fully
        # owned by us; leaving it is harmless. Don't delete it — the
        # next install reads from the same path.
        raise


def _auto_uninstall_from_claude_cache() -> bool:
    """Reverse the three writes from auto_install. Each step is best-
    effort — failing to remove one shouldn't leave another orphaned.
    Idempotent."""
    touched = False

    # 1. Wipe the cache dir for our plugin across all versions. The
    #    `<slug>/<plugin>/` subtree contains only our plugin so it's
    #    safe to rmtree.
    plugin_cache_dir = CLAUDE_PLUGIN_CACHE_ROOT / MARKETPLACE_SLUG / PLUGIN_NAME
    if plugin_cache_dir.exists():
        shutil.rmtree(plugin_cache_dir, ignore_errors=True)
        touched = True
    # 1b. If the slug dir is now empty, remove it too (cosmetic).
    slug_dir = CLAUDE_PLUGIN_CACHE_ROOT / MARKETPLACE_SLUG
    if slug_dir.is_dir():
        try:
            slug_dir.rmdir()  # only succeeds if empty
        except OSError:
            pass

    # 2. Strip our entry from installed_plugins.json. Independent
    #    try/except: a malformed file here must NOT prevent step 3
    #    from running. `_load_installed_plugins` raises on malformed
    #    JSON (correct behavior to prevent overwrite), but uninstall
    #    is best-effort — we skip this step and continue.
    if CLAUDE_INSTALLED_PLUGINS_JSON.exists():
        try:
            data = _load_installed_plugins()
            if INSTALL_KEY in data["plugins"]:
                del data["plugins"][INSTALL_KEY]
                _atomic_write_json(CLAUDE_INSTALLED_PLUGINS_JSON, data)
                touched = True
        except Exception:
            logger.exception(
                "Skipping installed_plugins.json strip during uninstall"
            )

    # 3. Strip our slug from known_marketplaces.json. Same independence
    #    guarantee as step 2.
    if CLAUDE_KNOWN_MARKETPLACES_JSON.exists():
        try:
            markets = _load_known_marketplaces()
            if MARKETPLACE_SLUG in markets:
                del markets[MARKETPLACE_SLUG]
                _atomic_write_json(CLAUDE_KNOWN_MARKETPLACES_JSON, markets)
                touched = True
        except Exception:
            logger.exception(
                "Skipping known_marketplaces.json strip during uninstall"
            )

    if touched:
        logger.info("Auto-uninstalled %s from Claude Code config", PLUGIN_NAME)
    return touched


def _claude_install_path() -> Optional[Path]:
    """Return the currently-registered install path for the plugin, or
    ``None`` if the plugin isn't in installed_plugins.json yet. Used by
    /status so the UI can tell whether the user already auto-installed.
    """
    if not CLAUDE_INSTALLED_PLUGINS_JSON.exists():
        return None
    data = _load_installed_plugins()
    entries = data["plugins"].get(INSTALL_KEY)
    if not isinstance(entries, list) or not entries:
        return None
    entry = entries[0] if isinstance(entries[0], dict) else {}
    p = entry.get("installPath")
    if not isinstance(p, str) or not p:
        return None
    candidate = Path(p)
    return candidate if candidate.exists() else None


def _enable_in_claude_settings() -> bool:
    """Set ``enabledPlugins[<our-key>] = true`` in Claude Code's
    ``settings.json``. Preserves every other field — only the one
    plugin-flag is touched. Atomic write. Returns True on success.

    No-ops if settings.json doesn't exist or isn't parseable. Callers
    treat False as "couldn't auto-enable; surface fallback wording."
    """
    if not CLAUDE_SETTINGS_JSON.exists():
        return False
    try:
        data = json.loads(CLAUDE_SETTINGS_JSON.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(data, dict):
        return False
    ep = data.get("enabledPlugins")
    if not isinstance(ep, dict):
        ep = {}
        data["enabledPlugins"] = ep
    if ep.get(INSTALL_KEY) is True:
        return True  # already enabled — nothing to write
    ep[INSTALL_KEY] = True
    _atomic_write_json(CLAUDE_SETTINGS_JSON, data)
    logger.info(
        "Enabled %s in %s (enabledPlugins[%s]=true)",
        PLUGIN_NAME, CLAUDE_SETTINGS_JSON, INSTALL_KEY,
    )
    return True


def _disable_in_claude_settings() -> bool:
    """Remove ``enabledPlugins[<our-key>]`` from settings.json. Atomic
    write. Returns True if we removed something, False if nothing was
    there (idempotent)."""
    if not CLAUDE_SETTINGS_JSON.exists():
        return False
    try:
        data = json.loads(CLAUDE_SETTINGS_JSON.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(data, dict):
        return False
    ep = data.get("enabledPlugins")
    if not isinstance(ep, dict) or INSTALL_KEY not in ep:
        return False
    del ep[INSTALL_KEY]
    _atomic_write_json(CLAUDE_SETTINGS_JSON, data)
    logger.info("Disabled %s in %s", PLUGIN_NAME, CLAUDE_SETTINGS_JSON)
    return True


def _is_enabled_in_claude_settings() -> bool:
    """Read-only: is the plugin currently flagged as enabled?"""
    if not CLAUDE_SETTINGS_JSON.exists():
        return False
    try:
        data = json.loads(CLAUDE_SETTINGS_JSON.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(data, dict):
        return False
    ep = data.get("enabledPlugins")
    return isinstance(ep, dict) and ep.get(INSTALL_KEY) is True


# --- Routes -----------------------------------------------------------------


@router.get("/status", response_model=StatusResponse)
async def plugin_status():
    """Return whether the plugin is staged + the list of present files.

    Read-only. Treats partial installs as not-installed (all-or-nothing
    from the user's perspective).
    """
    files_present = [f for f in PLUGIN_FILES if (STAGING_DIR / f).is_file()]
    claude_path = _claude_install_path()
    return StatusResponse(
        installed=len(files_present) == len(PLUGIN_FILES),
        staging_dir=str(STAGING_DIR),
        files_present=files_present,
        auto_installed=claude_path is not None,
        claude_install_path=str(claude_path) if claude_path else None,
        enabled=_is_enabled_in_claude_settings(),
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

    # Try the no-marketplace auto-install. If Claude Code's plugin
    # config dir is present we copy the tree in and register it; the
    # user only needs `/reload-plugins` instead of the two paste-in
    # commands. If the dir is missing we surface the legacy commands
    # so the user can still install manually.
    version = _read_staged_plugin_version()
    install_path: Optional[Path]
    try:
        install_path = _auto_install_to_claude_cache(version)
    except Exception:
        logger.exception(
            "Auto-install to Claude Code cache failed; falling back to "
            "paste-in commands",
        )
        install_path = None

    if install_path is not None:
        # Auto-enable in settings.json::enabledPlugins so the user
        # doesn't have to click again. Failure here is non-fatal —
        # the plugin still appears in /plugin list, the user just
        # has to flip the toggle manually.
        enabled = False
        try:
            enabled = _enable_in_claude_settings()
        except Exception:
            logger.exception("Failed to auto-enable in settings.json")
        return InstallResponse(
            ok=True,
            staging_dir=str(STAGING_DIR),
            files=files_written,
            commands=[],
            auto_installed=True,
            claude_install_path=str(install_path),
            enabled=enabled,
            next_step=(
                "Run /reload-plugins in your Claude Code session to activate."
                if enabled
                else "Plugin installed. Enable it via /plugin enable "
                f"{PLUGIN_NAME}, then run /reload-plugins."
            ),
        )

    return InstallResponse(
        ok=True,
        staging_dir=str(STAGING_DIR),
        files=files_written,
        commands=[
            f"/plugin marketplace add {STAGING_DIR}",
            f"/plugin install {PLUGIN_NAME}",
        ],
        auto_installed=False,
        claude_install_path=None,
        enabled=False,
        next_step=None,
    )


@router.post("/uninstall", response_model=UninstallResponse)
async def uninstall_plugin():
    """Remove the staged plugin tree + Claude Code cache entry + settings
    enabledPlugins flag + diagnostic cost-probe payloads. All steps are
    independently best-effort — a failure in one shouldn't block the
    others. Idempotent.

    The cost-probes wipe is a GDPR Art. 17 / CCPA right-to-delete
    affordance: the Stop hook probe writes payload shape metadata to
    ``~/.securevector/cost-probes/``; on uninstall, the user has
    withdrawn consent so we wipe the captured data.
    """
    if STAGING_DIR.is_dir():
        shutil.rmtree(STAGING_DIR, ignore_errors=True)
        logger.info("Removed staged plugin tree at %s", STAGING_DIR)
    try:
        _auto_uninstall_from_claude_cache()
    except Exception:
        logger.exception("Auto-uninstall from Claude Code cache failed")
    try:
        _disable_in_claude_settings()
    except Exception:
        logger.exception("Failed to clear enabledPlugins entry")
    # GDPR Art. 17: clear captured cost-probe payloads on uninstall.
    cost_probes_dir = SECUREVECTOR_DIR / "cost-probes"
    if cost_probes_dir.is_dir():
        try:
            shutil.rmtree(cost_probes_dir, ignore_errors=True)
            logger.info("Removed cost-probes dir at %s", cost_probes_dir)
        except Exception:
            logger.exception("Failed to remove cost-probes dir")
    return UninstallResponse(ok=True)


# --- Token-usage telemetry --------------------------------------------------
#
# Sidesteps the upstream hook-API gap. Anthropic doesn't currently surface
# token usage to plugin hook events (Pre/PostToolUse, Stop), but Claude
# Code DOES persist every turn's `usage` block to disk at
# ``~/.claude/projects/<slug>/<session-id>.jsonl`` — that's the same
# source `/cost` reads. So we read it directly. Local file, no IPC.

CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"


def _parse_iso(ts: str) -> datetime | None:
    """Parse an ISO-8601 transcript timestamp into a timezone-aware datetime.

    Tolerates the trailing ``Z`` (CC's default) and bare offsets. Returns
    ``None`` on parse failure rather than raising. Used wherever we need to
    compare timestamps across sessions — string-comparison of ISO strings
    only works if every row is in the same format (always-Z or always-offset),
    and CC's transcript format has changed at least once historically, so
    parsing is the safe form.
    """
    try:
        norm = ts.replace("Z", "+00:00") if ts.endswith("Z") else ts
        dt = datetime.fromisoformat(norm)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


def _iso_to_local_day(ts: str) -> str | None:
    """Parse an ISO-8601 transcript timestamp into a local-tz ``YYYY-MM-DD``.

    CC writes UTC timestamps with a trailing ``Z`` (e.g. ``2026-05-20T01:25:33.324Z``).
    For the daily roll-up we convert to the host's local timezone so the
    chart's day buckets line up with the user's wall clock. Returns
    ``None`` on parse failure rather than raising — the caller treats
    "no day" as "skip this row from the daily series."
    """
    try:
        # `fromisoformat` doesn't accept the trailing 'Z' before Python 3.11
        # without normalisation. Normalise to `+00:00`.
        norm = ts.replace("Z", "+00:00") if ts.endswith("Z") else ts
        dt = datetime.fromisoformat(norm)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        local = dt.astimezone()
        return local.strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        return None


def _aggregate_session_usage(
    jsonl_path: Path,
) -> tuple[int, int, int, int, int, str | None,
           dict[str, dict[str, int]], dict[str, dict[str, int]]]:
    """Sum the per-turn ``usage`` blocks in a Claude Code session transcript.

    Returns ``(turns, input, output, cache_create, cache_read, last_iso,
    per_model, per_day)``. ``per_model`` is keyed by model name; ``per_day``
    is keyed by local-tz ``YYYY-MM-DD``. Both sub-dicts carry the same
    ``turns/input/output/cache_create/cache_read`` shape.

    Malformed lines / missing usage keys are skipped quietly — transcript
    files can be partially-written if Claude Code is mid-flush, and we
    refuse to crash the route on a single bad row.
    """
    turns = 0
    inp = out = cc = cr = 0
    last_iso: str | None = None
    per_model: dict[str, dict[str, int]] = {}
    per_day: dict[str, dict[str, int]] = {}
    try:
        with jsonl_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msg = rec.get("message") or {}
                u = msg.get("usage")
                if not isinstance(u, dict):
                    continue
                turns += 1
                t_in = int(u.get("input_tokens") or 0)
                t_out = int(u.get("output_tokens") or 0)
                t_cc = int(u.get("cache_creation_input_tokens") or 0)
                t_cr = int(u.get("cache_read_input_tokens") or 0)
                inp += t_in
                out += t_out
                cc += t_cc
                cr += t_cr
                model = msg.get("model") or "unknown"
                mu = per_model.setdefault(model, {
                    "turns": 0, "input": 0, "output": 0,
                    "cache_create": 0, "cache_read": 0,
                })
                mu["turns"] += 1
                mu["input"] += t_in
                mu["output"] += t_out
                mu["cache_create"] += t_cc
                mu["cache_read"] += t_cr
                ts = rec.get("timestamp")
                if isinstance(ts, str):
                    last_iso = ts
                    day = _iso_to_local_day(ts)
                    if day is not None:
                        du = per_day.setdefault(day, {
                            "turns": 0, "input": 0, "output": 0,
                            "cache_create": 0, "cache_read": 0,
                        })
                        du["turns"] += 1
                        du["input"] += t_in
                        du["output"] += t_out
                        du["cache_create"] += t_cc
                        du["cache_read"] += t_cr
    except OSError:
        # File is locked / unreadable — treat as empty rather than 500.
        pass
    return turns, inp, out, cc, cr, last_iso, per_model, per_day


def _compute_token_usage_sync() -> TokenUsageResponse:
    """Blocking implementation of token-usage aggregation.

    Extracted from the async route handler so the FastAPI route can
    delegate to ``asyncio.to_thread`` — see route docstring for why.
    Returns a fully-populated ``TokenUsageResponse``.
    """
    if not CLAUDE_PROJECTS_DIR.is_dir():
        return TokenUsageResponse(
            sessions=0, turns_with_usage=0,
            input_tokens=0, output_tokens=0,
            cache_creation_input_tokens=0, cache_read_input_tokens=0,
            last_activity=None,
            by_model=[],
            daily=[],
        )

    sessions = 0
    total_turns = 0
    total_inp = total_out = total_cc = total_cr = 0
    latest_iso: str | None = None
    # model_totals: model_name -> {turns, input, output, cache_create, cache_read}
    model_totals: dict[str, dict[str, int]] = {}
    # day_totals: 'YYYY-MM-DD' -> same shape
    day_totals: dict[str, dict[str, int]] = {}

    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue
        for jsonl in project_dir.glob("*.jsonl"):
            sessions += 1
            t, i, o, cc, cr, last, per_model, per_day = _aggregate_session_usage(jsonl)
            total_turns += t
            total_inp += i
            total_out += o
            total_cc += cc
            total_cr += cr
            if last:
                # Parse-compare rather than string-compare: CC transcripts
                # are always-Z UTC today, but a future format change (or a
                # session synced from another tool with a different ISO
                # form) would silently break lexicographic ordering.
                if latest_iso is None:
                    latest_iso = last
                else:
                    last_dt = _parse_iso(last)
                    current_dt = _parse_iso(latest_iso)
                    if last_dt is not None and (current_dt is None or last_dt > current_dt):
                        latest_iso = last
            for model, mu in per_model.items():
                agg = model_totals.setdefault(model, {
                    "turns": 0, "input": 0, "output": 0,
                    "cache_create": 0, "cache_read": 0,
                })
                for k, v in mu.items():
                    agg[k] += v
            for day, du in per_day.items():
                agg = day_totals.setdefault(day, {
                    "turns": 0, "input": 0, "output": 0,
                    "cache_create": 0, "cache_read": 0,
                })
                for k, v in du.items():
                    agg[k] += v

    by_model: list[ModelUsage] = [
        ModelUsage(
            model=model,
            turns=mu["turns"],
            input_tokens=mu["input"],
            output_tokens=mu["output"],
            cache_creation_input_tokens=mu["cache_create"],
            cache_read_input_tokens=mu["cache_read"],
        )
        for model, mu in model_totals.items()
    ]
    # Sort biggest model first by total tokens so the UI top-N is stable.
    by_model.sort(
        key=lambda m: m.input_tokens + m.output_tokens
                    + m.cache_creation_input_tokens + m.cache_read_input_tokens,
        reverse=True,
    )

    # Daily series — sorted oldest → newest, last 30 days. The frontend
    # 7-day chart filters to last-7; surfacing 30 also lets a future
    # "month view" reuse the same payload.
    daily: list[DailyTokenUsage] = sorted(
        (
            DailyTokenUsage(
                day=day,
                turns=du["turns"],
                input_tokens=du["input"],
                output_tokens=du["output"],
                cache_creation_input_tokens=du["cache_create"],
                cache_read_input_tokens=du["cache_read"],
            )
            for day, du in day_totals.items()
        ),
        key=lambda d: d.day,
    )[-30:]

    return TokenUsageResponse(
        sessions=sessions,
        turns_with_usage=total_turns,
        input_tokens=total_inp,
        output_tokens=total_out,
        cache_creation_input_tokens=total_cc,
        cache_read_input_tokens=total_cr,
        last_activity=latest_iso,
        by_model=by_model,
        daily=daily,
    )


@router.get("/token-usage", response_model=TokenUsageResponse)
async def get_token_usage() -> TokenUsageResponse:
    """Aggregate token usage across all Claude Code session transcripts.

    Walks ``~/.claude/projects/*/*.jsonl`` and sums each session's
    ``message.usage`` blocks. Tolerates a missing projects dir (returns
    zeros) — fresh installs that haven't run any CC sessions yet land
    here legitimately.

    Why this lives on a CC-plugin route rather than the shared
    ``/api/costs/*`` surface: the transcript-on-disk discovery is
    CC-specific. OpenClaw cost goes through its own `llm_output` event
    pipeline; the two sources don't share a code path even though they
    eventually display in the same Cost Tracking UI.

    The actual filesystem walk + per-line parse runs in a thread pool
    via ``asyncio.to_thread`` so a user with hundreds of jsonl files
    doesn't stall the event loop for every other request. Aggregation
    is pure CPU once the I/O is done — fine to keep in one helper.
    """
    return await asyncio.to_thread(_compute_token_usage_sync)
