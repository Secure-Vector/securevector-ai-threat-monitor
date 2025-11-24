"""
Local mode implementation for offline threat detection.

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
from securevector.models.config_models import LocalModeConfig
from securevector.utils.exceptions import RuleLoadError
from securevector.utils.logger import get_logger
from securevector.utils.performance import ContextTimer, PerformanceTracker

from .local_analyzer import LocalAnalyzer
from .local_cache import LocalCache


class LocalMode:
    """
    Local mode handler for offline threat detection.

    Uses community rules and local pattern matching for fast, privacy-preserving
    threat detection without external API calls.
    """

    def __init__(self, config: LocalModeConfig):
        self.config = config
        self.logger = get_logger(__name__)
        self.performance = PerformanceTracker(enabled=config.performance_monitoring)

        # Initialize components
        self.cache = (
            LocalCache(
                enabled=config.cache_enabled,
                ttl_seconds=config.cache_ttl_seconds,
                max_size=config.pattern_cache_size,
            )
            if config.cache_enabled
            else None
        )

        try:
            self.analyzer = LocalAnalyzer(config)
            self.logger.info(f"Local mode initialized with {self.analyzer.get_rule_count()} rules")
        except Exception as e:
            self.logger.error(f"Failed to initialize local analyzer: {e}")
            raise RuleLoadError(f"Failed to load security rules: {e}")

    def analyze(self, prompt: str, **kwargs) -> AnalysisResult:
        """
        Analyze a prompt using local rules and pattern matching.

        Args:
            prompt: The prompt text to analyze
            **kwargs: Additional analysis options

        Returns:
            AnalysisResult: Analysis result with threat detection
        """
        with ContextTimer(self.performance, "local_analysis") as _:
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

            # Perform local analysis
            detections = self.analyzer.analyze_prompt(prompt)

            # Calculate overall risk score and confidence
            risk_score = max([d.risk_score for d in detections], default=0)
            confidence = max([d.confidence for d in detections], default=0.0)
            is_threat = risk_score >= 70  # Default threshold

            # Create analysis result
            result = AnalysisResult(
                is_threat=is_threat,
                risk_score=risk_score,
                confidence=confidence,
                detections=detections,
                analysis_time_ms=0.0,  # Will be set by timer
                detection_method=DetectionMethod.LOCAL_RULES,
                prompt_hash=prompt_hash,
            )

            # Cache the result
            if self.cache:
                self.cache.set(prompt_hash, result)

            # Record performance metrics
            self.performance.increment_counter("local_analyses")

            return result

    def analyze_batch(self, prompts: List[str], **kwargs) -> List[AnalysisResult]:
        """
        Analyze multiple prompts in batch.

        Args:
            prompts: List of prompt strings to analyze
            **kwargs: Additional analysis options

        Returns:
            List[AnalysisResult]: Analysis results for each prompt
        """
        with ContextTimer(self.performance, "local_batch_analysis"):
            results = []

            for prompt in prompts:
                result = self.analyze(prompt, **kwargs)
                results.append(result)

            self.performance.increment_counter("batch_analyses")
            self.performance.record_metric("batch_size", len(prompts), "count")

            return results

    def get_health_status(self) -> Dict[str, Any]:
        """Get health status of local mode components"""
        return {
            "mode": "local",
            "status": "healthy",
            "analyzer_status": self.analyzer.get_health_status(),
            "cache_status": self.cache.get_health_status() if self.cache else {"enabled": False},
            "rules_loaded": self.analyzer.get_rule_count(),
            "performance_metrics": self.performance.get_metrics(),
        }

    def get_stats(self) -> Dict[str, Any]:
        """Get local mode statistics"""
        stats = {
            "mode": "local",
            "rules_loaded": self.analyzer.get_rule_count(),
            "rule_categories": self.analyzer.get_rule_categories(),
            "performance_metrics": self.performance.get_metrics(),
        }

        if self.cache:
            stats["cache_stats"] = self.cache.get_stats()

        return stats

    def reload_rules(self) -> bool:
        """Reload security rules from disk"""
        try:
            with ContextTimer(self.performance, "rule_reload"):
                old_count = self.analyzer.get_rule_count()
                self.analyzer.reload_rules()
                new_count = self.analyzer.get_rule_count()

                self.logger.info(f"Rules reloaded: {old_count} → {new_count}")
                self.performance.increment_counter("rule_reloads")

                # Clear cache after rule reload
                if self.cache:
                    self.cache.clear()

                return True
        except Exception as e:
            self.logger.error(f"Failed to reload rules: {e}")
            return False

    def update_config(self, config: LocalModeConfig) -> None:
        """Update local mode configuration"""
        old_config = self.config
        self.config = config

        # Update analyzer if rules path changed
        if old_config.rules_path != config.rules_path:
            self.analyzer.update_rules_path(config.rules_path)
            self.reload_rules()

        # Update cache configuration
        if self.cache and (
            old_config.cache_ttl_seconds != config.cache_ttl_seconds
            or old_config.pattern_cache_size != config.pattern_cache_size
        ):
            self.cache.update_config(
                ttl_seconds=config.cache_ttl_seconds, max_size=config.pattern_cache_size
            )

        self.logger.info("Local mode configuration updated")

    def clear_cache(self) -> bool:
        """Clear the local cache"""
        if self.cache:
            self.cache.clear()
            self.logger.info("Local cache cleared")
            return True
        return False

    def get_rule_info(self) -> Dict[str, Any]:
        """Get detailed information about loaded rules"""
        return self.analyzer.get_rule_info()

    def close(self) -> None:
        """Clean up resources"""
        if self.cache:
            self.cache.close()

        self.analyzer.close()
        self.logger.info("Local mode closed")
