"""
Device admin endpoints — recovery actions on the local device.

active-mcp-and-policy-sync bundle, Phase 2 / Release A device side.

POST /api/system/device-id/reset
    For cloned-VM recovery. The cloud's (device_id, org_id) UNIQUE constraint
    blocks re-enrollment when two machines share the same device_id; this
    endpoint regenerates the local device_id so re-enrollment can succeed.
    Also clears any existing enrolled credentials — the user must re-enroll
    against their org afterwards.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from securevector.app.services.credentials import clear_enrolled_credentials
from securevector.app.utils.device_id import force_reset_device_id

logger = logging.getLogger(__name__)

router = APIRouter()


class DeviceIdResetResponse(BaseModel):
    success: bool
    new_device_id: str
    enrolled_cleared: bool
    message: str


@router.post("/system/device-id/reset", response_model=DeviceIdResetResponse)
async def reset_device_id() -> DeviceIdResetResponse:
    """
    Erase the local device_id cache, generate a fresh one, and clear any
    existing enrolled credentials. Caller must re-enroll afterwards.
    """
    try:
        new_id = force_reset_device_id()
    except Exception as exc:  # noqa: BLE001
        logger.error("Device-id reset failed: %s", exc)
        raise HTTPException(
            status_code=500,
            detail={"error": "device_id_reset_failed", "message": str(exc)},
        ) from exc

    enrolled_cleared = clear_enrolled_credentials()
    logger.info(
        "Device-id reset: new=%s enrolled_cleared=%s",
        new_id,
        enrolled_cleared,
    )
    return DeviceIdResetResponse(
        success=True,
        new_device_id=new_id,
        enrolled_cleared=enrolled_cleared,
        message="Device ID reset. Re-enroll against your org with `securevector-app enroll <token>`.",
    )
