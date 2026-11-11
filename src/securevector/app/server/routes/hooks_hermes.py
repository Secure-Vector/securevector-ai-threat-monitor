"""
Hermes (NousResearch ``hermes-agent``) token-usage API endpoint.

Parallel to the ``hooks_claude_code.py`` / ``hooks_codex.py`` /
``hooks_copilot_cli.py`` token-usage scanners, but for a FRAMEWORK-shape
runtime: Hermes is governed by the ``securevector-sdk-hermes`` package. The
install/uninstall/status endpoints at the end of this module manage the
separate cost-tracking directory plugin (``plugins/hermes``), which Hermes
loads from ``$HERMES_HOME/plugins/securevector``.

GET /api/hooks/hermes/token-usage - Aggregate token usage across Hermes sessions
GET  /api/hooks/hermes/status    - Whether the cost plugin is copied and enabled
POST /api/hooks/hermes/install   - Copy the plugin and enable it in config.yaml
POST /api/hooks/hermes/uninstall - Remove the plugin folder and its enable entry

Data source: Hermes stores session state in a SQLite DB (not JSONL) —
``$HERMES_HOME/state.db`` (default ``~/.hermes/state.db``), table
``sessions`` with cumulative per-session counters:
``input_tokens`` / ``output_tokens`` / ``cache_read_tokens`` /
``cache_write_tokens``, ``message_count``, ``model``, ``started_at`` /
``ended_at`` (epoch seconds). This is the same store Hermes's own
``/insights`` command reads. Schema verified against hermes-agent 0.18.0
(``hermes_state.py``). The DB is opened read-only over a URI so a live
Hermes session's WAL lock is never disturbed.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter

from .hooks_claude_code import (
    DailyTokenUsage,
    ModelUsage,
    TokenUsageResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hooks/hermes", tags=["Hooks"])


def _hermes_state_db() -> Path:
    """Resolve Hermes's state DB, honoring the HERMES_HOME override."""
    return _hermes_home() / "state.db"


def _epoch_to_iso(epoch: float | None) -> str | None:
    if not epoch:
        return None
    try:
        return datetime.fromtimestamp(float(epoch)).astimezone().isoformat()
    except (ValueError, OSError, OverflowError):
        return None


def _epoch_to_local_day(epoch: float | None) -> str | None:
    if not epoch:
        return None
    try:
        return datetime.fromtimestamp(float(epoch)).astimezone().strftime("%Y-%m-%d")
    except (ValueError, OSError, OverflowError):
        return None


def _compute_hermes_token_usage_sync() -> TokenUsageResponse:
    """Blocking aggregation over the Hermes sessions table."""
    empty = TokenUsageResponse(
        sessions=0, turns_with_usage=0,
        input_tokens=0, output_tokens=0,
        cache_creation_input_tokens=0, cache_read_input_tokens=0,
        last_activity=None, by_model=[], daily=[],
    )
    db_path = _hermes_state_db()
    if not db_path.is_file():
        return empty

    rows: list[tuple] = []
    try:
        # mode=ro: never create, never write — a live `hermes` process owns
        # the WAL; read-only access can't corrupt or block it. Build the URI
        # via Path.as_uri() so a home dir containing % / ? / # is escaped
        # correctly rather than mis-parsed as URI syntax.
        conn = sqlite3.connect(f"{db_path.as_uri()}?mode=ro", uri=True, timeout=2.0)
        try:
            rows = conn.execute(
                """
                SELECT model, message_count,
                       input_tokens, output_tokens,
                       cache_write_tokens, cache_read_tokens,
                       COALESCE(ended_at, started_at) AS last_ts
                FROM sessions
                WHERE COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) > 0
                """
            ).fetchall()
        finally:
            conn.close()
    except sqlite3.Error as exc:
        # Locked / mid-migration / foreign schema — zeros beat a 500.
        logger.debug("hermes state.db read failed: %s", exc)
        return empty

    sessions = 0
    total_turns = 0
    total = {"input": 0, "output": 0, "cache_create": 0, "cache_read": 0}
    latest_epoch: float | None = None
    model_totals: dict = {}
    day_totals: dict = {}

    for model, msg_count, inp, out, cache_w, cache_r, last_ts in rows:
        sessions += 1
        turns = int(msg_count or 0)
        total_turns += turns
        usage = {
            "input": int(inp or 0),
            "output": int(out or 0),
            "cache_create": int(cache_w or 0),
            "cache_read": int(cache_r or 0),
        }
        if last_ts and (latest_epoch is None or float(last_ts) > latest_epoch):
            latest_epoch = float(last_ts)

        agg = model_totals.setdefault(model or "unknown", {
            "turns": 0, "input": 0, "output": 0,
            "cache_create": 0, "cache_read": 0,
        })
        agg["turns"] += turns
        for k in ("input", "output", "cache_create", "cache_read"):
            agg[k] += usage[k]
            total[k] += usage[k]

        day = _epoch_to_local_day(last_ts)
        if day is not None:
            du = day_totals.setdefault(day, {
                "turns": 0, "input": 0, "output": 0,
                "cache_create": 0, "cache_read": 0,
            })
            du["turns"] += turns
            for k in ("input", "output", "cache_create", "cache_read"):
                du[k] += usage[k]

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
        last_activity=_epoch_to_iso(latest_epoch),
        by_model=by_model,
        daily=daily,
    )


