"""
SIEM forwarder CRUD routes.

Mounted under ``/api``:

    POST   /api/siem-forwarders                 create destination
    GET    /api/siem-forwarders                 list destinations
    GET    /api/siem-forwarders/{id}            get one
    PUT    /api/siem-forwarders/{id}            update (partial)
    DELETE /api/siem-forwarders/{id}            delete (cascades to outbox)
    POST   /api/siem-forwarders/{id}/test       dispatch a synthetic OCSF event
    GET    /api/siem-forwarders/{id}/health     pending-count + last-error view

The endpoint surface is intentionally small. Retries, circuit-breaking
and delivery happen in the background ``ExternalForwarderService``; the
HTTP routes only mutate config and expose status.

Gating: none. Per product decision, SIEM export is free for every user
— monetization is on the rule/ML-analysis side, not the transport.
"""

from __future__ import annotations

import ipaddress
import logging
import socket
from typing import Any, Literal, Optional
from urllib.parse import urlparse, urlunparse

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.external_forwarders import (
    ExternalForwardOutboxRepository,
    ExternalForwardersRepository,
    is_siem_forwarding_enabled,
    set_siem_forwarding_enabled,
)
from securevector.app.services import forwarder_secrets, siem_ocsf

logger = logging.getLogger(__name__)
router = APIRouter()


def _sanitized_http_url(raw: str) -> str:
    """SSRF barrier for the Test-connection endpoint.

    Explicit parse → scheme/host check → link-local + metadata-address
    reject → reconstruct. Link-local (169.254/16) is the classic SSRF
    target (AWS/GCE/Azure metadata), so we hard-block it even though
    other private ranges stay allowed for legitimate on-prem Splunk.
    The reconstruction with urlunparse gives CodeQL a clean barrier
    it can track as a sanitizer boundary.
    """
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="URL must be http(s)")
    host = parsed.hostname
    if not host:
        raise HTTPException(status_code=400, detail="URL missing host")
    try:
        for info in socket.getaddrinfo(host, None):
            addr = info[4][0]
            try:
                ip = ipaddress.ip_address(addr)
            except ValueError:
                continue
            if ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
                raise HTTPException(
                    status_code=400,
                    detail="URL host resolves to a reserved / link-local address",
                )
    except socket.gaierror:
        pass  # DNS may be unavailable in offline dev envs; allow by default
    return urlunparse(parsed)


def _safe_exception_label(e: BaseException) -> str:
    """Return ONLY the exception class name — never the message.

    CodeQL: py/information-exposure-through-an-exception. Previously we
    returned `{type_name}: {sanitized_msg}`, but `str(e)` can carry
    filesystem paths, hostnames, or credential fragments that shouldn't
    reach the API caller. Exception class names come from source code
    (ConnectionError, PermissionError, TimeoutException, etc.) — enough
    for the operator to triage. Full exception + stack lives in server
    logs only, via `logger.warning(..., exc_info=True)` at the callsite.
    """
    return str(type(e).__name__)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


ForwarderKind = Literal["webhook", "splunk_hec", "datadog", "otlp_http", "file"]
EventFilter = Literal["all", "threats_only", "audits_only"]
RedactionLevel = Literal["standard", "minimal", "full"]
# v26 — SOC-tuning. `review` drops WARN-tier noise by default; `block`
# forwards only actively stopped events; `warn` forwards everything the
# scanner flagged.
MinSeverity = Literal["block", "review", "warn"]


class ForwarderCreate(BaseModel):
    kind: ForwarderKind
    name: str = Field(..., min_length=1, max_length=120)
    url: str = Field(..., min_length=8, max_length=2000)
    secret: Optional[str] = Field(
        default=None,
        description="Token/API key. Stored in a 0o600 file, never in SQLite.",
    )
    headers: Optional[dict[str, str]] = None
    event_filter: EventFilter = "threats_only"
    include_tool_audits: bool = True
    # Default to `minimal` — safer posture for new destinations. Ships
    # verdict + attribution + MITRE + device.uid, strips threat_scores
    # / rule_ids / hash-chain. Operators who want the richer SOC payload
    # opt in via the editor dropdown. Rationale: indie operators
    # clicking through defaults shouldn't ship more than they intended.
    redaction_level: RedactionLevel = "minimal"
    enabled: bool = True
    min_severity: MinSeverity = "review"
    rate_limit_per_minute: int = Field(default=0, ge=0, le=10000)

    @field_validator("url")
    @classmethod
    def _url_scheme(cls, v: str) -> str:
        # URL validation is kind-dependent, but Pydantic field_validator
        # can't see sibling fields without model_validator. The repo
        # layer enforces the correct rule per kind — this validator
        # accepts either scheme (http/https) OR a filesystem path so
        # file destinations don't get blocked at the API boundary.
        if v.lower().startswith(("http://", "https://")):
            return v
        if v.startswith("/") or v.startswith("~") or v == "":
            return v
        raise ValueError("URL must be http(s):// or an absolute file path")


class ForwarderUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    url: Optional[str] = Field(None, min_length=8, max_length=2000)
    secret: Optional[str] = Field(
        default=None,
        description="Empty string clears the stored secret; null leaves it alone.",
    )
    headers: Optional[dict[str, str]] = None
    event_filter: Optional[EventFilter] = None
    include_tool_audits: Optional[bool] = None
    redaction_level: Optional[RedactionLevel] = None
    enabled: Optional[bool] = None
    min_severity: Optional[MinSeverity] = None
    rate_limit_per_minute: Optional[int] = Field(default=None, ge=0, le=10000)

    @field_validator("url")
    @classmethod
    def _url_scheme(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        if v.lower().startswith(("http://", "https://")):
            return v
        if v.startswith("/") or v.startswith("~") or v == "":
            return v
        raise ValueError("URL must be http(s):// or an absolute file path")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/siem-forwarders")
async def create_forwarder(req: ForwarderCreate) -> dict[str, Any]:
    db = get_database()
    repo = ExternalForwardersRepository(db)
    try:
        row = await repo.create(
            kind=req.kind,
            name=req.name,
            url=req.url,
            secret=req.secret,
            headers=req.headers,
            event_filter=req.event_filter,
            include_tool_audits=req.include_tool_audits,
            redaction_level=req.redaction_level,
            enabled=req.enabled,
            min_severity=req.min_severity,
            rate_limit_per_minute=req.rate_limit_per_minute,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return row


@router.get("/siem-forwarders")
async def list_forwarders() -> dict[str, Any]:
    db = get_database()
    repo = ExternalForwardersRepository(db)
    outbox = ExternalForwardOutboxRepository(db)
    items = await repo.list_all()
    # Per-destination pending count is cheap and the UI wants it on load.
    for item in items:
        item["pending"] = await outbox.pending_count(int(item["id"]))
    return {"items": items, "total": len(items)}


# ── Global kill-switch (v24) ───────────────────────────────────────────
# MUST be declared BEFORE /siem-forwarders/{forwarder_id} — FastAPI picks
# the first matching route in declaration order. If this were below the
# `{forwarder_id}` route, `global-settings` would be parsed as an int id
# and the request would 422.


class SiemGlobalSettings(BaseModel):
    """Shape of GET/PUT /api/siem-forwarders/global-settings."""

    enabled: bool


@router.get("/siem-forwarders/global-settings", response_model=SiemGlobalSettings)
async def get_global_siem_settings() -> SiemGlobalSettings:
    db = get_database()
    return SiemGlobalSettings(enabled=await is_siem_forwarding_enabled(db))


@router.put("/siem-forwarders/global-settings", response_model=SiemGlobalSettings)
async def set_global_siem_settings(body: SiemGlobalSettings) -> SiemGlobalSettings:
    db = get_database()
    await set_siem_forwarding_enabled(db, body.enabled)
    logger.info(f"SIEM forwarding globally {'enabled' if body.enabled else 'disabled'}")
    return SiemGlobalSettings(enabled=body.enabled)


@router.get("/siem-forwarders/{forwarder_id}")
async def get_forwarder(forwarder_id: int) -> dict[str, Any]:
    db = get_database()
    repo = ExternalForwardersRepository(db)
    row = await repo.get(forwarder_id)
    if row is None:
        raise HTTPException(status_code=404, detail="forwarder not found")
    outbox = ExternalForwardOutboxRepository(db)
    row["pending"] = await outbox.pending_count(forwarder_id)
    return row


@router.put("/siem-forwarders/{forwarder_id}")
async def update_forwarder(forwarder_id: int, req: ForwarderUpdate) -> dict[str, Any]:
    db = get_database()
    repo = ExternalForwardersRepository(db)
    try:
        row = await repo.update(
            forwarder_id,
            name=req.name,
            url=req.url,
            secret=req.secret,
            headers=req.headers,
            event_filter=req.event_filter,
            include_tool_audits=req.include_tool_audits,
            redaction_level=req.redaction_level,
            enabled=req.enabled,
            min_severity=req.min_severity,
            rate_limit_per_minute=req.rate_limit_per_minute,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if row is None:
        raise HTTPException(status_code=404, detail="forwarder not found")
    return row


@router.delete("/siem-forwarders/{forwarder_id}")
async def delete_forwarder(forwarder_id: int) -> dict[str, Any]:
    db = get_database()
    repo = ExternalForwardersRepository(db)
    existed = await repo.delete(forwarder_id)
    if not existed:
        raise HTTPException(status_code=404, detail="forwarder not found")
    return {"ok": True, "id": forwarder_id}


@router.post("/siem-forwarders/{forwarder_id}/test")
async def test_forwarder(forwarder_id: int) -> dict[str, Any]:
    """Dispatch one synthetic OCSF event inline. Returns HTTP status and
    latency so the user sees immediately whether their destination works.

    Does NOT enqueue; this is a direct one-shot POST so the test isn't
    held up behind any real pending traffic.
    """
    db = get_database()
    repo = ExternalForwardersRepository(db)
    fwd = await repo.get(forwarder_id)
    if fwd is None:
        raise HTTPException(status_code=404, detail="forwarder not found")

    try:
        import httpx
    except ImportError:
        raise HTTPException(status_code=500, detail="httpx not installed")

    synth_payload = {
        "scan_id": f"test-{forwarder_id}",
        "timestamp": _now_iso(),
        "verdict": "REVIEW",
        "threat_score": 0.42,
        "confidence_score": 0.8,
        "risk_level": "medium",
        "detected_items_count": 1,
        "detected_types": ["synthetic_test_event"],
        "ml_status": "skipped",
        "scan_duration_ms": 0.0,
        "model_id": None,
        "conversation_id": None,
    }
    event = siem_ocsf.encode_scan_event(synth_payload, redaction=fwd["redaction_level"])

    # File destination: write one line, no HTTP. Same synthetic event is
    # appended to the operator's NDJSON file so they can verify the
    # destination is wired up end-to-end (perms OK, path writable).
    if fwd["kind"] == "file":
        import json as _json
        import os as _os
        import time as _time
        from pathlib import Path as _Path
        raw_path = (fwd.get("url") or "").strip()
        if not raw_path:
            try:
                from securevector.app.utils.platform import user_data_dir
                raw_path = str(_Path(user_data_dir(None, None)) / "siem-events.jsonl")
            except Exception:
                raw_path = str(_Path.home() / ".securevector" / "siem-events.jsonl")
        expanded = _os.path.expanduser(raw_path)
        start = _time.perf_counter()
        try:
            path = _Path(expanded)
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as f:
                f.write(_json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n")
            latency_ms = int((_time.perf_counter() - start) * 1000)
            # Bump events_sent counter — Test writes one real synthetic
            # event, so it's a legitimate delivery for counting purposes.
            await repo.mark_success(forwarder_id, delivered=1)
            return {
                "ok": True,
                "status_code": 200,  # synthetic — no HTTP semantics here
                "latency_ms": latency_ms,
                "response_preview": f"wrote 1 line to {expanded}",
                # File writes ARE verifiable — the event is on disk, not
                # in a remote ingest queue. Honest label reflects that.
                "verified": "written",
                "ack_id": None,
            }
        except Exception as e:
            # Expose ONLY exception type + a short sanitized message —
            # full stack / internal paths stay server-side. The operator
            # needs enough to act (e.g. "PermissionError") without us
            # leaking implementation details into the API response.
            # CodeQL: py/information-exposure-through-an-exception.
            safe_err = _safe_exception_label(e)
            await repo.mark_failure(forwarder_id, f"test: {safe_err}")
            logger.warning("test_forwarder(file) failed", exc_info=True)
            return {
                "ok": False,
                "status_code": 0,
                "latency_ms": int((_time.perf_counter() - start) * 1000),
                "error": safe_err,
                "response_preview": f"write failed: {expanded}",
            }

    translator = siem_ocsf.TRANSLATORS.get(fwd["kind"])
    if translator is None:
        raise HTTPException(status_code=500, detail=f"unknown kind: {fwd['kind']}")

    body, content_type, extra_headers = translator([event], fwd)
    # Inline version of external_forwarder._build_auth_headers — duplicated
    # intentionally so the test path stays out of the background service.
    secret = (
        forwarder_secrets.get_secret(fwd["secret_ref"]) if fwd["secret_ref"] else None
    )
    headers: dict[str, str] = {"Content-Type": content_type}
    headers.update(fwd.get("headers") or {})
    headers.update(extra_headers or {})
    kind = fwd["kind"]
    if kind == "splunk_hec" and not secret:
        raise HTTPException(status_code=400, detail="Splunk HEC token not configured")
    if kind == "datadog" and not secret:
        raise HTTPException(status_code=400, detail="Datadog API key not configured")
    if kind == "splunk_hec":
        headers["Authorization"] = f"Splunk {secret}"
        # Per-request channel is required for Splunk HEC's indexer-ack
        # feature. If the HEC token has acks enabled, the POST response
        # will carry `ackId` which the follow-up /ack call verifies.
        # If acks are off, this header is ignored — harmless.
        import uuid as _uuid
        headers.setdefault("X-Splunk-Request-Channel", str(_uuid.uuid4()))
    elif kind == "datadog":
        headers["DD-API-KEY"] = secret or ""
    elif secret:
        headers.setdefault("Authorization", f"Bearer {secret}")

    import time as _time
    start = _time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(fwd["url"], content=body, headers=headers)
    except Exception as e:
        # Static warning — fwd-derived values omitted from the log arg
        # list so CodeQL's taint tracker can't connect them to any
        # `secret_ref` in the dict. Full exception incl. stack is
        # captured by `exc_info=True` for diagnostic purposes.
        logger.warning("test_forwarder failed", exc_info=True)
        return {
            "ok": False,
            "status_code": 0,
            "latency_ms": int((_time.perf_counter() - start) * 1000),
            "error": _safe_exception_label(e),
        }
    latency_ms = int((_time.perf_counter() - start) * 1000)
    ok = 200 <= resp.status_code < 300
    # Record the test outcome on the config row — keeps the health view honest.
    # Test POSTs one synthetic OCSF event, so it's a real delivery — bump
    # events_sent so the lifetime counter reflects it.
    if ok:
        await repo.mark_success(forwarder_id, delivered=1)
    else:
        await repo.mark_failure(forwarder_id, f"test: HTTP {resp.status_code}")

    # Honest verification status. HTTP 2xx from most SIEM ingest endpoints
    # only proves the bytes were accepted — not that the event became
    # searchable. The most common failure mode for new users is Splunk
    # HEC accepting the payload but dropping it into `_internal` because
    # the sourcetype isn't mapped.
    #
    # When a Splunk HEC response carries an `ackId`, surface it so the
    # user can verify the write on their HEC channel — that's the only
    # built-in Splunk-side proof of indexing. Other vendors don't expose
    # a simple sync ACK, so we explicitly label the test as
    # "accepted, not verified indexed" to avoid false confidence.
    verified = "accepted"  # default: bytes reached the endpoint
    ack_id: Optional[str] = None
    indexing_poll_ms: Optional[int] = None
    if ok and kind == "splunk_hec":
        try:
            body_json = resp.json()
            if isinstance(body_json, dict) and body_json.get("ackId") is not None:
                ack_id = str(body_json.get("ackId"))
                verified = "accepted_with_ack"
        except Exception:
            pass  # best-effort JSON parse of HEC response; absent ackId leaves verified=accepted

        # CISO #3 — verify-back. If HEC returned an ackId, call the
        # ACK endpoint to confirm Splunk actually indexed the event.
        # This closes the "HEC 200 but sourcetype drops the event"
        # failure mode that used to show green in the UI. We poll up
        # to ~3s; if ACK never flips true, surface "pending" — the
        # operator sees the distinction instead of a false green.
        #
        # Splunk's ACK endpoint requires the channel to have been set
        # via the `X-Splunk-Request-Channel` header on the original
        # POST AND acks to be enabled on the HEC token. If the token
        # doesn't have acks enabled, the response won't carry ackId
        # and we'll never reach this branch — test stays "accepted."
        if ack_id is not None:
            ack_url = fwd["url"]
            # Replace /event with /ack per Splunk HEC endpoint shape.
            # Common URLs: /services/collector, /services/collector/event, /services/collector/raw
            for needle in ("/services/collector/event", "/services/collector/raw", "/services/collector"):
                if ack_url.endswith(needle):
                    ack_url = ack_url[:-len(needle)] + "/services/collector/ack"
                    break
            ack_headers = dict(headers)
            ack_headers["Content-Type"] = "application/json"
            ack_start = _time.perf_counter()
            try:
                async with httpx.AsyncClient(timeout=5.0) as ack_client:
                    # Poll up to 3 times @ 1s — ACK lag is typically <1s.
                    ack_payload = {"acks": [int(ack_id)]} if ack_id.isdigit() else {"acks": [ack_id]}
                    for _ in range(3):
                        ack_resp = await ack_client.post(
                            ack_url,
                            json=ack_payload,
                            headers=ack_headers,
                        )
                        if 200 <= ack_resp.status_code < 300:
                            try:
                                ack_json = ack_resp.json()
                                acks_map = (ack_json or {}).get("acks") or {}
                                # Splunk returns {"acks": {"<id>": true/false}}
                                if any(bool(v) for v in acks_map.values()):
                                    verified = "indexed"
                                    break
                            except Exception:
                                pass  # malformed ACK response body; try again on next poll cycle
                        # Not yet acknowledged — back off briefly.
                        import asyncio as _asyncio
                        await _asyncio.sleep(1.0)
                    if verified != "indexed":
                        verified = "pending"
                indexing_poll_ms = int((_time.perf_counter() - ack_start) * 1000)
            except Exception:
                # ACK endpoint unreachable or auth bad — don't flip the
                # main "ok" verdict, just leave verified=accepted_with_ack.
                indexing_poll_ms = int((_time.perf_counter() - ack_start) * 1000)

    return {
        "ok": ok,
        "status_code": resp.status_code,
        "latency_ms": latency_ms,
        "response_preview": (resp.text or "")[:200],
        # v26 + CISO-#3: honesty fields. `verified` is one of:
        #   "accepted"           — HTTP 2xx only (bytes accepted; indexing not proven)
        #   "accepted_with_ack"  — HEC returned an ackId but ACK endpoint wasn't reached
        #   "pending"            — ACK endpoint reached, event not yet acknowledged in 3s
        #   "indexed"            — Splunk ACK endpoint returned acks: true — provably searchable
        #   "written"            — File destination, line written to disk
        "verified": verified,
        "ack_id": ack_id,
        "indexing_poll_ms": indexing_poll_ms,
    }


class ForwarderTestConfig(BaseModel):
    """Pre-save test payload.

    Mirrors ForwarderCreate's fields but accepts a RAW `secret` value
    (not a secret_ref), since at Add/Edit time the secret hasn't been
    written to forwarder_secrets yet. The endpoint does not persist
    anything — runs one synthetic OCSF event against the supplied
    config and returns the same response shape as /{id}/test.
    """

    kind: ForwarderKind
    url: str = Field(..., min_length=1, max_length=2000)
    secret: Optional[str] = None
    headers: Optional[dict[str, str]] = None
    redaction_level: RedactionLevel = "minimal"


@router.post("/siem-forwarders/test-config")
async def test_forwarder_config(req: ForwarderTestConfig) -> dict[str, Any]:
    """Fire one synthetic OCSF event at a destination config without
    saving it — used by the Add/Edit modal's "Test connection" button
    so the operator can validate URL + credentials before committing.

    Intentionally shares delivery logic with /test (same synth event,
    same HTTP path, same Splunk HEC ACK verify-back). Does NOT call
    mark_success / mark_failure, since no DB row exists yet.
    """
    try:
        import httpx
    except ImportError:
        raise HTTPException(status_code=500, detail="httpx not installed")

    fwd = {
        "kind": req.kind,
        "url": req.url,
        "headers": req.headers or {},
        "redaction_level": req.redaction_level,
        # secret_ref not used here; secret is passed separately below.
        "secret_ref": None,
    }

    synth_payload = {
        "scan_id": "test-preflight",
        "timestamp": _now_iso(),
        "verdict": "DETECTED",
        "threat_score": 0.42,
        "confidence_score": 0.8,
        "risk_level": "medium",
        "detected_items_count": 1,
        "detected_types": ["synthetic_test_event"],
        "ml_status": "skipped",
        "scan_duration_ms": 0.0,
        "model_id": None,
        "conversation_id": None,
    }
    event = siem_ocsf.encode_scan_event(synth_payload, redaction=req.redaction_level)

    # File destination branch — write one line, no HTTP.
    if req.kind == "file":
        import json as _json
        import os as _os
        import time as _time
        from pathlib import Path as _Path
        raw_path = (req.url or "").strip()
        if not raw_path:
            try:
                from securevector.app.utils.platform import user_data_dir
                raw_path = str(_Path(user_data_dir(None, None)) / "siem-events.jsonl")
            except Exception:
                raw_path = str(_Path.home() / ".securevector" / "siem-events.jsonl")
        expanded = _os.path.expanduser(raw_path)
        start = _time.perf_counter()
        try:
            path = _Path(expanded)
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as f:
                f.write(_json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n")
            return {
                "ok": True,
                "status_code": 200,
                "latency_ms": int((_time.perf_counter() - start) * 1000),
                "response_preview": f"wrote 1 line to {expanded}",
                "verified": "written",
                "ack_id": None,
            }
        except Exception as e:
            logger.warning("test-config (file) failed", exc_info=True)
            return {
                "ok": False,
                "status_code": 0,
                "latency_ms": int((_time.perf_counter() - start) * 1000),
                "error": _safe_exception_label(e),
                "response_preview": f"write failed: {expanded}",
            }

    # HTTP destinations — translate + POST.
    translator = siem_ocsf.TRANSLATORS.get(req.kind)
    if translator is None:
        raise HTTPException(status_code=500, detail=f"unknown kind: {req.kind}")

    body, content_type, extra_headers = translator([event], fwd)
    headers: dict[str, str] = {"Content-Type": content_type}
    headers.update(fwd.get("headers") or {})
    headers.update(extra_headers or {})

    secret = req.secret
    if req.kind == "splunk_hec" and not secret:
        raise HTTPException(status_code=400, detail="Splunk HEC token is required")
    if req.kind == "datadog" and not secret:
        raise HTTPException(status_code=400, detail="Datadog API key is required")
    if req.kind == "splunk_hec":
        headers["Authorization"] = f"Splunk {secret}"
        import uuid as _uuid
        headers.setdefault("X-Splunk-Request-Channel", str(_uuid.uuid4()))
    elif req.kind == "datadog":
        headers["DD-API-KEY"] = secret or ""
    elif secret:
        headers.setdefault("Authorization", f"Bearer {secret}")

    import time as _time
    safe_url = _sanitized_http_url(req.url)
    start = _time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(safe_url, content=body, headers=headers)
    except Exception as e:
        logger.warning("test-config dispatch failed", exc_info=True)
        return {
            "ok": False,
            "status_code": 0,
            "latency_ms": int((_time.perf_counter() - start) * 1000),
            "error": _safe_exception_label(e),
        }

    latency_ms = int((_time.perf_counter() - start) * 1000)
    ok = 200 <= resp.status_code < 300

    # HEC ACK verify-back (same logic as /test; no mark_success side effect).
    verified = "accepted"
    ack_id: Optional[str] = None
    indexing_poll_ms: Optional[int] = None
    if ok and req.kind == "splunk_hec":
        try:
            body_json = resp.json()
            if isinstance(body_json, dict) and body_json.get("ackId") is not None:
                ack_id = str(body_json.get("ackId"))
                verified = "accepted_with_ack"
        except Exception:
            pass  # absent ackId leaves verified=accepted
        if ack_id is not None:
            ack_url = safe_url
            for needle in ("/services/collector/event", "/services/collector/raw", "/services/collector"):
                if ack_url.endswith(needle):
                    ack_url = ack_url[:-len(needle)] + "/services/collector/ack"
                    break
            safe_ack_url = _sanitized_http_url(ack_url)
            ack_headers = dict(headers)
            ack_headers["Content-Type"] = "application/json"
            ack_start = _time.perf_counter()
            try:
                async with httpx.AsyncClient(timeout=5.0) as ack_client:
                    ack_payload = {"acks": [int(ack_id)]} if ack_id.isdigit() else {"acks": [ack_id]}
                    for _ in range(3):
                        ack_resp = await ack_client.post(safe_ack_url, json=ack_payload, headers=ack_headers)
                        if 200 <= ack_resp.status_code < 300:
                            try:
                                ack_json = ack_resp.json()
                                acks_map = (ack_json or {}).get("acks") or {}
                                if any(bool(v) for v in acks_map.values()):
                                    verified = "indexed"
                                    break
                            except Exception:
                                pass  # malformed ACK body; retry next cycle
                        import asyncio as _asyncio
                        await _asyncio.sleep(1.0)
                    if verified != "indexed":
                        verified = "pending"
                indexing_poll_ms = int((_time.perf_counter() - ack_start) * 1000)
            except Exception:
                indexing_poll_ms = int((_time.perf_counter() - ack_start) * 1000)

    return {
        "ok": ok,
        "status_code": resp.status_code,
        "latency_ms": latency_ms,
        "response_preview": (resp.text or "")[:200],
        "verified": verified,
        "ack_id": ack_id,
        "indexing_poll_ms": indexing_poll_ms,
    }


@router.get("/siem-forwarders/{forwarder_id}/health")
async def forwarder_health(forwarder_id: int) -> dict[str, Any]:
    db = get_database()
    repo = ExternalForwardersRepository(db)
    fwd = await repo.get(forwarder_id)
    if fwd is None:
        raise HTTPException(status_code=404, detail="forwarder not found")
    outbox = ExternalForwardOutboxRepository(db)
    # Same knobs the dispatcher uses — keep in sync with
    # ExternalForwarderService._apply_backoff so the drawer shows the
    # actual wait time, not a guess.
    import os as _os
    breaker_base = 60.0
    breaker_cap = 60.0 * 60.0
    breaker_trip = 5
    max_attempts = int(_os.environ.get("SV_SIEM_MAX_ATTEMPTS", "10"))
    consecutive = int(fwd["consecutive_fails"] or 0)
    backoff_seconds: Optional[int] = None
    if consecutive >= breaker_trip:
        exponent = consecutive - breaker_trip
        backoff_seconds = int(min(breaker_base * (2 ** exponent), breaker_cap))
    return {
        "id": forwarder_id,
        "enabled": fwd["enabled"],
        "pending": await outbox.pending_count(forwarder_id),
        "last_success_at": fwd["last_success_at"],
        "last_failure_at": fwd["last_failure_at"],
        "last_error": fwd["last_error"],
        "consecutive_fails": consecutive,
        "events_sent": int(fwd.get("events_sent") or 0),
        "circuit_open": consecutive >= breaker_trip,
        "backoff_seconds": backoff_seconds,
        "max_attempts": max_attempts,
        "recent_failures": await outbox.recent_failures(forwarder_id, limit=10),
    }


@router.post("/siem-forwarders/{forwarder_id}/reset-breaker")
async def reset_forwarder_breaker(forwarder_id: int) -> dict[str, Any]:
    """Zero the circuit-breaker so the next dispatcher tick retries now.

    Use case: operator fixed a broken destination (corrected URL,
    rotated token) and doesn't want to wait out the exponential
    backoff. Outbox rows keep their `attempts` counter — if the
    underlying issue persists, the breaker will trip again and drops
    still apply via `drop_exceeded(max_attempts=10)`.
    """
    db = get_database()
    repo = ExternalForwardersRepository(db)
    fwd = await repo.get(forwarder_id)
    if fwd is None:
        raise HTTPException(status_code=404, detail="forwarder not found")
    await repo.reset_breaker(forwarder_id)
    return {"ok": True, "id": forwarder_id}


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
