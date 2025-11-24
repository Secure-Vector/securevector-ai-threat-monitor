"""
MCP Resource: Threat Detection Rules

This module provides the rules MCP resource for SecureVector AI Threat Monitor,
enabling LLMs to access threat detection rules and patterns through MCP.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import os
import yaml
from typing import Any, Dict, List, Optional, TYPE_CHECKING
from pathlib import Path

try:
    from mcp.server.fastmcp import FastMCP
    from mcp.server.session import ServerSession
    from mcp import types
    MCP_AVAILABLE = True
except ImportError:
    MCP_AVAILABLE = False

from securevector.utils.logger import get_logger
from securevector.utils.exceptions import SecurityException, APIError

if TYPE_CHECKING:
    from securevector.mcp.server import SecureVectorMCPServer


logger = get_logger(__name__)


def setup_rules_resource(mcp: "FastMCP", server: "SecureVectorMCPServer"):
    """Setup the rules MCP resource."""

    @mcp.resource("rules://category/{category}")
    async def get_rules_by_category(category: str) -> str:
        """
        Access threat detection rules by category.

        This resource provides read-only access to SecureVector's threat detection
        rules, organized by security category. Rules are sanitized to remove
        sensitive patterns while maintaining educational and analytical value.

        Args:
            category: Rule category - "prompt_injection", "data_exfiltration",
                     "social_engineering", "content_safety", "all"

        Returns:
            YAML-formatted string containing rule definitions for the category

        Example URI: rules://category/prompt_injection

        Available Categories:
        - prompt_injection: Rules for detecting prompt injection attacks
        - data_exfiltration: Rules for detecting data extraction attempts
        - social_engineering: Rules for detecting social engineering attacks
        - content_safety: Rules for detecting harmful content requests
        - all: All available rules (may be large)

        Rule Format:
        ```yaml
        rules:
          - rule:
              id: "rule_identifier"
              name: "Human Readable Name"
              category: "threat_category"
              severity: "critical|high|medium|low"
              description: "Rule description"
              examples:
                - "Example threat pattern"
              detection_methods:
                - "pattern_matching"
                - "heuristic_analysis"
        ```

        Security Note:
        - Actual regex patterns are sanitized for security
        - Only rule metadata and examples are exposed
        - No sensitive detection logic is revealed
        """
        client_id = "mcp_client"

        try:
            # Log the request
            server.audit_logger.log_request(client_id, "get_rules_by_category", {
                "category": category
            })

            logger.info(f"Fetching rules for category: {category}")

            # Validate category
            valid_categories = [
                "prompt_injection", "data_exfiltration", "social_engineering",
                "content_safety", "data_leakage", "all"
            ]

            if category not in valid_categories:
                raise SecurityException(
                    f"Invalid category: {category}. Valid categories: {', '.join(valid_categories)}",
                    error_code="INVALID_CATEGORY"
                )

            # Get sanitized rules
            rules_data = await _get_sanitized_rules(category, server)

            if not rules_data:
                return _create_empty_rules_response(category)

            # Convert to YAML
            yaml_content = yaml.dump(rules_data, default_flow_style=False, indent=2)

            # Log successful response
            server.audit_logger.log_response(
                client_id, "get_rules_by_category", True, 0
            )

            return yaml_content

        except (SecurityException, APIError) as e:
            server.audit_logger.log_response(
                client_id, "get_rules_by_category", False, 0, str(e)
            )
            raise

        except Exception as e:
            error_msg = f"Failed to fetch rules for category {category}: {str(e)}"
            logger.error(error_msg)
            server.audit_logger.log_response(
                client_id, "get_rules_by_category", False, 0, error_msg
            )
            raise APIError(error_msg, error_code="RULES_FETCH_FAILED")

    @mcp.resource("rules://rule/{rule_id}")
    async def get_rule_by_id(rule_id: str) -> str:
        """
        Access a specific threat detection rule by ID.

        Args:
            rule_id: Unique rule identifier

        Returns:
            YAML-formatted string containing the specific rule definition

        Example URI: rules://rule/prompt_injection_basic_override
        """
        client_id = "mcp_client"

        try:
            server.audit_logger.log_request(client_id, "get_rule_by_id", {
                "rule_id": rule_id
            })

            logger.info(f"Fetching rule: {rule_id}")

            # Get specific rule
            rule_data = await _get_sanitized_rule_by_id(rule_id, server)

            if not rule_data:
                raise SecurityException(
                    f"Rule not found: {rule_id}",
                    error_code="RULE_NOT_FOUND"
                )

            # Convert to YAML
            yaml_content = yaml.dump({"rule": rule_data}, default_flow_style=False, indent=2)

            server.audit_logger.log_response(
                client_id, "get_rule_by_id", True, 0
            )

            return yaml_content

        except (SecurityException, APIError) as e:
            server.audit_logger.log_response(
                client_id, "get_rule_by_id", False, 0, str(e)
            )
            raise

        except Exception as e:
            error_msg = f"Failed to fetch rule {rule_id}: {str(e)}"
            logger.error(error_msg)
            server.audit_logger.log_response(
                client_id, "get_rule_by_id", False, 0, error_msg
            )
            raise APIError(error_msg, error_code="RULE_FETCH_FAILED")

    @mcp.resource("rules://index")
    async def get_rules_index() -> str:
        """
        Get an index of available rule categories and counts.

        Returns:
            YAML-formatted index of all available rules

        Example URI: rules://index
        """
        client_id = "mcp_client"

        try:
            server.audit_logger.log_request(client_id, "get_rules_index", {})

            logger.info("Generating rules index")

            # Generate rules index
            index_data = await _generate_rules_index(server)

            # Convert to YAML
            yaml_content = yaml.dump(index_data, default_flow_style=False, indent=2)

            server.audit_logger.log_response(
                client_id, "get_rules_index", True, 0
            )

            return yaml_content

        except Exception as e:
            error_msg = f"Failed to generate rules index: {str(e)}"
            logger.error(error_msg)
            server.audit_logger.log_response(
                client_id, "get_rules_index", False, 0, error_msg
            )
            raise APIError(error_msg, error_code="INDEX_GENERATION_FAILED")


async def _get_sanitized_rules(category: str, server: "SecureVectorMCPServer") -> Dict[str, Any]:
    """Get sanitized rules for a category."""
    try:
        # Find rules directory
        rules_dir = _find_rules_directory()
        if not rules_dir:
            logger.warning("Rules directory not found, returning sample rules")
            return _get_sample_rules(category)

        # Load rules based on category
        if category == "all":
            return await _load_all_rules(rules_dir)
        else:
            return await _load_category_rules(rules_dir, category)

    except Exception as e:
        logger.error(f"Error loading rules: {e}")
        return _get_sample_rules(category)


async def _get_sanitized_rule_by_id(rule_id: str, server: "SecureVectorMCPServer") -> Optional[Dict[str, Any]]:
    """Get a specific sanitized rule by ID."""
    try:
        rules_dir = _find_rules_directory()
        if not rules_dir:
            return None

        # Search for rule across all files
        for rule_file in rules_dir.glob("**/*.yml"):
            try:
                with open(rule_file, 'r') as f:
                    rules_data = yaml.safe_load(f)

                if "rules" in rules_data:
                    for rule in rules_data["rules"]:
                        # Support both old format ({"rule": {...}}) and community format (direct entry)
                        rule_obj = rule.get("rule", rule)  # Use nested or direct format
                        if rule_obj.get("id") == rule_id:
                            return _sanitize_rule(rule_obj)
            except Exception as e:
                logger.warning(f"Error reading rule file {rule_file}: {e}")
                continue

        return None

    except Exception as e:
        logger.error(f"Error searching for rule {rule_id}: {e}")
        return None


def _find_rules_directory() -> Optional[Path]:
    """Find the rules directory in the SecureVector package."""
    try:
        # Look for rules in the package
        import securevector
        package_dir = Path(securevector.__file__).parent
        rules_dir = package_dir / "rules" / "community"

        if rules_dir.exists():
            return rules_dir

        # Alternative locations
        alternative_paths = [
            Path(__file__).parent.parent.parent / "rules" / "community",
            Path.cwd() / "src" / "securevector" / "rules" / "community",
        ]

        for path in alternative_paths:
            if path.exists():
                return path

        return None

    except Exception as e:
        logger.error(f"Error finding rules directory: {e}")
        return None


async def _load_all_rules(rules_dir: Path) -> Dict[str, Any]:
    """Load all rules from the rules directory."""
    all_rules = {"rules": []}

    for rule_file in rules_dir.glob("*.yml"):
        try:
            with open(rule_file, 'r') as f:
                rules_data = yaml.safe_load(f)

            if "rules" in rules_data:
                for rule in rules_data["rules"]:
                    # Support both old format ({"rule": {...}}) and community format (direct entry)
                    rule_obj = rule.get("rule", rule)  # Use nested or direct format
                    sanitized_rule = _sanitize_rule(rule_obj)
                    all_rules["rules"].append({"rule": sanitized_rule})

        except Exception as e:
            logger.warning(f"Error loading rule file {rule_file}: {e}")
            continue

    return all_rules


async def _load_category_rules(rules_dir: Path, category: str) -> Dict[str, Any]:
    """Load rules for a specific category."""
    category_rules = {"rules": []}

    # Map category to file names (community rule files)
    category_files = {
        "prompt_injection": ["sv_community_prompt_injection.yml"],
        "data_exfiltration": ["sv_community_data_extraction.yml"],
        "social_engineering": ["sv_community_social_engineering.yml"],
        "content_safety": ["sv_community_harmful_content.yml"],
        "data_leakage": ["sv_community_pii_detection.yml"],
    }

    files_to_check = category_files.get(category, [f"{category}.yml", f"{category}.yaml"])

    for filename in files_to_check:
        rule_file = rules_dir / filename
        if rule_file.exists():
            try:
                with open(rule_file, 'r') as f:
                    rules_data = yaml.safe_load(f)

                if "rules" in rules_data:
                    for rule in rules_data["rules"]:
                        # Support both old format ({"rule": {...}}) and community format (direct entry)
                        rule_obj = rule.get("rule", rule)  # Use nested or direct format
                        sanitized_rule = _sanitize_rule(rule_obj)
                        category_rules["rules"].append({"rule": sanitized_rule})

            except Exception as e:
                logger.warning(f"Error loading category file {rule_file}: {e}")
                continue

    return category_rules


def _sanitize_rule(rule: Dict[str, Any]) -> Dict[str, Any]:
    """Sanitize a rule by removing sensitive detection patterns."""
    sanitized = {
        "id": rule.get("id", "unknown"),
        "name": rule.get("name", "Unknown Rule"),
        "category": rule.get("category", "unknown"),
        "severity": rule.get("severity", "medium"),
        "confidence": rule.get("confidence", 0.5),
    }

    # Add description if available
    if "description" in rule:
        sanitized["description"] = rule["description"]

    # Add attack examples if available
    if "attack_examples" in rule:
        sanitized["attack_examples"] = rule["attack_examples"]

    # Add testing examples (sanitized)
    # Support both old format ("testing") and community format ("test_cases")
    if "testing" in rule and "true_positives" in rule["testing"]:
        sanitized["example_threats"] = rule["testing"]["true_positives"][:3]  # Limit to 3 examples
    elif "test_cases" in rule:
        # Community format: extract inputs where expected_result is "match"
        true_positives = [
            tc.get("input") for tc in rule["test_cases"]
            if tc.get("expected_result") == "match"
        ][:3]
        if true_positives:
            sanitized["example_threats"] = true_positives

    if "testing" in rule and "true_negatives" in rule["testing"]:
        sanitized["example_safe_inputs"] = rule["testing"]["true_negatives"][:3]
    elif "test_cases" in rule:
        # Community format: extract inputs where expected_result is "no_match"
        true_negatives = [
            tc.get("input") for tc in rule["test_cases"]
            if tc.get("expected_result") == "no_match"
        ][:3]
        if true_negatives:
            sanitized["example_safe_inputs"] = true_negatives

    # Add metadata about detection methods (without actual patterns)
    if "detection" in rule:
        detection_methods = []
        for detection in rule["detection"]:
            if detection.get("type") == "pattern":
                detection_methods.append("pattern_matching")
            elif detection.get("type") == "heuristic":
                detection_methods.append("heuristic_analysis")
            elif detection.get("type") == "ml":
                detection_methods.append("ml_classification")

        sanitized["detection_methods"] = list(set(detection_methods))

    # Add performance info if available
    if "performance" in rule:
        perf = rule["performance"]
        sanitized["performance_info"] = {
            "max_eval_time": perf.get("max_eval_time", "unknown"),
            "priority": perf.get("priority", "normal"),
        }

    return sanitized


def _get_sample_rules(category: str) -> Dict[str, Any]:
    """Get sample rules when actual rules aren't available."""
    sample_rules = {
        "rules": [
            {
                "rule": {
                    "id": f"sample_{category}_rule",
                    "name": f"Sample {category.replace('_', ' ').title()} Rule",
                    "category": category,
                    "severity": "medium",
                    "confidence": 0.75,
                    "description": f"Sample rule for {category} detection",
                    "detection_methods": ["pattern_matching"],
                    "example_threats": [
                        "Sample threat pattern",
                        "Another example threat"
                    ],
                    "example_safe_inputs": [
                        "Safe input example",
                        "Another safe example"
                    ]
                }
            }
        ]
    }

    return sample_rules


