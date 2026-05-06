"""
Unit tests for GET /api/v1/policy-sync/status — header badge data source.

Covers the two states the UI needs to distinguish:
  - not enrolled → enrolled=False, message explains personal-mode behavior
  - enrolled (svet_*) → enrolled=True, org info + last bundle stats present
"""

import asyncio
from unittest.mock import patch

import pytest

from securevector.app.server.routes.device_admin import policy_sync_status
from securevector.app.services.credentials import EnrolledCredentials


@pytest.mark.asyncio
async def test_not_enrolled_returns_off_with_explanatory_message():
    with patch(
        "securevector.app.server.routes.device_admin.is_enrolled", return_value=False
    ):
        resp = await policy_sync_status()

    assert resp.enrolled is False
    assert resp.org_id is None
    assert resp.org_name is None
    assert resp.synced_rule_count == 0
    # Personal-mode users must see explicit messaging that nothing changed
    assert "OFF" in resp.message
    assert "not enrolled" in resp.message.lower()
    assert "personal" in resp.message.lower()


@pytest.mark.asyncio
async def test_enrolled_with_no_bundle_yet_signals_waiting():
    creds = EnrolledCredentials(
        device_record_id="dev_record_1",
        device_id="sv-abc",
        org_id="org_xyz",
        org_name="Acme Corp",
        user_id="user_1",
        user_email="alice@acme.com",
        admin_email="admin@acme.com",
        group_memberships=["engineering"],
    )

    class FakeRepo:
        def __init__(self, *_, **__):
            pass

        async def list_all(self):
            return []

    with (
        patch(
            "securevector.app.server.routes.device_admin.is_enrolled", return_value=True
        ),
        patch(
            "securevector.app.server.routes.device_admin.get_enrolled_credentials",
            return_value=creds,
        ),
        patch(
            "securevector.app.server.routes.device_admin.get_database",
            return_value=None,
        ),
        patch(
            "securevector.app.server.routes.device_admin.SyncedRulesRepository",
            FakeRepo,
        ),
    ):
        resp = await policy_sync_status()

    assert resp.enrolled is True
    assert resp.org_id == "org_xyz"
    assert resp.org_name == "Acme Corp"
    assert resp.admin_email == "admin@acme.com"
    assert resp.user_email == "alice@acme.com"
    assert resp.last_synced_bundle_id is None
    assert resp.last_synced_version is None
    assert resp.synced_rule_count == 0
    assert "waiting" in resp.message.lower()


@pytest.mark.asyncio
async def test_enrolled_with_bundle_returns_latest_version_and_count():
    creds = EnrolledCredentials(
        device_record_id="dev_record_1",
        device_id="sv-abc",
        org_id="org_xyz",
        org_name="Acme Corp",
        user_id="user_1",
        user_email="alice@acme.com",
    )

    # Three rows from two bundles; latest by applied_at should win
    class _Row:
        def __init__(self, bundle_id, policy_id, version, applied_at):
            self.bundle_id = bundle_id
            self.policy_id = policy_id
            self.policy_version = version
            self.applied_at = applied_at

    rows = [
        _Row("bnd_old", "pol_001", 5, "2026-05-01T00:00:00+00:00"),
        _Row("bnd_new", "pol_001", 7, "2026-05-03T10:00:00+00:00"),
        _Row("bnd_new", "pol_001", 7, "2026-05-03T10:00:00+00:00"),
    ]

    class FakeRepo:
        def __init__(self, *_, **__):
            pass

        async def list_all(self):
            return rows

    with (
        patch(
            "securevector.app.server.routes.device_admin.is_enrolled", return_value=True
        ),
        patch(
            "securevector.app.server.routes.device_admin.get_enrolled_credentials",
            return_value=creds,
        ),
        patch(
            "securevector.app.server.routes.device_admin.get_database",
            return_value=None,
        ),
        patch(
            "securevector.app.server.routes.device_admin.SyncedRulesRepository",
            FakeRepo,
        ),
    ):
        resp = await policy_sync_status()

    assert resp.enrolled is True
    assert resp.last_synced_bundle_id == "bnd_new"
    assert resp.last_synced_policy_id == "pol_001"
    assert resp.last_synced_version == 7
    assert resp.synced_rule_count == 3
    assert "ON" in resp.message
    assert "Acme Corp" in resp.message
