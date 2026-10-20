"""
Storage for the "stop the session and alert" switch: the per agent tool
switch (``rung_modes.stop_high``) and one ``session_stops`` row per session
the switch acted on. Ids, states and times only.
"""

from __future__ import annotations

from typing import Optional

from securevector.app.database.connection import DatabaseConnection


class SessionStopsRepository:
    def __init__(self, db: DatabaseConnection):
        self.db = db

    # --- per agent tool switch ---------------------------------------------------

    async def switch_on(self, harness: str) -> bool:
        if not harness:
            return False
        try:
            row = await self.db.fetch_one("SELECT stop_high FROM rung_modes WHERE harness = ?", (harness,))
        except Exception:  # noqa: BLE001 - no column yet reads as off
            return False
        return bool(row and row["stop_high"])

    async def set_switch(self, harness: str, on: bool) -> None:
        """The row must exist (the caller creates it with the mode)."""
        await self.db.execute("UPDATE rung_modes SET stop_high = ? WHERE harness = ?", (int(bool(on)), harness))

    # --- per session record ---------------------------------------------------------

    async def claim(self, session_id: str, task_id: Optional[str], harness: str, trigger: str,
                    test_mode: bool, ts: str, upgrade_from: Optional[str] = None) -> bool:
        """Record that the switch acts on this session. False when it already
        did: one action per session, whichever trigger came first. With
        `upgrade_from`, a finished record of that trigger may be taken over
        once (a would-have on a settling score, then a real stop)."""
        conn = await self.db.connect()
        cur = await conn.execute(
            "INSERT OR IGNORE INTO session_stops (session_id, task_id, harness, trigger, outcome, test_mode, ts) "
            "VALUES (?, ?, ?, ?, '', ?, ?)",
            (session_id, task_id, harness, trigger, int(bool(test_mode)), ts),
        )
        claimed = (cur.rowcount or 0) > 0
        if not claimed and upgrade_from:
            cur = await conn.execute(
                "UPDATE session_stops SET trigger = ?, outcome = '', test_mode = ?, ts = ?, alerted = 0 "
                "WHERE session_id = ? AND trigger = ? AND outcome != ''",
                (trigger, int(bool(test_mode)), ts, session_id, upgrade_from),
            )
            claimed = (cur.rowcount or 0) > 0
        await conn.commit()
        return claimed

    async def release(self, session_id: str) -> None:
        """Drop an unfinished claim (nothing was running to act on)."""
        await self.db.execute("DELETE FROM session_stops WHERE session_id = ? AND outcome = ''", (session_id,))

    async def finish(self, session_id: str, outcome: str, alerted: int) -> None:
        await self.db.execute(
            "UPDATE session_stops SET outcome = ?, alerted = ? WHERE session_id = ?",
            (outcome, int(alerted), session_id),
        )

    async def get(self, session_id: str) -> Optional[dict]:
        row = await self.db.fetch_one("SELECT * FROM session_stops WHERE session_id = ?", (session_id,))
        return dict(row) if row else None

    async def for_sessions(self, session_ids: list) -> dict:
        ids = [s for s in dict.fromkeys(session_ids) if s][:500]
        if not ids:
            return {}
        marks = ",".join("?" for _ in ids)
        rows = await self.db.fetch_all(
            f"SELECT * FROM session_stops WHERE outcome != '' AND session_id IN ({marks})", tuple(ids)
        )
        return {r["session_id"]: dict(r) for r in rows or []}