# Same short-TTL memo as the CC / Copilot scanners — the dashboard re-requests
# on every navigation and the query is disk-bound.
_HERMES_TOKEN_USAGE_TTL_SECONDS = 60.0
_hermes_token_usage_cache: dict = {"ts": 0.0, "value": None}


@router.get("/token-usage", response_model=TokenUsageResponse)
async def get_hermes_token_usage() -> TokenUsageResponse:
    """Aggregate token usage across all Hermes sessions.

    Reads ``$HERMES_HOME/state.db`` (default ``~/.hermes/state.db``) —
    the SQLite store behind Hermes's own ``/insights``. Missing DB →
    zeros (fresh installs that haven't run a Hermes session).
    """
    now = time.monotonic()
    cached = _hermes_token_usage_cache
    if cached["value"] is not None and (now - cached["ts"]) < _HERMES_TOKEN_USAGE_TTL_SECONDS:
        return cached["value"]
    value = await asyncio.to_thread(_compute_hermes_token_usage_sync)
    cached["ts"] = time.monotonic()
    cached["value"] = value
    return value


# --- Cost plugin install (directory plugin) ---------------------------------
#
# Hermes 0.18 (``hermes_cli/plugins.py``) loads a user plugin from
# ``$HERMES_HOME/plugins/<name>/`` when it has a ``plugin.yaml`` manifest and
# an ``__init__.py`` with ``register(ctx)``, and only when its name appears in
# the ``plugins.enabled`` list of ``$HERMES_HOME/config.yaml`` (a name in
# ``plugins.disabled`` never loads). ``hermes plugins enable`` edits the same
# list, rewriting the whole file; this installer instead edits only the lines
# it needs, so the user's comments and layout survive.

import re  # noqa: E402  (route-module convention)
import shutil  # noqa: E402
from typing import Optional  # noqa: E402

from fastapi import Depends, HTTPException  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from . import _hooks_common  # noqa: E402
from ._plugin_guard import require_local_origin  # noqa: E402

PLUGIN_NAME = "securevector"
PLUGIN_FILES = ["plugin.yaml", "__init__.py", "cost.py", "audit.py", "README.md"]
# Bundled plugin source: src/securevector/app/server/routes/<this> -> up 4 -> securevector/
BUNDLED_PLUGIN_DIR = Path(__file__).parent.parent.parent.parent / "plugins" / "hermes"


