"""
Tool permissions API endpoints.

GET /api/tool-permissions/essential - List all essential tools with overrides
GET /api/tool-permissions/overrides - Get all user overrides
PUT /api/tool-permissions/overrides/:tool_id - Upsert an override
DELETE /api/tool-permissions/overrides/:tool_id - Delete an override
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.tool_permissions import (
    ToolPermissionsRepository,
)
from securevector.app.database.repositories.custom_tools import (
    CustomToolsRepository,
)
from securevector.core.tool_permissions.engine import (
    load_essential_registry,
    get_risk_score,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# Cache registry in module scope (loaded once)
_essential_registry: Optional[dict] = None


def _get_registry() -> dict:
    global _essential_registry
    if _essential_registry is None:
        _essential_registry = load_essential_registry()
    return _essential_registry


class OverrideRequest(BaseModel):
    """Request to set an override."""

    action: str = Field(..., pattern="^(block|allow)$")


class OverrideResponse(BaseModel):
    """Single override response."""

    tool_id: str
    action: str
    updated_at: str


class EssentialToolResponse(BaseModel):
    """Single essential tool with current effective action."""

    tool_id: str
    name: str
    category: str
    risk: str
    risk_score: int
    default_permission: str
    description: str
    effective_action: str  # after applying override
    has_override: bool


class UpdateRateLimitRequest(BaseModel):
    """Request to update a tool's rate limit."""

    max_calls: Optional[int] = Field(default=None, ge=1, le=10000)
    window_seconds: Optional[int] = Field(default=None, ge=60, le=86400)


@router.get("/tool-permissions/essential")
async def list_essential_tools():
    """List all essential tools with their effective permissions."""
    try:
        registry = _get_registry()
        db = get_database()
        repo = ToolPermissionsRepository(db)
        overrides_list = await repo.get_all_overrides()
        overrides_map = {o["tool_id"]: o for o in overrides_list}

        tools = []
        for tool_id, tool in registry.items():
            override = overrides_map.get(tool_id)
            override_action = override["action"] if override else None
            default_perm = tool.get("default_permission", "block")
            effective = override_action if override_action else default_perm

            # Recommended rate limits from YAML registry
            yaml_rl = tool.get("rate_limit", {}) or {}

            tools.append({
                "tool_id": tool_id,
                "name": tool.get("name", tool_id),
                "provider": tool.get("provider", ""),
                "category": tool.get("category", "unknown"),
                "risk": tool.get("risk", "write"),
                "risk_score": get_risk_score(tool.get("risk")),
                "default_permission": default_perm,
                "description": tool.get("description", ""),
                "effective_action": effective,
                "has_override": override_action is not None,
                "rate_limit_max_calls": override.get("rate_limit_max_calls") if override else None,
                "rate_limit_window_seconds": override.get("rate_limit_window_seconds") if override else None,
                "recommended_max_calls": yaml_rl.get("max_calls"),
                "recommended_window_seconds": yaml_rl.get("window_seconds"),
                "rate_limit_note": yaml_rl.get("note", ""),
            })

        # Sort by category, then by name
        tools.sort(key=lambda t: (t["category"], t["name"]))

        return {"tools": tools, "total": len(tools)}

    except Exception as e:
        logger.error(f"Failed to list essential tools: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/tool-permissions/overrides")
async def get_overrides():
    """Get all user overrides."""
    try:
        db = get_database()
        repo = ToolPermissionsRepository(db)
        overrides = await repo.get_all_overrides()
        return {"overrides": overrides, "total": len(overrides)}

    except Exception as e:
        logger.error(f"Failed to get overrides: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/tool-permissions/overrides/{tool_id}")
async def upsert_override(tool_id: str, request: OverrideRequest):
    """Set or update an override for an essential tool."""
    try:
        # Validate tool_id exists in registry
        registry = _get_registry()
        if tool_id not in registry:
            raise HTTPException(
                status_code=404,
                detail=f"Unknown essential tool: {tool_id}",
            )

        db = get_database()
        repo = ToolPermissionsRepository(db)
        result = await repo.upsert_override(tool_id, request.action)

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to upsert override: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/tool-permissions/overrides/{tool_id}")
async def delete_override(tool_id: str):
    """Delete an override, reverting to registry default."""
    try:
        db = get_database()
        repo = ToolPermissionsRepository(db)
        await repo.delete_override(tool_id)
        return {"message": f"Override for {tool_id} deleted"}

    except Exception as e:
        logger.error(f"Failed to delete override: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/tool-permissions/overrides/{tool_id}/rate-limit")
