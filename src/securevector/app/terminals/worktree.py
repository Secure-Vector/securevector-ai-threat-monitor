"""Worktree isolation for launched tasks.

A task may run in its own git worktree under its task folder, so the
person's working folder is untouched. Governance keeps treating the task as
if it ran in the source folder: the task row's `workspace` stays the source,
and `source_for` maps any path inside a task's worktree back to the same
place in the source folder.

Every git call here is an argv list (no shell), runs with a timeout, never
runs a repository hook (core.hooksPath points at an empty folder the app
owns), an fsmonitor, or a filter driver (attributes come from the empty tree
and every configured filter is blanked), and ignores GIT_* variables from the
app's own environment. Callers on the event loop run these functions in an executor.

Nothing here removes a worktree on its own: `remove` runs only on an
explicit request from the person, and the startup sweep only marks rows and
prunes git's bookkeeping for worktrees already removed.
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

GIT_TIMEOUT = 30
BRANCH_PREFIX = "sv/task-"
WORKTREE_DIRNAME = "worktree"
ACTIVE, KEPT, REMOVED, REMOVING = "active", "kept", "removed", "removing"
# Claude Code's local, usually git-ignored, project settings. Nothing else is
# ever copied: never .env or other secrets.
LOCAL_CONFIG_FILES = (".mcp.json", ".claude/settings.local.json")
MAX_CONFIG_BYTES = 1024 * 1024

NOT_A_REPO = "Not a git repository. The task runs in this folder."
NO_COMMITS = "The repository has no commits yet, so a worktree cannot start from it."
IGNORED_NOTE = "Ignored files such as build output are deleted too."
LFS_UNSUPPORTED = "Worktrees are not available for Git LFS repositories yet. The task runs in this folder."
GIT_TOO_OLD = "Worktree isolation needs git 2.42 or newer. The task runs in this folder."
# git's well-known empty tree: attributes are read from it, not the checkout.
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"


class WorktreeError(RuntimeError):
    """A worktree could not be created or changed. The message is shown."""


class NotAGitRepository(WorktreeError):
    pass


@dataclass
class Created:
    run_dir: str          # where the task runs (worktree root + source subpath)
    root: str             # the worktree root, <task_dir>/worktree
    source_root: str      # the source repository's top level
    branch: str
    base: str             # the commit the branch starts from
    copied: list = field(default_factory=list)


# -- git ------------------------------------------------------------------------



def _count(n, noun):
    return f"{n} {noun}" if n == 1 else f"{n} {noun}s"

def _git_env() -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_OPTIONAL_LOCKS"] = "0"
    env["LC_ALL"] = "C"
    return env


def _git_bin() -> str:
    found = shutil.which("git")
    if not found:
        raise WorktreeError("git is not installed")
    return found


_SETUP_LOCK = threading.Lock()
_HOOKS_DIR: Optional[str] = None
_ATTR_SOURCE_OK: Optional[bool] = None


def configure(data_dir) -> None:
    """Use an empty hooks folder under the app's data folder (all platforms)."""
    global _HOOKS_DIR
    with _SETUP_LOCK:
        _HOOKS_DIR = str(Path(data_dir) / "terminals" / "git-hooks-empty")


def _hooks_dir() -> str:
    """An empty folder for core.hooksPath, so no repository hook can run."""
    global _HOOKS_DIR
    with _SETUP_LOCK:
        if _HOOKS_DIR is None:
            _HOOKS_DIR = tempfile.mkdtemp(prefix="sv-git-hooks-")
        path = _HOOKS_DIR
    try:
        os.makedirs(path, mode=0o700, exist_ok=True)
        if not os.path.isdir(path) or os.path.islink(path) or os.listdir(path):
            raise WorktreeError("The app's empty git hooks folder is not empty; worktrees are off.")
    except OSError as exc:
        raise WorktreeError("The app's git hooks folder cannot be prepared.") from exc
    return path


def _run(argv: list, timeout: float) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                              env=_git_env(), stdin=subprocess.DEVNULL, check=False)
    except subprocess.TimeoutExpired as exc:
        raise WorktreeError("git did not answer in time") from exc
    except OSError as exc:
        raise WorktreeError(f"git could not run: {exc.strerror or exc}") from exc


def attr_source_supported() -> bool:
    """Whether this git takes --attr-source (2.42 and newer). Asked once."""
    global _ATTR_SOURCE_OK
    if _ATTR_SOURCE_OK is None:
        out = _run([_git_bin(), f"--attr-source={EMPTY_TREE}", "version"], GIT_TIMEOUT)
        _ATTR_SOURCE_OK = out.returncode == 0
    return _ATTR_SOURCE_OK


