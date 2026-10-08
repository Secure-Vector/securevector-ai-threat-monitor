"""Agent Config Trust: the read-only scanner.

Finds each harness's setup files (user scope under the home folder, project
scope under a workspace), parses them by type and reduces them to a canonical
form so formatting never alerts: comments stripped, keys sorted, whitespace
dropped, env and header *values* replaced by their key names, volatile fields
and SecureVector's own Guard entries left out. One SHA-256 per surface, one
setup hash per harness and scope.

This module READS ONLY. It opens files and parses JSON, JSONC, TOML and
Markdown text. It never starts, imports or evaluates anything it finds: no
process, no dynamic import, no network, no database. Paths stay inside the
process; what leaves this module for storage or display is a relative hint
("~/.claude/settings.json", ".mcp.json"), hashes, key names and counts.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover - 3.10
    try:
        import tomli as tomllib  # type: ignore
    except ModuleNotFoundError:
        tomllib = None  # type: ignore

NORMALISER_VERSION = 1

SURFACE_TYPES = ("hooks", "mcp", "permissions", "plugins", "rules", "other")
# A change to one of these is red; rules and other are amber.
RED_TYPES = frozenset({"hooks", "mcp", "permissions", "plugins"})

MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_DIR_FILES = 500
MAX_HASH_BYTES = 4 * 1024 * 1024
MAX_DESCRIPTION_CHARS = 4000
# Deeper than this is not a config anyone writes by hand; refuse to parse it.
MAX_NESTING = 64
# Bounded walk for the recursive folder signature used by the recheck.
MAX_SIG_ENTRIES = 4 * MAX_DIR_FILES
TREE_SIG_PREFIX = "tree::"
OWN_MARKER = "securevector"

# Fields that move on their own and say nothing about trust.
VOLATILE_KEYS = frozenset({
    "installedAt", "lastUpdated", "last_updated", "updatedAt", "lastUsed",
    "last_used", "gitCommitSha", "numStartups", "firstStartTime",
    "lastSessionId", "lastCost", "lastDuration", "tipsHistory",
})
# Maps whose values are secrets or machine-specific: only the key names count.
VALUE_REDACTED_KEYS = frozenset({
    "env", "headers", "environment", "http_headers", "env_http_headers",
    "httpHeaders", "requestInit",
})
# Lists where order carries no meaning (permission rule lists).
UNORDERED_LIST_KEYS = frozenset({"allow", "deny", "ask", "additionalDirectories"})

# Settings keys that loosen permissions, read from the canonical form.
CLAUDE_PERMISSION_KEYS = (
    "permissions", "disableAllHooks", "allowManagedHooksOnly", "allowManagedModsOnly",
    "allowModsToOverrideDenyRules", "enableAllProjectMcpServers",
    "enabledMcpjsonServers", "disabledMcpjsonServers", "sandbox",
)
CLAUDE_PLUGIN_KEYS = ("enabledPlugins", "extraKnownMarketplaces")
MOD_POSTURE_FLAGS = ("allowManagedModsOnly", "allowModsToOverrideDenyRules", "disableAllHooks")

HARNESS_LABELS = {
    "claude-code": "Claude Code", "codex": "Codex", "copilot-cli": "GitHub Copilot CLI",
    "opencode": "OpenCode", "cursor": "Cursor", "openclaw": "OpenClaw",
}
HARNESSES = tuple(HARNESS_LABELS)


# --- data -------------------------------------------------------------------


@dataclass
class Surface:
    harness: str
    scope: str                 # "user" | "project"
    key: str                   # path hint plus section, e.g. ".claude/settings.json#hooks"
    type: str                  # one of SURFACE_TYPES
    path_hint: str
    hash: str
    count: int = 0             # hook entries, rules files, ... for the setup card
    partial: bool = False      # folder over the file cap: only the first files were hashed


@dataclass
class McpServer:
    harness: str
    scope: str
    name: str
    transport: str             # "stdio" | "http" | "sse"
    definition_hash: str
    source_hint: str
    env_keys: List[str] = field(default_factory=list)
    header_keys: List[str] = field(default_factory=list)
    # In-process only, for the opt-in probe. Never stored, never returned.
    url: Optional[str] = None
    # Raw header spec from the config (values may name env vars). Resolved
    # only at probe time by probe_headers_for, never stored or returned.
    header_spec: Dict[str, Any] = field(default_factory=dict, repr=False)
    # Harness-reported tool surface, when the harness keeps one on disk.
    tools: Optional[List[dict]] = None


@dataclass
class Mod:
    key: str
    name: str
    version: str
    managed: bool
    enabled_scopes: List[str]
    handlers: List[str]
    permissions: List[str]
    manifest_hash: str
    tree_hash: Optional[str]


@dataclass
class Risk:
    kind: str                  # "permissions" | "hooks" | "mcp" | "rules" | "plugins"
    severity: str              # "red" | "amber"
    text: str


@dataclass
class ScopeScan:
    harness: str
    scope: str
    workspace_hash: str = ""
    workspace_name: str = ""
    present: bool = False
    surfaces: List[Surface] = field(default_factory=list)
    servers: List[McpServer] = field(default_factory=list)
    mods: List[Mod] = field(default_factory=list)
    posture: Dict[str, bool] = field(default_factory=dict)
    risks: List[Risk] = field(default_factory=list)
    setup_hash: str = ""
    # (path, mtime_ns, size) for every file and folder looked at, for the
    # stat-gated recheck. In-process only.
    stat_sig: List[Tuple[str, int, int]] = field(default_factory=list, repr=False)
    # Path hints of files that could not be read or parsed (too large, too
    # deeply nested, a symlink out of bounds, a parser error).
    unparsed: List[str] = field(default_factory=list)


# --- hashing and canonical form -----------------------------------------------


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hash_canonical(obj: Any) -> str:
    payload = json.dumps({"v": NORMALISER_VERSION, "d": obj}, sort_keys=True,
                         separators=(",", ":"), ensure_ascii=False)
    return sha256_hex(payload.encode("utf-8"))


def _is_own(value: Any) -> bool:
    try:
        text = json.dumps(value, sort_keys=True, ensure_ascii=False) if not isinstance(value, str) else value
    except (TypeError, ValueError, RecursionError):
        text = str(value)
    return OWN_MARKER in text.lower()


def canonical(obj: Any, parent_key: str = "", _depth: int = 0) -> Any:
    """Formatting-free form of a parsed config value.

    Keys sort at dump time. Volatile keys and SecureVector's own entries are
    dropped. The values of env and header maps become their sorted key names,
    so a rotated token never alerts and never reaches a hash input in clear.
    Depth is capped so no input can exhaust the stack.
    """
    if _depth > MAX_NESTING:
        return "__too_deep__"
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            k = str(k)
            if k in VOLATILE_KEYS or OWN_MARKER in k.lower():
                continue
            if k in VALUE_REDACTED_KEYS and isinstance(v, dict):
                out[k] = sorted(str(x) for x in v.keys() if OWN_MARKER not in str(x).lower())
                continue
            cv = canonical(v, k, _depth + 1)
            if cv in ({}, []) and v not in ({}, []):
                continue  # emptied by dropping our own entries: as if never written
            out[k] = cv
        return out
    if isinstance(obj, list):
        items = [canonical(x, parent_key, _depth + 1) for x in obj if not _is_own(x)]
        if parent_key in UNORDERED_LIST_KEYS:
            items.sort(key=lambda x: json.dumps(x, sort_keys=True))
        return items
    if isinstance(obj, str):
        return obj.strip()
    return obj


def strip_jsonc(text: str) -> str:
    """Remove // and /* */ comments and trailing commas outside strings."""
    out: List[str] = []
    i, n = 0, len(text)
    in_str = False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            end = text.find("*/", i + 2)
            i = n if end == -1 else end + 2
            continue
        out.append(c)
        i += 1
    cleaned = "".join(out)
    # Trailing commas: a comma followed only by whitespace before } or ].
    result: List[str] = []
    in_str = False
    j = 0
    while j < len(cleaned):
        c = cleaned[j]
        if in_str:
            result.append(c)
            if c == "\\" and j + 1 < len(cleaned):
                result.append(cleaned[j + 1])
                j += 2
                continue
            if c == '"':
                in_str = False
            j += 1
            continue
        if c == '"':
            in_str = True
        elif c == ",":
            k = j + 1
            while k < len(cleaned) and cleaned[k] in " \t\r\n":
                k += 1
            if k < len(cleaned) and cleaned[k] in "}]":
                j += 1
                continue
        result.append(c)
        j += 1
    return "".join(result)