async def update_essential_tool_rate_limit(
    tool_id: str, request: UpdateRateLimitRequest
):
    """Update rate limit for an essential tool. Set both to null to remove."""
    try:
        registry = _get_registry()
        if tool_id not in registry:
            raise HTTPException(
                status_code=404,
                detail=f"Unknown essential tool: {tool_id}",
            )

        db = get_database()
        repo = ToolPermissionsRepository(db)
        result = await repo.upsert_rate_limit(
            tool_id, request.max_calls, request.window_seconds
        )
        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update essential tool rate limit: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/tool-permissions/overrides/{tool_id}/rate-limit")
async def get_essential_tool_rate_limit_status(tool_id: str):
    """Get current rate limit status for an essential tool."""
    try:
        db = get_database()
        repo = ToolPermissionsRepository(db)
        override = await repo.get_override(tool_id)

        max_calls = override.get("rate_limit_max_calls") if override else None
        window_secs = override.get("rate_limit_window_seconds") if override else None

        if not max_calls or not window_secs:
            return {
                "tool_id": tool_id,
                "rate_limited": False,
                "current_count": 0,
                "max_calls": None,
                "window_seconds": None,
            }

        # Reuse custom tools repo for call log (same table)
        custom_repo = CustomToolsRepository(db)
        current_count = await custom_repo.count_recent_calls(tool_id, window_secs)

        return {
            "tool_id": tool_id,
            "rate_limited": current_count >= max_calls,
            "current_count": current_count,
            "max_calls": max_calls,
            "window_seconds": window_secs,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get essential tool rate limit status: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/tool-permissions/overrides/{tool_id}/log-call")
async def log_essential_tool_call(tool_id: str):
    """Log an essential tool call for rate limiting (called by proxy)."""
    try:
        db = get_database()
        repo = CustomToolsRepository(db)
        await repo.log_tool_call(tool_id)
        return {"logged": True}

    except Exception as e:
        logger.error(f"Failed to log essential tool call: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== Custom Tools ====================


class CreateCustomToolRequest(BaseModel):
    """Request to create a custom tool."""

    tool_id: str = Field(..., min_length=1, max_length=100)
    name: str = Field(..., min_length=1, max_length=100)
    risk: str = Field(default="write", pattern="^(read|write|delete|admin)$")
    default_permission: str = Field(default="block", pattern="^(block|allow)$")
    description: str = Field(default="", max_length=200)
    rate_limit_max_calls: Optional[int] = Field(default=None, ge=1, le=10000)
    rate_limit_window_seconds: Optional[int] = Field(default=None, ge=60, le=86400)



class UpdateCustomToolPermissionRequest(BaseModel):
    """Request to update a custom tool's permission."""

    default_permission: str = Field(..., pattern="^(block|allow)$")


@router.get("/tool-permissions/custom")
async def list_custom_tools():
    """List all custom tools."""
    try:
        db = get_database()
        repo = CustomToolsRepository(db)
        tools = await repo.get_all_custom_tools()

        # Add risk_score to each tool
        for tool in tools:
            tool["risk_score"] = get_risk_score(tool.get("risk"))

        return {"tools": tools, "total": len(tools)}

    except Exception as e:
        logger.error(f"Failed to list custom tools: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/tool-permissions/custom")
async def create_custom_tool(request: CreateCustomToolRequest):
    """Create a new custom tool."""
    try:
        db = get_database()
        repo = CustomToolsRepository(db)

        # Check for duplicate
        existing = await repo.get_custom_tool(request.tool_id)
        if existing:
            raise HTTPException(
                status_code=409,
                detail=f"Custom tool '{request.tool_id}' already exists",
            )

        # Check it doesn't collide with essential tools
        registry = _get_registry()
        if request.tool_id in registry:
            raise HTTPException(
                status_code=409,
                detail=f"'{request.tool_id}' conflicts with an essential tool",
            )

        tool = await repo.create_custom_tool(
            tool_id=request.tool_id,
            name=request.name,
            risk=request.risk,
            default_permission=request.default_permission,
            description=request.description,
            rate_limit_max_calls=request.rate_limit_max_calls,
            rate_limit_window_seconds=request.rate_limit_window_seconds,
        )

        tool["risk_score"] = get_risk_score(tool.get("risk"))
        return tool

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to create custom tool: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/tool-permissions/custom/{tool_id}")
async def update_custom_tool_permission(
    tool_id: str, request: UpdateCustomToolPermissionRequest
):
    """Update a custom tool's permission (block/allow)."""
    try:
        db = get_database()
        repo = CustomToolsRepository(db)

        existing = await repo.get_custom_tool(tool_id)
        if not existing:
            raise HTTPException(
                status_code=404,
                detail=f"Custom tool '{tool_id}' not found",
            )

        tool = await repo.update_custom_tool_permission(
            tool_id, request.default_permission
        )
        tool["risk_score"] = get_risk_score(tool.get("risk"))
        return tool

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update custom tool: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/tool-permissions/custom/{tool_id}")
async def delete_custom_tool(tool_id: str):
    """Delete a custom tool."""
    try:
        db = get_database()
        repo = CustomToolsRepository(db)

        existing = await repo.get_custom_tool(tool_id)
        if not existing:
            raise HTTPException(
                status_code=404,
                detail=f"Custom tool '{tool_id}' not found",
            )

        await repo.delete_custom_tool(tool_id)
        return {"message": f"Custom tool '{tool_id}' deleted"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete custom tool: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== Rate Limiting ====================


@router.put("/tool-permissions/custom/{tool_id}/rate-limit")
async def update_custom_tool_rate_limit(
    tool_id: str, request: UpdateRateLimitRequest
):
    """Update rate limit config for a custom tool. Set both to null to remove."""
    try:
        db = get_database()
        repo = CustomToolsRepository(db)

        existing = await repo.get_custom_tool(tool_id)
        if not existing:
            raise HTTPException(
                status_code=404,
                detail=f"Custom tool '{tool_id}' not found",
            )

        tool = await repo.update_custom_tool_rate_limit(
            tool_id, request.max_calls, request.window_seconds
        )
        tool["risk_score"] = get_risk_score(tool.get("risk"))
        return tool

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update rate limit: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/tool-permissions/custom/{tool_id}/rate-limit")
async def get_custom_tool_rate_limit_status(tool_id: str):
    """Get current rate limit status (call count within window) for a custom tool."""
    try:
        db = get_database()
        repo = CustomToolsRepository(db)

        tool = await repo.get_custom_tool(tool_id)
        if not tool:
            raise HTTPException(
                status_code=404,
                detail=f"Custom tool '{tool_id}' not found",
            )

        max_calls = tool.get("rate_limit_max_calls")
        window_secs = tool.get("rate_limit_window_seconds")

        if not max_calls or not window_secs:
            return {
                "tool_id": tool_id,
                "rate_limited": False,
                "current_count": 0,
                "max_calls": None,
                "window_seconds": None,
            }

        current_count = await repo.count_recent_calls(tool_id, window_secs)

        return {
            "tool_id": tool_id,
            "rate_limited": current_count >= max_calls,
            "current_count": current_count,
            "max_calls": max_calls,
            "window_seconds": window_secs,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get rate limit status: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/tool-permissions/custom/{tool_id}/log-call")
async def log_tool_call(tool_id: str):
    """Log a tool call for rate limiting purposes (called by proxy)."""
    try:
        db = get_database()
        repo = CustomToolsRepository(db)
        await repo.log_tool_call(tool_id)
        return {"logged": True}

    except Exception as e:
        logger.error(f"Failed to log tool call: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/tool-permissions/cleanup-call-log")
async def cleanup_call_log():
    """Clean up old tool call log entries (housekeeping)."""
    try:
        db = get_database()
        repo = CustomToolsRepository(db)
        await repo.cleanup_old_calls()
        return {"cleaned": True}

    except Exception as e:
        logger.error(f"Failed to cleanup call log: {e}")
        raise HTTPException(status_code=500, detail=str(e))
