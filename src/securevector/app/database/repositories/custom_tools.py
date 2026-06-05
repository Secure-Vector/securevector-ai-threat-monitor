"""
Repository for user-defined custom tools.

Users can register their own agent tools (e.g. research, transcribe)
and control permissions through the same block/allow system as essential tools.
"""

import asyncio
import hashlib
import logging
from typing import Optional

from securevector.app.database.connection import DatabaseConnection

logger = logging.getLogger(__name__)

# Sentinel prev_hash for the first row in the chain.
_AUDIT_GENESIS_HASH = "GENESIS"

# Serializes the audit hash-chain's read-tail → insert critical section.
# The app is single-process, so one process-wide asyncio lock makes seq +
# prev_hash assignment atomic and prevents two concurrent writes from forking
# the chain on the same seq (the "seq gap" the verifier would flag).
_AUDIT_WRITE_LOCK = asyncio.Lock()


async def _siem_enqueue_tool_audit(
    *,
    db: DatabaseConnection,
    seq: int,
    tool_id: str,
    function_name: str,
    action: str,
    risk: str,
    is_essential: bool,
    called_at: str,
    prev_hash: Optional[str],
    row_hash: str,
    device_id: Optional[str] = None,
    # Full-tier raw context. Stripped for standard/minimal destinations
    # at the repo layer before the outbox write.
    args_full: Optional[str] = None,
    reason_full: Optional[str] = None,
) -> None:
    """Fan a new audit row out to every enabled SIEM forwarder.

    Lazy-imports the forwarder repo so a non-SIEM install path doesn't
    drag the subsystem into every tool-call audit write.
    """
    from securevector.app.database.repositories.external_forwarders import (
        ExternalForwardOutboxRepository,
        ExternalForwardersRepository,
        build_tool_audit_payload,
        is_siem_forwarding_enabled,
    )

    # Global kill-switch (v24). Short-circuits before any outbox work.
    if not await is_siem_forwarding_enabled(db):
        return

    fwds = await ExternalForwardersRepository(db).list_active()
    if not fwds:
        return

    # ── v26 SOC-context. Best-effort; None on failure.
    actor_user: Optional[str] = None
    try:
        import getpass
        actor_user = getpass.getuser()
    except Exception:
        pass  # best-effort OS-user lookup; absence is fine
    # actor_process is "who invoked the tool?" — we don't have the source
    # here, but the tool_id carries enough attribution for audits.
    actor_process: Optional[str] = str(tool_id) if tool_id else None

    # finding_group_id clusters repeated invocations of the same
    # blocked/allowed tool in the same hour, so a runaway loop shows up
    # as one finding rather than thousands.
    finding_group_id: Optional[str] = None
    try:
        from datetime import datetime
        ca = str(called_at)
        hour = ca[:13] if len(ca) >= 13 else ca  # "YYYY-MM-DDTHH"
        seed = f"{tool_id}|{function_name}|{action}|{hour}".encode("utf-8")
        finding_group_id = hashlib.sha256(seed).hexdigest()[:16]
    except Exception:
        pass  # best-effort finding_group_id derivation; falls through to None

    # audit_id isn't known at this call site (we only have seq + row_hash),
    # so pass 0 — consumers keying on row_hash are unaffected, and the OCSF
    # encoder surfaces audit_id in `unmapped` for completeness.
    payload = build_tool_audit_payload(
        audit_id=0,
        seq=int(seq),
        tool_id=str(tool_id or ""),
        function_name=str(function_name or ""),
        action=str(action or ""),
        risk=str(risk or ""),
        is_essential=bool(is_essential),
        called_at=str(called_at),
        prev_hash=prev_hash,
        row_hash=str(row_hash),
        device_id=device_id,
        args_full=args_full,
        reason_full=reason_full,
        # v26 SOC-context
        actor_user=actor_user,
        actor_process=actor_process,
        finding_group_id=finding_group_id,
        mitre_techniques=None,
    )

    outbox = ExternalForwardOutboxRepository(db)
    written = await outbox.enqueue_fanout("tool_audit", payload, forwarders=fwds)
    if written:
        logger.debug(f"siem: enqueued tool_audit seq={seq} → {written} forwarder(s)")


