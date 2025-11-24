"""
MCP Resources for SecureVector AI Threat Monitor

This module contains MCP resource implementations that provide read-only access
to SecureVector's threat detection rules and security policies.

Available Resources:
- rules://category/{category}: Access threat detection rules by category
- policy://template/{template}: Security policy templates

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

try:
    from .rules import RulesResource
    from .policies import PoliciesResource

    MCP_RESOURCES_AVAILABLE = True
except ImportError:
    MCP_RESOURCES_AVAILABLE = False

    # Dummy classes for when MCP is not available
    class RulesResource:
        def __init__(self):
            raise ImportError("MCP resources require mcp package to be installed")

    class PoliciesResource:
        def __init__(self):
            raise ImportError("MCP resources require mcp package to be installed")

__all__ = [
    "RulesResource",
    "PoliciesResource",
    "MCP_RESOURCES_AVAILABLE",
]
