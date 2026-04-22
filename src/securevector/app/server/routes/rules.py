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
from securevector.app.services.nlp_rule_generator import NLPRuleGenerator

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


class SyncFromCloudRequest(BaseModel):
    """Request body for POST /rules/sync-from-cloud (one-shot, no review)."""

    replace_existing: bool = Field(
        default=False,
        description=(
            "If true, clear community_rules first so the local cache becomes "
            "an exact mirror of the cloud bundle. Default false — upsert merges."
        ),
    )
    dry_run: bool = Field(
        default=False,
        description="If true, fetch and validate but do not write to SQLite.",
    )


class SyncApplyRequest(BaseModel):
    """Request body for POST /rules/sync/apply.

    Selective save:
      - Omit both `selected_rule_ids` and `skip_rule_ids` → apply all.
      - Send `skip_rule_ids=[…]` → apply everything except those.
      - Send `selected_rule_ids=[…]` → apply only those.
      - If both are sent, `selected_rule_ids` wins.
    """

    preview_token: str = Field(..., min_length=1)
    replace_existing: bool = Field(default=False)
    selected_rule_ids: Optional[list[str]] = Field(
        default=None,
        description="If set, apply only these rule IDs from the preview.",
    )
    skip_rule_ids: Optional[list[str]] = Field(
        default=None,
        description="If set, apply everything in the preview except these rule IDs.",
    )


def _map_sync_error(e: Exception) -> HTTPException:
    msg = str(e)
    # 409 if the caller's precondition failed (cloud off / no creds),
    # 502 if the cloud is unreachable or returned garbage.
    status = 409 if "Cloud Mode" in msg or "credentials" in msg.lower() or "Preview not found" in msg else 502
    return HTTPException(status_code=status, detail=msg)


@router.post("/rules/sync-from-cloud")
async def sync_rules_from_cloud_endpoint(
    request: SyncFromCloudRequest | None = None,
) -> dict:
    """One-shot cloud → local rule sync (no review step).

    Prefer `/rules/sync/preview` + `/rules/sync/apply` for UI flows — this
    endpoint exists for CLI/automation where skipping the review is fine.

    Requires Cloud Mode enabled. Response: `{ok, fetched, normalized,
    skipped, upserted, total_after, replaced_existing, dry_run,
    started_at, finished_at, source}`.
    """
    from securevector.app.services.cloud_rules_sync import (
        CloudRulesSyncError,
        sync_rules_from_cloud,
    )

    req = request or SyncFromCloudRequest()
    try:
        return await sync_rules_from_cloud(
            replace_existing=req.replace_existing,
            dry_run=req.dry_run,
        )
    except CloudRulesSyncError as e:
        raise _map_sync_error(e)
    except Exception as e:
        logger.error(f"Cloud rules sync failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/rules/sync/preview")
async def sync_preview_endpoint() -> dict:
    """Fetch the cloud bundle, validate it, and stash it for review.

    Does NOT write to the local cache. Returns a `preview_token` the UI
    uses to paginate through rules and later apply. Preview expires after
    ~10 minutes.
    """
    from securevector.app.services.cloud_rules_preview import create_preview
    from securevector.app.services.cloud_rules_sync import CloudRulesSyncError

    try:
        return await create_preview()
    except CloudRulesSyncError as e:
        raise _map_sync_error(e)
    except Exception as e:
        logger.error(f"Cloud rules preview failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/rules/sync/preview/{preview_token}")
async def sync_preview_page_endpoint(
    preview_token: str,
    page: int = Query(1, ge=1),
    per_page: int = Query(10, description="Page size (10, 25, 50, or 100)"),
) -> dict:
    """Paginate through the rules the user is about to import."""
    from securevector.app.services.cloud_rules_preview import get_preview_page
    from securevector.app.services.cloud_rules_sync import CloudRulesSyncError

    try:
        return get_preview_page(preview_token, page=page, per_page=per_page)
    except CloudRulesSyncError as e:
        raise _map_sync_error(e)


@router.post("/rules/sync/apply")
async def sync_apply_endpoint(request: SyncApplyRequest) -> dict:
    """Persist the previewed rules into the local cache."""
    from securevector.app.services.cloud_rules_preview import apply_preview
    from securevector.app.services.cloud_rules_sync import CloudRulesSyncError

    try:
        return await apply_preview(
            request.preview_token,
            replace_existing=request.replace_existing,
            selected_rule_ids=request.selected_rule_ids,
            skip_rule_ids=request.skip_rule_ids,
        )
    except CloudRulesSyncError as e:
        raise _map_sync_error(e)
    except Exception as e:
        logger.error(f"Cloud rules apply failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/rules/sync/preview/{preview_token}")
async def sync_preview_discard_endpoint(preview_token: str) -> dict:
    """Drop a preview without applying (user cancelled review)."""
    from securevector.app.services.cloud_rules_preview import discard_preview

    existed = discard_preview(preview_token)
    return {"ok": True, "existed": existed}


@router.get("/rules", response_model=RuleListResponse)
async def list_rules(
    category: Optional[str] = Query(None, description="Filter by category"),
    source: Optional[str] = Query("all", description="Filter by source (community/custom/all)"),
    enabled: Optional[bool] = Query(None, description="Filter by enabled status"),
    search: Optional[str] = Query(None, description="Search in name/description"),
) -> RuleListResponse:
    """
    Get all rules (community and custom).

    Rules are always local - cloud mode only affects analyze endpoint.
    """
    try:
        db = get_database()
        repo = RulesRepository(db)

        # Build response
        items = []

        # Add custom rules
        if source in ("custom", "all"):
            custom_rules = await repo.list_custom_rules(
                category=category,
                enabled=enabled,
            )
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

        # Add community rules from database cache
        if source in ("community", "all"):
            community_rules = await repo.list_community_rules(
                category=category,
                enabled=enabled,
            )

            # Get overrides to check which rules have been modified
            overrides = await repo.list_overrides()
            override_map = {o.original_rule_id: o for o in overrides}

            for rule in community_rules:
                if search and search.lower() not in rule.name.lower() and search.lower() not in rule.description.lower():
                    continue

                has_override = rule.id in override_map
                override = override_map.get(rule.id)

                # Apply override if exists
                effective_enabled = override.enabled if (override and override.enabled is not None) else rule.enabled
                effective_severity = override.severity if (override and override.severity) else rule.severity
                effective_patterns = override.patterns if (override and override.patterns) else rule.patterns

                # Prefer the time the rule *landed in this install* over
                # the cloud's original authoring date — users want the
                # Rules table to reflect "when did I get this rule" rather
                # than "when did the cloud team write it".
                #   - synced_at: set by cloud_rules_sync for rules pulled
                #     through Sync from Cloud (the common case for paid
                #     tiers).
                #   - loaded_at: set by cache_community_rule for every
                #     upsert (bundled + synced). Absolute fallback.
                #   - created_at (from metadata): legacy bundled-only fallback
                #     for old DBs that never got a loaded_at timestamp.
                rule_meta = rule.metadata or {}
                rule_created_at = (
                    rule_meta.get("synced_at")
                    or (rule.loaded_at.isoformat() if getattr(rule, "loaded_at", None) else None)
                    or rule_meta.get("created_at")
                )

                items.append(
                    RuleResponse(
                        id=rule.id,
                        name=rule.name,
                        category=rule.category,
                        description=rule.description,
                        severity=effective_severity,
                        patterns=effective_patterns,
                        enabled=effective_enabled,
                        source="community",
                        has_override=has_override,
                        metadata=rule.metadata,
                        created_at=rule_created_at,
                    )
                )

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
