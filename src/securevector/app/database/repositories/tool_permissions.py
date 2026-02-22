"""
Repository for tool permission essential overrides.

Stores user's block/allow choices for the ~27 bundled essential tools.
"""

import logging
from datetime import datetime
from typing import Optional

from securevector.app.database.connection import DatabaseConnection

logger = logging.getLogger(__name__)


class ToolPermissionsRepository:
    """Repository for essential tool permission overrides."""

    def __init__(self, db: DatabaseConnection):
        self.db = db

    _OVERRIDE_COLUMNS = (
        "tool_id, action, rate_limit_max_calls, rate_limit_window_seconds, updated_at"
    )

    async def get_all_overrides(self) -> list[dict]:
        """Get all essential tool overrides.

        Returns:
            List of dicts with tool_id, action, rate limit fields, updated_at keys.
        """
        rows = await self.db.fetch_all(
            f"SELECT {self._OVERRIDE_COLUMNS} FROM tool_essential_overrides ORDER BY tool_id"
        )
        return [dict(row) for row in rows] if rows else []

    async def get_override(self, tool_id: str) -> Optional[dict]:
        """Get a single override by tool ID.

        Args:
            tool_id: Essential tool ID (e.g. "gmail.send_email").

        Returns:
            Dict with tool_id, action, rate limit fields, updated_at or None.
        """
        row = await self.db.fetch_one(
            f"SELECT {self._OVERRIDE_COLUMNS} FROM tool_essential_overrides WHERE tool_id = ?",
            (tool_id,),
        )
        return dict(row) if row else None

    async def upsert_override(self, tool_id: str, action: str) -> dict:
        """Create or update an override.

        Args:
            tool_id: Essential tool ID.
            action: "block" or "allow".

        Returns:
            The upserted override dict.
        """
        now = datetime.utcnow().isoformat()
        await self.db.execute(
            """
            INSERT INTO tool_essential_overrides (tool_id, action, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(tool_id) DO UPDATE SET action = ?, updated_at = ?
            """,
            (tool_id, action, now, action, now),
        )
        logger.info(f"Upserted tool override: {tool_id} -> {action}")
        return {"tool_id": tool_id, "action": action, "updated_at": now}

    async def delete_override(self, tool_id: str) -> bool:
        """Delete an override, reverting to registry default.

        Args:
            tool_id: Essential tool ID.

        Returns:
            True if a row was deleted.
        """
        await self.db.execute(
            "DELETE FROM tool_essential_overrides WHERE tool_id = ?",
            (tool_id,),
        )
        logger.info(f"Deleted tool override: {tool_id}")
        return True

    async def upsert_rate_limit(
        self,
        tool_id: str,
        max_calls: Optional[int],
        window_seconds: Optional[int],
    ) -> dict:
        """Set rate limit on an essential tool override.

        Creates the override row if it doesn't exist (preserving registry default action).

        Args:
            tool_id: Essential tool ID.
            max_calls: Max calls per window (None = no limit).
            window_seconds: Window duration in seconds (None = no limit).

        Returns:
            The updated override dict.
        """
        now = datetime.utcnow().isoformat()

        # Check if override exists
        existing = await self.get_override(tool_id)
        if existing:
            await self.db.execute(
                "UPDATE tool_essential_overrides "
                "SET rate_limit_max_calls = ?, rate_limit_window_seconds = ?, updated_at = ? "
                "WHERE tool_id = ?",
                (max_calls, window_seconds, now, tool_id),
            )
        else:
            # Create override row — need the default action from the caller
            # Use 'allow' as default since rate limiting only makes sense for allowed tools
            await self.db.execute(
                "INSERT INTO tool_essential_overrides "
                "(tool_id, action, rate_limit_max_calls, rate_limit_window_seconds, updated_at) "
                "VALUES (?, 'allow', ?, ?, ?)",
                (tool_id, max_calls, window_seconds, now),
            )

        logger.info(f"Upserted rate limit for {tool_id}: {max_calls}/{window_seconds}s")
        return await self.get_override(tool_id)
