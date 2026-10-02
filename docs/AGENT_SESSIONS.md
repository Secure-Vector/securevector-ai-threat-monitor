# Agent Sessions

Run Claude Code, Codex, GitHub Copilot CLI or OpenCode from inside SecureVector
and see what the agent does while it works: every tool call, whether it was
allowed or blocked, which websites it reached, and how much context it has used.

You do not write any code for this. You need the app and one plugin per agent.

## Before you start

1. **Install and open the app.**

   ```bash
   pip install "securevector-ai-monitor[app]"
   securevector-app --web
   ```

   Or from npm, if you have Python 3.10 or newer on your PATH:

   ```bash
   npx @securevector/cli
   ```

   The app opens at [http://localhost:8741](http://localhost:8741).

2. **Install the Guard plugin for your agent.** In the app, click
   **Connect Agents**, pick your agent, and click **Install Plugin**. Then
   restart the agent (in Claude Code, run `/reload-plugins`).

   The plugin is what lets SecureVector see and check each tool call. An agent
   cannot be launched from SecureVector until its plugin is installed, so a
   session never starts unwatched by accident. Keep the app running: if it
   stops, agents carry on but their calls are no longer checked.

## Launch a session from the app

1. Click **Agents** in the left rail.
2. Click **+ Launch**.
3. Pick the agent, pick the folder it should work in, and give it a name if you
   like.
4. Click **Launch task**.

The agent starts in a terminal inside the app. Type into it the way you would in
your own terminal. Closing the window does not stop it; open **Agents** again to
come back.

**Run two side by side:** with a session open, click **+** in the tab bar to
launch another. Then drag one tab to the left or right edge of the pane to
split it.

## What you see beside the terminal

| Section | What it shows |
|---|---|
| **Tool calls** | Every tool call the agent made, and whether it was allowed or blocked, with the rule that decided |
| **Traces** | The full detail of each call |
| **Egress** | Every outside host the session contacted |
| **Context & cost** | How full the context window is, and a **Compact now** button |
| **Approval inbox** | Requests from calls a rule blocked. Approve one and the agent can retry that call for the time you choose |

A blocked call or a waiting request opens its section on its own, so you do not
have to look for it.

## Sessions you started in your own terminal

You do not have to launch from the app. If you start Claude Code in your own
terminal and its plugin is installed, the session appears under **Running
outside SecureVector** as soon as it makes a tool call. Its calls are already being checked by the
plugin; click **Govern** to put it on the board with the others so you can see
and manage it there.

From there you can:

- **Continue this session here:** reopen the same conversation in a terminal inside the app.
- **Start a new session here:** a fresh session in the same folder.
- **Unlink:** take it off the board. The agent keeps running, and its history is
  kept.

The app asks before continuing or starting a new session when the other terminal
may still be open, because two agents editing the same folder can overwrite each
other's work.

### "Unverified"

If an agent is still running but has stopped reporting tool calls, its session
is marked **unverified**. That means the agent is alive but SecureVector is not
currently seeing what it does, which is different from an agent that is simply
idle.

## Launch and manage sessions from the command line

Everything above also works from a terminal. With pip the command is
`sv-monitor session`; with npm it is `securevector monitor session`. They are the
same command.

```bash
# With npm, replace sv-monitor session with: securevector monitor session

# See what can be launched, and whether each agent's plugin is installed
sv-monitor session harnesses

# Launch Claude Code in a folder (the folder defaults to where you are)
sv-monitor session launch claude-code ~/projects/my-app --title "refactor"

# Reopen an earlier Claude Code conversation instead of starting fresh
sv-monitor session launch claude-code ~/projects/my-app --resume <session-id>

# List every session on the board
sv-monitor session list

# Sessions that are reporting in but are not on the board yet
sv-monitor session unlinked

# Put one of those on the board
sv-monitor session link claude-code <session-id>

# Stop a session, or every session the app started
sv-monitor session stop <id>
sv-monitor session stop --all
```

Add `--json` to any command for machine-readable output.

The agent names are `claude-code`, `codex`, `copilot-cli` and `opencode`.

The command line uses the same local API as the app, so it can do exactly what
the page can and nothing more. You name an agent and a folder; the app decides
how to start it. Each action is recorded in the session's history as coming
from the command line rather than the page.

## Platforms

macOS and Linux run a full terminal. Windows shows the agent's output but is not
a full terminal yet.
