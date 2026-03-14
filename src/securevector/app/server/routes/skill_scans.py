"""
Skill Scanner API endpoints.

GET  /api/skill-scans/history           - Paginated scan history
GET  /api/skill-scans/history/{scan_id} - Single scan record with full findings
POST /api/skill-scans/scan              - Trigger a new skill scan
DELETE /api/skill-scans/history/{scan_id} - Delete a scan record
"""

import asyncio
import json
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.skill_scans import SkillScansRepository, ScanRecord
from securevector.app.services.skill_scanner import SkillScannerService

logger = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# Blocked system path prefixes (defence-in-depth at route level)
# ---------------------------------------------------------------------------
_BLOCKED_SYSTEM_PATHS = {
    "/etc",
    "/proc",
    "/sys",
    "/dev",
    "/root",
    "/boot",
    "/usr/bin",
    "/usr/sbin",
    "/sbin",
    "/bin",
}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

def _validate_one_path(v: str) -> str:
    """Shared path validation used by the field validator."""
    v = v.strip()
    if not v:
        raise ValueError("path must not be empty or whitespace")
    if "\x00" in v:
        raise ValueError("path must not contain null bytes")
    if len(v) > 4096:
        raise ValueError("path must not exceed 4096 characters")
    expanded = str(Path(v).expanduser())
    # Reject root and all blocked system paths (must match _BLOCKED_SYSTEM_PATHS)
    if expanded == "/":
        raise ValueError("scanning '/' is not allowed")
    for blocked in _BLOCKED_SYSTEM_PATHS:
        if expanded == blocked or expanded.startswith(blocked + "/"):
            raise ValueError(f"scanning '{expanded}' is not allowed")
    return v


class ScanRequest(BaseModel):
    paths: list[str] = Field(
        ...,
        min_length=1,
        max_length=20,
        description="One or more skill directory paths to scan (max 20). Each may use ~ for home directory.",
    )

    @field_validator("paths")
    @classmethod
    def validate_paths(cls, vs: list[str]) -> list[str]:
        validated = []
        seen: set[str] = set()
        for v in vs:
            v = _validate_one_path(v)
            if v in seen:
                continue  # silently deduplicate
            seen.add(v)
            validated.append(v)
        return validated


class FindingResponse(BaseModel):
    file_path: str
    line_number: int
    category: str
    excerpt: str
    severity: str
    rule_id: str


class ScanRecordSummary(BaseModel):
    id: str
    scanned_path: str
    skill_name: str
    scan_timestamp: str
    invocation_source: str
    risk_level: str
    findings_count: int
    manifest_present: bool


class ScanRecordDetail(ScanRecordSummary):
    findings: list[FindingResponse]


class ScanHistoryResponse(BaseModel):
    records: list[ScanRecordSummary]
    total: int


class ScanResultItem(BaseModel):
    """Result for a single path within a multi-scan request."""
    path: str
    success: bool
    result: ScanRecordDetail | None = None
    error: str | None = None
    warning: str | None = None


class MultiScanResponse(BaseModel):
    results: list[ScanResultItem]
    total_scanned: int
    total_errors: int


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _record_to_summary(record: ScanRecord) -> ScanRecordSummary:
    return ScanRecordSummary(
        id=record.id,
        scanned_path=record.scanned_path,
        skill_name=record.skill_name,
        scan_timestamp=record.scan_timestamp,
        invocation_source=record.invocation_source,
        risk_level=record.risk_level,
        findings_count=record.findings_count,
        manifest_present=bool(record.manifest_present),
    )


def _record_to_detail(record: ScanRecord) -> ScanRecordDetail:
    try:
        raw_findings = json.loads(record.findings_json)
    except Exception:
        raw_findings = []
    findings = [FindingResponse(**f) for f in raw_findings]
    # Use actual parsed findings length as authoritative count
    return ScanRecordDetail(
        id=record.id,
        scanned_path=record.scanned_path,
        skill_name=record.skill_name,
        scan_timestamp=record.scan_timestamp,
        invocation_source=record.invocation_source,
        risk_level=record.risk_level,
        findings_count=len(findings),
        manifest_present=bool(record.manifest_present),
        findings=findings,
    )


