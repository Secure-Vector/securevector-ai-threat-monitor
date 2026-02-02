"""
LLM Review API endpoints.

GET /api/settings/llm - Get LLM configuration
PUT /api/settings/llm - Update LLM configuration
POST /api/settings/llm/test - Test LLM connection
POST /api/llm/review - Review analysis result with LLM
"""

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.settings import SettingsRepository
from securevector.app.services.llm_review import (
    LLMConfig,
    LLMProvider,
    LLMReviewService,
    DEFAULT_CONFIGS,
)

logger = logging.getLogger(__name__)

router = APIRouter()


class LLMSettingsResponse(BaseModel):
    """LLM settings response."""
    enabled: bool = False
    provider: str = "ollama"
    model: str = "llama3"
    endpoint: str = "http://localhost:11434"
    api_key_configured: bool = False
    aws_region: str = "us-east-1"
    timeout: int = 30
    max_tokens: int = 1024
    temperature: float = 0.1


class LLMSettingsUpdate(BaseModel):
    """LLM settings update request."""
    enabled: Optional[bool] = None
    provider: Optional[str] = Field(None, pattern="^(ollama|openai|anthropic|azure|bedrock|custom)$")
    model: Optional[str] = Field(None, max_length=100)
    endpoint: Optional[str] = Field(None, max_length=500)
    api_key: Optional[str] = Field(None, max_length=500)
    api_secret: Optional[str] = Field(None, max_length=500)  # For AWS secret key
    aws_region: Optional[str] = Field(None, max_length=50)  # For Bedrock
    timeout: Optional[int] = Field(None, ge=5, le=120)
    max_tokens: Optional[int] = Field(None, ge=100, le=4096)
    temperature: Optional[float] = Field(None, ge=0, le=2)


class LLMProvidersResponse(BaseModel):
    """Available LLM providers and their defaults."""
    providers: list[dict[str, Any]]


class TestConnectionResponse(BaseModel):
    """Test connection response."""
    success: bool
    message: str


class ReviewRequest(BaseModel):
    """Request to review an analysis result."""
    original_text: str = Field(..., min_length=1, max_length=10000)
    analysis_result: dict[str, Any]


class ReviewResponse(BaseModel):
    """LLM review response."""
    reviewed: bool
    llm_agrees: bool = True
    llm_threat_assessment: Optional[str] = None
    llm_confidence: float = 0.0
    llm_explanation: str = ""
    llm_suggested_category: Optional[str] = None
    llm_risk_adjustment: int = 0
    model_used: Optional[str] = None
    processing_time_ms: int = 0
    error: Optional[str] = None


@router.get("/settings/llm", response_model=LLMSettingsResponse)
async def get_llm_settings() -> LLMSettingsResponse:
    """Get current LLM settings."""
    try:
        db = get_database()
        repo = SettingsRepository(db)
        settings = await repo.get()

        llm_settings = settings.llm_settings or {}

        return LLMSettingsResponse(
            enabled=llm_settings.get("enabled", False),
            provider=llm_settings.get("provider", "ollama"),
            model=llm_settings.get("model", "llama3"),
            endpoint=llm_settings.get("endpoint", "http://localhost:11434"),
            api_key_configured=bool(llm_settings.get("api_key")),
            aws_region=llm_settings.get("aws_region", "us-east-1"),
            timeout=llm_settings.get("timeout", 30),
            max_tokens=llm_settings.get("max_tokens", 1024),
            temperature=llm_settings.get("temperature", 0.1),
        )

    except Exception as e:
        logger.error(f"Failed to get LLM settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/settings/llm", response_model=LLMSettingsResponse)
