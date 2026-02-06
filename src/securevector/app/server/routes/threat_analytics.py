"""
Threat Analytics API endpoint - mirrors cloud API path.

POST /api/threat-analytics/ - Analyze text for threats (cloud-compatible path)

This endpoint mirrors the cloud API path for seamless switching between
local and cloud mode. When cloud mode is enabled, proxies to cloud API
using Bearer token authentication.
"""

import logging
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.threat_intel import ThreatIntelRepository
from securevector.app.database.repositories.settings import SettingsRepository

logger = logging.getLogger(__name__)

router = APIRouter()


class ThreatAnalyticsRequest(BaseModel):
    """Request body for threat analytics."""

    text: str = Field(..., max_length=102400, description="Text to analyze (max 100KB)")
    metadata: Optional[Dict[str, Any]] = Field(None, description="Additional metadata")


class ThreatAnalyticsResponse(BaseModel):
    """Response body for threat analytics."""

    is_threat: bool
    threat_type: Optional[str] = None
    risk_score: int = Field(..., ge=0, le=100)
    confidence: float = Field(..., ge=0, le=1)
    matched_rules: List[str] = []
    analysis_source: str = "local"  # "local", "cloud", or "local_fallback"
    processing_time_ms: int = 0
    request_id: Optional[str] = None


@router.post("/threat-analytics/", response_model=ThreatAnalyticsResponse)
async def threat_analytics(request: ThreatAnalyticsRequest) -> ThreatAnalyticsResponse:
    """
    Analyze text for threats (cloud-compatible endpoint).

    When cloud mode is enabled, proxies to SecureVector cloud API using
    Bearer token. Otherwise, uses local pattern matching.

    This endpoint mirrors the cloud API path at:
    https://api.securevector.io/api/threat-analytics/
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
                cloud_result = await proxy.threat_analytics(
                    text=request.text,
                    metadata=request.metadata,
                )

                processing_time_ms = int(
                    (time.perf_counter() - start_time) * 1000
                )

                logger.debug(
                    f"Cloud analysis complete: is_threat={cloud_result.get('is_threat')}, "
                    f"processing_time={processing_time_ms}ms"
                )

                return ThreatAnalyticsResponse(
                    is_threat=cloud_result.get("is_threat", False),
                    threat_type=cloud_result.get("threat_type"),
                    risk_score=cloud_result.get("risk_score", 0),
                    confidence=cloud_result.get("confidence", 0.0),
                    matched_rules=cloud_result.get("matched_rules", []),
                    analysis_source="cloud",
                    processing_time_ms=processing_time_ms,
                    request_id=cloud_result.get("request_id"),
                )

            except Exception as e:
                # Cloud failed, fallback to local
                logger.warning(f"Cloud analysis failed, falling back to local: {e}")
                analysis_source = "local_fallback"

        # Use local analysis service
        from securevector.app.services.analysis_service import get_analysis_service

        service = get_analysis_service()
        result = await service.analyze(request.text)

        processing_time_ms = int((time.perf_counter() - start_time) * 1000)

        # Extract rule IDs from matched rules
        matched_rule_ids = [
            rule.get("id", "unknown") for rule in result.matched_rules
        ]

        logger.debug(
            f"Local analysis complete: is_threat={result.is_threat}, "
            f"risk_score={result.risk_score}, "
            f"processing_time={processing_time_ms}ms"
        )

        return ThreatAnalyticsResponse(
            is_threat=result.is_threat,
            threat_type=result.threat_type,
            risk_score=result.risk_score,
            confidence=result.confidence,
            matched_rules=matched_rule_ids,
            analysis_source=analysis_source,
            processing_time_ms=processing_time_ms,
        )

    except Exception as e:
        logger.error(f"Threat analytics failed: {e}")
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")
