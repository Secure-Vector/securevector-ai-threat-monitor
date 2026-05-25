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
            limit=limit,
        )
        return {"summary": summary, "events": events}
    except Exception as e:
        logger.error(f"Failed to list redactions: {e}")
        raise HTTPException(status_code=500, detail=str(e))
