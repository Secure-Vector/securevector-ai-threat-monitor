"""Audit log of rule-only detections the Guardian model cleared.

Mechanism 2 in ``routes/analyze.py`` clears a rule-only verdict when every
firing rule sits in a category the model judges and its P(malicious) is
below the veto bar. Nothing lands in ``threat_intel_records`` for those, so
this table is the only place the decision is visible: the Threats page reads
``summary()`` for its "cleared by Guardian" count, and the rows are what you
tune the bar against.
"""

from __future__ import annotations

import logging
from typing import Optional

from securevector.app.database.connection import DatabaseConnection

logger = logging.getLogger(__name__)


class GuardianClearedRepository:
    """Read + write access to guardian_cleared_events."""

    def __init__(self, db: DatabaseConnection):
        self.db = db

    async def record(
        self,
        *,
        rule_ids: list[str],
        category: Optional[str],
        direction: Optional[str],
        ml_score: float,
        source: Optional[str] = None,
        request_id: Optional[str] = None,
        text_preview: Optional[str] = None,
    ) -> None:
        """Append one cleared detection. Best-effort: never raises."""
        try:
            await self.db.execute(
                """
                INSERT INTO guardian_cleared_events (
                    rule_ids, category, direction, ml_score, source, request_id, text_preview
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    ",".join(rule_ids),
                    category,
                    direction,
                    float(ml_score),
                    source,
                    request_id,
                    (text_preview or "")[:160] or None,
                ),
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("failed to persist guardian cleared event: %s", e)

    async def summary(self, *, window_days: int = 7) -> dict:
        """Counts for the Threats masthead.

        Shape: {"window_days": 7, "total": 12, "by_rule": {rule_id: n},
                "by_direction": {direction: n}}
        """
        window_days = max(1, min(int(window_days), 365))
        cutoff = f"-{window_days} days"
        total_row = await self.db.fetch_one(
            "SELECT COUNT(*) AS n FROM guardian_cleared_events WHERE cleared_at >= datetime('now', ?)",
            (cutoff,),
        )
        rows = await self.db.fetch_all(
            "SELECT rule_ids, direction FROM guardian_cleared_events WHERE cleared_at >= datetime('now', ?)",
            (cutoff,),
        )
        by_rule: dict[str, int] = {}
        by_direction: dict[str, int] = {}
        for r in rows or []:
            for rid in (r["rule_ids"] or "").split(","):
                if rid:
                    by_rule[rid] = by_rule.get(rid, 0) + 1
            d = r["direction"] or "unknown"
            by_direction[d] = by_direction.get(d, 0) + 1
        return {
            "window_days": window_days,
            "total": int(total_row["n"]) if total_row else 0,
            "by_rule": dict(sorted(by_rule.items(), key=lambda kv: -kv[1])),
            "by_direction": by_direction,
        }

    async def list_recent(self, *, limit: int = 50) -> list[dict]:
        rows = await self.db.fetch_all(
            "SELECT id, rule_ids, category, direction, ml_score, source, request_id, text_preview, cleared_at "
            "FROM guardian_cleared_events ORDER BY cleared_at DESC LIMIT ?",
            (max(1, min(int(limit), 500)),),
        )
        return [dict(r) for r in (rows or [])]
