"""Guard: an enrollment-sourced forwarder (the SecureVector cloud destination)
can never sit at 'full' redaction — that tier forwards raw prompt/output/tool
args, but the cloud path is metadata-only by contract.

Before this guard the source<->redaction coupling was convention-only: nothing
stopped update() (or create()) from elevating an enrollment forwarder to 'full'
and leaking raw content to the cloud. See llm-security-engine#190.
"""

from __future__ import annotations

import pytest

from securevector.app.database.connection import init_database, close_database
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.external_forwarders import (
    ExternalForwardersRepository,
)


async def _build_db(tmp_path):
    db = await init_database(tmp_path / "guard.db")
    await run_migrations(db)
    return db


@pytest.mark.asyncio
async def test_create_enrollment_full_redaction_rejected(tmp_path):
    db = await _build_db(tmp_path)
    try:
        repo = ExternalForwardersRepository(db)
        with pytest.raises(ValueError, match="metadata-only"):
            await repo.create(
                kind="webhook",
                name="cloud",
                url="https://x.example/h",
                source="enrollment",
                redaction_level="full",
            )
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_update_enrollment_to_full_redaction_rejected(tmp_path):
    db = await _build_db(tmp_path)
    try:
        repo = ExternalForwardersRepository(db)
        rec = await repo.create(
            kind="webhook",
            name="cloud",
            url="https://x.example/h",
            source="enrollment",
            redaction_level="standard",
        )
        with pytest.raises(ValueError, match="metadata-only"):
            await repo.update(rec["id"], redaction_level="full")
        # The rejected update must not have changed anything.
        fetched = await repo.get(rec["id"])
        assert fetched["redaction_level"] == "standard"
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_user_forwarder_full_redaction_still_allowed(tmp_path):
    """A user-sourced forwarder is the customer's OWN SIEM (never SecureVector
    cloud) — it may legitimately opt into 'full'. The guard must not touch it."""
    db = await _build_db(tmp_path)
    try:
        repo = ExternalForwardersRepository(db)
        rec = await repo.create(
            kind="webhook",
            name="my-siem",
            url="https://x.example/h",
            source="user",
            redaction_level="standard",
        )
        updated = await repo.update(rec["id"], redaction_level="full")
        assert updated["redaction_level"] == "full"

        # Creating a user forwarder directly at 'full' is also fine.
        rec2 = await repo.create(
            kind="webhook",
            name="my-siem-2",
            url="https://x.example/h2",
            source="user",
            redaction_level="full",
        )
        assert rec2["redaction_level"] == "full"
    finally:
        await close_database()
