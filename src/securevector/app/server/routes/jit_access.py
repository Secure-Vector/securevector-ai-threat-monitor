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

from fastapi import APIRouter, Header, HTTPException, Query
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


def _require_ui_token(token: Optional[str]) -> None:
    if not token or not secrets.compare_digest(token, _UI_TOKEN):
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
    duration: str = Field(..., pattern="^(15m|1h|session)$")


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


@router.get("/jit/ui-token")
async def get_ui_token():
    """Per-run token the web UI attaches to decision calls."""
    return {"token": _UI_TOKEN}


@router.post("/jit/requests")
async def create_request(body: JitRequestCreate):
    """File a JIT access request (the agent-facing surface)."""
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
        items = await repo.list_requests(status=status)
        return {"items": items, "pending": await repo.pending_count()}
    except Exception as e:
        logger.error(f"Failed to list JIT requests: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/jit/requests/{request_id}/approve")
async def approve_request(
    request_id: str,
    body: JitApprove,
    x_sv_ui_token: Optional[str] = Header(None),
):
    _require_ui_token(x_sv_ui_token)
    try:
        db = get_database()
        repo = JitAccessRepository(db)
        try:
            grant = await repo.approve_request(request_id, body.duration)
        except ValueError as ve:
            raise HTTPException(status_code=422, detail=str(ve))
        if grant is None:
            raise HTTPException(status_code=404, detail="No such pending request")
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
    x_sv_ui_token: Optional[str] = Header(None),
):
    _require_ui_token(x_sv_ui_token)
    try:
        db = get_database()
        ok = await JitAccessRepository(db).deny_request(request_id, body.reason)
        if not ok:
            raise HTTPException(status_code=404, detail="No such pending request")
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
        return {
            "items": await repo.list_grants(),
            "active": await repo.active_grants(),
        }
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
