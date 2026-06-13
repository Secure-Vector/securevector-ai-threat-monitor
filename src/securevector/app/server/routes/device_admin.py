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


# ---------------------------------------------------------------------------
# Cloud Activity — single aggregated read for the Cloud Activity page + the
# `sv inspect-uplink` CLI. Pure visibility: what the cloud pushes DOWN
# (synced policies) and what this device pushes UP (enrollment-sourced
# forwarders + the OCSF event classes emitted). Read-only; reuses the #112
# enrollment + device_lifecycle + external_forwarders data already on the box.
# ---------------------------------------------------------------------------


# The OCSF event classes this device is capable of emitting outbound when
# enrollment-sourced destinations are configured. Static descriptor — these
# are the only shapes that ever leave the host, and every one is
# metadata-only (raw_data is always null; no prompt text, output, or tool
# args). Surfaced so the user can audit the full outbound vocabulary without
# reading source. Keep in sync with services/device_lifecycle.py (lifecycle)
# and services/siem_ocsf.py (tool-activity / threat translators).
_OUTBOUND_EVENT_TYPES = [
    {
        "event_code": "device.lifecycle.enrolled",
        "class_uid": 5001,
        "class_name": "Device Inventory Info",
        "description": "Emitted once when this device enrolls against your org.",
    },
    {
        "event_code": "device.lifecycle.uninstalling",
        "class_uid": 5001,
        "class_name": "Device Inventory Info",
        "description": "Emitted just before the app is uninstalled / shut down.",
    },
    {
        "event_code": "tool.activity",
        "class_uid": 6003,
        "class_name": "API Activity",
        "description": "Tool-call audit metadata (tool id, decision, agent) — never the arguments.",
    },
]


class CloudActivityEnrollment(BaseModel):
    """Enrollment status banner data for the Cloud Activity page."""

    enrolled: bool
    org_id: Optional[str] = None
    org_name: Optional[str] = None
    admin_email: Optional[str] = None
    user_email: Optional[str] = None
    device_id: Optional[str] = None
    device_record_id: Optional[str] = None
    group_memberships: List[str] = []
    # Best-effort liveness derived from the policy-sync health snapshot —
    # the long-poll loop is the only persistent cloud connection we hold.
    last_sync_at: Optional[str] = None
    last_sync_status: Optional[str] = None
    connection_state: str = "unknown"  # connected | idle | stale | offline | not_enrolled


class CloudActivityInbound(BaseModel):
    """Inbound (cloud → device) synced-policy summary."""

    any_active: bool
    verification_status: str
    policy_count: int
    rule_count: int
    bundle_version: Optional[int] = None
    bundle_id: Optional[str] = None
    signing_key_fingerprint: Optional[str] = None
    last_applied_at: Optional[str] = None
    rules: List[SyncedRuleView] = []


class CloudActivityDestination(BaseModel):
    """One outbound destination this device forwards metadata to."""

    id: int
    name: str
    url: str
    kind: str
    source: str  # 'enrollment' (🔒 managed) | 'user'
    enabled: bool
    last_success_at: Optional[str] = None
    events_sent: int = 0


class CloudActivityOutboundEventType(BaseModel):
    event_code: str
    class_uid: int
    class_name: str
    description: str


class CloudActivityOutbound(BaseModel):
    """Outbound (device → cloud/SIEM) forwarding summary."""

    enrollment_destinations: List[CloudActivityDestination] = []
    user_destinations: List[CloudActivityDestination] = []
    event_types: List[CloudActivityOutboundEventType] = []
    metadata_only: bool = True
    # User-level opt-out (#151): the device owner can disable forwarding to the
    # managed cloud destinations even when the admin opted in at enrollment.
    # True = at least one managed (enrollment) destination is enabled and
    # forwarding to the cloud fleet; False = the user turned it off locally and
    # nothing leaves the device for the cloud fleet. Derived from whether the
    # enrollment-source destinations are enabled.
    forwarding_enabled: bool = True


class CloudActivityResponse(BaseModel):
    """Aggregated Cloud Activity snapshot — one read for the page + CLI."""

    enrolled: bool
    enrollment: CloudActivityEnrollment
    inbound: CloudActivityInbound
    outbound: CloudActivityOutbound


def _derive_connection_state(health_raw: dict) -> str:
    """Map the policy-sync health snapshot onto a coarse connection state.

    The long-poll /policy/sync loop is the device's only persistent cloud
    link, so its last poll is the best available liveness signal. We bucket
    rather than expose raw timestamps so the banner reads at a glance.
    """
    last_poll = health_raw.get("last_poll_at")
    status = health_raw.get("last_poll_status") or ""
    if not last_poll:
        return "idle"  # enrolled, loop running, first poll not yet landed
    # An error-ish last status downgrades the state regardless of recency.
    if status in ("http_error", "timeout", "signature_mismatch"):
        return "stale"
    try:
        from datetime import datetime, timezone

        then = datetime.fromisoformat(str(last_poll).replace("Z", "+00:00"))
        if then.tzinfo is None:
            then = then.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - then).total_seconds()
    except Exception:
        return "connected"
    if age < 180:
        return "connected"
    if age < 1800:
        return "idle"
    return "stale"


