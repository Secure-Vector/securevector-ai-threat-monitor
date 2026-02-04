"""
Analysis API endpoint for threat detection.

POST /api/v1/analyze - Analyze text for threats
"""

import logging
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.threat_intel import ThreatIntelRepository
from securevector.app.database.repositories.settings import SettingsRepository
from securevector.app.utils.redaction import redact_secrets

logger = logging.getLogger(__name__)

router = APIRouter()


class AnalysisRequest(BaseModel):
    """Request body for threat analysis."""

    text: str = Field(..., max_length=102400, description="Text to analyze (max 100KB)")
    source: Optional[str] = Field(None, max_length=255, description="Source identifier")
    session_id: Optional[str] = Field(None, max_length=64, description="Session ID")
    request_id: Optional[str] = Field(None, max_length=64, description="Client request ID")
    metadata: Optional[dict] = Field(None, description="Additional metadata")
    llm_response: bool = Field(False, description="Set true when analyzing LLM output (checks for leaks, PII)")


class MatchedRule(BaseModel):
    """Matched rule details."""

    rule_id: str
    rule_name: str
    category: str
    severity: str
    source: str  # 'community' or 'custom'
    matched_patterns: list[str] = []


class LLMReviewInfo(BaseModel):
    """LLM review details."""

    reviewed: bool = False
    agrees: bool = True
    confidence: float = 0.0
    reasoning: str = ""
    recommendation: str = ""  # Recommended action from LLM
    risk_adjustment: int = 0
    model_used: Optional[str] = None
    processing_time_ms: int = 0
    tokens_used: int = 0


class AnalysisResult(BaseModel):
    """Response body for threat analysis."""

    is_threat: bool
    threat_type: Optional[str]
    risk_score: int = Field(..., ge=0, le=100)
    confidence: float = Field(..., ge=0, le=1)
    matched_rules: list[MatchedRule]
    analysis_id: Optional[str] = None
    processing_time_ms: int
    request_id: Optional[str] = None
    analysis_source: str = "local"  # "local", "cloud", or "local_fallback"
    # LLM Review fields
    llm_review: Optional[LLMReviewInfo] = None


