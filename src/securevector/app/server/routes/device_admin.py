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

GET /api/v1/policy-sync/policies
    List view used by the dedicated MCP Policies sidebar page. One entry
    per distinct synced policy_id with its rule count and the rules
    themselves; read-only — authoring lives in the cloud admin UI.
"""

from __future__ import annotations

import logging
import os as _os
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.synced_rules import SyncedRulesRepository
from securevector.app.database.repositories.tool_permissions import ToolPermissionsRepository
from securevector.app.services.cloud_sync import _sync_once, get_health_snapshot
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


# ---------------------------------------------------------------------------
# Policy listing — data source for the dedicated MCP Policies sidebar page
# ---------------------------------------------------------------------------


class SyncedRuleView(BaseModel):
    """One synced rule rendered on the MCP Policies page."""

    tool_id: str
    effect: str
    priority: int
    reason: Optional[str] = None
    shadows_local_count: int = 0


class SyncedPolicyView(BaseModel):
    """One synced policy block on the MCP Policies page (provenance + rules)."""

    policy_id: str
    policy_name: Optional[str] = None
    bundle_id: str
    policy_version: int
    org_id: str
    org_name: Optional[str] = None
    admin_email: Optional[str] = None
    applied_at: str
    rule_count: int
    rules: List[SyncedRuleView]


class HealthSnapshotView(BaseModel):
    """Liveness + drift signals consumed by the MCP Policies page banner."""

    last_poll_at: Optional[str] = None
    last_poll_status: Optional[str] = None
    last_match_at: Optional[str] = None
    consecutive_mismatch_count: int = 0
    freshness_remaining_seconds: Optional[int] = None
    signing_key_fingerprint: Optional[str] = None


class PolicySyncPoliciesResponse(BaseModel):
    """Aggregated response for `GET /api/v1/policy-sync/policies`."""

    any_active: bool
    verification_status: str  # match | degraded | error | tampered
    # When verification_status=='tampered', these two are populated so the
    # MCP Policies page can render the exact tamper time + reason in the
    # red banner. Null for every other status.
    tampered_at: Optional[str] = None
    tamper_reason: Optional[str] = None
    health: HealthSnapshotView
    policies: List[SyncedPolicyView]
    # Gates the "Sync now" button on the page. False when nothing useful would
    # come of a force-refresh — primarily because the device isn't enrolled,
    # so /policy/sync would just 401/403. Frontend uses this to disable the
    # button + render the blocker_reason in the tooltip.
    can_refresh: bool
    refresh_blocker_reason: Optional[str] = None


class PolicySyncRefreshResponse(BaseModel):
    """Outcome of a manual `POST /api/v1/policy-sync/refresh` invocation."""

    applied: bool          # True if a new bundle was applied this call
    status: str            # ok | not_modified | not_enrolled | error
    message: str
    error_detail: Optional[str] = None


@router.get("/v1/policy-sync/policies", response_model=PolicySyncPoliciesResponse)
async def policy_sync_policies() -> PolicySyncPoliciesResponse:
    """
    Return all synced policies with provenance + drift/health signals.

    Read by the MCP Policies sidebar page. Always safe to call — returns an
    empty list with `match` status when the device isn't enrolled or no
    bundle has been applied yet (the page renders an empty-state in that
    case rather than 404'ing).
    """
    db = get_database()
    repo = SyncedRulesRepository(db)
    overrides_repo = ToolPermissionsRepository(db)

    # Health snapshot needs the latest applied_at to compute freshness window.
    policies_meta = await repo.list_policies()
    latest_applied = policies_meta[0]["applied_at"] if policies_meta else None
    health_raw = get_health_snapshot(last_applied_at=latest_applied)

    # Local override set used to count "shadows N local rules" per synced rule.
    # A local override on the same tool_id is shadowed by a synced rule because
    # synced > local in the precedence order (services/policy_engine.py).
    local_overrides = await overrides_repo.get_all_overrides()
    local_tool_ids = {o["tool_id"] for o in local_overrides}

    # admin_email lives on the credentials blob, not on every synced row —
    # surfaced here so the page can route "who do I escalate to?" without
    # an extra round trip.
    creds = get_enrolled_credentials()
    admin_email = creds.admin_email if creds else None

    policies: List[SyncedPolicyView] = []
    for meta in policies_meta:
        rules = await repo.list_rules_for_policy(meta["policy_id"])
        policies.append(
            SyncedPolicyView(
                policy_id=meta["policy_id"],
                policy_name=meta.get("policy_name"),
                bundle_id=meta["bundle_id"],
                policy_version=meta["policy_version"],
                org_id=meta["org_id"],
                org_name=meta.get("org_name"),
                admin_email=admin_email,
                applied_at=meta["applied_at"],
                rule_count=meta["rule_count"],
                rules=[
                    SyncedRuleView(
                        tool_id=r.tool_id,
                        effect=r.effect,
                        priority=r.priority,
                        reason=r.reason,
                        shadows_local_count=1 if r.tool_id in local_tool_ids else 0,
                    )
                    for r in rules
                ],
            )
        )

    # Refresh-button gating — the cheap rules:
    #   1. Must be enrolled (otherwise we have no auth target).
    #   2. Must have either a stored API key, an env-var API key, or a
    #      live JWT in credentials. The frontend doesn't need to know which —
    #      cloud_sync._build_sync_auth_headers picks at request time.
    can_refresh = False
    refresh_blocker_reason: Optional[str] = None
    if not is_enrolled():
        refresh_blocker_reason = "Not enrolled — run `securevector-app enroll <token>` first."
    elif not creds:
        refresh_blocker_reason = "Credentials unavailable."
    else:
        has_api_key = bool(_os.getenv("SECUREVECTOR_API_KEY")) or bool(getattr(creds, "api_key", None))
        has_jwt = bool(getattr(creds, "supabase_jwt", None))
        if not (has_api_key or has_jwt):
            refresh_blocker_reason = "No API key or JWT in credentials — re-enroll or set SECUREVECTOR_API_KEY."
        else:
            can_refresh = True

    return PolicySyncPoliciesResponse(
        any_active=bool(policies),
        verification_status=health_raw["verification_status"],
        tampered_at=health_raw.get("tampered_at"),
        tamper_reason=health_raw.get("tamper_reason"),
        health=HealthSnapshotView(
            last_poll_at=health_raw.get("last_poll_at"),
            last_poll_status=health_raw.get("last_poll_status"),
            last_match_at=health_raw.get("last_match_at"),
            consecutive_mismatch_count=health_raw.get("consecutive_mismatch_count", 0),
            freshness_remaining_seconds=health_raw.get("freshness_remaining_seconds"),
            signing_key_fingerprint=health_raw.get("signing_key_fingerprint"),
        ),
        policies=policies,
        can_refresh=can_refresh,
        refresh_blocker_reason=refresh_blocker_reason,
    )


# ---------------------------------------------------------------------------
# Manual sync — bypass the long-poll cadence + force one-shot apply
# ---------------------------------------------------------------------------


@router.post("/v1/policy-sync/refresh", response_model=PolicySyncRefreshResponse)
async def policy_sync_refresh() -> PolicySyncRefreshResponse:
    """
    Force one sync iteration immediately. Used by the "Sync now" button on
    the MCP Policies page. Idempotent — running it twice in a row is fine
    (second call returns 304 / not_modified if no new bundle).

    Reuses cloud_sync._sync_once for behaviour parity with the background
    loop — same auth path (X-Api-Key preferred, JWT fallback), same
    signature verification, same DB write transactionality.
    """
    if not is_enrolled():
        return PolicySyncRefreshResponse(
            applied=False,
            status="not_enrolled",
            message="Device is not enrolled. Run `securevector-app enroll <token>` first.",
        )

    db = get_database()
    repo = SyncedRulesRepository(db)
    try:
        applied = await _sync_once(db, repo)
    except Exception as exc:  # noqa: BLE001 — expose the message to the user
        logger.warning("Manual policy sync failed: %s", exc)
        return PolicySyncRefreshResponse(
            applied=False,
            status="error",
            message="Sync failed. Check that the cloud is reachable and the API key / JWT is valid.",
            error_detail=str(exc),
        )

    if applied:
        return PolicySyncRefreshResponse(
            applied=True,
            status="ok",
            message="New bundle applied.",
        )
    return PolicySyncRefreshResponse(
        applied=False,
        status="not_modified",
        message="Already on the latest bundle (304 not_modified).",
    )
