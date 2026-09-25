"""Governance from gaps in real activity: the pure half.

The Agent Governance page leads with what actually went unchecked on this
device, not a checklist of switches. This module holds everything that can
be decided without the database or the file system, so it is testable on
plain data:

- coverage math: transcript tool_use calls matched to governed audit rows by
  tool name and count (the same rule as ``TraceSteps.unchecked`` in the UI,
  applied per session rather than per step);
- the Codex hook-trust check, read-only, on the text of ``config.toml``;
- the gap record shape and its severity rules.

The route (``server/routes/governance.py``) gathers the inputs.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Iterable, Optional

# Tools the Guard hook never sees or has nothing to govern in. Mirror of
# TraceSteps.UNCHECKED_IGNORE (js/components/trace-steps.js): Codex's own
# agent-coordination tools and Claude Code's read-only / UI helpers.
UNCHECKED_IGNORE = frozenset({
    "wait", "wait_agent", "send_message", "list_agents", "interrupt_agent",
    "followup_task", "update_plan", "request_user_input_async",
    "ToolSearch", "AskUserQuestion", "BashOutput", "TaskOutput", "TodoWrite",
    "TodoRead", "EnterPlanMode", "ExitPlanMode",
    # Claude's own agent coordination: messages between its agents and its
    # notification inbox, no effect outside Claude. Agent / Task stay counted.
    "SendMessage", "ListAgents", "ReadNotifications",
})

SEVERITY = {
    "unrecorded_calls": "high",
    "plugin_not_active": "high",
    "codex_hooks_untrusted": "high",
    "egress_uncovered_hosts": "warn",
    "tools_without_rule": "info",
    "approvals_pending": "info",
    "agent_health": "info",  # "warn" when any finding is a failing one
}

_SEVERITY_RANK = {"high": 0, "warn": 1, "info": 2}

HARNESS_LABELS = {
    "claude-code": "Claude Code",
    "codex": "Codex",
    "copilot-cli": "GitHub Copilot CLI",
    "cursor": "Cursor",
    "opencode": "OpenCode",
    "antigravity": "Antigravity",
}

# Harnesses with their own setup guide page; the rest land on Connect Agents.
_GUIDES = {"claude-code", "codex", "copilot-cli", "cursor", "opencode", "antigravity", "openclaw"}


def harness_label(runtime: Optional[str]) -> str:
    r = str(runtime or "")
    return HARNESS_LABELS.get(r, r or "Unknown runtime")


def guide_route(runtime: Optional[str]) -> str:
    r = str(runtime or "")
    return f"guide-{r}" if r in _GUIDES else "guide-connect-agents"


def is_boundary(name: Optional[str]) -> bool:
    """Session markers (``__session_start__`` and the like) are not calls."""
    s = str(name or "")
    return len(s) >= 4 and s.startswith("__") and s.endswith("__")


def same_tool(name: str, function_name: Optional[str], tool_id: Optional[str]) -> bool:
    """Whether a transcript tool name and a governed row name the same tool.
    Port of TraceSteps.sameTool: MCP tools appear as ``mcp__server__tool``
    (older Codex ``server__tool``) in the transcript and as that name or
    ``server:tool`` on the row."""
    n = str(name or "")
    if not n:
        return False
    if function_name == n or tool_id == n:
        return True
    bare = n[5:] if n.startswith("mcp__") else n
    i = bare.find("__")
    if 0 < i < len(bare) - 2:
        colon = f"{bare[:i]}:{bare[i + 2:]}"
        if tool_id == colon or function_name == f"mcp__{bare}":
            return True
    return False


def match_calls(names: Iterable[str], rows: Iterable[dict]) -> tuple[int, int, dict]:
    """(total, governed, unrecorded_by_tool) for one session's window.

    ``names`` are the transcript's tool_use names (repeats kept); ``rows``
    are its governed audit rows ({function_name, tool_id}). Each row covers
    at most one call of the same tool. Ignored tools and boundary rows count
    on neither side."""
    counts: dict = {}
    for n in names:
        n = str(n or "")
        if n and n not in UNCHECKED_IGNORE:
            counts[n] = counts.get(n, 0) + 1
    pool = [r for r in rows
            if not is_boundary(r.get("function_name")) and not is_boundary(r.get("tool_id"))]
    used = [False] * len(pool)
    total = governed = 0
    unrecorded: dict = {}
    for name, count in counts.items():
        covered = 0
        for k, r in enumerate(pool):
            if covered >= count:
                break
            if not used[k] and same_tool(name, r.get("function_name"), r.get("tool_id")):
                used[k] = True
                covered += 1
        total += count
        governed += covered
        if count > covered:
            unrecorded[name] = count - covered
    return total, governed, unrecorded


def pct(governed: int, total: int) -> Optional[float]:
    """Share of calls checked, floored to one decimal and never shown as 100
    unless every call was checked; None when there is nothing to measure
    (never a made-up 100%)."""
    if not total:
        return None
    if governed >= total:
        return 100.0
    return min(99.9, math.floor(1000.0 * governed / total) / 10.0)


# --- Codex hook trust -----------------------------------------------------------

def _snake(event: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", str(event)).lower()


def expected_trust_keys(hooks_json: dict, install_key: str) -> list[str]:
    """The ``[hooks.state."..."]`` keys Codex writes when the user trusts a
    plugin's hooks: ``<plugin>@<marketplace>:hooks/hooks.json:<event>:<i>:<j>``
    with the event in snake_case, ``i`` the matcher group and ``j`` the hook
    inside it (see hooks_codex._HOOK_STATE_PREFIX)."""
    out = []
    hooks = (hooks_json or {}).get("hooks") or {}
    for event, groups in hooks.items():
        for i, group in enumerate(groups or []):
            for j, _hook in enumerate((group or {}).get("hooks") or []):
                out.append(f"{install_key}:hooks/hooks.json:{_snake(event)}:{i}:{j}")
    return out


_HEADER_RE = re.compile(r"^\s*\[([^\[\]].*?)\]\s*(#.*)?$")
_ARRAY_HEADER_RE = re.compile(r"^\s*\[\[.*\]\]\s*(#.*)?$")
_STATE_HEADER_RE = re.compile(r'^hooks\.state\."(.+)"$')
_INLINE_RE = re.compile(r'^\s*"(.+?)"\s*=\s*\{(.*)\}\s*(#.*)?$')


def _toml_state(config_text: str) -> Optional[set]:
    """Trusted keys via a real TOML parser; None when none is available or
    the file does not parse (the line scan then takes over)."""
    try:
        import tomllib  # Python 3.11+
    except ImportError:  # pragma: no cover - 3.10
        try:
            import tomli as tomllib  # type: ignore
        except ImportError:
            return None
    try:
        data = tomllib.loads(config_text)
    except ValueError:
        return None
    hooks = data.get("hooks")
    state = hooks.get("state") if isinstance(hooks, dict) else None
    if not isinstance(state, dict):
        return set()
    return {k for k, v in state.items() if isinstance(v, dict) and v.get("trusted_hash")}


def _scan_state(config_text: str) -> set:
    """Line scan fallback. Uses hooks_codex's multi-line string tracking so
    a header-shaped line inside a triple-quoted value is not a section, and
    treats ``[[...]]`` array headers as section boundaries."""
    from securevector.app.server.routes.hooks_codex import _enter_multiline_string

    found: set = set()
    section = None
    in_ml = False
    for line in config_text.splitlines():
        if in_ml:
            in_ml = _enter_multiline_string(line, in_ml)
            continue
        if _ARRAY_HEADER_RE.match(line):
            section = None
            continue
        h = _HEADER_RE.match(line)
        if h:
            section = h.group(1).strip()
            continue
        in_ml = _enter_multiline_string(line, in_ml)
        if section is None:
            continue
        m = _STATE_HEADER_RE.match(section)
        if m and re.match(r"^\s*trusted_hash\s*=\s*\"[^\"]+\"", line):
            found.add(m.group(1))
        elif section == "hooks.state":
            im = _INLINE_RE.match(line)
            if im and re.search(r"trusted_hash\s*=\s*\"[^\"]+\"", im.group(2)):
                found.add(im.group(1))
    return found


def trusted_keys(config_text: Optional[str]) -> set:
    """Keys under ``[hooks.state]`` that carry a ``trusted_hash``: the table
    form Codex writes (``[hooks.state."key"]`` then ``trusted_hash = ...``)
    or an inline table under ``[hooks.state]``."""
    if not config_text:
        return set()
    parsed = _toml_state(config_text)
    return parsed if parsed is not None else _scan_state(config_text)


def codex_hooks_trust(config_path: Path, hooks_json_path: Path, install_key: str) -> dict:
    """Read-only: are all of the SecureVector plugin's Codex hooks trusted?

    Returns {"trusted", "missing", "expected", "config_found"}. A missing or
    unreadable config means nothing is trusted yet. An unreadable hooks.json
    yields ``trusted: None`` (unknown), never a guess."""
    try:
        hooks_json = json.loads(Path(hooks_json_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"trusted": None, "missing": [], "expected": 0, "config_found": False}
    expected = expected_trust_keys(hooks_json, install_key)
    try:
        text = Path(config_path).read_text(encoding="utf-8")
        config_found = True
    except (OSError, ValueError):
        text, config_found = None, False
    have = trusted_keys(text)
    missing = [k for k in expected if k not in have]
    return {"trusted": bool(expected) and not missing, "missing": missing,
            "expected": len(expected), "config_found": config_found}


# --- gap records ----------------------------------------------------------------

def gap(kind: str, count: int, title: str, detail: str, fix: dict, *,
        key: Optional[str] = None, severity: Optional[str] = None) -> Optional[dict]:
    """One gap row, or None when there is nothing to close (count <= 0)."""
    try:
        n = int(count or 0)
    except (TypeError, ValueError):
        n = 0
    if n <= 0:
        return None
    return {
        "id": f"{kind}:{key}" if key else kind,
        "kind": kind,
        "severity": severity or SEVERITY.get(kind, "info"),
        "title": title,
        "detail": detail,
        "count": n,
        "fix": fix,
    }


def sort_gaps(gaps: Iterable[Optional[dict]]) -> list[dict]:
    kept = [g for g in gaps if g]
    return sorted(kept, key=lambda g: (_SEVERITY_RANK.get(g["severity"], 3), -g["count"]))


def plural(n: int, word: str, many: Optional[str] = None) -> str:
    return f"{n} {word if n == 1 else (many or word + 's')}"


def top_tools(by_tool: dict, k: int = 3) -> str:
    items = sorted(by_tool.items(), key=lambda kv: (-kv[1], kv[0]))[:k]
    return ", ".join(f"{name} x{n}" if n > 1 else name for name, n in items)
