"""Best-effort git facts about a task folder, read from disk without spawning git."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

# A HEAD or `.git` pointer file is one short line. Read a bounded prefix
# rather than whatever size the file claims: this runs against a folder the
# app did not create, so an enormous or hostile file must cost nothing.
MAX_BYTES = 4096
# git's own ref-name limit; the value is rendered in the UI, so cap it here
# too rather than trusting the file.
MAX_NAME = 255


def _first_line(path: Path) -> str:
    with open(path, "rb") as handle:
        raw = handle.read(MAX_BYTES)
    return raw.decode("utf-8", errors="replace").split("\n", 1)[0].strip()


def _clean(name: str) -> Optional[str]:
    """The name as it may be shown, or None when it is not a plain ref name."""
    if not 1 <= len(name) <= MAX_NAME:
        return None
    if name.startswith("/") or name.endswith("/"):
        return None
    # Control characters would corrupt the status line, and U+FFFD means the
    # bytes were not text in the first place.
    if "�" in name or not all(ch.isprintable() for ch in name):
        return None
    return name


def workspace_branch(workspace: str) -> Optional[str]:
    """Current branch name of `workspace`, or a 7-char short SHA when detached.

    Returns None when the folder is not a git checkout, anything is
    unreadable, or HEAD does not hold a plain ref name. Handles worktrees and
    submodules, whose `.git` is a file holding `gitdir: <path>` rather than a
    directory.
    """
    try:
        root = Path(workspace)
        dot_git = root / ".git"
        if dot_git.is_file():
            first = _first_line(dot_git)
            if not first.startswith("gitdir:"):
                return None
            gitdir = Path(first[len("gitdir:") :].strip())
            if not gitdir.is_absolute():
                gitdir = (root / gitdir).resolve()
        elif dot_git.is_dir():
            gitdir = dot_git
        else:
            return None
        head = _first_line(gitdir / "HEAD")
    except (OSError, ValueError):
        return None
    if head.startswith("ref: "):
        ref = head[5:].strip()
        if ref.startswith("refs/heads/"):
            return _clean(ref[len("refs/heads/") :])
        return _clean(ref.rsplit("/", 1)[-1])
    return _clean(head[:7])
