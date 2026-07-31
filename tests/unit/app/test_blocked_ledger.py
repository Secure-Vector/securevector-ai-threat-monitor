"""Tests for the blocked-action ledger aggregation (agent-observability §3.2)."""

from __future__ import annotations

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.custom_tools import CustomToolsRepository


async def _repo(tmp_path) -> CustomToolsRepository:
    db = DatabaseConnection(tmp_path / "ledger.db")
    await run_migrations(db)
    return CustomToolsRepository(db)


async def _seed(repo, tool, fn, action, *, risk=None, reason=None, rt="claude-code", sid="s1"):
    await repo.log_tool_call_audit(
        tool, fn, action, risk=risk, reason=reason, runtime_kind=rt, session_id=sid,
    )


@pytest.mark.asyncio
async def test_empty_ledger(tmp_path):
    repo = await _repo(tmp_path)
    led = await repo.get_blocked_ledger(window_days=7)
    assert led["summary"]["blocked_total"] == 0
    assert led["by_reason"] == []
    assert led["by_tool"] == []


@pytest.mark.asyncio
async def test_only_blocked_rows_counted(tmp_path):
    repo = await _repo(tmp_path)
    await _seed(repo, "Bash", "Bash", "allow")
    await _seed(repo, "Read", "Read", "log_only")
    await _seed(repo, "Bash", "Bash", "block", risk="delete", reason="deny shell")
    led = await repo.get_blocked_ledger(window_days=7)
    # Allow / log_only never appear in the ledger.
    assert led["summary"]["blocked_total"] == 1
    assert len(led["by_reason"]) == 1
    assert led["by_reason"][0]["reason"] == "deny shell"


@pytest.mark.asyncio
async def test_grouping_by_reason_with_hit_counts(tmp_path):
    repo = await _repo(tmp_path)
    # Same reason, two different tools + two agents.
    await _seed(repo, "Bash", "Bash", "block", risk="delete", reason="deny shell", sid="a")
    await _seed(repo, "Bash", "Bash", "block", risk="delete", reason="deny shell", sid="b")
    await _seed(repo, "Write", "Write", "block", risk="write", reason="sensitive path", sid="a")
    led = await repo.get_blocked_ledger(window_days=7)
    assert led["summary"]["blocked_total"] == 3
    assert led["summary"]["tools_blocked"] == 2
    # by_reason sorted by count desc — "deny shell" (2) leads.
    top = led["by_reason"][0]
    assert top["reason"] == "deny shell"
    assert top["count"] == 2
    assert top["agents"] == 2      # sid a + b
    assert top["high_risk"] == 1   # delete is high-risk


@pytest.mark.asyncio
async def test_missing_reason_gets_placeholder(tmp_path):
    repo = await _repo(tmp_path)
    await _seed(repo, "Bash", "Bash", "block", risk="write", reason=None)
    led = await repo.get_blocked_ledger(window_days=7)
    assert led["by_reason"][0]["reason"] == "Policy block (no reason recorded)"


@pytest.mark.asyncio
async def test_by_tool_breakdown(tmp_path):
    repo = await _repo(tmp_path)
    await _seed(repo, "Bash", "Bash", "block", reason="r1")
    await _seed(repo, "Bash", "Bash", "block", reason="r1")
    await _seed(repo, "mcp__x__y", "y", "block", reason="r2")
    led = await repo.get_blocked_ledger(window_days=7)
    tools = {t["tool_id"]: t["count"] for t in led["by_tool"]}
    assert tools["Bash"] == 2
    assert tools["mcp__x__y"] == 1
