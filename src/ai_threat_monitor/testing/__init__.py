"""
Testing utilities for the SecureVector AI Threat Monitor SDK.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

from .mock_client import MockSecureVectorClient, MockAsyncSecureVectorClient
from .fixtures import (
    create_test_prompts, create_test_results, create_test_config,
    ThreatScenario, TestDataGenerator
)
from .assertions import (
    assert_is_threat, assert_is_safe, assert_risk_score,
    assert_threat_types, assert_analysis_time
)

__all__ = [
    "MockSecureVectorClient",
    "MockAsyncSecureVectorClient", 
    "create_test_prompts",
    "create_test_results",
    "create_test_config",
    "ThreatScenario",
    "TestDataGenerator",
    "assert_is_threat",
    "assert_is_safe", 
    "assert_risk_score",
    "assert_threat_types",
    "assert_analysis_time"
]

