"""
Reads and writes for the Session Drift Score.

Every read here is keyed on `session_id` (or a short list of baseline
session ids) and uses the existing session indexes on `tool_call_audit` and
`egress_audit`. The one write is the `session_drift` row: the score, band,
status, feature counts and the "looks normal" mark. Argument previews are
read only to match credential locations in memory; they are never written.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

from securevector.app.database.connection import DatabaseConnection

logger = logging.getLogger(__name__)

# SQLite caps bound parameters per statement; keep well under it.
_CHUNK = 400
_BOUNDARY = ("__session_start__", "__session_end__")
_OBSERVED = "observed"
_RUNNING = ("starting", "working", "blocked", "idle")


def _chunks(items: list) -> Iterable[list]:
    for start in range(0, len(items), _CHUNK):
        yield items[start:start + _CHUNK]


class SessionDriftRepository:
    def __init__(self, db: DatabaseConnection):
        self.db = db

    # --- the scored session ---------------------------------------------------

    async def task(self, task_id: str) -> Optional[dict]:
        row = await self.db.fetch_one("SELECT * FROM terminal_tasks WHERE id = ?", (task_id,))
        return dict(row) if row else None

    async def task_for_session(self, session_id: str) -> Optional[dict]:
        row = await self.db.fetch_one(
            "SELECT * FROM terminal_tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
            (session_id,),
        )
        return dict(row) if row else None

    async def session_calls(self, session_id: str, limit: int = 20000) -> list:
        rows = await self.db.fetch_all(
            "SELECT tool_id, function_name, action, reason, args_preview, called_at "
            "FROM tool_call_audit WHERE session_id = ? ORDER BY called_at ASC, id ASC LIMIT ?",
            (session_id, limit),
        )
        return [dict(r) for r in rows]

    async def session_harness(self, session_id: str) -> Optional[str]:
        row = await self.db.fetch_one(
            "SELECT runtime_kind FROM tool_call_audit WHERE session_id = ? "
            "AND runtime_kind IS NOT NULL LIMIT 1",
            (session_id,),
        )
        return row["runtime_kind"] if row else None

    async def session_egress(self, session_id: str) -> dict:
        """One session's egress shape, the per-session form of
        EgressRepository.session_scope: distinct hosts, hosts this device
        first contacted inside the session (by row id, as there), and span."""
        rows = await self.db.fetch_all(
            """
            SELECT a.host AS host,
                   MIN(a.id) AS first_here,
                   (SELECT MIN(e.id) FROM egress_audit e
                     WHERE e.host = a.host AND e.action != ?) AS first_any,
                   COUNT(*) AS calls,
                   MIN(a.timestamp) AS started_at,
                   MAX(a.timestamp) AS ended_at
            FROM egress_audit a
            WHERE a.session_id = ? AND a.host IS NOT NULL AND a.action != ?
            GROUP BY a.host
            """,
            (_OBSERVED, session_id, _OBSERVED),
        )
        hosts = [r["host"] for r in rows]
        starts = [r["started_at"] for r in rows if r["started_at"]]
        ends = [r["ended_at"] for r in rows if r["ended_at"]]
        span = 0.0
        if starts and ends:
            from securevector.app.terminals.store import parse_ts

            a, b = parse_ts(min(starts)), parse_ts(max(ends))
            if a and b:
                span = max(0.0, (b - a).total_seconds() / 60.0)
        return {
            "session_id": session_id,
            "distinct_hosts": len(hosts),
            "novel_hosts": sum(1 for r in rows if r["first_here"] == r["first_any"]),
            "calls": sum(int(r["calls"] or 0) for r in rows),
            "span_minutes": span,
            "hosts": hosts,
        }

    async def known_host_count(self) -> int:
        row = await self.db.fetch_one(
            "SELECT COUNT(DISTINCT host) AS n FROM egress_audit WHERE host IS NOT NULL AND action != ?",
            (_OBSERVED,),
        )
        return int(row["n"] or 0) if row else 0

    async def session_jit(self, session_id: str) -> list:
        rows = await self.db.fetch_all(
            "SELECT tool_id, function_name, status, requested_at FROM jit_access_requests "
            "WHERE session_id = ? ORDER BY requested_at ASC",
            (session_id,),
        )
        return [dict(r) for r in rows]

    # --- the baseline ------------------------------------------------------------

    async def baseline_sessions(self, harness: str, since: datetime) -> dict:
        """Per-session aggregates for every candidate baseline session of one
        harness: ended in the window, or marked "looks normal". Returns
        {session_id: {workspace, ended_at, calls, tools, hosts}}."""
        cands: dict = {}
        # terminal_tasks.ended_at is ISO with milliseconds and an offset, the
        # same shape as `since` here, so the window filter is a text compare.
        for r in await self.db.fetch_all(
            "SELECT session_id, workspace, ended_at FROM terminal_tasks "
            "WHERE session_id IS NOT NULL AND ended_at IS NOT NULL AND ended_at >= ? "
            "AND executor_id = ?",
            (since.astimezone(timezone.utc).isoformat(timespec="milliseconds"), harness),
        ):
            cur = cands.get(r["session_id"])
            if not cur or str(r["ended_at"]) > str(cur["ended_at"]):
                cands[r["session_id"]] = {"workspace": r["workspace"], "ended_at": r["ended_at"]}
        # "Looks normal" adds a session only once it has ended.
        for r in await self.db.fetch_all(
            "SELECT d.session_id, d.workspace, MAX(t.ended_at) AS ended_at FROM session_drift d "
            "JOIN terminal_tasks t ON t.session_id = d.session_id "
            "WHERE d.feedback = 'normal' AND d.harness = ? AND t.ended_at IS NOT NULL "
            "AND datetime(d.computed_at) >= datetime(?) "
            "AND NOT EXISTS (SELECT 1 FROM terminal_tasks r WHERE r.session_id = d.session_id "
            "                AND r.ended_at IS NULL) "
            "GROUP BY d.session_id, d.workspace",
            (harness, since.astimezone(timezone.utc).isoformat(timespec="seconds")),
        ):
            cands.setdefault(r["session_id"], {"workspace": r["workspace"], "ended_at": r["ended_at"]})
        out = {sid: dict(v, calls=0, tools=set(), hosts=set()) for sid, v in cands.items()}
        ids = list(out)
        for batch in _chunks(ids):
            ph = ",".join("?" for _ in batch)
            for r in await self.db.fetch_all(
                "SELECT session_id, function_name, COUNT(*) AS n FROM tool_call_audit "
                f"WHERE session_id IN ({ph}) AND function_name NOT IN (?, ?) "
                "GROUP BY session_id, function_name",
                (*batch, *_BOUNDARY),
            ):
                s = out[r["session_id"]]
                s["calls"] += int(r["n"] or 0)
                s["tools"].add(r["function_name"])
            for r in await self.db.fetch_all(
                "SELECT session_id, host FROM egress_audit "
                f"WHERE session_id IN ({ph}) AND host IS NOT NULL AND action != ? "
                "GROUP BY session_id, host",
                (*batch, _OBSERVED),
            ):
                out[r["session_id"]]["hosts"].add(str(r["host"]).lower())
        return out

    async def location_sessions(self, locations: Iterable[str], session_ids: list) -> dict:
        """For each credential location the scored session reached, how many
        baseline sessions reached it too with an allowed call. Only the few
        locations hit are probed, so this stays cheap on a large baseline."""
        from securevector.app.services import session_drift as drift

        out: dict = {}
        for loc in locations:
            kind, frags = drift.location_probe(loc)
            if not frags or not session_ids:
                out[loc] = 0
                continue
            col = "lower(args_preview)" if kind == "path" else "args_preview"
            like = " OR ".join(f"instr({col}, ?) > 0" for _ in frags)
            seen: set = set()
            for batch in _chunks(session_ids):
                ph = ",".join("?" for _ in batch)
                for r in await self.db.fetch_all(
                    "SELECT session_id, args_preview FROM tool_call_audit "
                    f"WHERE session_id IN ({ph}) AND action != 'block' AND ({like})",
                    (*batch, *frags),
                ):
                    if r["session_id"] not in seen and loc in drift.location_matches(r["args_preview"]):
                        seen.add(r["session_id"])
            out[loc] = len(seen)
        return out

    # --- the stored row -----------------------------------------------------------

    async def upsert(self, session_id: str, task_id: Optional[str], harness: str,
                     workspace: Optional[str], result: Any) -> None:
        """One row per session, overwritten on each compute. The feedback mark
        survives the overwrite."""
        from securevector.app.services import session_drift as drift

        await self.db.execute(
            """
            INSERT INTO session_drift (session_id, task_id, harness, workspace, score, band, status,
                                       features_json, baseline_sessions, baseline_calls, computed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                task_id = excluded.task_id, harness = excluded.harness, workspace = excluded.workspace,
                score = excluded.score, band = excluded.band, status = excluded.status,
                features_json = excluded.features_json, baseline_sessions = excluded.baseline_sessions,
                baseline_calls = excluded.baseline_calls, computed_at = excluded.computed_at
            """,
            (
                session_id, task_id, harness, workspace, result.score, result.band, result.status,
                drift.features_json(result), int(result.baseline.get("sessions") or 0),
                int(result.baseline.get("calls") or 0), result.computed_at,
            ),
        )

    async def get(self, session_id: str) -> Optional[dict]:
        row = await self.db.fetch_one("SELECT * FROM session_drift WHERE session_id = ?", (session_id,))
        return dict(row) if row else None

    async def for_sessions(self, session_ids: list) -> dict:
        """Stored score, band and status per session, for the board."""
        out: dict = {}
        ids = [i for i in session_ids if i]
        for batch in _chunks(ids):
            ph = ",".join("?" for _ in batch)
            for r in await self.db.fetch_all(
                f"SELECT session_id, score, band, status, feedback FROM session_drift WHERE session_id IN ({ph})",
                tuple(batch),
            ):
                out[r["session_id"]] = dict(r)
        return out

    async def set_feedback(self, session_id: str, feedback: str = "normal") -> bool:
        cur = await self.db.execute(
            "UPDATE session_drift SET feedback = ? WHERE session_id = ?", (feedback, session_id)
        )
        return (cur.rowcount or 0) > 0

    async def false_flag_rate(self) -> dict:
        """The published number: high sessions marked normal / high sessions."""
        row = await self.db.fetch_one(
            "SELECT COUNT(*) AS high, SUM(CASE WHEN feedback = 'normal' THEN 1 ELSE 0 END) AS normal "
            "FROM session_drift WHERE band = 'high'"
        )
        high = int(row["high"] or 0) if row else 0
        normal = int(row["normal"] or 0) if row else 0
        return {"high": high, "marked_normal": normal, "rate": (normal / high) if high else None}

    async def running_tasks(self, limit: int) -> list:
        ph = ",".join("?" for _ in _RUNNING)
        rows = await self.db.fetch_all(
            f"SELECT * FROM terminal_tasks WHERE session_id IS NOT NULL AND ended_at IS NULL "
            f"AND status IN ({ph}) ORDER BY COALESCE(last_activity_at, created_at) DESC LIMIT ?",
            (*_RUNNING, limit),
        )
        return [dict(r) for r in rows]