def normalise_markdown(text: str) -> str:
    lines = [ln.rstrip() for ln in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    out: List[str] = []
    for ln in lines:
        if not ln and (not out or not out[-1]):
            continue
        out.append(ln)
    return "\n".join(out).strip()


# --- reading ------------------------------------------------------------------


def nesting_depth(text: str, limit: int = MAX_NESTING) -> int:
    """Bracket depth outside strings, stopping once past `limit`. Cheap and
    iterative, so it runs before any recursive parser sees the text."""
    depth = deepest = 0
    in_str = None
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if in_str:
            if c == "\\":
                i += 2
                continue
            if c == in_str:
                in_str = None
        elif c in "\"'":
            in_str = c
        elif c in "[{":
            depth += 1
            if depth > deepest:
                deepest = depth
                if deepest > limit:
                    return deepest
        elif c in "]}":
            depth = max(0, depth - 1)
        i += 1
    return deepest


def tree_signature(root: str) -> Tuple[int, int]:
    """(entries, newest mtime) over a bounded walk: catches a file added in
    an existing subfolder, which no single stat would show."""
    count, newest = 0, 0
    try:
        newest = os.lstat(root).st_mtime_ns
    except OSError:
        return 0, -1
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [d for d in dirnames if not d.startswith(".git") and d != "node_modules"]
        for name in dirnames + filenames:
            count += 1
            try:
                newest = max(newest, os.lstat(os.path.join(dirpath, name)).st_mtime_ns)
            except OSError:
                pass
            if count >= MAX_SIG_ENTRIES:
                return count, newest
    return count, newest


_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)


