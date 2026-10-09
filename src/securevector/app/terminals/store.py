"""SQLite persistence for Agent Terminals: the board and its audit trail."""

from __future__ import annotations

import asyncio
import hashlib
import re
import sqlite3
from datetime import datetime, timezone
from typing import Any, Optional

from securevector.app.database.connection import DatabaseConnection

RUNNING = ("starting", "working", "blocked", "idle")

# Lifecycle sentinels the Guard plugins emit around a harness session. They
# are not tool calls; the linked-task liveness rules read them as boundaries
# and the Tool calls list hides them.
SESSION_BOUNDARY = ("__session_start__", "__session_end__")

# The four harnesses whose Guard plugins report a runtime_kind that maps
# one to one onto an Agent Tasks executor id. Anything else the audit trail
# carries (an SDK, the proxy) has no terminal to link.
RUNTIME_TO_EXECUTOR = {
    "claude-code": "claude-code",
    "codex": "codex",
    "copilot-cli": "copilot-cli",
    "opencode": "opencode",
}


# terminal_events.kind for a task that moved to a new harness session; the
# event's detail is the session id it left.
SESSION_RELINKED = "session_relinked"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def parse_ts(value: Any) -> Optional[datetime]:
    """Parse either timestamp shape this database stores.

    Audit rows carry SQLite's own 'YYYY-MM-DD HH:MM:SS' (UTC, no offset);
    terminal rows carry an ISO string with a '+00:00' offset. A naive value
    is read as UTC, which is what every writer here means by it.
    """
    if not value:
        return None
    text = str(value).strip().replace(" ", "T")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def age_seconds(value: Any, *, now: Optional[datetime] = None) -> Optional[float]:
    """Seconds since `value`, or None when it cannot be parsed."""
    parsed = parse_ts(value)
    if parsed is None:
        return None
    return ((now or datetime.now(timezone.utc)) - parsed).total_seconds()


# A path is the one field here that legitimately contains spaces, so the
# value runs to a semicolon or to the end of the preview rather than to the
# next space. Bounded because the preview itself is attacker-adjacent text:
# it comes from whatever the harness passed to a tool.
CWD_MAX_CHARS = 1024


# An absolute POSIX path, a home-relative one, or a Windows drive. A working
# folder is always one of these, and requiring it is what stops "cwd=" matched
# inside some other text from being read as a folder.
_CWD_LIKE = re.compile(r"\A(?:/|~/|~\Z|[A-Za-z]:[\\/])")


# Characters that end a real path in this context. A quote or an escape means
# the marker was found inside quoted text, not in a field of its own.
_NOT_IN_A_PATH = ('"', "'", "\\n", "\\t", "\\\"", "\x00")


def _plausible_cwd(candidate: str) -> Optional[str]:
    """One candidate, kept only if it is actually a working folder.

    The scrape reads a marker out of free text, so a candidate is a guess
    until it is checked, and the shape tests alone were not enough: a value
    lifted out of source code starts with "/" as readily as a real path does,
    carries its line breaks as literal backslash-n pairs rather than newlines,
    and sits well under the length cap. Six of thirteen real audit rows still
    produced source after shape checking.

    What does catch them is the content: a value lifted out of quoted source
    carries a quote or an escape sequence, and a working folder never does.
    That refuses all thirteen.

    Deliberately NOT checked here: whether the folder is on disk. It is the
    one test that cannot be imitated, but this runs inside a per request query
    over every offered session, and a well formed path that happens not to
    exist is a far smaller problem than source code on the board: the launch
    itself reports it. Existence belongs where the folder is used, not where
    it is read.
    """
    candidate = candidate.strip()
    if not candidate or len(candidate) > CWD_MAX_CHARS:
        return None
    if any(ch in candidate for ch in "\n\r\x00"):
        return None
    if any(bad in candidate for bad in _NOT_IN_A_PATH):
        return None
    if not _CWD_LIKE.match(candidate):
        return None
    return candidate


