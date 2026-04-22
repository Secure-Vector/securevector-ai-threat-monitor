"""
Metadata-only cloud sync — local → cloud forwarding (v21).

Purpose
-------
When Cloud Mode is ON (see app_settings.cloud_mode_enabled) the local
SecureVector App enqueues a metadata-only record of each local scan into
`cloud_sync_outbox`. A background forwarder drains the outbox and POSTs
each payload to the cloud ingestion endpoint with at-least-once delivery.

Privacy contract (honest, enforced at write time)
-------------------------------------------------
The payload written to the outbox — and therefore every byte that leaves
this machine — contains ONLY metadata-only fields:

    scan_id, timestamp, verdict, threat_score, confidence_score,
    risk_level, detected_items_count, detected_types[],
    ml_status, scan_duration_ms, model_id, conversation_id,
    source='local-app'

It NEVER contains the prompt, the LLM output, the masked output,
matched_pattern, reviewer_reasoning, or ml_reasoning.

The `build_scan_payload(...)` helper is the single choke point that
assembles these dicts — any change to what ships off-host has to go
through it. Callers pass only the whitelist fields.

Design: at-least-once, local durability
---------------------------------------
- Row inserted into outbox → `created_at = now`, `attempts = 0`,
  `delivered_at = NULL`.
- Forwarder reads oldest pending batch (`delivered_at IS NULL`), POSTs.
- On 2xx: `mark_delivered(ids)` sets `delivered_at = now`.
- On transient error (network, 5xx): `mark_failed(id, error)` increments
  `attempts` and records `last_error`. Rows remain pending so the next
  poll retries.
- Periodic `purge_delivered(days=7)` keeps the table bounded.

Ordering: rows are polled in id-order, delivered in id-order, but
at-least-once — the cloud ingestor must de-dupe by (source, scan_id).
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Iterable, Literal, Optional

from securevector.app.database.connection import DatabaseConnection

logger = logging.getLogger(__name__)

OutboxKind = Literal["scan_result", "output_scan", "audit_event"]


# ---------------------------------------------------------------------------
# Allow-lists: the exact fields that are permitted to leave this machine.
# Keep these tight — anything not here is treated as forbidden.
# ---------------------------------------------------------------------------
_SCAN_RESULT_ALLOWED_FIELDS = frozenset({
    "scan_id",
    "timestamp",
    "verdict",
    "threat_score",
    "confidence_score",
    "risk_level",
    "detected_items_count",
    "detected_types",
    "ml_status",
    "scan_duration_ms",
    "model_id",
    "conversation_id",
})

_OUTPUT_SCAN_ALLOWED_FIELDS = _SCAN_RESULT_ALLOWED_FIELDS  # identical shape

_AUDIT_EVENT_ALLOWED_FIELDS = frozenset({
    # metadata-only fields from tool_call_audit
    "seq",
    "action",
    "risk",
    "is_essential",
    "called_at",
    # integrity witness — lets the cloud rebuild the chain
    "prev_hash",
    "row_hash",
})


def _assert_metadata_only(
    payload: dict,
    allowed: Iterable[str],
    *,
    kind: str,
) -> None:
    """Refuse to enqueue anything that carries a field outside the allow-list.

    Raises:
        ValueError if `payload` has any key not in `allowed`.
    """
    allowed_set = set(allowed)
    extras = sorted(k for k in payload.keys() if k not in allowed_set)
    if extras:
        raise ValueError(
            f"cloud_sync: refusing to enqueue {kind} payload with forbidden "
            f"field(s): {extras}. Only metadata-only fields may be forwarded; "
            f"prompt/output/reasoning/pattern text is never transmitted."
        )


def build_scan_payload(
    *,
    scan_id: str,
    timestamp: str,
    verdict: str,
    threat_score: float,
    confidence_score: float,
    risk_level: str,
    detected_items_count: int,
    detected_types: list[str],
    ml_status: str,
    scan_duration_ms: float,
    model_id: Optional[str] = None,
    conversation_id: Optional[str] = None,
) -> dict:
    """Assemble a metadata-only scan-result payload. The ONLY entry point
    for populating the cloud_sync_outbox for scans."""
    payload = {
        "scan_id": scan_id,
        "timestamp": timestamp,
        "verdict": verdict,
        "threat_score": threat_score,
        "confidence_score": confidence_score,
        "risk_level": risk_level,
        "detected_items_count": detected_items_count,
        "detected_types": list(detected_types or []),
        "ml_status": ml_status,
        "scan_duration_ms": scan_duration_ms,
        "model_id": model_id,
        "conversation_id": conversation_id,
    }
    _assert_metadata_only(payload, _SCAN_RESULT_ALLOWED_FIELDS, kind="scan_result")
    return payload


class CloudSyncRepository:
    """CRUD over `cloud_sync_outbox`."""

    def __init__(self, db: DatabaseConnection):
        self.db = db

    async def enqueue(self, kind: OutboxKind, payload: dict) -> int:
        """Validate + insert one metadata-only payload. Returns the row id."""
        if kind == "scan_result":
            _assert_metadata_only(payload, _SCAN_RESULT_ALLOWED_FIELDS, kind=kind)
        elif kind == "output_scan":
            _assert_metadata_only(payload, _OUTPUT_SCAN_ALLOWED_FIELDS, kind=kind)
        elif kind == "audit_event":
            _assert_metadata_only(payload, _AUDIT_EVENT_ALLOWED_FIELDS, kind=kind)
        else:
            raise ValueError(f"cloud_sync: unknown kind {kind!r}")

        conn = await self.db.connect()
        cursor = await conn.execute(
            """
            INSERT INTO cloud_sync_outbox (kind, payload_json)
            VALUES (?, ?)
            """,
            (kind, json.dumps(payload, separators=(",", ":"), sort_keys=True)),
        )
        await conn.commit()
        row_id = cursor.lastrowid
        logger.debug(f"cloud_sync: enqueued {kind} id={row_id}")
        return int(row_id) if row_id is not None else 0

    async def next_batch(self, limit: int = 50) -> list[dict]:
        """Read up to `limit` pending rows (oldest first)."""
        conn = await self.db.connect()
        cursor = await conn.execute(
            """
            SELECT id, kind, payload_json, attempts, created_at
            FROM cloud_sync_outbox
            WHERE delivered_at IS NULL
            ORDER BY id ASC
            LIMIT ?
            """,
            (limit,),
        )
        rows = await cursor.fetchall()
        out = []
        for r in rows:
            try:
                payload = json.loads(r["payload_json"])
            except Exception:
                payload = {}
            out.append({
                "id": r["id"],
                "kind": r["kind"],
                "payload": payload,
                "attempts": r["attempts"],
                "created_at": r["created_at"],
            })
        return out

    async def mark_delivered(self, ids: Iterable[int]) -> int:
        """Mark a set of rows as delivered (delivered_at = now). Returns count."""
        ids = list(ids)
        if not ids:
            return 0
        placeholders = ",".join("?" * len(ids))
        conn = await self.db.connect()
        now_iso = datetime.now(timezone.utc).isoformat()
        await conn.execute(
            f"UPDATE cloud_sync_outbox SET delivered_at = ? WHERE id IN ({placeholders})",
            (now_iso, *ids),
        )
        await conn.commit()
        return len(ids)

    async def mark_failed(self, row_id: int, error: str) -> None:
        """Bump attempts + record last_error on a transient failure."""
        conn = await self.db.connect()
        await conn.execute(
            """
            UPDATE cloud_sync_outbox
               SET attempts   = attempts + 1,
                   last_error = ?
             WHERE id = ?
            """,
            (error[:500], row_id),
        )
        await conn.commit()

    async def purge_delivered(self, keep_days: int = 7) -> int:
        """Drop rows that were successfully delivered more than N days ago.
        Keeps the outbox table bounded. Returns rows removed."""
        conn = await self.db.connect()
        cursor = await conn.execute(
            "DELETE FROM cloud_sync_outbox "
            "WHERE delivered_at IS NOT NULL "
            "  AND delivered_at < datetime('now', ?)",
            (f"-{int(keep_days)} days",),
        )
        await conn.commit()
        return int(cursor.rowcount or 0)

    async def pending_count(self) -> int:
        """Current number of pending outbox rows."""
        conn = await self.db.connect()
        cursor = await conn.execute(
            "SELECT COUNT(*) AS n FROM cloud_sync_outbox WHERE delivered_at IS NULL"
        )
        row = await cursor.fetchone()
        return int(row["n"]) if row else 0

    async def stats(self) -> dict[str, Any]:
        """Quick stats for the /api/cloud-sync/status route."""
        conn = await self.db.connect()
        cur = await conn.execute(
            """
            SELECT
                SUM(CASE WHEN delivered_at IS NULL THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered,
                SUM(attempts)                                         AS total_attempts,
                MAX(delivered_at)                                     AS last_delivered_at
            FROM cloud_sync_outbox
            """
        )
        row = await cur.fetchone()
        return {
            "pending": int(row["pending"] or 0),
            "delivered": int(row["delivered"] or 0),
            "total_attempts": int(row["total_attempts"] or 0),
            "last_delivered_at": row["last_delivered_at"],
        }
