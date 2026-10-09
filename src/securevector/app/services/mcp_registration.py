"""
User-scope registration of the SecureVector MCP server in each harness.

The Guard installers call `register(harness)` after staging the plugin and
`unregister(harness)` on uninstall. The entry runs
`<this python> -m securevector.mcp --tools check_policy,session_burn` with
`SECUREVECTOR_APP_URL` pointing at this app. Agent Config Trust treats a
server named `securevector` as the app's own entry (its OWN_MARKER), so
writing it is not reported as a setup change.

Only an entry this module wrote is ever changed or removed: it carries the
`--tools` argument and the `SECUREVECTOR_MCP_HARNESS` variable. A
`securevector` entry without them is left exactly as it is. The first edit
of each file keeps one `<file>.securevector.bak` copy.

Nothing is registered where the server cannot start: the desktop build (no
`-m` entry point) or an install without the `mcp` extra.

Every step is best effort and never raises into the installer: a harness
that is not installed (its config folder is absent), a config file that does
not parse, or a symlinked config file is left untouched.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Dict, Optional

logger = logging.getLogger(__name__)

SERVER_NAME = "securevector"
TOOLS = "check_policy,session_burn"
HARNESSES = ("claude-code", "codex", "copilot-cli", "cursor", "opencode", "antigravity")
MARKER_ENV = "SECUREVECTOR_MCP_HARNESS"
BACKUP_SUFFIX = ".securevector.bak"

REGISTERED = "registered"
NOT_REGISTERED = "not_registered"
UNAVAILABLE = "unavailable"
OTHER_ENTRY = "other_entry"
STATUS_TEXT = {
    REGISTERED: "MCP tools: registered",
    NOT_REGISTERED: "MCP tools: not registered",
    UNAVAILABLE: "MCP tools: not available, install securevector-ai-monitor[mcp]",
    OTHER_ENTRY: "MCP tools: an existing securevector entry was left unchanged",
}

_CODEX_TABLE_RE = re.compile(r"^\s*\[\s*mcp_servers\s*\.\s*(?:\"securevector\"|securevector)\s*(?:\.[^\]]*)?\]\s*$")
_TOML_HEADER_RE = re.compile(r"^\s*\[")
_available: Optional[bool] = None


def available() -> bool:
    """True when `python -m securevector.mcp` can start from this install:
    not the frozen desktop build, and the MCP server package is present."""
    global _available
    if getattr(sys, "frozen", False):
        return False
    if _available is None:
        try:
            _available = (importlib.util.find_spec("mcp") is not None
                          and importlib.util.find_spec("mcp.server.fastmcp") is not None)
        except (ImportError, ValueError):
            _available = False
    return _available


def _home() -> Path:
    return Path(os.path.expanduser("~"))


def _env_dir(var: str, default: Path) -> Path:
    v = os.environ.get(var)
    return Path(v).expanduser() if v else default


def _app_url() -> str:
    try:
        from securevector.app.server.routes import _hooks_common

        return _hooks_common.resolve_sv_url()
    except Exception:  # noqa: BLE001
        return "http://127.0.0.1:8741"


def _args() -> list:
    return ["-m", "securevector.mcp", "--tools", TOOLS]


def _env(harness: str) -> dict:
    return {
        "SECUREVECTOR_APP_URL": _app_url(),
        MARKER_ENV: harness,
        # Absolute, so the server's audit log never lands in the harness's
        # working folder.
        "SECUREVECTOR_AUDIT_LOG": str(_home() / ".securevector" / "logs" / "mcp-audit.log"),
    }


def config_path(harness: str) -> Optional[Path]:
    """The user-scope MCP config file for a harness."""
    h = _home()
    if harness == "claude-code":
        return h / ".claude.json"
    if harness == "codex":
        return _env_dir("CODEX_HOME", h / ".codex") / "config.toml"
    if harness == "copilot-cli":
        return _env_dir("COPILOT_HOME", h / ".copilot") / "mcp-config.json"
    if harness == "cursor":
        return _env_dir("CURSOR_HOME", h / ".cursor") / "mcp.json"
    if harness == "opencode":
        if os.environ.get("OPENCODE_CONFIG"):
            return Path(os.environ["OPENCODE_CONFIG"]).expanduser()
        xdg = os.environ.get("XDG_CONFIG_HOME")
        return (Path(xdg).expanduser() if xdg else h / ".config") / "opencode" / "opencode.json"
    if harness == "antigravity":
        return _env_dir("GEMINI_HOME", h / ".gemini") / "antigravity" / "mcp_config.json"
    return None


def _installed(harness: str, path: Path) -> bool:
    """Write only where the harness already keeps its config."""
    if harness == "claude-code":
        return path.is_file() or _env_dir("CLAUDE_HOME", _home() / ".claude").is_dir()
    return path.parent.is_dir()


def _backup_once(path: Path) -> None:
    bak = path.with_name(path.name + BACKUP_SUFFIX)
    if path.is_file() and not bak.exists():
        shutil.copy2(path, bak)


def _atomic_write(path: Path, text: str) -> None:
    if path.is_symlink():
        raise PermissionError("refusing to write through a symlink")
    _backup_once(path)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix="." + path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        if path.exists():
            os.chmod(tmp, path.stat().st_mode & 0o777)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_json(path: Path) -> tuple:
    """(data, raw text). data is None when the file does not parse."""
    if not path.exists():
        return {}, ""
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw or "{}")
    except (OSError, ValueError):
        return None, ""
    return (data if isinstance(data, dict) else None), raw


def _indent_of(raw: str):
    """The file's own indent, so a rewrite does not reformat it."""
    body = raw.strip()
    if body and "\n" not in body:
        return None
    m = re.search(r"\n([ \t]+)\S", raw)
    return m.group(1) if m else 2


