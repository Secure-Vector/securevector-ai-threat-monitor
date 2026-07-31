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

from datetime import datetime, timezone
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

# The 3-layer (harness -> session -> tool) graph fans out wider than the 2-layer
# one (one tool node per session, not one shared per runtime), so it gets a more
# generous cap. Still bounded + reported so nothing is silently hidden.
_EDGE_CAP_3L = 240

# A session whose last activity is within this many days is treated as "active"
# (coloured + animated flow); older ones grey out with an "Nd inactive" note.
_ACTIVE_WITHIN_DAYS = 1

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


@router.get("/graph/agent-session")
async def get_agent_session_graph(
    window_days: int = Query(7, ge=1, le=90),
):
    """Return the 3-layer harness -> agent/session -> tool graph.

    Same enforcement-coloured semantics as ``/graph/agent-tool`` but with the
    session tier added so each agent *run* is its own node. Powers the
    multi-layer Agent Map (radial / tree / mesh topologies). Node kinds:
    ``harness`` (runtime), ``session`` (one agent run; carries ``num`` →
    "agent #N", ``active``, ``idle_days``), and ``tool`` (per-session).
    """
    db = get_database()
    repo = CustomToolsRepository(db)
    raw = await repo.get_agent_session_graph(window_days=window_days)
    # Correlate each session→tool edge back to the threats its calls produced
    # (shared request_id) so the map can badge Rule / ML / Rule+ML. Attached to
    # the raw edge rows; build_graph_3layer copies them onto the edge payload.
    det = await repo.get_edge_detection_sources(window_days=window_days)
    if det:
        for r in raw:
            if r.get("row_kind") == "boundary":
                continue
            d = det.get((r.get("session_key"), r.get("tool_id")))
            if d:
                r["detection_source"] = d["source"]
                r["ml_score"] = d["ml_score"]
                r["detection_rules"] = d["rules"]
                r["ml_agreement"] = d.get("ml_agreement")
                # A correlated secret/leak detection lights the lock badge even
                # when the call was *allowed* (reason=NULL) — the legacy
                # reason-LIKE ``touched_secrets`` heuristic alone can't see a
                # leak caught downstream by /analyze. build_graph_3layer rolls
                # this onto the tool node; the frontend derives the session
                # (agent) lock from any tool that touched a secret.
                if d.get("secret"):
                    r["touched_secrets"] = True
    return build_graph_3layer(raw, window_days)


def _parse_dt(value: Optional[str]) -> Optional[datetime]:
    """Parse a SQLite ``called_at`` string into a UTC-aware datetime, or None."""
    if not value:
        return None
    text = str(value).strip().replace("T", " ")
    if text.endswith("Z"):
        text = text[:-1]
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _max_dt(a: Optional[str], b: Optional[str]) -> Optional[str]:
    """Return the later of two ``called_at`` strings (string compare is safe for
    the fixed ``YYYY-MM-DD HH:MM:SS`` SQLite format)."""
    if a is None:
        return b
    if b is None:
        return a
    return a if a >= b else b


_AGREE_RANK = {"corroborated": 2, "ml_uncertain": 1, "ml_disagrees": 0}
_RANK_AGREE = {2: "corroborated", 1: "ml_uncertain", 0: "ml_disagrees"}


