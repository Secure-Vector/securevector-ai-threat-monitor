from unittest.mock import Mock

from securevector.app.desktop_shell import DesktopMenu, close_policy
from securevector.app.main import _app_terminating


def test_no_tasks_means_exit():
    assert close_policy(running=0, quitting=False, confirmed=False) == "exit"
    assert close_policy(running=0, quitting=True, confirmed=False) == "exit"


def test_window_close_with_tasks_hides():
    assert close_policy(running=2, quitting=False, confirmed=False) == "hide"


def test_quit_with_tasks_asks_then_stops():
    assert close_policy(running=2, quitting=True, confirmed=False) == "confirm"
    assert close_policy(running=2, quitting=True, confirmed=True) == "stop_and_exit"


def test_menu_quit_uses_on_quit_callback_when_given():
    window = Mock()
    on_quit = Mock()
    menu = DesktopMenu(window, "http://127.0.0.1:0", "0.0.0", on_quit=on_quit)

    menu.quit()

    on_quit.assert_called_once()
    window.destroy.assert_not_called()


def test_menu_quit_falls_back_to_window_destroy_without_on_quit():
    window = Mock()
    menu = DesktopMenu(window, "http://127.0.0.1:0", "0.0.0")

    menu.quit()

    window.destroy.assert_called_once()


def test_app_terminating_false_for_plain_call():
    assert _app_terminating() is False


def test_app_terminating_true_inside_applicationShouldTerminate_():
    # pywebview's AppDelegate.applicationShouldTerminate_ (Cmd+Q / the
    # native Quit item) is the only caller whose frame name should flip
    # this; a real frame is enough, no pywebview or Cocoa needed to fake it.
    def applicationShouldTerminate_():
        return _app_terminating()

    assert applicationShouldTerminate_() is True
