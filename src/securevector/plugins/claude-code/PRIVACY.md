# Privacy Policy — SecureVector Guard (Claude Code plugin)

**Last updated:** 2026-05-27

The SecureVector Guard plugin for Claude Code is **local-first**. By default, every piece of data the plugin reads from Claude Code is sent only to a companion app running on your own machine — never to SecureVector's servers, never to Anthropic, never to any third party.

## What the plugin sees

The plugin reads three Claude Code hook events:

| Event | What it sees |
|---|---|
| `PreToolUse` | The tool name (`Bash`, `WebFetch`, `mcp__server__tool`, etc.) and the call's `tool_input` arguments. Used to look up deny rules. |
| `PostToolUse` | The tool name, the input, and a short redacted snippet of the response. Used to write an audit row. |
| `UserPromptSubmit` | The text of your prompt to Claude Code. Used to scan for prompt-injection or credential-leak patterns. |

The plugin never reads anything outside what Claude Code passes to these three hooks.

## Where the data goes

All hook payloads are sent over loopback HTTP to your local companion app at `http://127.0.0.1:8741` (configurable via the `SV_BASE_URL` env var). The companion app writes them to a SQLite database on disk — typically under `~/.securevector/`.

Nothing leaves your machine unless **you** explicitly enable cloud sync in the companion app (see below).

## Client-side redaction before any POST

Before sending a hook payload to the local app, the plugin runs the payload through a redactor (`lib/redact.js`) that masks common secret shapes:

- API keys (`sk-…`, `pk-…`)
- GitHub personal access tokens (`ghp_…`)
- AWS access key IDs (`AKIA…`)
- JWTs
- Labelled credential key/value pairs (`password=…`, `secret: …`, etc.)

Payloads are also capped at 8 KB before POST.

## What the plugin never sends

- No telemetry, analytics, or crash reports from the plugin itself.
- No data to Anthropic.
- No data to SecureVector's cloud unless you opt in.
- No file contents outside what Claude Code passes in the hook payload.

## Optional cloud sync (opt-in only)

The companion app has an opt-in setting for two cloud features:

1. **Cloud-managed deny rules** — fetches policy rules from the SecureVector cloud so a security team can push deny lists to every developer.
2. **SIEM forwarding** — forwards your local audit log to a SIEM endpoint you configure (Splunk, Datadog, etc.).

Both are **off by default**. Both can be turned off in the companion app at any time. Even when on, only the audit metadata (tool name, decision, timestamp, redacted snippet) leaves the device — full payloads and prompts stay local.

## Failing open

If the local companion app is unreachable, every hook returns immediately and the tool call proceeds. No data is queued, buffered, or retried — the plugin loses the event rather than block Claude Code or hold data.

## Retention and deletion

All data lives in the SQLite database under `~/.securevector/`. You control retention:

- Delete the database file to wipe all audit history.
- Uninstall the plugin (`/plugin` in Claude Code, or `securevector-app --uninstall-plugin claude-code`) to stop collection.
- Remove `~/.securevector/` to clear all SecureVector data on the machine.

## Contact

For privacy questions or data-related requests, email **support@securevector.io** or open an issue at <https://github.com/Secure-Vector/securevector-ai-threat-monitor/issues>.
