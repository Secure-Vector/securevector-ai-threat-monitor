"""
OCSF 1.3.0 event encoder + per-destination translators for SIEM export.

Why OCSF:
  AWS Security Lake, CrowdStrike, Splunk, Palo Alto, IBM QRadar are all
  converging on the Open Cybersecurity Schema Framework. Shipping OCSF
  gives the customer's SOC a schema their existing dashboards already
  understand, and it ages better than a home-grown taxonomy.

Two classes cover every event we emit:
  - class 2001  Security Finding      — scan verdict (prompt injection,
                                        PII detection, jailbreak, etc.)
  - class 1007  Process Activity      — tool call audit rows (with the
                                        hash-chain fields in `unmapped`)

`raw_data` is always `null`. Prompts, outputs, matched patterns, and
reasoning text never leave this host, even to the customer's SIEM —
same privacy contract as the cloud forwarder.

Translators (webhook / splunk_hec / datadog / otlp_http) are small pure
functions taking a list of OCSF events and returning
``(body_bytes, content_type, extra_headers)``. Adding a fifth vendor
takes ~20 lines and no SDK dependency.
"""

from __future__ import annotations

import json
import time
from typing import Any, Callable, Optional

OCSF_VERSION = "1.3.0"
PRODUCT_NAME = "SecureVector Local Threat Monitor"
VENDOR_NAME = "SecureVector"

# OCSF severity_id mapping
#   1=Informational 2=Low 3=Medium 4=High 5=Critical 6=Fatal 99=Other
_SEVERITY_TO_ID = {
    "info": 1, "informational": 1,
    "low": 2,
    "medium": 3,
    "high": 4,
    "critical": 5,
}

# OCSF Security Finding activity_id
#   1=Create 2=Update 3=Close 99=Other
_ACTIVITY_CREATE = 1

# OCSF Process Activity activity_id (class 1007)
#   1=Launch 2=Terminate 3=Open 4=Inject 5=Set User ID 6=Set Group ID 99=Other
_PROCESS_LAUNCH = 1


def _now_millis() -> int:
    return int(time.time() * 1000)


def _iso_to_millis(iso: Optional[str]) -> int:
    """Best-effort parse — if we can't parse, fall back to now."""
    if not iso:
        return _now_millis()
    try:
        from datetime import datetime
        # Handle trailing Z or explicit offset
        normalized = iso.replace("Z", "+00:00")
        return int(datetime.fromisoformat(normalized).timestamp() * 1000)
    except Exception:
        return _now_millis()


def _verdict_to_severity_id(verdict: str, threat_score: float) -> int:
    """Map our verdict + threat_score to OCSF severity_id."""
    v = (verdict or "").upper()
    if v == "BLOCK":
        return 5 if threat_score >= 0.9 else 4  # Critical / High
    if v == "REVIEW":
        return 3  # Medium
    if v == "WARN":
        return 2  # Low
    return 1  # Informational (ALLOW shouldn't reach here under threats_only filter)


def _metadata_block() -> dict[str, Any]:
    return {
        "version": OCSF_VERSION,
        "product": {
            "name": PRODUCT_NAME,
            "vendor_name": VENDOR_NAME,
        },
        "log_name": "securevector-local-scan",
    }


def encode_scan_event(payload: dict[str, Any], *, redaction: str = "standard") -> dict[str, Any]:
    """Encode a scan-result payload as an OCSF 2001 Security Finding.

    `redaction`:
      - "standard"  — includes threat_score, rule ids, user/session ids
      - "minimal"   — drops user/session ids; keeps counts and severity
    """
    scan_id = str(payload.get("scan_id") or "")
    verdict = str(payload.get("verdict") or "ALLOW").upper()
    threat_score = float(payload.get("threat_score") or 0.0)
    severity_id = _verdict_to_severity_id(verdict, threat_score)

    finding = {
        "uid": scan_id,
        "title": _finding_title(payload),
        "types": list(payload.get("detected_types") or []) or ["threat_detected"],
    }

    observables = [
        {"type_id": 0, "name": "verdict", "value": verdict},
        {"type_id": 0, "name": "risk_level", "value": str(payload.get("risk_level") or "")},
    ]

    unmapped: dict[str, Any] = {
        "threat_score": threat_score,
        "confidence_score": float(payload.get("confidence_score") or 0.0),
        "detected_items_count": int(payload.get("detected_items_count") or 0),
        "detected_types": list(payload.get("detected_types") or []),
        "ml_status": str(payload.get("ml_status") or ""),
        "scan_duration_ms": float(payload.get("scan_duration_ms") or 0.0),
    }
    if redaction != "minimal":
        if payload.get("conversation_id"):
            unmapped["conversation_id"] = str(payload["conversation_id"])
        if payload.get("model_id"):
            unmapped["model_id"] = str(payload["model_id"])

    return {
        "metadata": _metadata_block(),
        "category_uid": 2,
        "class_uid": 2001,
        "class_name": "Security Finding",
        "activity_id": _ACTIVITY_CREATE,
        "severity_id": severity_id,
        "severity": verdict,
        "time": _iso_to_millis(payload.get("timestamp")),
        "finding": finding,
        "observables": observables,
        "raw_data": None,  # privacy contract — never populated
        "unmapped": unmapped,
    }