def _check_blocked_path(skill_path: Path) -> None:
    """Raise HTTPException 400 if the resolved path falls under a blocked system root."""
    try:
        resolved_str = str(skill_path.resolve())
    except Exception:
        resolved_str = str(skill_path)
    for blocked in _BLOCKED_SYSTEM_PATHS:
        if resolved_str == blocked or resolved_str.startswith(blocked + "/"):
            raise HTTPException(
                status_code=400,
                detail=f"Scanning system path is not allowed: {skill_path}",
            )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/skill-scans/scan", response_model=MultiScanResponse)
async def trigger_scan(request: ScanRequest):
    """Scan one or more skill directories concurrently and persist all results."""
    db = get_database()
    scanner = SkillScannerService(db)
    repo = SkillScansRepository(db)

    openclaw_skills_dir = Path("~/.openclaw/skills").expanduser().resolve()

    async def _scan_one(path: str) -> ScanResultItem:
        # Resolve to absolute path and validate before any filesystem access
        try:
            resolved_path = Path(path).expanduser().resolve(strict=False)
        except (ValueError, OSError):
            return ScanResultItem(path=path, success=False, error=f"Invalid path: {path}")

        try:
            _check_blocked_path(resolved_path)
        except HTTPException as exc:
            return ScanResultItem(path=path, success=False, error=exc.detail)

        if not resolved_path.exists() or not resolved_path.is_dir():
            return ScanResultItem(path=path, success=False, error=f"Path not found or not a directory: {path}")

        # Warn if path is outside the standard OpenClaw skills directory
        warning = None
        if not str(resolved_path).startswith(str(openclaw_skills_dir)):
            warning = (
                "This path is outside the standard OpenClaw skills directory "
                f"({openclaw_skills_dir}). Verify the source before installing."
            )

        try:
            result = await scanner.scan(str(resolved_path), invocation_source="ui")
        except ValueError as exc:
            return ScanResultItem(path=path, success=False, error=str(exc))
        except Exception as exc:
            logger.exception("Skill scan failed for %s", path)
            return ScanResultItem(path=path, success=False, error=f"Scan failed: {exc}")

        record = ScanRecord(
            id=result.id,
            scanned_path=result.scanned_path,
            skill_name=result.skill_name,
            scan_timestamp=result.scan_timestamp,
            invocation_source="ui",
            risk_level=result.risk_level,
            findings_count=result.findings_count,
            findings_json=result.findings_json_str(),
            manifest_present=1 if result.manifest_present else 0,
        )
        await repo.insert_scan(record)
        return ScanResultItem(path=path, success=True, result=_record_to_detail(record), warning=warning)

    items = await asyncio.gather(*[_scan_one(p) for p in request.paths])
    results = list(items)

    return MultiScanResponse(
        results=results,
        total_scanned=sum(1 for r in results if r.success),
        total_errors=sum(1 for r in results if not r.success),
    )


@router.get("/skill-scans/history", response_model=ScanHistoryResponse)
async def list_scan_history(
    limit: int = Query(default=50, ge=1, le=200, description="Number of records to return (1–200)"),
    offset: int = Query(default=0, ge=0, description="Number of records to skip"),
):
    """Return paginated scan history, newest-first."""
    db = get_database()
    repo = SkillScansRepository(db)
    records, total = await repo.list_scans(limit=limit, offset=offset)
    return ScanHistoryResponse(
        records=[_record_to_summary(r) for r in records],
        total=total,
    )


def _validate_scan_id(scan_id: str) -> None:
    """Reject scan_id values that don't look like a UUID."""
    import re as _re
    if not _re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", scan_id, _re.IGNORECASE):
        raise HTTPException(status_code=400, detail="scan_id must be a valid UUID")


@router.get("/skill-scans/history/{scan_id}", response_model=ScanRecordDetail)
async def get_scan_record(scan_id: str):
    """Return a single scan record with full findings."""
    _validate_scan_id(scan_id)
    db = get_database()
    repo = SkillScansRepository(db)
    record = await repo.get_scan_by_id(scan_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Scan record not found: {scan_id}")
    return _record_to_detail(record)


@router.delete("/skill-scans/history/{scan_id}", status_code=204)
async def delete_scan_record(scan_id: str):
    """Hard-delete a scan record."""
    _validate_scan_id(scan_id)
    db = get_database()
    repo = SkillScansRepository(db)
    deleted = await repo.delete_scan(scan_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Scan record not found: {scan_id}")
    return Response(status_code=204)
