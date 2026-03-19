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
import os
import platform
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.skill_scans import SkillScansRepository, ScanRecord
from securevector.app.services.skill_scanner import SkillScannerService
from securevector.app.services.policy_engine import PolicyEngine

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

def _win_path_to_wsl(v: str) -> str:
    """Convert a Windows path (e.g. C:\\Users\\x) to WSL mount path (/mnt/c/Users/x)."""
    v = v.replace("\\", "/")
    # Match drive letter pattern: C:/... or c:/...
    if len(v) >= 3 and v[1] == ":" and v[2] == "/":
        drive = v[0].lower()
        return f"/mnt/{drive}{v[2:]}"
    return v


def _validate_one_path(v: str) -> str:
    """Shared path validation used by the field validator."""
    v = v.strip()
    if not v:
        raise ValueError("path must not be empty or whitespace")
    if "\x00" in v:
        raise ValueError("path must not contain null bytes")
    if len(v) > 4096:
        raise ValueError("path must not exceed 4096 characters")
    # Auto-convert Windows paths when running under WSL
    if platform.system() == "Linux" and _is_wsl() and len(v) >= 2 and v[1] in (":", ) and v[0].isalpha():
        v = _win_path_to_wsl(v)
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
    ai_verdict: str = ""
    ai_explanation: str = ""


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


class PolicySummary(BaseModel):
    """Inline policy evaluation result attached to each scan."""
    action: str             # 'allow', 'warn', 'block'
    risk_score: int
    safe_count: int = 0
    review_count: int = 0
    dangerous_count: int = 0
    unknown_count: int = 0
    trusted_publisher: bool = False


class ScanHistoryResponse(BaseModel):
    records: list[ScanRecordSummary]
    total: int


class AIReviewSummary(BaseModel):
    """AI-powered false-positive review summary."""
    reviewed: bool = False
    false_positives: int = 0
    ai_risk_level: str = ""
    ai_assessment: str = ""
    model_used: str = ""
    tokens_used: int = 0


class ScanResultItem(BaseModel):
    """Result for a single path within a multi-scan request."""
    path: str
    success: bool
    result: ScanRecordDetail | None = None
    policy: PolicySummary | None = None
    ai_review: AIReviewSummary | None = None
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



# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

class DiscoveredSkill(BaseModel):
    name: str
    path: str
    source: str  # e.g. "openclaw", "mcp", "claude", "custom"


class DiscoverResponse(BaseModel):
    skills_dir: str
    skills: list[DiscoveredSkill]
    searched_dirs: list[str] = []
    is_wsl: bool = False


def _is_wsl() -> bool:
    """Detect if running inside Windows Subsystem for Linux."""
    try:
        return "microsoft" in Path("/proc/version").read_text().lower()
    except (OSError, PermissionError):
        return False


