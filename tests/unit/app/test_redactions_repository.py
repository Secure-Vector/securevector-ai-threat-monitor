"""Tests for the redaction_events audit log repository.

Covers the migration, hash-only storage posture, aggregation correctness,
and the optional record_event hook on redact_secrets().
"""

from __future__ import annotations

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.redactions import (
    RedactionsRepository,
    hash_matched_substring,
)
from securevector.app.utils.redaction import redact_secrets


async def _build_db(tmp_path) -> DatabaseConnection:
    db = DatabaseConnection(tmp_path / "redactions.db")
    await run_migrations(db)
    return db


# ---------------------------------------------------------------------------
# hash_matched_substring
# ---------------------------------------------------------------------------


def test_hash_matched_substring_is_deterministic():
    a = hash_matched_substring("sk-aBcDeFgHiJkLmNoPqRsT1234567890XYZA")
    b = hash_matched_substring("sk-aBcDeFgHiJkLmNoPqRsT1234567890XYZA")
    assert a == b


def test_hash_matched_substring_changes_with_input():
    a = hash_matched_substring("sk-aBcDeFgHiJkLmNoPqRsT1234567890XYZA")
    b = hash_matched_substring("sk-DIFFERENTKEY999999999999999999999999")
    assert a != b


def test_hash_matched_substring_is_self_describing():
    h = hash_matched_substring("anything")
    assert h.startswith("sha256:")
    assert len(h) == len("sha256:") + 64


# ---------------------------------------------------------------------------
# RedactionsRepository — write + read
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_record_appends_event_row(tmp_path):
    db = await _build_db(tmp_path)
    repo = RedactionsRepository(db)

    await repo.record(
        pattern_id="openai-sk",
        secret_type="OpenAI sk- key",
        direction="outgoing",
        redaction_hash=hash_matched_substring("sk-abc"),
        source_tool="WebFetch",
        source_tool_id="WebFetch",
        request_id="req_001",
    )

    events = await repo.list_events(window_days=1)
    assert len(events) == 1
    e = events[0]
    assert e["pattern_id"] == "openai-sk"
    assert e["secret_type"] == "OpenAI sk- key"
    assert e["direction"] == "outgoing"
    assert e["source_tool"] == "WebFetch"
    assert e["request_id"] == "req_001"
    assert e["redaction_hash"].startswith("sha256:")

    await db.disconnect()


@pytest.mark.asyncio
async def test_record_drops_unknown_direction(tmp_path):
    db = await _build_db(tmp_path)
    repo = RedactionsRepository(db)

    # Unknown direction value must be silently dropped (CHECK constraint
    # on the column would error otherwise; the repo guards above the DB).
    await repo.record(
        pattern_id="x",
        secret_type="x",
        direction="lateral",  # invalid
        redaction_hash="sha256:0",
    )
    events = await repo.list_events(window_days=1)
    assert events == []

    await db.disconnect()


@pytest.mark.asyncio
async def test_list_filters_by_direction(tmp_path):
    db = await _build_db(tmp_path)
    repo = RedactionsRepository(db)

    for d in ("outgoing", "outgoing", "incoming", "llm_response"):
        await repo.record(
            pattern_id="openai-sk",
            secret_type="OpenAI sk- key",
            direction=d,
            redaction_hash="sha256:abc",
        )

    incoming = await repo.list_events(window_days=1, direction="incoming")
    assert len(incoming) == 1
    outgoing = await repo.list_events(window_days=1, direction="outgoing")
    assert len(outgoing) == 2

    await db.disconnect()


@pytest.mark.asyncio
async def test_aggregate_returns_per_direction_and_per_type_counts(tmp_path):
    db = await _build_db(tmp_path)
    repo = RedactionsRepository(db)

    matches = [
        ("openai-sk", "OpenAI sk- key", "outgoing"),
        ("openai-sk", "OpenAI sk- key", "outgoing"),
        ("openai-sk", "OpenAI sk- key", "incoming"),
        ("pem-private-key", "PEM private key", "incoming"),
        ("aws-access-key", "AWS access key", "outgoing"),
    ]
    for pid, stype, dirn in matches:
        await repo.record(
            pattern_id=pid,
            secret_type=stype,
            direction=dirn,
            redaction_hash="sha256:abc",
        )

    summary = await repo.aggregate(window_days=1)
    assert summary["total"] == 5
    assert summary["by_direction"] == {"outgoing": 3, "incoming": 2}
    assert summary["by_secret_type"]["OpenAI sk- key"] == 3
    assert summary["by_secret_type"]["PEM private key"] == 1
    assert summary["by_secret_type"]["AWS access key"] == 1

    await db.disconnect()


@pytest.mark.asyncio
async def test_raw_secret_never_stored_in_redaction_hash_column(tmp_path):
    # Defence-in-depth check — only sha256: hashes ever land in the table.
    db = await _build_db(tmp_path)
    repo = RedactionsRepository(db)
    secret = "sk-aBcDeFgHiJkLmNoPqRsT1234567890XYZA"
    await repo.record(
        pattern_id="openai-sk",
        secret_type="OpenAI sk- key",
        direction="outgoing",
        redaction_hash=hash_matched_substring(secret),
    )
    events = await repo.list_events(window_days=1)
    assert events[0]["redaction_hash"].startswith("sha256:")
    assert secret not in events[0]["redaction_hash"]

    await db.disconnect()


# ---------------------------------------------------------------------------
# redact_secrets record_event callback
# ---------------------------------------------------------------------------


def test_redact_secrets_invokes_callback_with_pattern_metadata():
    captured = []
    text = "key=sk-aBcDeFgHiJkLmNoPqRsT1234567890XYZA inside a prompt"
    redacted, n = redact_secrets(
        text,
        direction="outgoing",
        record_event=lambda m: captured.append(m),
    )
    assert n >= 1
    # At least one captured match for the openai-sk pattern.
    assert any(c["pattern_id"] == "openai-sk" for c in captured)
    # Callback receives the raw matched substring — it's the caller's
    # job (analyze.py) to hash before persisting.
    assert any("sk-aBcDeFgHiJkLmNoPqRsT" in c["matched"] for c in captured)


def test_redact_secrets_callback_swallows_errors():
    # A failing callback must never derail the redaction.
    def boom(_):
        raise RuntimeError("test")

    redacted, n = redact_secrets("sk-aBcDeFgHiJkLmNoPqRsT1234567890XYZA", record_event=boom)
    assert n >= 1
    assert "sk-aBcDeFgHiJkLmNoPqRsT1234567890XYZA" not in redacted


def test_redact_secrets_callback_fires_for_pem_only_on_incoming():
    # Direction gating must also gate which patterns the callback sees.
    pem = (
        "-----BEGIN RSA PRIVATE KEY-----\n"
        "secretbody12345\n"
        "-----END RSA PRIVATE KEY-----"
    )
    incoming_captured = []
    redact_secrets(pem, direction="incoming", record_event=lambda m: incoming_captured.append(m))
    assert any(c["pattern_id"] == "pem-private-key" for c in incoming_captured)

    outgoing_captured = []
    redact_secrets(pem, direction="outgoing", record_event=lambda m: outgoing_captured.append(m))
    assert not any(c["pattern_id"] == "pem-private-key" for c in outgoing_captured)
