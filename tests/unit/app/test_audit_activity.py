"""Timeline overview chart aggregate — get_audit_activity().

Regression guard for the "Blocked 0" bug: the chart used to be built from the
feed's 200-row page, so blocks older than the latest 200 calls silently
vanished from the chart while the Map (full-window aggregate) still counted
them. get_audit_activity() aggregates the whole window server-side so the two
views agree.
"""

from __future__ import annotations

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.custom_tools import CustomToolsRepository


async def _db(tmp_path) -> DatabaseConnection:
    db = DatabaseConnection(tmp_path / "t.db")
    await run_migrations(db)
    return db


async def _seed(repo, action, risk=None, n=1):
    for _ in range(n):
        await repo.log_tool_call_audit(
            tool_id="github:x", function_name="x", action=action,
            risk=risk, reason="r", is_essential=False, args_preview=None,
            runtime_kind="openclaw", session_id="s1",
        )


def _counts(buckets):
    high = {"delete", "admin", "write"}
    allow = block = threat = 0
    for b in buckets:
        n = b["n"]
        if b["action"] == "block":
            block += n
        elif (b["risk"] or "") in high:
            threat += n
        else:
            allow += n
    return allow, block, threat


@pytest.mark.asyncio
async def test_activity_counts_all_verdicts_over_window(tmp_path):
    db = await _db(tmp_path)
    repo = CustomToolsRepository(db)
    # 250 allows then 7 blocks — the blocks would fall OUTSIDE a 200-row page,
    # which is exactly the case the old chart got wrong.
    await _seed(repo, "allow", "read", n=250)
    await _seed(repo, "block", "admin", n=7)

    buckets = await repo.get_audit_activity(window_days=7)
    allow, block, threat = _counts(buckets)
    assert block == 7, buckets          # the bug: this used to read 0
    assert allow == 250
    assert threat == 0


@pytest.mark.asyncio
async def test_activity_collapses_buckets(tmp_path):
    # Same (day, action, risk) must collapse to ONE row with summed n, not one
    # row per call (the GROUP-BY-binds-to-raw-column bug).
    db = await _db(tmp_path)
    repo = CustomToolsRepository(db)
    await _seed(repo, "allow", "read", n=40)

    buckets = await repo.get_audit_activity(window_days=7)
    assert len(buckets) == 1, buckets
    assert buckets[0]["n"] == 40


@pytest.mark.asyncio
async def test_activity_separates_high_risk_threats(tmp_path):
    db = await _db(tmp_path)
    repo = CustomToolsRepository(db)
    await _seed(repo, "allow", "read", n=3)
    await _seed(repo, "allow", "admin", n=2)   # allowed but high-risk → threat
    await _seed(repo, "block", "delete", n=1)

    allow, block, threat = _counts(await repo.get_audit_activity(window_days=7))
    assert (allow, block, threat) == (3, 1, 2)


@pytest.mark.asyncio
async def test_activity_empty_window(tmp_path):
    db = await _db(tmp_path)
    repo = CustomToolsRepository(db)
    assert await repo.get_audit_activity(window_days=7) == []