def _base_argv() -> list:
    return [_git_bin(), "-c", f"core.hooksPath={_hooks_dir()}", "-c", "core.fsmonitor=false",
            # Submodules are never entered: the filter blanking below covers
            # this repository's configuration only.
            "-c", "submodule.recurse=false", "-c", "diff.ignoreSubmodules=all",
            "-c", "status.submoduleSummary=false",
            f"--attr-source={EMPTY_TREE}"]


def _filter_overrides(repo: str, timeout: float) -> list:
    """Blank every filter driver the configuration defines (clean, smudge,
    process), so no filter command runs; .git/info/attributes can still name
    a driver, which --attr-source does not cover. A driver marked required
    then fails the call instead of running."""
    out = _run(_base_argv() + ["-C", str(repo), "config", "-z", "--get-regexp", r"^filter\."], timeout)
    if out.returncode == 1:
        return []
    if out.returncode != 0:
        raise WorktreeError("git could not read the repository configuration")
    names = set()
    for entry in out.stdout.split("\0"):
        key = entry.split("\n", 1)[0]
        if not key.startswith("filter."):
            continue
        name = key[len("filter."):].rpartition(".")[0]
        if name:
            names.add(name)
    args = []
    for name in sorted(names):
        if "=" in name or "\n" in name or "\0" in name:
            raise WorktreeError("A git filter name in this repository is not supported.")
        for var in ("clean", "smudge", "process"):
            args += ["-c", f"filter.{name}.{var}="]
    return args


def git(repo: str, *args: str, timeout: float = GIT_TIMEOUT) -> subprocess.CompletedProcess:
    """One git call in `repo`, with no hook, fsmonitor, attribute file from
    the tree, or filter driver able to run. Never raises for a non-zero exit;
    raises WorktreeError when git is too old to run it safely."""
    if not attr_source_supported():
        raise WorktreeError(GIT_TOO_OLD)
    argv = _base_argv() + _filter_overrides(repo, timeout) + ["-C", str(repo), *args]
    return _run(argv, timeout)


def repo_root(folder: str) -> Optional[str]:
    """The top level of the repository `folder` is in, or None."""
    if not folder or not os.path.isdir(folder):
        return None
    try:
        out = git(folder, "rev-parse", "--show-toplevel")
    except WorktreeError:
        return None
    if out.returncode != 0 or not out.stdout.strip():
        return None
    return os.path.realpath(out.stdout.strip())


