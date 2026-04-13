"""Sandbox session database repository."""

import logging
from typing import Optional

from securevector.app.database.connection import DatabaseConnection
from securevector.app.sandbox.models import SandboxSession

logger = logging.getLogger(__name__)


class SandboxRepository:
    def __init__(self, db: DatabaseConnection):
        self.db = db

    async def create(self, session: SandboxSession) -> None:
        await self.db.execute(
            """INSERT INTO sandbox_sessions
               (id, command, profile, status, pid, workspace, started_at, agent_type)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (session.id, session.command, session.profile, session.status,
             session.pid, session.workspace, session.started_at, session.agent_type),
        )
        conn = await self.db.connect()
        await conn.commit()

    async def get_by_id(self, session_id: str) -> Optional[SandboxSession]:
        row = await self.db.fetch_one(
            "SELECT * FROM sandbox_sessions WHERE id = ?", (session_id,)
        )
        if not row:
            return None
        return self._row_to_session(row)

    async def list_all(self, status: Optional[str] = None, limit: int = 100) -> list[SandboxSession]:
        if status:
            rows = await self.db.fetch_all(
                "SELECT * FROM sandbox_sessions WHERE status = ? ORDER BY started_at DESC LIMIT ?",
                (status, limit),
            )
        else:
            rows = await self.db.fetch_all(
                "SELECT * FROM sandbox_sessions ORDER BY started_at DESC LIMIT ?",
                (limit,),
            )
        return [self._row_to_session(r) for r in rows]

    async def update_status(
        self, session_id: str, status: str,
        exit_code: Optional[int] = None,
        stdout: Optional[str] = None,
        stderr: Optional[str] = None,
        duration_ms: Optional[int] = None,
        finished_at: Optional[str] = None,
        error: Optional[str] = None,
    ) -> None:
        await self.db.execute(
            """UPDATE sandbox_sessions
               SET status = ?, exit_code = ?, stdout = ?, stderr = ?,
                   duration_ms = ?, finished_at = ?, error = ?
               WHERE id = ?""",
            (status, exit_code, stdout, stderr, duration_ms, finished_at, error, session_id),
        )
        conn = await self.db.connect()
        await conn.commit()

    async def delete(self, session_id: str) -> None:
        await self.db.execute("DELETE FROM sandbox_sessions WHERE id = ?", (session_id,))
        conn = await self.db.connect()
        await conn.commit()

    def _row_to_session(self, row) -> SandboxSession:
        return SandboxSession(
            id=row[0],
            command=row[1],
            profile=row[2],
            status=row[3],
            pid=row[4],
            workspace=row[5],
            exit_code=row[6],
            stdout=row[7],
            stderr=row[8],
            duration_ms=row[9],
            started_at=row[10],
            finished_at=row[11],
            agent_type=row[12],
            error=row[13],
        )
