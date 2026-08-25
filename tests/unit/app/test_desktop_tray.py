"""Cheap tests for desktop tray helpers and --no-tray wiring."""

from __future__ import annotations

import inspect
import sys
from pathlib import Path

from securevector.app.main import run_desktop
from securevector.app.utils import tray


def test_tray_supported_mac_and_windows_only(monkeypatch) -> None:
    monkeypatch.setattr(tray.sys, "platform", "linux")
    assert tray.tray_supported() is False
    monkeypatch.setattr(tray.sys, "platform", "darwin")
    assert tray.tray_supported() is True
    monkeypatch.setattr(tray.sys, "platform", "win32")
    assert tray.tray_supported() is True


def test_start_tray_skips_on_linux(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(tray.sys, "platform", "linux")
    assert tray.start_tray(assets_path=tmp_path, on_show=lambda: None) is False


def test_run_desktop_accepts_no_tray() -> None:
    assert "no_tray" in inspect.signature(run_desktop).parameters


def test_no_tray_flag_in_main_source() -> None:
    src = inspect.getsource(sys.modules["securevector.app.main"].main)
    assert "--no-tray" in src