def _hermes_home() -> Path:
    """The Hermes home as Hermes resolves it (``get_hermes_home`` in
    hermes_constants.py): a non-empty ``HERMES_HOME``, else the platform
    default."""
    home = (os.environ.get("HERMES_HOME") or "").strip()
    if home:
        return Path(home).expanduser()
    if sys.platform == "win32":
        local = (os.environ.get("LOCALAPPDATA") or "").strip()
        return (Path(local) if local else Path.home() / "AppData" / "Local") / "hermes"
    return Path.home() / ".hermes"


def _plugin_dir() -> Path:
    return _hermes_home() / "plugins" / PLUGIN_NAME


def _config_file() -> Path:
    return _hermes_home() / "config.yaml"


def _hermes_detected() -> bool:
    return bool(shutil.which("hermes")) or _hermes_home().is_dir()


def _allowed_roots() -> list[Path]:
    """The Hermes home that Hermes itself uses (``$HERMES_HOME`` or the
    default). A symlinked Hermes home is refused: it could point anywhere."""
    # Any HERMES_HOME is accepted on purpose (for example a path under /opt):
    # the environment the app runs in is trusted, as Hermes trusts it. The
    # symlinked-root refusal below still applies.
    root = _hermes_home()
    if root.is_symlink():
        raise HTTPException(status_code=400, detail=f"Refusing a symlinked Hermes home at {root}")
    return [root.resolve(strict=False)]


def _check_target(path: Path) -> None:
    """Refuse a symlinked target, or one that resolves outside the Hermes home."""
    if path.is_symlink():
        raise HTTPException(status_code=400, detail=f"Refusing to write through a symlink at {path}")
    resolved = path.resolve(strict=False)
    if not any(resolved.is_relative_to(root) for root in _allowed_roots()):
        raise HTTPException(
            status_code=400,
            detail=f"Refusing to write outside the Hermes home ({_hermes_home()}): resolved {resolved} (was {path})",
        )


def _backup_once(path: Path) -> None:
    """One-shot copy to ``config.yaml.before-securevector`` before the first
    change. Never overwrites an existing backup. Best effort."""
    if not path.is_file():
        return
    backup = path.with_suffix(path.suffix + ".before-securevector")
    if backup.is_symlink() or backup.exists():
        return
    try:
        shutil.copy2(path, backup)
    except OSError as e:
        logger.warning("Could not write backup at %s (continuing): %s", backup, e)


# --- Minimal YAML list edits ------------------------------------------------
#
# Only ``plugins.enabled`` / ``plugins.disabled`` are touched. Every other
# line is left byte-for-byte. Each edit is checked by parsing the file before
# and after: if anything other than the target list changed, nothing is written.


class _YamlEditError(Exception):
    pass


_TOP_PLUGINS = re.compile(r"^plugins\s*:\s*(.*)$")
_ITEM = re.compile(r"^(\s*)-\s*(.*?)\s*(#.*)?$")


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    return value


def _strip_comment(rest: str) -> tuple[str, str]:
    """Split ``value  # comment`` (a ``#`` after whitespace starts a comment)."""
    m = re.search(r"(^|\s)#", rest)
    if not m:
        return rest.strip(), ""
    return rest[: m.start()].strip(), rest[m.start():].rstrip()


def _plugins_block(lines: list[str]) -> Optional[tuple[int, int]]:
    """(index of the ``plugins:`` line, end index exclusive) or None."""
    for i, line in enumerate(lines):
        if _TOP_PLUGINS.match(line):
            end = i + 1
            while end < len(lines):
                nxt = lines[end]
                if nxt.strip() and not nxt[0].isspace() and not nxt.lstrip().startswith("#"):
                    break
                end += 1
            return i, end
    return None


def _flow_items(value: str) -> Optional[list[str]]:
    if not (value.startswith("[") and value.endswith("]")):
        return None
    inner = value[1:-1].strip()
    return [_unquote(v) for v in inner.split(",") if v.strip()] if inner else []


