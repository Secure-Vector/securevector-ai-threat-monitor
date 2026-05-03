"""
Repository for `synced_tool_rules` (V29 migration) — cloud-pushed policy
bundle rules layered over local Tool Permissions.

active-mcp-and-policy-sync bundle, Phase 2 / Release B.

Lifecycle:
- Wiped + rewritten on every successful bundle apply (atomic in a single
  transaction so a failed apply leaves the previous bundle intact).
- Read at Tool Permissions request time to compute `effective_action`:
  cloud rule > local user rule > default.
- Cleared on graceful unenroll.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, List, Optional

from securevector.app.database.connection import DatabaseConnection

logger = logging.getLogger(__name__)


@dataclass
class SyncedToolRule:
    """One cloud-pushed rule, ready to layer over a local Tool Permission row."""

    id: int
    bundle_id: str
    policy_id: str
    policy_version: int
    org_id: str
    org_name: Optional[str]
    tool_id: str
    effect: str  # 'allow' | 'deny' | 'prompt'
    priority: int
    reason: Optional[str]
    applied_at: str  # ISO timestamp


class SyncedRulesRepository:
    """CRUD over the synced_tool_rules table."""

    def __init__(self, db: DatabaseConnection):
        self.db = db

    async def list_all(self) -> List[SyncedToolRule]:
        rows = await self.db.fetch_all(
            "SELECT id, bundle_id, policy_id, policy_version, org_id, org_name, "
            "tool_id, effect, priority, reason, applied_at "
            "FROM synced_tool_rules ORDER BY priority DESC, id ASC"
        )
        return [self._row_to_rule(r) for r in rows]

    async def find_by_tool(self, tool_id: str) -> Optional[SyncedToolRule]:
        """Return the highest-priority synced rule matching `tool_id`, or None."""
        row = await self.db.fetch_one(
            "SELECT id, bundle_id, policy_id, policy_version, org_id, org_name, "
            "tool_id, effect, priority, reason, applied_at "
            "FROM synced_tool_rules WHERE tool_id = ? "
            "ORDER BY priority DESC, id ASC LIMIT 1",
            (tool_id,),
        )
        return self._row_to_rule(row) if row else None

    async def replace_bundle(
        self,
        *,
        bundle_id: str,
        policy_id: str,
        policy_version: int,
        org_id: str,
        org_name: Optional[str],
        rules: Iterable[dict],
    ) -> int:
        """
        Atomically replace the synced ruleset with the contents of a verified
        bundle. Wipes existing rows for this `policy_id` first, then inserts
        the new bundle's rules. Returns the number of rules inserted.

        Each `rules` item must have keys: tool_id, effect, priority (int),
        reason (optional). Missing fields are tolerated where reasonable.
        """
        applied_at = datetime.now(timezone.utc).isoformat()
        conn = await self.db.connect()
        async with conn.execute("BEGIN"):
            pass
        try:
            # v1 strategy: wipe-and-rewrite the entire table on each apply.
            # If/when multi-policy stacking lands, narrow the wipe by policy_id.
            await conn.execute("DELETE FROM synced_tool_rules")
            count = 0
            for rule in rules:
                tool_id = rule.get("tool_id")
                effect = rule.get("effect", "deny")
                if not tool_id or effect not in ("allow", "deny", "prompt"):
                    logger.warning(
                        "Skipping invalid synced rule %r (tool_id missing or bad effect)",
                        rule,
                    )
                    continue
                await conn.execute(
                    "INSERT INTO synced_tool_rules "
                    "(bundle_id, policy_id, policy_version, org_id, org_name, "
                    " tool_id, effect, priority, reason, applied_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        bundle_id,
                        policy_id,
                        int(policy_version),
                        org_id,
                        org_name,
                        tool_id,
                        effect,
                        int(rule.get("priority") or 0),
                        rule.get("reason"),
                        applied_at,
                    ),
                )
                count += 1
            await conn.commit()
            logger.info(
                "Replaced synced rules: bundle=%s policy=%s v=%d count=%d",
                bundle_id,
                policy_id,
                policy_version,
                count,
            )
            return count
        except Exception:
            await conn.rollback()
            raise

    async def get_last_applied_version(self, policy_id: str) -> Optional[int]:
        """
        Return the highest policy_version applied for a given policy_id, or
        None if this policy hasn't been applied yet. Used by the version
        guard in bundle_verifier.
        """
        row = await self.db.fetch_one(
            "SELECT MAX(policy_version) AS v FROM synced_tool_rules WHERE policy_id = ?",
            (policy_id,),
        )
        return int(row["v"]) if row and row["v"] is not None else None

    async def clear(self) -> int:
        """Wipe all synced rules — used on graceful unenroll."""
        conn = await self.db.connect()
        cursor = await conn.execute("DELETE FROM synced_tool_rules")
        await conn.commit()
        return cursor.rowcount or 0

    @staticmethod
    def _row_to_rule(row) -> SyncedToolRule:
        return SyncedToolRule(
            id=row["id"],
            bundle_id=row["bundle_id"],
            policy_id=row["policy_id"],
            policy_version=row["policy_version"],
            org_id=row["org_id"],
            org_name=row["org_name"],
            tool_id=row["tool_id"],
            effect=row["effect"],
            priority=row["priority"],
            reason=row["reason"],
            applied_at=row["applied_at"],
        )
