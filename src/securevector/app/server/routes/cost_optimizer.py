"""Cost / Token Optimizer routes (issue #202).

Mirrors the Instant Audit route contract: status / run / report / delete, plus
a prefs endpoint for the billing mode and the Recommend opt-in. The scan is
consent-gated the same way Instant Audit is — it reads local transcripts, and
that is the operator's call to make, once.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from securevector.app.database.connection import get_database
from securevector.app.services.cost_optimizer import (
    DEFAULT_WINDOW_DAYS,
    get_cost_optimizer_service,
)

logger = logging.getLogger(__name__)

router = APIRouter()


class RunOptimizerRequest(BaseModel):
    consent: bool = False
    window_days: int = Field(default=DEFAULT_WINDOW_DAYS, ge=1, le=365)


class OptimizerPrefsUpdate(BaseModel):
    billing_mode: Optional[str] = Field(default=None, pattern="^(api|subscription)$")
    recommend_enabled: Optional[bool] = None


@router.get("/cost-optimizer/status")
async def optimizer_status():
    svc = get_cost_optimizer_service()
    report = svc.read_report()
    prefs = svc.get_prefs()
    # Billing mode defaults automatically where derivable: proxy-metered
    # agents are API-metered by definition. Otherwise the UI asks once.
    derived = None
    if not prefs.get("billing_mode") and report:
        if report.get("billing", {}).get("proxy_metered_seen"):
            derived = "api"
    return {
        "consented_at": svc.consented(),
        "running": svc.running,
        "progress": svc.progress,
        "has_report": report is not None,
        "report_generated_at": report.get("generated_at") if report else None,
        "prefs": {
            "billing_mode": prefs.get("billing_mode"),
            "billing_mode_derived": derived,
            "recommend_enabled": prefs.get("recommend_enabled"),
        },
    }


@router.post("/cost-optimizer/run")
async def run_optimizer(req: RunOptimizerRequest):
    svc = get_cost_optimizer_service()
    if not req.consent and not svc.consented():
        raise HTTPException(status_code=403, detail="consent required")
    if req.consent and not svc.consented():
        svc.record_consent()
    if not svc.start(get_database(), window_days=req.window_days):
        raise HTTPException(status_code=409, detail="a scan is already running")
    return {"started": True, "window_days": req.window_days}


@router.get("/cost-optimizer/report")
async def optimizer_report():
    report = get_cost_optimizer_service().read_report()
    if report is None:
        raise HTTPException(status_code=404, detail="no report")
    return report


@router.delete("/cost-optimizer/report")
async def delete_optimizer_report():
    if not get_cost_optimizer_service().delete_report():
        raise HTTPException(status_code=500, detail="could not delete report")
    return {"deleted": True}


@router.put("/cost-optimizer/prefs")
async def update_optimizer_prefs(req: OptimizerPrefsUpdate):
    svc = get_cost_optimizer_service()
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    prefs = svc.set_prefs(**updates)
    return {
        "billing_mode": prefs.get("billing_mode"),
        "recommend_enabled": prefs.get("recommend_enabled"),
    }
