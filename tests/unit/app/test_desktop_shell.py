"""
Unit tests for the desktop shell helpers (single-instance lock, activation
endpoint, window geometry persistence, menu tree). pywebview is never
started; the window is a MagicMock.
"""

import json
import os
import socket
import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from securevector.app import desktop_shell as ds


def _screen(x, y, w, h):
    return SimpleNamespace(x=x, y=y, width=w, height=h)


class _Event:
    """Minimal stand-in for pywebview's Event: supports ``+=`` and fire()."""

    def __init__(self):
        self.handlers = []

    def __iadd__(self, handler):
        self.handlers.append(handler)
        return self

    def fire(self, *args):
        for h in self.handlers:
            h(*args)


def _window():
    window = MagicMock()
    window.events = SimpleNamespace(
        resized=_Event(), moved=_Event(), maximized=_Event(), restored=_Event(), loaded=_Event()
    )
    return window


# ---------------------------------------------------------------------------
# Lock file
# ---------------------------------------------------------------------------


class TestLockFile:
    def test_write_read_remove_round_trip(self, tmp_path):
        ds.write_lock(8745, "127.0.0.1", data_dir=tmp_path, pid=4242)
        info = ds.read_lock(tmp_path)
        assert info == ds.LockInfo(pid=4242, port=8745, host="127.0.0.1")
        ds.remove_lock(tmp_path)
        assert ds.read_lock(tmp_path) is None
        ds.remove_lock(tmp_path)  # idempotent

    def test_read_missing_or_corrupt_returns_none(self, tmp_path):
        assert ds.read_lock(tmp_path) is None
        (tmp_path / ds.LOCK_FILENAME).write_text("{not json", encoding="utf-8")
        assert ds.read_lock(tmp_path) is None
        (tmp_path / ds.LOCK_FILENAME).write_text(json.dumps({"pid": "x"}), encoding="utf-8")
        assert ds.read_lock(tmp_path) is None

    def test_pid_alive_for_self_and_dead_pid(self):
        assert ds.pid_alive(os.getpid()) is True
        assert ds.pid_alive(0) is False
        assert ds.pid_alive(-1) is False

    def test_stale_lock_dead_process_is_removed_and_not_activated(self, tmp_path):
        ds.write_lock(8745, data_dir=tmp_path, pid=999999)
        with patch.object(ds, "pid_alive", return_value=False), patch.object(ds, "ping_activate") as ping:
            assert ds.activate_running_instance(data_dir=tmp_path) is False
        ping.assert_not_called()
        assert ds.read_lock(tmp_path) is None

    def test_stale_lock_process_alive_but_not_answering_is_removed(self, tmp_path):
        ds.write_lock(8745, data_dir=tmp_path, pid=999999)
        with patch.object(ds, "pid_alive", return_value=True), patch.object(ds, "ping_activate", return_value=False) as ping:
            assert ds.activate_running_instance(data_dir=tmp_path) is False
        ping.assert_called_once_with(8745, "127.0.0.1")
        assert ds.read_lock(tmp_path) is None

    def test_live_lock_activates_using_lock_port_not_fallback(self, tmp_path):
        ds.write_lock(8745, data_dir=tmp_path, pid=999999)
        with patch.object(ds, "pid_alive", return_value=True), patch.object(ds, "ping_activate", return_value=True) as ping:
            assert ds.activate_running_instance(fallback_port=8741, data_dir=tmp_path) is True
        ping.assert_called_once_with(8745, "127.0.0.1")
        assert ds.read_lock(tmp_path) is not None

    def test_no_lock_falls_back_to_given_port(self, tmp_path):
        with patch.object(ds, "ping_activate", return_value=True) as ping:
            assert ds.activate_running_instance(fallback_port=8741, data_dir=tmp_path) is True
        ping.assert_called_once_with(8741, "127.0.0.1")

    def test_own_pid_in_lock_is_treated_as_stale(self, tmp_path):
        ds.write_lock(8745, data_dir=tmp_path)  # pid = this process
        with patch.object(ds, "ping_activate") as ping:
            assert ds.activate_running_instance(data_dir=tmp_path) is False
        ping.assert_not_called()
        assert ds.read_lock(tmp_path) is None


