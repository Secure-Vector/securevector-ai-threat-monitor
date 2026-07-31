"""Tests for the JIT access request/grant repository.

Focus: approving a request is exactly-once. A double-clicked Approve button
(or a UI retry of a slow request) must never mint two live grants for one
approval — the second caller has to observe that it lost and return the
grant the winner already created.
"""

from __future__ import annotations

import asyncio

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.jit_access import JitAccessRepository


async def _build_db(tmp_path) -> DatabaseConnection:
    db = DatabaseConnection(tmp_path / "jit.db")
    await run_migrations(db)
    return db


async def _pending_request(repo: JitAccessRepository) -> dict:
    req = await repo.create_request(
        tool_id="Bash",
        rule_source="local",
        runtime_kind="claude-code",
        session_id="sess-1",
    )
    assert req is not None
    return req


@pytest.mark.asyncio
async def test_approve_mints_one_grant(tmp_path):
    db = await _build_db(tmp_path)
    repo = JitAccessRepository(db)
    req = await _pending_request(repo)

    grant = await repo.approve_request(req["id"], "15m")

    assert grant is not None
    assert grant["tool_id"] == "Bash"
    rows = await db.fetch_all(
        "SELECT id FROM jit_access_grants WHERE request_id = ?", (req["id"],)
    )
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_double_approve_does_not_double_grant(tmp_path):
    """Sequential re-approval (the retry case) stays idempotent."""
    db = await _build_db(tmp_path)
    repo = JitAccessRepository(db)
    req = await _pending_request(repo)

    first = await repo.approve_request(req["id"], "15m")
    second = await repo.approve_request(req["id"], "15m")

    rows = await db.fetch_all(
        "SELECT id FROM jit_access_grants WHERE request_id = ?", (req["id"],)
    )
    assert len(rows) == 1, "a second approval must not mint a second grant"
    # The loser reports the winner's grant, not a spurious 404.
    assert second is not None
    assert second["id"] == first["id"]


@pytest.mark.asyncio
async def test_concurrent_approve_does_not_double_grant(tmp_path):
    """Two approvals racing on the same request — the double-click case.

    Both callers can read status='pending' before either writes, so the
    UPDATE's rowcount is the only thing that separates winner from loser.
    """
    db = await _build_db(tmp_path)
    repo = JitAccessRepository(db)
    req = await _pending_request(repo)

    results = await asyncio.gather(
        repo.approve_request(req["id"], "15m"),
        repo.approve_request(req["id"], "15m"),
        return_exceptions=True,
    )

    for r in results:
        assert not isinstance(r, Exception), f"approval raised: {r!r}"

    rows = await db.fetch_all(
        "SELECT id FROM jit_access_grants WHERE request_id = ?", (req["id"],)
    )
    assert len(rows) == 1, f"expected exactly one grant, got {len(rows)}"


@pytest.mark.asyncio
async def test_approve_after_deny_returns_none(tmp_path):
    """A denied request is no longer pending, and nothing is minted for it."""
    db = await _build_db(tmp_path)
    repo = JitAccessRepository(db)
    req = await _pending_request(repo)

    assert await repo.deny_request(req["id"], "not needed")
    grant = await repo.approve_request(req["id"], "15m")

    assert grant is None
    rows = await db.fetch_all(
        "SELECT id FROM jit_access_grants WHERE request_id = ?", (req["id"],)
    )
    assert rows == [] or len(rows) == 0


@pytest.mark.asyncio
async def test_reapprove_after_revoke_does_not_report_a_dead_grant(tmp_path):
    """Approving again after the grant was revoked must not return it.

    Enforcement reads active_grants(), so a revoked grant confers nothing —
    but handing it back to a retrying client would report access that does
    not exist. None is the honest answer.
    """
    db = await _build_db(tmp_path)
    repo = JitAccessRepository(db)
    req = await _pending_request(repo)

    grant = await repo.approve_request(req["id"], "15m")
    assert grant is not None
    assert await repo.revoke_grant(grant["id"])

    again = await repo.approve_request(req["id"], "15m")

    assert again is None, "a revoked grant must not be reported as live"
    # And no replacement grant was minted behind the user's back.
    rows = await db.fetch_all(
        "SELECT id FROM jit_access_grants WHERE request_id = ?", (req["id"],)
    )
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_reapprove_after_expiry_does_not_report_a_dead_grant(tmp_path):
    """Same rule for a grant that simply aged out."""
    db = await _build_db(tmp_path)
    repo = JitAccessRepository(db)
    req = await _pending_request(repo)

    grant = await repo.approve_request(req["id"], "15m")
    assert grant is not None
    await db.execute(
        "UPDATE jit_access_grants SET expires_at = datetime('now', '-1 hour') "
        "WHERE id = ?",
        (grant["id"],),
    )

    assert await repo.approve_request(req["id"], "15m") is None
