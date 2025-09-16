"""
Policy configuration models for AI threat detection.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Union

from .threat_types import RiskLevel, ThreatType


class PolicyAction(Enum):
    """Actions that can be taken when a policy is triggered"""

    ALLOW = "allow"
    WARN = "warn"
    BLOCK = "block"
    LOG_ONLY = "log_only"
    CUSTOM = "custom"


class PolicyCondition(Enum):
    """Conditions for policy evaluation"""

    RISK_SCORE_ABOVE = "risk_score_above"
    RISK_SCORE_BELOW = "risk_score_below"
    THREAT_TYPE_MATCHES = "threat_type_matches"
    CONFIDENCE_ABOVE = "confidence_above"
    CONFIDENCE_BELOW = "confidence_below"
    PATTERN_MATCHES = "pattern_matches"
    CUSTOM_CONDITION = "custom_condition"


@dataclass
class PolicyRule:
    """Individual policy rule definition"""

    name: str
    description: str
    condition: PolicyCondition
    condition_value: Union[int, float, str, List[str]]
    action: PolicyAction
    priority: int = 100  # Lower numbers = higher priority
    enabled: bool = True
    metadata: Dict[str, Any] = field(default_factory=dict)

    def evaluate(
        self, risk_score: int, threat_types: List[str], confidence: float, prompt: str = ""
    ) -> bool:
        """Evaluate if this rule matches the given analysis result"""
        try:
            if self.condition == PolicyCondition.RISK_SCORE_ABOVE:
                return risk_score > int(self.condition_value)
            elif self.condition == PolicyCondition.RISK_SCORE_BELOW:
                return risk_score < int(self.condition_value)
            elif self.condition == PolicyCondition.THREAT_TYPE_MATCHES:
                if isinstance(self.condition_value, str):
                    return self.condition_value in threat_types
                elif isinstance(self.condition_value, list):
                    return any(t in threat_types for t in self.condition_value)
            elif self.condition == PolicyCondition.CONFIDENCE_ABOVE:
                return confidence > float(self.condition_value)
            elif self.condition == PolicyCondition.CONFIDENCE_BELOW:
                return confidence < float(self.condition_value)
            elif self.condition == PolicyCondition.PATTERN_MATCHES:
                import re

                pattern = str(self.condition_value)
                return bool(re.search(pattern, prompt, re.IGNORECASE))
            elif self.condition == PolicyCondition.CUSTOM_CONDITION:
                # Custom conditions would be handled by subclasses
                return False
        except (ValueError, TypeError):
            return False

        return False


@dataclass
class SecurityPolicy:
    """Complete security policy configuration"""

    name: str
    description: str
    version: str = "1.0.0"
    rules: List[PolicyRule] = field(default_factory=list)
    default_action: PolicyAction = PolicyAction.ALLOW
    enabled: bool = True
    metadata: Dict[str, Any] = field(default_factory=dict)

    def add_rule(self, rule: PolicyRule) -> None:
        """Add a policy rule"""
        self.rules.append(rule)
        # Keep rules sorted by priority (lower number = higher priority)
        self.rules.sort(key=lambda r: r.priority)

    def remove_rule(self, rule_name: str) -> bool:
        """Remove a policy rule by name"""
        for i, rule in enumerate(self.rules):
            if rule.name == rule_name:
                del self.rules[i]
                return True
        return False

    def get_rule(self, rule_name: str) -> Optional[PolicyRule]:
        """Get a policy rule by name"""
        for rule in self.rules:
            if rule.name == rule_name:
                return rule
        return None

    def evaluate(
        self, risk_score: int, threat_types: List[str], confidence: float, prompt: str = ""
    ) -> PolicyAction:
        """Evaluate policy and return the action to take"""
        if not self.enabled:
            return self.default_action

        # Evaluate rules in priority order (lower number = higher priority)
        for rule in sorted(self.rules, key=lambda r: r.priority):
            if rule.enabled and rule.evaluate(risk_score, threat_types, confidence, prompt):
                return rule.action

        return self.default_action

    @classmethod
    def create_default_policy(cls) -> "SecurityPolicy":
        """Create a default security policy"""
        policy = cls(
            name="Default Security Policy",
            description="Standard security policy with balanced threat detection",
            version="1.0.0",
        )

        # High-risk threats - block immediately
        policy.add_rule(
            PolicyRule(
                name="block_critical_threats",
                description="Block threats with critical risk scores",
                condition=PolicyCondition.RISK_SCORE_ABOVE,
                condition_value=80,
                action=PolicyAction.BLOCK,
                priority=10,
            )
        )

        # Medium-risk threats - warn but allow
        policy.add_rule(
            PolicyRule(
                name="warn_medium_threats",
                description="Warn on medium risk threats",
                condition=PolicyCondition.RISK_SCORE_ABOVE,
                condition_value=50,
                action=PolicyAction.WARN,
                priority=20,
            )
        )

        # Specific threat types
        policy.add_rule(
            PolicyRule(
                name="block_prompt_injection",
                description="Block prompt injection attempts",
                condition=PolicyCondition.THREAT_TYPE_MATCHES,
                condition_value=ThreatType.PROMPT_INJECTION.value,
                action=PolicyAction.BLOCK,
                priority=15,
            )
        )

        policy.add_rule(
            PolicyRule(
                name="block_data_exfiltration",
                description="Block data exfiltration attempts",
                condition=PolicyCondition.THREAT_TYPE_MATCHES,
                condition_value=ThreatType.DATA_EXFILTRATION.value,
                action=PolicyAction.BLOCK,
                priority=15,
            )
        )

        return policy

    @classmethod
    def create_strict_policy(cls) -> "SecurityPolicy":
        """Create a strict security policy"""
        policy = cls(
            name="Strict Security Policy",
            description="High-security policy with aggressive threat blocking",
            version="1.0.0",
        )

        # Block anything above 40
        policy.add_rule(
            PolicyRule(
                name="block_low_risk_threats",
                description="Block even low-risk threats",
                condition=PolicyCondition.RISK_SCORE_ABOVE,
                condition_value=40,
                action=PolicyAction.BLOCK,
                priority=10,
            )
        )

        # Block all known threat types
        for threat_type in [
            ThreatType.PROMPT_INJECTION,
            ThreatType.DATA_EXFILTRATION,
            ThreatType.JAILBREAK,
            ThreatType.SOCIAL_ENGINEERING,
            ThreatType.SYSTEM_OVERRIDE,
        ]:
            policy.add_rule(
                PolicyRule(
                    name=f"block_{threat_type.value}",
                    description=f"Block {threat_type.value} attempts",
                    condition=PolicyCondition.THREAT_TYPE_MATCHES,
                    condition_value=threat_type.value,
                    action=PolicyAction.BLOCK,
                    priority=5,
                )
            )

        return policy

    @classmethod
    def create_permissive_policy(cls) -> "SecurityPolicy":
        """Create a permissive security policy"""
        policy = cls(
            name="Permissive Security Policy",
            description="Lenient policy that only blocks critical threats",
            version="1.0.0",
        )

        # Only block very high-risk threats
        policy.add_rule(
            PolicyRule(
                name="block_critical_only",
                description="Block only critical threats",
                condition=PolicyCondition.RISK_SCORE_ABOVE,
                condition_value=90,
                action=PolicyAction.BLOCK,
                priority=10,
            )
        )

        # Log everything else
        policy.add_rule(
            PolicyRule(
                name="log_all_others",
                description="Log all other threats",
                condition=PolicyCondition.RISK_SCORE_ABOVE,
                condition_value=0,
                action=PolicyAction.LOG_ONLY,
                priority=100,
            )
        )

        return policy

    def to_dict(self) -> Dict[str, Any]:
        """Convert policy to dictionary"""
        return {
            "name": self.name,
            "description": self.description,
            "version": self.version,
            "enabled": self.enabled,
            "default_action": self.default_action.value,
            "rules": [
                {
                    "name": rule.name,
                    "description": rule.description,
                    "condition": rule.condition.value,
                    "condition_value": rule.condition_value,
                    "action": rule.action.value,
                    "priority": rule.priority,
                    "enabled": rule.enabled,
                    "metadata": rule.metadata,
                }
                for rule in self.rules
            ],
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SecurityPolicy":
        """Create policy from dictionary"""
        policy = cls(
            name=data["name"],
            description=data["description"],
            version=data.get("version", "1.0.0"),
            enabled=data.get("enabled", True),
            default_action=PolicyAction(data.get("default_action", "allow")),
            metadata=data.get("metadata", {}),
        )

        for rule_data in data.get("rules", []):
            rule = PolicyRule(
                name=rule_data["name"],
                description=rule_data["description"],
                condition=PolicyCondition(rule_data["condition"]),
                condition_value=rule_data["condition_value"],
                action=PolicyAction(rule_data["action"]),
                priority=rule_data.get("priority", 100),
                enabled=rule_data.get("enabled", True),
                metadata=rule_data.get("metadata", {}),
            )
            policy.add_rule(rule)

        return policy
