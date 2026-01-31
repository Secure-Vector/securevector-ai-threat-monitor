"""
Rules API endpoints for managing detection rules.

GET /api/v1/rules - List all rules
POST /api/v1/rules/custom - Create custom rule
GET /api/v1/rules/custom/{id} - Get custom rule
PUT /api/v1/rules/custom/{id} - Update custom rule
DELETE /api/v1/rules/custom/{id} - Delete custom rule
PUT /api/v1/rules/{id}/override - Create/update rule override
DELETE /api/v1/rules/{id}/override - Delete rule override
POST /api/v1/rules/{id}/toggle - Toggle rule enabled status
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.rules import (
    RulesRepository,
    RuleValidationError,
)
from securevector.app.services.nlp_rule_generator import (
    NLPRuleGenerator,
    GeneratedPattern,
)

logger = logging.getLogger(__name__)

router = APIRouter()


class RuleResponse(BaseModel):
    """Rule response model."""

    id: str
    name: str
    category: str
    description: str
    severity: str
    patterns: list[str]
    enabled: bool
    source: str  # 'community' or 'custom'
    has_override: bool = False
    metadata: Optional[dict] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class RuleListResponse(BaseModel):
    """Rule list response."""

    items: list[RuleResponse]
    total: int
    categories: list[dict]
    source: str = "local"  # "local" or "cloud"


class CreateRuleRequest(BaseModel):
    """Request to create a custom rule."""

    name: str = Field(..., min_length=3, max_length=255)
    category: str = Field(..., min_length=2, max_length=50)
    description: str = Field(..., max_length=2000)
    severity: str = Field(..., pattern="^(low|medium|high|critical)$")
    patterns: list[str] = Field(..., min_length=1)
    enabled: bool = True
    metadata: Optional[dict] = None


class UpdateRuleRequest(BaseModel):
    """Request to update a custom rule."""

    name: Optional[str] = Field(None, min_length=3, max_length=255)
    category: Optional[str] = Field(None, min_length=2, max_length=50)
    description: Optional[str] = Field(None, max_length=2000)
    severity: Optional[str] = Field(None, pattern="^(low|medium|high|critical)$")
    patterns: Optional[list[str]] = Field(None, min_length=1)
    enabled: Optional[bool] = None
    metadata: Optional[dict] = None


class RuleOverrideRequest(BaseModel):
    """Request to override a community rule."""

    enabled: Optional[bool] = None
    severity: Optional[str] = Field(None, pattern="^(low|medium|high|critical)$")
    patterns: Optional[list[str]] = None


class ToggleRequest(BaseModel):
    """Request to toggle rule enabled status."""

    enabled: bool


class GeneratePatternsRequest(BaseModel):
    """Request to generate patterns from natural language."""

    description: str = Field(..., min_length=5, max_length=500, description="Natural language description")


class GeneratedPatternResponse(BaseModel):
    """Generated pattern response."""

    pattern: str
    description: str
    confidence: float
    category: str


class GeneratePatternsResponse(BaseModel):
    """Response with generated patterns."""

    patterns: list[GeneratedPatternResponse]
    suggested_category: str
    suggested_severity: str
    suggested_name: str


@router.post("/rules/generate", response_model=GeneratePatternsResponse)
async def generate_patterns_from_nlp(request: GeneratePatternsRequest) -> GeneratePatternsResponse:
    """
    Generate regex patterns from a natural language description.

    Examples:
    - "block credit card numbers" → credit card regex patterns
    - "detect api keys and passwords" → secret detection patterns
    - "flag attempts to ignore instructions" → prompt injection patterns

    The generated patterns can be used to create a custom rule.
    """
    try:
        generator = NLPRuleGenerator()
        patterns = generator.generate(request.description)
        suggested_category = generator.suggest_category(request.description)
        suggested_severity = generator.suggest_severity(patterns)

        # Generate suggested name from description
        words = request.description.lower().split()[:4]
        suggested_name = "_".join(w for w in words if w.isalnum())[:50]

        return GeneratePatternsResponse(
            patterns=[
                GeneratedPatternResponse(
                    pattern=p.pattern,
                    description=p.description,
                    confidence=p.confidence,
                    category=p.category,
                )
                for p in patterns
            ],
            suggested_category=suggested_category,
            suggested_severity=suggested_severity,
            suggested_name=suggested_name or "custom_rule",
        )

    except Exception as e:
        logger.error(f"Failed to generate patterns: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/rules", response_model=RuleListResponse)
async def list_rules(
    category: Optional[str] = Query(None, description="Filter by category"),
    source: Optional[str] = Query("all", description="Filter by source (community/custom/all)"),
    enabled: Optional[bool] = Query(None, description="Filter by enabled status"),
    search: Optional[str] = Query(None, description="Search in name/description"),
) -> RuleListResponse:
    """
    Get all rules (community and custom).

    When cloud mode is enabled, returns cloud rules.
    Otherwise, returns local rules with effective settings (overrides applied).
    """
    try:
        db = get_database()

        # Check if cloud mode is enabled
        from securevector.app.database.repositories.settings import SettingsRepository

        settings_repo = SettingsRepository(db)
        settings = await settings_repo.get()

        if settings.cloud_mode_enabled:
            # Try to get cloud rules
            try:
                from securevector.app.services.cloud_proxy import (
                    get_cloud_proxy,
                    CloudProxyError,
                )

                proxy = get_cloud_proxy()
                cloud_result = await proxy.get_rules()

                # Convert cloud response to our format
                items = []
                for rule in cloud_result.get("rules", []):
                    items.append(
                        RuleResponse(
                            id=rule.get("id", "unknown"),
                            name=rule.get("name", "Unknown Rule"),
                            category=rule.get("category", "unknown"),
                            description=rule.get("description", ""),
                            severity=rule.get("severity", "medium"),
                            patterns=rule.get("patterns", []),
                            enabled=rule.get("enabled", True),
                            source="cloud",
                            has_override=False,
                        )
                    )

                # Calculate category counts
                category_counts = {}
                for item in items:
                    category_counts[item.category] = (
                        category_counts.get(item.category, 0) + 1
                    )

                categories = [
                    {"name": cat, "count": count}
                    for cat, count in sorted(category_counts.items())
                ]

                return RuleListResponse(
                    items=items,
                    total=len(items),
                    categories=categories,
                    source="cloud",
                )

            except Exception as e:
                logger.warning(f"Failed to get cloud rules, using local: {e}")
                # Fall through to local rules

        repo = RulesRepository(db)

        # Get custom rules
        custom_rules = await repo.list_custom_rules(
            category=category if source in ("custom", "all") else "__none__",
            enabled=enabled,
        )

        # Get overrides
        overrides = await repo.list_overrides()
        override_map = {o.original_rule_id: o for o in overrides}

        # Build response
        items = []

        # Add custom rules
        for rule in custom_rules:
            if search and search.lower() not in rule.name.lower() and search.lower() not in rule.description.lower():
                continue
            items.append(
                RuleResponse(
                    id=rule.id,
                    name=rule.name,
                    category=rule.category,
                    description=rule.description,
                    severity=rule.severity,
                    patterns=rule.patterns,
                    enabled=rule.enabled,
                    source="custom",
                    has_override=False,
                    metadata=rule.metadata,
                    created_at=rule.created_at.isoformat() if rule.created_at else None,
                    updated_at=rule.updated_at.isoformat() if rule.updated_at else None,
                )
            )

        # TODO: Add community rules from SDK
        # For now, return just custom rules

        # Calculate category counts
        category_counts = {}
        for item in items:
            category_counts[item.category] = category_counts.get(item.category, 0) + 1

        categories = [
            {"name": cat, "count": count}
            for cat, count in sorted(category_counts.items())
        ]

        return RuleListResponse(
            items=items,
            total=len(items),
            categories=categories,
            source="local",
        )

    except Exception as e:
        logger.error(f"Failed to list rules: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/rules/custom", response_model=RuleResponse, status_code=201)
async def create_custom_rule(request: CreateRuleRequest) -> RuleResponse:
    """
    Create a new custom detection rule.
    """
    try:
        db = get_database()
        repo = RulesRepository(db)

        rule = await repo.create_custom_rule(
            name=request.name,
            category=request.category,
            description=request.description,
            severity=request.severity,
            patterns=request.patterns,
            enabled=request.enabled,
            metadata=request.metadata,
        )

        return RuleResponse(
            id=rule.id,
            name=rule.name,
            category=rule.category,
            description=rule.description,
            severity=rule.severity,
            patterns=rule.patterns,
            enabled=rule.enabled,
            source="custom",
            has_override=False,
            metadata=rule.metadata,
            created_at=rule.created_at.isoformat() if rule.created_at else None,
            updated_at=rule.updated_at.isoformat() if rule.updated_at else None,
        )

    except RuleValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to create rule: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/rules/custom/{rule_id}", response_model=RuleResponse)
async def get_custom_rule(rule_id: str) -> RuleResponse:
    """
    Get a custom rule by ID.
    """
    try:
        db = get_database()
        repo = RulesRepository(db)

        rule = await repo.get_custom_rule(rule_id)

        if rule is None:
            raise HTTPException(status_code=404, detail="Rule not found")

        return RuleResponse(
            id=rule.id,
            name=rule.name,
            category=rule.category,
            description=rule.description,
            severity=rule.severity,
            patterns=rule.patterns,
            enabled=rule.enabled,
            source="custom",
            has_override=False,
            metadata=rule.metadata,
            created_at=rule.created_at.isoformat() if rule.created_at else None,
            updated_at=rule.updated_at.isoformat() if rule.updated_at else None,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get rule: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/rules/custom/{rule_id}", response_model=RuleResponse)
async def update_custom_rule(rule_id: str, request: UpdateRuleRequest) -> RuleResponse:
    """
    Update a custom rule.
    """
    try:
        db = get_database()
        repo = RulesRepository(db)

        rule = await repo.update_custom_rule(
            rule_id=rule_id,
            name=request.name,
            category=request.category,
            description=request.description,
            severity=request.severity,
            patterns=request.patterns,
            enabled=request.enabled,
            metadata=request.metadata,
        )

        if rule is None:
            raise HTTPException(status_code=404, detail="Rule not found")

        return RuleResponse(
            id=rule.id,
            name=rule.name,
            category=rule.category,
            description=rule.description,
            severity=rule.severity,
            patterns=rule.patterns,
            enabled=rule.enabled,
            source="custom",
            has_override=False,
            metadata=rule.metadata,
            created_at=rule.created_at.isoformat() if rule.created_at else None,
            updated_at=rule.updated_at.isoformat() if rule.updated_at else None,
        )

    except RuleValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update rule: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/rules/custom/{rule_id}", status_code=204)
async def delete_custom_rule(rule_id: str) -> None:
    """
    Delete a custom rule.
    """
    try:
        db = get_database()
        repo = RulesRepository(db)

        deleted = await repo.delete_custom_rule(rule_id)

        if not deleted:
            raise HTTPException(status_code=404, detail="Rule not found")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete rule: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/rules/{rule_id}/override", response_model=RuleResponse)
async def set_rule_override(rule_id: str, request: RuleOverrideRequest) -> RuleResponse:
    """
    Create or update an override for a community rule.
    """
    try:
        db = get_database()
        repo = RulesRepository(db)

        override = await repo.create_override(
            original_rule_id=rule_id,
            enabled=request.enabled,
            severity=request.severity,
            patterns=request.patterns,
        )

        # TODO: Return the effective rule with override applied
        # For now, return a placeholder
        return RuleResponse(
            id=rule_id,
            name=f"Rule {rule_id}",
            category="unknown",
            description="Community rule with override",
            severity=override.severity or "medium",
            patterns=override.patterns or [],
            enabled=override.enabled if override.enabled is not None else True,
            source="community",
            has_override=True,
            created_at=override.created_at.isoformat() if override.created_at else None,
            updated_at=override.updated_at.isoformat() if override.updated_at else None,
        )

    except RuleValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to set override: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/rules/{rule_id}/override", response_model=RuleResponse)
async def reset_rule_override(rule_id: str) -> RuleResponse:
    """
    Remove an override and reset to default community rule.
    """
    try:
        db = get_database()
        repo = RulesRepository(db)

        deleted = await repo.delete_override(rule_id)

        if not deleted:
            raise HTTPException(status_code=404, detail="Override not found")

        # TODO: Return the original community rule
        return RuleResponse(
            id=rule_id,
            name=f"Rule {rule_id}",
            category="unknown",
            description="Community rule (default settings)",
            severity="medium",
            patterns=[],
            enabled=True,
            source="community",
            has_override=False,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to reset override: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/rules/{rule_id}/toggle", response_model=RuleResponse)
async def toggle_rule(rule_id: str, request: ToggleRequest) -> RuleResponse:
    """
    Toggle a rule's enabled status.

    Works for both custom rules and community rules (via override).
    """
    try:
        db = get_database()
        repo = RulesRepository(db)

        # Check if it's a custom rule
        custom_rule = await repo.get_custom_rule(rule_id)

        if custom_rule:
            # Update custom rule
            rule = await repo.update_custom_rule(rule_id, enabled=request.enabled)
            return RuleResponse(
                id=rule.id,
                name=rule.name,
                category=rule.category,
                description=rule.description,
                severity=rule.severity,
                patterns=rule.patterns,
                enabled=rule.enabled,
                source="custom",
                has_override=False,
                metadata=rule.metadata,
                created_at=rule.created_at.isoformat() if rule.created_at else None,
                updated_at=rule.updated_at.isoformat() if rule.updated_at else None,
            )
        else:
            # Create/update override for community rule
            override = await repo.create_override(rule_id, enabled=request.enabled)
            return RuleResponse(
                id=rule_id,
                name=f"Rule {rule_id}",
                category="unknown",
                description="Community rule",
                severity="medium",
                patterns=[],
                enabled=request.enabled,
                source="community",
                has_override=True,
                updated_at=override.updated_at.isoformat() if override.updated_at else None,
            )

    except Exception as e:
        logger.error(f"Failed to toggle rule: {e}")
        raise HTTPException(status_code=500, detail=str(e))
