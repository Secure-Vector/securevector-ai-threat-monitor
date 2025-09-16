"""
SecureVector AI Threat Monitor SDK

A comprehensive AI security monitoring toolkit that protects applications from:
- Prompt injection attacks
- Data exfiltration attempts  
- Jailbreak attempts
- Social engineering
- System override attempts

Supports multiple modes:
- Local mode (bundled rules, offline)
- API mode (enhanced detection via api.securevector.io)
- Hybrid mode (intelligent switching)

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

from .client import SecureVectorClient
from .async_client import AsyncSecureVectorClient
from .models.analysis_result import AnalysisResult, ThreatDetection
from .models.threat_types import ThreatType, RiskLevel
from .models.config_models import SDKConfig, ModeConfig
from .models.policy_models import SecurityPolicy, PolicyRule
from .types import (
    # Type definitions for better IDE support
    OperationModeType, LogLevelType, DetectionMethodType, PolicyActionType,
    SDKConfigDict, AnalysisResultDict, StatisticsDict, HealthStatusDict,
    BaseSecureVectorClient, AsyncBaseSecureVectorClient,
    ThreatAnalyzer, AsyncThreatAnalyzer
)

# Import zero-config utilities
from utils.auto_config import (
    create_zero_config_client, create_zero_config_async_client,
    get_auto_configurator
)

# Main public interface
__version__ = "1.0.0"
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
    "AsyncThreatAnalyzer"
]

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

