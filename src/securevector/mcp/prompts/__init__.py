"""
MCP Prompts for SecureVector AI Threat Monitor

This module contains MCP prompt template implementations that provide
pre-defined workflows for AI security analysis and assessment.

Available Prompts:
- threat_analysis_workflow: Comprehensive threat analysis template
- security_audit_checklist: Security audit and assessment template
- risk_assessment_guide: Risk evaluation workflow template

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

try:
    from .templates import (
        ThreatAnalysisTemplate,
        SecurityAuditTemplate,
        RiskAssessmentTemplate,
    )

    MCP_PROMPTS_AVAILABLE = True
except ImportError:
    MCP_PROMPTS_AVAILABLE = False

    # Dummy classes for when MCP is not available
    class ThreatAnalysisTemplate:
        def __init__(self):
            raise ImportError("MCP prompts require mcp package to be installed")

    class SecurityAuditTemplate:
        def __init__(self):
            raise ImportError("MCP prompts require mcp package to be installed")

    class RiskAssessmentTemplate:
        def __init__(self):
            raise ImportError("MCP prompts require mcp package to be installed")

__all__ = [
    "ThreatAnalysisTemplate",
    "SecurityAuditTemplate",
    "RiskAssessmentTemplate",
    "MCP_PROMPTS_AVAILABLE",
]
