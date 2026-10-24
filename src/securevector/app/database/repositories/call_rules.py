"""
Reads and writes for the named call-time rules: one `session_rule_state`
row per session with the times each rule was armed and cleared, and the
rule ids that fired. Timestamps and rule ids only; never a path, a host
or argument text.
"""

from __future__ import annotations

from typing import Optional

from securevector.app.database.connection import DatabaseConnection


class CallRulesRepository:
    def __init__(self, db: DatabaseConnection):
        self.db = db

    async def get(self, session_id: str) -> Optional[dict]:
        """One primary-key read."""
        row = await self.db.fetch_one("SELECT * FROM session_rule_state WHERE session_id = ?", (session_id,))
        return dict(row) if row else None

    async def mark(self, session_id: str, ts: str, *, cred: bool = False, outside: bool = False) -> None:
        """Stamp the credential read and or the outside read at `ts`."""
        if not (cred or outside):
            return
        await self.db.execute(
            "INSERT INTO session_rule_state (session_id, cred_read_at, outside_read_at, updated_at) "
            "VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET "
            "cred_read_at = COALESCE(excluded.cred_read_at, cred_read_at), "
            "outside_read_at = COALESCE(excluded.outside_read_at, outside_read_at), "
            "updated_at = excluded.updated_at",
            (session_id, ts if cred else None, ts if outside else None, ts),
        )

    async def clear(self, session_id: str, ts: str, *, cred: bool = False, outside: bool = False) -> None:
        """Stamp the clear time of one or both rules."""
        if not (cred or outside):
            return
        await self.db.execute(
            "INSERT INTO session_rule_state (session_id, cleared_cred_at, cleared_outside_at, updated_at) "
            "VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET "
            "cleared_cred_at = COALESCE(excluded.cleared_cred_at, cleared_cred_at), "
            "cleared_outside_at = COALESCE(excluded.cleared_outside_at, cleared_outside_at), "
            "updated_at = excluded.updated_at",
            (session_id, ts if cred else None, ts if outside else None, ts),
        )

    async def touch_held(self, session_id: str, ts: str) -> None:
        """Stamp the last time a call was held under a rule."""
        await self.db.execute(
            "INSERT INTO session_rule_state (session_id, last_held_at, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(session_id) DO UPDATE SET last_held_at = excluded.last_held_at, "
            "updated_at = excluded.updated_at",
            (session_id, ts, ts),
        )

    async def clear_to(self, session_id: str, ts: str, *, cred_at: Optional[str] = None,
                       outside_at: Optional[str] = None) -> None:
        """Clear a rule up to the arm time given (a later read re-arms it)."""
        if not (cred_at or outside_at):
            return
        await self.db.execute(
            "UPDATE session_rule_state SET "
            "cleared_cred_at = CASE WHEN ? IS NOT NULL AND (cleared_cred_at IS NULL OR cleared_cred_at < ?) "
            "THEN ? ELSE cleared_cred_at END, "
            "cleared_outside_at = CASE WHEN ? IS NOT NULL AND (cleared_outside_at IS NULL OR cleared_outside_at < ?) "
            "THEN ? ELSE cleared_outside_at END, updated_at = ? WHERE session_id = ?",
            (cred_at, cred_at, cred_at, outside_at, outside_at, outside_at, ts, session_id),
        )

    async def add_fired(self, session_id: str, rule_ids, ts: str) -> None:
        """Merge rule ids into the session's fired list (kept in order)."""
        row = await self.get(session_id)
        have = [r for r in ((row or {}).get("fired_rules") or "").split(",") if r]
        for rid in rule_ids or ():
            if rid and rid not in have:
                have.append(rid)
        await self.db.execute(
            "INSERT INTO session_rule_state (session_id, fired_rules, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(session_id) DO UPDATE SET fired_rules = excluded.fired_rules, "
            "updated_at = excluded.updated_at",
            (session_id, ",".join(have), ts),
        )

    async def fired_for(self, session_ids) -> dict:
        """Fired rule ids per session, for the review list. Reads only."""
        out: dict = {}
        ids = [i for i in session_ids or [] if i]
        for start in range(0, len(ids), 200):
            batch = ids[start:start + 200]
            ph = ",".join("?" for _ in batch)
            for r in await self.db.fetch_all(
                f"SELECT session_id, fired_rules FROM session_rule_state WHERE session_id IN ({ph})",
                tuple(batch),
            ):
                fired = [x for x in (r["fired_rules"] or "").split(",") if x]
                if fired:
                    out[r["session_id"]] = fired
        return out

    async def holds_by_mode(self, session_id: str, rules=None) -> dict:
        """This session's hold events counted per mode, for the given rule
        ids only when `rules` is set. Reads only."""
        sql = "SELECT mode, COUNT(*) AS n FROM response_holds WHERE session_id = ?"
        args: tuple = (session_id,)
        ids = [r for r in rules or () if r]
        if ids:
            sql += f" AND rule IN ({','.join('?' for _ in ids)})"
            args += tuple(ids)
        rows = await self.db.fetch_all(sql + " GROUP BY mode", args)
        return {r["mode"]: int(r["n"] or 0) for r in rows or []}
