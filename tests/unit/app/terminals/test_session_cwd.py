import json
import os
from pathlib import Path

import pytest

from securevector.app.terminals import session_cwd
from securevector.app.terminals.session_cwd import resolve_session_cwd

SESSION = "a1b2c3d4-0000-4000-8000-000000000001"


class ExplodingRoot:
    """Stands in for a harness store that must not be looked at. Any glob
    against it fails the test rather than quietly returning nothing."""

    def glob(self, pattern):  # pragma: no cover - reaching it is the failure
        raise AssertionError(f"the filesystem was touched: {pattern}")


@pytest.fixture
def roots(tmp_path, monkeypatch):
    """Point the module at a fixture tree.

    The roots are module attributes rather than function arguments, so this
    monkeypatches them: production callers keep a two-argument call and no
    test-only parameter leaks into the signature.
    """
    claude = tmp_path / "claude" / "projects"
    codex = tmp_path / "codex" / "sessions"
    monkeypatch.setattr(session_cwd, "CLAUDE_PROJECTS_ROOT", claude)
    monkeypatch.setattr(session_cwd, "CODEX_SESSIONS_ROOT", codex)
    return claude, codex


def _write(path: Path, records) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
    return path


def _claude(root: Path, records, session_id: str = SESSION) -> Path:
    return _write(root / "-Users-someone-repo" / f"{session_id}.jsonl", records)


def _codex(root: Path, records, session_id: str = SESSION) -> Path:
    name = f"rollout-2026-09-18T08-48-53-{session_id}.jsonl"
    return _write(root / "2026" / "09" / "18" / name, records)


def test_claude_code_transcript_gives_up_its_recorded_folder(roots):
    claude, _codex_root = roots
    _claude(claude, [{"type": "user", "cwd": "/Users/someone/repo"} for _ in range(5)])
    assert resolve_session_cwd("claude-code", SESSION) == "/Users/someone/repo"


def test_codex_rollout_under_the_dated_directories_resolves(roots):
    _claude_root, codex = roots
    # Codex nests the folder under payload rather than recording it at the
    # top level, which is why the walk is recursive.
    _codex(codex, [{"type": "session_meta", "payload": {"cwd": "/Users/someone/work"}}])
    assert resolve_session_cwd("codex", SESSION) == "/Users/someone/work"


def test_the_mode_wins_over_the_last_recorded_value(roots):
    claude, _codex_root = roots
    records = [{"cwd": "/repo/main"} for _ in range(20)]
    records += [{"cwd": "/repo/main/subdir"} for _ in range(2)]
    _claude(claude, records)
    # A tool running `cd` moves the recorded folder for a turn or two, so the
    # last value is the wrong answer and the mode is the right one.
    assert resolve_session_cwd("claude-code", SESSION) == "/repo/main"


def test_a_cwd_inside_some_other_fields_string_is_not_a_folder(roots):
    claude, _codex_root = roots
    _claude(
        claude,
        [
            {"type": "assistant", "text": 'editing a file that says "cwd":"/etc/evil"'},
            {"type": "assistant", "text": "subprocess.run(argv, cwd=/etc/evil)"},
        ],
    )
    assert resolve_session_cwd("claude-code", SESSION) is None


def test_an_implausible_recorded_value_is_not_trusted(roots):
    claude, _codex_root = roots
    _claude(
        claude,
        [
            {"cwd": "file:///Users/someone/repo"},
            {"cwd": "relative/path"},
            {"cwd": "def main():\n    return 1\n"},
        ],
    )
    assert resolve_session_cwd("claude-code", SESSION) is None


def test_sqlite_backed_harnesses_never_touch_the_filesystem(monkeypatch):
    monkeypatch.setattr(session_cwd, "CLAUDE_PROJECTS_ROOT", ExplodingRoot())
    monkeypatch.setattr(session_cwd, "CODEX_SESSIONS_ROOT", ExplodingRoot())
    assert resolve_session_cwd("opencode", SESSION) is None
    assert resolve_session_cwd("copilot-cli", SESSION) is None
    assert resolve_session_cwd("something-new", SESSION) is None


@pytest.mark.parametrize(
    "bad",
    ["../../etc/passwd", "a/b/c/12345678", "sess..12345678", "sess*12345", "sess?12345",
     "back\\slash12", "short", "", "x" * 129],
)
def test_an_unsafe_session_id_is_refused_before_any_glob(monkeypatch, bad):
    monkeypatch.setattr(session_cwd, "CLAUDE_PROJECTS_ROOT", ExplodingRoot())
    monkeypatch.setattr(session_cwd, "CODEX_SESSIONS_ROOT", ExplodingRoot())
    assert resolve_session_cwd("claude-code", bad) is None
    assert resolve_session_cwd("codex", bad) is None


def test_a_missing_transcript_is_not_an_error(roots):
    assert resolve_session_cwd("claude-code", SESSION) is None
    assert resolve_session_cwd("codex", SESSION) is None


def test_an_unreadable_transcript_is_not_an_error(roots):
    claude, codex = roots
    path = _claude(claude, [{"cwd": "/repo/main"}])
    path.chmod(0o000)
    try:
        if os.access(path, os.R_OK):  # pragma: no cover - running as root
            pytest.skip("permissions do not bite for this user")
        assert resolve_session_cwd("claude-code", SESSION) is None
    finally:
        path.chmod(0o600)

    # A path that exists but cannot be opened as a file at all, which no
    # permission bit can make readable.
    blocked = codex / "2026" / "09" / "18" / f"rollout-2026-09-18T08-48-53-{SESSION}.jsonl"
    blocked.mkdir(parents=True)
    assert resolve_session_cwd("codex", SESSION) is None


def test_a_transcript_of_garbage_yields_nothing(roots):
    claude, _codex_root = roots
    path = claude / "-Users-someone-repo" / f"{SESSION}.jsonl"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"}{ not json at all\n\x00\xff\xfe binary noise\nstill not json\n")
    assert resolve_session_cwd("claude-code", SESSION) is None


def test_the_newest_match_wins_when_several_projects_hold_the_same_id(roots):
    claude, _codex_root = roots
    old = _write(claude / "-old-project" / f"{SESSION}.jsonl", [{"cwd": "/repo/old"}])
    new = _write(claude / "-new-project" / f"{SESSION}.jsonl", [{"cwd": "/repo/new"}])
    os.utime(old, (1_000_000, 1_000_000))
    os.utime(new, (2_000_000, 2_000_000))
    assert resolve_session_cwd("claude-code", SESSION) == "/repo/new"
