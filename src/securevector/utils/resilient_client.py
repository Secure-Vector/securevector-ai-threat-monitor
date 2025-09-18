"""
Resilient client wrapper that ensures network issues never break the SDK.

This module provides automatic fallback mechanisms and graceful degradation
when network issues occur, following SDK-Builder principles of resilience.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import asyncio
import logging
import time
from contextlib import contextmanager
from functools import wraps
from typing import Any, Callable, Dict, List, Optional, Union

from securevector.models.analysis_result import (
    AnalysisResult,
    DetectionMethod,
    ThreatDetection,
)
from securevector.models.config_models import OperationMode
from .exceptions import (
    APIError,
    AuthenticationError,
    CircuitBreakerError,
    ConfigurationError,
    ErrorCode,
    RateLimitError,
)
from .retry import CircuitBreaker, RetryConfig, with_async_retry, with_retry
from .telemetry import debug_log, record_event


class NetworkResilienceManager:
    """Manages network resilience and automatic fallbacks"""

    def __init__(
        self,
        enable_fallback: bool = True,
        fallback_timeout: float = 5.0,
        max_consecutive_failures: int = 3,
    ):
        """
        Initialize network resilience manager.

        Args:
            enable_fallback: Whether to enable automatic fallback to local mode
            fallback_timeout: Timeout before triggering fallback (seconds)
            max_consecutive_failures: Max failures before permanent fallback
        """
        self.enable_fallback = enable_fallback
        self.fallback_timeout = fallback_timeout
        self.max_consecutive_failures = max_consecutive_failures

        self.logger = logging.getLogger(__name__)

        # Failure tracking
        self._consecutive_failures = 0
        self._last_failure_time = 0
        self._permanent_fallback = False

        # Circuit breaker for API calls
        self._circuit_breaker = CircuitBreaker(
            failure_threshold=max_consecutive_failures,
            recovery_timeout=60.0,  # 1 minute recovery time
            expected_exception=APIError,
        )

        # Local fallback client cache
        self._local_fallback_client = None

    def wrap_client_method(self, method: Callable, fallback_method: Optional[Callable] = None):
        """Wrap a client method with network resilience"""

        @wraps(method)
        def resilient_wrapper(*args, **kwargs):
            return self._execute_with_fallback(method, fallback_method, *args, **kwargs)

        return resilient_wrapper

    def wrap_async_client_method(
        self, method: Callable, fallback_method: Optional[Callable] = None
    ):
        """Wrap an async client method with network resilience"""

        @wraps(method)
        async def resilient_async_wrapper(*args, **kwargs):
            return await self._execute_async_with_fallback(method, fallback_method, *args, **kwargs)

        return resilient_async_wrapper

    def _execute_with_fallback(
        self, primary_method: Callable, fallback_method: Optional[Callable], *args, **kwargs
    ) -> Any:
        """Execute method with automatic fallback on network issues"""

        # Check if we're in permanent fallback mode
        if self._permanent_fallback and fallback_method:
            debug_log("Using permanent fallback due to repeated failures")
            return fallback_method(*args, **kwargs)

        try:
            # Try primary method with circuit breaker protection
            result = self._circuit_breaker.call(primary_method, *args, **kwargs)

            # Success - reset failure counter
            self._consecutive_failures = 0
            return result

        except CircuitBreakerError as e:
            self.logger.warning(f"Circuit breaker is open: {e}")
            record_event(
                "circuit_breaker_triggered",
                "resilience.network",
                {"failure_count": self._circuit_breaker.failure_count},
            )

            if fallback_method and self.enable_fallback:
                return self._execute_fallback(fallback_method, *args, **kwargs)
            else:
                # Convert to a more user-friendly error
                raise APIError(
                    "Service temporarily unavailable. Please try again later.",
                    error_code=ErrorCode.API_SERVICE_UNAVAILABLE,
                )

        except (APIError, ConnectionError, TimeoutError) as e:
            self._handle_network_failure(e)

            if fallback_method and self.enable_fallback:
                return self._execute_fallback(fallback_method, *args, **kwargs)
            else:
                # Don't re-raise network errors - convert to graceful degradation
                self.logger.error(f"Network error occurred: {e}")
                return self._create_error_result(str(e))

        except AuthenticationError:
            # Authentication errors should not trigger fallback
            raise

        except Exception as e:
            self.logger.error(f"Unexpected error in resilient wrapper: {e}")

            if fallback_method and self.enable_fallback:
                return self._execute_fallback(fallback_method, *args, **kwargs)
            else:
                return self._create_error_result(f"Analysis failed: {str(e)}")

    async def _execute_async_with_fallback(
        self, primary_method: Callable, fallback_method: Optional[Callable], *args, **kwargs
    ) -> Any:
        """Execute async method with automatic fallback on network issues"""

        if self._permanent_fallback and fallback_method:
            debug_log("Using permanent fallback due to repeated failures")
            if asyncio.iscoroutinefunction(fallback_method):
                return await fallback_method(*args, **kwargs)
            else:
                return fallback_method(*args, **kwargs)

        try:
            # Try primary method with circuit breaker protection
            result = await self._circuit_breaker.call_async(primary_method, *args, **kwargs)

            # Success - reset failure counter
            self._consecutive_failures = 0
            return result

        except CircuitBreakerError as e:
            self.logger.warning(f"Circuit breaker is open: {e}")
            record_event(
                "circuit_breaker_triggered",
                "resilience.network",
                {"failure_count": self._circuit_breaker.failure_count},
            )

            if fallback_method and self.enable_fallback:
                return await self._execute_async_fallback(fallback_method, *args, **kwargs)
            else:
                raise APIError(
                    "Service temporarily unavailable. Please try again later.",
                    error_code=ErrorCode.API_SERVICE_UNAVAILABLE,
                )

        except (APIError, ConnectionError, TimeoutError) as e:
            self._handle_network_failure(e)

            if fallback_method and self.enable_fallback:
                return await self._execute_async_fallback(fallback_method, *args, **kwargs)
            else:
                self.logger.error(f"Network error occurred: {e}")
                return self._create_error_result(str(e))

        except AuthenticationError:
            raise

        except Exception as e:
            self.logger.error(f"Unexpected error in async resilient wrapper: {e}")

            if fallback_method and self.enable_fallback:
                return await self._execute_async_fallback(fallback_method, *args, **kwargs)
            else:
                return self._create_error_result(f"Analysis failed: {str(e)}")

    def _handle_network_failure(self, error: Exception) -> None:
        """Handle network failure and update failure tracking"""
        self._consecutive_failures += 1
        self._last_failure_time = time.time()

        record_event(
            "network_failure",
            "resilience.network",
            {
                "error_type": type(error).__name__,
                "error_message": str(error),
                "consecutive_failures": self._consecutive_failures,
            },
        )

        # Check if we should enable permanent fallback
        if (
            self._consecutive_failures >= self.max_consecutive_failures
            and not self._permanent_fallback
        ):
            self._permanent_fallback = True
            self.logger.warning(
                f"Enabling permanent fallback after {self._consecutive_failures} consecutive failures"
            )
            record_event(
                "permanent_fallback_enabled",
                "resilience.network",
                {"consecutive_failures": self._consecutive_failures},
            )

    def _execute_fallback(self, fallback_method: Callable, *args, **kwargs) -> Any:
        """Execute fallback method"""
        try:
            self.logger.info("Executing fallback method due to network issues")
            result = fallback_method(*args, **kwargs)

            record_event(
                "fallback_executed",
                "resilience.network",
                {"method": fallback_method.__name__, "success": True},
            )

            return result

        except Exception as e:
            self.logger.error(f"Fallback method also failed: {e}")
            record_event(
                "fallback_failed",
                "resilience.network",
                {"method": fallback_method.__name__, "error": str(e)},
            )

            return self._create_error_result(f"Both primary and fallback methods failed: {str(e)}")

    async def _execute_async_fallback(self, fallback_method: Callable, *args, **kwargs) -> Any:
        """Execute async fallback method"""
        try:
            self.logger.info("Executing async fallback method due to network issues")

            if asyncio.iscoroutinefunction(fallback_method):
                result = await fallback_method(*args, **kwargs)
            else:
                result = fallback_method(*args, **kwargs)

            record_event(
                "fallback_executed",
                "resilience.network",
                {"method": fallback_method.__name__, "success": True, "async": True},
            )

            return result

        except Exception as e:
            self.logger.error(f"Async fallback method also failed: {e}")
            record_event(
                "fallback_failed",
                "resilience.network",
                {"method": fallback_method.__name__, "error": str(e), "async": True},
            )

            return self._create_error_result(f"Both primary and fallback methods failed: {str(e)}")

    def _create_error_result(self, error_message: str) -> AnalysisResult:
        """Create a safe error result instead of raising exceptions"""
        return AnalysisResult(
            is_threat=False,  # Err on the side of caution - don't block on errors
            risk_score=0,
            confidence=0.0,
            detections=[],
            analysis_time_ms=0.0,
            detection_method=DetectionMethod.LOCAL_RULES,
            summary=f"Analysis unavailable: {error_message}",
            metadata={"error": True, "error_message": error_message, "fallback_used": True},
        )

    def reset_failures(self) -> None:
        """Reset failure tracking (useful for testing or manual recovery)"""
        self._consecutive_failures = 0
        self._permanent_fallback = False
        self._circuit_breaker = CircuitBreaker(
            failure_threshold=self.max_consecutive_failures,
            recovery_timeout=60.0,
            expected_exception=APIError,
        )
        self.logger.info("Network failure tracking reset")

    def get_status(self) -> Dict[str, Any]:
        """Get current resilience status"""
        return {
            "consecutive_failures": self._consecutive_failures,
            "permanent_fallback": self._permanent_fallback,
            "circuit_breaker_state": self._circuit_breaker.state,
            "last_failure_time": self._last_failure_time,
            "enable_fallback": self.enable_fallback,
        }


class ResilientClientMixin:
    """Mixin to add network resilience to client classes"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        # Initialize resilience manager
        self._resilience_manager = NetworkResilienceManager(
            enable_fallback=getattr(self.config, "enable_network_fallback", True),
            max_consecutive_failures=getattr(self.config, "max_network_failures", 3),
        )

        # Set up local fallback client if needed
        self._setup_local_fallback()

    def _setup_local_fallback(self):
        """Set up local fallback client for network resilience"""
        if self.config.mode in [OperationMode.API, OperationMode.HYBRID]:
            try:
                # Create a local-only configuration for fallback
                from securevector.models.config_models import SDKConfig

                fallback_config = SDKConfig()
                fallback_config.mode = OperationMode.LOCAL
                fallback_config.local_config = self.config.local_config

                # Import here to avoid circular imports
                from securevector.client import SecureVectorClient

                self._local_fallback_client = SecureVectorClient(config=fallback_config)

                self.logger.debug("Local fallback client initialized")

            except Exception as e:
                self.logger.warning(f"Could not initialize local fallback client: {e}")
                self._local_fallback_client = None

    def _get_fallback_analyze(self):
        """Get fallback analyze method"""
        if self._local_fallback_client:
            return self._local_fallback_client.analyze
        return None

    def _get_fallback_analyze_batch(self):
        """Get fallback analyze_batch method"""
        if self._local_fallback_client:
            return self._local_fallback_client.analyze_batch
        return None


