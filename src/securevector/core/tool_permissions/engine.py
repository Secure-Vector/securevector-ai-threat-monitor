"""
Essential tool permission engine.

Evaluates tool calls against the bundled essential tool registry
and user overrides to make block/allow/log_only decisions.
"""

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import yaml

logger = logging.getLogger(__name__)

# Risk level to score mapping
RISK_SCORES = {
    "read": 20,
    "write": 50,
    "delete": 75,
    "admin": 90,
}


@dataclass
class RateLimitResult:
    """Result of checking a tool's rate limit."""

    allowed: bool
    current_count: int
    max_calls: int
    window_seconds: int
    retry_after_seconds: Optional[int] = None


@dataclass
class PermissionDecision:
    """Result of evaluating a tool call against the permission registry."""

    tool_name: Optional[str]  # Registry tool ID (e.g. "gmail.send_email")
    function_name: str  # Actual function name from LLM response
    action: str  # "block", "allow", or "log_only"
    risk: Optional[str]  # "read", "write", "delete", "admin"
    reason: str
    is_essential: bool


def load_essential_registry(yaml_path: Optional[str] = None) -> dict:
    """Load the essential tool registry from YAML.

    Searches multiple paths to work both in development and installed package.

    Args:
        yaml_path: Optional explicit path to the YAML file.

    Returns:
        Dict mapping tool_id -> tool definition dict.
    """
    if yaml_path:
        paths = [Path(yaml_path)]
    else:
        paths = [
            # When installed as package
            Path(__file__).parent.parent.parent / "rules" / "tool_permissions" / "sv_tool_essential.yml",
            # Development layout
            Path(__file__).parent.parent.parent.parent / "rules" / "tool_permissions" / "sv_tool_essential.yml",
        ]

    for p in paths:
        if p.exists():
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = yaml.safe_load(f)

                registry = {}
                for tool in data.get("essential_tools", []):
                    tool_id = tool.get("id")
                    if tool_id:
                        registry[tool_id] = tool

                logger.info(f"Loaded {len(registry)} essential tool definitions from {p}")
                return registry
            except Exception as e:
                logger.warning(f"Failed to load essential registry from {p}: {e}")

    logger.warning("Essential tool registry not found")
    return {}


def get_essential_overrides(overrides_list: list[dict]) -> dict:
    """Convert a list of override records to a lookup dict.

    Args:
        overrides_list: List of dicts with tool_id and action keys.

    Returns:
        Dict mapping tool_id -> action string.
    """
    return {
        o["tool_id"]: o["action"]
        for o in overrides_list
        if "tool_id" in o and "action" in o
    }


def evaluate_tool_call(
    function_name: str,
    essential_registry: dict,
    overrides: Optional[dict] = None,
    custom_registry: Optional[dict] = None,
) -> PermissionDecision:
    """Evaluate a single tool call against the essential and custom registries.

    Check order: essential registry -> custom registry -> log_only (pass-through).

    Args:
        function_name: The tool function name from the LLM response.
        essential_registry: Dict of essential tool definitions.
        overrides: Dict mapping tool_id -> action (from user configuration).
        custom_registry: Dict mapping tool_id -> custom tool definition dict.

    Returns:
        PermissionDecision with the enforcement action.
    """
    if overrides is None:
        overrides = {}

    # Check if function_name matches any essential tool ID exactly
    if function_name in essential_registry:
        tool = essential_registry[function_name]
        tool_id = function_name

        # Check for user override first
        if tool_id in overrides:
            action = overrides[tool_id]
            return PermissionDecision(
                tool_name=tool_id,
                function_name=function_name,
                action=action,
                risk=tool.get("risk"),
                reason=f"User override: {action}",
                is_essential=True,
            )

        # Use default from registry
        default_action = tool.get("default_permission", "block")
        return PermissionDecision(
            tool_name=tool_id,
            function_name=function_name,
            action=default_action,
            risk=tool.get("risk"),
            reason=f"Essential tool default: {default_action}",
            is_essential=True,
        )

    # Check if function_name matches the last part of a tool ID
    # e.g. "send_email" might match "gmail.send_email"
    for tool_id, tool in essential_registry.items():
        parts = tool_id.split(".")
        if len(parts) == 2 and parts[1] == function_name:
            # Exact match on the function part
            if tool_id in overrides:
                action = overrides[tool_id]
                return PermissionDecision(
                    tool_name=tool_id,
                    function_name=function_name,
                    action=action,
                    risk=tool.get("risk"),
                    reason=f"User override: {action} (matched {tool_id})",
                    is_essential=True,
                )

            default_action = tool.get("default_permission", "block")
            return PermissionDecision(
                tool_name=tool_id,
                function_name=function_name,
                action=default_action,
                risk=tool.get("risk"),
                reason=f"Essential tool default: {default_action} (matched {tool_id})",
                is_essential=True,
            )

    # Check custom tools registry
    if custom_registry and function_name in custom_registry:
        custom_tool = custom_registry[function_name]

        # Check for user override first
        if function_name in overrides:
            action = overrides[function_name]
            return PermissionDecision(
                tool_name=function_name,
                function_name=function_name,
                action=action,
                risk=custom_tool.get("risk"),
                reason=f"Custom tool override: {action}",
                is_essential=False,
            )

        default_action = custom_tool.get("default_permission", "block")
        return PermissionDecision(
            tool_name=function_name,
            function_name=function_name,
            action=default_action,
            risk=custom_tool.get("risk"),
            reason=f"Custom tool default: {default_action}",
            is_essential=False,
        )

    # Not an essential or custom tool — log only, pass through
    return PermissionDecision(
        tool_name=None,
        function_name=function_name,
        action="log_only",
        risk=None,
        reason="Non-essential tool call (logged only)",
        is_essential=False,
    )


def get_risk_score(risk: Optional[str]) -> int:
    """Get numeric risk score for a risk level.

    Args:
        risk: Risk level string.

    Returns:
        Risk score (0-100).
    """
    return RISK_SCORES.get(risk, 0)
