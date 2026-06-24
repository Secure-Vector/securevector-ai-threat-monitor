"""
SecureVector MCP tool: check_tool_permission

Exposes SecureVector's tool-permission governance over MCP so an MCP client
(Claude Desktop and other MCP hosts) can ask the running local app whether a
given tool/function call is allowed before it executes — and have the decision
appended to the tamper-evident audit chain.

The permission *decision* is resolved exactly the way the bundled SDKs and the
OpenClaw hook resolve it: by merging the three policy tiers served by the local
app's REST API, with precedence

    synced (cloud-pushed) > local override > essential registry > default-allow

Audit rows are attributed to ``runtime_kind="mcp"`` so MCP-originated calls are
distinguishable on the Agent Map / Tool Permissions surfaces from SDK and
plugin traffic.

Transport is the stdlib (``urllib``) on purpose — no extra HTTP dependency, and
the same loopback REST surface (``/api/tool-permissions/*``) the SDKs already
use. Everything is best-effort: if the app is not running the tool returns an
``allow`` verdict flagged with ``app_reachable=false`` rather than hard-failing
the MCP host.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import TYPE_CHECKING, Any, Dict, List, Optional

if TYPE_CHECKING:
    from fastmcp import FastMCP

    from ..server import SecureVectorMCPServer

logger = logging.getLogger(__name__)

# Attribution for audit rows emitted by MCP traffic. Mirrors the per-framework
# RUNTIME_KIND the SDKs send; surfaced as "MCP" by the app's _RUNTIME_LABELS map.
RUNTIME_KIND = "mcp"

DEFAULT_APP_URL = "http://127.0.0.1:8741"
_VALID_AUDIT_ACTIONS = ("block", "allow", "log_only")


def _app_base_url() -> str:
    """Resolve the local app base URL, honouring the same env knob the SDKs use."""
    return (
        os.getenv("SECUREVECTOR_SDK_APP_URL")
        or os.getenv("SECUREVECTOR_APP_URL")
        or DEFAULT_APP_URL
    ).rstrip("/")


def _request(method: str, path: str, body: Optional[dict], timeout: float) -> Any:
    url = f"{_app_base_url()}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"}
    # Forward a bearer to remote, token-gated deployments (no-op for the default
    # loopback app, which has no inbound auth).
    api_key = os.getenv("SECUREVECTOR_API_KEY")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (loopback)
        raw = resp.read()
        return json.loads(raw) if raw else {}


def _index(arr: Optional[List[dict]], key: str) -> Dict[str, dict]:
    """Index rows by id with a case-insensitive fallback (exact casing wins),
    mirroring the app's own lookup."""
    out: Dict[str, dict] = {}
    for item in arr or []:
        k = item.get(key)
        if k is not None:
            out.setdefault(str(k).lower(), item)
    for item in arr or []:
        k = item.get(key)
        if k is not None:
            out[str(k)] = item
    return out


def _resolve(tool_id: str, essential: dict, overrides: dict, synced: dict) -> Dict[str, Any]:
    """Merge the three policy tiers exactly like the SDK / OpenClaw hook."""
    name = tool_id
    low = tool_id.lower()
    emap = _index((essential or {}).get("tools"), "tool_id")
    omap = _index((overrides or {}).get("overrides"), "tool_id")
    smap = _index((synced or {}).get("synced"), "tool_id")
    is_essential = name in emap or low in emap

    # 1. Cloud-pushed synced policy wins.
    s = smap.get(name) or smap.get(low)
    if s:
        effect = str(s.get("effect", "")).lower()
        action = "allow" if effect == "allow" else "block"
        policy = s.get("policy_name") or s.get("policy_id") or "synced"
        ver = f" v{s['policy_version']}" if s.get("policy_version") is not None else ""
        return {
            "action": action, "risk": "synced",
            "reason": f"Synced policy '{policy}'{ver}: {effect}",
            "is_essential": is_essential, "tier": "synced",
        }
    # 2. Local user override.
    o = omap.get(name) or omap.get(low)
    if o:
        return {
            "action": o.get("action", "allow"), "risk": "overridden",
            "reason": f"User override: {o.get('action')}",
            "is_essential": is_essential, "tier": "override",
        }
    # 3. Essential registry default.
    e = emap.get(name) or emap.get(low)
    if e:
        return {
            "action": e.get("effective_action") or e.get("default_action") or "allow",
            "risk": e.get("risk", "unknown"),
            "reason": e.get("reason", "Essential tool policy"),
            "is_essential": True, "tier": "essential",
        }
    # 4. Not in registry — allowed by default.
    return {
        "action": "allow", "risk": "unknown",
        "reason": "Not in registry — allowed by default",
        "is_essential": False, "tier": "default",
    }


