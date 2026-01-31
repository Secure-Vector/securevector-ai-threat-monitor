"""
Main entry point for the SecureVector Local Threat Monitor Desktop Application.

Usage:
    securevector-app [OPTIONS]

Options:
    --port PORT       API server port (default: 8741)
    --host HOST       API server host (default: 127.0.0.1)
    --no-tray         Don't minimize to system tray on close
    --debug           Enable debug logging
    --version         Show version and exit
"""

import argparse
import asyncio
import logging
import sys
import threading
from typing import Optional

import flet as ft

from securevector.app import (
    __app_name__,
    __version__,
    check_app_dependencies,
    AppDependencyError,
)
from securevector.app.database.connection import init_database, close_database, get_database
from securevector.app.database.migrations import init_database_schema
from securevector.app.database.repositories.settings import SettingsRepository
from securevector.app.ui.theme import (
    DARK_THEME,
    LIGHT_THEME,
    get_theme,
    create_flet_theme,
    get_flet_theme_mode,
)
from securevector.app.utils.platform import (
    ensure_app_directories,
    enable_autostart,
    disable_autostart,
    is_autostart_enabled,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


class SecureVectorApp:
    """
    Main application class for SecureVector Local Threat Monitor.

    Manages:
    - Flet UI window
    - Embedded FastAPI server
    - Database lifecycle
    - Theme management
    """

    def __init__(
        self,
        port: int = 8741,
        host: str = "127.0.0.1",
        use_tray: bool = True,
        debug: bool = False,
    ):
        """
        Initialize the application.

        Args:
            port: API server port.
            host: API server host.
            use_tray: Whether to use system tray.
            debug: Enable debug mode.
        """
        self.port = port
        self.host = host
        self.use_tray = use_tray
        self.debug = debug

        self.page: Optional[ft.Page] = None
        self.server_thread: Optional[threading.Thread] = None
        self._current_theme = "system"

    async def initialize(self) -> None:
        """Initialize database and load settings."""
        logger.info("Initializing application...")

        # Ensure directories exist
        paths = ensure_app_directories()
        logger.info(f"Data directory: {paths['data_dir']}")

        # Initialize database
        db = await init_database()
        await init_database_schema(db)

        # Load settings
        settings_repo = SettingsRepository(db)
        settings = await settings_repo.get()
        self._current_theme = settings.theme

        logger.info("Application initialized")

    async def cleanup(self) -> None:
        """Cleanup resources on shutdown."""
        logger.info("Cleaning up...")
        await close_database()
        logger.info("Cleanup complete")

    def start_server(self) -> None:
        """Start the embedded API server in a background thread."""
        # Import here to avoid circular imports
        from securevector.app.server.app import create_app

        import uvicorn

        app = create_app()

        config = uvicorn.Config(
            app,
            host=self.host,
            port=self.port,
            log_level="debug" if self.debug else "info",
        )
        server = uvicorn.Server(config)

        def run_server():
            asyncio.run(server.serve())

        self.server_thread = threading.Thread(target=run_server, daemon=True)
        self.server_thread.start()
        logger.info(f"API server started at http://{self.host}:{self.port}")

    def build_ui(self, page: ft.Page) -> None:
        """
        Build the main UI.

        Args:
            page: Flet page instance.
        """
        self.page = page

        # Configure window
        page.title = __app_name__
        page.window.width = 1200
        page.window.height = 800
        page.window.min_width = 900
        page.window.min_height = 600

        # Set theme
        page.theme_mode = get_flet_theme_mode(self._current_theme)
        page.theme = create_flet_theme(LIGHT_THEME)
        page.dark_theme = create_flet_theme(DARK_THEME)

        # Build navigation rail
        nav_rail = ft.NavigationRail(
            selected_index=0,
            label_type=ft.NavigationRailLabelType.ALL,
            min_width=100,
            min_extended_width=200,
            destinations=[
                ft.NavigationRailDestination(
                    icon=ft.Icons.DASHBOARD_OUTLINED,
                    selected_icon=ft.Icons.DASHBOARD,
                    label="Dashboard",
                ),
                ft.NavigationRailDestination(
                    icon=ft.Icons.SECURITY_OUTLINED,
                    selected_icon=ft.Icons.SECURITY,
                    label="Threat Intel",
                ),
                ft.NavigationRailDestination(
                    icon=ft.Icons.RULE_OUTLINED,
                    selected_icon=ft.Icons.RULE,
                    label="Rules",
                ),
                ft.NavigationRailDestination(
                    icon=ft.Icons.SETTINGS_OUTLINED,
                    selected_icon=ft.Icons.SETTINGS,
                    label="Settings",
                ),
            ],
            on_change=self._on_nav_change,
        )

        # Content area
        self.content_area = ft.Container(
            content=self._build_dashboard(),
            expand=True,
            padding=20,
        )

        # Header with server status
        header = ft.Container(
            content=ft.Row(
                [
                    ft.Icon(ft.Icons.SHIELD, color=DARK_THEME.accent_primary, size=24),
                    ft.Text(
                        __app_name__,
                        size=18,
                        weight=ft.FontWeight.BOLD,
                    ),
                    ft.Container(expand=True),
                    ft.Container(
                        content=ft.Row(
                            [
                                ft.Icon(ft.Icons.CIRCLE, color="#10b981", size=10),
                                ft.Text(
                                    f"Server: {self.host}:{self.port}",
                                    size=12,
                                ),
                            ],
                            spacing=5,
                        ),
                        padding=ft.padding.only(right=10),
                    ),
                    ft.IconButton(
                        icon=ft.Icons.DARK_MODE if self._current_theme != "dark" else ft.Icons.LIGHT_MODE,
                        tooltip="Toggle theme",
                        on_click=self._toggle_theme,
                    ),
                ],
                alignment=ft.MainAxisAlignment.START,
            ),
            padding=ft.padding.symmetric(horizontal=20, vertical=10),
            border=ft.border.only(bottom=ft.BorderSide(1, "#e2e8f0")),
        )

        # Main layout
        page.add(
            ft.Column(
                [
                    header,
                    ft.Row(
                        [
                            nav_rail,
                            ft.VerticalDivider(width=1),
                            self.content_area,
                        ],
                        expand=True,
                    ),
                ],
                expand=True,
                spacing=0,
            )
        )

    def _build_dashboard(self) -> ft.Control:
        """Build the dashboard page."""
        # Check cloud mode state
        cloud_mode_enabled = False
        try:
            db = get_database()
            settings_repo = SettingsRepository(db)
            import asyncio

            loop = asyncio.new_event_loop()
            settings = loop.run_until_complete(settings_repo.get())
            loop.close()
            cloud_mode_enabled = settings.cloud_mode_enabled
        except Exception:
            pass

        # Cloud mode indicator
        cloud_indicator = ft.Container(
            content=ft.Row(
                [
                    ft.Icon(ft.Icons.CLOUD, color="#3b82f6", size=16),
                    ft.Text("Cloud Mode Active", size=12, color="#3b82f6"),
                ],
                spacing=5,
            ),
            padding=ft.padding.symmetric(horizontal=10, vertical=5),
            border=ft.border.all(1, "#3b82f6"),
            border_radius=15,
            visible=cloud_mode_enabled,
        )

        return ft.Column(
            [
                ft.Row(
                    [
                        ft.Text("Dashboard", size=24, weight=ft.FontWeight.BOLD),
                        ft.Container(expand=True),
                        cloud_indicator,
                    ],
                    alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
                ),
                ft.Text("Welcome to SecureVector Local Threat Monitor", size=14),
                ft.Divider(height=20),
                ft.Row(
                    [
                        self._stat_card("Total Analyses", "0", ft.Icons.ANALYTICS),
                        self._stat_card("Threats Detected", "0", ft.Icons.WARNING, color="#ef4444"),
                        self._stat_card("Detection Rate", "0%", ft.Icons.PERCENT),
                        self._stat_card("Avg Response", "0ms", ft.Icons.TIMER),
                    ],
                    wrap=True,
                    spacing=20,
                ),
                ft.Divider(height=20),
                ft.Text("Recent Activity", size=18, weight=ft.FontWeight.W_500),
                ft.Container(
                    content=ft.Text(
                        "No activity yet. Connect an agent to start monitoring.",
                        italic=True,
                    ),
                    padding=20,
                    border=ft.border.all(1, "#e2e8f0"),
                    border_radius=8,
                ),
            ],
            spacing=10,
        )

    def _stat_card(
        self,
        label: str,
        value: str,
        icon: str,
        color: str = "#3b82f6",
    ) -> ft.Container:
        """Build a statistics card widget."""
        return ft.Container(
            content=ft.Column(
                [
                    ft.Row(
                        [
                            ft.Icon(icon, color=color, size=20),
                            ft.Text(label, size=12, color="#64748b"),
                        ],
                        spacing=8,
                    ),
                    ft.Text(value, size=28, weight=ft.FontWeight.BOLD),
                ],
                spacing=5,
            ),
            padding=20,
            border=ft.border.all(1, "#e2e8f0"),
            border_radius=8,
            width=200,
        )

    def _on_nav_change(self, e: ft.ControlEvent) -> None:
        """Handle navigation rail selection change."""
        index = e.control.selected_index
        pages = [
            self._build_dashboard,
            self._build_threat_intel,
            self._build_rules,
            self._build_settings,
        ]
        self.content_area.content = pages[index]()
        self.page.update()

    def _build_threat_intel(self) -> ft.Control:
        """Build the threat intel page (placeholder)."""
        return ft.Column(
            [
                ft.Text("Threat Intel", size=24, weight=ft.FontWeight.BOLD),
                ft.Text("Historical analysis data and threat feed", size=14),
                ft.Divider(height=20),
                ft.Text("Coming soon...", italic=True),
            ],
            spacing=10,
        )

    def _build_rules(self) -> ft.Control:
        """Build the rules page (placeholder)."""
        return ft.Column(
            [
                ft.Text("Detection Rules", size=24, weight=ft.FontWeight.BOLD),
                ft.Text("Browse and manage detection rules", size=14),
                ft.Divider(height=20),
                ft.Text("Coming soon...", italic=True),
            ],
            spacing=10,
        )

    def _build_settings(self) -> ft.Control:
        """Build the settings page with autostart toggle and cloud mode."""
        # Check current autostart state
        autostart_enabled = is_autostart_enabled()

        # Check cloud mode state
        from securevector.app.services.credentials import credentials_configured

        cloud_credentials_configured = credentials_configured()

        # Get cloud settings from database
        cloud_mode_enabled = False
        cloud_user_email = None
        try:
            db = get_database()
            settings_repo = SettingsRepository(db)
            # Run async in thread
            import asyncio

            loop = asyncio.new_event_loop()
            settings = loop.run_until_complete(settings_repo.get())
            loop.close()
            cloud_mode_enabled = settings.cloud_mode_enabled
            cloud_user_email = settings.cloud_user_email
        except Exception:
            pass


        def on_autostart_change(e):
            """Handle autostart toggle change."""
            if e.control.value:
                success = enable_autostart()
                if success:
                    self.page.snack_bar = ft.SnackBar(
                        content=ft.Text("SecureVector will start on login"),
                        bgcolor="#10b981",
                    )
                else:
                    e.control.value = False
                    self.page.snack_bar = ft.SnackBar(
                        content=ft.Text("Failed to enable autostart"),
                        bgcolor="#ef4444",
                    )
            else:
                success = disable_autostart()
                if success:
                    self.page.snack_bar = ft.SnackBar(
                        content=ft.Text("Autostart disabled"),
                        bgcolor="#6b7280",
                    )
                else:
                    e.control.value = True
                    self.page.snack_bar = ft.SnackBar(
                        content=ft.Text("Failed to disable autostart"),
                        bgcolor="#ef4444",
                    )
            self.page.snack_bar.open = True
            self.page.update()

        # Build cloud section based on state
        if cloud_credentials_configured:
            # Show connected state with cloud mode toggle
            cloud_section = ft.Container(
                content=ft.Column(
                    [
                        ft.Row(
                            [
                                ft.Icon(ft.Icons.CLOUD_DONE, color="#10b981", size=20),
                                ft.Text(
                                    f"Connected as {cloud_user_email or 'Unknown'}",
                                    weight=ft.FontWeight.W_500,
                                ),
                                ft.Container(expand=True),
                                ft.TextButton(
                                    "Disconnect",
                                    on_click=lambda _: self._disconnect_cloud(),
                                ),
                            ],
                        ),
                        ft.Divider(height=10),
                        ft.Row(
                            [
                                ft.Column(
                                    [
                                        ft.Text("Cloud Mode", weight=ft.FontWeight.W_500),
                                        ft.Text(
                                            "Use cloud ML analysis instead of local pattern matching",
                                            size=12,
                                            color="#64748b",
                                        ),
                                    ],
                                    spacing=2,
                                    expand=True,
                                ),
                                ft.Switch(
                                    value=cloud_mode_enabled,
                                    on_change=lambda e: self._toggle_cloud_mode(e),
                                ),
                            ],
                            alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
                        ),
                        ft.Container(
                            content=ft.Text(
                                "When enabled, analyzed text is sent to SecureVector cloud for ML analysis.",
                                size=11,
                                color="#f59e0b",
                                italic=True,
                            ),
                            visible=cloud_mode_enabled,
                        ),
                    ],
                    spacing=5,
                ),
                padding=15,
                border=ft.border.all(1, "#10b981" if cloud_mode_enabled else "#e2e8f0"),
                border_radius=8,
            )
        else:
            # Show connect to cloud option
            cloud_section = ft.Container(
                content=ft.Column(
                    [
                        ft.Row(
                            [
                                ft.Icon(ft.Icons.CLOUD_OFF, color="#64748b", size=20),
                                ft.Text("Not connected", color="#64748b"),
                            ],
                            spacing=8,
                        ),
                        ft.Text(
                            "Connect to SecureVector Cloud for ML-powered threat analysis",
                            size=12,
                            color="#64748b",
                        ),
                        ft.Container(height=10),
                        ft.Row(
                            [
                                ft.ElevatedButton(
                                    "Connect to Cloud",
                                    icon=ft.Icons.CLOUD,
                                    on_click=lambda _: self._show_cloud_connect_dialog(),
                                ),
                                ft.TextButton(
                                    "Get credentials",
                                    icon=ft.Icons.OPEN_IN_NEW,
                                    url="https://app.securevector.io",
                                ),
                            ],
                            spacing=10,
                        ),
                    ],
                    spacing=5,
                ),
                padding=15,
                border=ft.border.all(1, "#e2e8f0"),
                border_radius=8,
            )

        return ft.Column(
            [
                ft.Text("Settings", size=24, weight=ft.FontWeight.BOLD),
                ft.Text("Configure application preferences", size=14),
                ft.Divider(height=20),
                # Cloud section
                ft.Text("Cloud Mode", size=18, weight=ft.FontWeight.W_500),
                cloud_section,
                ft.Container(height=10),
                # Startup section
                ft.Text("Startup", size=18, weight=ft.FontWeight.W_500),
                ft.Container(
                    content=ft.Row(
                        [
                            ft.Column(
                                [
                                    ft.Text("Start on login", weight=ft.FontWeight.W_500),
                                    ft.Text(
                                        "Automatically start SecureVector when you log in",
                                        size=12,
                                        color="#64748b",
                                    ),
                                ],
                                spacing=2,
                                expand=True,
                            ),
                            ft.Switch(
                                value=autostart_enabled,
                                on_change=on_autostart_change,
                            ),
                        ],
                        alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
                    ),
                    padding=15,
                    border=ft.border.all(1, "#e2e8f0"),
                    border_radius=8,
                ),
                ft.Container(height=10),
                # Server section
                ft.Text("Server", size=18, weight=ft.FontWeight.W_500),
                ft.Container(
                    content=ft.Column(
                        [
                            ft.Row(
                                [
                                    ft.Text("API Server", weight=ft.FontWeight.W_500),
                                    ft.Container(expand=True),
                                    ft.Container(
                                        content=ft.Row(
                                            [
                                                ft.Icon(ft.Icons.CIRCLE, color="#10b981", size=10),
                                                ft.Text(f"Running on {self.host}:{self.port}", size=12),
                                            ],
                                            spacing=5,
                                        ),
                                    ),
                                ],
                            ),
                            ft.Text(
                                "The local API server accepts connections from your AI agents",
                                size=12,
                                color="#64748b",
                            ),
                        ],
                        spacing=5,
                    ),
                    padding=15,
                    border=ft.border.all(1, "#e2e8f0"),
                    border_radius=8,
                ),
                ft.Container(height=10),
                # About section
                ft.Text("About", size=18, weight=ft.FontWeight.W_500),
                ft.Container(
                    content=ft.Column(
                        [
                            ft.Row(
                                [
                                    ft.Text("Version", weight=ft.FontWeight.W_500),
                                    ft.Container(expand=True),
                                    ft.Text(__version__, size=12),
                                ],
                            ),
                            ft.Divider(height=10),
                            ft.Row(
                                [
                                    ft.TextButton(
                                        "GitHub",
                                        icon=ft.Icons.CODE,
                                        url="https://github.com/Secure-Vector/securevector-ai-threat-monitor",
                                    ),
                                    ft.TextButton(
                                        "Documentation",
                                        icon=ft.Icons.BOOK,
                                        url="https://securevector.io/docs",
                                    ),
                                ],
                            ),
                        ],
                        spacing=5,
                    ),
                    padding=15,
                    border=ft.border.all(1, "#e2e8f0"),
                    border_radius=8,
                ),
            ],
            spacing=10,
            scroll=ft.ScrollMode.AUTO,
        )

    def _show_cloud_connect_dialog(self) -> None:
        """Show dialog to enter cloud credentials."""
        api_key_field = ft.TextField(
            label="API Key",
            hint_text="Enter your API Key from app.securevector.io",
            password=True,
            can_reveal_password=True,
        )
        bearer_token_field = ft.TextField(
            label="Bearer Token",
            hint_text="Enter your Bearer Token from app.securevector.io",
            password=True,
            can_reveal_password=True,
        )
        status_text = ft.Text("", color="#ef4444", size=12)

        def close_dialog(e):
            dialog.open = False
            self.page.update()

        def save_credentials(e):
            api_key = api_key_field.value
            bearer_token = bearer_token_field.value

            if not api_key or not bearer_token:
                status_text.value = "Please enter both API Key and Bearer Token"
                self.page.update()
                return

            # Validate and save credentials via API
            import asyncio
            import httpx

            async def validate_and_save():
                try:
                    async with httpx.AsyncClient() as client:
                        response = await client.post(
                            f"http://{self.host}:{self.port}/api/v1/settings/cloud/credentials",
                            json={
                                "api_key": api_key,
                                "bearer_token": bearer_token,
                            },
                            timeout=10.0,
                        )
                        return response.json()
                except Exception as ex:
                    return {"valid": False, "message": str(ex)}

            loop = asyncio.new_event_loop()
            result = loop.run_until_complete(validate_and_save())
            loop.close()

            if result.get("valid"):
                dialog.open = False
                self.page.snack_bar = ft.SnackBar(
                    content=ft.Text(f"Connected as {result.get('user_email', 'Unknown')}"),
                    bgcolor="#10b981",
                )
                self.page.snack_bar.open = True
                # Refresh settings page
                self.content_area.content = self._build_settings()
                self.page.update()
            else:
                status_text.value = result.get("message", "Invalid credentials")
                self.page.update()

        dialog = ft.AlertDialog(
            modal=True,
            title=ft.Text("Connect to SecureVector Cloud"),
            content=ft.Container(
                content=ft.Column(
                    [
                        ft.Text(
                            "Enter your credentials from app.securevector.io",
                            size=12,
                            color="#64748b",
                        ),
                        ft.Container(height=10),
                        api_key_field,
                        bearer_token_field,
                        status_text,
                    ],
                    spacing=10,
                    tight=True,
                ),
                width=400,
            ),
            actions=[
                ft.TextButton("Cancel", on_click=close_dialog),
                ft.ElevatedButton("Connect", on_click=save_credentials),
            ],
            actions_alignment=ft.MainAxisAlignment.END,
        )

        self.page.overlay.append(dialog)
        dialog.open = True
        self.page.update()

    def _disconnect_cloud(self) -> None:
        """Disconnect from cloud and remove credentials."""
        import asyncio
        import httpx

        async def disconnect():
            try:
                async with httpx.AsyncClient() as client:
                    await client.delete(
                        f"http://{self.host}:{self.port}/api/v1/settings/cloud/credentials",
                        timeout=10.0,
                    )
            except Exception:
                pass

        loop = asyncio.new_event_loop()
        loop.run_until_complete(disconnect())
        loop.close()

        self.page.snack_bar = ft.SnackBar(
            content=ft.Text("Disconnected from cloud"),
            bgcolor="#6b7280",
        )
        self.page.snack_bar.open = True
        # Refresh settings page
        self.content_area.content = self._build_settings()
        self.page.update()

    def _toggle_cloud_mode(self, e: ft.ControlEvent) -> None:
        """Toggle cloud mode on/off."""
        import asyncio
        import httpx

        enabled = e.control.value

        async def toggle():
            try:
                async with httpx.AsyncClient() as client:
                    response = await client.put(
                        f"http://{self.host}:{self.port}/api/v1/settings/cloud/mode",
                        json={"enabled": enabled},
                        timeout=10.0,
                    )
                    return response.json()
            except Exception as ex:
                return {"error": str(ex)}

        loop = asyncio.new_event_loop()
        result = loop.run_until_complete(toggle())
        loop.close()

        if "error" in result:
            e.control.value = not enabled
            self.page.snack_bar = ft.SnackBar(
                content=ft.Text(f"Failed to toggle cloud mode: {result.get('error')}"),
                bgcolor="#ef4444",
            )
        else:
            msg = "Cloud mode enabled" if enabled else "Cloud mode disabled"
            self.page.snack_bar = ft.SnackBar(
                content=ft.Text(msg),
                bgcolor="#10b981" if enabled else "#6b7280",
            )
            # Refresh settings page to update privacy warning visibility
            self.content_area.content = self._build_settings()

        self.page.snack_bar.open = True
        self.page.update()

    def _toggle_theme(self, e: ft.ControlEvent) -> None:
        """Toggle between light and dark theme."""
        if self.page.theme_mode == ft.ThemeMode.LIGHT:
            self.page.theme_mode = ft.ThemeMode.DARK
            self._current_theme = "dark"
        else:
            self.page.theme_mode = ft.ThemeMode.LIGHT
            self._current_theme = "light"
        self.page.update()


def flet_main(page: ft.Page) -> None:
    """
    Flet app main function.

    Args:
        page: Flet page instance.
    """
    # Get app instance from global
    app = _app_instance

    # Initialize async components
    async def init():
        await app.initialize()
        app.start_server()

    # Run initialization
    asyncio.run(init())

    # Build UI
    app.build_ui(page)


# Global app instance (set by main())
_app_instance: Optional[SecureVectorApp] = None


def main() -> None:
    """Main entry point for securevector-app command."""
    global _app_instance

    # Check dependencies first
    try:
        check_app_dependencies()
    except AppDependencyError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    # Parse arguments
    parser = argparse.ArgumentParser(
        description=__app_name__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8741,
        help="API server port (default: 8741)",
    )
    parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="API server host (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--no-tray",
        action="store_true",
        help="Don't minimize to system tray on close",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"{__app_name__} v{__version__}",
    )

    args = parser.parse_args()

    # Configure logging
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)
        logger.debug("Debug mode enabled")

    # Create app instance
    _app_instance = SecureVectorApp(
        port=args.port,
        host=args.host,
        use_tray=not args.no_tray,
        debug=args.debug,
    )

    logger.info(f"Starting {__app_name__} v{__version__}")

    # Run Flet app
    ft.app(target=flet_main)


if __name__ == "__main__":
    main()