@router.post("/analyze", response_model=AnalysisResult)
async def analyze_text(request: AnalysisRequest, http_request: Request) -> AnalysisResult:
    """
    Analyze text content for threats.

    When cloud mode is enabled, proxies to SecureVector cloud API.
    Otherwise, runs the text through local community and custom rules.
    Stores the result in threat intel and returns the analysis.
    """
    start_time = time.perf_counter()
    analysis_source = "local"
    user_agent = http_request.headers.get("user-agent")
    is_llm_response = request.llm_response  # True when analyzing LLM output

    try:
        # Check settings
        db = get_database()
        settings_repo = SettingsRepository(db)
        settings = await settings_repo.get()

        # If this is an LLM response scan and scan_llm_responses is disabled, skip
        if is_llm_response and not settings.scan_llm_responses:
            logger.debug("LLM response scanning disabled, skipping")
            return AnalysisResult(
                is_threat=False,
                threat_type=None,
                risk_score=0,
                confidence=0.0,
                matched_rules=[],
                analysis_id="skipped",
                processing_time_ms=0,
                request_id=request.request_id,
                analysis_source="disabled",
            )

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

                # Only store in database if threat detected
                record = None
                if cloud_result.get("is_threat", False):
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
                        user_agent=user_agent,
                    )

                return AnalysisResult(
                    is_threat=cloud_result.get("is_threat", False),
                    threat_type=cloud_result.get("threat_type"),
                    risk_score=cloud_result.get("risk_score", 0),
                    confidence=cloud_result.get("confidence", 0.0),
                    matched_rules=[],  # Cloud doesn't return detailed rules
                    analysis_id=record.id if record else None,
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

        # Get settings for LLM review and storage
        db = get_database()
        settings_repo = SettingsRepository(db)
        settings = await settings_repo.get()

        # LLM Review (if enabled)
        llm_review_info = None
        final_is_threat = result.is_threat
        final_risk_score = result.risk_score
        final_confidence = result.confidence
        final_threat_type = result.threat_type

        # Mark output scan threats with "output_" prefix
        scan_type = (request.metadata or {}).get("scan_type", "input")
        if is_llm_response and scan_type == "output" and final_threat_type:
            if not final_threat_type.startswith("output_"):
                final_threat_type = f"output_{final_threat_type}"

        llm_settings = settings.llm_settings or {}
        # Skip LLM review for output scans - regex is sufficient for data leakage detection
        # and LLM review adds latency that causes timeouts in block mode
        skip_llm_for_output = is_llm_response and scan_type == "output"
        if llm_settings.get("enabled") and not skip_llm_for_output:
            try:
                from securevector.app.services.llm_review import LLMConfig, LLMReviewService

                config = LLMConfig(
                    enabled=True,
                    provider=llm_settings.get("provider", "ollama"),
                    model=llm_settings.get("model", "llama3"),
                    endpoint=llm_settings.get("endpoint", "http://localhost:11434"),
                    api_key=llm_settings.get("api_key"),
                    timeout=llm_settings.get("timeout", 30),
                    max_tokens=llm_settings.get("max_tokens", 1024),
                    temperature=llm_settings.get("temperature", 0.1),
                )

                llm_service = LLMReviewService(config)
                try:
                    # Build analysis dict for LLM review
                    analysis_dict = {
                        "is_threat": result.is_threat,
                        "threat_type": result.threat_type,
                        "risk_score": result.risk_score,
                        "confidence": result.confidence,
                        "matched_rules": [r.rule_name for r in matched_rules],
                        # Context for LLM review: output scan looks for data leakage, PII exposure
                        "scan_type": "output" if is_llm_response else "input",
                    }

                    llm_result = await llm_service.review(request.text, analysis_dict)

                    if llm_result.reviewed:
                        llm_review_info = LLMReviewInfo(
                            reviewed=True,
                            agrees=llm_result.llm_agrees,
                            confidence=llm_result.llm_confidence,
                            reasoning=llm_result.llm_explanation,
                            recommendation=llm_result.llm_recommendation,
                            risk_adjustment=llm_result.llm_risk_adjustment,
                            model_used=llm_result.model_used,
                            processing_time_ms=llm_result.processing_time_ms,
                            tokens_used=llm_result.tokens_used,
                        )

                        # Combine results: adjust risk score and confidence
                        # If LLM found threat but regex didn't (or vice versa)
                        if llm_result.llm_threat_assessment == "threat" and not result.is_threat:
                            # LLM detected threat that regex missed
                            final_is_threat = True
                            final_risk_score = min(100, result.risk_score + max(30, llm_result.llm_risk_adjustment))
                            final_threat_type = llm_result.llm_suggested_category or "llm_detected"
                        elif llm_result.llm_threat_assessment == "safe" and result.is_threat:
                            # LLM thinks it's safe, reduce risk but keep as threat if high regex confidence
                            if result.confidence < 0.7:
                                final_is_threat = False
                                final_risk_score = max(0, result.risk_score + llm_result.llm_risk_adjustment)
                        else:
                            # Both agree, adjust risk score by LLM recommendation
                            final_risk_score = max(0, min(100, result.risk_score + llm_result.llm_risk_adjustment))

                        # Combine confidence scores (weighted average)
                        if llm_result.llm_confidence > 0:
                            final_confidence = (result.confidence * 0.4 + llm_result.llm_confidence * 0.6)

                        processing_time_ms += llm_result.processing_time_ms

                finally:
                    await llm_service.close()

            except Exception as e:
                logger.warning(f"LLM review failed, using regex-only result: {e}")
                llm_review_info = LLMReviewInfo(
                    reviewed=False,
                    reasoning=f"LLM review failed: {str(e)}",
                )

        # Only store in database if threat detected
        record = None
        if final_is_threat:
            threat_intel_repo = ThreatIntelRepository(db)

            # Redact secrets before storing
            text_to_store = request.text
            if settings.store_text_content:
                redacted_text, redaction_count = redact_secrets(request.text)
                if redaction_count > 0:
                    text_to_store = redacted_text
                    logger.info("Redacted")

            record = await threat_intel_repo.create(
                text=text_to_store,
                is_threat=final_is_threat,
                threat_type=final_threat_type,
                risk_score=final_risk_score,
                confidence=final_confidence,
                matched_rules=[r.model_dump() for r in matched_rules],
                processing_time_ms=processing_time_ms,
                store_text=settings.store_text_content,
                request_id=request.request_id,
                source=request.source,
                session_id=request.session_id,
                metadata=request.metadata,
                # LLM Review data
                llm_reviewed=llm_review_info.reviewed if llm_review_info else False,
                llm_agrees=llm_review_info.agrees if llm_review_info else True,
                llm_confidence=llm_review_info.confidence if llm_review_info else 0.0,
                llm_explanation=llm_review_info.reasoning if llm_review_info else None,
                llm_recommendation=llm_review_info.recommendation if llm_review_info else None,
                llm_risk_adjustment=llm_review_info.risk_adjustment if llm_review_info else 0,
                llm_model_used=llm_review_info.model_used if llm_review_info else None,
                llm_tokens_used=llm_review_info.tokens_used if llm_review_info else 0,
                user_agent=user_agent,
            )

        logger.debug(
            f"Analysis complete: is_threat={final_is_threat}, "
            f"risk_score={final_risk_score}, "
            f"llm_reviewed={llm_review_info.reviewed if llm_review_info else False}, "
            f"processing_time={processing_time_ms}ms"
        )

        return AnalysisResult(
            is_threat=final_is_threat,
            threat_type=final_threat_type,
            risk_score=final_risk_score,
            confidence=final_confidence,
            matched_rules=matched_rules,
            analysis_id=record.id if record else None,
            processing_time_ms=processing_time_ms,
            request_id=request.request_id,
            analysis_source=analysis_source,
            llm_review=llm_review_info,
        )

    except Exception as e:
        logger.error(f"Analysis failed: {e}")
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")
