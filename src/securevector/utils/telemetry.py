"""
Advanced telemetry and debugging tools for the SecureVector AI Threat Monitor SDK.

This module provides comprehensive telemetry, debugging, and observability
features for monitoring SDK performance and behavior.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import json
import logging
import os
import sys
import threading
import time
import uuid
from collections import defaultdict, deque
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, List, Optional, TextIO, Union

from .exceptions import ErrorCode


@dataclass
class TelemetryEvent:
    """Represents a telemetry event"""

    event_id: str
    timestamp: datetime
    event_type: str
    source: str
    data: Dict[str, Any]
    session_id: str
    user_id: Optional[str] = None
    tags: Optional[Dict[str, str]] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization"""
        result = asdict(self)
        result["timestamp"] = self.timestamp.isoformat()
        return result

    def to_json(self) -> str:
        """Convert to JSON string"""
        return json.dumps(self.to_dict())


@dataclass
class PerformanceMetric:
    """Represents a performance metric"""

    name: str
    value: float
    unit: str
    timestamp: datetime
    tags: Optional[Dict[str, str]] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary"""
        result = asdict(self)
        result["timestamp"] = self.timestamp.isoformat()
        return result


class TelemetryCollector:
    """Advanced telemetry collector with debugging capabilities"""

    def __init__(
        self,
        enabled: bool = True,
        session_id: Optional[str] = None,
        max_events: int = 10000,
        auto_flush_interval: int = 300,
        debug_mode: bool = False,
    ):
        """
        Initialize telemetry collector.

        Args:
            enabled: Whether telemetry is enabled
            session_id: Session identifier
            max_events: Maximum events to keep in memory
            auto_flush_interval: Auto-flush interval in seconds
            debug_mode: Enable debug logging
        """
        self.enabled = enabled
        self.session_id = session_id or str(uuid.uuid4())
        self.max_events = max_events
        self.auto_flush_interval = auto_flush_interval
        self.debug_mode = debug_mode

        # Thread-safe event storage
        self._lock = threading.Lock()
        self._events = deque(maxlen=max_events)
        self._metrics = deque(maxlen=max_events)

        # Performance tracking
        self._performance_counters = defaultdict(list)
        self._error_counts = defaultdict(int)
        self._request_latencies = deque(maxlen=1000)

        # Debug information
        self._debug_logs = deque(maxlen=1000)
        self._call_stack = []

        # Auto-flush setup
        self._last_flush = time.time()
        self._flush_callbacks: List[Callable[[List[TelemetryEvent]], None]] = []

        # Logger
        self.logger = logging.getLogger(__name__)
        if debug_mode:
            self.logger.setLevel(logging.DEBUG)

    def record_event(
        self,
        event_type: str,
        source: str,
        data: Dict[str, Any],
        user_id: Optional[str] = None,
        tags: Optional[Dict[str, str]] = None,
    ) -> str:
        """Record a telemetry event"""
        if not self.enabled:
            return ""

        event_id = str(uuid.uuid4())
        event = TelemetryEvent(
            event_id=event_id,
            timestamp=datetime.utcnow(),
            event_type=event_type,
            source=source,
            data=data,
            session_id=self.session_id,
            user_id=user_id,
            tags=tags or {},
        )

        with self._lock:
            self._events.append(event)

        if self.debug_mode:
            self.logger.debug(f"Recorded event: {event_type} from {source}")

        self._check_auto_flush()
        return event_id

    def record_metric(
        self, name: str, value: float, unit: str = "", tags: Optional[Dict[str, str]] = None
    ) -> None:
        """Record a performance metric"""
        if not self.enabled:
            return

        metric = PerformanceMetric(
            name=name, value=value, unit=unit, timestamp=datetime.utcnow(), tags=tags or {}
        )

        with self._lock:
            self._metrics.append(metric)
            self._performance_counters[name].append(value)

        if self.debug_mode:
            self.logger.debug(f"Recorded metric: {name} = {value} {unit}")

    def record_error(self, error: Exception, context: Optional[Dict[str, Any]] = None) -> str:
        """Record an error event with context"""
        error_data = {
            "error_type": type(error).__name__,
            "error_message": str(error),
            "error_code": getattr(error, "code", None),
            "context": context or {},
        }

        # Add stack trace in debug mode
        if self.debug_mode:
            import traceback

            error_data["stack_trace"] = traceback.format_exc()

        with self._lock:
            self._error_counts[type(error).__name__] += 1

        return self.record_event(event_type="error", source="sdk.error_handler", data=error_data)

    def record_request_latency(self, latency_ms: float, operation: str) -> None:
        """Record request latency"""
        if not self.enabled:
            return

        with self._lock:
            self._request_latencies.append(latency_ms)

        self.record_metric(
            name=f"{operation}.latency", value=latency_ms, unit="ms", tags={"operation": operation}
        )

    @contextmanager
    def trace_operation(self, operation_name: str, **context):
        """Context manager for tracing operations"""
        if not self.enabled:
            yield
            return

        start_time = time.time()
        operation_id = str(uuid.uuid4())

        # Record start event
        self.record_event(
            event_type="operation_start",
            source=f"sdk.{operation_name}",
            data={
                "operation_id": operation_id,
                "operation_name": operation_name,
                "context": context,
            },
        )

        try:
            yield operation_id
        except Exception as e:
            # Record error
            self.record_error(e, context={"operation": operation_name, **context})
            raise
        finally:
            # Record completion
            duration_ms = (time.time() - start_time) * 1000
            self.record_event(
                event_type="operation_complete",
                source=f"sdk.{operation_name}",
                data={
                    "operation_id": operation_id,
                    "operation_name": operation_name,
                    "duration_ms": duration_ms,
                    "context": context,
                },
            )
            self.record_request_latency(duration_ms, operation_name)

    def debug_log(self, message: str, level: str = "info", **context) -> None:
        """Add debug log entry"""
        if not self.enabled or not self.debug_mode:
            return

        debug_entry = {
            "timestamp": datetime.utcnow().isoformat(),
            "level": level,
            "message": message,
            "context": context,
            "thread_id": threading.current_thread().ident,
        }

        with self._lock:
            self._debug_logs.append(debug_entry)

        # Also log to standard logger
        log_level = getattr(logging, level.upper(), logging.INFO)
        self.logger.log(log_level, f"{message} | Context: {context}")

    def get_performance_summary(self) -> Dict[str, Any]:
        """Get performance summary statistics"""
        with self._lock:
            latencies = list(self._request_latencies)
            counters = dict(self._performance_counters)
            errors = dict(self._error_counts)

        summary = {
            "session_id": self.session_id,
            "total_events": len(self._events),
            "total_metrics": len(self._metrics),
            "total_errors": sum(errors.values()),
            "error_breakdown": errors,
        }

        if latencies:
            summary["latency_stats"] = {
                "count": len(latencies),
                "avg_ms": sum(latencies) / len(latencies),
                "min_ms": min(latencies),
                "max_ms": max(latencies),
                "p95_ms": (
                    sorted(latencies)[int(len(latencies) * 0.95)] if len(latencies) > 0 else 0
                ),
                "p99_ms": (
                    sorted(latencies)[int(len(latencies) * 0.99)] if len(latencies) > 0 else 0
                ),
            }

        # Add counter summaries
        for name, values in counters.items():
            if values:
                summary[f"{name}_stats"] = {
                    "count": len(values),
                    "avg": sum(values) / len(values),
                    "min": min(values),
                    "max": max(values),
                }

        return summary

    def get_debug_info(self) -> Dict[str, Any]:
        """Get debug information"""
        with self._lock:
            debug_logs = list(self._debug_logs)
            recent_events = list(self._events)[-10:]  # Last 10 events

        return {
            "session_id": self.session_id,
            "debug_mode": self.debug_mode,
            "recent_events": [event.to_dict() for event in recent_events],
            "debug_logs": debug_logs,
            "performance_summary": self.get_performance_summary(),
        }

    def export_events(self, format: str = "json") -> str:
        """Export events in specified format"""
        with self._lock:
            events = list(self._events)

        if format == "json":
            return json.dumps([event.to_dict() for event in events], indent=2)
        elif format == "csv":
            import csv
            import io

            output = io.StringIO()
            if events:
                writer = csv.DictWriter(output, fieldnames=events[0].to_dict().keys())
                writer.writeheader()
                for event in events:
                    writer.writerow(event.to_dict())
            return output.getvalue()
        else:
            raise ValueError(f"Unsupported format: {format}")

    def add_flush_callback(self, callback: Callable[[List[TelemetryEvent]], None]) -> None:
        """Add callback for when events are flushed"""
        self._flush_callbacks.append(callback)

    def flush_events(self, force: bool = False) -> int:
        """Flush events to registered callbacks"""
        if not self.enabled:
            return 0

        current_time = time.time()
        if not force and current_time - self._last_flush < self.auto_flush_interval:
            return 0

        with self._lock:
            events_to_flush = list(self._events)
            if not events_to_flush:
                return 0

        # Call flush callbacks
        for callback in self._flush_callbacks:
            try:
                callback(events_to_flush)
            except Exception as e:
                self.logger.error(f"Flush callback failed: {e}")

        self._last_flush = current_time
        return len(events_to_flush)

    def _check_auto_flush(self) -> None:
        """Check if auto-flush should be triggered"""
        if time.time() - self._last_flush > self.auto_flush_interval:
            self.flush_events()

    def clear_events(self) -> None:
        """Clear all stored events and metrics"""
        with self._lock:
            self._events.clear()
            self._metrics.clear()
            self._debug_logs.clear()
            self._performance_counters.clear()
            self._error_counts.clear()
            self._request_latencies.clear()


class DebugProfiler:
    """Advanced profiling and debugging utility"""

    def __init__(self, telemetry_collector: Optional[TelemetryCollector] = None):
        """Initialize debug profiler"""
        self.telemetry = telemetry_collector or TelemetryCollector()
        self._active_profiles = {}
        self._profile_results = {}

    @contextmanager
    def profile_block(self, name: str, **context):
        """Profile a code block"""
        profile_id = str(uuid.uuid4())
        start_time = time.perf_counter()
        start_memory = self._get_memory_usage()

        self.telemetry.debug_log(f"Starting profile: {name}", context=context)

        try:
            yield profile_id
        finally:
            end_time = time.perf_counter()
            end_memory = self._get_memory_usage()

            duration_ms = (end_time - start_time) * 1000
            memory_delta = end_memory - start_memory

            profile_result = {
                "name": name,
                "duration_ms": duration_ms,
                "memory_delta_mb": memory_delta,
                "context": context,
                "timestamp": datetime.utcnow().isoformat(),
            }

            self._profile_results[profile_id] = profile_result

            self.telemetry.record_metric(f"profile.{name}.duration", duration_ms, "ms")
            self.telemetry.record_metric(f"profile.{name}.memory", memory_delta, "mb")

            self.telemetry.debug_log(
                f"Profile complete: {name} - {duration_ms:.2f}ms, {memory_delta:.2f}MB",
                context=profile_result,
            )

    def _get_memory_usage(self) -> float:
        """Get current memory usage in MB"""
        try:
            import psutil

            process = psutil.Process(os.getpid())
            return process.memory_info().rss / 1024 / 1024
        except ImportError:
            return 0.0

    def get_profile_results(self) -> Dict[str, Any]:
        """Get all profile results"""
        return dict(self._profile_results)

    def clear_profiles(self) -> None:
        """Clear profile results"""
        self._profile_results.clear()


# Global telemetry instance
_global_telemetry: Optional[TelemetryCollector] = None
_telemetry_lock = threading.Lock()


def get_telemetry_collector(create_if_missing: bool = True) -> Optional[TelemetryCollector]:
    """Get the global telemetry collector"""
    global _global_telemetry

    with _telemetry_lock:
        if _global_telemetry is None and create_if_missing:
            # Check environment variables for configuration
            enabled = os.getenv("SECUREVECTOR_TELEMETRY_ENABLED", "true").lower() == "true"
            debug_mode = os.getenv("SECUREVECTOR_DEBUG_MODE", "false").lower() == "true"

            _global_telemetry = TelemetryCollector(enabled=enabled, debug_mode=debug_mode)

        return _global_telemetry


def set_telemetry_collector(collector: Optional[TelemetryCollector]) -> None:
    """Set the global telemetry collector"""
    global _global_telemetry

    with _telemetry_lock:
        _global_telemetry = collector


# Convenience functions
def record_event(event_type: str, source: str, data: Dict[str, Any], **kwargs) -> str:
    """Record a telemetry event using global collector"""
    collector = get_telemetry_collector()
    if collector:
        return collector.record_event(event_type, source, data, **kwargs)
    return ""


def record_metric(name: str, value: float, unit: str = "", **kwargs) -> None:
    """Record a metric using global collector"""
    collector = get_telemetry_collector()
    if collector:
        collector.record_metric(name, value, unit, **kwargs)


def debug_log(message: str, level: str = "info", **context) -> None:
    """Add debug log using global collector"""
    collector = get_telemetry_collector()
    if collector:
        collector.debug_log(message, level, **context)


@contextmanager
def trace_operation(operation_name: str, **context):
    """Trace an operation using global collector"""
    collector = get_telemetry_collector()
    if collector:
        with collector.trace_operation(operation_name, **context) as op_id:
            yield op_id
    else:
        yield None