def encode_tool_audit_event(payload: dict[str, Any], *, redaction: str = "standard") -> dict[str, Any]:
    """Encode a tool-call-audit row as an OCSF 1007 Process Activity event.

    The hash-chain fields (`seq`, `prev_hash`, `row_hash`) go into
    `unmapped` so the customer's SIEM can verify the chain itself — this
    is what makes the audit log tamper-evident *in the customer's
    infrastructure*, not just locally.
    """
    action = str(payload.get("action") or "").lower()
    risk = str(payload.get("risk") or "").lower()
    severity_id = _SEVERITY_TO_ID.get(risk, 1)
    # "block" decisions are inherently higher-severity than "allow"
    if action == "block" and severity_id < 3:
        severity_id = 3

    process = {
        "name": str(payload.get("function_name") or ""),
        "uid": str(payload.get("tool_id") or ""),
    }

    unmapped: dict[str, Any] = {
        "audit_id": int(payload.get("audit_id") or 0),
        "action": action,
        "risk": risk,
        "is_essential": bool(payload.get("is_essential") or False),
        # Hash-chain witness — lets the SIEM reconstruct the chain and
        # detect tampering even if the local SQLite is later altered.
        "seq": int(payload.get("seq") or 0),
        "prev_hash": payload.get("prev_hash"),
        "row_hash": str(payload.get("row_hash") or ""),
    }
    if redaction == "minimal":
        # Minimal keeps the integrity witness (that's the point) but
        # drops the specific tool identity.
        process = {"name": "redacted", "uid": ""}

    return {
        "metadata": _metadata_block(),
        "category_uid": 1,
        "class_uid": 1007,
        "class_name": "Process Activity",
        "activity_id": _PROCESS_LAUNCH,
        "severity_id": severity_id,
        "time": _iso_to_millis(payload.get("called_at")),
        "process": process,
        "raw_data": None,
        "unmapped": unmapped,
    }


def encode_batch(batch: list[dict[str, Any]], *, redaction: str = "standard") -> list[dict[str, Any]]:
    """Encode a batch of outbox rows into OCSF events, preserving order."""
    out: list[dict[str, Any]] = []
    for row in batch:
        kind = row.get("kind")
        payload = row.get("payload") or {}
        if kind == "scan" or kind == "output_scan":
            out.append(encode_scan_event(payload, redaction=redaction))
        elif kind == "tool_audit":
            out.append(encode_tool_audit_event(payload, redaction=redaction))
        # Unknown kinds are silently dropped — the outbox CHECK constraint
        # should prevent this, so this is pure belt-and-suspenders.
    return out


def _finding_title(payload: dict[str, Any]) -> str:
    verdict = str(payload.get("verdict") or "ALLOW").upper()
    types = payload.get("detected_types") or []
    if types:
        first = str(types[0]).replace("_", " ").title()
        return f"{verdict}: {first}"
    return f"{verdict} decision"


# ---------------------------------------------------------------------------
# Destination translators
#
# Each translator takes (events, forwarder_dict) and returns
# (body_bytes, content_type, extra_headers). They do NOT fetch secrets
# or make HTTP calls — the forwarder service handles that. Keeping them
# pure makes them trivially unit-testable.
# ---------------------------------------------------------------------------


Translator = Callable[
    [list[dict[str, Any]], dict[str, Any]],
    tuple[bytes, str, dict[str, str]],
]