def _merge_detection(node: dict, source, ml_score, rules, ml_agreement=None) -> None:
    """Fold one edge's detection source into a node (tool / session) roll-up.

    A node aggregates several edges, so the combined source is Rule+ML if any
    edge ever brought ML and any ever brought a rule; ml_score is the max; rule
    names are unioned (capped); ml_agreement keeps the BEST tier (a single
    corroborated edge means the node is real). No-op when the edge had no
    detection.
    """
    if not source:
        return
    prev = node.get("detection_source")
    has_ml = source in ("ml", "rule_ml") or prev in ("ml", "rule_ml")
    has_rule = source in ("rule", "rule_ml") or prev in ("rule", "rule_ml")
    node["detection_source"] = "rule_ml" if (has_ml and has_rule) else ("ml" if has_ml else "rule")
    if ml_score is not None:
        node["ml_score"] = ml_score if node.get("ml_score") is None else max(node["ml_score"], ml_score)
    if rules:
        merged = list(dict.fromkeys([*(node.get("detection_rules") or []), *rules]))
        node["detection_rules"] = merged[:5]
    if ml_agreement:
        best = max(_AGREE_RANK.get(node.get("ml_agreement"), -1), _AGREE_RANK.get(ml_agreement, -1))
        if best >= 0:
            node["ml_agreement"] = _RANK_AGREE[best]