# ---------------------------------------------------------------------------
# Activation endpoint (real loopback server on a free high port)
# ---------------------------------------------------------------------------


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def activation_server():
    import uvicorn
    from fastapi import FastAPI

    calls = []
    app = FastAPI()
    ds.install_activation_route(app, lambda: calls.append(time.time()))
    port = _free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 5
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    assert server.started, "test server failed to start"
    yield port, calls
    server.should_exit = True
    thread.join(timeout=3)


class TestActivationRoute:
    def test_ping_activate_hits_endpoint(self, activation_server):
        port, calls = activation_server
        assert ds.ping_activate(port) is True
        assert len(calls) == 1

    def test_ping_activate_false_when_nothing_listening(self):
        assert ds.ping_activate(_free_port(), timeout=0.3) is False

    def test_non_loopback_client_is_rejected(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        app = FastAPI()
        activate = MagicMock()
        ds.install_activation_route(app, activate)
        client = TestClient(app)  # request.client.host is "testclient"
        resp = client.post(ds.ACTIVATE_PATH)
        assert resp.status_code == 403
        activate.assert_not_called()

    def test_activate_exception_returns_503(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        app = FastAPI()
        ds.install_activation_route(app, MagicMock(side_effect=RuntimeError("gui gone")))
        client = TestClient(app, client=("127.0.0.1", 50000))
        resp = client.post(ds.ACTIVATE_PATH)
        assert resp.status_code == 503
        assert resp.json() == {"activated": False}

    def test_is_loopback(self):
        assert ds.is_loopback("127.0.0.1")
        assert ds.is_loopback("::1")
        assert not ds.is_loopback("10.0.0.5")
        assert not ds.is_loopback(None)

    def test_make_activate_callback_restores_then_shows(self):
        window = MagicMock()
        ds.make_activate_callback(window)()
        window.restore.assert_called_once()
        window.show.assert_called_once()
        window.reset_mock()
        window.restore.side_effect = RuntimeError("not minimized")
        ds.make_activate_callback(window)()
        window.show.assert_called_once()


# ---------------------------------------------------------------------------
# Geometry validation
# ---------------------------------------------------------------------------


class TestValidateGeometry:
    primary = [_screen(0, 0, 1920, 1080)]

    def test_defaults_when_nothing_saved(self):
        g = ds.validate_geometry(ds.WindowGeometry(), self.primary)
        assert (g.x, g.y, g.width, g.height, g.maximized) == (None, None, 1200, 800, False)

    def test_on_screen_position_is_kept(self):
        g = ds.validate_geometry(ds.WindowGeometry(x=100, y=50, width=1000, height=700), self.primary)
        assert (g.x, g.y, g.width, g.height) == (100, 50, 1000, 700)

    def test_fully_off_screen_position_is_dropped(self):
        g = ds.validate_geometry(ds.WindowGeometry(x=3000, y=50, width=1000, height=700), self.primary)
        assert (g.x, g.y) == (None, None)
        assert (g.width, g.height) == (1000, 700)

    def test_barely_visible_position_is_dropped(self):
        # Only 40px of the window remain on screen: not enough to grab.
        g = ds.validate_geometry(ds.WindowGeometry(x=1880, y=50, width=1000, height=700), self.primary)
        assert (g.x, g.y) == (None, None)

    def test_partially_visible_position_is_kept(self):
        g = ds.validate_geometry(ds.WindowGeometry(x=1500, y=600, width=1000, height=700), self.primary)
        assert (g.x, g.y) == (1500, 600)

    def test_title_bar_above_screen_is_dropped(self):
        g = ds.validate_geometry(ds.WindowGeometry(x=100, y=-200, width=1000, height=700), self.primary)
        assert (g.x, g.y) == (None, None)

    def test_secondary_monitor_with_negative_coords(self):
        screens = [_screen(0, 0, 1920, 1080), _screen(-2560, -300, 2560, 1440)]
        g = ds.validate_geometry(ds.WindowGeometry(x=-2000, y=100, width=1200, height=800), screens)
        assert (g.x, g.y) == (-2000, 100)

    def test_unplugged_monitor_position_is_dropped(self):
        g = ds.validate_geometry(ds.WindowGeometry(x=-2000, y=100, width=1200, height=800), self.primary)
        assert (g.x, g.y) == (None, None)

    def test_size_is_clamped_to_min_and_largest_screen(self):
        g = ds.validate_geometry(ds.WindowGeometry(width=200, height=100), self.primary)
        assert (g.width, g.height) == (ds.MIN_WIDTH, ds.MIN_HEIGHT)
        g = ds.validate_geometry(ds.WindowGeometry(width=5000, height=4000), self.primary)
        assert (g.width, g.height) == (1920, 1080)

    def test_no_screens_keeps_size_drops_position(self):
        g = ds.validate_geometry(ds.WindowGeometry(x=10, y=10, width=1300, height=900, maximized=True), [])
        assert (g.x, g.y, g.width, g.height, g.maximized) == (None, None, 1300, 900, True)


# ---------------------------------------------------------------------------
# Serialization + tracker
# ---------------------------------------------------------------------------


class TestWindowStatePersistence:
    def test_round_trip(self, tmp_path):
        g = ds.WindowGeometry(x=10, y=20, width=1300, height=900, maximized=True)
        ds.save_window_geometry(g, tmp_path)
        saved = json.loads((tmp_path / ds.WINDOW_STATE_FILENAME).read_text(encoding="utf-8"))
        assert saved == {"x": 10, "y": 20, "width": 1300, "height": 900, "maximized": True}
        assert ds.load_window_geometry(tmp_path) == g

    def test_missing_or_corrupt_file_gives_defaults(self, tmp_path):
        assert ds.load_window_geometry(tmp_path) == ds.WindowGeometry()
        (tmp_path / ds.WINDOW_STATE_FILENAME).write_text("garbage", encoding="utf-8")
        assert ds.load_window_geometry(tmp_path) == ds.WindowGeometry()
        (tmp_path / ds.WINDOW_STATE_FILENAME).write_text("[1,2]", encoding="utf-8")
        assert ds.load_window_geometry(tmp_path) == ds.WindowGeometry()

    def test_from_dict_tolerates_bad_values(self):
        g = ds.WindowGeometry.from_dict({"x": "abc", "y": None, "width": "1400", "height": 0, "maximized": 1})
        assert (g.x, g.y, g.width, g.height, g.maximized) == (None, None, 1400, ds.DEFAULT_HEIGHT, True)

    def test_restore_geometry_uses_webview_screens(self, tmp_path):
        ds.save_window_geometry(ds.WindowGeometry(x=5000, y=5000, width=1000, height=700), tmp_path)
        fake_webview = SimpleNamespace(screens=[_screen(0, 0, 1920, 1080)])
        with patch.dict("sys.modules", {"webview": fake_webview}):
            g = ds.restore_geometry(tmp_path)
        assert (g.x, g.y, g.width, g.height) == (None, None, 1000, 700)

    def test_tracker_records_events_and_flushes(self, tmp_path):
        tracker = ds.WindowStateTracker(ds.WindowGeometry(), data_dir=tmp_path, debounce=0.05)
        window = _window()
        tracker.attach(window)
        for name in ("resized", "moved", "maximized", "restored"):
            assert len(getattr(window.events, name).handlers) == 1

        window.events.resized.fire(1400, 900)
        window.events.moved.fire(30, 40)
        window.events.maximized.fire()
        # Geometry reported while maximized must not clobber the normal size.
        window.events.resized.fire(1920, 1080)
        window.events.moved.fire(0, 0)
        tracker.flush()
        assert ds.load_window_geometry(tmp_path) == ds.WindowGeometry(x=30, y=40, width=1400, height=900, maximized=True)

        window.events.restored.fire()
        time.sleep(0.3)  # debounce timer writes without an explicit flush
        assert ds.load_window_geometry(tmp_path).maximized is False


# ---------------------------------------------------------------------------
# Context menu + menu bar
# ---------------------------------------------------------------------------


class TestContextMenuAndMenuBar:
    def test_suppress_context_menu_runs_js_on_every_load(self):
        window = _window()
        ds.suppress_context_menu(window)
        window.events.loaded.fire()
        window.events.loaded.fire(window)
        assert window.evaluate_js.call_count == 2
        assert "contextmenu" in window.evaluate_js.call_args[0][0]
        assert "preventDefault" in window.evaluate_js.call_args[0][0]

    def _titles(self, menus):
        from webview.menu import MenuAction

        out = {}
        for menu in menus:
            out[menu.title] = [i.title for i in menu.items if isinstance(i, MenuAction)]
        return out

    def test_menu_tree_no_em_dashes_and_expected_items(self):
        window = MagicMock()
        menus = ds.build_menu(window, "http://127.0.0.1:9999", "9.9.9")
        titles = self._titles(menus)
        assert "File" in titles and "Window" in titles and "Help" in titles
        assert titles["Help"] == ["Documentation", "Open Logs", "About SecureVector"]
        assert titles["File"] == ["Quit SecureVector"]
        flat = [t for items in titles.values() for t in items] + list(titles)
        assert all("—" not in t for t in flat)
        assert "Reload" in flat and "Zoom In" in flat and "Minimize" in flat

    def test_menu_actions_drive_the_window(self):
        window = MagicMock()
        menu = ds.DesktopMenu(window, "http://127.0.0.1:9999", "9.9.9")
        menu.quit()
        window.destroy.assert_called_once()
        menu.reload()
        window.load_url.assert_called_once_with("http://127.0.0.1:9999")
        menu.minimize()
        window.minimize.assert_called_once()
        menu.zoom_in()
        assert "zoom='1.1'" in window.evaluate_js.call_args[0][0]
        menu.actual_size()
        assert "zoom='1.0'" in window.evaluate_js.call_args[0][0]
        menu.zoom_out()
        assert "zoom='0.9'" in window.evaluate_js.call_args[0][0]
        menu.select_all()
        assert "selectAll" in window.evaluate_js.call_args[0][0]
        with patch("webbrowser.open") as wb:
            menu.documentation()
        wb.assert_called_once_with(ds.DOCS_URL)
        with patch.object(ds, "open_path_in_file_manager") as opener, patch(
            "securevector.app.utils.platform.get_log_dir", return_value="/tmp/x"
        ):
            menu.open_logs()
        opener.assert_called_once_with("/tmp/x")
        menu.about()
        title, message = window.create_confirmation_dialog.call_args[0]
        assert title == "About SecureVector" and "9.9.9" in message and "—" not in message

    def test_menu_platform_variants(self):
        window = MagicMock()
        with patch.object(ds.sys, "platform", "darwin"):
            titles = self._titles(ds.build_menu(window, "u", "1"))
        assert "Edit" not in titles and "View" not in titles  # pywebview supplies native ones
        assert "Reload" in titles["Window"]
        with patch.object(ds.sys, "platform", "win32"):
            titles = self._titles(ds.build_menu(window, "u", "1"))
        assert titles["Edit"] == ["Undo", "Redo", "Cut", "Copy", "Paste", "Select All"]
        assert titles["View"] == ["Reload", "Zoom In", "Zoom Out", "Actual Size"]
        assert titles["Window"] == ["Minimize"]


def test_hold_instance_mutex_is_a_no_op_off_windows(monkeypatch):
    from securevector.app import desktop_shell

    monkeypatch.setattr(desktop_shell.sys, "platform", "linux")
    assert desktop_shell.hold_instance_mutex() is False
    assert desktop_shell.INSTANCE_MUTEX_NAME == "SecureVectorDesktop"


def test_hold_instance_mutex_keeps_the_handle_on_windows(monkeypatch):
    import types

    from securevector.app import desktop_shell

    calls = []
    kernel32 = types.SimpleNamespace(CreateMutexW=lambda a, b, name: calls.append(name) or 42)
    fake_ctypes = types.SimpleNamespace(windll=types.SimpleNamespace(kernel32=kernel32))
    monkeypatch.setattr(desktop_shell.sys, "platform", "win32")
    monkeypatch.setitem(__import__("sys").modules, "ctypes", fake_ctypes)
    try:
        assert desktop_shell.hold_instance_mutex() is True
        assert calls == ["SecureVectorDesktop"]
        assert desktop_shell._instance_mutex_handle == 42
    finally:
        desktop_shell._instance_mutex_handle = None

