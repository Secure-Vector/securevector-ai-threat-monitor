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
from securevector.app.database.repositories.settings import SettingsRepository
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
#
# Codex shares the exact same built-in names (its plugin re-uses
# normalize.js verbatim), so `CODEX_BUILTINS` below is derived from this
# table and surfaced as parallel UI rows under category "codex".
# A single rule `tool_id="Bash"` governs both runtimes — the duplicate
# rows are intentional: they let the UI show *which* runtime the user is
# governing without inventing a per-runtime tool_id namespace that would
# break synced-rule lookups.
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

# Canonical list of Codex HOOK-PAYLOAD tool names. CRITICAL distinction
# from the model-layer `function_call.name` you see in session JSONL:
# Codex's hook engine renames some tools before invoking PreToolUse /
# PostToolUse. Defined in `codex-rs/core/src/tools/hook_names.rs`:
#
#   exec_command + shell_command   → "Bash"          (HookToolName::bash())
#   apply_patch                    → "apply_patch"   (matcher aliases: Write, Edit)
#   spawn_agent                    → "spawn_agent"   (matcher alias: Agent)
#   everything else                → passthrough
#
# Empirically confirmed by capturing hook stdin: when the LLM emitted
# `function_call.name = "exec_command"`, the hook received
# `tool_name: "Bash"`. The previous iteration of this list contained
# `exec_command` (wrong — never appears in hook stdin) and silently
# fail-opened every Codex shell call. KEEP IN LOCKSTEP with the Codex
# copy of `normalize.js` (`src/securevector/plugins/codex/lib/normalize.js`).
#
# Risk classification ("admin" / "write" / "read") drives the default
# UI sort + future risk-budget views.
CODEX_BUILTINS: list[tuple[str, str, str]] = [
    # Shell + I/O — Codex's hook payload uses "Bash" for exec_command +
    # shell_command. The single most load-bearing entry in this list;
    # without it every Codex shell call fail-opens.
    ("Bash",                    "admin", "Shell command (covers Codex's exec_command, shell_command, and file reads via cat / grep / ls / sed)."),
    # File mutation — apply_patch is the canonical hook name; Write +
    # Edit work as matcher aliases at the hook engine layer.
    ("apply_patch",             "write", "Apply a diff to one or more files (Codex's Edit/Write/MultiEdit)."),
    # Planning + UI
    ("update_plan",             "write", "Update the session task list (Codex's TodoWrite)."),
    ("view_image",              "read",  "Inspect an image at a URL or path."),
    ("web_search",              "read",  "Run a web search."),
    # User interaction
    ("request_permissions",     "admin", "Request elevated permissions from the user."),
    ("request_user_input",      "read",  "Ask the user a clarifying question."),
    # MCP discovery + read
    ("list_mcp_resources",      "read",  "List MCP resources exposed by configured servers."),
    ("list_mcp_resource_templates", "read", "List MCP resource templates."),
    ("read_mcp_resource",       "read",  "Read an MCP resource by URI."),
    # Plugin lifecycle
    ("list_available_plugins_to_install", "read", "List plugins available in configured marketplaces."),
    ("request_plugin_install",  "admin", "Request installation of a Codex plugin."),
    # Documentation
    ("docs",                    "read",  "Query the documentation tool."),
    # Multi-agent orchestration — Codex's "agent jobs" subsystem
    ("spawn_agent",             "admin", "Spawn a subordinate agent."),
    ("spawn_agents_on_csv",     "admin", "Spawn multiple agents from a CSV."),
    ("wait_agent",              "read",  "Wait for a spawned agent."),
    ("close_agent",             "admin", "Close a spawned agent."),
    ("resume_agent",            "admin", "Resume a previously-spawned agent."),
    ("list_agents",             "read",  "List active agents."),
    ("send_input",              "admin", "Send input to a spawned agent."),
    ("send_message",            "admin", "Send a message to a spawned agent."),
    ("followup_task",           "admin", "Schedule a follow-up task on an agent."),
    ("report_agent_job_result", "write", "Report the result of an agent job."),
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

        # Codex built-ins. Same tool_id namespace as CC (so a single
        # synced/override rule covers both runtimes), but surfaced as a
        # distinct UI row under category "codex" so users can see at a
        # glance that the governance applies to their Codex sessions
        # too. The Codex row is omitted only when the registry already
        # claims the name — registry metadata is richer.
        for name, risk, description in CODEX_BUILTINS:
            if name in registry_ids:
                continue
            builtin_meta = {
                "name": name,
                "provider": "Codex",
                "category": "codex",
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
    """Effective tool-permission decisions, in proxy-friendly shape.

    ENFORCEMENT VIEW — NOT the full rule catalogue. This endpoint returns
    the set of rules that are CURRENTLY ENFORCED, which is gated on the
    global enforcement kill-switch (`settings.tool_permissions_enabled`).
    When enforcement is OFF it returns `{"synced": [], "total": 0}` even
    though synced rules and local overrides may still be configured in
    their tables. A UI consumer MUST NOT read an empty result as "no rules
    configured" — it can equally mean "enforcement is disabled, so nothing
    is being enforced right now." To list the configured rules regardless
    of enforcement state, query the underlying sources instead:
    `/tool-permissions/essential` (effective per-tool view incl. synced +
    overrides) and `/tool-permissions/overrides` (raw local overrides).

    Despite the historical name, this endpoint now merges TWO sources:
      1. Cloud-pushed synced rules (from `synced_rules` table)
      2. Local user overrides set via the Tool Permissions UI's
         block/allow buttons (from `tool_essential_overrides` table)

    Precedence: synced > local. Implemented by appending synced rows
    FIRST and local rows SECOND; downstream consumers (hook, proxy,
    OpenClaw plugin) all use first-seen-wins by tool_id, so synced
    rules naturally win when both target the same tool.

    Per-row `source` field discriminates `"synced"` vs `"local"` for
    telemetry and audit. Existing consumers that ignore `source`
    will simply start enforcing local overrides, which is what users
    expect when they click Block in the UI — historically the click
    was cosmetic for agent runtimes since hooks only consulted the
    synced table.
    """
    try:
        from securevector.app.database.repositories.synced_rules import (
            SyncedRulesRepository,
        )

        db = get_database()

        # Global enforcement kill-switch. When the Tool Permissions page's
        # "Enforcement" toggle is OFF the user expects nothing to be
        # blocked anywhere — proxy AND plugin hooks. The proxy already
        # short-circuits on its own settings check, but agent plugins
        # (CC / Codex / OpenClaw) consult this endpoint as their only
        # decision oracle. Returning an empty synced list here makes
        # every plugin's `decideFromOverrides` fail-open to allow,
        # which matches the toggle's stated "monitor only" semantics.
        # PostToolUse audit POSTs are unaffected so the user still sees
        # every call in Tool Activity — just no blocks.
        try:
            settings_repo = SettingsRepository(db)
            app_settings = await settings_repo.get()
            if not app_settings.tool_permissions_enabled:
                return {"synced": [], "total": 0}
        except Exception as e:
            logger.warning(
                "Settings fetch failed in /synced-overrides; "
                "defaulting to enforcement-on: %s", e,
            )

        synced_repo = SyncedRulesRepository(db)
        rows = await synced_repo.list_all()

        # Emit each synced rule under its full tool_id AND, when the cloud
        # composed `<server>:<tool>`, under the bare suffix as an alias. The
        # proxy's _load_synced_overrides keys by tool_id directly, so without
        # aliasing here a synced rule on `github-mcp-server:delete_file`
        # would never match the LLM call's bare `delete_file` function name.
        merged: list = []
        for r in rows:
            base = {
                "effect": r.effect,
                "priority": r.priority,
                "policy_id": r.policy_id,
                "policy_name": r.policy_name,
                "policy_version": r.policy_version,
                "org_name": r.org_name,
                "reason": r.reason,
                "source": "synced",
            }
            merged.append({"tool_id": r.tool_id, **base})
            if ':' in r.tool_id:
                merged.append({"tool_id": r.tool_id.split(':', 1)[1], **base})

        # Local overrides — set via the UI's Block/Allow buttons. Mapped
        # into the synced-row shape so existing consumers don't need to
        # learn a second format. Local action `block` → effect `deny`;
        # `allow` → `allow`. `log_only` not exposed as a local-UI option
        # so no mapping needed.
        #
        # Wrapped in its own try/except so a local-overrides DB error
        # falls back to "synced only" instead of 500-ing the whole
        # endpoint — preserves the pre-merge fail-quiet contract that
        # the three downstream consumers (CC hook, OpenClaw plugin,
        # proxy) rely on for fail-open behaviour.
        local_rows: list[dict] = []
        try:
            local_repo = ToolPermissionsRepository(db)
            local_rows = await local_repo.get_all_overrides()
        except Exception as e:
            logger.warning(
                "Local-overrides fetch failed in /synced-overrides; "
                "returning synced-only: %s", e,
            )
        ACTION_TO_EFFECT = {"block": "deny", "allow": "allow"}
        for lr in local_rows:
            action = lr.get("action")
            effect = ACTION_TO_EFFECT.get(action)
            if effect is None:
                continue
            merged.append({
                "tool_id": lr["tool_id"],
                "effect": effect,
                "priority": 50,  # below synced (100); first-seen-wins in
                                 # the hook so synced still wins if both
                                 # target the same tool_id.
                "policy_id": "_local",
                "policy_name": "Local override",
                "policy_version": 0,
                "org_name": "Local",
                "reason": "User-set local override",
                "source": "local",
            })
        return {"synced": merged, "total": len(merged)}

    except Exception as e:
        logger.error(f"Failed to get synced overrides: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/tool-permissions/overrides/{tool_id}")
async def upsert_override(tool_id: str, request: OverrideRequest):
    """Set or update an override for an essential tool."""
    try:
        # Validate tool_id exists either in the YAML registry OR in the
        # built-ins list for one of the supported runtimes — the Tool
        # Permissions page renders all of them as governable rows, so a
        # 404 on built-in IDs would make every "Block Bash" click
        # silently fail with a toast error. The CC + Codex built-in
        # sets share names today, but accept the union to stay correct
        # if either runtime adds a tool the other doesn't have.
        registry = _get_registry()
        builtin_ids = {name for name, _r, _d in CLAUDE_CODE_BUILTINS}
        builtin_ids.update(name for name, _r, _d in CODEX_BUILTINS)
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

    Called by the proxy after every tool permission evaluation. Volume
    filter: when the action is `allow` and no policy decision was
    actually made (i.e., the call passed by default rather than by an
    explicit rule), we drop the row instead of persisting it.

    Rationale: Claude Code routinely produces 200-500 `allow` rows per
    developer per day from routine Read/Glob/Bash calls. None of those
    are policy decisions — they're "no rule matched, default-allow."
    Persisting them buries the meaningful rows (block / log_only) in
    noise and bloats the hash chain. Block and log_only ALWAYS persist;
    a non-empty `reason` field means an explicit rule fired and the row
    persists too. Threat detections go through `/api/analyze` → the
    `threat_intel_records` table, not this audit log.
    """
    # Record every row. The earlier default-allow noise filter dropped
    # rows where action=allow and reason was None — which silenced
    # Claude Code's routine Read/Glob/Bash calls and left the Tool
    # Activity tab empty after install. UI-side filter chips
    # ("Policy decisions only" / "Blocked only") let users narrow the
    # view without losing the underlying truth on disk. If chain
    # volume becomes a real problem, retention/rotation is the answer,
    # not preemptive row-drops.
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


# MCP tool calls land in tool_call_audit in two possible shapes for tool_id:
#   1. Raw runtime form ``mcp__<server>__<tool>`` (some hook paths).
#   2. Normalised ``<server>:<tool>`` (the canonical form emitted by
#      plugins/claude-code/lib/normalize.js line 87 — this is the form
#      Claude Code's PostToolUse hook actually writes).
# Anything else is a built-in (Bash, Edit, Write, …).
_MCP_PREFIX = "mcp__"
_MCP_SEP = "__"


# Known agent-harness auth scopes for built-in tool names. Auth scope here is
# SecureVector's classification (read / write / delete / admin), not the
# harness's self-declared capability. Only used as a fallback when neither
# custom_tools.risk nor tool_call_audit.risk has a value — historical audit
# rows can have NULL risk because risk classification was a later addition.
_BUILTIN_AUTH_SCOPE = {
    "Bash":           "admin",
    "Skill":          "admin",
    "Agent":          "admin",
    "Read":           "read",
    "Grep":           "read",
    "Glob":           "read",
    "WebFetch":       "read",
    "WebSearch":      "read",
    "NotebookRead":   "read",
    "Edit":           "write",
    "Write":          "write",
    "MultiEdit":      "write",
    "NotebookEdit":   "write",
    "TodoWrite":      "write",
    "ExitPlanMode":   "admin",
}

# MCP tool-name prefix → inferred auth scope. Heuristic: most MCP tools follow
# a verb-noun naming convention. Falls back to "—" (rendered as a dash) when
# the prefix is unrecognised.
_MCP_SCOPE_PREFIX = (
    ("read",   ("read_", "get_", "list_", "search_", "find_", "query_", "browse_",
                "browser_snapshot", "browser_take_screenshot", "browser_console",
                "browser_network", "describe_", "show_", "fetch_", "load_")),
    ("write",  ("write_", "create_", "post_", "put_", "update_", "edit_", "save_",
                "append_", "insert_", "upsert_", "browser_click", "browser_type",
                "browser_navigate", "browser_fill", "browser_press", "browser_drag",
                "browser_select", "browser_hover", "browser_evaluate")),
    ("delete", ("delete_", "remove_", "drop_", "destroy_", "browser_close")),
    ("admin",  ("admin_", "manage_", "config_", "configure_", "auth", "authenticate")),
)


def _infer_mcp_scope(tool_name: str) -> Optional[str]:
    if not tool_name:
        return None
    name = tool_name.lower()
    for scope, prefixes in _MCP_SCOPE_PREFIX:
        if any(name.startswith(p) for p in prefixes):
            return scope
    return None


# Display labels for known runtimes — keep the UI free of repo-internal slugs.
_RUNTIME_LABELS = {
    "claude-code":  "Claude Code",
    "claude_code":  "Claude Code",
    "codex":        "Codex",
    "openclaw":     "OpenClaw",
    "langchain":    "LangChain",
    "langgraph":    "LangGraph",
    "crewai":       "CrewAI",
    "n8n":          "n8n",
    "ollama":       "Ollama",
    # Proxy fallback when --integration isn't set on the subprocess.
    "proxy":        "Proxy (unattributed)",
}


def _format_harness(runtime_kinds: Optional[str]) -> Optional[str]:
    """Format the comma-separated runtime_kinds list as a human label."""
    if not runtime_kinds:
        return None
    seen = []
    for raw in str(runtime_kinds).split(","):
        slug = raw.strip()
        if not slug:
            continue
        label = _RUNTIME_LABELS.get(slug, slug)
        if label not in seen:
            seen.append(label)
    return " / ".join(seen) if seen else None


def _split_server_and_tool(tool_id: str, function_name: Optional[str]) -> tuple[str, str]:
    """Return (server_label, tool_label) for a tool_id from tool_call_audit.

    Handles three encodings:
      - ``mcp__filesystem__read_file`` (raw)         -> ("filesystem", "read_file")
      - ``filesystem:read_file`` (normalised)        -> ("filesystem", "read_file")
      - ``Bash`` (built-in)                          -> ("built-in", "Bash")
    Unknown encodings fall back to the raw tool_id under "built-in".
    """
    if not tool_id:
        return ("built-in", function_name or "")

    # Form 1: raw MCP encoding ``mcp__<server>__<tool>``.
    if tool_id.startswith(_MCP_PREFIX):
        remainder = tool_id[len(_MCP_PREFIX):]
        sep_idx = remainder.find(_MCP_SEP)
        if sep_idx > 0:
            server = remainder[:sep_idx]
            tool = remainder[sep_idx + len(_MCP_SEP):]
            if server and tool:
                return (server, tool)

    # Form 2: normalised ``<server>:<tool>`` (no built-in tool name contains
    # ``:`` — see BUILTIN_TOOLS in normalize.js — so this is unambiguous).
    if ":" in tool_id:
        server, _, tool = tool_id.partition(":")
        if server and tool:
            return (server, tool)

    # tool_id is the canonical identifier; function_name is a Claude-Code-ism
    # where the harness happens to set function_name == tool_id for built-ins
    # like "Bash". Other harnesses (OpenClaw) use function_name as a session
    # key ("agent:main:main"), which is NOT a tool name. Prefer tool_id —
    # function_name is a last-resort fallback only when tool_id is empty.
    return ("built-in", tool_id or function_name or "")


@router.get("/tool-permissions/bill-of-tools")
async def get_bill_of_tools(window_days: int = 7):
    """SBOM-style inventory of every (server, tool) active in the trailing window.

    Returns one row per tool_id seen in tool_call_audit during the last
    ``window_days`` days, joined with custom_tools (local risk classification)
    and synced_tool_rules (cloud policy attribution). The result is the local
    "MCP Bill of Tools" view — a single rolled-up table the user can export
    as CSV or PDF.

    Query params:
      - window_days: trailing window in days (1–90, default 7).

    Response shape:
      {
        "window_days": 7,
        "row_count": N,
        "rows": [
          {
            "tool_id":          "mcp__filesystem__read_file",
            "server":           "filesystem",
            "tool":             "read_file",
            "source":           "cloud-policy" | "local-custom" | "built-in",
            "auth_scope":       "read" | "write" | "delete" | "admin" | "unknown",
            "auth_scope_origin": "local-custom-tools" | "audit-row" | "default",
            "last_used":        "<iso>",
            "calls":            42,
            "blocked":          1,
            "allowed":          40,
            "logged":           1,
            "touched_secrets":  false,
            "policy_name":      "Filesystem guardrail" | null,
            "policy_org":       "ACME Sec" | null
          },
          ...
        ]
      }

    Limitation: ``touched_secrets`` is a LIKE-match against the audit row's
    ``reason`` for credential/secret/token keywords — catches rule-fired
    blocks/log_onlys, NOT unflagged exfiltration via a tool that legitimately
    accepts secrets (e.g. a vault MCP server). Sufficient for the v1 governance
    artifact; tighter cross-correlation with the rules engine is a follow-up.
    """
    try:
        db = get_database()
        repo = CustomToolsRepository(db)
        raw_rows = await repo.get_bill_of_tools(window_days=window_days)

        rows = []
        for r in raw_rows:
            tool_id = r.get("tool_id") or ""
            server, tool = _split_server_and_tool(tool_id, r.get("function_name"))

            # source classification (most-specific wins):
            #   - cloud-policy : a synced policy covers this tool
            #   - local-custom : user registered it locally
            #   - built-in     : harness built-in (Bash, Read, Edit, …)
            #   - mcp          : discovered MCP tool with no policy / custom row
            if r.get("synced_effect") is not None:
                source = "cloud-policy"
            elif r.get("local_risk") is not None:
                source = "local-custom"
            elif server == "built-in":
                source = "built-in"
            else:
                source = "mcp"

            # auth_scope precedence:
            #   1. explicit custom_tools.risk (user-declared)
            #   2. tool_call_audit.risk (engine recorded at decision time)
            #   3. static map for known built-ins (Bash → admin, Read → read, …)
            #   4. verb-prefix heuristic for MCP tool names
            # Falls through to None (rendered as "—") when nothing applies.
            scope = r.get("local_risk") or r.get("recent_risk")
            if scope:
                scope_origin = "local-custom-tools" if r.get("local_risk") else "audit-row"
            elif server == "built-in" and tool in _BUILTIN_AUTH_SCOPE:
                # Bash is always 'admin' regardless of whether a policy now
                # covers it — derive from what the tool IS, not from source.
                scope = _BUILTIN_AUTH_SCOPE[tool]
                scope_origin = "builtin-map"
            else:
                inferred = _infer_mcp_scope(tool)
                if inferred:
                    scope = inferred
                    scope_origin = "name-heuristic"
                else:
                    scope = None
                    scope_origin = "unknown"

            rows.append({
                "tool_id": tool_id,
                "server": server,
                "tool": tool,
                "source": source,
                "harness": _format_harness(r.get("runtime_kinds")),
                "auth_scope": scope,
                "auth_scope_origin": scope_origin,
                "last_used": r.get("last_used"),
                "calls": int(r.get("calls") or 0),
                "blocked": int(r.get("blocked") or 0),
                "allowed": int(r.get("allowed") or 0),
                "logged": int(r.get("logged") or 0),
                "touched_secrets": bool(r.get("touched_secrets")),
                "policy_name": r.get("synced_policy_name"),
                "policy_org": r.get("synced_org_name"),
            })

        return {
            "window_days": max(1, min(int(window_days), 90)),
            "row_count": len(rows),
            "rows": rows,
        }
    except Exception as e:
        logger.error(f"Failed to compute bill of tools: {e}")
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


