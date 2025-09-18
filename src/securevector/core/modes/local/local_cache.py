"""
Local caching implementation for threat detection results.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import threading
import time
from collections import OrderedDict
from typing import Any, Dict, Optional, Tuple

from securevector.models.analysis_result import AnalysisResult
from securevector.utils.logger import get_logger
from securevector.utils.security import (
    constant_time_cache_lookup,
    sanitize_output_for_logging,
    secure_cache_eviction,
    validate_cache_access_pattern,
)


class LocalCache:
    """
    Thread-safe LRU cache for analysis results with TTL support.

    Provides fast caching of analysis results to avoid re-analyzing
    the same prompts repeatedly.
    """

    def __init__(self, enabled: bool = True, ttl_seconds: int = 300, max_size: int = 1000):
        self.enabled = enabled
        self.ttl_seconds = ttl_seconds
        self.max_size = max_size
        self.logger = get_logger(__name__)

        # Thread-safe cache storage
        self._cache: OrderedDict[str, tuple] = OrderedDict()
        self._lock = threading.RLock()

        # Statistics
        self._stats = {"hits": 0, "misses": 0, "evictions": 0, "size": 0, "total_requests": 0}

        # Security monitoring
        self._access_times = []
        self._max_access_history = 100
        self._suspicious_access_count = 0

        self.logger.debug(f"Local cache initialized: max_size={max_size}, ttl={ttl_seconds}s")

    def get(self, key: str) -> Optional[AnalysisResult]:
        """
        Get cached analysis result with timing attack protection.

        Args:
            key: Cache key (usually prompt hash)

        Returns:
            AnalysisResult if found and not expired, None otherwise
        """
        if not self.enabled:
            return None

        start_time = time.time()

        with self._lock:
            self._stats["total_requests"] += 1

            # Record access time for security monitoring
            access_time_ms = (time.time() - start_time) * 1000
            self._access_times.append(access_time_ms)

            # Limit access history size
            if len(self._access_times) > self._max_access_history:
                self._access_times = self._access_times[-self._max_access_history :]

            # Check for suspicious access patterns
            if len(self._access_times) >= 10:
                if validate_cache_access_pattern(self._access_times):
                    self._suspicious_access_count += 1
                    self.logger.warning(
                        f"Suspicious local cache access pattern detected (count: {self._suspicious_access_count})"
                    )

            # Use constant-time lookup to prevent timing attacks
            found, cache_data = constant_time_cache_lookup(self._cache, key)

            if not found:
                self._stats["misses"] += 1
                return None

            result, timestamp = cache_data

            # Check if expired
            current_time = time.time()
            if current_time - timestamp > self.ttl_seconds:
                del self._cache[key]
                self._stats["misses"] += 1
                self._stats["evictions"] += 1
                self._update_size()
                return None

            # Move to end (LRU) - but only after validation
            self._cache.move_to_end(key)
            self._stats["hits"] += 1

            return result

    def set(self, key: str, result: AnalysisResult) -> None:
        """
        Cache an analysis result.

        Args:
            key: Cache key (usually prompt hash)
            result: Analysis result to cache
        """
        if not self.enabled:
            return

        with self._lock:
            # Use secure eviction to prevent information disclosure
            if len(self._cache) >= self.max_size:
                evicted_count = secure_cache_eviction(self._cache, self.max_size - 1)
                self._stats["evictions"] += evicted_count

            # Add new entry
            self._cache[key] = (result, time.time())
            self._update_size()

    def clear(self) -> None:
        """Clear all cached entries"""
        with self._lock:
            self._cache.clear()
            self._update_size()
            self.logger.debug("Cache cleared")

    def remove(self, key: str) -> bool:
        """
        Remove specific entry from cache.

        Args:
            key: Cache key to remove

        Returns:
            bool: True if key was found and removed
        """
        if not self.enabled:
            return False

        with self._lock:
            if key in self._cache:
                del self._cache[key]
                self._update_size()
                return True
            return False

    def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics with security metrics"""
        with self._lock:
            stats = self._stats.copy()

            # Calculate hit rate
            total_requests = stats["total_requests"]
            if total_requests > 0:
                stats["hit_rate"] = stats["hits"] / total_requests
                stats["miss_rate"] = stats["misses"] / total_requests
            else:
                stats["hit_rate"] = 0.0
                stats["miss_rate"] = 0.0

            # Add configuration info
            stats.update(
                {
                    "enabled": self.enabled,
                    "max_size": self.max_size,
                    "ttl_seconds": self.ttl_seconds,
                    "current_size": len(self._cache),
                }
            )

            # Add security metrics
            stats.update(
                {
                    "suspicious_access_count": self._suspicious_access_count,
                    "access_time_samples": len(self._access_times),
                    "security_monitoring_active": True,
                }
            )

            return stats

    def get_health_status(self) -> Dict[str, Any]:
        """Get cache health status"""
        stats = self.get_stats()

        # Determine health status
        status = "healthy"
        issues = []

        if stats["hit_rate"] < 0.5 and stats["total_requests"] > 100:
            status = "warning"
            issues.append("Low cache hit rate")

        if stats["current_size"] >= self.max_size * 0.9:
            status = "warning"
            issues.append("Cache near capacity")

        return {"status": status, "enabled": self.enabled, "issues": issues, "stats": stats}

    def update_config(
        self, ttl_seconds: Optional[int] = None, max_size: Optional[int] = None
    ) -> None:
        """
        Update cache configuration.

        Args:
            ttl_seconds: New TTL in seconds
            max_size: New maximum cache size
        """
        with self._lock:
            if ttl_seconds is not None:
                self.ttl_seconds = ttl_seconds
                self.logger.debug(f"Cache TTL updated to {ttl_seconds}s")

            if max_size is not None:
                old_max_size = self.max_size
                self.max_size = max_size

                # Trim cache if new size is smaller
                while len(self._cache) > max_size:
                    oldest_key = next(iter(self._cache))
                    del self._cache[oldest_key]
                    self._stats["evictions"] += 1

                self._update_size()
                self.logger.debug(f"Cache max size updated: {old_max_size} → {max_size}")

    def cleanup_expired(self) -> int:
        """
        Remove expired entries from cache.

        Returns:
            int: Number of entries removed
        """
        if not self.enabled:
            return 0

        with self._lock:
            current_time = time.time()
            expired_keys = []

            for key, (result, timestamp) in self._cache.items():
                if current_time - timestamp > self.ttl_seconds:
                    expired_keys.append(key)

            for key in expired_keys:
                del self._cache[key]
                self._stats["evictions"] += 1

            if expired_keys:
                self._update_size()
                self.logger.debug(f"Cleaned up {len(expired_keys)} expired cache entries")

            return len(expired_keys)

    def get_cache_keys(self) -> list:
        """Get list of current cache keys"""
        with self._lock:
            return list(self._cache.keys())

    def _update_size(self) -> None:
        """Update size statistic"""
        self._stats["size"] = len(self._cache)

    def close(self) -> None:
        """Clean up cache resources"""
        self.clear()
        self.logger.debug("Local cache closed")

    def __len__(self) -> int:
        """Get current cache size"""
        return len(self._cache)

    def __contains__(self, key: str) -> bool:
        """Check if key exists in cache (ignoring expiration)"""
        with self._lock:
            return key in self._cache
