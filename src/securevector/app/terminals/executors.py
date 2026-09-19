"""Governed spawn: the only way a task starts.

A client names an executor id and a folder. The host builds argv, the child
environment (allowlist, never a denylist) and the hook settings file. Client
supplied argv or env never exist as a concept here.

The --settings flag is additive: the workspace's own project settings and
.mcp.json still load, as they would for a hand-run Claude Code session.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import sys
import types
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from securevector.app.terminals import hook_relay
from securevector.app.terminals.pty_host import Launch


class UnknownExecutor(ValueError):
    """Executor id is not in the allowlist."""


class ExecutorUnavailable(RuntimeError):
    """The executor binary is not installed or not on PATH."""


class ResumeUnsupported(ValueError):
    """This harness cannot reopen a named session, so resume is refused.

    A ValueError so the routes layer maps it to a 400 alongside the other
    "the client asked for something this host will not do" cases.
    """


@dataclass(frozen=True)
class Executor:
    id: str
    label: str
    binary: str
    extra_args: tuple[str, ...] = ()
    # Claude Code accepts an additive --settings file and a per-launch plugin
    # directory. Codex loads its Guard plugin from its own trusted plugin
    # registry, so passing Claude-only flags would silently break the launch.
    supports_terminal_settings: bool = False
    # How this harness reopens a session by id. Empty means it cannot, and
    # resume is then never offered: OpenCode's --continue takes the most
    # recent session rather than a named one, and silently resuming the
    # wrong conversation is worse than not offering it.
    resume_argv: tuple[str, ...] = ()
    # Harness-specific auth and config names, admitted only for THIS
    # executor's child. Kept off the global allowlist so a Copilot token or an
    # OpenAI key is never handed to an unrelated harness's process.
    env_extra: tuple[str, ...] = ()


_EXECUTORS: dict[str, Executor] = {
    "claude-code": Executor(
        id="claude-code",
        label="Claude Code",
        binary="claude",
        resume_argv=("--resume", "{session_id}"),
        supports_terminal_settings=True,
    ),
    "codex": Executor(
        id="codex",
        label="Codex",
        binary="codex",
        # A subcommand, not a flag: `codex resume <id>`.
        resume_argv=("resume", "{session_id}"),
        env_extra=("OPENAI_API_KEY",),
    ),
    "copilot-cli": Executor(
        id="copilot-cli",
        label="GitHub Copilot CLI",
        binary="copilot",
        resume_argv=("--resume", "{session_id}"),
        env_extra=("COPILOT_HOME", "GH_TOKEN", "GITHUB_TOKEN"),
    ),
    "opencode": Executor(
        id="opencode",
        label="OpenCode",
        binary="opencode",
        env_extra=("OPENCODE_CONFIG", "OPENAI_API_KEY"),
    ),
}
EXECUTORS = types.MappingProxyType(_EXECUTORS)

# Claude Code hook events the relay forwards. Matcher ".*" for the tool
# events, no matcher for the lifecycle ones (Claude Code rejects a matcher
# there).
RELAY_EVENTS = (
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Notification",
    "Stop",
)
_MATCHED_EVENTS = {"PreToolUse", "PostToolUse"}

# Child env allowlist. Exact names plus prefixes for the families the
# harness documents (locale, Anthropic auth, cloud provider auth for
# Bedrock/Vertex, proxy/CA for corporate networks). Never a denylist: anything
# not listed does not reach the task, so a new harness-nesting marker cannot
# leak in. CLAUDE_CODE_* family also carries live session and IPC-token
# markers from a parent harness (MESSAGING_SOCKET, MESSAGING_TOKEN, SESSION_ID,
# CHILD_SESSION, EXECPATH, BRIDGE_SESSION_ID), so no prefix — only whitelisted
# exact names are admitted.
ENV_ALLOW = frozenset(
    {
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "TMPDIR",
        "LANG",
        "COLORTERM",
        "SSH_AUTH_SOCK",
        "CLAUDE_CONFIG_DIR",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_RUNTIME_DIR",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
        "CLAUDE_CODE_SKIP_AUTO_INSTALL",
        "CODEX_HOME",
        # Harness-agnostic state root. OPENCODE_CONFIG_DIR is deliberately
        # absent: the app's OpenCode gate inspects only OPENCODE_CONFIG and
        # XDG_CONFIG_HOME, so forwarding it would let the child load a config
        # the gate never checked.
        "XDG_STATE_HOME",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
    }
)
ENV_ALLOW_PREFIXES = ("LC_", "ANTHROPIC_", "AWS_", "GOOGLE_", "CLOUD_ML_")
# Belt and braces: never admitted even if a future allowlist or prefix edit
# would let them through. These mark "already inside a harness" and make
# Claude Code refuse to start or change its behaviour.
ENV_NEVER = frozenset({"CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"})


def build_child_env(
    parent: Mapping[str, str],
    *,
    task_id: str,
    port: int,
    hook_token: str,
    executor: Executor | None = None,
) -> dict[str, str]:
    allowed = ENV_ALLOW if executor is None else ENV_ALLOW | frozenset(executor.env_extra)
    env: dict[str, str] = {}
    for key, value in parent.items():
        if key in ENV_NEVER:
            continue
        if key in allowed or key.startswith(ENV_ALLOW_PREFIXES):
            env[key] = value
    env["TERM"] = "xterm-256color"
    env["SV_TERMINAL_TASK_ID"] = task_id
    env["SV_TERMINAL_PORT"] = str(port)
    env["SV_TERMINAL_HOOK_TOKEN"] = hook_token
    # The installed Codex plugin honours this existing engine-endpoint
    # contract. Pin it to this app instance rather than relying on its 8741
    # default, which would misroute a terminal launched on a custom port.
    env["SECUREVECTOR_ENGINE_ENDPOINT"] = f"http://127.0.0.1:{port}"
    return env


def hook_command() -> list[str]:
    """How the task invokes the relay: the frozen app binary has a
    ``terminal-hook`` subcommand; in dev it is the module."""
    if getattr(sys, "frozen", False):
        return [sys.executable, "terminal-hook"]
    # Not `-m securevector.app.terminals.hook_relay`: the child env carries
    # no PYTHONPATH, so `-m` would resolve against whatever site-packages
    # copy happens to be on the interpreter's default path, not this
    # checkout. The relay's own file path is unambiguous.
    return [sys.executable, str(Path(hook_relay.__file__))]


def write_hook_settings(task_dir: Path, command: list[str]) -> Path:
    # parents=True leaves intermediate directories at umask default; only the leaf is 0o700.
    task_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name == "posix":
        os.chmod(task_dir, 0o700)
    # POSIX quoting; the Windows streams release must switch to subprocess.list2cmdline.
    cmd = shlex.join(command)
    hooks: dict[str, list[dict[str, object]]] = {}
    for event in RELAY_EVENTS:
        entry: dict[str, object] = {"hooks": [{"type": "command", "command": cmd, "timeout": 5}]}
        if event in _MATCHED_EVENTS:
            entry = {"matcher": ".*", **entry}
        hooks[event] = [entry]
    payload = json.dumps({"hooks": hooks}, indent=2)
    path = task_dir / "settings.json"
    if os.name == "posix":

        def _opener(p, flags):
            return os.open(p, flags | os.O_NOFOLLOW, 0o600)

        with open(path, "w", encoding="utf-8", opener=_opener) as fh:
            fh.write(payload)
        os.chmod(path, 0o600)
    else:
        path.write_text(payload, encoding="utf-8")
    return path


def build_launch(
    executor_id: str,
    *,
    workspace: Path,
    task_dir: Path,
    port: int,
    task_id: str,
    hook_token: str,
    parent_env: Mapping[str, str],
    plugin_dir: Optional[Path],
    resume_session_id: Optional[str] = None,
) -> Launch:
    executor = EXECUTORS.get(executor_id)
    if executor is None:
        raise UnknownExecutor(f"unknown executor id: {executor_id[:64]!r}")
    resume_args: list[str] = []
    if resume_session_id:
        if not executor.resume_argv:
            raise ResumeUnsupported(f"{executor.label} cannot reopen a session by id.")
        resume_args = [part.format(session_id=resume_session_id) for part in executor.resume_argv]
    # Codex spells resume as a SUBCOMMAND (`codex resume <id>`), not a flag, so
    # it has to sit immediately after the binary: anything in front of it would
    # be parsed as a flag of the root command instead. A flag form (Claude Code,
    # Copilot CLI) is position independent and goes last, after the settings
    # flags this host already owns.
    subcommand = bool(resume_args) and not resume_args[0].startswith("-")
    if subcommand and (executor.supports_terminal_settings or executor.extra_args):
        # A subcommand takes the argv that follows it, so the flags this host
        # adds for its own governance would land on the subcommand rather than
        # the root command. Refusing beats emitting a command line that means
        # something other than what was asked for.
        raise ResumeUnsupported(
            f"{executor.label} cannot reopen a session by id and stay governed."
        )
    workspace = Path(workspace).expanduser()
    try:
        workspace = workspace.resolve(strict=True)
    except OSError as exc:
        raise NotADirectoryError(str(workspace)) from exc
    if not workspace.is_dir():
        raise NotADirectoryError(str(workspace))
    env = build_child_env(
        parent_env, task_id=task_id, port=port, hook_token=hook_token, executor=executor
    )
    child_path = env.get("PATH")
    if not child_path:
        raise ExecutorUnavailable(f"{executor.label} cannot be resolved: no PATH for the task")
    resolved = shutil.which(executor.binary, path=child_path)
    if resolved is None:
        raise ExecutorUnavailable(f"{executor.label} is not installed")
    argv = [resolved]
    if subcommand:
        argv += resume_args
    if executor.supports_terminal_settings:
        settings = write_hook_settings(task_dir, hook_command())
        argv += ["--settings", str(settings)]
        if plugin_dir is not None:
            argv += ["--plugin-dir", str(plugin_dir)]
    argv += list(executor.extra_args)
    if resume_args and not subcommand:
        argv += resume_args
    return Launch(argv=argv, env=env, cwd=str(workspace))