def _t_webhook(events: list[dict[str, Any]], _fwd: dict[str, Any]) -> tuple[bytes, str, dict[str, str]]:
    """Generic HTTPS webhook — JSON array of OCSF events.

    Works with any endpoint that accepts JSON POST: Lambda URLs, Cloudflare
    Workers, custom API routes, Zapier, n8n, Tines, etc.
    """
    body = json.dumps({"events": events, "schema": "ocsf-1.3.0"}, separators=(",", ":"))
    return body.encode("utf-8"), "application/json", {}


def _t_splunk_hec(events: list[dict[str, Any]], _fwd: dict[str, Any]) -> tuple[bytes, str, dict[str, str]]:
    """Splunk HTTP Event Collector — newline-delimited JSON wrapped in
    HEC envelope (``{"event": <ocsf>, "sourcetype": "securevector:ocsf"}``).

    User must target the ``/services/collector/event`` endpoint on their
    HEC host. Auth is via HEC token in the ``Authorization: Splunk <token>``
    header — the forwarder service adds that header using the secret.
    """
    lines: list[str] = []
    for ev in events:
        lines.append(json.dumps({
            "event": ev,
            "sourcetype": "securevector:ocsf",
            "source": "securevector-local",
            "index": "main",
            "time": (ev.get("time") or _now_millis()) / 1000.0,
        }, separators=(",", ":")))
    body = "\n".join(lines)
    # HEC accepts application/json even for NDJSON bodies
    return body.encode("utf-8"), "application/json", {}


def _t_datadog(events: list[dict[str, Any]], _fwd: dict[str, Any]) -> tuple[bytes, str, dict[str, str]]:
    """Datadog Logs intake — JSON array.

    Target URL shape: ``https://http-intake.logs.<site>/api/v2/logs``
    (the customer fills in their datadoghq.com / datadoghq.eu site).
    Auth via ``DD-API-KEY`` header — the forwarder adds that from the
    secret.
    """
    docs: list[dict[str, Any]] = []
    for ev in events:
        docs.append({
            "ddsource": "securevector",
            "service": "securevector-local",
            "hostname": "securevector-agent",
            "ddtags": "schema:ocsf-1.3.0",
            "message": json.dumps(ev, separators=(",", ":")),
        })
    body = json.dumps(docs, separators=(",", ":"))
    return body.encode("utf-8"), "application/json", {}


def _t_otlp_http(events: list[dict[str, Any]], _fwd: dict[str, Any]) -> tuple[bytes, str, dict[str, str]]:
    """OTLP/HTTP logs encoding — minimal handwritten (no otel SDK
    dependency). Target: an OpenTelemetry Collector's ``/v1/logs`` HTTP
    endpoint.

    Body shape:
      { resourceLogs: [ { resource, scopeLogs: [ { scope, logRecords[] } ] } ] }
    """
    log_records: list[dict[str, Any]] = []
    for ev in events:
        log_records.append({
            "timeUnixNano": str(int((ev.get("time") or _now_millis()) * 1_000_000)),
            "severityNumber": _ocsf_severity_to_otel(ev.get("severity_id", 1)),
            "severityText": str(ev.get("severity") or ""),
            "body": {"stringValue": json.dumps(ev, separators=(",", ":"))},
            "attributes": [
                {"key": "ocsf.class_uid", "value": {"intValue": ev.get("class_uid", 0)}},
                {"key": "ocsf.category_uid", "value": {"intValue": ev.get("category_uid", 0)}},
                {"key": "ocsf.schema_version", "value": {"stringValue": OCSF_VERSION}},
            ],
        })

    envelope = {
        "resourceLogs": [{
            "resource": {
                "attributes": [
                    {"key": "service.name", "value": {"stringValue": "securevector-local"}},
                    {"key": "service.version", "value": {"stringValue": "4.0.0"}},
                ],
            },
            "scopeLogs": [{
                "scope": {"name": "securevector.siem", "version": OCSF_VERSION},
                "logRecords": log_records,
            }],
        }],
    }
    body = json.dumps(envelope, separators=(",", ":"))
    return body.encode("utf-8"), "application/json", {}


def _ocsf_severity_to_otel(sev_id: int) -> int:
    """OCSF severity_id (1-6) → OpenTelemetry severityNumber (1-24).
    Pragmatic mapping; both schemas are monotonic."""
    return {1: 5, 2: 9, 3: 13, 4: 17, 5: 21, 6: 23}.get(int(sev_id or 1), 9)


TRANSLATORS: dict[str, Translator] = {
    "webhook": _t_webhook,
    "splunk_hec": _t_splunk_hec,
    "datadog": _t_datadog,
    "otlp_http": _t_otlp_http,
}
