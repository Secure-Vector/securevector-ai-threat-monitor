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

# tool_id prefix of a host approval for a blocked egress destination.
EGRESS_TOOL_PREFIX = "egress:"
# Host requests have their own caps, separate from the tool-request queue
# (whose cap ignores host rows), with a per-session limit.
MAX_PENDING_HOST_REQUESTS_PER_SESSION = 10
MAX_PENDING_HOST_REQUESTS = 50


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
            "SELECT COUNT(*) AS n FROM jit_access_requests WHERE status = 'pending' "
            "AND tool_id NOT LIKE ?",
            (f"{EGRESS_TOOL_PREFIX}%",),
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

    async def _latest_grant(self, request_id: str) -> Optional[dict]:
        """The most recent grant still IN FORCE for a request, if any.

        Used to make approval idempotent: a caller that lost the approval race
        (or is retrying an already-approved request) gets the real grant back
        instead of a second one.

        Matches active_grants()' definition of "in force" (not revoked, not
        expired) on purpose. Returning the newest grant regardless of state
        would hand a revoked or expired grant back to a retrying client as
        though access were live — enforcement reads active_grants() so no
        access is actually conferred, but the API would be reporting a grant
        that does not exist. None here is the honest answer: the request was
        approved, and the grant it produced is gone.
        """
        row = await self.db.fetch_one(
            "SELECT * FROM jit_access_grants WHERE request_id = ? "
            "AND revoked_at IS NULL "
            "AND (expires_at IS NULL OR expires_at > datetime('now')) "
            "ORDER BY granted_at DESC, rowid DESC LIMIT 1",
            (request_id,),
        )
        return dict(row) if row else None

    async def approve_request(self, request_id: str, duration: str) -> Optional[dict]:
        """Approve a pending request and mint its grant. Returns the grant.

        Idempotent: approving an already-approved request returns the grant
        that was already minted rather than a second one (or a 404). A double
        click on Approve, or the UI retrying a slow request, must not hand out
        two live grants — see the rowcount gate below for the racing case.
        """
        req = await self.get_request(request_id)
        if not req:
            return None
        if req["status"] != "pending":
            if req["status"] == "approved":
                return await self._latest_grant(request_id)
            return None  # denied / expired — nothing to grant
        if duration not in ("15m", "1h", "session"):
            raise ValueError(f"invalid duration: {duration}")
        # A response rung's approval lasts the rest of that session only.
        if req.get("rule_source") == "rung":
            duration = "session"
            tid = str(req.get("tool_id") or "")
            if not tid or "*" in tid or tid.lower().startswith(EGRESS_TOOL_PREFIX):
                raise ValueError("this request cannot be granted")
        # A session grant needs a session to scope to — without one it would
        # degrade into an unbounded runtime-wide allow, which is exactly the
        # "until I revoke" shape the review ruled out.
        if duration == "session" and not req.get("session_id"):
            raise ValueError("session-scoped grant requires a session_id on the request")

        # The `status = 'pending'` predicate makes this UPDATE the concurrency
        # gate: exactly one caller can flip a given request out of pending.
        # We MUST check rowcount before minting — the get_request() read above
        # is not part of this statement, so two racing approvals (a double
        # click, or the UI retrying a slow request) both see 'pending' there.
        # Without this guard both would fall through and INSERT a grant,
        # handing out two live grants for one approval. A losing caller
        # returns the grant the winner already minted, so the UI shows the
        # real grant instead of a spurious 404.
        cur = await self.db.execute(
            "UPDATE jit_access_requests SET status = 'approved', "
            "decided_at = CURRENT_TIMESTAMP, decided_by = 'local-user' "
            "WHERE id = ? AND status = 'pending'",
            (request_id,),
        )
        if getattr(cur, "rowcount", 1) == 0:
            return await self._latest_grant(request_id)
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

    # ---------------------------------------------------------- host grants
    #
    # A blocked egress host reuses the request/grant lifecycle above rather
    # than a parallel table: the row is a JIT request whose tool_id is
    # ``egress:<host>`` (function_name carries the rule that fired, the
    # justification its reason). Two things differ from a tool grant, both on
    # the side of less reach:
    #
    # - Every host grant is scoped to one session, whatever its duration. A
    #   15m or 1h host grant is time-boxed *inside* that session, never
    #   device-wide; the egress evaluator matches host + harness + session.
    # - /synced-overrides never emits these rows as tool allows (the prefix is
    #   skipped there); only the egress evaluator reads them.

    async def create_host_request(
        self,
        host: str,
        rule_id: Optional[str],
        reason: Optional[str],
        runtime_kind: Optional[str],
        session_id: Optional[str],
        rule_source: str = "local",
    ) -> Optional[dict]:
        """File (or return the pending duplicate of) a host approval request.

        Returns None when there is no session to scope to, or the pending
        queue is full. Callers decide promotability before calling: a
        non-promotable rule must never reach this method.
        """
        if not host or not session_id:
            return None
        tool_id = f"{EGRESS_TOOL_PREFIX}{host}"
        # One pending request per (session, host, rule), whatever the harness.
        dup = await self.db.fetch_one(
            "SELECT * FROM jit_access_requests WHERE status = 'pending' "
            "AND tool_id = ? AND session_id = ? "
            "AND COALESCE(function_name,'') = COALESCE(?,'')",
            (tool_id, session_id, rule_id),
        )
        if dup:
            return dict(dup)
        mine = await self.db.fetch_one(
            "SELECT COUNT(*) AS n FROM jit_access_requests WHERE status = 'pending' "
            "AND tool_id LIKE ? AND session_id = ?",
            (f"{EGRESS_TOOL_PREFIX}%", session_id),
        )
        if mine and mine["n"] >= MAX_PENDING_HOST_REQUESTS_PER_SESSION:
            logger.warning("Host request rejected: session queue full (%s)", mine["n"])
            return None
        total = await self.db.fetch_one(
            "SELECT COUNT(*) AS n FROM jit_access_requests WHERE status = 'pending' "
            "AND tool_id LIKE ?",
            (f"{EGRESS_TOOL_PREFIX}%",),
        )
        if total and total["n"] >= MAX_PENDING_HOST_REQUESTS:
            logger.warning("Host request rejected: host queue full (%s)", total["n"])
            return None
        rid = f"jitreq_{uuid.uuid4().hex[:20]}"
        just = (reason or "").strip()[:MAX_JUSTIFICATION_CHARS] or None
        await self.db.execute(
            "INSERT INTO jit_access_requests "
            "(id, tool_id, function_name, runtime_kind, session_id, trace_id, "
            " justification, rule_source) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
            (rid, tool_id, rule_id, runtime_kind, session_id, just, rule_source),
        )
        return await self.get_request(rid)

    async def revoke_session_host_grants(self, session_ids) -> int:
        """Revoke the host grants of sessions whose task ended or was archived.
        "Rest of this session" ends with the task; the 24h cap stays as the
        backstop for a session the app never saw end."""
        ids = [str(s) for s in dict.fromkeys(session_ids or []) if s][:500]
        if not ids:
            return 0
        marks = ",".join("?" for _ in ids)
        cur = await self.db.execute(
            "UPDATE jit_access_grants SET revoked_at = CURRENT_TIMESTAMP "
            f"WHERE revoked_at IS NULL AND tool_id LIKE ? AND session_id IN ({marks})",
            (f"{EGRESS_TOOL_PREFIX}%", *ids),
        )
        return cur.rowcount if cur else 0

    async def grant_host(
        self,
        host: str,
        rule_id: Optional[str],
        reason: Optional[str],
        runtime_kind: Optional[str],
        session_id: str,
        duration: str,
        rule_source: str = "local",
    ) -> Optional[dict]:
        """Approve a blocked host for one session straight from the pane.

        A pending inbox request for the same host and session is approved
        (so the inbox clears with it); otherwise a request row is written and
        approved in the same way, keeping one audit trail for both surfaces.
        The pending-queue cap is not applied: this is the human acting, not an
        agent asking.
        """
        if not host or not session_id:
            raise ValueError("a host grant requires a host and a session_id")
        if duration not in ("15m", "1h", "session"):
            raise ValueError(f"invalid duration: {duration}")
        tool_id = f"{EGRESS_TOOL_PREFIX}{host}"
        row = await self.db.fetch_one(
            "SELECT id FROM jit_access_requests WHERE status = 'pending' "
            "AND tool_id = ? AND COALESCE(runtime_kind,'') = COALESCE(?,'') "
            "AND session_id = ?",
            (tool_id, runtime_kind, session_id),
        )
        if row:
            return await self.approve_request(row["id"], duration)
        rid = f"jitreq_{uuid.uuid4().hex[:20]}"
        just = (reason or "").strip()[:MAX_JUSTIFICATION_CHARS] or None
        await self.db.execute(
            "INSERT INTO jit_access_requests "
            "(id, tool_id, function_name, runtime_kind, session_id, trace_id, "
            " justification, rule_source) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
            (rid, tool_id, rule_id, runtime_kind, session_id, just, rule_source),
        )
        return await self.approve_request(rid, duration)

    async def active_host_grants(
        self,
        session_id: Optional[str],
        runtime_kind: Optional[str] = None,
        any_runtime: bool = False,
    ) -> dict:
        """Hosts approved for this session right now: {host: grant row}.

        Enforcement passes the harness and gets an exact match on it; the
        pane's read passes ``any_runtime`` because it already names the one
        session. No session, no grants: there is no device-wide host grant.
        """
        if not session_id:
            return {}
        sql = (
            "SELECT * FROM jit_access_grants WHERE tool_id LIKE ? "
            "AND session_id = ? AND revoked_at IS NULL "
            "AND (expires_at IS NULL OR expires_at > datetime('now')) "
            # A response rung's approval only lifts that rung's own hold.
            "AND request_id NOT IN (SELECT id FROM jit_access_requests WHERE rule_source = 'rung')"
        )
        params: tuple = (f"{EGRESS_TOOL_PREFIX}%", session_id)
        if not any_runtime:
            sql += " AND COALESCE(runtime_kind,'') = COALESCE(?,'')"
            params = params + (runtime_kind,)
        rows = await self.db.fetch_all(sql + " ORDER BY granted_at DESC", params)
        out: dict = {}
        for r in rows or []:
            host = str(r["tool_id"])[len(EGRESS_TOOL_PREFIX):].lower()
            if host and host not in out:
                out[host] = dict(r)
        return out
