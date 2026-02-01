"""
Threat Intel API endpoints.

GET /api/v1/threat-intel - List threat intel records
GET /api/v1/threat-intel/{id} - Get single record
"""

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.threat_intel import ThreatIntelRepository

logger = logging.getLogger(__name__)

router = APIRouter()


class ThreatIntelResponse(BaseModel):
    """Single threat intel record response."""

    id: str
    request_id: Optional[str]
    text_content: Optional[str]
    text_preview: str
    text_length: int
    is_threat: bool
    threat_type: Optional[str]
    risk_score: int
    confidence: float
    matched_rules: list[dict]
    source_identifier: Optional[str]
    session_id: Optional[str]
    processing_time_ms: int
    created_at: str
    metadata: Optional[dict]


class ThreatIntelListResponse(BaseModel):
    """Paginated threat intel list response."""

    items: list[ThreatIntelResponse]
    total: int
    page: int
    page_size: int
    total_pages: int


@router.get("/threat-intel", response_model=ThreatIntelListResponse)
async def list_threat_intel(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(50, ge=1, le=100, description="Items per page"),
    is_threat: Optional[bool] = Query(None, description="Filter by threat status"),
    threat_type: Optional[str] = Query(None, description="Filter by threat type"),
    source: Optional[str] = Query(None, description="Filter by source identifier"),
    start_date: Optional[datetime] = Query(None, description="Filter after date"),
    end_date: Optional[datetime] = Query(None, description="Filter before date"),
    sort: str = Query("created_at", description="Sort field"),
    order: str = Query("desc", description="Sort order (asc/desc)"),
) -> ThreatIntelListResponse:
    """
    Get paginated list of threat intel records.

    Supports filtering by threat status, type, source, and date range.
    """
    try:
        db = get_database()
        repo = ThreatIntelRepository(db)

        result = await repo.list(
            page=page,
            page_size=page_size,
            is_threat=is_threat,
            threat_type=threat_type,
            source=source,
            start_date=start_date,
            end_date=end_date,
            sort=sort,
            order=order,
        )

        return ThreatIntelListResponse(
            items=[
                ThreatIntelResponse(
                    id=item.id,
                    request_id=item.request_id,
                    text_content=item.text_content,
                    text_preview=item.text_preview,
                    text_length=item.text_length,
                    is_threat=item.is_threat,
                    threat_type=item.threat_type,
                    risk_score=item.risk_score,
                    confidence=item.confidence,
                    matched_rules=item.matched_rules,
                    source_identifier=item.source_identifier,
                    session_id=item.session_id,
                    processing_time_ms=item.processing_time_ms,
                    created_at=item.created_at.isoformat() if item.created_at else "",
                    metadata=item.metadata,
                )
                for item in result.items
            ],
            total=result.total,
            page=result.page,
            page_size=result.page_size,
            total_pages=result.total_pages,
        )

    except Exception as e:
        logger.error(f"Failed to list threat intel: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/threat-intel/{record_id}", response_model=ThreatIntelResponse)
async def get_threat_intel(record_id: str) -> ThreatIntelResponse:
    """
    Get a single threat intel record by ID.
    """
    try:
        db = get_database()
        repo = ThreatIntelRepository(db)

        record = await repo.get_by_id(record_id)

        if record is None:
            raise HTTPException(status_code=404, detail="Record not found")

        return ThreatIntelResponse(
            id=record.id,
            request_id=record.request_id,
            text_content=record.text_content,
            text_preview=record.text_preview,
            text_length=record.text_length,
            is_threat=record.is_threat,
            threat_type=record.threat_type,
            risk_score=record.risk_score,
            confidence=record.confidence,
            matched_rules=record.matched_rules,
            source_identifier=record.source_identifier,
            session_id=record.session_id,
            processing_time_ms=record.processing_time_ms,
            created_at=record.created_at.isoformat() if record.created_at else "",
            metadata=record.metadata,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get threat intel: {e}")
        raise HTTPException(status_code=500, detail=str(e))
