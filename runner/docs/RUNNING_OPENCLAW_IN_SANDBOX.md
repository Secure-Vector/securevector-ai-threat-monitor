# Running OpenClaw in the SecureVector Sandbox

This guide shows how to run OpenClaw agents inside the sv-sandbox sandbox.

## Prerequisites

- OpenClaw installed ([docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started))
- Node.js 22.14+ or 24
- sv-sandbox binary built (`cd runner && make build`)
- An LLM provider API key (OpenAI, Anthropic, etc.)

## Quick Start

```bash
# Run OpenClaw agent with a single task
sv-sandbox --timeout 60s --allow-env OPENAI_API_KEY \
  -- openclaw agent --agent main -m "find recent critical CVEs"

# Run OpenClaw interactive TUI (no timeout)
sv-sandbox --timeout 0 --allow-env OPENAI_API_KEY \
  -- openclaw tui

# Run OpenClaw gateway
sv-sandbox --timeout 300s --allow-env OPENAI_API_KEY \
  -- openclaw gateway
```

## What Happens

When you run OpenClaw inside sv-sandbox:

```
sv-sandbox creates:
  /tmp/sv-session-abc123/          ← isolated workspace

sv-sandbox rewrites env vars:
  HOME=/tmp/sv-session-abc123      ← was /home/you
  OPENCLAW_HOME=/tmp/sv-session-abc123
  OPENCLAW_STATE_DIR=/tmp/sv-session-abc123
  OPENCLAW_CONFIG_PATH=/tmp/sv-session-abc123
  OPENAI_API_KEY=sk-xxx            ← kept (via --allow-env)
  PATH=/usr/bin:...                ← kept (node must be accessible)

sv-sandbox strips:
  AWS_SECRET_ACCESS_KEY            ← removed
  SSH_AUTH_SOCK                    ← removed
  GITHUB_TOKEN                     ← removed
  DATABASE_URL                     ← removed

sv-sandbox then execs:
  openclaw agent --agent main -m "find recent critical CVEs"
  inside /tmp/sv-session-abc123/
  with the filtered env vars
```

OpenClaw runs normally — it reads `OPENAI_API_KEY` from env, talks to the LLM, executes tools. But:

- All file writes go to the sandbox workspace, not your host filesystem
- HOME points to the workspace, so OpenClaw state stays isolated
- Dangerous env vars (cloud credentials, SSH keys, database URLs) are stripped
- The process is killed if it exceeds the timeout

## What OpenClaw Can Do Inside the Sandbox

| Action | Result |
|---|---|
| Read files in workspace | Allowed |
| Write files in workspace | Allowed |
| Execute shell commands | Allowed (runs in workspace) |
| Access LLM API | Allowed (via --allow-env for API key) |
| Read ~/.ssh/id_rsa | Blocked (HOME is rewritten to workspace) |
| Access AWS credentials | Blocked (env vars stripped) |
| Write to /home/you/ | Phase 1: possible (no OS isolation yet). Phase 2+: blocked by landlock |

## Phase 1 Limitations

In Phase 1, sv-sandbox provides:
- Workspace isolation (separate temp directory)
- Environment variable filtering (strips secrets)
- Timeout enforcement (kills process group)
- Output capture

It does NOT yet provide:
- Filesystem access control (landlock/seccomp — Phase 2)
- Network isolation (netns — Phase 2)
- Resource limits (cgroups — Phase 2)

This means in Phase 1, OpenClaw could technically still access host files outside the workspace if it uses absolute paths. The env rewriting and HOME redirection prevent most access patterns, but it is not a hard security boundary yet.

## Using with Anthropic

```bash
sv-sandbox --timeout 60s --allow-env ANTHROPIC_API_KEY \
  -- openclaw agent --agent main -m "analyze this codebase"
```

## Using with Multiple API Keys

```bash
sv-sandbox --timeout 60s --allow-env OPENAI_API_KEY,ANTHROPIC_API_KEY \
  -- openclaw agent --agent main -m "compare models on this task"
```

## Keeping Workspace for Review

```bash
sv-sandbox --timeout 60s --keep --allow-env OPENAI_API_KEY \
  -- openclaw agent --agent main -m "write a security report"

# After completion, review the output:
ls /tmp/sv-session-xxx/
cat /tmp/sv-session-xxx/report.md
```

## JSON Output (for programmatic use)

```bash
sv-sandbox --json --timeout 60s --allow-env OPENAI_API_KEY \
  -- openclaw agent --agent main -m "hello"

# Output:
# {
#   "exit_code": 0,
#   "stdout": "...",
#   "stderr": "...",
#   "workspace": "/tmp/sv-session-xxx",
#   "duration_ms": 12345,
#   "timed_out": false
# }
```

