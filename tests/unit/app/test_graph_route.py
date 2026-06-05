"""Tests for the Agent–Tool Live Graph (story #143)."""

from __future__ import annotations

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.custom_tools import CustomToolsRepository
from securevector.app.server.routes.graph import (
    _edge_outcome,
    _edge_risk,
    _worst,
    build_graph,
)


# ---------------- pure helpers ----------------


def test_edge_risk_red_when_blocked():
    assert _edge_risk(blocked=1, touched_secrets=False, recent_risk="read") == "red"


def test_edge_risk_amber_on_secret_or_high_risk():
    assert _edge_risk(0, True, "read") == "amber"
    assert _edge_risk(0, False, "admin") == "amber"
    assert _edge_risk(0, False, "delete") == "amber"


def test_edge_risk_green_otherwise():
    assert _edge_risk(0, False, "read") == "green"
    assert _edge_risk(0, False, None) == "green"


def test_edge_outcome():
    assert _edge_outcome(blocked=2, allowed=8, logged=0) == "blocked"
    assert _edge_outcome(0, 0, 3) == "log_only"
    assert _edge_outcome(0, 5, 1) == "allow"


def test_worst_picks_higher_severity():
    assert _worst("green", "red") == "red"
    assert _worst("amber", "green") == "amber"
    assert _worst("red", "amber") == "red"


# ---------------- build_graph (pure assembly) ----------------


def _row(runtime, tool_id, calls, blocked=0, allowed=0, logged=0, **kw):
    base = {
        "runtime_kind": runtime,
        "tool_id": tool_id,
        "function_name": tool_id.split(":")[-1],
        "calls": calls,
        "blocked": blocked,
        "allowed": allowed,
        "logged": logged,
        "last_used": "2026-06-04 00:00:00",
        "recent_risk": "read",
        "touched_secrets": 0,
        "synced_effect": None,
        "synced_policy_name": None,
        "synced_org_name": None,
    }
    base.update(kw)
    return base


def test_build_graph_makes_agent_and_tool_nodes_and_edges():
    raw = [
        _row("claude-code", "srv:read_file", 10, allowed=10),
        _row("claude-code", "srv:web_fetch", 7, blocked=7),
        _row("codex", "srv:read_file", 3, allowed=3),
    ]
    g = build_graph(raw, window_days=7)

    agents = {n["id"]: n for n in g["nodes"] if n["kind"] == "agent"}
    tools = {n["id"]: n for n in g["nodes"] if n["kind"] == "tool"}
    assert set(agents) == {"agent:claude-code", "agent:codex"}
    assert set(tools) == {"tool:srv:read_file", "tool:srv:web_fetch"}
    assert len(g["edges"]) == 3

    # A blocked edge → red; agent inherits the worst ring of its edges.
    blocked_edge = next(e for e in g["edges"] if e["target"] == "tool:srv:web_fetch")
    assert blocked_edge["outcome"] == "blocked"
    assert blocked_edge["risk"] == "red"
    assert agents["agent:claude-code"]["risk"] == "red"
    # codex only touched the clean tool → green
    assert agents["agent:codex"]["risk"] == "green"
    # read_file aggregates calls from both agents
    assert tools["tool:srv:read_file"]["calls"] == 13


def test_build_graph_flags_cloud_managed_and_secrets():
    raw = [
        _row("claude-code", "srv:vault", 4, allowed=4, synced_effect="deny", touched_secrets=1),
    ]
    g = build_graph(raw, window_days=7)
    tool = next(n for n in g["nodes"] if n["kind"] == "tool")
    assert tool["cloud_managed"] is True
    assert tool["touched_secrets"] is True


def test_build_graph_truncates_top_n(monkeypatch):
    import securevector.app.server.routes.graph as graph_mod

    monkeypatch.setattr(graph_mod, "_EDGE_CAP", 2)
    raw = [
        _row("claude-code", f"srv:tool_{i}", calls=i, allowed=i) for i in range(5)
    ]
    g = graph_mod.build_graph(raw, window_days=7)
    assert g["truncated"] is True
    assert g["dropped_edges"] == 3
    assert len(g["edges"]) == 2
    # the two highest-volume edges survive
    assert {e["calls"] for e in g["edges"]} == {4, 3}


# ---------------- repository aggregation (real DB) ----------------


async def _build_db(tmp_path) -> DatabaseConnection:
    db = DatabaseConnection(tmp_path / "test.db")
    await run_migrations(db)
    return db


@pytest.mark.asyncio
async def test_repo_groups_edges_by_runtime_and_tool(tmp_path):
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    # two runtimes, overlapping + distinct tools, a block on one edge
    await repo.log_tool_call_audit("srv:a", "a", "allow", runtime_kind="claude-code", session_id="s1")
    await repo.log_tool_call_audit("srv:a", "a", "allow", runtime_kind="claude-code", session_id="s1")
    await repo.log_tool_call_audit("srv:b", "b", "block", reason="credential exfil", runtime_kind="claude-code", session_id="s1")
    await repo.log_tool_call_audit("srv:a", "a", "allow", runtime_kind="codex", session_id="s2")

    edges = await repo.get_agent_tool_graph(window_days=7)
    by_key = {(e["runtime_kind"], e["tool_id"]): e for e in edges}

    assert by_key[("claude-code", "srv:a")]["calls"] == 2
    assert by_key[("claude-code", "srv:a")]["allowed"] == 2
    assert by_key[("claude-code", "srv:b")]["blocked"] == 1
    assert by_key[("claude-code", "srv:b")]["touched_secrets"] == 1
    assert by_key[("codex", "srv:a")]["calls"] == 1

    await db.disconnect()
