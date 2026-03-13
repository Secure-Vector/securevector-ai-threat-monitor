"""
Skill Scanner Service — OpenClaw Skill Scanner.

Performs static analysis on a skill directory before install.
Eight detection categories:
  1. Outbound network calls to undeclared domains
  2. Environment variable reads (credential harvest pattern)
  3. Dynamic shell execution (injection risk)
  4. Code execution via eval/exec
  5. Dynamic/obfuscated imports
  6. File writes outside declared scope
  7. Base64-encoded string literals (obfuscation signal)
  8. Matches from the existing SecureVector community rule library

All analysis is static — no code is executed.
"""

import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import yaml

from securevector.app.database.connection import DatabaseConnection

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Scan limits
# ---------------------------------------------------------------------------
MAX_FILES = 500
MAX_FILE_SIZE_BYTES = 1_000_000  # 1 MB

# ---------------------------------------------------------------------------
# Source file extensions scanned / skipped
# ---------------------------------------------------------------------------
SCANNABLE_EXTENSIONS = {".py", ".js", ".mjs", ".cjs", ".ts", ".sh", ".bash"}
BINARY_EXTENSIONS = {".pyc", ".so", ".dll", ".whl", ".egg", ".class", ".pyd", ".exe"}

# ---------------------------------------------------------------------------
# Blocked system path prefixes (path restriction)
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
# Compiled regex patterns
# ---------------------------------------------------------------------------

# Network calls — Python + JS
_RE_NETWORK = re.compile(
    r"(?:requests|httpx)\s*\.\s*(?:get|post|put|delete|patch|head|options)\s*\(\s*"
    r"(?:[\"'](?P<url_py>[^\"'\n]+)[\"'])"
    r"|urllib\.request\.urlopen\s*\(\s*[\"'](?P<url_urllib>[^\"'\n]+)[\"']"
    r"|fetch\s*\(\s*[\"'`](?P<url_fetch>[^\"'`\n]+)[\"'`]"
    r"|axios\s*\.\s*(?:get|post|put|delete|patch)\s*\(\s*[\"'`](?P<url_axios>[^\"'`\n]+)[\"'`]",
    re.IGNORECASE,
)

# Env var reads
_RE_ENV = re.compile(
    r"os\.environ\s*[\[.]"
    r"|os\.getenv\s*\("
    r"|process\.env\.[A-Z_a-z]"
    r"|getenv\s*\(",
    re.IGNORECASE,
)

# Shell execution calls — subprocess and os.system/os.popen only
_RE_SHELL_CALL = re.compile(
    r"subprocess\s*\.\s*(?:run|Popen|call|check_output|check_call)\s*\("
    r"|os\s*\.\s*(?:system|popen)\s*\(",
    re.IGNORECASE,
)
_RE_DYNAMIC_ARG = re.compile(r'[+]|f["\']|\$\{|%\s*[a-zA-Z]|\.format\s*\(')

# Code execution via eval/exec (separate from shell_exec)
_RE_CODE_EXEC = re.compile(
    r"\beval\s*\("
    r"|\bexec\s*\(",
    re.IGNORECASE,
)

# Dynamic / obfuscated imports
_RE_DYNAMIC_IMPORT = re.compile(
    r"__import__\s*\("
    r"|importlib\s*\.\s*import_module\s*\("
    r"|getattr\s*\([^)]+,\s*[\"'](?:get|post|run|system|popen|environ|exec|eval)[\"']",
    re.IGNORECASE,
)

# File writes
_RE_FILE_WRITE = re.compile(
    r"open\s*\([^)]+,\s*[\"'][wa+][\"']"
    r"|open\s*\([^)]+,\s*[\"']r\+[\"']"
    r"|Path\s*\([^)]*\)\s*\.\s*(?:write_text|write_bytes)\s*\("
    r"|fs\s*\.\s*(?:writeFile|appendFile|writeFileSync|appendFileSync)\s*\(",
    re.IGNORECASE,
)

