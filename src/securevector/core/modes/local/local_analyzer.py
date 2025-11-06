"""
Local analyzer for pattern-based threat detection.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

from securevector.models.analysis_result import ThreatDetection
from securevector.models.config_models import LocalModeConfig
from securevector.models.threat_types import ThreatType
from securevector.utils.exceptions import RuleLoadError
from securevector.utils.logger import get_logger
from securevector.utils.security import (
    PathTraversalError,
    RegexSecurityError,
    RegexTimeoutError,
    safe_regex_compile,
    safe_regex_search,
    secure_file_glob,
    secure_path_join,
    validate_file_path,
)


class LocalAnalyzer:
    """
    Local threat analyzer using pattern matching and rule-based detection.

    Loads security rules from YAML files and performs fast pattern matching
    against input prompts to detect threats.
    """

    def __init__(self, config: LocalModeConfig):
        self.config = config
        self.logger = get_logger(__name__)

        # Rule storage
        self.rules: Dict[str, Dict] = {}
        self.compiled_patterns: Dict[str, List] = {}

        # Performance tracking
        self.rule_load_time = 0.0
        self.last_reload_time = 0.0

        # Load rules
        self._load_rules()

    def _load_rules(self) -> None:
        """Load security rules from configured path"""
        start_time = time.time()

        try:
            # Validate and secure the rules path
            rules_path = Path(self.config.rules_path).resolve()

            # Define allowed base paths for security
            allowed_base_paths = [
                Path(__file__).parent.parent.parent.parent.parent / "rules",  # Project rules
                Path.cwd() / "rules",  # Current directory rules
                Path("/opt/securevector/rules"),  # System rules (if exists)
            ]

            # Add the configured path as allowed if it's absolute and exists
            if rules_path.is_absolute() and rules_path.exists():
                allowed_base_paths.append(rules_path.parent)

            try:
                # Validate that the rules path is within allowed directories
                if not rules_path.exists():
                    # Try community rules as fallback
                    community_path = (
                        Path(__file__).parent.parent.parent.parent / "rules" / "community"
                    )
                    community_path = community_path.resolve()

                    if community_path.exists():
                        rules_path = community_path
                        self.logger.warning(
                            f"Rules path not found, using community rules: {community_path}"
                        )
                    else:
                        raise RuleLoadError(f"Rules path not found: {self.config.rules_path}")
                else:
                    # Validate the existing path is safe
                    rules_path = validate_file_path(rules_path, allowed_base_paths)

            except PathTraversalError as e:
                self.logger.error(f"Path traversal detected in rules path: {e}")
                # Fallback to community rules
                community_path = (
                    Path(__file__).parent.parent.parent.parent / "rules" / "community"
                )
                community_path = community_path.resolve()
                if community_path.exists():
                    rules_path = community_path
                    self.logger.warning("Using community rules due to security concerns")
                else:
                    raise RuleLoadError(f"Secure rules path not available")

            self.rules.clear()
            self.compiled_patterns.clear()

            # Load rules from all YAML files
            rule_files = []

            # Load from core rules using secure glob
            try:
                core_path = secure_path_join(rules_path, "core")
                if core_path.exists():
                    rule_files.extend(secure_file_glob(core_path, "*.yml"))
                    rule_files.extend(secure_file_glob(core_path, "*.yaml"))
            except PathTraversalError as e:
                self.logger.warning(f"Security issue with core rules path: {e}")

            # Load from industry rules if enabled
            if self.config.custom_rules_enabled:
                try:
                    industry_path = secure_path_join(rules_path, "industry")
                    if industry_path.exists():
                        rule_files.extend(secure_file_glob(industry_path, "*.yml"))
                        rule_files.extend(secure_file_glob(industry_path, "*.yaml"))
                except PathTraversalError as e:
                    self.logger.warning(f"Security issue with industry rules path: {e}")

            # Load from compliance rules if enabled
            if self.config.custom_rules_enabled:
                try:
                    compliance_path = secure_path_join(rules_path, "compliance")
                    if compliance_path.exists():
                        rule_files.extend(secure_file_glob(compliance_path, "*.yml"))
                        rule_files.extend(secure_file_glob(compliance_path, "*.yaml"))
                except PathTraversalError as e:
                    self.logger.warning(f"Security issue with compliance rules path: {e}")

            # Load from custom rules if enabled (but don't go outside rules directory)
            if self.config.custom_rules_enabled:
                try:
                    custom_path = secure_path_join(rules_path, "custom")
                    if custom_path.exists():
                        rule_files.extend(secure_file_glob(custom_path, "*.yml"))
                        rule_files.extend(secure_file_glob(custom_path, "*.yaml"))
                except PathTraversalError as e:
                    self.logger.warning(f"Security issue with custom rules path: {e}")

            # If no rule files found in structured format, load from flat directory
            if not rule_files:
                try:
                    rule_files.extend(secure_file_glob(rules_path, "*.yml"))
                    rule_files.extend(secure_file_glob(rules_path, "*.yaml"))
                except PathTraversalError as e:
                    self.logger.warning(f"Security issue with rules directory: {e}")

            total_patterns = 0

            for rule_file in rule_files:
                try:
                    # Validate that the rule file is still within allowed paths
                    rule_file = validate_file_path(rule_file, allowed_base_paths)

                    with open(rule_file, "r", encoding="utf-8") as f:
                        rule_data = yaml.safe_load(f)

                        if not rule_data:
                            self.logger.warning(f"Empty rule file: {rule_file}")
                            continue

                        # Support both old format (patterns) and new format (rules)
                        if "rules" not in rule_data and "patterns" not in rule_data:
                            self.logger.warning(f"Invalid rule file format: {rule_file}")
                            continue

                        rule_name = rule_file.stem
                        self.rules[rule_name] = rule_data

                        # Compile patterns for performance
                        if self.config.rule_compilation:
                            self._compile_patterns(rule_name, rule_data)

                        # Count patterns in both old and new format
                        if "rules" in rule_data:
                            # Support multiple formats:
                            # 1. Old format: {"rule": {"detection": [...]}}
                            # 2. Community format: {"pattern": {"value": [...]}}
                            # 3. Direct format: {"patterns": [...]}
                            pattern_count = 0
                            for rule_entry in rule_data["rules"]:
                                if "rule" in rule_entry:
                                    # Old format
                                    pattern_count += len(rule_entry.get("rule", {}).get("detection", []))
                                elif "pattern" in rule_entry:
                                    # Community format
                                    pattern_value = rule_entry.get("pattern", {}).get("value", [])
                                    if isinstance(pattern_value, list):
                                        pattern_count += len(pattern_value)
                                    else:
                                        pattern_count += 1
                                elif "patterns" in rule_entry:
                                    # Direct format (most common in community rules)
                                    patterns = rule_entry.get("patterns", [])
                                    if isinstance(patterns, list):
                                        pattern_count += len(patterns)
                        else:
                            pattern_count = len(rule_data.get("patterns", []))
                        total_patterns += pattern_count

                        self.logger.debug(f"Loaded {pattern_count} patterns from {rule_file}")

                except PathTraversalError as e:
                    self.logger.error(
                        f"Security violation - path traversal in rule file {rule_file}: {e}"
                    )
                    continue
                except FileNotFoundError as e:
                    self.logger.error(f"Rule file not found: {rule_file}: {e}")
                    continue
                except Exception as e:
                    self.logger.error(f"Failed to load rule file {rule_file}: {e}")
                    continue

            self.rule_load_time = (time.time() - start_time) * 1000
            self.last_reload_time = time.time()

            self.logger.info(
                f"Loaded {len(self.rules)} rule files with {total_patterns} total patterns "
                f"in {self.rule_load_time:.1f}ms"
            )

            if len(self.rules) == 0:
                raise RuleLoadError("No valid rule files found")

        except Exception as e:
            self.logger.error(f"Failed to load rules: {e}")
            raise RuleLoadError(f"Failed to load security rules: {e}")

    def _compile_patterns(self, rule_name: str, rule_data: Dict) -> None:
        """Compile regex patterns for better performance"""
        compiled_patterns = []

        # Handle new security-rule-forge format and community format
        if "rules" in rule_data:
            for rule_entry in rule_data["rules"]:
                # Support multiple formats:
                # 1. Old format: {"rule": {"detection": [...]}}
                # 2. Nested pattern format: {"pattern": {"value": [...]}}
                # 3. Direct format: {"patterns": [...]}
                if "rule" in rule_entry:
                    # Old format
                    rule = rule_entry.get("rule", {})
                    rule_id = rule.get("id", f"{rule_name}_unknown")
                    rule_category = rule.get("category", rule_name)
                    rule_confidence = rule.get("confidence", 0.8)
                    patterns_to_compile = []

                    for detection in rule.get("detection", []):
                        pattern_str = detection.get("match", "")
                        if pattern_str:
                            patterns_to_compile.append({
                                "pattern": pattern_str,
                                "flags": detection.get("flags", []),
                                "weight": detection.get("weight", 1.0)
                            })
                elif "patterns" in rule_entry:
                    # Direct format (most common in community rules)
                    rule = rule_entry
                    rule_id = rule_entry.get("id", f"{rule_name}_unknown")
                    rule_category = rule_entry.get("category", rule_name)
                    rule_confidence = rule_entry.get("threshold", 0.8)

                    # Extract patterns directly
                    patterns_to_compile = []
                    pattern_values = rule_entry.get("patterns", [])
                    if not isinstance(pattern_values, list):
                        pattern_values = [pattern_values]

                    for pattern_str in pattern_values:
                        if pattern_str:
                            patterns_to_compile.append({
                                "pattern": pattern_str,
                                "flags": [],
                                "weight": 1.0
                            })
                else:
                    # Nested pattern format
                    rule_id = rule_entry.get("id", f"{rule_name}_unknown")
                    rule_category = rule_entry.get("category", rule_name)
                    rule_confidence = rule_entry.get("pattern", {}).get("confidence_threshold", 0.8)
                    rule = rule_entry  # Use the entry directly

                    # Extract patterns from nested pattern format
                    patterns_to_compile = []
                    pattern_data = rule_entry.get("pattern", {})
                    pattern_values = pattern_data.get("value", [])
                    if not isinstance(pattern_values, list):
                        pattern_values = [pattern_values]

                    for pattern_str in pattern_values:
                        if pattern_str:
                            patterns_to_compile.append({
                                "pattern": pattern_str,
                                "flags": [] if not pattern_data.get("case_sensitive", False) else [],
                                "weight": 1.0
                            })

                # Compile all patterns for this rule
                for pattern_info in patterns_to_compile:
                    pattern_str = pattern_info["pattern"]

                    # Convert flags to regex flags
                    flags = re.IGNORECASE  # Default flag for community format
                    detection_flags = pattern_info.get("flags", [])
                    if "multiline" in detection_flags:
                        flags |= re.MULTILINE
                    if "dotall" in detection_flags:
                        flags |= re.DOTALL

                    try:
                        # Use safe regex compilation with ReDoS protection
                        compiled_pattern = safe_regex_compile(pattern_str, flags, timeout=2.0)

                        # Calculate risk score from severity and confidence
                        severity_scores = {"critical": 90, "high": 75, "medium": 50, "low": 25}
                        base_score = severity_scores.get(rule.get("severity", "medium"), 50)
                        risk_score = int(base_score * rule_confidence)

                        compiled_patterns.append(
                            {
                                "compiled": compiled_pattern,
                                "original": pattern_str,
                                "risk_score": risk_score,
                                "description": rule.get("name", ""),
                                "threat_type": rule_category,
                                "rule_id": rule_id,
                                "confidence": rule_confidence,
                                "weight": pattern_info.get("weight", 1.0),
                                "response": rule.get("response", {}),
                            }
                        )
                    except RegexSecurityError as e:
                        self.logger.warning(
                            f"Unsafe regex pattern in {rule_id}: {pattern_str} - {e}"
                        )
                        continue
                    except RegexTimeoutError as e:
                        self.logger.warning(
                            f"Regex compilation timeout in {rule_id}: {pattern_str} - {e}"
                        )
                        continue
                    except re.error as e:
                        self.logger.warning(
                            f"Invalid regex pattern in {rule_id}: {pattern_str} - {e}"
                        )
                        continue

        # Handle old format for backward compatibility
        else:
            for pattern_info in rule_data.get("patterns", []):
                pattern_str = pattern_info.get("pattern", "")
                if not pattern_str:
                    continue

                try:
                    # Use safe regex compilation with ReDoS protection
                    compiled_pattern = safe_regex_compile(
                        pattern_str, re.IGNORECASE | re.MULTILINE, timeout=2.0
                    )
                    compiled_patterns.append(
                        {
                            "compiled": compiled_pattern,
                            "original": pattern_str,
                            "risk_score": pattern_info.get("risk_score", 50),
                            "description": pattern_info.get("description", ""),
                            "threat_type": pattern_info.get("threat_type", rule_name),
                            "rule_id": f"{rule_name}:{pattern_str}",
                            "confidence": 0.8,
                            "weight": 1.0,
                            "response": {"action": "alert", "message": "Potential threat detected"},
                        }
                    )
                except re.error as e:
                    self.logger.warning(
                        f"Invalid regex pattern in {rule_name}: {pattern_str} - {e}"
                    )
                    continue

        self.compiled_patterns[rule_name] = compiled_patterns

    def analyze_prompt(self, prompt: str) -> List[ThreatDetection]:
        """
        Analyze a prompt against all loaded rules.

        Args:
            prompt: The prompt text to analyze

        Returns:
            List[ThreatDetection]: List of detected threats
        """
        detections = []

        if self.config.rule_compilation and self.compiled_patterns:
            # Use compiled patterns for better performance
            detections = self._analyze_with_compiled_patterns(prompt)
        else:
            # Use runtime pattern matching
            detections = self._analyze_with_runtime_patterns(prompt)

        return detections

    def _analyze_with_compiled_patterns(self, prompt: str) -> List[ThreatDetection]:
        """Analyze using pre-compiled regex patterns"""
        detections = []

        for rule_name, patterns in self.compiled_patterns.items():
            for pattern_info in patterns:
                try:
                    # Use safe regex search with timeout protection
                    match = safe_regex_search(pattern_info["compiled"], prompt, timeout=0.1)
                    if match:
                        detection = ThreatDetection(
                            threat_type=pattern_info["threat_type"],
                            risk_score=pattern_info["risk_score"],
                            confidence=pattern_info["confidence"],
                            description=pattern_info["description"],
                            rule_id=pattern_info["rule_id"],
                            pattern_matched=pattern_info["original"],
                        )
                        detections.append(detection)
                except RegexTimeoutError as e:
                    self.logger.warning(f"Pattern matching timeout: {e}")
                    continue
                except Exception as e:
                    self.logger.warning(f"Pattern matching error: {e}")
                    continue

        return detections

    def _analyze_with_runtime_patterns(self, prompt: str) -> List[ThreatDetection]:
        """Analyze using runtime pattern compilation"""
        detections = []

        for rule_name, rule_data in self.rules.items():
            if not rule_data:
                continue

            # Handle new security-rule-forge format
            if "rules" in rule_data:
                for rule_entry in rule_data["rules"]:
                    rule = rule_entry.get("rule", {})
                    rule_id = rule.get("id", f"{rule_name}_unknown")
                    rule_category = rule.get("category", rule_name)
                    rule_confidence = rule.get("confidence", 0.8)

                    # Calculate risk score from severity and confidence
                    severity_scores = {"critical": 90, "high": 75, "medium": 50, "low": 25}
                    base_score = severity_scores.get(rule.get("severity", "medium"), 50)
                    risk_score = int(base_score * rule_confidence)

                    for detection in rule.get("detection", []):
                        pattern_str = detection.get("match", "")
                        if not pattern_str:
                            continue

                        # Convert flags to regex flags
                        flags = re.IGNORECASE  # Default flag
                        detection_flags = detection.get("flags", [])
                        if "multiline" in detection_flags:
                            flags |= re.MULTILINE
                        if "dotall" in detection_flags:
                            flags |= re.DOTALL

                        try:
                            # Use safe regex compilation and search
                            compiled_pattern = safe_regex_compile(pattern_str, flags, timeout=1.0)
                            match = safe_regex_search(compiled_pattern, prompt, timeout=0.1)
                            if match:
                                detection = ThreatDetection(
                                    threat_type=rule_category,
                                    risk_score=risk_score,
                                    confidence=rule_confidence,
                                    description=rule.get("name", ""),
                                    rule_id=rule_id,
                                    pattern_matched=pattern_str,
                                )
                                detections.append(detection)
                        except RegexSecurityError as e:
                            self.logger.warning(f"Unsafe regex in {rule_id}: {pattern_str} - {e}")
                            continue
                        except RegexTimeoutError as e:
                            self.logger.warning(f"Regex timeout in {rule_id}: {pattern_str} - {e}")
                            continue
                        except re.error as e:
                            self.logger.warning(f"Invalid regex in {rule_id}: {pattern_str} - {e}")
                            continue
                        except Exception as e:
                            self.logger.warning(f"Pattern matching error: {e}")
                            continue

            # Handle old format for backward compatibility
            elif "patterns" in rule_data:
                for pattern_info in rule_data["patterns"]:
                    pattern_str = pattern_info.get("pattern", "")
                    risk_score = pattern_info.get("risk_score", 50)
                    description = pattern_info.get("description", "")
                    threat_type = pattern_info.get("threat_type", rule_name)

                    if not pattern_str:
                        continue

                    try:
                        # Use safe regex compilation and search
                        compiled_pattern = safe_regex_compile(
                            pattern_str, re.IGNORECASE | re.MULTILINE, timeout=1.0
                        )
                        match = safe_regex_search(compiled_pattern, prompt, timeout=0.1)
                        if match:
                            detection = ThreatDetection(
                                threat_type=threat_type,
                                risk_score=risk_score,
                                confidence=0.8,  # High confidence for pattern matches
                                description=description,
                                rule_id=f"{rule_name}:{pattern_str}",
                                pattern_matched=pattern_str,
                            )
                            detections.append(detection)
                    except RegexSecurityError as e:
                        self.logger.warning(f"Unsafe regex in {rule_name}: {pattern_str} - {e}")
                        continue
                    except RegexTimeoutError as e:
                        self.logger.warning(f"Regex timeout in {rule_name}: {pattern_str} - {e}")
                        continue
                    except re.error as e:
                        self.logger.warning(f"Invalid regex in {rule_name}: {pattern_str} - {e}")
                        continue
                    except Exception as e:
                        self.logger.warning(f"Pattern matching error: {e}")
                        continue

        return detections

    def get_rule_count(self) -> int:
        """Get total number of loaded rules"""
        return len(self.rules)

    def get_pattern_count(self) -> int:
        """Get total number of patterns across all rules"""
        total = 0
        for rule_data in self.rules.values():
            if "rules" in rule_data:
                # New format: count detection patterns in each rule
                total += sum(
                    len(rule_entry.get("rule", {}).get("detection", []))
                    for rule_entry in rule_data["rules"]
                )
            else:
                # Old format: count patterns directly
                total += len(rule_data.get("patterns", []))
        return total

    def get_rule_categories(self) -> List[str]:
        """Get list of rule categories (file names)"""
        return list(self.rules.keys())

    def get_rule_info(self) -> Dict[str, Any]:
        """Get detailed information about loaded rules"""
        info = {
            "total_rules": len(self.rules),
            "total_patterns": self.get_pattern_count(),
            "categories": {},
            "load_time_ms": self.rule_load_time,
            "last_reload": self.last_reload_time,
            "compilation_enabled": self.config.rule_compilation,
        }

        for rule_name, rule_data in self.rules.items():
            if "rules" in rule_data:
                # New format: extract info from first rule or use file-level info
                pattern_count = sum(
                    len(rule_entry.get("rule", {}).get("detection", []))
                    for rule_entry in rule_data["rules"]
                )
                info["categories"][rule_name] = {
                    "name": f"Security Rules - {rule_name}",
                    "description": f"Contains {len(rule_data['rules'])} security rules",
                    "version": "2.0.0",  # New schema version
                    "pattern_count": pattern_count,
                    "rule_count": len(rule_data["rules"]),
                }
            else:
                # Old format
                info["categories"][rule_name] = {
                    "name": rule_data.get("name", rule_name),
                    "description": rule_data.get("description", ""),
                    "version": rule_data.get("version", ""),
                    "pattern_count": len(rule_data.get("patterns", [])),
                }

        return info

    def get_health_status(self) -> Dict[str, Any]:
        """Get health status of the analyzer"""
        return {
            "status": "healthy" if self.rules else "error",
            "rules_loaded": len(self.rules),
            "patterns_loaded": self.get_pattern_count(),
            "last_reload": self.last_reload_time,
            "load_time_ms": self.rule_load_time,
        }

    def reload_rules(self) -> None:
        """Reload rules from disk"""
        self._load_rules()

    def update_rules_path(self, new_path: str) -> None:
        """Update the rules path"""
        self.config.rules_path = new_path
        self.reload_rules()

    def close(self) -> None:
        """Clean up resources"""
        self.rules.clear()
        self.compiled_patterns.clear()
        self.logger.debug("Local analyzer closed")
