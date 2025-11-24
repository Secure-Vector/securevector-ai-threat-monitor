"""
Main public interface for the SecureVector AI Threat Monitor SDK.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import hashlib
import hmac
import logging
import secrets
import time
from typing import Any, Dict, Generic, List, Optional, Protocol, TypeVar, Union, overload

# Handle typing_extensions imports with fallbacks for older Python versions
try:
    from typing_extensions import Concatenate, Literal, ParamSpec, TypedDict
except ImportError:
    try:
        # Python 3.8+ has some of these in typing
        from typing import Literal, TypedDict

        # Create dummy types for missing ones
        ParamSpec = TypeVar
        Concatenate = Any
    except ImportError:
        # Fallback for older Python versions
        Literal = Any
        TypedDict = dict
        ParamSpec = TypeVar
        Concatenate = Any

from .models.analysis_result import AnalysisResult, DetectionMethod, ThreatDetection
from .models.config_models import OperationMode, SDKConfig
from .models.policy_models import PolicyAction, SecurityPolicy
from .models.threat_types import RiskLevel, ThreatType
from .types import (
    BaseSecureVectorClient,
    HealthStatusDict,
    OperationModeType,
    StatisticsDict,
    SyncClientContextManager,
)

from securevector.core.modes.mode_factory import ModeFactory
from securevector.utils.exceptions import (
    APIError,
    ConfigurationError,
    ErrorCode,
    SecurityException,
    ValidationError,
)
from securevector.utils.logger import get_logger
from securevector.utils.performance import PerformanceTracker
from securevector.utils.security import secure_cache_key_derivation
from securevector.utils.telemetry import debug_log, get_telemetry_collector, record_event, trace_operation


def _constant_time_string_compare(s1: str, s2: str) -> bool:
    """
    Constant-time string comparison to prevent timing attacks.

    Args:
        s1: First string to compare
        s2: Second string to compare

    Returns:
        bool: True if strings are equal, False otherwise

    Security note:
    - Always performs the same number of operations regardless of string content
    - Prevents timing-based attacks that could infer string values
    """
    if len(s1) != len(s2):
        # Still perform constant-time comparison on dummy data
        _ = hmac.compare_digest(
            s1.ljust(max(len(s1), len(s2))), s2.ljust(max(len(s1), len(s2)))
        )
        return False
    return hmac.compare_digest(s1.encode("utf-8"), s2.encode("utf-8"))


def _sanitize_error_for_response(error: Exception, include_details: bool = False) -> str:
    """
    Sanitize error messages to prevent information disclosure.

    Args:
        error: The exception to sanitize
        include_details: Whether to include detailed error information

    Returns:
        str: Sanitized error message

    Security note:
    - Prevents leaking sensitive information through error messages
    - Provides consistent response format regardless of error type
    """
    if include_details and isinstance(error, (ValidationError, ConfigurationError)):
        return str(error)

    # Generic error messages to prevent information disclosure
    if isinstance(error, ValidationError):
        return "Invalid input provided"
    elif isinstance(error, SecurityException):
        return "Security policy violation detected"
    elif isinstance(error, APIError):
        return "Service temporarily unavailable"
    elif isinstance(error, ConfigurationError):
        return "Configuration error occurred"
    else:
        return "An error occurred during processing"


class SecureVectorClient:
    """
    Main client interface for the SecureVector AI Threat Monitor SDK.

    Provides unified access to threat detection across multiple modes:
    - Local mode: Fast, offline detection using community rules
    - API mode: Enhanced detection via SecureVector API
    - Hybrid mode: Intelligent combination of local and API
    - Auto mode: Automatic mode selection based on configuration
    """

    def __init__(
        self,
        mode: Union[OperationModeType, OperationMode] = OperationMode.AUTO,
        api_key: Optional[str] = None,
        config: Optional[SDKConfig] = None,
        policy: Optional[SecurityPolicy] = None,
        **kwargs: Any,
    ) -> None:
        """
        Initialize the SecureVector client.

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

        # Initialize telemetry
        self.telemetry = get_telemetry_collector()
        if self.telemetry:
            self.telemetry.record_event(
                event_type="client_initialized",
                source="sdk.client",
                data={
                    "mode": mode.value if isinstance(mode, OperationMode) else mode,
                    "has_api_key": bool(api_key),
                    "performance_monitoring": self.config.performance_monitoring,
                    "caching_enabled": self.config.enable_caching,
                },
            )

        # Initialize the appropriate mode handler
        try:
            self.mode_handler = ModeFactory.create_handler(self.config)
            self.logger.info(f"Initialized SecureVector client in {mode.value} mode")
        except ConfigurationError:
            # Re-raise ConfigurationError as-is to avoid duplication
            raise
        except Exception as e:
            self.logger.error(f"Failed to initialize mode handler: {e}")
            raise ConfigurationError(f"Failed to initialize {mode.value} mode: {e}")

        # Statistics tracking
        self.stats = {
            "total_requests": 0,
            "threats_detected": 0,
            "threats_blocked": 0,
            "avg_response_time_ms": 0.0,
            "cache_hits": 0,
            "api_calls": 0,
            "local_analyses": 0,
        }

    def analyze(self, prompt: str, **kwargs) -> AnalysisResult:
        """
        Analyze a prompt for security threats.

        Args:
            prompt: The prompt text to analyze
            **kwargs: Additional analysis options

        Returns:
            AnalysisResult: Complete analysis result with threat detection

        Raises:
            SecurityException: If a threat is detected and raise_on_threat is True
        """
        start_time = time.time()

        # Enhanced telemetry and debugging
        with trace_operation(
            "analyze_prompt", prompt_length=len(prompt) if prompt else 0
        ) as _:
            try:
                # Enhanced input validation with structured error codes
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

                # Generate secure prompt hash for tracking and caching
                context = {"user_id": kwargs.get("user_id"), "session_id": kwargs.get("session_id")}
                # Use full hash to prevent collision attacks and information disclosure
                prompt_hash = secure_cache_key_derivation(prompt, context)

                # Perform analysis using the configured mode
                result = self.mode_handler.analyze(prompt, **kwargs)

                # Add prompt hash and ensure timestamp is set
                result.prompt_hash = prompt_hash
                if result.timestamp is None:
                    from datetime import datetime

                    result.timestamp = datetime.utcnow()

                # Apply security policy
                policy_action = self.policy.evaluate(
                    risk_score=result.risk_score,
                    threat_types=result.threat_types,
                    confidence=result.confidence,
                    prompt=prompt,
                )

                # Update statistics
                self._update_stats(result, time.time() - start_time)

                # Log the result
                self._log_result(result, policy_action)

                # Handle policy action
                if policy_action == PolicyAction.BLOCK or (
                    result.is_threat and self.config.raise_on_threat
                ):
                    self.stats["threats_blocked"] += 1
                    raise SecurityException(
                        f"Threat detected: {result.summary}", result=result, action=policy_action
                    )

                return result

            except SecurityException:
                # Re-raise security exceptions
                raise
            except Exception as e:
                # Log detailed error internally but don't expose sensitive information
                self.logger.error(
                    f"Analysis failed: {type(e).__name__}: {_sanitize_error_for_response(e, include_details=True)}"
                )

                # Ensure consistent response time to prevent timing attacks
                elapsed = time.time() - start_time
                min_response_time = 0.01  # Minimum 10ms response time
                if elapsed < min_response_time:
                    time.sleep(min_response_time - elapsed)

                # Return a safe fallback result without exposing error details
                return AnalysisResult(
                    is_threat=False,
                    risk_score=0,
                    confidence=0.0,
                    detections=[],
                    analysis_time_ms=(time.time() - start_time) * 1000,
                    detection_method=DetectionMethod.LOCAL_RULES,
                    prompt_hash=secure_cache_key_derivation(prompt, context),
                )

    def analyze_batch(self, prompts: List[str], **kwargs) -> List[AnalysisResult]:
        """
        Analyze multiple prompts in batch.

        Args:
            prompts: List of prompt strings to analyze
            **kwargs: Additional analysis options

        Returns:
            List[AnalysisResult]: Analysis results for each prompt

        Raises:
            ValidationError: If prompts list is invalid
        """
        # Enhanced batch validation
        if not isinstance(prompts, list):
            raise ValidationError(
                f"Prompts must be a list, got {type(prompts).__name__}",
                error_code=ErrorCode.VALIDATION_INVALID_INPUT_TYPE,
                expected_type="List[str]",
                received_type=type(prompts).__name__,
            )

        if len(prompts) == 0:
            return []

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

        if hasattr(self.mode_handler, "analyze_batch"):
            return self.mode_handler.analyze_batch(prompts, **kwargs)

        # Fallback to individual analysis
        results = []
        for prompt in prompts:
            try:
                result = self.analyze(prompt, **kwargs)
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

    def is_threat(self, prompt: str, **kwargs) -> bool:
        """
        Simple boolean check if prompt is a threat.

        Args:
            prompt: The prompt text to analyze
            **kwargs: Additional analysis options

        Returns:
            bool: True if threat detected, False otherwise
        """
        try:
            result = self.analyze(prompt, **kwargs)
            return result.is_threat
        except SecurityException:
            return True
        except Exception:
            return False

    def get_risk_score(self, prompt: str, **kwargs) -> int:
        """
        Get the risk score for a prompt.

        Args:
            prompt: The prompt text to analyze
            **kwargs: Additional analysis options

        Returns:
            int: Risk score (0-100)
        """
        try:
            result = self.analyze(prompt, **kwargs)
            return result.risk_score
        except SecurityException as e:
            if hasattr(e, "result") and e.result:
                return e.result.risk_score
            return 100
        except Exception:
            return 0

    def update_policy(self, policy: SecurityPolicy) -> None:
        """Update the security policy"""
        self.policy = policy
        self.logger.info(f"Updated security policy: {policy.name}")

    def update_config(self, config: SDKConfig) -> None:
        """Update the SDK configuration"""
        old_mode = self.config.mode
        self.config = config

        # Reinitialize mode handler if mode changed
        if old_mode != config.mode:
            self.mode_handler = ModeFactory.create_handler(config)
            self.logger.info(f"Switched from {old_mode.value} to {config.mode.value} mode")

    def get_stats(self) -> StatisticsDict:
        """Get usage statistics"""
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

    def get_health_status(self) -> HealthStatusDict:
        """Get health status of the client and its components"""
        return {
            "status": "healthy",
            "mode": self.config.mode.value,
            "mode_handler_status": getattr(self.mode_handler, "get_health_status", lambda: {})(),
            "policy_enabled": self.policy.enabled,
            "cache_enabled": self.config.enable_caching,
            "stats": self.get_stats(),
        }

    def _update_stats(self, result: AnalysisResult, response_time: float) -> None:
        """Update internal statistics"""
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

    def __enter__(self):
        """Context manager entry"""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit"""
        if hasattr(self.mode_handler, "close"):
            self.mode_handler.close()

        # Log final statistics
        stats = self.get_stats()
        self.logger.info(
            f"Session complete: {stats['total_requests']} requests, "
            f"{stats['threats_detected']} threats detected, "
            f"{stats['avg_response_time_ms']:.1f}ms avg response time"
        )
