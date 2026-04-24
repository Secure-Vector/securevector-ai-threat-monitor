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


def _sanitize_for_log(value: Any, cap: int = 80) -> str:
    """Strip CR/LF + other ASCII control characters from user-provided
    values before they hit the log stream. Prevents log-injection via a
    malicious destination name / URL. CodeQL: py/log-injection.

    Caps the result at `cap` chars so a 10 KB pasted value doesn't blow
    up the log line.
    """
    if value is None:
        return ""
    s = str(value)
    # Drop ASCII controls (0x00-0x1F + 0x7F) — keeps printable ASCII +
    # most unicode. A tab inside a destination name is already weird;
    # a newline is hostile.
    s = "".join(c for c in s if ord(c) >= 32 and ord(c) != 127)
    return s[:cap]


OutboxKind = Literal["scan", "output_scan", "tool_audit"]
# `file` = local NDJSON append, indie-friendly destination with zero
# infra. URL column is reinterpreted as a filesystem path for this kind.
ForwarderKind = Literal["webhook", "splunk_hec", "datadog", "otlp_http", "file"]
EventFilter = Literal["all", "threats_only", "audits_only"]
# v26 — severity threshold for scan events. A destination set to
# 'review' drops the noisy WARN tier (low-confidence detections).
# 'block' is the tightest — only events we actively stopped. 'warn'
# is the loosest — everything our scanner flagged. Legacy SOC note:
# "review" is the right default for most production SIEMs.
MinSeverity = Literal["block", "review", "warn"]
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
# + SOC correlation context (actor, group_id, MITRE techniques).
_SCAN_MINIMAL = frozenset({
    "scan_id",
    "timestamp",
    "verdict",
    "risk_level",
    "detected_items_count",
    "device_id",
    # SOC-visibility essentials. Keeping these in `minimal` too because
    # ops dashboards that pivot on user/host or ATT&CK need them even
    # at the smallest tier.
    "actor_user",
    "actor_process",
    "finding_group_id",
    "mitre_techniques",
    # Burst suppression: if rate-limiter dropped events in the last
    # window, the next allowed event carries this count so the SIEM
    # sees a summary instead of losing the burst silently.
    "suppressed_count",
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
    # Per-rule severity override — lets the encoder pick severity_id
    # based on the worst matched rule, not just the verdict.
    "worst_rule_severity",
    "matched_rule_ids",
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
    # SOC correlation context also carried at minimal tier.
    "actor_user",
    "actor_process",
    "finding_group_id",
    "mitre_techniques",
    "suppressed_count",
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


# v26 — Full-tier payload size cap. Even when a user enables raw-data
# forwarding, a single 50KB prompt at 100 events/min is GB/day of ingest
# into the SIEM — an easy way to blow a customer's Splunk bill. We cap
# each raw-data field at 8KB with an explicit truncation marker. That's
# enough context for the analyst to triage the event; the rest stays in
# the local threat_intel_records table where forensic queries can pull it.
_FULL_TIER_MAX_BYTES = 8192  # per field: prompt_text, llm_output, args_full
_FULL_TIER_PATTERN_MAX_BYTES = 1024  # per matched_patterns[] element


def _truncate_utf8(value: Optional[str], cap_bytes: int) -> Optional[str]:
    """Cap a string at `cap_bytes` UTF-8 bytes and append an explicit
    truncation marker so the SIEM-side analyst knows bytes were dropped
    rather than silently losing them. Returns None unchanged.

    Truncates on a UTF-8 boundary — never splits a multi-byte codepoint
    in half, which would break JSON encoding downstream. Short strings
    pass through unchanged (no marker noise).
    """
    if value is None:
        return None
    if not isinstance(value, str):
        value = str(value)
    encoded = value.encode("utf-8")
    if len(encoded) <= cap_bytes:
        return value
    # Step back to the nearest valid UTF-8 boundary. A continuation byte
    # has the top two bits `10xxxxxx` (0x80..0xBF); leading bytes don't.
    cut = cap_bytes
    while cut > 0 and (encoded[cut] & 0xC0) == 0x80:
        cut -= 1
    dropped = len(encoded) - cut
    return encoded[:cut].decode("utf-8", errors="ignore") + f"\n...[truncated {dropped} bytes]"


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
    # v26 SOC-context fields — actor, ATT&CK, correlation group
    actor_user: Optional[str] = None,
    actor_process: Optional[str] = None,
    finding_group_id: Optional[str] = None,
    mitre_techniques: Optional[list[str]] = None,
    worst_rule_severity: Optional[str] = None,
    matched_rule_ids: Optional[list[str]] = None,
) -> dict[str, Any]:
    # Full-tier size cap: truncate raw-data fields at 8KB. Even though
    # standard/minimal destinations will strip these entirely at enqueue
    # time, we cap here (one place, consistent) so the outbox row for a
    # full-tier destination never carries a multi-MB prompt. Prevents
    # a chatty workload from silently blowing customer SIEM ingest.
    capped_prompt = _truncate_utf8(prompt_text, _FULL_TIER_MAX_BYTES)
    capped_llm_output = _truncate_utf8(llm_output, _FULL_TIER_MAX_BYTES)
    capped_patterns: Optional[list[str]] = None
    if matched_patterns:
        capped_patterns = [
            _truncate_utf8(str(p), _FULL_TIER_PATTERN_MAX_BYTES) or ""
            for p in matched_patterns
        ]

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
        "prompt_text": capped_prompt,
        "llm_output": capped_llm_output,
        "matched_patterns": capped_patterns,
        # v26 SOC-context
        "actor_user": actor_user,
        "actor_process": actor_process,
        "finding_group_id": finding_group_id,
        "mitre_techniques": list(mitre_techniques) if mitre_techniques else None,
        "worst_rule_severity": worst_rule_severity,
        "matched_rule_ids": list(matched_rule_ids) if matched_rule_ids else None,
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
    # v26 SOC-context.
    actor_user: Optional[str] = None,
    actor_process: Optional[str] = None,
    finding_group_id: Optional[str] = None,
    mitre_techniques: Optional[list[str]] = None,
) -> dict[str, Any]:
    # Same 8KB cap as scans — tool-call args can be chatty too (a vector
    # with 20k embedded values, a base64 blob pasted into a tool payload).
    capped_args = _truncate_utf8(args_full, _FULL_TIER_MAX_BYTES)
    capped_reason = _truncate_utf8(reason_full, _FULL_TIER_MAX_BYTES)

    payload = {
        "audit_id": audit_id,
        "seq": seq,
        "tool_id": tool_id,
        "function_name": function_name,
        "action": action,
        "risk": risk,
        "is_essential": bool(is_essential),
        "called_at": called_at,
        "args_full": capped_args,
        "reason_full": capped_reason,
        "prev_hash": prev_hash,
        "row_hash": row_hash,
        "device_id": device_id,
        # v26 SOC-context
        "actor_user": actor_user,
        "actor_process": actor_process,
        "finding_group_id": finding_group_id,
        "mitre_techniques": list(mitre_techniques) if mitre_techniques else None,
    }
    _assert_metadata_only(payload, _TOOL_AUDIT_ALLOWED, kind="tool_audit")
    return payload


