"""
Settings repository for application preferences.

The settings table is a singleton (always id=1), storing:
- Theme preference (system/light/dark)
- Server configuration
- Data retention settings
- Window state
"""

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from securevector.app.database.connection import DatabaseConnection

logger = logging.getLogger(__name__)


@dataclass
class AppSettings:
    """Application settings data class."""

    theme: str = "system"
    server_port: int = 8741
    server_host: str = "127.0.0.1"
    retention_days: int = 30
    store_text_content: bool = True
    notifications_enabled: bool = True
    launch_on_startup: bool = False
    minimize_to_tray: bool = True
    window_width: Optional[int] = None
    window_height: Optional[int] = None
    window_x: Optional[int] = None
    window_y: Optional[int] = None
    # Cloud mode fields
    cloud_mode_enabled: bool = False
    cloud_user_email: Optional[str] = None
    cloud_connected_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {
            "theme": self.theme,
            "server_port": self.server_port,
            "server_host": self.server_host,
            "retention_days": self.retention_days,
            "store_text_content": self.store_text_content,
            "notifications_enabled": self.notifications_enabled,
            "launch_on_startup": self.launch_on_startup,
            "minimize_to_tray": self.minimize_to_tray,
            "window_width": self.window_width,
            "window_height": self.window_height,
            "window_x": self.window_x,
            "window_y": self.window_y,
            "cloud_mode_enabled": self.cloud_mode_enabled,
            "cloud_user_email": self.cloud_user_email,
            "cloud_connected_at": (
                self.cloud_connected_at.isoformat()
                if self.cloud_connected_at
                else None
            ),
        }


class SettingsRepository:
    """
    Repository for application settings.

    Provides CRUD operations for the singleton settings row.
    """

    def __init__(self, db: DatabaseConnection):
        """
        Initialize settings repository.

        Args:
            db: Database connection instance.
        """
        self.db = db

    async def get(self) -> AppSettings:
        """
        Get current application settings.

        Returns:
            AppSettings instance with current values.
        """
        row = await self.db.fetch_one(
            "SELECT * FROM app_settings WHERE id = 1"
        )

        if row is None:
            # Return defaults if no settings exist
            return AppSettings()

        # Parse cloud_connected_at if present
        cloud_connected_at = None
        if row.get("cloud_connected_at"):
            try:
                if isinstance(row["cloud_connected_at"], str):
                    cloud_connected_at = datetime.fromisoformat(
                        row["cloud_connected_at"]
                    )
                else:
                    cloud_connected_at = row["cloud_connected_at"]
            except (ValueError, TypeError):
                pass

        return AppSettings(
            theme=row["theme"],
            server_port=row["server_port"],
            server_host=row["server_host"],
            retention_days=row["retention_days"],
            store_text_content=bool(row["store_text_content"]),
            notifications_enabled=bool(row["notifications_enabled"]),
            launch_on_startup=bool(row["launch_on_startup"]),
            minimize_to_tray=bool(row["minimize_to_tray"]),
            window_width=row["window_width"],
            window_height=row["window_height"],
            window_x=row["window_x"],
            window_y=row["window_y"],
            cloud_mode_enabled=bool(row.get("cloud_mode_enabled", False)),
            cloud_user_email=row.get("cloud_user_email"),
            cloud_connected_at=cloud_connected_at,
            updated_at=row["updated_at"],
        )

    async def update(self, **kwargs) -> AppSettings:
        """
        Update application settings.

        Args:
            **kwargs: Settings to update (only provided keys are updated).

        Returns:
            Updated AppSettings instance.
        """
        if not kwargs:
            return await self.get()

        # Build update query
        valid_fields = {
            "theme",
            "server_port",
            "server_host",
            "retention_days",
            "store_text_content",
            "notifications_enabled",
            "launch_on_startup",
            "minimize_to_tray",
            "window_width",
            "window_height",
            "window_x",
            "window_y",
            "cloud_mode_enabled",
            "cloud_user_email",
            "cloud_connected_at",
        }

        updates = {k: v for k, v in kwargs.items() if k in valid_fields}
        if not updates:
            return await self.get()

        # Add updated_at
        updates["updated_at"] = datetime.utcnow().isoformat()

        # Build SET clause
        set_clause = ", ".join(f"{k} = ?" for k in updates.keys())
        values = list(updates.values())

        await self.db.execute(
            f"UPDATE app_settings SET {set_clause} WHERE id = 1",
            tuple(values),
        )

        logger.info(f"Updated settings: {list(updates.keys())}")
        return await self.get()

    async def update_window_state(
        self,
        width: int,
        height: int,
        x: int,
        y: int,
    ) -> None:
        """
        Update window position and size.

        Args:
            width: Window width.
            height: Window height.
            x: Window X position.
            y: Window Y position.
        """
        await self.db.execute(
            """
            UPDATE app_settings
            SET window_width = ?, window_height = ?, window_x = ?, window_y = ?,
                updated_at = ?
            WHERE id = 1
            """,
            (width, height, x, y, datetime.utcnow().isoformat()),
        )

    async def reset_to_defaults(self) -> AppSettings:
        """
        Reset all settings to default values.

        Returns:
            Default AppSettings instance.
        """
        defaults = AppSettings()
        await self.db.execute(
            """
            UPDATE app_settings SET
                theme = ?,
                server_port = ?,
                server_host = ?,
                retention_days = ?,
                store_text_content = ?,
                notifications_enabled = ?,
                launch_on_startup = ?,
                minimize_to_tray = ?,
                window_width = NULL,
                window_height = NULL,
                window_x = NULL,
                window_y = NULL,
                cloud_mode_enabled = 0,
                cloud_user_email = NULL,
                cloud_connected_at = NULL,
                updated_at = ?
            WHERE id = 1
            """,
            (
                defaults.theme,
                defaults.server_port,
                defaults.server_host,
                defaults.retention_days,
                int(defaults.store_text_content),
                int(defaults.notifications_enabled),
                int(defaults.launch_on_startup),
                int(defaults.minimize_to_tray),
                datetime.utcnow().isoformat(),
            ),
        )
        logger.info("Reset settings to defaults")
        return defaults

    async def clear_cloud_settings(self) -> None:
        """
        Clear cloud mode settings (used when credentials are removed).
        """
        await self.db.execute(
            """
            UPDATE app_settings SET
                cloud_mode_enabled = 0,
                cloud_user_email = NULL,
                cloud_connected_at = NULL,
                updated_at = ?
            WHERE id = 1
            """,
            (datetime.utcnow().isoformat(),),
        )
        logger.info("Cloud settings cleared")
