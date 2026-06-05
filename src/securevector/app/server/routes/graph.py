"""Agent–Tool Live Graph route (story #143).

Read-only aggregation that turns the flat tool_call_audit log into a network
node map: **agent nodes** (the runtime that emitted the calls) connected by
**edges** to **tool / MCP nodes** they invoked. Edges are colored by
enforcement outcome (allow / log_only / blocked) — something a pure
observability tool cannot draw, because the verdict only exists where there is
an enforcement layer.

Pure read over existing tables (tool_call_audit + synced_tool_rules); no
migration, no writes. The frontend Agent Map page renders the returned
nodes/edges as a hand-rolled force-directed SVG.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Query

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.custom_tools import CustomToolsRepository

router = APIRouter()

# Cap how many edges (and therefore nodes) we return so the force-directed
# renderer stays responsive on a busy device. Edges are taken top-N by call
# volume; anything dropped is surfaced via `truncated` + `dropped_edges` so
# the UI never silently hides traffic.
_EDGE_CAP = 60

# tool_call_audit.risk values that warrant an amber "watch" ring even when the
# call was allowed (no block fired).
_HIGH_RISK = {"delete", "admin", "write"}


def _edge_risk(blocked: int, touched_secrets: bool, recent_risk: Optional[str]) -> str:
    """Map an edge's enforcement signals to a traffic-light ring color."""
    if blocked > 0:
        return "red"
    if touched_secrets or (recent_risk or "").lower() in _HIGH_RISK:
        return "amber"
    return "green"


def _edge_outcome(blocked: int, allowed: int, logged: int) -> str:
    if blocked > 0:
        return "blocked"
    if logged > 0 and allowed == 0:
        return "log_only"
    return "allow"


def _worst(a: str, b: str) -> str:
    """Return the higher-severity of two ring colors."""
    order = {"green": 0, "amber": 1, "red": 2}
    return a if order.get(a, 0) >= order.get(b, 0) else b


@router.get("/graph/agent-tool")
async def get_agent_tool_graph(
    window_days: int = Query(7, ge=1, le=90),
):
    """Return the agent→tool graph for the trailing ``window_days``.

    Response shape::

        {
          "window_days": 7,
          "node_cap": 60,
          "truncated": false,
          "dropped_edges": 0,
          "nodes": [
            {"id": "agent:claude-code", "kind": "agent", "label": "claude-code",
             "calls": 42, "blocked": 3, "risk": "red"},
            {"id": "tool:server-x:tool_a", "kind": "tool", "label": "tool_a",
             "tool_id": "server-x:tool_a", "calls": 10, "blocked": 0,
             "cloud_managed": true, "touched_secrets": false, "risk": "green"}
          ],
          "edges": [
            {"source": "agent:claude-code", "target": "tool:server-x:tool_a",
             "calls": 10, "blocked": 2, "allowed": 8, "log_only": 0,
             "outcome": "blocked", "risk": "red", "last_used": "...",
             "cloud_managed": true, "touched_secrets": false,
             "policy_name": null, "org_name": null}
          ]
        }
    """
    db = get_database()
    repo = CustomToolsRepository(db)
    raw = await repo.get_agent_tool_graph(window_days=window_days)
    return build_graph(raw, window_days)


def build_graph(raw: list[dict], window_days: int) -> dict:
    """Assemble the nodes/edges payload from raw per-(agent,tool) edge rows.

    Pure function (no DB) so the graph semantics — outcome coloring, risk-ring
    roll-up, top-N capping — are unit-testable in isolation.
    """
    # Top-N by volume so the renderer stays responsive; report what we dropped.
    raw_sorted = sorted(raw, key=lambda r: int(r.get("calls") or 0), reverse=True)
    dropped = max(0, len(raw_sorted) - _EDGE_CAP)
    kept = raw_sorted[:_EDGE_CAP]

    agents: dict[str, dict] = {}
    tools: dict[str, dict] = {}
    edges: list[dict] = []

    for r in kept:
        runtime = r.get("runtime_kind") or "unknown"
        tool_id = r.get("tool_id") or "unknown"
        calls = int(r.get("calls") or 0)
        blocked = int(r.get("blocked") or 0)
        allowed = int(r.get("allowed") or 0)
        logged = int(r.get("logged") or 0)
        touched = bool(r.get("touched_secrets"))
        cloud_managed = r.get("synced_effect") is not None
        risk = _edge_risk(blocked, touched, r.get("recent_risk"))

        agent_node_id = f"agent:{runtime}"
        tool_node_id = f"tool:{tool_id}"

        edges.append(
            {
                "source": agent_node_id,
                "target": tool_node_id,
                "calls": calls,
                "blocked": blocked,
                "allowed": allowed,
                "log_only": logged,
                "outcome": _edge_outcome(blocked, allowed, logged),
                "risk": risk,
                "last_used": r.get("last_used"),
                "cloud_managed": cloud_managed,
                "touched_secrets": touched,
                "policy_name": r.get("synced_policy_name"),
                "org_name": r.get("synced_org_name"),
            }
        )

        a = agents.setdefault(
            agent_node_id,
            {
                "id": agent_node_id,
                "kind": "agent",
                "label": runtime,
                "calls": 0,
                "blocked": 0,
                "risk": "green",
            },
        )
        a["calls"] += calls
        a["blocked"] += blocked
        a["risk"] = _worst(a["risk"], risk)

        t = tools.setdefault(
            tool_node_id,
            {
                "id": tool_node_id,
                "kind": "tool",
                "label": r.get("function_name") or tool_id.split(":")[-1],
                "tool_id": tool_id,
                "calls": 0,
                "blocked": 0,
                "cloud_managed": False,
                "touched_secrets": False,
                "risk": "green",
            },
        )
        t["calls"] += calls
        t["blocked"] += blocked
        t["cloud_managed"] = t["cloud_managed"] or cloud_managed
        t["touched_secrets"] = t["touched_secrets"] or touched
        t["risk"] = _worst(t["risk"], risk)

    return {
        "window_days": window_days,
        "node_cap": _EDGE_CAP,
        "truncated": dropped > 0,
        "dropped_edges": dropped,
        "nodes": list(agents.values()) + list(tools.values()),
        "edges": edges,
    }