class _Reader:
    """Every file and folder read goes through here, so the stat signature for
    the recheck covers exactly what was read. Regular files only, size capped,
    never through a symlinked folder walk. A symlinked file is read only when
    it resolves inside `root` (the workspace for project scope, the home
    folder for user scope); the file is opened without following links and
    checked on the open descriptor, so a swap between check and read fails."""

    def __init__(self, root: Optional[Path] = None) -> None:
        self.sig: List[Tuple[str, int, int]] = []
        self.root = root
        self.unparsed: List[Path] = []

    def _note(self, path: Path) -> Optional[os.stat_result]:
        try:
            st = path.stat()
        except OSError:
            self.sig.append((str(path), 0, -1))
            return None
        self.sig.append((str(path), st.st_mtime_ns, st.st_size))
        return st

    def _target(self, path: Path) -> Optional[Path]:
        """The path to open: itself, or a symlink's target inside root."""
        try:
            lst = os.lstat(path)
        except OSError:
            return None
        if not stat.S_ISLNK(lst.st_mode):
            return path
        try:
            real = path.resolve(strict=True)
        except (OSError, RuntimeError):
            self.unparsed.append(path)
            return None
        if self.root is None or not _under(real, self.root):
            self.unparsed.append(path)
            return None
        return real

    def _read_bytes(self, path: Path, cap: int) -> Optional[bytes]:
        target = self._target(path)
        if target is None:
            return None
        try:
            fd = os.open(target, os.O_RDONLY | _O_NOFOLLOW)
        except OSError:
            return None
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                return None
            if st.st_size > cap:
                self.unparsed.append(path)
                return None
            chunks, total = [], 0
            while total <= cap:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
            if total > cap:
                self.unparsed.append(path)
                return None
            return b"".join(chunks)
        except OSError:
            return None
        finally:
            os.close(fd)

    def text(self, path: Path) -> Optional[str]:
        if self._note(path) is None:
            return None
        data = self._read_bytes(path, MAX_FILE_BYTES)
        return data.decode("utf-8", "replace") if data is not None else None

    def _unparsed(self, path: Path, raw: str) -> dict:
        self.unparsed.append(path)
        return {"__unparsed__": sha256_hex(raw.encode("utf-8"))}

    def json(self, path: Path, jsonc: bool = False) -> Optional[Any]:
        raw = self.text(path)
        if raw is None:
            return None
        if nesting_depth(raw) > MAX_NESTING:
            return self._unparsed(path, raw)
        for candidate in ((strip_jsonc(raw),) if jsonc else (raw, None)):
            try:
                return json.loads(candidate if candidate is not None else strip_jsonc(raw))
            except Exception:  # noqa: BLE001 - any parser failure is "could not check"
                continue
        return self._unparsed(path, raw)

    def toml(self, path: Path) -> Optional[Any]:
        raw = self.text(path)
        if raw is None:
            return None
        if tomllib is None or nesting_depth(raw) > MAX_NESTING:
            return self._unparsed(path, raw)
        try:
            return tomllib.loads(raw)
        except Exception:  # noqa: BLE001 - any parser failure is "could not check"
            return self._unparsed(path, raw)

    def file_hash(self, path: Path) -> Optional[str]:
        data = self._read_bytes(path, MAX_HASH_BYTES)
        return sha256_hex(data) if data is not None else None

    def tree(self, root: Path) -> Optional[Tuple[List[List[Any]], bool]]:
        """Sorted (relative path, size, file hash) for a folder plus whether
        the file cap cut it short, or None."""
        st = self._note(root)
        if st is None or not stat.S_ISDIR(st.st_mode) or os.path.islink(root):
            return None
        count, newest = tree_signature(str(root))
        self.sig.append((TREE_SIG_PREFIX + str(root), newest, count))
        entries: List[List[Any]] = []
        partial = False
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith(".git") and d != "node_modules")
            for name in sorted(filenames):
                if len(entries) >= MAX_DIR_FILES:
                    partial = True
                    break
                p = Path(dirpath) / name
                try:
                    fst = p.lstat()
                except OSError:
                    continue
                if not stat.S_ISREG(fst.st_mode):
                    continue
                rel = p.relative_to(root).as_posix()
                entries.append([rel, fst.st_size, self.file_hash(p)])
            if partial:
                break
        entries.sort()
        return entries, partial

    def subdirs(self, root: Path) -> List[Path]:
        st = self._note(root)
        if st is None or not stat.S_ISDIR(st.st_mode):
            return []
        try:
            return sorted(p for p in root.iterdir() if p.is_dir() and not p.is_symlink())
        except OSError:
            return []


# --- homes --------------------------------------------------------------------


def home() -> Path:
    return Path(os.path.expanduser("~"))


def _env_dir(var: str, default: Path) -> Path:
    v = os.environ.get(var)
    return Path(v).expanduser() if v else default


def harness_home(harness: str) -> Path:
    h = home()
    if harness == "claude-code":
        return _env_dir("CLAUDE_HOME", h / ".claude")
    if harness == "codex":
        return _env_dir("CODEX_HOME", h / ".codex")
    if harness == "copilot-cli":
        return _env_dir("COPILOT_HOME", h / ".copilot")
    if harness == "cursor":
        return _env_dir("CURSOR_HOME", h / ".cursor")
    if harness == "opencode":
        if os.environ.get("OPENCODE_CONFIG"):
            return Path(os.environ["OPENCODE_CONFIG"]).expanduser().parent
        xdg = os.environ.get("XDG_CONFIG_HOME")
        return (Path(xdg).expanduser() if xdg else h / ".config") / "opencode"
    if harness == "openclaw":
        return h / ".openclaw"
    raise ValueError(f"unknown harness {harness}")


def _hint(path: Path, base: Path, prefix: str) -> str:
    """A display hint with no user name in it: '~/...' or a workspace-relative path."""
    try:
        rel = path.relative_to(base).as_posix()
    except ValueError:
        rel = path.name
    return f"{prefix}{rel}" if prefix else rel


def workspace_id(workspace: Optional[str]) -> Tuple[str, str]:
    if not workspace:
        return "", ""
    p = Path(workspace).expanduser()
    try:
        p = p.resolve()
    except OSError:
        pass
    return sha256_hex(str(p).encode("utf-8"))[:16], p.name


# --- MCP server definitions -----------------------------------------------------


