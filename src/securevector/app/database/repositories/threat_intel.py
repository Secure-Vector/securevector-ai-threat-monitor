"""
Threat intel repository for analysis records.

Provides CRUD operations for threat_intel_records:
- Store analysis results
- Query with pagination and filtering
- Get statistics and trends
"""

import hashlib
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, List, Optional

from securevector.app.database.connection import DatabaseConnection

logger = logging.getLogger(__name__)


@dataclass
class ThreatIntelRecord:
    """Threat intel record data class."""

    id: str
    is_threat: bool
    threat_type: Optional[str]
    risk_score: int
    confidence: float
    matched_rules: list[dict]
    processing_time_ms: int
    created_at: datetime
    request_id: Optional[str] = None
    text_content: Optional[str] = None
    text_hash: str = ""
    text_length: int = 0
    source_identifier: Optional[str] = None
    session_id: Optional[str] = None
    metadata: Optional[dict] = None
    user_agent: Optional[str] = None
    # LLM Review fields
    llm_reviewed: bool = False
    llm_agrees: bool = True
    llm_confidence: float = 0.0
    llm_explanation: Optional[str] = None
    llm_recommendation: Optional[str] = None
    llm_risk_adjustment: int = 0
    llm_model_used: Optional[str] = None
    llm_tokens_used: int = 0
    action_taken: str = "logged"  # "logged" or "blocked"

    @property
    def text_preview(self) -> str:
        """Get first 100 characters of text content."""
        if self.text_content:
            return self.text_content[:100]
        return ""

    def to_dict(self) -> dict:
        """Convert to dictionary for API response."""
        result = {
            "id": self.id,
            "request_id": self.request_id,
            "text_content": self.text_content,
            "text_preview": self.text_preview,
            "text_length": self.text_length,
            "is_threat": self.is_threat,
            "threat_type": self.threat_type,
            "risk_score": self.risk_score,
            "confidence": self.confidence,
            "matched_rules": self.matched_rules,
            "source_identifier": self.source_identifier,
            "session_id": self.session_id,
            "processing_time_ms": self.processing_time_ms,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "metadata": self.metadata,
            "user_agent": self.user_agent,
            # LLM Review fields (flat for frontend compatibility)
            "llm_reviewed": self.llm_reviewed,
            "llm_agrees": self.llm_agrees,
            "llm_confidence": self.llm_confidence,
            "llm_reasoning": self.llm_explanation,  # Alias for frontend
            "llm_explanation": self.llm_explanation,
            "llm_recommendation": self.llm_recommendation,
            "llm_risk_adjustment": self.llm_risk_adjustment,
            "llm_model_used": self.llm_model_used,
            "llm_tokens_used": self.llm_tokens_used,
            "action_taken": self.action_taken,
        }
        return result


@dataclass
class ThreatIntelPage:
    """Paginated threat intel response."""

    items: list[ThreatIntelRecord]
    total: int
    page: int
    page_size: int

    @property
    def total_pages(self) -> int:
        """Calculate total pages."""
        return (self.total + self.page_size - 1) // self.page_size if self.page_size > 0 else 0

    def to_dict(self) -> dict:
        """Convert to dictionary for API response."""
        return {
            "items": [item.to_dict() for item in self.items],
            "total": self.total,
            "page": self.page,
            "page_size": self.page_size,
            "total_pages": self.total_pages,
        }


