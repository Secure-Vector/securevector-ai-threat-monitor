"""
Desktop shell helpers for the native (pywebview) window.

Everything here is kept free of a live webview so it can be unit tested:

- single-instance lock file + activation ping (raise the existing window
  instead of opening a browser tab on a second launch)
- native menu bar built with ``webview.menu``
- WebView context-menu suppression
- window geometry persistence (size / position / maximized) validated
  against the current screens so a window never opens off-screen
"""

import json
import logging
import os
import subprocess
import sys
import threading
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

logger = logging.getLogger(__name__)

LOCK_FILENAME = "desktop.lock"
WINDOW_STATE_FILENAME = "window_state.json"
ACTIVATE_PATH = "/api/desktop/activate"
CHROME_PATH = "/api/desktop/chrome"
CHROME_THEME_PATH = "/api/desktop/chrome/theme"
DESKTOP_USER_AGENT_TOKEN = "SecureVectorDesktop"
DOCS_URL = "https://securevector.io/docs"
GITHUB_URL = "https://github.com/Secure-Vector/securevector-ai-threat-monitor"
GITHUB_ISSUES_URL = "https://github.com/Secure-Vector/securevector-ai-threat-monitor/issues/new"
DISCORD_URL = "https://discord.gg/k3bgZuCQBC"
CONTACT_EMAIL = "contact@securevector.io"

DEFAULT_WIDTH = 1200
DEFAULT_HEIGHT = 800
MIN_WIDTH = 800
MIN_HEIGHT = 600
# How much of the window must remain on a screen for a saved position to be
# reused. Enough to grab the title bar and drag it back.
MIN_VISIBLE_PX = 120

_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"})


def _app_data_dir() -> Path:
    from securevector.app.utils.platform import get_app_data_dir

    return get_app_data_dir()


# ---------------------------------------------------------------------------
# 1. Single-instance lock + activation
# ---------------------------------------------------------------------------


@dataclass
class LockInfo:
    pid: int
    port: int
    host: str = "127.0.0.1"


def lock_path(data_dir: Optional[Path] = None) -> Path:
    return (data_dir or _app_data_dir()) / LOCK_FILENAME