def server_from_config(harness: str, scope: str, name: str, cfg: Any, source_hint: str) -> Optional[McpServer]:
    if not isinstance(cfg, dict) or OWN_MARKER in str(name).lower():
        return None
    kind = str(cfg.get("type") or cfg.get("transport") or "").lower()
    url = cfg.get("url") or cfg.get("serverUrl") or cfg.get("httpUrl")
    command = cfg.get("command")
    args = cfg.get("args") or []
    if isinstance(command, list):  # OpenCode: command is the argv list
        args = list(command[1:]) + list(args if isinstance(args, list) else [])
        command = command[0] if command else None
    env = cfg.get("env") or cfg.get("environment") or {}
    headers = cfg.get("headers") or cfg.get("http_headers") or {}
    env_headers = cfg.get("env_http_headers") or {}
    if url and kind not in ("sse",):
        transport = "http"
    elif url:
        transport = "sse"
    else:
        transport = "stdio"
    env_keys = sorted(str(k) for k in env) if isinstance(env, dict) else []
    header_keys = sorted({*(str(k) for k in headers if isinstance(headers, dict)),
                          *(str(k) for k in env_headers if isinstance(env_headers, dict))})
    if cfg.get("bearer_token_env_var"):
        header_keys = sorted(set(header_keys) | {"Authorization"})
    # The environment variables the definition reads, by name: `${A}` in a
    # header or env value, env_http_headers targets, the bearer variable.
    # Values are never hashed (a rotated secret is not a change), but which
    # variable a header reads is part of the definition, so switching `${A}`
    # to `${AWS_SECRET_ACCESS_KEY}` drops the approval and the probe opt-in.
    env_refs = set()
    for mapping in (headers, env):
        if isinstance(mapping, dict):
            for v in mapping.values():
                env_refs.update(_env_refs(v))
    if isinstance(env_headers, dict):
        env_refs.update(str(v) for v in env_headers.values())
    if cfg.get("bearer_token_env_var"):
        env_refs.add(str(cfg["bearer_token_env_var"]))
    definition = {
        "transport": transport,
        "command": str(command).strip() if command else None,
        "args": [str(a) for a in args] if isinstance(args, list) else [],
        "url": str(url).strip() if url else None,
        "env_keys": env_keys,
        "header_keys": header_keys,
        "env_refs": sorted(env_refs),
    }
    spec: Dict[str, Any] = {}
    if transport != "stdio":
        spec = {
            "headers": {str(k): str(v) for k, v in headers.items()} if isinstance(headers, dict) else {},
            "env_headers": {str(k): str(v) for k, v in env_headers.items()} if isinstance(env_headers, dict) else {},
            "bearer_var": str(cfg["bearer_token_env_var"]) if cfg.get("bearer_token_env_var") else None,
        }
    return McpServer(
        harness=harness, scope=scope, name=str(name), transport=transport,
        definition_hash=hash_canonical(definition), source_hint=source_hint,
        env_keys=env_keys, header_keys=header_keys,
        url=str(url) if url and transport != "stdio" else None, header_spec=spec,
    )


def _has_env_ref(value: str) -> bool:
    return "$" in value or ("%" in value and os.name == "nt")


_ENV_REF = re.compile(r"\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)")
_WIN_ENV_REF = re.compile(r"%([^%]+)%")


def _env_refs(value: Any) -> List[str]:
    """Names of the environment variables a config value reads (the forms
    os.path.expandvars honours). Names only; the value itself is not kept."""
    if not isinstance(value, str):
        return []
    names = [a or b for a, b in _ENV_REF.findall(value)]
    if os.name == "nt":
        names += _WIN_ENV_REF.findall(value)
    return names


def probe_headers_for(srv: McpServer, allow_secrets: bool) -> Dict[str, str]:
    """The headers the opt-in probe sends. With `allow_secrets` (a user-scope
    server, or a project server whose exact definition the user approved),
    env references in header values are expanded and env-named headers and
    bearer tokens are attached. Without it, only literal values that name no
    environment variable are sent."""
    spec = srv.header_spec or {}
    out: Dict[str, str] = {}
    for k, v in (spec.get("headers") or {}).items():
        if _has_env_ref(v):
            if allow_secrets:
                out[k] = os.path.expandvars(v)
        else:
            out[k] = v
    if allow_secrets:
        for hk, var in (spec.get("env_headers") or {}).items():
            if os.environ.get(var):
                out[hk] = os.environ[var]
        var = spec.get("bearer_var")
        if var and os.environ.get(var):
            out["Authorization"] = f"Bearer {os.environ[var]}"
    return out


def tool_entry(name: str, description: Optional[str], schema: Any, source: str) -> dict:
    """One tool on a server's surface: name, description hash, schema hash.
    The description text is kept for the local approval diff only."""
    desc = description if isinstance(description, str) else None
    return {
        "name": str(name),
        "desc_hash": sha256_hex(desc.strip().encode("utf-8")) if desc is not None else None,
        "schema_hash": hash_canonical(canonical(schema)) if schema is not None else None,
        "description": desc.strip()[:MAX_DESCRIPTION_CHARS] if desc is not None else None,
        "arg_keys": sorted((schema or {}).get("properties", {}).keys()) if isinstance(schema, dict) else [],
        "source": source,
    }


