"""
Unit tests for the policy bundle verifier (active-mcp-and-policy-sync).

Coverage:
- Sign+verify round-trip
- Tampered bundle rejection (signature_invalid)
- Bundle older than 24h rejection (bundle_expired)
- Version replay rejection (version_replay)
- Missing fields rejection
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from securevector.app.services.bundle_verifier import (
    BUNDLE_FRESHNESS_WINDOW,
    BundleVerificationError,
    fingerprint_signing_key,
    sign_bundle,
    verify_bundle,
    verify_envelope,
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


# ---------------------------------------------------------------------------
# verify_envelope — tamper-detect path (V31)
# ---------------------------------------------------------------------------


def _canonical(payload: dict) -> str:
    """Serialise the way cloud_sync persists the envelope on apply —
    sorted keys, tight separators, matches bundle_verifier._canonical_json
    so the signature round-trips through json.dumps + json.loads."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def test_envelope_round_trip_verifies():
    bundle = _make_bundle()
    envelope_json = _canonical(bundle)
    # Should not raise — same signature, same canonical bytes.
    verify_envelope(envelope_json, signing_key=SIGNING_KEY)


def test_envelope_rejected_when_payload_field_mutated():
    """Mimic a sqlite3-shell edit: someone flips an effect inside the
    stored bundle_json. The recomputed HMAC over the new canonical bytes
    won't match the stored signature."""
    bundle = _make_bundle()
    bundle["rules"][0]["effect"] = "allow"  # tampered AFTER signing
    envelope_json = _canonical(bundle)
    with pytest.raises(BundleVerificationError) as excinfo:
        verify_envelope(envelope_json, signing_key=SIGNING_KEY)
    assert excinfo.value.code == "signature_invalid"


def test_envelope_rejected_when_signature_stripped():
    bundle = _make_bundle()
    bundle.pop("signature")
    envelope_json = _canonical(bundle)
    with pytest.raises(BundleVerificationError) as excinfo:
        verify_envelope(envelope_json, signing_key=SIGNING_KEY)
    assert excinfo.value.code == "signature_invalid"


def test_envelope_rejected_when_signing_key_mismatch():
    """Same bundle, different device key — catches the case where a
    bundle from another device is dropped into the SQLite file."""
    bundle = _make_bundle()
    envelope_json = _canonical(bundle)
    with pytest.raises(BundleVerificationError) as excinfo:
        verify_envelope(envelope_json, signing_key="some-other-key-32bytes-aaaaaaaa")
    assert excinfo.value.code == "signature_invalid"


def test_envelope_rejected_when_bundle_json_not_json():
    with pytest.raises(BundleVerificationError) as excinfo:
        verify_envelope("not-json-at-all", signing_key=SIGNING_KEY)
    assert excinfo.value.code == "envelope_unparseable"


def test_envelope_rejected_when_bundle_json_not_object():
    """A JSON list / scalar in bundle_json is structurally invalid."""
    with pytest.raises(BundleVerificationError) as excinfo:
        verify_envelope("[1, 2, 3]", signing_key=SIGNING_KEY)
    assert excinfo.value.code == "envelope_unparseable"


def test_envelope_round_trip_ignores_freshness_window():
    """verify_envelope is for *stored* bundles — freshness is checked at
    apply time on the wire, not on every poll. A bundle whose signed_at
    is 48h old still re-verifies fine; freshness becomes a separate
    health-snapshot concern."""
    old = datetime.now(timezone.utc) - timedelta(hours=48)
    bundle = _make_bundle(signed_at=old)
    envelope_json = _canonical(bundle)
    verify_envelope(envelope_json, signing_key=SIGNING_KEY)


def test_fingerprint_signing_key_deterministic():
    fp1 = fingerprint_signing_key(SIGNING_KEY)
    fp2 = fingerprint_signing_key(SIGNING_KEY)
    assert fp1 == fp2
    assert fp1.startswith("sha256:")
    # Different key → different fingerprint
    fp3 = fingerprint_signing_key("different-key")
    assert fp3 != fp1
