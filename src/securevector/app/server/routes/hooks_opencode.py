"""
OpenCode plugin management API endpoints.

Parallel to ``hooks_claude_code.py``, ``hooks_codex.py``, and
``hooks_copilot_cli.py``. All delegate the shared file-staging plumbing to
``_hooks_common``.

GET  /api/hooks/opencode/status     - Plugin install status
POST /api/hooks/opencode/install    - Stage + register with OpenCode
POST /api/hooks/opencode/uninstall  - Remove the plugin (idempotent)

WHY THIS ONE IS SHAPED DIFFERENTLY
----------------------------------
Every other harness we support loads plugins as SUBPROCESS HOOKS declared in a
``hooks.json``, so their install handlers copy a tree into a host-owned store
and register a manifest. OpenCode instead loads plugins as IN-PROCESS ES
MODULES: ``packages/opencode/src/plugin/index.ts`` imports each entry in the
resolved config's ``plugin`` array and calls it as a factory. Consequences for
this module:

  * There is no separate host "store" to copy into. The staged directory IS the
    installed plugin — OpenCode imports it in place.
  * Registration is a single string appended to the ``plugin`` array in
    OpenCode's config file. Presence in that array IS enablement; there is no
    per-entry ``enabled`` flag to honour (contrast Copilot's ``installedPlugins``).
  * No ``plugin.json`` manifest and no plugin-root env var — the module's own
    ``package.json`` is the manifest, and imports resolve relative to the file.

Verified against opencode 1.18.23 (anomalyco/opencode):

  * Config file: ``~/.config/opencode/opencode.json`` (or ``opencode.jsonc``);
    honours ``$OPENCODE_CONFIG`` (explicit file) and ``$XDG_CONFIG_HOME``.
  * ``src/config/plugin.ts::resolvePluginSpec`` accepts a path-like spec — one
    that ``isPathPluginSpec`` recognises as ``file://``-prefixed, ``.``-relative,
    or ABSOLUTE — and ``resolvePathPluginTarget`` resolves an absolute path to a
    DIRECTORY as long as that directory contains a ``package.json`` (ours does).
    So registering ``str(STAGING_DIR)`` is a first-class, offline-safe install:
    no npm fetch, no network, no registry account.
  * ``deduplicatePluginOrigins`` keys local specs on the exact resolved
    ``file://`` URL, so a repeat install of the same path cannot double-load.

We deliberately do NOT use the ``{plugin,plugins}/*.{ts,js}`` directory
auto-scan that ``ConfigPlugin.load()`` also supports: that glob does not
descend into subdirectories, so it can only pick up a single flat file, and our
plugin is a directory with a ``lib/``.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import _hooks_common

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hooks/opencode", tags=["Hooks"])

PLUGIN_NAME = "securevector-guard"

# Plugin tree files — must match what lives under
# ``src/securevector/plugins/opencode/``. ``package.json`` is load-bearing:
# it is both the ESM ``type: module`` marker and the file that lets OpenCode
# resolve the staged DIRECTORY as a plugin target.
PLUGIN_FILES = [
    "package.json",
    "index.js",
    "lib/normalize.js",
    "lib/decide.js",
    "lib/client.js",
    "lib/redact.js",
    "LICENSE",
    "README.md",
    "PRIVACY.md",
]

# Bundled plugin source: src/securevector/app/server/routes/<this> → up 4 → securevector/
BUNDLED_PLUGIN_DIR = Path(__file__).parent.parent.parent.parent / "plugins" / "opencode"

# The staged dir IS the installed plugin — OpenCode imports it in place.
SECUREVECTOR_DIR = Path.home() / ".securevector"
STAGING_DIR = SECUREVECTOR_DIR / "staging" / "opencode-plugin"


def _opencode_config_dir() -> Path:
    """OpenCode's global config directory.

    Mirrors OpenCode's own resolution order: an explicit ``$OPENCODE_CONFIG``
    file wins (we take its parent), then ``$XDG_CONFIG_HOME/opencode``, then
    ``~/.config/opencode``. Confirmed against ``opencode debug paths``.
    """
    explicit = os.environ.get("OPENCODE_CONFIG")
    if explicit:
        return Path(explicit).expanduser().parent
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg).expanduser() / "opencode"
    return Path.home() / ".config" / "opencode"


def _opencode_config_file() -> Path:
    """The config file to read/write.

    Prefers an explicit ``$OPENCODE_CONFIG``; otherwise an existing
    ``opencode.jsonc`` (so we don't strand a user's commented config by writing
    a competing ``.json`` beside it), else ``opencode.json``.
    """
    explicit = os.environ.get("OPENCODE_CONFIG")
    if explicit:
        return Path(explicit).expanduser()
    cfg_dir = _opencode_config_dir()
    jsonc = cfg_dir / "opencode.jsonc"
    if jsonc.is_file():
        return jsonc
    return cfg_dir / "opencode.json"


def _opencode_data_dir() -> Path:
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        return Path(xdg).expanduser() / "opencode"
    return Path.home() / ".local" / "share" / "opencode"


def _opencode_detected() -> bool:
    """True when OpenCode looks installed on this machine.

    Any of: the binary on PATH, the config dir, or the data dir. The binary
    alone is enough — a freshly-installed OpenCode has neither directory until
    its first run, and we can create the config ourselves.
    """
    if shutil.which("opencode"):
        return True
    return _opencode_config_dir().is_dir() or _opencode_data_dir().is_dir()


# --- Pydantic response models -----------------------------------------------


class StatusResponse(BaseModel):
    installed: bool
    staging_dir: str
    files_present: list[str]
    opencode_detected: bool = False
    # True when the staged plugin is registered in OpenCode's config `plugin` array.
    auto_installed: bool = False
    enabled: bool = False
    config_file: Optional[str] = None


class InstallResponse(BaseModel):
    ok: bool
    staging_dir: str
    files: list[str]
    auto_installed: bool = False
    enabled: bool = False
    install_path: Optional[str] = None
    config_file: Optional[str] = None
    commands: list[str] = []
    next_step: Optional[str] = None


class UninstallResponse(BaseModel):
    ok: bool


# --- JSONC helpers -----------------------------------------------------------
#
# OpenCode accepts ``opencode.jsonc``, and users hand-write these files, so a
# config may carry ``//`` line comments. stdlib json can't parse them. We strip
# only lines whose FIRST non-whitespace characters are ``//`` and re-prepend the
# captured leading header on write — inline ``//`` inside a string value (a URL
# in ``"$schema"``, say) sits on a ``"key": ...`` line and is never touched.

_LINE_COMMENT = re.compile(r"^\s*//")


def _read_config_jsonc(path: Path) -> tuple[dict, list[str]]:
    """Return ``(data, leading_header_lines)`` for an OpenCode config file."""
    if not path.is_file():
        return {}, []
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as e:
        logger.warning("Could not read OpenCode config at %s: %s", path, e)
        return {}, []

    lines = raw.splitlines()
    header: list[str] = []
    idx = 0
    for line in lines:
        if _LINE_COMMENT.match(line) or not line.strip():
            header.append(line)
            idx += 1
            continue
        break
    body_lines = lines[idx:]
    # Drop any remaining full-line comments inside the body so json.loads works.
    body = "\n".join(ln for ln in body_lines if not _LINE_COMMENT.match(ln))
    # Trailing blank header lines belong to the body's whitespace, not the header.
    while header and not header[-1].strip():
        header.pop()
    try:
        data = json.loads(body) if body.strip() else {}
    except json.JSONDecodeError as e:
        logger.warning("OpenCode config at %s is not valid JSON (%s)", path, e)
        raise HTTPException(
            status_code=500,
            detail=(
                f"OpenCode's config at {path} could not be parsed as JSON ({e}). "
                "Fix or move that file, then retry the install — SecureVector will "
                "not overwrite a config it cannot safely read."
            ),
        )
    if not isinstance(data, dict):
        return {}, header
    return data, header


def _backup_once(path: Path) -> None:
    """One-shot pristine snapshot to ``<path>.before-securevector`` before the
    first mutation. Never clobbers an existing backup (a reinstall must not
    overwrite the pristine snapshot). No-op when source is absent. Best-effort —
    never raises. Mirror of ``hooks_claude_code._backup_once``."""
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
    """Atomically write OpenCode's config (header + pretty JSON body), with a
    symlink + traversal guard scoped to OpenCode's config dir and
    ``~/.securevector``.

    Same crash-safety + security contract as ``hooks_claude_code._atomic_write_json``:
    tempfile + ``os.replace`` so a crash can't leave a half-truncated config, and
    a refusal to write anywhere outside the allowed roots (defeats path traversal
    via a hostile ``$OPENCODE_CONFIG`` / ``$XDG_CONFIG_HOME``)."""
    resolved_parent = path.parent.resolve(strict=False)
    home = Path.home().resolve(strict=False)
    allowed = [
        (home / ".config" / "opencode").resolve(strict=False),
        (home / ".securevector").resolve(strict=False),
        _opencode_config_dir().resolve(strict=False),
    ]
    if not any(resolved_parent.is_relative_to(root) for root in allowed):
        raise PermissionError(
            "refusing to write outside allowed dirs (OpenCode config dir or "
            f"~/.securevector): resolved {resolved_parent} (was {path})"
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


def _spec_matches_staging(spec) -> bool:
    """True when a ``plugin`` array entry refers to our staged plugin.

    An entry may be a plain string or a ``[spec, options]`` pair (OpenCode's
    ``ConfigPluginV1.Spec``). We compare against both the raw path and its
    ``file://`` URL form, since a user may have written either — and OpenCode
    itself normalises path specs to ``file://`` in memory.
    """
    if isinstance(spec, list) and spec:
        spec = spec[0]
    if not isinstance(spec, str):
        return False
    staged = str(STAGING_DIR)
    candidates = {staged, staged.rstrip("/"), Path(staged).as_uri()}
    return spec.rstrip("/") in {c.rstrip("/") for c in candidates}


def _is_registered() -> bool:
    """True when OpenCode's config lists our staged plugin directory."""
    cfg_file = _opencode_config_file()
    if not cfg_file.is_file():
        return False
    try:
        data, _ = _read_config_jsonc(cfg_file)
    except HTTPException:
        return False
    plugins = data.get("plugin")
    if not isinstance(plugins, list):
        return False
    return any(_spec_matches_staging(p) for p in plugins)


