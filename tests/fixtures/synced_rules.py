"""Test-only helper to prime ``synced_tool_rules`` without spinning up
the cloud-sync round-trip.

Wraps ``SyncedRulesRepository.replace_bundle()`` with sensible test
defaults so an integration test can seed N synced rules in one call.

IMPORTANT: each invocation issues ``DELETE FROM synced_tool_rules``
(the WHOLE table, not scoped to ``policy_id``), then inserts the new
rows atomically. A second call in the same test WILL erase the rows
from the first call — even if you change the policy_id. Call this
helper exactly once per test, passing the complete ruleset you need.

Default bundle/policy/org ids are namespaced ``*_test_<short-uuid>`` so
test rows can never collide with real cloud-pushed bundles in any
tooling that reads this table during development.
"""

from __future__ import annotations

import uuid
from typing import Iterable, Optional

from securevector.app.database.repositories.synced_rules import SyncedRulesRepository


async def seed_synced_rules(
    repo: SyncedRulesRepository,
    rules: Iterable[dict],
    *,
    bundle_id: Optional[str] = None,
    policy_id: Optional[str] = None,
    policy_name: str = "Test policy",
    policy_version: int = 1,
    org_id: Optional[str] = None,
    org_name: str = "Test org",
) -> int:
    """Insert ``rules`` into ``synced_tool_rules`` with test defaults.

    Each item in ``rules`` is a dict with ``tool_id`` + ``effect``
    (required), ``priority`` (default 0), and ``reason`` (optional).

    Returns the number of rules inserted (mirrors ``replace_bundle``).
    """
    short = uuid.uuid4().hex[:8]
    return await repo.replace_bundle(
        bundle_id=bundle_id or f"bnd_test_{short}",
        policy_id=policy_id or f"pol_test_{short}",
        policy_name=policy_name,
        policy_version=policy_version,
        org_id=org_id or f"org_test_{short}",
        org_name=org_name,
        rules=rules,
    )
