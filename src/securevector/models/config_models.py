"""
Configuration models for the AI Threat Monitor SDK.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import os
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, Optional

from securevector.utils.security import mask_sensitive_value, sanitize_dict_for_logging


class OperationMode(Enum):
    """SDK operation modes"""

    LOCAL = "local"  # Local rules only
    API = "api"  # API-enhanced detection
    HYBRID = "hybrid"  # Intelligent local + API
    AUTO = "auto"  # Automatic mode selection


class LogLevel(Enum):
    """Logging levels"""

    DEBUG = "debug"
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


@dataclass
class ModeConfig:
    """Configuration for specific operation modes"""

    # Common settings
    enabled: bool = True
    timeout_ms: int = 5000
    retry_attempts: int = 3
    cache_enabled: bool = True
    cache_ttl_seconds: int = 300

    # Mode-specific settings
    mode_specific: Dict[str, Any] = field(default_factory=dict)

    def get(self, key: str, default: Any = None) -> Any:
        """Get mode-specific configuration value"""
        return self.mode_specific.get(key, default)

    def set(self, key: str, value: Any) -> None:
        """Set mode-specific configuration value"""
        self.mode_specific[key] = value


@dataclass
class LocalModeConfig(ModeConfig):
    """Configuration specific to local mode"""

    rules_path: Optional[str] = None
    custom_rules_enabled: bool = True
    pattern_cache_size: int = 1000
    rule_compilation: bool = True
    performance_monitoring: bool = True

    def __post_init__(self):
        if self.rules_path is None:
            # Default to community rules from llm-rules-builder
            self.rules_path = os.path.join(os.path.dirname(__file__), "../rules/community")


@dataclass
class APIModeConfig(ModeConfig):
    """
    Configuration specific to API mode.

    The default API URL points to the production endpoint: https://scan.securevector.io
    Development builds automatically configure a separate development endpoint during the build process.

    This can be overridden via SECUREVECTOR_API_URL environment variable.
    """

    api_url: str = "https://scan.securevector.io"  # Default to production, overridden during build
    api_key: Optional[str] = None
    endpoint: str = "/analyze"
    user_tier: str = "community"  # User tier: community, professional, enterprise
    max_request_size: int = 1024 * 1024  # 1MB
    rate_limit_requests: int = 100
    rate_limit_window_seconds: int = 60
    fallback_to_local: bool = True

    def __post_init__(self):
        # Allow override from environment variable
        api_url_env = os.getenv("SECUREVECTOR_API_URL")
        if api_url_env:
            self.api_url = api_url_env

        if self.api_key is None:
            self.api_key = os.getenv("SECUREVECTOR_API_KEY")

        # Get user tier from environment if set
        user_tier_env = os.getenv("SECUREVECTOR_USER_TIER")
        if user_tier_env:
            self.user_tier = user_tier_env


@dataclass
class HybridModeConfig(ModeConfig):
    """Configuration specific to hybrid mode"""

    local_first: bool = True
    api_threshold_score: int = 50  # Use API for scores above this
    smart_routing: bool = True
    performance_optimization: bool = True
    fallback_strategy: str = "local"  # "local" or "block"


@dataclass
class SDKConfig:
    """Main SDK configuration"""

    # Core settings
    mode: OperationMode = OperationMode.AUTO
    risk_threshold: int = 70  # Block threats above this score
    log_level: LogLevel = LogLevel.INFO
    log_all_requests: bool = False
    raise_on_threat: bool = True

    # Performance settings
    enable_caching: bool = True
    cache_size: int = 10000
    performance_monitoring: bool = True
    metrics_enabled: bool = True

    # Mode configurations
    local_config: LocalModeConfig = field(default_factory=LocalModeConfig)
    api_config: APIModeConfig = field(default_factory=APIModeConfig)
    hybrid_config: HybridModeConfig = field(default_factory=HybridModeConfig)

    # Custom settings
    custom_settings: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "SDKConfig":
        """Create configuration from environment variables"""
        config = cls()

        # Parse mode from environment
        mode_str = os.getenv("SECUREVECTOR_MODE", "auto").lower()
        try:
            config.mode = OperationMode(mode_str)
        except ValueError:
            config.mode = OperationMode.AUTO

        # Parse other settings
        config.risk_threshold = int(os.getenv("SECUREVECTOR_RISK_THRESHOLD", "70"))
        config.log_all_requests = os.getenv("SECUREVECTOR_LOG_ALL", "false").lower() == "true"
        config.raise_on_threat = os.getenv("SECUREVECTOR_RAISE_ON_THREAT", "true").lower() == "true"
        config.enable_caching = os.getenv("SECUREVECTOR_ENABLE_CACHE", "true").lower() == "true"

        # Log level
        log_level_str = os.getenv("SECUREVECTOR_LOG_LEVEL", "info").lower()
        try:
            config.log_level = LogLevel(log_level_str)
        except ValueError:
            config.log_level = LogLevel.INFO

        # API configuration
        api_key = os.getenv("SECUREVECTOR_API_KEY")
        if api_key:
            config.api_config.api_key = api_key

        api_url = os.getenv("SECUREVECTOR_API_URL")
        if api_url:
            config.api_config.api_url = api_url

        # Local configuration
        rules_path = os.getenv("SECUREVECTOR_RULES_PATH")
        if rules_path:
            config.local_config.rules_path = rules_path

        return config

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SDKConfig":
        """Create configuration from dictionary"""
        config = cls()

        # Basic settings
        if "mode" in data:
            config.mode = OperationMode(data["mode"])
        if "risk_threshold" in data:
            config.risk_threshold = data["risk_threshold"]
        if "log_level" in data:
            config.log_level = LogLevel(data["log_level"])
        if "log_all_requests" in data:
            config.log_all_requests = data["log_all_requests"]
        if "raise_on_threat" in data:
            config.raise_on_threat = data["raise_on_threat"]
        if "enable_caching" in data:
            config.enable_caching = data["enable_caching"]

        # Mode-specific configurations
        if "local_config" in data:
            config.local_config = LocalModeConfig(**data["local_config"])
        if "api_config" in data:
            config.api_config = APIModeConfig(**data["api_config"])
        if "hybrid_config" in data:
            config.hybrid_config = HybridModeConfig(**data["hybrid_config"])

        # Custom settings
        if "custom_settings" in data:
            config.custom_settings = data["custom_settings"]

        return config

    def to_dict(self, secure: bool = True) -> Dict[str, Any]:
        """
        Convert configuration to dictionary.

        Args:
            secure: If True, masks sensitive values like API keys. If False, includes raw values.
                   Use secure=False only for internal operations that need actual values.
        """
        data = {
            "mode": self.mode.value,
            "risk_threshold": self.risk_threshold,
            "log_level": self.log_level.value,
            "log_all_requests": self.log_all_requests,
            "raise_on_threat": self.raise_on_threat,
            "enable_caching": self.enable_caching,
            "cache_size": self.cache_size,
            "performance_monitoring": self.performance_monitoring,
            "metrics_enabled": self.metrics_enabled,
            "local_config": {
                "enabled": self.local_config.enabled,
                "timeout_ms": self.local_config.timeout_ms,
                "retry_attempts": self.local_config.retry_attempts,
                "cache_enabled": self.local_config.cache_enabled,
                "cache_ttl_seconds": self.local_config.cache_ttl_seconds,
                "rules_path": self.local_config.rules_path,
                "custom_rules_enabled": self.local_config.custom_rules_enabled,
                "pattern_cache_size": self.local_config.pattern_cache_size,
                "rule_compilation": self.local_config.rule_compilation,
                "performance_monitoring": self.local_config.performance_monitoring,
            },
            "api_config": {
                "enabled": self.api_config.enabled,
                "timeout_ms": self.api_config.timeout_ms,
                "retry_attempts": self.api_config.retry_attempts,
                "cache_enabled": self.api_config.cache_enabled,
                "cache_ttl_seconds": self.api_config.cache_ttl_seconds,
                "api_url": self.api_config.api_url,
                "api_key": (
                    mask_sensitive_value(self.api_config.api_key)
                    if secure
                    else self.api_config.api_key
                ),
                "endpoint": self.api_config.endpoint,
                "user_tier": self.api_config.user_tier,
                "max_request_size": self.api_config.max_request_size,
                "rate_limit_requests": self.api_config.rate_limit_requests,
                "rate_limit_window_seconds": self.api_config.rate_limit_window_seconds,
                "fallback_to_local": self.api_config.fallback_to_local,
            },
            "hybrid_config": {
                "enabled": self.hybrid_config.enabled,
                "timeout_ms": self.hybrid_config.timeout_ms,
                "retry_attempts": self.hybrid_config.retry_attempts,
                "cache_enabled": self.hybrid_config.cache_enabled,
                "cache_ttl_seconds": self.hybrid_config.cache_ttl_seconds,
                "local_first": self.hybrid_config.local_first,
                "api_threshold_score": self.hybrid_config.api_threshold_score,
                "smart_routing": self.hybrid_config.smart_routing,
                "performance_optimization": self.hybrid_config.performance_optimization,
                "fallback_strategy": self.hybrid_config.fallback_strategy,
            },
            "custom_settings": self.custom_settings,
        }

        # Apply additional sanitization if secure mode is enabled
        if secure:
            data = sanitize_dict_for_logging(data)

        return data

    def get_mode_config(self) -> ModeConfig:
        """Get configuration for the current mode"""
        if self.mode == OperationMode.LOCAL:
            return self.local_config
        elif self.mode == OperationMode.API:
            return self.api_config
        elif self.mode == OperationMode.HYBRID:
            return self.hybrid_config
        else:  # AUTO mode
            # Return hybrid config as default for auto mode
            return self.hybrid_config
