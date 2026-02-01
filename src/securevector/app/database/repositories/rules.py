"""
Rules repository for custom rules and overrides.

Provides CRUD operations for:
- Custom detection rules (user-created)
- Rule overrides (modifications to community rules)
"""

import json
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from securevector.app.database.connection import DatabaseConnection

logger = logging.getLogger(__name__)


class RuleValidationError(Exception):
    """Raised when a rule fails validation."""

    pass


@dataclass
class CustomRule:
    """Custom rule data class."""

    id: str
    name: str
    category: str
    description: str
    severity: str
    patterns: list[str]
    enabled: bool
    created_at: datetime
    updated_at: datetime
    metadata: Optional[dict] = None

    def to_dict(self) -> dict:
        """Convert to dictionary for API response."""
        return {
            "id": self.id,
            "name": self.name,
            "category": self.category,
            "description": self.description,
            "severity": self.severity,
            "patterns": self.patterns,
            "enabled": self.enabled,
            "source": "custom",
            "has_override": False,
            "metadata": self.metadata,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


@dataclass
class RuleOverride:
    """Rule override data class."""

    id: str
    original_rule_id: str
    enabled: Optional[bool]
    severity: Optional[str]
    patterns: Optional[list[str]]
    created_at: datetime
    updated_at: datetime

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {
            "id": self.id,
            "original_rule_id": self.original_rule_id,
            "enabled": self.enabled,
            "severity": self.severity,
            "patterns": self.patterns,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


VALID_SEVERITIES = ("low", "medium", "high", "critical")


@dataclass
class CommunityRule:
    """Community rule data class (cached from YAML)."""

    id: str
    name: str
    category: str
    description: str
    severity: str
    patterns: list[str]
    enabled: bool
    source_file: Optional[str] = None
    metadata: Optional[dict] = None
    loaded_at: Optional[datetime] = None

    def to_dict(self) -> dict:
        """Convert to dictionary for API response."""
        return {
            "id": self.id,
            "name": self.name,
            "category": self.category,
            "description": self.description,
            "severity": self.severity,
            "patterns": self.patterns,
            "enabled": self.enabled,
            "source": "community",
            "has_override": False,
            "metadata": self.metadata,
        }


def validate_patterns(patterns: list[str]) -> None:
    """
    Validate regex patterns.

    Args:
        patterns: List of regex pattern strings.

    Raises:
        RuleValidationError: If any pattern is invalid.
    """
    if not patterns:
        raise RuleValidationError("At least one pattern is required")

    for i, pattern in enumerate(patterns):
        try:
            re.compile(pattern)
        except re.error as e:
            raise RuleValidationError(
                f"Invalid regex pattern at index {i}: {pattern} - {e}"
            )


def validate_severity(severity: str) -> None:
    """
    Validate severity value.

    Args:
        severity: Severity string.

    Raises:
        RuleValidationError: If severity is invalid.
    """
    if severity not in VALID_SEVERITIES:
        raise RuleValidationError(
            f"Invalid severity: {severity}. Must be one of: {', '.join(VALID_SEVERITIES)}"
        )


class RulesRepository:
    """
    Repository for custom rules and rule overrides.

    Provides CRUD operations for user-created rules and
    modifications to community rules.
    """

    def __init__(self, db: DatabaseConnection):
        """
        Initialize rules repository.

        Args:
            db: Database connection instance.
        """
        self.db = db

    # --- Custom Rules ---

    async def create_custom_rule(
        self,
        name: str,
        category: str,
        description: str,
        severity: str,
        patterns: list[str],
        enabled: bool = True,
        metadata: Optional[dict] = None,
    ) -> CustomRule:
        """
        Create a new custom rule.

        Args:
            name: Rule name.
            category: Rule category.
            description: Rule description.
            severity: Severity level (low/medium/high/critical).
            patterns: List of regex patterns.
            enabled: Whether rule is enabled.
            metadata: Additional metadata.

        Returns:
            Created CustomRule.

        Raises:
            RuleValidationError: If validation fails.
        """
        # Validate
        validate_severity(severity)
        validate_patterns(patterns)

        # Generate ID
        rule_id = f"custom_{uuid.uuid4().hex[:12]}"
        now = datetime.utcnow()

        await self.db.execute(
            """
            INSERT INTO custom_rules (
                id, name, category, description, severity,
                patterns, enabled, metadata, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                rule_id,
                name,
                category,
                description,
                severity,
                json.dumps(patterns),
                int(enabled),
                json.dumps(metadata) if metadata else None,
                now.isoformat(),
                now.isoformat(),
            ),
        )

        logger.info(f"Created custom rule: {rule_id} ({name})")

        return CustomRule(
            id=rule_id,
            name=name,
            category=category,
            description=description,
            severity=severity,
            patterns=patterns,
            enabled=enabled,
            metadata=metadata,
            created_at=now,
            updated_at=now,
        )

    async def get_custom_rule(self, rule_id: str) -> Optional[CustomRule]:
        """
        Get a custom rule by ID.

        Args:
            rule_id: Rule ID.

        Returns:
            CustomRule or None if not found.
        """
        row = await self.db.fetch_one(
            "SELECT * FROM custom_rules WHERE id = ?",
            (rule_id,),
        )

        if row is None:
            return None

        return self._row_to_custom_rule(row)

    async def list_custom_rules(
        self,
        category: Optional[str] = None,
        enabled: Optional[bool] = None,
    ) -> list[CustomRule]:
        """
        List all custom rules.

        Args:
            category: Filter by category.
            enabled: Filter by enabled status.

        Returns:
            List of CustomRule instances.
        """
        conditions = []
        params = []

        if category is not None:
            conditions.append("category = ?")
            params.append(category)

        if enabled is not None:
            conditions.append("enabled = ?")
            params.append(int(enabled))

        where_clause = " AND ".join(conditions) if conditions else "1=1"

        rows = await self.db.fetch_all(
            f"SELECT * FROM custom_rules WHERE {where_clause} ORDER BY name",
            tuple(params),
        )

        return [self._row_to_custom_rule(row) for row in rows]

    async def update_custom_rule(
        self,
        rule_id: str,
        name: Optional[str] = None,
        category: Optional[str] = None,
        description: Optional[str] = None,
        severity: Optional[str] = None,
        patterns: Optional[list[str]] = None,
        enabled: Optional[bool] = None,
        metadata: Optional[dict] = None,
    ) -> Optional[CustomRule]:
        """
        Update a custom rule.

        Args:
            rule_id: Rule ID.
            name: New name (optional).
            category: New category (optional).
            description: New description (optional).
            severity: New severity (optional).
            patterns: New patterns (optional).
            enabled: New enabled status (optional).
            metadata: New metadata (optional).

        Returns:
            Updated CustomRule or None if not found.

        Raises:
            RuleValidationError: If validation fails.
        """
        # Check if rule exists
        existing = await self.get_custom_rule(rule_id)
        if existing is None:
            return None

        # Validate new values
        if severity is not None:
            validate_severity(severity)
        if patterns is not None:
            validate_patterns(patterns)

        # Build update
        updates = {}
        if name is not None:
            updates["name"] = name
        if category is not None:
            updates["category"] = category
        if description is not None:
            updates["description"] = description
        if severity is not None:
            updates["severity"] = severity
        if patterns is not None:
            updates["patterns"] = json.dumps(patterns)
        if enabled is not None:
            updates["enabled"] = int(enabled)
        if metadata is not None:
            updates["metadata"] = json.dumps(metadata)

        if not updates:
            return existing

        updates["updated_at"] = datetime.utcnow().isoformat()

        set_clause = ", ".join(f"{k} = ?" for k in updates.keys())
        values = list(updates.values())

        await self.db.execute(
            f"UPDATE custom_rules SET {set_clause} WHERE id = ?",
            tuple(values + [rule_id]),
        )

        logger.info(f"Updated custom rule: {rule_id}")
        return await self.get_custom_rule(rule_id)

    async def delete_custom_rule(self, rule_id: str) -> bool:
        """
        Delete a custom rule.

        Args:
            rule_id: Rule ID.

        Returns:
            True if deleted, False if not found.
        """
        cursor = await self.db.execute(
            "DELETE FROM custom_rules WHERE id = ?",
            (rule_id,),
        )

        deleted = cursor.rowcount > 0
        if deleted:
            logger.info(f"Deleted custom rule: {rule_id}")

        return deleted

    # --- Rule Overrides ---

    async def create_override(
        self,
        original_rule_id: str,
        enabled: Optional[bool] = None,
        severity: Optional[str] = None,
        patterns: Optional[list[str]] = None,
    ) -> RuleOverride:
        """
        Create or update a rule override.

        Args:
            original_rule_id: ID of the community rule to override.
            enabled: Override enabled status.
            severity: Override severity.
            patterns: Override patterns.

        Returns:
            Created or updated RuleOverride.

        Raises:
            RuleValidationError: If validation fails.
        """
        # Validate
        if severity is not None:
            validate_severity(severity)
        if patterns is not None:
            validate_patterns(patterns)

        # Check if override exists
        existing = await self.get_override(original_rule_id)

        now = datetime.utcnow()

        if existing:
            # Update existing override
            await self.db.execute(
                """
                UPDATE rule_overrides SET
                    enabled = ?, severity = ?, patterns = ?, updated_at = ?
                WHERE original_rule_id = ?
                """,
                (
                    enabled if enabled is not None else existing.enabled,
                    severity if severity is not None else existing.severity,
                    json.dumps(patterns) if patterns is not None else (
                        json.dumps(existing.patterns) if existing.patterns else None
                    ),
                    now.isoformat(),
                    original_rule_id,
                ),
            )
            logger.info(f"Updated override for rule: {original_rule_id}")
        else:
            # Create new override
            override_id = str(uuid.uuid4())
            await self.db.execute(
                """
                INSERT INTO rule_overrides (
                    id, original_rule_id, enabled, severity, patterns,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    override_id,
                    original_rule_id,
                    enabled,
                    severity,
                    json.dumps(patterns) if patterns else None,
                    now.isoformat(),
                    now.isoformat(),
                ),
            )
            logger.info(f"Created override for rule: {original_rule_id}")

        return await self.get_override(original_rule_id)

    async def get_override(self, original_rule_id: str) -> Optional[RuleOverride]:
        """
        Get a rule override by original rule ID.

        Args:
            original_rule_id: Original community rule ID.

        Returns:
            RuleOverride or None if not found.
        """
        row = await self.db.fetch_one(
            "SELECT * FROM rule_overrides WHERE original_rule_id = ?",
            (original_rule_id,),
        )

        if row is None:
            return None

        return self._row_to_override(row)

    async def list_overrides(self) -> list[RuleOverride]:
        """
        List all rule overrides.

        Returns:
            List of RuleOverride instances.
        """
        rows = await self.db.fetch_all(
            "SELECT * FROM rule_overrides ORDER BY original_rule_id"
        )
        return [self._row_to_override(row) for row in rows]

    async def delete_override(self, original_rule_id: str) -> bool:
        """
        Delete a rule override (reset to default).

        Args:
            original_rule_id: Original community rule ID.

        Returns:
            True if deleted, False if not found.
        """
        cursor = await self.db.execute(
            "DELETE FROM rule_overrides WHERE original_rule_id = ?",
            (original_rule_id,),
        )

        deleted = cursor.rowcount > 0
        if deleted:
            logger.info(f"Deleted override for rule: {original_rule_id}")

        return deleted

    # --- Helpers ---

    def _row_to_custom_rule(self, row) -> CustomRule:
        """Convert database row to CustomRule."""
        patterns = json.loads(row["patterns"]) if row["patterns"] else []
        metadata = json.loads(row["metadata"]) if row["metadata"] else None
        created_at = datetime.fromisoformat(row["created_at"]) if isinstance(row["created_at"], str) else row["created_at"]
        updated_at = datetime.fromisoformat(row["updated_at"]) if isinstance(row["updated_at"], str) else row["updated_at"]

        return CustomRule(
            id=row["id"],
            name=row["name"],
            category=row["category"],
            description=row["description"],
            severity=row["severity"],
            patterns=patterns,
            enabled=bool(row["enabled"]),
            metadata=metadata,
            created_at=created_at,
            updated_at=updated_at,
        )

    # --- Community Rules (cached from YAML) ---

    async def cache_community_rule(
        self,
        rule_id: str,
        name: str,
        category: str,
        description: str,
        severity: str,
        patterns: list[str],
        source_file: Optional[str] = None,
        metadata: Optional[dict] = None,
    ) -> CommunityRule:
        """
        Cache a community rule from YAML file.

        Args:
            rule_id: Unique rule ID.
            name: Rule name.
            category: Rule category.
            description: Rule description.
            severity: Severity level.
            patterns: List of regex patterns.
            source_file: Source YAML file path.
            metadata: Additional metadata.

        Returns:
            Cached CommunityRule.
        """
        now = datetime.utcnow()

        # Upsert - insert or replace
        await self.db.execute(
            """
            INSERT OR REPLACE INTO community_rules (
                id, name, category, description, severity,
                patterns, enabled, source_file, metadata, loaded_at
            ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
            """,
            (
                rule_id,
                name,
                category,
                description,
                severity,
                json.dumps(patterns),
                source_file,
                json.dumps(metadata) if metadata else None,
                now.isoformat(),
            ),
        )

        return CommunityRule(
            id=rule_id,
            name=name,
            category=category,
            description=description,
            severity=severity,
            patterns=patterns,
            enabled=True,
            source_file=source_file,
            metadata=metadata,
            loaded_at=now,
        )

    async def list_community_rules(
        self,
        category: Optional[str] = None,
        enabled: Optional[bool] = None,
    ) -> list[CommunityRule]:
        """
        List all cached community rules.

        Args:
            category: Filter by category.
            enabled: Filter by enabled status.

        Returns:
            List of CommunityRule instances.
        """
        conditions = []
        params = []

        if category is not None:
            conditions.append("category = ?")
            params.append(category)

        if enabled is not None:
            conditions.append("enabled = ?")
            params.append(int(enabled))

        where_clause = " AND ".join(conditions) if conditions else "1=1"

        rows = await self.db.fetch_all(
            f"SELECT * FROM community_rules WHERE {where_clause} ORDER BY category, name",
            tuple(params),
        )

        return [self._row_to_community_rule(row) for row in rows]

    async def get_community_rule(self, rule_id: str) -> Optional[CommunityRule]:
        """Get a community rule by ID."""
        row = await self.db.fetch_one(
            "SELECT * FROM community_rules WHERE id = ?",
            (rule_id,),
        )
        return self._row_to_community_rule(row) if row else None

    async def clear_community_rules(self) -> int:
        """Clear all cached community rules. Returns count deleted."""
        cursor = await self.db.execute("DELETE FROM community_rules")
        return cursor.rowcount

    async def get_all_enabled_rules(self) -> list[dict]:
        """
        Get all enabled rules (community + custom) with overrides applied.

        Returns:
            List of rule dicts ready for pattern matching.
        """
        rules = []

        # Get community rules with overrides applied
        community = await self.db.fetch_all(
            """
            SELECT c.*, o.enabled as override_enabled, o.severity as override_severity, o.patterns as override_patterns
            FROM community_rules c
            LEFT JOIN rule_overrides o ON c.id = o.original_rule_id
            WHERE COALESCE(o.enabled, c.enabled) = 1
            """
        )

        for row in community:
            patterns = json.loads(row["override_patterns"]) if row["override_patterns"] else json.loads(row["patterns"])
            rules.append({
                "id": row["id"],
                "name": row["name"],
                "category": row["category"],
                "description": row["description"],
                "severity": row["override_severity"] or row["severity"],
                "patterns": patterns,
                "source": "community",
                "has_override": row["override_enabled"] is not None or row["override_severity"] is not None,
            })

        # Get custom rules
        custom = await self.db.fetch_all(
            "SELECT * FROM custom_rules WHERE enabled = 1"
        )

        for row in custom:
            rules.append({
                "id": row["id"],
                "name": row["name"],
                "category": row["category"],
                "description": row["description"],
                "severity": row["severity"],
                "patterns": json.loads(row["patterns"]),
                "source": "custom",
                "has_override": False,
            })

        return rules

    async def get_rule_counts(self) -> dict:
        """Get counts of rules by source."""
        community_row = await self.db.fetch_one(
            "SELECT COUNT(*) as count FROM community_rules"
        )
        custom_row = await self.db.fetch_one(
            "SELECT COUNT(*) as count FROM custom_rules"
        )
        override_row = await self.db.fetch_one(
            "SELECT COUNT(*) as count FROM rule_overrides"
        )

        return {
            "community": community_row["count"] if community_row else 0,
            "custom": custom_row["count"] if custom_row else 0,
            "overrides": override_row["count"] if override_row else 0,
        }

    def _row_to_community_rule(self, row) -> CommunityRule:
        """Convert database row to CommunityRule."""
        patterns = json.loads(row["patterns"]) if row["patterns"] else []
        metadata = json.loads(row["metadata"]) if row["metadata"] else None
        loaded_at = datetime.fromisoformat(row["loaded_at"]) if isinstance(row["loaded_at"], str) else row["loaded_at"]

        return CommunityRule(
            id=row["id"],
            name=row["name"],
            category=row["category"],
            description=row["description"],
            severity=row["severity"],
            patterns=patterns,
            enabled=bool(row["enabled"]),
            source_file=row["source_file"],
            metadata=metadata,
            loaded_at=loaded_at,
        )

    def _row_to_override(self, row) -> RuleOverride:
        """Convert database row to RuleOverride."""
        patterns = json.loads(row["patterns"]) if row["patterns"] else None
        created_at = datetime.fromisoformat(row["created_at"]) if isinstance(row["created_at"], str) else row["created_at"]
        updated_at = datetime.fromisoformat(row["updated_at"]) if isinstance(row["updated_at"], str) else row["updated_at"]

        return RuleOverride(
            id=row["id"],
            original_rule_id=row["original_rule_id"],
            enabled=bool(row["enabled"]) if row["enabled"] is not None else None,
            severity=row["severity"],
            patterns=patterns,
            created_at=created_at,
            updated_at=updated_at,
        )
