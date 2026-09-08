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
DOCS_URL = "https://securevector.io/docs"

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

SUPPRESS_CONTEXT_MENU_JS = (
    "(function(){if(window.__svNoContextMenu){return;}window.__svNoContextMenu=true;"
    "document.addEventListener('contextmenu',function(e){e.preventDefault();},true);})();"
)


def suppress_context_menu(window: Any) -> None:
    """Attach a per-page-load hook that disables the native WebView context menu."""

    def _on_loaded(*_args: Any) -> None:
        try:
            window.evaluate_js(SUPPRESS_CONTEXT_MENU_JS)
        except Exception as exc:
            logger.debug("Context menu suppression skipped: %s", exc)

    window.events.loaded += _on_loaded


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

    def documentation(self) -> None:
        import webbrowser

        webbrowser.open(DOCS_URL)

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
                    MenuAction("About SecureVector", self.about),
                ],
            )
        )
        return menus


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
