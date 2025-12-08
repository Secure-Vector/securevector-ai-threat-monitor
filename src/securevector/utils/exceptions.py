"""
Exception classes for the AI Threat Monitor SDK.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

from enum import Enum
from typing import Any, Dict, List, Optional, Union

from securevector.models.analysis_result import AnalysisResult
from securevector.models.policy_models import PolicyAction


class ErrorCode(Enum):
    """Structured error codes for programmatic error handling"""

    # Security Errors (1000-1999)
    SECURITY_THREAT_DETECTED = "SV-1001"
    SECURITY_POLICY_VIOLATION = "SV-1002"
    SECURITY_RULE_FAILED = "SV-1003"

    # Configuration Errors (2000-2999)
    CONFIG_INVALID = "SV-2001"
    CONFIG_MISSING_API_KEY = "SV-2002"
    CONFIG_INVALID_MODE = "SV-2003"
    CONFIG_INVALID_POLICY = "SV-2004"
    CONFIG_MISSING_RULES = "SV-2005"

    # API Errors (3000-3999)
    API_CONNECTION_FAILED = "SV-3001"
    API_AUTHENTICATION_FAILED = "SV-3002"
    API_RATE_LIMIT_EXCEEDED = "SV-3003"
    API_REQUEST_TIMEOUT = "SV-3004"
    API_INVALID_RESPONSE = "SV-3005"
    API_SERVICE_UNAVAILABLE = "SV-3006"
    API_PAYLOAD_TOO_LARGE = "SV-3007"

    # Validation Errors (4000-4999)
    VALIDATION_EMPTY_PROMPT = "SV-4001"
    VALIDATION_PROMPT_TOO_LONG = "SV-4002"
    VALIDATION_INVALID_INPUT_TYPE = "SV-4003"
    VALIDATION_BATCH_TOO_LARGE = "SV-4004"

    # Performance Errors (5000-5999)
    PERFORMANCE_TIMEOUT = "SV-5001"
    PERFORMANCE_MEMORY_EXCEEDED = "SV-5002"
    PERFORMANCE_THRESHOLD_EXCEEDED = "SV-5003"

    # Cache Errors (6000-6999)
    CACHE_WRITE_FAILED = "SV-6001"
    CACHE_READ_FAILED = "SV-6002"
    CACHE_CORRUPTION = "SV-6003"

    # Rule Engine Errors (7000-7999)
    RULES_LOAD_FAILED = "SV-7001"
    RULES_PARSE_ERROR = "SV-7002"
    RULES_MISSING = "SV-7003"
    RULES_VALIDATION_FAILED = "SV-7004"

    # Circuit Breaker Errors (8000-8999)
    CIRCUIT_BREAKER_OPEN = "SV-8001"
    CIRCUIT_BREAKER_HALF_OPEN = "SV-8002"

    # Mode Errors (9000-9999)
    MODE_NOT_AVAILABLE = "SV-9001"
    MODE_INITIALIZATION_FAILED = "SV-9002"
    MODE_SWITCH_FAILED = "SV-9003"

    # General Errors (10000+)
    UNKNOWN_ERROR = "SV-10001"
    INTERNAL_ERROR = "SV-10002"


class ErrorSolution:
    """Provides actionable solutions for errors"""

    def __init__(
        self,
        code: ErrorCode,
        title: str,
        description: str,
        solutions: List[str],
        docs_url: Optional[str] = None,
    ):
        self.code = code
        self.title = title
        self.description = description
        self.solutions = solutions
        self.docs_url = docs_url

    def __str__(self) -> str:
        solution_text = "\n".join([f"  • {sol}" for sol in self.solutions])
        docs_text = f"\n📖 Documentation: {self.docs_url}" if self.docs_url else ""
        return f"""
🔧 {self.title}
{self.description}

