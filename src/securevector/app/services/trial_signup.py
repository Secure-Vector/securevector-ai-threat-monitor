"""
One-click cloud trial — OAuth-style device flow client (local half).

2026-07-14-conversion-ux bundle, v5.0.0 feature 2 (local half).

Flow (mirrors RFC 8628 device authorization grant, trial-signup variant):
  1. Local app POSTs /api/v1/trial/device/code with { device_id, app_version }.
  2. Cloud returns { device_code, user_code, verification_uri_complete,
     interval, expires_in }; the UI opens the browser to the verification URI
     where the user signs up (or logs in) — the trial + personal svpk_ key
     are minted cloud-side on completion.
  3. Local app polls /api/v1/trial/device/token with { device_code,
     device_id } until status=complete, then persists the returned svpk_ key
     via the existing credentials service (caller's job).

Errors:
  - 404/405 from the auth service → trial_unavailable (the trial-signup
    variant is not deployed yet — the local UI falls back to the manual
    paste-a-key path). This keeps v5.0.0 shippable before the cloud half.
  - authorization_pending / slow_down → keep polling (slow_down: back off).
  - expired_token / access_denied → terminal, restart the flow.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

import httpx

from securevector.app.services.cloud_config import get_auth_service_url
from securevector.app.utils.device_id import get_device_id

logger = logging.getLogger(__name__)


class TrialSignupError(Exception):
    """Raised when the device flow fails. `code` matches the wire error_code."""

    def __init__(self, code: str, message: str, *, http_status: int = 0) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status


@dataclass
class DeviceCodeGrant:
    """Successful device-code request — what the UI needs to send the user off."""

    device_code: str
    user_code: str
    verification_uri: str
    verification_uri_complete: str
    interval: int
    expires_in: int


@dataclass
class TrialTokenResult:
    """One poll of the token endpoint."""

    # "complete" | "pending" | "slow_down"
    status: str
    api_key: Optional[str] = None
    user_email: Optional[str] = None


def _safe_json(response: "httpx.Response") -> dict:
    try:
        return response.json()
    except Exception:
        return {}


def _extract_message(body: dict) -> Optional[str]:
    detail = body.get("detail")
    if isinstance(detail, dict):
        return detail.get("message") or detail.get("error")
    if isinstance(detail, str):
        return detail
    return body.get("message") or body.get("error") or body.get("error_description")


def _extract_code(body: dict) -> Optional[str]:
    detail = body.get("detail")
    if isinstance(detail, dict) and detail.get("error"):
        return detail["error"]
    return body.get("error") or body.get("error_code")


async def request_device_code(*, app_version: Optional[str] = None) -> DeviceCodeGrant:
    """
    Ask the auth service for a trial-signup device code. Raises
    TrialSignupError("trial_unavailable") when the cloud half is not deployed,
    so the UI can quietly fall back to the manual key path.
    """
    auth_url = get_auth_service_url().rstrip("/")
    endpoint = f"{auth_url}/api/v1/trial/device/code"

    payload = {"device_id": get_device_id()}
    if app_version:
        payload["app_version"] = app_version

    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            response = await client.post(endpoint, json=payload)
        except httpx.RequestError as exc:
            raise TrialSignupError(
                "network_error",
                f"Could not reach SecureVector cloud at {auth_url}: {exc}",
            ) from exc

    if response.status_code in (404, 405, 501):
        # Trial-signup variant not deployed on this auth service yet.
        raise TrialSignupError(
            "trial_unavailable",
            "One-click trial signup is not available yet — "
            "use app.securevector.io to create a key.",
            http_status=response.status_code,
        )
    if response.status_code == 429:
        raise TrialSignupError(
            "rate_limited",
            "Too many trial-signup attempts from this device. Try again later.",
            http_status=429,
        )
    if response.status_code != 200:
        body = _safe_json(response)
        raise TrialSignupError(
            _extract_code(body) or "trial_signup_failed",
            _extract_message(body)
            or f"Trial signup failed: HTTP {response.status_code}",
            http_status=response.status_code,
        )

    data = _safe_json(response)
    required = ("device_code", "user_code", "verification_uri_complete")
    if not all(data.get(k) for k in required):
        raise TrialSignupError(
            "bad_response",
            "Trial signup response was missing required fields",
        )
    return DeviceCodeGrant(
        device_code=data["device_code"],
        user_code=data["user_code"],
        verification_uri=data.get("verification_uri")
        or data["verification_uri_complete"],
        verification_uri_complete=data["verification_uri_complete"],
        interval=int(data.get("interval") or 5),
        expires_in=int(data.get("expires_in") or 900),
    )


async def poll_trial_token(device_code: str) -> TrialTokenResult:
    """
    One poll of the token endpoint. Returns pending/slow_down/complete;
    raises TrialSignupError for terminal outcomes (expired, denied, network).
    The returned api_key is NOT persisted here — the route persists it via
    the existing credentials service so all key-handling stays in one place.
    """
    if not device_code:
        raise TrialSignupError("bad_request", "device_code is required")

    auth_url = get_auth_service_url().rstrip("/")
    endpoint = f"{auth_url}/api/v1/trial/device/token"
    payload = {"device_code": device_code, "device_id": get_device_id()}

    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            response = await client.post(endpoint, json=payload)
        except httpx.RequestError as exc:
            raise TrialSignupError(
                "network_error",
                f"Could not reach SecureVector cloud at {auth_url}: {exc}",
            ) from exc

    body = _safe_json(response)
    code = _extract_code(body)

    if response.status_code == 200:
        status = body.get("status") or ("complete" if body.get("api_key") else "pending")
        if status == "complete":
            api_key = body.get("api_key") or ""
            if not api_key.startswith("svpk_"):
                raise TrialSignupError(
                    "bad_response",
                    "Trial signup completed but no personal key was returned",
                )
            return TrialTokenResult(
                status="complete",
                api_key=api_key,
                user_email=body.get("user_email"),
            )
        if status in ("authorization_pending", "pending"):
            return TrialTokenResult(status="pending")
        if status == "slow_down":
            return TrialTokenResult(status="slow_down")
        raise TrialSignupError(
            code or "trial_signup_failed",
            _extract_message(body) or f"Unexpected trial status: {status}",
        )

    # RFC 8628 sends non-terminal + terminal states as HTTP 400 error codes.
    if code in ("authorization_pending",):
        return TrialTokenResult(status="pending")
    if code in ("slow_down",):
        return TrialTokenResult(status="slow_down")
    if code in ("expired_token",):
        raise TrialSignupError(
            "expired_token",
            "The signup window expired before it was completed. Start again.",
            http_status=response.status_code,
        )
    if code in ("access_denied",):
        raise TrialSignupError(
            "access_denied",
            "The signup was cancelled in the browser.",
            http_status=response.status_code,
        )
    if response.status_code in (404, 405, 501):
        raise TrialSignupError(
            "trial_unavailable",
            "One-click trial signup is not available yet.",
            http_status=response.status_code,
        )
    raise TrialSignupError(
        code or "trial_signup_failed",
        _extract_message(body) or f"Trial signup failed: HTTP {response.status_code}",
        http_status=response.status_code,
    )
