#!/usr/bin/env python3
"""
Quick test script to verify SSE and stdio transports work correctly.
"""
import asyncio
import sys
import os

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from securevector.mcp.server import create_server


async def run_sse_transport():
    """Test SSE transport starts and runs."""
    print("Testing SSE transport...")

    try:
        server = create_server(
            name="Test SSE Server",
            api_key=os.getenv("SECUREVECTOR_API_KEY")
        )

        # Configure for SSE
        server.config.transport = "sse"
        server.config.host = "0.0.0.0"
        server.config.port = 8080

        print(f"Starting SSE server on {server.config.host}:{server.config.port}")
        print("Server should stay running... (Ctrl+C to stop)")

        # This should block and keep running
        await server.run("sse")

    except KeyboardInterrupt:
        print("\nSSE server stopped by user")
        return True
    except Exception as e:
        print(f"SSE transport test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


async def run_stdio_transport():
    """Test stdio transport starts and runs."""
    print("Testing stdio transport...")

    try:
        server = create_server(
            name="Test Stdio Server",
            api_key=os.getenv("SECUREVECTOR_API_KEY")
        )

        print("Starting stdio server...")
        print("Server should stay running and accept stdio input... (Ctrl+C to stop)")

        # This should block and keep running
        await server.run("stdio")

    except KeyboardInterrupt:
        print("\nStdio server stopped by user")
        return True
    except Exception as e:
        print(f"Stdio transport test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python test_transports.py [sse|stdio]")
        sys.exit(1)

    transport = sys.argv[1].lower()

    if transport == "sse":
        asyncio.run(run_sse_transport())
    elif transport == "stdio":
        asyncio.run(run_stdio_transport())
    else:
        print(f"Unknown transport: {transport}")
        print("Valid options: sse, stdio")
        sys.exit(1)