def _json_entry(harness: str) -> dict:
    if harness == "opencode":
        return {"type": "local", "command": [sys.executable, *_args()], "environment": _env(harness),
                "enabled": True}
    entry = {"command": sys.executable, "args": _args(), "env": _env(harness)}
    if harness == "claude-code":
        entry = {"type": "stdio", **entry}
    if harness == "copilot-cli":
        entry = {"type": "local", **entry, "tools": ["*"]}
    return entry


def _json_key(harness: str) -> str:
    return "mcp" if harness == "opencode" else "mcpServers"


def is_ours(entry) -> bool:
    """An entry this module wrote: the --tools argument and the marker
    variable."""
    if not isinstance(entry, dict):
        return False
    argv = entry.get("args") or []
    if isinstance(entry.get("command"), list):
        argv = list(entry["command"]) + list(argv if isinstance(argv, list) else [])
    env = entry.get("env") or entry.get("environment") or {}
    return isinstance(argv, list) and "--tools" in argv and isinstance(env, dict) and MARKER_ENV in env


def _edit_json(harness: str, path: Path, add: bool) -> Optional[str]:
    data, raw = _read_json(path)
    if data is None:
        return None
    key = _json_key(harness)
    servers = data.get(key)
    if servers is not None and not isinstance(servers, dict):
        return None
    current = (servers or {}).get(SERVER_NAME)
    if current is not None and not is_ours(current):
        return OTHER_ENTRY
    if add:
        if current == _json_entry(harness):
            return REGISTERED
        servers = dict(servers or {})
        servers[SERVER_NAME] = _json_entry(harness)
        data[key] = servers
    else:
        if current is None:
            return NOT_REGISTERED
        servers = dict(servers)
        servers.pop(SERVER_NAME, None)
        data[key] = servers
    text = json.dumps(data, indent=_indent_of(raw) if raw else 2, ensure_ascii=False)
    if not raw or raw.endswith("\n"):
        text += "\n"
    _atomic_write(path, text)
    return REGISTERED if add else NOT_REGISTERED