def write_lock(port: int, host: str = "127.0.0.1", data_dir: Optional[Path] = None, pid: Optional[int] = None) -> Path:
    path = lock_path(data_dir)
    payload = {"pid": pid if pid is not None else os.getpid(), "port": int(port), "host": host, "created": time.time()}
    tmp = path.with_suffix(".lock.tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    os.replace(tmp, path)
    return path


def read_lock(data_dir: Optional[Path] = None) -> Optional[LockInfo]:
    path = lock_path(data_dir)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return LockInfo(pid=int(data["pid"]), port=int(data["port"]), host=str(data.get("host") or "127.0.0.1"))
    except (OSError, ValueError, KeyError, TypeError):
        return None


def remove_lock(data_dir: Optional[Path] = None) -> None:
    try:
        lock_path(data_dir).unlink()
    except OSError:
        pass


INSTANCE_MUTEX_NAME = "SecureVectorDesktop"
_instance_mutex_handle: Any = None


def hold_instance_mutex(name: str = INSTANCE_MUTEX_NAME) -> bool:
    """Hold the named Windows mutex the installer checks (``AppMutex`` in the
    Inno Setup script) so an upgrade can tell the app is running. No-op and
    False on other platforms or when the handle cannot be created."""
    global _instance_mutex_handle
    if sys.platform != "win32":
        return False
    try:
        import ctypes

        handle = ctypes.windll.kernel32.CreateMutexW(None, False, name)  # type: ignore[attr-defined]
    except Exception:  # pragma: no cover - depends on the Windows API
        return False
    if not handle:
        return False
    _instance_mutex_handle = handle
    return True


def pid_alive(pid: int) -> bool:
    """Best-effort liveness probe. Unknown (e.g. permission denied) counts as alive."""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        try:
            import ctypes

            handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                return False
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
        except Exception:
            return True
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def ping_activate(port: int, host: str = "127.0.0.1", timeout: float = 1.5) -> bool:
    """POST the activation endpoint of a running instance. True iff it answered."""
    url = f"http://{host}:{port}{ACTIVATE_PATH}"
    headers = {"Content-Length": "0"}
    token = os.environ.get("SECUREVECTOR_INGRESS_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=b"", method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if getattr(resp, "status", 200) != 200:
                return False
            body = json.loads(resp.read(1024).decode("utf-8", "replace") or "{}")
            return bool(isinstance(body, dict) and body.get("activated"))
    except Exception:
        return False


def activate_running_instance(fallback_port: Optional[int] = None, data_dir: Optional[Path] = None) -> bool:
    """
    Try to raise an already-running desktop instance.

    Consults the lock file first (it knows the real port even after an
    auto-fallback), then ``fallback_port``. A lock whose process is gone or
    whose port does not answer is stale and removed so the caller can start
    normally.
    """
    ports: list[tuple[str, int]] = []
    info = read_lock(data_dir)
    if info is not None:
        if info.pid != os.getpid() and pid_alive(info.pid):
            ports.append((info.host, info.port))
        else:
            remove_lock(data_dir)
    if fallback_port and (("127.0.0.1", fallback_port) not in ports):
        ports.append(("127.0.0.1", fallback_port))

    for host, port in ports:
        if ping_activate(port, host):
            return True
    if info is not None and ports and ports[0] == (info.host, info.port):
        # Process alive but not answering: not our window (pid reuse) or an
        # older build without the endpoint. Treat as stale.
        remove_lock(data_dir)
    return False


def is_loopback(host: Optional[str]) -> bool:
    return bool(host) and host in _LOOPBACK_HOSTS


def install_activation_route(app: Any, activate: Callable[[], None]) -> None:
    """Register ``POST /api/desktop/activate`` (loopback only) on a FastAPI app."""
    from fastapi import Request
    from fastapi.responses import JSONResponse

    async def _activate(request: Request):
        client_host = request.client.host if request.client else None
        if not is_loopback(client_host):
            return JSONResponse({"error": "Forbidden"}, status_code=403)
        try:
            activate()
        except Exception as exc:  # never let a GUI hiccup 500 the caller
            logger.warning("Desktop activation failed: %s", exc)
            return JSONResponse({"activated": False}, status_code=503)
        return {"activated": True}

    app.add_api_route(ACTIVATE_PATH, _activate, methods=["POST"], include_in_schema=False)


# ---------------------------------------------------------------------------
# 4. Window geometry persistence
# ---------------------------------------------------------------------------


@dataclass
class WindowGeometry:
    x: Optional[int] = None
    y: Optional[int] = None
    width: int = DEFAULT_WIDTH
    height: int = DEFAULT_HEIGHT
    maximized: bool = False

    def to_dict(self) -> dict:
        return {"x": self.x, "y": self.y, "width": self.width, "height": self.height, "maximized": self.maximized}

    @classmethod
    def from_dict(cls, data: Any) -> "WindowGeometry":
        if not isinstance(data, dict):
            return cls()

        def _int(key: str, default: Optional[int]) -> Optional[int]:
            value = data.get(key, default)
            if value is None:
                return None
            try:
                return int(value)
            except (TypeError, ValueError):
                return default

        return cls(
            x=_int("x", None),
            y=_int("y", None),
            width=_int("width", DEFAULT_WIDTH) or DEFAULT_WIDTH,
            height=_int("height", DEFAULT_HEIGHT) or DEFAULT_HEIGHT,
            maximized=bool(data.get("maximized", False)),
        )


def window_state_path(data_dir: Optional[Path] = None) -> Path:
    return (data_dir or _app_data_dir()) / WINDOW_STATE_FILENAME


def load_window_geometry(data_dir: Optional[Path] = None) -> WindowGeometry:
    try:
        return WindowGeometry.from_dict(json.loads(window_state_path(data_dir).read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return WindowGeometry()


def save_window_geometry(geometry: WindowGeometry, data_dir: Optional[Path] = None) -> None:
    path = window_state_path(data_dir)
    tmp = path.with_suffix(".json.tmp")
    try:
        tmp.write_text(json.dumps(geometry.to_dict()), encoding="utf-8")
        os.replace(tmp, path)
    except OSError as exc:
        logger.debug("Could not save window state: %s", exc)


def validate_geometry(geometry: WindowGeometry, screens: Iterable[Any]) -> WindowGeometry:
    """
    Clamp a saved rectangle to the current screens.

    Size is clamped to the minimum and to the largest screen. The position
    is kept only if at least ``MIN_VISIBLE_PX`` of the window (including
    its top edge, where the title bar lives) sits on some screen; otherwise
    x/y are dropped so pywebview centers the window on the primary screen.
    ``screens`` are objects with ``x``, ``y``, ``width``, ``height``.
    """
    rects = [(int(s.x), int(s.y), int(s.width), int(s.height)) for s in screens if s is not None]
    result = WindowGeometry(maximized=geometry.maximized)

    width = max(MIN_WIDTH, int(geometry.width or DEFAULT_WIDTH))
    height = max(MIN_HEIGHT, int(geometry.height or DEFAULT_HEIGHT))
    if rects:
        width = min(width, max(r[2] for r in rects))
        height = min(height, max(r[3] for r in rects))
    result.width, result.height = width, height

    if geometry.x is None or geometry.y is None or not rects:
        return result

    x, y = int(geometry.x), int(geometry.y)
    for sx, sy, sw, sh in rects:
        visible_w = min(x + width, sx + sw) - max(x, sx)
        visible_h = min(y + height, sy + sh) - max(y, sy)
        top_on_screen = sy <= y < sy + sh
        if visible_w >= MIN_VISIBLE_PX and visible_h >= MIN_VISIBLE_PX and top_on_screen:
            result.x, result.y = x, y
            return result
    return result


class WindowStateTracker:
    """Collects geometry from pywebview window events and persists it (debounced)."""

    def __init__(self, initial: WindowGeometry, data_dir: Optional[Path] = None, debounce: float = 0.4):
        self.geometry = WindowGeometry(**initial.to_dict())
        self._data_dir = data_dir
        self._debounce = debounce
        self._timer: Optional[threading.Timer] = None
        self._lock = threading.Lock()

    # --- event handlers (signatures match pywebview 6.x events) ---
    def on_resized(self, width: int, height: int) -> None:
        if not self.geometry.maximized:
            self.geometry.width, self.geometry.height = int(width), int(height)
        self._schedule()

    def on_moved(self, x: int, y: int) -> None:
        if not self.geometry.maximized:
            self.geometry.x, self.geometry.y = int(x), int(y)
        self._schedule()

    def on_maximized(self) -> None:
        self.geometry.maximized = True
        self._schedule()

    def on_restored(self) -> None:
        self.geometry.maximized = False
        self._schedule()

    def attach(self, window: Any) -> None:
        window.events.resized += self.on_resized
        window.events.moved += self.on_moved
        window.events.maximized += self.on_maximized
        window.events.restored += self.on_restored

    # --- persistence ---
    def _schedule(self) -> None:
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(self._debounce, self.flush)
            self._timer.daemon = True
            self._timer.start()

    def flush(self) -> None:
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
        try:
            save_window_geometry(self.geometry, self._data_dir)
        except Exception as exc:
            logger.debug("Window state flush failed: %s", exc)


def restore_geometry(data_dir: Optional[Path] = None) -> WindowGeometry:
    """Saved geometry validated against ``webview.screens`` (falls back to defaults)."""
    saved = load_window_geometry(data_dir)
    try:
        import webview

        screens = list(webview.screens)
    except Exception as exc:
        logger.debug("Could not enumerate screens: %s", exc)
        screens = []
    return validate_geometry(saved, screens)


# ---------------------------------------------------------------------------
# 3. Context menu suppression
# ---------------------------------------------------------------------------

# Context-menu suppression lives in the page (desktop-chrome.js), gated on the
# desktop user agent and the ``context_menu`` flag from the chrome route. The
# page's Content Security Policy has no ``unsafe-eval``, and pywebview's
# ``evaluate_js`` wraps every script in ``eval``, so nothing pushed from
# Python that way ever runs.


# ---------------------------------------------------------------------------
# 2. Native menu bar
# ---------------------------------------------------------------------------

ZOOM_STEPS = (0.67, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0)


def open_path_in_file_manager(path: Path) -> None:
    path_str = str(path)
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", path_str])
        elif sys.platform == "win32":
            os.startfile(path_str)  # type: ignore[attr-defined]
        else:
            subprocess.Popen(["xdg-open", path_str])
    except Exception as exc:
        logger.warning("Could not open %s: %s", path_str, exc)


class DesktopMenu:
    """Builds the ``webview.menu`` tree for the main window."""

    def __init__(self, window: Any, app_url: str, version: str, debug: bool = False):
        self.window = window
        self.app_url = app_url
        self.version = version
        self.debug = debug
        self._zoom_index = ZOOM_STEPS.index(1.0)

    # --- actions ---
    def quit(self) -> None:
        self.window.destroy()

    def _exec(self, command: str) -> None:
        self.window.evaluate_js(f"document.execCommand('{command}')")

    def undo(self) -> None:
        self._exec("undo")

    def redo(self) -> None:
        self._exec("redo")

    def cut(self) -> None:
        self._exec("cut")

    def copy(self) -> None:
        self._exec("copy")

    def paste(self) -> None:
        self._exec("paste")

    def select_all(self) -> None:
        self._exec("selectAll")

    def reload(self) -> None:
        self.window.load_url(self.app_url)

    def _apply_zoom(self) -> None:
        level = ZOOM_STEPS[self._zoom_index]
        self.window.evaluate_js(f"document.body.style.zoom='{level}'")

    def zoom_in(self) -> None:
        self._zoom_index = min(self._zoom_index + 1, len(ZOOM_STEPS) - 1)
        self._apply_zoom()

    def zoom_out(self) -> None:
        self._zoom_index = max(self._zoom_index - 1, 0)
        self._apply_zoom()

    def actual_size(self) -> None:
        self._zoom_index = ZOOM_STEPS.index(1.0)
        self._apply_zoom()

    def minimize(self) -> None:
        self.window.minimize()

    def _open(self, url: str) -> None:
        import webbrowser

        webbrowser.open(url)

    def documentation(self) -> None:
        self._open(DOCS_URL)

    def star_on_github(self) -> None:
        self._open(GITHUB_URL)

    def join_discord(self) -> None:
        self._open(DISCORD_URL)

    def report_issue(self) -> None:
        self._open(issue_url(self.version))

    def email_feedback(self) -> None:
        self._open(mail_url(self.version))

    def open_logs(self) -> None:
        from securevector.app.utils.platform import get_log_dir

        open_path_in_file_manager(get_log_dir())

    def about(self) -> None:
        self.window.create_confirmation_dialog(
            "About SecureVector",
            f"SecureVector v{self.version}\nSecurity & Observability for AI Agents\n{DOCS_URL}",
        )

    # --- tree ---
    def build(self) -> list:
        from webview.menu import Menu, MenuAction, MenuSeparator

        native_edit_menu = sys.platform == "darwin"  # pywebview adds a native Edit + View menu on macOS

        view_items = [
            MenuAction("Reload", self.reload),
            MenuSeparator(),
            MenuAction("Zoom In", self.zoom_in),
            MenuAction("Zoom Out", self.zoom_out),
            MenuAction("Actual Size", self.actual_size),
        ]
        menus = [Menu("File", [MenuAction("Quit SecureVector", self.quit)])]
        if not native_edit_menu:
            menus.append(
                Menu(
                    "Edit",
                    [
                        MenuAction("Undo", self.undo),
                        MenuAction("Redo", self.redo),
                        MenuSeparator(),
                        MenuAction("Cut", self.cut),
                        MenuAction("Copy", self.copy),
                        MenuAction("Paste", self.paste),
                        MenuSeparator(),
                        MenuAction("Select All", self.select_all),
                    ],
                )
            )
        if native_edit_menu:
            # macOS already shows pywebview's "View" (Enter Full Screen); avoid a
            # second menu with the same title by folding these into Window.
            menus.append(Menu("Window", [MenuAction("Minimize", self.minimize), MenuSeparator(), *view_items]))
        else:
            menus.append(Menu("View", view_items))
            menus.append(Menu("Window", [MenuAction("Minimize", self.minimize)]))
        menus.append(
            Menu(
                "Help",
                [
                    MenuAction("Documentation", self.documentation),
                    MenuAction("Open Logs", self.open_logs),
                    MenuSeparator(),
                    MenuAction("Star SecureVector on GitHub", self.star_on_github),
                    MenuAction("Join the Discord", self.join_discord),
                    MenuAction("Report an Issue", self.report_issue),
                    MenuAction("Email Feedback", self.email_feedback),
                    MenuSeparator(),
                    MenuAction("About SecureVector", self.about),
                ],
            )
        )
        return menus


def issue_url(version: str) -> str:
    """Prefilled bug report: version, platform and install method land in the form fields."""
    from urllib.parse import urlencode

    os_name = {"darwin": "macOS", "win32": "Windows"}.get(sys.platform, "Linux")
    install = {"darwin": "macOS installer (.dmg)", "win32": "Windows installer (.exe)"}.get(sys.platform, "Linux AppImage")
    query = urlencode({"template": "bug_report.yml", "version": version, "os": os_name, "install_method": install})
    return f"{GITHUB_ISSUES_URL}?{query}"


def mail_url(version: str) -> str:
    """mailto for the public contact alias; the subject carries version and platform."""
    from urllib.parse import quote

    os_name = {"darwin": "macOS", "win32": "Windows"}.get(sys.platform, "Linux")
    return f"mailto:{CONTACT_EMAIL}?subject={quote(f'SecureVector feedback (v{version}, {os_name})')}"


def build_menu(window: Any, app_url: str, version: str, debug: bool = False) -> list:
    return DesktopMenu(window, app_url, version, debug).build()


# ---------------------------------------------------------------------------
# Activation callback used by the route
# ---------------------------------------------------------------------------


def make_activate_callback(window: Any) -> Callable[[], None]:
    """Un-minimize and bring the window to front. pywebview dispatches to the GUI thread."""

    def _activate() -> None:
        try:
            window.restore()
        except Exception as exc:
            logger.debug("restore() failed: %s", exc)
        window.show()

    return _activate


# ---------------------------------------------------------------------------
# Window chrome: unified title bar, theme-aware appearance, menu order
# ---------------------------------------------------------------------------

#: Rail background per theme id, mirroring ``--bg-secondary`` in styles.css.
#: The native window paints this behind the web view so the title strip, the
#: resize edge and the first paint all match the active theme. Second value
#: is the system appearance the title-bar controls should use.
CHROME_THEMES: dict = {
    "dark": ("#0e1218", "dark"),
    "black": ("#08090b", "dark"),
    "slate": ("#1b212c", "dark"),
    "azure": ("#0c1826", "dark"),
    "ember": ("#19120e", "dark"),
    "light": ("#f6f8fa", "light"),
}
DEFAULT_CHROME_THEME = "dark"

#: Menu bar order after the application menu. pywebview inserts its own Edit
#: and View menus at index 1, which pushes our File menu behind them.
MACOS_MENU_ORDER = ("File", "Edit", "View", "Window", "Help")

_NS_FULL_SIZE_CONTENT_VIEW = 1 << 15  # NSWindowStyleMaskFullSizeContentView
_NS_TITLE_HIDDEN = 1  # NSWindowTitleHidden
_NS_TOOLBAR_UNIFIED_COMPACT = 4  # NSWindowToolbarStyleUnifiedCompact (macOS 11+)
_DWMWA_USE_IMMERSIVE_DARK_MODE = 20
_DWMWA_CAPTION_COLOR = 35
_DWMWA_TEXT_COLOR = 36


def chrome_theme(theme_id: Any) -> tuple:
    """Return ``(hex_color, scheme)`` for a theme id; unknown ids fall back to dark."""
    key = str(theme_id or "").strip().lower()
    return CHROME_THEMES.get(key, CHROME_THEMES[DEFAULT_CHROME_THEME])


def menu_order(titles: Iterable[str]) -> list:
    """Reorder menu titles: app menu stays first, then File, Edit, View, Window, Help, then the rest."""
    titles = list(titles)
    if not titles:
        return []
    app_menu, rest = titles[0], titles[1:]
    known = [t for t in MACOS_MENU_ORDER if t in rest]
    extras = [t for t in rest if t not in MACOS_MENU_ORDER]
    return [app_menu, *known, *extras]


def _hex_to_rgb(color: str) -> tuple:
    value = color.lstrip("#")
    if len(value) != 6:
        value = "0e1218"
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def apply_unified_titlebar(window: Any) -> bool:
    """macOS: make the title bar transparent and run the web view under the traffic lights.

    Called from the ``before_show`` event, which pywebview fires on the main
    thread after the NSWindow exists and before it is ordered front. Returns
    True when the style was applied; a no-op elsewhere.
    """
    if sys.platform != "darwin":
        return False
    native = getattr(window, "native", None)
    if native is None:
        return False
    try:
        import AppKit

        native.setStyleMask_(native.styleMask() | _NS_FULL_SIZE_CONTENT_VIEW)
        native.setTitlebarAppearsTransparent_(True)
        native.setTitleVisibility_(_NS_TITLE_HIDDEN)
        # An empty toolbar gives the title strip the taller "unified" height
        # with the traffic lights vertically centred, the way Claude Desktop
        # and Codex Desktop present theirs.
        toolbar = AppKit.NSToolbar.alloc().initWithIdentifier_("securevector-chrome")
        toolbar.setShowsBaselineSeparator_(False)
        toolbar.setAllowsUserCustomization_(False)
        native.setToolbar_(toolbar)
        if hasattr(native, "setToolbarStyle_"):
            native.setToolbarStyle_(_NS_TOOLBAR_UNIFIED_COMPACT)
        return True
    except Exception as exc:  # pragma: no cover - depends on the Cocoa runtime
        logger.debug("unified title bar not applied: %s", exc)
        return False


_NS_VIEW_WIDTH_SIZABLE = 2
_strip_class: Any = None


def double_click_action(preference: Any) -> Optional[str]:
    """Map the macOS "double-click a window's title bar to" setting to an action.

    Values seen in the wild: Maximize (default), Fill (macOS 15), Minimize, None.
    """
    pref = str(preference or "Maximize").strip().lower()
    if pref == "minimize":
        return "minimize"
    if pref == "none":
        return None
    return "zoom"


def _titlebar_strip_class() -> Any:
    """Transparent NSView that gives the hidden title strip its gestures back.

    With the full-size content view the web view covers the title area, so
    the system never sees a drag or a double-click there. The strip sits
    above the web view over the inset only (the page keeps that band empty)
    and hands single clicks to the native window drag and double clicks to
    the user's title-bar preference. Built lazily: PyObjC classes can only
    be defined once and only where AppKit exists.
    """
    global _strip_class
    if _strip_class is not None:
        return _strip_class
    import AppKit

    class SecureVectorTitleStrip(AppKit.NSView):
        def acceptsFirstMouse_(self, event):  # noqa: N802 - ObjC selector
            return True

        def resizeWithOldSuperviewSize_(self, old_size):  # noqa: N802 - ObjC selector
            # Re-place on every resize instead of trusting the autoresizing
            # mask: the superview is the flipped WKWebView, where top is y=0.
            place_title_strip(self, getattr(self, "_sv_inset", 0) or 0)

        def mouseDown_(self, event):  # noqa: N802 - ObjC selector
            window = self.window()
            if window is None:
                return
            if event.clickCount() >= 2:
                pref = AppKit.NSUserDefaults.standardUserDefaults().stringForKey_("AppleActionOnDoubleClick")
                action = double_click_action(pref)
                if action == "zoom":
                    window.performZoom_(None)
                elif action == "minimize":
                    window.performMiniaturize_(None)
                return
            window.performWindowDragWithEvent_(event)

    _strip_class = SecureVectorTitleStrip
    return _strip_class


def place_title_strip(strip: Any, inset: int) -> None:
    """Pin the strip to the top of its superview, whichever way that view's y axis runs.

    pywebview makes the WKWebView itself the content view; WKWebView is
    flipped (y grows downward), so its top is y = 0. A plain NSView would
    put the top at height minus inset.
    """
    superview = strip.superview()
    if superview is None or inset <= 0:
        return
    import AppKit

    bounds = superview.bounds()
    flipped = bool(superview.isFlipped()) if hasattr(superview, "isFlipped") else False
    y = 0 if flipped else bounds.size.height - inset
    strip.setFrame_(AppKit.NSMakeRect(0, y, bounds.size.width, inset))


def install_titlebar_gestures(window: Any) -> bool:
    """macOS only: add the title strip view over the inset, on the main thread.

    Scheduled rather than immediate because the inset is only known once the
    toolbar has laid out (after first show), and AppKit view work belongs on
    the main thread. Returns True when the install was scheduled.
    """
    if sys.platform != "darwin":
        return False
    native = getattr(window, "native", None)
    if native is None:
        return False
    try:
        import AppKit
        from PyObjCTools import AppHelper

        def _apply() -> None:
            inset = titlebar_inset(window)
            if inset <= 0:
                logger.debug("title strip gestures skipped: no inset")
                return
            content = native.contentView()
            strip = _titlebar_strip_class().alloc().initWithFrame_(AppKit.NSMakeRect(0, 0, 0, 0))
            strip._sv_inset = inset
            strip.setAutoresizingMask_(_NS_VIEW_WIDTH_SIZABLE)
            content.addSubview_(strip)
            place_title_strip(strip, inset)

        AppHelper.callAfter(_apply)
        return True
    except Exception as exc:  # pragma: no cover - depends on the Cocoa runtime
        logger.debug("title strip gestures not installed: %s", exc)
        return False


def titlebar_inset(window: Any) -> int:
    """Height in points of the native title strip that overlaps the web view (macOS only)."""
    if sys.platform != "darwin":
        return 0
    native = getattr(window, "native", None)
    if native is None:
        return 0
    try:
        frame = native.frame()
        layout = native.contentLayoutRect()
        return max(0, int(round(frame.size.height - layout.size.height)))
    except Exception as exc:
        logger.debug("titlebar inset unavailable: %s", exc)
        return 0


def apply_chrome_theme(window: Any, theme_id: Any) -> bool:
    """Bind the native window chrome to the app theme.

    macOS: system appearance (dark or light controls) plus the window
    background. Windows: caption colour and dark-mode title bar through DWM
    on builds that support it. Other platforms: no-op.
    """
    color, scheme = chrome_theme(theme_id)
    native = getattr(window, "native", None)
    if native is None:
        return False
    if sys.platform == "darwin":
        try:
            import AppKit
            from PyObjCTools import AppHelper

            r, g, b = _hex_to_rgb(color)

            def _apply() -> None:
                name = "NSAppearanceNameDarkAqua" if scheme == "dark" else "NSAppearanceNameAqua"
                native.setAppearance_(AppKit.NSAppearance.appearanceNamed_(name))
                native.setBackgroundColor_(
                    AppKit.NSColor.colorWithSRGBRed_green_blue_alpha_(r / 255, g / 255, b / 255, 1.0)
                )

            AppHelper.callAfter(_apply)
            return True
        except Exception as exc:
            logger.debug("chrome theme not applied: %s", exc)
            return False
    if sys.platform == "win32":
        try:
            import ctypes

            handle = getattr(native, "Handle", None)
            hwnd = int(handle.ToInt64()) if hasattr(handle, "ToInt64") else int(handle)
            dwm = ctypes.windll.dwmapi
            dark = ctypes.c_int(1 if scheme == "dark" else 0)
            dwm.DwmSetWindowAttribute(hwnd, _DWMWA_USE_IMMERSIVE_DARK_MODE, ctypes.byref(dark), ctypes.sizeof(dark))
            r, g, b = _hex_to_rgb(color)
            caption = ctypes.c_uint32((b << 16) | (g << 8) | r)
            dwm.DwmSetWindowAttribute(hwnd, _DWMWA_CAPTION_COLOR, ctypes.byref(caption), ctypes.sizeof(caption))
            text = ctypes.c_uint32(0x00EEEEEE if scheme == "dark" else 0x00202020)
            dwm.DwmSetWindowAttribute(hwnd, _DWMWA_TEXT_COLOR, ctypes.byref(text), ctypes.sizeof(text))
            return True
        except Exception as exc:
            logger.debug("chrome theme not applied: %s", exc)
            return False
    return False


def menu_item_title(item: Any) -> str:
    """Visible title of a menu-bar item: the submenu's title, since pywebview leaves the item's own blank."""
    try:
        submenu = item.submenu()
        if submenu is not None:
            return str(submenu.title())
    except Exception as exc:
        logger.debug("submenu title unavailable: %s", exc)
    return str(item.title())


def desktop_user_agent(version: str) -> str:
    """User agent for the desktop web view; the page keys desktop-only behaviour on the token."""
    if sys.platform == "darwin":
        base = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"
    elif sys.platform == "win32":
        base = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)"
    else:
        base = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)"
    return f"{base} {DESKTOP_USER_AGENT_TOKEN}/{version}"


def reorder_macos_menu() -> bool:
    """Move File in front of the Edit and View menus pywebview inserts.

    AppKit only allows the main menu to be read or changed on the main
    thread, so the whole pass is scheduled there. Returns True when scheduled.
    """
    if sys.platform != "darwin":
        return False
    try:
        import AppKit
        from PyObjCTools import AppHelper

        def _apply() -> None:
            main = AppKit.NSApplication.sharedApplication().mainMenu()
            if main is None:
                return
            items = list(main.itemArray())
            titles = [menu_item_title(i) for i in items]
            wanted = menu_order(titles)
            if wanted == titles or len(set(titles[1:])) != len(titles[1:]):
                return  # nothing to do, or ambiguous titles: leave the bar alone
            by_title = {menu_item_title(i): i for i in items[1:]}
            main.removeAllItems()
            main.addItem_(items[0])
            for title in wanted[1:]:
                main.addItem_(by_title[title])

        AppHelper.callAfter(_apply)
        return True
    except Exception as exc:
        logger.debug("menu reorder skipped: %s", exc)
        return False


class ChromeApi:
    """Chrome state shared between the shell and the loopback routes.

    The window is bound after ``create_window`` returns and the title bar is
    styled from ``before_show``; the page asks for the result over HTTP.
    """

    def __init__(self, window: Any = None, context_menu: bool = False):
        self._window = window
        self._unified = False
        self.context_menu = bool(context_menu)

    def bind(self, window: Any, unified: bool = False) -> None:
        self._window = window
        self._unified = bool(unified)

    def chrome_info(self) -> dict:
        return {
            "platform": sys.platform,
            "unified_titlebar": self._unified,
            "titlebar_inset": titlebar_inset(self._window) if self._unified else 0,
            "context_menu": self.context_menu,
        }

    def set_theme(self, theme_id: Any = None) -> bool:
        return apply_chrome_theme(self._window, theme_id)


def install_chrome_routes(app: Any, chrome: ChromeApi) -> None:
    """Register the loopback-only chrome routes the page uses instead of the JS bridge.

    ``GET /api/desktop/chrome`` returns the title-bar inset and flags;
    ``POST /api/desktop/chrome/theme`` binds the native window to a theme id.
    """
    from fastapi import Request
    from fastapi.responses import JSONResponse

    async def _info(request: Request):
        client_host = request.client.host if request.client else None
        if not is_loopback(client_host):
            return JSONResponse({"error": "Forbidden"}, status_code=403)
        return chrome.chrome_info()

    async def _theme(request: Request):
        client_host = request.client.host if request.client else None
        if not is_loopback(client_host):
            return JSONResponse({"error": "Forbidden"}, status_code=403)
        try:
            body = await request.json()
        except Exception:
            body = {}
        theme = body.get("theme") if isinstance(body, dict) else None
        if not isinstance(theme, str) or theme.lower() not in CHROME_THEMES:
            return JSONResponse({"error": "Unknown theme"}, status_code=400)
        try:
            applied = chrome.set_theme(theme)
        except Exception as exc:  # never let a GUI hiccup 500 the page
            logger.warning("Chrome theme failed: %s", exc)
            applied = False
        return {"applied": bool(applied), "theme": theme.lower()}

    # The SPA catch-all (``GET /{path}``) is already registered by the time the
    # desktop shell configures the app, so these go to the front of the table.
    _add_route_first(app, CHROME_PATH, _info, ["GET"])
    _add_route_first(app, CHROME_THEME_PATH, _theme, ["POST"])


def _add_route_first(app: Any, path: str, endpoint: Callable[..., Any], methods: list) -> None:
    app.add_api_route(path, endpoint, methods=methods, include_in_schema=False)
    routes = app.router.routes
    routes.insert(0, routes.pop())
