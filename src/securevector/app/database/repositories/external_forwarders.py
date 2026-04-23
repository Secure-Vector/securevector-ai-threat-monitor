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
# Three tiers of what a destination receives:
#   - minimal  : severity + class + verdict only (ops dashboards)
#   - standard : + rule metadata, threat_score, hash-chain witness (default)
#   - full     : + raw prompt text, LLM output, matched patterns, full args
# See _SCAN_FIELDS_BY_LEVEL / _TOOL_AUDIT_FIELDS_BY_LEVEL for the exact
# field allow-list at each tier. Enforced at enqueue time.
RedactionLevel = Literal["standard", "minimal", "full"]


# ---------------------------------------------------------------------------
# Allow-lists, tiered by redaction_level. Everything not listed for a given
# level is stripped from the payload BEFORE it lands in the outbox. A
# destination configured at `standard` will never see fields that only
# exist at `full`, even if the scan callsite passed them in.
# ---------------------------------------------------------------------------

# Fields every tier receives — severity summary + device + integrity
_SCAN_MINIMAL = frozenset({
    "scan_id",
    "timestamp",
    "verdict",
    "risk_level",
    "detected_items_count",
    "device_id",
})

# Default "most commonly forwarded" set. Adds threat_score, rule metadata,
# conversation/model ids, scan duration, ml status. No prompt text.
_SCAN_STANDARD = _SCAN_MINIMAL | frozenset({
    "threat_score",
    "confidence_score",
    "detected_types",
    "ml_status",
    "scan_duration_ms",
    "model_id",
    "conversation_id",
})

# Full forensic payload — adds raw prompt text, LLM output, pattern details.
# Opt-in per destination; loud warning in the UI when user selects this.
_SCAN_FULL = _SCAN_STANDARD | frozenset({
    "prompt_text",
    "llm_output",
    "matched_patterns",
})

_SCAN_FIELDS_BY_LEVEL: dict[str, frozenset[str]] = {
    "minimal":  _SCAN_MINIMAL,
    "standard": _SCAN_STANDARD,
    "full":     _SCAN_FULL,
}

# Union of all allowed fields — used for input validation on
# build_scan_payload(). Level-specific redaction happens later at
# enqueue_fanout time, per destination.
_SCAN_ALLOWED = _SCAN_FULL
_OUTPUT_SCAN_ALLOWED = _SCAN_ALLOWED

# Tool-audit tiers follow the same pattern.
_TOOL_AUDIT_MINIMAL = frozenset({
    "audit_id",
    "seq",
    "action",
    "device_id",
})

_TOOL_AUDIT_STANDARD = _TOOL_AUDIT_MINIMAL | frozenset({
    "tool_id",
    "function_name",
    "risk",
    "is_essential",
    "called_at",
    # Integrity witness — only useful when combined with the tool_id it
    # was hashed against, so we keep it in standard (not minimal).
    "prev_hash",
    "row_hash",
})

_TOOL_AUDIT_FULL = _TOOL_AUDIT_STANDARD | frozenset({
    # Full call-site context for forensic triage.
    "args_full",
    "reason_full",
})

_TOOL_AUDIT_FIELDS_BY_LEVEL: dict[str, frozenset[str]] = {
    "minimal":  _TOOL_AUDIT_MINIMAL,
    "standard": _TOOL_AUDIT_STANDARD,
    "full":     _TOOL_AUDIT_FULL,
}

_TOOL_AUDIT_ALLOWED = _TOOL_AUDIT_FULL


def _assert_metadata_only(
    payload: dict[str, Any],
    allowed: Iterable[str],
    *,
    kind: str,
) -> None:
    """Validate the *input* to build_* helpers — anything outside the
    union allow-list is rejected regardless of destination. Per-destination
    stripping (the redaction tier) happens later at enqueue_fanout()."""
    allowed_set = set(allowed)
    extras = sorted(k for k in payload.keys() if k not in allowed_set)
    if extras:
        raise ValueError(
            f"external_forwarders: refusing to enqueue {kind} with forbidden "
            f"field(s) {extras}. Only metadata + opt-in raw_data fields are allowed."
        )


