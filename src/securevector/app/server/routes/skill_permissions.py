"""
Skill Permissions & Policy Engine API endpoints.

GET    /api/skill-permissions                - List permissions (filterable)
POST   /api/skill-permissions                - Add custom permission
PUT    /api/skill-permissions/{id}           - Update permission
DELETE /api/skill-permissions/{id}           - Delete permission
POST   /api/skill-permissions/reset          - Reset to defaults

GET    /api/skill-permissions/publishers     - List trusted publishers
POST   /api/skill-permissions/publishers     - Add publisher
DELETE /api/skill-permissions/publishers/{id} - Delete publisher

GET    /api/skill-permissions/policy-config  - Get policy config
PUT    /api/skill-permissions/policy-config  - Update policy config

POST   /api/skill-permissions/evaluate       - Evaluate findings against policy
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field, model_validator

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.skill_permissions import SkillPermissionsRepository
from securevector.app.services.policy_engine import PolicyEngine

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class PermissionResponse(BaseModel):
    id: int
    category: str
    pattern: str
    classification: str
    label: str
    is_default: bool
    enabled: bool


class PermissionListResponse(BaseModel):
    permissions: list[PermissionResponse]
    total: int


class AddPermissionRequest(BaseModel):
    category: str = Field(..., pattern=r"^(network|env_var|file_path|shell_command)$")
    pattern: str = Field(..., min_length=1, max_length=500)
    classification: str = Field(..., pattern=r"^(safe|review|dangerous)$")
    label: str = Field(default="", max_length=200)


class UpdatePermissionRequest(BaseModel):
    classification: Optional[str] = Field(default=None, pattern=r"^(safe|review|dangerous)$")
    label: Optional[str] = Field(default=None, max_length=200)
    enabled: Optional[bool] = None


class PublisherResponse(BaseModel):
    id: int
    publisher_name: str
    trust_level: str
    is_default: bool


class AddPublisherRequest(BaseModel):
    publisher_name: str = Field(..., min_length=1, max_length=200)
    trust_level: str = Field(default="trusted", pattern=r"^(trusted|untrusted)$")


class PolicyConfigResponse(BaseModel):
    policy_enabled: bool
    risk_weights: dict[str, int]
    threshold_allow: int
    threshold_warn: int


class UpdatePolicyConfigRequest(BaseModel):
    policy_enabled: Optional[bool] = None
    threshold_allow: Optional[int] = Field(default=None, ge=0, le=100)
    threshold_warn: Optional[int] = Field(default=None, ge=0, le=100)
    risk_weights: Optional[dict[str, int]] = None

    @model_validator(mode="after")
    def _check_risk_weights(self) -> "UpdatePolicyConfigRequest":
        if self.risk_weights:
            for cat, w in self.risk_weights.items():
                if w < 0:
                    raise ValueError(f"Risk weight for '{cat}' must be non-negative")
                if w > 100:
                    raise ValueError(f"Risk weight for '{cat}' must be <= 100")
        return self

    @model_validator(mode="after")
    def _check_threshold_order(self) -> "UpdatePolicyConfigRequest":
        if (
            self.threshold_allow is not None
            and self.threshold_warn is not None
            and self.threshold_allow > self.threshold_warn
        ):
            raise ValueError(
                "threshold_allow must be <= threshold_warn"
            )
        return self


VALID_CATEGORIES = {"network", "env_var", "file_path", "shell_command"}
VALID_CLASSIFICATIONS = {"safe", "review", "dangerous"}


class ImportPermissionItem(BaseModel):
    category: str = Field(..., pattern=r"^(network|env_var|file_path|shell_command)$")
    pattern: str = Field(..., min_length=1, max_length=500)
    classification: str = Field(..., pattern=r"^(safe|review|dangerous)$")
    label: str = Field(default="", max_length=200)


class ImportPermissionsRequest(BaseModel):
    permissions: list[ImportPermissionItem] = Field(..., min_length=1, max_length=1000)


class ImportPermissionsResponse(BaseModel):
    imported: int
    skipped: int
    errors: list[str]


class EvaluateRequest(BaseModel):
    findings: list[dict]
    publisher_name: Optional[str] = None


class PolicyFindingResponse(BaseModel):
    category: str
    pattern: str
    classification: Optional[str]
    severity: str
    file_path: str
    line_number: int
    excerpt: str
    weight: int


class EvaluateResponse(BaseModel):
    action: str
    risk_score: int
    threshold_allow: int
    threshold_warn: int
    total_findings: int
    safe_count: int
    review_count: int
    dangerous_count: int
    unknown_count: int
    trusted_publisher: bool
    publisher_name: Optional[str]
    classified_findings: list[PolicyFindingResponse]


# ---------------------------------------------------------------------------
# Permission endpoints
# ---------------------------------------------------------------------------

@router.get("/skill-permissions", response_model=PermissionListResponse)
async def list_permissions(
    category: Optional[str] = Query(default=None, pattern=r"^(network|env_var|file_path|shell_command)$"),
    classification: Optional[str] = Query(default=None, pattern=r"^(safe|review|dangerous)$"),
    enabled_only: bool = Query(default=False),
    limit: int = Query(default=500, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    db = get_database()
    repo = SkillPermissionsRepository(db)
    perms, total = await repo.list_permissions(
        category=category,
        classification=classification,
        enabled_only=enabled_only,
        limit=limit,
        offset=offset,
    )
    return PermissionListResponse(
        permissions=[
            PermissionResponse(
                id=p.id, category=p.category, pattern=p.pattern,
                classification=p.classification, label=p.label,
                is_default=p.is_default, enabled=p.enabled,
            )
            for p in perms
        ],
        total=total,
    )


@router.post("/skill-permissions", response_model=PermissionResponse, status_code=201)
async def add_permission(request: AddPermissionRequest):
    db = get_database()
    repo = SkillPermissionsRepository(db)
    try:
        perm = await repo.add_permission(
            category=request.category,
            pattern=request.pattern,
            classification=request.classification,
            label=request.label,
        )
    except Exception as exc:
        if "UNIQUE" in str(exc):
            raise HTTPException(status_code=409, detail="Permission already exists for this category/pattern")
        raise
    return PermissionResponse(
        id=perm.id, category=perm.category, pattern=perm.pattern,
        classification=perm.classification, label=perm.label,
        is_default=perm.is_default, enabled=perm.enabled,
    )


@router.put("/skill-permissions/policy-config", response_model=PolicyConfigResponse)
async def update_policy_config(request: UpdatePolicyConfigRequest):
    db = get_database()
    repo = SkillPermissionsRepository(db)

    # Cross-validate against current config when only one threshold is provided
    if (request.threshold_allow is not None) != (request.threshold_warn is not None):
        current = await repo.get_policy_config()
        new_allow = request.threshold_allow if request.threshold_allow is not None else current.threshold_allow
        new_warn = request.threshold_warn if request.threshold_warn is not None else current.threshold_warn
        if new_allow > new_warn:
            raise HTTPException(
                status_code=422,
                detail=f"threshold_allow ({new_allow}) must be <= threshold_warn ({new_warn})",
            )

    kwargs = {}
    if request.policy_enabled is not None:
        kwargs["policy_enabled"] = request.policy_enabled
    if request.threshold_allow is not None:
        kwargs["threshold_allow"] = request.threshold_allow
    if request.threshold_warn is not None:
        kwargs["threshold_warn"] = request.threshold_warn
    if request.risk_weights is not None:
        kwargs["risk_weights"] = request.risk_weights
    config = await repo.update_policy_config(**kwargs)
    return PolicyConfigResponse(
        policy_enabled=config.policy_enabled,
        risk_weights=config.risk_weights,
        threshold_allow=config.threshold_allow,
        threshold_warn=config.threshold_warn,
    )


@router.put("/skill-permissions/{perm_id}", response_model=PermissionResponse)
async def update_permission(perm_id: int, request: UpdatePermissionRequest):
    db = get_database()
    repo = SkillPermissionsRepository(db)
    perm = await repo.update_permission(
        perm_id,
        classification=request.classification,
        label=request.label,
        enabled=request.enabled,
    )
    if not perm:
        raise HTTPException(status_code=404, detail="Permission not found")
    return PermissionResponse(
        id=perm.id, category=perm.category, pattern=perm.pattern,
        classification=perm.classification, label=perm.label,
        is_default=perm.is_default, enabled=perm.enabled,
    )


@router.delete("/skill-permissions/{perm_id}", status_code=204)
async def delete_permission(perm_id: int):
    db = get_database()
    repo = SkillPermissionsRepository(db)
    try:
        deleted = await repo.delete_permission(perm_id)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    if not deleted:
        raise HTTPException(status_code=404, detail="Permission not found")
    return Response(status_code=204)


@router.post("/skill-permissions/reset", response_model=dict)
async def reset_permissions():
    db = get_database()
    repo = SkillPermissionsRepository(db)
    count = await repo.reset_defaults()
    return {"message": "Permissions reset to defaults", "total": count}


@router.get("/skill-permissions/export", response_model=dict)
async def export_permissions():
    """Export all permissions as JSON for backup or sharing."""
    db = get_database()
    repo = SkillPermissionsRepository(db)
    perms, _ = await repo.list_permissions(limit=10000)
    return {
        "permissions": [
            {
                "category": p.category,
                "pattern": p.pattern,
                "classification": p.classification,
                "label": p.label,
            }
            for p in perms
        ],
    }


@router.post("/skill-permissions/import", response_model=ImportPermissionsResponse)
async def import_permissions(request: ImportPermissionsRequest):
    """Bulk import permissions. Duplicates are skipped."""
    db = get_database()
    repo = SkillPermissionsRepository(db)
    imported = 0
    skipped = 0
    errors: list[str] = []

    for item in request.permissions:
        try:
            await repo.add_permission(
                category=item.category,
                pattern=item.pattern,
                classification=item.classification,
                label=item.label,
            )
            imported += 1
        except Exception as exc:
            if "UNIQUE" in str(exc):
                skipped += 1
            else:
                errors.append(f"{item.category}/{item.pattern}: {exc}")

    return ImportPermissionsResponse(imported=imported, skipped=skipped, errors=errors)


# ---------------------------------------------------------------------------
# Publisher endpoints
# ---------------------------------------------------------------------------

@router.get("/skill-permissions/publishers", response_model=list[PublisherResponse])
async def list_publishers():
    db = get_database()
    repo = SkillPermissionsRepository(db)
    publishers = await repo.list_publishers()
    return [
        PublisherResponse(
            id=p.id, publisher_name=p.publisher_name,
            trust_level=p.trust_level, is_default=p.is_default,
        )
        for p in publishers
    ]


@router.post("/skill-permissions/publishers", response_model=PublisherResponse, status_code=201)
async def add_publisher(request: AddPublisherRequest):
    db = get_database()
    repo = SkillPermissionsRepository(db)
    try:
        pub = await repo.add_publisher(request.publisher_name, request.trust_level)
    except Exception as exc:
        if "UNIQUE" in str(exc):
            raise HTTPException(status_code=409, detail="Publisher already exists")
        raise
    return PublisherResponse(
        id=pub.id, publisher_name=pub.publisher_name,
        trust_level=pub.trust_level, is_default=pub.is_default,
    )


@router.delete("/skill-permissions/publishers/{pub_id}", status_code=204)
async def delete_publisher(pub_id: int):
    db = get_database()
    repo = SkillPermissionsRepository(db)
    try:
        deleted = await repo.delete_publisher(pub_id)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    if not deleted:
        raise HTTPException(status_code=404, detail="Publisher not found")
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Policy config endpoints
# ---------------------------------------------------------------------------

@router.get("/skill-permissions/policy-config", response_model=PolicyConfigResponse)
async def get_policy_config():
    db = get_database()
    repo = SkillPermissionsRepository(db)
    config = await repo.get_policy_config()
    return PolicyConfigResponse(
        policy_enabled=config.policy_enabled,
        risk_weights=config.risk_weights,
        threshold_allow=config.threshold_allow,
        threshold_warn=config.threshold_warn,
    )


# ---------------------------------------------------------------------------
# Policy evaluation endpoint
# ---------------------------------------------------------------------------

@router.post("/skill-permissions/evaluate", response_model=EvaluateResponse)
async def evaluate_findings(request: EvaluateRequest):
    db = get_database()
    engine = PolicyEngine(db)
    decision = await engine.evaluate(request.findings, request.publisher_name)
    return EvaluateResponse(
        action=decision.action,
        risk_score=decision.risk_score,
        threshold_allow=decision.threshold_allow,
        threshold_warn=decision.threshold_warn,
        total_findings=decision.total_findings,
        safe_count=decision.safe_count,
        review_count=decision.review_count,
        dangerous_count=decision.dangerous_count,
        unknown_count=decision.unknown_count,
        trusted_publisher=decision.trusted_publisher,
        publisher_name=decision.publisher_name,
        classified_findings=[
            PolicyFindingResponse(
                category=f.category,
                pattern=f.pattern,
                classification=f.classification,
                severity=f.severity,
                file_path=f.file_path,
                line_number=f.line_number,
                excerpt=f.excerpt,
                weight=f.weight,
            )
            for f in decision.classified_findings
        ],
    )
