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
import os
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from securevector.app.database.connection import DatabaseConnection

logger = logging.getLogger(__name__)


def _residency_locked_from_env() -> bool:
    """Data-residency hard-lock from env/config (the enforcement source today).

    EU / regulated deployments set this so the device can never send prompt or
    output text to the cloud. ``SV_RESIDENCY_LOCKED`` is an explicit boolean;
    ``SV_DATA_RESIDENCY`` locks when set to an EU/EEA region. The cloud
    enrollment response will be able to set the persisted ``residency_locked``
    column too (llm-security-engine #189) — either source enables the lock.
    """
    if os.environ.get("SV_RESIDENCY_LOCKED", "").strip().lower() in ("1", "true", "yes", "on"):
        return True
    return os.environ.get("SV_DATA_RESIDENCY", "").strip().lower() in ("eu", "eea")


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
    # LLM Review settings (stored as JSON)
    llm_settings: Optional[dict] = field(default_factory=lambda: None)
    # Output leakage detection (scan LLM responses for data leaks)
    scan_llm_responses: bool = True
    # Block threats mode (when enabled, proxy blocks detected threats)
    block_threats: bool = False
    # Tool call permission scanning
    tool_permissions_enabled: bool = True
    # SecureVector Guardian — local ML detection layer (runs in parallel with rules)
    guardian_ml_enabled: bool = True
    # Local-only analysis ("EU residency mode"): when True, prompts/outputs are
    # never sent to the cloud /analyze engine — detection stays on-device. The
    # rest of Cloud Connect (rule/policy sync, fleet metadata, governance) is
    # unaffected. Default ON — prompts stay local unless explicitly opted out.
    local_only_analysis: bool = True
    # Data-residency hard-lock: when True, local_only_analysis is forced ON and
    # cannot be turned off (EU/regulated orgs). Resolved from env/config or the
    # persisted column (cloud enrollment, future). Default OFF.
    residency_locked: bool = False
    # Per-run cost enforcement (#203). NULL/0 = off — every control ships
    # disabled; a cost control that blocks real work by default is a cost
    # control that gets switched off.
    run_max_tool_calls: Optional[int] = None
    run_max_cost_usd: Optional[float] = None
    run_max_tokens: Optional[int] = None
    run_limit_action: str = "warn"
    run_loop_breaker: bool = False

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
            "scan_llm_responses": self.scan_llm_responses,
            "block_threats": self.block_threats,
            "guardian_ml_enabled": self.guardian_ml_enabled,
            "local_only_analysis": self.local_only_analysis,
            "residency_locked": self.residency_locked,
            "run_max_tool_calls": self.run_max_tool_calls,
            "run_max_cost_usd": self.run_max_cost_usd,
            "run_max_tokens": self.run_max_tokens,
            "run_limit_action": self.run_limit_action,
            "run_loop_breaker": self.run_loop_breaker,
        }


DEFAULT_DELEGATION_POLICY = {"enabled": True, "cross_harness": False, "folder_allowlist": []}
MAX_DELEGATION_ALLOWLIST = 50