@router.get("/v1/cloud-activity", response_model=CloudActivityResponse)
async def cloud_activity() -> CloudActivityResponse:
    """Aggregated Cloud Activity snapshot.

    Backs both the Cloud Activity sidebar page and `sv inspect-uplink`.
    Always safe to call: when the device isn't enrolled it returns
    ``enrolled: false`` with empty inbound/outbound sections (the page
    renders an enrolled-only gate in that case). Read-only.
    """
    enrolled = is_enrolled()
    creds = get_enrolled_credentials() if enrolled else None

    db = get_database()
    synced_repo = SyncedRulesRepository(db)

    # --- Inbound: synced policies (reuse the same data the MCP Policies page
    # reads) ---
    policies_meta = await synced_repo.list_policies()
    latest_applied = policies_meta[0]["applied_at"] if policies_meta else None
    health_raw = get_health_snapshot(last_applied_at=latest_applied)

    all_rule_views: List[SyncedRuleView] = []
    rule_count = 0
    for meta in policies_meta:
        rules = await synced_repo.list_rules_for_policy(meta["policy_id"])
        rule_count += len(rules)
        for r in rules:
            all_rule_views.append(
                SyncedRuleView(
                    tool_id=r.tool_id,
                    effect=r.effect,
                    priority=r.priority,
                    reason=r.reason,
                )
            )

    bundle_version = None
    bundle_id = None
    if policies_meta:
        bundle_version = max(
            (m.get("policy_version") or 0) for m in policies_meta
        ) or None
        bundle_id = policies_meta[0].get("bundle_id")

    inbound = CloudActivityInbound(
        any_active=bool(policies_meta),
        verification_status=health_raw.get("verification_status", "match"),
        policy_count=len(policies_meta),
        rule_count=rule_count,
        bundle_version=bundle_version,
        bundle_id=bundle_id,
        signing_key_fingerprint=health_raw.get("signing_key_fingerprint"),
        last_applied_at=latest_applied,
        # Cap the inline rule list so the payload stays small — the MCP
        # Policies page is the full drill-down surface.
        rules=all_rule_views[:50],
    )

    # --- Outbound: forwarding destinations + the OCSF vocabulary emitted ---
    enrollment_dests: List[CloudActivityDestination] = []
    user_dests: List[CloudActivityDestination] = []
    try:
        from securevector.app.database.repositories.external_forwarders import (
            ExternalForwardersRepository,
        )

        fwd_repo = ExternalForwardersRepository(db)
        for f in await fwd_repo.list_all():
            dest = CloudActivityDestination(
                id=int(f["id"]),
                name=f.get("name") or "",
                url=f.get("url") or "",
                kind=f.get("kind") or "webhook",
                source=str(f.get("source") or "user"),
                enabled=bool(f.get("enabled")),
                last_success_at=f.get("last_success_at"),
                events_sent=int(f.get("events_sent") or 0),
            )
            if dest.source == "enrollment":
                enrollment_dests.append(dest)
            else:
                user_dests.append(dest)
    except Exception as exc:  # noqa: BLE001 — visibility read, never 500
        logger.debug("cloud-activity: could not load forwarders: %s", type(exc).__name__)

    outbound = CloudActivityOutbound(
        enrollment_destinations=enrollment_dests,
        user_destinations=user_dests,
        event_types=[CloudActivityOutboundEventType(**e) for e in _OUTBOUND_EVENT_TYPES],
        metadata_only=True,
        # Forwarding is "on" when at least one managed destination is enabled.
        forwarding_enabled=any(d.enabled for d in enrollment_dests),
    )

    # --- Enrollment status banner ---
    device_id = None
    try:
        from securevector.app.utils.device_id import get_device_id

        device_id = get_device_id()
    except Exception:
        pass

    connection_state = "not_enrolled" if not enrolled else _derive_connection_state(health_raw)

    enrollment = CloudActivityEnrollment(
        enrolled=enrolled,
        org_id=creds.org_id if creds else None,
        org_name=creds.org_name if creds else None,
        admin_email=creds.admin_email if creds else None,
        user_email=creds.user_email if creds else None,
        device_id=device_id,
        device_record_id=creds.device_record_id if creds else None,
        group_memberships=list(creds.group_memberships) if creds else [],
        last_sync_at=health_raw.get("last_poll_at"),
        last_sync_status=health_raw.get("last_poll_status"),
        connection_state=connection_state,
    )

    return CloudActivityResponse(
        enrolled=enrolled,
        enrollment=enrollment,
        inbound=inbound,
        outbound=outbound,
    )


class CloudForwardingToggleRequest(BaseModel):
    """Body for the user-level cloud-forwarding opt-out."""

    enabled: bool


@router.post("/v1/cloud-forwarding")
async def set_cloud_forwarding(body: CloudForwardingToggleRequest) -> dict:
    """User-level opt-out for cloud fleet forwarding (#151).

    Lets the device owner disable forwarding to the managed (enrollment)
    destinations — so nothing leaves the device for the cloud fleet — even
    when the admin opted in at enrollment, and re-enable it later. Only the
    managed (source='enrollment') destinations are affected; the user's own
    SIEM destinations are never touched by this toggle. When disabled, the
    forwarder's delivery loop skips these destinations (they are filtered out
    of list_active by the enabled flag) and nothing new is queued for them.
    """
    if not is_enrolled():
        raise HTTPException(
            status_code=409,
            detail="Device is not enrolled — there is no cloud forwarding to toggle.",
        )

    from securevector.app.database.repositories.external_forwarders import (
        ExternalForwardersRepository,
    )

    repo = ExternalForwardersRepository(get_database())
    changed = 0
    for f in await repo.list_all():
        if str(f.get("source") or "") == "enrollment":
            await repo.update(int(f["id"]), enabled=bool(body.enabled))
            changed += 1

    logger.info(
        "cloud-forwarding %s by user (%d managed destination(s))",
        "enabled" if body.enabled else "disabled",
        changed,
    )
    return {"ok": True, "forwarding_enabled": bool(body.enabled), "destinations_updated": changed}
