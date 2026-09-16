"""SQLite persistence for Agent Terminals: the board and its audit trail."""

from __future__ import annotations

import asyncio
import hashlib
import sqlite3
from datetime import datetime, timezone
from typing import Any, Optional

from securevector.app.database.connection import DatabaseConnection

RUNNING = ("starting", "working", "blocked", "idle")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _row(r: Optional[sqlite3.Row]) -> Optional[dict[str, Any]]:
    return dict(r) if r is not None else None


class TerminalStore:
    def __init__(self, db: DatabaseConnection) -> None:
        self.db = db
        # DatabaseConnection.transaction() takes no lock of its own and
        # every caller shares one aiosqlite connection, so two concurrent
        # add_event calls can interleave a BEGIN inside another BEGIN
        # ("cannot start a transaction within a transaction"), aborting one
        # of them. Serialise the whole read-prev-then-insert body here so
        # the hash chain never loses or misorders an event.
        #
        # Lazy-initialised for the same reason as DatabaseConnection._lock
        # (see database/connection.py): on Python 3.9 `asyncio.Lock()`
        # eagerly calls `events.get_event_loop()`, which raises when a
        # TerminalStore is constructed from sync code before an event loop
        # exists. Asyncio's cooperative single-thread model makes the
        # check + assign in add_event race-free without a sync primitive.
        self._lock: Optional[asyncio.Lock] = None

    # -- tasks -------------------------------------------------------------

    async def create_task(
        self,
        task_id: str,
        *,
        executor_id: str,
        workspace: str,
        title: Optional[str],
        pid: Optional[int],
    ) -> None:
        await self.db.execute(
            "INSERT INTO terminal_tasks (id, executor_id, workspace, title, status, pid, created_at) "
            "VALUES (?, ?, ?, ?, 'starting', ?, ?)",
            (task_id, executor_id, workspace, title, pid, _now()),
        )

    async def update_pid(self, task_id: str, pid: Optional[int]) -> None:
        await self.db.execute("UPDATE terminal_tasks SET pid = ? WHERE id = ?", (pid, task_id))

    async def get_task(self, task_id: str) -> Optional[dict[str, Any]]:
        return _row(
            await self.db.fetch_one("SELECT * FROM terminal_tasks WHERE id = ?", (task_id,))
        )

    async def list_tasks(
        self, running_only: bool = False, limit: int = 200
    ) -> list[dict[str, Any]]:
        if running_only:
            placeholders = ",".join("?" * len(RUNNING))
            rows = await self.db.fetch_all(
                f"SELECT * FROM terminal_tasks WHERE archived_at IS NULL AND status IN ({placeholders}) "
                "ORDER BY created_at DESC, rowid DESC LIMIT ?",
                (*RUNNING, limit),
            )
        else:
            rows = await self.db.fetch_all(
                "SELECT * FROM terminal_tasks WHERE archived_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?",
                (limit,),
            )
        return [dict(r) for r in rows]

    async def archive_task(self, task_id: str) -> bool:
        """Remove a finished task from the board without deleting its audit."""
        task = await self.get_task(task_id)
        if task is None:
            return False
        if task["status"] in RUNNING:
            raise ValueError("Stop the task before removing it from the board")
        await self.db.execute(
            "UPDATE terminal_tasks SET archived_at = ? WHERE id = ? AND archived_at IS NULL",
            (_now(), task_id),
        )
        await self.add_event(task_id, kind="archived", origin="ui", detail="Removed from Agent Tasks board")
        return True

    async def set_session(self, task_id: str, session_id: str) -> None:
        await self.db.execute(
            "UPDATE terminal_tasks SET session_id = ? WHERE id = ?", (session_id, task_id)
        )

    async def update_status(
        self, task_id: str, status: str, *, activity: Optional[str] = None
    ) -> None:
        if activity is None:
            await self.db.execute(
                "UPDATE terminal_tasks SET status = ?, last_activity_at = ? WHERE id = ?",
                (status, _now(), task_id),
            )
        else:
            await self.db.execute(
                "UPDATE terminal_tasks SET status = ?, activity = ?, last_activity_at = ? WHERE id = ?",
                (status, activity[:200], _now(), task_id),
            )

    async def set_exit(self, task_id: str, exit_code: Optional[int]) -> None:
        status = "done" if exit_code == 0 else "failed"
        await self.db.execute(
            "UPDATE terminal_tasks SET status = ?, exit_code = ?, ended_at = ? WHERE id = ?",
            (status, exit_code, _now(), task_id),
        )

    async def mark_running_interrupted(self) -> list[dict[str, Any]]:
        placeholders = ",".join("?" * len(RUNNING))
        rows = await self.db.fetch_all(
            f"SELECT * FROM terminal_tasks WHERE status IN ({placeholders}) "
            "ORDER BY created_at DESC, rowid DESC",
            RUNNING,
        )
        ids = [r["id"] for r in rows]
        if not ids:
            return []
        now = _now()
        for task_id in ids:
            await self.db.execute(
                "UPDATE terminal_tasks SET status = 'interrupted', ended_at = ? WHERE id = ?",
                (now, task_id),
            )
        id_placeholders = ",".join("?" * len(ids))
        updated = await self.db.fetch_all(
            f"SELECT * FROM terminal_tasks WHERE id IN ({id_placeholders}) "
            "ORDER BY created_at DESC, rowid DESC",
            ids,
        )
        return [dict(r) for r in updated]

    # -- events (hash chained) --------------------------------------------

    @staticmethod
    def _hash(
        prev: Optional[str],
        task_id: str,
        kind: str,
        origin: str,
        detail: Optional[str],
        created_at: str,
    ) -> str:
        h = hashlib.sha256()
        for part in (prev or "", task_id, kind, origin, detail or "", created_at):
            h.update(part.encode("utf-8"))
            h.update(b"\x00")
        return h.hexdigest()

    async def add_event(
        self, task_id: str, *, kind: str, origin: str, detail: Optional[str] = None
    ) -> int:
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            async with self.db.transaction() as conn:
                cur = await conn.execute(
                    "SELECT row_hash FROM terminal_events ORDER BY seq DESC LIMIT 1"
                )
                last = await cur.fetchone()
                prev = last["row_hash"] if last else None
                created_at = _now()
                row_hash = self._hash(prev, task_id, kind, origin, detail, created_at)
                cur = await conn.execute(
                    "INSERT INTO terminal_events (task_id, kind, origin, detail, prev_hash, row_hash, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (task_id, kind, origin, detail, prev, row_hash, created_at),
                )
                return int(cur.lastrowid)

    async def list_events(self, task_id: str, limit: int = 200) -> list[dict[str, Any]]:
        rows = await self.db.fetch_all(
            "SELECT * FROM terminal_events WHERE task_id = ? ORDER BY seq ASC LIMIT ?",
            (task_id, limit),
        )
        return [dict(r) for r in rows]

    async def list_verdicts(self, session_id: str, limit: int = 200) -> list[dict[str, Any]]:
        rows = await self.db.fetch_all(
            "SELECT tool_id, function_name, action, risk, reason, args_preview, called_at "
            "FROM tool_call_audit WHERE session_id = ? ORDER BY called_at DESC, rowid DESC LIMIT ?",
            (session_id, limit),
        )
        return [dict(r) for r in rows]

    async def verify_chain(self) -> dict[str, Any]:
        rows = await self.db.fetch_all("SELECT * FROM terminal_events ORDER BY seq ASC")
        prev: Optional[str] = None
        for r in rows:
            expected = self._hash(
                prev, r["task_id"], r["kind"], r["origin"], r["detail"], r["created_at"]
            )
            if r["prev_hash"] != prev or r["row_hash"] != expected:
                return {"ok": False, "checked": len(rows), "first_bad_seq": r["seq"]}
            prev = r["row_hash"]
        return {"ok": True, "checked": len(rows), "first_bad_seq": None}