def _compute_audit_row_hash(
    *,
    prev_hash: str,
    seq: int,
    tool_id: str,
    function_name: str,
    action: str,
    risk: Optional[str],
    reason: Optional[str],
    is_essential: int,
    args_preview: Optional[str],
    called_at: str,
) -> str:
    """Compute the hex SHA-256 row_hash used for the tool_call_audit hash chain.

    Canonical serialization is a newline-separated join of the fields in a
    fixed order. Must match exactly what `migrate_to_v20` used for backfill.
    """
    canonical = "\n".join([
        prev_hash,
        str(seq),
        str(tool_id),
        str(function_name),
        str(action),
        str(risk or ""),
        str(reason or ""),
        str(is_essential),
        str(args_preview or ""),
        str(called_at),
    ])
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class CustomToolsRepository:
    """CRUD repository for custom tools."""

    def __init__(self, db: DatabaseConnection):
        self.db = db

    _CUSTOM_TOOL_COLUMNS = (
        "tool_id, name, category, risk, default_permission, description, "
        "rate_limit_max_calls, rate_limit_window_seconds, created_at"
    )

    async def get_all_custom_tools(self) -> list[dict]:
        """Get all custom tools.

        Returns:
            List of custom tool dicts.
        """
        rows = await self.db.fetch_all(
            f"SELECT {self._CUSTOM_TOOL_COLUMNS} "
            "FROM custom_tools ORDER BY created_at DESC"
        )
        return [dict(row) for row in rows] if rows else []

    async def get_custom_tool(self, tool_id: str) -> Optional[dict]:
        """Get a single custom tool by ID.

        Args:
            tool_id: Custom tool ID (e.g. "research").

        Returns:
            Dict or None.
        """
        row = await self.db.fetch_one(
            f"SELECT {self._CUSTOM_TOOL_COLUMNS} "
            "FROM custom_tools WHERE tool_id = ?",
            (tool_id,),
        )
        return dict(row) if row else None

    async def create_custom_tool(
        self,
        tool_id: str,
        name: str,
        category: str = "custom",
        risk: str = "write",
        default_permission: str = "block",
        description: str = "",
        rate_limit_max_calls: Optional[int] = None,
        rate_limit_window_seconds: Optional[int] = None,
    ) -> dict:
        """Create a new custom tool.

        Args:
            tool_id: Unique tool identifier.
            name: Display name.
            category: Tool category (default "custom").
            risk: Risk level (read/write/delete/admin).
            default_permission: Default action (block/allow).
            description: Tool description.
            rate_limit_max_calls: Max calls per window (None = no limit).
            rate_limit_window_seconds: Window duration in seconds (None = no limit).

        Returns:
            The created tool dict.
        """
        await self.db.execute(
            """
            INSERT INTO custom_tools
            (tool_id, name, category, risk, default_permission, description,
             rate_limit_max_calls, rate_limit_window_seconds)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (tool_id, name, category, risk, default_permission, description,
             rate_limit_max_calls, rate_limit_window_seconds),
        )
        logger.info(f"Created custom tool: {tool_id}")
        return await self.get_custom_tool(tool_id)

    async def update_custom_tool_permission(
        self, tool_id: str, default_permission: str
    ) -> Optional[dict]:
        """Update the default_permission of a custom tool.

        Args:
            tool_id: Tool ID to update.
            default_permission: New permission ("block" or "allow").

        Returns:
            Updated tool dict, or None if not found.
        """
        await self.db.execute(
            "UPDATE custom_tools SET default_permission = ? WHERE tool_id = ?",
            (default_permission, tool_id),
        )
        logger.info(f"Updated custom tool permission: {tool_id} -> {default_permission}")
        return await self.get_custom_tool(tool_id)

    async def update_custom_tool_rate_limit(
        self,
        tool_id: str,
        max_calls: Optional[int],
        window_seconds: Optional[int],
    ) -> Optional[dict]:
        """Update rate limit config for a custom tool.

        Setting both to None removes the rate limit.

        Args:
            tool_id: Tool ID to update.
            max_calls: Max calls per window (None = no limit).
            window_seconds: Window duration in seconds (None = no limit).

        Returns:
            Updated tool dict, or None if not found.
        """
        await self.db.execute(
            "UPDATE custom_tools SET rate_limit_max_calls = ?, rate_limit_window_seconds = ? "
            "WHERE tool_id = ?",
            (max_calls, window_seconds, tool_id),
        )
        logger.info(f"Updated rate limit for {tool_id}: {max_calls}/{window_seconds}s")
        return await self.get_custom_tool(tool_id)

    async def delete_custom_tool(self, tool_id: str) -> bool:
        """Delete a custom tool.

        Args:
            tool_id: Tool ID to delete.

        Returns:
            True if deleted.
        """
        await self.db.execute(
            "DELETE FROM custom_tools WHERE tool_id = ?",
            (tool_id,),
        )
        logger.info(f"Deleted custom tool: {tool_id}")
        return True

    # ==================== Call Log ====================

    async def log_tool_call(self, tool_id: str) -> None:
        """Record a tool call for rate limiting.

        Args:
            tool_id: Tool ID that was called.
        """
        await self.db.execute(
            "INSERT INTO tool_call_log (tool_id) VALUES (?)",
            (tool_id,),
        )

    async def count_recent_calls(self, tool_id: str, window_seconds: int) -> int:
        """Count tool calls within the given time window.

        Args:
            tool_id: Tool ID to check.
            window_seconds: How far back to look (in seconds).

        Returns:
            Number of calls in the window.
        """
        row = await self.db.fetch_one(
            "SELECT COUNT(*) as cnt FROM tool_call_log "
            "WHERE tool_id = ? AND called_at >= datetime('now', ?)",
            (tool_id, f"-{window_seconds} seconds"),
        )
        return row["cnt"] if row else 0

    async def cleanup_old_calls(self, older_than_seconds: int = 86400) -> int:
        """Delete old call log entries for housekeeping.

        Args:
            older_than_seconds: Delete entries older than this (default 24h).

        Returns:
            Number of rows deleted.
        """
        result = await self.db.execute(
            "DELETE FROM tool_call_log WHERE called_at < datetime('now', ?)",
            (f"-{older_than_seconds} seconds",),
        )
        return result if isinstance(result, int) else 0

    # ==================== Audit Log ====================

    async def log_tool_call_audit(
        self,
        tool_id: str,
        function_name: str,
        action: str,
        *,
        risk: Optional[str] = None,
        reason: Optional[str] = None,
        is_essential: bool = False,
        args_preview: Optional[str] = None,
        runtime_kind: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> None:
        """Record a full tool call decision (block/allow/log_only) for audit history.

        Each row is appended to a SHA-256 hash chain via (seq, prev_hash, row_hash).
        Any later tampering with a persisted row is detectable by re-running
        `verify_audit_chain()` (or hitting GET /api/audit/integrity).

        Args:
            tool_id: Resolved registry tool ID (or function_name if unknown).
            function_name: Actual function name from LLM response.
            action: Decision — "block", "allow", or "log_only".
            risk: Risk level string ("read", "write", "delete", "admin").
            reason: Human-readable reason for the decision.
            is_essential: True if matched in essential registry.
            args_preview: First 200 chars of the tool arguments.
            runtime_kind: Which agent runtime emitted the call — "claude-code",
                "openclaw", etc. Metadata only; not in the v20 hash chain
                (same precedent as device_id, see migrate_to_v21 comment).
            session_id: The runtime's own session id for the agent run this
                call belongs to. Used to derive the per-run ``trace_id`` and
                ``turn_index`` that group the flat audit log into runs/turns
                (story #141). Metadata only; NOT in the hash chain. Falsy →
                the row is an orphan single-span run.
        """
        conn = await self.db.connect()

        # Serialize read-tail → compute → insert. seq + prev_hash derive from the
        # current tail, so two concurrent writes must NOT interleave between the
        # SELECT and the INSERT, or both pick the same seq and FORK the chain
        # (the "seq gap" the verifier flags). aiosqlite serializes the INSERTs
        # but not this read-modify-write, so hold a process-wide lock across it.
        async with _AUDIT_WRITE_LOCK:
            async with conn.execute(
                "SELECT seq, row_hash FROM tool_call_audit ORDER BY seq DESC LIMIT 1"
            ) as cursor:
                tail = await cursor.fetchone()

            if tail is None:
                next_seq = 1
                prev_hash = _AUDIT_GENESIS_HASH
            else:
                next_seq = int(tail["seq"] or 0) + 1
                prev_hash = tail["row_hash"] or _AUDIT_GENESIS_HASH

            # Resolve called_at deterministically so row_hash is reproducible on reads.
            # SQLite's CURRENT_TIMESTAMP returns 'YYYY-MM-DD HH:MM:SS' in UTC.
            async with conn.execute("SELECT CURRENT_TIMESTAMP AS ts") as cursor:
                ts_row = await cursor.fetchone()
            called_at = str(ts_row["ts"])

            resolved_tool_id = tool_id or function_name
            essential_int = 1 if is_essential else 0

            row_hash = _compute_audit_row_hash(
                prev_hash=prev_hash,
                seq=next_seq,
                tool_id=resolved_tool_id,
                function_name=function_name,
                action=action,
                risk=risk,
                reason=reason,
                is_essential=essential_int,
                args_preview=args_preview,
                called_at=called_at,
            )

            # Stable per-device identifier stamped on every row. Derived
            # from the OS machine ID (survives reinstalls), SHA-256-hashed.
            # Not part of the canonical hash-chain serialization — see
            # migration v21's comment block for why this is metadata, not
            # material.
            from securevector.app.utils.device_id import get_device_id
            device_id = get_device_id()

            # Agent-run grouping keys (story #141). Derived from the runtime
            # session_id; metadata only, NOT in the canonical hash above. See
            # app/utils/trace_id.py for the run-boundary rule. A row without a
            # session_id gets trace_id=None and renders as an orphan single-span
            # run; turn_index is its 0-based position within the run.
            from securevector.app.utils.trace_id import derive_trace_id
            trace_id = derive_trace_id(runtime_kind, session_id)
            turn_index: Optional[int] = None
            if trace_id is not None:
                async with conn.execute(
                    "SELECT COUNT(*) AS n FROM tool_call_audit WHERE trace_id = ?",
                    (trace_id,),
                ) as cursor:
                    count_row = await cursor.fetchone()
                turn_index = int(count_row["n"] or 0)
            parent_span_id: Optional[str] = None  # reserved for future nested spans

            await conn.execute(
                """
                INSERT INTO tool_call_audit
                    (tool_id, function_name, action, risk, reason, is_essential,
                     args_preview, called_at, seq, prev_hash, row_hash, device_id,
                     runtime_kind, session_id, trace_id, turn_index, parent_span_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    resolved_tool_id,
                    function_name,
                    action,
                    risk,
                    reason,
                    essential_int,
                    args_preview,
                    called_at,
                    next_seq,
                    prev_hash,
                    row_hash,
                    device_id,
                    runtime_kind,
                    session_id,
                    trace_id,
                    turn_index,
                    parent_span_id,
                ),
            )
            await conn.commit()

        # SIEM fan-out — push the audit row (with its chain witness) to
        # every enabled forwarder so the customer's SIEM can re-verify the
        # chain. Same metadata-only allow-list as the cloud outbox.
        # Failures here MUST NOT disturb the audit write; wrap + log.
        try:
            await _siem_enqueue_tool_audit(
                db=self.db,
                seq=next_seq,
                tool_id=resolved_tool_id,
                function_name=function_name,
                action=action,
                risk=risk or "",
                is_essential=bool(is_essential),
                called_at=called_at,
                prev_hash=prev_hash,
                row_hash=row_hash,
                device_id=device_id,
                # Full-tier only: untruncated args + policy reason.
                # Standard/minimal destinations get these stripped.
                args_full=args_preview,
                reason_full=reason,
            )
        except Exception as _sie:
            logger.debug(f"siem enqueue (tool_audit) skipped: {_sie}")

    async def verify_audit_chain(self) -> dict:
        """Walk the tool_call_audit hash chain and report integrity status.

        Handles truncation cleanly: retention sweeps prune the OLDEST end
        of the chain, so the lowest remaining seq may be > 1. In that
        case we accept the row's stored `prev_hash` as the post-truncation
        anchor — the verifier still proves nothing was tampered with
        after the truncation boundary. The `chain_origin_seq` field in
        the response records where the surviving chain starts.

        IMPORTANT: when ``chain_origin_seq > 1`` the verifier proves
        integrity only for the surviving rows. It CANNOT detect whether
        the deleted prefix was forged-and-replaced versus genuinely
        pruned, because the post-truncation anchor row's ``prev_hash``
        is accepted unconditionally (it links to a now-pruned row). If
        you need authenticity proof for the pruned prefix, rely on a
        SIEM forwarder that captured those rows before retention ran.

        Returns:
            dict with keys:
              - ok               (bool)    — True iff every row_hash recomputes
              - total            (int)     — rows scanned
              - chain_origin_seq (int|None) — seq of the lowest surviving row,
                                              or None if the table is empty
              - tampered_at      (int|None) — seq of the first row that failed
              - tampered_id      (int|None) — DB id of the first row that failed
              - reason           (str|None) — short human-readable diagnosis
              - last_verified_at (str)      — ISO timestamp of this check
        """
        from datetime import datetime, timezone

        conn = await self.db.connect()
        cursor = await conn.execute(
            """
            SELECT id, seq, prev_hash, row_hash,
                   tool_id, function_name, action,
                   COALESCE(risk, '') AS risk,
                   COALESCE(reason, '') AS reason,
                   is_essential,
                   COALESCE(args_preview, '') AS args_preview,
                   called_at
            FROM tool_call_audit
            ORDER BY seq ASC
            """
        )
        rows = await cursor.fetchall()

        # Bootstrap from the actual lowest seq instead of assuming seq=1.
        # Empty table is trivially valid.
        if not rows:
            return {
                "ok": True,
                "total": 0,
                "chain_origin_seq": None,
                "tampered_at": None,
                "tampered_id": None,
                "reason": None,
                "last_verified_at": datetime.now(timezone.utc).isoformat(),
            }
        chain_origin_seq = rows[0]["seq"]
        # When the chain hasn't been truncated, the first row's prev_hash
        # is the GENESIS sentinel — verify that explicitly. After
        # truncation, accept whatever prev_hash the surviving lowest row
        # stored (it linked to a now-pruned row).
        if chain_origin_seq == 1 and rows[0]["prev_hash"] != _AUDIT_GENESIS_HASH:
            return {
                "ok": False,
                "total": len(rows),
                "chain_origin_seq": chain_origin_seq,
                "tampered_at": 1,
                "tampered_id": rows[0]["id"],
                "reason": "seq=1 row has non-GENESIS prev_hash — chain origin tampered",
                "last_verified_at": datetime.now(timezone.utc).isoformat(),
            }
        prev_hash = rows[0]["prev_hash"]
        expected_seq = chain_origin_seq
        for row in rows:
            if row["seq"] != expected_seq:
                return {
                    "ok": False,
                    "total": len(rows),
                    "chain_origin_seq": chain_origin_seq,
                    "tampered_at": expected_seq,
                    "tampered_id": row["id"],
                    "reason": f"seq gap: expected {expected_seq}, got {row['seq']}",
                    "last_verified_at": datetime.now(timezone.utc).isoformat(),
                }
            # The chain-origin row's stored prev_hash is the anchor; it's
            # not compared against an earlier row's row_hash because that
            # row is either GENESIS (untruncated chain) or pruned (post-
            # truncation). Skip the linkage check on it.
            if row["seq"] != chain_origin_seq and row["prev_hash"] != prev_hash:
                return {
                    "ok": False,
                    "total": len(rows),
                    "chain_origin_seq": chain_origin_seq,
                    "tampered_at": row["seq"],
                    "tampered_id": row["id"],
                    "reason": "prev_hash does not match previous row's row_hash",
                    "last_verified_at": datetime.now(timezone.utc).isoformat(),
                }
            recomputed = _compute_audit_row_hash(
                prev_hash=row["prev_hash"],
                seq=row["seq"],
                tool_id=row["tool_id"],
                function_name=row["function_name"],
                action=row["action"],
                risk=row["risk"],
                reason=row["reason"],
                is_essential=row["is_essential"],
                args_preview=row["args_preview"],
                called_at=row["called_at"],
            )
            if recomputed != row["row_hash"]:
                return {
                    "ok": False,
                    "total": len(rows),
                    "chain_origin_seq": chain_origin_seq,
                    "tampered_at": row["seq"],
                    "tampered_id": row["id"],
                    "reason": "row_hash does not match canonical serialization — row content was modified after insert",
                    "last_verified_at": datetime.now(timezone.utc).isoformat(),
                }
            prev_hash = row["row_hash"]
            expected_seq += 1

        return {
            "ok": True,
            "total": len(rows),
            "chain_origin_seq": chain_origin_seq,
            "tampered_at": None,
            "tampered_id": None,
            "reason": None,
            "last_verified_at": datetime.now(timezone.utc).isoformat(),
        }

    async def get_audit_log(
        self,
        limit: int = 50,
        offset: int = 0,
        action_filter: Optional[str] = None,
    ) -> tuple[list[dict], int]:
        """Fetch recent tool call audit entries, newest first, with pagination.

        Args:
            limit: Page size.
            offset: Skip this many rows.
            action_filter: Optional "block" | "allow" | "log_only" filter.

        Returns:
            Tuple of (list of audit record dicts, total count).
        """
        if action_filter and action_filter in ("block", "allow", "log_only"):
            count_row = await self.db.fetch_one(
                "SELECT COUNT(*) AS n FROM tool_call_audit WHERE action = ?",
                (action_filter,),
            )
            rows = await self.db.fetch_all(
                """
                SELECT id, tool_id, function_name, action, risk, reason,
                       is_essential, args_preview, called_at,
                       seq, prev_hash, row_hash, device_id, runtime_kind
                FROM tool_call_audit
                WHERE action = ?
                ORDER BY id DESC
                LIMIT ? OFFSET ?
                """,
                (action_filter, limit, offset),
            )
        else:
            count_row = await self.db.fetch_one(
                "SELECT COUNT(*) AS n FROM tool_call_audit",
            )
            rows = await self.db.fetch_all(
                """
                SELECT id, tool_id, function_name, action, risk, reason,
                       is_essential, args_preview, called_at,
                       seq, prev_hash, row_hash, device_id, runtime_kind
                FROM tool_call_audit
                ORDER BY id DESC
                LIMIT ? OFFSET ?
                """,
                (limit, offset),
            )
        total = count_row["n"] if count_row else 0
        return ([dict(r) for r in rows] if rows else []), total

    async def get_audit_stats(self) -> dict:
        """Return aggregate counts for the audit log.

        Returns:
            Dict with total, blocked, allowed, log_only counts.
        """
        row = await self.db.fetch_one(
            """
            SELECT
                COUNT(*)                                        AS total,
                SUM(CASE WHEN action = 'block'    THEN 1 ELSE 0 END) AS blocked,
                SUM(CASE WHEN action = 'allow'    THEN 1 ELSE 0 END) AS allowed,
                SUM(CASE WHEN action = 'log_only' THEN 1 ELSE 0 END) AS log_only
            FROM tool_call_audit
            """
        )
        if row:
            return {
                "total":    row["total"]    or 0,
                "blocked":  row["blocked"]  or 0,
                "allowed":  row["allowed"]  or 0,
                "log_only": row["log_only"] or 0,
            }
        return {"total": 0, "blocked": 0, "allowed": 0, "log_only": 0}

    async def get_audit_daily_stats(self, days: int = 7) -> list[dict]:
        """Return per-day blocked/allowed/logged counts for the last N days."""
        rows = await self.db.fetch_all(
            """
            SELECT
                DATE(called_at, 'localtime') AS day,
                SUM(CASE WHEN action = 'block'    THEN 1 ELSE 0 END) AS blocked,
                SUM(CASE WHEN action = 'allow'    THEN 1 ELSE 0 END) AS allowed,
                SUM(CASE WHEN action = 'log_only' THEN 1 ELSE 0 END) AS logged
            FROM tool_call_audit
            WHERE DATE(called_at, 'localtime') >= DATE('now', 'localtime', ?)
            GROUP BY DATE(called_at, 'localtime')
            ORDER BY day ASC
            """,
            (f"-{days} days",),
        )
        return [dict(r) for r in rows] if rows else []

    async def delete_audit_entries(self, ids: list[int]) -> int:
        """Delete audit log entries by their IDs.

        Returns:
            Number of rows deleted.
        """
        if not ids:
            return 0
        placeholders = ",".join("?" * len(ids))
        await self.db.execute(
            f"DELETE FROM tool_call_audit WHERE id IN ({placeholders})",
            tuple(ids),
        )
        return len(ids)

    async def get_bill_of_tools(self, window_days: int = 7) -> list[dict]:
        """Aggregate per-(tool_id) inventory of every tool active in the window.

        Returns one row per tool_id seen in tool_call_audit during the trailing
        window. Each row joins:
          - tool_call_audit (counts, last_used, recent risk, secrets-touch heuristic)
          - custom_tools (locally-registered risk classification, category)
          - synced_tool_rules (cloud-pushed policy attribution: org, policy)

        The ``touched_secrets`` flag is a LIKE-match over ``reason`` for keywords
        the rules engine writes when a credential/PII rule fires on a tool's
        arg scan (e.g. ``credential_exfil``, ``secret_exposure``). It catches
        rule-flagged calls; it does NOT catch unflagged exfiltration through
        a tool that legitimately accepts secrets (e.g. a vault MCP).
        """
        window_days = max(1, min(int(window_days), 90))
        cutoff = f"-{window_days} days"
        rows = await self.db.fetch_all(
            """
            WITH calls AS (
                SELECT
                    tool_id,
                    MAX(function_name) AS function_name,
                    -- Comma-separated list of distinct runtimes so the UI can
                    -- disambiguate which agent/harness emitted the call
                    -- (e.g. claude-code, openclaw, langchain). For built-in
                    -- tool names like "Bash" this is the only way to know
                    -- which agent ran it.
                    GROUP_CONCAT(DISTINCT runtime_kind) AS runtime_kinds,
                    COUNT(*) AS calls,
                    SUM(CASE WHEN action='block' THEN 1 ELSE 0 END) AS blocked,
                    SUM(CASE WHEN action='allow' THEN 1 ELSE 0 END) AS allowed,
                    SUM(CASE WHEN action='log_only' THEN 1 ELSE 0 END) AS logged,
                    MAX(called_at) AS last_used,
                    MAX(risk) AS recent_risk,
                    MAX(CASE
                        WHEN LOWER(COALESCE(reason,'')) LIKE '%credential%'
                          OR LOWER(COALESCE(reason,'')) LIKE '%secret%'
                          OR LOWER(COALESCE(reason,'')) LIKE '%api_key%'
                          OR LOWER(COALESCE(reason,'')) LIKE '%api key%'
                          OR LOWER(COALESCE(reason,'')) LIKE '%token%'
                          OR LOWER(COALESCE(reason,'')) LIKE '%password%'
                          OR LOWER(COALESCE(reason,'')) LIKE '%exfil%'
                          OR LOWER(COALESCE(reason,'')) LIKE '%pii%'
                        THEN 1 ELSE 0
                    END) AS touched_secrets
                FROM tool_call_audit
                WHERE called_at >= datetime('now', ?)
                GROUP BY tool_id
            )
            SELECT
                c.tool_id,
                c.function_name,
                c.runtime_kinds,
                c.calls,
                c.blocked,
                c.allowed,
                c.logged,
                c.last_used,
                c.recent_risk,
                c.touched_secrets,
                ct.risk AS local_risk,
                ct.category AS local_category,
                ct.name AS local_name,
                s.effect AS synced_effect,
                s.policy_name AS synced_policy_name,
                s.org_name AS synced_org_name,
                s.policy_id AS synced_policy_id
            FROM calls c
            LEFT JOIN custom_tools ct ON ct.tool_id = c.tool_id
            LEFT JOIN synced_tool_rules s ON s.tool_id = c.tool_id
            ORDER BY c.last_used DESC
            """,
            (cutoff,),
        )
        return [dict(r) for r in rows] if rows else []

    async def get_agent_tool_graph(self, window_days: int = 7) -> list[dict]:
        """Aggregate audit rows into per-(agent, tool) edges for the Agent Map.

        One row per (runtime_kind, tool_id) pair seen in tool_call_audit during
        the trailing window — i.e. one edge from an agent node (the runtime that
        emitted the call) to a tool/MCP node. Each edge carries call volume, the
        allow/block/log_only breakdown, the most recent risk, a secret-touch
        heuristic, and the cloud-policy attribution (so the tool node can show a
        lock glyph). Nodes are derived from these edges by the route layer.

        Per-agent identity is ``runtime_kind`` (the harness) — the most stable
        agent identity available until a real agent_id column exists (the v36
        ``trace_id`` groups individual runs, not agents). ``touched_secrets`` is
        the same ``reason`` LIKE-heuristic as get_bill_of_tools.
        """
        window_days = max(1, min(int(window_days), 90))
        cutoff = f"-{window_days} days"
        rows = await self.db.fetch_all(
            """
            WITH edges AS (
                SELECT
                    COALESCE(runtime_kind, 'unknown') AS runtime_kind,
                    tool_id,
                    MAX(function_name) AS function_name,
                    COUNT(*) AS calls,
                    SUM(CASE WHEN action='block' THEN 1 ELSE 0 END) AS blocked,
                    SUM(CASE WHEN action='allow' THEN 1 ELSE 0 END) AS allowed,
                    SUM(CASE WHEN action='log_only' THEN 1 ELSE 0 END) AS logged,
                    MAX(called_at) AS last_used,
                    CASE WHEN MAX(CASE WHEN LOWER(COALESCE(risk,'')) IN ('delete','admin','write') THEN 1 ELSE 0 END) = 1 THEN 'admin' ELSE 'read' END AS recent_risk,
                    MAX(CASE
                        WHEN LOWER(COALESCE(reason,'')) LIKE '%credential%'
                          OR LOWER(COALESCE(reason,'')) LIKE '%secret%'
                          OR LOWER(COALESCE(reason,'')) LIKE '%api_key%'
                          OR LOWER(COALESCE(reason,'')) LIKE '%api key%'
                          OR LOWER(COALESCE(reason,'')) LIKE '%token%'
                          OR LOWER(COALESCE(reason,'')) LIKE '%password%'
                          OR LOWER(COALESCE(reason,'')) LIKE '%exfil%'
                          OR LOWER(COALESCE(reason,'')) LIKE '%pii%'
                        THEN 1 ELSE 0
                    END) AS touched_secrets
                FROM tool_call_audit
                WHERE called_at >= datetime('now', ?)
                GROUP BY runtime_kind, tool_id
            )
            SELECT
                e.runtime_kind,
                e.tool_id,
                e.function_name,
                e.calls,
                e.blocked,
                e.allowed,
                e.logged,
                e.last_used,
                e.recent_risk,
                e.touched_secrets,
                s.effect AS synced_effect,
                s.policy_name AS synced_policy_name,
                s.org_name AS synced_org_name
            FROM edges e
            LEFT JOIN synced_tool_rules s ON s.tool_id = e.tool_id
            ORDER BY e.calls DESC
            """,
            (cutoff,),
        )
        return [dict(r) for r in rows] if rows else []

    async def get_audit_activity(self, window_days: int = 7) -> list[dict]:
        """Per-day verdict counts over the FULL trailing window.

        Backs the Timeline overview chart. Aggregated server-side in SQL so the
        chart reflects every enforced call in the window — not just the latest
        page the feed list happens to fetch. (The feed is paged at 200 rows;
        driving the chart off that page silently under-counted blocks whenever
        volume exceeded 200 — the chart said "Blocked 0" while the Map, which
        aggregates the full window, said "7 blocked". This method closes that
        gap so both views agree.)

        One row per (bucket, action, risk-bucket): ``called_at`` is the bucket
        timestamp (hourly for a 24h window, otherwise daily) as a full
        ``YYYY-MM-DD HH:MM:SS`` string the client can parse, ``n`` the count.
        ``risk`` is lower-cased so the client can apply the same high-risk test
        it uses on individual rows.
        """
        window_days = max(1, min(int(window_days), 90))
        cutoff = f"-{window_days} days"
        # Hourly resolution for the 24h window so it doesn't collapse to one
        # point; daily otherwise.
        bucket_fmt = "%Y-%m-%d %H:00:00" if window_days <= 1 else "%Y-%m-%d 00:00:00"
        # Bucket in a subquery first, then GROUP BY the projected column. If we
        # grouped in the same SELECT, SQLite binds ``GROUP BY called_at`` to the
        # raw table column (which exists) rather than the strftime alias, so no
        # collapse happens and every row comes back with n=1.
        rows = await self.db.fetch_all(
            f"""
            SELECT called_at, action, risk, COUNT(*) AS n
            FROM (
                SELECT
                    strftime('{bucket_fmt}', called_at) AS called_at,
                    COALESCE(action, 'allow') AS action,
                    LOWER(COALESCE(risk, '')) AS risk
                FROM tool_call_audit
                WHERE called_at >= datetime('now', ?)
            )
            GROUP BY called_at, action, risk
            ORDER BY called_at
            """,
            (cutoff,),
        )
        return [dict(r) for r in rows] if rows else []

    async def get_trace_runs(self, window_days: int = 7, limit: int = 50) -> list[dict]:
        """List agent runs (traces) in the window, newest first.

        One row per ``trace_id`` (a run = one runtime session, per the v36
        run-boundary rule). Each run carries its runtime, span count, block
        count, time bounds, and the distinct tools touched — enough to render
        the run list of the Agent Run Trace view (story #142). Rows with a NULL
        trace_id (no session id forwarded) are orphan single-span runs and are
        excluded from this rollup; they remain visible in Tool Activity.
        """
        window_days = max(1, min(int(window_days), 90))
        limit = max(1, min(int(limit), 500))
        cutoff = f"-{window_days} days"
        rows = await self.db.fetch_all(
            """
            SELECT
                trace_id,
                MAX(runtime_kind) AS runtime_kind,
                MAX(session_id) AS session_id,
                COUNT(*) AS spans,
                SUM(CASE WHEN action='block' THEN 1 ELSE 0 END) AS blocked,
                SUM(CASE WHEN action='log_only' THEN 1 ELSE 0 END) AS logged,
                MIN(called_at) AS started_at,
                MAX(called_at) AS ended_at,
                CASE WHEN MAX(CASE WHEN LOWER(COALESCE(risk,'')) IN ('delete','admin','write') THEN 1 ELSE 0 END) = 1 THEN 'admin' ELSE 'read' END AS recent_risk,
                GROUP_CONCAT(DISTINCT function_name) AS tools
            FROM tool_call_audit
            WHERE called_at >= datetime('now', ?) AND trace_id IS NOT NULL
            GROUP BY trace_id
            ORDER BY ended_at DESC
            LIMIT ?
            """,
            (cutoff, limit),
        )
        return [dict(r) for r in rows] if rows else []

    async def get_trace_spans(self, trace_id: str) -> list[dict]:
        """Return the ordered spans (tool-call audit rows) for one run.

        Ordered by ``seq`` — the globally-monotonic, uniquely-assigned hash-chain
        sequence — so the waterfall always reads top-to-bottom in true execution
        order. (``seq`` is the reliable order key; the stored ``turn_index`` is a
        best-effort write-time counter and the route renumbers it for display, so
        a concurrent-write collision can never surface as duplicate turn numbers.)
        Each span is one enforced tool call carrying its allow/block/log_only
        verdict, risk, reason, and timestamp.
        """
        rows = await self.db.fetch_all(
            """
            SELECT
                seq, turn_index, tool_id, function_name, action,
                risk, reason, called_at, runtime_kind, args_preview
            FROM tool_call_audit
            WHERE trace_id = ?
            ORDER BY seq ASC
            """,
            (trace_id,),
        )
        return [dict(r) for r in rows] if rows else []

    async def cleanup_old_audit_records(self, retention_days: int) -> int:
        """Delete audit rows older than ``retention_days``.

        Truncates the OLDEST end of the hash chain — the verifier in
        ``verify_audit_chain`` accepts the new lowest seq + its stored
        ``prev_hash`` as the post-truncation chain anchor, so the
        remaining rows still verify intact.

        THREAT MODEL: after truncation, the verifier proves the SURVIVING
        rows were not modified after they were written, but it cannot
        prove the deleted prefix wasn't replaced with forged rows by an
        actor with SQLite write access. Customers who need authenticity
        proof for the pruned prefix MUST run a SIEM forwarder that
        captured those rows before retention removed them.

        Returns the number of rows deleted.
        """
        if retention_days < 1:
            return 0
        cutoff = f"-{int(retention_days)} days"
        cursor = await self.db.execute(
            "DELETE FROM tool_call_audit WHERE called_at <= datetime('now', ?)",
            (cutoff,),
        )
        count = cursor.rowcount if cursor else 0
        if count > 0:
            logger.info(f"Cleaned up {count} old audit rows (retention: {retention_days} days)")
        return count
