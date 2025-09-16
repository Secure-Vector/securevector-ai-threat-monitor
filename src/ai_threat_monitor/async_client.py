"""
Async client interface for the SecureVector AI Threat Monitor SDK.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import asyncio
import hashlib
import logging
import threading
import time
from typing import Any, Dict, List, Optional, Union

from .core.modes.mode_factory import ModeFactory
from .utils.exceptions import (
    APIError,
    ConfigurationError,
    ErrorCode,
    SecurityException,
    ValidationError,
)
from .utils.logger import get_logger
from .utils.performance import PerformanceTracker
from .utils.security import secure_cache_key_derivation

from .models.analysis_result import AnalysisResult, DetectionMethod, ThreatDetection
from .models.config_models import OperationMode, SDKConfig
from .models.policy_models import PolicyAction, SecurityPolicy
from .models.threat_types import RiskLevel, ThreatType


class AsyncSecureVectorClient:
    """
    Async client interface for the SecureVector AI Threat Monitor SDK.

    Provides async/await support for all operations while maintaining
    thread safety and high performance for modern applications.
    """

    def __init__(
        self,
        mode: Union[str, OperationMode] = OperationMode.AUTO,
        api_key: Optional[str] = None,
        config: Optional[SDKConfig] = None,
        policy: Optional[SecurityPolicy] = None,
        **kwargs,
    ):
        """
        Initialize the async SecureVector client.

        Args:
            mode: Operation mode (local, api, hybrid, auto)
            api_key: API key for enhanced detection (optional)
            config: Custom SDK configuration (optional)
            policy: Custom security policy (optional)
            **kwargs: Additional configuration options
        """
        # Convert string mode to enum
        if isinstance(mode, str):
            try:
                mode = OperationMode(mode.lower())
            except ValueError:
                mode = OperationMode.AUTO

        # Initialize configuration
        self.config = config or SDKConfig.from_env()
        self.config.mode = mode

        # Set API key if provided
        if api_key:
            self.config.api_config.api_key = api_key

        # Apply additional configuration from kwargs
        for key, value in kwargs.items():
            if hasattr(self.config, key):
                setattr(self.config, key, value)

        # Initialize security policy
        self.policy = policy or SecurityPolicy.create_default_policy()

        # Initialize logging
        self.logger = get_logger(__name__, self.config.log_level)

        # Initialize performance tracking
        self.performance = PerformanceTracker(enabled=self.config.performance_monitoring)

        # Thread safety
        self._lock = asyncio.Lock()
        self._thread_local = threading.local()

        # Initialize the appropriate mode handler
        try:
            self.mode_handler = ModeFactory.create_handler(self.config)
            self.logger.info(f"Initialized async SecureVector client in {mode.value} mode")
        except ConfigurationError:
            # Re-raise ConfigurationError as-is to avoid duplication
            raise
        except Exception as e:
            self.logger.error(f"Failed to initialize mode handler: {e}")
            raise ConfigurationError(
                f"Failed to initialize {mode.value} mode: {e}",
                error_code=ErrorCode.MODE_INITIALIZATION_FAILED,
            )

        # Statistics tracking (thread-safe)
        self._stats_lock = threading.Lock()
        self.stats = {
            "total_requests": 0,
            "threats_detected": 0,
            "threats_blocked": 0,
            "avg_response_time_ms": 0.0,
            "cache_hits": 0,
            "api_calls": 0,
            "local_analyses": 0,
        }

    async def analyze(self, prompt: str, **kwargs) -> AnalysisResult:
        """
        Analyze a prompt for security threats asynchronously.

        Args:
            prompt: The prompt text to analyze
            **kwargs: Additional analysis options

        Returns:
            AnalysisResult: Complete analysis result with threat detection

        Raises:
            SecurityException: If a threat is detected and raise_on_threat is True
            ValidationError: If input validation fails
        """
        start_time = time.time()

        async with self._lock:
            try:
                # Enhanced input validation with structured error codes
                await self._validate_prompt(prompt)

                # Generate prompt hash for tracking
                context = {"user_id": kwargs.get("user_id"), "session_id": kwargs.get("session_id")}
                prompt_hash = secure_cache_key_derivation(prompt, context)[:16]

                # Perform analysis using the configured mode
                # Run in thread pool for CPU-bound operations
                result = await asyncio.get_event_loop().run_in_executor(
                    None, lambda: self.mode_handler.analyze(prompt, **kwargs)
                )

                # Add prompt hash and ensure timestamp is set
                result.prompt_hash = prompt_hash
                if result.timestamp is None:
                    from datetime import datetime

                    result.timestamp = datetime.utcnow()

                # Apply security policy
                policy_action = await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: self.policy.evaluate(
                        risk_score=result.risk_score,
                        threat_types=result.threat_types,
                        confidence=result.confidence,
                        prompt=prompt,
                    ),
                )

                # Update statistics
                await self._update_stats(result, time.time() - start_time)

                # Log the result
                self._log_result(result, policy_action)

                # Handle policy action
                if policy_action == PolicyAction.BLOCK or (
                    result.is_threat and self.config.raise_on_threat
                ):
                    with self._stats_lock:
                        self.stats["threats_blocked"] += 1
                    raise SecurityException(
                        f"Threat detected: {result.summary}", result=result, action=policy_action
                    )

                return result

            except SecurityException:
                # Re-raise security exceptions
                raise
            except Exception as e:
                self.logger.error(f"Analysis failed: {e}")
                # Return a safe fallback result
                return AnalysisResult(
                    is_threat=False,
                    risk_score=0,
                    confidence=0.0,
                    detections=[],
                    analysis_time_ms=(time.time() - start_time) * 1000,
                    detection_method=DetectionMethod.LOCAL_RULES,
                    prompt_hash=secure_cache_key_derivation(prompt, context)[:16],
                )

    async def analyze_batch(self, prompts: List[str], **kwargs) -> List[AnalysisResult]:
        """
        Analyze multiple prompts in batch asynchronously.

        Args:
            prompts: List of prompt strings to analyze
            **kwargs: Additional analysis options

        Returns:
            List[AnalysisResult]: Analysis results for each prompt

        Raises:
            ValidationError: If prompts list is invalid
        """
        # Enhanced batch validation
        await self._validate_batch(prompts)

        if len(prompts) == 0:
            return []

        # Check if mode handler supports async batch processing
        if hasattr(self.mode_handler, "analyze_batch_async"):
            return await self.mode_handler.analyze_batch_async(prompts, **kwargs)
        elif hasattr(self.mode_handler, "analyze_batch"):
            # Run in thread pool for sync batch processing
            return await asyncio.get_event_loop().run_in_executor(
                None, lambda: self.mode_handler.analyze_batch(prompts, **kwargs)
            )

        # Fallback to concurrent individual analysis
        tasks = [self.analyze(prompt, **kwargs) for prompt in prompts]

        results = []
        for task in asyncio.as_completed(tasks):
            try:
                result = await task
                results.append(result)
            except SecurityException as e:
                # Include the exception result if available
                if hasattr(e, "result") and e.result:
                    results.append(e.result)
                else:
                    # Create a threat result
                    results.append(
                        AnalysisResult(
                            is_threat=True,
                            risk_score=100,
                            confidence=1.0,
                            detections=[
                                ThreatDetection(
                                    threat_type="security_exception",
                                    risk_score=100,
                                    confidence=1.0,
                                    description=str(e),
                                )
                            ],
                            analysis_time_ms=0.0,
                            detection_method=DetectionMethod.LOCAL_RULES,
                        )
                    )

        return results

    async def is_threat(self, prompt: str, **kwargs) -> bool:
        """
        Simple boolean check if prompt is a threat asynchronously.

        Args:
            prompt: The prompt text to analyze
            **kwargs: Additional analysis options

        Returns:
            bool: True if threat detected, False otherwise
        """
        try:
            result = await self.analyze(prompt, **kwargs)
            return result.is_threat
        except SecurityException:
            return True
        except Exception:
            return False

    async def get_risk_score(self, prompt: str, **kwargs) -> int:
        """
        Get the risk score for a prompt asynchronously.

        Args:
            prompt: The prompt text to analyze
            **kwargs: Additional analysis options

        Returns:
            int: Risk score (0-100)
        """
        try:
            result = await self.analyze(prompt, **kwargs)
            return result.risk_score
        except SecurityException as e:
            if hasattr(e, "result") and e.result:
                return e.result.risk_score
            return 100
        except Exception:
            return 0

    async def update_policy(self, policy: SecurityPolicy) -> None:
        """Update the security policy"""
        async with self._lock:
            self.policy = policy
            self.logger.info(f"Updated security policy: {policy.name}")

    async def update_config(self, config: SDKConfig) -> None:
        """Update the SDK configuration"""
        async with self._lock:
            old_mode = self.config.mode
            self.config = config

            # Reinitialize mode handler if mode changed
            if old_mode != config.mode:
                self.mode_handler = await asyncio.get_event_loop().run_in_executor(
                    None, lambda: ModeFactory.create_handler(config)
                )
                self.logger.info(f"Switched from {old_mode.value} to {config.mode.value} mode")

    async def get_stats(self) -> Dict[str, Any]:
        """Get usage statistics"""
        with self._stats_lock:
            stats = self.stats.copy()

        stats.update(
            {
                "mode": self.config.mode.value,
                "policy_name": self.policy.name,
                "threat_rate": (stats["threats_detected"] / max(stats["total_requests"], 1) * 100),
                "performance_metrics": self.performance.get_metrics(),
            }
        )
        return stats

    async def get_health_status(self) -> Dict[str, Any]:
        """Get health status of the client and its components"""
        return {
            "status": "healthy",
            "mode": self.config.mode.value,
            "mode_handler_status": getattr(self.mode_handler, "get_health_status", lambda: {})(),
            "policy_enabled": self.policy.enabled,
            "cache_enabled": self.config.enable_caching,
            "stats": await self.get_stats(),
        }

    async def _validate_prompt(self, prompt: str) -> None:
        """Validate a single prompt"""
        if prompt is None:
            raise ValidationError(
                "Prompt cannot be None",
                error_code=ErrorCode.VALIDATION_INVALID_INPUT_TYPE,
                expected_type="str",
                received_type=type(prompt).__name__,
            )

        if not isinstance(prompt, str):
            raise ValidationError(
                f"Prompt must be a string, got {type(prompt).__name__}",
                error_code=ErrorCode.VALIDATION_INVALID_INPUT_TYPE,
                expected_type="str",
                received_type=type(prompt).__name__,
            )

        if len(prompt.strip()) == 0:
            raise ValidationError(
                "Prompt cannot be empty or contain only whitespace",
                error_code=ErrorCode.VALIDATION_EMPTY_PROMPT,
                prompt_length=len(prompt),
                stripped_length=len(prompt.strip()),
            )

        # Check maximum prompt length
        max_length = getattr(self.config, "max_prompt_length", 100000)
        if len(prompt) > max_length:
            raise ValidationError(
                f"Prompt exceeds maximum length of {max_length} characters",
                error_code=ErrorCode.VALIDATION_PROMPT_TOO_LONG,
                prompt_length=len(prompt),
                max_length=max_length,
            )

    async def _validate_batch(self, prompts: List[str]) -> None:
        """Validate a batch of prompts"""
        if not isinstance(prompts, list):
            raise ValidationError(
                f"Prompts must be a list, got {type(prompts).__name__}",
                error_code=ErrorCode.VALIDATION_INVALID_INPUT_TYPE,
                expected_type="List[str]",
                received_type=type(prompts).__name__,
            )

        # Check batch size limits
        max_batch_size = getattr(self.config, "max_batch_size", 100)
        if len(prompts) > max_batch_size:
            raise ValidationError(
                f"Batch size {len(prompts)} exceeds maximum of {max_batch_size}",
                error_code=ErrorCode.VALIDATION_BATCH_TOO_LARGE,
                batch_size=len(prompts),
                max_batch_size=max_batch_size,
            )

        # Validate each prompt in the batch
        for i, prompt in enumerate(prompts):
            if not isinstance(prompt, str):
                raise ValidationError(
                    f"Prompt at index {i} must be a string, got {type(prompt).__name__}",
                    error_code=ErrorCode.VALIDATION_INVALID_INPUT_TYPE,
                    prompt_index=i,
                    expected_type="str",
                    received_type=type(prompt).__name__,
                )

    async def _update_stats(self, result: AnalysisResult, response_time: float) -> None:
        """Update internal statistics (thread-safe)"""
        with self._stats_lock:
            self.stats["total_requests"] += 1

            if result.is_threat:
                self.stats["threats_detected"] += 1

            # Update average response time
            current_avg = self.stats["avg_response_time_ms"]
            total_requests = self.stats["total_requests"]
            response_time_ms = response_time * 1000

            self.stats["avg_response_time_ms"] = (
                current_avg * (total_requests - 1) + response_time_ms
            ) / total_requests

            # Update mode-specific stats
            if result.detection_method == DetectionMethod.LOCAL_RULES:
                self.stats["local_analyses"] += 1
            elif result.detection_method == DetectionMethod.API_ENHANCED:
                self.stats["api_calls"] += 1

    def _log_result(self, result: AnalysisResult, policy_action: PolicyAction) -> None:
        """Log analysis result"""
        if self.config.log_all_requests or result.is_threat:
            if result.is_threat:
                self.logger.warning(f"🚨 {result.summary} | Action: {policy_action.value}")
            else:
                self.logger.info(f"✅ {result.summary}")

    async def __aenter__(self):
        """Async context manager entry"""
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit"""
        if hasattr(self.mode_handler, "close"):
            if asyncio.iscoroutinefunction(self.mode_handler.close):
                await self.mode_handler.close()
            else:
                await asyncio.get_event_loop().run_in_executor(None, self.mode_handler.close)

        # Log final statistics
        stats = await self.get_stats()
        self.logger.info(
            f"Async session complete: {stats['total_requests']} requests, "
            f"{stats['threats_detected']} threats detected, "
            f"{stats['avg_response_time_ms']:.1f}ms avg response time"
        )
