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
                "source": tool.get("source", "official"),
                "mcp_server": tool.get("mcp_server", ""),
                "popular": tool.get("popular", False),
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


# ==================== Custom Tools ====================


class CreateCustomToolRequest(BaseModel):
    """Request to create a custom tool."""

    tool_id: str = Field(..., min_length=1, max_length=100)
    name: str = Field(..., min_length=1, max_length=100)
    risk: str = Field(default="write", pattern="^(read|write|delete|admin)$")
    default_permission: str = Field(default="block", pattern="^(block|allow)$")
    description: str = Field(default="", max_length=200)



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


# ==================== Tool Call Audit Log ====================


class AuditLogRequest(BaseModel):
    """Single tool call decision to record in the audit log."""

    tool_id: str
    function_name: str
    action: str = Field(..., pattern="^(block|allow|log_only)$")
    risk: Optional[str] = None
    reason: Optional[str] = None
    is_essential: bool = False
    args_preview: Optional[str] = None


@router.post("/tool-permissions/call-audit")
async def record_call_audit(request: AuditLogRequest):
    """Record a tool call decision (block/allow/log_only) in the audit log.

    Called by the proxy after every tool permission evaluation.
    """
    try:
        db = get_database()
        repo = CustomToolsRepository(db)
        await repo.log_tool_call_audit(
            tool_id=request.tool_id,
            function_name=request.function_name,
            action=request.action,
            risk=request.risk,
            reason=request.reason,
            is_essential=request.is_essential,
            args_preview=request.args_preview,
        )
        return {"ok": True}

    except Exception as e:
        logger.error(f"Failed to record call audit: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/tool-permissions/call-audit")
async def get_call_audit(
    limit: int = 50,
    offset: int = 0,
    action: Optional[str] = None,
):
    """Return recent tool call audit entries, newest first.

    Query params:
      - limit: page size (default 50, max 200)
      - offset: skip N rows for pagination
      - action: filter to "block" | "allow" | "log_only"
    """
    try:
        limit = min(limit, 200)
        db = get_database()
        repo = CustomToolsRepository(db)
        entries, total = await repo.get_audit_log(limit=limit, offset=offset, action_filter=action)
        return {"entries": entries, "total": total}

    except Exception as e:
        logger.error(f"Failed to fetch call audit: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/tool-permissions/call-audit/daily")
async def get_call_audit_daily(days: int = 7):
    """Return per-day blocked/allowed/logged counts for the last N days."""
    try:
        days = min(days, 30)
        db = get_database()
        repo = CustomToolsRepository(db)
        rows = await repo.get_audit_daily_stats(days=days)
        return {"days": rows, "total_days": days}
    except Exception as e:
        logger.error(f"Failed to fetch daily audit stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/tool-permissions/call-audit/stats")
async def get_call_audit_stats():
    """Return aggregate block/allow/log_only counts for the audit log."""
    try:
        db = get_database()
        repo = CustomToolsRepository(db)
        stats = await repo.get_audit_stats()
        return stats

    except Exception as e:
        logger.error(f"Failed to fetch audit stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class AuditDeleteRequest(BaseModel):
    ids: list[int] = Field(..., description="List of audit entry IDs to delete")


@router.delete("/tool-permissions/call-audit")
async def delete_call_audit_entries(body: AuditDeleteRequest):
    """Delete tool call audit entries by ID."""
    try:
        db = get_database()
        repo = CustomToolsRepository(db)
        deleted = await repo.delete_audit_entries(body.ids)
        return {"deleted": deleted}

    except Exception as e:
        logger.error(f"Failed to delete audit entries: {e}")
        raise HTTPException(status_code=500, detail=str(e))


