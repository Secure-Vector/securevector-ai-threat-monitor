"""
Verify cloud-signed policy bundles before applying them locally.

Three independent checks, in order:
  1. HS256 signature — bundle hasn't been tampered with mid-flight.
  2. Freshness    — bundle isn't older than 24 h (replay window).
  3. Version guard — bundle version > last-applied version (replay attack).

A bundle is applied only if ALL three pass. A failure on any check leaves
the previously-applied bundle in effect and emits an audit event with
the failure reason.

active-mcp-and-policy-sync bundle, Phase 2 / Release B device side.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# Bundle freshness window — bundles older than this are rejected even if
# the signature is valid (limits replay-attack horizon if signing key
# is compromised). 24 h matches Phase 2 README spec.
BUNDLE_FRESHNESS_WINDOW = timedelta(hours=24)


class BundleVerificationError(Exception):
    """Bundle failed one of the three verification checks."""

    code: str

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class VerifiedBundle:
    """A bundle that passed all three checks. Safe to apply."""

    bundle_id: str
    org_id: str
    policy_id: str
    version: int
    mode: str
    signed_at: datetime
    expires_at: Optional[datetime]
    rules: list


def _canonical_json(payload: dict) -> bytes:
    """
    Produce the canonical-JSON form the server signed against.

    Match the server-side `json.dumps(bundle, sort_keys=True,
    separators=(",", ":"))` — sorting keys recursively isn't required
    because Python's json doesn't sort nested dicts when sort_keys is
    set (it does, actually — sort_keys propagates). Drop the `signature`
    field from the input before serialising.
    """
    body = {k: v for k, v in payload.items() if k != "signature"}
    return json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _verify_signature(payload: dict, signing_key: str) -> None:
    """Raise if the bundle's HS256 signature doesn't match."""
    signature = payload.get("signature")
    if not signature or not isinstance(signature, str):
        raise BundleVerificationError(
            "signature_invalid", "Bundle has no signature field"
        )

    canonical = _canonical_json(payload)
    expected = hmac.new(
        signing_key.encode("utf-8"), canonical, hashlib.sha256
    ).digest()
    expected_b64 = base64.urlsafe_b64encode(expected).rstrip(b"=").decode("ascii")

    # Constant-time compare to avoid timing oracles.
    if not hmac.compare_digest(expected_b64, signature):
        raise BundleVerificationError(
            "signature_invalid",
            "Bundle signature does not match expected HS256 over canonical JSON",
        )


def _parse_iso(s: str) -> datetime:
    """Parse an ISO-8601 timestamp; tolerate both Z and +00:00 suffix."""
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _verify_freshness(payload: dict, *, now: Optional[datetime] = None) -> datetime:
    """Raise if the bundle is older than the freshness window."""
    signed_at_str = payload.get("signed_at")
    if not signed_at_str:
        raise BundleVerificationError(
            "bundle_expired", "Bundle has no signed_at timestamp"
        )
    try:
        signed_at = _parse_iso(signed_at_str)
    except ValueError as exc:
        raise BundleVerificationError(
            "bundle_expired", f"Invalid signed_at: {exc}"
        ) from exc

    current = now or datetime.now(timezone.utc)
    age = current - signed_at
    if age > BUNDLE_FRESHNESS_WINDOW:
        raise BundleVerificationError(
            "bundle_expired",
            f"Bundle signed {age.total_seconds():.0f}s ago — exceeds "
            f"{BUNDLE_FRESHNESS_WINDOW.total_seconds():.0f}s freshness window",
        )

    expires_at_str = payload.get("expires_at")
    if expires_at_str:
        try:
            expires_at = _parse_iso(expires_at_str)
            if current > expires_at:
                raise BundleVerificationError(
                    "bundle_expired",
                    f"Bundle expired at {expires_at_str}",
                )
        except ValueError:
            # Unparseable expires_at is permissive — signed_at already enforced
            pass

    return signed_at


def _verify_version(payload: dict, last_applied_version: Optional[int]) -> int:
    """Raise if the new bundle's version isn't strictly greater than last applied."""
    version = payload.get("version")
    if not isinstance(version, int):
        raise BundleVerificationError(
            "version_replay", "Bundle has no integer version field"
        )
    if last_applied_version is not None and version <= last_applied_version:
        raise BundleVerificationError(
            "version_replay",
            f"Bundle version {version} <= last applied {last_applied_version}",
        )
    return version


def verify_bundle(
    payload: dict,
    *,
    signing_key: str,
    last_applied_version: Optional[int] = None,
    now: Optional[datetime] = None,
) -> VerifiedBundle:
    """
    Run all three checks; return a VerifiedBundle on success or raise.

    Args:
        payload: parsed JSON of the /policy/sync response body
        signing_key: HS256 signing key from credentials (set at enroll time)
        last_applied_version: highest version applied to this device so far,
            or None if no bundle has been applied yet (e.g. first poll after enrollment)
        now: optional override for the freshness clock (used in tests)
    """
    _verify_signature(payload, signing_key)
    signed_at = _verify_freshness(payload, now=now)
    version = _verify_version(payload, last_applied_version)

    expires_at = None
    expires_at_str = payload.get("expires_at")
    if expires_at_str:
        try:
            expires_at = _parse_iso(expires_at_str)
        except ValueError:
            expires_at = None

    return VerifiedBundle(
        bundle_id=str(payload.get("bundle_id") or ""),
        org_id=str(payload.get("org_id") or ""),
        policy_id=str(payload.get("policy_id") or ""),
        version=version,
        mode=str(payload.get("mode") or "audit"),
        signed_at=signed_at,
        expires_at=expires_at,
        rules=list(payload.get("rules") or []),
    )


def sign_bundle(payload: dict, signing_key: str) -> str:
    """
    Sign a bundle the same way the server does.

    Exposed for unit tests (round-trip verify) — the threat-monitor never
    signs production bundles itself.
    """
    canonical = _canonical_json(payload)
    digest = hmac.new(
        signing_key.encode("utf-8"), canonical, hashlib.sha256
    ).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