def _register_with_opencode() -> Path:
    """Append the staged plugin dir to OpenCode's ``plugin`` array.

    Idempotent: an existing entry for our staging dir is left as-is rather than
    duplicated, and every other plugin entry (and every unrelated config key) is
    preserved untouched. Returns the config file written."""
    cfg_file = _opencode_config_file()
    _backup_once(cfg_file)
    data, header = _read_config_jsonc(cfg_file)

    plugins = data.get("plugin")
    if not isinstance(plugins, list):
        plugins = []

    if not any(_spec_matches_staging(p) for p in plugins):
        plugins.append(str(STAGING_DIR))

    data["plugin"] = plugins
    _atomic_write_config(cfg_file, data, header)
    logger.info(
        "Registered OpenCode plugin %s → %s (config %s)",
        PLUGIN_NAME, STAGING_DIR, cfg_file,
    )
    return cfg_file


# --- Routes -----------------------------------------------------------------


@router.get("/status", response_model=StatusResponse)
async def plugin_status():
    """Whether the plugin is staged, whether OpenCode is installed, and whether
    it's registered in OpenCode's config. Read-only."""
    files_present = [f for f in PLUGIN_FILES if (STAGING_DIR / f).is_file()]
    registered = _is_registered()
    cfg_file = _opencode_config_file()
    return StatusResponse(
        installed=len(files_present) == len(PLUGIN_FILES),
        staging_dir=str(STAGING_DIR),
        files_present=files_present,
        opencode_detected=_opencode_detected(),
        # For OpenCode the staged dir IS the install, so "auto installed" means
        # staged AND registered.
        auto_installed=registered and len(files_present) == len(PLUGIN_FILES),
        enabled=registered,
        config_file=str(cfg_file),
    )


