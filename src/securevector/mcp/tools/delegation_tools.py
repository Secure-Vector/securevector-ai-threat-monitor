"""
SecureVector MCP tools: delegate and delegation_result.

Thin clients of the running local app over loopback HTTP
(`/api/policy/delegate`, `/api/policy/delegations/{id}`), with the same
request helper and terminal headers as check_policy. Only a task the app
launched can delegate; the app runs its checks, and a delegation to another
harness waits for a person's approval.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import asyncio
import logging
import re
import time
import urllib.error
import urllib.parse
from typing import TYPE_CHECKING, Annotated, Any, Callable, Dict, Optional

from .policy_tools import _harness, _request

if TYPE_CHECKING:
    from fastmcp import FastMCP

    from ..server import SecureVectorMCPServer

logger = logging.getLogger(__name__)

POLL_INTERVAL_S = 2.0
MAX_TIMEOUT_S = 3600
_ID_RE = re.compile(r"^dlg_[0-9a-f]{20}$")
_STATES = ("pending_approval", "refused", "running", "done", "held", "failed")
_FIELDS = ("delegation_id", "state", "harness", "folder", "child_task_id", "reason", "result",
           "warnings", "exit_code", "child_status", "result_pending")
_FINAL = ("refused", "done", "held", "failed")

DELEGATE_DESCRIPTION = (
    "Start a second agent session on a task, governed by SecureVector, and get its answer. "
    "It runs in the same harness as you unless you name another; another harness works only if the "
    "user enabled cross-harness delegation, and then waits for their approval. folder must be inside "
    "your current folder. With wait=true the call returns when the task ends or timeout_s passes; "
    "otherwise poll delegation_result with the returned delegation_id. "
    "Claude Code and Codex return the session's final message; other harnesses return the exit status "
    "and ask the user to see the child pane. If state is refused or failed, tell the user the reason. "
    "If it is pending_approval or waiting_for_user, tell the user to act in SecureVector or the child pane."
)
DELEGATION_RESULT_DESCRIPTION = (
    "State and result of a delegation you started, by delegation_id. "
    "running: still working. done: result holds the final message (or an exit summary). "
    "held: the result matched a detection rule and waits for the user to release it in SecureVector. "
    "pending_approval or waiting_for_user: the user must act; reason says where. "
    "result_pending: done, and the final message is still being read; call again shortly. "
    "refused or failed: tell the user the reason."
)
PARAM_FOLDER = "Folder for the new session, inside your current folder."
PARAM_PROMPT = "The task for the new session, in plain words (at most 4000 characters)."
PARAM_HARNESS = "claude-code, codex, copilot-cli or opencode; defaults to your own harness."
PARAM_WAIT = "true to wait for the result; false to return at once and poll delegation_result."
PARAM_TIMEOUT = "With wait=true, the most seconds to wait (up to 3600)."
PARAM_ID = "The delegation_id that delegate returned."


def _final(answer: Dict[str, Any]) -> bool:
    """Ended, and not a result still being read."""
    return answer.get("state") in _FINAL and not answer.get("result_pending")


def _unavailable(delegation_id: Optional[str] = None, reason: str = "SecureVector is unavailable.") -> Dict[str, Any]:
    return {"delegation_id": delegation_id, "state": "failed", "harness": None, "folder": None,
            "child_task_id": None, "reason": reason, "result": None}


def _shape(answer: Any, delegation_id: Optional[str] = None) -> Dict[str, Any]:
    if not isinstance(answer, dict) or answer.get("state") not in _STATES:
        return _unavailable(delegation_id)
    return {k: answer.get(k) for k in _FIELDS if k in answer}


def _call(method: str, path: str, body: Optional[dict], delegation_id: Optional[str] = None) -> Dict[str, Any]:
    try:
        return _shape(_request(method, path, body), delegation_id)
    except urllib.error.HTTPError as exc:
        if exc.code == 403:
            return _unavailable(delegation_id, "Delegation is available only to a task SecureVector launched.")
        if exc.code == 404:
            return _unavailable(delegation_id, "No such delegation.")
        return _unavailable(delegation_id)
    except (urllib.error.URLError, OSError, ValueError, ConnectionError) as exc:
        logger.debug("delegation: app unavailable (%s)", type(exc).__name__)
        return _unavailable(delegation_id)


def delegation_result_call(delegation_id: Any) -> Dict[str, Any]:
    """One read, synchronously. Never raises."""
    if not isinstance(delegation_id, str) or not _ID_RE.match(delegation_id):
        return _unavailable(None, "Unknown delegation_id.")
    return _call("GET", "/api/policy/delegations/" + urllib.parse.quote(delegation_id), None, delegation_id)


def delegate_call(folder: Any, prompt: Any, harness: Any = None, wait: bool = False, timeout_s: Any = 600, *,
                  sleep: Callable[[float], None] = time.sleep,
                  clock: Callable[[], float] = time.monotonic) -> Dict[str, Any]:
    """Ask for a delegation and, with wait, poll until it ends. Never raises."""
    if not isinstance(folder, str) or not folder or not isinstance(prompt, str) or not prompt:
        return _unavailable(None, "folder and prompt are required.")
    body = {"folder": folder, "prompt": prompt,
            "harness": harness if isinstance(harness, str) and harness else _harness()}
    answer = _call("POST", "/api/policy/delegate", body)
    if not wait or _final(answer) or not answer.get("delegation_id"):
        return answer
    try:
        limit = max(0.0, min(float(timeout_s), float(MAX_TIMEOUT_S)))
    except (TypeError, ValueError):
        limit = 600.0
    deadline = clock() + limit
    while clock() < deadline:
        sleep(min(POLL_INTERVAL_S, max(0.0, deadline - clock())))
        answer = delegation_result_call(answer["delegation_id"])
        if _final(answer):
            return answer
    return answer


def setup_delegation_tools(mcp: "FastMCP", server: "SecureVectorMCPServer", names) -> None:
    """Register delegate and/or delegation_result."""
    from pydantic import Field

    if "delegate" in names:
        @mcp.tool(name="delegate", description=DELEGATE_DESCRIPTION)
        async def delegate(
            folder: Annotated[str, Field(description=PARAM_FOLDER)],
            prompt: Annotated[str, Field(description=PARAM_PROMPT)],
            harness: Annotated[Optional[str], Field(description=PARAM_HARNESS)] = None,
            wait: Annotated[bool, Field(description=PARAM_WAIT)] = False,
            timeout_s: Annotated[int, Field(description=PARAM_TIMEOUT)] = 600,
        ) -> Dict[str, Any]:
            return await asyncio.to_thread(delegate_call, folder, prompt, harness, wait, timeout_s)

    if "delegation_result" in names:
        @mcp.tool(name="delegation_result", description=DELEGATION_RESULT_DESCRIPTION)
        async def delegation_result(
            delegation_id: Annotated[str, Field(description=PARAM_ID)],
        ) -> Dict[str, Any]:
            return await asyncio.to_thread(delegation_result_call, delegation_id)
