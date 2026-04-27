"""
FastAPI application for the SecureVector local API server.

Provides REST API endpoints for:
- Threat analysis
- Threat intel queries
- Rules management
- Statistics
- Settings
- Static web UI files
"""

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from securevector.app import __version__, __app_name__

logger = logging.getLogger(__name__)

# Path to web assets
WEB_ASSETS_PATH = Path(__file__).parent.parent / "assets" / "web"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """
    Application lifespan manager.

    Handles startup and shutdown events, including database initialization.
    """
    logger.info("API server starting up...")

    # Initialize database and run migrations
    from securevector.app.database.connection import get_database
    from securevector.app.database.migrations import init_database_schema

    db = get_database()
    await db.connect()
    await init_database_schema(db)
    logger.info("Database initialized")

    # Apply svconfig.yml config (creates default if missing)
    from securevector.app.utils.config_file import apply_config_to_db, load_config
    await apply_config_to_db(db)

    # Auto-start proxy if configured in svconfig.yml
    # For OpenClaw/ClawdBot: proxy only starts when block_mode is enabled
    # (plugin-only mode handles monitoring without proxy overhead).
    # For other integrations (langchain, crewai, ollama): proxy starts as before.
    try:
        import os as _os
        _cfg = load_config()
        _proxy_cfg = _cfg.get("proxy", {})
        _proxy_mode = _proxy_cfg.get("mode", "")
        _integration = _proxy_cfg.get("integration", "openclaw")
        _security_cfg = _cfg.get("security", {})
        _block_mode = bool(_security_cfg.get("block_mode", False))

        if _proxy_mode in ("multi-provider", "single"):
            _needs_proxy = True
            # OpenClaw/ClawdBot: plugin handles monitoring (threat scanning,
            # cost tracking, context injection). Proxy handles blocking
            # (tool stripping, threat blocking) when block_mode is enabled.
            if _integration in ("openclaw", "clawdbot"):
                _needs_proxy = _block_mode
                if not _block_mode:
                    logger.info(
                        "[svconfig] OpenClaw integration in monitor mode — "
                        "plugin handles monitoring, proxy not started. "
                        "Enable block_mode in svconfig.yml to start the proxy for active blocking."
                    )

            if _needs_proxy:
                from securevector.app.server.routes.proxy import auto_start_from_config
                # Use SV_PROXY_PORT (set by main.py from --port + 1) rather than the
                # svconfig default of 8742, so the proxy respects the --port flag.
                _proxy_port = int(_os.environ.get('SV_PROXY_PORT', _proxy_cfg.get("port", 8742)))
                auto_start_from_config(
                    integration=_integration,
                    mode=_proxy_mode,
                    host=_proxy_cfg.get("host", "127.0.0.1"),
                    port=_proxy_port,
                    provider=_proxy_cfg.get("provider") or None,
                )
    except Exception as _e:
        logger.warning(f"Could not auto-start proxy from svconfig.yml: {_e}")

    # Start the external SIEM forwarder. Runs unconditionally —
    # customers without SecureVector Cloud still use SIEM export to
    # their own Splunk / Datadog / OTLP / webhook destinations.
    try:
        from securevector.app.services.external_forwarder import start_external_forwarder
        await start_external_forwarder()
    except Exception as _e:
        logger.warning(f"Could not start external_forwarder: {_e}")

    yield
    logger.info("API server shutting down...")

    try:
        from securevector.app.services.external_forwarder import stop_external_forwarder
        await stop_external_forwarder()
    except Exception as _e:
        logger.warning(f"Could not stop external_forwarder cleanly: {_e}")


