"""
External SIEM forwarders — config + per-destination outbox.

Tables: `external_forwarders` (v22), `external_forward_outbox` (v23).

Privacy contract (enforced at enqueue)
--------------------------------------
The payload written to the outbox — and therefore every byte that
leaves this machine on the way to the customer's SIEM — contains only
the metadata-only fields in `_ALLOWED_FIELDS` below. It NEVER contains
the prompt text, the LLM output, masked output, matched_pattern,
reviewer_reasoning, or ml_reasoning. Same contract as `cloud_sync.py`.

Fan-out model
-------------
One event at the call site → N outbox rows (one per enabled forwarder
that passes the event filter). Each forwarder drains its own queue,
so a failing Datadog destination never blocks a healthy Splunk one.

Secrets
-------
Never stored in SQLite. The row carries a `secret_ref` (opaque UUID)
that `forwarder_secrets.get_secret()` resolves at send time from a
0o600 file in the app data dir.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Iterable, Literal, Optional

from securevector.app.database.connection import DatabaseConnection
from securevector.app.services import forwarder_secrets

logger = logging.getLogger(__name__)

OutboxKind = Literal["scan", "output_scan", "tool_audit"]
ForwarderKind = Literal["webhook", "splunk_hec", "datadog", "otlp_http"]
EventFilter = Literal["all", "threats_only", "audits_only"]
RedactionLevel = Literal["standard", "minimal"]


# ---------------------------------------------------------------------------
# Allow-lists — tight. Anything not here is forbidden to enqueue.
# ---------------------------------------------------------------------------
_SCAN_ALLOWED = frozenset({
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

_OUTPUT_SCAN_ALLOWED = _SCAN_ALLOWED  # identical shape

_TOOL_AUDIT_ALLOWED = frozenset({
    # metadata-only columns from tool_call_audit
    "audit_id",
    "seq",
    "tool_id",
    "function_name",
    "action",
    "risk",
    "is_essential",
    "called_at",
    # integrity witness — lets the customer's SIEM verify the chain
    "prev_hash",
    "row_hash",
})


def _assert_metadata_only(
    payload: dict[str, Any],
    allowed: Iterable[str],
    *,
    kind: str,
) -> None:
    allowed_set = set(allowed)
    extras = sorted(k for k in payload.keys() if k not in allowed_set)
    if extras:
        raise ValueError(
            f"external_forwarders: refusing to enqueue {kind} with forbidden "
            f"field(s) {extras}. SIEM forwarding is metadata-only by contract."
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
) -> dict[str, Any]:
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
    _assert_metadata_only(payload, _SCAN_ALLOWED, kind="scan")
    return payload


def build_tool_audit_payload(
    *,
    audit_id: int,
    seq: int,
    tool_id: str,
    function_name: str,
    action: str,
    risk: str,
    is_essential: bool,
    called_at: str,
    prev_hash: Optional[str],
    row_hash: str,
) -> dict[str, Any]:
    payload = {
        "audit_id": audit_id,
        "seq": seq,
        "tool_id": tool_id,
        "function_name": function_name,
        "action": action,
        "risk": risk,
        "is_essential": bool(is_essential),
        "called_at": called_at,
        "prev_hash": prev_hash,
        "row_hash": row_hash,
    }
    _assert_metadata_only(payload, _TOOL_AUDIT_ALLOWED, kind="tool_audit")
    return payload


# ---------------------------------------------------------------------------
# Config CRUD
# ---------------------------------------------------------------------------


class ExternalForwardersRepository:
    """CRUD for user-configured SIEM destinations."""

    def __init__(self, db: DatabaseConnection) -> None:
        self.db = db

    async def create(
        self,
        *,
        kind: ForwarderKind,
        name: str,
        url: str,
        secret: Optional[str] = None,
        headers: Optional[dict[str, str]] = None,
        event_filter: EventFilter = "threats_only",
        include_tool_audits: bool = True,
        redaction_level: RedactionLevel = "standard",
        enabled: bool = True,
    ) -> dict[str, Any]:
        if kind not in ("webhook", "splunk_hec", "datadog", "otlp_http"):
            raise ValueError(f"unknown forwarder kind: {kind!r}")
        if not url.lower().startswith("https://") and not url.lower().startswith("http://"):
            # http:// is tolerated for local dev only; the UI layer
            # warns the user when they use it.
            raise ValueError("forwarder URL must be http(s)://")

        secret_ref = forwarder_secrets.save_secret(secret) if secret else None
        headers_json = json.dumps(headers, separators=(",", ":")) if headers else None

        conn = await self.db.connect()
        cursor = await conn.execute(
            """
            INSERT INTO external_forwarders
                (kind, name, url, secret_ref, headers_json,
                 event_filter, include_tool_audits, redaction_level, enabled,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (
                kind, name.strip(), url.strip(), secret_ref, headers_json,
                event_filter, 1 if include_tool_audits else 0, redaction_level,
                1 if enabled else 0,
            ),
        )
        await conn.commit()
        row_id = int(cursor.lastrowid or 0)
        logger.info(f"external_forwarders: created id={row_id} kind={kind} name={name!r}")
        return await self.get(row_id)  # type: ignore[return-value]

    async def update(
        self,
        forwarder_id: int,
        *,
        name: Optional[str] = None,
        url: Optional[str] = None,
        secret: Optional[str] = None,  # None = leave as-is; "" = remove
        headers: Optional[dict[str, str]] = None,
        event_filter: Optional[EventFilter] = None,
        include_tool_audits: Optional[bool] = None,
        redaction_level: Optional[RedactionLevel] = None,
        enabled: Optional[bool] = None,
    ) -> Optional[dict[str, Any]]:
        current = await self.get(forwarder_id)
        if current is None:
            return None

        sets: list[str] = []
        vals: list[Any] = []

        if name is not None:
            sets.append("name = ?")
            vals.append(name.strip())
        if url is not None:
            if not url.lower().startswith(("http://", "https://")):
                raise ValueError("forwarder URL must be http(s)://")
            sets.append("url = ?")
            vals.append(url.strip())
        if secret is not None:
            # "" clears, any other value replaces
            if current["secret_ref"]:
                forwarder_secrets.delete_secret(current["secret_ref"])
            new_ref = forwarder_secrets.save_secret(secret) if secret else None
            sets.append("secret_ref = ?")
            vals.append(new_ref)
        if headers is not None:
            sets.append("headers_json = ?")
            vals.append(json.dumps(headers, separators=(",", ":")) if headers else None)
        if event_filter is not None:
            sets.append("event_filter = ?")
            vals.append(event_filter)
        if include_tool_audits is not None:
            sets.append("include_tool_audits = ?")
            vals.append(1 if include_tool_audits else 0)
        if redaction_level is not None:
            sets.append("redaction_level = ?")
            vals.append(redaction_level)
        if enabled is not None:
            sets.append("enabled = ?")
            vals.append(1 if enabled else 0)

        if not sets:
            return current

        sets.append("updated_at = CURRENT_TIMESTAMP")
        vals.append(forwarder_id)

        conn = await self.db.connect()
        await conn.execute(
            f"UPDATE external_forwarders SET {', '.join(sets)} WHERE id = ?",
            vals,
        )
        await conn.commit()
        return await self.get(forwarder_id)

    async def delete(self, forwarder_id: int) -> bool:
        current = await self.get(forwarder_id)
        if current is None:
            return False
        if current["secret_ref"]:
            forwarder_secrets.delete_secret(current["secret_ref"])
        conn = await self.db.connect()
        # CASCADE drops the matching outbox rows.
        await conn.execute("DELETE FROM external_forwarders WHERE id = ?", (forwarder_id,))
        await conn.commit()
        logger.info(f"external_forwarders: deleted id={forwarder_id}")
        return True

    async def get(self, forwarder_id: int) -> Optional[dict[str, Any]]:
        conn = await self.db.connect()
        cur = await conn.execute(
            "SELECT * FROM external_forwarders WHERE id = ?", (forwarder_id,)
        )
        row = await cur.fetchone()
        return _row_to_dict(row) if row else None

    async def list_all(self) -> list[dict[str, Any]]:
        conn = await self.db.connect()
        cur = await conn.execute(
            "SELECT * FROM external_forwarders ORDER BY id ASC"
        )
        rows = await cur.fetchall()
        return [_row_to_dict(r) for r in rows]

    async def list_active(self) -> list[dict[str, Any]]:
        conn = await self.db.connect()
        cur = await conn.execute(
            "SELECT * FROM external_forwarders WHERE enabled = 1 ORDER BY id ASC"
        )
        rows = await cur.fetchall()
        return [_row_to_dict(r) for r in rows]

    async def mark_success(self, forwarder_id: int) -> None:
        conn = await self.db.connect()
        now = datetime.now(timezone.utc).isoformat()
        await conn.execute(
            """
            UPDATE external_forwarders
               SET last_success_at   = ?,
                   consecutive_fails = 0,
                   last_error        = NULL
             WHERE id = ?
            """,
            (now, forwarder_id),
        )
        await conn.commit()

    async def mark_failure(self, forwarder_id: int, error: str) -> None:
        conn = await self.db.connect()
        now = datetime.now(timezone.utc).isoformat()
        await conn.execute(
            """
            UPDATE external_forwarders
               SET last_failure_at   = ?,
                   consecutive_fails = consecutive_fails + 1,
                   last_error        = ?
             WHERE id = ?
            """,
            (now, error[:500], forwarder_id),
        )
        await conn.commit()