💡 Possible solutions:
{solution_text}{docs_text}
"""


# Error solution database
ERROR_SOLUTIONS = {
    ErrorCode.CONFIG_MISSING_API_KEY: ErrorSolution(
        ErrorCode.CONFIG_MISSING_API_KEY,
        "API Key Required",
        "API mode requires a valid SecureVector API key.",
        [
            "Set SECUREVECTOR_API_KEY environment variable",
            "Pass api_key parameter to SecureVectorClient()",
            "Switch to local mode: SecureVectorClient(mode='local')",
            "Use hybrid mode for automatic fallback",
        ],
        "https://docs.securevector.io/api-keys",
    ),
    ErrorCode.API_CONNECTION_FAILED: ErrorSolution(
        ErrorCode.API_CONNECTION_FAILED,
        "API Connection Failed",
        "Unable to connect to SecureVector API service.",
        [
            "Check your internet connection",
            "Verify API endpoint URL in configuration",
            "Switch to local mode for offline operation",
            "Enable hybrid mode for automatic fallback",
            "Check if firewall is blocking the connection",
        ],
        "https://docs.securevector.io/troubleshooting#connection-issues",
    ),
    ErrorCode.VALIDATION_EMPTY_PROMPT: ErrorSolution(
        ErrorCode.VALIDATION_EMPTY_PROMPT,
        "Empty Prompt",
        "Prompt cannot be empty or contain only whitespace.",
        [
            "Provide a non-empty string prompt",
            "Check if prompt variable is properly initialized",
            "Validate input before calling analyze()",
        ],
    ),
    ErrorCode.API_RATE_LIMIT_EXCEEDED: ErrorSolution(
        ErrorCode.API_RATE_LIMIT_EXCEEDED,
        "Rate Limit Exceeded",
        "Too many API requests in a short time period.",
        [
            "Wait before making more requests",
            "Implement exponential backoff retry logic",
            "Switch to local mode temporarily",
            "Upgrade to higher rate limit plan",
            "Use batch processing for multiple prompts",
        ],
        "https://docs.securevector.io/rate-limits",
    ),
    ErrorCode.RULES_LOAD_FAILED: ErrorSolution(
        ErrorCode.RULES_LOAD_FAILED,
        "Security Rules Load Failed",
        "Unable to load security rules for threat detection.",
        [
            "Check if rules directory exists and is readable",
            "Verify rule file format (YAML)",
            "Reinstall the package to restore community rules",
            "Check file permissions on rules directory",
        ],
        "https://docs.securevector.io/custom-rules",
    ),
}


class AIThreatMonitorException(Exception):
    """Base exception for all AI Threat Monitor errors"""

    def __init__(
        self,
        message: str,
        error_code: Optional[Union[ErrorCode, str]] = None,
        context: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(message)
        # Handle both ErrorCode enum and string error codes
        if error_code is None:
            self.error_code = ErrorCode.UNKNOWN_ERROR
        elif isinstance(error_code, str):
            # Store string as-is, will be handled in __str__ and code property
            self.error_code = error_code
        else:
            self.error_code = error_code

        self.context = context or {}
        # Only get solution for ErrorCode enum values
        if isinstance(self.error_code, ErrorCode):
            self.solution = ERROR_SOLUTIONS.get(self.error_code)
        else:
            self.solution = None

    def __str__(self) -> str:
        base_message = super().__str__()
        # Handle both ErrorCode enum and string
        if isinstance(self.error_code, ErrorCode):
            error_code_str = self.error_code.value
        else:
            error_code_str = str(self.error_code)

        error_info = f"\n[{error_code_str}] {base_message}"

        if self.solution:
            error_info += str(self.solution)

        if self.context:
            context_info = "\n📋 Context:\n" + "\n".join(
                [f"  • {k}: {v}" for k, v in self.context.items()]
            )
            error_info += context_info

        return error_info

    @property
    def code(self) -> str:
        """Get the error code as string"""
        if isinstance(self.error_code, ErrorCode):
            return self.error_code.value
        return str(self.error_code)


class SecurityException(AIThreatMonitorException):
    """Raised when a security threat is detected"""

    def __init__(
        self,
        message: str,
        result: Optional[AnalysisResult] = None,
        action: Optional[PolicyAction] = None,
        error_code: Union[ErrorCode, str] = ErrorCode.SECURITY_THREAT_DETECTED,
        **kwargs,
    ):
        context = {
            "risk_score": result.risk_score if result else None,
            "threat_types": result.threat_types if result else [],
            "policy_action": action.value if action else None,
            **kwargs,
        }
        super().__init__(message, error_code, context)
        self.result = result
        self.action = action

    @property
    def threat_type(self) -> Optional[str]:
        """Get the primary threat type"""
        if self.result and self.result.detections:
            return self.result.detections[0].threat_type
        return None

    @property
    def risk_score(self) -> Optional[int]:
        """Get the risk score"""
        return self.result.risk_score if self.result else None


class ConfigurationError(AIThreatMonitorException):
    """Raised when there's a configuration error"""

    def __init__(self, message: str, error_code: Union[ErrorCode, str] = ErrorCode.CONFIG_INVALID, **kwargs):
        super().__init__(message, error_code, kwargs)


