"""
Retry utilities with exponential backoff for the SecureVector AI Threat Monitor SDK.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import asyncio
import logging
import random
import time
from functools import wraps
from typing import Any, Callable, Optional, Tuple, Type, Union

from .exceptions import (
    APIError,
    AuthenticationError,
    CircuitBreakerError,
    ErrorCode,
    RateLimitError,
)


class RetryConfig:
    """Configuration for retry behavior"""

    def __init__(
        self,
        max_attempts: int = 3,
        base_delay: float = 1.0,
        max_delay: float = 60.0,
        exponential_base: float = 2.0,
        jitter: bool = True,
        retryable_exceptions: Tuple[Type[Exception], ...] = None,
    ):
        """
        Initialize retry configuration.

        Args:
            max_attempts: Maximum number of retry attempts
            base_delay: Base delay in seconds before first retry
            max_delay: Maximum delay in seconds between retries
            exponential_base: Base for exponential backoff calculation
            jitter: Whether to add random jitter to delays
            retryable_exceptions: Tuple of exception types to retry on
        """
        self.max_attempts = max_attempts
        self.base_delay = base_delay
        self.max_delay = max_delay
        self.exponential_base = exponential_base
        self.jitter = jitter
        self.retryable_exceptions = retryable_exceptions or (
            APIError,
            ConnectionError,
            TimeoutError,
        )
        # Never retry authentication errors or circuit breaker errors
        self.non_retryable_exceptions = (
            AuthenticationError,
            CircuitBreakerError,
        )

    def calculate_delay(self, attempt: int) -> float:
        """Calculate delay for given attempt number"""
        if attempt <= 0:
            return 0

        # Exponential backoff: base_delay * (exponential_base ^ (attempt - 1))
        delay = self.base_delay * (self.exponential_base ** (attempt - 1))

        # Cap at max_delay
        delay = min(delay, self.max_delay)

        # Add jitter if enabled (±25% of delay)
        if self.jitter:
            jitter_range = delay * 0.25
            delay += random.uniform(-jitter_range, jitter_range)

        return max(0, delay)

    def should_retry(self, exception: Exception, attempt: int) -> bool:
        """Determine if we should retry based on exception and attempt count"""
        if attempt >= self.max_attempts:
            return False

        # Never retry certain exception types
        if isinstance(exception, self.non_retryable_exceptions):
            return False

        # Handle rate limit errors specially
        if isinstance(exception, RateLimitError):
            # Only retry if we have retry_after information
            return hasattr(exception, "context") and "retry_after_seconds" in exception.context

        # Retry if it's a retryable exception type
        return isinstance(exception, self.retryable_exceptions)


def with_retry(config: Optional[RetryConfig] = None):
    """
    Decorator to add retry logic with exponential backoff to functions.

    Args:
        config: RetryConfig instance, uses default if None
    """
    if config is None:
        config = RetryConfig()

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def wrapper(*args, **kwargs):
            last_exception = None

            for attempt in range(config.max_attempts):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    last_exception = e

                    if not config.should_retry(e, attempt + 1):
                        raise

                    # Calculate delay for next attempt
                    if attempt < config.max_attempts - 1:  # Don't delay after last attempt
                        delay = config.calculate_delay(attempt + 1)

                        # Handle rate limit retry_after
                        if isinstance(e, RateLimitError) and hasattr(e, "context"):
                            retry_after = e.context.get("retry_after_seconds")
                            if retry_after:
                                delay = max(delay, retry_after)

                        logging.getLogger(__name__).warning(
                            f"Attempt {attempt + 1} failed with {type(e).__name__}: {e}. "
                            f"Retrying in {delay:.2f}s..."
                        )
                        time.sleep(delay)

            # All attempts failed, raise the last exception
            raise last_exception

        return wrapper

    return decorator


def with_async_retry(config: Optional[RetryConfig] = None):
    """
    Decorator to add async retry logic with exponential backoff to async functions.

    Args:
        config: RetryConfig instance, uses default if None
    """
    if config is None:
        config = RetryConfig()

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def wrapper(*args, **kwargs):
            last_exception = None

            for attempt in range(config.max_attempts):
                try:
                    return await func(*args, **kwargs)
                except Exception as e:
                    last_exception = e

                    if not config.should_retry(e, attempt + 1):
                        raise

                    # Calculate delay for next attempt
                    if attempt < config.max_attempts - 1:  # Don't delay after last attempt
                        delay = config.calculate_delay(attempt + 1)

                        # Handle rate limit retry_after
                        if isinstance(e, RateLimitError) and hasattr(e, "context"):
                            retry_after = e.context.get("retry_after_seconds")
                            if retry_after:
                                delay = max(delay, retry_after)

                        logging.getLogger(__name__).warning(
                            f"Async attempt {attempt + 1} failed with {type(e).__name__}: {e}. "
                            f"Retrying in {delay:.2f}s..."
                        )
                        await asyncio.sleep(delay)

            # All attempts failed, raise the last exception
            raise last_exception

        return wrapper

    return decorator


class CircuitBreaker:
    """
    Circuit breaker implementation for API protection.

    States:
    - CLOSED: Normal operation, requests pass through
    - OPEN: Failing fast, requests immediately fail
    - HALF_OPEN: Testing if service has recovered
    """

    def __init__(
        self,
        failure_threshold: int = 5,
        recovery_timeout: float = 60.0,
        expected_exception: Type[Exception] = Exception,
    ):
        """
        Initialize circuit breaker.

        Args:
            failure_threshold: Number of failures before opening circuit
            recovery_timeout: Seconds to wait before trying again
            expected_exception: Exception type that counts as failure
        """
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.expected_exception = expected_exception

        self.failure_count = 0
        self.last_failure_time = None
        self.state = "CLOSED"  # CLOSED, OPEN, HALF_OPEN

        self.logger = logging.getLogger(__name__)

    def call(self, func: Callable, *args, **kwargs) -> Any:
        """Execute function with circuit breaker protection"""
        if self.state == "OPEN":
            if self._should_attempt_reset():
                self.state = "HALF_OPEN"
                self.logger.info("Circuit breaker moving to HALF_OPEN state")
            else:
                raise CircuitBreakerError(
                    f"Circuit breaker is OPEN. Service unavailable.",
                    error_code=ErrorCode.CIRCUIT_BREAKER_OPEN,
                    failure_count=self.failure_count,
                    last_failure_time=self.last_failure_time,
                )

        try:
            result = func(*args, **kwargs)
            self._on_success()
            return result
        except self.expected_exception:
            self._on_failure()
            raise

    async def call_async(self, func: Callable, *args, **kwargs) -> Any:
        """Execute async function with circuit breaker protection"""
        if self.state == "OPEN":
            if self._should_attempt_reset():
                self.state = "HALF_OPEN"
                self.logger.info("Circuit breaker moving to HALF_OPEN state")
            else:
                raise CircuitBreakerError(
                    f"Circuit breaker is OPEN. Service unavailable.",
                    error_code=ErrorCode.CIRCUIT_BREAKER_OPEN,
                    failure_count=self.failure_count,
                    last_failure_time=self.last_failure_time,
                )

        try:
            result = await func(*args, **kwargs)
            self._on_success()
            return result
        except self.expected_exception:
            self._on_failure()
            raise

    def _should_attempt_reset(self) -> bool:
        """Check if enough time has passed to attempt reset"""
        if self.last_failure_time is None:
            return True
        return time.time() - self.last_failure_time >= self.recovery_timeout

    def _on_success(self):
        """Handle successful call"""
        if self.state == "HALF_OPEN":
            self.state = "CLOSED"
            self.logger.info("Circuit breaker reset to CLOSED state")
        self.failure_count = 0

    def _on_failure(self):
        """Handle failed call"""
        self.failure_count += 1
        self.last_failure_time = time.time()

        if self.failure_count >= self.failure_threshold:
            self.state = "OPEN"
            self.logger.warning(f"Circuit breaker opened after {self.failure_count} failures")


# Default retry configurations for different scenarios
API_RETRY_CONFIG = RetryConfig(
    max_attempts=3, base_delay=1.0, max_delay=30.0, exponential_base=2.0, jitter=True
)

AGGRESSIVE_RETRY_CONFIG = RetryConfig(
    max_attempts=5, base_delay=0.5, max_delay=60.0, exponential_base=2.0, jitter=True
)

CONSERVATIVE_RETRY_CONFIG = RetryConfig(
    max_attempts=2, base_delay=2.0, max_delay=10.0, exponential_base=1.5, jitter=True
)
