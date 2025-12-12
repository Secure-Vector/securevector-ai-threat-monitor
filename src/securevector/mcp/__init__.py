"""
SecureVector MCP (Model Context Protocol) Server

This module provides MCP server capabilities for SecureVector AI Threat Monitor,
enabling LLMs to securely access threat analysis tools through standardized interfaces.

The MCP server exposes:
- Tools: analyze_prompt, batch_analyze, get_threat_statistics
- Resources: threat detection rules, security policies
- Prompts: analysis workflow templates

Usage:
    from securevector.mcp import SecureVectorMCPServer

    server = SecureVectorMCPServer()
    server.run()

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

from typing import Optional

try:
    from .server import SecureVectorMCPServer
    from .config.server_config import MCPServerConfig

    # Optional imports - only available if mcp is installed
    MCP_AVAILABLE = True
except ImportError:
    MCP_AVAILABLE = False

    class SecureVectorMCPServer:
        def __init__(self, *args, **kwargs):
            raise ImportError(
                "MCP dependencies not installed. Install with: "
                "pip install securevector-ai-monitor[mcp]"
            )

    class MCPServerConfig:
        def __init__(self, *args, **kwargs):
            raise ImportError(
                "MCP dependencies not installed. Install with: "
                "pip install securevector-ai-monitor[mcp]"
            )

__version__ = "1.1.0"
__all__ = [
    "SecureVectorMCPServer",
    "MCPServerConfig",
    "MCP_AVAILABLE",
]

def create_mcp_server(
    name: str = "SecureVector AI Threat Monitor",
    api_key: Optional[str] = None,
    **kwargs
) -> "SecureVectorMCPServer":
    """
    Create a SecureVector MCP server instance.

    Args:
        name: Server name for MCP identification
        api_key: Optional API key for authentication
        **kwargs: Additional configuration options

    Returns:
        SecureVectorMCPServer instance

    Raises:
        ImportError: If MCP dependencies not installed
    """
    if not MCP_AVAILABLE:
        raise ImportError(
            "MCP dependencies not installed. Install with: "
            "pip install securevector-ai-monitor[mcp]"
        )

    return SecureVectorMCPServer(name=name, api_key=api_key, **kwargs)

def check_mcp_dependencies() -> bool:
    """
    Check if MCP dependencies are available.

    Returns:
        True if MCP can be used, False otherwise
    """
    return MCP_AVAILABLE
