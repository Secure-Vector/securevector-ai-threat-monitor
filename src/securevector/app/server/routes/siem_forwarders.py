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


ForwarderKind = Literal["webhook", "splunk_hec", "datadog", "otlp_http"]
EventFilter = Literal["all", "threats_only", "audits_only"]
RedactionLevel = Literal["standard", "minimal", "full"]


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
    redaction_level: RedactionLevel = "standard"
    enabled: bool = True

    @field_validator("url")
    @classmethod
    def _url_scheme(cls, v: str) -> str:
        if not v.lower().startswith(("http://", "https://")):
            raise ValueError("URL must start with http:// or https://")
        return v


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

    @field_validator("url")
    @classmethod
    def _url_scheme(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        if not v.lower().startswith(("http://", "https://")):
            raise ValueError("URL must start with http:// or https://")
        return v


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
    return {
        "ok": ok,
        "status_code": resp.status_code,
        "latency_ms": latency_ms,
        "response_preview": (resp.text or "")[:200],
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