def build_graph_3layer(raw: list[dict], window_days: int, now: Optional[datetime] = None) -> dict:
    """Assemble the 3-layer nodes/edges payload from raw per-(harness, session,
    tool) edge rows.

    Pure function (no DB; ``now`` is injectable) so the layering, idle/active
    derivation, per-harness agent numbering and top-N capping are unit-testable.
    Emits two edge tiers — harness->session and session->tool — and three node
    kinds. Tool nodes are per-session (id ``tool:<session_key>:<tool_id>``); the
    renderer dedupes them by ``tool_id`` for the shared-tool mesh topology.
    """
    if now is None:
        now = datetime.now(timezone.utc)

    # Split lifecycle session-boundary roll-ups (row_kind == "boundary") out of
    # the tool-edge stream. Boundary markers (__session_start__ /
    # __session_end__) are NOT tools — they must not become tool nodes nor
    # spawn a second agent node for a session that already has tool calls. They
    # only contribute their session's existence + recency; folded in after the
    # tool layer is built. (Rows without an explicit row_kind are treated as
    # edges, preserving the older shape used by unit tests.)
    boundary_rows = [r for r in raw if r.get("row_kind") == "boundary"]
    edge_raw = [r for r in raw if r.get("row_kind") != "boundary"]

    raw_sorted = sorted(edge_raw, key=lambda r: int(r.get("calls") or 0), reverse=True)
    dropped = max(0, len(raw_sorted) - _EDGE_CAP_3L)
    kept = raw_sorted[:_EDGE_CAP_3L]

    harnesses: dict[str, dict] = {}
    sessions: dict[str, dict] = {}
    tools: dict[str, dict] = {}
    edges: list[dict] = []

    for r in kept:
        runtime = r.get("runtime_kind") or "unknown"
        session_key = r.get("session_key") or f"orphan:{runtime}"
        tool_id = r.get("tool_id") or "unknown"
        calls = int(r.get("calls") or 0)
        blocked = int(r.get("blocked") or 0)
        allowed = int(r.get("allowed") or 0)
        logged = int(r.get("logged") or 0)
        touched = bool(r.get("touched_secrets"))
        cloud_managed = r.get("synced_effect") is not None
        last_used = r.get("last_used")
        last_blocked = r.get("last_blocked")
        risk = _edge_risk(blocked, touched, r.get("recent_risk"))

        harness_id = f"harness:{runtime}"
        session_node_id = f"session:{session_key}"
        tool_node_id = f"tool:{session_key}:{tool_id}"

        edges.append(
            {
                "source": session_node_id,
                "target": tool_node_id,
                "tier": "session-tool",
                "calls": calls,
                "blocked": blocked,
                "allowed": allowed,
                "log_only": logged,
                "outcome": _edge_outcome(blocked, allowed, logged),
                "risk": risk,
                "last_used": last_used,
                "last_blocked": last_blocked,
                "cloud_managed": cloud_managed,
                "touched_secrets": touched,
                "policy_name": r.get("synced_policy_name"),
                "org_name": r.get("synced_org_name"),
                # Detection source rolled up across this edge's calls (None when
                # no call on the edge produced a threat record).
                "detection_source": r.get("detection_source"),
                "ml_score": r.get("ml_score"),
                "detection_rules": r.get("detection_rules"),
                "ml_agreement": r.get("ml_agreement"),
            }
        )

        h = harnesses.setdefault(
            harness_id,
            {
                "id": harness_id,
                "kind": "harness",
                "label": runtime,
                "calls": 0,
                "blocked": 0,
                "sessions": 0,
                "risk": "green",
                "last_used": None,
            },
        )
        h["calls"] += calls
        h["blocked"] += blocked
        h["risk"] = _worst(h["risk"], risk)
        h["last_used"] = _max_dt(h["last_used"], last_used)

        s = sessions.setdefault(
            session_node_id,
            {
                "id": session_node_id,
                "kind": "session",
                "harness": runtime,
                "harness_id": harness_id,
                "session_id": r.get("session_id"),
                "trace_id": r.get("trace_id"),
                "calls": 0,
                "blocked": 0,
                "tools": 0,
                "risk": "green",
                "last_used": None,
            },
        )
        s["calls"] += calls
        s["blocked"] += blocked
        s["risk"] = _worst(s["risk"], risk)
        s["last_used"] = _max_dt(s["last_used"], last_used)

        t = tools.setdefault(
            tool_node_id,
            {
                "id": tool_node_id,
                "kind": "tool",
                "label": r.get("function_name") or tool_id.split(":")[-1],
                "tool_id": tool_id,
                "session_id_node": session_node_id,
                "calls": 0,
                "blocked": 0,
                "cloud_managed": False,
                "touched_secrets": False,
                "last_used": None,
                "last_blocked": None,
                "risk": "green",
            },
        )
        if t["calls"] == 0:
            s["tools"] += 1
        t["calls"] += calls
        t["blocked"] += blocked
        t["cloud_managed"] = t["cloud_managed"] or cloud_managed
        t["touched_secrets"] = t["touched_secrets"] or touched
        t["last_used"] = _max_dt(t["last_used"], last_used)
        t["last_blocked"] = _max_dt(t["last_blocked"], last_blocked)
        t["risk"] = _worst(t["risk"], risk)

        # Roll detection source (Rule / ML / Rule+ML) up to the tool and session
        # nodes — the clickable elements on the map, mirroring touched_secrets.
        det_source = r.get("detection_source")
        det_ml = r.get("ml_score")
        det_rules = r.get("detection_rules")
        det_agree = r.get("ml_agreement")
        _merge_detection(t, det_source, det_ml, det_rules, det_agree)
        _merge_detection(s, det_source, det_ml, det_rules, det_agree)

    # Fold session-boundary recency into the owning session WITHOUT drawing a
    # tool node. A boundary marker (__session_start__ / __session_end__) is a
    # lifecycle signal, not a tool call — so it must never split a single run
    # into a second agent node.
    #
    # Attribution:
    #   * A boundary row that carries a real trace_id (session_key starts with
    #     a hex trace, not "orphan:") maps straight onto its session node — and
    #     creates a tool-less session node if that run logged only a start/end.
    #   * A boundary row in the "orphan:<runtime>" bucket (the legacy case where
    #     the SessionStart/Stop hook never forwarded session_id, so trace_id is
    #     NULL) is merged into that runtime's most-recently-active tool-bearing
    #     session. This is what prevents the phantom "orphan:codex" agent node
    #     that used to appear beside the real run for one Codex session.
    sessions_by_harness_recent: dict[str, list[dict]] = {}
    for s in sessions.values():
        sessions_by_harness_recent.setdefault(s["harness_id"], []).append(s)
    for sess_list in sessions_by_harness_recent.values():
        sess_list.sort(key=lambda s: (s["last_used"] or ""), reverse=True)

    for b in boundary_rows:
        runtime = b.get("runtime_kind") or "unknown"
        session_key = b.get("session_key") or f"orphan:{runtime}"
        last_used = b.get("last_used")
        harness_id = f"harness:{runtime}"
        session_node_id = f"session:{session_key}"

        is_orphan = str(session_key).startswith("orphan:")
        target = sessions.get(session_node_id)

        if target is None and is_orphan:
            # Legacy NULL-session_id markers: attach to this runtime's most
            # recent real session rather than minting a duplicate agent node.
            candidates = sessions_by_harness_recent.get(harness_id) or []
            target = candidates[0] if candidates else None

        if target is not None:
            target["last_used"] = _max_dt(target["last_used"], last_used)
            continue

        # No tool-bearing session to attach to (real trace_id, tool-less run, or
        # an orphan marker for a runtime with no tool calls yet). Surface the
        # session so its existence/recency still shows — but with zero tools.
        if session_node_id in sessions:
            continue
        sessions[session_node_id] = {
            "id": session_node_id,
            "kind": "session",
            "harness": runtime,
            "harness_id": harness_id,
            "session_id": b.get("session_id"),
            "trace_id": b.get("trace_id"),
            "calls": 0,
            "blocked": 0,
            "tools": 0,
            "risk": "green",
            "last_used": last_used,
        }
        harnesses.setdefault(
            harness_id,
            {
                "id": harness_id,
                "kind": "harness",
                "label": runtime,
                "calls": 0,
                "blocked": 0,
                "sessions": 0,
                "risk": "green",
                "last_used": None,
            },
        )
        harnesses[harness_id]["last_used"] = _max_dt(
            harnesses[harness_id]["last_used"], last_used
        )

    # Finalise sessions: idle/active + a GLOBAL "agent #N" numbering. Numbering
    # is global (not per-harness) so every session has a UNIQUE label: on the
    # flat Traces list, per-harness numbering produced three "agent #1"s (one
    # per harness) that were indistinguishable. Global, recency-ordered numbers
    # (newest run = agent #1) stay unique and let the Map and the Traces list
    # cross-reference the same "agent #N".
    all_sessions = sorted(
        sessions.values(), key=lambda s: (s["last_used"] or ""), reverse=True
    )
    for idx, s in enumerate(all_sessions, start=1):
        dt = _parse_dt(s["last_used"])
        idle_days = int((now - dt).total_seconds() // 86400) if dt else None
        s["num"] = idx
        s["label"] = f"agent #{idx}"
        s["idle_days"] = idle_days
        s["active"] = idle_days is not None and idle_days < _ACTIVE_WITHIN_DAYS

    # Per-harness session counts + active flag (numbering is global now; these
    # roll-ups stay per-harness).
    by_harness: dict[str, list[dict]] = {}
    for s in sessions.values():
        by_harness.setdefault(s["harness_id"], []).append(s)
    for harness_id, sess_list in by_harness.items():
        harnesses[harness_id]["sessions"] = len(sess_list)

    # Harness active = any of its sessions active.
    for harness_id, sess_list in by_harness.items():
        harnesses[harness_id]["active"] = any(s["active"] for s in sess_list)

    # Harness->session edges (one per session), carrying the session's roll-up.
    for s in sessions.values():
        edges.append(
            {
                "source": s["harness_id"],
                "target": s["id"],
                "tier": "harness-session",
                "calls": s["calls"],
                "blocked": s["blocked"],
                "allowed": 0,
                "log_only": 0,
                "outcome": "blocked" if s["blocked"] > 0 else "allow",
                "risk": s["risk"],
                "last_used": s["last_used"],
                "active": s["active"],
            }
        )

    return {
        "window_days": window_days,
        "node_cap": _EDGE_CAP_3L,
        "truncated": dropped > 0,
        "dropped_edges": dropped,
        "nodes": list(harnesses.values()) + list(sessions.values()) + list(tools.values()),
        "edges": edges,
    }


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
