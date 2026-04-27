"""
Replay timeline endpoint.

Bundle 0.4 — Agent Replay Timeline. Local-first observability wedge.

Merges three already-tracked event streams into a single
time-sorted feed for the per-agent Replay page:

  - Threat scans       (threat_intel.list)
  - Tool-call audits   (CustomToolsRepository.get_audit_log)
  - LLM cost records   (CostsRepository.list_records)

The agent identifier across the three streams is unified to a single
``agent`` field — the source-of-truth varies per stream:

  - threat_intel  → ``source_identifier`` (agent / project name passed
                    by the SDK on /analyze)
  - tool_audit    → ``tool_id`` (best proxy until we add a real
                    agent_id column to tool_call_audit)
  - cost_records  → ``agent_id`` (already explicit)

Output is intentionally lean: each row is a single timeline entry with
a discriminating ``kind`` and a small ``summary`` that the UI can
render without following sub-links. Full detail per row is fetched
lazily by the existing per-stream endpoints (/api/threat-intel/{id},
etc.) when the operator clicks to expand.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.costs import CostsRepository
from securevector.app.database.repositories.custom_tools import CustomToolsRepository
from securevector.app.database.repositories.threat_intel import ThreatIntelRepository

logger = logging.getLogger(__name__)
router = APIRouter()


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        # accept both "2026-04-26T00:00:00Z" and "2026-04-26T00:00:00+00:00"
        v = value.replace("Z", "+00:00")
        dt = datetime.fromisoformat(v)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def _to_iso(value: Any) -> Optional[str]:
    """Normalise to ISO-with-T so string-sort matches chronological order.

    The three event streams store timestamps in different forms:
      - threat_intel.created_at  -> ISO with 'T' separator
      - llm_cost_records.created_at -> ISO with 'T' separator
      - tool_call_audit.called_at -> SQLite CURRENT_TIMESTAMP, 'YYYY-MM-DD HH:MM:SS'
                                     with a SPACE between date and time.

    Plain string sort puts ' ' (0x20) before 'T' (0x54), so a newer
    space-formatted tool-audit timestamp sorts BEFORE an older T-formatted
    scan timestamp. Normalise on the way out so the merge sort behaves.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    s = str(value)
    # Convert "YYYY-MM-DD HH:MM:SS" -> "YYYY-MM-DDTHH:MM:SS" without
    # disturbing already-normalised ISO strings (which carry no space
    # before the time component).
    if len(s) >= 19 and s[10] == ' ':
        s = s[:10] + 'T' + s[11:]
    return s


