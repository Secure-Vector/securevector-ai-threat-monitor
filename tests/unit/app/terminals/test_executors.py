"""Tests for governed task execution — the only way a task starts."""

import json
import os
import shlex
import sys
import types

import pytest

from securevector.app.terminals import executors
from securevector.app.terminals.executors import (
    ENV_NEVER,
    EXECUTORS,
    RELAY_EVENTS,
    ExecutorUnavailable,
    UnknownExecutor,
    build_child_env,
    build_launch,
    hook_command,
    write_hook_settings,
)


def test_allowlist_contains_governed_interactive_executors():
    assert set(EXECUTORS) == {"claude-code", "codex"}
    assert EXECUTORS["claude-code"].binary == "claude"
    assert EXECUTORS["codex"].binary == "codex"


def test_child_env_is_allowlisted_and_scrubs_harness_nesting():
    parent = {
        "PATH": "/usr/bin",
        "HOME": "/Users/x",
        "LANG": "en_US.UTF-8",
        "LC_ALL": "C",
        "ANTHROPIC_API_KEY": "k",
        "CLAUDE_CODE_USE_BEDROCK": "1",
        "CLAUDECODE": "1",
        "CLAUDE_CODE_ENTRYPOINT": "cli",
        "SECUREVECTOR_INGRESS_TOKEN": "secret",
        "AWS_PROFILE": "dev",
        "RANDOM_THING": "no",
    }
    env = build_child_env(parent, task_id="t1", port=8741, hook_token="tok")
    assert set(env) == {
        "PATH",
        "HOME",
        "LANG",
        "LC_ALL",
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_USE_BEDROCK",
        "AWS_PROFILE",
        "TERM",
        "SV_TERMINAL_TASK_ID",
        "SV_TERMINAL_PORT",
        "SV_TERMINAL_HOOK_TOKEN",
        "SECUREVECTOR_ENGINE_ENDPOINT",
    }
    assert env["SECUREVECTOR_ENGINE_ENDPOINT"] == "http://127.0.0.1:8741"


@pytest.mark.parametrize("never", sorted(ENV_NEVER))
def test_env_never_wins_over_the_allowlist(never, monkeypatch):
    monkeypatch.setattr(executors, "ENV_ALLOW", executors.ENV_ALLOW | {never})
    assert never not in build_child_env({never: "1"}, task_id="t", port=1, hook_token="k")


def test_parent_harness_ipc_markers_do_not_reach_the_task():
    parent = {
        "CLAUDE_CODE_MESSAGING_SOCKET": "/tmp/s",
        "CLAUDE_CODE_MESSAGING_TOKEN": "t",
        "CLAUDE_CODE_SESSION_ID": "s",
        "CLAUDE_CODE_CHILD_SESSION": "1",
    }
    env = build_child_env(parent, task_id="t", port=1, hook_token="k")
    assert "CLAUDE_CODE_MESSAGING_SOCKET" not in env
    assert "CLAUDE_CODE_MESSAGING_TOKEN" not in env
    assert "CLAUDE_CODE_SESSION_ID" not in env
    assert "CLAUDE_CODE_CHILD_SESSION" not in env


