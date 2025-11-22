#!/usr/bin/env python3
"""
Rule validation script to ensure all security rules follow the security-rule-forge schema.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import os
import re
import sys
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml


class ValidationLevel(Enum):
    ERROR = "ERROR"
    WARNING = "WARNING"
    INFO = "INFO"


@dataclass
class ValidationIssue:
    level: ValidationLevel
    file_path: str
    rule_id: Optional[str]
    field: str
    message: str
    line_number: Optional[int] = None


class RuleValidator:
    """Validates security rules against the security-rule-forge schema."""

    REQUIRED_RULE_FIELDS = {
        "id",
        "name",
        "category",
        "severity",
        "confidence",
        "detection",
        "context",
        "response",
        "performance",
        "testing",
    }

    VALID_CATEGORIES = {"prompt_injection", "data_exfiltration", "jailbreak", "content_safety"}

    VALID_SEVERITIES = {"critical", "high", "medium", "low"}

    VALID_DETECTION_TYPES = {"pattern", "semantic", "ml", "hybrid"}

    VALID_DETECTION_FLAGS = {"case_insensitive", "multiline", "dotall"}

    VALID_APPLIES_TO = {"user_input", "model_output", "both"}

    VALID_CONVERSATION_STAGES = {"initial", "ongoing", "any"}

    VALID_ACTIONS = {"block", "alert", "log", "sanitize", "escalate"}

    def __init__(self):
        self.issues: List[ValidationIssue] = []

    def validate_rule_file(self, file_path: Path) -> List[ValidationIssue]:
        """Validate a single rule file."""
        self.issues = []

        try:
            with open(file_path, "r", encoding="utf-8") as f:
                content = yaml.safe_load(f)

            if not content:
                self.issues.append(
                    ValidationIssue(
                        ValidationLevel.ERROR,
                        str(file_path),
                        None,
                        "file",
                        "Empty or invalid YAML file",
                    )
                )
                return self.issues

            # Check if it has the new rules structure
            if "rules" not in content:
                self.issues.append(
                    ValidationIssue(
                        ValidationLevel.ERROR,
                        str(file_path),
                        None,
                        "structure",
                        "File does not follow new schema - missing 'rules' root element",
                    )
                )
                return self.issues

            # Validate each rule
            for i, rule_entry in enumerate(content["rules"]):
                if "rule" not in rule_entry:
                    self.issues.append(
                        ValidationIssue(
                            ValidationLevel.ERROR,
                            str(file_path),
                            None,
                            f"rules[{i}]",
                            "Rule entry missing 'rule' key",
                        )
                    )
                    continue

                rule = rule_entry["rule"]
                self._validate_rule(rule, str(file_path), i)

        except yaml.YAMLError as e:
            self.issues.append(
                ValidationIssue(
                    ValidationLevel.ERROR, str(file_path), None, "yaml", f"YAML parsing error: {e}"
                )
            )
        except Exception as e:
            self.issues.append(
                ValidationIssue(
                    ValidationLevel.ERROR, str(file_path), None, "general", f"Validation error: {e}"
                )
            )

        return self.issues

    def _validate_rule(self, rule: Dict[str, Any], file_path: str, rule_index: int):
        """Validate a single rule."""
        rule_id = rule.get("id", f"rule_{rule_index}")

        # Check required fields
        for field in self.REQUIRED_RULE_FIELDS:
            if field not in rule:
                self.issues.append(
                    ValidationIssue(
                        ValidationLevel.ERROR,
                        file_path,
                        rule_id,
                        field,
                        f"Missing required field: {field}",
                    )
                )

        # Validate ID format
        if "id" in rule:
            if not re.match(r"^[a-z0-9_]+$", rule["id"]):
                self.issues.append(
                    ValidationIssue(
                        ValidationLevel.WARNING,
                        file_path,
                        rule_id,
                        "id",
                        "ID should contain only lowercase letters, numbers, and underscores",
                    )
                )

        # Validate category
        if "category" in rule:
            if rule["category"] not in self.VALID_CATEGORIES:
                self.issues.append(
                    ValidationIssue(
                        ValidationLevel.ERROR,
                        file_path,
                        rule_id,
                        "category",
                        f"Invalid category. Must be one of: {', '.join(self.VALID_CATEGORIES)}",
                    )
                )

        # Validate severity
        if "severity" in rule:
            if rule["severity"] not in self.VALID_SEVERITIES:
                self.issues.append(
                    ValidationIssue(
                        ValidationLevel.ERROR,
                        file_path,
                        rule_id,
                        "severity",
                        f"Invalid severity. Must be one of: {', '.join(self.VALID_SEVERITIES)}",
                    )
                )

        # Validate confidence
        if "confidence" in rule:
            confidence = rule["confidence"]
            if not isinstance(confidence, (int, float)) or not (0.0 <= confidence <= 1.0):
                self.issues.append(
                    ValidationIssue(
                        ValidationLevel.ERROR,
                        file_path,
                        rule_id,
                        "confidence",
                        "Confidence must be a number between 0.0 and 1.0",
                    )
                )

        # Validate detection
        if "detection" in rule:
            self._validate_detection(rule["detection"], file_path, rule_id)

        # Validate context
        if "context" in rule:
            self._validate_context(rule["context"], file_path, rule_id)

        # Validate response
        if "response" in rule:
            self._validate_response(rule["response"], file_path, rule_id)

        # Validate performance
        if "performance" in rule:
            self._validate_performance(rule["performance"], file_path, rule_id)

        # Validate testing
        if "testing" in rule:
            self._validate_testing(rule["testing"], file_path, rule_id)

    def _validate_detection(self, detection: Any, file_path: str, rule_id: str):
        """Validate detection section."""
        if not isinstance(detection, list):
            self.issues.append(
                ValidationIssue(
                    ValidationLevel.ERROR,
                    file_path,
                    rule_id,
                    "detection",
                    "Detection must be a list of detection patterns",
                )
            )
            return

        for i, pattern in enumerate(detection):
            if not isinstance(pattern, dict):
                self.issues.append(
                    ValidationIssue(
                        ValidationLevel.ERROR,
                        file_path,
                        rule_id,
                        f"detection[{i}]",
                        "Detection pattern must be a dictionary",
                    )
                )
                continue

            # Check required fields
            if "type" not in pattern:
                self.issues.append(
                    ValidationIssue(
                        ValidationLevel.ERROR,
                        file_path,
                        rule_id,
                        f"detection[{i}].type",
                        "Missing required field: type",
                    )
                )
            elif pattern["type"] not in self.VALID_DETECTION_TYPES:
                self.issues.append(
                    ValidationIssue(
                        ValidationLevel.ERROR,
                        file_path,
                        rule_id,
                        f"detection[{i}].type",
                        f"Invalid detection type. Must be one of: {', '.join(self.VALID_DETECTION_TYPES)}",
                    )
                )

            if "match" not in pattern:
                self.issues.append(
                    ValidationIssue(
                        ValidationLevel.ERROR,
                        file_path,
                        rule_id,
                        f"detection[{i}].match",
                        "Missing required field: match",
                    )
                )
            else:
                # Validate regex if it's a pattern type
                if pattern.get("type") == "pattern":
                    try:
                        re.compile(pattern["match"])
                    except re.error as e:
                        self.issues.append(
                            ValidationIssue(
                                ValidationLevel.ERROR,
                                file_path,
                                rule_id,
                                f"detection[{i}].match",
                                f"Invalid regex pattern: {e}",
                            )
                        )

            # Validate flags
            if "flags" in pattern:
                if not isinstance(pattern["flags"], list):
                    self.issues.append(
                        ValidationIssue(
                            ValidationLevel.ERROR,
                            file_path,
                            rule_id,
                            f"detection[{i}].flags",
                            "Flags must be a list",
                        )
                    )
                else:
                    for flag in pattern["flags"]:
                        if flag not in self.VALID_DETECTION_FLAGS:
                            self.issues.append(
                                ValidationIssue(
                                    ValidationLevel.WARNING,
                                    file_path,
                                    rule_id,
                                    f"detection[{i}].flags",
                                    f"Unknown flag: {flag}",
                                )
                            )

            # Validate weight
            if "weight" in pattern:
                weight = pattern["weight"]
                if not isinstance(weight, (int, float)) or not (0.0 <= weight <= 1.0):
                    self.issues.append(
                        ValidationIssue(
                            ValidationLevel.ERROR,
                            file_path,
                            rule_id,
                            f"detection[{i}].weight",
                            "Weight must be a number between 0.0 and 1.0",
                        )
                    )

    def _validate_context(self, context: Any, file_path: str, rule_id: str):
        """Validate context section."""
        if not isinstance(context, dict):
            self.issues.append(
                ValidationIssue(
                    ValidationLevel.ERROR,
                    file_path,
                    rule_id,
                    "context",
                    "Context must be a dictionary",
                )
            )
            return

        # Validate applies_to
        if "applies_to" in context:
            if context["applies_to"] not in self.VALID_APPLIES_TO:
                self.issues.append(
                    ValidationIssue(
                        ValidationLevel.ERROR,
                        file_path,
                        rule_id,
                        "context.applies_to",
                        f"Invalid applies_to. Must be one of: {', '.join(self.VALID_APPLIES_TO)}",
                    )
                )

        # Validate conversation_stage
        if "conversation_stage" in context:
            if context["conversation_stage"] not in self.VALID_CONVERSATION_STAGES:
                self.issues.append(
                    ValidationIssue(
                        ValidationLevel.ERROR,
                        file_path,
                        rule_id,
                        "context.conversation_stage",
                        f"Invalid conversation_stage. Must be one of: {', '.join(self.VALID_CONVERSATION_STAGES)}",
                    )
                )

        # Validate models
        if "models" in context:
            models = context["models"]
            if isinstance(models, str):
                if models not in ["all"]:
                    self.issues.append(
                        ValidationIssue(
                            ValidationLevel.INFO,
                            file_path,
                            rule_id,
                            "context.models",
                            f"Specific model '{models}' - ensure it's supported",
                        )
                    )
            elif isinstance(models, list):
                for model in models:
                    if not isinstance(model, str):
                        self.issues.append(
                            ValidationIssue(
                                ValidationLevel.ERROR,
                                file_path,
                                rule_id,
                                "context.models",
                                "Model names must be strings",
                            )
                        )

    def _validate_response(self, response: Any, file_path: str, rule_id: str):
        """Validate response section."""
        if not isinstance(response, dict):
            self.issues.append(
                ValidationIssue(
                    ValidationLevel.ERROR,
                    file_path,
                    rule_id,
                    "response",
                    "Response must be a dictionary",
                )
            )
            return

        # Validate action
        if "action" not in response:
            self.issues.append(
                ValidationIssue(
                    ValidationLevel.ERROR,
                    file_path,
                    rule_id,
                    "response.action",
                    "Missing required field: action",
                )
            )
        elif response["action"] not in self.VALID_ACTIONS:
            self.issues.append(
                ValidationIssue(
                    ValidationLevel.ERROR,
                    file_path,
                    rule_id,
                    "response.action",
                    f"Invalid action. Must be one of: {', '.join(self.VALID_ACTIONS)}",
                )
            )

        # Check for message
        if "message" not in response:
            self.issues.append(
                ValidationIssue(
                    ValidationLevel.WARNING,
                    file_path,
                    rule_id,
                    "response.message",
                    "Missing user-facing message",
                )
            )

    def _validate_performance(self, performance: Any, file_path: str, rule_id: str):
        """Validate performance section."""
        if not isinstance(performance, dict):
            self.issues.append(
                ValidationIssue(
                    ValidationLevel.ERROR,
                    file_path,
                    rule_id,
                    "performance",
                    "Performance must be a dictionary",
                )
            )
            return

        # Validate max_eval_time
        if "max_eval_time" in performance:
            eval_time = performance["max_eval_time"]
            if isinstance(eval_time, str):
                if not re.match(r"^\d+ms$", eval_time):
                    self.issues.append(
                        ValidationIssue(
                            ValidationLevel.ERROR,
                            file_path,
                            rule_id,
                            "performance.max_eval_time",
                            "max_eval_time must be in format like '10ms'",
                        )
                    )
                else:
                    # Extract number and check if it's within reasonable bounds
                    ms = int(eval_time[:-2])
                    if ms > 10:
                        self.issues.append(
                            ValidationIssue(
                                ValidationLevel.WARNING,
                                file_path,
                                rule_id,
                                "performance.max_eval_time",
                                f"Evaluation time {ms}ms exceeds recommended 10ms limit",
                            )
                        )

        # Validate priority
        if "priority" in performance:
            priority = performance["priority"]
            if not isinstance(priority, int) or not (1 <= priority <= 100):
                self.issues.append(
                    ValidationIssue(
                        ValidationLevel.ERROR,
                        file_path,
                        rule_id,
                        "performance.priority",
                        "Priority must be an integer between 1 and 100",
                    )
                )

    def _validate_testing(self, testing: Any, file_path: str, rule_id: str):
        """Validate testing section."""
        if not isinstance(testing, dict):
            self.issues.append(
                ValidationIssue(
                    ValidationLevel.ERROR,
                    file_path,
                    rule_id,
                    "testing",
                    "Testing must be a dictionary",
                )
            )
            return

        # Check for test cases
        if "true_positives" not in testing:
            self.issues.append(
                ValidationIssue(
                    ValidationLevel.ERROR,
                    file_path,
                    rule_id,
                    "testing.true_positives",
                    "Missing required field: true_positives",
                )
            )
        elif not isinstance(testing["true_positives"], list) or len(testing["true_positives"]) < 3:
            self.issues.append(
                ValidationIssue(
                    ValidationLevel.WARNING,
                    file_path,
                    rule_id,
                    "testing.true_positives",
                    "Should have at least 3 true positive test cases",
                )
            )

        if "true_negatives" not in testing:
            self.issues.append(
                ValidationIssue(
                    ValidationLevel.ERROR,
                    file_path,
                    rule_id,
                    "testing.true_negatives",
                    "Missing required field: true_negatives",
                )
            )
        elif not isinstance(testing["true_negatives"], list) or len(testing["true_negatives"]) < 3:
            self.issues.append(
                ValidationIssue(
                    ValidationLevel.WARNING,
                    file_path,
                    rule_id,
                    "testing.true_negatives",
                    "Should have at least 3 true negative test cases",
                )
            )

        # Validate target_false_positive_rate
        if "target_false_positive_rate" in testing:
            fpr = testing["target_false_positive_rate"]
            if not isinstance(fpr, (int, float)) or not (0.0 <= fpr <= 1.0):
                self.issues.append(
                    ValidationIssue(
                        ValidationLevel.ERROR,
                        file_path,
                        rule_id,
                        "testing.target_false_positive_rate",
                        "target_false_positive_rate must be a number between 0.0 and 1.0",
                    )
                )
            elif fpr > 0.01:
                self.issues.append(
                    ValidationIssue(
                        ValidationLevel.WARNING,
                        file_path,
                        rule_id,
                        "testing.target_false_positive_rate",
                        f"False positive rate {fpr} exceeds recommended 1% (0.01) threshold",
                    )
                )


def main():
    """Main validation function."""
    if len(sys.argv) < 2:
        print("Usage: python validate_rules.py <rules_directory>")
        sys.exit(1)

    rules_dir = Path(sys.argv[1])
    if not rules_dir.exists():
        print(f"Error: Rules directory {rules_dir} does not exist")
        sys.exit(1)

    validator = RuleValidator()
    all_issues = []

    # Find all YAML/YML files
    rule_files = list(rules_dir.rglob("*.yml")) + list(rules_dir.rglob("*.yaml"))

    print(f"Validating {len(rule_files)} rule files...")
    print("=" * 60)

    for rule_file in sorted(rule_files):
        print(f"\nValidating: {rule_file.relative_to(rules_dir)}")
        issues = validator.validate_rule_file(rule_file)
        all_issues.extend(issues)

        if not issues:
            print("  ✅ No issues found")
        else:
            for issue in issues:
                icon = (
                    "❌"
                    if issue.level == ValidationLevel.ERROR
                    else "⚠️" if issue.level == ValidationLevel.WARNING else "ℹ️"
                )
                print(f"  {icon} {issue.level.value}: {issue.field} - {issue.message}")

    # Summary
    print("\n" + "=" * 60)
    print("VALIDATION SUMMARY")
    print("=" * 60)

    error_count = sum(1 for issue in all_issues if issue.level == ValidationLevel.ERROR)
    warning_count = sum(1 for issue in all_issues if issue.level == ValidationLevel.WARNING)
    info_count = sum(1 for issue in all_issues if issue.level == ValidationLevel.INFO)

    print(f"Files validated: {len(rule_files)}")
    print(f"Total issues: {len(all_issues)}")
    print(f"  Errors: {error_count}")
    print(f"  Warnings: {warning_count}")
    print(f"  Info: {info_count}")

    if error_count > 0:
        print("\n❌ Validation FAILED - Please fix errors before proceeding")
        sys.exit(1)
    elif warning_count > 0:
        print("\n⚠️ Validation completed with warnings - Review recommended")
        sys.exit(0)
    else:
        print("\n✅ All rules are valid!")
        sys.exit(0)


if __name__ == "__main__":
    main()
