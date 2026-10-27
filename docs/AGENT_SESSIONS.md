# Agent Sessions

Run Claude Code, Codex, GitHub Copilot CLI, OpenCode, GovRun, Hermes or OpenClaw from inside SecureVector
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

### GovRun, Hermes and OpenClaw

These three report their tool calls through their own Guard: GovRun's is built
in, Hermes uses the `securevector-sdk-hermes` plugin, and OpenClaw uses the
SecureVector OpenClaw plugin. A session started in your own terminal shows up
under **Running outside SecureVector** and can be put on the board the same way.

You can also launch them from the app (`govrun`, `hermes`, and `openclaw tui`
in the folder you pick), and continue an earlier session by its id. A session
launched this way is marked ungoverned on the board, because these Guards do not
report to a task the app started. OpenClaw's terminal UI talks to the OpenClaw
Gateway, so its agent works in the Gateway's workspace, not the folder you pick;
its card says so.

The folder shown for a linked GovRun, Hermes or OpenClaw session is the one the
agent reported, and its card says "folder reported by the agent". Before such a
session can be continued here, unlink it and link it again with the folder it runs
in: `sv-monitor session link <agent> <session-id> --folder <path>`.

Known limit: a session launched from the app also appears under **Running
outside SecureVector** once it reports, and linking it adds a second row.

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

The agent names are `claude-code`, `codex`, `copilot-cli`, `opencode`,
`govrun`, `hermes` and `openclaw`.

The command line uses the same local API as the app, so it can do exactly what
the page can and nothing more. You name an agent and a folder; the app decides
how to start it. Each action is recorded in the session's history as coming
from the command line rather than the page.

## Approve and stop sessions from another machine

When the app runs on a server and you open it from a laptop, you can watch runs, governance and costs by its network address. To also approve, deny and revoke held calls and stop sessions from there, turn on **Settings > Remote access** on the machine itself. It is off by default and is offered only when the app listens on a network address.

- Put the app behind a reverse proxy that serves HTTPS. Enter the https address you open it by and the IP address (or range) the proxy connects from. Your proxy must pass the original Host header (nginx: `proxy_set_header Host $host;`). The proxy address cannot be a loopback address: if the proxy runs on this machine, point it at this machine's private IP instead of 127.0.0.1 (nginx: `proxy_pass http://<private-ip>:<port>;`, Caddy: `reverse_proxy <private-ip>:<port>`, where `<port>` is the app's web port, 8741 by default) and list that IP. Requests from this machine itself (agent hooks, the local browser) keep working as before.
- A signed-in remote browser can turn the mode off (never on) after entering the token again. On the machine, restarting with `SECUREVECTOR_REMOTE_ACCESS=off` also keeps it off.
- Turning it on creates an access token. It is shown once: store it in your password manager. Only a salted hash is kept.
- In the browser on the other machine, choose **Sign in for remote access** and paste the token. Approve and Revoke ask for the token again after 10 minutes. From another machine you can allow once or deny; calls held by a rule marked "approve on this device only" are approved on the machine itself.
- If you set `SECUREVECTOR_INGRESS_TOKEN`, your proxy still sends it as before (Authorization or X-Api-Key); the remote session travels in its own header, so both work together.
- Five wrong tokens in a minute lock that address for 15 minutes. Rotating the token or turning the mode off signs out every remote browser.
- Launching, linking and typing into sessions work only on the machine itself in this release.

## Platforms

macOS and Linux run a full terminal. Windows shows the agent's output but is not
a full terminal yet.
