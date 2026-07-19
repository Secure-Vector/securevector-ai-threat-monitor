"""
Repository for JIT (just-in-time) tool access requests and grants.

An agent that hits a *requestable* deny files a request; a human approves or
denies it in the local web UI. Approval creates a time-boxed grant that the
/synced-overrides merge emits as a high-priority allow row.

Security boundaries (fixed by the idea page's legal/UX pre-review):
- Requests against non-requestable (hard) denies are rejected at creation —
  this repository never sees them.
- Grants are always bounded: '15m' / '1h' carry an expires_at; 'session'
  grants are scoped to the requesting session_id and die with it. There is
  deliberately no unbounded duration.
- Rows are the audit trail: requests are never deleted, only
  status-transitioned; grants are never deleted, only revoked/expired.
"""

import logging
import uuid
from typing import Optional

from securevector.app.database.connection import DatabaseConnection

logger = logging.getLogger(__name__)

# A runaway agent must not be able to flood the human's approval queue.
MAX_PENDING_REQUESTS = 25
# Data minimization: keep just enough justification to make a decision.
MAX_JUSTIFICATION_CHARS = 500

_DURATION_MINUTES = {"15m": 15, "1h": 60}


class JitAccessRepository:
    """Repository for JIT access request/grant lifecycle rows."""

    def __init__(self, db: DatabaseConnection):
        self.db = db

    # ------------------------------------------------------------- requests

    async def create_request(
        self,
        tool_id: str,
        rule_source: str,
        function_name: Optional[str] = None,
        runtime_kind: Optional[str] = None,
        session_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        justification: Optional[str] = None,
    ) -> Optional[dict]:
        """File a new pending request.

        Returns the created row, the existing pending duplicate (idempotent
        per tool+runtime+session), or None when the pending queue is full.
        """
        dup = await self.db.fetch_one(
            "SELECT * FROM jit_access_requests WHERE status = 'pending' "
            "AND tool_id = ? AND COALESCE(runtime_kind,'') = COALESCE(?,'') "
            "AND COALESCE(session_id,'') = COALESCE(?,'')",
            (tool_id, runtime_kind, session_id),
        )
        if dup:
            return dict(dup)

        row = await self.db.fetch_one(
            "SELECT COUNT(*) AS n FROM jit_access_requests WHERE status = 'pending'"
        )
        if row and row["n"] >= MAX_PENDING_REQUESTS:
            logger.warning("JIT request rejected: pending queue full (%s)", row["n"])
            return None

        rid = f"jitreq_{uuid.uuid4().hex[:20]}"
        just = (justification or "").strip()[:MAX_JUSTIFICATION_CHARS] or None
        await self.db.execute(
            "INSERT INTO jit_access_requests "
            "(id, tool_id, function_name, runtime_kind, session_id, trace_id, "
            " justification, rule_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (rid, tool_id, function_name, runtime_kind, session_id, trace_id,
             just, rule_source),
        )
        return await self.get_request(rid)

    async def get_request(self, request_id: str) -> Optional[dict]:
        row = await self.db.fetch_one(
            "SELECT * FROM jit_access_requests WHERE id = ?", (request_id,)
        )
        return dict(row) if row else None

    async def list_requests(
        self, status: Optional[str] = None, limit: int = 100
    ) -> list[dict]:
        if status:
            rows = await self.db.fetch_all(
                "SELECT * FROM jit_access_requests WHERE status = ? "
                "ORDER BY requested_at DESC LIMIT ?",
                (status, limit),
            )
        else:
            rows = await self.db.fetch_all(
                "SELECT * FROM jit_access_requests ORDER BY requested_at DESC LIMIT ?",
                (limit,),
            )
        return [dict(r) for r in rows] if rows else []

    async def pending_count(self) -> int:
        row = await self.db.fetch_one(
            "SELECT COUNT(*) AS n FROM jit_access_requests WHERE status = 'pending'"
        )
        return int(row["n"]) if row else 0

    # ------------------------------------------------------------ decisions

    async def approve_request(self, request_id: str, duration: str) -> Optional[dict]:
        """Approve a pending request and mint its grant. Returns the grant."""
        req = await self.get_request(request_id)
        if not req or req["status"] != "pending":
            return None
        if duration not in ("15m", "1h", "session"):
            raise ValueError(f"invalid duration: {duration}")
        # A session grant needs a session to scope to — without one it would
        # degrade into an unbounded runtime-wide allow, which is exactly the
        # "until I revoke" shape the review ruled out.
        if duration == "session" and not req.get("session_id"):
            raise ValueError("session-scoped grant requires a session_id on the request")

        await self.db.execute(
            "UPDATE jit_access_requests SET status = 'approved', "
            "decided_at = CURRENT_TIMESTAMP, decided_by = 'local-user' "
            "WHERE id = ? AND status = 'pending'",
            (request_id,),
        )
        gid = f"jitgrant_{uuid.uuid4().hex[:20]}"
        if duration in _DURATION_MINUTES:
            await self.db.execute(
                "INSERT INTO jit_access_grants "
                "(id, request_id, tool_id, runtime_kind, session_id, duration, expires_at) "
                f"VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+{_DURATION_MINUTES[duration]} minutes'))",
                (gid, request_id, req["tool_id"], req.get("runtime_kind"),
                 req.get("session_id"), duration),
            )
        else:  # session-scoped: bounded by the session, belt-and-braces 24h cap
            await self.db.execute(
                "INSERT INTO jit_access_grants "
                "(id, request_id, tool_id, runtime_kind, session_id, duration, expires_at) "
                "VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+24 hours'))",
                (gid, request_id, req["tool_id"], req.get("runtime_kind"),
                 req.get("session_id"), duration),
            )
        row = await self.db.fetch_one(
            "SELECT * FROM jit_access_grants WHERE id = ?", (gid,)
        )
        return dict(row) if row else None

    async def deny_request(
        self, request_id: str, reason: Optional[str] = None
    ) -> bool:
        req = await self.get_request(request_id)
        if not req or req["status"] != "pending":
            return False
        await self.db.execute(
            "UPDATE jit_access_requests SET status = 'denied', "
            "decided_at = CURRENT_TIMESTAMP, decided_by = 'local-user', "
            "deny_reason = ? WHERE id = ? AND status = 'pending'",
            ((reason or "").strip()[:200] or None, request_id),
        )
        return True

    async def expire_stale_requests(self, older_than_hours: int = 24) -> int:
        """Pending requests nobody decided within a day auto-expire — a stale
        queue must not become a standing invitation to approve blindly."""
        cur = await self.db.execute(
            "UPDATE jit_access_requests SET status = 'expired', "
            "decided_at = CURRENT_TIMESTAMP, decided_by = 'auto-expiry' "
            f"WHERE status = 'pending' AND requested_at < datetime('now', '-{int(older_than_hours)} hours')"
        )
        return cur.rowcount if cur else 0

    # --------------------------------------------------------------- grants

    async def active_grants(self, runtime_kind: Optional[str] = None) -> list[dict]:
        """Grants currently in force (not revoked, not past expires_at)."""
        sql = (
            "SELECT * FROM jit_access_grants WHERE revoked_at IS NULL "
            "AND (expires_at IS NULL OR expires_at > datetime('now'))"
        )
        params: tuple = ()
        if runtime_kind:
            sql += " AND (runtime_kind IS NULL OR runtime_kind = ?)"
            params = (runtime_kind,)
        rows = await self.db.fetch_all(sql + " ORDER BY granted_at DESC", params)
        return [dict(r) for r in rows] if rows else []

    async def list_grants(self, limit: int = 100) -> list[dict]:
        rows = await self.db.fetch_all(
            "SELECT g.*, r.justification, r.function_name "
            "FROM jit_access_grants g "
            "LEFT JOIN jit_access_requests r ON r.id = g.request_id "
            "ORDER BY g.granted_at DESC LIMIT ?",
            (limit,),
        )
        return [dict(r) for r in rows] if rows else []

    async def revoke_grant(self, grant_id: str) -> bool:
        cur = await self.db.execute(
            "UPDATE jit_access_grants SET revoked_at = CURRENT_TIMESTAMP "
            "WHERE id = ? AND revoked_at IS NULL",
            (grant_id,),
        )
        return bool(cur and cur.rowcount)