@router.post("/install", response_model=InstallResponse)
async def install_plugin():
    """Stage the plugin tree (URL-substituted), then — if OpenCode is detected —
    register the staged directory in OpenCode's config ``plugin`` array.
    Idempotent: reinstall rewrites the staged files (keeping hooks pointed at the
    current app URL) and leaves a single registry entry.

    Falls back to staging-only + the documented command when OpenCode isn't
    installed yet."""
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
        "Staged %d OpenCode plugin file(s) for %s at %s (sv_url=%s)",
        len(files_written), PLUGIN_NAME, STAGING_DIR, sv_url,
    )

    # Defense-in-depth: zero files means the bundled plugin assets are missing
    # from the installed package (wheel built without the plugin's non-Python
    # files — see setup.py:package_data + MANIFEST.in).
    if not files_written:
        raise HTTPException(
            status_code=500,
            detail=(
                f"OpenCode plugin staging produced 0 files from {BUNDLED_PLUGIN_DIR}. "
                "Bundled plugin assets are missing from the installed package — verify "
                "setup.py:package_data and MANIFEST.in include plugins/opencode/**/*."
            ),
        )

    if _opencode_detected():
        try:
            cfg_file = _register_with_opencode()
        except HTTPException:
            raise
        except Exception as e:  # surface, but don't lose the staged copy
            logger.exception("OpenCode registration failed; staged copy is intact")
            raise HTTPException(
                status_code=500,
                detail=(
                    f"Staged the plugin but failed to register it with OpenCode: {e}. "
                    f'You can register manually by adding "{STAGING_DIR}" to the '
                    f'"plugin" array in {_opencode_config_file()}.'
                ),
            )
        return InstallResponse(
            ok=True,
            staging_dir=str(STAGING_DIR),
            files=files_written,
            auto_installed=True,
            enabled=True,
            install_path=str(STAGING_DIR),
            config_file=str(cfg_file),
            commands=[],
            next_step=(
                "Installed and enabled. Start a new OpenCode session to load the "
                "plugin (OpenCode resolves plugins at launch)."
            ),
        )

    # Fallback: OpenCode not installed — hand the user the manual step.
    return InstallResponse(
        ok=True,
        staging_dir=str(STAGING_DIR),
        files=files_written,
        auto_installed=False,
        enabled=False,
        install_path=None,
        config_file=str(_opencode_config_file()),
        commands=[f'opencode plugin "{STAGING_DIR}"'],
        next_step=(
            "OpenCode was not detected. Once it's installed, run the command "
            "above (or add the staged path to the \"plugin\" array in "
            f"{_opencode_config_file()}), then start a new OpenCode session."
        ),
    )