class ThreatIntelRepository:
    """
    Repository for threat intel records.

    Provides CRUD operations with pagination and filtering.
    """

    def __init__(self, db: DatabaseConnection):
        """
        Initialize threat intel repository.

        Args:
            db: Database connection instance.
        """
        self.db = db

    async def create(
        self,
        text: str,
        is_threat: bool,
        threat_type: Optional[str],
        risk_score: int,
        confidence: float,
        matched_rules: list[dict],
        processing_time_ms: int,
        store_text: bool = True,
        request_id: Optional[str] = None,
        source: Optional[str] = None,
        session_id: Optional[str] = None,
        metadata: Optional[dict] = None,
        user_agent: Optional[str] = None,
        # LLM Review fields
        llm_reviewed: bool = False,
        llm_agrees: bool = True,
        llm_confidence: float = 0.0,
        llm_explanation: Optional[str] = None,
        llm_recommendation: Optional[str] = None,
        llm_risk_adjustment: int = 0,
        llm_model_used: Optional[str] = None,
        llm_tokens_used: int = 0,
        action_taken: str = "logged",
    ) -> ThreatIntelRecord:
        """
        Create a new threat intel record.

        Args:
            text: Analyzed text content.
            is_threat: Whether a threat was detected.
            threat_type: Type of threat (if detected).
            risk_score: Risk score (0-100).
            confidence: Confidence level (0-1).
            matched_rules: List of matched rule details.
            processing_time_ms: Analysis duration in milliseconds.
            store_text: Whether to store the text content.
            request_id: Client-provided request ID.
            source: Source identifier (agent name).
            session_id: Session grouping ID.
            metadata: Additional metadata.

        Returns:
            Created ThreatIntelRecord.
        """
        record_id = str(uuid.uuid4())
        text_hash = hashlib.sha256(text.encode()).hexdigest()
        text_length = len(text)
        created_at = datetime.utcnow()

        await self.db.execute(
            """
            INSERT INTO threat_intel_records (
                id, request_id, text_content, text_hash, text_length,
                is_threat, threat_type, risk_score, confidence,
                matched_rules, source_identifier, session_id,
                processing_time_ms, created_at, metadata, user_agent,
                llm_reviewed, llm_agrees, llm_confidence, llm_explanation,
                llm_recommendation, llm_risk_adjustment, llm_model_used, llm_tokens_used,
                action_taken
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record_id,
                request_id,
                text if store_text else None,
                text_hash,
                text_length,
                int(is_threat),
                threat_type,
                risk_score,
                confidence,
                json.dumps(matched_rules),
                source,
                session_id,
                processing_time_ms,
                created_at.isoformat(),
                json.dumps(metadata) if metadata else None,
                user_agent,
                int(llm_reviewed),
                int(llm_agrees),
                llm_confidence,
                llm_explanation,
                llm_recommendation,
                llm_risk_adjustment,
                llm_model_used,
                llm_tokens_used,
                action_taken,
            ),
        )

        logger.debug(f"Created threat intel record: {record_id}")

        return ThreatIntelRecord(
            id=record_id,
            request_id=request_id,
            text_content=text if store_text else None,
            text_hash=text_hash,
            text_length=text_length,
            is_threat=is_threat,
            threat_type=threat_type,
            risk_score=risk_score,
            confidence=confidence,
            matched_rules=matched_rules,
            source_identifier=source,
            session_id=session_id,
            processing_time_ms=processing_time_ms,
            created_at=created_at,
            metadata=metadata,
            user_agent=user_agent,
            llm_reviewed=llm_reviewed,
            llm_agrees=llm_agrees,
            llm_confidence=llm_confidence,
            llm_explanation=llm_explanation,
            llm_recommendation=llm_recommendation,
            llm_risk_adjustment=llm_risk_adjustment,
            llm_model_used=llm_model_used,
            llm_tokens_used=llm_tokens_used,
            action_taken=action_taken,
        )

    async def get_by_id(self, record_id: str) -> Optional[ThreatIntelRecord]:
        """
        Get a threat intel record by ID.

        Args:
            record_id: Record UUID.

        Returns:
            ThreatIntelRecord or None if not found.
        """
        row = await self.db.fetch_one(
            "SELECT * FROM threat_intel_records WHERE id = ?",
            (record_id,),
        )

        if row is None:
            return None

        return self._row_to_record(row)

    async def list(
        self,
        page: int = 1,
        page_size: int = 50,
        is_threat: Optional[bool] = None,
        threat_type: Optional[str] = None,
        source: Optional[str] = None,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        sort: str = "created_at",
        order: str = "desc",
    ) -> ThreatIntelPage:
        """
        List threat intel records with pagination and filtering.

        Args:
            page: Page number (1-indexed).
            page_size: Items per page (max 100).
            is_threat: Filter by threat status.
            threat_type: Filter by threat type.
            source: Filter by source identifier.
            start_date: Filter records after this date.
            end_date: Filter records before this date.
            sort: Sort field (created_at or risk_score).
            order: Sort order (asc or desc).

        Returns:
            ThreatIntelPage with items and pagination info.
        """
        # Validate parameters
        page = max(1, page)
        page_size = min(max(1, page_size), 100)
        sort = sort if sort in ("created_at", "risk_score") else "created_at"
        order = order.upper() if order.lower() in ("asc", "desc") else "DESC"

        # Build WHERE clause
        conditions = []
        params = []

        if is_threat is not None:
            conditions.append("is_threat = ?")
            params.append(int(is_threat))

        if threat_type is not None:
            conditions.append("threat_type = ?")
            params.append(threat_type)

        if source is not None:
            conditions.append("source_identifier = ?")
            params.append(source)

        if start_date is not None:
            conditions.append("created_at >= ?")
            params.append(start_date.isoformat())

        if end_date is not None:
            conditions.append("created_at <= ?")
            params.append(end_date.isoformat())

        where_clause = " AND ".join(conditions) if conditions else "1=1"

        # Get total count
        count_row = await self.db.fetch_one(
            f"SELECT COUNT(*) as count FROM threat_intel_records WHERE {where_clause}",
            tuple(params),
        )
        total = count_row["count"] if count_row else 0

        # Get items
        offset = (page - 1) * page_size
        rows = await self.db.fetch_all(
            f"""
            SELECT * FROM threat_intel_records
            WHERE {where_clause}
            ORDER BY {sort} {order}
            LIMIT ? OFFSET ?
            """,
            tuple(params + [page_size, offset]),
        )

        items = [self._row_to_record(row) for row in rows]

        return ThreatIntelPage(
            items=items,
            total=total,
            page=page,
            page_size=page_size,
        )

    async def delete_older_than(self, days: int) -> int:
        """
        Delete records older than specified days.

        Args:
            days: Number of days to retain.

        Returns:
            Number of deleted records.
        """
        cutoff = datetime.utcnow() - timedelta(days=days)

        cursor = await self.db.execute(
            "DELETE FROM threat_intel_records WHERE created_at < ?",
            (cutoff.isoformat(),),
        )

        deleted = cursor.rowcount
        if deleted > 0:
            logger.info(f"Purged {deleted} threat intel records older than {days} days")

        return deleted

    async def get_count(self) -> int:
        """Get total record count."""
        row = await self.db.fetch_one(
            "SELECT COUNT(*) as count FROM threat_intel_records"
        )
        return row["count"] if row else 0

    async def delete_by_id(self, record_id: str) -> bool:
        """
        Delete a single threat intel record by ID.

        Args:
            record_id: Record UUID to delete.

        Returns:
            True if record was deleted, False if not found.
        """
        cursor = await self.db.execute(
            "DELETE FROM threat_intel_records WHERE id = ?",
            (record_id,),
        )
        deleted = cursor.rowcount > 0
        if deleted:
            logger.info(f"Deleted threat intel record: {record_id}")
        return deleted

    async def delete_all(self) -> int:
        """
        Delete all threat intel records.

        Returns:
            Number of deleted records.
        """
        # Get count first
        count = await self.get_count()

        if count > 0:
            await self.db.execute("DELETE FROM threat_intel_records")
            logger.info(f"Deleted all {count} threat intel records")

        return count

    async def delete_by_ids(self, record_ids: List[str]) -> int:
        """
        Delete multiple threat intel records by IDs.

        Args:
            record_ids: List of record UUIDs to delete.

        Returns:
            Number of deleted records.
        """
        if not record_ids:
            return 0

        placeholders = ",".join("?" * len(record_ids))
        cursor = await self.db.execute(
            f"DELETE FROM threat_intel_records WHERE id IN ({placeholders})",
            tuple(record_ids),
        )
        deleted = cursor.rowcount
        if deleted > 0:
            logger.info(f"Deleted {deleted} threat intel records")
        return deleted

    def _row_to_record(self, row) -> ThreatIntelRecord:
        """Convert database row to ThreatIntelRecord."""
        matched_rules = json.loads(row["matched_rules"]) if row["matched_rules"] else []
        metadata = json.loads(row["metadata"]) if row["metadata"] else None
        created_at = datetime.fromisoformat(row["created_at"]) if isinstance(row["created_at"], str) else row["created_at"]

        # Convert row to dict for safe access to optional LLM fields
        row_keys = row.keys() if hasattr(row, 'keys') else []

        def safe_get(key, default=None):
            """Safely get value from row, handling sqlite3.Row objects."""
            if key in row_keys:
                val = row[key]
                return val if val is not None else default
            return default

        return ThreatIntelRecord(
            id=row["id"],
            request_id=row["request_id"],
            text_content=row["text_content"],
            text_hash=row["text_hash"],
            text_length=row["text_length"],
            is_threat=bool(row["is_threat"]),
            threat_type=row["threat_type"],
            risk_score=row["risk_score"],
            confidence=row["confidence"],
            matched_rules=matched_rules,
            source_identifier=row["source_identifier"],
            session_id=row["session_id"],
            processing_time_ms=row["processing_time_ms"],
            created_at=created_at,
            metadata=metadata,
            user_agent=safe_get("user_agent"),
            # LLM Review fields (with defaults for older records)
            llm_reviewed=bool(safe_get("llm_reviewed", 0)),
            llm_agrees=bool(safe_get("llm_agrees", 1)),
            llm_confidence=float(safe_get("llm_confidence", 0) or 0),
            llm_explanation=safe_get("llm_explanation"),
            llm_recommendation=safe_get("llm_recommendation"),
            llm_risk_adjustment=int(safe_get("llm_risk_adjustment", 0) or 0),
            llm_model_used=safe_get("llm_model_used"),
            llm_tokens_used=int(safe_get("llm_tokens_used", 0) or 0),
            action_taken=safe_get("action_taken", "logged"),
        )
