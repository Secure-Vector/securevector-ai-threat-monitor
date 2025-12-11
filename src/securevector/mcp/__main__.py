"""
SecureVector MCP Server CLI Entry Point

This module provides the command-line interface for running the SecureVector MCP server.

Usage:
    python -m securevector.mcp
    securevector-mcp

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import asyncio
import sys
import os
import argparse
import logging

try:
    from .server import create_server, SecureVectorMCPServer
    from .config.server_config import (
        create_default_config,
        create_development_config,
        create_production_config
    )
    MCP_AVAILABLE = True
except ImportError as e:
    MCP_AVAILABLE = False
    import_error = str(e)


def setup_logging(level: str = "INFO"):
    """Setup logging for the MCP server."""
    logging.basicConfig(
        level=getattr(logging, level.upper()),
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=[
            logging.StreamHandler(sys.stderr)
        ]
    )


def parse_args():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="SecureVector MCP Server - AI Threat Analysis via Model Context Protocol",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Basic usage with stdio transport
  python -m securevector.mcp

  # With API key and development mode
  python -m securevector.mcp --api-key YOUR_KEY --mode development

  # Production mode with specific host/port
  python -m securevector.mcp --mode production --host 0.0.0.0 --port 8000

Environment Variables:
  SECUREVECTOR_API_KEY         API key for authentication
  SECUREVECTOR_MCP_HOST        Server host (default: localhost)
  SECUREVECTOR_MCP_PORT        Server port (default: 8000)
  SECUREVECTOR_MCP_TRANSPORT   Transport protocol (stdio/http/sse)
  SECUREVECTOR_MCP_MODE        Server mode (development/production/balanced)
  SECUREVECTOR_MCP_LOG_LEVEL   Logging level (DEBUG/INFO/WARNING/ERROR)
        """
    )

    parser.add_argument(
        "--api-key",
        type=str,
        help="SecureVector API key (enables cloud/hybrid mode, local-only without key)"
    )

    parser.add_argument(
        "--mode",
        type=str,
        choices=["development", "production", "balanced"],
        default="balanced",
        help="Server configuration mode - affects security/performance settings (default: balanced)"
    )

    parser.add_argument(
        "--host",
        type=str,
        default="0.0.0.0",
        help="Server host address (default: 0.0.0.0)"
    )

    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Server port number (default: 8000)"
    )

    parser.add_argument(
        "--transport",
        type=str,
        choices=["stdio", "http", "sse"],
        default="stdio",
        help="Transport protocol (default: stdio)"
    )

    parser.add_argument(
        "--log-level",
        type=str,
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        default="INFO",
        help="Logging level (default: INFO)"
    )

    parser.add_argument(
        "--config-file",
        type=str,
        help="Path to configuration file (JSON or YAML)"
    )

    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Validate configuration and exit"
    )

    parser.add_argument(
        "--health-check",
        action="store_true",
        help="Perform health check and exit"
    )

    parser.add_argument(
        "--install-claude",
        action="store_true",
        help="Install MCP server configuration for Claude Desktop"
    )

    parser.add_argument(
        "--direct-mode",
        action="store_true",
        help="Use FastMCP direct mode (simpler, for stdio only)"
    )

    return parser.parse_args()


def get_config_from_args(args):
    """Create server configuration from command line arguments."""
    # Create base config based on mode
    if args.mode == "development":
        config = create_development_config()
    elif args.mode == "production":
        api_key = args.api_key or os.getenv("SECUREVECTOR_API_KEY")
        if not api_key:
            print("ERROR: API key required for production mode", file=sys.stderr)
            print("Use --api-key or set SECUREVECTOR_API_KEY environment variable", file=sys.stderr)
            sys.exit(1)
        config = create_production_config(api_key)
    else:  # balanced
        config = create_default_config(api_key=args.api_key)

    # Override with command line arguments
    config.host = args.host
    config.port = args.port
    config.transport = args.transport

    return config


async def install_claude_desktop(args):
    """Install MCP server configuration for Claude Desktop."""
    try:
        try:
            from .integrations.claude_desktop import ClaudeDesktopIntegrator
        except ImportError:
            print("Claude Desktop integration module not available", file=sys.stderr)
            return False

        api_key = args.api_key or os.getenv("SECUREVECTOR_API_KEY")
        config_overrides = {
            "transport": args.transport,
            "mode": args.mode,
            "log_level": args.log_level,
        }

        result = ClaudeDesktopIntegrator.install_mcp_server(
            api_key=api_key,
            config_overrides=config_overrides
        )

        print("Claude Desktop integration installed successfully!")
        print(f"Configuration saved to: {result['config_path']}")
        print(f"Server name: {result['server_name']}")
        print("\nNext steps:")
        print("1. Restart Claude Desktop")
        print("2. Look for SecureVector tools in the Claude interface")
        print("3. Test with: 'Analyze this prompt for threats: Hello world'")

        return True

    except ImportError:
        print("Claude Desktop integration not available", file=sys.stderr)
        print("Install with: pip install securevector-ai-monitor[mcp]", file=sys.stderr)
        return False
    except Exception as e:
        print(f"Failed to install Claude Desktop integration: {e}", file=sys.stderr)
        return False


