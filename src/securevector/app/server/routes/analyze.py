"""
Analysis API endpoint for threat detection.

POST /api/v1/analyze - Analyze text for threats
"""

import logging
import time
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.threat_intel import ThreatIntelRepository
from securevector.app.database.repositories.settings import SettingsRepository

logger = logging.getLogger(__name__)

router = APIRouter()


class AnalysisRequest(BaseModel):
    """Request body for threat analysis."""

    text: str = Field(..., max_length=102400, description="Text to analyze (max 100KB)")
    source: Optional[str] = Field(None, max_length=255, description="Source identifier")
    session_id: Optional[str] = Field(None, max_length=64, description="Session ID")
    request_id: Optional[str] = Field(None, max_length=64, description="Client request ID")
    metadata: Optional[dict] = Field(None, description="Additional metadata")


class MatchedRule(BaseModel):
    """Matched rule details."""

    rule_id: str
    rule_name: str
    category: str
    severity: str
    source: str  # 'community' or 'custom'
    matched_patterns: list[str] = []


class AnalysisResult(BaseModel):
    """Response body for threat analysis."""

    is_threat: bool
    threat_type: Optional[str]
    risk_score: int = Field(..., ge=0, le=100)
    confidence: float = Field(..., ge=0, le=1)
    matched_rules: list[MatchedRule]
    analysis_id: str
    processing_time_ms: int
    request_id: Optional[str] = None
    analysis_source: str = "local"  # "local", "cloud", or "local_fallback"


@router.post("/analyze", response_model=AnalysisResult)
async def analyze_text(request: AnalysisRequest) -> AnalysisResult:
    """
    Analyze text content for threats.

    When cloud mode is enabled, proxies to SecureVector cloud API.
    Otherwise, runs the text through local community and custom rules.
    Stores the result in threat intel and returns the analysis.
    """
    start_time = time.perf_counter()
    analysis_source = "local"

    try:
        # Check if cloud mode is enabled
        db = get_database()
        settings_repo = SettingsRepository(db)
        settings = await settings_repo.get()

        if settings.cloud_mode_enabled:
            # Try cloud analysis
            try:
                from securevector.app.services.cloud_proxy import (
                    get_cloud_proxy,
                    CloudProxyError,
                )

                proxy = get_cloud_proxy()
                cloud_result = await proxy.analyze(
                    text=request.text,
                    metadata=request.metadata,
                )

                # Cloud returned result - use it directly
                processing_time_ms = int(
                    (time.perf_counter() - start_time) * 1000
                )

                # Store in threat intel
                threat_intel_repo = ThreatIntelRepository(db)

                record = await threat_intel_repo.create(
                    text=request.text,
                    is_threat=cloud_result.get("is_threat", False),
                    threat_type=cloud_result.get("threat_type"),
                    risk_score=cloud_result.get("risk_score", 0),
                    confidence=cloud_result.get("confidence", 0.0),
                    matched_rules=cloud_result.get("matched_rules", []),
                    processing_time_ms=processing_time_ms,
                    store_text=settings.store_text_content,
                    request_id=request.request_id,
                    source=request.source,
                    session_id=request.session_id,
                    metadata=request.metadata,
                )

                return AnalysisResult(
                    is_threat=cloud_result.get("is_threat", False),
                    threat_type=cloud_result.get("threat_type"),
                    risk_score=cloud_result.get("risk_score", 0),
                    confidence=cloud_result.get("confidence", 0.0),
                    matched_rules=[],  # Cloud doesn't return detailed rules
                    analysis_id=record.id,
                    processing_time_ms=processing_time_ms,
                    request_id=request.request_id,
                    analysis_source="cloud",
                )

            except Exception as e:
                # Cloud failed, fallback to local
                logger.warning(f"Cloud analysis failed, falling back to local: {e}")
                analysis_source = "local_fallback"

        # Use local analysis service (combines SDK + custom rules)
        from securevector.app.services.analysis_service import get_analysis_service

        service = get_analysis_service()
        result = await service.analyze(request.text)

        # Convert matched rules to response format
        matched_rules = []
        for rule in result.matched_rules:
            matched_rules.append(
                MatchedRule(
                    rule_id=rule.get("id", "unknown"),
                    rule_name=rule.get("name", "Unknown Rule"),
                    category=rule.get("category", "unknown"),
                    severity=rule.get("severity", "medium"),
                    source=rule.get("source", "community"),
                    matched_patterns=rule.get("matched_patterns", []),
                )
            )

        processing_time_ms = result.processing_time_ms

        # Store in threat intel
        db = get_database()
        threat_intel_repo = ThreatIntelRepository(db)
        settings_repo = SettingsRepository(db)
        settings = await settings_repo.get()

        record = await threat_intel_repo.create(
            text=request.text,
            is_threat=result.is_threat,
            threat_type=result.threat_type,
            risk_score=result.risk_score,
            confidence=result.confidence,
            matched_rules=[r.model_dump() for r in matched_rules],
            processing_time_ms=processing_time_ms,
            store_text=settings.store_text_content,
            request_id=request.request_id,
            source=request.source,
            session_id=request.session_id,
            metadata=request.metadata,
        )

        logger.debug(
            f"Analysis complete: is_threat={result.is_threat}, "
            f"risk_score={result.risk_score}, "
            f"processing_time={processing_time_ms}ms"
        )

        return AnalysisResult(
            is_threat=result.is_threat,
            threat_type=result.threat_type,
            risk_score=result.risk_score,
            confidence=result.confidence,
            matched_rules=matched_rules,
            analysis_id=record.id,
            processing_time_ms=processing_time_ms,
            request_id=request.request_id,
            analysis_source=analysis_source,
        )

    except Exception as e:
        logger.error(f"Analysis failed: {e}")
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")