def cwd_from_preview(preview: Any) -> Optional[str]:
    """Best-effort working folder out of an audit row's args_preview.

    No hook forwards a cwd field today, so this only finds one when a preview
    happens to spell it out. Accepts a quoted value, or an unquoted one running
    to the next ';' or the end.

    Every candidate is then checked against what a folder can actually look
    like, and every "cwd=" in the text is tried rather than only the first.
    The marker is matched in free text, so it hits inside a tool's own
    arguments too: an edit to a file containing `cwd=str(workspace)` once
    returned eight kilobytes of Python as a session's folder, which then
    showed on the board and could not be spawned into. A guess that fails the
    check is discarded, and callers fall back to a placeholder rather than
    inventing a path.
    """
    if not preview:
        return None
    text = str(preview)
    at = text.find("cwd=")
    while at >= 0:
        rest = text[at + 4 :]
        if rest[:1] in ('"', "'"):
            quote = rest[0]
            end = rest.find(quote, 1)
            candidate = rest[1:end] if end > 0 else rest[1:]
        else:
            # A newline ends an unquoted value as surely as a ';' does.
            candidate = re.split(r"[;\r\n]", rest, 1)[0]
        found = _plausible_cwd(candidate)
        if found is not None:
            return found
        at = text.find("cwd=", at + 4)
    return None


def _row(r: Optional[sqlite3.Row]) -> Optional[dict[str, Any]]:
    return dict(r) if r is not None else None