# Decorators for adding resilience to methods
def resilient_network_call(fallback_method: Optional[str] = None):
    """Decorator to make network calls resilient with automatic fallback"""

    def decorator(method):
        @wraps(method)
        def wrapper(self, *args, **kwargs):
            if hasattr(self, "_resilience_manager"):
                fallback = getattr(self, fallback_method, None) if fallback_method else None
                return self._resilience_manager._execute_with_fallback(
                    method, fallback, self, *args, **kwargs
                )
            else:
                return method(self, *args, **kwargs)

        return wrapper

    return decorator


def resilient_async_network_call(fallback_method: Optional[str] = None):
    """Decorator to make async network calls resilient with automatic fallback"""

    def decorator(method):
        @wraps(method)
        async def wrapper(self, *args, **kwargs):
            if hasattr(self, "_resilience_manager"):
                fallback = getattr(self, fallback_method, None) if fallback_method else None
                return await self._resilience_manager._execute_async_with_fallback(
                    method, fallback, self, *args, **kwargs
                )
            else:
                return await method(self, *args, **kwargs)

        return wrapper

    return decorator


# Global resilience manager for convenience
_global_resilience_manager: Optional[NetworkResilienceManager] = None


def get_global_resilience_manager() -> NetworkResilienceManager:
    """Get global resilience manager instance"""
    global _global_resilience_manager
    if _global_resilience_manager is None:
        _global_resilience_manager = NetworkResilienceManager()
    return _global_resilience_manager


@contextmanager
def resilient_network_context(enable_fallback: bool = True):
    """Context manager for resilient network operations"""
    manager = NetworkResilienceManager(enable_fallback=enable_fallback)
    try:
        yield manager
    finally:
        # Cleanup if needed
        pass
