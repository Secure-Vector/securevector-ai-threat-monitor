"""
Repository for user-defined custom tools.

Users can register their own agent tools (e.g. research, transcribe)
and control permissions through the same block/allow system as essential tools.
"""

import logging
from typing import Optional

from securevector.app.database.connection import DatabaseConnection

logger = logging.getLogger(__name__)


class CustomToolsRepository:
    """CRUD repository for custom tools."""

    def __init__(self, db: DatabaseConnection):
        self.db = db

    _CUSTOM_TOOL_COLUMNS = (
        "tool_id, name, category, risk, default_permission, description, "
        "rate_limit_max_calls, rate_limit_window_seconds, created_at"
    )

    async def get_all_custom_tools(self) -> list[dict]:
        """Get all custom tools.

        Returns:
            List of custom tool dicts.
        """
        rows = await self.db.fetch_all(
            f"SELECT {self._CUSTOM_TOOL_COLUMNS} "
            "FROM custom_tools ORDER BY created_at DESC"
        )
        return [dict(row) for row in rows] if rows else []

    async def get_custom_tool(self, tool_id: str) -> Optional[dict]:
        """Get a single custom tool by ID.

        Args:
            tool_id: Custom tool ID (e.g. "research").

        Returns:
            Dict or None.
        """
        row = await self.db.fetch_one(
            f"SELECT {self._CUSTOM_TOOL_COLUMNS} "
            "FROM custom_tools WHERE tool_id = ?",
            (tool_id,),
        )
        return dict(row) if row else None

    async def create_custom_tool(
        self,
        tool_id: str,
        name: str,
        category: str = "custom",
        risk: str = "write",
        default_permission: str = "block",
        description: str = "",
        rate_limit_max_calls: Optional[int] = None,
        rate_limit_window_seconds: Optional[int] = None,
    ) -> dict:
        """Create a new custom tool.

        Args:
            tool_id: Unique tool identifier.
            name: Display name.
            category: Tool category (default "custom").
            risk: Risk level (read/write/delete/admin).
            default_permission: Default action (block/allow).
            description: Tool description.
            rate_limit_max_calls: Max calls per window (None = no limit).
            rate_limit_window_seconds: Window duration in seconds (None = no limit).

        Returns:
            The created tool dict.
        """
        await self.db.execute(
            """
            INSERT INTO custom_tools
            (tool_id, name, category, risk, default_permission, description,
             rate_limit_max_calls, rate_limit_window_seconds)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (tool_id, name, category, risk, default_permission, description,
             rate_limit_max_calls, rate_limit_window_seconds),
        )
        logger.info(f"Created custom tool: {tool_id}")
        return await self.get_custom_tool(tool_id)

    async def update_custom_tool_permission(
        self, tool_id: str, default_permission: str
    ) -> Optional[dict]:
        """Update the default_permission of a custom tool.

        Args:
            tool_id: Tool ID to update.
            default_permission: New permission ("block" or "allow").

        Returns:
            Updated tool dict, or None if not found.
        """
        await self.db.execute(
            "UPDATE custom_tools SET default_permission = ? WHERE tool_id = ?",
            (default_permission, tool_id),
        )
        logger.info(f"Updated custom tool permission: {tool_id} -> {default_permission}")
        return await self.get_custom_tool(tool_id)

    async def update_custom_tool_rate_limit(
        self,
        tool_id: str,
        max_calls: Optional[int],
        window_seconds: Optional[int],
    ) -> Optional[dict]:
        """Update rate limit config for a custom tool.

        Setting both to None removes the rate limit.

        Args:
            tool_id: Tool ID to update.
            max_calls: Max calls per window (None = no limit).
            window_seconds: Window duration in seconds (None = no limit).

        Returns:
            Updated tool dict, or None if not found.
        """
        await self.db.execute(
            "UPDATE custom_tools SET rate_limit_max_calls = ?, rate_limit_window_seconds = ? "
            "WHERE tool_id = ?",
            (max_calls, window_seconds, tool_id),
        )
        logger.info(f"Updated rate limit for {tool_id}: {max_calls}/{window_seconds}s")
        return await self.get_custom_tool(tool_id)

    async def delete_custom_tool(self, tool_id: str) -> bool:
        """Delete a custom tool.

        Args:
            tool_id: Tool ID to delete.

        Returns:
            True if deleted.
        """
        await self.db.execute(
            "DELETE FROM custom_tools WHERE tool_id = ?",
            (tool_id,),
        )
        logger.info(f"Deleted custom tool: {tool_id}")
        return True

    # ==================== Call Log ====================

    async def log_tool_call(self, tool_id: str) -> None:
        """Record a tool call for rate limiting.

        Args:
            tool_id: Tool ID that was called.
        """
        await self.db.execute(
            "INSERT INTO tool_call_log (tool_id) VALUES (?)",
            (tool_id,),
        )

    async def count_recent_calls(self, tool_id: str, window_seconds: int) -> int:
        """Count tool calls within the given time window.

        Args:
            tool_id: Tool ID to check.
            window_seconds: How far back to look (in seconds).

        Returns:
            Number of calls in the window.
        """
        row = await self.db.fetch_one(
            "SELECT COUNT(*) as cnt FROM tool_call_log "
            "WHERE tool_id = ? AND called_at >= datetime('now', ?)",
            (tool_id, f"-{window_seconds} seconds"),
        )
        return row["cnt"] if row else 0

    async def cleanup_old_calls(self, older_than_seconds: int = 86400) -> int:
        """Delete old call log entries for housekeeping.

        Args:
            older_than_seconds: Delete entries older than this (default 24h).

        Returns:
            Number of rows deleted.
        """
        result = await self.db.execute(
            "DELETE FROM tool_call_log WHERE called_at < datetime('now', ?)",
            (f"-{older_than_seconds} seconds",),
        )
        return result if isinstance(result, int) else 0
