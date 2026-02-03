"""
Main entry point for the SecureVector Local Threat Monitor Desktop Application.

Usage:
    securevector-app [OPTIONS]

Options:
    --port PORT       API server port (default: 8741)
    --host HOST       API server host (default: 127.0.0.1)
    --web             Run in web browser mode (no desktop window)
    --proxy PLATFORM  Start proxy for agent platform (e.g., openclaw)
    --proxy-port PORT Proxy listen port (default: 18789)
    --mode MODE       Proxy mode: analyze (log only) or block (stop threats)
    --debug           Enable debug logging
    --version         Show version and exit
"""

import argparse
import logging
import os
import sys
import threading
import time
from pathlib import Path

from securevector.app import (
    __app_name__,
    __version__,
    check_app_dependencies,
    AppDependencyError,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def get_assets_path() -> Path:
    """Get the path to the assets directory."""
    return Path(__file__).parent / "assets"


def start_server(host: str, port: int, ready_event: threading.Event) -> None:
    """Start the FastAPI server in a background thread."""
    import uvicorn
    from securevector.app.server.app import create_app

    app = create_app(host=host, port=port)

    # Signal that we're about to start
    def signal_ready():
        time.sleep(0.5)  # Give uvicorn a moment to bind
        ready_event.set()

    threading.Thread(target=signal_ready, daemon=True).start()

    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="warning",
        access_log=False,
    )


def run_desktop(host: str, port: int, debug: bool) -> None:
    """Run the application with a native desktop window."""
    import webview

    assets_path = get_assets_path()
    loading_html = assets_path / "web" / "loading.html"
    favicon_path = assets_path / "favicon.ico"

    # Start with loading screen
    window = webview.create_window(
        title="SecureVector",
        url=str(loading_html) if loading_html.exists() else f"http://{host}:{port}",
        width=1200,
        height=800,
        min_size=(800, 600),
        text_select=True,
    )

    # Start server in background
    server_ready = threading.Event()
    server_thread = threading.Thread(
        target=start_server,
        args=(host, port, server_ready),
        daemon=True,
    )
    server_thread.start()

    def on_loaded():
        """Called when webview is ready."""
        # Wait for server to be ready
        server_ready.wait(timeout=10)
        time.sleep(0.3)  # Extra buffer for server startup

        # Navigate to the main app
        window.load_url(f"http://{host}:{port}")

    # Start webview (blocking)
    webview.start(on_loaded, debug=debug)


def run_web(host: str, port: int) -> None:
    """Run in web-only mode (no desktop window)."""
    import uvicorn
    from securevector.app.server.app import create_app

    print(f"\n  SecureVector Local Threat Monitor v{__version__}")
    print(f"  ─────────────────────────────────────────")
    print(f"  Web UI:  http://{host}:{port}")
    print(f"  API:     http://{host}:{port}/docs")
    print(f"\n  Press Ctrl+C to stop\n")

    app = create_app(host=host, port=port)
    uvicorn.run(app, host=host, port=port, log_level="info")


def run_proxy(platform: str, proxy_port: int, target_port: int, securevector_port: int, verbose: bool = False, mode: str = "analyze") -> None:
    """Run SecureVector proxy only (no web server)."""
    import asyncio

    block_threats = (mode == "block")

    if platform == "openclaw":
        try:
            from securevector.integrations.openclaw_proxy import SecureVectorProxy
        except ImportError:
            print("Error: Missing dependencies. Install with: pip install websockets httpx")
            sys.exit(1)

        proxy = SecureVectorProxy(
            proxy_port=proxy_port,
            openclaw_host="127.0.0.1",
            openclaw_port=target_port,
            securevector_host="127.0.0.1",
            securevector_port=securevector_port,
            verbose=verbose,
            block_threats=block_threats,
        )

        try:
            asyncio.run(proxy.run())
        except KeyboardInterrupt:
            print("\n[proxy] Shutting down...")
    else:
        print(f"Error: Unknown platform '{platform}'. Supported: openclaw")
        sys.exit(1)