# Base64 usage
_RE_BASE64_CALL = re.compile(
    r"base64\s*\.\s*(?:b64decode|b64encode|encodebytes|decodebytes)\s*\("
    r"|\batob\s*\("
    r"|\bbtoa\s*\(",
    re.IGNORECASE,
)
_RE_BASE64_LITERAL = re.compile(
    r"[\"'](?P<b64>[A-Za-z0-9+/]{20,}={0,2})[\"']"
)


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class Finding:
    """A single static analysis finding."""

    file_path: str
    line_number: int
    category: str
    excerpt: str
    severity: str
    rule_id: str

    def to_dict(self) -> dict:
        return {
            "file_path": self.file_path,
            "line_number": self.line_number,
            "category": self.category,
            "excerpt": self.excerpt[:200],
            "severity": self.severity,
            "rule_id": self.rule_id,
        }


@dataclass
class PermissionsManifest:
    """Parsed skill permissions manifest."""

    networks: frozenset
    files: list
    env_vars: frozenset
    source_file: str


@dataclass
class ScanResult:
    """Result of a complete skill scan."""

    id: str
    scanned_path: str
    skill_name: str
    scan_timestamp: str
    invocation_source: str
    risk_level: str
    findings: list = field(default_factory=list)
    manifest_present: bool = False

    @property
    def findings_count(self) -> int:
        return len(self.findings)

    def findings_json_str(self) -> str:
        return json.dumps([f.to_dict() for f in self.findings])


# ---------------------------------------------------------------------------
# SkillScannerService
# ---------------------------------------------------------------------------

