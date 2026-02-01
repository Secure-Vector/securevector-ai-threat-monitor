"""
Rules service for managing detection rules.

All-DB approach:
- Custom rules stored in SQLite only
- Triggers analysis service reload when rules change
"""

import logging
from typing import Optional

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.repositories.rules import (
    CustomRule,
    RulesRepository,
    RuleValidationError,
)
from securevector.app.services.nlp_rule_generator import NLPRuleGenerator, GeneratedPattern

logger = logging.getLogger(__name__)


class RulesService:
    """
    Service for managing custom detection rules.

    All-DB approach - rules are stored only in SQLite.
    Analysis service reloads rules when they change.
    """

    def __init__(self, db: DatabaseConnection):
        """
        Initialize rules service.

        Args:
            db: Database connection.
        """
        self.db = db
        self.repo = RulesRepository(db)
        self.nlp_generator = NLPRuleGenerator()

    async def create_rule_from_nlp(
        self,
        description: str,
        name: Optional[str] = None,
        category: Optional[str] = None,
        severity: Optional[str] = None,
        enabled: bool = True,
    ) -> CustomRule:
        """
        Create a rule from natural language description.

        Args:
            description: Natural language description of what to detect.
            name: Optional rule name (auto-generated if not provided).
            category: Optional category (suggested from description if not provided).
            severity: Optional severity (suggested from patterns if not provided).
            enabled: Whether rule should be enabled.

        Returns:
            Created CustomRule.

        Raises:
            RuleValidationError: If no patterns could be generated.
        """
        # Generate patterns from description
        patterns = self.nlp_generator.generate(description)

        if not patterns:
            raise RuleValidationError(
                f"Could not generate patterns from description: {description}"
            )

        # Use suggestions if not provided
        if not category:
            category = self.nlp_generator.suggest_category(description)
        if not severity:
            severity = self.nlp_generator.suggest_severity(patterns)
        if not name:
            # Generate name from description
            words = description.lower().split()[:4]
            name = "_".join(w for w in words if w.isalnum())[:50] or "custom_rule"

        # Extract pattern strings
        pattern_strings = [p.pattern for p in patterns]

        # Create rule in database
        rule = await self.repo.create_custom_rule(
            name=name,
            category=category,
            description=description,
            severity=severity,
            patterns=pattern_strings,
            enabled=enabled,
            metadata={
                "generated_from": "nlp",
                "original_description": description,
                "pattern_confidences": [p.confidence for p in patterns],
            },
        )

        # Trigger rules reload in analysis service
        await self._reload_analysis_service()

        logger.info(f"Created rule from NLP: {rule.id} with {len(pattern_strings)} patterns")
        return rule

    async def create_rule(
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
        Create a custom rule.

        Args:
            name: Rule name.
            category: Rule category.
            description: Rule description.
            severity: Severity level.
            patterns: List of regex patterns.
            enabled: Whether rule is enabled.
            metadata: Additional metadata.

        Returns:
            Created CustomRule.
        """
        # Create in database
        rule = await self.repo.create_custom_rule(
            name=name,
            category=category,
            description=description,
            severity=severity,
            patterns=patterns,
            enabled=enabled,
            metadata=metadata,
        )

        # Trigger rules reload
        await self._reload_analysis_service()

        return rule

    async def update_rule(
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

        Returns:
            Updated CustomRule or None if not found.
        """
        rule = await self.repo.update_custom_rule(
            rule_id=rule_id,
            name=name,
            category=category,
            description=description,
            severity=severity,
            patterns=patterns,
            enabled=enabled,
            metadata=metadata,
        )

        if rule:
            # Trigger rules reload
            await self._reload_analysis_service()

        return rule

    async def delete_rule(self, rule_id: str) -> bool:
        """
        Delete a custom rule.

        Returns:
            True if deleted, False if not found.
        """
        deleted = await self.repo.delete_custom_rule(rule_id)

        if deleted:
            # Trigger rules reload
            await self._reload_analysis_service()

        return deleted

    async def toggle_rule(self, rule_id: str, enabled: bool) -> Optional[CustomRule]:
        """Toggle rule enabled status."""
        return await self.update_rule(rule_id, enabled=enabled)

    async def _reload_analysis_service(self) -> None:
        """Reload rules in the analysis service."""
        try:
            from securevector.app.services.analysis_service import get_analysis_service
            service = get_analysis_service()
            await service.reload_rules()
            logger.debug("Analysis service rules reloaded")
        except Exception as e:
            logger.warning(f"Failed to reload analysis service: {e}")