def _record_audit(verdict: Dict[str, Any], tool_id: str, function_name: Optional[str],
                  args_preview: Optional[str], session_id: Optional[str], timeout: float) -> bool:
    act = verdict["action"] if verdict["action"] in _VALID_AUDIT_ACTIONS else "log_only"
    body = {
        "tool_id": tool_id,
        "function_name": function_name or tool_id,
        "action": act,
        "risk": verdict.get("risk"),
        "reason": verdict.get("reason"),
        "is_essential": bool(verdict.get("is_essential")),
        "args_preview": (str(args_preview)[:2048] if args_preview else None),
        "runtime_kind": RUNTIME_KIND,
        "session_id": session_id,
    }
    try:
        _request("POST", "/api/tool-permissions/call-audit", body, timeout)
        return True
    except Exception as exc:  # never let audit failure break the host
        logger.debug("MCP tool-permission audit post failed: %s", exc)
        return False


def setup_tool_permissions_tool(mcp: "FastMCP", server: "SecureVectorMCPServer"):
    """Register the check_tool_permission MCP tool."""

    @mcp.tool()
    async def check_tool_permission(
        tool_id: str,
        function_name: Optional[str] = None,
        args_preview: Optional[str] = None,
        session_id: Optional[str] = None,
        record: bool = True,
    ) -> Dict[str, Any]:
        """
        Check whether a tool/function call is permitted by SecureVector policy,
        and (by default) append the decision to the tamper-evident audit chain.

        Resolves the decision against the local SecureVector app exactly as the
        SecureVector SDKs and the OpenClaw hook do — merging cloud-synced policy,
        local user overrides, and the essential-tool registry (in that order of
        precedence). Use this before executing a sensitive tool so blocked calls
        never run, and so every call is recorded for replay/audit.

        Args:
            tool_id: Canonical tool identifier to check (e.g. "WebFetch",
                "filesystem.write", "shell.exec"). Required.
            function_name: Human-facing function name for the audit row
                (defaults to tool_id).
            args_preview: Short, redaction-safe preview of the call arguments to
                store on the audit row (truncated to 2KB; do not pass secrets).
            session_id: Conversation/session id to group calls on the Agent Map.
            record: When True (default), append a call-audit row attributed to
                runtime_kind="mcp". Set False for a dry-run policy lookup.

        Returns:
            Dict containing:
            - allowed: Boolean — True unless the resolved action is "block".
            - action: "allow" | "block" (the resolved policy effect).
            - tier: which policy tier decided it — "synced" | "override" |
              "essential" | "default".
            - risk: risk label associated with the decision.
            - reason: human-readable explanation of the decision.
            - is_essential: whether the tool is in the essential registry.
            - tool_id: echoed back.
            - audited: whether the decision was written to the audit chain.
            - app_reachable: False if the local app could not be reached (in
              which case the call is allowed by default — fail-open, flagged).
        """
        start = time.time()
        timeout = max(getattr(server.config.performance, "request_timeout_seconds", 5) or 5, 1)

        try:
            essential = _request("GET", "/api/tool-permissions/essential", None, timeout) or {}
            overrides = _request("GET", "/api/tool-permissions/overrides", None, timeout) or {}
            synced = _request(
                "GET",
                "/api/tool-permissions/synced-overrides?"
                + urllib.parse.urlencode({"runtime": RUNTIME_KIND}),
                None, timeout,
            ) or {}
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
            logger.warning("check_tool_permission: app unreachable (%s) — failing open", exc)
            return {
                "allowed": True, "action": "allow", "tier": "default",
                "risk": "unknown",
                "reason": "Local SecureVector app unreachable — allowed by default",
                "is_essential": False, "tool_id": tool_id,
                "audited": False, "app_reachable": False,
                "analysis_time_ms": int((time.time() - start) * 1000),
            }

        verdict = _resolve(tool_id, essential, overrides, synced)
        audited = False
        if record:
            audited = _record_audit(
                verdict, tool_id, function_name, args_preview, session_id, timeout
            )

        return {
            "allowed": verdict["action"] != "block",
            "action": verdict["action"],
            "tier": verdict["tier"],
            "risk": verdict.get("risk"),
            "reason": verdict.get("reason"),
            "is_essential": verdict.get("is_essential"),
            "tool_id": tool_id,
            "audited": audited,
            "app_reachable": True,
            "analysis_time_ms": int((time.time() - start) * 1000),
        }

    return check_tool_permission