def run_web_with_proxy(host: str, port: int, platform: str, proxy_port: int, target_port: int, verbose: bool = False, mode: str = "analyze") -> None:
    """Run web server and proxy together."""
    import asyncio
    import uvicorn
    from securevector.app.server.app import create_app

    block_threats = (mode == "block")
    mode_label = "BLOCK" if block_threats else "ANALYZE"

    try:
        from securevector.integrations.openclaw_proxy import SecureVectorProxy
    except ImportError:
        print("Error: Missing dependencies. Install with: pip install websockets httpx")
        sys.exit(1)

    print(f"\n  SecureVector Local Threat Monitor v{__version__}")
    print(f"  ─────────────────────────────────────────")
    print(f"  Web UI:     http://{host}:{port}")
    print(f"  API:        http://{host}:{port}/docs")
    print(f"  Proxy:      ws://127.0.0.1:{proxy_port} → OpenClaw ({target_port})")
    print(f"  Mode:       {mode_label} {'(threats will be blocked)' if block_threats else '(threats logged only)'}")
    if verbose:
        print(f"  Verbose:    ON (logging all messages)")
    print(f"\n  Press Ctrl+C to stop\n")

    app = create_app(host=host, port=port)

    # Run both uvicorn and proxy
    async def run_both():
        proxy = SecureVectorProxy(
            proxy_port=proxy_port,
            openclaw_host="127.0.0.1",
            openclaw_port=target_port,
            securevector_host="127.0.0.1",
            securevector_port=port,
            verbose=verbose,
            block_threats=block_threats,
        )

        config = uvicorn.Config(app, host=host, port=port, log_level="warning")
        server = uvicorn.Server(config)

        await asyncio.gather(
            server.serve(),
            proxy.run(),
        )

    try:
        asyncio.run(run_both())
    except KeyboardInterrupt:
        print("\n  Shutting down...")


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="SecureVector Local Threat Monitor Desktop Application",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8741,
        help="API server port (default: 8741)",
    )
    parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="API server host (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--web",
        action="store_true",
        help="Run in web browser mode (no desktop window)",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging",
    )
    parser.add_argument(
        "--version",
        action="store_true",
        help="Show version and exit",
    )
    parser.add_argument(
        "--proxy",
        type=str,
        choices=["openclaw"],
        help="Start proxy for agent platform (e.g., openclaw)",
    )
    parser.add_argument(
        "--proxy-port",
        type=int,
        default=18789,
        help="Proxy listen port (default: 18789 - OpenClaw's default)",
    )
    parser.add_argument(
        "--target-port",
        type=int,
        default=18790,
        help="Target platform port (default: 18790 - run OpenClaw with --port 18790)",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Log all messages passing through proxy",
    )
    parser.add_argument(
        "--mode",
        type=str,
        choices=["analyze", "block"],
        default="analyze",
        help="Proxy mode: analyze (log only, default) or block (stop threats)",
    )

    args = parser.parse_args()

    if args.version:
        print(f"SecureVector Local Threat Monitor v{__version__}")
        sys.exit(0)

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)
        logger.debug("Debug mode enabled")

    # Proxy mode
    if args.proxy:
        if args.web:
            # Run both web server and proxy together
            run_web_with_proxy(args.host, args.port, args.proxy, args.proxy_port, args.target_port, args.verbose, args.mode)
            return
        else:
            # Run proxy only
            run_proxy(args.proxy, args.proxy_port, args.target_port, args.port, args.verbose, args.mode)
            return

    # Check dependencies
    try:
        check_app_dependencies()
    except AppDependencyError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    # Initialize database before starting
    import asyncio
    from securevector.app.database.connection import init_database
    from securevector.app.database.migrations import init_database_schema
    from securevector.app.utils.platform import ensure_app_directories

    # Ensure directories exist
    ensure_app_directories()

    # Initialize database
    db = asyncio.run(init_database())
    asyncio.run(init_database_schema(db))

    logger.info(f"Starting SecureVector on {args.host}:{args.port}")

    if args.web:
        run_web(args.host, args.port)
    else:
        run_desktop(args.host, args.port, args.debug)


if __name__ == "__main__":
    main()
