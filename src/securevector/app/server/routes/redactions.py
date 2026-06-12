"""Redactions audit-log API.

Backs the local-app Redactions page (sibling to Bill of Tools under
Agent Activity). Every redaction performed by ``redact_secrets()`` in
the /analyze pipeline lands here. Storage is hash-only — see
RedactionsRepository for the security posture.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.redactions import RedactionsRepository

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/redactions")
async def list_redactions(
    window_days: int = 7,
    direction: Optional[str] = None,
    secret_type: Optional[str] = None,
    runtime_kind: Optional[str] = None,
    limit: int = 1000,
):
    """List recent redaction events (newest first) + a rollup summary.

    Response shape:
        {
          "summary": {
            "window_days": 7,
            "total": 42,
            "distinct_tools": 9,
            "by_direction":   { "incoming": 12, "outgoing": 27, ... },
            "by_secret_type": { "PEM private key": 8, ... }
          },
          "events": [
            { "id": ..., "pattern_id": "...", "secret_type": "...",
              "direction": "...", "source_tool": "...",
              "source_tool_id": "...", "request_id": "...",
              "redaction_hash": "sha256:...", "redacted_at": "..." },
            ...
          ]
        }

    No raw secret values are ever returned — ``redaction_hash`` is a
    SHA-256 of the matched substring, persisted that way.

    Query params:
      - window_days: trailing window in days (1–365, default 7).
      - direction: optional filter — "outgoing" | "incoming" | "llm_response".
      - secret_type: optional human-readable filter (e.g. "PEM private key").
      - limit: row cap on the events list (default 1000, max 5000).
    """
    try:
        db = get_database()
        repo = RedactionsRepository(db)
        summary = await repo.aggregate(window_days=window_days)
        events = await repo.list_events(
            window_days=window_days,
            direction=direction,
            secret_type=secret_type,
            runtime_kind=runtime_kind,
            limit=limit,
        )

        # Detection-source label (Option 2). A secret match is intrinsically a
        # Rule (regex) — Guardian ML doesn't detect credentials. But when the
        # SAME request was independently flagged by the model (e.g. an exfil
        # attempt that carried the secret), the event is Rule+ML, which is a
        # stronger signal worth surfacing. ML-only never applies here. We reuse
        # the request_id ↔ threat correlation built for Agent Runs/Map.
        from securevector.app.database.repositories.custom_tools import (
            CustomToolsRepository,
        )

        det = await CustomToolsRepository(db).get_detection_sources(
            [e.get("request_id") for e in events]
        )
        for ev in events:
            d = det.get(ev.get("request_id"))
            has_ml = bool(d and d.get("source") in ("ml", "rule_ml"))
            ev["detection_source"] = "rule_ml" if has_ml else "rule"
            ev["ml_score"] = d.get("ml_score") if has_ml else None
            # The secret type is the "rule" name for the "Detected by …" tooltip.
            ev["detection_rules"] = [ev["secret_type"]] if ev.get("secret_type") else None

        return {"summary": summary, "events": events}
    except Exception as e:
        logger.error(f"Failed to list redactions: {e}")
        raise HTTPException(status_code=500, detail=str(e))