def cursor_reported_tools(reader: _Reader, cursor_home: Path) -> Dict[str, List[dict]]:
    """Cursor keeps a per-server folder of tool descriptors under
    ~/.cursor/projects/<slug>/mcps/<server>/tools/<tool>.json (spike result).
    Read them as data; the newest file wins when a tool shows in several
    projects. Format is not documented, so name/description/inputSchema are
    read tolerantly."""
    found: Dict[str, Dict[str, Tuple[int, dict]]] = {}
    for proj in reader.subdirs(cursor_home / "projects"):
        for server_dir in reader.subdirs(proj / "mcps"):
            tools_dir = server_dir / "tools"
            try:
                files = sorted(tools_dir.glob("*.json"))[:MAX_DIR_FILES]
            except OSError:
                continue
            for f in files:
                data = reader.json(f)
                if not isinstance(data, dict):
                    continue
                try:
                    mtime = f.stat().st_mtime_ns
                except OSError:
                    mtime = 0
                name = data.get("name") or f.stem
                schema = data.get("inputSchema") or data.get("input_schema") or data.get("parameters")
                entry = tool_entry(name, data.get("description"), schema, "harness")
                per = found.setdefault(server_dir.name, {})
                if name not in per or per[name][0] < mtime:
                    per[name] = (mtime, entry)
    return {srv: [e for _, e in sorted(per.values(), key=lambda x: x[1]["name"])] for srv, per in found.items()}


# --- per-harness surfaces ---------------------------------------------------------


def _sections(obj: Any, split: Dict[str, Iterable[str]], keep_rest: bool = True) -> Dict[str, Any]:
    """Split one parsed settings file into typed sections."""
    if not isinstance(obj, dict):
        return {"other": obj} if obj is not None else {}
    used = set()
    out: Dict[str, Any] = {}
    for stype, keys in split.items():
        part = {k: obj[k] for k in keys if k in obj}
        used.update(part)
        if part:
            out[stype] = part
    if keep_rest:
        rest = {k: v for k, v in obj.items() if k not in used}
        if rest:
            out["other"] = rest
    return out


def _count_hooks(section: Any) -> int:
    if isinstance(section, dict) and "hooks" in section and len(section) <= 2:
        section = section.get("hooks")
    n = 0
    if isinstance(section, dict):
        for v in section.values():
            if isinstance(v, list):
                n += len(v)
            elif v:
                n += 1
    elif isinstance(section, list):
        n = len(section)
    return n


class _Builder:
    def __init__(self, harness: str, scope: str, base: Path, prefix: str, reader: _Reader):
        self.harness, self.scope, self.base, self.prefix, self.r = harness, scope, base, prefix, reader
        self.out = ScopeScan(harness=harness, scope=scope)

    def hint(self, path: Path) -> str:
        return _hint(path, self.base, self.prefix)

    def add(self, path: Path, stype: str, value: Any, section: str = "", count: int = 0) -> None:
        canon = canonical(value)
        if canon in (None, {}, []):
            return
        hint = self.hint(path)
        key = f"{hint}#{section}" if section else hint
        if stype == "hooks" and not count:
            count = _count_hooks(canon)
        self.out.surfaces.append(Surface(self.harness, self.scope, key, stype, hint, hash_canonical(canon), count))
        self.out.present = True

    def add_sections(self, path: Path, parsed: Any, split: Dict[str, Iterable[str]], keep_rest: bool = True,
                     mcp_key: Optional[str] = None) -> None:
        if parsed is None:
            return
        self.out.present = True
        if mcp_key and isinstance(parsed, dict):
            self.add_servers(path, parsed.get(mcp_key))
            parsed = {k: v for k, v in parsed.items() if k != mcp_key}
        for stype, part in _sections(parsed, split, keep_rest).items():
            self.add(path, stype, part, stype)

    def add_servers(self, path: Path, servers: Any) -> None:
        if not isinstance(servers, dict):
            return
        for name, cfg in servers.items():
            srv = server_from_config(self.harness, self.scope, name, cfg, self.hint(path))
            if srv:
                self.out.servers.append(srv)
                self.out.present = True

    def add_markdown(self, path: Path) -> None:
        text = self.r.text(path)
        if text is None:
            return
        norm = normalise_markdown(text)
        self.out.surfaces.append(Surface(self.harness, self.scope, self.hint(path), "rules", self.hint(path),
                                         hash_canonical(norm), 1))
        self.out.present = True

    def add_tree(self, path: Path, stype: str) -> None:
        got = self.r.tree(path)
        if not got or not got[0]:
            return
        entries, partial = got
        self.out.surfaces.append(Surface(self.harness, self.scope, self.hint(path) + "/", stype,
                                         self.hint(path) + "/", hash_canonical(entries), len(entries), partial))
        self.out.present = True


def _claude(b: _Builder, ws: Optional[Path]) -> None:
    r = b.r
    split = {"hooks": ["hooks"], "permissions": CLAUDE_PERMISSION_KEYS, "plugins": CLAUDE_PLUGIN_KEYS}
    if ws is None:
        ch = harness_home("claude-code")
        b.add_sections(ch / "settings.json", r.json(ch / "settings.json"), split, mcp_key="mcpServers")
        b.add_markdown(ch / "CLAUDE.md")
        for sub in ("hooks", "commands", "agents", "skills"):
            b.add_tree(ch / sub, "hooks" if sub == "hooks" else "other")
        state = r.json(home() / ".claude.json")
        if isinstance(state, dict):
            b.out.present = True
            b.add_servers(home() / ".claude.json", state.get("mcpServers"))
    else:
        cd = ws / ".claude"
        for name in ("settings.json", "settings.local.json"):
            b.add_sections(cd / name, r.json(cd / name), split, mcp_key="mcpServers")
        mcp = r.json(ws / ".mcp.json")
        if isinstance(mcp, dict):
            b.add_servers(ws / ".mcp.json", mcp.get("mcpServers", mcp))
        b.add_markdown(ws / "CLAUDE.md")
        b.add_markdown(cd / "CLAUDE.md")
        for sub in ("hooks", "commands", "agents", "skills"):
            b.add_tree(cd / sub, "hooks" if sub == "hooks" else "other")
        # Local-scope servers Claude Code keeps per folder in ~/.claude.json.
        state = r.json(home() / ".claude.json")
        if isinstance(state, dict):
            projects = state.get("projects") or {}
            entry = projects.get(str(ws)) if isinstance(projects, dict) else None
            if isinstance(entry, dict):
                for name, cfg in (entry.get("mcpServers") or {}).items():
                    srv = server_from_config("claude-code", "project", name, cfg, "~/.claude.json (this folder)")
                    if srv:
                        b.out.servers.append(srv)
                        b.out.present = True


