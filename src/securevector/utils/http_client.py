"""
High-performance HTTP client with connection pooling and advanced features.

This module provides optimized HTTP clients with connection pooling, retry logic,
and performance monitoring for the SecureVector AI Threat Monitor SDK.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import asyncio
import json
import logging
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Union
from urllib.parse import urlparse

from .exceptions import APIError, AuthenticationError, ErrorCode, RateLimitError
from .retry import RetryConfig, with_async_retry, with_retry
from .telemetry import debug_log, record_metric


@dataclass
class ConnectionPoolConfig:
    """Configuration for HTTP connection pooling"""

    max_pool_size: int = 100
    max_connections_per_host: int = 10
    connection_timeout: float = 30.0
    read_timeout: float = 30.0
    keepalive_timeout: float = 300.0  # 5 minutes
    max_retries: int = 3
    retry_backoff_factor: float = 0.5
    enable_compression: bool = True
    verify_ssl: bool = True


class HTTPConnectionPool:
    """High-performance HTTP connection pool with advanced features"""

    def __init__(self, config: ConnectionPoolConfig):
        """Initialize connection pool"""
        self.config = config
        self.logger = logging.getLogger(__name__)

        # Connection pool storage
        self._pools: Dict[str, Any] = {}
        self._pool_stats: Dict[str, Dict[str, int]] = {}
        self._lock = threading.RLock()

        # Performance metrics
        self._request_count = 0
        self._total_time = 0.0
        self._error_count = 0

        # Initialize pools
        self._initialize_pools()

    def _initialize_pools(self):
        """Initialize connection pools for sync and async operations"""
        try:
            # Try to import requests for sync operations
            import requests
            from requests.adapters import HTTPAdapter
            from urllib3.util.retry import Retry

            # Create requests session with connection pooling
            self._sync_session = requests.Session()

            # Configure retry strategy
            retry_strategy = Retry(
                total=self.config.max_retries,
                backoff_factor=self.config.retry_backoff_factor,
                status_forcelist=[429, 500, 502, 503, 504],
            )

            # Configure adapter with connection pooling
            adapter = HTTPAdapter(
                max_retries=retry_strategy,
                pool_connections=self.config.max_pool_size,
                pool_maxsize=self.config.max_connections_per_host,
                pool_block=False,
            )

            self._sync_session.mount("http://", adapter)
            self._sync_session.mount("https://", adapter)

            # Set timeouts
            self._sync_session.timeout = (self.config.connection_timeout, self.config.read_timeout)

            self.logger.debug("Initialized sync HTTP connection pool")

        except ImportError:
            self.logger.warning("requests library not available - sync HTTP disabled")
            self._sync_session = None

        # Initialize async session placeholder
        self._async_session = None

    async def _get_async_session(self):
        """Get or create async HTTP session"""
        if self._async_session is None:
            try:
                import aiohttp

                # Configure connection limits
                connector = aiohttp.TCPConnector(
                    limit=self.config.max_pool_size,
                    limit_per_host=self.config.max_connections_per_host,
                    ttl_dns_cache=300,
                    use_dns_cache=True,
                    keepalive_timeout=self.config.keepalive_timeout,
                    enable_cleanup_closed=True,
                )

                # Configure timeout
                timeout = aiohttp.ClientTimeout(
                    total=self.config.connection_timeout + self.config.read_timeout,
                    connect=self.config.connection_timeout,
                    sock_read=self.config.read_timeout,
                )

                self._async_session = aiohttp.ClientSession(
                    connector=connector,
                    timeout=timeout,
                    trust_env=True,
                    auto_decompress=self.config.enable_compression,
                )

                self.logger.debug("Initialized async HTTP connection pool")

            except ImportError:
                self.logger.error("aiohttp library not available - async HTTP disabled")
                raise APIError(
                    "Async HTTP client not available. Install aiohttp: pip install aiohttp",
                    error_code=ErrorCode.CONFIG_MISSING_DEPENDENCY,
                )

        return self._async_session

    def request(
        self,
        method: str,
        url: str,
        headers: Optional[Dict[str, str]] = None,
        data: Optional[Union[str, Dict]] = None,
        timeout: Optional[float] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        """Make synchronous HTTP request with connection pooling"""

        if self._sync_session is None:
            raise APIError(
                "Sync HTTP client not available. Install requests: pip install requests",
                error_code=ErrorCode.CONFIG_MISSING_DEPENDENCY,
            )

        start_time = time.time()

        try:
            # Prepare request data
            if isinstance(data, dict):
                data = json.dumps(data)
                if headers is None:
                    headers = {}
                headers["Content-Type"] = "application/json"

            # Make request
            response = self._sync_session.request(
                method=method,
                url=url,
                headers=headers,
                data=data,
                timeout=timeout or (self.config.connection_timeout, self.config.read_timeout),
                verify=self.config.verify_ssl,
                **kwargs,
            )

            # Update metrics
            request_time = time.time() - start_time
            self._update_metrics(url, request_time, response.status_code)

            # Handle response
            return self._handle_response(response)

        except Exception as e:
            self._error_count += 1
            request_time = time.time() - start_time
            self._update_metrics(url, request_time, 0, error=True)

            # Convert to appropriate SDK exception
            raise self._convert_exception(e)

    async def request_async(
        self,
        method: str,
        url: str,
        headers: Optional[Dict[str, str]] = None,
        data: Optional[Union[str, Dict]] = None,
        timeout: Optional[float] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        """Make asynchronous HTTP request with connection pooling"""

        session = await self._get_async_session()
        start_time = time.time()

        try:
            # Prepare request data
            if isinstance(data, dict):
                data = json.dumps(data)
                if headers is None:
                    headers = {}
                headers["Content-Type"] = "application/json"

            # Configure timeout
            if timeout:
                import aiohttp

                timeout_config = aiohttp.ClientTimeout(total=timeout)
            else:
                timeout_config = None

            # Make async request
            async with session.request(
                method=method,
                url=url,
                headers=headers,
                data=data,
                timeout=timeout_config,
                ssl=self.config.verify_ssl,
                **kwargs,
            ) as response:

                # Update metrics
                request_time = time.time() - start_time
                self._update_metrics(url, request_time, response.status)

                # Handle response
                return await self._handle_async_response(response)

        except Exception as e:
            self._error_count += 1
            request_time = time.time() - start_time
            self._update_metrics(url, request_time, 0, error=True)

            # Convert to appropriate SDK exception
            raise self._convert_exception(e)

    def _handle_response(self, response) -> Dict[str, Any]:
        """Handle synchronous response"""

        # Check for HTTP errors
        if response.status_code == 401:
            raise AuthenticationError(
                "Invalid API key or authentication failed",
                error_code=ErrorCode.AUTH_INVALID_API_KEY,
            )
        elif response.status_code == 429:
            retry_after = response.headers.get("Retry-After", "60")
            raise RateLimitError(
                f"Rate limit exceeded. Retry after {retry_after} seconds",
                error_code=ErrorCode.API_RATE_LIMIT_EXCEEDED,
                retry_after=int(retry_after),
            )
        elif response.status_code >= 400:
            error_msg = f"HTTP {response.status_code}: {response.reason}"
            try:
                error_detail = response.json().get("error", error_msg)
                error_msg = error_detail
            except (ValueError, KeyError, AttributeError):
                pass

            raise APIError(error_msg, error_code=ErrorCode.API_REQUEST_FAILED)

        # Parse JSON response
        try:
            return response.json()
        except ValueError as e:
            raise APIError(
                f"Invalid JSON response: {str(e)}", error_code=ErrorCode.API_INVALID_RESPONSE
            )

    async def _handle_async_response(self, response) -> Dict[str, Any]:
        """Handle asynchronous response"""

        # Check for HTTP errors
        if response.status == 401:
            raise AuthenticationError(
                "Invalid API key or authentication failed",
                error_code=ErrorCode.AUTH_INVALID_API_KEY,
            )
        elif response.status == 429:
            retry_after = response.headers.get("Retry-After", "60")
            raise RateLimitError(
                f"Rate limit exceeded. Retry after {retry_after} seconds",
                error_code=ErrorCode.API_RATE_LIMIT_EXCEEDED,
                retry_after=int(retry_after),
            )
        elif response.status >= 400:
            error_msg = f"HTTP {response.status}: {response.reason}"
            try:
                error_data = await response.json()
                error_detail = error_data.get("error", error_msg)
                error_msg = error_detail
            except (ValueError, KeyError, AttributeError):
                pass

            raise APIError(error_msg, error_code=ErrorCode.API_REQUEST_FAILED)

        # Parse JSON response
        try:
            return await response.json()
        except ValueError as e:
            raise APIError(
                f"Invalid JSON response: {str(e)}", error_code=ErrorCode.API_INVALID_RESPONSE
            )

    def _convert_exception(self, exc: Exception) -> Exception:
        """Convert various exceptions to SDK exceptions"""

        # Handle requests exceptions
        try:
            import requests

            if isinstance(exc, requests.exceptions.Timeout):
                return APIError(
                    "Request timeout - API server did not respond in time",
                    error_code=ErrorCode.API_TIMEOUT,
                )
            elif isinstance(exc, requests.exceptions.ConnectionError):
                return APIError(
                    "Connection error - unable to connect to API server",
                    error_code=ErrorCode.API_CONNECTION_ERROR,
                )
            elif isinstance(exc, requests.exceptions.HTTPError):
                return APIError(f"HTTP error: {str(exc)}", error_code=ErrorCode.API_REQUEST_FAILED)
        except ImportError:
            pass

        # Handle aiohttp exceptions
        try:
            import aiohttp

            if isinstance(exc, aiohttp.ClientTimeout):
                return APIError(
                    "Request timeout - API server did not respond in time",
                    error_code=ErrorCode.API_TIMEOUT,
                )
            elif isinstance(exc, aiohttp.ClientConnectionError):
                return APIError(
                    "Connection error - unable to connect to API server",
                    error_code=ErrorCode.API_CONNECTION_ERROR,
                )
            elif isinstance(exc, aiohttp.ClientError):
                return APIError(
                    f"Client error: {str(exc)}", error_code=ErrorCode.API_REQUEST_FAILED
                )
        except ImportError:
            pass

        # Handle SSL errors
        if "ssl" in str(exc).lower() or "certificate" in str(exc).lower():
            return APIError(f"SSL/TLS error: {str(exc)}", error_code=ErrorCode.API_SSL_ERROR)

        # Default to generic API error
        return APIError(f"Request failed: {str(exc)}", error_code=ErrorCode.API_REQUEST_FAILED)

    def _update_metrics(self, url: str, request_time: float, status_code: int, error: bool = False):
        """Update connection pool metrics"""
        with self._lock:
            self._request_count += 1
            self._total_time += request_time

            # Parse hostname for per-host metrics
            try:
                hostname = urlparse(url).hostname or "unknown"
            except (ValueError, AttributeError):
                hostname = "unknown"

            if hostname not in self._pool_stats:
                self._pool_stats[hostname] = {"requests": 0, "errors": 0, "total_time": 0.0}

            self._pool_stats[hostname]["requests"] += 1
            self._pool_stats[hostname]["total_time"] += request_time

            if error or status_code >= 400:
                self._pool_stats[hostname]["errors"] += 1

        # Record telemetry
        record_metric(
            "http.request.duration",
            request_time * 1000,
            "ms",
            {"hostname": hostname, "status_code": str(status_code), "error": str(error)},
        )

        debug_log(
            f"HTTP request completed",
            url=url,
            duration_ms=request_time * 1000,
            status_code=status_code,
            error=error,
        )

    def get_pool_stats(self) -> Dict[str, Any]:
        """Get connection pool statistics"""
        with self._lock:
            stats = {
                "total_requests": self._request_count,
                "total_errors": self._error_count,
                "average_response_time": (self._total_time / max(self._request_count, 1)),
                "error_rate": (self._error_count / max(self._request_count, 1)),
                "per_host_stats": self._pool_stats.copy(),
                "pool_config": {
                    "max_pool_size": self.config.max_pool_size,
                    "max_connections_per_host": self.config.max_connections_per_host,
                    "connection_timeout": self.config.connection_timeout,
                    "read_timeout": self.config.read_timeout,
                },
            }

        return stats

    async def close(self):
        """Close connection pools and cleanup resources"""
        if self._async_session:
            await self._async_session.close()
            self._async_session = None

        if self._sync_session:
            self._sync_session.close()
            self._sync_session = None

        self.logger.debug("HTTP connection pools closed")

    def __enter__(self):
        """Context manager entry"""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit"""
        if self._sync_session:
            self._sync_session.close()

    async def __aenter__(self):
        """Async context manager entry"""
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit"""
        await self.close()


class PooledHTTPClient:
    """High-level HTTP client with connection pooling"""

    def __init__(
        self,
        base_url: Optional[str] = None,
        default_headers: Optional[Dict[str, str]] = None,
        pool_config: Optional[ConnectionPoolConfig] = None,
    ):
        """
        Initialize pooled HTTP client.

        Args:
            base_url: Base URL for all requests
            default_headers: Default headers to include in all requests
            pool_config: Connection pool configuration
        """
        self.base_url = base_url
        self.default_headers = default_headers or {}
        self.pool_config = pool_config or ConnectionPoolConfig()

        self._pool = HTTPConnectionPool(self.pool_config)
        self.logger = logging.getLogger(__name__)

    def get(self, path: str, **kwargs) -> Dict[str, Any]:
        """Make GET request"""
        return self._request("GET", path, **kwargs)

    def post(self, path: str, data: Optional[Dict] = None, **kwargs) -> Dict[str, Any]:
        """Make POST request"""
        return self._request("POST", path, data=data, **kwargs)

    def put(self, path: str, data: Optional[Dict] = None, **kwargs) -> Dict[str, Any]:
        """Make PUT request"""
        return self._request("PUT", path, data=data, **kwargs)

    def delete(self, path: str, **kwargs) -> Dict[str, Any]:
        """Make DELETE request"""
        return self._request("DELETE", path, **kwargs)

    async def get_async(self, path: str, **kwargs) -> Dict[str, Any]:
        """Make async GET request"""
        return await self._request_async("GET", path, **kwargs)

    async def post_async(self, path: str, data: Optional[Dict] = None, **kwargs) -> Dict[str, Any]:
        """Make async POST request"""
        return await self._request_async("POST", path, data=data, **kwargs)

    async def put_async(self, path: str, data: Optional[Dict] = None, **kwargs) -> Dict[str, Any]:
        """Make async PUT request"""
        return await self._request_async("PUT", path, data=data, **kwargs)

    async def delete_async(self, path: str, **kwargs) -> Dict[str, Any]:
        """Make async DELETE request"""
        return await self._request_async("DELETE", path, **kwargs)

    def _request(self, method: str, path: str, **kwargs) -> Dict[str, Any]:
        """Make synchronous request with pooling"""
        url = self._build_url(path)
        headers = self._build_headers(kwargs.pop("headers", None))

        return self._pool.request(method, url, headers=headers, **kwargs)

    async def _request_async(self, method: str, path: str, **kwargs) -> Dict[str, Any]:
        """Make asynchronous request with pooling"""
        url = self._build_url(path)
        headers = self._build_headers(kwargs.pop("headers", None))

        return await self._pool.request_async(method, url, headers=headers, **kwargs)

    def _build_url(self, path: str) -> str:
        """Build full URL from path"""
        if path.startswith("http"):
            return path
        elif self.base_url:
            return f"{self.base_url.rstrip('/')}/{path.lstrip('/')}"
        else:
            return path

    def _build_headers(self, headers: Optional[Dict[str, str]]) -> Dict[str, str]:
        """Build headers with defaults"""
        result = self.default_headers.copy()
        if headers:
            result.update(headers)
        return result

    def get_stats(self) -> Dict[str, Any]:
        """Get client statistics"""
        return self._pool.get_pool_stats()

    async def close(self):
        """Close client and cleanup resources"""
        await self._pool.close()


# Global HTTP client instances
_global_http_client: Optional[PooledHTTPClient] = None
_client_lock = threading.Lock()


def get_http_client(
    base_url: Optional[str] = None, pool_config: Optional[ConnectionPoolConfig] = None
) -> PooledHTTPClient:
    """Get or create global HTTP client"""
    global _global_http_client

    with _client_lock:
        if _global_http_client is None:
            _global_http_client = PooledHTTPClient(base_url=base_url, pool_config=pool_config)

        return _global_http_client


@asynccontextmanager
async def pooled_http_client(
    base_url: Optional[str] = None, pool_config: Optional[ConnectionPoolConfig] = None
):
    """Async context manager for HTTP client"""
    client = PooledHTTPClient(base_url=base_url, pool_config=pool_config)
    try:
        yield client
    finally:
        await client.close()
