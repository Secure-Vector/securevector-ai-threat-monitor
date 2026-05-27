"""Tests for the Bill of Tools aggregation + server/tool split helper."""

from __future__ import annotations

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.custom_tools import CustomToolsRepository
from securevector.app.server.routes.tool_permissions import _split_server_and_tool


async def _build_db(tmp_path) -> DatabaseConnection:
    db = DatabaseConnection(tmp_path / "bill.db")
    await run_migrations(db)
    return db


# ---------------------------------------------------------------------------
# _split_server_and_tool helper
# ---------------------------------------------------------------------------


def test_split_mcp_tool_id():
    assert _split_server_and_tool("mcp__filesystem__read_file", "read_file") == (
        "filesystem", "read_file",
    )


def test_split_mcp_tool_id_with_double_underscore_in_tool_name():
    # If the tool itself has __ in its name, split at the FIRST separator only.
    assert _split_server_and_tool("mcp__slack__post_message", "post_message") == (
        "slack", "post_message",
    )


def test_split_normalised_colon_form():
    # Claude Code's PostToolUse hook persists the normalised form per
    # plugins/claude-code/lib/normalize.js line 87.
    assert _split_server_and_tool(
        "plugin_playwright_playwright:browser_navigate",
        "mcp__plugin_playwright_playwright__browser_navigate",
    ) == ("plugin_playwright_playwright", "browser_navigate")


def test_split_normalised_colon_form_simple():
    assert _split_server_and_tool("filesystem:read_file", "read_file") == (
        "filesystem", "read_file",
    )


def test_split_builtin_tool():
    # Bare PascalCase built-ins (Bash, Edit, …) land under "built-in".
    assert _split_server_and_tool("Bash", "Bash") == ("built-in", "Bash")


def test_split_unknown_encoding_falls_back():
    # tool_id without the mcp__ prefix and no known built-in is treated as built-in.
    assert _split_server_and_tool("weird_tool_id", "weird_tool_id") == (
        "built-in", "weird_tool_id",
    )


def test_split_empty_tool_id_uses_function_name():
    assert _split_server_and_tool("", "fallback_name") == ("built-in", "fallback_name")


def test_split_malformed_mcp_prefix():
    # mcp__ with no separator after — fall back to built-in. We prefer
    # tool_id over function_name in the fallback because OpenClaw sends
    # sessionKey-shaped strings (e.g. "agent:main:main") as function_name,
    # which would pollute the column. The raw tool_id (here, the malformed
    # "mcp__justaserver") at least reflects what the caller intended.
    assert _split_server_and_tool("mcp__justaserver", "justaserver") == (
        "built-in", "mcp__justaserver",
    )


# ---------------------------------------------------------------------------
# get_bill_of_tools aggregation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bill_aggregates_calls_per_tool_id(tmp_path):
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    # Three calls to the same MCP tool — two allow, one block.
    for action in ("allow", "allow", "block"):
        await repo.log_tool_call_audit(
            tool_id="mcp__filesystem__read_file",
            function_name="read_file",
            action=action,
            risk="read",
            reason="essential" if action == "allow" else "policy_deny",
            runtime_kind="claude-code",
        )

    rows = await repo.get_bill_of_tools(window_days=7)
    assert len(rows) == 1
    row = rows[0]
    assert row["tool_id"] == "mcp__filesystem__read_file"
    assert row["calls"] == 3
    assert row["allowed"] == 2
    assert row["blocked"] == 1
    assert row["recent_risk"] == "read"
    # No credential keyword in any reason → touched_secrets is falsy.
    assert not row["touched_secrets"]

    await db.disconnect()


@pytest.mark.asyncio
async def test_bill_groups_distinct_tools_separately(tmp_path):
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    await repo.log_tool_call_audit(
        tool_id="mcp__filesystem__read_file",
        function_name="read_file",
        action="allow",
        risk="read",
    )
    await repo.log_tool_call_audit(
        tool_id="Bash",
        function_name="Bash",
        action="block",
        risk="admin",
        reason="dangerous shell command",
    )

    rows = await repo.get_bill_of_tools(window_days=7)
    tool_ids = sorted(r["tool_id"] for r in rows)
    assert tool_ids == ["Bash", "mcp__filesystem__read_file"]

    await db.disconnect()


@pytest.mark.asyncio
async def test_bill_touched_secrets_set_when_credential_keyword_in_reason(tmp_path):
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    await repo.log_tool_call_audit(
        tool_id="mcp__email__send_message",
        function_name="send_message",
        action="block",
        risk="write",
        reason="rule sv_community_033_credential_harvesting matched on args",
    )

    rows = await repo.get_bill_of_tools(window_days=7)
    assert len(rows) == 1
    assert rows[0]["touched_secrets"]

    await db.disconnect()


@pytest.mark.asyncio
async def test_bill_touched_secrets_matches_token_keyword(tmp_path):
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    await repo.log_tool_call_audit(
        tool_id="mcp__github__create_pr",
        function_name="create_pr",
        action="log_only",
        reason="Detected leaked api_key in tool input",
    )

    rows = await repo.get_bill_of_tools(window_days=7)
    assert len(rows) == 1
    assert rows[0]["touched_secrets"]

    await db.disconnect()


@pytest.mark.asyncio
async def test_bill_window_clamps_to_supported_range(tmp_path):
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    await repo.log_tool_call_audit(
        tool_id="Bash",
        function_name="Bash",
        action="allow",
    )

    # < 1 clamps to 1; > 90 clamps to 90. Both should still return the row.
    rows_zero = await repo.get_bill_of_tools(window_days=0)
    rows_huge = await repo.get_bill_of_tools(window_days=99999)
    assert len(rows_zero) == 1
    assert len(rows_huge) == 1

    await db.disconnect()


@pytest.mark.asyncio
async def test_bill_returns_empty_when_no_calls(tmp_path):
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    rows = await repo.get_bill_of_tools(window_days=7)
    assert rows == []

    await db.disconnect()


@pytest.mark.asyncio
async def test_bill_joins_custom_tools_for_local_risk(tmp_path):
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    # Register a custom tool with an explicit risk classification.
    await repo.create_custom_tool(
        tool_id="mcp__vault__fetch_secret",
        name="vault fetch_secret",
        category="custom",
        risk="admin",
        default_permission="block",
        description="reads from secret store",
    )
    # Now log a call to it.
    await repo.log_tool_call_audit(
        tool_id="mcp__vault__fetch_secret",
        function_name="fetch_secret",
        action="block",
        risk="admin",
        reason="custom tool — default_permission=block",
    )

    rows = await repo.get_bill_of_tools(window_days=7)
    assert len(rows) == 1
    row = rows[0]
    # Local risk classification should be surfaced from custom_tools join.
    assert row["local_risk"] == "admin"
    assert row["local_category"] == "custom"

    await db.disconnect()
