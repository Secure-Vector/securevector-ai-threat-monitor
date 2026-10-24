"""
Canonical action descriptors for a harness tool call.

`canonical_action(tool_name, tool_input)` turns the call exactly as a
PreToolUse hook receives it into `(action_kind, target_hash, action_hash)`.
The same function runs when a pre-flight decision is recorded and when the
real call arrives, so two spellings of one action hash equal by
construction.

Normalisation is string-only: trim, collapse whitespace, lower-case URL
hosts, percent-decode a URL path once, strip quoting that does not change
meaning, and resolve `.` and `..` lexically. Nothing here touches the file
system or resolves a name, so a hash never depends on whether a target
exists.

Kinds: `shell`, `file_read`, `file_write`, `network`, `mcp`, `other`.
"""

from __future__ import annotations

import hashlib
import json
import posixpath
import re
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import unquote, urlsplit, urlunsplit

SHELL = "shell"
FILE_READ = "file_read"
FILE_WRITE = "file_write"
NETWORK = "network"
MCP = "mcp"
OTHER = "other"
KINDS = (SHELL, FILE_READ, FILE_WRITE, NETWORK, MCP, OTHER)

# Bumped when a normalisation rule changes, so hashes from two versions
# never compare equal by accident.
CANON_VERSION = "1"

_SHELL_TOOLS = frozenset({
    "bash", "powershell", "shell", "exec", "terminal", "run_terminal_cmd",
    "runcommand", "execute_command", "run_shell_command", "local_shell",
})
_READ_TOOLS = frozenset({
    "read", "notebookread", "view", "read_file", "ls", "list_dir",
    "list_directory", "glob", "grep",
})
_WRITE_TOOLS = frozenset({
    "write", "edit", "multiedit", "notebookedit", "create", "write_file",
    "edit_file", "str_replace", "str_replace_editor", "replace", "delete_file",
})
_FETCH_TOOLS = frozenset({"webfetch", "web_fetch", "fetch"})
_SEARCH_TOOLS = frozenset({"websearch", "web_search", "google_web_search"})

_COMMAND_KEYS = ("command", "script", "cmd")
_PATH_KEYS = ("file_path", "path", "notebook_path", "filePath", "target_file", "file")
# Fields that describe a call but are not the action: a different
# description or timeout is the same command.
_SHELL_IGNORED = frozenset({"description", "timeout", "run_in_background", "explanation"})
_READ_IGNORED = frozenset({"offset", "limit", "head_limit", "description"})

_SHELL_OPS = set(";&|<>()")
_URL_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.\-]*://")
_WS_RE = re.compile(r"\s+")
_DEFAULT_PORTS = {"http": "80", "https": "443"}


class UnsupportedAction(ValueError):
    """The input is not a tool call this module can describe."""


@dataclass(frozen=True)
class CanonicalAction:
    kind: str
    target_hash: str
    action_hash: str


def _h(*parts: str) -> str:
    joined = "\x1f".join([CANON_VERSION, *parts])
    return hashlib.sha256(joined.encode("utf-8", "surrogatepass")).hexdigest()


def collapse(text: str) -> str:
    return _WS_RE.sub(" ", text or "").strip()


def _strip_quotes(text: str) -> str:
    t = text.strip()
    while len(t) >= 2 and t[0] == t[-1] and t[0] in ("'", '"'):
        t = t[1:-1].strip()
    return t


def _lexical_path(path: str) -> str:
    """Resolve `.` and `..` without touching the disk. A trailing slash and
    repeated slashes do not change the target."""
    if not path:
        return path
    lead = "/" if path.startswith("/") else ""
    out = posixpath.normpath(path)
    if lead and out.startswith("//"):
        out = "/" + out.lstrip("/")
    return out