def _redact_for_destination(
    payload: dict[str, Any],
    *,
    kind: str,
    redaction_level: str,
) -> dict[str, Any]:
    """Strip payload fields that are not permitted at this destination's
    redaction_level. Unknown levels fall through to `standard` (fail-safe).
    Returns a NEW dict — never mutates the input."""
    if kind in ("scan", "output_scan"):
        allowed = _SCAN_FIELDS_BY_LEVEL.get(redaction_level, _SCAN_STANDARD)
    else:
        allowed = _TOOL_AUDIT_FIELDS_BY_LEVEL.get(redaction_level, _TOOL_AUDIT_STANDARD)
    return {k: v for k, v in payload.items() if k in allowed and v is not None}


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
    device_id: Optional[str] = None,
    # Optional raw-data fields — only surfaced to destinations whose
    # redaction_level is 'full'. At 'standard'/'minimal' they're stripped
    # by _redact_for_destination before the outbox write.
    prompt_text: Optional[str] = None,
    llm_output: Optional[str] = None,
    matched_patterns: Optional[list[str]] = None,
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
        "device_id": device_id,
        "prompt_text": prompt_text,
        "llm_output": llm_output,
        "matched_patterns": list(matched_patterns) if matched_patterns else None,
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
    device_id: Optional[str] = None,
    # Full-tier only: untruncated args + full policy reason string.
    args_full: Optional[str] = None,
    reason_full: Optional[str] = None,
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
        "args_full": args_full,
        "reason_full": reason_full,
        "prev_hash": prev_hash,
        "row_hash": row_hash,
        "device_id": device_id,
    }
    _assert_metadata_only(payload, _TOOL_AUDIT_ALLOWED, kind="tool_audit")
    return payload


# ---------------------------------------------------------------------------
# Global kill-switch (stored in app_settings.siem_forwarding_enabled, v24)
# ---------------------------------------------------------------------------
#
# Read by the hot-path _siem_enqueue_* helpers before any work. Cached in
# process memory with a short TTL so high-rate callers aren't hitting
# SQLite on every scan/audit. Cache invalidated explicitly by the PUT
# endpoint so a toggle takes effect immediately instead of waiting for TTL.

_SIEM_ENABLED_CACHE: dict[str, object] = {"value": True, "fetched_at": 0.0}
_SIEM_ENABLED_TTL_SEC = 5.0


async def is_siem_forwarding_enabled(db: DatabaseConnection) -> bool:
    """Return the global SIEM forwarding flag. Defaults to True on fresh
    installs; cached briefly to stay off the hot path.

    If the `siem_forwarding_enabled` column doesn't exist (pre-v24 DB in
    a dev environment), fail open — assume enabled. The migration adds
    the column for any real install.
    """
    import time
    now = time.monotonic()
    if (now - float(_SIEM_ENABLED_CACHE["fetched_at"])) < _SIEM_ENABLED_TTL_SEC:
        return bool(_SIEM_ENABLED_CACHE["value"])
    try:
        row = await db.fetch_one(
            "SELECT siem_forwarding_enabled FROM app_settings WHERE id = 1"
        )
        val = bool(row["siem_forwarding_enabled"]) if row and row["siem_forwarding_enabled"] is not None else True
    except Exception:
        # Column doesn't exist yet (pre-v24). Fail open; migration fixes this.
        val = True
    _SIEM_ENABLED_CACHE["value"] = val
    _SIEM_ENABLED_CACHE["fetched_at"] = now
    return val


def invalidate_siem_enabled_cache() -> None:
    """Force next is_siem_forwarding_enabled() call to re-read from DB.
    Called by the PUT endpoint so toggles take effect immediately."""
    _SIEM_ENABLED_CACHE["fetched_at"] = 0.0


async def set_siem_forwarding_enabled(db: DatabaseConnection, enabled: bool) -> None:
    """Write the global flag. Invalidates cache so the change is visible
    to in-flight hot-path callers within one SQLite round-trip."""
    await db.execute(
        "UPDATE app_settings SET siem_forwarding_enabled = ? WHERE id = 1",
        (1 if enabled else 0,),
    )
    invalidate_siem_enabled_cache()


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
        """Validate payload once, then write one outbox row per forwarder,
        with each row's payload stripped to that destination's
        redaction_level. A `standard` destination never sees fields that
        only exist at `full`, even if the caller passed them in.

        Returns the count of rows written.
        """
        # Up-front input validation against the UNION allow-list. Anything
        # beyond the full-tier field set means the caller is trying to
        # shove something that was never whitelisted — hard reject.
        if kind == "scan":
            _assert_metadata_only(payload, _SCAN_ALLOWED, kind=kind)
        elif kind == "output_scan":
            _assert_metadata_only(payload, _OUTPUT_SCAN_ALLOWED, kind=kind)
        elif kind == "tool_audit":
            _assert_metadata_only(payload, _TOOL_AUDIT_ALLOWED, kind=kind)
        else:
            raise ValueError(f"unknown outbox kind: {kind!r}")

        conn = await self.db.connect()
        written = 0
        for fwd in forwarders:
            if not _passes_filter(fwd, kind, payload):
                continue
            # Per-destination redaction: STRIP fields the destination isn't
            # entitled to see, BEFORE the row lands in the outbox. If the
            # outbox is ever dumped mid-flight, a standard-level
            # destination's rows have no prompt text to leak.
            level = str(fwd.get("redaction_level") or "standard")
            redacted = _redact_for_destination(payload, kind=kind, redaction_level=level)
            serialized = json.dumps(redacted, separators=(",", ":"), sort_keys=True)
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