CODEX_SPLIT = {
    "hooks": ["hooks", "notify"],
    "permissions": ["approval_policy", "sandbox_mode", "sandbox_workspace_write", "projects",
                    "shell_environment_policy", "profiles"],
    "plugins": ["plugins", "marketplaces"],
}


def _codex(b: _Builder, ws: Optional[Path]) -> None:
    base = harness_home("codex") if ws is None else ws / ".codex"
    b.add_sections(base / "config.toml", b.r.toml(base / "config.toml"), CODEX_SPLIT, mcp_key="mcp_servers")
    if ws is None:
        b.add_markdown(base / "AGENTS.md")
        b.add_tree(base / "hooks", "hooks")
    else:
        b.add_markdown(ws / "AGENTS.md")


def _copilot(b: _Builder, ws: Optional[Path]) -> None:
    if ws is None:
        base = harness_home("copilot-cli")
        b.add_sections(base / "config.json", b.r.json(base / "config.json"),
                       {"hooks": ["hooks"], "permissions": ["trusted_folders", "allowed_urls", "denied_urls",
                                                             "allow_all_tools", "allowAllTools"]},
                       mcp_key="mcpServers")
        mcp = b.r.json(base / "mcp-config.json")
        if isinstance(mcp, dict):
            b.add_servers(base / "mcp-config.json", mcp.get("mcpServers", mcp))
    else:
        b.add_markdown(ws / ".github" / "copilot-instructions.md")
        b.add_markdown(ws / "AGENTS.md")
        b.add_tree(ws / ".github" / "hooks", "hooks")
        mcp = b.r.json(ws / ".github" / "mcp.json") or b.r.json(ws / ".copilot" / "mcp-config.json")
        if isinstance(mcp, dict):
            b.add_servers(ws / ".github" / "mcp.json", mcp.get("mcpServers", mcp))


OPENCODE_SPLIT = {"permissions": ["permission", "tools", "agent"], "plugins": ["plugin"]}


def _opencode(b: _Builder, ws: Optional[Path]) -> None:
    base = harness_home("opencode") if ws is None else ws
    for name in ("opencode.json", "opencode.jsonc"):
        b.add_sections(base / name, b.r.json(base / name, jsonc=True), OPENCODE_SPLIT, mcp_key="mcp")
    b.add_markdown(base / "AGENTS.md")
    if ws is not None:
        b.add_tree(ws / ".opencode" / "plugin", "plugins")


def _cursor(b: _Builder, ws: Optional[Path]) -> None:
    base = harness_home("cursor") if ws is None else ws / ".cursor"
    mcp = b.r.json(base / "mcp.json")
    if isinstance(mcp, dict):
        b.out.present = True
        b.add_servers(base / "mcp.json", mcp.get("mcpServers", mcp))
    hooks = b.r.json(base / "hooks.json")
    if hooks is not None:
        b.add(base / "hooks.json", "hooks", hooks, "hooks")
    if ws is not None:
        b.add_tree(base / "rules", "rules")
        b.add_markdown(ws / "AGENTS.md")
    else:
        reported = cursor_reported_tools(b.r, base)
        for srv in b.out.servers:
            if srv.name in reported:
                srv.tools = reported[srv.name]


def _openclaw(b: _Builder, ws: Optional[Path]) -> None:
    if ws is not None:
        return
    base = harness_home("openclaw")
    cfg = b.r.json(base / "openclaw.json")
    if isinstance(cfg, dict):
        b.out.present = True
        b.add(base / "openclaw.json", "plugins", cfg.get("plugins"), "plugins")
        b.add(base / "openclaw.json", "hooks", cfg.get("hooks"), "hooks")


_SCANNERS: Dict[str, Callable[[_Builder, Optional[Path]], None]] = {
    "claude-code": _claude, "codex": _codex, "copilot-cli": _copilot,
    "opencode": _opencode, "cursor": _cursor, "openclaw": _openclaw,
}


# --- mods (Claude Code only) ----------------------------------------------------------

# Managed settings path per platform; tests point this elsewhere.
MANAGED_SETTINGS_PATHS = {
    "darwin": Path("/Library/Application Support/ClaudeCode/managed-settings.json"),
    "linux": Path("/etc/claude-code/managed-settings.json"),
    "win32": Path("C:/ProgramData/ClaudeCode/managed-settings.json"),
}


def _managed_settings_path() -> Optional[Path]:
    override = os.environ.get("SV_CLAUDE_MANAGED_SETTINGS")
    if override:
        return Path(override)
    return MANAGED_SETTINGS_PATHS.get(sys.platform)