def _row_to_dict(row: Any) -> dict[str, Any]:
    headers: Optional[dict[str, str]] = None
    raw_headers = row["headers_json"]
    if raw_headers:
        try:
            parsed = json.loads(raw_headers)
            if isinstance(parsed, dict):
                headers = parsed
        except Exception:
            pass

    return {
        "id": int(row["id"]),
        "kind": row["kind"],
        "name": row["name"],
        "url": row["url"],
        "secret_ref": row["secret_ref"],
        "has_secret": bool(row["secret_ref"]),
        "headers": headers or {},
        "event_filter": row["event_filter"],
        "include_tool_audits": bool(row["include_tool_audits"]),
        "redaction_level": row["redaction_level"],
        "enabled": bool(row["enabled"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "last_success_at": row["last_success_at"],
        "last_failure_at": row["last_failure_at"],
        "last_error": row["last_error"],
        "consecutive_fails": int(row["consecutive_fails"] or 0),
    }


# ---------------------------------------------------------------------------
# Outbox
# ---------------------------------------------------------------------------


class ExternalForwardOutboxRepository:
    """CRUD over `external_forward_outbox` (per-destination queue)."""

    def __init__(self, db: DatabaseConnection) -> None:
        self.db = db

    async def enqueue_fanout(
        self,
        kind: OutboxKind,
        payload: dict[str, Any],
        *,
        forwarders: Iterable[dict[str, Any]],
    ) -> int:
        """Validate payload once and write one outbox row per forwarder that
        passes its event_filter. Returns number of rows written."""
        if kind == "scan":
            _assert_metadata_only(payload, _SCAN_ALLOWED, kind=kind)
        elif kind == "output_scan":
            _assert_metadata_only(payload, _OUTPUT_SCAN_ALLOWED, kind=kind)
        elif kind == "tool_audit":
            _assert_metadata_only(payload, _TOOL_AUDIT_ALLOWED, kind=kind)
        else:
            raise ValueError(f"unknown outbox kind: {kind!r}")

        serialized = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        conn = await self.db.connect()
        written = 0
        for fwd in forwarders:
            if not _passes_filter(fwd, kind, payload):
                continue
            await conn.execute(
                """
                INSERT INTO external_forward_outbox (forwarder_id, kind, payload_json)
                VALUES (?, ?, ?)
                """,
                (int(fwd["id"]), kind, serialized),
            )
            written += 1
        if written:
            await conn.commit()
        return written

    async def next_batch(self, forwarder_id: int, limit: int = 50) -> list[dict[str, Any]]:
        conn = await self.db.connect()
        cur = await conn.execute(
            """
            SELECT id, kind, payload_json, attempts, created_at
              FROM external_forward_outbox
             WHERE forwarder_id = ?
               AND delivered_at IS NULL
             ORDER BY id ASC
             LIMIT ?
            """,
            (forwarder_id, limit),
        )
        rows = await cur.fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            try:
                payload = json.loads(r["payload_json"])
            except Exception:
                payload = {}
            out.append({
                "id": int(r["id"]),
                "kind": r["kind"],
                "payload": payload,
                "attempts": int(r["attempts"] or 0),
                "created_at": r["created_at"],
            })
        return out

    async def mark_delivered(self, ids: Iterable[int]) -> int:
        ids = list(ids)
        if not ids:
            return 0
        placeholders = ",".join("?" * len(ids))
        conn = await self.db.connect()
        now = datetime.now(timezone.utc).isoformat()
        await conn.execute(
            f"UPDATE external_forward_outbox "
            f"   SET delivered_at = ? "
            f" WHERE id IN ({placeholders})",
            (now, *ids),
        )
        await conn.commit()
        return len(ids)

    async def mark_failed(self, ids: Iterable[int], error: str) -> None:
        ids = list(ids)
        if not ids:
            return
        placeholders = ",".join("?" * len(ids))
        conn = await self.db.connect()
        await conn.execute(
            f"UPDATE external_forward_outbox "
            f"   SET attempts = attempts + 1, last_error = ? "
            f" WHERE id IN ({placeholders})",
            (error[:500], *ids),
        )
        await conn.commit()

    async def drop_exceeded(self, forwarder_id: int, max_attempts: int = 10) -> int:
        """Drop rows that have exceeded max attempts. Returns count removed.

        We accept data loss rather than growing the queue forever — the
        forwarder health view surfaces consecutive_fails so operators see
        the destination is broken. Mirrors cloud_sync's posture.
        """
        conn = await self.db.connect()
        cur = await conn.execute(
            """
            DELETE FROM external_forward_outbox
             WHERE forwarder_id = ?
               AND delivered_at IS NULL
               AND attempts >= ?
            """,
            (forwarder_id, max_attempts),
        )
        await conn.commit()
        return int(cur.rowcount or 0)

    async def purge_delivered(self, keep_days: int = 7) -> int:
        conn = await self.db.connect()
        cur = await conn.execute(
            "DELETE FROM external_forward_outbox "
            "WHERE delivered_at IS NOT NULL "
            "  AND delivered_at < datetime('now', ?)",
            (f"-{int(keep_days)} days",),
        )
        await conn.commit()
        return int(cur.rowcount or 0)

    async def pending_count(self, forwarder_id: Optional[int] = None) -> int:
        conn = await self.db.connect()
        if forwarder_id is None:
            cur = await conn.execute(
                "SELECT COUNT(*) AS n FROM external_forward_outbox WHERE delivered_at IS NULL"
            )
        else:
            cur = await conn.execute(
                "SELECT COUNT(*) AS n FROM external_forward_outbox "
                "WHERE delivered_at IS NULL AND forwarder_id = ?",
                (forwarder_id,),
            )
        row = await cur.fetchone()
        return int(row["n"]) if row else 0


def _passes_filter(fwd: dict[str, Any], kind: str, payload: dict[str, Any]) -> bool:
    """Does this event pass the forwarder's event_filter + per-kind toggles?"""
    event_filter = fwd.get("event_filter", "threats_only")
    include_audits = bool(fwd.get("include_tool_audits", True))

    if kind == "tool_audit":
        if event_filter == "threats_only":
            return False
        return include_audits

    # scan or output_scan
    if event_filter == "audits_only":
        return False
    if event_filter == "threats_only":
        verdict = (payload.get("verdict") or "").upper()
        # Anything other than ALLOW counts as a threat — matches how the
        # scan engine classifies verdicts.
        return verdict not in ("", "ALLOW")
    return True  # 'all'
