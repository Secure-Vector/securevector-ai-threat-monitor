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

import logging
from typing import Any, Literal, Optional

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
            await repo.mark_success(forwarder_id)
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
            err = f"{type(e).__name__}: {e!s}"
            await repo.mark_failure(forwarder_id, f"test: {err}")
            return {
                "ok": False,
                "status_code": 0,
                "latency_ms": int((_time.perf_counter() - start) * 1000),
                "error": err,
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
        return {
            "ok": False,
            "status_code": 0,
            "latency_ms": int((_time.perf_counter() - start) * 1000),
            "error": f"{type(e).__name__}: {e!s}",
        }
    latency_ms = int((_time.perf_counter() - start) * 1000)
    ok = 200 <= resp.status_code < 300
    # Record the test outcome on the config row — keeps the health view honest.
    if ok:
        await repo.mark_success(forwarder_id)
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
            pass

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
                                pass
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


@router.get("/siem-forwarders/{forwarder_id}/health")
async def forwarder_health(forwarder_id: int) -> dict[str, Any]:
    db = get_database()
    repo = ExternalForwardersRepository(db)
    fwd = await repo.get(forwarder_id)
    if fwd is None:
        raise HTTPException(status_code=404, detail="forwarder not found")
    outbox = ExternalForwardOutboxRepository(db)
    return {
        "id": forwarder_id,
        "enabled": fwd["enabled"],
        "pending": await outbox.pending_count(forwarder_id),
        "last_success_at": fwd["last_success_at"],
        "last_failure_at": fwd["last_failure_at"],
        "last_error": fwd["last_error"],
        "consecutive_fails": fwd["consecutive_fails"],
    }


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
