"""Tests for the Agent–Tool Live Graph (story #143)."""

from __future__ import annotations

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.custom_tools import CustomToolsRepository
from datetime import datetime, timezone

from securevector.app.server.routes.graph import (
    _edge_outcome,
    _edge_risk,
    _worst,
    build_graph,
    build_graph_3layer,
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


# ---------------- build_graph_3layer (pure assembly) ----------------


def _row3(runtime, session_key, tool_id, calls, blocked=0, allowed=0, logged=0,
          last_used="2026-06-05 12:00:00", session_id=None, trace_id=None, **kw):
    base = {
        "runtime_kind": runtime,
        "session_key": session_key,
        "session_id": session_id if session_id is not None else session_key,
        "trace_id": trace_id if trace_id is not None else session_key,
        "tool_id": tool_id,
        "function_name": tool_id.split(":")[-1],
        "calls": calls,
        "blocked": blocked,
        "allowed": allowed,
        "logged": logged,
        "last_used": last_used,
        "recent_risk": "read",
        "touched_secrets": 0,
        "synced_effect": None,
        "synced_policy_name": None,
        "synced_org_name": None,
    }
    base.update(kw)
    return base


_NOW = datetime(2026, 6, 5, 18, 0, 0, tzinfo=timezone.utc)


def test_build_graph_3layer_emits_three_node_kinds_and_two_edge_tiers():
    raw = [
        _row3("claude-code", "t-a", "srv:read", 5, allowed=5),
        _row3("claude-code", "t-a", "srv:bash", 2, blocked=2),
        _row3("claude-code", "t-b", "srv:read", 3, allowed=3),
        _row3("codex", "t-c", "srv:read", 1, allowed=1),
    ]
    g = build_graph_3layer(raw, window_days=7, now=_NOW)

    kinds = {n["kind"] for n in g["nodes"]}
    assert kinds == {"harness", "session", "tool"}

    harnesses = {n["id"]: n for n in g["nodes"] if n["kind"] == "harness"}
    sessions = {n["id"]: n for n in g["nodes"] if n["kind"] == "session"}
    tools = {n["id"]: n for n in g["nodes"] if n["kind"] == "tool"}

    assert set(harnesses) == {"harness:claude-code", "harness:codex"}
    # two claude sessions + one codex session
    assert set(sessions) == {"session:t-a", "session:t-b", "session:t-c"}
    # tool nodes are PER SESSION (so radial/tree don't collapse them)
    assert "tool:t-a:srv:read" in tools and "tool:t-b:srv:read" in tools

    # harness rolls up its sessions' volume + worst ring (bash was blocked → red)
    assert harnesses["harness:claude-code"]["sessions"] == 2
    assert harnesses["harness:claude-code"]["calls"] == 10
    assert harnesses["harness:claude-code"]["risk"] == "red"

    tiers = {e["tier"] for e in g["edges"]}
    assert tiers == {"harness-session", "session-tool"}
    # one harness-session edge per session
    hs = [e for e in g["edges"] if e["tier"] == "harness-session"]
    assert len(hs) == 3


def test_build_graph_3layer_numbers_agents_per_harness_by_recency():
    raw = [
        _row3("claude-code", "old", "srv:read", 1, allowed=1, last_used="2026-06-01 09:00:00"),
        _row3("claude-code", "new", "srv:read", 1, allowed=1, last_used="2026-06-05 17:00:00"),
    ]
    g = build_graph_3layer(raw, window_days=7, now=_NOW)
    sessions = {n["id"]: n for n in g["nodes"] if n["kind"] == "session"}
    # newest run is agent #1
    assert sessions["session:new"]["num"] == 1
    assert sessions["session:new"]["label"] == "agent #1"
    assert sessions["session:old"]["num"] == 2


def test_build_graph_3layer_marks_active_and_idle_days():
    raw = [
        _row3("claude-code", "live", "srv:read", 1, allowed=1, last_used="2026-06-05 17:00:00"),
        _row3("claude-code", "stale", "srv:read", 1, allowed=1, last_used="2026-06-01 09:00:00"),
    ]
    g = build_graph_3layer(raw, window_days=7, now=_NOW)
    sessions = {n["id"]: n for n in g["nodes"] if n["kind"] == "session"}
    assert sessions["session:live"]["active"] is True
    assert sessions["session:live"]["idle_days"] == 0
    assert sessions["session:stale"]["active"] is False
    assert sessions["session:stale"]["idle_days"] == 4
    # harness is active if ANY session is active
    harness = next(n for n in g["nodes"] if n["kind"] == "harness")
    assert harness["active"] is True


def test_build_graph_3layer_carries_last_blocked():
    raw = [
        _row3("claude-code", "t1", "srv:bash", 5, blocked=2, last_blocked="2026-06-05 10:00:00"),
        _row3("claude-code", "t2", "srv:bash", 3, blocked=1, last_blocked="2026-06-05 12:00:00"),
        _row3("claude-code", "t1", "srv:read", 4, allowed=4),  # no block → None
    ]
    g = build_graph_3layer(raw, window_days=7, now=_NOW)
    st = [e for e in g["edges"] if e["tier"] == "session-tool"]
    assert any(e.get("last_blocked") == "2026-06-05 10:00:00" for e in st)
    tools = {n["id"]: n for n in g["nodes"] if n["kind"] == "tool"}
    assert tools["tool:t1:srv:bash"]["last_blocked"] == "2026-06-05 10:00:00"
    assert tools["tool:t2:srv:bash"]["last_blocked"] == "2026-06-05 12:00:00"
    # an allow-only tool has no block timestamp
    assert tools["tool:t1:srv:read"]["last_blocked"] is None


def _boundary_row(runtime, session_key, last_used, session_id=None, trace_id=None):
    """A session-boundary roll-up row (row_kind == 'boundary') as emitted by
    get_agent_session_graph for __session_start__/__session_end__ sentinels."""
    return {
        "row_kind": "boundary",
        "runtime_kind": runtime,
        "session_key": session_key,
        "session_id": session_id,
        "trace_id": trace_id,
        "last_used": last_used,
    }


def test_build_graph_3layer_orphan_boundary_does_not_split_session():
    """Regression: a single Codex session that emits a session-start/end marker
    with a NULL trace_id (orphan bucket) plus a real Bash tool call must render
    as ONE agent node — not the tool-bearing run AND a phantom 'orphan:codex'
    node. The boundary's recency folds into the real session."""
    raw = [
        # The real run: one Bash call with a derived trace_id.
        _row3("codex", "6c254e055afd", "Bash", 1, allowed=1,
              last_used="2026-06-06 16:45:17", session_id="019e9dd2", trace_id="6c254e055afd"),
        # The lifecycle markers landed in the orphan bucket (legacy NULL
        # session_id), slightly LATER than the Bash call.
        _boundary_row("codex", "orphan:codex", "2026-06-06 16:45:25"),
    ]
    g = build_graph_3layer(raw, window_days=7, now=_NOW)

    sessions = [n for n in g["nodes"] if n["kind"] == "session" and n["harness"] == "codex"]
    tools = [n for n in g["nodes"] if n["kind"] == "tool"]

    # Exactly ONE codex agent node — no orphan:codex phantom.
    assert len(sessions) == 1
    assert sessions[0]["id"] == "session:6c254e055afd"
    assert not any("orphan:codex" in s["id"] for s in sessions)
    # Boundary sentinels never become tool nodes.
    assert not any(t["tool_id"] in ("__session_start__", "__session_end__") for t in tools)
    assert all("orphan:codex" not in t["id"] for t in tools)
    # The session's recency advances to the latest boundary timestamp.
    assert sessions[0]["last_used"] == "2026-06-06 16:45:25"
    # One codex harness with exactly one session.
    codex_harness = next(n for n in g["nodes"] if n["kind"] == "harness" and n["label"] == "codex")
    assert codex_harness["sessions"] == 1


def test_build_graph_3layer_boundary_only_session_still_appears():
    """A run that logged only a session-start/end (no tool call yet) but carries
    a real trace_id still surfaces as a tool-less session node so its existence
    and recency are visible on the map."""
    raw = [
        _boundary_row("codex", "deadbeef", "2026-06-05 17:30:00",
                      session_id="sess-x", trace_id="deadbeef"),
    ]
    g = build_graph_3layer(raw, window_days=7, now=_NOW)
    sessions = {n["id"]: n for n in g["nodes"] if n["kind"] == "session"}
    assert "session:deadbeef" in sessions
    assert sessions["session:deadbeef"]["tools"] == 0
    assert sessions["session:deadbeef"]["last_used"] == "2026-06-05 17:30:00"
    # No tool nodes / no session-tool edges for a boundary-only session.
    assert not any(n["kind"] == "tool" for n in g["nodes"])
    assert not any(e["tier"] == "session-tool" for e in g["edges"])


def test_build_graph_3layer_truncates_top_n(monkeypatch):
    import securevector.app.server.routes.graph as graph_mod

    monkeypatch.setattr(graph_mod, "_EDGE_CAP_3L", 2)
    raw = [
        _row3("claude-code", f"s{i}", f"srv:tool_{i}", calls=i, allowed=i) for i in range(5)
    ]
    g = graph_mod.build_graph_3layer(raw, window_days=7, now=_NOW)
    assert g["truncated"] is True
    assert g["dropped_edges"] == 3
    # only the 2 highest-volume session-tool edges survive
    st = [e for e in g["edges"] if e["tier"] == "session-tool"]
    assert len(st) == 2
    assert {e["calls"] for e in st} == {4, 3}


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


@pytest.mark.asyncio
async def test_repo_session_graph_excludes_boundary_markers_from_tools(tmp_path):
    """Regression (one-session-two-nodes bug): a Codex session that logs a
    session-start/end sentinel WITHOUT a session_id (NULL trace_id) plus a real
    Bash call must yield ONE tool-bearing session edge and a SEPARATE boundary
    roll-up — never a __session_* tool edge — so the route renders one agent
    node, not two."""
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    # Lifecycle markers: legacy behaviour forwarded no session_id → NULL trace.
    await repo.log_tool_call_audit("__session_start__", "__session_start__", "log_only",
                                   runtime_kind="codex")
    await repo.log_tool_call_audit("Bash", "Bash", "allow",
                                   runtime_kind="codex", session_id="codex-sess-1")
    await repo.log_tool_call_audit("__session_end__", "__session_end__", "log_only",
                                   runtime_kind="codex")

    rows = await repo.get_agent_session_graph(window_days=7)
    edge_rows = [r for r in rows if r.get("row_kind") == "edge"]
    boundary_rows = [r for r in rows if r.get("row_kind") == "boundary"]

    # The tool layer contains ONLY the real Bash edge — no sentinel tool edges.
    assert {r["tool_id"] for r in edge_rows} == {"Bash"}
    assert not any(r["tool_id"] in ("__session_start__", "__session_end__") for r in edge_rows)
    # The boundary sentinels are rolled up into the orphan:codex bucket.
    assert len(boundary_rows) == 1
    assert boundary_rows[0]["session_key"] == "orphan:codex"

    # End-to-end through the builder: exactly one codex session node.
    g = build_graph_3layer(rows, window_days=7)
    codex_sessions = [n for n in g["nodes"] if n["kind"] == "session" and n["harness"] == "codex"]
    assert len(codex_sessions) == 1
    assert not any(
        n["kind"] == "tool" and n["tool_id"] in ("__session_start__", "__session_end__")
        for n in g["nodes"]
    )

    await db.disconnect()


@pytest.mark.asyncio
async def test_repo_session_graph_groups_by_runtime_session_and_tool(tmp_path):
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)

    # claude-code has two distinct sessions; codex one. trace_id is derived
    # from (runtime_kind, session_id), so distinct session_ids → distinct runs.
    await repo.log_tool_call_audit("srv:a", "a", "allow", runtime_kind="claude-code", session_id="s1")
    await repo.log_tool_call_audit("srv:a", "a", "allow", runtime_kind="claude-code", session_id="s1")
    await repo.log_tool_call_audit("srv:b", "b", "block", reason="token leak", runtime_kind="claude-code", session_id="s1")
    await repo.log_tool_call_audit("srv:a", "a", "allow", runtime_kind="claude-code", session_id="s2")
    await repo.log_tool_call_audit("srv:a", "a", "allow", runtime_kind="codex", session_id="s3")

    rows = await repo.get_agent_session_graph(window_days=7)
    # one row per (runtime, session, tool)
    by_key = {(r["runtime_kind"], r["session_id"], r["tool_id"]): r for r in rows}

    assert by_key[("claude-code", "s1", "srv:a")]["calls"] == 2
    assert by_key[("claude-code", "s1", "srv:b")]["blocked"] == 1
    assert by_key[("claude-code", "s1", "srv:b")]["touched_secrets"] == 1
    # session s2 is a separate run from s1 even though same runtime + tool
    assert by_key[("claude-code", "s2", "srv:a")]["calls"] == 1
    assert by_key[("codex", "s3", "srv:a")]["calls"] == 1

    # the builder turns these into 2 claude sessions + 1 codex session
    g = build_graph_3layer(rows, window_days=7)
    sessions = [n for n in g["nodes"] if n["kind"] == "session"]
    assert len([s for s in sessions if s["harness"] == "claude-code"]) == 2
    assert len([s for s in sessions if s["harness"] == "codex"]) == 1

    await db.disconnect()
