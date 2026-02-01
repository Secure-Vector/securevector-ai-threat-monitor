"""
SecureVector theme configuration for Flet.

Color palette extracted from secure-vector-app/tailwind.config.js
to ensure exact visual consistency between web and desktop apps.
"""

from dataclasses import dataclass
from typing import Optional

import flet as ft


@dataclass
class ColorPalette:
    """Color palette with shade variants."""

    shade_50: str
    shade_100: str
    shade_200: str
    shade_300: str
    shade_400: str
    shade_500: str
    shade_600: str
    shade_700: str
    shade_800: str
    shade_900: str

    @property
    def default(self) -> str:
        """Default shade (500)."""
        return self.shade_500

    @property
    def light(self) -> str:
        """Light shade (300)."""
        return self.shade_300

    @property
    def dark(self) -> str:
        """Dark shade (700)."""
        return self.shade_700


# =============================================================================
# SecureVector Color Palette (from secure-vector-app/tailwind.config.js)
# =============================================================================

# Primary colors (Slate-based)
PRIMARY = ColorPalette(
    shade_50="#f1f5f9",
    shade_100="#e2e8f0",
    shade_200="#cbd5e1",
    shade_300="#94a3b8",
    shade_400="#64748b",
    shade_500="#475569",
    shade_600="#334155",
    shade_700="#1e293b",
    shade_800="#0f172a",
    shade_900="#020617",
)

# Security colors (Blue-based) - brand accent
SECURITY = ColorPalette(
    shade_50="#eff6ff",
    shade_100="#dbeafe",
    shade_200="#bfdbfe",
    shade_300="#93c5fd",
    shade_400="#60a5fa",
    shade_500="#3b82f6",
    shade_600="#2563eb",
    shade_700="#1d4ed8",
    shade_800="#1e40af",
    shade_900="#1e3a8a",
)

# Status colors
SUCCESS_500 = "#10b981"
SUCCESS_600 = "#059669"

WARNING_500 = "#f59e0b"
WARNING_600 = "#d97706"

DANGER_500 = "#ef4444"
DANGER_600 = "#dc2626"


# =============================================================================
# Theme Definitions
# =============================================================================

@dataclass
class SecureVectorTheme:
    """Complete theme definition for SecureVector app."""

    # Mode
    name: str
    is_dark: bool

    # Background colors
    bg_primary: str
    bg_secondary: str
    bg_tertiary: str
    bg_card: str
    bg_hover: str

    # Text colors
    text_primary: str
    text_secondary: str
    text_muted: str

    # Border colors
    border_default: str
    border_light: str

    # Accent colors
    accent_primary: str
    accent_secondary: str

    # Status colors
    success: str
    warning: str
    danger: str

    # Special
    sidebar_bg: str
    header_bg: str


# Dark theme (matches secure-vector-app dark mode)
DARK_THEME = SecureVectorTheme(
    name="dark",
    is_dark=True,

    # Backgrounds
    bg_primary=PRIMARY.shade_900,      # #020617 - Main background
    bg_secondary=PRIMARY.shade_800,    # #0f172a - Secondary background
    bg_tertiary=PRIMARY.shade_700,     # #1e293b - Tertiary/elevated
    bg_card=PRIMARY.shade_800,         # #0f172a - Card background
    bg_hover=PRIMARY.shade_700,        # #1e293b - Hover state

    # Text
    text_primary="#ffffff",            # White text
    text_secondary=PRIMARY.shade_200,  # #cbd5e1 - Secondary text
    text_muted=PRIMARY.shade_400,      # #64748b - Muted text

    # Borders
    border_default=PRIMARY.shade_700,  # #1e293b
    border_light=PRIMARY.shade_600,    # #334155

    # Accent
    accent_primary=SECURITY.shade_500,   # #3b82f6 - Primary accent (blue)
    accent_secondary=SECURITY.shade_400, # #60a5fa - Secondary accent

    # Status
    success=SUCCESS_500,
    warning=WARNING_500,
    danger=DANGER_500,

    # Special areas
    sidebar_bg=PRIMARY.shade_900,      # #020617
    header_bg=PRIMARY.shade_800,       # #0f172a
)