def normalize_delegation_policy(value: dict) -> dict:
    """Keep only known keys with the right types. Allowlist entries are
    absolute paths, at most MAX_DELEGATION_ALLOWLIST of them."""
    out = {
        "enabled": bool(value.get("enabled", DEFAULT_DELEGATION_POLICY["enabled"])),
        "cross_harness": bool(value.get("cross_harness", DEFAULT_DELEGATION_POLICY["cross_harness"])),
        "folder_allowlist": [],
    }
    folders = value.get("folder_allowlist")
    if isinstance(folders, list):
        for f in folders:
            if isinstance(f, str) and f.startswith("/") and len(f) <= 4096 and "\x00" not in f:
                path = f.rstrip("/") or "/"
                if path not in out["folder_allowlist"]:
                    out["folder_allowlist"].append(path)
            if len(out["folder_allowlist"]) >= MAX_DELEGATION_ALLOWLIST:
                break
    return out


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

        # Convert row to dict for safe .get() access (sqlite3.Row doesn't support .get())
        row_dict = dict(row)

        # Parse cloud_connected_at if present
        cloud_connected_at = None
        if row_dict.get("cloud_connected_at"):
            try:
                if isinstance(row_dict["cloud_connected_at"], str):
                    cloud_connected_at = datetime.fromisoformat(
                        row_dict["cloud_connected_at"]
                    )
                else:
                    cloud_connected_at = row_dict["cloud_connected_at"]
            except (ValueError, TypeError):
                pass

        # Parse llm_settings JSON if present
        llm_settings = None
        if row_dict.get("llm_settings"):
            try:
                llm_settings = json.loads(row_dict["llm_settings"])
            except (json.JSONDecodeError, TypeError):
                pass

        return AppSettings(
            theme=row_dict["theme"],
            server_port=row_dict["server_port"],
            server_host=row_dict["server_host"],
            retention_days=row_dict["retention_days"],
            store_text_content=bool(row_dict["store_text_content"]),
            notifications_enabled=bool(row_dict["notifications_enabled"]),
            launch_on_startup=bool(row_dict["launch_on_startup"]),
            minimize_to_tray=bool(row_dict["minimize_to_tray"]),
            window_width=row_dict["window_width"],
            window_height=row_dict["window_height"],
            window_x=row_dict["window_x"],
            window_y=row_dict["window_y"],
            cloud_mode_enabled=bool(row_dict.get("cloud_mode_enabled", False)),
            cloud_user_email=row_dict.get("cloud_user_email"),
            cloud_connected_at=cloud_connected_at,
            updated_at=row_dict["updated_at"],
            llm_settings=llm_settings,
            scan_llm_responses=bool(row_dict.get("scan_llm_responses", True)),
            block_threats=bool(row_dict.get("block_threats", False)),
            tool_permissions_enabled=bool(row_dict.get("tool_permissions_enabled", True)),
            guardian_ml_enabled=bool(row_dict.get("guardian_ml_enabled", True)),
            run_max_tool_calls=row_dict.get("run_max_tool_calls"),
            run_max_cost_usd=row_dict.get("run_max_cost_usd"),
            run_max_tokens=row_dict.get("run_max_tokens"),
            run_limit_action=row_dict.get("run_limit_action") or "warn",
            run_loop_breaker=bool(row_dict.get("run_loop_breaker", False)),
            **self._resolve_residency(row_dict),
        )

    @staticmethod
    def _resolve_residency(row_dict: dict) -> dict:
        """Resolve the residency lock + local-only flag together.

        The lock is True if EITHER the persisted column says so OR an env/config
        override is set. When locked, ``local_only_analysis`` is force-coerced
        ON — that's the whole point of the lock, so prompt text can never leave
        the device regardless of what the stored toggle says.
        """
        locked = bool(row_dict.get("residency_locked", False)) or _residency_locked_from_env()
        local_only = bool(row_dict.get("local_only_analysis", True))
        if locked:
            local_only = True
        return {"local_only_analysis": local_only, "residency_locked": locked}

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
            "llm_settings",
            "scan_llm_responses",
            "block_threats",
            "tool_permissions_enabled",
            "guardian_ml_enabled",
            "local_only_analysis",
            "residency_locked",
            "run_max_tool_calls",
            "run_max_cost_usd",
            "run_max_tokens",
            "run_limit_action",
            "run_loop_breaker",
        }

        updates = {}
        for k, v in kwargs.items():
            if k not in valid_fields:
                continue
            # Convert llm_settings dict to JSON string
            if k == "llm_settings" and isinstance(v, dict):
                updates[k] = json.dumps(v)
            else:
                updates[k] = v
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

    async def get_delegation_policy(self) -> dict:
        """The delegation policy: {enabled, cross_harness, folder_allowlist}.
        Defaults when unset or unreadable."""
        policy = dict(DEFAULT_DELEGATION_POLICY)
        policy["folder_allowlist"] = []
        try:
            row = await self.db.fetch_one("SELECT delegation_policy FROM app_settings WHERE id = 1")
        except Exception:  # column absent before v60
            return policy
        raw = dict(row).get("delegation_policy") if row else None
        if raw:
            try:
                stored = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                stored = None
            if isinstance(stored, dict):
                policy.update(normalize_delegation_policy(stored))
        return policy

    async def set_delegation_policy(self, policy: dict) -> dict:
        """Store a normalized delegation policy and return it."""
        clean = normalize_delegation_policy(policy)
        await self.db.execute(
            "UPDATE app_settings SET delegation_policy = ?, updated_at = ? WHERE id = 1",
            (json.dumps(clean), datetime.utcnow().isoformat()),
        )
        return clean

    async def _ensure_remote_access_column(self) -> None:
        """Add ``app_settings.remote_access`` when missing (idempotent)."""
        try:
            rows = await self.db.fetch_all("PRAGMA table_info(app_settings)")
        except Exception:  # noqa: BLE001 - no table: nothing to add to
            return
        cols = {dict(r)["name"] for r in rows or []}
        if cols and "remote_access" not in cols:
            await self.db.execute("ALTER TABLE app_settings ADD COLUMN remote_access TEXT")

    async def get_remote_access(self) -> dict:
        """Remote access mode state as stored (a dict, {} when unset). The
        token is kept only as a salted hash; see server/remote_access.py."""
        try:
            row = await self.db.fetch_one("SELECT remote_access FROM app_settings WHERE id = 1")
        except Exception:  # column absent before the remote access step
            return {}
        raw = dict(row).get("remote_access") if row else None
        if not raw:
            return {}
        try:
            stored = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return {}
        return stored if isinstance(stored, dict) else {}

    async def set_remote_access(self, state: dict) -> dict:
        """Store the remote access mode state (a JSON object) and return it."""
        await self._ensure_remote_access_column()
        cur = await self.db.execute(
            "UPDATE app_settings SET remote_access = ?, updated_at = ? WHERE id = 1",
            (json.dumps(state, sort_keys=True), datetime.utcnow().isoformat()),
        )
        if getattr(cur, "rowcount", 1) == 0:
            # No settings row: nothing was stored, so the caller must not
            # report (or cache) the new state.
            raise RuntimeError("Settings are not initialised; remote access was not changed")
        return dict(state)

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