def normalize_url(raw: str) -> str:
    """Lower-case scheme and host, drop a default port and a trailing dot,
    percent-decode the path once and resolve dot segments in it."""
    text = _strip_quotes(raw)
    try:
        parts = urlsplit(text)
    except ValueError:
        return collapse(text)
    scheme = (parts.scheme or "").lower()
    netloc = parts.netloc
    userinfo = ""
    if "@" in netloc:
        userinfo, netloc = netloc.rsplit("@", 1)
        userinfo += "@"
    host, port = netloc, ""
    if netloc.startswith("["):
        end = netloc.find("]")
        if end != -1:
            host, rest = netloc[: end + 1], netloc[end + 1:]
            port = rest[1:] if rest.startswith(":") else ""
    elif ":" in netloc:
        host, port = netloc.rsplit(":", 1)
    host = host.lower().rstrip(".")
    if port and _DEFAULT_PORTS.get(scheme) == port:
        port = ""
    netloc = userinfo + host + (":" + port if port else "")
    path = unquote(parts.path or "")
    path = _lexical_path(path) if path else "/"
    if path == ".":
        path = "/"
    if not path.startswith("/"):
        path = "/" + path
    return urlunsplit((scheme, netloc, path, parts.query, ""))


# Characters an unquoted shell word expands or matches on. A word part that
# holds none of them means the same quoted or unquoted.
_SHELL_SPECIAL = set("$`\\*?[]{}~!")
_LITERAL_SAFE_RE = re.compile(r"^[A-Za-z0-9_@%+=:,./\-]+$")


def _shell_words(command: str) -> list:
    """Split a command the way a POSIX shell reads its quoting.

    Returns ("op", text) for operators and ("w", parts) for words, where
    each part is (text, literal). `literal` is True for text whose meaning
    does not depend on how it was quoted: single-quoted text, an escaped
    character, double-quoted text with no expansion, and unquoted text with
    no expansion or glob characters. Raises ValueError on an unterminated
    quote."""
    tokens: list = []
    parts: list = []
    in_word = False
    i, n = 0, len(command)

    def add(text: str, literal: bool) -> None:
        nonlocal in_word
        in_word = True
        if parts and parts[-1][1] == literal and literal:
            parts[-1] = (parts[-1][0] + text, True)
        else:
            parts.append((text, literal))

    def flush() -> None:
        nonlocal parts, in_word
        if in_word:
            tokens.append(("w", list(parts)))
        parts, in_word = [], False

    while i < n:
        c = command[i]
        if c.isspace():
            flush()
            i += 1
        elif c in _SHELL_OPS:
            flush()
            j = i
            while j < n and command[j] in _SHELL_OPS:
                j += 1
            tokens.append(("op", command[i:j]))
            i = j
        elif c == "'":
            end = command.find("'", i + 1)
            if end == -1:
                raise ValueError("unterminated quote")
            add(command[i + 1:end], True)
            i = end + 1
        elif c == '"':
            j = i + 1
            buf = []
            while j < n and command[j] != '"':
                if command[j] == "\\" and j + 1 < n and command[j + 1] in '"\\$`':
                    buf.append(command[j:j + 2] if command[j + 1] in "$`" else command[j + 1])
                    j += 2
                    continue
                buf.append(command[j])
                j += 1
            if j >= n:
                raise ValueError("unterminated quote")
            part = "".join(buf)
            if "$" in part or "`" in part:
                add('"' + part + '"', False)
            else:
                add(part, True)
            i = j + 1
        elif c == "\\" and i + 1 < n:
            add(command[i + 1], True)
            i += 2
        else:
            j = i
            while j < n and not command[j].isspace() and command[j] not in _SHELL_OPS \
                    and command[j] not in "'\"\\":
                j += 1
            run = command[i:j]
            literal = not any(ch in _SHELL_SPECIAL for ch in run)
            add(run, literal)
            i = j
    flush()
    return tokens


def _quote_literal(text: str) -> str:
    if text and _LITERAL_SAFE_RE.match(text):
        return text
    return "'" + text.replace("'", "'\\''") + "'"


