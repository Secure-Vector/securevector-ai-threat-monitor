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


# --- Per-rule detection confidence (issue #136) ----------------------------
# The legacy engine stamped a flat 0.8 confidence on EVERY regex hit, so a
# lone shape-only heuristic was indistinguishable from a rock-solid
# `ghp_…`/`AKIA…`/PEM signature, and the `_MIN_RULE_CONFIDENCE` floor in the
# analyze route was dead code (nothing ever scored below it). Confidence is
# now a real per-rule value:
#   1. An authored `metadata.confidence` (0.0–1.0) always wins — this is the
#      precision dial tuned per rule against the precision/recall harness.
#   2. Otherwise a severity-based default is used. Defaults are deliberately
#      conservative (all above the 0.25 noise floor) so this change cannot
#      regress recall on its own; the calibrated VERDICT (see the analyze
#      route) is what gates a lone medium hit from alarming.
_SEVERITY_CONFIDENCE_DEFAULT = {
    "critical": 0.9,
    "high": 0.75,
    "medium": 0.6,
    "low": 0.4,
}


def calibrate_confidence(severity: str, authored=None) -> float:
    """Resolve a rule's detection confidence.

    Authored `metadata.confidence` wins (clamped to [0, 1]); otherwise fall
    back to a severity-based default. Kept module-level + importable so the
    precision/recall harness and tests can assert the calibration directly.
    """
    if authored is not None:
        try:
            return max(0.0, min(1.0, float(authored)))
        except (TypeError, ValueError):
            logger.warning("Ignoring non-numeric rule confidence: %r", authored)
    return _SEVERITY_CONFIDENCE_DEFAULT.get(severity, 0.6)


# Calibrated-verdict thresholds (issue #136). A threat requires either ONE
# high-confidence hit OR at least TWO corroborating medium-confidence hits.
# Single source of truth: the analyze route AND the precision/recall harness
# both call calibrated_verdict() so they can never drift apart.
CALIBRATED_HIGH_CONFIDENCE = 0.75
CALIBRATED_MED_CONFIDENCE = 0.6


def calibrated_verdict(confidences) -> bool:
    """Decide is_threat from the confidences of the SURVIVING matched rules.

    Replaces the legacy "any rule matched = threat": a lone low/medium hit
    informs the score but does not alarm on its own.
    """
    confs = []
    for c in confidences:
        try:
            confs.append(float(c))
        except (TypeError, ValueError):
            continue
    if any(c >= CALIBRATED_HIGH_CONFIDENCE for c in confs):
        return True
    return sum(1 for c in confs if c >= CALIBRATED_MED_CONFIDENCE) >= 2


# --- Rule direction (issue #136 Phase 3) -----------------------------------
# Each rule declares which scan directions it should be EVALUATED on. This
# replaces the analyze route's hardcoded incoming-suppression list with a
# tag-driven mechanism that is a single source of truth (route + engine +
# precision/recall harness all import these). Vocabulary:
#   both      (default) — evaluate on every direction.
#   outgoing  — user prompt / model output only; SUPPRESSED on incoming
#               fetched/tool content (these rules match shapes common in
#               benign source code and docs and would FP-flood otherwise).
#   incoming  — fetched/tool content only (e.g. IDPI-specific rules).
# Legacy `input` / `output` / `llm_response` metadata values were dead config
# (the engine's direction filter was never wired) and normalize to `both`.
_VALID_DIRECTIONS = {"incoming", "outgoing", "both"}


def resolve_direction(rule_id, category=None, authored=None) -> str:
    """Resolve a rule's evaluation direction.

    An explicit, valid `metadata.direction` wins. Otherwise rules whose id
    marks them an evasion technique (`_evasion_`) default to `outgoing` —
    reproducing the route's historical `"_evasion_" in id` incoming-suppression
    so this refactor preserves behavior. Everything else is `both`.
    """
    if isinstance(authored, str):
        a = authored.strip().lower()
        if a in _VALID_DIRECTIONS:
            return a
    if rule_id and "_evasion_" in rule_id:
        return "outgoing"
    return "both"


