# Privacy Policy — SecureVector Guard (Codex plugin)

**Last updated:** 2026-05-27
**Applies to:** plugin v4.4.x

The SecureVector Guard plugin runs entirely on your machine. It reads a small set of OpenAI Codex hook events and posts them over **loopback HTTP** to a companion app you installed locally. The plugin itself makes no network calls to SecureVector, to OpenAI, or to any third party.

What happens to the data *after* it reaches the companion app — local storage, optional cloud sync, retention, deletion — is governed by the **companion app's** own privacy policy, not this one.

## What the plugin reads

The plugin registers three Codex hook events:

| Surface | What it reads | Where it sends it |
|---|---|---|
| `PreToolUse` hook | Tool name and `tool_input` arguments | Local app `/api/tool-permissions/call-audit` over loopback |
| `PostToolUse` hook | Tool name, input arguments, and — for `WebFetch` / `Read` / `Grep` / `Bash` / `PowerShell` / any `mcp__*` tool — up to 16 KB of the tool response (including `stdout` and `stderr` for shell tools) | Local app `/api/tool-permissions/call-audit` over loopback. Additionally, `/analyze` is hit over loopback for prose-input tools (`WebFetch`, `Skill`, `Task`, `Agent`) and for tool-response scans on `WebFetch` / `Read` / `Grep` / `Bash` / `PowerShell` / `mcp__*`. Shell-output scanning catches credentials leaked via commands like `printenv` / `cat .env` / `cat ~/.aws/credentials` — those bytes leave the plugin process toward the local app on loopback for rule matching, then are persisted with secret values redacted and replaced by SHA-256 hashes. |
| `UserPromptSubmit` hook | Text of your prompt to Codex | Local app `/analyze` over loopback |

The plugin never reads anything outside what Codex passes to these hooks.

## Where the data goes

Every network-bound surface talks to **loopback HTTP** at `http://127.0.0.1:8741` (overridable via `SV_BASE_URL`). Traffic never leaves your machine.

In addition to the POSTs listed in the table above, the `PreToolUse` and `PostToolUse` hooks issue a short-timeout GET to `/api/tool-permissions/synced-overrides` on the same loopback origin to fetch the current cloud-synced rule set. The GET carries no user data.

The plugin writes no files to disk. (The Claude Code plugin's Stop-event probe is intentionally NOT ported to Codex — Codex's Stop event has a different shape and no probe is required.)

For anything the companion app does with hook payloads after they arrive (local SQLite persistence, optional Cloud Connect, SIEM forwarding, retention windows, deletion), see the companion app's privacy documentation: <https://github.com/Secure-Vector/securevector-ai-threat-monitor>.

## Client-side redaction before any POST

Before sending a hook payload to the local app, the plugin runs the payload through a redactor (`lib/redact.js`) that masks common secret shapes:

- API key prefixes (e.g. `sk-…`, `pk-…`, `sk-proj-…`)
- Stripe secret keys (`sk_live_…`, `sk_test_…`)
- GitHub tokens of all documented prefixes (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`)
- AWS access key IDs (`AKIA…`) and secret access keys
- JWTs
- PEM private-key blocks (`-----BEGIN … PRIVATE KEY-----`)
- Labelled credential key/value pairs (`password=…`, `secret: …`, etc.)

Redaction is **best-effort pattern matching, not a cryptographic guarantee.** The canonical pattern set lives at [`lib/redact.js`](./lib/redact.js); review it before installation if your workload contains custom secret formats.

Size limits enforced by the plugin before any POST:

- `/api/tool-permissions/call-audit` — the `args_preview` field is truncated to 200 characters.
- `/analyze` — the `text` field is capped at 8 KB (8 000 bytes) for prompt and prose-input scans, and at 16 KB for tool-response scans (including `stdout` / `stderr` from `Bash` / `PowerShell`).

## What the plugin never collects

- **No external telemetry, analytics, or crash reports.**
- **No data to OpenAI.**
- **No data to SecureVector's cloud.** The plugin makes no outbound network calls.
- **No file contents** outside what Codex passes in the hook payload.
- **No OS identifiers, IP addresses, or third-party account identifiers** (OpenAI account, GitHub login, etc.). The plugin does forward a Codex-generated `session_id` to the **local** `/analyze` endpoint for correlation; this identifier never leaves the plugin's loopback POST.

## Failing open

If the local companion app is unreachable, the three network-bound surfaces (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`) return immediately and the tool call or prompt proceeds. The event is dropped — not queued, buffered, or retried — and never reaches network.

## Disabling the plugin

- `codex plugin remove securevector-guard@securevector-local`, or
- `securevector-app --uninstall-plugin codex`.

Once uninstalled, no hook events are read and no POSTs are made.

## Source code & licence

The plugin is **Apache-2.0 licensed** and published at <https://github.com/Secure-Vector/securevector-ai-threat-monitor> under `src/securevector/plugins/codex/`. The redactor ([`lib/redact.js`](./lib/redact.js)), all three hook scripts ([`hooks/*.js`](./hooks/)), the hook manifest ([`hooks/hooks.json`](./hooks/hooks.json)), and the HTTP client ([`lib/client.js`](./lib/client.js)) are auditable — we encourage reviewing them before installation.

## Changes to this policy

We may update this policy from time to time. Material changes will bump the **Last updated** date and be noted in the plugin [CHANGELOG](../../../../CHANGELOG.md).

## Contact

For privacy questions about the plugin, email **privacy@securevector.io**, or open an issue at <https://github.com/Secure-Vector/securevector-ai-threat-monitor/issues>.