def create_app(host: str = "127.0.0.1", port: int = 8741) -> FastAPI:
    """
    Create and configure the FastAPI application.

    Args:
        host: Server host address (used for CORS configuration).
        port: Server port (used for CORS configuration).

    Returns:
        Configured FastAPI application.
    """
    app = FastAPI(
        title="SecureVector Local Threat Monitor API",
        description=(
            "Local API for the SecureVector Threat Monitor Desktop Application. "
            "Provides threat analysis for autonomous AI agents running locally."
        ),
        version=__version__,
        docs_url="/docs",
        redoc_url="/redoc",
        lifespan=lifespan,
    )

    # Build allowed origins based on configured host/port
    # Restrict to localhost only for security (prevents malicious websites from accessing API)
    allowed_origins = [
        f"http://127.0.0.1:{port}",
        f"http://localhost:{port}",
    ]
    # If host is 0.0.0.0, still only allow localhost origins for CORS
    # (the API will be network-accessible but CORS blocks cross-origin browser requests)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Content-Type", "X-Api-Key"],
    )

    # SPA fallback — serve index.html for any 404 on a GET request that isn't an API call
    @app.exception_handler(404)
    async def spa_fallback(request: Request, exc):
        path = request.url.path
        if request.method == "GET" and not path.startswith("/api") and not path.startswith("/docs") and not path.startswith("/redoc"):
            index_path = WEB_ASSETS_PATH / "index.html"
            if index_path.exists():
                return FileResponse(str(index_path))
        return JSONResponse({"error": "Not found"}, status_code=404)

    # Health check endpoint
    @app.get("/health", tags=["System"])
    async def health_check():
        """Check server and database health."""
        from securevector.app.database.connection import get_database

        try:
            db = get_database()
            db_health = await db.health_check()
        except Exception as e:
            logger.exception("Database health check failed")
            db_health = {
                "connected": False,
                "error": "Database health check failed",
            }

        status = "healthy" if db_health.get("connected") else "degraded"

        return {
            "status": status,
            "version": __version__,
            "database": db_health,
            "rules_loaded": {
                "community": 0,  # TODO: Get actual count
                "custom": 0,
            },
        }

    # Device identity — used by the audit UI to display which machine
    # the chain belongs to. Returns the stable per-device ID derived
    # from the OS machine identifier (hashed + namespaced — raw OS
    # UUID is never transmitted).
    @app.get("/api/system/device-id", tags=["System"])
    async def get_device():
        from securevector.app.utils.device_id import get_device_id
        return {"device_id": get_device_id()}

    # Register route modules
    from securevector.app.server.routes import (
        analyze,
        rules,
        cloud_settings,
        threat_analytics,
        threat_intel,
        llm,
        proxy,
        tool_permissions,
        costs,
        hooks,
        skill_scans,
        skill_permissions,
        siem_forwarders,
    )

    # Quick analysis endpoint (uses X-Api-Key for cloud)
    app.include_router(analyze.router, prefix="", tags=["Analysis"])

    # Primary API - mirrors cloud API structure
    app.include_router(threat_analytics.router, prefix="/api", tags=["Threat Analytics"])
    app.include_router(threat_intel.router, prefix="/api", tags=["Threat Intel"])
    app.include_router(rules.router, prefix="/api", tags=["Rules"])
    app.include_router(cloud_settings.router, prefix="/api", tags=["Cloud Settings"])
    app.include_router(llm.router, prefix="/api", tags=["LLM Review"])
    app.include_router(proxy.router, prefix="/api", tags=["Proxy"])
    app.include_router(tool_permissions.router, prefix="/api", tags=["Tool Permissions"])
    app.include_router(costs.router, prefix="/api", tags=["Costs"])
    app.include_router(hooks.router, prefix="/api", tags=["Hooks"])
    app.include_router(skill_scans.router, prefix="/api", tags=["Skill Scanner"])
    app.include_router(skill_permissions.router, prefix="/api", tags=["Skill Permissions"])
    app.include_router(siem_forwarders.router, prefix="/api", tags=["SIEM Forwarders"])
    # Bundle 0.4 — Agent Replay Timeline. Merged threat / tool-audit / cost feed.
    from securevector.app.server.routes import replay
    app.include_router(replay.router, prefix="/api", tags=["Replay"])

    # Serve web UI static files
    if WEB_ASSETS_PATH.exists():
        # Mount static directories
        css_path = WEB_ASSETS_PATH / "css"
        js_path = WEB_ASSETS_PATH / "js"
        icons_path = WEB_ASSETS_PATH / "icons"

        if css_path.exists():
            app.mount("/css", StaticFiles(directory=str(css_path)), name="css")
        if js_path.exists():
            app.mount("/js", StaticFiles(directory=str(js_path)), name="js")
        if icons_path.exists():
            app.mount("/icons", StaticFiles(directory=str(icons_path)), name="icons")

        # Mount images directory
        images_path = WEB_ASSETS_PATH / "images"
        if images_path.exists():
            app.mount("/images", StaticFiles(directory=str(images_path)), name="images")

        # Mount SIEM dashboard templates (Sentinel workbook, Splunk XML).
        # Ship with the package; served in-process so the Copy / Download
        # modal on the SIEM Forwarder page works offline and doesn't
        # depend on a public GitHub URL.
        siem_templates_path = WEB_ASSETS_PATH / "siem-templates"
        if siem_templates_path.exists():
            app.mount("/siem-templates", StaticFiles(directory=str(siem_templates_path)), name="siem-templates")

        _NO_CACHE_HEADERS = {
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
        }

        # Serve index.html at root
        @app.get("/", include_in_schema=False)
        async def serve_index():
            index_path = WEB_ASSETS_PATH / "index.html"
            if index_path.exists():
                return FileResponse(str(index_path), headers=_NO_CACHE_HEADERS)
            return {"error": "Web UI not found"}

        # Client-side routing catch-all — serve index.html for any unmatched path
        # FastAPI matches registered API routes first; this only fires for SPA page routes
        @app.get("/{path:path}", include_in_schema=False)
        async def serve_spa(path: str):
            index_path = WEB_ASSETS_PATH / "index.html"
            if index_path.exists():
                return FileResponse(str(index_path), headers=_NO_CACHE_HEADERS)
            return {"error": "Web UI not found"}

        logger.info(f"Web UI mounted from {WEB_ASSETS_PATH}")

    logger.info("FastAPI application created")
    return app
