"""Sanity tests for ``tests/fixtures/synced_rules.py`` — the seeding
helper Task 15's e2e integration test will lean on. Keeping these as
focused unit tests means the integration test can rely on the helper
without re-proving its correctness inline.
"""

from __future__ import annotations

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.synced_rules import SyncedRulesRepository
from tests.fixtures.synced_rules import seed_synced_rules


async def _build_db(tmp_path) -> DatabaseConnection:
    db = DatabaseConnection(tmp_path / "test.db")
    await run_migrations(db)
    return db


@pytest.mark.asyncio
async def test_seed_synced_rules_inserts_a_single_rule(tmp_path):
    db = await _build_db(tmp_path)
    repo = SyncedRulesRepository(db)

    count = await seed_synced_rules(
        repo,
        [
            {
                "tool_id": "server-x:tool_a",
                "effect": "deny",
                "priority": 10,
                "reason": "test",
            }
        ],
    )

    assert count == 1
    rule = await repo.find_by_tool("server-x:tool_a")
    assert rule is not None
    assert rule.effect == "deny"
    assert rule.priority == 10
    assert rule.reason == "test"


@pytest.mark.asyncio
async def test_seed_synced_rules_inserts_many(tmp_path):
    db = await _build_db(tmp_path)
    repo = SyncedRulesRepository(db)

    count = await seed_synced_rules(
        repo,
        [
            {"tool_id": "server-x:tool_a", "effect": "deny"},
            {"tool_id": "server-x:tool_b", "effect": "allow"},
            {"tool_id": "server-x:tool_c", "effect": "prompt", "priority": 5},
        ],
    )

    assert count == 3
    all_rules = await repo.list_all()
    assert len(all_rules) == 3
    assert {r.tool_id for r in all_rules} == {
        "server-x:tool_a",
        "server-x:tool_b",
        "server-x:tool_c",
    }


@pytest.mark.asyncio
async def test_seed_synced_rules_applies_default_bundle_metadata(tmp_path):
    db = await _build_db(tmp_path)
    repo = SyncedRulesRepository(db)

    await seed_synced_rules(repo, [{"tool_id": "t1", "effect": "deny"}])
    rule = await repo.find_by_tool("t1")

    # Defaults are recognisable test markers so seed rows are obvious in
    # any tooling that reads this table during development.
    assert rule is not None
    assert rule.bundle_id.startswith("bnd_test_")
    assert rule.policy_id.startswith("pol_test_")
    assert rule.org_id.startswith("org_test_")
    assert rule.policy_version >= 1


@pytest.mark.asyncio
async def test_seed_synced_rules_wipes_existing_rows(tmp_path):
    """Each call wipes the table first (replace_bundle semantics) — gives
    integration tests predictable state without manual teardown."""
    db = await _build_db(tmp_path)
    repo = SyncedRulesRepository(db)

    await seed_synced_rules(repo, [{"tool_id": "t1", "effect": "deny"}])
    await seed_synced_rules(repo, [{"tool_id": "t2", "effect": "allow"}])

    assert await repo.find_by_tool("t1") is None
    rule = await repo.find_by_tool("t2")
    assert rule is not None and rule.effect == "allow"


@pytest.mark.asyncio
async def test_seed_synced_rules_empty_list_returns_zero(tmp_path):
    """Empty input is a valid call — wipes the table, inserts nothing,
    returns 0. Tested so a Task-15 setup path that accidentally passes
    `[]` fails fast on the seed assertion instead of yielding confusing
    None rows downstream."""
    db = await _build_db(tmp_path)
    repo = SyncedRulesRepository(db)

    # Pre-load a row so we can confirm the wipe still happens on `[]`.
    await seed_synced_rules(repo, [{"tool_id": "stale", "effect": "deny"}])
    assert await repo.find_by_tool("stale") is not None

    count = await seed_synced_rules(repo, [])

    assert count == 0
    assert await repo.list_all() == []
    assert await repo.find_by_tool("stale") is None


@pytest.mark.asyncio
async def test_seed_synced_rules_accepts_explicit_bundle_metadata(tmp_path):
    """Explicit bundle/policy ids let integration tests assert on the
    'who pushed this' fields without guessing the random default ids."""
    db = await _build_db(tmp_path)
    repo = SyncedRulesRepository(db)

    await seed_synced_rules(
        repo,
        [{"tool_id": "t1", "effect": "deny"}],
        bundle_id="bnd_fixed",
        policy_id="pol_fixed",
        policy_name="Pinned policy",
        policy_version=42,
        org_id="org_fixed",
        org_name="Pinned org",
    )

    rule = await repo.find_by_tool("t1")
    assert rule is not None
    assert rule.bundle_id == "bnd_fixed"
    assert rule.policy_id == "pol_fixed"
    assert rule.policy_name == "Pinned policy"
    assert rule.policy_version == 42
    assert rule.org_id == "org_fixed"
    assert rule.org_name == "Pinned org"
