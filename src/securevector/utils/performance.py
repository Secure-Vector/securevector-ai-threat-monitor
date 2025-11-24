"""
Performance monitoring and tracking utilities.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import statistics
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class PerformanceMetric:
    """Individual performance metric"""

    name: str
    value: float
    unit: str
    timestamp: float
    metadata: Dict[str, Any] = field(default_factory=dict)


class PerformanceTracker:
    """Thread-safe performance tracking and monitoring"""

    def __init__(self, enabled: bool = True, max_history: int = 1000):
        self.enabled = enabled
        self.max_history = max_history
        self._lock = threading.Lock()

        # Metrics storage
        self._metrics: Dict[str, deque] = defaultdict(lambda: deque(maxlen=max_history))
        self._counters: Dict[str, int] = defaultdict(int)
        self._timers: Dict[str, float] = {}

        # Performance thresholds
        self.thresholds = {
            "analysis_time_ms": 100.0,  # Max analysis time
            "api_response_ms": 5000.0,  # Max API response time
            "cache_hit_rate": 0.8,  # Min cache hit rate
            "memory_usage_mb": 100.0,  # Max memory usage
        }

    def start_timer(self, name: str) -> str:
        """Start a named timer"""
        if not self.enabled:
            return name

        timer_key = f"{name}_{threading.current_thread().ident}_{time.time()}"
        self._timers[timer_key] = time.time()
        return timer_key

    def end_timer(self, timer_key: str, metadata: Optional[Dict[str, Any]] = None) -> float:
        """End a timer and record the duration"""
        if not self.enabled or timer_key not in self._timers:
            return 0.0

        duration = (time.time() - self._timers[timer_key]) * 1000  # Convert to ms
        del self._timers[timer_key]

        # Extract metric name from timer key
        metric_name = timer_key.split("_")[0]
        self.record_metric(f"{metric_name}_time_ms", duration, "ms", metadata or {})

        return duration

    def record_metric(
        self, name: str, value: float, unit: str = "", metadata: Optional[Dict[str, Any]] = None
    ) -> None:
        """Record a performance metric"""
        if not self.enabled:
            return

        with self._lock:
            metric = PerformanceMetric(
                name=name, value=value, unit=unit, timestamp=time.time(), metadata=metadata or {}
            )
            self._metrics[name].append(metric)

    def increment_counter(self, name: str, value: int = 1) -> None:
        """Increment a counter metric"""
        if not self.enabled:
            return

        with self._lock:
            self._counters[name] += value

    def get_counter(self, name: str) -> int:
        """Get current counter value"""
        with self._lock:
            return self._counters.get(name, 0)

    def get_metric_stats(self, name: str) -> Dict[str, Any]:
        """Get statistics for a metric"""
        if not self.enabled or name not in self._metrics:
            return {}

        with self._lock:
            metrics = list(self._metrics[name])

        if not metrics:
            return {}

        values = [m.value for m in metrics]

        return {
            "count": len(values),
            "min": min(values),
            "max": max(values),
            "mean": statistics.mean(values),
            "median": statistics.median(values),
            "std_dev": statistics.stdev(values) if len(values) > 1 else 0.0,
            "p95": statistics.quantiles(values, n=20)[18] if len(values) >= 20 else max(values),
            "p99": statistics.quantiles(values, n=100)[98] if len(values) >= 100 else max(values),
            "unit": metrics[0].unit if metrics else "",
            "latest": values[-1] if values else 0.0,
        }

    def get_metrics(self) -> Dict[str, Any]:
        """Get all performance metrics"""
        if not self.enabled:
            return {"enabled": False}

        metrics = {}

        # Get metric statistics
        with self._lock:
            metric_names = list(self._metrics.keys())

        for name in metric_names:
            metrics[name] = self.get_metric_stats(name)

        # Add counters
        with self._lock:
            counters = dict(self._counters)

        metrics["counters"] = counters

        # Add performance summary
        metrics["summary"] = self._get_performance_summary()

        return metrics

    def _get_performance_summary(self) -> Dict[str, Any]:
        """Get performance summary with health indicators"""
        summary = {"status": "healthy", "warnings": [], "errors": []}

        # Check analysis time performance
        analysis_stats = self.get_metric_stats("analysis_time_ms")
        if analysis_stats and analysis_stats.get("p95", 0) > self.thresholds["analysis_time_ms"]:
            summary["warnings"].append(
                f"Analysis time P95 ({analysis_stats['p95']:.1f}ms) exceeds threshold "
                f"({self.thresholds['analysis_time_ms']:.1f}ms)"
            )

        # Check API response time
        api_stats = self.get_metric_stats("api_response_time_ms")
        if api_stats and api_stats.get("p95", 0) > self.thresholds["api_response_ms"]:
            summary["warnings"].append(
                f"API response time P95 ({api_stats['p95']:.1f}ms) exceeds threshold "
                f"({self.thresholds['api_response_ms']:.1f}ms)"
            )

        # Check cache hit rate
        cache_hits = self.get_counter("cache_hits")
        cache_misses = self.get_counter("cache_misses")
        total_cache_requests = cache_hits + cache_misses

        if total_cache_requests > 0:
            hit_rate = cache_hits / total_cache_requests
            if hit_rate < self.thresholds["cache_hit_rate"]:
                summary["warnings"].append(
                    f"Cache hit rate ({hit_rate:.2f}) below threshold "
                    f"({self.thresholds['cache_hit_rate']:.2f})"
                )

        # Set overall status
        if summary["errors"]:
            summary["status"] = "error"
        elif summary["warnings"]:
            summary["status"] = "warning"

        return summary

    def clear_metrics(self) -> None:
        """Clear all metrics and counters"""
        if not self.enabled:
            return

        with self._lock:
            self._metrics.clear()
            self._counters.clear()
            self._timers.clear()

    def set_threshold(self, metric_name: str, threshold_value: float) -> None:
        """Set performance threshold for a metric"""
        self.thresholds[metric_name] = threshold_value

    def get_recent_metrics(self, name: str, count: int = 10) -> List[PerformanceMetric]:
        """Get recent metrics for a given name"""
        if not self.enabled or name not in self._metrics:
            return []

        with self._lock:
            recent = list(self._metrics[name])[-count:]

        return recent

    def export_metrics(self, format: str = "dict") -> Any:
        """Export metrics in specified format"""
        metrics = self.get_metrics()

        if format == "dict":
            return metrics
        elif format == "json":
            import json

            return json.dumps(metrics, indent=2)
        elif format == "csv":
            # Simple CSV export for basic metrics
            lines = ["metric_name,value,unit,timestamp"]

            with self._lock:
                for name, metric_deque in self._metrics.items():
                    for metric in metric_deque:
                        lines.append(
                            f"{metric.name},{metric.value},{metric.unit},{metric.timestamp}"
                        )

            return "\n".join(lines)
        else:
            raise ValueError(f"Unsupported export format: {format}")


class ContextTimer:
    """Context manager for timing operations"""

    def __init__(
        self, tracker: PerformanceTracker, name: str, metadata: Optional[Dict[str, Any]] = None
    ):
        self.tracker = tracker
        self.name = name
        self.metadata = metadata or {}
        self.timer_key = None

    def __enter__(self):
        self.timer_key = self.tracker.start_timer(self.name)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.timer_key:
            _  = self.tracker.end_timer(self.timer_key, self.metadata)

            # Add exception info to metadata if an error occurred
            if exc_type:
                self.metadata["exception"] = str(exc_val)
                self.metadata["exception_type"] = exc_type.__name__

            return False  # Don't suppress exceptions


def timed_operation(
    tracker: PerformanceTracker, name: str, metadata: Optional[Dict[str, Any]] = None
):
    """Decorator for timing function calls"""

    def decorator(func):
        def wrapper(*args, **kwargs):
            with ContextTimer(tracker, name, metadata):
                return func(*args, **kwargs)

        return wrapper

    return decorator
