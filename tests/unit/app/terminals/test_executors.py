"""Tests for governed task execution — the only way a task starts."""

import json
import os
import shlex
import stat
import sys
import types

import pytest

from securevector.app.terminals import executors
from securevector.app.terminals.executors import (
    ENV_NEVER,
    EXECUTORS,
    RELAY_EVENTS,
    ExecutorUnavailable,
    ResumeUnsupported,
    UnknownExecutor,
    build_child_env,
    build_launch,
    hook_command,
    write_hook_settings,
)


def test_allowlist_contains_governed_interactive_executors():
    assert set(EXECUTORS) == {"claude-code", "codex", "copilot-cli", "opencode"}
    assert EXECUTORS["claude-code"].binary == "claude"
    assert EXECUTORS["codex"].binary == "codex"
    assert EXECUTORS["copilot-cli"].binary == "copilot"
    assert EXECUTORS["opencode"].binary == "opencode"


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


def test_copilot_cli_and_opencode_launch_have_no_claude_only_flags_and_pin_the_engine_endpoint(
    tmp_path,
):
    """Neither harness accepts Claude Code's --settings / --plugin-dir flags."""
    tmp_bin = tmp_path / "bin"
    tmp_bin.mkdir()
    for name in ("copilot", "opencode"):
        binary = tmp_bin / name
        binary.write_text("#!/bin/sh\nexit 0\n")
        binary.chmod(binary.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    ws = tmp_path / "proj"
    ws.mkdir()
    for executor_id, binary_name in (("copilot-cli", "copilot"), ("opencode", "opencode")):
        launch = build_launch(
            executor_id,
            workspace=ws,
            task_dir=tmp_path / "task",
            port=8899,
            task_id="t",
            hook_token="k",
            parent_env={"PATH": str(tmp_bin)},
            plugin_dir=None,
        )
        assert os.path.basename(launch.argv[0]) == binary_name
        assert "--settings" not in launch.argv and "--plugin-dir" not in launch.argv
        assert launch.env["SECUREVECTOR_ENGINE_ENDPOINT"] == "http://127.0.0.1:8899"
        assert launch.env["SV_TERMINAL_TASK_ID"] == "t"


PARENT_WITH_HARNESS_AUTH = {
    "PATH": "/usr/bin",
    "GH_TOKEN": "gh",
    "GITHUB_TOKEN": "ght",
    "COPILOT_HOME": "/Users/x/.copilot",
    "OPENCODE_CONFIG": "/Users/x/opencode.json",
    "OPENCODE_CONFIG_DIR": "/Users/x/.config/opencode",
    "OPENAI_API_KEY": "oai",
    "XDG_STATE_HOME": "/Users/x/.local/state",
    "FOO_SECRET": "no",
}


def _child_env_for(executor_id):
    return build_child_env(
        PARENT_WITH_HARNESS_AUTH,
        task_id="t1",
        port=8741,
        hook_token="tok",
        executor=EXECUTORS[executor_id],
    )


def test_harness_auth_vars_are_per_executor_not_global():
    """A Copilot token must never reach an unrelated harness's child."""
    copilot = _child_env_for("copilot-cli")
    for name in ("GH_TOKEN", "GITHUB_TOKEN", "COPILOT_HOME"):
        assert copilot[name] == PARENT_WITH_HARNESS_AUTH[name]
    assert "OPENAI_API_KEY" not in copilot
    assert "OPENCODE_CONFIG" not in copilot

    opencode = _child_env_for("opencode")
    assert opencode["OPENCODE_CONFIG"] == PARENT_WITH_HARNESS_AUTH["OPENCODE_CONFIG"]
    assert opencode["OPENAI_API_KEY"] == PARENT_WITH_HARNESS_AUTH["OPENAI_API_KEY"]
    assert "GH_TOKEN" not in opencode
    assert "COPILOT_HOME" not in opencode

    codex = _child_env_for("codex")
    assert codex["OPENAI_API_KEY"] == PARENT_WITH_HARNESS_AUTH["OPENAI_API_KEY"]
    assert "GH_TOKEN" not in codex
    assert "OPENCODE_CONFIG" not in codex

    claude = _child_env_for("claude-code")
    for name in ("GH_TOKEN", "GITHUB_TOKEN", "COPILOT_HOME", "OPENCODE_CONFIG", "OPENAI_API_KEY"):
        assert name not in claude


def test_child_env_admits_the_shared_state_root_but_not_unknown_secrets():
    env = _child_env_for("opencode")
    assert env["XDG_STATE_HOME"] == PARENT_WITH_HARNESS_AUTH["XDG_STATE_HOME"]
    assert "FOO_SECRET" not in env
    # The OpenCode gate inspects OPENCODE_CONFIG and XDG_CONFIG_HOME only, so
    # OPENCODE_CONFIG_DIR must never reach the child under any executor.
    for executor_id in EXECUTORS:
        assert "OPENCODE_CONFIG_DIR" not in _child_env_for(executor_id)


def test_env_extra_is_declared_per_executor():
    assert EXECUTORS["claude-code"].env_extra == ()
    assert EXECUTORS["codex"].env_extra == ("OPENAI_API_KEY",)
    assert EXECUTORS["copilot-cli"].env_extra == ("COPILOT_HOME", "GH_TOKEN", "GITHUB_TOKEN")
    assert EXECUTORS["opencode"].env_extra == ("OPENCODE_CONFIG", "OPENAI_API_KEY")


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


# --- resume: reopening a session the app did not start ----------------------
#
# A live PTY cannot be handed between processes, so the only way a session
# someone began in their own terminal ends up governed here is for the harness
# to reopen it by id on a PTY this host owns. The client names the session; the
# host still decides every argument.

_RESUME_ID = "sess-0123456789abcdef"


def _resume_launch(executor_id, tmp_path, *, resume_session_id=_RESUME_ID, plugin_dir=None):
    ws = tmp_path / "proj"
    ws.mkdir(exist_ok=True)
    return build_launch(
        executor_id,
        workspace=ws,
        task_dir=tmp_path / "task",
        port=8741,
        task_id="t",
        hook_token="k",
        parent_env={"PATH": "/bin"},
        plugin_dir=plugin_dir,
        resume_session_id=resume_session_id,
    )


def test_resume_argv_is_declared_only_for_harnesses_that_reopen_a_named_session():
    assert EXECUTORS["claude-code"].resume_argv == ("--resume", "{session_id}")
    assert EXECUTORS["codex"].resume_argv == ("resume", "{session_id}")
    assert EXECUTORS["copilot-cli"].resume_argv == ("--resume", "{session_id}")
    # OpenCode only has --continue, which takes the most recent session rather
    # than a named one. Resuming the wrong conversation silently is worse than
    # not offering resume at all.
    assert EXECUTORS["opencode"].resume_argv == ()


def test_claude_code_resume_flag_follows_the_governance_flags(tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda binary, path=None: "/usr/local/bin/claude")
    launch = _resume_launch("claude-code", tmp_path, plugin_dir=tmp_path / "plugin")
    assert launch.argv == [
        "/usr/local/bin/claude",
        "--settings",
        str(tmp_path / "task" / "settings.json"),
        "--plugin-dir",
        str(tmp_path / "plugin"),
        "--resume",
        _RESUME_ID,
    ]


def test_codex_resume_is_a_subcommand_and_comes_first(tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda binary, path=None: "/usr/local/bin/codex")
    launch = _resume_launch("codex", tmp_path)
    # `codex resume <id>`: a subcommand, so anything in front of it would be
    # parsed as a flag of the root command instead.
    assert launch.argv == ["/usr/local/bin/codex", "resume", _RESUME_ID]


def test_copilot_cli_resume_is_a_flag(tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda binary, path=None: "/usr/local/bin/copilot")
    launch = _resume_launch("copilot-cli", tmp_path)
    assert launch.argv == ["/usr/local/bin/copilot", "--resume", _RESUME_ID]


def test_opencode_resume_is_refused_rather_than_launched_without_it(tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda binary, path=None: "/usr/local/bin/opencode")
    with pytest.raises(ResumeUnsupported) as exc:
        _resume_launch("opencode", tmp_path)
    assert "OpenCode" in str(exc.value)
    assert issubclass(ResumeUnsupported, ValueError)


def test_no_resume_id_leaves_every_harness_argv_exactly_as_it_was(tmp_path, monkeypatch):
    """The default path is the one nearly every launch takes; it must not move."""
    monkeypatch.setattr("shutil.which", lambda binary, path=None: "/usr/local/bin/x")
    for executor_id in ("claude-code", "codex", "copilot-cli", "opencode"):
        argv = _resume_launch(executor_id, tmp_path, resume_session_id=None).argv
        expected = ["/usr/local/bin/x"]
        if executor_id == "claude-code":
            expected += ["--settings", str(tmp_path / "task" / "settings.json")]
        assert argv == expected, executor_id
        # An empty string is not a resume request either: no argv, no refusal.
        assert _resume_launch(executor_id, tmp_path, resume_session_id="").argv == expected
