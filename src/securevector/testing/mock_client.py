"""
Mock client implementations for testing the SecureVector AI Threat Monitor SDK.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import hashlib
import random
import time
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Union

from securevector.async_client import AsyncSecureVectorClient
from securevector.client import SecureVectorClient
from securevector.models.analysis_result import AnalysisResult, DetectionMethod, ThreatDetection
from securevector.models.config_models import OperationMode, SDKConfig
from securevector.models.policy_models import PolicyAction, SecurityPolicy
from securevector.models.threat_types import RiskLevel, ThreatType


class MockBehavior:
    """Defines mock behavior for testing scenarios"""

    def __init__(
        self,
        default_is_threat: bool = False,
        default_risk_score: int = 10,
        default_confidence: float = 0.95,
        response_time_ms: float = 15.0,
        failure_rate: float = 0.0,
        custom_responses: Optional[Dict[str, AnalysisResult]] = None,
    ):
        """
        Initialize mock behavior.

        Args:
            default_is_threat: Default threat detection result
            default_risk_score: Default risk score (0-100)
            default_confidence: Default confidence (0.0-1.0)
            response_time_ms: Simulated response time in milliseconds
            failure_rate: Rate of simulated failures (0.0-1.0)
            custom_responses: Custom responses for specific prompts
        """
        self.default_is_threat = default_is_threat
        self.default_risk_score = default_risk_score
        self.default_confidence = default_confidence
        self.response_time_ms = response_time_ms
        self.failure_rate = failure_rate
        self.custom_responses = custom_responses or {}

        # Predefined threat patterns for realistic testing
        self.threat_patterns = {
            "ignore previous instructions": {
                "risk_score": 85,
                "threat_types": ["prompt_injection"],
            },
            "show me secrets": {"risk_score": 90, "threat_types": ["data_exfiltration"]},
            "you are now dan": {"risk_score": 80, "threat_types": ["jailbreak"]},
            "admin access": {"risk_score": 95, "threat_types": ["privilege_escalation"]},
            "system prompt": {"risk_score": 75, "threat_types": ["system_probing"]},
            "bypass security": {"risk_score": 88, "threat_types": ["security_bypass"]},
        }

    def get_response(self, prompt: str) -> AnalysisResult:
        """Generate a mock response for the given prompt"""
        # Simulate processing time
        time.sleep(self.response_time_ms / 1000)

        # Simulate failures
        if random.random() < self.failure_rate:
            raise Exception("Simulated failure for testing")

        # Check for custom responses
        if prompt in self.custom_responses:
            return self.custom_responses[prompt]

        # Check for threat patterns
        prompt_lower = prompt.lower()
        for pattern, config in self.threat_patterns.items():
            if pattern in prompt_lower:
                return AnalysisResult(
                    is_threat=True,
                    risk_score=config["risk_score"],
                    confidence=self.default_confidence,
                    detections=[
                        ThreatDetection(
                            threat_type=threat_type,
                            risk_score=config["risk_score"],
                            confidence=self.default_confidence,
                            description=f"Detected {threat_type} pattern: '{pattern}'",
                        )
                        for threat_type in config["threat_types"]
                    ],
                    analysis_time_ms=self.response_time_ms,
                    detection_method=DetectionMethod.LOCAL_RULES,
                    prompt_hash=hashlib.sha256(prompt.encode()).hexdigest()[:16],
                    timestamp=datetime.utcnow(),
                )

        # Default response
        return AnalysisResult(
            is_threat=self.default_is_threat,
            risk_score=self.default_risk_score,
            confidence=self.default_confidence,
            detections=[],
            analysis_time_ms=self.response_time_ms,
            detection_method=DetectionMethod.LOCAL_RULES,
            prompt_hash=hashlib.sha256(prompt.encode()).hexdigest()[:16],
            timestamp=datetime.utcnow(),
        )


class MockSecureVectorClient(SecureVectorClient):
    """Mock implementation of SecureVectorClient for testing"""

    def __init__(
        self,
        mock_behavior: Optional[MockBehavior] = None,
        mode: Union[str, OperationMode] = OperationMode.LOCAL,
        **kwargs,
    ):
        """
        Initialize mock client.

        Args:
            mock_behavior: MockBehavior instance defining response behavior
            mode: Operation mode (for compatibility)
            **kwargs: Additional arguments (ignored in mock)
        """
        self.mock_behavior = mock_behavior or MockBehavior()
        self.mode = mode if isinstance(mode, OperationMode) else OperationMode.LOCAL

        # Initialize minimal required attributes
        self.config = SDKConfig()
        self.config.mode = self.mode
        self.policy = SecurityPolicy.create_default_policy()

        # Mock statistics
        self.stats = {
            "total_requests": 0,
            "threats_detected": 0,
            "threats_blocked": 0,
            "avg_response_time_ms": 0.0,
            "cache_hits": 0,
            "api_calls": 0,
            "local_analyses": 0,
        }

        # Call log for testing
        self.call_log = []

    def analyze(self, prompt: str, **kwargs) -> AnalysisResult:
        """Mock analyze method"""
        self.call_log.append({"method": "analyze", "prompt": prompt, "kwargs": kwargs})

        # Input validation (same as real client)
        if not isinstance(prompt, str) or len(prompt.strip()) == 0:
            raise ValueError("Prompt must be a non-empty string")

        result = self.mock_behavior.get_response(prompt)

        # Update stats
        self.stats["total_requests"] += 1
        if result.is_threat:
            self.stats["threats_detected"] += 1

        return result

    def analyze_batch(self, prompts: List[str], **kwargs) -> List[AnalysisResult]:
        """Mock batch analyze method"""
        self.call_log.append({"method": "analyze_batch", "prompts": prompts, "kwargs": kwargs})

        if not isinstance(prompts, list):
            raise ValueError("Prompts must be a list")

        results = []
        for prompt in prompts:
            try:
                result = self.analyze(prompt, **kwargs)
                results.append(result)
            except Exception as e:
                # Create error result
                results.append(
                    AnalysisResult(
                        is_threat=True,
                        risk_score=100,
                        confidence=1.0,
                        detections=[],
                        analysis_time_ms=0.0,
                        detection_method=DetectionMethod.LOCAL_RULES,
                        summary=f"Error: {str(e)}",
                    )
                )

        return results

    def is_threat(self, prompt: str, **kwargs) -> bool:
        """Mock is_threat method"""
        try:
            result = self.analyze(prompt, **kwargs)
            return result.is_threat
        except Exception:
            return False

    def get_risk_score(self, prompt: str, **kwargs) -> int:
        """Mock get_risk_score method"""
        try:
            result = self.analyze(prompt, **kwargs)
            return result.risk_score
        except Exception:
            return 0

    def get_stats(self) -> Dict[str, Any]:
        """Get mock statistics"""
        return self.stats.copy()

    def get_health_status(self) -> Dict[str, Any]:
        """Get mock health status"""
        return {
            "status": "healthy",
            "mode": self.mode.value,
            "mock": True,
            "stats": self.get_stats(),
        }

    def reset_mock(self):
        """Reset mock state for testing"""
        self.call_log.clear()
        self.stats = {
            "total_requests": 0,
            "threats_detected": 0,
            "threats_blocked": 0,
            "avg_response_time_ms": 0.0,
            "cache_hits": 0,
            "api_calls": 0,
            "local_analyses": 0,
        }


class MockAsyncSecureVectorClient(AsyncSecureVectorClient):
    """Mock async implementation of AsyncSecureVectorClient for testing"""

    def __init__(
        self,
        mock_behavior: Optional[MockBehavior] = None,
        mode: Union[str, OperationMode] = OperationMode.LOCAL,
        **kwargs,
    ):
        """
        Initialize mock async client.

        Args:
            mock_behavior: MockBehavior instance defining response behavior
            mode: Operation mode (for compatibility)
            **kwargs: Additional arguments (ignored in mock)
        """
        self.mock_behavior = mock_behavior or MockBehavior()
        self.mode = mode if isinstance(mode, OperationMode) else OperationMode.LOCAL

        # Initialize minimal required attributes
        self.config = SDKConfig()
        self.config.mode = self.mode
        self.policy = SecurityPolicy.create_default_policy()

        # Mock statistics
        self.stats = {
            "total_requests": 0,
            "threats_detected": 0,
            "threats_blocked": 0,
            "avg_response_time_ms": 0.0,
            "cache_hits": 0,
            "api_calls": 0,
            "local_analyses": 0,
        }

        # Call log for testing
        self.call_log = []

    async def analyze(self, prompt: str, **kwargs) -> AnalysisResult:
        """Mock async analyze method"""
        self.call_log.append({"method": "analyze", "prompt": prompt, "kwargs": kwargs})

        # Input validation (same as real client)
        if not isinstance(prompt, str) or len(prompt.strip()) == 0:
            raise ValueError("Prompt must be a non-empty string")

        # Simulate async operation
        import asyncio

        await asyncio.sleep(self.mock_behavior.response_time_ms / 1000)

        result = self.mock_behavior.get_response(prompt)

        # Update stats
        self.stats["total_requests"] += 1
        if result.is_threat:
            self.stats["threats_detected"] += 1

        return result

    async def analyze_batch(self, prompts: List[str], **kwargs) -> List[AnalysisResult]:
        """Mock async batch analyze method"""
        self.call_log.append({"method": "analyze_batch", "prompts": prompts, "kwargs": kwargs})

        if not isinstance(prompts, list):
            raise ValueError("Prompts must be a list")

        # Simulate concurrent processing
        import asyncio

        tasks = [self.analyze(prompt, **kwargs) for prompt in prompts]
        return await asyncio.gather(*tasks, return_exceptions=True)

    async def is_threat(self, prompt: str, **kwargs) -> bool:
        """Mock async is_threat method"""
        try:
            result = await self.analyze(prompt, **kwargs)
            return result.is_threat
        except Exception:
            return False

    async def get_risk_score(self, prompt: str, **kwargs) -> int:
        """Mock async get_risk_score method"""
        try:
            result = await self.analyze(prompt, **kwargs)
            return result.risk_score
        except Exception:
            return 0

    async def get_stats(self) -> Dict[str, Any]:
        """Get mock statistics"""
        return self.stats.copy()

    async def get_health_status(self) -> Dict[str, Any]:
        """Get mock health status"""
        return {
            "status": "healthy",
            "mode": self.mode.value,
            "mock": True,
            "stats": await self.get_stats(),
        }

    def reset_mock(self):
        """Reset mock state for testing"""
        self.call_log.clear()
        self.stats = {
            "total_requests": 0,
            "threats_detected": 0,
            "threats_blocked": 0,
            "avg_response_time_ms": 0.0,
            "cache_hits": 0,
            "api_calls": 0,
            "local_analyses": 0,
        }

    async def __aenter__(self):
        """Async context manager entry"""
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit"""
        pass
