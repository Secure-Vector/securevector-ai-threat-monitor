"""
Device admin + policy-sync status endpoints.

active-mcp-and-policy-sync bundle, Phase 2 / Release A device side.

POST /api/system/device-id/reset
    For cloned-VM recovery. The cloud's (device_id, org_id) UNIQUE constraint
    blocks re-enrollment when two machines share the same device_id; this
    endpoint regenerates the local device_id so re-enrollment can succeed.
    Also clears any existing enrolled credentials — the user must re-enroll
    against their org afterwards.

GET /api/v1/policy-sync/status
    Header badge data. Returns whether this device is currently in
    org-enrolled (svet_*) mode — and therefore receiving signed policy
    bundles from the cloud — vs personal-mode (svpk_* / legacy / no
    credentials) where Cloud Connect behaves exactly as it always has.

    Mental model: "Policy Sync" is a strictly additive layer that turns
    on ONLY when the device was enrolled via a mint token. There is no
    partial mode and no manual toggle — install path determines state.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.synced_rules import SyncedRulesRepository
from securevector.app.services.credentials import (
    clear_enrolled_credentials,
    get_enrolled_credentials,
    is_enrolled,
)
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


# ---------------------------------------------------------------------------
# Policy Sync status — header badge data source
# ---------------------------------------------------------------------------


class PolicySyncStatusResponse(BaseModel):
    """
    Header-badge state for Cloud → Local policy sync.

    `enrolled` is the source of truth. Devices installed without an svet_*
    mint token (personal API key, legacy unprefixed, or no credentials)
    return `enrolled: false` and behave exactly as before — there is no
    partial cloud-policy mode.

    When enrolled, the badge surfaces:
      - org_name + admin_email so the user can see who manages their device
      - last_synced_bundle_id / last_synced_version / synced_rule_count to
        confirm a bundle has actually been applied (not just enrolled)
    """

    enrolled: bool
    org_id: Optional[str] = None
    org_name: Optional[str] = None
    admin_email: Optional[str] = None
    user_email: Optional[str] = None
    last_synced_bundle_id: Optional[str] = None
    last_synced_policy_id: Optional[str] = None
    last_synced_version: Optional[int] = None
    synced_rule_count: int = 0
    message: str


@router.get("/v1/policy-sync/status", response_model=PolicySyncStatusResponse)
async def policy_sync_status() -> PolicySyncStatusResponse:
    """Cheap idempotent read used by the header badge polling loop."""
    if not is_enrolled():
        return PolicySyncStatusResponse(
            enrolled=False,
            message=(
                "Policy Sync is OFF. This device is not enrolled in any "
                "organization — Cloud Connect behaves as a personal "
                "subscription. To turn Policy Sync ON, an admin must mint "
                "an svet_ enrollment token and you must run "
                "`securevector-app enroll <token>`."
            ),
        )

    creds = get_enrolled_credentials()
    db = get_database()
    repo = SyncedRulesRepository(db)
    rows = await repo.list_all()

    last_bundle_id = None
    last_policy_id = None
    last_version = None
    if rows:
        # Sort by applied_at desc; first row is most recent bundle apply
        rows_sorted = sorted(rows, key=lambda r: r.applied_at, reverse=True)
        latest = rows_sorted[0]
        last_bundle_id = latest.bundle_id
        last_policy_id = latest.policy_id
        last_version = latest.policy_version

    return PolicySyncStatusResponse(
        enrolled=True,
        org_id=creds.org_id if creds else None,
        org_name=creds.org_name if creds else None,
        admin_email=creds.admin_email if creds else None,
        user_email=creds.user_email if creds else None,
        last_synced_bundle_id=last_bundle_id,
        last_synced_policy_id=last_policy_id,
        last_synced_version=last_version,
        synced_rule_count=len(rows),
        message=(
            f"Policy Sync ON — managed by {creds.org_name if creds else 'your organization'}."
            if rows
            else (
                f"Enrolled in {creds.org_name if creds else 'your organization'}; "
                "waiting for the first signed bundle to apply (≤60s)."
            )
        ),
    )
