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


# Canonical list of Claude Code built-in tools the UI should govern. Mirrors
# the `BUILTIN_TOOLS` Set in
# src/securevector/plugins/claude-code/lib/normalize.js — KEEP THESE TWO IN
# SYNC. Drift is caught by `tests/unit/app/test_tool_permissions_builtins.py`
# which asserts every name in the JS Set has an entry here.
#
# Each tuple is (name, risk, description). The category is uniformly
# `"claude_code"`; default_permission is `"allow"` because built-ins
# are default-allow in the host — cloud rules deny selectively.
CLAUDE_CODE_BUILTINS: list[tuple[str, str, str]] = [
    # File operations
    ("Read",          "read",   "Read file contents."),
    ("Edit",          "write",  "Modify an existing file."),
    ("Write",         "write",  "Write a new file or replace an existing one."),
    ("MultiEdit",     "write",  "Apply multiple edits to a single file atomically."),
    ("NotebookEdit",  "write",  "Modify cells in a Jupyter notebook."),
    ("NotebookRead",  "read",   "Read cells in a Jupyter notebook."),
    # Search / navigation
    ("Glob",          "read",   "Match files by glob pattern."),
    ("Grep",          "read",   "Search file contents by pattern."),
    ("LS",            "read",   "List directory contents."),
    ("LSP",           "read",   "Query language-server protocol metadata."),
    # Shell
    ("Bash",          "admin",  "Execute a shell command."),
    ("PowerShell",    "admin",  "Execute a PowerShell command."),
    # Web
    ("WebFetch",      "read",   "Fetch a URL."),
    ("WebSearch",     "read",   "Run a web search."),
    # Agents / planning
    ("Task",          "admin",  "Dispatch a sub-agent task."),
    ("Agent",         "admin",  "Launch a sub-agent."),
    ("ExitPlanMode",  "read",   "Exit the planning mode."),
    ("EnterPlanMode", "read",   "Enter the planning mode."),
    # Worktrees
    ("EnterWorktree", "write",  "Switch into a git worktree."),
    ("ExitWorktree",  "write",  "Switch out of a git worktree."),
    # Skills / background
    ("Skill",         "admin",  "Execute a registered skill."),
    ("Monitor",       "admin",  "Start a background monitor process."),
    # Todos
    ("TodoWrite",     "write",  "Update the session todo list."),
    ("TodoRead",      "read",   "Read the session todo list."),
]


def _build_tool_response_row(
    tool_id: str,
    tool_meta: dict,
    overrides_map: dict,
    synced_map: dict,
    last_resort_matcher,
) -> dict:
    """Resolve precedence (last_resort > synced > local > default) and
    build the response row. Shared between registry tools and Claude
    Code built-ins so a single source of truth governs the precedence
    chain."""
    override = overrides_map.get(tool_id)
    override_action = override["action"] if override else None
    default_perm = tool_meta.get("default_permission", "block")

    synced_rule = synced_map.get(tool_id)
    last_resort = last_resort_matcher(tool_id)

    if last_resort is not None:
        effective = last_resort.effect  # always 'deny'
        source = "last_resort"
    elif synced_rule is not None:
        effective = synced_rule.effect
        source = "synced"
    elif override_action is not None:
        effective = override_action
        source = "local"
    else:
        effective = default_perm
        source = "default"

    return {
        "tool_id": tool_id,
        "name": tool_meta.get("name", tool_id),
        "provider": tool_meta.get("provider", ""),
        "category": tool_meta.get("category", "unknown"),
        "risk": tool_meta.get("risk", "write"),
        "risk_score": get_risk_score(tool_meta.get("risk")),
        "default_permission": default_perm,
        "description": tool_meta.get("description", ""),
        "effective_action": effective,
        "effective_source": source,
        "has_override": override_action is not None,
        "is_synced": synced_rule is not None,
        "synced_effect": synced_rule.effect if synced_rule else None,
        "synced_source_org": synced_rule.org_name if synced_rule else None,
        "synced_policy_id": synced_rule.policy_id if synced_rule else None,
        "synced_policy_name": synced_rule.policy_name if synced_rule else None,
        "synced_policy_version": synced_rule.policy_version if synced_rule else None,
        "synced_reason": synced_rule.reason if synced_rule else None,
        "is_last_resort": last_resort is not None,
        "last_resort_reason": last_resort.reason if last_resort else None,
        "source": tool_meta.get("source", "official"),
        "mcp_server": tool_meta.get("mcp_server", ""),
        "popular": tool_meta.get("popular", False),
    }


