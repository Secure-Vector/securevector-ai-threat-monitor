"""
The device side of cloud-authored egress policy: verify, store, apply, revoke.

Two ends of one seam are pinned here.

At the verifier: the `egress` key is inside the signed body, so a bundle whose
allowlist was widened in flight must fail signature verification, and a bundle
from an engine that predates the field must still verify. Getting the second
one wrong would break every already-enrolled device on the day the cloud half
ships.

At the store: an org policy that stops being sent has to stop being enforced.
A device that only ever wrote on presence would keep applying a policy the
admin already deleted, with no way to remove it from the UI.
"""

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.egress import EgressRepository
from securevector.app.services.bundle_verifier import (
    BundleVerificationError,
    sign_bundle,
    verify_bundle,
)
from securevector.app.services.cloud_sync import _apply_egress

SIGNING_KEY = "test-signing-key-32-bytes-aaaaaa"


def _bundle(**extra):
    from datetime import datetime, timezone

    body = {
        "bundle_id": "bnd_test",
        "org_id": "org_1",
        "policy_id": "org:org_1",
        "version": 12,
        "mode": "enforce",
        "signed_at": datetime.now(timezone.utc).isoformat(),
        "rules": [],
        "signing_key_id": "k1",
        **extra,
    }
    body["signature"] = sign_bundle(body, SIGNING_KEY)
    return body


def _egress_section(**over):
    return {
        "preset": "contained",
        "allowlist": ["github.com"],
        "denylist": ["paste.example"],
        "sources": [{
            "policy_id": "pol_1", "policy_name": "Locked down",
            "policy_version": 3, "preset": "contained",
        }],
        **over,
    }


# --- verifier --------------------------------------------------------------

class TestVerifier:
    def test_a_bundle_without_egress_still_verifies(self):
        # Backward compatibility with engines that predate the field. This is
        # the case that would break every enrolled device if it regressed.
        verified = verify_bundle(_bundle(), signing_key=SIGNING_KEY)
        assert verified.egress is None

    def test_egress_section_is_surfaced_on_the_verified_bundle(self):
        verified = verify_bundle(
            _bundle(egress=_egress_section()), signing_key=SIGNING_KEY
        )
        assert verified.egress["preset"] == "contained"
        assert verified.egress["allowlist"] == ["github.com"]

    def test_widening_the_allowlist_in_flight_fails_verification(self):
        bundle = _bundle(egress=_egress_section())
        bundle["egress"]["allowlist"].append("attacker.example")
        with pytest.raises(BundleVerificationError) as exc:
            verify_bundle(bundle, signing_key=SIGNING_KEY)
        assert exc.value.code == "signature_invalid"

    def test_adding_an_egress_section_in_flight_fails_verification(self):
        bundle = _bundle()
        bundle["egress"] = _egress_section(preset="baseline")
        with pytest.raises(BundleVerificationError):
            verify_bundle(bundle, signing_key=SIGNING_KEY)

    def test_a_non_dict_egress_value_is_ignored_rather_than_crashing(self):
        verified = verify_bundle(
            _bundle(egress="contained"), signing_key=SIGNING_KEY
        )
        assert verified.egress is None


# --- store and apply -------------------------------------------------------

async def _db(tmp_path):
    db = DatabaseConnection(tmp_path / "consumer.db")
    await run_migrations(db)
    return db