def _under(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (ValueError, OSError):
        return False


def _manifest(reader: _Reader, root: Path) -> Any:
    for rel in (".claude-plugin/plugin.json", "plugin.json"):
        data = reader.json(root / rel)
        if isinstance(data, dict):
            return data
    return None


def _mod_handlers(reader: _Reader, root: Path, manifest: Any) -> List[str]:
    handlers = set()
    hooks = reader.json(root / "hooks" / "hooks.json")
    if isinstance(hooks, dict):
        events = hooks.get("hooks", hooks)
        if isinstance(events, dict):
            handlers.update(f"hook:{k}" for k in events)
    if isinstance(manifest, dict):
        mh = manifest.get("hooks")
        if isinstance(mh, dict):
            handlers.update(f"hook:{k}" for k in mh.get("hooks", mh))
        servers = manifest.get("mcpServers")
        if isinstance(servers, dict):
            handlers.update(f"mcp:{k}" for k in servers)
    mcp = reader.json(root / ".mcp.json")
    if isinstance(mcp, dict):
        handlers.update(f"mcp:{k}" for k in mcp.get("mcpServers", mcp))
    for sub in ("commands", "agents", "skills"):
        try:
            if (root / sub).is_dir():
                handlers.add(sub)
        except OSError:
            pass
    return sorted(handlers)


def _mod_permissions(manifest: Any) -> List[str]:
    if not isinstance(manifest, dict):
        return []
    perms = manifest.get("permissions")
    if isinstance(perms, list):
        return sorted(str(p) for p in perms)[:50]
    if isinstance(perms, dict):
        return sorted(f"{k}:{v}" for k, v in perms.items())[:50]
    return []


def scan_mods(reader: _Reader, settings_by_scope: Dict[str, Any]) -> Tuple[List[Mod], Dict[str, bool]]:
    """Inventory of Claude Code mods from installed_plugins.json, the plugin
    cache and dev-mods/. Manifests are parsed as data; nothing is loaded."""
    ch = harness_home("claude-code")
    plugins_root = ch / "plugins"
    installed = reader.json(plugins_root / "installed_plugins.json")
    entries: Dict[str, dict] = {}
    if isinstance(installed, dict):
        table = installed.get("plugins") if isinstance(installed.get("plugins"), dict) else installed
        for key, val in table.items():
            if key == "version" or OWN_MARKER in str(key).lower():
                continue
            rec = val[0] if isinstance(val, list) and val else val
            if isinstance(rec, dict):
                entries[str(key)] = rec
    enabled: Dict[str, List[str]] = {}
    managed_keys = set()
    for scope, settings in settings_by_scope.items():
        ep = settings.get("enabledPlugins") if isinstance(settings, dict) else None
        if isinstance(ep, dict):
            for k, on in ep.items():
                if on and OWN_MARKER not in str(k).lower():
                    enabled.setdefault(str(k), []).append(scope)
                    if scope == "managed":
                        managed_keys.add(str(k))
    mods: List[Mod] = []
    for key, rec in sorted(entries.items()):
        install = Path(str(rec.get("installPath") or ""))
        root_ok = install.is_absolute() and _under(install, plugins_root)
        manifest = _manifest(reader, install) if root_ok else None
        mods.append(Mod(
            key=key, name=key.split("@")[0], version=str(rec.get("version") or (manifest or {}).get("version") or ""),
            managed=rec.get("scope") == "managed" or key in managed_keys,
            enabled_scopes=sorted(enabled.get(key, [])),
            handlers=_mod_handlers(reader, install, manifest) if root_ok else [],
            permissions=_mod_permissions(manifest),
            manifest_hash=hash_canonical(canonical(manifest)) if manifest is not None else hash_canonical(canonical(rec)),
            tree_hash=hash_canonical(list(reader.tree(install) or ())) if root_ok else None,
        ))
    for d in reader.subdirs(ch / "dev-mods"):
        if OWN_MARKER in d.name.lower():
            continue
        manifest = _manifest(reader, d)
        key = f"dev:{d.name}"
        mods.append(Mod(
            key=key, name=d.name, version=str((manifest or {}).get("version") or ""), managed=False,
            enabled_scopes=sorted(enabled.get(key, [])), handlers=_mod_handlers(reader, d, manifest),
            permissions=_mod_permissions(manifest),
            manifest_hash=hash_canonical(canonical(manifest)), tree_hash=hash_canonical(list(reader.tree(d) or ())),
        ))
    posture = {flag: any(bool((s or {}).get(flag)) for s in settings_by_scope.values() if isinstance(s, dict))
               for flag in MOD_POSTURE_FLAGS}
    return mods, posture


# --- risks in plain words ---------------------------------------------------------------


def _risks_from_settings(harness: str, scope: str, settings: Any, out: List[Risk]) -> None:
    if not isinstance(settings, dict):
        return
    where = "this folder" if scope == "project" else "your user settings"
    perms = settings.get("permissions") if isinstance(settings.get("permissions"), dict) else {}
    mode = perms.get("defaultMode") or settings.get("defaultMode")
    if mode == "bypassPermissions":
        out.append(Risk("permissions", "red", f"Permission prompts are turned off in {where} (bypass mode)."))
    allow = [str(a) for a in (perms.get("allow") or []) if isinstance(a, str)]
    if any(a in ("Bash", "Bash(*)", "Bash(*:*)") for a in allow):
        out.append(Risk("permissions", "red", f"Any shell command runs without asking ({where} allows Bash(*))."))
    if settings.get("disableAllHooks"):
        out.append(Risk("permissions", "red", f"All hooks are turned off in {where}, Guard included."))
    if settings.get("allowModsToOverrideDenyRules"):
        out.append(Risk("permissions", "red", f"Mods can override your deny rules ({where})."))
    if settings.get("enableAllProjectMcpServers"):
        out.append(Risk("mcp", "red", f"Every MCP server a project defines starts without asking ({where})."))
    if scope == "project":
        ep = settings.get("enabledPlugins")
        if isinstance(ep, dict):
            on = [k for k, v in ep.items() if v and OWN_MARKER not in str(k).lower()]
            if on:
                out.append(Risk("plugins", "red", f"This folder turns on mods: {', '.join(sorted(on)[:3])}."))


def _risks_from_codex(scope: str, cfg: Any, out: List[Risk]) -> None:
    if not isinstance(cfg, dict):
        return
    where = "this folder" if scope == "project" else "your Codex config"
    tables = [cfg] + [p for p in (cfg.get("profiles") or {}).values() if isinstance(p, dict)]
    if any(t.get("approval_policy") == "never" for t in tables):
        out.append(Risk("permissions", "red", f"Codex never asks before running commands ({where})."))
    if any(t.get("sandbox_mode") == "danger-full-access" for t in tables):
        out.append(Risk("permissions", "red", f"Codex runs without a sandbox ({where})."))


def _collect_risks(scan: ScopeScan, reader: _Reader, ws: Optional[Path]) -> None:
    risks: List[Risk] = []
    if scan.harness == "claude-code":
        files = ([harness_home("claude-code") / "settings.json"] if ws is None
                 else [ws / ".claude" / "settings.json", ws / ".claude" / "settings.local.json"])
        for f in files:
            _risks_from_settings("claude-code", scan.scope, reader.json(f), risks)
    elif scan.harness == "codex":
        base = harness_home("codex") if ws is None else ws / ".codex"
        _risks_from_codex(scan.scope, reader.toml(base / "config.toml"), risks)
    if scan.scope == "project":
        hooks = sum(s.count or 1 for s in scan.surfaces if s.type == "hooks")
        if hooks:
            risks.append(Risk("hooks", "red", f"This folder adds its own hooks ({hooks})."))
        for srv in scan.servers:
            risks.append(Risk("mcp", "red", f"This folder adds MCP server {srv.name} ({srv.transport})."))
    scan.risks = risks


def _setup_hash(scan: ScopeScan) -> str:
    parts = sorted([f"s:{s.key}:{s.hash}" for s in scan.surfaces]
                   + [f"m:{m.name}:{m.definition_hash}" for m in scan.servers]
                   + [f"d:{m.key}:{m.manifest_hash}:{m.tree_hash}" for m in scan.mods])
    return hash_canonical(parts)


def scan_scope(harness: str, workspace: Optional[str] = None) -> ScopeScan:
    """Scan one harness at user scope (workspace None) or project scope."""
    if harness not in _SCANNERS:
        raise ValueError(f"unknown harness {harness}")
    ws = Path(workspace).expanduser() if workspace else None
    if ws is not None:
        try:
            ws = ws.resolve()
        except OSError:
            pass
    reader = _Reader(ws if ws is not None else home())
    scope = "user" if ws is None else "project"
    base, prefix = (home(), "~/") if ws is None else (ws, "")
    b = _Builder(harness, scope, base, prefix, reader)
    if ws is None:
        try:
            b.out.present = harness_home(harness).is_dir()
        except OSError:
            b.out.present = False
    _SCANNERS[harness](b, ws)
    scan = b.out
    scan.workspace_hash, scan.workspace_name = workspace_id(str(ws) if ws else None)
    if harness == "claude-code" and ws is None:
        settings = {"user": reader.json(harness_home("claude-code") / "settings.json")}
        mp = _managed_settings_path()
        if mp is not None:
            settings["managed"] = reader.json(mp)
        scan.mods, scan.posture = scan_mods(reader, settings)
    _collect_risks(scan, reader, ws)
    seen = set()
    for p in reader.unparsed:
        hint = _hint(p, base, prefix)
        if hint not in seen:
            seen.add(hint)
            scan.unparsed.append(hint)
            scan.risks.insert(0, Risk("other", "red", f"Could not check {hint}: too large, too deeply nested, "
                                      "unreadable, or a link that points outside this folder. Look at it by hand."))
    for s in scan.surfaces:
        if s.partial:
            scan.risks.append(Risk("other", "amber", f"{s.path_hint} is too large to fully check: only the first "
                                   f"{MAX_DIR_FILES} files were hashed."))
    scan.setup_hash = _setup_hash(scan)
    scan.stat_sig = reader.sig
    return scan


def stat_signature(scan: ScopeScan) -> str:
    """Re-stat everything the scan looked at, cheaply, for the 60 s recheck."""
    parts = []
    for path, _m, _s in scan.stat_sig:
        if path.startswith(TREE_SIG_PREFIX):
            count, newest = tree_signature(path[len(TREE_SIG_PREFIX):])
            parts.append(f"{path}:{newest}:{count}")
            continue
        try:
            st = os.stat(path)
            parts.append(f"{path}:{st.st_mtime_ns}:{st.st_size}")
        except OSError:
            parts.append(f"{path}:0:-1")
    return sha256_hex("\n".join(sorted(parts)).encode("utf-8"))


def newest_mtime(scan: ScopeScan) -> float:
    newest = 0.0
    for path, _m, _s in scan.stat_sig:
        if path.startswith(TREE_SIG_PREFIX):
            _count, ns = tree_signature(path[len(TREE_SIG_PREFIX):])
            newest = max(newest, ns / 1e9)
            continue
        try:
            newest = max(newest, os.stat(path).st_mtime)
        except OSError:
            continue
    return newest