async def _generate_rules_index(server: "SecureVectorMCPServer") -> Dict[str, Any]:
    """Generate an index of all available rules."""
    rules_dir = _find_rules_directory()

    index = {
        "rules_index": {
            "generated_at": "2025-01-15T00:00:00Z",
            "total_categories": 0,
            "total_rules": 0,
            "categories": {}
        }
    }

    if not rules_dir:
        # Return sample index
        index["rules_index"]["categories"] = {
            "prompt_injection": {"count": 12, "description": "Prompt injection attack detection"},
            "data_exfiltration": {"count": 8, "description": "Data extraction attempt detection"},
            "social_engineering": {"count": 6, "description": "Social engineering attack detection"},
            "content_safety": {"count": 4, "description": "Harmful content detection"},
        }
        index["rules_index"]["total_categories"] = 4
        index["rules_index"]["total_rules"] = 30
        return index

    # Count actual rules
    category_counts = {}
    total_rules = 0

    for rule_file in rules_dir.glob("*.yml"):
        try:
            with open(rule_file, 'r') as f:
                rules_data = yaml.safe_load(f)

            if "rules" in rules_data:
                category = rule_file.stem
                count = len(rules_data["rules"])
                category_counts[category] = {
                    "count": count,
                    "description": f"{category.replace('_', ' ').title()} detection rules"
                }
                total_rules += count

        except Exception as e:
            logger.warning(f"Error counting rules in {rule_file}: {e}")
            continue

    index["rules_index"]["categories"] = category_counts
    index["rules_index"]["total_categories"] = len(category_counts)
    index["rules_index"]["total_rules"] = total_rules

    return index


def _create_empty_rules_response(category: str) -> str:
    """Create an empty rules response."""
    empty_response = {
        "rules": [],
        "message": f"No rules found for category: {category}",
        "available_categories": [
            "prompt_injection", "data_exfiltration", "social_engineering",
            "content_safety", "data_leakage"
        ]
    }

    return yaml.dump(empty_response, default_flow_style=False, indent=2)


class RulesResource:
    """
    Standalone class for the rules resource.
    Useful for testing and direct integration.
    """

    def __init__(self, server: "SecureVectorMCPServer"):
        self.server = server
        self.logger = get_logger(__name__)

    async def get_category_rules(self, category: str) -> Dict[str, Any]:
        """Get rules for a category (direct method)."""
        try:
            return await _get_sanitized_rules(category, self.server)
        except Exception as e:
            self.logger.error(f"Failed to get rules for category {category}: {e}")
            return {"error": str(e), "rules": []}

    async def get_rules_summary(self) -> Dict[str, Any]:
        """Get a summary of available rules."""
        try:
            return await _generate_rules_index(self.server)
        except Exception as e:
            self.logger.error(f"Failed to generate rules summary: {e}")
            return {"error": str(e), "rules_index": {}}
