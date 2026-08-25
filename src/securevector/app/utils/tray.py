"""System tray helper for the SecureVector desktop shell.

Tray is implemented on macOS and Windows via pystray. Linux keeps the
existing close-exits behavior. Import of pystray/PIL is lazy so --web
and pip-only installs without the extra still run.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger(__name__)

_icon = None
_quit_requested = False
_quit_lock = threading.Lock()


def tray_supported() -> bool:
    """True on the platforms we ship a tray for (Mac + Windows)."""
    return sys.platform in ("win32", "darwin")


def quit_requested() -> bool:
    return _quit_requested


def request_quit() -> None:
    """Stop the tray icon (best-effort) and hard-exit.

    ``os._exit`` is the Cmd+Q hang fix (PR #72): pywebview's Cocoa loop
    otherwise waits on the daemon uvicorn thread.
    """
    global _quit_requested, _icon
    with _quit_lock:
        _quit_requested = True
    icon = _icon
    if icon is not None:
        try:
            icon.stop()
        except Exception:
            pass
    os._exit(0)


def _resolve_icon_path(assets_path: Path) -> Optional[Path]:
    candidates = [
        assets_path / "favicon.png",
        assets_path / "favicon.ico",
    ]
    if getattr(sys, "frozen", False):
        meipass = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
        exe_dir = Path(sys.executable).parent
        candidates.extend(
            [
                meipass / "securevector" / "app" / "assets" / "favicon.png",
                meipass / "securevector" / "app" / "assets" / "favicon.ico",
                meipass / "assets" / "favicon.png",
                exe_dir / "assets" / "favicon.png",
                exe_dir / "assets" / "favicon.ico",
            ]
        )
    for path in candidates:
        if path.exists():
            return path
    return None


def start_tray(*, assets_path: Path, on_show: Callable[[], None]) -> bool:
    """Start a background tray icon. Returns False if tray cannot be used."""
    if not tray_supported():
        return False

    try:
        import pystray
        from PIL import Image
    except ImportError:
        logger.warning("pystray/PIL not installed; system tray disabled")
        return False

    icon_path = _resolve_icon_path(assets_path)
    if icon_path is None:
        logger.warning("No tray icon found under %s; system tray disabled", assets_path)
        return False

    try:
        image = Image.open(icon_path)
        image.load()
    except Exception:
        logger.exception("Failed to load tray icon from %s", icon_path)
        return False

    def _show(icon=None, item=None) -> None:  # noqa: ARG001
        try:
            on_show()
        except Exception:
            logger.exception("Failed to show window from tray")

    def _quit(icon=None, item=None) -> None:  # noqa: ARG001
        request_quit()

    menu = pystray.Menu(
        pystray.MenuItem("Show SecureVector", _show, default=True),
        pystray.MenuItem("Quit", _quit),
    )
    icon = pystray.Icon("SecureVector", image, "SecureVector", menu)

    global _icon
    _icon = icon

    try:
        if hasattr(icon, "run_detached"):
            icon.run_detached()
        else:
            thread = threading.Thread(target=icon.run, name="sv-tray", daemon=True)
            thread.start()
    except Exception:
        logger.exception("Failed to start system tray")
        _icon = None
        return False

    logger.info("System tray started")
    return True