@router.post("/uninstall", response_model=UninstallResponse)
async def uninstall_plugin():
    """Remove the plugin everywhere we wrote it: the staged tree and the
    registry entry in OpenCode's config. Idempotent — safe to call with nothing
    installed."""
    # 1. Deregister FIRST, while the staged path is still the thing config
    #    points at. (Order matters only for readability; both steps are safe.)
    cfg_file = _opencode_config_file()
    if cfg_file.is_file():
        _backup_once(cfg_file)
        try:
            data, header = _read_config_jsonc(cfg_file)
        except HTTPException:
            data, header = {}, []
        plugins = data.get("plugin")
        if isinstance(plugins, list):
            kept = [p for p in plugins if not _spec_matches_staging(p)]
            if len(kept) != len(plugins):
                data["plugin"] = kept
                try:
                    _atomic_write_config(cfg_file, data, header)
                    logger.info("Deregistered %s from %s", PLUGIN_NAME, cfg_file)
                except Exception as e:  # best-effort
                    logger.warning(
                        "Could not rewrite OpenCode config (continuing): %s", e
                    )

    # 2. Staged tree (the installed plugin itself).
    if STAGING_DIR.is_dir():
        shutil.rmtree(STAGING_DIR, ignore_errors=True)
        logger.info("Removed staged OpenCode plugin tree at %s", STAGING_DIR)

    return UninstallResponse(ok=True)


