# SecureVector Guard — Codex plugin

Real-time policy enforcement and tamper-evident audit for tool calls invoked from an OpenAI Codex CLI session.

This plugin is a third-party integration for [OpenAI Codex CLI](https://github.com/openai/codex). It is built by SecureVector and is **not affiliated with or endorsed by OpenAI**.

---

## What it does

Every tool call your Codex session issues passes through three hooks installed by this plugin:

| Hook | What happens |
|---|---|
| **PreToolUse** | Looks up the call against cloud-pushed deny rules synced to the local SecureVector app. Returns `permissionDecision: "deny"` (with policy reason), `"ask"`, or `"allow"`. **Fails open** — if the local app is unreachable, the call proceeds. |
| **PostToolUse** | Posts a fire-and-forget audit row to the local SecureVector app with `runtime_kind: "codex"`, the resolved policy decision, and a redacted snippet of the arguments. Persisted in a tamper-evident hash chain. For prose-input tools (`WebFetch`, `Skill`, `Task`, `Agent`) and tool responses from `WebFetch` / `Read` / `Grep` / any `mcp__*` tool, the redacted text is also POSTed to `/analyze` for prompt-injection / credential-leak scanning. |
| **UserPromptSubmit** | Forwards every prompt you submit to local `/analyze` for injection / jailbreak scanning by the rule engine. Detection happens server-side, not in the hook. Fail-open, never blocks the prompt. |

**Tool-name matching:** MCP tools (`mcp__<server>__<tool>`) are matched directly. Codex's built-in tool names are matched against a list that mirrors the Claude Code BUILTIN_TOOLS set in `lib/normalize.js`; if a Codex-specific tool name is outside that list, the plugin short-circuits to allow (fail-open). The list is a v1 surface — expand `lib/normalize.js` if you find a Codex tool that needs governing.

## Requirements

- [OpenAI Codex CLI](https://github.com/openai/codex) ≥ 0.133.0 (the version that supports `codex plugin marketplace` / `codex plugin add`)
- Node.js 18+ (Codex uses its own Node runtime; no separate install required)
- A running local [SecureVector AI Threat Monitor](https://github.com/Secure-Vector/securevector-ai-threat-monitor) app on `http://127.0.0.1:8741` (or override via `SV_BASE_URL` env var)

## Installation

Two equivalent paths:

```bash
# Option A: via the SecureVector app UI
# Open http://127.0.0.1:8741 → Integrations → Codex → Install Plugin

# Option B: via CLI (runs the same handler in-process)
securevector-app --install-plugin codex
```

After install, in your Codex session:

```text
codex plugin marketplace add ~/.securevector/staging/codex-plugin
codex plugin add securevector-guard@securevector-local
```

Codex will prompt you to **trust SecureVector Guard hooks** on first run. This is a one-time per-machine confirmation.

Uninstall: `securevector-app --uninstall-plugin codex` (or `codex plugin remove securevector-guard@securevector-local`).

## Verifying it works

1. Confirm SecureVector is running:
   ```bash
   curl -fsS http://127.0.0.1:8741/health
   ```

2. From a Codex session, invoke any MCP tool. The call should succeed and within a few seconds appear in the SecureVector **Tool Activity** tab with `runtime_kind=codex`.

3. To verify deny enforcement, push a cloud-managed deny rule for an MCP tool you control, then call that tool — Codex should return a denial with the policy reason in the transcript.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Calls pass even with a deny rule active | SecureVector app not running, OR hook handler can't reach it | Confirm `curl http://127.0.0.1:8741/health`; check `SV_BASE_URL` if non-default port |
| "Trust SecureVector Guard hooks?" prompt every session | Codex trust-cache not persisted between sessions | Confirm the trust prompt was accepted, not dismissed; check `~/.codex/config.toml` for the trusted-hook entry |
| Hook calls feel slow | Local app unreachable; 100ms timeout firing on every call | Restart the SecureVector app — the timeout is fail-open by design |
| No audit rows appearing | Plugin not installed in Codex, OR hooks not trusted | Run `codex plugin list` to confirm `securevector-guard` is listed |
| Built-in tools not enforced | The tool name isn't in `lib/normalize.js` BUILTIN_TOOLS set | Open an issue with the exact tool name Codex reports in the hook payload |

## Configuration

The plugin reads `SV_BASE_URL` from the environment if set; otherwise defaults to `http://127.0.0.1:8741`. To point at a non-default SecureVector instance:

```bash
export SV_BASE_URL="http://localhost:9000"
# then launch Codex
```

## Hooks registered

- **PreToolUse** (`hooks/pre-tool-use.js`) — blocks tool calls per the synced + local override rules; returns `permissionDecision: allow|deny|ask`.
- **PostToolUse** (`hooks/post-tool-use.js`) — fire-and-forget audit POST to `/api/tool-permissions/call-audit` (tagged `runtime_kind=codex`). A second POST to `/analyze` runs only for tools whose `tool_input` is prose the agent emitted in natural language (`WebFetch`, `Skill`, `Task`, `Agent`) — syntax-shaped tools (Bash-like commands, file writes, source-code edits) are intentionally NOT scanned at `/analyze` to keep the false-positive rate down. A tool-response scan POST runs for `WebFetch` / `Read` / `Grep` / any `mcp__*` tool to catch indirect prompt injection and credentials in fetched content. Secrets are redacted via shared `lib/redact.js` before either POST.
- **UserPromptSubmit** (`hooks/user-prompt-submit.js`) — forwards every incoming prompt to local `/analyze` for injection / jailbreak scanning. Prompts are first redacted (`lib/redact.js` patterns: sk-/pk- / GitHub PAT / AWS AKIA / JWT / labelled credential kv-pairs) and capped at 8 KB before POST.

All hooks fail-open: every error path emits the equivalent of "allow" (or an empty response) and the plugin never breaks a Codex session. All POSTs target loopback (`http://127.0.0.1:8741` by default).

## Statusline

Codex's statusline (`status_line` config field and `/statusline` slash command) selects from built-in items only (branch, git summary, PR number, sandbox mode, approval mode, context window tokens). There is no plugin hook event for statusline rendering, so this plugin does **not** ship a statusline emitter. Equivalent live findings (threat count, 7-day token usage) are visible in the local SecureVector dashboard at <http://127.0.0.1:8741>.

## Known gaps (v1)

- **Cost tracking**: LLM token / cost telemetry lives in Codex's API SDK layer, not the tool-call hook layer. The plugin physically cannot see token counts from these hooks. The local app's Cost Tracking dashboard does not include Codex costs in v1. Coming in a follow-up release.
- **BUILTIN_TOOLS list is CC-derived**: `lib/normalize.js` ships with Claude Code's built-in tool names. MCP tools (`mcp__server__tool`) work today regardless. Codex-specific built-ins outside the CC list short-circuit to allow (fail-open). Expand the set as you encounter Codex tools that need governing.

## License

Apache 2.0. Source at <https://github.com/Secure-Vector/securevector-ai-threat-monitor> under `src/securevector/plugins/codex/`.