def _canon_word(parts: list) -> str:
    """One spelling per word. A fully literal word that is a URL gets its
    host and path normalised; nothing else is rewritten, so a word holding
    a variable or a glob keeps exactly the text it had."""
    if len(parts) == 1 and parts[0][1]:
        text = parts[0][0]
        if _URL_RE.match(text):
            text = normalize_url(text)
        return _quote_literal(text)
    out = []
    for text, literal in parts:
        out.append(_quote_literal(text) if literal else text)
    return "".join(out)


def normalize_command(command: str) -> str:
    """One canonical spelling of a shell command."""
    try:
        tokens = _shell_words(command)
    except ValueError:
        return collapse(command)
    return " ".join(text if kind == "op" else _canon_word(text) for kind, text in tokens)


def _canon_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def _first_str(data: dict, keys) -> Optional[str]:
    for k in keys:
        v = data.get(k)
        if isinstance(v, str) and v.strip():
            return v
    return None


def _rest(data: dict, drop) -> str:
    return _canon_json({k: v for k, v in data.items() if k not in drop})


def canonical_action(tool_name: Any, tool_input: Any) -> CanonicalAction:
    """`(kind, target_hash, action_hash)` for one harness-native tool call.

    Raises UnsupportedAction when the name or input is not a tool call."""
    if not isinstance(tool_name, str) or not tool_name.strip() or len(tool_name) > 256:
        raise UnsupportedAction("tool_name")
    if tool_input is None:
        tool_input = {}
    if not isinstance(tool_input, dict):
        raise UnsupportedAction("tool_input")
    name = tool_name.strip()
    low = name.lower()

    if low.startswith("mcp__"):
        remainder = name[5:]
        sep = remainder.find("__")
        if sep <= 0 or sep + 2 >= len(remainder):
            raise UnsupportedAction("mcp tool name")
        target = remainder[:sep] + ":" + remainder[sep + 2:]
        return CanonicalAction(MCP, _h(MCP, target), _h(MCP, target, _canon_json(tool_input)))

    if low in _SHELL_TOOLS:
        command = _first_str(tool_input, _COMMAND_KEYS)
        if command is None:
            raise UnsupportedAction("command")
        canon = normalize_command(command)
        rest = _rest(tool_input, _SHELL_IGNORED | set(_COMMAND_KEYS))
        return CanonicalAction(SHELL, _h(SHELL, canon), _h(SHELL, low, canon, rest))

    if low in _FETCH_TOOLS:
        url = _first_str(tool_input, ("url", "URL"))
        if url is None:
            raise UnsupportedAction("url")
        canon = normalize_url(url)
        return CanonicalAction(NETWORK, _h(NETWORK, canon), _h(NETWORK, "fetch", canon))

    if low in _SEARCH_TOOLS:
        query = _first_str(tool_input, ("query", "q"))
        if query is None:
            raise UnsupportedAction("query")
        canon = "search:" + collapse(_strip_quotes(query)).lower()
        return CanonicalAction(NETWORK, _h(NETWORK, canon), _h(NETWORK, "search", canon))

    if low in _READ_TOOLS or low in _WRITE_TOOLS:
        kind = FILE_READ if low in _READ_TOOLS else FILE_WRITE
        raw = _first_str(tool_input, _PATH_KEYS)
        if raw is None and low in ("glob", "grep", "ls", "list_dir", "list_directory"):
            raw = "."
        if raw is not None:
            target = _lexical_path(_strip_quotes(raw))
            drop = set(_PATH_KEYS) | (_READ_IGNORED if kind == FILE_READ else {"description"})
            return CanonicalAction(kind, _h(kind, target), _h(kind, low, target, _rest(tool_input, drop)))

    return CanonicalAction(OTHER, _h(OTHER, low), _h(OTHER, low, _canon_json(tool_input)))
