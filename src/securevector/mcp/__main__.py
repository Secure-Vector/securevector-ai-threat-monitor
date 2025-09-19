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
from typing import Optional

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
        help="SecureVector API key for authentication"
    )

    parser.add_argument(
        "--mode",
        type=str,
        choices=["development", "production", "balanced"],
        default="balanced",
        help="Server configuration mode (default: balanced)"
    )

    parser.add_argument(
        "--host",
        type=str,
        default="localhost",
        help="Server host address (default: localhost)"
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
        from .integrations.claude_desktop import ClaudeDesktopIntegrator

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

        print("✅ Claude Desktop integration installed successfully!")
        print(f"📁 Configuration saved to: {result['config_path']}")
        print(f"🔧 Server name: {result['server_name']}")
        print("\n📋 Next steps:")
        print("1. Restart Claude Desktop")
        print("2. Look for SecureVector tools in the Claude interface")
        print("3. Test with: 'Analyze this prompt for threats: Hello world'")

        return True

    except ImportError:
        print("❌ Claude Desktop integration not available", file=sys.stderr)
        print("Install with: pip install securevector-ai-monitor[mcp]", file=sys.stderr)
        return False
    except Exception as e:
        print(f"❌ Failed to install Claude Desktop integration: {e}", file=sys.stderr)
        return False


async def perform_health_check(server: SecureVectorMCPServer):
    """Perform comprehensive health check."""
    try:
        from .dev_utils import MCPServerTester

        tester = MCPServerTester(server)
        health = await tester.validate_server_health()

        print("🏥 SecureVector MCP Server Health Check")
        print("=" * 50)
        print(f"📊 Overall Status: {health['status'].upper()}")
        print(f"⚙️  Server Info: {server.config.name} v{server.config.version}")
        print(f"🔧 Configuration: {server.config.transport} transport, {len(server.config.enabled_tools)} tools")

        print("\n📋 Component Health:")
        for check, status in health['checks'].items():
            emoji = "✅" if status == "pass" else "❌"
            print(f"  {emoji} {check.replace('_', ' ').title()}: {status}")

        if health['errors']:
            print(f"\n⚠️  Errors ({len(health['errors'])}):")
            for error in health['errors']:
                print(f"  • {error}")

        if 'config_summary' in health:
            summary = health['config_summary']
            print(f"\n📈 Configuration Summary:")
            print(f"  • Tools enabled: {summary['tools_enabled']}")
            print(f"  • Resources enabled: {summary['resources_enabled']}")
            print(f"  • Prompts enabled: {summary['prompts_enabled']}")

        return health['status'] == "healthy"

    except Exception as e:
        print(f"❌ Health check failed: {e}", file=sys.stderr)
        return False


async def main():
    """Main entry point for the MCP server."""
    # Check if MCP dependencies are available
    if not MCP_AVAILABLE:
        print("❌ MCP dependencies not available", file=sys.stderr)
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
        print(f"❌ Configuration error: {e}", file=sys.stderr)
        sys.exit(1)

    # Validate configuration
    if args.validate_only:
        try:
            print("✅ Configuration validation successful")
            print(f"📊 Server: {config.name} v{config.version}")
            print(f"🔧 Transport: {config.transport} on {config.host}:{config.port}")
            print(f"⚙️  Tools: {len(config.enabled_tools)} enabled")
            print(f"📚 Resources: {len(config.enabled_resources)} enabled")
            print(f"📝 Prompts: {len(config.enabled_prompts)} enabled")
            sys.exit(0)
        except Exception as e:
            print(f"❌ Configuration validation failed: {e}", file=sys.stderr)
            sys.exit(1)

    # Create and initialize server
    try:
        server = create_server(config=config)
        print(f"🚀 Starting SecureVector MCP Server", file=sys.stderr)
        print(f"📊 Mode: {args.mode}, Transport: {args.transport}", file=sys.stderr)
        print(f"🔧 Host: {config.host}:{config.port}", file=sys.stderr)

        if args.health_check:
            healthy = await perform_health_check(server)
            sys.exit(0 if healthy else 1)

    except Exception as e:
        print(f"❌ Server initialization failed: {e}", file=sys.stderr)
        sys.exit(1)

    # Run server
    try:
        await server.run(args.transport)
    except KeyboardInterrupt:
        print("\n🛑 Shutting down SecureVector MCP Server...", file=sys.stderr)
        await server.shutdown()
    except Exception as e:
        print(f"❌ Server error: {e}", file=sys.stderr)
        await server.shutdown()
        sys.exit(1)


def sync_main():
    """Synchronous wrapper for main function."""
    try:
        # Check if event loop is already running (e.g., in Jupyter notebook or IDE)
        try:
            loop = asyncio.get_running_loop()
            # If we get here, there's already a running loop
            print("⚠️  Event loop already running. Running in separate thread.", file=sys.stderr)
            import threading
            import queue

            # Use a queue to capture any exceptions from the thread
            result_queue = queue.Queue()

            def run_in_thread():
                try:
                    asyncio.run(main())
                    result_queue.put(None)  # Success
                except Exception as e:
                    result_queue.put(e)  # Error

            thread = threading.Thread(target=run_in_thread, daemon=True)
            thread.start()

            # Wait for the thread to complete and check for errors
            try:
                result = result_queue.get(timeout=1)  # Wait 1 second for startup
                if result is not None:
                    raise result
                # If we get here, the server started successfully
                thread.join()  # Wait for completion
            except queue.Empty:
                # Server is still starting up, that's normal
                print("🚀 MCP Server starting...", file=sys.stderr)
                thread.join()  # Wait for completion

        except RuntimeError:
            # No event loop running, safe to use asyncio.run()
            asyncio.run(main())

    except KeyboardInterrupt:
        print("\n🛑 Interrupted", file=sys.stderr)
        sys.exit(130)  # 128 + SIGINT
    except Exception as e:
        print(f"❌ Fatal error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    sync_main()