"""
Device enrollment — redeems an `svet_*` token against the SecureVector cloud.

active-mcp-and-policy-sync bundle, Phase 2 / Release A device side.

Flow:
  1. Local app reads device_id (from existing utils/device_id.py).
  2. POST /api/v1/devices/enroll with { device_id, enrollment_token }.
  3. On success, persists the enrolled bundle (org binding + Supabase JWT
     + policy bundle signing key) to credentials.
  4. Caller can then start the cloud-sync loop and policy-sync long-poll.

Errors:
  - 401 token_already_used / token_invalid / token_expired → exit code 1
  - 409 device_id_collision (cloned VM) → suggest device-id reset
  - 5xx / network → retryable, surface as transient error
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

import httpx

from securevector.app.services.cloud_config import get_auth_service_url
from securevector.app.services.credentials import (
    EnrolledCredentials,
    save_enrolled_credentials,
)
from securevector.app.utils.device_id import get_device_id

logger = logging.getLogger(__name__)


class EnrollmentError(Exception):
    """Raised when enrollment fails. `code` matches the wire-format error_code."""

    def __init__(self, code: str, message: str, *, http_status: int = 0) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status


@dataclass
class EnrollmentResult:
    """Successful enrollment summary, returned to the caller (CLI / UI)."""

    user_email: str
    org_name: str
    org_id: str
    admin_email: Optional[str]
    group_memberships: list


async def enroll(
    token: str,
    *,
    hostname: Optional[str] = None,
    os_name: Optional[str] = None,
    app_version: Optional[str] = None,
) -> EnrollmentResult:
    """
    Redeem an enrollment token. On success, persists credentials and
    returns an EnrollmentResult; on failure raises EnrollmentError with a
    machine-readable `code`.
    """
    if not token or not token.startswith("svet_"):
        raise EnrollmentError(
            "token_invalid",
            "Enrollment tokens must start with `svet_`",
        )

    device_id = get_device_id()
    auth_url = get_auth_service_url().rstrip("/")
    endpoint = f"{auth_url}/api/v1/devices/enroll"

    payload = {
        "device_id": device_id,
        "enrollment_token": token,
    }
    if hostname:
        payload["hostname"] = hostname
    if os_name:
        payload["os"] = os_name
    if app_version:
        payload["app_version"] = app_version

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            response = await client.post(endpoint, json=payload)
        except httpx.RequestError as exc:
            raise EnrollmentError(
                "network_error",
                f"Could not reach SecureVector cloud at {auth_url}: {exc}",
            ) from exc

    if response.status_code == 401:
        body = _safe_json(response)
        code = (body.get("detail", {}) if isinstance(body.get("detail"), dict) else {}).get(
            "error"
        ) or body.get("error") or "token_invalid"
        raise EnrollmentError(
            code,
            _extract_message(body) or "Enrollment token is invalid, used, or expired",
            http_status=401,
        )
    if response.status_code == 409:
        body = _safe_json(response)
        raise EnrollmentError(
            "device_id_collision",
            _extract_message(body)
            or "This device_id is already enrolled. Run device-id reset and retry.",
            http_status=409,
        )
    if response.status_code >= 500:
        raise EnrollmentError(
            "server_error",
            f"Cloud returned {response.status_code} during enrollment",
            http_status=response.status_code,
        )
    if response.status_code != 200:
        body = _safe_json(response)
        raise EnrollmentError(
            "enrollment_failed",
            _extract_message(body) or f"Enrollment failed: HTTP {response.status_code}",
            http_status=response.status_code,
        )

    data = response.json()
    if not data.get("success"):
        raise EnrollmentError(
            "enrollment_failed",
            data.get("error") or "Enrollment response had success=false",
        )

    creds = EnrolledCredentials(
        device_record_id=data["device_record_id"],
        device_id=data["device_id"],
        org_id=data["org_id"],
        org_name=data["org_name"],
        user_id=data["user_id"],
        user_email=data["user_email"],
        admin_email=data.get("admin_email"),
        group_memberships=list(data.get("group_memberships") or []),
        supabase_jwt=data.get("access_token"),
        supabase_refresh_token=data.get("refresh_token"),
        policy_bundle_signing_key=data.get("policy_bundle_signing_key"),
    )

    if not save_enrolled_credentials(creds):
        raise EnrollmentError(
            "credentials_save_failed",
            "Enrollment succeeded but credentials could not be persisted to disk",
        )

    logger.info(
        "Enrolled as %s (%s) — device_record %s",
        creds.user_email,
        creds.org_name,
        creds.device_record_id,
    )
    return EnrollmentResult(
        user_email=creds.user_email,
        org_name=creds.org_name,
        org_id=creds.org_id,
        admin_email=creds.admin_email,
        group_memberships=list(creds.group_memberships),
    )


def _safe_json(response: "httpx.Response") -> dict:
    try:
        return response.json()
    except Exception:
        return {}


def _extract_message(body: dict) -> Optional[str]:
    """Pull the human-readable message out of FastAPI-style error envelopes."""
    detail = body.get("detail")
    if isinstance(detail, dict):
        return detail.get("message") or detail.get("error")
    if isinstance(detail, str):
        return detail
    return body.get("message") or body.get("error")
