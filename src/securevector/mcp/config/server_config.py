"""
MCP Server Configuration for SecureVector AI Threat Monitor

This module provides configuration classes for the SecureVector MCP server,
including security settings, performance parameters, and server options.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Union
from pathlib import Path


@dataclass
class SecurityConfig:
    """Security configuration for MCP server."""

    # Authentication
    api_key: Optional[str] = None
    require_authentication: bool = True

    # Rate limiting
    requests_per_minute: int = 60
    burst_requests: int = 10

    # Input validation
    max_prompt_length: int = 50000
    max_batch_size: int = 100

    # Audit logging
    enable_audit_logging: bool = True
    audit_log_path: Optional[str] = None

    def __post_init__(self):
        """Post-initialization validation and setup."""
        if self.api_key is None:
            self.api_key = os.getenv("SECUREVECTOR_API_KEY")

        if self.audit_log_path is None:
            self.audit_log_path = os.getenv("SECUREVECTOR_AUDIT_LOG", "securevector_mcp.log")


@dataclass
class PerformanceConfig:
    """Performance configuration for MCP server."""

    # Timeouts
    request_timeout_seconds: int = 30
    analysis_timeout_seconds: int = 10

    # Concurrency
    max_concurrent_requests: int = 10
    worker_pool_size: int = 4

    # Caching
    enable_caching: bool = True
    cache_ttl_seconds: int = 300
    max_cache_size: int = 1000

    # Memory management
    max_memory_mb: int = 512
    garbage_collect_interval: int = 100


@dataclass
class MCPServerConfig:
    """Main configuration for SecureVector MCP server."""

    # Server identification
    name: str = "SecureVector AI Threat Monitor"
    version: str = "1.0.0"
    description: str = "AI threat analysis and security monitoring via MCP"

    # Server settings
    host: str = "localhost"
    port: int = 8000
    transport: str = "stdio"  # stdio, sse, or http

    # Component configurations
    security: SecurityConfig = field(default_factory=SecurityConfig)
    performance: PerformanceConfig = field(default_factory=PerformanceConfig)

    # Feature flags
    enable_tools: bool = True
    enable_resources: bool = True
    enable_prompts: bool = True

    # Tool-specific settings
    enabled_tools: List[str] = field(default_factory=lambda: [
        "analyze_prompt",
        "batch_analyze",
        "get_threat_statistics"
    ])

    # Resource settings
    enabled_resources: List[str] = field(default_factory=lambda: [
        "rules",
        "policies"
    ])

    # Prompt settings
    enabled_prompts: List[str] = field(default_factory=lambda: [
        "threat_analysis_workflow",
        "security_audit_checklist",
        "risk_assessment_guide"
    ])

    # SecureVector client settings
    securevector_mode: str = "auto"
    securevector_config: Dict = field(default_factory=dict)

    def __post_init__(self):
        """Post-initialization validation and setup."""
        self._validate_config()
        self._setup_from_environment()

    def _validate_config(self):
        """Validate configuration parameters."""
        if self.port < 1 or self.port > 65535:
            raise ValueError(f"Invalid port number: {self.port}")

        if self.transport not in ["stdio", "sse", "http"]:
            raise ValueError(f"Invalid transport: {self.transport}")

        if self.security.requests_per_minute <= 0:
            raise ValueError("requests_per_minute must be positive")

        if self.performance.max_concurrent_requests <= 0:
            raise ValueError("max_concurrent_requests must be positive")

    def _setup_from_environment(self):
        """Setup configuration from environment variables."""
        # Server settings
        if env_host := os.getenv("SECUREVECTOR_MCP_HOST"):
            self.host = env_host

        if env_port := os.getenv("SECUREVECTOR_MCP_PORT"):
            try:
                self.port = int(env_port)
            except ValueError:
                raise ValueError(f"Invalid port in environment: {env_port}")

        if env_transport := os.getenv("SECUREVECTOR_MCP_TRANSPORT"):
            self.transport = env_transport

        # Security settings
        if env_api_key := os.getenv("SECUREVECTOR_API_KEY"):
            self.security.api_key = env_api_key

        # SecureVector mode settings
        if env_mode := os.getenv("SECUREVECTOR_MODE"):
            self.securevector_mode = env_mode.lower()

        # Performance settings
        if env_timeout := os.getenv("SECUREVECTOR_MCP_TIMEOUT"):
            try:
                self.performance.request_timeout_seconds = int(env_timeout)
            except ValueError:
                raise ValueError(f"Invalid timeout in environment: {env_timeout}")

    @classmethod
    def from_file(cls, config_path: Union[str, Path]) -> "MCPServerConfig":
        """Load configuration from a file (JSON or YAML)."""
        import json

        config_path = Path(config_path)
        if not config_path.exists():
            raise FileNotFoundError(f"Config file not found: {config_path}")

        with open(config_path, 'r') as f:
            if config_path.suffix.lower() in ['.yml', '.yaml']:
                try:
                    import yaml
                    config_data = yaml.safe_load(f)
                except ImportError:
                    raise ImportError("PyYAML required for YAML config files")
            else:
                config_data = json.load(f)

        return cls(**config_data)

    def to_dict(self) -> Dict:
        """Convert configuration to dictionary."""
        return {
            "name": self.name,
            "version": self.version,
            "description": self.description,
            "host": self.host,
            "port": self.port,
            "transport": self.transport,
            "security": {
                "api_key": "***" if self.security.api_key else None,
                "require_authentication": self.security.require_authentication,
                "requests_per_minute": self.security.requests_per_minute,
                "burst_requests": self.security.burst_requests,
                "max_prompt_length": self.security.max_prompt_length,
                "max_batch_size": self.security.max_batch_size,
                "enable_audit_logging": self.security.enable_audit_logging,
            },
            "performance": {
                "request_timeout_seconds": self.performance.request_timeout_seconds,
                "analysis_timeout_seconds": self.performance.analysis_timeout_seconds,
                "max_concurrent_requests": self.performance.max_concurrent_requests,
                "worker_pool_size": self.performance.worker_pool_size,
                "enable_caching": self.performance.enable_caching,
                "cache_ttl_seconds": self.performance.cache_ttl_seconds,
            },
            "enabled_tools": self.enabled_tools,
            "enabled_resources": self.enabled_resources,
            "enabled_prompts": self.enabled_prompts,
        }


def create_default_config(
    api_key: Optional[str] = None,
    **overrides
) -> MCPServerConfig:
    """
    Create a default MCP server configuration.

    Args:
        api_key: Optional API key for authentication
        **overrides: Configuration overrides

    Returns:
        MCPServerConfig instance with defaults
    """
    config_kwargs = {}

    if api_key:
        config_kwargs["security"] = SecurityConfig(api_key=api_key)

    config_kwargs.update(overrides)

    return MCPServerConfig(**config_kwargs)


def create_development_config() -> MCPServerConfig:
    """
    Create a development-friendly MCP server configuration.

    Returns:
        MCPServerConfig with development settings
    """
    return MCPServerConfig(
        security=SecurityConfig(
            require_authentication=False,
            requests_per_minute=1000,  # Higher limit for development
            enable_audit_logging=False,
        ),
        performance=PerformanceConfig(
            enable_caching=False,  # Disable caching for testing
            max_concurrent_requests=50,
        ),
    )


def create_production_config(api_key: str) -> MCPServerConfig:
    """
    Create a production-ready MCP server configuration.

    Args:
        api_key: Required API key for production

    Returns:
        MCPServerConfig with production settings
    """
    return MCPServerConfig(
        security=SecurityConfig(
            api_key=api_key,
            require_authentication=True,
            requests_per_minute=60,  # Conservative rate limiting
            enable_audit_logging=True,
        ),
        performance=PerformanceConfig(
            request_timeout_seconds=30,
            analysis_timeout_seconds=10,
            max_concurrent_requests=10,
            enable_caching=True,
        ),
    )