def _wsl_win_home() -> Path | None:
    """Resolve the Windows-side user home from WSL (e.g. /mnt/c/Users/alice)."""
    # Try WSLENV-forwarded USERPROFILE first
    winprofile = os.environ.get("USERPROFILE")
    if winprofile:
        # Convert Windows path → WSL mount (C:\Users\x → /mnt/c/Users/x)
        winprofile = winprofile.replace("\\", "/")
        if len(winprofile) >= 3 and winprofile[1] == ":":
            drive = winprofile[0].lower()
            wsl_path = Path(f"/mnt/{drive}{winprofile[2:]}")
            if wsl_path.is_dir():
                return wsl_path

    # Try wslpath to resolve Windows USERPROFILE
    try:
        import subprocess
        result = subprocess.run(
            ["wslpath", "-u", subprocess.check_output(
                ["cmd.exe", "/C", "echo", "%USERPROFILE%"],
                stderr=subprocess.DEVNULL, text=True,
            ).strip()],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            wsl_path = Path(result.stdout.strip())
            if wsl_path.is_dir():
                return wsl_path
    except (OSError, subprocess.SubprocessError):
        pass

    # Fallback: scan /mnt/c/Users — pick real user dirs (skip system dirs)
    _SYSTEM_USERS = {"Public", "Default", "Default User", "All Users", "desktop.ini"}
    users_dir = Path("/mnt/c/Users")
    if users_dir.is_dir():
        linux_user = os.environ.get("USER", "")
        real_users = [
            child for child in users_dir.iterdir()
            if child.is_dir() and child.name not in _SYSTEM_USERS
        ]
        # Exact match on Linux username
        for user_dir in real_users:
            if user_dir.name.lower() == linux_user.lower():
                return user_dir
        # Single real user — safe to assume it's them
        if len(real_users) == 1:
            return real_users[0]
        # Multiple users — check which has an NTUSER.DAT (active profile)
        for user_dir in real_users:
            if (user_dir / "NTUSER.DAT").exists():
                return user_dir
    return None


def _add_windows_paths(paths: list[tuple[Path, str]], win_home: Path) -> None:
    """Add standard Windows skill directories given a user home path."""
    # Dotfile locations (work on all OS)
    paths.append((win_home / ".openclaw" / "skills", "openclaw"))
    paths.append((win_home / ".mcp" / "skills", "mcp"))
    paths.append((win_home / ".claude" / "skills", "claude"))
    # AppData\Roaming (standard Windows app data)
    appdata = win_home / "AppData" / "Roaming"
    paths.append((appdata / "OpenClaw" / "skills", "openclaw"))
    paths.append((appdata / "Claude" / "skills", "claude"))
    # AppData\Local
    localappdata = win_home / "AppData" / "Local"
    paths.append((localappdata / "OpenClaw" / "skills", "openclaw"))


def _get_skill_search_paths() -> list[tuple[Path, str]]:
    """Return platform-aware skill search directories with source labels."""
    home = Path.home()
    system = platform.system()
    wsl = system == "Linux" and _is_wsl()
    paths: list[tuple[Path, str]] = []

    if system == "Windows":
        # Native Windows — use env vars for accurate AppData paths
        appdata = Path(os.environ.get("APPDATA", home / "AppData" / "Roaming"))
        localappdata = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local"))
        paths.append((home / ".openclaw" / "skills", "openclaw"))
        paths.append((home / ".mcp" / "skills", "mcp"))
        paths.append((home / ".claude" / "skills", "claude"))
        paths.append((appdata / "OpenClaw" / "skills", "openclaw"))
        paths.append((appdata / "Claude" / "skills", "claude"))
        paths.append((localappdata / "OpenClaw" / "skills", "openclaw"))
    elif system == "Darwin":
        # macOS
        paths.append((home / ".openclaw" / "skills", "openclaw"))
        paths.append((home / ".mcp" / "skills", "mcp"))
        paths.append((home / ".claude" / "skills", "claude"))
        paths.append((home / "Library" / "Application Support" / "OpenClaw" / "skills", "openclaw"))
        paths.append((home / "Library" / "Application Support" / "Claude" / "skills", "claude"))
        paths.append((home / ".config" / "openclaw" / "skills", "openclaw"))
    else:
        # Linux / BSD — WSL linux-side paths
        paths.append((home / ".openclaw" / "skills", "openclaw"))
        paths.append((home / ".mcp" / "skills", "mcp"))
        paths.append((home / ".claude" / "skills", "claude"))
        paths.append((home / ".config" / "openclaw" / "skills", "openclaw"))
        paths.append((home / ".config" / "mcp" / "skills", "mcp"))
        paths.append((home / ".local" / "share" / "openclaw" / "skills", "openclaw"))

        if wsl:
            # WSL: also search Windows-side user home via /mnt/
            win_home = _wsl_win_home()
            if win_home:
                _add_windows_paths(paths, win_home)

    # Android (Termux)
    try:
        termux_home = Path(os.environ.get("PREFIX", "/data/data/com.termux/files/usr")).parent / "home"
        if termux_home.is_dir() and termux_home != home:
            paths.append((termux_home / ".openclaw" / "skills", "openclaw"))
    except (PermissionError, OSError):
        pass

    # iOS (iSH / a-Shell)
    try:
        ish_docs = Path("/root/Documents")
        if system != "Windows" and ish_docs.is_dir():
            paths.append((ish_docs / ".openclaw" / "skills", "openclaw"))
    except (PermissionError, OSError):
        pass

    return paths


@router.get("/skill-scans/discover", response_model=DiscoverResponse)
async def discover_skills():
    """Discover skill directories from all known platform-specific locations."""
    primary_dir = Path.home() / ".openclaw" / "skills"
    search_paths = _get_skill_search_paths()
    wsl = platform.system() == "Linux" and _is_wsl()

    # Deduplicate searched dirs for display
    seen_dirs: set[str] = set()
    searched_dirs: list[str] = []
    for skills_dir, _ in search_paths:
        dir_str = str(skills_dir)
        if dir_str not in seen_dirs:
            seen_dirs.add(dir_str)
            searched_dirs.append(dir_str)

    skills: list[DiscoveredSkill] = []
    seen_paths: set[str] = set()

    for skills_dir, source in search_paths:
        if not skills_dir.is_dir():
            continue
        for child in sorted(skills_dir.iterdir()):
            if child.is_dir() and not child.name.startswith("."):
                resolved = str(child.resolve())
                if resolved not in seen_paths:
                    seen_paths.add(resolved)
                    skills.append(DiscoveredSkill(
                        name=child.name,
                        path=str(child),
                        source=source,
                    ))

    return DiscoverResponse(
        skills_dir=str(primary_dir),
        skills=skills,
        searched_dirs=searched_dirs,
        is_wsl=wsl,
    )


@router.post("/skill-scans/scan", response_model=MultiScanResponse)
async def trigger_scan(request: ScanRequest):
    """Scan one or more skill directories concurrently and persist all results."""
    db = get_database()
    scanner = SkillScannerService(db)
    repo = SkillScansRepository(db)

    openclaw_skills_dir = Path("~/.openclaw/skills").expanduser().resolve()

    # Allowlist of safe parent directories for scanning
    _SAFE_HOME = os.path.realpath(os.path.expanduser("~"))
    _SAFE_TMP = os.path.realpath(tempfile.gettempdir())

    def _is_under_allowed_root(resolved: str) -> bool:
        """Return True if *resolved* (already os.path.realpath'd) is under $HOME or $TMPDIR."""
        if resolved.startswith(_SAFE_HOME + os.sep) or resolved == _SAFE_HOME:
            return True
        if resolved.startswith(_SAFE_TMP + os.sep) or resolved == _SAFE_TMP:
            return True
        return False

    async def _scan_one(path: str) -> ScanResultItem:  # noqa: C901
        # Sanitise user-supplied path before any filesystem access.
        sanitised = os.path.realpath(os.path.expanduser(path))

        # Allowlist guard — must be under home or temp.
        if not _is_under_allowed_root(sanitised):
            return ScanResultItem(
                path=path, success=False,
                error="Path must be under your home directory or temp directory",
            )

        # Double-check against blocked system paths
        for blocked in _BLOCKED_SYSTEM_PATHS:
            if sanitised == blocked or sanitised.startswith(blocked + "/"):
                return ScanResultItem(path=path, success=False, error=f"Scanning '{sanitised}' is not allowed")

        # Path is validated — safe to access filesystem.
        if not os.path.exists(sanitised) or not os.path.isdir(sanitised):
            return ScanResultItem(path=path, success=False, error=f"Path not found or not a directory: {path}")

        # Warn if path is outside the standard OpenClaw skills directory
        warning = None
        if not sanitised.startswith(str(openclaw_skills_dir)):
            warning = (
                "This path is outside the standard OpenClaw skills directory "
                f"({openclaw_skills_dir}). Verify the source before installing."
            )

        try:
            result = await scanner.scan(sanitised, invocation_source="ui")
        except ValueError as exc:
            return ScanResultItem(path=path, success=False, error=str(exc))
        except Exception as exc:
            logger.exception("Skill scan failed for %s", path)
            return ScanResultItem(path=path, success=False, error=f"Scan failed: {exc}")

        # AI review — runs if LLM is enabled, silently skips otherwise
        ai_summary = None
        try:
            result = await scanner.ai_review_findings(result)
            if result.ai_reviewed:
                ai_summary = AIReviewSummary(
                    reviewed=True,
                    false_positives=result.ai_false_positives,
                    ai_risk_level=result.ai_risk_level,
                    ai_assessment=result.ai_assessment,
                    model_used=result.ai_model_used,
                    tokens_used=result.ai_tokens_used,
                )
        except Exception:
            logger.debug("AI review skipped", exc_info=True)

        record = ScanRecord(
            id=result.id,
            scanned_path=result.scanned_path,
            skill_name=result.skill_name,
            scan_timestamp=result.scan_timestamp,
            invocation_source="ui",
            risk_level=result.ai_risk_level if result.ai_reviewed else result.risk_level,
            findings_count=result.findings_count,
            findings_json=result.findings_json_str(),
            manifest_present=1 if result.manifest_present else 0,
        )
        await repo.insert_scan(record)

        # Run policy evaluation inline (minimal friction — automatic)
        policy_summary = None
        try:
            engine = PolicyEngine(db)
            findings_dicts = [
                {"category": f.category, "excerpt": f.excerpt, "severity": f.severity,
                 "file_path": f.file_path, "line_number": f.line_number, "rule_id": f.rule_id}
                for f in result.findings
            ]
            decision = await engine.evaluate(findings_dicts, publisher_name=result.skill_name)
            policy_summary = PolicySummary(
                action=decision.action,
                risk_score=decision.risk_score,
                safe_count=decision.safe_count,
                review_count=decision.review_count,
                dangerous_count=decision.dangerous_count,
                unknown_count=decision.unknown_count,
                trusted_publisher=decision.trusted_publisher,
            )
        except Exception:
            logger.debug("Policy evaluation skipped (tables may not exist yet)", exc_info=True)

        return ScanResultItem(
            path=path, success=True, result=_record_to_detail(record),
            policy=policy_summary, ai_review=ai_summary, warning=warning,
        )

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


# ---------------------------------------------------------------------------
# Scan from URL
# ---------------------------------------------------------------------------

class ScanUrlRequest(BaseModel):
    url: str = Field(..., max_length=2048, description="GitHub repo, archive, or npm package URL")


class ScanUrlResponse(BaseModel):
    success: bool
    skill_name: str | None = None
    url_type: str | None = None
    source_url: str | None = None
    temp_path: str | None = None
    result: ScanRecordDetail | None = None
    policy: PolicySummary | None = None
    ai_review: AIReviewSummary | None = None
    error: str | None = None


class InstallSkillRequest(BaseModel):
    source_path: str = Field(..., description="Temp directory from scan-url result")
    skill_name: str = Field(..., max_length=100, description="Skill name for installation")


class InstallSkillResponse(BaseModel):
    installed: bool
    install_path: str


@router.post("/skill-scans/scan-url", response_model=ScanUrlResponse)
async def scan_from_url(request: ScanUrlRequest):
    """Download a skill from URL, scan it, and return results with policy decision."""
    from securevector.app.services.url_skill_fetcher import UrlSkillFetcher, UrlFetchError

    fetcher = UrlSkillFetcher()

    # Cleanup stale temp dirs from previous runs
    fetcher.cleanup_stale()

    try:
        fetch_result = await fetcher.fetch(request.url)
    except UrlFetchError as e:
        return ScanUrlResponse(success=False, error=str(e))
    except Exception as e:
        logger.exception("URL fetch failed for %s", request.url)
        return ScanUrlResponse(success=False, error=f"Fetch failed: {e}")

    # Scan the downloaded skill
    db = get_database()
    scanner = SkillScannerService(db)
    repo = SkillScansRepository(db)

    try:
        result = await scanner.scan(fetch_result.temp_dir, invocation_source="ui")
    except Exception as e:
        fetcher.cleanup(fetch_result.temp_dir)
        logger.exception("Scan failed for URL %s", request.url)
        return ScanUrlResponse(success=False, error=f"Scan failed: {e}")

    # AI review — runs if LLM is enabled, silently skips otherwise
    ai_summary = None
    try:
        result = await scanner.ai_review_findings(result)
        if result.ai_reviewed:
            ai_summary = AIReviewSummary(
                reviewed=True,
                false_positives=result.ai_false_positives,
                ai_risk_level=result.ai_risk_level,
                ai_assessment=result.ai_assessment,
                model_used=result.ai_model_used,
                tokens_used=result.ai_tokens_used,
            )
    except Exception:
        logger.debug("AI review skipped for URL scan", exc_info=True)

    # Persist scan record
    record = ScanRecord(
        id=result.id,
        scanned_path=request.url,  # Store URL as path for history display
        skill_name=result.skill_name,
        scan_timestamp=result.scan_timestamp,
        invocation_source="ui",
        risk_level=result.ai_risk_level if result.ai_reviewed else result.risk_level,
        findings_count=result.findings_count,
        findings_json=result.findings_json_str(),
        manifest_present=1 if result.manifest_present else 0,
    )
    await repo.insert_scan(record)

    # Policy evaluation
    policy_summary = None
    try:
        engine = PolicyEngine(db)
        findings_dicts = [
            {"category": f.category, "excerpt": f.excerpt, "severity": f.severity,
             "file_path": f.file_path, "line_number": f.line_number, "rule_id": f.rule_id}
            for f in result.findings
        ]
        decision = await engine.evaluate(findings_dicts, publisher_name=result.skill_name)
        policy_summary = PolicySummary(
            action=decision.action,
            risk_score=decision.risk_score,
            safe_count=decision.safe_count,
            review_count=decision.review_count,
            dangerous_count=decision.dangerous_count,
            unknown_count=decision.unknown_count,
            trusted_publisher=decision.trusted_publisher,
        )
    except Exception:
        logger.debug("Policy evaluation skipped for URL scan", exc_info=True)

    return ScanUrlResponse(
        success=True,
        skill_name=fetch_result.skill_name,
        url_type=fetch_result.url_type,
        source_url=fetch_result.source_url,
        temp_path=fetch_result.temp_dir,
        result=_record_to_detail(record),
        policy=policy_summary,
        ai_review=ai_summary,
    )


@router.post("/skill-scans/install", response_model=InstallSkillResponse)
async def install_skill_from_temp(request: InstallSkillRequest):
    """Install a scanned skill from temp directory to ~/.openclaw/skills/."""
    from securevector.app.services.url_skill_fetcher import install_skill, UrlFetchError

    # Security: source must be under system temp dir.
    # os.path.realpath is used as a CodeQL-recognised path sanitiser.
    sanitised_source = os.path.realpath(request.source_path)
    source = Path(sanitised_source)
    try:
        source.relative_to(Path(tempfile.gettempdir()).resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="Source path must be in the system temp directory")

    try:
        install_path = install_skill(sanitised_source, request.skill_name)
    except UrlFetchError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return InstallSkillResponse(installed=True, install_path=install_path)
