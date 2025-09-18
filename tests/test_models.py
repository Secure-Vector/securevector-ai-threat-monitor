"""
Unit tests for SecureVector AI Threat Monitor Models
"""

import pytest

from securevector.models.analysis_result import AnalysisResult, DetectionMethod, ThreatDetection
from securevector.models.config_models import OperationMode
from securevector.models.threat_types import ThreatType


class TestAnalysisResult:
    """Test cases for AnalysisResult model"""

    def test_threat_result_creation(self):
        """Test creating a threat analysis result"""
        result = AnalysisResult(
            is_threat=True,
            risk_score=80,
            detections=[ThreatDetection(
                threat_type="prompt_injection",
                risk_score=80,
                confidence=0.95,
                description="Prompt injection detected"
            )],
            confidence=0.95,
            analysis_time_ms=25.0,
            detection_method=DetectionMethod.LOCAL_RULES,
        )

        assert result.is_threat is True
        assert result.risk_score == 80
        assert "prompt_injection" in result.threat_types
        assert result.confidence == 0.95
        assert result.analysis_time_ms == 25.0

    def test_safe_result_creation(self):
        """Test creating a safe analysis result"""
        result = AnalysisResult(
            is_threat=False, 
            risk_score=1, 
            detections=[], 
            confidence=0.98, 
            analysis_time_ms=15.0,
            detection_method=DetectionMethod.LOCAL_RULES
        )

        assert result.is_threat is False
        assert result.risk_score == 1
        assert len(result.threat_types) == 0
        assert result.confidence == 0.98
        assert result.analysis_time_ms == 15.0

    def test_risk_score_validation(self):
        """Test risk score validation"""
        # Valid risk scores
        for score in [0, 50, 100]:
            result = AnalysisResult(
                is_threat=score > 50,
                risk_score=score,
                detections=[],
                confidence=0.9,
            analysis_time_ms=10.0,
            detection_method=DetectionMethod.LOCAL_RULES,
        )
            assert result.risk_score == score

        # Invalid risk scores should be handled gracefully
        # (implementation dependent - may clamp or raise exception)

    def test_confidence_validation(self):
        """Test confidence validation"""
        # Valid confidence scores
        for confidence in [0.0, 0.5, 1.0]:
            result = AnalysisResult(
                is_threat=False,
                risk_score=1,
                detections=[],
                confidence=confidence,
            analysis_time_ms=10.0,
            detection_method=DetectionMethod.LOCAL_RULES,
        )
            assert result.confidence == confidence

    def test_multiple_threat_types(self):
        """Test result with multiple threat types"""
        threat_types = ["prompt_injection", "data_exfiltration", "jailbreak"]
        detections = [
            ThreatDetection(
                threat_type=threat_type,
                risk_score=90,
                confidence=0.85,
                description=f"{threat_type} detected"
            )
            for threat_type in threat_types
        ]
        result = AnalysisResult(
            is_threat=True,
            risk_score=90,
            detections=detections,
            confidence=0.85,
            analysis_time_ms=30.0,
            detection_method=DetectionMethod.LOCAL_RULES,
        )

        assert len(result.threat_types) == 3
        for threat_type in threat_types:
            assert threat_type in result.threat_types


class TestOperationMode:
    """Test cases for OperationMode enum"""

    def test_operation_modes_exist(self):
        """Test that all expected operation modes exist"""
        assert hasattr(OperationMode, "LOCAL")
        assert hasattr(OperationMode, "API")
        assert hasattr(OperationMode, "HYBRID")

    def test_operation_mode_values(self):
        """Test operation mode values"""
        assert OperationMode.LOCAL.value == "local"
        assert OperationMode.API.value == "api"
        assert OperationMode.HYBRID.value == "hybrid"

    def test_operation_mode_comparison(self):
        """Test operation mode comparison"""
        assert OperationMode.LOCAL == OperationMode.LOCAL
        assert OperationMode.LOCAL != OperationMode.API
        assert OperationMode.API != OperationMode.HYBRID


class TestThreatType:
    """Test cases for ThreatType enum"""

    def test_common_threat_types_exist(self):
        """Test that common threat types exist"""
        expected_types = [
            "PROMPT_INJECTION",
            "DATA_EXFILTRATION",
            "JAILBREAK",
            "SOCIAL_ENGINEERING",
        ]

        for threat_type in expected_types:
            assert hasattr(ThreatType, threat_type), f"ThreatType.{threat_type} should exist"

    def test_threat_type_string_representation(self):
        """Test threat type string representations"""
        # This test depends on the actual implementation
        # Adjust based on your ThreatType implementation
        if hasattr(ThreatType, "PROMPT_INJECTION"):
            assert ThreatType.PROMPT_INJECTION.value == "prompt_injection"
