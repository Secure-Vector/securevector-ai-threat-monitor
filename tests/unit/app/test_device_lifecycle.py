"""Tests for the device-lifecycle managed-device hook (story #112).

Covers:
  - v38 migration adds the `source` provenance column (default 'user').
  - ExternalForwardersRepository.create(source="enrollment") round-trips
    and _row_to_dict surfaces it.
  - register_enrollment_destinations() with destinations registers each
    one tagged source="enrollment" and emits device.lifecycle.enrolled.
  - register_enrollment_destinations(None) / ([]) is a no-op.
  - encode_lifecycle_event() is metadata-only (raw_data is null).

HTTP is never hit — _post_event_to_destination is monkeypatched so the
emit path is exercised without a network.
"""

from __future__ import annotations

import pytest

from securevector.app.database.connection import init_database, close_database
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.external_forwarders import (
    ExternalForwardersRepository,
)
from securevector.app.services import device_lifecycle


async def _build_db(tmp_path):
    """Point the global DB at a temp file and run all migrations.

    register_enrollment_destinations() resolves the repo via get_database(),
    so we initialise the GLOBAL connection (not a standalone one) to keep
    the test exercising the real code path.
    """
    db = await init_database(tmp_path / "lifecycle.db")
    await run_migrations(db)
    return db


# ---------------------------------------------------------------------------
# v38 migration + repo source column
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_v38_adds_source_column_default_user(tmp_path):
    db = await _build_db(tmp_path)
    try:
        conn = await db.connect()
        cur = await conn.execute("PRAGMA table_info(external_forwarders)")
        cols = {row[1] for row in await cur.fetchall()}
        assert "source" in cols

        # A row created with no explicit source defaults to 'user'.
        repo = ExternalForwardersRepository(db)
        rec = await repo.create(kind="webhook", name="hand-added", url="https://x.example/h")
        assert rec["source"] == "user"
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_create_with_enrollment_source_roundtrips(tmp_path):
    db = await _build_db(tmp_path)
    try:
        repo = ExternalForwardersRepository(db)
        rec = await repo.create(
            kind="webhook",
            name="managed",
            url="https://cloud.example/ocsf/ingest",
            source="enrollment",
        )
        assert rec["source"] == "enrollment"
        fetched = await repo.get(rec["id"])
        assert fetched["source"] == "enrollment"
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_create_rejects_unknown_source(tmp_path):
    db = await _build_db(tmp_path)
    try:
        repo = ExternalForwardersRepository(db)
        with pytest.raises(ValueError):
            await repo.create(
                kind="webhook", name="bad", url="https://x.example/h", source="bogus"
            )
    finally:
        await close_database()


# ---------------------------------------------------------------------------
# register_enrollment_destinations
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_enrollment_with_destinations_registers_and_emits(tmp_path, monkeypatch):
    db = await _build_db(tmp_path)
    try:
        # Capture emitted events instead of hitting the network.
        emitted: list = []

        async def _fake_post(fwd, event):
            emitted.append((fwd["url"], event))
            return True

        monkeypatch.setattr(device_lifecycle, "_post_event_to_destination", _fake_post)

        destinations = [
            {
                "name": "SecureVector Cloud",
                "type": "webhook",
                "url": "https://cloud.example/ocsf/ingest",
                "token": "tok_abc",
                "source": "enrollment",
            }
        ]
        created = await device_lifecycle.register_enrollment_destinations(destinations)

        # Registered exactly one destination, tagged as enrollment-sourced.
        assert len(created) == 1
        assert created[0]["source"] == "enrollment"
        assert created[0]["kind"] == "webhook"
        assert created[0]["has_secret"] is True  # token stored as secret_ref

        # It is persisted and discoverable as enrollment-sourced.
        repo = ExternalForwardersRepository(db)
        rows = await repo.list_all()
        assert len(rows) == 1
        assert rows[0]["source"] == "enrollment"

        # A device.lifecycle.enrolled event was emitted to it.
        assert len(emitted) == 1
        url, event = emitted[0]
        assert url == "https://cloud.example/ocsf/ingest"
        assert event["metadata"]["event_code"] == "device.lifecycle.enrolled"
        assert event["unmapped"]["lifecycle_activity"] == "enrolled"
        # Metadata-only contract: never carries raw text.
        assert event["raw_data"] is None
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_enrollment_without_destinations_is_noop(tmp_path, monkeypatch):
    db = await _build_db(tmp_path)
    try:
        emitted: list = []

        async def _fake_post(fwd, event):  # pragma: no cover - must not be called
            emitted.append(event)
            return True

        monkeypatch.setattr(device_lifecycle, "_post_event_to_destination", _fake_post)

        assert await device_lifecycle.register_enrollment_destinations(None) == []
        assert await device_lifecycle.register_enrollment_destinations([]) == []

        repo = ExternalForwardersRepository(db)
        assert await repo.list_all() == []
        assert emitted == []  # nothing forwarded
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_uninstalling_emits_only_to_enrollment_sourced(tmp_path, monkeypatch):
    db = await _build_db(tmp_path)
    try:
        repo = ExternalForwardersRepository(db)
        # One hand-added (user) destination, one enrollment-sourced one.
        await repo.create(kind="webhook", name="user-dst", url="https://user.example/h")
        await repo.create(
            kind="webhook",
            name="managed-dst",
            url="https://cloud.example/ocsf/ingest",
            source="enrollment",
        )

        emitted_urls: list = []

        async def _fake_post(fwd, event):
            emitted_urls.append(fwd["url"])
            return True

        monkeypatch.setattr(device_lifecycle, "_post_event_to_destination", _fake_post)

        acked = await device_lifecycle.emit_lifecycle_to_enrollment_destinations(
            device_lifecycle.LIFECYCLE_UNINSTALLING
        )
        # Only the enrollment-sourced destination receives the event.
        assert acked == 1
        assert emitted_urls == ["https://cloud.example/ocsf/ingest"]
    finally:
        await close_database()


# ---------------------------------------------------------------------------
# encode_lifecycle_event
# ---------------------------------------------------------------------------


def test_encode_lifecycle_event_is_metadata_only():
    ev = device_lifecycle.encode_lifecycle_event(
        device_lifecycle.LIFECYCLE_UNINSTALLING,
        device_id="dev-123",
        app_version="4.2.0",
        org_id="org-9",
    )
    assert ev["class_uid"] == 5001
    assert ev["metadata"]["event_code"] == "device.lifecycle.uninstalling"
    assert ev["raw_data"] is None
    assert ev["device"]["uid"] == "dev-123"
    assert ev["unmapped"]["app_version"] == "4.2.0"
    assert ev["unmapped"]["org_id"] == "org-9"
