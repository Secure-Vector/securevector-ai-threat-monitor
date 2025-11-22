"""
Smart routing logic for hybrid mode analysis decisions.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import time
from collections import deque
from typing import Any, Dict, Optional

from securevector.models.analysis_result import AnalysisResult
from securevector.models.config_models import HybridModeConfig
from securevector.utils.logger import get_logger
from securevector.utils.performance import PerformanceTracker


class SmartRouter:
    """
    Intelligent routing system for deciding between local and API analysis.

    Makes routing decisions based on:
    - Historical accuracy patterns
    - Performance metrics
    - Risk assessment confidence
    - API availability and cost considerations
    """

    def __init__(self, config: HybridModeConfig, performance_tracker: PerformanceTracker):
        self.config = config
        self.performance = performance_tracker
        self.logger = get_logger(__name__)

        # Routing statistics and learning
        self.routing_history = deque(maxlen=1000)  # Keep last 1000 decisions
        self.accuracy_tracking = {
            "local_only": {"correct": 0, "total": 0},
            "api_enhanced": {"correct": 0, "total": 0},
        }

        # Performance tracking
        self.api_performance = {
            "avg_response_time": 0.0,
            "success_rate": 1.0,
            "recent_failures": deque(maxlen=10),
        }

        # Adaptive thresholds
        self.adaptive_threshold = config.api_threshold_score
        self.threshold_adjustment_factor = 0.1

        self.logger.debug("Smart router initialized for hybrid mode")

    def should_use_api(self, local_result: AnalysisResult, prompt: str, **kwargs) -> bool:
        """
        Make an intelligent routing decision based on multiple factors.

        Args:
            local_result: Result from local analysis
            prompt: The original prompt text
            **kwargs: Additional analysis options

        Returns:
            bool: True if API analysis should be performed
        """
        # Factor 1: Risk-based routing
        risk_score = local_result.risk_score
        confidence = local_result.confidence

        # Factor 2: API availability and performance
        api_available = self._is_api_performing_well()

        # Factor 3: Historical accuracy patterns
        local_accuracy = self._get_local_accuracy()

        # Factor 4: Prompt characteristics
        prompt_complexity = self._assess_prompt_complexity(prompt)

        # Make routing decision
        decision = self._make_routing_decision(
            risk_score=risk_score,
            confidence=confidence,
            api_available=api_available,
            local_accuracy=local_accuracy,
            prompt_complexity=prompt_complexity,
            **kwargs,
        )

        # Record decision for learning
        self._record_routing_decision(decision, local_result, prompt)

        return decision

    def _make_routing_decision(
        self,
        risk_score: int,
        confidence: float,
        api_available: bool,
        local_accuracy: float,
        prompt_complexity: float,
        **kwargs,
    ) -> bool:
        """Make the actual routing decision based on all factors"""

        # Don't use API if it's not performing well
        if not api_available:
            return False

        # Always use API for high-risk scenarios
        if risk_score >= 90:
            return True

        # Use API if local confidence is low
        if confidence < 0.6:
            return True

        # Use API if local accuracy has been poor recently
        if local_accuracy < 0.8:
            return True

        # Use API for complex prompts that might need advanced analysis
        if prompt_complexity > 0.7 and risk_score >= self.adaptive_threshold:
            return True

        # Use API if risk score exceeds adaptive threshold
        if risk_score >= self.adaptive_threshold:
            return True

        # For medium-risk prompts with uncertain local results
        if 50 <= risk_score < self.adaptive_threshold and confidence < 0.8:
            return True

        # Default to local analysis
        return False

    def _is_api_performing_well(self) -> bool:
        """Check if API is performing well enough to warrant usage"""
        current_time = time.time()

        # Check recent failures (last 5 minutes)
        recent_failures = [
            failure_time
            for failure_time in self.api_performance["recent_failures"]
            if current_time - failure_time < 300  # 5 minutes
        ]

        # If more than 3 failures in last 5 minutes, consider API unavailable
        if len(recent_failures) > 3:
            return False

        # Check success rate
        if self.api_performance["success_rate"] < 0.8:
            return False

        # Check response time (don't use API if it's too slow)
        if self.api_performance["avg_response_time"] > 10000:  # 10 seconds
            return False

        return True

    def _get_local_accuracy(self) -> float:
        """Get recent local analysis accuracy"""
        local_stats = self.accuracy_tracking["local_only"]
        if local_stats["total"] == 0:
            return 0.8  # Default assumption

        return local_stats["correct"] / local_stats["total"]

    def _assess_prompt_complexity(self, prompt: str) -> float:
        """
        Assess prompt complexity to help with routing decisions.

        Returns:
            float: Complexity score from 0.0 to 1.0
        """
        complexity_score = 0.0

        # Length factor
        if len(prompt) > 500:
            complexity_score += 0.2
        elif len(prompt) > 200:
            complexity_score += 0.1

        # Multiple sentences/instructions
        sentence_count = prompt.count(".") + prompt.count("!") + prompt.count("?")
        if sentence_count > 3:
            complexity_score += 0.2
        elif sentence_count > 1:
            complexity_score += 0.1

        # Technical terms or jargon
        technical_keywords = [
            "system",
            "database",
            "api",
            "code",
            "script",
            "algorithm",
            "configuration",
            "authentication",
            "authorization",
            "encryption",
        ]
        technical_count = sum(
            1 for keyword in technical_keywords if keyword.lower() in prompt.lower()
        )
        complexity_score += min(technical_count * 0.1, 0.3)

        # Special characters and formatting
        special_chars = sum(1 for char in prompt if char in "{}[]()<>|\\")
        if special_chars > 5:
            complexity_score += 0.2
        elif special_chars > 0:
            complexity_score += 0.1

        # Nested instructions or multi-step requests
        if any(phrase in prompt.lower() for phrase in ["then", "after that", "next", "step"]):
            complexity_score += 0.2

        return min(complexity_score, 1.0)

    def _record_routing_decision(
        self, decision: bool, local_result: AnalysisResult, prompt: str
    ) -> None:
        """Record routing decision for learning and adaptation"""
        decision_record = {
            "timestamp": time.time(),
            "decision": "api" if decision else "local",
            "local_risk_score": local_result.risk_score,
            "local_confidence": local_result.confidence,
            "prompt_length": len(prompt),
            "prompt_complexity": self._assess_prompt_complexity(prompt),
        }

        self.routing_history.append(decision_record)

    def update_accuracy(self, routing_method: str, was_correct: bool) -> None:
        """
        Update accuracy tracking for learning.

        Args:
            routing_method: "local_only" or "api_enhanced"
            was_correct: Whether the analysis was correct
        """
        if routing_method in self.accuracy_tracking:
            self.accuracy_tracking[routing_method]["total"] += 1
            if was_correct:
                self.accuracy_tracking[routing_method]["correct"] += 1

            # Adapt threshold based on performance
            self._adapt_threshold()

    def update_api_performance(self, response_time_ms: float, success: bool) -> None:
        """
        Update API performance metrics.

        Args:
            response_time_ms: API response time in milliseconds
            success: Whether the API call was successful
        """
        # Update response time (exponential moving average)
        alpha = 0.1
        self.api_performance["avg_response_time"] = (
            alpha * response_time_ms + (1 - alpha) * self.api_performance["avg_response_time"]
        )

        # Update success rate (exponential moving average)
        success_value = 1.0 if success else 0.0
        self.api_performance["success_rate"] = (
            alpha * success_value + (1 - alpha) * self.api_performance["success_rate"]
        )

        # Record failures
        if not success:
            self.api_performance["recent_failures"].append(time.time())

    def _adapt_threshold(self) -> None:
        """Adapt the API threshold based on performance feedback"""
        local_accuracy = self._get_local_accuracy()
        api_accuracy = self.accuracy_tracking["api_enhanced"]["correct"] / max(
            self.accuracy_tracking["api_enhanced"]["total"], 1
        )

        # If local accuracy is high, raise threshold (use API less)
        if local_accuracy > 0.9 and len(self.routing_history) > 50:
            self.adaptive_threshold = min(
                self.adaptive_threshold + self.threshold_adjustment_factor, 90
            )

        # If API accuracy is significantly better, lower threshold (use API more)
        elif api_accuracy - local_accuracy > 0.1 and len(self.routing_history) > 50:
            self.adaptive_threshold = max(
                self.adaptive_threshold - self.threshold_adjustment_factor, 30
            )

        # Log threshold changes
        if abs(self.adaptive_threshold - self.config.api_threshold_score) > 5:
            self.logger.info(
                f"Adaptive threshold adjusted: {self.config.api_threshold_score} → "
                f"{self.adaptive_threshold:.1f} (local acc: {local_accuracy:.2f}, "
                f"api acc: {api_accuracy:.2f})"
            )

    def get_routing_stats(self) -> Dict[str, Any]:
        """Get routing statistics and performance metrics"""
        total_decisions = len(self.routing_history)
        api_decisions = sum(1 for d in self.routing_history if d["decision"] == "api")

        return {
            "total_decisions": total_decisions,
            "api_usage_rate": api_decisions / max(total_decisions, 1),
            "adaptive_threshold": self.adaptive_threshold,
            "original_threshold": self.config.api_threshold_score,
            "accuracy_tracking": self.accuracy_tracking.copy(),
            "api_performance": self.api_performance.copy(),
            "recent_decisions": list(self.routing_history)[-10:],  # Last 10 decisions
        }

    def get_health_status(self) -> Dict[str, Any]:
        """Get health status of the smart router"""
        local_accuracy = self._get_local_accuracy()
        api_available = self._is_api_performing_well()

        status = "healthy"
        issues = []

        if local_accuracy < 0.7:
            status = "warning"
            issues.append("Low local accuracy")

        if not api_available:
            status = "warning"
            issues.append("API performance issues")

        return {
            "status": status,
            "issues": issues,
            "local_accuracy": local_accuracy,
            "api_available": api_available,
            "adaptive_threshold": self.adaptive_threshold,
            "total_decisions": len(self.routing_history),
        }

    def get_stats(self) -> Dict[str, Any]:
        """Get comprehensive router statistics"""
        return self.get_routing_stats()

    def update_config(self, config: HybridModeConfig) -> None:
        """Update router configuration"""
        self.config = config
        # Reset adaptive threshold to new base value
        self.adaptive_threshold = config.api_threshold_score
        self.logger.info("Smart router configuration updated")

    def close(self) -> None:
        """Clean up router resources"""
        self.routing_history.clear()
        self.logger.debug("Smart router closed")
