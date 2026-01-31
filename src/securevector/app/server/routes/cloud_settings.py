"""
Cloud settings API endpoints.

GET /api/v1/settings/cloud - Get cloud mode configuration
POST /api/v1/settings/cloud/credentials - Configure API key and bearer token
DELETE /api/v1/settings/cloud/credentials - Remove credentials
PUT /api/v1/settings/cloud/mode - Toggle cloud mode
"""

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.settings import SettingsRepository
from securevector.app.services.credentials import (
    save_credentials,
    delete_credentials,
    credentials_configured,
)
from securevector.app.services.cloud_proxy import get_cloud_proxy, CloudProxyError

logger = logging.getLogger(__name__)

router = APIRouter()


class CloudSettingsResponse(BaseModel):
    """Cloud mode settings response."""

    credentials_configured: bool
    cloud_mode_enabled: bool
    user_email: Optional[str] = None
    connected_at: Optional[str] = None


class CredentialsRequest(BaseModel):
    """Request to configure credentials."""

    api_key: str = Field(..., min_length=1, description="API Key from app.securevector.io")
    bearer_token: str = Field(
        ..., min_length=1, description="Bearer token from app.securevector.io"
    )


class CredentialsResponse(BaseModel):
    """Response after configuring credentials."""

    valid: bool
    user_email: Optional[str] = None
    message: str


class CloudModeRequest(BaseModel):
    """Request to toggle cloud mode."""

    enabled: bool


class CloudModeResponse(BaseModel):
    """Response after toggling cloud mode."""

    cloud_mode_enabled: bool
    message: str


class MessageResponse(BaseModel):
    """Simple message response."""

    message: str


@router.get("/settings/cloud", response_model=CloudSettingsResponse)
async def get_cloud_settings() -> CloudSettingsResponse:
    """
    Get cloud mode configuration.

    Returns current cloud connection status and settings.
    """
    try:
        db = get_database()
        settings_repo = SettingsRepository(db)
        settings = await settings_repo.get()

        return CloudSettingsResponse(
            credentials_configured=credentials_configured(),
            cloud_mode_enabled=settings.cloud_mode_enabled,
            user_email=settings.cloud_user_email,
            connected_at=(
                settings.cloud_connected_at.isoformat()
                if settings.cloud_connected_at
                else None
            ),
        )

    except Exception as e:
        logger.error(f"Failed to get cloud settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/settings/cloud/credentials", response_model=CredentialsResponse)
async def configure_credentials(request: CredentialsRequest) -> CredentialsResponse:
    """
    Configure API Key and Bearer Token from app.securevector.io.

    Validates credentials with cloud API before saving.
    """
    try:
        # Validate credentials with cloud API
        proxy = get_cloud_proxy()

        try:
            user_info = await proxy.validate_credentials(request.bearer_token)
        except CloudProxyError as e:
            logger.warning(f"Credential validation failed: {e}")
            return CredentialsResponse(
                valid=False,
                message=f"Failed to validate credentials: {str(e)}",
            )

        if user_info is None:
            return CredentialsResponse(
                valid=False,
                message="Invalid credentials",
            )

        # Save credentials to OS keychain
        if not save_credentials(request.api_key, request.bearer_token):
            raise HTTPException(
                status_code=500,
                detail="Failed to save credentials to OS keychain",
            )

        # Update database with user info
        db = get_database()
        settings_repo = SettingsRepository(db)
        await settings_repo.update(
            cloud_user_email=user_info.get("email"),
            cloud_connected_at=datetime.utcnow().isoformat(),
        )

        logger.info(f"Credentials configured for user: {user_info.get('email')}")

        return CredentialsResponse(
            valid=True,
            user_email=user_info.get("email"),
            message="Credentials validated and saved",
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to configure credentials: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/settings/cloud/credentials", response_model=MessageResponse)
async def remove_credentials() -> MessageResponse:
    """
    Remove credentials and disable cloud mode.
    """
    try:
        # Delete credentials from OS keychain
        delete_credentials()

        # Clear cloud settings in database
        db = get_database()
        settings_repo = SettingsRepository(db)
        await settings_repo.clear_cloud_settings()

        logger.info("Credentials removed, cloud mode disabled")

        return MessageResponse(message="Credentials removed, cloud mode disabled")

    except Exception as e:
        logger.error(f"Failed to remove credentials: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/settings/cloud/mode", response_model=CloudModeResponse)
async def toggle_cloud_mode(request: CloudModeRequest) -> CloudModeResponse:
    """
    Toggle cloud mode on/off.

    Requires credentials to be configured before enabling.
    """
    try:
        # Check if credentials are configured
        if request.enabled and not credentials_configured():
            raise HTTPException(
                status_code=400,
                detail="Configure API Key and Bearer Token before enabling cloud mode",
            )

        # Update database
        db = get_database()
        settings_repo = SettingsRepository(db)
        await settings_repo.update(cloud_mode_enabled=request.enabled)

        message = "Cloud mode enabled" if request.enabled else "Cloud mode disabled"
        logger.info(message)

        return CloudModeResponse(
            cloud_mode_enabled=request.enabled,
            message=message,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to toggle cloud mode: {e}")
        raise HTTPException(status_code=500, detail=str(e))