# --- Token usage (Cost Tracking) -------------------------------------------
#
# OpenCode keeps per-session state in a SQLite database at
# ``~/.local/share/opencode/opencode.db``. Its ``session`` table carries
# CUMULATIVE per-session counters — ``tokens_input`` / ``tokens_output`` /
# ``tokens_reasoning`` / ``tokens_cache_read`` / ``tokens_cache_write`` — plus
# the model as a JSON blob and ``time_updated`` as epoch milliseconds.
#
# Because the counters are cumulative per SESSION rather than per-turn deltas,
# a session's totals are attributed to the day of its LAST activity — the same
# approximation the Copilot CLI scanner makes, and close enough for the 7/30-day
# dashboard charts. Summing them as if they were deltas would inflate totals.
#
# The DB is opened READ-ONLY via a file: URI so a running OpenCode is never
# disturbed, and ``immutable=0`` keeps WAL reads correct.
#
# Reuses the Claude Code route's response models + ISO helpers so the Cost
# Tracking UI consumes an identical payload shape from every runtime.

from .hooks_claude_code import (  # noqa: E402  (route-module convention)
    DailyTokenUsage,
    ModelUsage,
    TokenUsageResponse,
)

OPENCODE_DB = _opencode_data_dir() / "opencode.db"


def _opencode_model_label(raw: str) -> str:
    """Turn OpenCode's model JSON blob into a display label.

    Stored as ``{"id":"qwen3:4b","providerID":"ollama","variant":"default"}``.
    Falls back to the raw string when it isn't JSON (older rows / future shape).
    """
    if not raw:
        return "unknown"
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return str(raw)
    if not isinstance(data, dict):
        return str(raw)
    model_id = data.get("id") or "unknown"
    provider = data.get("providerID")
    return f"{provider}/{model_id}" if provider else str(model_id)