class TestApply:
    @pytest.mark.asyncio
    async def test_applying_a_bundle_stores_the_org_policy(self, tmp_path):
        db = await _db(tmp_path)
        verified = verify_bundle(
            _bundle(egress=_egress_section()), signing_key=SIGNING_KEY
        )
        await _apply_egress(db, verified)

        row = await EgressRepository(db).get_synced_policy()
        assert row["preset"] == "contained"
        assert row["allowlist"] == ["github.com"]
        assert row["denylist"] == ["paste.example"]
        assert row["name"] == "Locked down"
        assert row["policy_version"] == 3

    @pytest.mark.asyncio
    async def test_the_local_policy_survives_an_org_policy_arriving(
        self, tmp_path
    ):
        db = await _db(tmp_path)
        repo = EgressRepository(db)
        local_before = await repo.get_active_policy()

        await _apply_egress(
            db, verify_bundle(
                _bundle(egress=_egress_section()), signing_key=SIGNING_KEY
            )
        )

        local_after = await repo.get_active_policy()
        assert local_after["id"] == local_before["id"]
        assert local_after["source"] == "local"

    @pytest.mark.asyncio
    async def test_a_later_bundle_replaces_rather_than_accumulates(
        self, tmp_path
    ):
        # A host the admin removed upstream has to stop applying here.
        db = await _db(tmp_path)
        await _apply_egress(db, verify_bundle(
            _bundle(egress=_egress_section(allowlist=["a.com", "b.com"])),
            signing_key=SIGNING_KEY,
        ))
        await _apply_egress(db, verify_bundle(
            _bundle(version=13, egress=_egress_section(allowlist=["a.com"])),
            signing_key=SIGNING_KEY,
        ))

        row = await EgressRepository(db).get_synced_policy()
        assert row["allowlist"] == ["a.com"]

    @pytest.mark.asyncio
    async def test_a_bundle_without_egress_revokes_a_previously_synced_policy(
        self, tmp_path
    ):
        # The admin deleted the org policy. Absence of the section is the only
        # signal the device gets, so it has to be acted on.
        db = await _db(tmp_path)
        await _apply_egress(db, verify_bundle(
            _bundle(egress=_egress_section()), signing_key=SIGNING_KEY
        ))
        assert await EgressRepository(db).get_synced_policy() is not None

        await _apply_egress(
            db, verify_bundle(_bundle(version=13), signing_key=SIGNING_KEY)
        )
        assert await EgressRepository(db).get_synced_policy() is None

    @pytest.mark.asyncio
    async def test_only_one_synced_row_is_ever_kept(self, tmp_path):
        db = await _db(tmp_path)
        for v in (12, 13, 14):
            await _apply_egress(db, verify_bundle(
                _bundle(version=v, egress=_egress_section()),
                signing_key=SIGNING_KEY,
            ))
        conn = await db.connect()
        cur = await conn.execute(
            "SELECT COUNT(*) FROM egress_policies WHERE source = 'synced'"
        )
        assert (await cur.fetchone())[0] == 1


# --- effective policy ------------------------------------------------------

class TestEffectivePolicy:
    @pytest.mark.asyncio
    async def test_the_evaluated_policy_reflects_the_org_after_a_sync(
        self, tmp_path
    ):
        from securevector.app.server.routes.egress import _load_policy

        db = await _db(tmp_path)
        repo = EgressRepository(db)
        local = await repo.get_active_policy()
        await repo.update_policy(local["id"], allowlist=["mine.example"])

        assert (await _load_policy(repo)).allowlist == ["mine.example"]

        await _apply_egress(db, verify_bundle(
            _bundle(egress=_egress_section()), signing_key=SIGNING_KEY
        ))

        effective = await _load_policy(repo)
        assert effective.preset == "contained"
        assert effective.allowlist == ["github.com"]
        assert effective.source == "synced"
        assert effective.org_managed_allowlist is True
        assert effective.local_allowlist_suppressed == ["mine.example"]

    @pytest.mark.asyncio
    async def test_revoking_the_org_policy_restores_local_enforcement(
        self, tmp_path
    ):
        from securevector.app.server.routes.egress import _load_policy

        db = await _db(tmp_path)
        repo = EgressRepository(db)
        local = await repo.get_active_policy()
        await repo.update_policy(local["id"], allowlist=["mine.example"])

        await _apply_egress(db, verify_bundle(
            _bundle(egress=_egress_section()), signing_key=SIGNING_KEY
        ))
        await _apply_egress(
            db, verify_bundle(_bundle(version=13), signing_key=SIGNING_KEY)
        )

        effective = await _load_policy(repo)
        assert effective.allowlist == ["mine.example"]
        assert effective.source == "local"
        assert effective.org_managed_allowlist is False