def _codex_blocks(text: str) -> tuple:
    """(text without the securevector tables, those tables' text)."""
    out, ours, skipping = [], [], False
    for line in text.splitlines(keepends=True):
        if _CODEX_TABLE_RE.match(line):
            skipping = True
            ours.append(line)
            continue
        if skipping and _TOML_HEADER_RE.match(line):
            skipping = False
        (ours if skipping else out).append(line)
    return "".join(out), "".join(ours)


def _codex_block() -> str:
    q = json.dumps
    env = _env("codex")
    return (
        f"\n[mcp_servers.{SERVER_NAME}]\n"
        f"command = {q(sys.executable)}\n"
        f"args = [{', '.join(q(a) for a in _args())}]\n"
        f"\n[mcp_servers.{SERVER_NAME}.env]\n"
        + "".join(f"{k} = {q(v)}\n" for k, v in env.items())
    )


def _codex_block_is_ours(block: str) -> bool:
    return '"--tools"' in block and MARKER_ENV in block


def _toml_parses(text: str) -> bool:
    """Parse check before writing. tomllib on 3.11+, tomli when installed;
    on 3.10 without tomli the check is skipped (the block written is fixed
    text with JSON-quoted strings, which is valid TOML)."""
    try:
        import tomllib as toml_reader
    except ImportError:
        try:
            import tomli as toml_reader  # type: ignore[no-redef]
        except ImportError:
            return True
    try:
        toml_reader.loads(text)
        return True
    except Exception:  # noqa: BLE001
        return False


def _edit_codex(path: Path, add: bool) -> Optional[str]:
    try:
        text = path.read_text(encoding="utf-8") if path.exists() else ""
    except OSError:
        return None
    stripped, block = _codex_blocks(text)
    if block and not _codex_block_is_ours(block):
        return OTHER_ENTRY
    if add:
        new = (stripped.rstrip("\n") + "\n" + _codex_block()) if stripped.strip() else _codex_block().lstrip("\n")
    else:
        if not block:
            return NOT_REGISTERED
        new = stripped
    if not _toml_parses(new):
        return None
    if new != text:
        _atomic_write(path, new)
    return REGISTERED if add else NOT_REGISTERED


def state(harness: str) -> str:
    """registered, not_registered, unavailable or other_entry."""
    path = config_path(harness)
    current = None
    if path is not None and path.is_file():
        if harness == "codex":
            try:
                _, block = _codex_blocks(path.read_text(encoding="utf-8"))
            except OSError:
                block = ""
            if block:
                return REGISTERED if _codex_block_is_ours(block) else OTHER_ENTRY
        else:
            data, _ = _read_json(path)
            servers = (data or {}).get(_json_key(harness))
            current = servers.get(SERVER_NAME) if isinstance(servers, dict) else None
            if current is not None:
                return REGISTERED if is_ours(current) else OTHER_ENTRY
    return NOT_REGISTERED if available() else UNAVAILABLE


def _apply(harness: str, add: bool) -> Optional[str]:
    path = config_path(harness)
    if path is None or not _installed(harness, path):
        return None
    try:
        if harness == "codex":
            return _edit_codex(path, add)
        return _edit_json(harness, path, add)
    except Exception as e:  # noqa: BLE001 - registration never breaks an install
        logger.warning("MCP registration for %s skipped: %s", harness, type(e).__name__)
        return None


def register(harness: str) -> bool:
    """Write our entry. False when the server cannot start here, the
    harness is not installed, or another securevector entry is present."""
    if not available():
        return False
    return _apply(harness, True) == REGISTERED


def unregister(harness: str) -> bool:
    """Remove our entry only. True when no entry of ours remains."""
    return _apply(harness, False) == NOT_REGISTERED


def is_registered(harness: str) -> bool:
    return state(harness) == REGISTERED


def status(harnesses=None) -> Dict[str, dict]:
    out = {}
    for h in harnesses or HARNESSES:
        if h in HARNESSES:
            s = state(h)
            out[h] = {"state": s, "text": STATUS_TEXT[s]}
    return out
