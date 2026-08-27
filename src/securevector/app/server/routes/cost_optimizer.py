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
    fix_fingerprint,
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
    live_advisor_enabled: Optional[bool] = None
    live_sounds_enabled: Optional[bool] = None
    stage_heads_up: Optional[int] = Field(default=None, ge=10, le=95)
    stage_act_now: Optional[int] = Field(default=None, ge=10, le=98)
    stage_last_call: Optional[int] = Field(default=None, ge=10, le=99)
    big_result_tokens: Optional[int] = Field(default=None, ge=200, le=100000)


class OptimizerFixCopied(BaseModel):
    """A fix the user just put on the clipboard. `text` is one of our own copy
    templates: the service keeps a normalized fingerprint of it so it can spot
    the paste in a local transcript, and nothing else."""
    type: str = Field(min_length=1, max_length=64)
    text: str = Field(min_length=8, max_length=4000)
    session_id: Optional[str] = Field(default=None, max_length=128)
    label: Optional[str] = Field(default=None, max_length=120)


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
            "live_advisor_enabled": prefs.get("live_advisor_enabled", True),
            "live_sounds_enabled": prefs.get("live_sounds_enabled", True),
            "stage_heads_up": prefs.get("stage_heads_up", 60),
            "stage_act_now": prefs.get("stage_act_now", 75),
            "stage_last_call": prefs.get("stage_last_call", 90),
            "big_result_tokens": prefs.get("big_result_tokens", 2000),
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


@router.get("/cost-optimizer/sessions")
async def optimizer_sessions(window_days: int = 30):
    """Live/stale status per session, from transcript mtimes. Cheap enough
    to poll: a stat sweep plus a tail read of each live file."""
    window_days = max(1, min(window_days, 90))
    return get_cost_optimizer_service().session_activity(window_days)


@router.get("/cost-optimizer/live")
async def optimizer_live():
    """Guardian live advisor: waste flags + compact staging for sessions
    active in the last few minutes. Tail reads of local transcripts only;
    advisory only, nothing is ever written into a session."""
    return get_cost_optimizer_service().live_advisor()


@router.post("/cost-optimizer/fix-copied")
async def optimizer_fix_copied(req: OptimizerFixCopied):
    """Record that a copy happened so the next live sweep can look for the
    paste and then measure whether it changed anything. Advisory only: this
    writes nothing into any session."""
    svc = get_cost_optimizer_service()
    return svc.record_fix_copied(
        fix_type=req.type,
        fingerprint=fix_fingerprint(req.text),
        session_id=req.session_id,
        label=req.label,
    )


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
    return {k: prefs.get(k) for k in (
        "billing_mode", "recommend_enabled",
        "live_advisor_enabled", "live_sounds_enabled",
        "stage_heads_up", "stage_act_now", "stage_last_call",
        "big_result_tokens",
    )}