class TerminalStore:
    def __init__(self, db: DatabaseConnection) -> None:
        self.db = db
        # DatabaseConnection.transaction() now serialises its own callers,
        # so two add_event calls can no longer nest a BEGIN. This lock still
        # keeps the read-prev-then-insert body of the hash chain in one
        # store-level critical section, so events are never lost or
        # misordered whatever the connection layer does.
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
        origin: str = "launch",
        status: str = "starting",
        session_id: Optional[str] = None,
        activity: Optional[str] = None,
    ) -> None:
        now = _now()
        await self.db.execute(
            "INSERT INTO terminal_tasks "
            "(id, executor_id, workspace, title, status, session_id, pid, activity, origin, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                task_id,
                executor_id,
                workspace,
                title,
                status,
                session_id,
                pid,
                activity[:200] if activity else None,
                origin,
                now,
            ),
        )

    async def task_for_session(self, session_id: str) -> Optional[dict[str, Any]]:
        """The live (non-archived) task already carrying this session id.

        One session belongs to one row on the board: linking the same
        harness session twice would show the same governance under two
        names and double every count read off the board.
        """
        return _row(
            await self.db.fetch_one(
                "SELECT * FROM terminal_tasks WHERE session_id = ? AND archived_at IS NULL "
                "ORDER BY created_at DESC, rowid DESC LIMIT 1",
                (session_id,),
            )
        )

    async def list_linked_tasks(self) -> list[dict[str, Any]]:
        rows = await self.db.fetch_all(
            "SELECT * FROM terminal_tasks WHERE origin = 'linked' AND archived_at IS NULL "
            "ORDER BY created_at DESC, rowid DESC"
        )
        return [dict(r) for r in rows]

    async def update_linked_state(
        self,
        task_id: str,
        *,
        status: str,
        activity: Optional[str],
        last_activity_at: Optional[str],
        ended_at: Optional[str],
    ) -> None:
        """Write a linked task's derived liveness.

        Unlike update_status this never stamps "now" on last_activity_at: a
        linked task's activity clock belongs to its audit trail, not to the
        moment the board happened to be polled.
        """
        await self.db.execute(
            "UPDATE terminal_tasks SET status = ?, activity = ?, last_activity_at = ?, "
            "ended_at = ? WHERE id = ?",
            (status, activity[:200] if activity else None, last_activity_at, ended_at, task_id),
        )

    async def session_activity(self, session_ids: list[str]) -> dict[str, dict[str, Any]]:
        """Newest audit timestamps per session, one query for the whole board.

        Returns `last_any` (newest row of any kind), `last_call` (newest row
        that is not a lifecycle sentinel) and `last_end` (newest
        __session_end__). A per-task query would scale with the number of
        linked tasks on a list that is re-read every few seconds.
        """
        out: dict[str, dict[str, Any]] = {}
        if not session_ids:
            return out
        unique = list(dict.fromkeys(session_ids))
        chunk = 500
        boundary = ",".join("?" * len(SESSION_BOUNDARY))
        for start in range(0, len(unique), chunk):
            batch = unique[start : start + chunk]
            placeholders = ",".join("?" for _ in batch)
            rows = await self.db.fetch_all(
                "SELECT session_id, MAX(called_at) AS last_any, "
                f"MAX(CASE WHEN function_name NOT IN ({boundary}) THEN called_at END) AS last_call, "
                "MAX(CASE WHEN function_name = '__session_end__' THEN called_at END) AS last_end "
                f"FROM tool_call_audit WHERE session_id IN ({placeholders}) GROUP BY session_id",
                (*SESSION_BOUNDARY, *batch),
            )
            for r in rows:
                out[r["session_id"]] = {
                    "last_any": r["last_any"],
                    "last_call": r["last_call"],
                    "last_end": r["last_end"],
                }
        return out

    async def unlinked_sessions(
        self, *, window_hours: int = 24, limit: int = 20
    ) -> list[dict[str, Any]]:
        """Harness sessions the Guard reported recently that no task claims.

        The board is the point of the feature, so a session that already has
        a live task row is not offered again; an archived task frees its
        session to be linked afresh. Claimed sessions are excluded in SQL so
        the LIMIT applies to what is actually offered: filtering them out in
        Python after the fact lets a busy board starve the list.

        runtime_kind and the folder come from the newest row of the session,
        not from MAX() over the group, which would pick whichever value
        sorted highest rather than whichever was most recent.
        """
        runtimes = list(RUNTIME_TO_EXECUTOR)
        runtime_placeholders = ",".join("?" * len(runtimes))
        boundary = ",".join("?" * len(SESSION_BOUNDARY))
        rows = await self.db.fetch_all(
            "SELECT a.session_id AS session_id, MAX(a.called_at) AS last_at, "
            f"SUM(CASE WHEN a.function_name IN ({boundary}) THEN 0 ELSE 1 END) AS calls, "
            "(SELECT r.runtime_kind FROM tool_call_audit r WHERE r.session_id = a.session_id "
            " ORDER BY r.called_at DESC, r.rowid DESC LIMIT 1) AS runtime_kind, "
            "(SELECT w.args_preview FROM tool_call_audit w WHERE w.session_id = a.session_id "
            " AND w.args_preview LIKE '%cwd=%' ORDER BY w.called_at DESC, w.rowid DESC LIMIT 1) AS preview "
            "FROM tool_call_audit a "
            f"WHERE a.session_id IS NOT NULL AND a.runtime_kind IN ({runtime_placeholders}) "
            "AND a.called_at >= datetime('now', ?) "
            "AND a.session_id NOT IN ("
            " SELECT session_id FROM terminal_tasks "
            " WHERE session_id IS NOT NULL AND archived_at IS NULL) "
            # A task re-linked to a new harness session (Claude Code /clear)
            # still owns the session it left; it is history, not an offer.
            "AND a.session_id NOT IN ("
            " SELECT e.detail FROM terminal_events e "
            " JOIN terminal_tasks t ON t.id = e.task_id "
            f" WHERE e.kind = '{SESSION_RELINKED}' AND t.archived_at IS NULL "
            " AND e.detail IS NOT NULL) "
            "GROUP BY a.session_id ORDER BY last_at DESC LIMIT ?",
            (
                *SESSION_BOUNDARY,
                *runtimes,
                f"-{max(1, int(window_hours))} hours",
                max(1, int(limit)),
            ),
        )
        out: list[dict[str, Any]] = []
        for r in rows:
            executor_id = RUNTIME_TO_EXECUTOR.get(r["runtime_kind"] or "")
            if executor_id is None:
                # The newest row came from a runtime with no terminal to
                # link (an SDK, the proxy); offering it would be a dead end.
                continue
            out.append(
                {
                    "session_id": r["session_id"],
                    "runtime_kind": r["runtime_kind"],
                    "executor_id": executor_id,
                    "last_at": r["last_at"],
                    "calls": int(r["calls"] or 0),
                    "workspace": cwd_from_preview(r["preview"]),
                }
            )
        return out

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
        # A linked row is exempt. The app owns no process for a session started
        # in someone's own terminal, so there is nothing here to stop, and the
        # advice to stop it first is unfollowable: a linked task's status is
        # derived from the audit trail and only a reported session end moves it
        # out of RUNNING. Without this exemption an adopted session can never
        # leave the board. Archiving stops nothing either way, it takes the row
        # off the board and keeps the audit, and it frees the session id to be
        # adopted again later.
        if task["status"] in RUNNING and task.get("origin") != "linked":
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

    async def tasks_claiming_session(
        self, session_id: str, *, exclude_task_id: Optional[str] = None
    ) -> list[dict[str, Any]]:
        """Non-archived tasks that hold `session_id` now or held it before a
        re-link. Used to refuse a second task taking a session that is
        already someone's, and to tell a launched task's session apart."""
        rows = await self.db.fetch_all(
            "SELECT * FROM terminal_tasks WHERE archived_at IS NULL AND id != ? AND ("
            " session_id = ? OR id IN (SELECT task_id FROM terminal_events "
            " WHERE kind = ? AND detail = ?))",
            (exclude_task_id or "", session_id, SESSION_RELINKED, session_id),
        )
        return [dict(r) for r in rows]

    async def session_history(self, task_id: str) -> list[str]:
        """Harness session ids this task held before its current one, oldest
        first. Each re-link writes one SESSION_RELINKED event whose detail is
        the id it left, on the task's hash-chained trail."""
        rows = await self.db.fetch_all(
            "SELECT detail FROM terminal_events WHERE task_id = ? AND kind = ? "
            "AND detail IS NOT NULL ORDER BY seq ASC",
            (task_id, SESSION_RELINKED),
        )
        return list(dict.fromkeys(str(r["detail"]) for r in rows))

    async def session_histories(self, task_ids: list[str]) -> dict[str, list[str]]:
        """session_history for many tasks in one query (the board is polled)."""
        out: dict[str, list[str]] = {}
        ids = [i for i in dict.fromkeys(task_ids) if i]
        for start in range(0, len(ids), 500):
            batch = ids[start : start + 500]
            placeholders = ",".join("?" for _ in batch)
            rows = await self.db.fetch_all(
                "SELECT task_id, detail FROM terminal_events "
                f"WHERE kind = ? AND detail IS NOT NULL AND task_id IN ({placeholders}) "
                "ORDER BY seq ASC",
                (SESSION_RELINKED, *batch),
            )
            for r in rows:
                lst = out.setdefault(r["task_id"], [])
                if str(r["detail"]) not in lst:
                    lst.append(str(r["detail"]))
        return out

    async def update_workspace(self, task_id: str, workspace: str) -> None:
        await self.db.execute(
            "UPDATE terminal_tasks SET workspace = ? WHERE id = ?", (workspace, task_id)
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

    async def set_exit(
        self, task_id: str, exit_code: Optional[int], *, stopped: bool = False
    ) -> None:
        # `stopped` is the manager's word that the app itself signalled this
        # process (the user clicked Stop); a signal exit then is not a failure.
        status = "done" if exit_code == 0 else ("stopped" if stopped else "failed")
        await self.db.execute(
            "UPDATE terminal_tasks SET status = ?, exit_code = ?, ended_at = ? WHERE id = ?",
            (status, exit_code, _now(), task_id),
        )

    async def mark_running_interrupted(self) -> list[dict[str, Any]]:
        placeholders = ",".join("?" * len(RUNNING))
        rows = await self.db.fetch_all(
            f"SELECT * FROM terminal_tasks WHERE status IN ({placeholders}) "
            # A linked session runs in the user's own terminal: this app
            # restarting did not interrupt it, and its liveness is rederived
            # from the audit trail on the next board read.
            "AND origin != 'linked' ORDER BY created_at DESC, rowid DESC",
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

    async def interrupted_without_event(self) -> list[dict[str, Any]]:
        """Interrupted tasks whose startup bookkeeping never finished.

        Startup marks every running task interrupted, then adds its
        `interrupted` event and reaps it one task at a time. A failure part
        way leaves later tasks marked but without the event (and unreaped);
        selecting by status plus the missing event lets a retry finish them.
        """
        rows = await self.db.fetch_all(
            "SELECT * FROM terminal_tasks t WHERE t.status = 'interrupted' "
            "AND t.origin != 'linked' AND NOT EXISTS ("
            "SELECT 1 FROM terminal_events e "
            "WHERE e.task_id = t.id AND e.kind = 'interrupted') "
            "ORDER BY t.created_at DESC, t.rowid DESC"
        )
        return [dict(r) for r in rows]

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

    async def verdict_counts(self, session_ids: list[str]) -> dict[str, dict[str, int]]:
        """Tool calls and blocked calls per harness session, in one grouped
        query per chunk, for the board's one-line facts."""
        out: dict[str, dict[str, int]] = {}
        ids = [i for i in session_ids if i]
        chunk = 500
        for start in range(0, len(ids), chunk):
            batch = ids[start : start + chunk]
            placeholders = ",".join("?" for _ in batch)
            rows = await self.db.fetch_all(
                "SELECT session_id, COUNT(*) AS calls, "
                "SUM(CASE WHEN action = 'block' THEN 1 ELSE 0 END) AS blocked "
                f"FROM tool_call_audit WHERE session_id IN ({placeholders}) GROUP BY session_id",
                tuple(batch),
            )
            for r in rows:
                out[r["session_id"]] = {"calls": int(r["calls"] or 0), "blocked": int(r["blocked"] or 0)}
        return out

    async def tasks_with_event(self, kind: str, task_ids: list[str]) -> set[str]:
        """Which of these tasks have at least one event of this kind.

        One query for the whole board instead of one per task: the terminals
        list is re-read every few seconds, so a per-task lookup would scale
        with the number of tasks on screen. Chunked because SQLite caps the
        number of bound parameters in a single statement.
        """
        found: set[str] = set()
        if not task_ids:
            return found
        chunk = 500
        for start in range(0, len(task_ids), chunk):
            batch = task_ids[start : start + chunk]
            placeholders = ",".join("?" for _ in batch)
            rows = await self.db.fetch_all(
                "SELECT DISTINCT task_id FROM terminal_events "
                f"WHERE kind = ? AND task_id IN ({placeholders})",
                (kind, *batch),
            )
            found.update(r["task_id"] for r in rows)
        return found

    async def list_verdicts(self, session_id, limit: int = 200) -> list[dict[str, Any]]:
        """Newest first. `session_id` is one id or a list (a task's whole
        session history); duplicates are dropped."""
        ids = [session_id] if isinstance(session_id, str) else list(session_id or [])
        ids = [i for i in dict.fromkeys(ids) if i]
        if not ids:
            return []
        placeholders = ",".join("?" for _ in ids)
        rows = await self.db.fetch_all(
            "SELECT tool_id, function_name, action, risk, reason, args_preview, called_at "
            f"FROM tool_call_audit WHERE session_id IN ({placeholders}) "
            "ORDER BY called_at DESC, rowid DESC LIMIT ?",
            (*ids, limit),
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
