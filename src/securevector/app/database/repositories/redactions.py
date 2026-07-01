"""Repository for the redaction_events audit log.

Backs the local-app Redactions page (sibling to Bill of Tools).

The legal-review intent that drove the PEM redaction feature also drove
the storage posture here: ``redaction_hash`` is SHA-256 of the matched
substring — the raw secret value is NEVER persisted on this table, even
though the table is local-only. Hash-only storage means future SIEM
forwarding "just works" without a redact-the-redaction-log pass, and
auditors can prove a specific match without the underlying secret ever
leaving the device.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Optional

from securevector.app.database.connection import DatabaseConnection

logger = logging.getLogger(__name__)


def hash_matched_substring(matched: str) -> str:
    """SHA-256 hex digest of a matched substring.

    Encoded as ``sha256:<64hex>`` so any future hashing-algorithm change
    is self-describing in the audit log.
    """
    digest = hashlib.sha256(matched.encode("utf-8", errors="replace")).hexdigest()
    return f"sha256:{digest}"


class RedactionsRepository:
    """Read + write access to redaction_events."""

    def __init__(self, db: DatabaseConnection):
        self.db = db

    async def record(
        self,
        *,
        pattern_id: str,
        secret_type: str,
        direction: str,
        redaction_hash: str,
        source_tool: Optional[str] = None,
        source_tool_id: Optional[str] = None,
        request_id: Optional[str] = None,
        runtime_kind: Optional[str] = None,
    ) -> None:
        """Append one redaction event."""
        if direction not in ("outgoing", "incoming", "llm_response"):
            # Fail closed on an unknown direction — don't pollute the
            # CHECK-constrained column.
            logger.warning("redaction event dropped: unknown direction=%r", str(direction).replace("\n", "").replace("\r", ""))
            return
        try:
            await self.db.execute(
                """
                INSERT INTO redaction_events (
                    pattern_id, secret_type, direction,
                    source_tool, source_tool_id, request_id, redaction_hash,
                    runtime_kind
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    pattern_id,
                    secret_type,
                    direction,
                    source_tool,
                    source_tool_id,
                    request_id,
                    redaction_hash,
                    runtime_kind,
                ),
            )
        except Exception as e:  # noqa: BLE001
            # Best-effort: a redaction-log write failure must NEVER block
            # the underlying scan response. Log and move on.
            logger.warning("failed to persist redaction event: %s", e)

    async def list_events(
        self,
        *,
        window_days: int = 7,
        direction: Optional[str] = None,
        secret_type: Optional[str] = None,
        runtime_kind: Optional[str] = None,
        limit: int = 1000,
    ) -> list[dict]:
        """Return recent redaction events, newest first.

        Window is clamped to [1, 365] days. Optional ``direction`` /
        ``secret_type`` / ``runtime_kind`` filters narrow the result set.
        """
        window_days = max(1, min(int(window_days), 365))
        cutoff = f"-{window_days} days"

        where = ["redacted_at >= datetime('now', ?)"]
        params: list = [cutoff]
        if direction in ("outgoing", "incoming", "llm_response"):
            where.append("direction = ?")
            params.append(direction)
        if secret_type:
            where.append("secret_type = ?")
            params.append(secret_type)
        if runtime_kind:
            where.append("runtime_kind = ?")
            params.append(runtime_kind)
        params.append(min(int(limit), 5000))

        sql = (
            "SELECT id, pattern_id, secret_type, direction, source_tool, "
            "source_tool_id, request_id, redaction_hash, redacted_at, runtime_kind "
            "FROM redaction_events "
            f"WHERE {' AND '.join(where)} "
            "ORDER BY id DESC "
            "LIMIT ?"
        )
        rows = await self.db.fetch_all(sql, tuple(params))
        return [dict(r) for r in rows] if rows else []

    async def aggregate(
        self,
        *,
        window_days: int = 7,
    ) -> dict:
        """Return rollup counts for the local Redactions report header.

        Shape:
            {
              "window_days": 7,
              "total": 42,
              "distinct_tools": 9,
              "by_direction":   { "incoming": 12, "outgoing": 27, "llm_response": 3 },
              "by_secret_type": { "PEM private key": 8, "OpenAI sk- key": 16, ... },
            }
        """
        window_days = max(1, min(int(window_days), 365))
        cutoff = f"-{window_days} days"

        total_row = await self.db.fetch_one(
            "SELECT COUNT(*) AS n, COUNT(DISTINCT source_tool_id) AS distinct_tools "
            "FROM redaction_events WHERE redacted_at >= datetime('now', ?)",
            (cutoff,),
        )
        total = int(total_row["n"]) if total_row else 0
        distinct_tools = int(total_row["distinct_tools"] or 0) if total_row else 0

        dir_rows = await self.db.fetch_all(
            "SELECT direction, COUNT(*) AS n FROM redaction_events "
            "WHERE redacted_at >= datetime('now', ?) "
            "GROUP BY direction",
            (cutoff,),
        )
        by_direction = {r["direction"]: int(r["n"]) for r in (dir_rows or [])}

        type_rows = await self.db.fetch_all(
            "SELECT secret_type, COUNT(*) AS n FROM redaction_events "
            "WHERE redacted_at >= datetime('now', ?) "
            "GROUP BY secret_type ORDER BY n DESC",
            (cutoff,),
        )
        by_secret_type = {r["secret_type"]: int(r["n"]) for r in (type_rows or [])}

        runtime_rows = await self.db.fetch_all(
            "SELECT runtime_kind, COUNT(*) AS n FROM redaction_events "
            "WHERE redacted_at >= datetime('now', ?) "
            "GROUP BY runtime_kind ORDER BY n DESC",
            (cutoff,),
        )
        by_runtime = {
            (r["runtime_kind"] or "unknown"): int(r["n"])
            for r in (runtime_rows or [])
        }

        return {
            "window_days": window_days,
            "total": total,
            "distinct_tools": distinct_tools,
            "by_direction": by_direction,
            "by_secret_type": by_secret_type,
            "by_runtime": by_runtime,
        }
