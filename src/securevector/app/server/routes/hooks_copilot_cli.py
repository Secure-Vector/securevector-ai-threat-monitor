"""
GitHub Copilot CLI plugin management API endpoints.

Parallel to ``hooks_claude_code.py``, ``hooks_codex.py``, and ``hooks.py``.
All delegate the shared file-staging plumbing to ``_hooks_common``.

GET  /api/hooks/copilot-cli/status     - Plugin install status
POST /api/hooks/copilot-cli/install    - Stage + auto-install into Copilot CLI
POST /api/hooks/copilot-cli/uninstall  - Remove the plugin (idempotent)

Install flow (mirrors Claude Code / Codex auto-install — no paste-in command):

  1. Stage the plugin tree (with the local-app URL substituted) into
     ``~/.securevector/staging/copilot-cli-plugin/`` — that directory IS the
     plugin (``plugin.json`` at its root). This is the "source of truth" copy.
  2. Copy that tree into Copilot's own store at
     ``~/.copilot/installed-plugins/_direct/copilot-cli-plugin/`` and register
     it as enabled in ``~/.copilot/config.json`` → ``installedPlugins[]``.

Copilot's on-disk layout was verified empirically against CLI v1.0.60 (the
shape ``copilot plugin install <local-dir>`` itself produces):

  * Files live under ``~/.copilot/installed-plugins/_direct/<staging-basename>/``.
  * The registry is ``~/.copilot/config.json`` (JSONC — leading ``//`` comment
    header) with an ``installedPlugins`` array; each entry carries
    ``name``/``version``/``enabled``/``cache_path``/``source.path``.
  * The ENABLEMENT source of truth is the per-entry ``enabled`` flag in
    config.json — NOT ``settings.json``'s ``enabledPlugins`` (which stays ``{}``
    even for an enabled plugin). So we touch only config.json.

If ``~/.copilot`` doesn't exist (Copilot CLI not installed), we fall back to
staging-only and return the documented ``copilot plugin install <dir>`` command
so the user can install once they have the CLI.

VERIFIED against Copilot CLI v1.0.60 (--log-level debug, live sessions):
  - ``${COPILOT_PLUGIN_ROOT}`` expands for installed-plugin hook commands.
  - MCP tools present to hooks as ``<server>-<tool>`` (e.g. ``everything-echo``),
    NOT Claude's ``mcp__server__tool``. ``lib/normalize.js`` handles the Copilot
    shape and emits literal / ``<server>:<tool>`` / bare-tool / server candidates.
  - The full built-in tool inventory (bash + the ``*_bash`` background-shell
    family, view/edit/create/glob/grep, web_fetch, task, skill, sql, …) was
    captured from the debug tool list and mirrored into the Python
    ``COPILOT_CLI_BUILTINS`` table (drift-tested against normalize.js).
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
from datetime import datetime, timezone
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

# Staging dir IS the plugin dir (plugin.json at its root). Also the registered
# ``source.path`` so a later ``copilot plugin update`` knows where we came from.
SECUREVECTOR_DIR = Path.home() / ".securevector"
STAGING_DIR = SECUREVECTOR_DIR / "staging" / "copilot-cli-plugin"

# Copilot CLI per-user home; presence is the "Copilot detected" signal AND the
# gate for auto-install. Copilot honours $COPILOT_HOME to relocate this base.
COPILOT_HOME = Path(os.environ.get("COPILOT_HOME", str(Path.home() / ".copilot")))
COPILOT_CONFIG_JSON = COPILOT_HOME / "config.json"
# Copilot copies a locally-installed plugin's files here, keyed by the source
# directory's basename (verified against `copilot plugin install`). Our staging
# dir basename is ``copilot-cli-plugin``, so we land at the same path the
# supported command would have produced — fully interchangeable with it.
COPILOT_CACHE_DIR = COPILOT_HOME / "installed-plugins" / "_direct" / STAGING_DIR.name
# Per-plugin runtime data dir Copilot creates (keyed by plugin NAME). Removed on
# uninstall so we leave no residue.
COPILOT_PLUGIN_DATA_DIR = COPILOT_HOME / "plugin-data" / "_direct" / PLUGIN_NAME


# --- Pydantic response models -----------------------------------------------


class StatusResponse(BaseModel):
    installed: bool
    staging_dir: str
    files_present: list[str]
    copilot_detected: bool = False
    # True when the plugin is registered + enabled in Copilot's config.json.
    auto_installed: bool = False
    enabled: bool = False


class InstallResponse(BaseModel):
    ok: bool
    staging_dir: str
    files: list[str]
    # True when we wrote directly into Copilot's store + config.json. False when
    # Copilot isn't installed and we only staged (commands tells the user how).
    auto_installed: bool = False
    enabled: bool = False
    install_path: Optional[str] = None
    commands: list[str] = []
    next_step: Optional[str] = None


class UninstallResponse(BaseModel):
    ok: bool


# --- JSONC config helpers ----------------------------------------------------
#
# Copilot's config.json is JSON with a leading ``//`` comment header
# ("// This file is managed automatically."). stdlib json can't parse comments,
# so we strip leading full-line comments to read and re-prepend the captured
# header on write — keeping the file looking native + managed. We only ever
# strip lines whose FIRST non-whitespace chars are ``//``; inline ``//`` inside
# JSON string values (e.g. ``http://``) lives on ``"key": ...`` lines and is
# never touched.

# Fallback header used only if the file had none (e.g. we created it). These are
# Copilot's own lines, harmless and informational.
_DEFAULT_CONFIG_HEADER = [
    "// User settings belong in settings.json.",
    "// This file is managed automatically.",
]


def _read_config_jsonc(path: Path) -> tuple[dict, list[str]]:
    """Return ``(data, header_lines)`` for Copilot's config.json.

    ``header_lines`` is the leading contiguous block of blank / ``//`` lines,
    preserved verbatim so a rewrite stays byte-faithful to Copilot's format.
    Missing / empty / malformed file → empty dict + default header (we never
    raise here; install proceeds on a best-effort fresh registry)."""
    if not path.is_file():
        return {}, list(_DEFAULT_CONFIG_HEADER)
    raw = path.read_text(encoding="utf-8")
    lines = raw.splitlines()
    header: list[str] = []
    body_start = 0
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped == "" or stripped.startswith("//"):
            header.append(line)
            body_start = i + 1
        else:
            break
    body = "\n".join(lines[body_start:])
    try:
        data = json.loads(body) if body.strip() else {}
    except json.JSONDecodeError as e:
        logger.warning(
            "Copilot config.json malformed at %s (%s); starting from empty registry",
            path, e,
        )
        return {}, header or list(_DEFAULT_CONFIG_HEADER)
    if not isinstance(data, dict):
        logger.warning("Copilot config.json is not an object; starting from empty registry")
        return {}, header or list(_DEFAULT_CONFIG_HEADER)
    return data, header or list(_DEFAULT_CONFIG_HEADER)


def _backup_once(path: Path) -> None:
    """One-shot pristine snapshot to ``<path>.before-securevector`` before the
    first mutation. ONE-SHOT: never clobbers an existing backup (a reinstall
    must not overwrite the pristine snapshot). No-op when source is absent.
    Best-effort — never raises. Mirror of ``hooks_claude_code._backup_once``."""
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


def _atomic_write_config(path: Path, data: dict, header: list[str]) -> None:
    """Atomically write Copilot config.json (header + pretty JSON body), with a
    symlink + traversal guard scoped to ``~/.copilot`` / ``~/.securevector``.

    Same crash-safety + security contract as ``hooks_claude_code._atomic_write_json``:
    tempfile + ``os.replace`` so a crash can't leave a half-truncated config,
    and a refusal to write anywhere outside the two allowed roots (defeats a
    path-traversal via a hostile ``COPILOT_HOME``)."""
    resolved_parent = path.parent.resolve(strict=False)
    home = Path.home().resolve(strict=False)
    copilot_root = (home / ".copilot").resolve(strict=False)
    sv_root = (home / ".securevector").resolve(strict=False)
    # Allow the configured COPILOT_HOME too (tests / $COPILOT_HOME relocation),
    # but still refuse arbitrary destinations.
    configured_root = COPILOT_HOME.resolve(strict=False)
    if not (
        resolved_parent.is_relative_to(copilot_root)
        or resolved_parent.is_relative_to(sv_root)
        or resolved_parent.is_relative_to(configured_root)
    ):
        raise PermissionError(
            f"refusing to write outside allowed dirs (~/.copilot or ~/.securevector): "
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
            for line in header:
                f.write(line + "\n")
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp_path, resolved_parent / path.name)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _auto_install_to_copilot(version: str) -> Path:
    """Copy the staged tree into Copilot's store + register it enabled in
    config.json. Returns the install (cache) path. Idempotent: a reinstall
    overwrites the cached files and updates the existing registry entry in
    place (matched by ``name``) rather than appending a duplicate.

    Copy is staged via a ``.tmp`` sibling + atomic rename so a crash can't
    leave Copilot pointing at a half-copied plugin dir."""
    # 1. Copy plugin files into Copilot's store (atomic: tmp dir → replace).
    COPILOT_CACHE_DIR.parent.mkdir(parents=True, exist_ok=True)
    tmp_install = COPILOT_CACHE_DIR.parent / (COPILOT_CACHE_DIR.name + ".tmp")
    if tmp_install.exists():
        shutil.rmtree(tmp_install, ignore_errors=True)
    shutil.copytree(STAGING_DIR, tmp_install)
    if COPILOT_CACHE_DIR.exists():
        shutil.rmtree(COPILOT_CACHE_DIR, ignore_errors=True)
    os.replace(tmp_install, COPILOT_CACHE_DIR)

    # 2. Register (enabled) in config.json. Back up the pristine file first.
    _backup_once(COPILOT_CONFIG_JSON)
    data, header = _read_config_jsonc(COPILOT_CONFIG_JSON)
    plugins = data.get("installedPlugins")
    if not isinstance(plugins, list):
        plugins = []
    now_iso = (
        datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    )
    entry = {
        "name": PLUGIN_NAME,
        "marketplace": "",
        "version": version,
        "installed_at": now_iso,
        "enabled": True,
        "cache_path": str(COPILOT_CACHE_DIR),
        "source": {"source": "local", "path": str(STAGING_DIR)},
    }
    # Upsert by name — preserve every other plugin's entry untouched.
    replaced = False
    for i, p in enumerate(plugins):
        if isinstance(p, dict) and p.get("name") == PLUGIN_NAME:
            # Keep the original installed_at on reinstall (less churn).
            entry["installed_at"] = p.get("installed_at", now_iso)
            plugins[i] = entry
            replaced = True
            break
    if not replaced:
        plugins.append(entry)
    data["installedPlugins"] = plugins
    _atomic_write_config(COPILOT_CONFIG_JSON, data, header)

    logger.info(
        "Auto-installed Copilot CLI plugin %s v%s → %s (registered enabled in %s)",
        PLUGIN_NAME, version, COPILOT_CACHE_DIR, COPILOT_CONFIG_JSON,
    )
    return COPILOT_CACHE_DIR


def _is_registered_enabled() -> bool:
    """True when config.json has an enabled ``securevector-guard`` entry."""
    if not COPILOT_CONFIG_JSON.is_file():
        return False
    data, _ = _read_config_jsonc(COPILOT_CONFIG_JSON)
    for p in data.get("installedPlugins", []) or []:
        if isinstance(p, dict) and p.get("name") == PLUGIN_NAME:
            return bool(p.get("enabled"))
    return False


def _plugin_version() -> str:
    """Resolve the running app version for the registry entry."""
    try:
        from securevector import __version__
        return __version__
    except Exception:  # pragma: no cover - defensive
        return "0.0.0"


# --- Routes -----------------------------------------------------------------


@router.get("/status", response_model=StatusResponse)
async def plugin_status():
    """Whether the plugin is staged, whether Copilot is installed, and whether
    it's registered+enabled in Copilot's config.json. Read-only."""
    files_present = [f for f in PLUGIN_FILES if (STAGING_DIR / f).is_file()]
    enabled = _is_registered_enabled()
    return StatusResponse(
        installed=len(files_present) == len(PLUGIN_FILES),
        staging_dir=str(STAGING_DIR),
        files_present=files_present,
        copilot_detected=COPILOT_HOME.is_dir(),
        auto_installed=COPILOT_CACHE_DIR.is_dir() and enabled,
        enabled=enabled,
    )


@router.post("/install", response_model=InstallResponse)
async def install_plugin():
    """Stage the plugin tree (URL-substituted), then — if Copilot CLI is
    installed — copy it into Copilot's store and register it enabled in
    config.json (no paste-in command needed). Idempotent: reinstall overwrites
    the staged + cached files and keeps hooks pointing at the current app URL.

    Falls back to staging-only + the documented install command when Copilot
    isn't installed yet (``~/.copilot`` absent)."""
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

    # Auto-install into Copilot's store when the CLI is present. Parity with
    # claude-code / codex / openclaw: one call → installed + enabled.
    if COPILOT_HOME.is_dir():
        try:
            install_path = _auto_install_to_copilot(_plugin_version())
        except Exception as e:  # surface, but don't lose the staged copy
            logger.exception("Copilot CLI auto-install failed; staged copy is intact")
            raise HTTPException(
                status_code=500,
                detail=(
                    f"Staged the plugin but failed to install into Copilot's store: {e}. "
                    f"You can install manually: copilot plugin install {STAGING_DIR}"
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
                "Installed and enabled. Start a new Copilot CLI session to load "
                "the plugin's hooks (Copilot reads plugins at launch)."
            ),
        )

    # Fallback: Copilot not installed — hand the user the documented command.
    return InstallResponse(
        ok=True,
        staging_dir=str(STAGING_DIR),
        files=files_written,
        auto_installed=False,
        enabled=False,
        install_path=None,
        commands=[f"copilot plugin install {STAGING_DIR}"],
        next_step=(
            "Copilot CLI was not detected (~/.copilot is absent). Once it's "
            "installed, run the command above, then start a new Copilot session."
        ),
    )


