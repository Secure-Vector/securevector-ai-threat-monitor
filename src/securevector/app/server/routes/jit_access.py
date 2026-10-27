"""
JIT (just-in-time) tool access API.

POST /api/jit/requests               - file a request (agent-callable, via Guard hooks)
GET  /api/jit/requests               - list requests (approval queue UI)
POST /api/jit/requests/{id}/approve  - approve + mint a time-boxed grant (UI only)
POST /api/jit/requests/{id}/deny     - deny (UI only)
GET  /api/jit/grants                 - list grants (UI)
POST /api/jit/grants/{id}/revoke     - revoke an active grant early (UI only)
GET  /api/jit/ui-token               - per-run token the web UI attaches to decisions

Legal/UX boundaries from the idea page's pre-implementation review:

- **Hard denies never queue.** A request is accepted only when the tool is
  currently denied by a rule that allows requesting: a synced rule with
  requestable=1, or a local Block (the approver owns local rules). A synced
  deny without requestable=1 is an org decision — creation returns 403 and
  nothing enters the queue.
- **Human-only approval.** Approve/deny/revoke require the per-run UI token
  (X-SV-UI-Token header) that only the web UI fetches and attaches. Guard
  plugins never call /ui-token; the create endpoint is the only JIT surface
  meant for agents. The token is minted fresh per server run.
- **Time-boxed only.** Durations are 15m / 1h / session — no unbounded grant.
- **Justification is data, never markup.** Stored truncated; the UI renders
  it inert (textContent).
"""

