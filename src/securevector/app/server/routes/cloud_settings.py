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


class GeneralSettingsResponse(BaseModel):
    """General app settings response."""

    scan_llm_responses: bool = True
    store_text_content: bool = True
    retention_days: int = 30
    block_threats: bool = False
    tool_permissions_enabled: bool = True
    config_file: Optional[str] = None
    config_updated: bool = False
    proxy_action: Optional[str] = None


class GeneralSettingsUpdate(BaseModel):
    """General app settings update request."""

    scan_llm_responses: Optional[bool] = None
    store_text_content: Optional[bool] = None
    retention_days: Optional[int] = None
    block_threats: Optional[bool] = None
    tool_permissions_enabled: Optional[bool] = None


class CloudSettingsResponse(BaseModel):
    """Cloud mode settings response."""

    credentials_configured: bool
    cloud_mode_enabled: bool
    user_email: Optional[str] = None
    connected_at: Optional[str] = None


class CredentialsRequest(BaseModel):
    """Request to configure credentials."""

    api_key: str = Field(..., min_length=1, description="API Key from app.securevector.io")
    bearer_token: Optional[str] = Field(
        None, description="Bearer token (optional, defaults to api_key)"
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


@router.get("/settings", response_model=GeneralSettingsResponse)
async def get_general_settings() -> GeneralSettingsResponse:
    """
    Get general app settings.

    Returns settings for output scanning, text storage, etc.
    """
    try:
        db = get_database()
        settings_repo = SettingsRepository(db)
        settings = await settings_repo.get()

        return GeneralSettingsResponse(
            scan_llm_responses=settings.scan_llm_responses,
            store_text_content=settings.store_text_content,
            retention_days=settings.retention_days,
            block_threats=settings.block_threats,
            tool_permissions_enabled=settings.tool_permissions_enabled,
        )

    except Exception as e:
        logger.error(f"Failed to get general settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/settings", response_model=GeneralSettingsResponse)
async def update_general_settings(request: GeneralSettingsUpdate) -> GeneralSettingsResponse:
    """
    Update general app settings.
    """
    try:
        db = get_database()
        settings_repo = SettingsRepository(db)

        # Build update dict from non-None values
        updates = {}
        if request.scan_llm_responses is not None:
            updates["scan_llm_responses"] = request.scan_llm_responses
        if request.store_text_content is not None:
            updates["store_text_content"] = request.store_text_content
        if request.retention_days is not None:
            updates["retention_days"] = request.retention_days
        if request.block_threats is not None:
            updates["block_threats"] = request.block_threats
        if request.tool_permissions_enabled is not None:
            updates["tool_permissions_enabled"] = request.tool_permissions_enabled

        if updates:
            await settings_repo.update(**updates)

        settings = await settings_repo.get()

        # Sync to securevector.yml
        config_path = None
        config_updated = False
        if updates:
            try:
                from securevector.app.utils.config_file import save_config, get_config_path
                from securevector.app.database.repositories.costs import CostsRepository
                costs_repo = CostsRepository(db)
                budget_data = await costs_repo.get_global_budget() or {}
                budget_action = budget_data.get("budget_action", "warn")
                config_path = save_config(
                    block_mode=settings.block_threats,
                    output_scan=settings.scan_llm_responses,
                    budget_warn=(budget_action == "warn"),
                    budget_block=(budget_action == "block"),
                    budget_daily_limit=budget_data.get("daily_budget_usd"),
                    tools_enforcement=settings.tool_permissions_enabled,
                )
                config_updated = True
            except Exception as ce:
                logger.warning(f"Could not update securevector.yml: {ce}")

        # OpenClaw: auto-start/stop proxy when block_mode is toggled
        proxy_action = None
        if "block_threats" in updates:
            try:
                from securevector.app.utils.config_file import load_config
                cfg = load_config()
                proxy_cfg = cfg.get("proxy", {})
                integration = proxy_cfg.get("integration", "openclaw")

                if integration in ("openclaw", "clawdbot"):
                    import securevector.app.server.routes.proxy as _proxy_mod

                    if settings.block_threats:
                        # block_mode ON → start proxy + patch pi-ai files
                        proxy_mode = proxy_cfg.get("mode", "multi-provider")
                        proxy_host = proxy_cfg.get("host", "127.0.0.1")
                        proxy_port = proxy_cfg.get("port", 8742)
                        import os as _os
                        proxy_port = int(_os.environ.get("SV_PROXY_PORT", proxy_port))

                        # Patch pi-ai files before starting proxy
                        try:
                            from securevector.app.main import _auto_setup_proxy_multi, _auto_setup_proxy_if_needed
                            if proxy_mode == "multi-provider":
                                _auto_setup_proxy_multi()
                            else:
                                _auto_setup_proxy_if_needed(integration)
                        except Exception as pe:
                            logger.warning(f"Could not patch pi-ai files: {pe}")

                        started = _proxy_mod.auto_start_from_config(
                            integration=integration,
                            mode=proxy_mode,
                            host=proxy_host,
                            port=proxy_port,
                            provider=proxy_cfg.get("provider") or None,
                        )
                        proxy_action = "started" if started else "start_failed"
                    else:
                        # block_mode OFF → stop proxy + revert pi-ai patches
                        if _proxy_mod._llm_proxy_process is not None or _proxy_mod._proxy_running_in_process:
                            stop_result = await _proxy_mod.stop_proxy()
                            proxy_action = stop_result.get("status", "stopped")
                        else:
                            # Proxy not running, but still revert patches in case they linger
                            try:
                                import asyncio
                                from securevector.app.main import revert_proxy as _do_revert
                                loop = asyncio.get_event_loop()
                                await loop.run_in_executor(None, _do_revert)
                                proxy_action = "patches_reverted"
                            except Exception:
                                pass
            except Exception as e:
                logger.warning(f"Could not auto-toggle proxy for block_mode: {e}")

        response = GeneralSettingsResponse(
            scan_llm_responses=settings.scan_llm_responses,
            store_text_content=settings.store_text_content,
            retention_days=settings.retention_days,
            block_threats=settings.block_threats,
            tool_permissions_enabled=settings.tool_permissions_enabled,
            config_file=str(config_path) if config_path else None,
            config_updated=config_updated,
        )
        if proxy_action:
            response.proxy_action = proxy_action
        return response

    except Exception as e:
        logger.error(f"Failed to update general settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


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
    Configure API Key from app.securevector.io.

    Saves to OS keychain (or encrypted file fallback) and enables cloud mode.
    """
    try:
        # Save API key to credential store
        if not save_credentials(request.api_key):
            raise HTTPException(
                status_code=500,
                detail="Failed to save API key to credential store",
            )

        # Enable cloud mode in database
        db = get_database()
        settings_repo = SettingsRepository(db)
        await settings_repo.update(
            cloud_connected_at=datetime.utcnow().isoformat(),
            cloud_mode_enabled=True,
        )

        logger.info("API key saved, cloud mode enabled")

        return CredentialsResponse(
            valid=True,
            message="API key saved. Cloud mode enabled.",
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