@router.post("/uninstall", response_model=UninstallResponse)
async def uninstall_plugin():
    """Remove the plugin everywhere we wrote it: the staged tree, Copilot's
    cached copy, the per-plugin data dir, and its config.json registry entry.
    Idempotent — safe to call with nothing installed."""
    # 1. Staged source-of-truth tree.
    if STAGING_DIR.is_dir():
        shutil.rmtree(STAGING_DIR, ignore_errors=True)
        logger.info("Removed staged Copilot CLI plugin tree at %s", STAGING_DIR)

    # 2. Copilot's cached copy + per-plugin data dir.
    if COPILOT_CACHE_DIR.is_dir():
        shutil.rmtree(COPILOT_CACHE_DIR, ignore_errors=True)
        logger.info("Removed Copilot CLI plugin cache at %s", COPILOT_CACHE_DIR)
    if COPILOT_PLUGIN_DATA_DIR.is_dir():
        shutil.rmtree(COPILOT_PLUGIN_DATA_DIR, ignore_errors=True)

    # 3. Deregister from config.json (preserve every other plugin's entry).
    if COPILOT_CONFIG_JSON.is_file():
        _backup_once(COPILOT_CONFIG_JSON)
        data, header = _read_config_jsonc(COPILOT_CONFIG_JSON)
        plugins = data.get("installedPlugins")
        if isinstance(plugins, list):
            kept = [
                p for p in plugins
                if not (isinstance(p, dict) and p.get("name") == PLUGIN_NAME)
            ]
            if len(kept) != len(plugins):
                data["installedPlugins"] = kept
                try:
                    _atomic_write_config(COPILOT_CONFIG_JSON, data, header)
                    logger.info("Deregistered %s from %s", PLUGIN_NAME, COPILOT_CONFIG_JSON)
                except Exception as e:  # best-effort; cache already gone
                    logger.warning("Could not rewrite Copilot config.json (continuing): %s", e)

    return UninstallResponse(ok=True)