def check_folder(folder: str) -> dict:
    """For the launch form: may this folder run a task in a worktree?"""
    try:
        if not attr_source_supported():
            return {"git": False, "root": None, "worktree_ok": False, "message": GIT_TOO_OLD}
    except WorktreeError:
        return {"git": False, "root": None, "worktree_ok": False, "message": NOT_A_REPO}
    root = repo_root(os.path.expanduser(folder or ""))
    if root is None:
        return {"git": False, "root": None, "message": NOT_A_REPO}
    head = git(root, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")
    if head.returncode != 0:
        return {"git": True, "root": root, "worktree_ok": False, "message": NO_COMMITS}
    if has_required_filter(root):
        return {"git": True, "root": root, "worktree_ok": False, "message": LFS_UNSUPPORTED}
    return {"git": True, "root": root, "worktree_ok": True, "message": None}


def has_required_filter(repo: str) -> bool:
    """Whether the configuration marks any filter driver required (Git LFS
    does). Such a checkout cannot run with filters blanked."""
    out = git(repo, "config", "-z", "--type=bool", "--get-regexp", r"^filter\..*\.required$")
    if out.returncode == 1:
        return False
    if out.returncode != 0:
        return True
    for entry in out.stdout.split("\0"):
        parts = entry.split("\n", 1)
        if len(parts) == 2 and parts[1].strip() == "true":
            return True
    return False


def branch_for(task_id: str) -> str:
    return BRANCH_PREFIX + task_id


# -- path mapping -----------------------------------------------------------------

# worktree root (real path) -> source repository top level (real path)
_MAP: dict = {}
_MAP_LOCK = threading.Lock()


def register(root: str, source_root: str) -> None:
    with _MAP_LOCK:
        for key in {os.path.normpath(root), os.path.realpath(root)}:
            _MAP[key] = os.path.normpath(source_root)


def unregister(root: str) -> None:
    with _MAP_LOCK:
        for key in {os.path.normpath(root), os.path.realpath(root)}:
            _MAP.pop(key, None)


def clear() -> None:
    with _MAP_LOCK:
        _MAP.clear()


def _mapped(path: str, pairs) -> Optional[str]:
    for root, src in pairs:
        if path == root:
            return src
        if path.startswith(root + os.sep):
            return src + path[len(root):]
    return None


def source_for(path):
    """A path inside a task's worktree becomes the same path in the source
    folder; any other path (or a non-string) comes back unchanged."""
    if not isinstance(path, str) or not path or not os.path.isabs(path):
        return path
    with _MAP_LOCK:
        pairs = list(_MAP.items())
    if not pairs:
        return path
    norm = os.path.normpath(path)
    found = _mapped(norm, pairs)
    if found is None:
        try:
            real = os.path.realpath(norm)
        except (OSError, ValueError):
            return path
        found = _mapped(real, pairs) if real != norm else None
    return path if found is None else found


def split_source(workspace: str, run_dir: str, root: str) -> Optional[str]:
    """The source top level from a task row: `workspace` minus the subpath
    `run_dir` has below the worktree root."""
    try:
        rel = os.path.relpath(run_dir, root)
    except ValueError:
        return None
    if rel.startswith(".."):
        return None
    if rel == ".":
        return os.path.normpath(workspace)
    parts = Path(rel).parts
    ws = Path(workspace)
    if tuple(ws.parts[-len(parts):]) != tuple(parts):
        return None
    return str(ws.parents[len(parts) - 1])


# -- create -----------------------------------------------------------------------


def create(source: str, task_dir: Path, task_id: str) -> Created:
    """`git worktree add -b sv/task-<id> <task_dir>/worktree <HEAD>` for the
    repository holding `source`. Uncommitted changes are not carried over.
    On any failure after git created something, what it created is removed."""
    if not attr_source_supported():
        raise WorktreeError(GIT_TOO_OLD)
    source = os.path.realpath(source)
    root = repo_root(source)
    if root is None:
        raise NotAGitRepository(NOT_A_REPO)
    head = git(root, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")
    base = head.stdout.strip()
    if head.returncode != 0 or not base:
        raise WorktreeError(NO_COMMITS)
    if has_required_filter(root):
        raise WorktreeError(LFS_UNSUPPORTED)
    task_dir = Path(task_dir)
    task_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        os.chmod(task_dir, 0o700)
    except OSError:
        pass
    wt = Path(os.path.realpath(task_dir)) / WORKTREE_DIRNAME
    if wt.exists():
        raise WorktreeError("A worktree folder for this task already exists")
    branch = branch_for(task_id)
    if git(root, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}").returncode == 0:
        # Never touch a branch this spawn did not create.
        raise WorktreeError(f"Branch {branch} already exists")
    out = git(root, "worktree", "add", "-b", branch, "--", str(wt), base)
    if out.returncode != 0:
        discard(root, str(wt), branch)
        raise WorktreeError("git could not create the worktree: " + _first_line(out.stderr))
    try:
        rel = os.path.relpath(source, root)
        run_dir = str(wt) if rel == "." else str(wt / rel)
        if not inside_real(run_dir, str(wt)):
            raise WorktreeError("The folder leaves the worktree through a link.")
        if not os.path.isdir(run_dir):
            # The source subfolder holds nothing git tracks.
            os.makedirs(run_dir, mode=0o755, exist_ok=True)
        copied = copy_local_config(source, run_dir)
    except BaseException:
        discard(root, str(wt), branch)
        raise
    register(str(wt), root)
    return Created(run_dir=run_dir, root=str(wt), source_root=root, branch=branch, base=base,
                   copied=copied)


def discard(source_root: str, root: str, branch: str) -> None:
    """Undo a create that did not reach a running task. Only ever called on
    the worktree and branch the same spawn just created."""
    unregister(root)
    try:
        if os.path.exists(root):
            git(source_root, "worktree", "remove", "--force", "--", root)
        if os.path.exists(root):
            shutil.rmtree(root, ignore_errors=True)
        git(source_root, "worktree", "prune")
        git(source_root, "branch", "-D", "--", branch)
    except WorktreeError:
        pass


def _first_line(text: str) -> str:
    line = (text or "").strip().splitlines()
    return line[0][:300] if line else "unknown error"


def _inside(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def inside_real(path: str, root: str) -> bool:
    """Whether `path`, with links resolved, stays inside `root`."""
    return _inside(os.path.realpath(path), os.path.realpath(root))


def copy_local_config(source: str, run_dir: str) -> list:
    """Copy Claude Code's local project files that git ignores (so the
    worktree lacks them). Only the two names in LOCAL_CONFIG_FILES, only
    regular files, only when git ignores them, never through a link that
    leaves the source folder, and never over a file the worktree has."""
    copied = []
    real_source = os.path.realpath(source)
    for rel in LOCAL_CONFIG_FILES:
        src = os.path.join(real_source, rel)
        try:
            if not os.path.lexists(src):
                continue
            target = os.path.realpath(src)
            if not _inside(target, real_source):
                continue
            st = os.stat(target)
            if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_CONFIG_BYTES:
                continue
            # Every parent between the source and the file must be a real
            # folder in the source, not a link elsewhere.
            if not _inside(os.path.realpath(os.path.dirname(src)), real_source):
                continue
            ignored = git(real_source, "check-ignore", "-q", "--", rel)
            if ignored.returncode != 0:
                continue
            dest = os.path.join(run_dir, rel)
            if os.path.lexists(dest):
                continue
            real_run = os.path.realpath(run_dir)
            if not _inside(os.path.realpath(os.path.dirname(dest)), real_run):
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            if not _inside(os.path.realpath(os.path.dirname(dest)), real_run):
                continue
            fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "wb") as out, open(target, "rb") as inp:
                out.write(inp.read(MAX_CONFIG_BYTES + 1)[:MAX_CONFIG_BYTES])
            copied.append(rel)
        except (OSError, WorktreeError):
            continue
    return copied


# -- end, remove ------------------------------------------------------------------


def counts(source_root: str, root: str, branch: str, base: str) -> dict:
    """Changed files in the worktree and commits on its branch beyond base.
    None for a value git could not report."""
    dirty = None
    commits = None
    if os.path.isdir(root):
        out = git(root, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=all")
        if out.returncode == 0:
            dirty = sum(1 for line in out.stdout.splitlines() if line.strip())
    if base and branch:
        out = git(source_root, "rev-list", "--count", f"{base}..refs/heads/{branch}")
        if out.returncode == 0 and out.stdout.strip().isdigit():
            commits = int(out.stdout.strip())
    return {"dirty": dirty, "commits": commits}


def remove(source_root: str, root: str, branch: str, base: str, *, confirm: bool,
           dirty_seen: Optional[int] = None) -> dict:
    """Remove the worktree on the person's request. Changed files (tracked
    or untracked) are counted fresh here, never taken from a stored count.
    With changes, removal needs `confirm` AND `dirty_seen` equal to the fresh
    count, so a confirm given against an older count (a stale card) cannot
    discard files the person never saw. The branch is deleted only when it
    has no commits beyond base; otherwise it is kept and the result says so."""
    now = counts(source_root, root, branch, base)
    if (now["dirty"] or 0) > 0 and confirm and dirty_seen != now["dirty"]:
        confirm = False
    if not confirm and now["dirty"] is None and os.path.exists(root):
        return {"removed": False, "needs_confirm": True, **now,
                "message": "The worktree's changes could not be read. Confirm to remove it anyway. "
                           + IGNORED_NOTE}
    if (now["dirty"] or 0) > 0 and not confirm:
        return {"removed": False, "needs_confirm": True, **now,
                "message": f"{_count(now['dirty'], 'uncommitted file')} will be lost. "
                           + IGNORED_NOTE}
    if os.path.exists(root):
        out = git(source_root, "worktree", "remove", "--force", "--", root)
        if out.returncode != 0 and os.path.exists(root):
            raise WorktreeError("git could not remove the worktree: " + _first_line(out.stderr))
    git(source_root, "worktree", "prune")
    unregister(root)
    branch_deleted = False
    message = "Worktree removed."
    if now["commits"] == 0:
        out = git(source_root, "branch", "-D", "--", branch)
        branch_deleted = out.returncode == 0
        if branch_deleted:
            message = f"Worktree and branch {branch} removed."
    elif now["commits"]:
        message = f"Worktree removed. Branch {branch} kept: it has {_count(now['commits'], 'commit')}."
    else:
        message = f"Worktree removed. Branch {branch} kept."
    return {"removed": True, "needs_confirm": False, "branch_deleted": branch_deleted,
            "branch_kept": not branch_deleted, **now, "message": message}


def prune(source_root: str) -> None:
    if os.path.isdir(source_root):
        git(source_root, "worktree", "prune")


def open_folder_argv(path: str) -> Optional[list]:
    """argv that reveals `path` in the platform file manager, or None."""
    if sys.platform == "darwin":
        tool = "/usr/bin/open"
    elif sys.platform.startswith("linux"):
        tool = shutil.which("xdg-open")
    elif sys.platform == "win32":
        tool = shutil.which("explorer")
    else:
        tool = None
    if not tool:
        return None
    return [tool, path]