def _edit_list(text: str, key: str, name: str, add: bool) -> str:
    """Add ``name`` to, or remove it from, ``plugins.<key>``."""
    nl = "\r\n" if "\r\n" in text else "\n"
    lines = text.splitlines()
    block = _plugins_block(lines)

    if block is None:
        if not add:
            return text
        prefix = text if (not text or text.endswith(("\n", "\r"))) else text + nl
        return prefix + nl.join(["plugins:", f"  {key}:", f"    - {name}"]) + nl

    start, end = block
    head_value, head_comment = _strip_comment(_TOP_PLUGINS.match(lines[start]).group(1))
    if head_value in ("{}", "null", "~"):
        if not add:
            return text
        lines[start] = "plugins:" + (" " + head_comment if head_comment else "")
        lines[start + 1:start + 1] = [f"  {key}:", f"    - {name}"]
        return nl.join(lines) + nl
    if head_value:
        raise _YamlEditError("plugins is written inline")

    children = [j for j in range(start + 1, end)
                if lines[j].strip() and not lines[j].lstrip().startswith("#")]
    indent = re.match(r"^(\s*)", lines[children[0]]).group(1) if children else "  "
    key_re = re.compile(rf"^{re.escape(indent)}{re.escape(key)}\s*:\s*(.*)$")
    key_idx = next((j for j in children if key_re.match(lines[j])), None)

    if key_idx is None:
        if not add:
            return text
        lines[start + 1:start + 1] = [f"{indent}{key}:", f"{indent}  - {name}"]
        return nl.join(lines) + nl

    value, comment = _strip_comment(key_re.match(lines[key_idx]).group(1))
    tail = (" " + comment) if comment else ""
    if value:
        items = _flow_items(value)
        if items is None:
            if value not in ("null", "~") or not add:
                raise _YamlEditError(f"plugins.{key} is not a list")
            items = []
        if add and name not in items:
            items.append(name)
        elif not add:
            items = [v for v in items if v != name]
        else:
            return text
        lines[key_idx] = f"{indent}{key}: [{', '.join(items)}]{tail}"
        return nl.join(lines) + nl

    # Block list: items follow at the key's indent or deeper.
    item_idx = []
    j = key_idx + 1
    while j < end:
        line = lines[j]
        if not line.strip() or line.lstrip().startswith("#"):
            j += 1
            continue
        m = _ITEM.match(line)
        if not m or len(m.group(1)) < len(indent):
            break
        item_idx.append(j)
        j += 1
    names = [_unquote(_ITEM.match(lines[k]).group(2)) for k in item_idx]
    if add:
        if name in names:
            return text
        item_indent = _ITEM.match(lines[item_idx[0]]).group(1) if item_idx else indent + "  "
        insert_at = (item_idx[-1] + 1) if item_idx else key_idx + 1
        lines.insert(insert_at, f"{item_indent}- {name}")
        return nl.join(lines) + nl
    drop = [k for k, n in zip(item_idx, names) if n == name]
    if not drop:
        return text
    for k in reversed(drop):
        del lines[k]
    if len(drop) == len(item_idx):
        lines[key_idx] = f"{indent}{key}: []{tail}"
    return nl.join(lines) + nl


def _load_yaml(text: str):
    import yaml

    return yaml.safe_load(text) if text.strip() else {}


def _plugin_list(data, key: str) -> list:
    plugins = data.get("plugins") if isinstance(data, dict) else None
    value = plugins.get(key) if isinstance(plugins, dict) else None
    return value if isinstance(value, list) else []


def _verified_edit(text: str, key: str, name: str, add: bool) -> str:
    """``_edit_list`` plus a parse check that only ``plugins.<key>`` changed."""
    new = _edit_list(text, key, name, add)
    if new == text:
        return text
    try:
        before, after = _load_yaml(text) or {}, _load_yaml(new) or {}
    except Exception as e:
        raise _YamlEditError(f"config.yaml did not parse: {e}")
    if not isinstance(before, dict) or not isinstance(after, dict):
        raise _YamlEditError("config.yaml is not a mapping")
    want = [v for v in _plugin_list(before, key) if v != name] + ([name] if add else [])
    got = _plugin_list(after, key)
    if sorted(map(str, got)) != sorted(map(str, want)):
        raise _YamlEditError(f"plugins.{key} did not come out as expected")

    def _rest(d):
        out = dict(d)
        plugins = dict(out.pop("plugins", None) or {})
        plugins.pop(key, None)
        return out, plugins

    if _rest(before) != _rest(after):
        raise _YamlEditError("an unrelated setting would have changed")
    return new


