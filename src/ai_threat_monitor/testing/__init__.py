"""
Testing utilities for the SecureVector AI Threat Monitor SDK.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

from .assertions import (
    assert_analysis_time,
    assert_is_safe,
    assert_is_threat,
    assert_risk_score,
    assert_threat_types,
)
from .fixtures import (
    TestDataGenerator,
    ThreatScenario,
    create_test_config,
    create_test_prompts,
    create_test_results,
)
from .mock_client import MockAsyncSecureVectorClient, MockBehavior, MockSecureVectorClient

__all__ = [
    "MockSecureVectorClient",
    "MockAsyncSecureVectorClient",
    "MockBehavior",
    "create_test_prompts",
    "create_test_results",
    "create_test_config",
    "ThreatScenario",
    "TestDataGenerator",
    "assert_is_threat",
    "assert_is_safe",
    "assert_risk_score",
    "assert_threat_types",
    "assert_analysis_time",
]
