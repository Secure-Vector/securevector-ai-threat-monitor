"""
One-click cloud trial — OAuth device flow client (local half).

2026-07-14-conversion-ux bundle, v5.0.0 feature 2 (local half).

Speaks identity-service's actual OAuth device-grant contract (RFC 8628):
  1. POST {auth}/oauth/device/code  { client_id, scope } →
     { device_code, user_code, verification_uri, interval, expires_in }.
     The UI opens the browser to the cloud app's /login/device page (with
     user_code prefilled) where the user signs up or logs in; signup accepts
     the user_code and authorizes the grant cloud-side.
  2. POST {auth}/oauth/token/json  { grant_type: "device_code", client_id,
     device_code, mint_api_key: true } until the grant is authorized. Polling
     states come back as an HTTP-200 body with an `error` field
     (authorization_pending / expired_token / invalid_grant). On success the
     response carries access_token + an auto-minted personal svpk_ key
     (nested {id, name, api_key}); if minting was skipped or failed, we fall
     back to POST /oauth/api-keys/json with the fresh access token, and fetch
     the account email from GET /oauth/user for the "Connected as …" UI.

Errors:
  - 404/405/501 from the auth service → trial_unavailable (device flow not
    deployed on this auth service — the local UI falls back to the manual
    paste-a-key path). This keeps v5.0.0 shippable against older clouds.
  - authorization_pending → keep polling; HTTP 429 → slow_down (back off).
  - expired_token / access_denied / invalid_grant → terminal, restart flow.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Optional

import httpx

from securevector.app.services.cloud_config import get_auth_service_url

logger = logging.getLogger(__name__)

# The device-grant client identity for the local app. identity-service binds
# each device code to the client_id that requested it and requires the same
# value on the token exchange; there is no server-side client registry.
OAUTH_CLIENT_ID = os.environ.get("SV_OAUTH_CLIENT_ID", "securevector-local-app")
OAUTH_SCOPE = "read write"

# Where the user lands to enter/confirm the user_code. identity-service
# returns its own verification_uri (env-configured per deployment); when that
# points at the auth API itself (a POST-only endpoint, not a browsable page)
# we send the user to the cloud app's device page instead.
APP_DEVICE_LOGIN_URL = os.environ.get(
    "SV_APP_DEVICE_LOGIN_URL", "https://app.securevector.io/login/device"
)


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
    return body.get("message") or body.get("error_description") or body.get("error")


def _extract_code(body: dict) -> Optional[str]:
    detail = body.get("detail")
    if isinstance(detail, dict) and detail.get("error"):
        return detail["error"]
    return body.get("error") or body.get("error_code")


def _browsable_verification_uri(server_uri: Optional[str], user_code: str) -> tuple[str, str]:
    """
    Pick the page the browser should open and build its ?user_code= variant.
    A server verification_uri under the auth service's own /oauth/ path is the
    POST-only verify endpoint, not a page — use the app's device-login page.
    """
    uri = (server_uri or "").strip()
    if not uri or "/oauth/device" in uri:
        uri = APP_DEVICE_LOGIN_URL
    sep = "&" if "?" in uri else "?"
    return uri, f"{uri}{sep}user_code={user_code}"


async def request_device_code(*, app_version: Optional[str] = None) -> DeviceCodeGrant:
    """
    Ask the auth service for a device code. Raises
    TrialSignupError("trial_unavailable") when the flow is not deployed,
    so the UI can quietly fall back to the manual key path.
    """
    auth_url = get_auth_service_url().rstrip("/")
    endpoint = f"{auth_url}/oauth/device/code"

    payload = {"client_id": OAUTH_CLIENT_ID, "scope": OAUTH_SCOPE}

    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            response = await client.post(endpoint, json=payload)
        except httpx.RequestError as exc:
            raise TrialSignupError(
                "network_error",
                f"Could not reach SecureVector cloud at {auth_url}: {exc}",
            ) from exc

    if response.status_code in (404, 405, 501):
        # Device flow not deployed on this auth service.
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
    if not (data.get("device_code") and data.get("user_code")):
        raise TrialSignupError(
            "bad_response",
            "Trial signup response was missing required fields",
        )
    user_code = str(data["user_code"])
    complete = data.get("verification_uri_complete")
    # A pre-fix identity-service can send a verification_uri_complete built on
    # its own POST-only /oauth/device/verify endpoint. Trust the server value
    # only when it is browsable; otherwise rebuild both URIs locally.
    if complete and "/oauth/device" not in str(complete):
        uri = data.get("verification_uri") or complete
    else:
        uri, complete = _browsable_verification_uri(data.get("verification_uri"), user_code)
    return DeviceCodeGrant(
        device_code=data["device_code"],
        user_code=user_code,
        verification_uri=uri,
        verification_uri_complete=complete,
        interval=int(data.get("interval") or 5),
        expires_in=int(data.get("expires_in") or 600),
    )


async def _mint_key_fallback(client: "httpx.AsyncClient", auth_url: str, access_token: str) -> Optional[str]:
    """Mint a personal key with the fresh access token when the token exchange
    didn't return one (mint_api_key unsupported or minting failed server-side)."""
    try:
        response = await client.post(
            f"{auth_url}/oauth/api-keys/json",
            json={"name": "Local App — Cloud Connect", "permissions": ["read", "write"]},
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if response.status_code in (200, 201):
            key = _safe_json(response).get("api_key")
            if isinstance(key, str) and key.startswith("svpk_"):
                return key
        logger.warning("Fallback API-key mint failed: HTTP %s", response.status_code)
    except httpx.RequestError as exc:
        logger.warning("Fallback API-key mint unreachable: %s", exc)
    return None


async def _fetch_user_email(client: "httpx.AsyncClient", auth_url: str, access_token: str) -> Optional[str]:
    """Best-effort account email for the "Connected as …" UI."""
    try:
        response = await client.get(
            f"{auth_url}/oauth/user",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if response.status_code == 200:
            user = _safe_json(response).get("user") or {}
            return user.get("email")
    except httpx.RequestError:
        pass
    return None


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
    endpoint = f"{auth_url}/oauth/token/json"
    payload = {
        "grant_type": "device_code",
        "client_id": OAUTH_CLIENT_ID,
        "device_code": device_code,
        "mint_api_key": True,
    }

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

        # identity-service returns polling states as an HTTP-200 body with an
        # `error` field (OAuthErrorResponse), success as OAuthTokenResponse.
        if response.status_code == 200 and not code:
            access_token = body.get("access_token")
            if not access_token:
                raise TrialSignupError(
                    "bad_response", "Token exchange returned no access token"
                )
            minted = body.get("api_key")
            api_key = minted.get("api_key") if isinstance(minted, dict) else minted
            if not (isinstance(api_key, str) and api_key.startswith("svpk_")):
                api_key = await _mint_key_fallback(client, auth_url, access_token)
            if not api_key:
                raise TrialSignupError(
                    "bad_response",
                    "Trial signup completed but no personal key was returned",
                )
            user_email = await _fetch_user_email(client, auth_url, access_token)
            return TrialTokenResult(
                status="complete", api_key=api_key, user_email=user_email
            )

    if code in ("authorization_pending",):
        return TrialTokenResult(status="pending")
    if code in ("slow_down",) or response.status_code == 429:
        return TrialTokenResult(status="slow_down")
    if code in ("expired_token",):
        raise TrialSignupError(
            "expired_token",
            "The signup window expired before it was completed. Start again.",
            http_status=response.status_code,
        )
    if code in ("access_denied", "invalid_grant"):
        raise TrialSignupError(
            "access_denied",
            "The signup was cancelled or the code was already used. Start again.",
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