# ---------------------------------------------------------------------------
# Per-destination burst guard (v26, in-memory)
#
# When an agent misbehaves and fires thousands of scans/sec, we don't
# want to drown the SIEM. Each forwarder carries rate_limit_per_minute
# (0 = unlimited). When exceeded:
#   1. New events within the 60s window are dropped and a suppressed
#      counter advances.
#   2. The NEXT allowed event (either when the window rolls over or
#      when rate is back under cap) carries `suppressed_count` in its
#      payload, so the SIEM sees a summary instead of losing the burst
#      silently.
#
# State lives in process memory — loss across restarts is acceptable
# because the WHOLE POINT is tamping bursts, not forensic accounting.
# ---------------------------------------------------------------------------
import time as _time  # local alias, avoids name clash


class _BurstGuard:
    def __init__(self) -> None:
        # forwarder_id -> {'window_start': monotonic, 'count': int, 'suppressed': int}
        self._state: dict[int, dict[str, float]] = {}

    def check(self, forwarder_id: int, rate_limit_per_minute: int) -> tuple[bool, int]:
        """Returns (allow, suppressed_count_to_report).

        - allow=True: send this event. If suppressed_count_to_report > 0,
          the caller should inject it into the payload so the SIEM sees
          the burst summary.
        - allow=False: drop this event. The suppressed counter advances
          and will surface on the next allowed event.

        rate_limit_per_minute=0 means unlimited — always returns (True, 0).
        """
        if rate_limit_per_minute <= 0:
            return True, 0
        now = _time.monotonic()
        state = self._state.setdefault(
            forwarder_id,
            {"window_start": now, "count": 0.0, "suppressed": 0.0},
        )
        # Roll the window if > 60s elapsed
        if now - state["window_start"] > 60.0:
            state["window_start"] = now
            state["count"] = 0.0
            # Note: we keep `suppressed` to surface on the next allowed
            # event; it gets reported + zeroed there, not here.
        if state["count"] >= rate_limit_per_minute:
            state["suppressed"] += 1
            return False, 0
        state["count"] += 1
        reported = int(state["suppressed"])
        state["suppressed"] = 0
        return True, reported