def direction_applies(rule_direction: str, scan_direction) -> bool:
    """Whether a rule tagged `rule_direction` should fire on a `scan_direction`
    scan. `scan_direction` is the analyze request direction
    (`outgoing` / `incoming` / `llm_response`), or None when unspecified.

      both     → always fires.
      outgoing → fires on outgoing + llm_response (model side); NOT on incoming.
      incoming → fires only on incoming fetched/tool content.
    """
    if rule_direction == "both" or not scan_direction:
        return True
    if rule_direction == "outgoing":
        return scan_direction != "incoming"
    if rule_direction == "incoming":
        return scan_direction == "incoming"
    return True


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

    # Category → MITRE ATT&CK fallback map. Rules that carry their own
    # `metadata.mitre_attack_ids` win; everything else falls back to a
    # defensible default based on threat category so `finding.techniques`
    # in OCSF output isn't empty for the ~86% of community rules that
    # don't ship explicit tags today. Chosen from ATT&CK v14 — each id
    # is the most specific technique that maps to the threat class.
    _CATEGORY_MITRE_FALLBACK: dict[str, list[str]] = {
        "prompt_injection":       ["T1059", "T1659"],   # Command interp, Content injection
        "jailbreak_attempts":     ["T1548", "T1027"],   # Abuse elevation, Obfuscation
        "jailbreak_attempt":      ["T1548", "T1027"],   # singular alias — some rules use this spelling
        "pii_detection":          ["T1005", "T1114"],   # Local data, Email collection
        "output_leakage":         ["T1530", "T1213"],   # Cloud storage, Info repos
        "data_leakage":           ["T1530", "T1213"],   # same mapping as output_leakage
        "data_extraction":        ["T1041", "T1567"],   # Exfil over C2, Exfil over web
        "sensitive_data_exposure":["T1041", "T1567"],
        "evasion_attempts":       ["T1027", "T1036", "T1070"],  # Obfuscation, Masquerade, Indicator removal
        "social_engineering":     ["T1566", "T1204"],   # Phishing, User execution
        "harmful_content":        ["T1204"],            # User execution
        "secrets":                ["T1552"],            # Unsecured credentials
        "secret_detection":       ["T1552"],
    }

    async def _compile_rules(self) -> None:
        """Compile all enabled rules for fast matching."""
        self._compiled_patterns.clear()

        rules = await self.repo.get_all_enabled_rules()

        for rule in rules:
            severity = rule["severity"]
            # Calculate risk score from severity
            severity_scores = {"critical": 90, "high": 75, "medium": 50, "low": 25}
            base_score = severity_scores.get(severity, 50)
            metadata = rule.get("metadata") or {}
            # MITRE resolution: rule's own tags first, then category fallback.
            # Community YAMLs use `mitre_attack_ids` as the field name.
            explicit_mitre = metadata.get("mitre_attack_ids") or metadata.get("mitre") or []
            if explicit_mitre:
                mitre_techniques = [str(t).strip() for t in explicit_mitre if str(t).strip()]
            else:
                mitre_techniques = list(self._CATEGORY_MITRE_FALLBACK.get(rule.get("category") or "", []))

            # Per-rule confidence (issue #136): authored metadata.confidence
            # wins, else a severity-based default. Replaces the flat 0.8.
            confidence = calibrate_confidence(severity, metadata.get("confidence"))
            # Evaluation direction (issue #136 Phase 3): explicit tag, else
            # `_evasion_`→outgoing, else both. Drives incoming-suppression.
            direction = resolve_direction(
                rule["id"], rule.get("category"), metadata.get("direction")
            )

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
                        "confidence": confidence,
                        "source": rule["source"],
                        "direction": direction,
                        "mitre_techniques": mitre_techniques,
                    })
                except re.error as e:
                    logger.warning(f"Invalid regex in {rule['id']}: {pattern_str} - {e}")

        logger.info(f"Compiled {len(self._compiled_patterns)} patterns from {len(rules)} rules")

    async def reload_rules(self) -> None:
        """Reload and recompile all rules."""
        self._rules_loaded = False
        await self.ensure_rules_loaded()

    async def analyze(self, text: str, direction: str = None) -> AnalysisResult:
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
            # Skip rules that don't apply to this scan direction (issue #136
            # Phase 3). When `direction` is None (the route's default call),
            # every rule applies and the route does the direction filtering
            # itself using the per-rule `direction` returned below.
            if not direction_applies(pattern_info.get("direction", "both"), direction):
                continue
            try:
                if pattern_info["compiled"].search(text):
                    matched_rules.append({
                        "id": pattern_info["rule_id"],
                        "name": pattern_info["rule_name"],
                        "category": pattern_info["category"],
                        "severity": pattern_info["severity"],
                        "source": pattern_info["source"],
                        "matched_patterns": [pattern_info["original"]],
                        "mitre_techniques": list(pattern_info.get("mitre_techniques") or []),
                        # Per-rule confidence (issue #136) — consumed by the
                        # analyze route's _MIN_RULE_CONFIDENCE floor and the
                        # calibrated verdict. Previously absent, which is why
                        # the floor was dead code.
                        "confidence": round(float(pattern_info["confidence"]), 3),
                        # Evaluation direction (Phase 3) — the route uses this
                        # to suppress cross-direction rules (e.g. drop
                        # outgoing-only rules on an incoming scan).
                        "direction": pattern_info.get("direction", "both"),
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
