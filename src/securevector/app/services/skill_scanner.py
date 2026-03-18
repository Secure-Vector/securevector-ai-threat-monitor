"""
Skill Scanner Service — OpenClaw Skill Scanner.

Performs static analysis on a skill directory before install.
Seven static detection categories:
  1. Outbound network calls to undeclared domains
  2. Environment variable reads (credential harvest pattern)
  3. Dynamic shell execution (injection risk)
  4. Code execution via eval/exec
  5. Dynamic/obfuscated imports
  6. File writes outside declared scope
  7. Base64-encoded string literals (obfuscation signal)

When AI analysis is enabled (Settings → AI / LLM), an LLM reviews
all findings in context and marks false positives automatically.

All analysis is static — no code is executed.
"""

import json
import logging
import os
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
    r"[\"'](?P<b64>[A-Za-z0-9+/]{40,}={0,2})[\"']"
)

# Safe environment variables — reading these is not a credential-harvest signal
_SAFE_ENV_VARS = {
    "PATH", "HOME", "USER", "LANG", "TERM", "SHELL", "EDITOR",
    "TMPDIR", "TMP", "TEMP", "PWD", "OLDPWD", "HOSTNAME", "LOGNAME",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
    "LC_ALL", "LC_CTYPE", "DISPLAY", "COLORTERM", "COLUMNS", "LINES",
    "NODE_ENV", "PYTHONPATH", "VIRTUAL_ENV", "CONDA_DEFAULT_ENV",
}

# Env iteration patterns — filtering/copying env is not suspicious
_RE_ENV_ITERATION = re.compile(
    r"os\.environ\.(?:items|keys|values|copy)\s*\(",
    re.IGNORECASE,
)

# Known safe commands for subprocess calls
_SAFE_COMMANDS = {
    "claude", "git", "npm", "npx", "node", "python", "python3",
    "pip", "pip3", "uv", "ruff", "black", "pytest", "cargo", "go",
    "yarn", "pnpm", "bun", "deno", "tsc", "eslint", "prettier",
}