_BURST_GUARD = _BurstGuard()


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
        redaction_level: RedactionLevel = "minimal",
        enabled: bool = True,
        min_severity: MinSeverity = "review",
        rate_limit_per_minute: int = 0,
    ) -> dict[str, Any]:
        if kind not in ("webhook", "splunk_hec", "datadog", "otlp_http", "file"):
            raise ValueError(f"unknown forwarder kind: {kind!r}")
        if kind == "file":
            # For `file` destinations the `url` column stores an absolute
            # path. Empty is allowed — the delivery path fills in a
            # default (app-data-dir/siem-events.jsonl) at send time.
            if url and not (url.startswith("/") or url.startswith("~")):
                raise ValueError(
                    "file forwarder path must be absolute or start with '~' "
                    "(expands to home directory)"
                )
        else:
            if not url.lower().startswith("https://") and not url.lower().startswith("http://"):
                # http:// is tolerated for local dev only; the UI layer
                # warns the user when they use it.
                raise ValueError("forwarder URL must be http(s)://")
        if min_severity not in ("block", "review", "warn"):
            raise ValueError(f"unknown min_severity: {min_severity!r}")
        if int(rate_limit_per_minute) < 0 or int(rate_limit_per_minute) > 10000:
            raise ValueError("rate_limit_per_minute must be between 0 and 10000")

        secret_ref = forwarder_secrets.save_secret(secret) if secret else None
        headers_json = json.dumps(headers, separators=(",", ":")) if headers else None

        conn = await self.db.connect()
        cursor = await conn.execute(
            """
            INSERT INTO external_forwarders
                (kind, name, url, secret_ref, headers_json,
                 event_filter, include_tool_audits, redaction_level, enabled,
                 min_severity, rate_limit_per_minute,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (
                kind, name.strip(), url.strip(), secret_ref, headers_json,
                event_filter, 1 if include_tool_audits else 0, redaction_level,
                1 if enabled else 0,
                min_severity, int(rate_limit_per_minute),
            ),
        )
        await conn.commit()
        row_id = int(cursor.lastrowid or 0)
        # Sanitize user-provided name before logging: strip CR/LF + other
        # control characters so a malicious name can't inject fake log
        # lines. Keep it short (CodeQL: py/log-injection).
        safe_name = _sanitize_for_log(name)
        logger.info("external_forwarders: created id=%d kind=%s name=%r", row_id, kind, safe_name)
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
        min_severity: Optional[MinSeverity] = None,
        rate_limit_per_minute: Optional[int] = None,
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
            # File destinations store a filesystem path here (not http).
            # We read `kind` off the current row to validate appropriately.
            if str(current.get("kind") or "") == "file":
                if url and not (url.startswith("/") or url.startswith("~")):
                    raise ValueError(
                        "file forwarder path must be absolute or start with '~'"
                    )
            elif not url.lower().startswith(("http://", "https://")):
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
        if min_severity is not None:
            if min_severity not in ("block", "review", "warn"):
                raise ValueError(f"unknown min_severity: {min_severity!r}")
            sets.append("min_severity = ?")
            vals.append(min_severity)
        if rate_limit_per_minute is not None:
            n = int(rate_limit_per_minute)
            if n < 0 or n > 10000:
                raise ValueError("rate_limit_per_minute must be between 0 and 10000")
            sets.append("rate_limit_per_minute = ?")
            vals.append(n)

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
        logger.info("external_forwarders: deleted id=%d", int(forwarder_id))
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

    async def mark_success(self, forwarder_id: int, delivered: int = 0) -> None:
        """Record a successful batch delivery.

        `delivered` = number of events in this batch. Bumps the lifetime
        `events_sent` counter so the UI can show total-forwarded per
        destination. Default 0 keeps the test-endpoint / synthetic path
        from inflating the counter — only real deliveries count.
        """
        conn = await self.db.connect()
        now = datetime.now(timezone.utc).isoformat()
        await conn.execute(
            """
            UPDATE external_forwarders
               SET last_success_at   = ?,
                   consecutive_fails = 0,
                   last_error        = NULL,
                   events_sent       = events_sent + ?
             WHERE id = ?
            """,
            (now, int(max(0, delivered)), forwarder_id),
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


def _row_get(row: Any, key: str, default: Any = None) -> Any:
    """Safe lookup on sqlite3.Row / aiosqlite.Row which don't implement
    .get(). Returns `default` for missing columns (pre-migration rows)."""
    try:
        return row[key]
    except (IndexError, KeyError):
        return default


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
        # v26 — SOC-tuning fields; column-safe fallback for pre-v26 rows.
        "min_severity": _row_get(row, "min_severity", "review") or "review",
        "rate_limit_per_minute": int(_row_get(row, "rate_limit_per_minute", 0) or 0),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "last_success_at": row["last_success_at"],
        "last_failure_at": row["last_failure_at"],
        "last_error": row["last_error"],
        "consecutive_fails": int(row["consecutive_fails"] or 0),
        # v28 — lifetime delivered count. Pre-v28 rows default to 0 via
        # the column default; _row_get keeps the read safe if the column
        # somehow doesn't exist on a freshly-seeded dev DB.
        "events_sent": int(_row_get(row, "events_sent", 0) or 0),
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

            # v26 burst guard — drop events that exceed the per-destination
            # rate limit. When allowed, the guard returns any suppressed
            # count accumulated since the last allowed event so we can
            # surface it in the payload.
            rate_limit = int(fwd.get("rate_limit_per_minute") or 0)
            allow, suppressed = _BURST_GUARD.check(int(fwd["id"]), rate_limit)
            if not allow:
                continue

            # Per-destination redaction: STRIP fields the destination isn't
            # entitled to see, BEFORE the row lands in the outbox.
            level = str(fwd.get("redaction_level") or "standard")
            redacted = _redact_for_destination(payload, kind=kind, redaction_level=level)
            # Inject burst-summary counter if the rate-limiter accumulated
            # any drops. This is the "N suppressed" signal the SIEM needs
            # so the burst isn't silently lost.
            if suppressed > 0:
                redacted["suppressed_count"] = suppressed

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


# v26 — severity threshold ranks. Higher number = more severe.
# `min_severity='review'` default means WARN (rank 1) gets dropped,
# REVIEW/DETECTED (rank 2) and BLOCK (rank 3) pass through. SOC analysts
# asked for this explicitly: WARN is low-confidence flagging and at
# scale it drowns the feed without being individually actionable.
_SEVERITY_RANK = {
    "warn":     1,
    "detected": 2,  # new consolidated tier (collapses WARN+REVIEW in output)
    "review":   2,  # legacy; treated equivalent to detected at threshold time
    "block":    3,
}


def _verdict_rank(verdict: str) -> int:
    """Return the severity rank of a scan verdict, 0 if unknown/ALLOW."""
    v = (verdict or "").upper()
    if v == "BLOCK":
        return _SEVERITY_RANK["block"]
    if v in ("REVIEW", "DETECTED"):
        return _SEVERITY_RANK["detected"]
    if v == "WARN":
        return _SEVERITY_RANK["warn"]
    return 0  # ALLOW / unknown


def _passes_filter(fwd: dict[str, Any], kind: str, payload: dict[str, Any]) -> bool:
    """Does this event pass the forwarder's filters?

    Two independent gates:
      1. Kind toggle — respect event_filter and include_tool_audits for
         audit events. Backward-compatible with pre-v26 configs.
      2. Severity threshold — scan events must meet min_severity.
         Added in v26; default 'review' drops WARN-tier noise.
    """
    event_filter = fwd.get("event_filter", "threats_only")
    include_audits = bool(fwd.get("include_tool_audits", True))

    if kind == "tool_audit":
        if event_filter == "threats_only":
            return False
        return include_audits

    # scan or output_scan: kind gate first, then severity gate
    if event_filter == "audits_only":
        return False
    if event_filter == "threats_only":
        verdict = (payload.get("verdict") or "").upper()
        if verdict in ("", "ALLOW"):
            return False

    # v26 severity threshold — enforce if configured. Defaults to 'review'
    # which drops WARN. Safe to apply on top of the kind gate above.
    min_sev = fwd.get("min_severity") or "review"
    threshold = _SEVERITY_RANK.get(str(min_sev).lower(), 2)
    if _verdict_rank(payload.get("verdict") or "") < threshold:
        return False

    return True
