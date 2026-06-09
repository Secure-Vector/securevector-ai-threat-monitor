# SecureVector Guard — GitHub Copilot CLI plugin

Real-time policy enforcement and tamper-evident audit for tool calls invoked from a GitHub Copilot CLI session.

This plugin is a third-party integration for [GitHub Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/copilot-cli). It is built by SecureVector and is **not affiliated with, endorsed by, or sponsored by GitHub or Microsoft**.

---

## What it does

Every tool call your Copilot CLI session issues passes through hooks installed by this plugin:

| Hook | What happens |
|---|---|
| **preToolUse** | Looks up the call against cloud-pushed deny rules synced to the local SecureVector app. Returns `permissionDecision: "deny"` (with policy reason), `"ask"`, or `"allow"`. **Fails open** — see the critical note below. |
| **postToolUse** | Posts a fire-and-forget audit row to the local SecureVector app with `runtime_kind: "copilot-cli"`, the resolved policy decision, and a redacted snippet of the arguments. Persisted in a tamper-evident hash chain. For the prose-input tool `task` and for tool responses from `web_fetch` / `view` / `bash` / `powershell` / any MCP tool (`<server>-<tool>`), the redacted text is also POSTed to `/analyze` for prompt-injection / credential-leak scanning. |
| **userPromptSubmitted** | Forwards every prompt you submit to local `/analyze` for injection / jailbreak scanning by the rule engine. Copilot's prompt hook has no stdout control, so this is observe-only — detection happens server-side and surfaces in the local Threats UI; it never blocks the prompt. |
| **sessionStart** | Probes the local app for reachability (a one-line stderr "Guard inactive — install/start the app" note if it's down) and writes a `__session_start__` audit row for clean session boundaries on the Agent Map. |

> ### ⚠️ Fail-open on an unreachable app — the important part
> Unlike Claude Code / Codex, **Copilot CLI's `preToolUse` hook fails *closed*** — a hook crash, non-zero exit, or timeout *denies* the tool call. SecureVector's invariant is the opposite: a stopped or unreachable local app must **never** block your session. So this plugin's `preToolUse` hook catches every error, emits an explicit `{"permissionDecision":"allow"}`, and always exits 0. Net result: when the SecureVector app is down, Copilot keeps working (fail-open), exactly like every other SecureVector harness.

**Tool-name matching:** Copilot's built-in tool names (`bash`, `write_bash`, `stop_bash`, `view`, `edit`, `create`, `glob`, `grep`, `web_fetch`, `task`, `skill`, `sql`, …) are matched against the list in `lib/normalize.js`. MCP tools arrive as `<server>-<tool>` (e.g. `everything-echo`) — `normalize.js` emits the literal name, the cloud `<server>:<tool>` form, the bare tool name, and the server prefix, so a rule can target the exact tool or the whole server. Names outside both sets (Copilot's internal bookkeeping tools, e.g. `report_intent`) short-circuit to allow (fail-open) and are not audited.

> **Empirically verified against Copilot CLI 1.0.60:** (1) `${COPILOT_PLUGIN_ROOT}` resolves for installed-plugin hook commands (confirmed in the CLI's own debug log); (2) MCP tools present to hooks as `<server>-<tool>` (e.g. `everything-echo`), NOT Claude's `mcp__server__tool` — `normalize.js` handles the Copilot shape. The full built-in tool inventory (incl. the `*_bash` background-shell family) was captured from `--log-level debug` and mirrored into the Python `COPILOT_CLI_BUILTINS` table.

## Requirements

- [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli) with the plugin/hooks system
- Node.js 18+ (Copilot uses its own Node runtime; no separate install required)
- A running local [SecureVector AI Threat Monitor](https://github.com/Secure-Vector/securevector-ai-threat-monitor) app on `http://127.0.0.1:8741` (or override via `SV_BASE_URL`)

## Installation

```bash
# Option A: via the SecureVector app UI
# Open http://127.0.0.1:8741 → Integrations → GitHub Copilot CLI → Install Plugin

# Option B: via CLI (runs the same handler in-process)
securevector-app --install-plugin copilot-cli
```

After install, in your terminal:

```text
copilot plugin marketplace add ~/.securevector/staging/copilot-cli-plugin
copilot plugin install securevector-guard@securevector-local
```

Uninstall: `securevector-app --uninstall-plugin copilot-cli` (or `copilot plugin uninstall securevector-guard`).

## Verifying it works

1. Confirm SecureVector is running: `curl -fsS http://127.0.0.1:8741/health`
2. From a Copilot CLI session, invoke any tool. Within a few seconds it should appear in the SecureVector **Tool Activity** tab with `runtime_kind=copilot-cli`.
3. To verify deny enforcement, push a cloud-managed deny rule for a tool you control, then call it — Copilot should return a denial with the `SecureVector Guard:` policy reason.

## Hooks registered

- **sessionStart** (`hooks/session-start.js`) — reachability/activation notice (stderr) + `__session_start__` audit row.
- **preToolUse** (`hooks/pre-tool-use.js`) — deny/allow/ask per synced + local override rules. Deny reasons are prefixed `SecureVector Guard:`. Fails open (explicit allow + exit 0) on any error.
- **postToolUse** (`hooks/post-tool-use.js`) — fire-and-forget audit POST (`runtime_kind=copilot-cli`). `/analyze` scan for the `task` prose input and for tool responses from `web_fetch` / `view` / any MCP tool `<server>-<tool>` (unconditional, for indirect prompt injection) and `bash` / `powershell` (credential-marker-gated, to keep FP rate down). Secrets redacted via `lib/redact.js` before any POST.
- **userPromptSubmitted** (`hooks/user-prompt-submit.js`) — forwards prompts to `/analyze` (observe-only; Copilot's prompt hook can't block). Does not fire on session *resume* (a documented Copilot limitation) — resumed sessions remain covered by the tool-call hooks.

All POSTs target loopback (`http://127.0.0.1:8741` by default). The plugin writes no files to disk.

## Configuration

Set `SV_BASE_URL` to point at a non-default SecureVector instance:

```bash
export SV_BASE_URL="http://localhost:9000"
```

## License

Apache 2.0. Source at <https://github.com/Secure-Vector/securevector-ai-threat-monitor> under `src/securevector/plugins/copilot-cli/`.

## Disclaimer

Built by SecureVector. Not affiliated with, endorsed by, or sponsored by GitHub or Microsoft. "GitHub Copilot" is a product name referenced descriptively to identify the target runtime; "Copilot" is not used in this plugin's name. See [GitHub's logo & trademark guidelines](https://github.com/logos) for the boundaries of nominative use.
