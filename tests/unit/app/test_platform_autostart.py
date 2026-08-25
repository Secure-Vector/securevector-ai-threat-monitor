"""Tests for login autostart executable resolution.

Frozen (PyInstaller) builds must register sys.executable so installer
users launch the real .exe / .app, not a pip Scripts/securevector-app path
that does not exist on a packaged machine.
"""

from __future__ import annotations

import sys
from pathlib import Path

from securevector.app.utils import platform as plat


def test_frozen_returns_sys_executable(monkeypatch) -> None:
    frozen_path = r"C:\\Program Files\\SecureVector\\SecureVector.exe"
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", frozen_path)
    assert plat._get_executable_path() == frozen_path


def test_frozen_macos_returns_sys_executable(monkeypatch) -> None:
    frozen_path = "/Applications/SecureVector.app/Contents/MacOS/SecureVector"
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", frozen_path)
    monkeypatch.setattr(sys, "platform", "darwin")
    assert plat._get_executable_path() == frozen_path


def test_unfrozen_windows_prefers_scripts_entry(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    monkeypatch.setattr(sys, "platform", "win32")
    python = tmp_path / "python.exe"
    python.write_bytes(b"")
    scripts = tmp_path / "Scripts"
    scripts.mkdir()
    entry = scripts / "securevector-app.exe"
    entry.write_bytes(b"")
    monkeypatch.setattr(sys, "executable", str(python))
    assert plat._get_executable_path() == str(entry)


def test_unfrozen_windows_falls_back_to_python_m(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    monkeypatch.setattr(sys, "platform", "win32")
    python = tmp_path / "python.exe"
    python.write_bytes(b"")
    (tmp_path / "Scripts").mkdir()
    monkeypatch.setattr(sys, "executable", str(python))
    assert plat._get_executable_path() == '"' + str(python) + '" -m securevector.app.main'


def test_unfrozen_unix_prefers_bin_entry(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    monkeypatch.setattr(sys, "platform", "darwin")
    python = tmp_path / "python3"
    python.write_bytes(b"")
    entry = tmp_path / "securevector-app"
    entry.write_bytes(b"")
    monkeypatch.setattr(sys, "executable", str(python))
    assert plat._get_executable_path() == str(entry)