# Safe file write targets — extensions that are non-executable output
_SAFE_WRITE_EXTENSIONS = {".json", ".html", ".txt", ".log", ".csv", ".md", ".xml", ".yaml", ".yml"}


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

    ai_verdict: str = ""          # "false_positive", "confirmed", or "" (not reviewed)
    ai_explanation: str = ""       # AI reasoning for the verdict

    def to_dict(self) -> dict:
        d = {
            "file_path": self.file_path,
            "line_number": self.line_number,
            "category": self.category,
            "excerpt": self.excerpt[:200],
            "severity": self.severity,
            "rule_id": self.rule_id,
        }
        if self.ai_verdict:
            d["ai_verdict"] = self.ai_verdict
            d["ai_explanation"] = self.ai_explanation
        return d


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

    ai_reviewed: bool = False
    ai_risk_level: str = ""          # AI-adjusted risk level (may differ from static)
    ai_false_positives: int = 0      # Number of findings AI marked as false positive
    ai_assessment: str = ""          # AI overall assessment of the skill
    ai_model_used: str = ""
    ai_tokens_used: int = 0

    @property
    def findings_count(self) -> int:
        return len(self.findings)

    @property
    def confirmed_findings(self) -> list:
        """Findings that AI did not mark as false positive."""
        if not self.ai_reviewed:
            return self.findings
        return [f for f in self.findings if f.ai_verdict != "false_positive"]

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
        # Sanitise with os.path.realpath so CodeQL recognises the flow.
        sanitised = os.path.realpath(os.path.expanduser(path))

        # Path restriction — reject system roots
        for blocked in _BLOCKED_SYSTEM_PATHS:
            if sanitised == blocked or sanitised.startswith(blocked + "/"):
                raise ValueError(f"Scanning system path is not allowed: {path}")

        if not os.path.exists(sanitised):
            raise ValueError(f"Path not found: {path}")
        if not os.path.isdir(sanitised):
            raise ValueError(f"Path is not a directory: {path}")

        skill_dir = Path(sanitised)

        skill_name = skill_dir.name
        scan_id = str(uuid.uuid4())
        scan_timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")

        manifest = self._load_manifest(skill_dir)
        findings = []

        # Only flag missing manifest for OpenClaw skill directories
        openclaw_skills_dir = Path("~/.openclaw/skills").expanduser().resolve()
        is_openclaw_skill = str(skill_dir).startswith(str(openclaw_skills_dir))

        if manifest is None and is_openclaw_skill:
            manifest_path = str(skill_dir / "permissions.yml")
            findings.append(Finding(
                file_path=manifest_path,
                line_number=0,
                category="missing_manifest",
                excerpt=f"No permissions manifest found. Create {manifest_path} to declare network, file, and env_var access.",
                severity="info",
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
            # Rule library intentionally excluded — community rules are
            # designed for LLM prompt/response text, not source code.
            # AI review (if enabled) provides context-aware analysis instead.

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

            # Downgrade: env iteration (os.environ.items/keys/copy) is config, not harvest
            severity = "medium"
            if _RE_ENV_ITERATION.search(excerpt):
                severity = "low"
            else:
                # Check if accessing a known-safe env var
                var_match = re.search(r"""(?:environ\s*\[\s*[\"']|getenv\s*\(\s*[\"']|process\.env\.)([A-Z_a-z]\w*)""", excerpt)
                if var_match and var_match.group(1) in _SAFE_ENV_VARS:
                    severity = "low"

            findings.append(Finding(
                file_path=rel_path,
                line_number=line_no,
                category="env_var_read",
                excerpt=excerpt,
                severity=severity,
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
            has_dynamic = _RE_DYNAMIC_ARG.search(line_text)

            # Check if the command target is a known safe tool
            uses_safe_cmd = self._line_invokes_safe_command(line_text)

            if uses_safe_cmd:
                severity = "low"
            elif has_dynamic:
                severity = "high"
            else:
                severity = "low"

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

    @staticmethod
    def _line_invokes_safe_command(line_text: str) -> bool:
        """Check if a subprocess call line targets a known safe command."""
        # Check quoted command: "claude", 'git', etc.
        cmd_match = re.search(r"""[\"'](\w[\w-]*)[\"']""", line_text)
        if cmd_match and cmd_match.group(1) in _SAFE_COMMANDS:
            return True
        # Check list-style args: ["claude", ...] or ["git", ...]
        list_match = re.search(r"""\[\s*[\"'](\w[\w-]*)[\"']""", line_text)
        if list_match and list_match.group(1) in _SAFE_COMMANDS:
            return True
        return False

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
            path_arg = self._extract_file_path_arg(match.group(0))
            if allowed_prefixes and path_arg:
                if any(
                    path_arg.startswith(prefix) or path_arg.startswith(prefix.lstrip("./"))
                    for prefix in allowed_prefixes
                ):
                    continue

            # Downgrade severity for safe write patterns:
            # - relative paths (within skill dir) writing safe extensions
            # - variable-based paths writing to safe extensions (.json, .html, etc.)
            severity = "high"
            if path_arg:
                ext = Path(path_arg).suffix.lower() if "." in path_arg else ""
                is_absolute = path_arg.startswith("/") or path_arg.startswith("~")
                if not is_absolute and ext in _SAFE_WRITE_EXTENSIONS:
                    severity = "low"
                elif ext in _SAFE_WRITE_EXTENSIONS:
                    severity = "medium"
            else:
                # No literal path arg (variable-based) — check the line for safe extensions
                ext_match = re.search(r"""[\"'][\w./\\-]+(\.\w+)[\"']""", excerpt)
                if ext_match and ext_match.group(1).lower() in _SAFE_WRITE_EXTENSIONS:
                    severity = "low"

            findings.append(Finding(
                file_path=rel_path,
                line_number=line_no,
                category="file_write",
                excerpt=excerpt,
                severity=severity,
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
            # Only apply input-direction rules — output rules (credential
            # leak, PII leak) are designed for LLM response text, not code.
            result = await self._analysis_service.analyze(text, direction="input")
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

            # The community rule library was designed for prompt/text
            # threat detection, not source code. Downgrade severity when
            # the matched line is clearly benign code (arithmetic, variable
            # access, standard API calls) rather than a real threat pattern.
            if self._is_benign_code_line(excerpt):
                severity = "low"

            findings.append(Finding(
                file_path=rel_path,
                line_number=line_no,
                category="rule_match",
                excerpt=excerpt,
                severity=severity,
                rule_id=rule.get("id", "rule_library"),
            ))
        return findings

    @staticmethod
    def _is_benign_code_line(excerpt: str) -> bool:
        """Check if a rule_match excerpt is clearly benign source code.

        The community rule library targets prompt injection and social
        engineering text. When applied to source files, it often matches
        innocent arithmetic, variable assignments, or standard API calls.
        """
        if not excerpt:
            return False
        # Pure arithmetic / array indexing: e.g. "1 - t", "bbox[2] - bbox[0]"
        if re.match(r'^(?:return\s+)?[\w.\[\]()]+\s*[-+*/]\s*[\w.\[\]()]+$', excerpt):
            return True
        # Numpy/Pillow/common library calls with arithmetic args
        if re.match(r'^[\w.]+\s*=\s*[\w.]+\(.*\)$', excerpt) and 'eval' not in excerpt and 'exec' not in excerpt:
            return True
        # Variable assignment with dict/attribute access: e.g. img.info.get("duration", 100)
        if re.match(r'^[\w.]+\s*=\s*[\w.]+\.(?:get|info|shape|size|dtype)\b', excerpt):
            return True
        # Padding/zeros/ones array creation
        if 'np.zeros' in excerpt or 'np.ones' in excerpt or 'np.empty' in excerpt:
            return True
        return False

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

    # -----------------------------------------------------------------------
    # AI-powered false-positive review
    # -----------------------------------------------------------------------

    async def ai_review_findings(self, scan_result: ScanResult) -> ScanResult:
        """Use the configured LLM to review findings and mark false positives.

        Reads LLM settings from the database. If LLM is not enabled or there
        are no findings to review, returns the scan result unchanged.
        """
        if not scan_result.findings:
            return scan_result

        try:
            from securevector.app.database.repositories.settings import SettingsRepository
            from securevector.app.services.llm_review import LLMConfig, LLMReviewService

            settings_repo = SettingsRepository(self.db)
            settings = await settings_repo.get()
            llm_settings = settings.llm_settings or {}

            if not llm_settings.get("enabled"):
                return scan_result

            provider = llm_settings.get("provider", "ollama")
            api_key = llm_settings.get("api_key") or ""

            # Cloud providers require an API key — skip if missing
            if provider in ("openai", "anthropic", "azure") and not api_key:
                logger.debug("AI review skipped: %s provider requires an API key", provider)
                return scan_result

            config = LLMConfig(
                enabled=True,
                provider=provider,
                model=llm_settings.get("model", "llama3"),
                endpoint=llm_settings.get("endpoint", "http://localhost:11434"),
                api_key=api_key,
                api_secret=llm_settings.get("api_secret") or "",
                aws_region=llm_settings.get("aws_region", "us-east-1"),
                timeout=llm_settings.get("timeout", 60),
                max_tokens=llm_settings.get("max_tokens", 2048),
                temperature=0.1,
            )
            llm_service = LLMReviewService(config)
        except Exception as exc:
            logger.debug("AI review unavailable: %s", exc)
            return scan_result

        # Build a concise prompt with all findings for batch review
        prompt = self._build_ai_review_prompt(scan_result)

        try:
            response, tokens_used = await self._call_llm_for_review(llm_service, prompt)
            verdicts, overall_assessment = self._parse_ai_review_response(response)

            false_positive_count = 0
            for i, finding in enumerate(scan_result.findings):
                key = f"{i}"
                verdict = verdicts.get(key, {})
                if verdict.get("verdict") == "false_positive":
                    finding.ai_verdict = "false_positive"
                    finding.ai_explanation = verdict.get("reason", "")
                    false_positive_count += 1
                elif verdict.get("verdict") == "confirmed":
                    finding.ai_verdict = "confirmed"
                    finding.ai_explanation = verdict.get("reason", "")
                else:
                    finding.ai_verdict = "confirmed"

            scan_result.ai_reviewed = True
            scan_result.ai_false_positives = false_positive_count
            scan_result.ai_assessment = overall_assessment
            scan_result.ai_model_used = config.model
            scan_result.ai_tokens_used = tokens_used

            # Recompute risk level using only confirmed findings
            scan_result.ai_risk_level = self._compute_risk_level(scan_result.confirmed_findings)

            await llm_service.close()
        except Exception as exc:
            logger.warning("AI review failed: %s", exc)

        return scan_result

    def _build_ai_review_prompt(self, scan_result: ScanResult) -> str:
        """Build a prompt for the LLM to review all findings at once."""
        findings_text = []
        for i, f in enumerate(scan_result.findings):
            findings_text.append(
                f"[{i}] {f.severity.upper()} | {f.category} | {f.file_path}:{f.line_number}\n"
                f"    Code: {f.excerpt[:150]}"
            )

        return f"""You are a security analyst reviewing static analysis findings from a skill/plugin scanner.
The skill "{scan_result.skill_name}" was scanned from: {scan_result.scanned_path}

FINDINGS TO REVIEW:
{chr(10).join(findings_text)}

For each finding, determine if it is a TRUE POSITIVE (genuine security concern) or FALSE POSITIVE (benign/expected behavior).

Common false positives to watch for:
- subprocess calls to well-known dev tools (claude, git, npm, python, pip, pytest, cargo)
- File writes to the skill's own directory for reports/logs/output (.json, .html, .txt, .log)
- os.environ reads for standard config vars (PATH, HOME, NODE_ENV) or env filtering (os.environ.items())
- Base64 usage for legitimate data encoding (not obfuscation)
- Network calls to well-known APIs matching the skill's stated purpose
- eval/exec used for legitimate metaprogramming (e.g., dynamic test generation)

Respond in JSON format ONLY:
{{
  "findings": {{
    "0": {{"verdict": "false_positive" or "confirmed", "reason": "brief explanation"}},
    "1": {{"verdict": "false_positive" or "confirmed", "reason": "brief explanation"}},
    ...
  }},
  "overall_assessment": "one-line summary of the skill's actual risk"
}}"""

    async def _call_llm_for_review(self, llm_service, prompt: str) -> tuple:
        """Call the LLM using the appropriate provider method."""
        from securevector.app.services.llm_review import LLMProvider

        provider = LLMProvider(llm_service.config.provider.lower())
        method_map = {
            LLMProvider.OLLAMA: llm_service._call_ollama,
            LLMProvider.OPENAI: llm_service._call_openai,
            LLMProvider.ANTHROPIC: llm_service._call_anthropic,
            LLMProvider.AZURE: llm_service._call_azure,
            LLMProvider.BEDROCK: llm_service._call_bedrock,
            LLMProvider.CUSTOM: llm_service._call_custom,
        }
        call_fn = method_map.get(provider)
        if not call_fn:
            raise ValueError(f"Unknown LLM provider: {provider}")
        return await call_fn(prompt)

    @staticmethod
    def _parse_ai_review_response(response: str) -> tuple:
        """Parse the LLM's JSON response into (findings_dict, overall_assessment)."""
        try:
            # Handle markdown code blocks
            text = response
            if "```json" in text:
                text = text[text.find("```json") + 7:]
                text = text[:text.find("```")]
            elif "```" in text:
                text = text[text.find("```") + 3:]
                text = text[:text.find("```")]

            start = text.find("{")
            end = text.rfind("}") + 1
            if start >= 0 and end > start:
                data = json.loads(text[start:end])
                return data.get("findings", {}), data.get("overall_assessment", "")
        except (json.JSONDecodeError, KeyError) as exc:
            logger.debug("Failed to parse AI review response: %s", exc)
        return {}, ""