def _compute_opencode_token_usage_sync() -> TokenUsageResponse:
    """Read per-session token counters out of OpenCode's SQLite store."""
    import sqlite3
    from collections import defaultdict
    from datetime import datetime, timedelta

    empty = TokenUsageResponse(
        sessions=0, turns_with_usage=0, input_tokens=0, output_tokens=0,
        cache_creation_input_tokens=0, cache_read_input_tokens=0,
        last_activity=None, by_model=[], daily=[],
    )
    if not OPENCODE_DB.is_file():
        return empty

    try:
        conn = sqlite3.connect(f"file:{OPENCODE_DB}?mode=ro", uri=True, timeout=2.0)
    except sqlite3.Error as e:
        logger.debug("Could not open OpenCode DB read-only: %s", e)
        return empty

    try:
        rows = list(conn.execute(
            "SELECT model, cost, tokens_input, tokens_output, tokens_reasoning, "
            "tokens_cache_read, tokens_cache_write, time_updated FROM session"
        ))
    except sqlite3.Error as e:
        # Schema drift in a future OpenCode must degrade to zeros, never 500.
        logger.debug("OpenCode DB schema not as expected (%s); reporting zeros", e)
        return empty
    finally:
        conn.close()

    sessions = 0
    tot_in = tot_out = tot_cache_read = tot_cache_write = 0
    last_ms = 0
    by_model: dict[str, dict] = defaultdict(
        lambda: {"turns": 0, "in": 0, "out": 0, "cw": 0, "cr": 0}
    )
    by_day: dict[str, dict] = defaultdict(
        lambda: {"turns": 0, "in": 0, "out": 0, "cw": 0, "cr": 0}
    )

    for model_raw, _cost, t_in, t_out, t_reason, t_cr, t_cw, t_upd in rows:
        t_in = int(t_in or 0)
        # Reasoning tokens are billed as output; fold them in so the number
        # matches what a provider console reports.
        t_out = int(t_out or 0) + int(t_reason or 0)
        t_cr = int(t_cr or 0)
        t_cw = int(t_cw or 0)
        if not (t_in or t_out or t_cr or t_cw):
            continue  # session that never ran a turn

        sessions += 1
        tot_in += t_in
        tot_out += t_out
        tot_cache_read += t_cr
        tot_cache_write += t_cw

        t_upd = int(t_upd or 0)
        last_ms = max(last_ms, t_upd)

        label = _opencode_model_label(model_raw)
        m = by_model[label]
        m["turns"] += 1
        m["in"] += t_in
        m["out"] += t_out
        m["cr"] += t_cr
        m["cw"] += t_cw

        if t_upd:
            # epoch ms -> local calendar day, matching the CC/Copilot scanners.
            day = datetime.fromtimestamp(t_upd / 1000.0).strftime("%Y-%m-%d")
            d = by_day[day]
            d["turns"] += 1
            d["in"] += t_in
            d["out"] += t_out
            d["cr"] += t_cr
            d["cw"] += t_cw

    if sessions == 0:
        return empty

    cutoff = (datetime.now() - timedelta(days=6)).strftime("%Y-%m-%d")
    daily = [
        DailyTokenUsage(
            day=day, turns=v["turns"], input_tokens=v["in"], output_tokens=v["out"],
            cache_creation_input_tokens=v["cw"], cache_read_input_tokens=v["cr"],
        )
        for day, v in sorted(by_day.items()) if day >= cutoff
    ]
    models = sorted(
        (
            ModelUsage(
                model=name, turns=v["turns"], input_tokens=v["in"], output_tokens=v["out"],
                cache_creation_input_tokens=v["cw"], cache_read_input_tokens=v["cr"],
            )
            for name, v in by_model.items()
        ),
        key=lambda m: m.input_tokens + m.output_tokens,
        reverse=True,
    )

    return TokenUsageResponse(
        sessions=sessions,
        turns_with_usage=sessions,  # one cumulative snapshot per session
        input_tokens=tot_in,
        output_tokens=tot_out,
        cache_creation_input_tokens=tot_cache_write,
        cache_read_input_tokens=tot_cache_read,
        last_activity=(
            datetime.fromtimestamp(last_ms / 1000.0).astimezone().isoformat()
            if last_ms else None
        ),
        by_model=models,
        daily=daily,
    )


# Same short-TTL memo as the CC / Copilot scanners — the dashboard re-requests
# on every navigation and the read is disk-bound.
_OPENCODE_TOKEN_USAGE_TTL_SECONDS = 60.0
_opencode_token_usage_cache: dict = {"ts": 0.0, "value": None}


@router.get("/token-usage", response_model=TokenUsageResponse)
async def get_opencode_token_usage() -> TokenUsageResponse:
    """Aggregate token usage across all OpenCode sessions.

    Reads the ``session`` table of ``~/.local/share/opencode/opencode.db``.
    Missing DB → zeros (fresh installs that haven't run an OpenCode session).
    """
    import asyncio
    import time

    now = time.monotonic()
    cached = _opencode_token_usage_cache
    if cached["value"] is not None and (now - cached["ts"]) < _OPENCODE_TOKEN_USAGE_TTL_SECONDS:
        return cached["value"]
    value = await asyncio.to_thread(_compute_opencode_token_usage_sync)
    cached["ts"] = time.monotonic()
    cached["value"] = value
    return value
