"""
FastAPI application for the SecureVector local API server.

Provides REST API endpoints for:
- Threat analysis
- Threat intel queries
- Rules management
- Statistics
- Settings
"""

import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from securevector.app import __version__, __app_name__

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """
    Application lifespan manager.

    Handles startup and shutdown events.
    """
    logger.info("API server starting up...")
    yield
    logger.info("API server shutting down...")


def create_app() -> FastAPI:
    """
    Create and configure the FastAPI application.

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

    # CORS middleware for local development
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # Local only, so permissive
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
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
    )

    # Quick analysis endpoint (uses X-Api-Key for cloud)
    app.include_router(analyze.router, prefix="", tags=["Analysis"])

    # Primary API - mirrors cloud API structure
    app.include_router(threat_analytics.router, prefix="/api", tags=["Threat Analytics"])
    app.include_router(rules.router, prefix="/api/v1", tags=["Rules"])
    app.include_router(cloud_settings.router, prefix="/api/v1", tags=["Cloud Settings"])

    logger.info("FastAPI application created")
    return app
