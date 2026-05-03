"""
Unit tests for the policy bundle verifier (active-mcp-and-policy-sync).

Coverage:
- Sign+verify round-trip
- Tampered bundle rejection (signature_invalid)
- Bundle older than 24h rejection (bundle_expired)
- Version replay rejection (version_replay)
- Missing fields rejection
"""

from datetime import datetime, timedelta, timezone

import pytest

from securevector.app.services.bundle_verifier import (
    BUNDLE_FRESHNESS_WINDOW,
    BundleVerificationError,
    sign_bundle,
    verify_bundle,
)


SIGNING_KEY = "test-signing-key-32bytes-aaaaaaaa"


def _make_bundle(version: int = 1, signed_at: datetime | None = None, **overrides):
    """Build a sample bundle, sign it, return the dict ready for verify."""
    signed_at = signed_at or datetime.now(timezone.utc)
    payload = {
        "bundle_id": "bnd_test123",
        "org_id": "org_xyz",
        "policy_id": "pol_001",
        "version": version,
        "mode": "enforce",
        "signed_at": signed_at.isoformat(),
        "expires_at": (signed_at + timedelta(hours=24)).isoformat(),
        "rules": [
            {"tool_id": "filesystem.write", "effect": "deny", "priority": 100}
        ],
    }
    payload.update(overrides)
    payload["signature"] = sign_bundle(payload, SIGNING_KEY)
    return payload


def test_round_trip_signs_and_verifies():
    bundle = _make_bundle()
    verified = verify_bundle(bundle, signing_key=SIGNING_KEY, last_applied_version=None)
    assert verified.bundle_id == "bnd_test123"
    assert verified.version == 1
    assert verified.mode == "enforce"
    assert len(verified.rules) == 1


def test_tampered_payload_rejected():
    bundle = _make_bundle()
    # Mutate a non-signature field after signing
    bundle["mode"] = "audit"
    with pytest.raises(BundleVerificationError) as excinfo:
        verify_bundle(bundle, signing_key=SIGNING_KEY)
    assert excinfo.value.code == "signature_invalid"


def test_wrong_signing_key_rejected():
    bundle = _make_bundle()
    with pytest.raises(BundleVerificationError) as excinfo:
        verify_bundle(bundle, signing_key="wrong-key")
    assert excinfo.value.code == "signature_invalid"


def test_bundle_older_than_freshness_window_rejected():
    too_old = datetime.now(timezone.utc) - BUNDLE_FRESHNESS_WINDOW - timedelta(minutes=1)
    bundle = _make_bundle(signed_at=too_old)
    with pytest.raises(BundleVerificationError) as excinfo:
        verify_bundle(bundle, signing_key=SIGNING_KEY)
    assert excinfo.value.code == "bundle_expired"


def test_version_replay_rejected():
    bundle = _make_bundle(version=5)
    with pytest.raises(BundleVerificationError) as excinfo:
        verify_bundle(bundle, signing_key=SIGNING_KEY, last_applied_version=5)
    assert excinfo.value.code == "version_replay"


def test_version_strictly_greater_passes():
    bundle = _make_bundle(version=6)
    verified = verify_bundle(bundle, signing_key=SIGNING_KEY, last_applied_version=5)
    assert verified.version == 6


def test_missing_signature_rejected():
    bundle = _make_bundle()
    bundle.pop("signature")
    with pytest.raises(BundleVerificationError) as excinfo:
        verify_bundle(bundle, signing_key=SIGNING_KEY)
    assert excinfo.value.code == "signature_invalid"


def test_missing_signed_at_rejected():
    bundle = _make_bundle()
    bundle.pop("signed_at")
    # Re-sign without signed_at
    bundle.pop("signature")
    bundle["signature"] = sign_bundle(bundle, SIGNING_KEY)
    with pytest.raises(BundleVerificationError) as excinfo:
        verify_bundle(bundle, signing_key=SIGNING_KEY)
    assert excinfo.value.code == "bundle_expired"


def test_missing_version_rejected():
    bundle = _make_bundle()
    bundle.pop("version")
    bundle.pop("signature")
    bundle["signature"] = sign_bundle(bundle, SIGNING_KEY)
    with pytest.raises(BundleVerificationError) as excinfo:
        verify_bundle(bundle, signing_key=SIGNING_KEY)
    assert excinfo.value.code == "version_replay"
