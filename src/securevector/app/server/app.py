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

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

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

    yield
    logger.info("API server shutting down...")


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

    # Register route modules
    from securevector.app.server.routes import (
        analyze,
        rules,
        cloud_settings,
        threat_analytics,
        threat_intel,
        llm,
        proxy,
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

        # Serve index.html at root
        @app.get("/", include_in_schema=False)
        async def serve_index():
            index_path = WEB_ASSETS_PATH / "index.html"
            if index_path.exists():
                return FileResponse(str(index_path))
            return {"error": "Web UI not found"}

        # Client-side routing - serve index.html for all page routes
        @app.get("/{page}", include_in_schema=False)
        async def serve_page(page: str):
            # Only handle known page routes, let other routes pass through
            valid_pages = [
                "dashboard", "threats", "rules", "proxy", "settings",
                # Integration pages
                "proxy-langchain", "proxy-langgraph", "proxy-crewai",
                "proxy-n8n", "proxy-ollama", "proxy-openclaw"
            ]
            if page in valid_pages:
                index_path = WEB_ASSETS_PATH / "index.html"
                if index_path.exists():
                    return FileResponse(str(index_path))
            return {"error": "Page not found"}

        logger.info(f"Web UI mounted from {WEB_ASSETS_PATH}")

    logger.info("FastAPI application created")
    return app
