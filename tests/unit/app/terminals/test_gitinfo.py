"""Branch lookup for a task folder, read from disk without spawning git."""

from securevector.app.terminals.gitinfo import workspace_branch

SHA = "0123456789abcdef0123456789abcdef01234567"


def _repo(root, head_text):
    git = root / ".git"
    git.mkdir(parents=True)
    (git / "HEAD").write_text(head_text, encoding="utf-8")
    return root


def test_plain_folder_is_not_a_checkout(tmp_path):
    (tmp_path / "proj").mkdir()
    assert workspace_branch(str(tmp_path / "proj")) is None


def test_missing_folder_is_none(tmp_path):
    assert workspace_branch(str(tmp_path / "nope")) is None


def test_symbolic_head_returns_branch_name(tmp_path):
    _repo(tmp_path / "r", "ref: refs/heads/feat/x\n")
    assert workspace_branch(str(tmp_path / "r")) == "feat/x"


def test_detached_head_returns_short_sha(tmp_path):
    _repo(tmp_path / "r", SHA + "\n")
    assert workspace_branch(str(tmp_path / "r")) == SHA[:7]


def test_non_branch_ref_falls_back_to_last_segment(tmp_path):
    _repo(tmp_path / "r", "ref: refs/remotes/origin/main\n")
    assert workspace_branch(str(tmp_path / "r")) == "main"


def test_worktree_gitdir_file_with_absolute_path(tmp_path):
    real = tmp_path / "store" / "worktrees" / "wt"
    real.mkdir(parents=True)
    (real / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    wt = tmp_path / "wt"
    wt.mkdir()
    (wt / ".git").write_text(f"gitdir: {real}\n", encoding="utf-8")
    assert workspace_branch(str(wt)) == "main"


def test_worktree_gitdir_file_with_relative_path(tmp_path):
    real = tmp_path / "store"
    real.mkdir()
    (real / "HEAD").write_text("ref: refs/heads/release/6.0.0\n", encoding="utf-8")
    wt = tmp_path / "wt"
    wt.mkdir()
    (wt / ".git").write_text("gitdir: ../store\n", encoding="utf-8")
    assert workspace_branch(str(wt)) == "release/6.0.0"


def test_git_file_without_gitdir_prefix_is_none(tmp_path):
    wt = tmp_path / "wt"
    wt.mkdir()
    (wt / ".git").write_text("something else\n", encoding="utf-8")
    assert workspace_branch(str(wt)) is None


def test_head_missing_is_none(tmp_path):
    root = tmp_path / "r"
    (root / ".git").mkdir(parents=True)
    assert workspace_branch(str(root)) is None


def test_empty_head_is_none(tmp_path):
    _repo(tmp_path / "r", "\n")
    assert workspace_branch(str(tmp_path / "r")) is None


def test_bare_refs_heads_prefix_only_is_none(tmp_path):
    _repo(tmp_path / "r", "ref: refs/heads/\n")
    assert workspace_branch(str(tmp_path / "r")) is None


def test_absurdly_long_ref_is_rejected(tmp_path):
    _repo(tmp_path / "r", "ref: refs/heads/" + "a" * 200000 + "\n")
    assert workspace_branch(str(tmp_path / "r")) is None


def test_only_the_first_line_of_head_is_read(tmp_path):
    _repo(tmp_path / "r", "ref: refs/heads/a\nb\n")
    assert workspace_branch(str(tmp_path / "r")) == "a"


def test_binary_head_is_rejected(tmp_path):
    root = tmp_path / "r"
    (root / ".git").mkdir(parents=True)
    (root / ".git" / "HEAD").write_bytes(b"\x00\x01\x02\x03\x04\x05\x06\x07\x08")
    assert workspace_branch(str(root)) is None


def test_control_characters_in_a_branch_name_are_rejected(tmp_path):
    _repo(tmp_path / "r", "ref: refs/heads/feat\x07bell\n")
    assert workspace_branch(str(tmp_path / "r")) is None


def test_undecodable_head_is_rejected(tmp_path):
    root = tmp_path / "r"
    (root / ".git").mkdir(parents=True)
    (root / ".git" / "HEAD").write_bytes(b"ref: refs/heads/\xff\xfe\xff\n")
    assert workspace_branch(str(root)) is None


def test_oversized_gitdir_pointer_is_rejected(tmp_path):
    wt = tmp_path / "wt"
    wt.mkdir()
    (wt / ".git").write_text("gitdir: /" + "x" * 200000 + "\n", encoding="utf-8")
    assert workspace_branch(str(wt)) is None
