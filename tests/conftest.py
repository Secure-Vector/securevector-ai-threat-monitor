"""
Pytest configuration and fixtures for AI Threat Monitor tests.
"""

import pytest
import json
import os
from pathlib import Path
from unittest.mock import Mock, patch

# Add the parent directory to sys.path so we can import our modules
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from decorator import SecurityException
from local_engine import SecurityEngine, ThreatDetectionResult
from console_logger import SecurityLogger


@pytest.fixture
def security_engine():
    """Fixture providing a fresh SecurityEngine instance."""
    return SecurityEngine()


@pytest.fixture
def security_logger():
    """Fixture providing a fresh SecurityLogger instance."""
    return SecurityLogger(verbose=False)  # Disable verbose output during tests


@pytest.fixture
def malicious_prompts():
    """Load malicious test prompts from fixtures."""
    fixtures_dir = Path(__file__).parent / "fixtures"
    with open(fixtures_dir / "threats.json", "r") as f:
        return json.load(f)


@pytest.fixture
def safe_prompts():
    """Load safe test prompts from fixtures."""
    fixtures_dir = Path(__file__).parent / "fixtures"
    with open(fixtures_dir / "safe.json", "r") as f:
        return json.load(f)


@pytest.fixture
def mock_ai_response():
    """Mock AI service response for testing."""
    return {
        "choices": [
            {
                "message": {
                    "content": "This is a mock AI response for testing purposes."
                }
            }
        ]
    }


@pytest.fixture
def sample_threat_result():
    """Sample threat detection result for testing."""
    return ThreatDetectionResult(
        is_threat=True,
        risk_score=85,
        threat_type="prompt_injection",
        description="Test threat detection"
    )


@pytest.fixture
def sample_safe_result():
    """Sample safe detection result for testing."""
    return ThreatDetectionResult(
        is_threat=False,
        risk_score=25,
        threat_type="",
        description=""
    )


@pytest.fixture
def disable_env_api_key():
    """Disable API key environment variable for testing."""
    with patch.dict(os.environ, {}, clear=True):
        yield


@pytest.fixture
def enable_env_api_key():
    """Enable API key environment variable for testing."""
    with patch.dict(os.environ, {"SECUREVECTOR_API_KEY": "test_key"}):
        yield