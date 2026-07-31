"""Instant Agent Audit API.

GET    /api/instant-audit/status  - consent / running / progress / report presence
POST   /api/instant-audit/run     - record consent + start a background scan
GET    /api/instant-audit/report  - the last report (404 when none)
DELETE /api/instant-audit/report  - remove the report file (privacy)

The scan reads on-disk agent transcripts only after explicit consent in the
request body — a bare POST without ``consent: true`` is rejected. Everything
stays on this machine; see services/instant_audit.py for the privacy contract.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from securevector.app.database.connection import get_database
from securevector.app.services.instant_audit import get_instant_audit_service

logger = logging.getLogger(__name__)

router = APIRouter()


class RunAuditRequest(BaseModel):
    consent: bool = False
    window_days: int = Field(default=90, ge=1, le=365)


@router.get("/instant-audit/status")
async def audit_status() -> dict:
    svc = get_instant_audit_service()
    report = svc.load_report()
    return {
        "consented_at": svc.consented(),
        "running": svc.running,
        "progress": svc.progress,
        "has_report": report is not None,
        "report_generated_at": (report or {}).get("generated_at"),
    }


@router.post("/instant-audit/run")
async def run_audit(req: RunAuditRequest) -> dict:
    svc = get_instant_audit_service()
    # Consent gate: either this request carries it, or it was recorded before.
    if not req.consent and not svc.consented():
        raise HTTPException(status_code=403, detail="consent required")
    if req.consent and not svc.consented():
        svc.record_consent()
    if not svc.start(get_database(), window_days=req.window_days):
        raise HTTPException(status_code=409, detail="a scan is already running")
    return {"started": True, "window_days": req.window_days}


@router.get("/instant-audit/report")
async def audit_report() -> dict:
    report = get_instant_audit_service().load_report()
    if report is None:
        raise HTTPException(status_code=404, detail="no report — run a scan first")
    return report


@router.delete("/instant-audit/report")
async def delete_report() -> dict:
    ok = get_instant_audit_service().delete_report()
    if not ok:
        raise HTTPException(status_code=500, detail="could not delete report")
    return {"deleted": True}
