"""
API response caching implementation.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import hashlib
import json
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


class APICache:
    """
    Thread-safe cache for API responses with TTL and size limits.

    Caches API analysis results to reduce redundant API calls and improve
    performance for repeated prompts.
    """

    def __init__(self, enabled: bool = True, ttl_seconds: int = 300, max_size: int = 5000):
        self.enabled = enabled
        self.ttl_seconds = ttl_seconds
        self.max_size = max_size
        self.logger = get_logger(__name__)

        # Thread-safe cache storage
        self._cache: OrderedDict[str, tuple] = OrderedDict()
        self._lock = threading.RLock()

        # Statistics
        self._stats = {
            "hits": 0,
            "misses": 0,
            "evictions": 0,
            "api_calls_saved": 0,
            "total_requests": 0,
            "cache_size": 0,
        }

        # Security monitoring
        self._access_times = []
        self._max_access_history = 100
        self._suspicious_access_count = 0

        self.logger.debug(f"API cache initialized: max_size={max_size}, ttl={ttl_seconds}s")

    def get(self, key: str) -> Optional[AnalysisResult]:
        """
        Get cached API response with timing attack protection.

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
                        f"Suspicious cache access pattern detected (count: {self._suspicious_access_count})"
                    )

            # Use constant-time lookup to prevent timing attacks
            found, cache_data = constant_time_cache_lookup(self._cache, key)

            if not found:
                self._stats["misses"] += 1
                return None

            result, timestamp, metadata = cache_data

            # Check if expired
            current_time = time.time()
            if current_time - timestamp > self.ttl_seconds:
                del self._cache[key]
                self._stats["misses"] += 1
                self._stats["evictions"] += 1
                self._update_cache_size()
                return None

            # Move to end (LRU) - but only after validation
            self._cache.move_to_end(key)
            self._stats["hits"] += 1
            self._stats["api_calls_saved"] += 1

            # Update cache metadata securely
            metadata["cache_hits"] = metadata.get("cache_hits", 0) + 1
            metadata["last_accessed"] = current_time

            return result

    def set(self, key: str, result: AnalysisResult, metadata: Optional[Dict] = None) -> None:
        """
        Cache an API response.

        Args:
            key: Cache key (usually prompt hash)
            result: Analysis result to cache
            metadata: Additional metadata about the cached item
        """
        if not self.enabled:
            return

        with self._lock:
            # Use secure eviction to prevent information disclosure
            if len(self._cache) >= self.max_size:
                evicted_count = secure_cache_eviction(self._cache, self.max_size - 1)
                self._stats["evictions"] += evicted_count

            # Prepare cache metadata
            cache_metadata = metadata or {}
            cache_metadata.update(
                {
                    "cached_at": time.time(),
                    "cache_hits": 0,
                    "last_accessed": time.time(),
                    "api_response_time_ms": getattr(result, "analysis_time_ms", 0.0),
                }
            )

            # Add new entry
            self._cache[key] = (result, time.time(), cache_metadata)
            self._update_cache_size()

    def clear(self) -> None:
        """Clear all cached entries"""
        with self._lock:
            self._cache.clear()
            self._update_cache_size()
            self.logger.debug("API cache cleared")

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
                self._update_cache_size()
                return True
            return False

    def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics with security metrics"""
        with self._lock:
            stats = self._stats.copy()

            # Calculate rates
            total_requests = stats["total_requests"]
            if total_requests > 0:
                stats["hit_rate"] = stats["hits"] / total_requests
                stats["miss_rate"] = stats["misses"] / total_requests
            else:
                stats["hit_rate"] = 0.0
                stats["miss_rate"] = 0.0

            # Calculate efficiency metrics
            if stats["hits"] > 0:
                stats["avg_cache_hits_per_entry"] = (
                    stats["hits"] / len(self._cache) if self._cache else 0
                )
            else:
                stats["avg_cache_hits_per_entry"] = 0.0

            # Add configuration info
            stats.update(
                {
                    "enabled": self.enabled,
                    "max_size": self.max_size,
                    "ttl_seconds": self.ttl_seconds,
                    "current_size": len(self._cache),
                    "memory_efficiency": self._calculate_memory_efficiency(),
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
        warnings = []

        # Check hit rate
        if stats["hit_rate"] < 0.3 and stats["total_requests"] > 100:
            status = "warning"
            warnings.append("Low cache hit rate")

        # Check capacity utilization
        utilization = stats["current_size"] / self.max_size
        if utilization > 0.9:
            status = "warning"
            warnings.append("Cache near capacity")
        elif utilization > 0.95:
            status = "critical"
            issues.append("Cache at critical capacity")

        # Check for excessive evictions
        if stats["evictions"] > stats["hits"] and stats["total_requests"] > 50:
            status = "warning"
            warnings.append("High eviction rate - consider increasing cache size")

        return {
            "status": status,
            "enabled": self.enabled,
            "issues": issues,
            "warnings": warnings,
            "stats": stats,
        }

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
                self.logger.debug(f"API cache TTL updated to {ttl_seconds}s")

            if max_size is not None:
                old_max_size = self.max_size
                self.max_size = max_size

                # Trim cache if new size is smaller
                while len(self._cache) > max_size:
                    oldest_key = next(iter(self._cache))
                    del self._cache[oldest_key]
                    self._stats["evictions"] += 1

                self._update_cache_size()
                self.logger.debug(f"API cache max size updated: {old_max_size} → {max_size}")

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

            for key, (result, timestamp, metadata) in self._cache.items():
                if current_time - timestamp > self.ttl_seconds:
                    expired_keys.append(key)

            for key in expired_keys:
                del self._cache[key]
                self._stats["evictions"] += 1

            if expired_keys:
                self._update_cache_size()
                self.logger.debug(f"Cleaned up {len(expired_keys)} expired API cache entries")

            return len(expired_keys)

    def get_cache_summary(self) -> Dict[str, Any]:
        """Get summary of cached items"""
        with self._lock:
            if not self._cache:
                return {"empty": True}

            # Analyze cached items
            threat_counts = {}
            risk_score_distribution = {"low": 0, "medium": 0, "high": 0, "critical": 0}
            total_api_time_saved = 0.0

            for result, timestamp, metadata in self._cache.values():
                # Count threat types
                for detection in result.detections:
                    threat_type = detection.threat_type
                    threat_counts[threat_type] = threat_counts.get(threat_type, 0) + 1

                # Risk score distribution
                risk_score = result.risk_score
                if risk_score < 30:
                    risk_score_distribution["low"] += 1
                elif risk_score < 60:
                    risk_score_distribution["medium"] += 1
                elif risk_score < 80:
                    risk_score_distribution["high"] += 1
                else:
                    risk_score_distribution["critical"] += 1

                # Calculate time saved
                cache_hits = metadata.get("cache_hits", 0)
                api_time = metadata.get("api_response_time_ms", 0.0)
                total_api_time_saved += cache_hits * api_time

            return {
                "total_entries": len(self._cache),
                "threat_type_counts": threat_counts,
                "risk_score_distribution": risk_score_distribution,
                "estimated_api_time_saved_ms": total_api_time_saved,
                "estimated_api_calls_saved": self._stats["api_calls_saved"],
            }

    def _calculate_memory_efficiency(self) -> float:
        """Calculate memory efficiency score (0.0-1.0)"""
        if not self._cache:
            return 1.0

        # Simple efficiency based on hit rate and utilization
        hit_rate = self._stats["hits"] / max(self._stats["total_requests"], 1)
        utilization = len(self._cache) / self.max_size

        # Efficiency is high when hit rate is high and utilization is reasonable
        return min(1.0, hit_rate * (1.0 + (0.7 - utilization) if utilization < 0.7 else 1.0))

    def _update_cache_size(self) -> None:
        """Update cache size statistic"""
        self._stats["cache_size"] = len(self._cache)

    def export_cache_data(self) -> Dict[str, Any]:
        """Export cache data for analysis or backup with sanitization"""
        with self._lock:
            exported_data = {
                "metadata": {
                    "export_time": time.time(),
                    "cache_config": {"ttl_seconds": self.ttl_seconds, "max_size": self.max_size},
                    "stats": self.get_stats(),
                },
                "entries": [],
            }

            for key, (result, timestamp, metadata) in self._cache.items():
                # Sanitize cache key to prevent information disclosure
                sanitized_key = sanitize_output_for_logging(key, max_length=32)

                entry = {
                    "key": sanitized_key,
                    "timestamp": timestamp,
                    "metadata": metadata,
                    "result_summary": {
                        "is_threat": result.is_threat,
                        "risk_score": result.risk_score,
                        "confidence": result.confidence,
                        "detection_count": len(result.detections),
                    },
                }
                exported_data["entries"].append(entry)

            return exported_data

    def close(self) -> None:
        """Clean up cache resources"""
        self.clear()
        self.logger.debug("API cache closed")

    def __len__(self) -> int:
        """Get current cache size"""
        return len(self._cache)

    def __contains__(self, key: str) -> bool:
        """Check if key exists in cache (ignoring expiration)"""
        with self._lock:
            return key in self._cache