# Light theme (matches secure-vector-app light mode)
LIGHT_THEME = SecureVectorTheme(
    name="light",
    is_dark=False,

    # Backgrounds
    bg_primary="#ffffff",              # White - Main background
    bg_secondary=PRIMARY.shade_50,     # #f1f5f9 - Secondary background
    bg_tertiary=PRIMARY.shade_100,     # #e2e8f0 - Tertiary/elevated
    bg_card="#ffffff",                 # White - Card background
    bg_hover=PRIMARY.shade_100,        # #e2e8f0 - Hover state

    # Text
    text_primary=PRIMARY.shade_900,    # #020617 - Primary text
    text_secondary=PRIMARY.shade_600,  # #334155 - Secondary text
    text_muted=PRIMARY.shade_400,      # #64748b - Muted text

    # Borders
    border_default=PRIMARY.shade_200,  # #cbd5e1
    border_light=PRIMARY.shade_100,    # #e2e8f0

    # Accent
    accent_primary=SECURITY.shade_600,   # #2563eb - Primary accent (blue)
    accent_secondary=SECURITY.shade_500, # #3b82f6 - Secondary accent

    # Status
    success=SUCCESS_600,
    warning=WARNING_600,
    danger=DANGER_600,

    # Special areas
    sidebar_bg=PRIMARY.shade_50,       # #f1f5f9
    header_bg="#ffffff",               # White
)


def get_theme(is_dark: bool) -> SecureVectorTheme:
    """
    Get the appropriate theme based on mode.

    Args:
        is_dark: Whether to use dark theme.

    Returns:
        SecureVectorTheme instance.
    """
    return DARK_THEME if is_dark else LIGHT_THEME


def create_flet_theme(sv_theme: SecureVectorTheme) -> ft.Theme:
    """
    Create a Flet Theme from SecureVector theme.

    Args:
        sv_theme: SecureVector theme definition.

    Returns:
        Configured Flet Theme.
    """
    return ft.Theme(
        color_scheme=ft.ColorScheme(
            primary=sv_theme.accent_primary,
            secondary=sv_theme.accent_secondary,
            surface=sv_theme.bg_card,
            background=sv_theme.bg_primary,
            error=sv_theme.danger,
            on_primary="#ffffff" if sv_theme.is_dark else "#ffffff",
            on_secondary="#ffffff" if sv_theme.is_dark else "#ffffff",
            on_surface=sv_theme.text_primary,
            on_background=sv_theme.text_primary,
            on_error="#ffffff",
        ),
        font_family="Inter",
    )


def get_flet_theme_mode(preference: str) -> ft.ThemeMode:
    """
    Convert theme preference string to Flet ThemeMode.

    Args:
        preference: Theme preference ('system', 'light', 'dark').

    Returns:
        Flet ThemeMode enum value.
    """
    if preference == "dark":
        return ft.ThemeMode.DARK
    elif preference == "light":
        return ft.ThemeMode.LIGHT
    else:
        return ft.ThemeMode.SYSTEM


# =============================================================================
# Severity Colors
# =============================================================================

SEVERITY_COLORS = {
    "critical": DANGER_500,
    "high": "#f97316",      # Orange-500
    "medium": WARNING_500,
    "low": SECURITY.shade_400,
}


def get_severity_color(severity: str) -> str:
    """
    Get color for severity level.

    Args:
        severity: Severity level string.

    Returns:
        Hex color string.
    """
    return SEVERITY_COLORS.get(severity.lower(), PRIMARY.shade_400)


# =============================================================================
# Risk Score Colors
# =============================================================================

def get_risk_color(score: int) -> str:
    """
    Get color for risk score.

    Args:
        score: Risk score (0-100).

    Returns:
        Hex color string.
    """
    if score >= 80:
        return DANGER_500
    elif score >= 60:
        return "#f97316"  # Orange
    elif score >= 40:
        return WARNING_500
    elif score >= 20:
        return SECURITY.shade_400
    else:
        return SUCCESS_500
