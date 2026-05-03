"""
Cloud Sync subsystem — async long-poll loop pulling signed policy bundles
from llm-security-engine `/policy/sync` and applying them locally.

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
import logging
import random
from typing import Optional

import httpx

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.repositories.synced_rules import SyncedRulesRepository
from securevector.app.services.bundle_verifier import (
    BundleVerificationError,
    verify_bundle,
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


# Module-level task handle so lifespan stop can cancel it.
_sync_task: Optional[asyncio.Task] = None


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


async def _sync_loop(db: DatabaseConnection) -> None:
    """Top-level loop. Never returns on its own."""
    repo = SyncedRulesRepository(db)
    backoff = TRANSIENT_BACKOFF_BASE

    while True:
        try:
            applied = await _sync_once(db, repo)
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
    db: DatabaseConnection, repo: SyncedRulesRepository
) -> bool:
    """
    One iteration: long-poll for a new bundle, verify, apply, ack.

    Returns True if a new bundle was applied; False on 304 / no-change.
    Raises on transient errors (the loop catches and backs off).
    """
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
        return False  # 304 no change

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
        policy_version=verified.version,
        org_id=verified.org_id,
        org_name=creds.org_name,
        rules=verified.rules,
    )
    logger.info(
        "Cloud Sync: applied bundle %s policy=%s v=%d (%d rules)",
        verified.bundle_id,
        verified.policy_id,
        verified.version,
        len(verified.rules),
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
        "Authorization": f"Bearer {creds.supabase_jwt or ''}",
        "X-SecureVector-Device-Id": get_device_id(),
    }
    if bundle_id_hint:
        headers["If-None-Match"] = bundle_id_hint

    async with httpx.AsyncClient(timeout=LONG_POLL_TIMEOUT_SECONDS + 5) as client:
        response = await client.get(url, headers=headers)

    if response.status_code == 304:
        return None
    if response.status_code == 401:
        # JWT expired or revoked — try refresh once.
        refreshed = await _refresh_supabase_jwt(creds)
        if not refreshed:
            raise RuntimeError(
                "Cloud Sync: 401 from /policy/sync and JWT refresh failed"
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
        "Authorization": f"Bearer {creds.supabase_jwt or ''}",
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
    """POST identity-service /auth/token with the refresh_token. Returns success."""
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
