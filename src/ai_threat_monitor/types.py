"""
Type definitions for the SecureVector AI Threat Monitor SDK.

This module provides comprehensive type hints and protocols for better
IDE support and type safety throughout the SDK.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

from abc import abstractmethod
from datetime import datetime
from typing import (
    TYPE_CHECKING,
    Any,
    AsyncContextManager,
    Awaitable,
    Callable,
    ContextManager,
    Dict,
    Generic,
    List,
    Optional,
    Protocol,
    TypeVar,
    Union,
)

# Handle typing_extensions imports with fallbacks
try:
    from typing_extensions import Literal, NotRequired, ParamSpec, TypedDict
except ImportError:
    try:
        # Python 3.8+ has some of these in typing
        from typing import Literal, TypedDict

        # Create dummy types for missing ones
        ParamSpec = TypeVar
        NotRequired = Any
    except ImportError:
        # Fallback for older Python versions
        Literal = Any
        TypedDict = dict
        ParamSpec = TypeVar
        NotRequired = Any

# Forward references to avoid circular imports
if TYPE_CHECKING:
    from .async_client import AsyncSecureVectorClient
    from .client import SecureVectorClient
    from .models.analysis_result import AnalysisResult

# Type variables
T = TypeVar("T")
P = ParamSpec("P")
ClientT = TypeVar("ClientT", bound="BaseSecureVectorClient")

# Literal types for better autocomplete
OperationModeType = Literal["local", "api", "hybrid", "auto"]
LogLevelType = Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
DetectionMethodType = Literal["local_rules", "api_enhanced", "hybrid_analysis"]
PolicyActionType = Literal["allow", "block", "warn", "log"]


# Configuration TypedDicts for better IDE support
class APIConfigDict(TypedDict):
    """API configuration dictionary with type hints"""

    api_key: NotRequired[str]
    api_url: NotRequired[str]
    endpoint: NotRequired[str]
    timeout_ms: NotRequired[int]
    rate_limit_requests: NotRequired[int]
    rate_limit_window: NotRequired[int]
    max_request_size: NotRequired[int]
    enable_retries: NotRequired[bool]
    max_retries: NotRequired[int]


class LocalConfigDict(TypedDict):
    """Local configuration dictionary with type hints"""

    rules_directory: NotRequired[str]
    enable_custom_rules: NotRequired[bool]
    rule_cache_size: NotRequired[int]
    enable_rule_validation: NotRequired[bool]


class SDKConfigDict(TypedDict):
    """SDK configuration dictionary with type hints"""

    mode: NotRequired[OperationModeType]
    api_config: NotRequired[APIConfigDict]
    local_config: NotRequired[LocalConfigDict]
    performance_monitoring: NotRequired[bool]
    log_level: NotRequired[LogLevelType]
    log_all_requests: NotRequired[bool]
    enable_caching: NotRequired[bool]
    cache_ttl_seconds: NotRequired[int]
    cache_max_size: NotRequired[int]
    raise_on_threat: NotRequired[bool]
    max_prompt_length: NotRequired[int]
    max_batch_size: NotRequired[int]
    request_timeout: NotRequired[int]


class ThreatDetectionDict(TypedDict):
    """Threat detection result dictionary"""

    threat_type: str
    risk_score: int
    confidence: float
    description: str
    rule_id: NotRequired[str]
    metadata: NotRequired[Dict[str, Any]]


class AnalysisResultDict(TypedDict):
    """Analysis result dictionary with type hints"""

    is_threat: bool
    risk_score: int
    confidence: float
    detections: List[ThreatDetectionDict]
    analysis_time_ms: float
    detection_method: DetectionMethodType
    timestamp: str  # ISO format
    summary: str
    prompt_hash: NotRequired[str]
    threat_types: NotRequired[List[str]]


class StatisticsDict(TypedDict):
    """Statistics dictionary with type hints"""

    total_requests: int
    threats_detected: int
    threats_blocked: int
    avg_response_time_ms: float
    cache_hits: int
    api_calls: int
    local_analyses: int
    mode: str
    policy_name: str
    threat_rate: float
    performance_metrics: Dict[str, Any]


class HealthStatusDict(TypedDict):
    """Health status dictionary with type hints"""

    status: Literal["healthy", "degraded", "unhealthy"]
    mode: str
    mode_handler_status: Dict[str, Any]
    policy_enabled: bool
    cache_enabled: bool
    stats: StatisticsDict


# Protocol definitions for better interface support
class AnalyzablePrompt(Protocol):
    """Protocol for objects that can be analyzed as prompts"""

    def __str__(self) -> str:
        """Convert to string for analysis"""
        ...


class ThreatAnalyzer(Protocol):
    """Protocol for threat analysis implementations"""

    @abstractmethod
    def analyze(self, prompt: str, **kwargs: Any) -> "AnalysisResult":
        """Analyze a prompt for threats"""
        ...

    @abstractmethod
    def analyze_batch(self, prompts: List[str], **kwargs: Any) -> List["AnalysisResult"]:
        """Analyze multiple prompts"""
        ...


class AsyncThreatAnalyzer(Protocol):
    """Protocol for async threat analysis implementations"""

    @abstractmethod
    async def analyze(self, prompt: str, **kwargs: Any) -> "AnalysisResult":
        """Analyze a prompt for threats asynchronously"""
        ...

    @abstractmethod
    async def analyze_batch(self, prompts: List[str], **kwargs: Any) -> List["AnalysisResult"]:
        """Analyze multiple prompts asynchronously"""
        ...


class BaseSecureVectorClient(Protocol):
    """Base protocol for SecureVector clients"""

    @abstractmethod
    def analyze(self, prompt: str, **kwargs: Any) -> "AnalysisResult":
        """Analyze a prompt for threats"""
        ...

    @abstractmethod
    def analyze_batch(self, prompts: List[str], **kwargs: Any) -> List["AnalysisResult"]:
        """Analyze multiple prompts"""
        ...

    @abstractmethod
    def is_threat(self, prompt: str, **kwargs: Any) -> bool:
        """Check if prompt is a threat"""
        ...

    @abstractmethod
    def get_risk_score(self, prompt: str, **kwargs: Any) -> int:
        """Get risk score for prompt"""
        ...

    @abstractmethod
    def get_stats(self) -> StatisticsDict:
        """Get usage statistics"""
        ...

    @abstractmethod
    def get_health_status(self) -> HealthStatusDict:
        """Get health status"""
        ...


class AsyncBaseSecureVectorClient(Protocol):
    """Base protocol for async SecureVector clients"""

    @abstractmethod
    async def analyze(self, prompt: str, **kwargs: Any) -> "AnalysisResult":
        """Analyze a prompt for threats asynchronously"""
        ...

    @abstractmethod
    async def analyze_batch(self, prompts: List[str], **kwargs: Any) -> List["AnalysisResult"]:
        """Analyze multiple prompts asynchronously"""
        ...

    @abstractmethod
    async def is_threat(self, prompt: str, **kwargs: Any) -> bool:
        """Check if prompt is a threat asynchronously"""
        ...

    @abstractmethod
    async def get_risk_score(self, prompt: str, **kwargs: Any) -> int:
        """Get risk score for prompt asynchronously"""
        ...

    @abstractmethod
    async def get_stats(self) -> StatisticsDict:
        """Get usage statistics asynchronously"""
        ...

    @abstractmethod
    async def get_health_status(self) -> HealthStatusDict:
        """Get health status asynchronously"""
        ...


# Generic types for better type inference
AnalysisFunction = Callable[[str], "AnalysisResult"]
AsyncAnalysisFunction = Callable[[str], Awaitable["AnalysisResult"]]
BatchAnalysisFunction = Callable[[List[str]], List["AnalysisResult"]]
AsyncBatchAnalysisFunction = Callable[[List[str]], Awaitable[List["AnalysisResult"]]]

# Context manager types
SyncClientContextManager = ContextManager["SecureVectorClient"]
AsyncClientContextManager = AsyncContextManager["AsyncSecureVectorClient"]

# Callback types for extensibility
ThreatDetectionCallback = Callable[["AnalysisResult"], None]
AsyncThreatDetectionCallback = Callable[["AnalysisResult"], Awaitable[None]]
ErrorHandlingCallback = Callable[[Exception], None]
AsyncErrorHandlingCallback = Callable[[Exception], Awaitable[None]]

# Validation types
PromptValidator = Callable[[str], bool]
BatchValidator = Callable[[List[str]], bool]
ConfigValidator = Callable[[SDKConfigDict], bool]

# Mock behavior types for testing
MockResponseGenerator = Callable[[str], "AnalysisResult"]
AsyncMockResponseGenerator = Callable[[str], Awaitable["AnalysisResult"]]


# Retry configuration types
class RetryConfigDict(TypedDict):
    """Retry configuration dictionary"""

    max_attempts: NotRequired[int]
    base_delay: NotRequired[float]
    max_delay: NotRequired[float]
    exponential_base: NotRequired[float]
    jitter: NotRequired[bool]


# Performance monitoring types
class PerformanceMetricsDict(TypedDict):
    """Performance metrics dictionary"""

    request_count: int
    average_response_time: float
    min_response_time: float
    max_response_time: float
    p95_response_time: float
    error_rate: float
    cache_hit_rate: float
    throughput_rps: float


# Testing types
class MockBehaviorDict(TypedDict):
    """Mock behavior configuration dictionary"""

    default_is_threat: NotRequired[bool]
    default_risk_score: NotRequired[int]
    default_confidence: NotRequired[float]
    response_time_ms: NotRequired[float]
    failure_rate: NotRequired[float]
    custom_responses: NotRequired[Dict[str, AnalysisResultDict]]


# Error context types
class ErrorContextDict(TypedDict):
    """Error context dictionary for structured error handling"""

    error_code: str
    timestamp: str
    request_id: NotRequired[str]
    user_id: NotRequired[str]
    session_id: NotRequired[str]
    additional_context: NotRequired[Dict[str, Any]]


# Export commonly used types for convenience
__all__ = [
    # Core types
    "OperationModeType",
    "LogLevelType",
    "DetectionMethodType",
    "PolicyActionType",
    # Configuration types
    "APIConfigDict",
    "LocalConfigDict",
    "SDKConfigDict",
    # Result types
    "ThreatDetectionDict",
    "AnalysisResultDict",
    "StatisticsDict",
    "HealthStatusDict",
    # Protocol types
    "AnalyzablePrompt",
    "ThreatAnalyzer",
    "AsyncThreatAnalyzer",
    "BaseSecureVectorClient",
    "AsyncBaseSecureVectorClient",
    # Function types
    "AnalysisFunction",
    "AsyncAnalysisFunction",
    "BatchAnalysisFunction",
    "AsyncBatchAnalysisFunction",
    # Context manager types
    "SyncClientContextManager",
    "AsyncClientContextManager",
    # Callback types
    "ThreatDetectionCallback",
    "AsyncThreatDetectionCallback",
    "ErrorHandlingCallback",
    "AsyncErrorHandlingCallback",
    # Validation types
    "PromptValidator",
    "BatchValidator",
    "ConfigValidator",
    # Testing types
    "MockResponseGenerator",
    "AsyncMockResponseGenerator",
    "MockBehaviorDict",
    # Performance types
    "PerformanceMetricsDict",
    "RetryConfigDict",
    # Error types
    "ErrorContextDict",
    # Type variables
    "T",
    "P",
    "ClientT",
]
