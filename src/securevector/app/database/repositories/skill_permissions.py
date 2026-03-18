"""
Skill permissions and policy configuration repository.

Provides CRUD for skill_permissions, skill_trusted_publishers,
and skill_policy_config tables (V19 migration).
"""

import logging
from dataclasses import dataclass
from typing import Optional

from securevector.app.database.connection import DatabaseConnection

logger = logging.getLogger(__name__)


@dataclass
class SkillPermission:
    id: int
    category: str           # 'network', 'env_var', 'file_path', 'shell_command'
    pattern: str
    classification: str     # 'safe', 'review', 'dangerous'
    label: str
    is_default: bool
    enabled: bool


@dataclass
class TrustedPublisher:
    id: int
    publisher_name: str
    trust_level: str        # 'trusted', 'untrusted'
    is_default: bool


@dataclass
class PolicyConfig:
    policy_enabled: bool
    risk_weights: dict[str, int]
    threshold_allow: int
    threshold_warn: int


class SkillPermissionsRepository:
    """Repository for skill permissions, trusted publishers, and policy config."""

    def __init__(self, db: DatabaseConnection):
        self.db = db

    # -----------------------------------------------------------------------
    # Permissions
    # -----------------------------------------------------------------------

    async def list_permissions(
        self,
        category: Optional[str] = None,
        classification: Optional[str] = None,
        enabled_only: bool = False,
        limit: int = 500,
        offset: int = 0,
    ) -> tuple[list[SkillPermission], int]:
        """Return filtered permissions with total count."""
        where_parts: list[str] = []
        params: list = []

        if category:
            where_parts.append("category = ?")
            params.append(category)
        if classification:
            where_parts.append("classification = ?")
            params.append(classification)
        if enabled_only:
            where_parts.append("enabled = 1")

        where_sql = " AND ".join(where_parts) if where_parts else "1=1"

        rows = await self.db.fetch_all(
            f"""
            SELECT * FROM skill_permissions
            WHERE {where_sql}
            ORDER BY category, classification, pattern
            LIMIT ? OFFSET ?
            """,
            (*params, limit, offset),
        )
        total_row = await self.db.fetch_one(
            f"SELECT COUNT(*) as total FROM skill_permissions WHERE {where_sql}",
            tuple(params),
        )
        total = total_row["total"] if total_row else 0
        return [self._row_to_permission(r) for r in rows], total

    async def get_permission_by_id(self, perm_id: int) -> Optional[SkillPermission]:
        row = await self.db.fetch_one(
            "SELECT * FROM skill_permissions WHERE id = ?", (perm_id,)
        )
        return self._row_to_permission(row) if row else None

    async def get_permissions_by_category(self, category: str) -> list[SkillPermission]:
        """Return all enabled permissions for a category."""
        rows = await self.db.fetch_all(
            "SELECT * FROM skill_permissions WHERE category = ? AND enabled = 1 ORDER BY pattern",
            (category,),
        )
        return [self._row_to_permission(r) for r in rows]

    async def add_permission(
        self, category: str, pattern: str, classification: str, label: str
    ) -> SkillPermission:
        """Add a custom (non-default) permission. Raises on duplicate."""
        await self.db.execute(
            """
            INSERT INTO skill_permissions (category, pattern, classification, label, is_default, enabled)
            VALUES (?, ?, ?, ?, 0, 1)
            """,
            (category, pattern, classification, label),
        )
        row = await self.db.fetch_one(
            "SELECT * FROM skill_permissions WHERE category = ? AND pattern = ?",
            (category, pattern),
        )
        return self._row_to_permission(row)

    async def update_permission(
        self,
        perm_id: int,
        classification: Optional[str] = None,
        label: Optional[str] = None,
        enabled: Optional[bool] = None,
    ) -> Optional[SkillPermission]:
        """Update classification, label, or enabled status."""
        existing = await self.get_permission_by_id(perm_id)
        if not existing:
            return None

        updates: list[str] = []
        params: list = []
        if classification is not None:
            updates.append("classification = ?")
            params.append(classification)
        if label is not None:
            updates.append("label = ?")
            params.append(label)
        if enabled is not None:
            updates.append("enabled = ?")
            params.append(1 if enabled else 0)

        if not updates:
            return existing

        params.append(perm_id)
        await self.db.execute(
            f"UPDATE skill_permissions SET {', '.join(updates)} WHERE id = ?",
            tuple(params),
        )
        return await self.get_permission_by_id(perm_id)

    async def delete_permission(self, perm_id: int) -> bool:
        """Delete a permission (custom only — defaults can only be disabled)."""
        existing = await self.get_permission_by_id(perm_id)
        if not existing:
            return False
        await self.db.execute("DELETE FROM skill_permissions WHERE id = ?", (perm_id,))
        return True

    async def reset_defaults(self) -> int:
        """Re-enable all default permissions and remove custom ones."""
        await self.db.execute("DELETE FROM skill_permissions WHERE is_default = 0")
        await self.db.execute("UPDATE skill_permissions SET enabled = 1 WHERE is_default = 1")
        row = await self.db.fetch_one("SELECT COUNT(*) as total FROM skill_permissions")
        return row["total"] if row else 0

    async def classify_pattern(self, category: str, value: str) -> Optional[str]:
        """Look up classification for a value by matching against enabled permissions.

        Returns 'safe', 'review', 'dangerous', or None if no match.
        Uses GLOB matching for patterns with wildcards, exact match otherwise.
        """
        rows = await self.db.fetch_all(
            "SELECT pattern, classification FROM skill_permissions WHERE category = ? AND enabled = 1",
            (category,),
        )
        for row in rows:
            pattern = row["pattern"]
            if "*" in pattern or "?" in pattern:
                # Use fnmatch-style matching
                import fnmatch
                if fnmatch.fnmatch(value, pattern) or fnmatch.fnmatch(value, f"*{pattern}"):
                    return row["classification"]
            else:
                if value == pattern or value.endswith(f".{pattern}") or pattern in value:
                    return row["classification"]
        return None

    @staticmethod
    def _row_to_permission(row) -> SkillPermission:
        return SkillPermission(
            id=row["id"],
            category=row["category"],
            pattern=row["pattern"],
            classification=row["classification"],
            label=row["label"],
            is_default=bool(row["is_default"]),
            enabled=bool(row["enabled"]),
        )

    # -----------------------------------------------------------------------
    # Trusted Publishers
    # -----------------------------------------------------------------------

    async def list_publishers(self) -> list[TrustedPublisher]:
        rows = await self.db.fetch_all(
            "SELECT * FROM skill_trusted_publishers ORDER BY publisher_name"
        )
        return [self._row_to_publisher(r) for r in rows]

    async def add_publisher(self, publisher_name: str, trust_level: str = "trusted") -> TrustedPublisher:
        await self.db.execute(
            "INSERT INTO skill_trusted_publishers (publisher_name, trust_level, is_default) VALUES (?, ?, 0)",
            (publisher_name, trust_level),
        )
        row = await self.db.fetch_one(
            "SELECT * FROM skill_trusted_publishers WHERE publisher_name = ?",
            (publisher_name,),
        )
        return self._row_to_publisher(row)

    async def delete_publisher(self, publisher_id: int) -> bool:
        existing = await self.db.fetch_one(
            "SELECT * FROM skill_trusted_publishers WHERE id = ?", (publisher_id,)
        )
        if not existing:
            return False
        await self.db.execute("DELETE FROM skill_trusted_publishers WHERE id = ?", (publisher_id,))
        return True

    async def is_trusted_publisher(self, publisher_name: str) -> bool:
        """Check if a publisher is trusted."""
        row = await self.db.fetch_one(
            "SELECT trust_level FROM skill_trusted_publishers WHERE publisher_name = ? AND trust_level = 'trusted'",
            (publisher_name,),
        )
        return row is not None

    @staticmethod
    def _row_to_publisher(row) -> TrustedPublisher:
        return TrustedPublisher(
            id=row["id"],
            publisher_name=row["publisher_name"],
            trust_level=row["trust_level"],
            is_default=bool(row["is_default"]),
        )

    # -----------------------------------------------------------------------
    # Policy Config (singleton)
    # -----------------------------------------------------------------------

    async def get_policy_config(self) -> PolicyConfig:
        """Return the singleton policy configuration."""
        row = await self.db.fetch_one("SELECT * FROM skill_policy_config WHERE id = 1")
        if not row:
            return PolicyConfig(
                policy_enabled=True,
                risk_weights=_default_risk_weights(),
                threshold_allow=3,
                threshold_warn=6,
            )
        return PolicyConfig(
            policy_enabled=bool(row["policy_enabled"]),
            risk_weights={
                "network_domain": row["risk_weight_network"],
                "env_var_read": row["risk_weight_env_var"],
                "shell_exec": row["risk_weight_shell_exec"],
                "code_exec": row["risk_weight_code_exec"],
                "dynamic_import": row["risk_weight_dynamic_import"],
                "file_write": row["risk_weight_file_write"],
                "base64_literal": row["risk_weight_base64"],
                "compiled_code": row["risk_weight_compiled"],
                "rule_match": row["risk_weight_rule_match"],
                "missing_manifest": row["risk_weight_missing_manifest"],
                "symlink_escape": row["risk_weight_symlink"],
            },
            threshold_allow=row["threshold_allow"],
            threshold_warn=row["threshold_warn"],
        )

    async def update_policy_config(self, **kwargs) -> PolicyConfig:
        """Update policy config fields. Accepted keys: policy_enabled, threshold_allow, threshold_warn."""
        updates: list[str] = []
        params: list = []

        simple_fields = {"policy_enabled", "threshold_allow", "threshold_warn"}
        for key in simple_fields:
            if key in kwargs:
                updates.append(f"{key} = ?")
                val = kwargs[key]
                params.append(1 if val is True else (0 if val is False else val))

        # Risk weight updates
        weight_map = {
            "network_domain": "risk_weight_network",
            "env_var_read": "risk_weight_env_var",
            "shell_exec": "risk_weight_shell_exec",
            "code_exec": "risk_weight_code_exec",
            "dynamic_import": "risk_weight_dynamic_import",
            "file_write": "risk_weight_file_write",
            "base64_literal": "risk_weight_base64",
            "compiled_code": "risk_weight_compiled",
            "rule_match": "risk_weight_rule_match",
            "missing_manifest": "risk_weight_missing_manifest",
            "symlink_escape": "risk_weight_symlink",
        }
        risk_weights = kwargs.get("risk_weights")
        if risk_weights and isinstance(risk_weights, dict):
            for category, col_name in weight_map.items():
                if category in risk_weights:
                    updates.append(f"{col_name} = ?")
                    params.append(risk_weights[category])

        if updates:
            updates.append("updated_at = CURRENT_TIMESTAMP")
            await self.db.execute(
                f"UPDATE skill_policy_config SET {', '.join(updates)} WHERE id = 1",
                tuple(params),
            )
        return await self.get_policy_config()


def _default_risk_weights() -> dict[str, int]:
    return {
        "network_domain": 2,
        "env_var_read": 2,
        "shell_exec": 5,
        "code_exec": 5,
        "dynamic_import": 4,
        "file_write": 3,
        "base64_literal": 1,
        "compiled_code": 3,
        "rule_match": 3,
        "missing_manifest": 1,
        "symlink_escape": 3,
    }