import logging
import secrets
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.jit_access import JitAccessRepository
from securevector.app.database.repositories.settings import SettingsRepository
from securevector.app.database.repositories.tool_permissions import (
    ToolPermissionsRepository,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# Per-run decision token. Regenerated every server start; fetched by the web
# UI on load and attached to approve/deny/revoke calls. This keeps the
# decision endpoints out of the "just POST to localhost" reach of an agent
# that was never told about them — it would have to deliberately fetch the
# token first, which no Guard plugin does and which the audit trail would
# show. (A local process determined to subvert its own machine's guard can —
# the meaningful boundary for JIT is that *SecureVector's agent surface*
# cannot approve.)
_UI_TOKEN = secrets.token_hex(16)

# Per-run page cookie: set on the served web UI page (HttpOnly,
# SameSite=Strict), and required, with the same-origin checks below, before
# /jit/ui-token hands out the token.
UI_PAGE_COOKIE = "sv_ui_page"
UI_PAGE_COOKIE_PATH = "/api/jit"
_UI_PAGE_SECRET = secrets.token_hex(24)


def set_ui_page_cookie(response):
    """Attach the page cookie to a response that serves the web UI page."""
    response.set_cookie(UI_PAGE_COOKIE, _UI_PAGE_SECRET, httponly=True, samesite="strict",
                        path=UI_PAGE_COOKIE_PATH)
    return response


def _ui_page_cookie_ok(request: Request) -> bool:
    value = request.cookies.get(UI_PAGE_COOKIE)
    if not value:
        return False
    return secrets.compare_digest(value.encode("utf-8", "surrogateescape"), _UI_PAGE_SECRET.encode("utf-8"))


def _require_ui_token(token: Optional[str]) -> None:
    if not isinstance(token, str) or not token or not secrets.compare_digest(
        token.encode("utf-8", "surrogateescape"), _UI_TOKEN.encode("utf-8")
    ):
        raise HTTPException(
            status_code=403,
            detail="JIT decisions require the local web UI (missing/invalid UI token)",
        )


class JitRequestCreate(BaseModel):
    """Agent-side request creation payload."""

    tool_id: str = Field(..., min_length=1, max_length=200)
    function_name: Optional[str] = Field(None, max_length=300)
    runtime_kind: Optional[str] = Field(None, max_length=40)
    session_id: Optional[str] = Field(None, max_length=128)
    trace_id: Optional[str] = Field(None, max_length=64)
    justification: Optional[str] = Field(None, max_length=500)


class JitApprove(BaseModel):
    # 'once' lifts one exact held call in its session; only requests whose
    # call the server held with its arguments can take it (else 422).
    duration: str = Field(..., pattern="^(15m|1h|session|once)$")


class JitDeny(BaseModel):
    reason: Optional[str] = Field(None, max_length=200)


async def _denying_rule(db, tool_id: str) -> Optional[dict]:
    """The rule currently denying tool_id, or None if it isn't denied.

    Returns {"source": "synced"|"local", "requestable": bool}. Mirrors the
    /synced-overrides precedence: synced (priority 100) wins over local (50).
    Matches both the full `server:tool` id and the bare suffix alias.
    """
    suffix = tool_id.split(":", 1)[1] if ":" in tool_id else tool_id
    row = await db.fetch_one(
        "SELECT effect, requestable FROM synced_tool_rules "
        "WHERE tool_id IN (?, ?) OR tool_id LIKE '%:' || ? "
        "ORDER BY priority DESC LIMIT 1",
        (tool_id, suffix, suffix),
    )
    if row:
        if row["effect"] != "deny":
            return None  # synced allow/prompt outranks any local block
        return {"source": "synced", "requestable": bool(row["requestable"])}

    local_repo = ToolPermissionsRepository(db)
    override = await local_repo.get_override(tool_id) or await local_repo.get_override(suffix)
    if override and override.get("action") == "block":
        # Local blocks are implicitly requestable — the human who approves
        # the request is the same human who authored the rule.
        return {"source": "local", "requestable": True}
    return None


_LOOPBACK_NAMES = ("127.0.0.1", "localhost", "[::1]")
_DESKTOP_UA_TOKEN = "SecureVectorDesktop"  # desktop_shell.DESKTOP_USER_AGENT_TOKEN


def _browser_same_origin(request: Request) -> bool:
    """True when the request looks like the app's own page asking.

    A same-origin browser fetch carries `Sec-Fetch-Site: same-origin`, or an
    Origin / Referer on the app's own loopback origin; the desktop shell's
    web view is recognised by its user-agent token. The Guard's
    `sv.self.control_api` egress rule applies to agent tool calls that name
    the control API on loopback as well.
    """
    h = request.headers
    if h.get("sec-fetch-site") == "same-origin":
        return True
    port = request.url.port
    origins = {f"http://{n}:{port}" for n in _LOOPBACK_NAMES} if port else set()
    origin = h.get("origin")
    if origin and origin in origins:
        return True
    referer = h.get("referer") or ""
    if any(referer == o or referer.startswith(o + "/") for o in origins):
        return True
    return _DESKTOP_UA_TOKEN in (h.get("user-agent") or "")


LOCAL_ONLY_DETAIL = "Approvals answer only on this machine (localhost)"


def _loopback_ip(host: Optional[str]) -> bool:
    """127.0.0.0/8, ::1 or an IPv4-mapped 127.x address."""
    import ipaddress

    try:
        ip = ipaddress.ip_address(str(host or "").strip())
    except ValueError:
        return False
    mapped = getattr(ip, "ipv4_mapped", None)
    return (mapped or ip).is_loopback


def _loopback_host_header(value: Optional[str]) -> bool:
    """Host header naming this machine: localhost, 127.0.0.1 or [::1], with
    an optional port."""
    v = str(value or "").strip().lower()
    if v.startswith("["):
        end = v.find("]")
        if end < 0:
            return False
        name, rest = v[: end + 1], v[end + 1:]
    else:
        name, _, port = v.partition(":")
        rest = ":" + port if port else ""
    port = rest[1:]
    if rest and not (rest.startswith(":") and port.isascii() and port.isdigit()):
        return False
    return name in _LOOPBACK_NAMES


def _asked_on_this_machine(request: Request) -> bool:
    client = getattr(request, "client", None)
    return _loopback_ip(client.host if client else None) and _loopback_host_header(request.headers.get("host"))


@router.get("/jit/ui-token")
async def get_ui_token(request: Request):
    """Per-run token the web UI attaches to decision calls. Handed out only
    to the page opened on this machine: a loopback peer and a loopback Host."""
    if not _asked_on_this_machine(request):
        raise HTTPException(status_code=403, detail=LOCAL_ONLY_DETAIL)
    if not _browser_same_origin(request) or not _ui_page_cookie_ok(request):
        raise HTTPException(status_code=403, detail="The UI token is for the local web UI only")
    # The page asking is not a governed task: same check the decisions run.
    from securevector.app.services import decisions
    await decisions.refuse_governed_caller(request)
    return {"token": _UI_TOKEN}


@router.post("/jit/requests")
async def create_request(body: JitRequestCreate, http_request: Request = None):
    """File a JIT access request (the agent-facing surface)."""
    # Host approvals are filed by the egress evaluator itself, for a block it
    # just decided.
    # Delegation approvals are filed by the delegate route, after its checks.
    if body.tool_id.startswith("delegate:"):
        raise HTTPException(
            status_code=403,
            detail={"error": "not_requestable",
                    "message": "Delegation approvals are filed by the delegate tool, "
                               "not requested directly."},
        )
    if body.tool_id.startswith("egress:"):
        raise HTTPException(
            status_code=403,
            detail={"error": "not_requestable",
                    "message": "Egress host approvals are filed by the egress check, "
                               "not requested directly."},
        )
    try:
        db = get_database()

        settings = await SettingsRepository(db).get()
        if not settings.tool_permissions_enabled:
            raise HTTPException(
                status_code=409,
                detail={"error": "enforcement_disabled",
                        "message": "Tool permission enforcement is off — nothing is denied."},
            )

        rule = await _denying_rule(db, body.tool_id)
        if rule is None:
            # A tool no rule denies may still be held by the session's
            # response rung (rung 3, active mode); the rung files it.
            from securevector.app.services import response_rungs
            if body.session_id and await response_rungs.holds_tool(db, body.session_id, body.tool_id):
                req = await response_rungs.file_request(
                    db, body.tool_id, body.function_name, body.runtime_kind, body.session_id)
                if req is not None:
                    return {"request": req}
                raise HTTPException(
                    status_code=429,
                    detail={"error": "queue_full",
                            "message": "The approval queue is full; try again later."},
                )
            # A call the Guard held under a named call-time rule.
            # Only for a session the Guard proved with its task's hook token.
            from securevector.app.server.routes.egress import _session_binding
            from securevector.app.services import call_rules
            _bound, verified = await _session_binding(http_request, body.session_id)
            handled, req = await call_rules.file_marker_hold(
                db, body.session_id, body.tool_id, body.function_name, body.runtime_kind, verified=verified)
            if handled:
                if req is not None:
                    return {"request": req}
                raise HTTPException(
                    status_code=429,
                    detail={"error": "queue_full",
                            "message": "The approval queue is full; try again later."},
                )
            raise HTTPException(
                status_code=409,
                detail={"error": "not_denied",
                        "message": "This tool is not currently denied; no request is needed."},
            )
        if not rule["requestable"]:
            # Org hard deny — never queue, never overridable locally.
            raise HTTPException(
                status_code=403,
                detail={"error": "not_requestable",
                        "message": "This deny is an organization policy and cannot be "
                                   "requested. Contact your policy admin."},
            )

        repo = JitAccessRepository(db)
        req = await repo.create_request(
            tool_id=body.tool_id,
            rule_source=rule["source"],
            function_name=body.function_name,
            runtime_kind=body.runtime_kind,
            session_id=body.session_id,
            trace_id=body.trace_id,
            justification=body.justification,
        )
        if req is None:
            raise HTTPException(
                status_code=429,
                detail={"error": "queue_full",
                        "message": "The approval queue is full; try again later."},
            )
        return {"request": req}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to create JIT request: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/jit/requests")
async def list_requests(
    status: Optional[str] = Query(None, pattern="^(pending|approved|denied|expired)$"),
):
    try:
        db = get_database()
        repo = JitAccessRepository(db)
        # Opportunistic housekeeping: stale pending requests expire on read so
        # the queue the human sees never contains day-old asks.
        await repo.expire_stale_requests()
        from securevector.app.services import response_rungs
        await response_rungs.expire_holds(db)
        items = await repo.list_requests(status=status)
        return {"items": items, "pending": await repo.pending_count()}
    except Exception as e:
        logger.error(f"Failed to list JIT requests: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def _decision_summary(request_id: str, verb: str) -> Optional[str]:
    """What the person is asked to confirm, e.g. "Allow Claude Code in
    webapp to run: Bash"."""
    from securevector.app.services import confirmations
    if not confirmations.enabled():
        return None
    try:
        row = await JitAccessRepository(get_database()).get_request(request_id)
    except Exception:  # noqa: BLE001 - the generic text is used
        return None
    if not row:
        return None
    from securevector.app.services.config_trust_scan import HARNESS_LABELS
    kind = row.get("runtime_kind") or ""
    who = HARNESS_LABELS.get(kind, kind or "the agent")
    tool = str(row.get("tool_id") or "a tool")[:80]
    if row.get("rule_source") == "delegate":
        return f"{verb} the delegated task from {who}"
    # A request bound to one held call names that call, so "Allow once"
    # is confirmed with the arguments in view.
    preview = row.get("call_preview") if row.get("call_fingerprint") else None
    if preview:
        tool = f"{tool} with {str(preview)[:160]}"
    return f"{verb} {who} to run: {tool}" if verb == "Allow" else f"{verb} {who}: {tool}"


@router.post("/jit/requests/{request_id}/approve")
async def approve_request(
    request_id: str,
    body: JitApprove,
    request: Request,
    x_sv_ui_token: Optional[str] = Header(None),
):
    from securevector.app.services import confirmations, decisions
    if not confirmations.is_replay(request):
        _require_ui_token(x_sv_ui_token)
    await decisions.refuse_governed_caller(request)
    await confirmations.gate(request, summary=await _decision_summary(request_id, "Allow"))
    try:
        db = get_database()
        repo = JitAccessRepository(db)
        # A hold past its limit is already a deny; a late approval cannot open it.
        from securevector.app.services import response_rungs
        await response_rungs.expire_holds(db)
        # A delegation request launches its task on approval; no grant.
        pending = await repo.get_request(request_id)
        if pending and pending.get("rule_source") == "delegate":
            from securevector.app.services import delegation
            manager = getattr(getattr(request.app, "state", None), "terminal_manager", None)
            out = await delegation.approve(db, manager, request_id)
            if out is None:
                raise HTTPException(status_code=404, detail="No such pending request")
            return {"delegation": out}
        try:
            grant, changed = await repo.approve_request(request_id, body.duration, with_change=True)
        except ValueError as ve:
            raise HTTPException(status_code=422, detail=str(ve))
        if grant is None:
            raise HTTPException(status_code=404, detail="No such pending request")
        if changed:
            await decisions.audit_request(db, "allow", pending)
            from securevector.app.services import call_rules
            await call_rules.on_approved(db, pending, duration=grant.get("duration"))
        logger.info(
            "JIT grant %s: %s for %s (%s)",
            grant["id"], grant["tool_id"], grant["duration"], request_id,
        )
        return {"grant": grant}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to approve JIT request: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/jit/requests/{request_id}/deny")
async def deny_request(
    request_id: str,
    body: JitDeny,
    request: Request,
    x_sv_ui_token: Optional[str] = Header(None),
):
    from securevector.app.services import confirmations, decisions
    if not confirmations.is_replay(request):
        _require_ui_token(x_sv_ui_token)
    await decisions.refuse_governed_caller(request)
    await confirmations.gate(request, summary=await _decision_summary(request_id, "Deny"))
    try:
        db = get_database()
        pending = await JitAccessRepository(db).get_request(request_id)
        if pending and pending.get("rule_source") == "delegate":
            from securevector.app.services import delegation
            manager = getattr(getattr(request.app, "state", None), "terminal_manager", None)
            out = await delegation.deny(db, manager, request_id, body.reason)
            if out is None:
                raise HTTPException(status_code=404, detail="No such pending request")
            return {"denied": True, "delegation": out}
        ok = await JitAccessRepository(db).deny_request(request_id, body.reason)
        if not ok:
            raise HTTPException(status_code=404, detail="No such pending request")
        await decisions.audit_request(db, "deny", pending, reason=body.reason)
        return {"denied": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to deny JIT request: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/jit/grants")
async def list_grants():
    try:
        db = get_database()
        repo = JitAccessRepository(db)
        items = await repo.list_grants()
        active = await repo.active_grants()
        # Who decided, for "approved from the cloud by <user>".
        ids = {g.get("request_id") for g in items + active if g.get("request_id")}
        if ids:
            try:
                marks = ",".join("?" for _ in ids)
                rows = await db.fetch_all(
                    f"SELECT id, decided_by, decision_source FROM jit_access_requests WHERE id IN ({marks})",
                    tuple(ids),
                ) or []
                by_id = {dict(r)["id"]: dict(r) for r in rows}
                for g in items + active:
                    r = by_id.get(g.get("request_id"))
                    if r and r.get("decision_source") == "cloud":
                        g["decision_source"] = "cloud"
                        g["decided_by"] = r.get("decided_by")
            except Exception:  # noqa: BLE001 - column absent before the storage step
                pass
        return {"items": items, "active": active}
    except Exception as e:
        logger.error(f"Failed to list JIT grants: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/jit/grants/{grant_id}/revoke")
async def revoke_grant(
    grant_id: str,
    x_sv_ui_token: Optional[str] = Header(None),
):
    _require_ui_token(x_sv_ui_token)
    try:
        db = get_database()
        ok = await JitAccessRepository(db).revoke_grant(grant_id)
        if not ok:
            raise HTTPException(status_code=404, detail="No such active grant")
        return {"revoked": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to revoke JIT grant: {e}")
        raise HTTPException(status_code=500, detail=str(e))
