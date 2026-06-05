"""Tests for the Agent Run Trace aggregation (story #142)."""

from __future__ import annotations

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.custom_tools import CustomToolsRepository
from securevector.app.server.routes.traces import _VERDICT, _run_risk


# ---------------- pure helpers ----------------


def test_run_risk():
    assert _run_risk(blocked=1, recent_risk="read") == "red"
    assert _run_risk(0, "admin") == "amber"
    assert _run_risk(0, "read") == "green"
    assert _run_risk(0, None) == "green"


def test_verdict_map():
    assert _VERDICT["block"] == ("blocked", "BLOCKED", "red")
    assert _VERDICT["log_only"] == ("log_only", "LOG", "grey")
    assert _VERDICT["allow"] == ("allow", "ALLOW", "green")


# ---------------- repository (real DB) ----------------


async def _build_db(tmp_path) -> DatabaseConnection:
    db = DatabaseConnection(tmp_path / "test.db")
    await run_migrations(db)
    return db


async def _seed_run(repo, runtime, session, calls):
    """calls = list of (tool_id, action, reason)."""
    for tool_id, action, reason in calls:
        await repo.log_tool_call_audit(
            tool_id, tool_id.split(":")[-1], action,
            reason=reason, runtime_kind=runtime, session_id=session,
        )


@pytest.mark.asyncio
async def test_trace_runs_group_by_session(tmp_path):
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    await _seed_run(repo, "claude-code", "s1", [
        ("srv:read", "allow", None),
        ("srv:read", "allow", None),
        ("srv:web", "block", "data_leakage"),
    ])
    await _seed_run(repo, "codex", "s2", [("srv:read", "allow", None)])

    runs = await repo.get_trace_runs(window_days=7)
    assert len(runs) == 2
    by_session = {r["session_id"]: r for r in runs}
    assert by_session["s1"]["spans"] == 3
    assert by_session["s1"]["blocked"] == 1
    assert by_session["s2"]["spans"] == 1
    # both runs have a derived trace_id
    assert all(r["trace_id"] for r in runs)


@pytest.mark.asyncio
async def test_trace_spans_ordered_with_verdicts(tmp_path):
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    await _seed_run(repo, "claude-code", "s1", [
        ("srv:read", "allow", None),
        ("srv:web", "block", "data_leakage credential"),
        ("srv:log", "log_only", None),
    ])
    from securevector.app.utils.trace_id import derive_trace_id
    tid = derive_trace_id("claude-code", "s1")

    spans = await repo.get_trace_spans(tid)
    assert [s["turn_index"] for s in spans] == [0, 1, 2]
    assert [s["action"] for s in spans] == ["allow", "block", "log_only"]
    # the blocked span carries its reason
    blocked = next(s for s in spans if s["action"] == "block")
    assert "data_leakage" in (blocked["reason"] or "")

    await db.disconnect()


@pytest.mark.asyncio
async def test_orphan_rows_excluded_from_runs(tmp_path):
    """Rows without a session id (NULL trace_id) are not listed as runs."""
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)
    await repo.log_tool_call_audit("srv:x", "x", "allow", runtime_kind="claude-code")  # no session
    runs = await repo.get_trace_runs(window_days=7)
    assert runs == []
    await db.disconnect()
