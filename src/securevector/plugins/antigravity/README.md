# SecureVector Guard, Antigravity plugin

Real-time policy enforcement and tamper-evident audit for the tool calls an [Antigravity](https://antigravity.google) agent makes.

This plugin is a third-party integration built on Antigravity's [Hooks](https://antigravity.google/docs/hooks) and [Plugins](https://antigravity.google/docs/plugins) systems. It is built by SecureVector and is **not affiliated with, endorsed by, or sponsored by Google**.

---

## What it does

Antigravity exposes five lifecycle events. This plugin registers three of them.

| Hook | Event | What happens |
|---|---|---|
| `hooks/pre-tool-use.js` | `PreToolUse` | Reads `toolCall.name` and `toolCall.args`, looks the tool up against the rules synced to the local SecureVector app, and returns `{"decision": "allow" \| "deny" \| "force_ask", "reason": "..."}`. A deny also writes its own audit row, because `PostToolUse` never fires for a call that did not run. Network-capable calls are additionally evaluated against the egress policy. Fails open. |
| `hooks/post-tool-use.js` | `PostToolUse` | Fire-and-forget audit row (`runtime_kind: "antigravity"`), plus an outgoing `/analyze` scan for the four tools whose arguments are prose. Returns `{}`. |
| `hooks/pre-invocation.js` | `PreInvocation` | On the session's first invocation only: probes the local app (one-line stderr notice if it is down) and writes a `__session_start__` audit row so the Agent Map shows clean session boundaries. Returns `{}` and never injects steps. |

`PostInvocation` and `Stop` are not registered. Neither carries anything the audit chain needs that the three above do not already provide.

## Two coverage gaps, stated plainly

Both follow from what Antigravity's hook payloads contain, not from anything left undone here.

1. **No prompt scanning.** Antigravity has no event that hands a hook the user's prompt. `PreInvocation`, the only pre-model event, carries `invocationNum`, `initialNumSteps`, `conversationId`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath` and `modelName`, and no prompt text. So prompt-injection and jailbreak attempts typed into the chat are not scanned on this harness, unlike Claude Code (`UserPromptSubmit`) or Cursor (`beforeSubmitPrompt`). Reading the prompt back out of `transcriptPath` was considered and rejected: that file's format is undocumented, and guessing at another product's log schema in order to ship user text to an analyzer is not a trade worth making.

2. **No tool-result scanning, for now.** Antigravity's documented `PostToolUse` payload is the `PreToolUse` payload plus an optional `error` string. It carries no tool RESULT, which is the field the incoming-direction scan reads on the other harnesses. So indirect prompt injection in fetched page content, and credentials appearing in command output, are not detected here. The scan is implemented and dormant: `post-tool-use.js` probes for a result field under several names and lights up automatically if a future Antigravity build sends one.

Tool-call enforcement, egress enforcement, and the full audit chain are unaffected by either gap.

## Fail mode

**SecureVector's invariant is fail-open:** a stopped or unreachable local app must never block your session. Every hook catches every error path, writes explicit valid JSON to stdout, and exits 0.

**Antigravity's own fail mode is not documented.** The first-party hooks page specifies neither exit-code semantics nor what happens when a hook errors, times out, or writes malformed JSON. Because a fail-closed host would turn a down app into a total block, these hooks are written to be correct either way: there is no path, including a stdin parse failure or an unexpected throw, that leaves stdout empty.

## Verified against the docs, not yet against a live CLI

The hook contract here follows the first-party documentation at `antigravity.google/docs/hooks`, `/docs/plugins` and `/docs/sdk/tools`, read on 2026-09-21. The following are **not** yet confirmed against a running `agy` session and should be treated as the plugin's open questions:

- **The MCP tool-name shape.** Not documented anywhere first-party. `lib/normalize.js` therefore generates candidates for every plausible shape (`mcp__server__tool`, `server__tool`, `server.tool`, `server-tool`, and the bare tool name) rather than committing to one and silently failing open on the rest.
- **The fail mode**, as above.
- **Whether `agy plugin disable` writes a registry** that records enabled state. The docs describe plugin discovery by directory presence and name no such file, so the installer writes none and treats presence as enabled.
- **Whether `hooks.json` at the plugin root is picked up** without a further declaration in `plugin.json`. The documented plugin layout puts it there as an optional sibling of `plugin.json`, which is what this plugin does.

## Governed tools

The twelve built-ins below are the governance surface, taken from the first-party built-in tool reference. Any name that is not one of them is treated as a potentially MCP-provided tool and is still audited and enforceable.

| Tool | Risk | What it does |
|---|---|---|
| `run_command` | admin | Execute a shell command |
| `start_subagent` | admin | Invoke a child subagent |
| `search_web` | admin | Perform a web search |
| `read_url_content` | admin | Fetch URL content |
| `generate_image` | admin | Generate or edit images |
| `create_file` | write | Create a new file |
| `edit_file` | write | Edit an existing file |
| `view_file` | read | Read file contents |
| `list_directory` | read | List directory contents |
| `search_directory` | read | Search within files |
| `find_file` | read | Find files by pattern |
| `ask_question` | read | Prompt the user for input |

`finish` is the thirteenth built-in and is deliberately **not** governable. It returns the agent's final output, so denying it cannot prevent anything that has not already happened, and blocking it would leave the session unable to terminate.

## Requirements

- Antigravity with plugin and hook support (CLI binary `agy`)
- Node.js 18+ on PATH (the hook commands run `node`)
- A running local [SecureVector AI Threat Monitor](https://github.com/Secure-Vector/securevector-ai-threat-monitor) app on `http://127.0.0.1:8741` (or override, see Configuration)

## Installation

```bash
# Option A: via the SecureVector app UI
# Open http://127.0.0.1:8741, Integrations, Antigravity, Install Plugin

# Option B: via CLI (runs the same handler in-process)
securevector-app --install-plugin antigravity
```

The installer stages the tree under `~/.securevector/staging/antigravity-plugin/`, then copies it to `~/.gemini/config/plugins/securevector-guard/`, the global plugin directory shared by Antigravity 2.0, the CLI, and the standalone IDE. Antigravity documents no plugin-root environment variable for hook commands, so the installer substitutes the absolute installed path into `hooks.json` at that point.

**Restart Antigravity to activate**, then confirm with `agy plugin list`.

If Antigravity is not installed yet, the plugin is staged only and the install response hands back `agy plugin install <staging dir>` to run later.

Uninstall: `securevector-app --uninstall-plugin antigravity`, which removes both the staged tree and `~/.gemini/config/plugins/securevector-guard/`.

## Verifying it works

1. Confirm SecureVector is running: `curl -fsS http://127.0.0.1:8741/health`
2. Start an Antigravity session and ask the agent to read a file. Within a few seconds the call should appear in the SecureVector **Tool Activity** tab with `runtime_kind=antigravity` and `function_name=view_file`.
3. To verify deny enforcement, set `run_command` to Block in Tool Permissions, then ask the agent to run a shell command. Antigravity should refuse it and surface the branded `SecureVector Guard:` reason.

## Configuration

Set `SECUREVECTOR_ENGINE_ENDPOINT` (legacy alias `SV_BASE_URL`) to point at a non-default **engine**, meaning your local app or a self-hosted deployment, not the SecureVector cloud. The installer also rewrites the default URL at staging time to match your app's actual port.

```bash
export SECUREVECTOR_ENGINE_ENDPOINT="https://<your-engine-endpoint>"
```

`SECUREVECTOR_API_KEY`, when set, is forwarded as `Authorization: Bearer <token>` for a token-gated remote engine.

## License

Apache 2.0. Source at <https://github.com/Secure-Vector/securevector-ai-threat-monitor> under `src/securevector/plugins/antigravity/`.

## Disclaimer

Built by SecureVector. Not affiliated with, endorsed by, or sponsored by Google. "Antigravity" and "Gemini" are product names referenced descriptively to identify the target runtime; they are not used in this plugin's name.
