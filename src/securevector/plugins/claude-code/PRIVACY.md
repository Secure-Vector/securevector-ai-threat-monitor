# Privacy Policy — SecureVector Guard (Claude Code plugin)

**Last updated:** 2026-05-27
**Applies to:** plugin v4.3.x

The SecureVector Guard plugin runs entirely on your machine. It reads a small set of Claude Code hook events and posts them over **loopback HTTP** to a companion app you installed locally. The plugin itself makes no network calls to SecureVector, to Anthropic, or to any third party.

What happens to the data *after* it reaches the companion app — local storage, optional cloud sync, retention, deletion — is governed by the **companion app's** own privacy policy, not this one.

## What the plugin reads

The plugin registers four Claude Code hook events plus an optional `statusLine` command:

| Surface | What it reads | Where it sends it |
|---|---|---|
| `PreToolUse` hook | Tool name and `tool_input` arguments | Local app `/api/tool-permissions/call-audit` over loopback |
| `PostToolUse` hook | Tool name, input arguments, and — for `WebFetch` / `Read` / `Grep` / any `mcp__*` tool — up to 16 KB of the tool response | Local app `/api/tool-permissions/call-audit` over loopback. Additionally, `/analyze` is hit over loopback for prose-input tools (`WebFetch`, `Skill`, `Task`, `Agent`) and for tool-response scans on `WebFetch` / `Read` / `Grep` / `mcp__*` |
| `UserPromptSubmit` hook | Text of your prompt to Claude Code | Local app `/analyze` over loopback |
| `Stop` hook | Shape-only metadata (payload length and top-level key names — no prompt or response content) | Disk file at `~/.securevector/cost-probes/cc-stop-*.json`, mode 0600, capped at 100 entries. Diagnostic probe; targeted for removal in a future 4.3.x patch release. Until removed, only shape metadata is written — never the Stop event payload itself. |
| `statusLine` command (host-wired in `~/.claude/settings.json`) | Polls the local app for token counts and live findings at the interval set in `statusLine.refreshInterval` (default 5 s) | Local app `/api/tool-permissions/call-audit/stats`, `/api/replay/timeline`, and `/api/hooks/claude-code/token-usage` over loopback |

The plugin never reads anything outside what Claude Code passes to these hooks.

## Where the data goes

Every network-bound surface talks to **loopback HTTP** at `http://127.0.0.1:8741` (overridable via `SV_BASE_URL` for the hooks, or `SECUREVECTOR_URL` for the statusline). Traffic never leaves your machine.

In addition to the POSTs listed in the table above, the `PreToolUse` and `PostToolUse` hooks issue a short-timeout GET to `/api/tool-permissions/synced-overrides` on the same loopback origin to fetch the current cloud-synced rule set. The GET carries no user data.

Plugin-side files written to disk:

- `~/.securevector/cost-probes/cc-stop-*.json` — shape-only Stop-probe metadata, mode 0600, capped at 100 entries.
- `~/.securevector/statusline-tokens.json` — opportunistic 5-minute token-count cache used by the statusline, mode 0600.
- `~/.securevector/statusline-refresh.lock` — short-lived PID lock that prevents multiple statusline background refreshes from racing.

Nothing else is written to disk by the plugin.

For anything the companion app does with hook payloads after they arrive (local SQLite persistence, optional Cloud Connect, SIEM forwarding, retention windows, deletion), see the companion app's privacy documentation: <https://github.com/Secure-Vector/securevector-ai-threat-monitor>.

## Client-side redaction before any POST

Before sending a hook payload to the local app, the plugin runs the payload through a redactor (`lib/redact.js`) that masks common secret shapes:

- API key prefixes (e.g. `sk-…`, `pk-…`)
- GitHub tokens of all documented prefixes (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`)
- AWS access key IDs (`AKIA…`)
- JWTs
- Labelled credential key/value pairs (`password=…`, `secret: …`, etc.)

Redaction is **best-effort pattern matching, not a cryptographic guarantee.** The canonical pattern set lives at [`lib/redact.js`](./lib/redact.js); review it before installation if your workload contains custom secret formats.

Size limits enforced by the plugin before any POST:

- `/api/tool-permissions/call-audit` — the `args_preview` field is truncated to 200 characters.
- `/analyze` — the `text` field is capped at 8 KB (8 000 bytes) for prompt and prose-input scans, and at 16 KB for tool-response scans.

## What the plugin never collects

- **No external telemetry, analytics, or crash reports.** The statusline polls the local companion app on loopback for live findings; this stays on-device.
- **No data to Anthropic.**
- **No data to SecureVector's cloud.** The plugin makes no outbound network calls.
- **No file contents** outside what Claude Code passes in the hook payload.
- **No OS identifiers, IP addresses, or third-party account identifiers** (Anthropic account, GitHub login, etc.). The plugin does forward a Claude Code-generated `session_id` to the **local** `/analyze` endpoint for correlation; this identifier never leaves the plugin's loopback POST.

## Failing open

If the local companion app is unreachable, the four network-bound surfaces (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, and the `statusLine` command) return immediately and the tool call or prompt proceeds. The event is dropped — not queued, buffered, or retried — and never reaches network. The local-only `Stop` diagnostic probe is unaffected.

## Disabling the plugin

- `/plugin` in Claude Code, then uninstall **securevector-guard**, or
- `securevector-app --uninstall-plugin claude-code`.

Once uninstalled, no hook events are read and no POSTs are made. The Stop probe directory at `~/.securevector/cost-probes/` is removed by the uninstall handler.

## Source code & licence

The plugin is **Apache-2.0 licensed** and published at <https://github.com/Secure-Vector/securevector-ai-threat-monitor> under `src/securevector/plugins/claude-code/`. The redactor ([`lib/redact.js`](./lib/redact.js)), all four hook scripts plus the statusline ([`hooks/*.js`](./hooks/)), the hook manifest ([`hooks/hooks.json`](./hooks/hooks.json)), and the HTTP client ([`lib/client.js`](./lib/client.js)) are auditable — we encourage reviewing them before installation.

## Changes to this policy

We may update this policy from time to time. Material changes will bump the **Last updated** date and be noted in the plugin [CHANGELOG](../../../../CHANGELOG.md).

## Contact

For privacy questions about the plugin, email **privacy@securevector.io**, or open an issue at <https://github.com/Secure-Vector/securevector-ai-threat-monitor/issues>.
