"""Tests for the enrollment disclosure + confirm prompt (story #114).

Covers the CLI consent gate that runs BEFORE any enrollment change:
  - The five-bullet disclosure block has exactly five bullets and is
    always printed (even with --yes / auto_yes).
  - The prompt defaults to NO: anything but a literal 'y'/'Y' aborts.
  - 'y' / 'Y' proceed.
  - EOF / no-TTY (input() raises EOFError) declines — never auto-yes.
  - auto_yes proceeds without prompting but still prints the disclosure.

No process is spawned and no network is hit — input/print are exercised
in-process via monkeypatch.
"""

from __future__ import annotations

import builtins

import pytest

from securevector.app import main as app_main


def test_five_bullets_present() -> None:
    assert len(app_main.ENROLLMENT_DISCLOSURE_BULLETS) == 5
    # Each bullet maps to a real, user-facing concept — sanity-check the
    # load-bearing phrases so a careless edit can't gut the contract.
    joined = " ".join(app_main.ENROLLMENT_DISCLOSURE_BULLETS).lower()
    assert "managed policies" in joined
    assert "metadata only" in joined
    assert "inspect" in joined


def test_prompt_yes_proceeds(monkeypatch, capsys) -> None:
    monkeypatch.setattr(builtins, "input", lambda _prompt="": "y")
    assert app_main._confirm_enrollment_disclosure(auto_yes=False) is True
    out = capsys.readouterr().out
    # Disclosure block always printed before the prompt.
    assert "what this does" in out.lower()
    assert out.count(". ") >= 5  # five numbered bullets


@pytest.mark.parametrize("answer", ["", "n", "N", "no", "yes please", "Y ", " y"])
def test_prompt_non_y_aborts(monkeypatch, answer) -> None:
    # Only a stripped, exact 'y'/'Y' proceeds. ' y' / 'Y ' strip to 'y'/'Y'
    # and DO proceed; the rest must abort. Encode that explicitly.
    monkeypatch.setattr(builtins, "input", lambda _prompt="": answer)
    result = app_main._confirm_enrollment_disclosure(auto_yes=False)
    expected = answer.strip() in ("y", "Y")
    assert result is expected


def test_eof_declines(monkeypatch) -> None:
    def _raise(_prompt: str = "") -> str:
        raise EOFError()

    monkeypatch.setattr(builtins, "input", _raise)
    # No TTY / piped stdin must NEVER be treated as consent.
    assert app_main._confirm_enrollment_disclosure(auto_yes=False) is False


def test_keyboard_interrupt_declines(monkeypatch) -> None:
    def _raise(_prompt: str = "") -> str:
        raise KeyboardInterrupt()

    monkeypatch.setattr(builtins, "input", _raise)
    assert app_main._confirm_enrollment_disclosure(auto_yes=False) is False


def test_auto_yes_proceeds_without_prompting(monkeypatch, capsys) -> None:
    # auto_yes must not call input() at all, but must still print the block.
    def _boom(_prompt: str = "") -> str:
        raise AssertionError("input() must not be called when auto_yes=True")

    monkeypatch.setattr(builtins, "input", _boom)
    assert app_main._confirm_enrollment_disclosure(auto_yes=True) is True
    out = capsys.readouterr().out
    assert "what this does" in out.lower()