def test_hook_settings_file_registers_every_relay_event(tmp_path):
    path = write_hook_settings(
        tmp_path, ["/usr/bin/python3", "-m", "securevector.app.terminals.hook_relay"]
    )
    data = json.loads(path.read_text())
    assert set(data["hooks"]) == set(RELAY_EVENTS)
    for event in RELAY_EVENTS:
        entry = data["hooks"][event][0]
        hook = entry["hooks"][0]
        assert hook["type"] == "command"
        assert hook["timeout"] == 5
        assert ("matcher" in entry) == (event in {"PreToolUse", "PostToolUse"})
    cmd = data["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
    assert cmd.startswith("/usr/bin/python3 -m securevector.app.terminals.hook_relay")


def test_hook_command_dev_and_frozen(monkeypatch):
    monkeypatch.delattr(sys, "frozen", raising=False)
    cmd = hook_command()
    assert cmd[0] == sys.executable
    assert len(cmd) == 2 and cmd[1].endswith("hook_relay.py")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    assert hook_command() == [sys.executable, "terminal-hook"]


def test_hook_command_is_shell_safe(tmp_path):
    path = write_hook_settings(tmp_path, ["/opt/My Apps/python3", "-m", "x"])
    data = json.loads(path.read_text())
    cmd = data["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
    assert shlex.split(cmd) == ["/opt/My Apps/python3", "-m", "x"]


def test_build_launch_for_claude_code(tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda binary, path=None: "/usr/local/bin/claude")
    ws = tmp_path / "proj"
    ws.mkdir()
    task_dir = tmp_path / "task"
    launch = build_launch(
        "claude-code",
        workspace=ws,
        task_dir=task_dir,
        port=8741,
        task_id="t1",
        hook_token="tok",
        parent_env={"PATH": "/bin"},
        plugin_dir=tmp_path / "plugin",
    )
    assert launch.argv[0] == "/usr/local/bin/claude"
    assert launch.argv[1:3] == ["--settings", str(task_dir / "settings.json")]
    assert launch.argv[3:5] == ["--plugin-dir", str(tmp_path / "plugin")]
    assert launch.cwd == str(ws.resolve())
    assert launch.env["SV_TERMINAL_TASK_ID"] == "t1"
    assert (task_dir / "settings.json").exists()
    if os.name == "posix":
        assert oct(task_dir.stat().st_mode & 0o777) == "0o700"
        assert oct((task_dir / "settings.json").stat().st_mode & 0o777) == "0o600"


def test_build_launch_without_plugin_dir_omits_flag(tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda binary, path=None: "/usr/local/bin/claude")
    ws = tmp_path / "proj"
    ws.mkdir()
    launch = build_launch(
        "claude-code",
        workspace=ws,
        task_dir=tmp_path / "task",
        port=1,
        task_id="t",
        hook_token="k",
        parent_env={"PATH": "/bin"},
        plugin_dir=None,
    )
    assert "--plugin-dir" not in launch.argv


def test_build_launch_workspace_symlink_resolves_to_target(tmp_path, monkeypatch):
    if os.name != "posix":
        pytest.skip("symlinks are posix-only")
    monkeypatch.setattr("shutil.which", lambda binary, path=None: "/usr/local/bin/claude")
    target = tmp_path / "target"
    target.mkdir()
    link = tmp_path / "link"
    os.symlink(target, link)
    launch = build_launch(
        "claude-code",
        workspace=link,
        task_dir=tmp_path / "task",
        port=1,
        task_id="t",
        hook_token="k",
        parent_env={"PATH": "/bin"},
        plugin_dir=None,
    )
    assert launch.cwd == str(target.resolve())


def test_codex_launch_has_no_claude_only_flags_and_pins_the_engine_endpoint(tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda binary, path=None: "/usr/local/bin/codex")
    ws = tmp_path / "proj"
    ws.mkdir()
    launch = build_launch(
        "codex", workspace=ws, task_dir=tmp_path / "task", port=8899,
        task_id="t", hook_token="k", parent_env={"PATH": "/bin"}, plugin_dir=None,
    )
    assert launch.argv == ["/usr/local/bin/codex"]
    assert launch.env["SECUREVECTOR_ENGINE_ENDPOINT"] == "http://127.0.0.1:8899"


def test_build_launch_workspace_file_raises_not_a_directory(tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda binary, path=None: "/usr/local/bin/claude")
    file_path = tmp_path / "file"
    file_path.touch()
    with pytest.raises(NotADirectoryError):
        build_launch(
            "claude-code",
            workspace=file_path,
            task_dir=tmp_path / "task",
            port=1,
            task_id="t",
            hook_token="k",
            parent_env={"PATH": "/bin"},
            plugin_dir=None,
        )


def test_build_launch_raises_when_binary_missing(tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda binary, path=None: None)
    ws = tmp_path / "proj"
    ws.mkdir()
    with pytest.raises(ExecutorUnavailable):
        build_launch(
            "claude-code",
            workspace=ws,
            task_dir=tmp_path / "task",
            port=1,
            task_id="t",
            hook_token="k",
            parent_env={"PATH": "/bin"},
            plugin_dir=None,
        )


def test_build_launch_rejects_unknown_executor(tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda binary, path=None: "/usr/local/bin/bash")
    ws = tmp_path / "proj"
    ws.mkdir()
    with pytest.raises(UnknownExecutor):
        build_launch(
            "bash",
            workspace=ws,
            task_dir=tmp_path / "task",
            port=1,
            task_id="t",
            hook_token="k",
            parent_env={"PATH": "/bin"},
            plugin_dir=None,
        )


def test_build_launch_missing_workspace_raises_before_binary_check(tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda binary, path=None: None)
    with pytest.raises(NotADirectoryError):
        build_launch(
            "claude-code",
            workspace=tmp_path / "missing",
            task_dir=tmp_path / "task",
            port=1,
            task_id="t",
            hook_token="k",
            parent_env={"PATH": "/bin"},
            plugin_dir=None,
        )


def test_extra_args_are_appended_after_flags(tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda binary, path=None: "/usr/local/bin/claude")
    from securevector.app.terminals.executors import Executor

    monkeypatch.setattr(
        executors,
        "EXECUTORS",
        types.MappingProxyType(
            {"x": Executor(id="x", label="X", binary="claude", extra_args=("--foo",))}
        ),
    )
    ws = tmp_path / "proj"
    ws.mkdir()
    launch = build_launch(
        "x",
        workspace=ws,
        task_dir=tmp_path / "task",
        port=1,
        task_id="t",
        hook_token="k",
        parent_env={"PATH": "/bin"},
        plugin_dir=None,
    )
    assert launch.argv[-1] == "--foo"


def test_build_launch_raises_without_path(tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda binary, path=None: "/usr/local/bin/claude")
    ws = tmp_path / "proj"
    ws.mkdir()
    with pytest.raises(ExecutorUnavailable):
        build_launch(
            "claude-code",
            workspace=ws,
            task_dir=tmp_path / "task",
            port=1,
            task_id="t",
            hook_token="k",
            parent_env={},
            plugin_dir=None,
        )


def test_unknown_executor_is_value_error():
    assert issubclass(UnknownExecutor, ValueError)
