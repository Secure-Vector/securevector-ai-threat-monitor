"""
Skill scan records repository.

Provides CRUD operations for skill_scan_records table.
Records are immutable once written — no update operations.
"""

import logging
from dataclasses import dataclass
from typing import Optional

from securevector.app.database.connection import DatabaseConnection

logger = logging.getLogger(__name__)


@dataclass
class ScanRecord:
    """Persisted record of a completed skill scan."""

    id: str
    scanned_path: str
    skill_name: str
    scan_timestamp: str
    invocation_source: str  # 'cli' or 'ui'
    risk_level: str         # 'HIGH', 'MEDIUM', or 'LOW'
    findings_count: int
    findings_json: str      # JSON-serialized list of Finding dicts
    manifest_present: int   # 0 or 1


class SkillScansRepository:
    """Repository for skill scan records."""

    def __init__(self, db: DatabaseConnection):
        self.db = db

    async def insert_scan(self, record: ScanRecord) -> None:
        """Insert a new scan record. Raises on constraint violation."""
        await self.db.execute(
            """
            INSERT INTO skill_scan_records
                (id, scanned_path, skill_name, scan_timestamp,
                 invocation_source, risk_level, findings_count,
                 findings_json, manifest_present)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record.id,
                record.scanned_path,
                record.skill_name,
                record.scan_timestamp,
                record.invocation_source,
                record.risk_level,
                record.findings_count,
                record.findings_json,
                record.manifest_present,
            ),
        )
        logger.debug(f"Inserted scan record {record.id} ({record.risk_level})")

    async def get_scan_by_id(self, scan_id: str) -> Optional[ScanRecord]:
        """Return full scan record by ID, or None if not found."""
        row = await self.db.fetch_one(
            "SELECT * FROM skill_scan_records WHERE id = ?",
            (scan_id,),
        )
        if not row:
            return None
        return self._row_to_record(row)

    async def list_scans(
        self, limit: int = 50, offset: int = 0
    ) -> tuple[list[ScanRecord], int]:
        """Return a page of scan records (newest-first) and total count."""
        rows = await self.db.fetch_all(
            """
            SELECT * FROM skill_scan_records
            ORDER BY scan_timestamp DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        )
        total_row = await self.db.fetch_one(
            "SELECT COUNT(*) as total FROM skill_scan_records"
        )
        total = total_row["total"] if total_row else 0
        return [self._row_to_record(r) for r in rows], total

    async def delete_scan(self, scan_id: str) -> bool:
        """Hard-delete a scan record. Returns True if deleted, False if not found."""
        existing = await self.get_scan_by_id(scan_id)
        if not existing:
            return False
        await self.db.execute(
            "DELETE FROM skill_scan_records WHERE id = ?",
            (scan_id,),
        )
        logger.debug(f"Deleted scan record {scan_id}")
        return True

    @staticmethod
    def _row_to_record(row) -> ScanRecord:
        return ScanRecord(
            id=row["id"],
            scanned_path=row["scanned_path"],
            skill_name=row["skill_name"],
            scan_timestamp=row["scan_timestamp"],
            invocation_source=row["invocation_source"],
            risk_level=row["risk_level"],
            findings_count=row["findings_count"],
            findings_json=row["findings_json"],
            manifest_present=row["manifest_present"],
        )