def _read_config_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8") if path.is_file() else ""
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Could not read {path}: {e}")


def _enable_state() -> tuple[bool, bool]:
    """(listed in plugins.enabled, listed in plugins.disabled). Read-only."""
    try:
        data = _load_yaml(_read_config_text(_config_file())) or {}
    except Exception:
        return False, False
    return PLUGIN_NAME in _plugin_list(data, "enabled"), PLUGIN_NAME in _plugin_list(data, "disabled")


def _write_config_edits(edits: list[tuple[str, bool]]) -> Path:
    cfg = _config_file()
    _check_target(cfg)
    text = _read_config_text(cfg)
    new = text
    try:
        for key, add in edits:
            new = _verified_edit(new, key, PLUGIN_NAME, add)
    except _YamlEditError as e:
        raise HTTPException(
            status_code=409,
            detail=f"Could not edit {cfg} safely ({e}). Run: hermes plugins enable {PLUGIN_NAME}",
        )
    if new != text:
        _backup_once(cfg)
        _check_target(cfg)
        cfg.parent.mkdir(parents=True, exist_ok=True)
        # A new config file is private to the user, as before.
        _hooks_common._atomic_write(cfg, new.encode("utf-8"), new_mode=0o600)
    return cfg


class HermesStatusResponse(BaseModel):
    installed: bool
    enabled: bool = False
    auto_installed: bool = False
    disabled_in_config: bool = False
    hermes_detected: bool = False
    install_path: str
    config_file: str
    files_present: list[str]
    # Update awareness: whether the staged files match this app's bundle.
    files_current: bool = False
    update_available: bool = False
    installed_version: Optional[str] = None
    bundled_version: Optional[str] = None


class HermesInstallResponse(BaseModel):
    ok: bool
    files: list[str] = []
    auto_installed: bool = False
    enabled: bool = False
    install_path: Optional[str] = None
    config_file: Optional[str] = None
    commands: list[str] = []
    next_step: Optional[str] = None


class HermesUninstallResponse(BaseModel):
    ok: bool


def _update_state() -> dict:
    """Update fields for /status: the plugin folder compared
    with the bundle, using the installer's URL."""
    sv_url = _hooks_common.resolve_sv_url()
    manifest = "plugin.yaml"

    def _installed_version():
        for root in (_plugin_dir(),):
            if root is not None and (root / manifest).is_file():
                return _hooks_common.read_manifest_version(root / manifest)
        return None

    return _hooks_common.update_state(
        staging_dir=_plugin_dir(),
        source_dir=BUNDLED_PLUGIN_DIR,
        files=PLUGIN_FILES,
        substitutions={"http://127.0.0.1:8741": sv_url, "http://localhost:8741": sv_url},
        bundled_version=_hooks_common.read_manifest_version(BUNDLED_PLUGIN_DIR / manifest),
        installed_version_reader=_installed_version,
        copies=(),
        # Installed means the folder is complete and Hermes has it enabled.
        installed=all((_plugin_dir() / f).is_file() for f in PLUGIN_FILES) and _enable_state() == (True, False),
    )


@router.get("/status", response_model=HermesStatusResponse)
async def plugin_status():
    """Whether the cost plugin is copied into Hermes and enabled. Read-only."""
    target = _plugin_dir()
    files_present = [f for f in PLUGIN_FILES if (target / f).is_file()]
    installed = len(files_present) == len(PLUGIN_FILES)
    listed, disabled = _enable_state()
    enabled = listed and not disabled
    return HermesStatusResponse(
        installed=installed,
        enabled=enabled,
        auto_installed=installed and enabled,
        disabled_in_config=disabled,
        hermes_detected=_hermes_detected(),
        install_path=str(target),
        config_file=str(_config_file()),
        files_present=files_present,
        **_hooks_common.status_fields(_update_state()),
    )