@router.get("/tool-permissions/essential")
async def list_essential_tools():
    """List all essential tools with their effective permissions.

    active-mcp-and-policy-sync: synced rules from cloud bundles layer over
    local user overrides. Precedence (highest first):
      1. last_resort rule (compiled-in, always deny)
      2. synced rule (cloud-pushed via /policy/sync)
      3. local user override
      4. registry default_permission

    Response includes the YAML registry tools AND the Claude Code
    built-ins (Bash, Edit, Read, …) under category "claude_code" so the
    Tool Permissions page surfaces them as governable rows. Built-ins
    flow through the SAME precedence chain — cloud rules with
    ``tool_id="Bash"`` Just Work.
    """
    try:
        registry = _get_registry()
        db = get_database()
        repo = ToolPermissionsRepository(db)
        overrides_list = await repo.get_all_overrides()
        overrides_map = {o["tool_id"]: o for o in overrides_list}

        # Layer cloud-pushed synced rules (active-mcp-and-policy-sync)
        from securevector.app.database.repositories.synced_rules import SyncedRulesRepository
        from securevector.app.rules.last_resort import matches_last_resort
        synced_repo = SyncedRulesRepository(db)
        synced_rows = await synced_repo.list_all()
        # Index synced rules under both the full tool_id and the bare suffix
        # after a `:` (cloud naming convention is `<server>:<tool>` but the
        # local registry uses bare tool names; without aliasing the lock icon
        # never appears on synced tools). Keep higher-priority rule on collision.
        synced_map: dict = {}
        for r in synced_rows:
            keys = [r.tool_id]
            if ':' in r.tool_id:
                keys.append(r.tool_id.split(':', 1)[1])
            for k in keys:
                existing = synced_map.get(k)
                if not existing or (r.priority or 0) > (existing.priority or 0):
                    synced_map[k] = r

        tools = []

        # Registry tools first.
        for tool_id, tool in registry.items():
            tools.append(_build_tool_response_row(
                tool_id, tool, overrides_map, synced_map, matches_last_resort,
            ))

        # Claude Code built-ins. Synthesized from the static table above so
        # cloud rules with `tool_id="Bash"` etc. appear governable in the UI.
        # Names duplicating a registry tool_id are skipped — registry wins
        # (the registry's metadata is richer).
        registry_ids = set(registry.keys())
        for name, risk, description in CLAUDE_CODE_BUILTINS:
            if name in registry_ids:
                continue
            builtin_meta = {
                "name": name,
                "provider": "Claude Code",
                "category": "claude_code",
                "risk": risk,
                "default_permission": "allow",
                "description": description,
                "source": "builtin",
                "mcp_server": "",
                "popular": False,
            }
            tools.append(_build_tool_response_row(
                name, builtin_meta, overrides_map, synced_map, matches_last_resort,
            ))

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


@router.get("/tool-permissions/synced-overrides")
async def get_synced_overrides():
    """Cloud-pushed synced rules in proxy-friendly shape.

    Returned dict per tool_id carries the synced effect + policy provenance so
    proxy enforcement decisions can be both correct (effect wins over local
    user override + registry default) and auditable (reason names the policy).
    """
    try:
        from securevector.app.database.repositories.synced_rules import (
            SyncedRulesRepository,
        )

        db = get_database()
        synced_repo = SyncedRulesRepository(db)
        rows = await synced_repo.list_all()

        # Emit each synced rule under its full tool_id AND, when the cloud
        # composed `<server>:<tool>`, under the bare suffix as an alias. The
        # proxy's _load_synced_overrides keys by tool_id directly, so without
        # aliasing here a synced rule on `github-mcp-server:delete_file`
        # would never match the LLM call's bare `delete_file` function name.
        synced: list = []
        for r in rows:
            base = {
                "effect": r.effect,
                "priority": r.priority,
                "policy_id": r.policy_id,
                "policy_name": r.policy_name,
                "policy_version": r.policy_version,
                "org_name": r.org_name,
                "reason": r.reason,
            }
            synced.append({"tool_id": r.tool_id, **base})
            if ':' in r.tool_id:
                synced.append({"tool_id": r.tool_id.split(':', 1)[1], **base})
        return {"synced": synced, "total": len(synced)}

    except Exception as e:
        logger.error(f"Failed to get synced overrides: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/tool-permissions/overrides/{tool_id}")
async def upsert_override(tool_id: str, request: OverrideRequest):
    """Set or update an override for an essential tool."""
    try:
        # Validate tool_id exists either in the YAML registry OR in the
        # Claude Code built-ins list — the Tool Permissions page renders
        # both as governable rows, so a 404 on built-in IDs would make
        # every "Block Bash" click silently fail with a toast error.
        registry = _get_registry()
        builtin_ids = {name for name, _r, _d in CLAUDE_CODE_BUILTINS}
        if tool_id not in registry and tool_id not in builtin_ids:
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
    # Which agent runtime emitted the call (e.g. "claude-code", "openclaw").
    # Metadata only; not in the v20 hash chain (see migrate_to_v21 / v32).
    runtime_kind: Optional[str] = None


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
            runtime_kind=request.runtime_kind,
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


@router.get("/tool-permissions/call-audit/integrity")
async def get_call_audit_integrity():
    """Verify the tamper-evident hash chain over the tool_call_audit table.

    Walks every row oldest-first, recomputes SHA-256(prev_hash ‖ canonical_row)
    against the stored row_hash, and also checks that seq is contiguous and
    each prev_hash matches the previous row's row_hash.

    Returns:
        {
          "ok": true | false,
          "total": <rows scanned>,
          "tampered_at": <seq> | null,
          "tampered_id": <db id> | null,
          "reason": <short message> | null,
          "last_verified_at": <iso timestamp>
        }

    Design note (PR #46 comment @desiorac): this catches casual tampering
    and disk corruption on the local audit log. A determined local attacker
    with the same OS privileges can recompute the chain and rewrite history
    — the durable defense is off-host forwarding, which the metadata-only
    cloud sync outbox (migration v21) provides.
    """
    try:
        db = get_database()
        repo = CustomToolsRepository(db)
        return await repo.verify_audit_chain()
    except Exception as e:
        logger.error(f"Failed to verify audit chain: {e}")
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