async def update_llm_settings(request: LLMSettingsUpdate) -> LLMSettingsResponse:
    """Update LLM settings."""
    try:
        db = get_database()
        repo = SettingsRepository(db)
        settings = await repo.get()

        # Get current settings
        llm_settings = settings.llm_settings or {}

        # Update only provided fields
        if request.enabled is not None:
            llm_settings["enabled"] = request.enabled
        if request.provider is not None:
            llm_settings["provider"] = request.provider
            # Set default endpoint for provider if not custom
            if request.endpoint is None and request.provider in DEFAULT_CONFIGS:
                default_endpoint = DEFAULT_CONFIGS[LLMProvider(request.provider)]["endpoint"]
                if default_endpoint:
                    llm_settings["endpoint"] = default_endpoint
        if request.model is not None:
            llm_settings["model"] = request.model
        if request.endpoint is not None:
            llm_settings["endpoint"] = request.endpoint
        if request.api_key is not None:
            llm_settings["api_key"] = request.api_key
        if request.api_secret is not None:
            llm_settings["api_secret"] = request.api_secret
        if request.aws_region is not None:
            llm_settings["aws_region"] = request.aws_region
        if request.timeout is not None:
            llm_settings["timeout"] = request.timeout
        if request.max_tokens is not None:
            llm_settings["max_tokens"] = request.max_tokens
        if request.temperature is not None:
            llm_settings["temperature"] = request.temperature

        # Save settings
        await repo.update(llm_settings=llm_settings)

        return LLMSettingsResponse(
            enabled=llm_settings.get("enabled", False),
            provider=llm_settings.get("provider", "ollama"),
            model=llm_settings.get("model", "llama3"),
            endpoint=llm_settings.get("endpoint", "http://localhost:11434"),
            api_key_configured=bool(llm_settings.get("api_key")),
            aws_region=llm_settings.get("aws_region", "us-east-1"),
            timeout=llm_settings.get("timeout", 30),
            max_tokens=llm_settings.get("max_tokens", 1024),
            temperature=llm_settings.get("temperature", 0.1),
        )

    except Exception as e:
        logger.error(f"Failed to update LLM settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/llm/providers", response_model=LLMProvidersResponse)
async def get_llm_providers() -> LLMProvidersResponse:
    """Get available LLM providers and their default configurations."""
    providers = []
    for provider, config in DEFAULT_CONFIGS.items():
        providers.append({
            "id": provider.value,
            "name": provider.value.title() if provider != LLMProvider.OPENAI else "OpenAI",
            "endpoint": config["endpoint"],
            "models": config["models"],
            "requires_api_key": provider not in [LLMProvider.OLLAMA, LLMProvider.CUSTOM],
        })
    return LLMProvidersResponse(providers=providers)


@router.post("/settings/llm/test", response_model=TestConnectionResponse)
async def test_llm_connection() -> TestConnectionResponse:
    """Test the LLM connection with current settings."""
    try:
        db = get_database()
        repo = SettingsRepository(db)
        settings = await repo.get()

        llm_settings = settings.llm_settings or {}

        config = LLMConfig(
            enabled=True,  # Force enabled for test
            provider=llm_settings.get("provider", "ollama"),
            model=llm_settings.get("model", "llama3"),
            endpoint=llm_settings.get("endpoint", "http://localhost:11434"),
            api_key=llm_settings.get("api_key"),
            timeout=llm_settings.get("timeout", 30),
        )

        service = LLMReviewService(config)
        try:
            success, message = await service.test_connection()
            return TestConnectionResponse(success=success, message=message)
        finally:
            await service.close()

    except Exception as e:
        logger.error(f"Failed to test LLM connection: {e}")
        return TestConnectionResponse(success=False, message=str(e))


@router.post("/llm/review", response_model=ReviewResponse)
async def review_analysis(request: ReviewRequest) -> ReviewResponse:
    """
    Review an analysis result using the configured LLM.

    This endpoint can be called independently to get LLM review
    of any analysis result.
    """
    try:
        db = get_database()
        repo = SettingsRepository(db)
        settings = await repo.get()

        llm_settings = settings.llm_settings or {}

        if not llm_settings.get("enabled"):
            return ReviewResponse(
                reviewed=False,
                error="LLM review is not enabled. Configure it in Settings.",
            )

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

        service = LLMReviewService(config)
        try:
            result = await service.review(request.original_text, request.analysis_result)
            return ReviewResponse(
                reviewed=result.reviewed,
                llm_agrees=result.llm_agrees,
                llm_threat_assessment=result.llm_threat_assessment,
                llm_confidence=result.llm_confidence,
                llm_explanation=result.llm_explanation,
                llm_suggested_category=result.llm_suggested_category,
                llm_risk_adjustment=result.llm_risk_adjustment,
                model_used=result.model_used,
                processing_time_ms=result.processing_time_ms,
                error=result.error,
            )
        finally:
            await service.close()

    except Exception as e:
        logger.error(f"LLM review failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def get_llm_service() -> Optional[LLMReviewService]:
    """
    Get an LLM review service if enabled.

    Returns None if LLM review is not configured or disabled.
    """
    try:
        db = get_database()
        repo = SettingsRepository(db)
        settings = await repo.get()

        llm_settings = settings.llm_settings or {}

        if not llm_settings.get("enabled"):
            return None

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

        return LLMReviewService(config)

    except Exception as e:
        logger.error(f"Failed to get LLM service: {e}")
        return None
