"""
Policy Engine for the Skill Scanner.

Takes scan results (findings), applies permission classifications and risk
scoring, and produces an allow / warn / block decision.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.repositories.skill_permissions import (
    SkillPermissionsRepository,
)

logger = logging.getLogger(__name__)


@dataclass
class PolicyFinding:
    """A single finding annotated with policy classification."""
    category: str
    pattern: str
    classification: str | None   # 'safe', 'review', 'dangerous', or None (unknown)
    severity: str
    file_path: str
    line_number: int
    excerpt: str
    weight: int


@dataclass
class PolicyDecision:
    """Result of policy evaluation against a scan."""
    action: str                        # 'allow', 'warn', 'block'
    risk_score: int
    threshold_allow: int
    threshold_warn: int
    total_findings: int
    classified_findings: list[PolicyFinding] = field(default_factory=list)
    safe_count: int = 0
    review_count: int = 0
    dangerous_count: int = 0
    unknown_count: int = 0
    trusted_publisher: bool = False
    publisher_name: str | None = None


class PolicyEngine:
    """Evaluate scan findings against the permission database."""

    def __init__(self, db: DatabaseConnection):
        self.db = db
        self.repo = SkillPermissionsRepository(db)

    async def evaluate(
        self,
        findings: list[dict],
        publisher_name: str | None = None,
    ) -> PolicyDecision:
        """
        Evaluate a list of scan findings against the policy.

        Args:
            findings: List of finding dicts with keys:
                category, excerpt, severity, file_path, line_number, rule_id
            publisher_name: Optional publisher for trusted-publisher shortcut.

        Returns:
            PolicyDecision with action, score, and classified findings.
        """
        config = await self.repo.get_policy_config()

        if not config.policy_enabled:
            return PolicyDecision(
                action="allow",
                risk_score=0,
                threshold_allow=config.threshold_allow,
                threshold_warn=config.threshold_warn,
                total_findings=len(findings),
            )

        # Check trusted publisher
        is_trusted = False
        if publisher_name:
            is_trusted = await self.repo.is_trusted_publisher(publisher_name)

        classified: list[PolicyFinding] = []
        safe_count = 0
        review_count = 0
        dangerous_count = 0
        unknown_count = 0

        for finding in findings:
            category = finding.get("category", "")
            excerpt = finding.get("excerpt", "")
            severity = finding.get("severity", "low")
            file_path = finding.get("file_path", "")
            line_number = finding.get("line_number", 0)

            # Determine the pattern to classify based on category
            pattern_value = self._extract_pattern(category, excerpt)
            classification = await self._classify(category, pattern_value)

            weight = config.risk_weights.get(category, 1)

            cf = PolicyFinding(
                category=category,
                pattern=pattern_value,
                classification=classification,
                severity=severity,
                file_path=file_path,
                line_number=line_number,
                excerpt=excerpt,
                weight=weight,
            )
            classified.append(cf)

            if classification == "safe":
                safe_count += 1
            elif classification == "review":
                review_count += 1
            elif classification == "dangerous":
                dangerous_count += 1
            else:
                unknown_count += 1

        # Calculate risk score: sum weights of non-safe findings
        # Severity multiplier: critical/high = 1.0, medium = 0.6, low = 0.3
        # Unknown boost: unrecognised high/critical patterns are suspicious — double weight
        severity_multiplier = {
            "critical": 1.0,
            "high": 1.0,
            "medium": 0.6,
            "low": 0.3,
        }
        risk_score = 0
        unknown_high_count = 0
        for cf in classified:
            if cf.classification != "safe":
                mult = severity_multiplier.get(cf.severity, 0.6)
                base = cf.weight * mult
                # Unknown patterns at high/critical severity get double weight
                if cf.classification is None and cf.severity in ("critical", "high"):
                    base *= 2
                    unknown_high_count += 1
                risk_score += int(base + 0.5)  # round

        # Trusted publisher shortcut: if trusted and score <= threshold_warn, allow
        if is_trusted and risk_score <= config.threshold_warn and dangerous_count == 0:
            action = "allow"
        elif risk_score <= config.threshold_allow:
            action = "allow"
        elif risk_score <= config.threshold_warn:
            action = "warn"
        else:
            action = "block"

        # Dangerous or unknown-high findings escalate to at least warn
        # (trusted publishers are exempt from unknown-high escalation)
        if action == "allow":
            if dangerous_count > 0:
                action = "warn"
            elif unknown_high_count > 0 and not is_trusted:
                action = "warn"

        return PolicyDecision(
            action=action,
            risk_score=risk_score,
            threshold_allow=config.threshold_allow,
            threshold_warn=config.threshold_warn,
            total_findings=len(findings),
            classified_findings=classified,
            safe_count=safe_count,
            review_count=review_count,
            dangerous_count=dangerous_count,
            unknown_count=unknown_count,
            trusted_publisher=is_trusted,
            publisher_name=publisher_name,
        )

    async def _classify(self, category: str, value: str) -> str | None:
        """Classify a value using the permissions database."""
        if not value:
            return None

        # Inherently dangerous categories — no DB lookup needed
        if category in ("code_exec", "dynamic_import", "symlink_escape"):
            return "dangerous"

        # Map finding categories to permission categories
        category_map = {
            "network_domain": "network",
            "env_var_read": "env_var",
            "file_write": "file_path",
            "shell_exec": "shell_command",
        }
        perm_category = category_map.get(category)
        if not perm_category:
            return None

        return await self.repo.classify_pattern(perm_category, value)

    @staticmethod
    def _extract_pattern(category: str, excerpt: str) -> str:
        """Extract the classifiable pattern from a finding excerpt."""
        import re

        if category == "network_domain":
            # Extract domain from URLs or domain references
            match = re.search(r'https?://([^\s/\'"]+)', excerpt)
            if match:
                return match.group(1)
            # Try bare domain
            match = re.search(r'[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,60}[a-zA-Z0-9])?\.[a-zA-Z]{2,10}', excerpt)
            if match:
                return match.group(0)

        elif category == "env_var_read":
            # Extract env var name from os.environ["X"], os.environ.get("X"), os.getenv("X"), process.env.X
            match = re.search(r'(?:environ\[|environ\.get\(|getenv\(|env\.)[\s"\']*(\w+)', excerpt)
            if match:
                return match.group(1)

        elif category == "file_write":
            # Extract file path from open("path", "w") etc
            match = re.search(r'open\(\s*["\']([^"\']+)["\']', excerpt)
            if match:
                return match.group(1)

        elif category == "shell_exec":
            # Extract command from subprocess calls
            match = re.search(r'(?:run|call|Popen|system)\(\s{0,5}(?:\[?\s{0,5}["\'])?([^"\')\]]{1,200})', excerpt)
            if match:
                return match.group(1).strip()

        return excerpt.strip()[:100]
