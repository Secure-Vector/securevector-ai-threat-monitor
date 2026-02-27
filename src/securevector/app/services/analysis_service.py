"""
Analysis service for the SecureVector desktop application.

All-DB approach:
- Rules loaded from SQLite (community + custom)
- No API key required
- LocalAnalyzer unchanged for SDK users
"""

import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import yaml

from securevector.app.database.connection import DatabaseConnection, get_database
from securevector.app.database.repositories.rules import RulesRepository

logger = logging.getLogger(__name__)


@dataclass
class AnalysisResult:
    """Result of threat analysis."""

    is_threat: bool
    threat_type: Optional[str]
    risk_score: int
    confidence: float
    matched_rules: list[dict]
    processing_time_ms: int


class AnalysisService:
    """
    Analysis service using all-DB approach.

    Rules are loaded from SQLite database:
    - Community rules: cached from YAML on first run
    - Custom rules: created by user via UI/API

    No API key required. Fully local.
    """

    def __init__(self, db: DatabaseConnection):
        """
        Initialize the analysis service.

        Args:
            db: Database connection.
        """
        self.db = db
        self.repo = RulesRepository(db)
        self._compiled_patterns: list[dict] = []
        self._rules_loaded = False

    async def ensure_rules_loaded(self) -> None:
        """Ensure rules are loaded and compiled."""
        if self._rules_loaded:
            return

        # Check if community rules are cached
        counts = await self.repo.get_rule_counts()
        if counts["community"] == 0:
            # First run - load community rules from YAML
            await self._load_community_rules_from_yaml()

        # Compile all enabled rules
        await self._compile_rules()
        self._rules_loaded = True

    async def _load_community_rules_from_yaml(self) -> int:
        """
        Load community rules from SDK YAML files into database.

        Returns:
            Number of rules loaded.
        """
        # Find community rules directory
        # Path: src/securevector/app/services/analysis_service.py
        # Need: src/securevector/rules/community
        package_dir = Path(__file__).parent.parent.parent  # src/securevector
        rules_dir = package_dir / "rules" / "community"

        if not rules_dir.exists():
            logger.warning(f"Community rules directory not found: {rules_dir}")
            return 0

        count = 0
        for yaml_file in rules_dir.glob("**/*.yaml"):
            try:
                count += await self._load_yaml_file(yaml_file)
            except Exception as e:
                logger.error(f"Failed to load {yaml_file}: {e}")

        for yaml_file in rules_dir.glob("**/*.yml"):
            try:
                count += await self._load_yaml_file(yaml_file)
            except Exception as e:
                logger.error(f"Failed to load {yaml_file}: {e}")

        logger.info(f"Loaded {count} community rules from YAML files")
        return count

    async def _load_yaml_file(self, yaml_file: Path) -> int:
        """Load rules from a single YAML file."""
        with open(yaml_file, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)

        if not data:
            return 0

        count = 0

        # Handle different YAML formats
        if "rules" in data:
            for rule_entry in data["rules"]:
                rule_id = rule_entry.get("id", f"{yaml_file.stem}_{count}")
                name = rule_entry.get("name", rule_id)
                category = rule_entry.get("category", yaml_file.stem)
                description = rule_entry.get("description", "")
                severity = rule_entry.get("severity", "medium")

                # Extract patterns from various formats
                patterns = []
                if "patterns" in rule_entry:
                    patterns = rule_entry["patterns"]
                elif "pattern" in rule_entry:
                    pattern_data = rule_entry["pattern"]
                    if isinstance(pattern_data, dict):
                        patterns = pattern_data.get("value", [])
                    else:
                        patterns = [pattern_data]
                elif "rule" in rule_entry:
                    rule = rule_entry["rule"]
                    for detection in rule.get("detection", []):
                        if "match" in detection:
                            patterns.append(detection["match"])

                if not isinstance(patterns, list):
                    patterns = [patterns]

                if patterns:
                    # Merge created_at / tags / source from rule entry into metadata
                    base_meta = dict(rule_entry.get("metadata") or {})
                    for field in ("created_at", "tags", "source"):
                        if field in rule_entry:
                            base_meta[field] = rule_entry[field]
                    await self.repo.cache_community_rule(
                        rule_id=rule_id,
                        name=name,
                        category=category,
                        description=description,
                        severity=severity,
                        patterns=patterns,
                        source_file=str(yaml_file),
                        metadata=base_meta or None,
                    )
                    count += 1

        elif "patterns" in data:
            # Old format - single rule per file
            for i, pattern_info in enumerate(data["patterns"]):
                rule_id = f"{yaml_file.stem}_{i}"
                await self.repo.cache_community_rule(
                    rule_id=rule_id,
                    name=pattern_info.get("description", rule_id),
                    category=yaml_file.stem,
                    description=pattern_info.get("description", ""),
                    severity="medium",
                    patterns=[pattern_info.get("pattern", "")],
                    source_file=str(yaml_file),
                )
                count += 1

        return count

    async def _compile_rules(self) -> None:
        """Compile all enabled rules for fast matching."""
        self._compiled_patterns.clear()

        rules = await self.repo.get_all_enabled_rules()

        for rule in rules:
            severity = rule["severity"]
            # Calculate risk score from severity
            severity_scores = {"critical": 90, "high": 75, "medium": 50, "low": 25}
            base_score = severity_scores.get(severity, 50)

            for pattern_str in rule["patterns"]:
                if not pattern_str:
                    continue
                try:
                    compiled = re.compile(pattern_str, re.IGNORECASE)
                    self._compiled_patterns.append({
                        "compiled": compiled,
                        "original": pattern_str,
                        "rule_id": rule["id"],
                        "rule_name": rule["name"],
                        "category": rule["category"],
                        "severity": severity,
                        "risk_score": base_score,
                        "confidence": 0.8,
                        "source": rule["source"],
                    })
                except re.error as e:
                    logger.warning(f"Invalid regex in {rule['id']}: {pattern_str} - {e}")

        logger.info(f"Compiled {len(self._compiled_patterns)} patterns from {len(rules)} rules")

    async def reload_rules(self) -> None:
        """Reload and recompile all rules."""
        self._rules_loaded = False
        await self.ensure_rules_loaded()

    async def analyze(self, text: str) -> AnalysisResult:
        """
        Analyze text for threats using database rules.

        Args:
            text: Text to analyze.

        Returns:
            AnalysisResult with threat information.
        """
        await self.ensure_rules_loaded()

        start_time = time.perf_counter()
        matched_rules = []
        max_risk_score = 0
        max_confidence = 0.0
        threat_type = None

        for pattern_info in self._compiled_patterns:
            try:
                if pattern_info["compiled"].search(text):
                    matched_rules.append({
                        "id": pattern_info["rule_id"],
                        "name": pattern_info["rule_name"],
                        "category": pattern_info["category"],
                        "severity": pattern_info["severity"],
                        "source": pattern_info["source"],
                        "matched_patterns": [pattern_info["original"]],
                    })
                    if pattern_info["risk_score"] > max_risk_score:
                        max_risk_score = pattern_info["risk_score"]
                        threat_type = pattern_info["category"]
                    if pattern_info["confidence"] > max_confidence:
                        max_confidence = pattern_info["confidence"]
            except Exception as e:
                logger.warning(f"Pattern matching error: {e}")

        processing_time_ms = int((time.perf_counter() - start_time) * 1000)

        return AnalysisResult(
            is_threat=len(matched_rules) > 0,
            threat_type=threat_type,
            risk_score=max_risk_score,
            confidence=max_confidence if max_confidence > 0 else 0.0,
            matched_rules=matched_rules,
            processing_time_ms=processing_time_ms,
        )

    async def get_stats(self) -> dict:
        """Get analyzer statistics."""
        counts = await self.repo.get_rule_counts()
        return {
            "community_rules": counts["community"],
            "custom_rules": counts["custom"],
            "overrides": counts["overrides"],
            "compiled_patterns": len(self._compiled_patterns),
        }


# Singleton instance
_analysis_service: Optional[AnalysisService] = None


def get_analysis_service() -> AnalysisService:
    """Get the global analysis service instance."""
    global _analysis_service
    if _analysis_service is None:
        db = get_database()
        _analysis_service = AnalysisService(db)
    return _analysis_service


async def init_analysis_service() -> AnalysisService:
    """Initialize the analysis service and load rules."""
    service = get_analysis_service()
    await service.ensure_rules_loaded()
    return service