@router.get("/replay/timeline")
async def get_replay_timeline(
    agent: Optional[str] = Query(None, description="Filter to one agent / source identifier"),
    since: Optional[str] = Query(None, description="ISO timestamp lower bound (UTC)"),
    until: Optional[str] = Query(None, description="ISO timestamp upper bound (UTC)"),
    limit: int = Query(200, ge=1, le=1000),
    include_kinds: Optional[str] = Query(
        None,
        description="Comma-separated subset of kinds to include (scan,tool_audit,cost). Default: all three.",
    ),
) -> dict[str, Any]:
    """Merged, time-sorted event feed for the Replay page.

    Returns up to ``limit`` rows from each underlying stream (so the merged
    feed has up to 3 × limit candidates), then sorts by timestamp DESC and
    truncates to ``limit``. This is intentionally lossy at large fleets —
    the Replay UI is for inspection, not for export. SIEM Forwarder is the
    durable export path.
    """
    db = get_database()
    threat_repo = ThreatIntelRepository(db)
    costs_repo = CostsRepository(db)
    tools_repo = CustomToolsRepository(db)

    start_dt = _parse_iso(since)
    end_dt = _parse_iso(until)

    kinds = {k.strip() for k in (include_kinds or "scan,tool_audit,cost").split(",") if k.strip()}
    valid = {"scan", "tool_audit", "cost"}
    kinds = kinds & valid
    if not kinds:
        kinds = valid

    rows: list[dict[str, Any]] = []

    # ---- threat scans ----
    if "scan" in kinds:
        try:
            tpage = await threat_repo.list(
                page=1,
                page_size=min(limit, 100),
                source=agent,
                start_date=start_dt,
                end_date=end_dt,
            )
            for it in (tpage.items or []) if hasattr(tpage, "items") else []:
                # tpage is a dataclass-ish object; fall through to dict-like access
                pass
            # ThreatIntelPage may be either dataclass or dict; handle both.
            items = getattr(tpage, "items", None) or (tpage.get("items") if isinstance(tpage, dict) else [])
            for item in items:
                # Item may be ThreatIntelItem / dataclass; coerce to dict
                d = item.__dict__ if hasattr(item, "__dict__") else dict(item)
                ts = d.get("created_at")
                rows.append({
                    "kind": "scan",
                    "timestamp": _to_iso(ts),
                    "agent": d.get("source_identifier") or "unknown",
                    "severity": (
                        "block" if (d.get("risk_score") or 0) >= 80 else
                        "high"  if (d.get("risk_score") or 0) >= 60 else
                        "medium" if (d.get("risk_score") or 0) >= 40 else
                        "low"
                    ),
                    "summary": (
                        f"{d.get('threat_type') or 'scan'}"
                        f" · risk {d.get('risk_score', 0)}"
                        f" · {(d.get('text_preview') or '')[:80]}"
                    ).strip(),
                    "id": d.get("id"),
                    "details_endpoint": f"/api/threat-intel/{d.get('id')}" if d.get("id") else None,
                })
        except Exception as e:
            logger.warning(f"replay: threat-intel slice failed: {e}")

    # ---- tool-call audits ----
    if "tool_audit" in kinds:
        try:
            entries, _total = await tools_repo.get_audit_log(limit=min(limit, 200), offset=0)
            for entry in entries:
                d = entry if isinstance(entry, dict) else dict(entry)
                ts = d.get("called_at")
                ts_dt = _parse_iso(ts) if isinstance(ts, str) else (ts if isinstance(ts, datetime) else None)
                if start_dt and ts_dt and ts_dt < start_dt:
                    continue
                if end_dt and ts_dt and ts_dt > end_dt:
                    continue
                tool_id = d.get("tool_id") or d.get("function_name") or "unknown"
                if agent and tool_id != agent:
                    continue
                action = (d.get("action") or "").lower()
                rows.append({
                    "kind": "tool_audit",
                    "timestamp": _to_iso(ts),
                    "agent": tool_id,
                    "severity": (
                        "block" if action == "block" else
                        "medium" if action == "log_only" else
                        "low"
                    ),
                    "summary": (
                        f"{d.get('function_name') or tool_id}"
                        f" · {action}"
                        f" · {(d.get('reason') or '')[:80]}"
                    ).strip(),
                    "id": d.get("id"),
                    "details_endpoint": "/api/tool-permissions/call-audit",
                })
        except Exception as e:
            logger.warning(f"replay: tool-audit slice failed: {e}")

    # ---- LLM cost records ----
    if "cost" in kinds:
        try:
            records, _total = await costs_repo.list_records(
                agent_id=agent,
                start=start_dt,
                end=end_dt,
                page=1,
                page_size=min(limit, 200),
            )
            for r in records:
                d = r if isinstance(r, dict) else (r.__dict__ if hasattr(r, "__dict__") else dict(r))
                ts = d.get("created_at") or d.get("recorded_at")
                rows.append({
                    "kind": "cost",
                    "timestamp": _to_iso(ts),
                    "agent": d.get("agent_id") or "unknown",
                    "severity": "info",
                    "summary": (
                        f"{d.get('provider') or 'unknown'}"
                        f"/{d.get('model_id') or 'unknown'}"
                        f" · ${float(d.get('total_cost_usd') or 0):.4f}"
                        f" · {int(d.get('input_tokens') or 0)}+{int(d.get('output_tokens') or 0)} tok"
                    ),
                    "id": d.get("id"),
                    "details_endpoint": f"/api/costs/records/{d.get('id')}" if d.get("id") else None,
                })
        except Exception as e:
            logger.warning(f"replay: cost slice failed: {e}")

    # ---- merge + sort + cap ----
    def _ts_key(row: dict[str, Any]) -> str:
        return row.get("timestamp") or ""
    rows.sort(key=_ts_key, reverse=True)
    rows = rows[:limit]

    # Distinct agents present in the result — useful for the UI's filter chip.
    distinct_agents = sorted({r["agent"] for r in rows if r.get("agent")})

    return {
        "items": rows,
        "total": len(rows),
        "agents": distinct_agents,
        "filters": {
            "agent": agent,
            "since": _to_iso(start_dt),
            "until": _to_iso(end_dt),
            "kinds": sorted(kinds),
        },
    }