@router.post("/install", response_model=HermesInstallResponse, dependencies=[Depends(require_local_origin)])
async def install_plugin():
    """Copy the plugin to ``$HERMES_HOME/plugins/securevector`` and add it to
    ``plugins.enabled`` (removing it from ``plugins.disabled``). Idempotent."""
    if not _hermes_detected():
        return HermesInstallResponse(
            ok=False,
            commands=["pip install hermes-agent"],
            next_step="Hermes was not found. Install it, then install the plugin.",
        )
    target = _plugin_dir()
    for path in (target.parent, target, _config_file()):
        _check_target(path)
    if target.is_dir() and not _folder_is_ours(target):
        raise HTTPException(status_code=409, detail=f"{target} is not the SecureVector plugin; left in place")
    _hooks_common.ensure_bundled_dir(BUNDLED_PLUGIN_DIR, PLUGIN_FILES)
    sv_url = _hooks_common.resolve_sv_url()
    files = _hooks_common.stage_files(
        staging_dir=target,
        source_dir=BUNDLED_PLUGIN_DIR,
        files=PLUGIN_FILES,
        substitutions={"http://127.0.0.1:8741": sv_url, "http://localhost:8741": sv_url},
    )
    if len(files) != len(PLUGIN_FILES):
        raise HTTPException(
            status_code=500,
            detail=(
                f"Hermes plugin files are missing from {BUNDLED_PLUGIN_DIR}, or a file in "
                f"{target} is a symlink. Verify setup.py:package_data and MANIFEST.in "
                "include plugins/hermes."
            ),
        )
    cfg = _write_config_edits([("enabled", True), ("disabled", False)])
    logger.info("Installed Hermes cost plugin at %s (config %s)", target, cfg)
    return HermesInstallResponse(
        ok=True,
        files=files,
        auto_installed=True,
        enabled=True,
        install_path=str(target),
        config_file=str(cfg),
        next_step="Start a new Hermes session to load it.",
    )


@router.post("/uninstall", response_model=HermesUninstallResponse, dependencies=[Depends(require_local_origin)])
async def uninstall_plugin():
    return await _uninstall_plugin()


def _folder_is_ours(target: Path) -> bool:
    """Our plugin folder: its plugin.yaml names us, or it holds only files
    from PLUGIN_FILES (a partial install)."""
    manifest = target / "plugin.yaml"
    try:
        if _load_yaml(manifest.read_text(encoding="utf-8")).get("name") == PLUGIN_NAME:
            return True
    except Exception:
        pass  # unreadable manifest: fall through to the file check
    if manifest.exists() or manifest.is_symlink():
        return False
    try:
        entries = list(target.iterdir())
    except OSError:
        return False
    return all(e.name in PLUGIN_FILES and not e.is_symlink() and e.is_file() for e in entries)


async def _uninstall_plugin():
    """Remove our enable entry and our plugin folder, nothing else. Idempotent.
    Ownership of the folder is checked first, so a foreign plugin named like
    ours keeps both its folder and its enable entry."""
    target = _plugin_dir()
    if target.is_symlink():
        raise HTTPException(status_code=400, detail=f"Refusing to remove a symlink at {target}")
    remove_dir = False
    if target.is_dir():
        _check_target(target)
        if not _folder_is_ours(target):
            raise HTTPException(status_code=409, detail=f"{target} is not the SecureVector plugin; left in place")
        remove_dir = True
    cfg = _config_file()
    if cfg.is_file():
        _write_config_edits([("enabled", False)])
    if remove_dir:
        shutil.rmtree(target)
        logger.info("Removed Hermes cost plugin at %s", target)
    return HermesUninstallResponse(ok=True)
