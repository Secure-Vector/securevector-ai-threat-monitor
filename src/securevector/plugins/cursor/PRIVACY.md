# Privacy Policy — SecureVector Guard (Cursor plugin)

**Last updated:** 2026-06-12
**Applies to:** plugin v4.6.x

The SecureVector Guard plugin runs entirely on your machine. It reads a small set of Cursor hook events and posts them over **loopback HTTP** to a companion app you installed locally. The plugin itself makes no network calls to SecureVector, to Anysphere/Cursor, or to any third party.

What happens to the data *after* it reaches the companion app — local storage, optional cloud sync, retention, deletion — is governed by the **companion app's** own privacy policy, not this one.

## What the plugin reads

| Surface | What it reads | Where it sends it |
|---|---|---|
| `beforeShellExecution` / `beforeMCPExecution` hooks | The command / MCP tool name and arguments | Local app `/api/tool-permissions/call-audit` over loopback (only on a deny or ask — the audit row for blocked attempts) |
| `afterShellExecution` hook | The command and up to 16 KB of its output | Audit row over loopback. Output goes to `/analyze` ONLY when it carries a credential shape (e.g. `printenv` leaking `AKIA…`) — benign command output isn't shipped. |
| `afterMCPExecution` hook | MCP tool name, input, and up to 16 KB of the result | Audit row + `/analyze` over loopback (MCP results are third-party data — always scanned for indirect prompt injection) |
| `afterFileEdit` hook | File path and edit count; the newly written strings | Audit row over loopback. Written content goes to `/analyze` ONLY when it carries a credential shape. |
| `beforeReadFile` hook | File path and content Cursor is about to show the model | Nothing, unless the content carries a credential shape — then up to 16 KB goes to `/analyze` over loopback as a secret-exposure record. The read itself is never blocked. |
| `beforeSubmitPrompt` hook | Text of your prompt to the agent | Local app `/analyze` over loopback |
| `sessionStart` / `stop` hooks | The Cursor session/conversation id | Local app `/api/tool-permissions/call-audit` (session-boundary markers) over loopback |

The plugin never reads anything outside what Cursor passes to these hooks.

## Where the data goes

Every network-bound surface talks to **loopback HTTP** at `http://127.0.0.1:8741` (overridable via `SV_BASE_URL`). Traffic never leaves your machine. The decision and audit hooks also issue a short-timeout GET to `/api/tool-permissions/synced-overrides` on the same loopback origin to fetch the current rule set; that GET carries no user data.

The plugin writes no files to disk.

For anything the companion app does with hook payloads after they arrive (local SQLite persistence, optional Cloud Connect, SIEM forwarding, retention, deletion), see the companion app's privacy documentation: <https://github.com/Secure-Vector/securevector-ai-threat-monitor>.

## Client-side redaction before any POST

Before sending an audit preview to the local app, the plugin masks common secret shapes via `lib/redact.js`: API-key prefixes (`sk-…`, `pk-…`, `sk-proj-…`), Stripe secret keys, GitHub tokens, AWS access key IDs and secret access keys, JWTs, PEM private-key blocks, and labelled credential key/value pairs. Redaction is **best-effort pattern matching, not a cryptographic guarantee** — review [`lib/redact.js`](./lib/redact.js) before installation if your workload contains custom secret formats.

Size limits enforced before any POST: `args_preview` truncated to 200 characters; `/analyze` `text` capped at 8 KB for prompt/prose scans and 16 KB for response/content scans.

## What the plugin never collects

- **No external telemetry, analytics, or crash reports.**
- **No data to Anysphere, Cursor, or any model provider.**
- **No data to SecureVector's cloud.** The plugin makes no outbound network calls.
- **No file contents** outside what Cursor passes in the hook payload, and file-read content only when credential-shaped.
- **No OS identifiers, IP addresses, or third-party account identifiers.** The plugin forwards Cursor's `conversation_id`/`session_id` to the **local** endpoints for correlation; it never leaves the loopback POST.

## Failing open

If the local companion app is unreachable, every network-bound surface returns immediately and the action proceeds. The event is dropped — not queued, buffered, or retried. Cursor's hooks are fail-open by default (exit codes other than 0/2 proceed) and every hook in this plugin additionally catches all errors and emits an explicit allow, so an unreachable app never blocks your session.

## Disabling the plugin

- `securevector-app --uninstall-plugin cursor` (removes the plugin directory at `~/.cursor/plugins/local/securevector-guard/`, plus any legacy global-`hooks.json` entries from older builds, preserving your other hooks), or
- delete `~/.cursor/plugins/local/securevector-guard/` manually.

Once uninstalled, no hook events are read and no POSTs are made.

## Source code & licence

Apache-2.0, published at <https://github.com/Secure-Vector/securevector-ai-threat-monitor> under `src/securevector/plugins/cursor/`. The redactor, all hook scripts, the hook manifest, and the HTTP client are auditable — we encourage reviewing them before installation.

## Contact

Privacy questions: **privacy@securevector.io**, or open an issue at <https://github.com/Secure-Vector/securevector-ai-threat-monitor/issues>.
