"""
Reads and writes for pre-flight policy checks: the logical session handles
an MCP process is given, and one `policy_decisions` row per check.

Rows hold hashes of the action and its target, the decision, a coarse
reason and the policy version. Argument text, paths and hosts are never
written here; the hash-chained `tool_call_audit` row carries the redacted
preview as every other audit row does.
"""

from __future__ import annotations

import time
from typing import Iterable, Optional

from securevector.app.database.connection import DatabaseConnection

_CHUNK = 400


def iso(epoch: Optional[float] = None) -> str:
    """UTC 'YYYY-MM-DDTHH:MM:SS', the one timestamp format these tables use,
    so string order is time order."""
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() if epoch is None else epoch))


class PolicyDecisionsRepository:
    def __init__(self, db: DatabaseConnection):
        self.db = db

    # --- logical sessions -------------------------------------------------------

    async def get_session(self, handle: str) -> Optional[dict]:
        row = await self.db.fetch_one("SELECT * FROM logical_sessions WHERE handle = ?", (handle,))
        return dict(row) if row else None

    async def create_session(self, *, handle: str, harness: Optional[str], cwd_hash: Optional[str],
                             task_id: Optional[str], harness_session_id: Optional[str],
                             binding: str, now: str) -> dict:
        await self.db.execute(
            "INSERT INTO logical_sessions (handle, harness, cwd_hash, task_id, harness_session_id, "
            "binding, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (handle, harness, cwd_hash, task_id, harness_session_id, binding, now, now),
        )
        return await self.get_session(handle) or {}

    async def touch_session(self, handle: str, now: str, *, harness_session_id: Optional[str] = None,
                            binding: Optional[str] = None) -> None:
        await self.db.execute(
            "UPDATE logical_sessions SET last_seen_at = ?, "
            "harness_session_id = COALESCE(?, harness_session_id), "
            "binding = COALESCE(?, binding) WHERE handle = ?",
            (now, harness_session_id, binding, handle),
        )

    async def close_session(self, handle: str, now: str) -> None:
        await self.db.execute(
            "UPDATE logical_sessions SET closed_at = ? WHERE handle = ? AND closed_at IS NULL",
            (now, handle),
        )

    async def claimed_harness_sessions(self) -> set:
        rows = await self.db.fetch_all(
            "SELECT harness_session_id FROM logical_sessions "
            "WHERE harness_session_id IS NOT NULL AND closed_at IS NULL"
        )
        return {r["harness_session_id"] for r in rows}

    async def handles_for_task(self, task_id: str) -> list:
        rows = await self.db.fetch_all(
            "SELECT handle FROM logical_sessions WHERE task_id = ? AND binding = 'verified'",
            (task_id,),
        )
        return [r["handle"] for r in rows]

    async def handles_for_harness_session(self, harness_session_id: str, *, unverified_only: bool = False) -> list:
        sql = "SELECT handle FROM logical_sessions WHERE harness_session_id = ?"
        if unverified_only:
            sql += " AND binding != 'verified'"
        rows = await self.db.fetch_all(sql, (harness_session_id,))
        return [r["handle"] for r in rows]

    # --- decisions ------------------------------------------------------------------

    async def insert_decision(self, row: dict) -> None:
        await self.db.execute(
            "INSERT INTO policy_decisions (jti, session, task_id, action_kind, tool_name, action_hash, "
            "target_hash, decision, reason, policy_version, issued_at, expires_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                row["jti"], row["session"], row.get("task_id"), row["action_kind"], row.get("tool_name"),
                row["action_hash"], row["target_hash"], row["decision"], row["reason"],
                row.get("policy_version"), row["issued_at"], row.get("expires_at"),
            ),
        )

    async def get_decision(self, jti: str) -> Optional[dict]:
        row = await self.db.fetch_one("SELECT * FROM policy_decisions WHERE jti = ?", (jti,))
        return dict(row) if row else None

    async def recent_for_action(self, handles: Iterable[str], action_hash: str, since: str) -> list:
        """Rows for this action in these sessions issued at or after `since`,
        newest first."""
        ids = [h for h in dict.fromkeys(handles or []) if h][:_CHUNK]
        if not ids:
            return []
        marks = ",".join("?" for _ in ids)
        rows = await self.db.fetch_all(
            f"SELECT * FROM policy_decisions WHERE session IN ({marks}) AND action_hash = ? "
            "AND issued_at >= ? ORDER BY issued_at DESC, rowid DESC",
            (*ids, action_hash, since),
        )
        return [dict(r) for r in rows]

    async def consume(self, jti: str, now: str) -> bool:
        """Single use: only the first caller flips an unconsumed row."""
        cur = await self.db.execute(
            "UPDATE policy_decisions SET consumed_at = ?, consume_result = 'matched' "
            "WHERE jti = ? AND consumed_at IS NULL",
            (now, jti),
        )
        return bool(cur.rowcount)

    async def set_result(self, jti: str, result: str) -> None:
        """Record why a matching row did not short-cut enforcement. A row
        already consumed keeps its result."""
        await self.db.execute(
            "UPDATE policy_decisions SET consume_result = ? WHERE jti = ? AND consumed_at IS NULL",
            (result, jti),
        )

    async def mark_attempted_after_deny(self, jti: str) -> bool:
        cur = await self.db.execute(
            "UPDATE policy_decisions SET attempted_after_deny = 1 "
            "WHERE jti = ? AND decision = 'deny' AND attempted_after_deny = 0",
            (jti,),
        )
        return bool(cur.rowcount)

    async def approved_since(self, harness_session_id: Optional[str], harness: Optional[str],
                             since: str) -> bool:
        """A JIT grant made for this session (or for every session of this
        harness) after `since`."""
        row = await self.db.fetch_one(
            "SELECT 1 FROM jit_access_grants WHERE revoked_at IS NULL "
            "AND (session_id IS NULL OR session_id = ?) "
            "AND (runtime_kind IS NULL OR ? IS NULL OR runtime_kind = ?) "
            "AND granted_at >= ? LIMIT 1",
            (harness_session_id, harness, harness, since.replace("T", " ")),
        )
        return row is not None

    # --- reads for the session views and drift ----------------------------------------

    async def handles_for_view(self, task_id: Optional[str], harness_session_id: Optional[str]) -> list:
        handles = []
        if task_id:
            handles += await self.handles_for_task(task_id)
        if harness_session_id:
            handles += await self.handles_for_harness_session(harness_session_id)
        return list(dict.fromkeys(handles))

    async def decisions_for(self, handles: Iterable[str]) -> list:
        ids = [h for h in dict.fromkeys(handles or []) if h][:_CHUNK]
        if not ids:
            return []
        marks = ",".join("?" for _ in ids)
        rows = await self.db.fetch_all(
            "SELECT action_kind, decision, issued_at, expires_at, consumed_at, consume_result, "
            f"attempted_after_deny FROM policy_decisions WHERE session IN ({marks}) "
            "ORDER BY issued_at DESC, rowid DESC",
            tuple(ids),
        )
        return [dict(r) for r in rows]

    async def attempts_after_deny(self, harness_session_id: Optional[str], task_id: Optional[str] = None) -> int:
        """Denied pre-flight checks that were attempted anyway, for the
        sessions linked to one harness session or task."""
        handles = await self.handles_for_view(task_id, harness_session_id)
        if not handles:
            return 0
        marks = ",".join("?" for _ in handles[:_CHUNK])
        row = await self.db.fetch_one(
            f"SELECT COUNT(*) AS n FROM policy_decisions WHERE session IN ({marks}) "
            "AND attempted_after_deny = 1",
            tuple(handles[:_CHUNK]),
        )
        return int(row["n"] or 0) if row else 0
