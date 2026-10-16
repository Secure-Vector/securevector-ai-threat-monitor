"""Pre-flight policy routes for the SecureVector MCP tools.

`POST /api/policy/check` answers "will this tool call be allowed?" and
`GET /api/policy/burn` answers "what has this session used so far?". The
caller is the SecureVector MCP process, which sends the launched task's
X-SV-Terminal-Task / X-SV-Terminal-Hook headers when it has them.
`POST /api/policy/attempt` is the Guard hook's report of a tool call it
decided without the egress check, so pre-flight decisions for every tool
can be matched. The `/api/policy` prefix is in the control-API path set, so
an agent cannot reach these routes through a tool call.

Every outcome of a check is a decision in a fixed shape: bad input is
`indeterminate`/`unsupported_action`, and any failure is
`indeterminate`/`unavailable`. Requests from a browser page on another
origin, and JSON posts without a JSON content type, are refused.
"""

from __future__ import annotations

import json
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Request

from securevector.app.database.connection import get_database
from securevector.app.services import mcp_registration, policy_check
from securevector.app.terminals.auth import _LOOPBACK

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/policy", tags=["Pre-flight Policy"])

_MAX_BODY = 64 * 1024
_MAX_ATTEMPT_BODY = 256 * 1024


def _manager(request: Request):
    return getattr(getattr(request.app, "state", None), "terminal_manager", None)


def _app_port(request: Request) -> Optional[int]:
    try:
        return int(request.url.port) if request.url.port else None
    except Exception:  # noqa: BLE001
        return None


def _require_local(request: Request, *, json_body: bool = False) -> None:
    """Loopback Host when the app knows its port; an Origin, when one is
    sent, must be this app's own; a POST must declare JSON."""
    port = getattr(getattr(request.app, "state", None), "port", None)
    headers = request.headers
    if isinstance(port, int) and port > 0:
        if headers.get("host", "") not in {f"{h}:{port}" for h in _LOOPBACK}:
            raise HTTPException(status_code=403, detail="Forbidden")
        allowed = {f"http://{h}:{port}" for h in _LOOPBACK}
    else:
        allowed = None
    origin = headers.get("origin")
    if origin is not None:
        if allowed is not None and origin not in allowed:
            raise HTTPException(status_code=403, detail="Forbidden")
        if allowed is None and not any(origin.startswith(f"http://{h}:") for h in _LOOPBACK):
            raise HTTPException(status_code=403, detail="Forbidden")
    if json_body:
        ctype = (headers.get("content-type") or "").split(";", 1)[0].strip().lower()
        if ctype != "application/json":
            raise HTTPException(status_code=415, detail="Expected application/json")


async def _json(request: Request, cap: int) -> Optional[dict]:
    try:
        raw = await request.body()
        body = json.loads(raw) if raw and len(raw) <= cap else None
    except (ValueError, UnicodeDecodeError):
        body = None
    return body if isinstance(body, dict) else None


@router.post("/check")
async def check_policy(request: Request):
    """Decide one harness-native tool call before it is attempted."""
    _require_local(request, json_body=True)
    body = await _json(request, _MAX_BODY)
    if body is None:
        return policy_check.response(policy_check.INDETERMINATE, policy_check.R_UNSUPPORTED, session=None)
    try:
        db = get_database()
        caller = await policy_check.caller_from_headers(
            _manager(request), request.headers, body.get("harness"), body.get("cwd"))
    except Exception as e:  # noqa: BLE001 - unavailable, never allow
        logger.warning("Pre-flight check setup failed: %s", type(e).__name__)
        return policy_check.response(policy_check.INDETERMINATE, policy_check.R_UNAVAILABLE, session=None)
    return await policy_check.check(
        db, caller, body.get("tool_name"), body.get("tool_input"), body.get("session"),
        app_port=_app_port(request), origin_git_host=body.get("origin_git_host"),
        mcp_endpoint=body.get("mcp_endpoint"),
    )


@router.post("/attempt")
async def report_attempt(request: Request):
    """A tool call the Guard decided without an egress check (a name-based
    deny or ask, or a call that cannot reach the network). Matched against
    recent pre-flight checks for metrics only; nothing here changes a
    verdict. Always answers {"ok": true}."""
    _require_local(request, json_body=True)
    body = await _json(request, _MAX_ATTEMPT_BODY)
    if body is None or not isinstance(body.get("tool_name"), str):
        return {"ok": True}
    try:
        from securevector.app.server.routes.egress import _session_binding

        session_id = body.get("session_id") if isinstance(body.get("session_id"), str) else None
        audit_session, verified = await _session_binding(request, session_id)
        task_id = (request.headers.get("x-sv-terminal-task") or None) if verified else None
        runtime = body.get("runtime_kind") if isinstance(body.get("runtime_kind"), str) else None
        await policy_check.consume_for_call(
            get_database(), body["tool_name"], body.get("tool_input") or {},
            task_id=task_id, verified=verified, harness=runtime, harness_session_id=audit_session,
        )
    except Exception as e:  # noqa: BLE001 - metrics only
        logger.warning("Pre-flight attempt report skipped: %s", type(e).__name__)
    return {"ok": True}


@router.get("/burn")
async def session_burn(request: Request, session: Optional[str] = None, harness: Optional[str] = None):
    """Tokens and cost so far for the caller's own logical session."""
    _require_local(request)
    try:
        caller = await policy_check.caller_from_headers(_manager(request), request.headers, harness, None)
        return await policy_check.burn(get_database(), caller, session)
    except Exception as e:  # noqa: BLE001
        logger.warning("Session burn route failed: %s", type(e).__name__)
        return policy_check._burn_unavailable(None)


@router.get("/mcp-registration")
async def mcp_registration_status(request: Request, harness: Optional[str] = None):
    """Whether each harness has the SecureVector MCP tools registered:
    registered, not_registered, unavailable or other_entry, with a label."""
    _require_local(request)
    return {"harnesses": mcp_registration.status([harness] if harness else None)}


# --- governed delegation -------------------------------------------------------------

_NOT_VERIFIED = "Delegation is available only to a task SecureVector launched."


async def _delegation_caller(request: Request):
    caller = await policy_check.caller_from_headers(_manager(request), request.headers, None, None)
    if not caller.verified or not caller.task_id:
        raise HTTPException(status_code=403, detail=_NOT_VERIFIED)
    return caller


@router.post("/delegate")
async def delegate(request: Request):
    """Ask SecureVector to start another task on a folder with a prompt.
    Only an app-launched task, by its own hook token, may ask. Every
    request that passes the checks starts at once for the same harness and
    waits for a person's approval for another harness."""
    _require_local(request, json_body=True)
    body = await _json(request, _MAX_BODY)
    caller = await _delegation_caller(request)
    if body is None:
        raise HTTPException(status_code=400, detail="Expected a JSON object")
    from securevector.app.services import delegation

    manager = _manager(request)
    if manager is None:
        raise HTTPException(status_code=503, detail="Agent Terminals is not running")
    return await delegation.request_delegation(
        get_database(), manager, caller, body.get("folder"), body.get("prompt"), body.get("harness"),
        app_port=_app_port(request),
    )


@router.get("/delegations/{delegation_id}")
async def delegation_result(delegation_id: str, request: Request):
    """The state and, when done, the result of the caller's own delegation."""
    _require_local(request)
    caller = await _delegation_caller(request)
    from securevector.app.services import delegation

    found = await delegation.get_for_caller(get_database(), _manager(request), caller, delegation_id)
    if found is None:
        raise HTTPException(status_code=404, detail="No such delegation")
    return found
