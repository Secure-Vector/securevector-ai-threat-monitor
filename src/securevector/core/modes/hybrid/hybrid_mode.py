"""
Hybrid mode implementation combining local and API analysis.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import hashlib
import time
from typing import Any, Dict, List, Optional

from securevector.models.analysis_result import (
    AnalysisResult,
    DetectionMethod,
    ThreatDetection,
)
from securevector.models.config_models import APIModeConfig, HybridModeConfig, LocalModeConfig
from securevector.utils.exceptions import APIError, ConfigurationError
from securevector.utils.logger import get_logger
from securevector.utils.performance import ContextTimer, PerformanceTracker

from ..api.api_mode import APIMode
from ..local.local_mode import LocalMode
from .smart_router import SmartRouter


class HybridMode:
    """
    Hybrid mode handler combining local and API analysis for optimal results.

    Intelligently routes requests between local and API analysis based on:
    - Initial risk assessment
    - API availability
    - Performance requirements
    - Configuration preferences
    """

    def __init__(
        self,
        local_config: LocalModeConfig,
        api_config: APIModeConfig,
        hybrid_config: HybridModeConfig,
    ):
        self.local_config = local_config
        self.api_config = api_config
        self.hybrid_config = hybrid_config
        self.logger = get_logger(__name__)
        self.performance = PerformanceTracker(enabled=hybrid_config.performance_optimization)

        # Initialize local mode (always available)
        try:
            self.local_mode = LocalMode(local_config)
            self.logger.info("Local mode initialized for hybrid analysis")
        except Exception as e:
            self.logger.error(f"Failed to initialize local mode: {e}")
            raise ConfigurationError(f"Local mode initialization failed: {e}")

        # Initialize API mode (optional)
        self.api_mode = None
        if api_config.api_key:
            try:
                self.api_mode = APIMode(api_config)
                self.logger.info("API mode initialized for hybrid analysis")
            except Exception as e:
                self.logger.warning(f"API mode initialization failed: {e}")
                if hybrid_config.fallback_strategy != "local":
                    raise ConfigurationError(f"API mode required but failed to initialize: {e}")

        # Initialize smart router
        self.router = (
            SmartRouter(hybrid_config, self.performance) if hybrid_config.smart_routing else None
        )

        # Statistics
        self.stats = {
            "local_analyses": 0,
            "api_analyses": 0,
            "hybrid_analyses": 0,
            "routing_decisions": 0,
            "fallbacks": 0,
        }

        self.logger.info(f"Hybrid mode initialized (API available: {self.api_mode is not None})")

    def analyze(self, prompt: str, **kwargs) -> AnalysisResult:
        """
        Analyze a prompt using hybrid local + API approach.

        Args:
            prompt: The prompt text to analyze
            **kwargs: Additional analysis options

        Returns:
            AnalysisResult: Combined analysis result
        """
        start_time = time.time()

        # Step 1: Always perform local analysis first (fast screening)
        local_result = self._perform_local_analysis(prompt, **kwargs)

        # Step 2: Decide if API analysis is needed
        needs_api_analysis = self._should_use_api(local_result, prompt, **kwargs)

        if needs_api_analysis and self.api_mode:
            try:
                # Step 3: Perform API analysis for enhanced detection
                api_result = self._perform_api_analysis(prompt, **kwargs)

                # Step 4: Combine results
                combined_result = self._combine_results(local_result, api_result, prompt)
                self.stats["hybrid_analyses"] += 1

                # Update analysis time
                combined_result.analysis_time_ms = (time.time() - start_time) * 1000

                return combined_result

            except Exception as e:
                self.logger.warning(f"API analysis failed in hybrid mode: {e}")
                self.stats["fallbacks"] += 1

                # Fallback to local result
                local_result.metadata = local_result.metadata or {}
                local_result.metadata["api_fallback"] = True
                local_result.metadata["api_error"] = str(e)

                # Update analysis time
                local_result.analysis_time_ms = (time.time() - start_time) * 1000

                return local_result

        # Return local result if API not needed or not available
        # Update analysis time for local-only hybrid result
        local_result.analysis_time_ms = (time.time() - start_time) * 1000
        return local_result

    def analyze_batch(self, prompts: List[str], **kwargs) -> List[AnalysisResult]:
        """
        Analyze multiple prompts using hybrid approach.

        Args:
            prompts: List of prompt strings to analyze
            **kwargs: Additional analysis options

        Returns:
            List[AnalysisResult]: Analysis results for each prompt
        """
        with ContextTimer(self.performance, "hybrid_batch_analysis"):
            results = []

            # Perform local batch analysis first
            local_results = self.local_mode.analyze_batch(prompts, **kwargs)

            # Determine which prompts need API analysis
            api_prompts = []
            api_indices = []

            for i, (prompt, local_result) in enumerate(zip(prompts, local_results)):
                if self._should_use_api(local_result, prompt, **kwargs):
                    api_prompts.append(prompt)
                    api_indices.append(i)

            # Perform API batch analysis if needed and available
            api_results = []
            if api_prompts and self.api_mode:
                try:
                    api_results = self.api_mode.analyze_batch(api_prompts, **kwargs)
                except Exception as e:
                    self.logger.warning(f"Batch API analysis failed: {e}")
                    api_results = []
                    self.stats["fallbacks"] += len(api_prompts)

            # Combine results
            api_result_index = 0
            for i, (prompt, local_result) in enumerate(zip(prompts, local_results)):
                if i in api_indices and api_result_index < len(api_results):
                    # Combine local and API results
                    api_result = api_results[api_result_index]
                    combined_result = self._combine_results(local_result, api_result, prompt)
                    results.append(combined_result)
                    api_result_index += 1
                    self.stats["hybrid_analyses"] += 1
                else:
                    # Use local result only
                    results.append(local_result)

            return results

    def _perform_local_analysis(self, prompt: str, **kwargs) -> AnalysisResult:
        """Perform local analysis"""
        result = self.local_mode.analyze(prompt, **kwargs)
        self.stats["local_analyses"] += 1
        return result

    def _perform_api_analysis(self, prompt: str, **kwargs) -> AnalysisResult:
        """Perform API analysis"""
        if not self.api_mode:
            raise APIError("API mode not available")

        result = self.api_mode.analyze(prompt, **kwargs)
        self.stats["api_analyses"] += 1
        return result

    def _should_use_api(self, local_result: AnalysisResult, prompt: str, **kwargs) -> bool:
        """
        Determine if API analysis should be used based on local result and configuration.

        Args:
            local_result: Result from local analysis
            prompt: The original prompt
            **kwargs: Analysis options

        Returns:
            bool: True if API analysis should be performed
        """
        self.stats["routing_decisions"] += 1

        # No API mode available
        if not self.api_mode:
            return False

        # Use smart router if available
        if self.router:
            return self.router.should_use_api(local_result, prompt, **kwargs)

        # Fallback to simple threshold-based routing
        if self.hybrid_config.local_first:
            # Use API for higher risk scores or uncertain results
            return local_result.risk_score >= self.hybrid_config.api_threshold_score or (
                local_result.is_threat and local_result.confidence < 0.8
            )
        else:
            # Always use API for additional validation
            return True

    def _combine_results(
        self, local_result: AnalysisResult, api_result: AnalysisResult, prompt: str
    ) -> AnalysisResult:
        """
        Combine local and API analysis results into a unified result.

        Args:
            local_result: Result from local analysis
            api_result: Result from API analysis
            prompt: The original prompt

        Returns:
            AnalysisResult: Combined analysis result
        """
        # Combine detections from both analyses
        combined_detections = []

        # Add local detections
        for detection in local_result.detections:
            detection.rule_id = f"local:{detection.rule_id}" if detection.rule_id else "local"
            combined_detections.append(detection)

        # Add API detections (avoid duplicates)
        local_patterns = {d.pattern_matched for d in local_result.detections if d.pattern_matched}
        for detection in api_result.detections:
            if detection.pattern_matched not in local_patterns:
                detection.rule_id = f"api:{detection.rule_id}" if detection.rule_id else "api"
                combined_detections.append(detection)

        # Calculate combined risk score (take the maximum)
        combined_risk_score = max(local_result.risk_score, api_result.risk_score)

        # Calculate combined confidence (weighted average, API has higher weight)
        local_weight = 0.3
        api_weight = 0.7
        combined_confidence = (
            local_result.confidence * local_weight + api_result.confidence * api_weight
        )

        # Determine if threat (either analysis detected a threat)
        is_threat = local_result.is_threat or api_result.is_threat

        # Combined analysis time
        combined_time = local_result.analysis_time_ms + api_result.analysis_time_ms

        # Create combined metadata
        combined_metadata = {
            "hybrid_analysis": True,
            "local_result": {
                "risk_score": local_result.risk_score,
                "confidence": local_result.confidence,
                "detection_count": len(local_result.detections),
            },
            "api_result": {
                "risk_score": api_result.risk_score,
                "confidence": api_result.confidence,
                "detection_count": len(api_result.detections),
            },
        }

        # Merge existing metadata
        if local_result.metadata:
            combined_metadata["local_metadata"] = local_result.metadata
        if api_result.metadata:
            combined_metadata["api_metadata"] = api_result.metadata

        # Create combined result
        combined_result = AnalysisResult(
            is_threat=is_threat,
            risk_score=combined_risk_score,
            confidence=combined_confidence,
            detections=combined_detections,
            analysis_time_ms=combined_time,
            detection_method=DetectionMethod.HYBRID,
            prompt_hash=local_result.prompt_hash or api_result.prompt_hash,
            timestamp=api_result.timestamp,  # Use API timestamp as it's more recent
            metadata=combined_metadata,
        )

        return combined_result

    def get_health_status(self) -> Dict[str, Any]:
        """Get health status of hybrid mode components"""
        status = {
            "mode": "hybrid",
            "status": "healthy",
            "local_mode_status": self.local_mode.get_health_status(),
            "api_mode_status": (
                self.api_mode.get_health_status() if self.api_mode else {"available": False}
            ),
            "router_status": self.router.get_health_status() if self.router else {"enabled": False},
            "performance_metrics": self.performance.get_metrics(),
            "stats": self.stats,
        }

        # Determine overall status
        local_healthy = status["local_mode_status"].get("status") == "healthy"
        api_healthy = (
            status["api_mode_status"].get("status") == "healthy" if self.api_mode else True
        )

        if not local_healthy:
            status["status"] = "error"
        elif self.api_mode and not api_healthy:
            status["status"] = "warning"

        return status

    def get_stats(self) -> Dict[str, Any]:
        """Get hybrid mode statistics"""
        stats = {
            "mode": "hybrid",
            "hybrid_stats": self.stats.copy(),
            "local_mode_stats": self.local_mode.get_stats(),
            "performance_metrics": self.performance.get_metrics(),
        }

        if self.api_mode:
            stats["api_mode_stats"] = self.api_mode.get_stats()

        if self.router:
            stats["router_stats"] = self.router.get_stats()

        return stats

    def update_config(
        self,
        local_config: Optional[LocalModeConfig] = None,
        api_config: Optional[APIModeConfig] = None,
        hybrid_config: Optional[HybridModeConfig] = None,
    ) -> None:
        """Update hybrid mode configuration"""
        if local_config:
            self.local_config = local_config
            self.local_mode.update_config(local_config)

        if api_config:
            self.api_config = api_config
            if self.api_mode:
                self.api_mode.update_config(api_config)

        if hybrid_config:
            self.hybrid_config = hybrid_config
            if self.router:
                self.router.update_config(hybrid_config)

        self.logger.info("Hybrid mode configuration updated")

    def clear_caches(self) -> Dict[str, bool]:
        """Clear all caches in hybrid mode"""
        results = {}

        results["local_cache"] = self.local_mode.clear_cache()

        if self.api_mode:
            results["api_cache"] = self.api_mode.clear_cache()
        else:
            results["api_cache"] = False

        return results

    def close(self) -> None:
        """Clean up resources"""
        if self.local_mode:
            self.local_mode.close()

        if self.api_mode:
            self.api_mode.close()

        if self.router:
            self.router.close()

        self.logger.info("Hybrid mode closed")