class SkillScannerService:
    """Static analysis scanner for OpenClaw skill directories."""

    def __init__(self, db: DatabaseConnection):
        self.db = db
        self._analysis_service = None

    async def scan(self, path: str, invocation_source: str = "ui") -> ScanResult:
        """Scan a skill directory and return a ScanResult."""
        skill_dir = Path(path).expanduser().resolve()

        # Path restriction — reject system roots
        path_str = str(skill_dir)
        for blocked in _BLOCKED_SYSTEM_PATHS:
            if path_str == blocked or path_str.startswith(blocked + "/"):
                raise ValueError(f"Scanning system path is not allowed: {path}")

        if not skill_dir.exists():
            raise ValueError(f"Path not found: {path}")
        if not skill_dir.is_dir():
            raise ValueError(f"Path is not a directory: {path}")

        skill_name = skill_dir.name
        scan_id = str(uuid.uuid4())
        scan_timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")

        await self._ensure_analysis_service()

        manifest = self._load_manifest(skill_dir)
        findings = []

        if manifest is None:
            findings.append(Finding(
                file_path="",
                line_number=0,
                category="missing_manifest",
                excerpt="No permissions manifest found in skill root",
                severity="medium",
                rule_id="scanner.missing_manifest",
            ))

        scanned_file_count = 0

        for file_path in sorted(skill_dir.rglob("*")):
            # a. Symlink escape check FIRST — before is_file() which follows links
            if file_path.is_symlink():
                try:
                    resolved = file_path.resolve()
                    if not str(resolved).startswith(str(skill_dir)):
                        findings.append(Finding(
                            file_path=str(file_path.relative_to(skill_dir)),
                            line_number=0,
                            category="symlink_escape",
                            excerpt=f"Symlink {file_path.name} targets path outside skill directory scope",
                            severity="medium",
                            rule_id="scanner.symlink_escape",
                        ))
                except Exception:
                    pass
                continue  # Never follow symlinks — skip regardless of target

            # b. Skip non-files
            if not file_path.is_file():
                continue

            # c. Binary / compiled file check
            if file_path.suffix in BINARY_EXTENSIONS:
                findings.append(Finding(
                    file_path=str(file_path.relative_to(skill_dir)),
                    line_number=0,
                    category="compiled_code",
                    excerpt=f"Compiled/binary file: {file_path.name}",
                    severity="medium",
                    rule_id="scanner.compiled_code",
                ))
                continue

            # d. Scannable extension check
            if file_path.suffix not in SCANNABLE_EXTENSIONS:
                continue

            # e. File size check
            try:
                if file_path.stat().st_size > MAX_FILE_SIZE_BYTES:
                    logger.debug(
                        "Skipping %s: file size exceeds %d bytes",
                        file_path,
                        MAX_FILE_SIZE_BYTES,
                    )
                    continue
            except Exception as exc:
                logger.debug("Cannot stat %s: %s", file_path, exc)
                continue

            # f. Read and run all detectors
            try:
                text = file_path.read_text(encoding="utf-8", errors="replace")
            except Exception as exc:
                logger.debug("Cannot read %s: %s", file_path, exc)
                continue

            rel_path = str(file_path.relative_to(skill_dir))
            lines = text.splitlines()

            findings.extend(self._detect_network_domains(text, lines, rel_path, manifest))
            findings.extend(self._detect_env_var_reads(text, lines, rel_path))
            findings.extend(self._detect_dynamic_shell_exec(text, lines, rel_path))
            findings.extend(self._detect_code_exec(text, lines, rel_path))
            findings.extend(self._detect_dynamic_imports(text, lines, rel_path))
            findings.extend(self._detect_file_writes(text, lines, rel_path, manifest))
            findings.extend(self._detect_base64(text, lines, rel_path))
            findings.extend(await self._detect_rule_library(text, lines, rel_path))

            scanned_file_count += 1
            if scanned_file_count >= MAX_FILES:
                findings.append(Finding(
                    file_path="",
                    line_number=0,
                    category="scan_limit",
                    excerpt=f"Scan stopped at {MAX_FILES} files — large directory",
                    severity="low",
                    rule_id="scanner.scan_limit",
                ))
                break

        risk_level = self._compute_risk_level(findings)

        return ScanResult(
            id=scan_id,
            scanned_path=str(skill_dir),
            skill_name=skill_name,
            scan_timestamp=scan_timestamp,
            invocation_source=invocation_source,
            risk_level=risk_level,
            findings=findings,
            manifest_present=(manifest is not None),
        )

    # -----------------------------------------------------------------------
    # Manifest parser (T015)
    # -----------------------------------------------------------------------

    def _load_manifest(self, skill_dir: Path) -> Optional[PermissionsManifest]:
        candidates = [
            (skill_dir / "skill.json", "json"),
            (skill_dir / "permissions.yml", "yaml"),
            (skill_dir / "permissions.yaml", "yaml"),
        ]
        for candidate, fmt in candidates:
            if not candidate.exists():
                continue
            try:
                if fmt == "json":
                    import json as _json
                    data = _json.loads(candidate.read_text(encoding="utf-8"))
                    perms = data.get("permissions", {})
                else:
                    raw = yaml.safe_load(candidate.read_text(encoding="utf-8")) or {}
                    perms = raw.get("permissions", {})

                return PermissionsManifest(
                    networks=frozenset(str(n).lower().strip() for n in (perms.get("networks") or [])),
                    files=[str(f) for f in (perms.get("files") or [])],
                    env_vars=frozenset(str(e) for e in (perms.get("env_vars") or [])),
                    source_file=candidate.name,
                )
            except Exception as exc:
                logger.warning("Manifest %s is malformed, treating as absent: %s", candidate.name, exc)
        return None

    # -----------------------------------------------------------------------
    # Detector: Network domain calls (T006, T016)
    # -----------------------------------------------------------------------

    def _detect_network_domains(
        self, text: str, lines: list, rel_path: str, manifest: Optional[PermissionsManifest]
    ) -> list:
        findings = []
        allowed = manifest.networks if manifest else frozenset()
        for match in _RE_NETWORK.finditer(text):
            url = (
                match.group("url_py")
                or match.group("url_urllib")
                or match.group("url_fetch")
                or match.group("url_axios")
            )
            if not url:
                continue
            try:
                parsed = urlparse(url if "://" in url else "https://" + url)
                domain = (parsed.hostname or "").lower()
            except Exception:
                continue
            if not domain or domain in allowed:
                continue
            line_no = text[: match.start()].count("\n") + 1
            excerpt = lines[line_no - 1].strip() if line_no <= len(lines) else url
            findings.append(Finding(
                file_path=rel_path,
                line_number=line_no,
                category="network_domain",
                excerpt=excerpt,
                severity="high",
                rule_id="scanner.network_domain",
            ))
        return findings

    # -----------------------------------------------------------------------
    # Detector: Env var reads (T007)
    # -----------------------------------------------------------------------

    def _detect_env_var_reads(self, text: str, lines: list, rel_path: str) -> list:
        findings = []
        for match in _RE_ENV.finditer(text):
            line_no = text[: match.start()].count("\n") + 1
            excerpt = lines[line_no - 1].strip() if line_no <= len(lines) else match.group(0)
            findings.append(Finding(
                file_path=rel_path,
                line_number=line_no,
                category="env_var_read",
                excerpt=excerpt,
                severity="medium",
                rule_id="scanner.env_var_read",
            ))
        return findings

    # -----------------------------------------------------------------------
    # Detector: Dynamic shell execution (T008) — subprocess/os.system/os.popen
    # -----------------------------------------------------------------------

    def _detect_dynamic_shell_exec(self, text: str, lines: list, rel_path: str) -> list:
        findings = []
        for match in _RE_SHELL_CALL.finditer(text):
            line_no = text[: match.start()].count("\n") + 1
            line_text = lines[line_no - 1] if line_no <= len(lines) else ""
            severity = "high" if _RE_DYNAMIC_ARG.search(line_text) else "low"
            excerpt = line_text.strip()
            findings.append(Finding(
                file_path=rel_path,
                line_number=line_no,
                category="shell_exec",
                excerpt=excerpt,
                severity=severity,
                rule_id="scanner.shell_exec",
            ))
        return findings

    # -----------------------------------------------------------------------
    # Detector: Code execution via eval/exec
    # -----------------------------------------------------------------------

    def _detect_code_exec(self, text: str, lines: list, rel_path: str) -> list:
        findings = []
        for match in _RE_CODE_EXEC.finditer(text):
            line_no = text[: match.start()].count("\n") + 1
            excerpt = lines[line_no - 1].strip() if line_no <= len(lines) else match.group(0)
            findings.append(Finding(
                file_path=rel_path,
                line_number=line_no,
                category="code_exec",
                excerpt=excerpt,
                severity="high",
                rule_id="scanner.code_exec",
            ))
        return findings

    # -----------------------------------------------------------------------
    # Detector: Dynamic / obfuscated imports
    # -----------------------------------------------------------------------

    def _detect_dynamic_imports(self, text: str, lines: list, rel_path: str) -> list:
        findings = []
        for match in _RE_DYNAMIC_IMPORT.finditer(text):
            line_no = text[: match.start()].count("\n") + 1
            excerpt = lines[line_no - 1].strip() if line_no <= len(lines) else match.group(0)
            findings.append(Finding(
                file_path=rel_path,
                line_number=line_no,
                category="dynamic_import",
                excerpt=excerpt,
                severity="high",
                rule_id="scanner.dynamic_import",
            ))
        return findings

    # -----------------------------------------------------------------------
    # Detector: File writes outside declared scope (T010, T017)
    # -----------------------------------------------------------------------

    def _detect_file_writes(
        self, text: str, lines: list, rel_path: str, manifest: Optional[PermissionsManifest]
    ) -> list:
        findings = []
        allowed_prefixes = manifest.files if manifest else []
        for match in _RE_FILE_WRITE.finditer(text):
            line_no = text[: match.start()].count("\n") + 1
            excerpt = lines[line_no - 1].strip() if line_no <= len(lines) else match.group(0)
            # Extract the file path argument from the matched code
            # Only allow if the path argument itself starts with a declared prefix
            if allowed_prefixes:
                path_arg = self._extract_file_path_arg(match.group(0))
                if path_arg and any(
                    path_arg.startswith(prefix) or path_arg.startswith(prefix.lstrip("./"))
                    for prefix in allowed_prefixes
                ):
                    continue
            findings.append(Finding(
                file_path=rel_path,
                line_number=line_no,
                category="file_write",
                excerpt=excerpt,
                severity="high",
                rule_id="scanner.file_write",
            ))
        return findings

    @staticmethod
    def _extract_file_path_arg(match_text: str) -> Optional[str]:
        """Extract the file path string from an open() or Path().write call."""
        # Match the first quoted string argument
        m = re.search(r"""[\"']([^\"']+)[\"']""", match_text)
        return m.group(1) if m else None

    # -----------------------------------------------------------------------
    # Detector: Base64 literals (T009)
    # -----------------------------------------------------------------------

    def _detect_base64(self, text: str, lines: list, rel_path: str) -> list:
        findings = []
        seen: set = set()

        for match in _RE_BASE64_CALL.finditer(text):
            line_no = text[: match.start()].count("\n") + 1
            if line_no in seen:
                continue
            seen.add(line_no)
            excerpt = lines[line_no - 1].strip() if line_no <= len(lines) else match.group(0)
            findings.append(Finding(
                file_path=rel_path,
                line_number=line_no,
                category="base64_literal",
                excerpt=excerpt,
                severity="medium",
                rule_id="scanner.base64_literal",
            ))

        for match in _RE_BASE64_LITERAL.finditer(text):
            line_no = text[: match.start()].count("\n") + 1
            if line_no in seen:
                continue
            seen.add(line_no)
            excerpt = lines[line_no - 1].strip() if line_no <= len(lines) else match.group(0)
            findings.append(Finding(
                file_path=rel_path,
                line_number=line_no,
                category="base64_literal",
                excerpt=excerpt,
                severity="medium",
                rule_id="scanner.base64_literal",
            ))

        return findings

    # -----------------------------------------------------------------------
    # Detector: Existing community rule library (T011)
    # -----------------------------------------------------------------------

    async def _detect_rule_library(self, text: str, lines: list, rel_path: str) -> list:
        if self._analysis_service is None:
            return []
        try:
            result = await self._analysis_service.analyze(text)
        except Exception as exc:
            logger.debug("Rule library analysis failed for %s: %s", rel_path, exc)
            return []

        findings = []
        for rule in result.matched_rules:
            severity = rule.get("severity", "medium").lower()
            if severity not in ("critical", "high", "medium", "low"):
                severity = "medium"
            line_no = 0
            for pattern_str in rule.get("matched_patterns", []):
                try:
                    m = re.search(pattern_str, text, re.IGNORECASE)
                    if m:
                        line_no = text[: m.start()].count("\n") + 1
                        break
                except re.error:
                    pass
            excerpt = lines[line_no - 1].strip() if line_no and line_no <= len(lines) else ""
            findings.append(Finding(
                file_path=rel_path,
                line_number=line_no,
                category="rule_match",
                excerpt=excerpt,
                severity=severity,
                rule_id=rule.get("id", "rule_library"),
            ))
        return findings

    # -----------------------------------------------------------------------
    # Risk level aggregation (T012)
    # -----------------------------------------------------------------------

    def _compute_risk_level(self, findings: list) -> str:
        severities = {f.severity for f in findings}
        if severities & {"critical", "high"}:
            return "HIGH"
        if "medium" in severities:
            return "MEDIUM"
        return "LOW"

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    async def _ensure_analysis_service(self) -> None:
        if self._analysis_service is not None:
            return
        try:
            from securevector.app.services.analysis_service import AnalysisService
            self._analysis_service = AnalysisService(self.db)
            await self._analysis_service.ensure_rules_loaded()
        except Exception as exc:
            logger.warning(
                "Could not load analysis service (rule library checks disabled): %s", exc
            )
            self._analysis_service = None
