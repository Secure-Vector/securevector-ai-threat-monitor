# SecureVector Guard — Cursor plugin

Real-time policy enforcement and tamper-evident audit for the Cursor agent's tool calls, file edits, file reads, and prompts.

This plugin is a third-party integration for [Cursor](https://cursor.com) built on Cursor's [Hooks](https://cursor.com/docs/agent/hooks) system. It is built by SecureVector and is **not affiliated with, endorsed by, or sponsored by Anysphere / Cursor**.

---

## What it does

Cursor splits enforcement across event-typed hooks (not one unified PreToolUse), so this plugin registers nine of them:

| Hook | What happens |
|---|---|
| **beforeShellExecution** | Looks up the synthesized `shell` tool against cloud-pushed deny rules synced to the local SecureVector app. Returns `permission: "deny"` (with branded `user_message` + `agent_message`), `"ask"`, or `"allow"`. Fails open. |
| **beforeMCPExecution** | Same decision pipeline for MCP tools. The server slug is derived from the server's `url`/`command` so a rule can target the exact tool, the cloud `<server>:<tool>` form, or the whole server. Fails open. |
| **afterShellExecution** | Fire-and-forget audit row (`runtime_kind: "cursor"`). Output is scanned via `/analyze` only when it carries a credential shape (marker-gated, like the Copilot plugin's `bash` handling). |
| **afterMCPExecution** | Audit row + unconditional incoming `/analyze` scan of the MCP result — MCP is a third-party trust boundary (indirect prompt injection surface). |
| **afterFileEdit** | Audit row (tool id `edit`, file path + edit count in the preview). Newly written content is scanned only when it carries a credential shape (an agent writing secrets into files is a leak/persistence vector). |
| **beforeSubmitPrompt** | Forwards your prompt to local `/analyze` for injection / jailbreak scanning. Observe-only — always returns `continue: true`; it never blocks your prompt. |
| **beforeReadFile** | Cursor-only surface with no Claude Code / Codex analogue: file content is visible BEFORE the model sees it. v1 is observe-only — credential-shaped content is recorded as a secret exposure (lock badge on the Agent Map) but the read is always allowed. |
| **sessionStart** | Probes the local app (one-line stderr "Guard inactive" note if it's down) and writes a `__session_start__` audit row for clean session boundaries on the Agent Map. |
| **stop** | Writes a `__session_end__` boundary row when an agent loop ends. |

**Fail-open invariant:** a stopped or unreachable SecureVector app must never block your Cursor session. Every hook catches every error path, emits an explicit allow, and exits 0. Cursor's own default is also fail-open (exit codes other than 0/2 proceed), so the two layers agree.

> ⚠️ **Cursor Hooks are beta** (introduced in Cursor 1.7, expanded since). The hook payloads this plugin parses follow the published contract at cursor.com/docs/agent/hooks; the MCP tool-name shape has not yet been verified against a live build the way the Copilot plugin was verified against CLI 1.0.60 — `lib/normalize.js` therefore generates candidates for every plausible shape (`MCP:<tool>`, bare names with event context, `mcp__server__tool` bridge form).

## Requirements

- [Cursor](https://cursor.com) 1.7+ with Hooks support
- Node.js 18+ on PATH (the hook commands run `node`)
- A running local [SecureVector AI Threat Monitor](https://github.com/Secure-Vector/securevector-ai-threat-monitor) app on `http://127.0.0.1:8741` (or override via `SV_BASE_URL`)

## Installation

```bash
# Option A: via the SecureVector app UI
# Open http://127.0.0.1:8741 → Integrations → Cursor → Install Plugin

# Option B: via CLI (runs the same handler in-process)
securevector-app --install-plugin cursor
```

The installer copies this plugin to `~/.cursor/plugins/local/securevector-guard/` (the location Cursor scans for local plugins — a real directory, since Cursor doesn't load symlinked local plugins). The plugin bundles its nine hooks via `.cursor-plugin/plugin.json` → `hooks/hooks.json`, so one install gives **both** the Settings → Plugins entry and the active hooks (Settings → Hooks). If you upgraded from an earlier build, the installer also strips the old global-`~/.cursor/hooks.json` entries (preserving your other hooks, with a one-shot `.before-securevector` backup) so hooks don't fire twice. **Reload Cursor to activate.**

Uninstall: `securevector-app --uninstall-plugin cursor` — removes the plugin directory at `~/.cursor/plugins/local/securevector-guard/` (and any legacy global-`hooks.json` entries, preserving your other hooks).

## Verifying it works

1. Confirm SecureVector is running: `curl -fsS http://127.0.0.1:8741/health`
2. Ask the Cursor agent to run any terminal command. Within a few seconds it should appear in the SecureVector **Tool Activity** tab with `runtime_kind=cursor`.
3. To verify deny enforcement, push a cloud-managed deny rule for `shell`, then ask the agent to run a command — Cursor should surface a denial carrying the `SecureVector Guard:` policy reason.

## Configuration

Set `SECUREVECTOR_ENGINE_ENDPOINT` (the unified engine-endpoint variable; legacy alias `SV_BASE_URL`) to point at a non-default **engine** — your local app or a self-hosted / Terraform deployment, not the SecureVector cloud (the installer also rewrites the default URL at staging time to match your app's actual port):

```bash
export SECUREVECTOR_ENGINE_ENDPOINT="https://<your-engine-endpoint>"   # legacy: SV_BASE_URL
```

## License

Apache 2.0. Source at <https://github.com/Secure-Vector/securevector-ai-threat-monitor> under `src/securevector/plugins/cursor/`.

## Disclaimer

Built by SecureVector. Not affiliated with, endorsed by, or sponsored by Anysphere. "Cursor" is a product name referenced descriptively to identify the target runtime; it is not used in this plugin's name.
