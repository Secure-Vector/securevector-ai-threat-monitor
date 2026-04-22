"""
Repository for user-defined custom tools.

Users can register their own agent tools (e.g. research, transcribe)
and control permissions through the same block/allow system as essential tools.
"""

import hashlib
import logging
from typing import Optional

from securevector.app.database.connection import DatabaseConnection

logger = logging.getLogger(__name__)

# Sentinel prev_hash for the first row in the chain.
_AUDIT_GENESIS_HASH = "GENESIS"


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
        """
        conn = await self.db.connect()

        # Atomically: read tail of chain → compute new row_hash → insert.
        # SQLite's default isolation level gives us a single-writer transaction here.
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

        await conn.execute(
            """
            INSERT INTO tool_call_audit
                (tool_id, function_name, action, risk, reason, is_essential,
                 args_preview, called_at, seq, prev_hash, row_hash, device_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            ),
        )
        await conn.commit()

    async def verify_audit_chain(self) -> dict:
        """Walk the tool_call_audit hash chain and report integrity status.

        Returns:
            dict with keys:
              - ok            (bool)    — True iff every row_hash recomputes
              - total         (int)     — rows scanned
              - tampered_at   (int|None) — seq of the first row that failed
              - tampered_id   (int|None) — DB id of the first row that failed
              - reason        (str|None) — short human-readable diagnosis
              - last_verified_at (str)   — ISO timestamp of this check
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

        prev_hash = _AUDIT_GENESIS_HASH
        expected_seq = 1
        for row in rows:
            if row["seq"] != expected_seq:
                return {
                    "ok": False,
                    "total": len(rows),
                    "tampered_at": expected_seq,
                    "tampered_id": row["id"],
                    "reason": f"seq gap: expected {expected_seq}, got {row['seq']}",
                    "last_verified_at": datetime.now(timezone.utc).isoformat(),
                }
            if row["prev_hash"] != prev_hash:
                return {
                    "ok": False,
                    "total": len(rows),
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
                       seq, prev_hash, row_hash, device_id
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
                       seq, prev_hash, row_hash, device_id
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
