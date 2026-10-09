"""
Reads and writes for the response rungs: one `session_rungs` row per
governed session and one `rung_modes` row per harness. Signal ids, counters
and timestamps only; never request text. Tables are created at startup, not
here.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from securevector.app.database.connection import DatabaseConnection


class ResponseRungsRepository:
    def __init__(self, db: DatabaseConnection):
        self.db = db

    # --- per session ------------------------------------------------------------

    async def get(self, session_id: str) -> Optional[dict]:
        row = await self.db.fetch_one("SELECT * FROM session_rungs WHERE session_id = ?", (session_id,))
        return dict(row) if row else None

    async def for_sessions(self, session_ids: list) -> dict:
        """Stored rung and mode per session, for the board. Reads only."""
        out: dict = {}
        ids = [i for i in session_ids if i]
        for start in range(0, len(ids), 200):
            batch = ids[start:start + 200]
            ph = ",".join("?" for _ in batch)
            for r in await self.db.fetch_all(
                f"SELECT session_id, rung, mode FROM session_rungs WHERE session_id IN ({ph})", tuple(batch)
            ):
                out[r["session_id"]] = dict(r)
        return out

    async def get_for_task(self, task_id: str) -> Optional[dict]:
        row = await self.db.fetch_one(
            "SELECT * FROM session_rungs WHERE task_id = ? ORDER BY last_eval_at DESC LIMIT 1", (task_id,)
        )
        return dict(row) if row else None

    async def upsert(self, session_id: str, task_id: Optional[str], harness: str, mode: str, state: Any,
                     now: str, ended: bool, released: bool = False) -> None:
        """One row per session, overwritten on each evaluation. The feedback
        mark and the first-ended stamp survive the overwrite."""
        await self.db.execute(
            """
            INSERT INTO session_rungs (session_id, task_id, harness, rung, mode, reasons_json, since,
                last_eval_at, released_at, last_drift_at, streak_watch, streak_high, last_r2_at, last_r3_at,
                cooldown_until, cooldown_kinds, pinned, peak_rung, counted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                task_id = COALESCE(excluded.task_id, task_id), harness = excluded.harness,
                rung = excluded.rung, mode = excluded.mode, reasons_json = excluded.reasons_json,
                since = excluded.since, last_eval_at = excluded.last_eval_at,
                released_at = COALESCE(excluded.released_at, released_at),
                last_drift_at = excluded.last_drift_at, streak_watch = excluded.streak_watch,
                streak_high = excluded.streak_high, last_r2_at = excluded.last_r2_at,
                last_r3_at = excluded.last_r3_at, cooldown_until = excluded.cooldown_until,
                cooldown_kinds = excluded.cooldown_kinds, pinned = excluded.pinned,
                peak_rung = excluded.peak_rung, counted_at = COALESCE(counted_at, excluded.counted_at)
            """,
            (
                session_id, task_id, harness, state.rung, mode, json.dumps(state.reasons), state.since or None,
                now, now if released else None, state.last_drift_at or None, state.streak_watch,
                state.streak_high, state.last_r2_at or None, state.last_r3_at or None,
                state.cooldown_until or None, json.dumps(state.cooldown_kinds), int(state.pinned),
                state.peak_rung, now if ended else None,
            ),
        )

    async def set_feedback(self, session_id: str, feedback: Optional[str]) -> None:
        await self.db.execute("UPDATE session_rungs SET feedback = ? WHERE session_id = ?", (feedback, session_id))

    # --- per harness ------------------------------------------------------------

    async def mode_row(self, harness: str, now: str, sig: str) -> dict:
        """The harness row, created in shadow on first sight. A change of
        drift weights or bands restarts shadow: mode back to shadow, clock
        and early end cleared."""
        await self.db.execute(
            "INSERT OR IGNORE INTO rung_modes (harness, mode, shadow_started_at, config_sig) "
            "VALUES (?, 'shadow', ?, ?)",
            (harness, now, sig),
        )
        row = dict(await self.db.fetch_one("SELECT * FROM rung_modes WHERE harness = ?", (harness,)))
        if row.get("config_sig") != sig:
            await self.db.execute(
                "UPDATE rung_modes SET mode = 'shadow', shadow_started_at = ?, early_ended = 0, "
                "activated_at = NULL, config_sig = ? WHERE harness = ?",
                (now, sig, harness),
            )
            row = dict(await self.db.fetch_one("SELECT * FROM rung_modes WHERE harness = ?", (harness,)))
        return row

    async def mode_peek(self, harness: str) -> Optional[dict]:
        """Read only: the harness row as stored, or None. No insert, no reset."""
        row = await self.db.fetch_one("SELECT * FROM rung_modes WHERE harness = ?", (harness,))
        return dict(row) if row else None

    async def set_mode(self, harness: str, mode: str, now: str) -> None:
        await self.db.execute(
            "UPDATE rung_modes SET mode = ?, activated_at = ? WHERE harness = ?",
            (mode, now if mode == "active" else None, harness),
        )

    async def set_early_end(self, harness: str, on: bool, now: str) -> None:
        await self.db.execute(
            "INSERT OR IGNORE INTO rung_modes (harness, mode, shadow_started_at) VALUES (?, 'shadow', ?)",
            (harness, now),
        )
        await self.db.execute("UPDATE rung_modes SET early_ended = ? WHERE harness = ?", (int(on), harness))

    async def shadow_counts(self, harness: str, started: str) -> tuple:
        """(ended sessions evaluated in shadow, unintended step-ups) since
        the shadow clock started. Unintended: a session that reached rung 3
        and was marked "Not needed" or "Looks normal"."""
        row = await self.db.fetch_one(
            "SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN r.peak_rung >= 3 AND (r.feedback = 'not_needed' "
            "OR d.feedback = 'normal') THEN 1 ELSE 0 END), 0) AS bad "
            "FROM session_rungs r LEFT JOIN session_drift d ON d.session_id = r.session_id "
            "WHERE r.harness = ? AND r.mode = 'shadow' AND r.counted_at IS NOT NULL AND r.counted_at >= ?",
            (harness, started),
        )
        return (int(row["n"] or 0), int(row["bad"] or 0)) if row else (0, 0)

    async def shadow_stepups(self, harness: str, started: str) -> list:
        rows = await self.db.fetch_all(
            "SELECT session_id, reasons_json, would_ask FROM session_rungs WHERE harness = ? AND mode = 'shadow' "
            "AND peak_rung >= 3 AND last_eval_at >= ?",
            (harness, started),
        )
        return [dict(r) for r in rows]

    async def all_modes(self) -> list:
        rows = await self.db.fetch_all("SELECT * FROM rung_modes ORDER BY harness")
        return [dict(r) for r in rows]

    async def add_would_ask(self, session_id: str) -> None:
        """Shadow mode: one call that active mode would have held for approval."""
        await self.db.execute(
            "UPDATE session_rungs SET would_ask = COALESCE(would_ask, 0) + 1 WHERE session_id = ?", (session_id,)
        )

    # --- approvals filed by a rung (rule_source = 'rung') ----------------------

    async def granted_tools(self, session_id: str) -> set:
        """Lower-cased tool ids with a rung grant in force for this session."""
        rows = await self.db.fetch_all(
            "SELECT g.tool_id FROM jit_access_grants g JOIN jit_access_requests r ON r.id = g.request_id "
            "WHERE r.rule_source = 'rung' AND g.session_id = ? AND g.revoked_at IS NULL "
            "AND (g.expires_at IS NULL OR g.expires_at > datetime('now'))",
            (session_id,),
        )
        return {str(r["tool_id"]).lower() for r in rows or []}

    async def rung_request_ids(self, request_ids) -> set:
        ids = [str(i) for i in request_ids or [] if i][:500]
        if not ids:
            return set()
        marks = ",".join("?" for _ in ids)
        rows = await self.db.fetch_all(
            f"SELECT id FROM jit_access_requests WHERE rule_source = 'rung' AND id IN ({marks})", tuple(ids)
        )
        return {r["id"] for r in rows or []}

    async def requests_in_last_hour(self, session_id: str) -> int:
        row = await self.db.fetch_one(
            "SELECT COUNT(*) AS n FROM jit_access_requests WHERE rule_source = 'rung' AND session_id = ? "
            "AND requested_at >= datetime('now', '-1 hour')",
            (session_id,),
        )
        return int(row["n"] or 0) if row else 0

    async def latest_pending(self, session_id: str) -> Optional[dict]:
        row = await self.db.fetch_one(
            "SELECT * FROM jit_access_requests WHERE rule_source = 'rung' AND session_id = ? "
            "AND status = 'pending' ORDER BY requested_at DESC, rowid DESC LIMIT 1",
            (session_id,),
        )
        return dict(row) if row else None

    async def active_grant_ids(self, session_id: str) -> list:
        rows = await self.db.fetch_all(
            "SELECT g.id FROM jit_access_grants g JOIN jit_access_requests r ON r.id = g.request_id "
            "WHERE r.rule_source = 'rung' AND g.session_id = ? AND g.revoked_at IS NULL",
            (session_id,),
        )
        return [r["id"] for r in rows or []]

    async def cancel_pending(self, session_id: str) -> int:
        cur = await self.db.execute(
            "UPDATE jit_access_requests SET status = 'denied', decided_at = CURRENT_TIMESTAMP, "
            "decided_by = 'release', deny_reason = 'Session released' "
            "WHERE rule_source = 'rung' AND session_id = ? AND status = 'pending'",
            (session_id,),
        )
        return cur.rowcount if cur else 0