class ModeNotAvailableError(AIThreatMonitorException):
    """Raised when a requested mode is not available"""

    def __init__(
        self, message: str, error_code: Union[ErrorCode, str] = ErrorCode.MODE_NOT_AVAILABLE, **kwargs
    ):
        super().__init__(message, error_code, kwargs)


class APIError(AIThreatMonitorException):
    """Raised when there's an API communication error"""

    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        response_body: Optional[str] = None,
        error_code: Union[ErrorCode, str] = ErrorCode.API_CONNECTION_FAILED,
        **kwargs,
    ):
        context = {"status_code": status_code, "response_body": response_body, **kwargs}
        super().__init__(message, error_code, context)
        self.status_code = status_code
        self.response_body = response_body


class AuthenticationError(APIError):
    """Raised when API authentication fails"""

    def __init__(self, message: str, **kwargs):
        super().__init__(message, error_code=ErrorCode.API_AUTHENTICATION_FAILED, **kwargs)


class RateLimitError(APIError):
    """Raised when API rate limit is exceeded"""

    def __init__(self, message: str, retry_after: Optional[int] = None, **kwargs):
        context = {"retry_after_seconds": retry_after, **kwargs}
        super().__init__(message, error_code=ErrorCode.API_RATE_LIMIT_EXCEEDED, **context)


class ValidationError(AIThreatMonitorException):
    """Raised when input validation fails"""

    def __init__(
        self,
        message: str,
        error_code: Union[ErrorCode, str] = ErrorCode.VALIDATION_INVALID_INPUT_TYPE,
        **kwargs,
    ):
        super().__init__(message, error_code, kwargs)


class RuleLoadError(AIThreatMonitorException):
    """Raised when security rules cannot be loaded"""

    def __init__(self, message: str, error_code: Union[ErrorCode, str] = ErrorCode.RULES_LOAD_FAILED, **kwargs):
        super().__init__(message, error_code, kwargs)


class CacheError(AIThreatMonitorException):
    """Raised when there's a caching error"""

    def __init__(
        self, message: str, error_code: Union[ErrorCode, str] = ErrorCode.CACHE_WRITE_FAILED, **kwargs
    ):
        super().__init__(message, error_code, kwargs)


class PerformanceError(AIThreatMonitorException):
    """Raised when performance thresholds are exceeded"""

    def __init__(
        self,
        message: str,
        error_code: Union[ErrorCode, str] = ErrorCode.PERFORMANCE_THRESHOLD_EXCEEDED,
        **kwargs,
    ):
        super().__init__(message, error_code, kwargs)


class CircuitBreakerError(AIThreatMonitorException):
    """Raised when circuit breaker is open"""

    def __init__(
        self, message: str, error_code: Union[ErrorCode, str] = ErrorCode.CIRCUIT_BREAKER_OPEN, **kwargs
    ):
        super().__init__(message, error_code, kwargs)


# Legacy exception for backwards compatibility
class ThreatDetectedException(SecurityException):
    """Legacy exception name for backwards compatibility"""

    pass