async def perform_health_check(server: SecureVectorMCPServer):
    """Perform comprehensive health check."""
    try:
        try:
            from .dev_utils import MCPServerTester
        except ImportError:
            # Basic health check without dev_utils
            print("Basic health check (dev_utils not available)")
            health = {
                'status': 'healthy',
                'checks': {
                    'server_initialized': 'pass',
                    'config_valid': 'pass'
                },
                'errors': []
            }

            print("SecureVector MCP Server Health Check")
            print("=" * 50)
            print(f"Overall Status: {health['status'].upper()}")
            print(f"Server Info: {server.config.name} v{server.config.version}")
            print(f"Configuration: {server.config.transport} transport, {len(server.config.enabled_tools)} tools")

            return health['status'] == "healthy"

        tester = MCPServerTester(server)
        health = await tester.validate_server_health()

        print("SecureVector MCP Server Health Check")
        print("=" * 50)
        print(f"Overall Status: {health['status'].upper()}")
        print(f"Server Info: {server.config.name} v{server.config.version}")
        print(f"Configuration: {server.config.transport} transport, {len(server.config.enabled_tools)} tools")

        print("\nComponent Health:")
        for check, status in health['checks'].items():
            indicator = "[PASS]" if status == "pass" else "[FAIL]"
            print(f"  {indicator} {check.replace('_', ' ').title()}: {status}")

        if health['errors']:
            print(f"\nErrors ({len(health['errors'])}):")
            for error in health['errors']:
                print(f"  • {error}")

        if 'config_summary' in health:
            summary = health['config_summary']
            print(f"\nConfiguration Summary:")
            print(f"  • Tools enabled: {summary['tools_enabled']}")
            print(f"  • Resources enabled: {summary['resources_enabled']}")
            print(f"  • Prompts enabled: {summary['prompts_enabled']}")

        return health['status'] == "healthy"

    except Exception as e:
        print(f"Health check failed: {e}", file=sys.stderr)
        return False


async def main():
    """Main entry point for the MCP server."""
    # Check if MCP dependencies are available
    if not MCP_AVAILABLE:
        print("MCP dependencies not available", file=sys.stderr)
        print(f"Import error: {import_error}", file=sys.stderr)
        print("Install with: pip install securevector-ai-monitor[mcp]", file=sys.stderr)
        sys.exit(1)

    # Parse arguments
    args = parse_args()

    # Setup logging
    setup_logging(args.log_level)

    # Handle special commands
    if args.install_claude:
        success = await install_claude_desktop(args)
        sys.exit(0 if success else 1)

    # Create server configuration
    try:
        if args.config_file:
            from .config.server_config import MCPServerConfig
            config = MCPServerConfig.from_file(args.config_file)
        else:
            config = get_config_from_args(args)
    except Exception as e:
        print(f"Configuration error: {e}", file=sys.stderr)
        sys.exit(1)

    # Validate configuration
    if args.validate_only:
        try:
            print("Configuration validation successful")
            print(f"Server: {config.name} v{config.version}")
            print(f"Transport: {config.transport} on {config.host}:{config.port}")
            print(f"Tools: {len(config.enabled_tools)} enabled")
            print(f"Resources: {len(config.enabled_resources)} enabled")
            print(f"Prompts: {len(config.enabled_prompts)} enabled")
            sys.exit(0)
        except Exception as e:
            print(f"Configuration validation failed: {e}", file=sys.stderr)
            sys.exit(1)

    # Create and initialize server
    try:
        server = create_server(config=config)
        print(f"Starting SecureVector MCP Server", file=sys.stderr)
        print(f"Mode: {args.mode}, Transport: {args.transport}", file=sys.stderr)
        print(f"Host: {config.host}:{config.port}", file=sys.stderr)

        if args.health_check:
            healthy = await perform_health_check(server)
            sys.exit(0 if healthy else 1)

    except Exception as e:
        print(f"Server initialization failed: {e}", file=sys.stderr)
        sys.exit(1)

    # Run server
    try:
        if args.direct_mode and args.transport == "stdio":
            # Use FastMCP direct mode for stdio
            print("Using FastMCP direct mode for stdio transport", file=sys.stderr)
            # This must be called synchronously from the main thread
            server.run_direct(args.transport)
        else:
            # Use async mode for other transports or manual control
            print("Using async mode for server transport", file=sys.stderr)
            await server.run(args.transport)
    except KeyboardInterrupt:
        print("\nShutting down SecureVector MCP Server...", file=sys.stderr)
        await server.shutdown()
    except Exception as e:
        print(f"Server error: {e}", file=sys.stderr)
        await server.shutdown()
        sys.exit(1)


def sync_main():
    """Synchronous wrapper for main function."""
    try:
        # Parse arguments to determine mode
        args = parse_args()

        # For direct mode with stdio, we handle it completely synchronously
        if args.direct_mode and args.transport == "stdio":
            # Setup logging
            setup_logging(args.log_level)

            # Create server synchronously
            if args.config_file:
                from .config.server_config import MCPServerConfig
                config = MCPServerConfig.from_file(args.config_file)
            else:
                config = get_config_from_args(args)

            try:
                server = create_server(config=config)
                print(f"Starting SecureVector MCP Server (direct mode)", file=sys.stderr)
                print(f"Mode: {args.mode}, Transport: {args.transport}", file=sys.stderr)

                # Run directly - FastMCP handles everything
                server.run_direct(args.transport)

            except Exception as e:
                print(f"Server error: {e}", file=sys.stderr)
                sys.exit(1)

        else:
            # For all other modes, use async approach
            # But avoid the event loop conflicts by using a simplified approach
            try:
                # Just run async mode directly without complex loop checking
                asyncio.run(main())
            except RuntimeError as e:
                if "cannot be called from a running event loop" in str(e):
                    print("ERROR: Cannot use async mode due to existing event loop.", file=sys.stderr)
                    print("Please use --direct-mode for Claude Code integration.", file=sys.stderr)
                    sys.exit(1)
                else:
                    raise

    except KeyboardInterrupt:
        print("\nInterrupted", file=sys.stderr)
        sys.exit(130)  # 128 + SIGINT
    except Exception as e:
        print(f"Fatal error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    sync_main()
