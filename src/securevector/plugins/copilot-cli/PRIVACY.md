# Privacy Policy — SecureVector Guard (GitHub Copilot CLI plugin)

**Last updated:** 2026-06-08
**Applies to:** plugin v4.6.x

The SecureVector Guard plugin runs entirely on your machine. It reads a small set of GitHub Copilot CLI hook events and posts them over **loopback HTTP** to a companion app you installed locally. The plugin itself makes no network calls to SecureVector, to GitHub/Microsoft, or to any third party.

What happens to the data *after* it reaches the companion app — local storage, optional cloud sync, retention, deletion — is governed by the **companion app's** own privacy policy, not this one.

## What the plugin reads

| Surface | What it reads | Where it sends it |
|---|---|---|
| `preToolUse` hook | Tool name and `toolArgs` arguments | Local app `/api/tool-permissions/call-audit` over loopback (only on a deny — the audit row for blocked attempts) |
| `postToolUse` hook | Tool name, input arguments, and — for `web_fetch` / `view` / `bash` / `powershell` / any `mcp__*` tool — up to 16 KB of the tool result (`toolResult.textResultForLlm`, including shell `stdout`/`stderr`) | Local app `/api/tool-permissions/call-audit` over loopback. Additionally, `/analyze` is hit over loopback for the `task` prose input and for tool-response scans. Shell-output scanning is credential-marker-gated — it scans `bash`/`powershell` output only when a credential shape is present (e.g. `printenv` / `cat .env` leaking `AKIA…`), so benign command output isn't shipped. |
| `userPromptSubmitted` hook | Text of your prompt to Copilot | Local app `/analyze` over loopback |
| `sessionStart` hook | The Copilot `sessionId` | Local app `/api/tool-permissions/call-audit` (a session-boundary marker) over loopback |

The plugin never reads anything outside what Copilot passes to these hooks.

## Where the data goes

Every network-bound surface talks to **loopback HTTP** at `http://127.0.0.1:8741` (overridable via `SV_BASE_URL`). Traffic never leaves your machine. The `preToolUse` / `postToolUse` / `sessionStart` hooks also issue a short-timeout GET to `/api/tool-permissions/synced-overrides` on the same loopback origin to fetch the current cloud-synced rule set; that GET carries no user data.

The plugin writes no files to disk.

For anything the companion app does with hook payloads after they arrive (local SQLite persistence, optional Cloud Connect, SIEM forwarding, retention, deletion), see the companion app's privacy documentation: <https://github.com/Secure-Vector/securevector-ai-threat-monitor>.

## Client-side redaction before any POST

Before sending a payload to the local app, the plugin masks common secret shapes via `lib/redact.js`: API-key prefixes (`sk-…`, `pk-…`, `sk-proj-…`), Stripe secret keys (`sk_live_…`/`sk_test_…`), GitHub tokens (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`), AWS access key IDs (`AKIA…`) and secret access keys, JWTs, PEM private-key blocks, and labelled credential key/value pairs. Redaction is **best-effort pattern matching, not a cryptographic guarantee** — review [`lib/redact.js`](./lib/redact.js) before installation if your workload contains custom secret formats.

Size limits enforced before any POST: `args_preview` truncated to 200 characters; `/analyze` `text` capped at 8 KB for prompt/prose scans and 16 KB for tool-response scans.

## What the plugin never collects

- **No external telemetry, analytics, or crash reports.**
- **No data to GitHub, Microsoft, or OpenAI.**
- **No data to SecureVector's cloud.** The plugin makes no outbound network calls.
- **No file contents** outside what Copilot passes in the hook payload.
- **No OS identifiers, IP addresses, or third-party account identifiers.** The plugin forwards a Copilot-generated `sessionId` to the **local** endpoints for correlation; it never leaves the loopback POST.

## Failing open

If the local companion app is unreachable, every network-bound surface returns immediately and the tool call or prompt proceeds. The event is dropped — not queued, buffered, or retried. Note that Copilot CLI's `preToolUse` hook is fail-*closed* by default (a hook error denies the call); this plugin deliberately catches all errors and returns an explicit allow + exit 0 so an unreachable app fails **open** and never blocks your session.

## Disabling the plugin

- `copilot plugin uninstall securevector-guard`, or
- `securevector-app --uninstall-plugin copilot-cli`.

Once uninstalled, no hook events are read and no POSTs are made.

## Source code & licence

Apache-2.0, published at <https://github.com/Secure-Vector/securevector-ai-threat-monitor> under `src/securevector/plugins/copilot-cli/`. The redactor, all hook scripts, the hook manifest, and the HTTP client are auditable — we encourage reviewing them before installation.

## Contact

Privacy questions: **privacy@securevector.io**, or open an issue at <https://github.com/Secure-Vector/securevector-ai-threat-monitor/issues>.
