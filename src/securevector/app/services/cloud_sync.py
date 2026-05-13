"""
Cloud Sync subsystem — async long-poll loop pulling signed policy bundles
from the SecureVector security engine `/policy/sync` and applying them locally.

active-mcp-and-policy-sync bundle, Phase 2 / Release B device side.

Lifecycle:
  - `maybe_start_cloud_sync(db)` — called from FastAPI lifespan startup. Starts
    the loop only if `is_enrolled()` is True; otherwise no cloud calls.
  - The loop polls every 60s (with 25s long-poll under the API GW 29s limit).
  - On 200 OK: verify bundle, apply atomically, POST /policy/applied with status=ok.
  - On 401: refresh Supabase JWT via /auth/token; retry once.
  - On verification failure: POST /policy/applied with status=rejected; keep
    previous bundle in effect.
  - `stop_cloud_sync()` — called from lifespan shutdown. Cancels the task.

The loop never exits on transient errors — exponential backoff caps at 5 min
between attempts. Only `stop_cloud_sync()` or app shutdown ends it.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import random
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.repositories.synced_rules import SyncedRulesRepository
from securevector.app.database.repositories.synced_bundle_envelope import (
    SyncedBundleEnvelopeRepository,
)
from securevector.app.services.bundle_verifier import (
    BUNDLE_FRESHNESS_WINDOW,
    BundleVerificationError,
    fingerprint_signing_key,
    verify_bundle,
    verify_envelope,
)
from securevector.app.services.cloud_config import get_auth_service_url, get_lse_url
from securevector.app.services.credentials import (
    EnrolledCredentials,
    get_enrolled_credentials,
    is_enrolled,
    update_supabase_jwt,
)
from securevector.app.utils.device_id import get_device_id

logger = logging.getLogger(__name__)


# Poll cadence — 60s nominal, with the long-poll budget under API GW's 29s limit.
SYNC_INTERVAL_SECONDS = 60.0
LONG_POLL_TIMEOUT_SECONDS = 25.0
TRANSIENT_BACKOFF_BASE = 5.0
TRANSIENT_BACKOFF_MAX = 300.0

# Drift thresholds for the MCP Policies page health snapshot. Match the
# tiered alerting design captured in the local-visibility plan.
DEGRADED_MISMATCH_STREAK = 3            # ≥3 consecutive verify failures → degraded
DEGRADED_QUIET_HOURS = 12               # >12h without a successful poll → degraded
ERROR_FRESHNESS_HOURS = 24              # >24h since last apply → error (enforcer falls back)


# Module-level task handle so lifespan stop can cancel it.
_sync_task: Optional[asyncio.Task] = None


# In-memory health snapshot. Mutated by _sync_once on every iteration; read by
# the /api/v1/policy-sync/policies endpoint to power the verification banner.
# Lost on app restart — that's fine, the next poll re-establishes a fresh
# baseline within ≤60s. Persisting this would require a per-poll DB write,
# which is the wrong tradeoff for a v1 surface (see plan: Phase 2 follow-up).
_HEALTH: dict = {
    "last_poll_at": None,           # ISO8601 — every poll attempt sets this
    "last_poll_status": None,       # 200_applied | 304_not_modified | 401_refresh | timeout | signature_mismatch | http_error | tampered
    "last_match_at": None,          # ISO8601 — last successful apply or 304-after-good-apply
    "consecutive_mismatch_count": 0,
    "signing_key_fingerprint": None,  # sha256:<32-hex> — proves *which* org key signed
    "tampered_at": None,            # ISO8601 — set when the stored envelope fails re-verify
    "tamper_reason": None,          # human-readable reason string from BundleVerificationError
}


def _record_poll(status: str, *, match: bool = False, signing_key: Optional[str] = None) -> None:
    """Record one poll outcome in the in-memory health snapshot."""
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    _HEALTH["last_poll_at"] = now_iso
    _HEALTH["last_poll_status"] = status
    if match:
        _HEALTH["last_match_at"] = now_iso
        _HEALTH["consecutive_mismatch_count"] = 0
    if status == "signature_mismatch":
        _HEALTH["consecutive_mismatch_count"] += 1
    if signing_key and not _HEALTH["signing_key_fingerprint"]:
        digest = hashlib.sha256(signing_key.encode("utf-8")).digest()
        _HEALTH["signing_key_fingerprint"] = "sha256:" + base64.b64encode(digest).decode("ascii").rstrip("=")


def get_health_snapshot(last_applied_at: Optional[str] = None) -> dict:
    """
    Return the in-memory health snapshot plus computed verification_status.

    `last_applied_at` is the most recent `applied_at` from synced_tool_rules;
    callers (the /policies endpoint) pass it so we don't need a DB cursor here.
    None means no bundle has ever been applied on this device — verification
    status is "match" by default until the first poll lands.
    """
    snap = dict(_HEALTH)  # shallow copy; never mutate the singleton from outside

    # Compute freshness_remaining_seconds against the bundle window.
    freshness_remaining = None
    if last_applied_at:
        try:
            applied_dt = datetime.fromisoformat(last_applied_at.replace("Z", "+00:00"))
            elapsed = datetime.now(timezone.utc) - applied_dt
            remaining = BUNDLE_FRESHNESS_WINDOW - elapsed
            freshness_remaining = max(0, int(remaining.total_seconds()))
        except (ValueError, TypeError):
            freshness_remaining = None
    snap["freshness_remaining_seconds"] = freshness_remaining

    # Tiered verification status — see plan Phase 1 table.
    status = "match"

    # Tamper tier — strictly highest priority. If a re-verify failed, the
    # synced rules have already been blanked; the UI must show that
    # loudly even if (e.g.) the bundle would otherwise be in freshness
    # window. Persists until the next clean re-verify clears it.
    if _HEALTH["tampered_at"]:
        status = "tampered"
    # Error tier: bundle past the 24h freshness window means the enforcer
    # is now falling back to local-only rules — surface this loudly.
    elif freshness_remaining is not None and freshness_remaining <= 0:
        status = "error"
    # Degraded tier: persistent mismatch streak OR quiet line.
    elif _HEALTH["consecutive_mismatch_count"] >= DEGRADED_MISMATCH_STREAK:
        status = "degraded"
    elif _HEALTH["last_match_at"]:
        try:
            match_dt = datetime.fromisoformat(_HEALTH["last_match_at"].replace("Z", "+00:00"))
            quiet = datetime.now(timezone.utc) - match_dt
            if quiet > timedelta(hours=DEGRADED_QUIET_HOURS):
                status = "degraded"
        except (ValueError, TypeError):
            pass

    snap["verification_status"] = status
    return snap


async def maybe_start_cloud_sync(db: DatabaseConnection) -> None:
    """
    Start the cloud-sync loop if this device is enrolled. No-op otherwise.

    Idempotent — calling twice does not start two loops. Safe to call from
    enrollment-completion code paths to kick the loop without restarting
    the app.
    """
    global _sync_task
    if not is_enrolled():
        logger.info("Cloud Sync skipped — device is not enrolled")
        return
    if _sync_task and not _sync_task.done():
        logger.debug("Cloud Sync already running; skipping start")
        return
    _sync_task = asyncio.create_task(_sync_loop(db), name="securevector-cloud-sync")
    logger.info("Cloud Sync loop started")


async def stop_cloud_sync() -> None:
    """Cancel the loop on shutdown / unenroll. Idempotent."""
    global _sync_task
    if not _sync_task or _sync_task.done():
        return
    _sync_task.cancel()
    try:
        await _sync_task
    except (asyncio.CancelledError, Exception):  # noqa: BLE001
        pass
    _sync_task = None
    logger.info("Cloud Sync loop stopped")


async def _verify_envelope_or_quarantine(
    db: DatabaseConnection,
    rules_repo: SyncedRulesRepository,
    envelope_repo: SyncedBundleEnvelopeRepository,
) -> bool:
    """
    Re-verify the stored signed envelope against the device's signing key.

    If the signature still matches, return True and refresh `verified_at`
    on the envelope row.

    If it doesn't match — typically because someone edited
    `synced_tool_rules` rows directly with sqlite3 (the verifier doesn't
    actually look at the rules table, but if a future attack edits the
    envelope itself the same path catches it) — wipe the rules,
    mark the envelope row tampered, and stamp the in-memory health
    snapshot so the MCP Policies page flips to the red tamper banner.
    Returns False.

    If there's no envelope (first poll after enrollment, or post-unenroll),
    return True without doing anything — there's nothing to verify yet.
    """
    envelope = await envelope_repo.load_latest()
    if envelope is None:
        return True
    creds = get_enrolled_credentials()
    if not creds or not creds.policy_bundle_signing_key:
        # Can't verify without the key; treat as quiet pass — the next
        # successful poll will overwrite the envelope and re-establish state.
        return True

    try:
        verify_envelope(envelope.bundle_json, signing_key=creds.policy_bundle_signing_key)
    except BundleVerificationError as exc:
        logger.error(
            "Cloud Sync: TAMPER DETECTED — stored envelope %s failed re-verify (%s): %s",
            envelope.bundle_id,
            exc.code,
            exc,
        )
        await rules_repo.clear()
        await envelope_repo.mark_tampered(reason=str(exc))
        _HEALTH["tampered_at"] = _now_iso()
        _HEALTH["tamper_reason"] = str(exc)
        _record_poll("tampered")
        return False

    await envelope_repo.touch_verified()
    # Clear any prior tamper state — a clean re-verify means recovery.
    _HEALTH["tampered_at"] = None
    _HEALTH["tamper_reason"] = None
    return True


async def _sync_loop(db: DatabaseConnection) -> None:
    """Top-level loop. Never returns on its own."""
    repo = SyncedRulesRepository(db)
    envelope_repo = SyncedBundleEnvelopeRepository(db)
    backoff = TRANSIENT_BACKOFF_BASE

    # Startup re-verify — catch sqlite3-shell edits made while the app
    # was down. If it fails, the rules are blanked before the first
    # enforcement read happens this session.
    try:
        await _verify_envelope_or_quarantine(db, repo, envelope_repo)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Cloud Sync: startup envelope verify failed (non-fatal): %s", exc)

    while True:
        try:
            # Re-verify before every poll — cheap (one HMAC) and catches
            # tampering that happened while the app was running.
            await _verify_envelope_or_quarantine(db, repo, envelope_repo)
            applied = await _sync_once(db, repo, envelope_repo)
            backoff = TRANSIENT_BACKOFF_BASE  # reset on success
            # 304 / no-change applied returns False; still wait normal cadence
            await asyncio.sleep(SYNC_INTERVAL_SECONDS if not applied else 1.0)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — top-level resilience
            logger.warning("Cloud Sync iteration failed: %s", exc)
            jitter = random.uniform(0, backoff * 0.25)
            await asyncio.sleep(min(TRANSIENT_BACKOFF_MAX, backoff + jitter))
            backoff = min(TRANSIENT_BACKOFF_MAX, backoff * 2)


async def _sync_once(
    db: DatabaseConnection,
    repo: SyncedRulesRepository,
    envelope_repo: Optional[SyncedBundleEnvelopeRepository] = None,
) -> bool:
    """
    One iteration: long-poll for a new bundle, verify, apply, ack.

    Returns True if a new bundle was applied; False on 304 / no-change.
    Raises on transient errors (the loop catches and backs off).

    When `envelope_repo` is provided (always, in the main loop; optional
    for test injection) the signed envelope is persisted on each apply
    so the tamper-detect re-verify path has something to check.
    """
    if envelope_repo is None:
        envelope_repo = SyncedBundleEnvelopeRepository(db)
    creds = get_enrolled_credentials()
    if not creds:
        # Lost enrollment mid-flight — stop the loop cleanly
        logger.info("Cloud Sync: credentials cleared, exiting iteration")
        return False
    if not creds.policy_bundle_signing_key:
        logger.warning(
            "Cloud Sync: no policy_bundle_signing_key in credentials — "
            "signature verification will fail. Cloud SSM param may be missing."
        )
        return False

    last_applied = await _get_last_applied_version(repo)
    bundle_id_hint = await _get_last_bundle_id(repo)

    response = await _fetch_bundle(creds, bundle_id_hint)
    if response is None:
        # 304 — no new bundle. Counts as a successful liveness ping; if the
        # last apply was good, we're still in MATCH state.
        _record_poll("304_not_modified", match=bool(_HEALTH["last_match_at"]))
        return False

    try:
        verified = verify_bundle(
            response,
            signing_key=creds.policy_bundle_signing_key,
            last_applied_version=last_applied,
        )
    except BundleVerificationError as exc:
        logger.error(
            "Cloud Sync: rejecting bundle %s (%s): %s",
            response.get("bundle_id"),
            exc.code,
            exc,
        )
        # Map the verifier's rejection codes onto the health snapshot's
        # poll-status vocabulary; the page renders these in the audit panel.
        _record_poll(
            "signature_mismatch" if exc.code == "signature_invalid" else exc.code,
        )
        await _post_applied(
            creds,
            bundle_id=str(response.get("bundle_id") or ""),
            policy_id=str(response.get("policy_id") or ""),
            version=int(response.get("version") or 0),
            status="rejected",
            error=exc.code,
        )
        return False

    await repo.replace_bundle(
        bundle_id=verified.bundle_id,
        policy_id=verified.policy_id,
        policy_name=verified.policy_name,
        policy_version=verified.version,
        org_id=verified.org_id,
        org_name=creds.org_name,
        rules=verified.rules,
    )
    # Persist the signed envelope alongside the extracted rules so the
    # next poll (and the next app startup) can re-verify the signature
    # without re-fetching from the cloud. The bundle JSON we serialise
    # MUST round-trip through the canonical-JSON form that the signature
    # was computed over — json.dumps with sort_keys=True + tight
    # separators matches bundle_verifier._canonical_json's expectation,
    # so verify_envelope() recomputes the same HMAC.
    try:
        envelope_bytes = json.dumps(response, sort_keys=True, separators=(",", ":"))
        await envelope_repo.save_envelope(
            bundle_id=verified.bundle_id,
            bundle_json=envelope_bytes,
            signature=str(response.get("signature") or ""),
            signing_key_fingerprint=fingerprint_signing_key(
                creds.policy_bundle_signing_key
            ),
        )
        # A successful apply clears any prior tamper state — the cloud just
        # pushed a fresh signed bundle, so we're recovering even if the
        # previous envelope had been tampered.
        _HEALTH["tampered_at"] = None
        _HEALTH["tamper_reason"] = None
    except Exception as exc:  # noqa: BLE001 — envelope write failure must not break apply
        logger.warning(
            "Cloud Sync: failed to persist envelope for bundle %s: %s",
            verified.bundle_id,
            exc,
        )
    logger.info(
        "Cloud Sync: applied bundle %s policy=%s (%s) v=%d (%d rules)",
        verified.bundle_id,
        verified.policy_id,
        verified.policy_name or "(unnamed)",
        verified.version,
        len(verified.rules),
    )

    # Record the MATCH + capture the signing-key fingerprint for the audit
    # panel. Fingerprint stays sticky across polls (only set once).
    _record_poll(
        "200_applied",
        match=True,
        signing_key=creds.policy_bundle_signing_key,
    )

    await _post_applied(
        creds,
        bundle_id=verified.bundle_id,
        policy_id=verified.policy_id,
        version=verified.version,
        status="ok",
        error=None,
    )
    return True


def _build_sync_auth_headers(creds: EnrolledCredentials) -> dict:
    """
    Auth header builder for /policy/sync.

    The engine accepts either an `X-Api-Key` (long-lived `sk-*` from the
    cloud Access Management page) or `Authorization: Bearer <supabase_jwt>`
    (short-lived, expires in ~1h). API key is preferred when available
    because it eliminates the JWT-expiry fragility — a failed JWT-refresh
    or a >401 response from the auth gateway no longer breaks the sync loop.

    Resolution order:
      1. SECUREVECTOR_API_KEY env var (operator override; matches the SDK's
         existing env-var convention).
      2. The api_key field on the credentials blob (if the user has stored
         one alongside their enrollment).
      3. Bearer JWT — the historical default; still gets the auto-refresh
         path on 401 if it expires.
    """
    api_key = os.getenv("SECUREVECTOR_API_KEY") or getattr(creds, "api_key", None)
    if api_key:
        return {"X-Api-Key": api_key}
    return {"Authorization": f"Bearer {creds.supabase_jwt or ''}"}


async def _fetch_bundle(
    creds: EnrolledCredentials, bundle_id_hint: Optional[str]
) -> Optional[dict]:
    """
    GET /policy/sync with `If-None-Match: <bundle_id_hint>` for long-poll.

    Returns the parsed JSON body on 200, or None on 304.
    Raises on transient / auth failure (caller backs off).
    """
    base = get_lse_url().rstrip("/")
    url = f"{base}/policy/sync"
    headers = {
        **_build_sync_auth_headers(creds),
        "X-SecureVector-Device-Id": get_device_id(),
    }
    if bundle_id_hint:
        headers["If-None-Match"] = bundle_id_hint

    async with httpx.AsyncClient(timeout=LONG_POLL_TIMEOUT_SECONDS + 5) as client:
        response = await client.get(url, headers=headers)

    if response.status_code == 304:
        return None
    # 401 OR 403 from the JWT path — engine has been observed to return both
    # for an expired token. Only attempt JWT refresh if we were actually using
    # the JWT path; if the API key was bad, no refresh will help.
    if response.status_code in (401, 403) and "Authorization" in headers:
        refreshed = await _refresh_supabase_jwt(creds)
        if not refreshed:
            raise RuntimeError(
                f"Cloud Sync: {response.status_code} from /policy/sync and JWT refresh failed"
            )
        # Refresh updated credentials on disk; let the next iteration retry
        # with the new JWT (avoids redoing the long-poll inside this call).
        raise RuntimeError("JWT refreshed; retrying on next iteration")
    if response.status_code != 200:
        raise RuntimeError(
            f"Cloud Sync: /policy/sync returned HTTP {response.status_code}"
        )
    return response.json()


async def _post_applied(
    creds: EnrolledCredentials,
    *,
    bundle_id: str,
    policy_id: str,
    version: int,
    status: str,
    error: Optional[str],
) -> None:
    """Best-effort POST /policy/applied. Log on failure but never raise."""
    base = get_lse_url().rstrip("/")
    url = f"{base}/policy/applied"
    payload = {
        "bundle_id": bundle_id,
        "policy_id": policy_id,
        "version": version,
        "device_id": get_device_id(),
        "org_id": creds.org_id,
        "applied_at": _now_iso(),
        "status": status,
        "error": error,
    }
    headers = {
        **_build_sync_auth_headers(creds),
        "X-SecureVector-Device-Id": get_device_id(),
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, json=payload, headers=headers)
        if response.status_code >= 400:
            logger.warning(
                "Cloud Sync: /policy/applied returned %d body=%s",
                response.status_code,
                response.text[:200],
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Cloud Sync: /policy/applied POST failed: %s", exc)


async def _refresh_supabase_jwt(creds: EnrolledCredentials) -> bool:
    """POST /auth/token with the refresh_token. Returns success."""
    if not creds.supabase_refresh_token:
        return False
    url = f"{get_auth_service_url().rstrip('/')}/auth/token"
    payload = {
        "grant_type": "refresh_token",
        "refresh_token": creds.supabase_refresh_token,
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(url, json=payload)
        if response.status_code != 200:
            logger.warning(
                "Cloud Sync: refresh failed, HTTP %d body=%s",
                response.status_code,
                response.text[:200],
            )
            return False
        body = response.json()
        access = body.get("access_token")
        refresh = body.get("refresh_token") or creds.supabase_refresh_token
        if not access:
            return False
        return update_supabase_jwt(access, refresh, body.get("expires_at"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("Cloud Sync: refresh raised %s", exc)
        return False


async def _get_last_applied_version(repo: SyncedRulesRepository) -> Optional[int]:
    """Highest version across any policy_id we've applied. Conservative — any
    applied policy reaching higher version than the new candidate triggers
    replay rejection. Tighten to per-policy_id when multi-policy stacking ships.
    """
    rows = await repo.list_all()
    if not rows:
        return None
    return max(r.policy_version for r in rows)


async def _get_last_bundle_id(repo: SyncedRulesRepository) -> Optional[str]:
    """The most recently applied bundle_id, used as the If-None-Match hint."""
    rows = await repo.list_all()
    if not rows:
        return None
    rows.sort(key=lambda r: r.applied_at, reverse=True)
    return rows[0].bundle_id


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
