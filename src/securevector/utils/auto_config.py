"""
Advanced auto-configuration and mode detection for zero-config initialization.

This module provides intelligent configuration detection and sensible defaults
to ensure the SDK works perfectly out of the box with minimal configuration.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import logging
import os
import platform
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from securevector.models.config_models import LogLevel, OperationMode, SDKConfig
from .exceptions import ConfigurationError, ErrorCode
from .logger import get_logger


class AutoConfigurator:
    """Advanced auto-configuration for zero-config SDK initialization"""

    def __init__(self):
        self.logger = get_logger(__name__)
        self._detected_capabilities = {}
        self._environment_info = {}

    def create_optimal_config(
        self,
        user_mode: Optional[OperationMode] = None,
        api_key: Optional[str] = None,
        **user_overrides,
    ) -> SDKConfig:
        """
        Create optimal configuration with intelligent defaults and auto-detection.

        Args:
            user_mode: User-specified mode (overrides auto-detection)
            api_key: User-provided API key
            **user_overrides: Additional user configuration overrides

        Returns:
            SDKConfig: Optimally configured SDK instance
        """
        self.logger.debug("Starting auto-configuration process")

        # Detect environment capabilities
        self._detect_environment()

        # Start with base configuration
        config = SDKConfig.from_env()

        # Apply intelligent mode selection
        if user_mode:
            config.mode = user_mode
        else:
            config.mode = self._determine_optimal_mode(api_key)

        # Apply performance optimizations based on environment
        self._optimize_for_environment(config)

        # Apply sensible defaults
        self._apply_sensible_defaults(config)

        # Apply user overrides
        for key, value in user_overrides.items():
            if hasattr(config, key):
                setattr(config, key, value)
                self.logger.debug(f"Applied user override: {key} = {value}")

        # Validate final configuration
        self._validate_configuration(config)

        self.logger.info(f"Auto-configured for {config.mode.value} mode with optimizations")
        return config

    def _detect_environment(self) -> None:
        """Detect environment capabilities and characteristics"""
        self._environment_info = {
            "platform": platform.system(),
            "python_version": sys.version_info,
            "is_docker": self._is_running_in_docker(),
            "is_cloud": self._is_running_in_cloud(),
            "is_ci": self._is_running_in_ci(),
            "available_memory_mb": self._get_available_memory(),
            "cpu_count": os.cpu_count() or 1,
            "has_network": self._check_network_connectivity(),
            "is_development": self._is_development_environment(),
        }

        # Detect SDK capabilities
        self._detected_capabilities = {
            "local_rules_available": self._check_local_rules(),
            "api_connectivity": self._check_api_connectivity(),
            "caching_supported": self._check_caching_support(),
            "async_supported": sys.version_info >= (3, 7),
            "telemetry_supported": True,  # Always supported
        }

        self.logger.debug(f"Environment detected: {self._environment_info}")
        self.logger.debug(f"Capabilities detected: {self._detected_capabilities}")

    def _determine_optimal_mode(self, api_key: Optional[str]) -> OperationMode:
        """Determine optimal operation mode based on environment and capabilities"""

        # Check for explicit environment variable
        env_mode = os.getenv("SECUREVECTOR_MODE", "").lower()
        if env_mode in ["local", "api", "hybrid"]:
            try:
                return OperationMode(env_mode)
            except ValueError:
                pass

        # Intelligent mode selection logic
        has_api_key = bool(api_key or os.getenv("SECUREVECTOR_API_KEY"))
        has_network = self._environment_info.get("has_network", True)
        is_ci = self._environment_info.get("is_ci", False)
        _  = self._environment_info.get("is_development", False)
        local_rules_available = self._detected_capabilities.get("local_rules_available", True)

        # Decision matrix for optimal mode
        if is_ci:
            # CI environments: prefer local for speed and reliability
            if local_rules_available:
                self.logger.debug("CI environment detected: choosing LOCAL mode")
                return OperationMode.LOCAL
            elif has_api_key and has_network:
                self.logger.debug("CI environment with API access: choosing API mode")
                return OperationMode.API

        if not has_network:
            # No network: must use local
            if local_rules_available:
                self.logger.debug("No network detected: choosing LOCAL mode")
                return OperationMode.LOCAL
            else:
                self.logger.warning("No network and no local rules: using LOCAL mode anyway")
                return OperationMode.LOCAL

        if has_api_key and has_network:
            # API key available: prefer hybrid for best of both worlds
            if local_rules_available:
                self.logger.debug("API key and local rules available: choosing HYBRID mode")
                return OperationMode.HYBRID
            else:
                self.logger.debug("API key available, no local rules: choosing API mode")
                return OperationMode.API

        # Default to local mode
        if local_rules_available:
            self.logger.debug("Default configuration: choosing LOCAL mode")
            return OperationMode.LOCAL
        else:
            self.logger.warning("No optimal mode found: defaulting to LOCAL mode")
            return OperationMode.LOCAL

    def _optimize_for_environment(self, config: SDKConfig) -> None:
        """Apply performance optimizations based on environment"""

        # Memory optimizations
        available_memory = self._environment_info.get("available_memory_mb", 1024)
        if available_memory < 512:  # Low memory environment
            config.enable_caching = False
            config.max_batch_size = 10
            self.logger.debug("Low memory detected: disabled caching, reduced batch size")
        elif available_memory > 4096:  # High memory environment
            config.cache_max_size = 10000
            config.max_batch_size = 100
            self.logger.debug("High memory detected: increased cache and batch sizes")

        # CPU optimizations
        cpu_count = self._environment_info.get("cpu_count", 1)
        if cpu_count >= 4:
            config.performance_monitoring = True
            self.logger.debug("Multi-core CPU detected: enabled performance monitoring")

        # Network optimizations
        if not self._environment_info.get("has_network", True):
            config.enable_caching = True  # More aggressive caching when offline
            config.cache_ttl_seconds = 3600  # Longer cache TTL
            self.logger.debug("No network detected: enhanced caching configuration")

        # Development environment optimizations
        if self._environment_info.get("is_development", False):
            config.log_level = LogLevel.DEBUG
            config.log_all_requests = True
            config.performance_monitoring = True
            self.logger.debug("Development environment detected: enhanced logging and monitoring")

        # CI environment optimizations
        if self._environment_info.get("is_ci", False):
            config.log_level = LogLevel.INFO
            config.performance_monitoring = False  # Reduce overhead in CI
            config.enable_caching = False  # Avoid cache issues in CI
            self.logger.debug("CI environment detected: optimized for reliability and speed")

        # Cloud environment optimizations
        if self._environment_info.get("is_cloud", False):
            config.request_timeout = 30  # Longer timeout for cloud latency
            config.enable_caching = True
            self.logger.debug("Cloud environment detected: optimized for latency")

    def _apply_sensible_defaults(self, config: SDKConfig) -> None:
        """Apply sensible defaults for common use cases"""

        # Ensure critical settings have sensible values
        if config.risk_threshold is None:
            config.risk_threshold = 70

        if config.max_prompt_length is None:
            config.max_prompt_length = 100000

        if config.max_batch_size is None:
            config.max_batch_size = 50

        # Ensure timeout settings
        if config.request_timeout is None:
            config.request_timeout = 30

        # Ensure caching settings
        if config.cache_ttl_seconds is None:
            config.cache_ttl_seconds = 300  # 5 minutes default

        if config.cache_max_size is None:
            config.cache_max_size = 1000

        self.logger.debug("Applied sensible defaults to configuration")

    def _validate_configuration(self, config: SDKConfig) -> None:
        """Validate final configuration and provide helpful feedback"""

        issues = []
        warnings = []

        # Validate mode-specific requirements
        if config.mode == OperationMode.API:
            if not config.api_config.api_key:
                issues.append("API mode requires an API key")

        if config.mode == OperationMode.HYBRID:
            if not config.api_config.api_key:
                warnings.append("Hybrid mode without API key will fall back to local mode")

        # Validate performance settings
        if config.max_batch_size > 1000:
            warnings.append("Large batch sizes may impact performance")

        if config.cache_max_size > 50000:
            warnings.append("Large cache size may consume significant memory")

        # Report issues
        if issues:
            error_msg = "Configuration validation failed: " + "; ".join(issues)
            raise ConfigurationError(error_msg, error_code=ErrorCode.CONFIG_INVALID)

        if warnings:
            for warning in warnings:
                self.logger.warning(f"Configuration warning: {warning}")

        self.logger.debug("Configuration validation completed successfully")

    def _is_running_in_docker(self) -> bool:
        """Check if running in Docker container"""
        return (
            os.path.exists("/.dockerenv")
            or os.path.exists("/proc/self/cgroup")
            and any("docker" in line for line in open("/proc/self/cgroup", "r").readlines())
        )

    def _is_running_in_cloud(self) -> bool:
        """Check if running in cloud environment"""
        cloud_indicators = [
            "AWS_EXECUTION_ENV",
            "GOOGLE_CLOUD_PROJECT",
            "AZURE_FUNCTIONS_ENVIRONMENT",
            "HEROKU_APP_NAME",
            "VERCEL",
            "NETLIFY",
        ]
        return any(os.getenv(indicator) for indicator in cloud_indicators)

    def _is_running_in_ci(self) -> bool:
        """Check if running in CI environment"""
        ci_indicators = [
            "CI",
            "CONTINUOUS_INTEGRATION",
            "GITHUB_ACTIONS",
            "GITLAB_CI",
            "JENKINS_URL",
            "TRAVIS",
            "CIRCLECI",
            "BUILDKITE",
        ]
        return any(os.getenv(indicator) for indicator in ci_indicators)

    def _get_available_memory(self) -> int:
        """Get available memory in MB"""
        try:
            import psutil

            return int(psutil.virtual_memory().available / 1024 / 1024)
        except ImportError:
            # Fallback estimation based on platform
            if platform.system() == "Linux":
                try:
                    with open("/proc/meminfo", "r") as f:
                        for line in f:
                            if line.startswith("MemAvailable:"):
                                return int(line.split()[1]) // 1024
                except (OSError, IOError, ValueError):
                    pass
            return 1024  # Default assumption

    def _check_network_connectivity(self) -> bool:
        """Check if network connectivity is available"""
        try:
            import socket

            socket.create_connection(("8.8.8.8", 53), timeout=3)
            return True
        except OSError:
            return False

    def _is_development_environment(self) -> bool:
        """Check if running in development environment"""
        dev_indicators = [
            sys.argv[0].endswith("python"),  # Running with python directly
            "pytest" in sys.modules,  # Running tests
            "jupyter" in sys.modules,  # Running in Jupyter
            os.getenv("DEVELOPMENT") == "1",
            os.getenv("DEBUG") == "1",
        ]
        return any(dev_indicators)

    def _check_local_rules(self) -> bool:
        """Check if local rules are available"""
        # Check for bundled rules
        possible_paths = [
            Path(__file__).parent.parent / "rules",
            Path.cwd() / "rules",
            Path("/etc/securevector/rules"),
        ]

        for path in possible_paths:
            if path.exists() and any(path.glob("*.yml")):
                return True

        return False

    def _check_api_connectivity(self) -> bool:
        """Check if API connectivity is available"""
        if not self._environment_info.get("has_network", True):
            return False

        # Could add actual API endpoint check here
        # For now, assume API is available if network is available
        return True

    def _check_caching_support(self) -> bool:
        """Check if caching is supported in current environment"""
        # Caching is generally supported unless in very constrained environments
        available_memory = self._environment_info.get("available_memory_mb", 1024)
        return available_memory >= 128  # Minimum memory for caching

    def get_environment_info(self) -> Dict[str, Any]:
        """Get detected environment information"""
        return {
            "environment": self._environment_info.copy(),
            "capabilities": self._detected_capabilities.copy(),
        }

    def get_recommendations(self, config: SDKConfig) -> List[str]:
        """Get configuration recommendations based on detected environment"""
        recommendations = []

        # Performance recommendations
        if self._environment_info.get("cpu_count", 1) >= 4:
            recommendations.append(
                "Consider using async client for better performance on multi-core systems"
            )

        if self._environment_info.get("available_memory_mb", 1024) > 2048:
            recommendations.append("Consider increasing cache size for better performance")

        # Security recommendations
        if config.mode != OperationMode.LOCAL and not self._environment_info.get(
            "has_network", True
        ):
            recommendations.append("Consider local mode for offline environments")

        # Development recommendations
        if self._environment_info.get("is_development", False):
            recommendations.append("Consider enabling telemetry for development insights")

        return recommendations


# Global auto-configurator instance
_auto_configurator: Optional[AutoConfigurator] = None


def get_auto_configurator() -> AutoConfigurator:
    """Get global auto-configurator instance"""
    global _auto_configurator
    if _auto_configurator is None:
        _auto_configurator = AutoConfigurator()
    return _auto_configurator


def create_zero_config_client(mode: Optional[str] = None, api_key: Optional[str] = None, **kwargs):
    """
    Create optimally configured client with zero configuration required.

    This function uses intelligent auto-detection to create the best possible
    configuration for the current environment.

    Args:
        mode: Optional mode override
        api_key: Optional API key
        **kwargs: Additional configuration overrides

    Returns:
        Optimally configured SecureVectorClient
    """
    from securevector.client import SecureVectorClient

    configurator = get_auto_configurator()

    # Convert string mode to enum if provided
    operation_mode = None
    if mode:
        try:
            operation_mode = OperationMode(mode.lower())
        except ValueError:
            operation_mode = OperationMode.AUTO

    # Create optimal configuration
    config = configurator.create_optimal_config(user_mode=operation_mode, api_key=api_key, **kwargs)

    # Create client with optimal configuration
    client = SecureVectorClient(config=config)

    # Log recommendations if in debug mode
    if config.log_level == LogLevel.DEBUG:
        recommendations = configurator.get_recommendations(config)
        if recommendations:
            logger = get_logger(__name__)
            logger.debug("Configuration recommendations:")
            for rec in recommendations:
                logger.debug(f"  • {rec}")

    return client


async def create_zero_config_async_client(
    mode: Optional[str] = None, api_key: Optional[str] = None, **kwargs
):
    """Create optimally configured async client with zero configuration required"""
    from securevector.async_client import AsyncSecureVectorClient

    configurator = get_auto_configurator()

    operation_mode = None
    if mode:
        try:
            operation_mode = OperationMode(mode.lower())
        except ValueError:
            operation_mode = OperationMode.AUTO

    config = configurator.create_optimal_config(user_mode=operation_mode, api_key=api_key, **kwargs)

    return AsyncSecureVectorClient(config=config)
