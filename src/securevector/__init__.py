"""
SecureVector AI Threat Monitor SDK

A comprehensive AI security monitoring toolkit that protects applications from:
- Prompt injection attacks
- Data exfiltration attempts
- Jailbreak attempts
- Social engineering
- System override attempts

Supports multiple modes:
- Local mode (community rules, offline)
- API mode (enhanced detection via api.securevector.io)
- Hybrid mode (intelligent switching)

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

# Import zero-config utilities
from .utils.auto_config import (
    create_zero_config_async_client,
    create_zero_config_client,
    get_auto_configurator,
)

from .async_client import AsyncSecureVectorClient
from .client import SecureVectorClient
from .models.analysis_result import AnalysisResult, ThreatDetection
from .models.config_models import ModeConfig, SDKConfig
from .models.policy_models import PolicyRule, SecurityPolicy
from .models.threat_types import RiskLevel, ThreatType
from .types import (  # Type definitions for better IDE support
    AnalysisResultDict,
    AsyncBaseSecureVectorClient,
    AsyncThreatAnalyzer,
    BaseSecureVectorClient,
    DetectionMethodType,
    HealthStatusDict,
    LogLevelType,
    OperationModeType,
    PolicyActionType,
    SDKConfigDict,
    StatisticsDict,
    ThreatAnalyzer,
)

# MCP Server imports (optional - only if MCP dependencies available)
try:
    from .mcp import (
        SecureVectorMCPServer,
        MCPServerConfig,
        create_mcp_server,
        check_mcp_dependencies,
        MCP_AVAILABLE,
    )
    _MCP_IMPORTS_AVAILABLE = True
except ImportError:
    # MCP dependencies not installed
    _MCP_IMPORTS_AVAILABLE = False
    MCP_AVAILABLE = False

    def create_mcp_server(*args, **kwargs):
        raise ImportError(
            "MCP dependencies not installed. Install with: "
            "pip install securevector-ai-monitor[mcp]"
        )

    def check_mcp_dependencies():
        return False

# Main public interface
__version__ = "1.1.0"
__all__ = [
    # Core clients
    "SecureVectorClient",
    "AsyncSecureVectorClient",
    # Zero-config clients (recommended)
    "create_zero_config_client",
    "create_zero_config_async_client",
    "get_auto_configurator",
    # Result models
    "AnalysisResult",
    "ThreatDetection",
    # Configuration models
    "ThreatType",
    "RiskLevel",
    "SDKConfig",
    "ModeConfig",
    "SecurityPolicy",
    "PolicyRule",
    # MCP Server (optional)
    "create_mcp_server",
    "check_mcp_dependencies",
    "MCP_AVAILABLE",
    # Type definitions for IDE support
    "OperationModeType",
    "LogLevelType",
    "DetectionMethodType",
    "PolicyActionType",
    "SDKConfigDict",
    "AnalysisResultDict",
    "StatisticsDict",
    "HealthStatusDict",
    "BaseSecureVectorClient",
    "AsyncBaseSecureVectorClient",
    "ThreatAnalyzer",
    "AsyncThreatAnalyzer",
]

# Add MCP exports to __all__ if available
if _MCP_IMPORTS_AVAILABLE:
    __all__.extend([
        "SecureVectorMCPServer",
        "MCPServerConfig",
    ])


# Convenience functions for quick setup
def create_client(mode="auto", api_key=None, **kwargs):
    """Create a SecureVectorClient with specified configuration"""
    return SecureVectorClient(mode=mode, api_key=api_key, **kwargs)


def create_async_client(mode="auto", api_key=None, **kwargs):
    """Create an AsyncSecureVectorClient with specified configuration"""
    return AsyncSecureVectorClient(mode=mode, api_key=api_key, **kwargs)


def analyze_prompt(prompt, mode="auto", api_key=None, **kwargs):
    """Quick analysis of a single prompt"""
    client = create_client(mode=mode, api_key=api_key, **kwargs)
    return client.analyze(prompt)


async def analyze_prompt_async(prompt, mode="auto", api_key=None, **kwargs):
    """Quick async analysis of a single prompt"""
    async with create_async_client(mode=mode, api_key=api_key, **kwargs) as client:
        return await client.analyze(prompt)
