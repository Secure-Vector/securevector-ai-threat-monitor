"""
API mode implementation for enhanced threat detection via SecureVector API.

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
from securevector.models.config_models import APIModeConfig
from securevector.utils.exceptions import APIError, AuthenticationError, RateLimitError
from securevector.utils.logger import get_logger
from securevector.utils.performance import ContextTimer, PerformanceTracker
from securevector.utils.security import secure_cache_key_derivation

from .api_analyzer import APIAnalyzer
from .api_cache import APICache


class APIMode:
    """
    API mode handler for enhanced threat detection via SecureVector API.

    Provides access to advanced ML-based threat detection, extended rule sets,
    and cloud-based analysis capabilities.
    """

    def __init__(self, config: APIModeConfig):
        self.config = config
        self.logger = get_logger(__name__)
        self.performance = PerformanceTracker(enabled=True)

        # Validate configuration
        if not config.api_key:
            raise AuthenticationError("API key is required for API mode")

        # Initialize components
        self.cache = (
            APICache(enabled=config.cache_enabled, ttl_seconds=config.cache_ttl_seconds)
            if config.cache_enabled
            else None
        )

        try:
            self.analyzer = APIAnalyzer(config)
            self.logger.info(
                f"API mode initialized with endpoint: {config.api_url}{config.endpoint}"
            )
        except Exception as e:
            self.logger.error(f"Failed to initialize API analyzer: {e}")
            raise APIError(f"Failed to initialize API analyzer: {e}")

    def analyze(self, prompt: str, **kwargs) -> AnalysisResult:
        """
        Analyze a prompt using the SecureVector API.

        Args:
            prompt: The prompt text to analyze
            **kwargs: Additional analysis options

        Returns:
            AnalysisResult: Analysis result with threat detection

        Raises:
            APIError: If API request fails
            AuthenticationError: If API key is invalid
            RateLimitError: If rate limit is exceeded
        """
        with ContextTimer(self.performance, "api_analysis") as _:
            # Generate prompt hash for caching
            prompt_hash = hashlib.sha256(prompt.encode()).hexdigest()[:16]

            # Check cache first
            if self.cache:
                cached_result = self.cache.get(prompt_hash)
                if cached_result:
                    self.performance.increment_counter("cache_hits")
                    self.logger.debug(f"Cache hit for prompt hash {prompt_hash}")
                    return cached_result
                else:
                    self.performance.increment_counter("cache_misses")

            # Validate prompt size
            if len(prompt.encode("utf-8")) > self.config.max_request_size:
                raise APIError(
                    f"Prompt size exceeds maximum allowed size of {self.config.max_request_size} bytes"
                )

            try:
                # Perform API analysis
                result = self.analyzer.analyze_prompt(prompt, **kwargs)

                # Cache the result
                if self.cache:
                    self.cache.set(prompt_hash, result)

                # Record performance metrics
                self.performance.increment_counter("api_calls")

                return result

            except AuthenticationError:
                # Don't retry authentication errors
                raise
            except RateLimitError:
                # Don't retry rate limit errors immediately
                raise
            except APIError as e:
                # Handle API errors with potential fallback
                if self.config.fallback_to_local:
                    self.logger.warning(f"API call failed, falling back to local analysis: {e}")
                    return self._fallback_local_analysis(prompt)
                else:
                    raise
            except Exception as e:
                # Handle unexpected errors
                self.logger.error(f"Unexpected error during API analysis: {e}")
                if self.config.fallback_to_local:
                    return self._fallback_local_analysis(prompt)
                else:
                    raise APIError(f"API analysis failed: {e}")

    def analyze_batch(self, prompts: List[str], **kwargs) -> List[AnalysisResult]:
        """
        Analyze multiple prompts in batch via API.

        Args:
            prompts: List of prompt strings to analyze
            **kwargs: Additional analysis options

        Returns:
            List[AnalysisResult]: Analysis results for each prompt
        """
        with ContextTimer(self.performance, "api_batch_analysis"):
            # Check if API supports batch analysis
            if hasattr(self.analyzer, "analyze_batch"):
                try:
                    results = self.analyzer.analyze_batch(prompts, **kwargs)
                    self.performance.increment_counter("batch_api_calls")
                    self.performance.record_metric("batch_size", len(prompts), "count")
                    return results
                except Exception as e:
                    self.logger.warning(
                        f"Batch API analysis failed, falling back to individual calls: {e}"
                    )

            # Fallback to individual analysis
            results = []
            for prompt in prompts:
                try:
                    result = self.analyze(prompt, **kwargs)
                    results.append(result)
                except Exception as e:
                    # Create error result for failed analysis
                    self.logger.error(f"Failed to analyze prompt in batch: {e}")
                    error_result = AnalysisResult(
                        is_threat=False,
                        risk_score=0,
                        confidence=0.0,
                        detections=[],
                        analysis_time_ms=0.0,
                        detection_method=DetectionMethod.API_ENHANCED,
                        prompt_hash=hashlib.sha256(prompt.encode()).hexdigest()[:16],
                    )
                    results.append(error_result)

            return results

    def _fallback_local_analysis(self, prompt: str) -> AnalysisResult:
        """
        Fallback to basic local analysis when API is unavailable.

        Args:
            prompt: The prompt text to analyze

        Returns:
            AnalysisResult: Basic analysis result
        """
        # Import local mode for fallback
        try:
            from securevector.models.config_models import LocalModeConfig
            from ..local.local_mode import LocalMode

            # Create minimal local config
            local_config = LocalModeConfig()
            local_mode = LocalMode(local_config)

            result = local_mode.analyze(prompt)

            # Mark as fallback analysis
            result.detection_method = DetectionMethod.LOCAL_RULES
            if result.metadata is None:
                result.metadata = {}
            result.metadata["fallback"] = True
            result.metadata["original_mode"] = "api"

            self.performance.increment_counter("api_fallbacks")

            return result

        except Exception as e:
            self.logger.error(f"Fallback local analysis failed: {e}")

            # Return safe default result
            return AnalysisResult(
                is_threat=False,
                risk_score=0,
                confidence=0.0,
                detections=[],
                analysis_time_ms=0.0,
                detection_method=DetectionMethod.LOCAL_RULES,
                prompt_hash=hashlib.sha256(prompt.encode()).hexdigest()[:16],
                metadata={"fallback": True, "fallback_error": str(e)},
            )

    def get_health_status(self) -> Dict[str, Any]:
        """Get health status of API mode components"""
        analyzer_status = self.analyzer.get_health_status()

        return {
            "mode": "api",
            "status": analyzer_status.get("status", "unknown"),
            "api_endpoint": f"{self.config.api_url}{self.config.endpoint}",
            "analyzer_status": analyzer_status,
            "cache_status": self.cache.get_health_status() if self.cache else {"enabled": False},
            "performance_metrics": self.performance.get_metrics(),
            "fallback_enabled": self.config.fallback_to_local,
        }

    def get_stats(self) -> Dict[str, Any]:
        """Get API mode statistics"""
        stats = {
            "mode": "api",
            "api_endpoint": f"{self.config.api_url}{self.config.endpoint}",
            "performance_metrics": self.performance.get_metrics(),
            "analyzer_stats": self.analyzer.get_stats(),
        }

        if self.cache:
            stats["cache_stats"] = self.cache.get_stats()

        return stats

    def update_config(self, config: APIModeConfig) -> None:
        """Update API mode configuration"""
        old_config = self.config
        self.config = config

        # Update analyzer configuration
        self.analyzer.update_config(config)

        # Update cache configuration
        if self.cache and (old_config.cache_ttl_seconds != config.cache_ttl_seconds):
            self.cache.update_config(ttl_seconds=config.cache_ttl_seconds)

        self.logger.info("API mode configuration updated")

    def clear_cache(self) -> bool:
        """Clear the API response cache"""
        if self.cache:
            self.cache.clear()
            self.logger.info("API cache cleared")
            return True
        return False

    def test_connection(self) -> Dict[str, Any]:
        """Test connection to the API"""
        return self.analyzer.test_connection()

    def get_api_info(self) -> Dict[str, Any]:
        """Get information about the API service"""
        return self.analyzer.get_api_info()

    def close(self) -> None:
        """Clean up resources"""
        if self.cache:
            self.cache.close()

        self.analyzer.close()
        self.logger.info("API mode closed")