# --- Token usage (Cost Tracking) -------------------------------------------
#
# Mirrors the Claude Code transcript scanner: Copilot CLI writes per-session
# event logs to ~/.copilot/session-state/<id>/events.jsonl, and each session's
# token consumption is available as CUMULATIVE per-model counters in the
# `data.modelMetrics.<model>.usage` block (carried on `session.shutdown` and
# periodically on turn events). Unlike Claude Code transcripts there is no
# reliable per-turn usage delta, so a session's totals are attributed to the
# day of its last activity — close enough for the 7/30-day dashboard charts.
#
# Reuses the Claude Code route's response models + ISO helpers so the Cost
# Tracking UI consumes an identical payload shape from both runtimes.

from .hooks_claude_code import (  # noqa: E402  (route-module convention)
    DailyTokenUsage,
    ModelUsage,
    TokenUsageResponse,
    _iso_to_local_day,
    _parse_iso,
)

COPILOT_SESSION_STATE_DIR = COPILOT_HOME / "session-state"


def _aggregate_copilot_session(events_path: Path):
    """Return (turns, per_model_usage, last_iso) for one events.jsonl.

    per_model_usage: model -> {input, output, cache_create, cache_read}
    taken from the LAST modelMetrics snapshot in the file (the counters are
    cumulative, so the last snapshot IS the session total — covers both clean
    `session.shutdown` files and sessions that died mid-flight).
    """
    turns = 0
    snapshot: dict = {}
    last_iso = None
    try:
        with open(events_path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                if not isinstance(rec, dict):
                    continue
                ts = rec.get("timestamp")
                if isinstance(ts, str):
                    last_iso = ts
                etype = rec.get("type")
                if etype == "assistant.message":
                    turns += 1
                data = rec.get("data")
                metrics = data.get("modelMetrics") if isinstance(data, dict) else None
                if isinstance(metrics, dict) and metrics:
                    snapshot = metrics
    except OSError:
        # File locked / unreadable — treat as empty rather than 500.
        return 0, {}, None

    per_model: dict = {}
    for model, m in snapshot.items():
        usage = m.get("usage") if isinstance(m, dict) else None
        if not isinstance(usage, dict):
            continue
        # `outputTokens` already includes the model's reasoning tokens
        # (reasoningTokens is an of-which breakdown, not an addend), so it is
        # NOT added again here. cacheWrite/cacheRead map onto the CC payload's
        # cache_creation / cache_read fields.
        per_model[model] = {
            "input": int(usage.get("inputTokens") or 0),
            "output": int(usage.get("outputTokens") or 0),
            "cache_create": int(usage.get("cacheWriteTokens") or 0),
            "cache_read": int(usage.get("cacheReadTokens") or 0),
        }
    return turns, per_model, last_iso


def _compute_copilot_token_usage_sync() -> TokenUsageResponse:
    """Blocking aggregation across all Copilot CLI session logs."""
    if not COPILOT_SESSION_STATE_DIR.is_dir():
        return TokenUsageResponse(
            sessions=0, turns_with_usage=0,
            input_tokens=0, output_tokens=0,
            cache_creation_input_tokens=0, cache_read_input_tokens=0,
            last_activity=None, by_model=[], daily=[],
        )

    sessions = 0
    total_turns = 0
    total = {"input": 0, "output": 0, "cache_create": 0, "cache_read": 0}
    latest_iso = None
    model_totals: dict = {}
    day_totals: dict = {}

    for session_dir in COPILOT_SESSION_STATE_DIR.iterdir():
        events = session_dir / "events.jsonl"
        if not session_dir.is_dir() or not events.is_file():
            continue
        turns, per_model, last_iso = _aggregate_copilot_session(events)
        if not per_model and turns == 0:
            continue
        sessions += 1
        total_turns += turns
        if last_iso:
            last_dt = _parse_iso(last_iso)
            cur_dt = _parse_iso(latest_iso) if latest_iso else None
            if last_dt is not None and (cur_dt is None or last_dt > cur_dt):
                latest_iso = last_iso
        day = _iso_to_local_day(last_iso) if last_iso else None
        for model, mu in per_model.items():
            agg = model_totals.setdefault(model, {
                "turns": 0, "input": 0, "output": 0,
                "cache_create": 0, "cache_read": 0,
            })
            agg["turns"] += turns
            for k in ("input", "output", "cache_create", "cache_read"):
                agg[k] += mu[k]
                total[k] += mu[k]
            if day is not None:
                du = day_totals.setdefault(day, {
                    "turns": 0, "input": 0, "output": 0,
                    "cache_create": 0, "cache_read": 0,
                })
                du["turns"] += turns
                for k in ("input", "output", "cache_create", "cache_read"):
                    du[k] += mu[k]

    by_model = [
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
    by_model.sort(
        key=lambda m: m.input_tokens + m.output_tokens
                    + m.cache_creation_input_tokens + m.cache_read_input_tokens,
        reverse=True,
    )

    daily = sorted(
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
        input_tokens=total["input"],
        output_tokens=total["output"],
        cache_creation_input_tokens=total["cache_create"],
        cache_read_input_tokens=total["cache_read"],
        last_activity=latest_iso,
        by_model=by_model,
        daily=daily,
    )


# Same short-TTL memo as the CC scanner — the dashboard re-requests on every
# navigation and the walk is disk-bound.
_COPILOT_TOKEN_USAGE_TTL_SECONDS = 60.0
_copilot_token_usage_cache: dict = {"ts": 0.0, "value": None}


@router.get("/token-usage", response_model=TokenUsageResponse)
async def get_copilot_token_usage() -> TokenUsageResponse:
    """Aggregate token usage across all Copilot CLI session logs.

    Walks ``~/.copilot/session-state/*/events.jsonl`` and reads each
    session's final cumulative ``modelMetrics`` snapshot. Missing dir →
    zeros (fresh installs that haven't run a Copilot session).
    """
    import asyncio
    import time

    now = time.monotonic()
    cached = _copilot_token_usage_cache
    if cached["value"] is not None and (now - cached["ts"]) < _COPILOT_TOKEN_USAGE_TTL_SECONDS:
        return cached["value"]
    value = await asyncio.to_thread(_compute_copilot_token_usage_sync)
    cached["ts"] = time.monotonic()
    cached["value"] = value
    return value
