"""
SecureVector MCP tools: check_policy and session_burn.

Both are thin clients of the running local app over loopback HTTP
(`/api/policy/check`, `/api/policy/burn`). The app decides; this process
only forwards the call exactly as the harness would send it, plus the
launched task's terminal headers when it has them, the harness name and
its working folder.

The app URL must be a loopback address; anything else, and any failure to
reach the app, answers `indeterminate`, never `allow`.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import asyncio
import json
import logging
import os
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from typing import TYPE_CHECKING, Any, Dict, Optional

if TYPE_CHECKING:
    from fastmcp import FastMCP

    from ..server import SecureVectorMCPServer

logger = logging.getLogger(__name__)

DEFAULT_APP_URL = "http://127.0.0.1:8741"
TIMEOUT_S = 5.0
_LOOPBACK = ("127.0.0.1", "localhost", "::1")
_DECISIONS = ("allow", "deny", "needs_approval", "indeterminate")
_REASONS = ("allowed", "blocked_by_policy", "approval_required", "unavailable", "unsupported_action")
_FIELDS = ("decision", "reason", "policy_version", "token", "expires_at", "session", "advisory")

CHECK_POLICY_DESCRIPTION = (
    "Ask SecureVector whether a tool call will be allowed before you make it. "
    "Call it before a shell, network, file write or MCP action you are unsure of. "
    "Pass tool_name and tool_input exactly as you would send the call. "
    "decision is allow, deny, needs_approval or indeterminate. A deny means do not attempt "
    "the action. needs_approval means a person must approve it in SecureVector first. "
    "indeterminate means SecureVector could not answer; treat it as not allowed. "
    "The call itself is still checked when you make it."
)
SESSION_BURN_DESCRIPTION = (
    "Tokens and cost used so far in this session, from SecureVector. Token counts are exact "
    "for Claude Code; cost_usd is a list-price estimate when cost_basis is estimate; figures "
    "can lag by up to 30 seconds. available is false when this session is not linked to a "
    "harness session. Returns counts only, no content and no file names."
)

# The logical session handle the app minted for this process.
_state: Dict[str, Optional[str]] = {"session": None}


def app_base_url() -> Optional[str]:
    """The app URL from the environment, or None when it is not loopback."""
    raw = (os.getenv("SECUREVECTOR_APP_URL") or DEFAULT_APP_URL).strip().rstrip("/")
    try:
        parts = urllib.parse.urlsplit(raw)
    except ValueError:
        return None
    if parts.scheme != "http" or (parts.hostname or "") not in _LOOPBACK:
        return None
    return raw


def _headers() -> Dict[str, str]:
    headers = {"Content-Type": "application/json"}
    task = (os.getenv("SV_TERMINAL_TASK_ID") or "").strip()
    token = (os.getenv("SV_TERMINAL_HOOK_TOKEN") or "").strip()
    if task and token:
        headers["X-SV-Terminal-Task"] = task
        headers["X-SV-Terminal-Hook"] = token
    return headers


def _request(method: str, path: str, body: Optional[dict]) -> Any:
    base = app_base_url()
    if base is None:
        raise ConnectionError("app URL is not loopback")
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method, headers=_headers())
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:  # noqa: S310 (loopback only)
        raw = resp.read(64 * 1024)
        return json.loads(raw) if raw else {}


def _unavailable(reason: str = "unavailable") -> Dict[str, Any]:
    return {"decision": "indeterminate", "reason": reason, "policy_version": None, "token": None,
            "expires_at": None, "session": _state["session"], "advisory": False}


def _shape(answer: Any) -> Dict[str, Any]:
    """Pass through only a well-formed decision; anything else is unavailable."""
    if not isinstance(answer, dict) or answer.get("decision") not in _DECISIONS \
            or answer.get("reason") not in _REASONS:
        return _unavailable()
    out = {k: answer.get(k) for k in _FIELDS}
    out["advisory"] = False
    if isinstance(out.get("session"), str):
        _state["session"] = out["session"]
    return out


_origin_cache: Dict[str, Optional[str]] = {}
_SCP_RE = re.compile(r"^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):")


def origin_git_host(cwd: Optional[str]) -> Optional[str]:
    """Host of the folder's `origin` remote, read from git's own config (no
    network), for the foreign-remote rule. None when there is none."""
    if not cwd:
        return None
    if cwd in _origin_cache:
        return _origin_cache[cwd]
    host = None
    try:
        out = subprocess.run(["git", "-C", cwd, "config", "--get", "remote.origin.url"],
                             capture_output=True, text=True, timeout=1.0, check=False)
        url = (out.stdout or "").strip()
        m = _SCP_RE.match(url)
        if m:
            host = m.group(1)
        elif "://" in url:
            host = urllib.parse.urlsplit(url).hostname
    except (OSError, subprocess.SubprocessError, ValueError):
        host = None
    _origin_cache[cwd] = host.lower() if host else None
    return _origin_cache[cwd]


def _harness() -> Optional[str]:
    return (os.getenv("SECUREVECTOR_MCP_HARNESS") or "").strip() or None


def check_policy_call(tool_name: Any, tool_input: Any, session: Optional[str] = None) -> Dict[str, Any]:
    """One check, synchronously. Never raises."""
    if not isinstance(tool_name, str) or not tool_name or (tool_input is not None and not isinstance(tool_input, dict)):
        return _unavailable("unsupported_action")
    try:
        cwd = os.getcwd()
    except OSError:
        cwd = None
    body = {
        "tool_name": tool_name,
        "tool_input": tool_input or {},
        "session": session or _state["session"],
        "harness": _harness(),
        "cwd": cwd,
        "origin_git_host": origin_git_host(cwd),
    }
    try:
        return _shape(_request("POST", "/api/policy/check", body))
    except (urllib.error.URLError, OSError, ValueError, ConnectionError) as exc:
        logger.debug("check_policy: app unavailable (%s)", type(exc).__name__)
        return _unavailable()


def session_burn_call(session: Optional[str] = None) -> Dict[str, Any]:
    """Usage for this process's session, synchronously. Never raises."""
    handle = session or _state["session"]
    empty = {"session": handle, "available": False,
             "tokens": {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0},
             "calls": 0, "cost_usd": None, "cost_basis": None, "by_model": [], "since": None, "lag_s": None}
    query = {"session": handle} if handle else {}
    if _harness():
        query["harness"] = _harness()
    try:
        answer = _request("GET", "/api/policy/burn?" + urllib.parse.urlencode(query), None)
    except (urllib.error.URLError, OSError, ValueError, ConnectionError) as exc:
        logger.debug("session_burn: app unavailable (%s)", type(exc).__name__)
        return empty
    if not isinstance(answer, dict) or "available" not in answer:
        return empty
    if isinstance(answer.get("session"), str):
        _state["session"] = answer["session"]
    return answer


def setup_policy_tools(mcp: "FastMCP", server: "SecureVectorMCPServer", names) -> None:
    """Register check_policy and/or session_burn."""
    if "check_policy" in names:
        @mcp.tool(name="check_policy", description=CHECK_POLICY_DESCRIPTION)
        async def check_policy(tool_name: str, tool_input: Optional[Dict[str, Any]] = None,
                               session: Optional[str] = None) -> Dict[str, Any]:
            return await asyncio.to_thread(check_policy_call, tool_name, tool_input, session)

    if "session_burn" in names:
        @mcp.tool(name="session_burn", description=SESSION_BURN_DESCRIPTION)
        async def session_burn(session: Optional[str] = None) -> Dict[str, Any]:
            return await asyncio.to_thread(session_burn_call, session)
