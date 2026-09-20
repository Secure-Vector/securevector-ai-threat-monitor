"""The working folder a harness recorded for one of its own sessions.

A linked task's folder used to be scraped out of an audit row's free-text
preview, which is a guess and has been wrong. Both JSONL harnesses write the
folder as a field on every turn, so for those two the folder can be read
rather than inferred. Harnesses that keep sessions in SQLite (opencode,
copilot-cli) are out of scope here and fall back to the scrape.

Everything in this module is best effort: a missing, unreadable or garbage
transcript yields None, never an exception. The folder is an enrichment, so
it must never be the reason a board read fails.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Optional

from securevector.app.terminals.store import _plausible_cwd

# Where each JSONL harness keeps its transcripts. Module attributes rather
# than arguments so callers stay a two-argument call; tests point them at a
# fixture tree.
CLAUDE_PROJECTS_ROOT = Path.home() / ".claude" / "projects"
CODEX_SESSIONS_ROOT = Path.home() / ".codex" / "sessions"

# A transcript reaches tens of megabytes, and the folder is restated on every
# turn, so the end of the file answers the question as well as the whole of it.
TAIL_BYTES = 262144

# Only read when the tail names no folder. Observed on a real 1.8 MB Codex
# rollout: the tail carries cwd only as a "file://" URI on each item, which is
# not a path and is rightly refused, while the plain folder is on the
# session_meta record at the very top of the file. Claude Code never needs
# this, and neither does a short Codex session.
HEAD_BYTES = 65536

# The session id is interpolated into a filesystem glob, so it is validated as
# a shape first. This repeats manager.SESSION_ID_RE rather than importing it:
# manager imports this module, so importing manager back would be a cycle.
# Keep the two patterns in step.
_SESSION_ID_SAFE = re.compile(r"\A[A-Za-z0-9._:-]{8,128}\Z")

# How deep a record is walked for a "cwd" key. Claude Code records it at the
# top level; Codex nests it under payload, and again under
# payload.state.environments.<name>. The bound stops an odd record from
# costing an unbounded walk.
_MAX_DEPTH = 8

# Fallback for lines that are not valid JSON, which in practice is only the
# truncated first line of the tail window. Applied to nothing else on purpose:
# a parsed record tells us which "cwd" is a field and which is merely text
# inside some other field's value, and that distinction is the whole reason
# the scrape this module replaces kept returning source code.
_CWD_TEXT = re.compile(r'"cwd"\s*:\s*("(?:[^"\\]|\\.){0,1024}")')


def resolve_session_cwd(executor_id: str, session_id: str) -> Optional[str]:
    """The working folder a harness itself recorded for a session.

    None when the executor keeps no JSONL transcript, when the session id is
    not a safe shape, when no transcript is found, or when nothing in the
    transcript tail looks like a folder.
    """
    if not _safe_session_id(session_id):
        return None
    path = _transcript_for(executor_id, session_id)
    if path is None:
        return None
    try:
        found = _mode_cwd(_tail_lines(path))
        if found is None:
            found = _mode_cwd(_head_lines(path))
        return found
    except OSError:
        return None


def _safe_session_id(session_id: str) -> bool:
    """A session id that can be interpolated into a glob without escaping."""
    session_id = (session_id or "").strip()
    if not _SESSION_ID_SAFE.match(session_id):
        return False
    # The character class already admits dots, so traversal is refused by name
    # rather than left to the pattern.
    return ".." not in session_id


def _transcript_for(executor_id: str, session_id: str) -> Optional[Path]:
    """The newest transcript file for this session, or None.

    Several can match when a session id was reused across projects or days,
    and the most recently modified one is the live one.
    """
    if executor_id == "claude-code":
        matches = CLAUDE_PROJECTS_ROOT.glob(f"*/{session_id}.jsonl")
    elif executor_id == "codex":
        # rollout-<ISO timestamp>-<session id>.jsonl under sessions/YYYY/MM/DD.
        matches = CODEX_SESSIONS_ROOT.glob(f"*/*/*/rollout-*-{session_id}.jsonl")
    else:
        # opencode and copilot-cli keep sessions in SQLite; nothing to glob,
        # and the filesystem is not touched at all for them.
        return None
    newest: Optional[Path] = None
    newest_mtime = -1.0
    try:
        for candidate in matches:
            try:
                mtime = candidate.stat().st_mtime
            except OSError:
                continue
            if mtime > newest_mtime:
                newest, newest_mtime = candidate, mtime
    except OSError:
        return None
    return newest


def _tail_lines(path: Path, tail_bytes: int = TAIL_BYTES) -> list:
    """Raw lines from the end of a JSONL file, oldest first.

    Same shape as cost_optimizer._tail_records, but the lines are kept
    unparsed so a line that is not JSON can still be scanned by pattern.
    The first line of the window is usually truncated, which is exactly such
    a line.
    """
    size = path.stat().st_size
    with path.open("rb") as fh:
        fh.seek(max(0, size - tail_bytes))
        chunk = fh.read().decode("utf-8", errors="replace")
    return chunk.splitlines()


def _head_lines(path: Path, head_bytes: int = HEAD_BYTES) -> list:
    """Raw lines from the start of a JSONL file. The last line of the window
    is dropped when the read was cut short, since it is a partial record."""
    with path.open("rb") as fh:
        chunk = fh.read(head_bytes)
    truncated = len(chunk) == head_bytes
    lines = chunk.decode("utf-8", errors="replace").splitlines()
    return lines[:-1] if truncated and lines else lines


def _line_cwds(line: str) -> list:
    """Every cwd value one transcript line records, as strings."""
    line = line.strip()
    if not line:
        return []
    try:
        record = json.loads(line)
    except ValueError:
        record = None
    if isinstance(record, (dict, list)):
        found: list = []
        _walk_cwds(record, 0, found)
        return found
    values: list = []
    for match in _CWD_TEXT.finditer(line):
        try:
            values.append(json.loads(match.group(1)))
        except ValueError:
            continue
    return values


def _walk_cwds(node: Any, depth: int, out: list) -> None:
    if depth > _MAX_DEPTH:
        return
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "cwd" and isinstance(value, str):
                out.append(value)
            else:
                _walk_cwds(value, depth + 1, out)
    elif isinstance(node, list):
        for value in node:
            _walk_cwds(value, depth + 1, out)


def _mode_cwd(lines: list) -> Optional[str]:
    """The most frequently recorded plausible folder, ties broken by recency.

    Not the last value: a session's cwd changes transiently whenever a tool
    runs `cd`, so the tail of a real transcript ends on a subdirectory as
    often as not. The mode is the folder the session actually lives in.

    Candidates are filtered through store._plausible_cwd as they are counted,
    so this path enforces the same shape rule as the scrape and an implausible
    value can never win by sheer volume.
    """
    counts: dict = {}
    last_at: dict = {}
    for index, line in enumerate(lines):
        for value in _line_cwds(line):
            folder = _plausible_cwd(value)
            if folder is None:
                continue
            counts[folder] = counts.get(folder, 0) + 1
            last_at[folder] = index
    if not counts:
        return None
    return max(counts, key=lambda folder: (counts[folder], last_at[folder]))
