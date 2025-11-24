"""
MCP Tools for SecureVector AI Threat Monitor

This module contains MCP tool implementations that expose SecureVector's
threat analysis capabilities to LLMs through the Model Context Protocol.

Available Tools:
- analyze_prompt: Single prompt threat analysis
- batch_analyze: Batch processing of multiple prompts
- get_threat_statistics: Aggregated threat detection metrics

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

try:
    from .analyze_prompt import AnalyzePromptTool
    from .batch_analysis import BatchAnalysisTool
    from .threat_stats import ThreatStatisticsTool

    MCP_TOOLS_AVAILABLE = True
except ImportError:
    MCP_TOOLS_AVAILABLE = False

    # Dummy classes for when MCP is not available
    class AnalyzePromptTool:
        def __init__(self):
            raise ImportError("MCP tools require mcp package to be installed")

    class BatchAnalysisTool:
        def __init__(self):
            raise ImportError("MCP tools require mcp package to be installed")

    class ThreatStatisticsTool:
        def __init__(self):
            raise ImportError("MCP tools require mcp package to be installed")

__all__ = [
    "AnalyzePromptTool",
    "BatchAnalysisTool",
    "ThreatStatisticsTool",
    "MCP_TOOLS_AVAILABLE",
]
