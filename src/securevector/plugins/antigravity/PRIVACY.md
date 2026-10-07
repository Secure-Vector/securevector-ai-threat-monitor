# Privacy Policy, SecureVector Guard (Antigravity plugin)

**Last updated:** 2026-09-21
**Applies to:** plugin v1.0.0

The SecureVector Guard plugin runs entirely on your machine. It reads three Antigravity hook events and posts them over **loopback HTTP** to a companion app you installed locally. The plugin itself makes no network calls to SecureVector, to Google, or to any third party.

What happens to the data after it reaches the companion app, meaning local storage, optional cloud sync, retention and deletion, is governed by the **companion app's** own privacy policy, not this one.

## What the plugin reads

| Surface | What it reads | Where it sends it |
|---|---|---|
| `PreToolUse` hook | `toolCall.name`, `toolCall.args`, and `conversationId` | Nothing on allow. On a **deny**, an audit row goes to the local app's `/api/tool-permissions/call-audit` over loopback, carrying a redacted arguments preview. For network-capable tools (`run_command`, `search_web`, `read_url_content`, `generate_image`, and any non-built-in tool), the tool name and arguments also go to the local app's `/api/egress/evaluate` over loopback so the destination can be checked. |
| `PostToolUse` hook | `toolCall.name`, `toolCall.args`, and `conversationId` | An audit row for **every** call, over loopback, carrying a redacted arguments preview. For four tools whose arguments are prose (`search_web`, `start_subagent`, `ask_question`, `generate_image`), the prose field also goes to the local app's `/analyze` over loopback. |
| `PreInvocation` hook | `invocationNum` and `conversationId` | On the session's first invocation only, a `__session_start__` session-boundary audit row over loopback. No prompt text is read, because Antigravity's `PreInvocation` payload does not contain any. |

The plugin never reads anything outside what Antigravity passes to these three hooks. It does not open `transcriptPath`, `artifactDirectoryPath`, `workspacePaths`, or any other file named in a hook payload.

**No prompt scanning.** Antigravity exposes no hook event carrying the user's prompt, so prompts are never read or transmitted by this plugin.

**No tool-result scanning today.** Antigravity's documented `PostToolUse` payload carries no tool result, only an optional error string, so there is nothing for the incoming-direction scan to read. The code path exists and would activate if a future Antigravity build began sending results; were that to happen, results from `read_url_content`, `search_web`, `view_file`, `search_directory` and any non-built-in tool would be sent to the local `/analyze` over loopback, and `run_command` output would be sent only when it carries a credential shape. This paragraph describes dormant behaviour, not current behaviour.

## Where the data goes

Every network-bound surface talks to **loopback HTTP** at `http://127.0.0.1:8741` (overridable via `SECUREVECTOR_ENGINE_ENDPOINT`, legacy alias `SV_BASE_URL`). Traffic never leaves your machine unless you point that variable at a remote engine yourself. The decision and audit hooks also issue a short-timeout GET to `/api/tool-permissions/synced-overrides` on the same origin to fetch the current rule set; that GET carries no user data beyond the runtime name and the conversation id.

The plugin writes no files to disk.

For anything the companion app does with hook payloads after they arrive (local SQLite persistence, optional Cloud Connect, SIEM forwarding, retention, deletion), see the companion app's privacy documentation: <https://github.com/Secure-Vector/securevector-ai-threat-monitor>.

## Client-side redaction before any POST

Before sending an arguments preview to the local app, the plugin masks common secret shapes via `lib/redact.js`: OpenAI project keys (`sk-proj-…`), Stripe live and test keys (`sk_live_…`, `sk_test_…`), other `sk-`/`pk-` API-key prefixes, GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`), AWS access key IDs (`AKIA…`) and secret access keys, JWTs (`eyJ…`), PEM private-key blocks of any flavour, and labelled credential key/value pairs (`password=`, `api_key:`, `token=`, `bearer`, `client_secret`, and similar). Redaction is **best-effort pattern matching, not a cryptographic guarantee**. Review [`lib/redact.js`](./lib/redact.js) before installation if your workload contains custom secret formats.

Text sent to `/analyze` is deliberately **not** pre-redacted: the companion app's own redactor is the single source of truth for redaction and owns the Secret Detections record, and masking client-side would erase the very matches that record exists to capture. That text goes only to the loopback endpoint above.

Size limits enforced before any POST: the arguments preview is capped at 8 KB (8192 characters) after redaction, and the app redacts and caps it again before storing. Text sent to `/analyze` is capped at 8 KB for the outgoing prose scan and 16 KB for the dormant result scan.

## What the plugin never collects

- **No external telemetry, analytics, or crash reports.**
- **No data to Google, Antigravity, or any model provider.**
- **No data to SecureVector's cloud.** The plugin makes no outbound network calls.
- **No prompt text**, because no Antigravity hook exposes it.
- **No file contents** beyond what appears inside `toolCall.args`.
- **No OS identifiers, IP addresses, or third-party account identifiers.** The plugin forwards Antigravity's `conversationId` to the **local** endpoints for correlation, and it never leaves the loopback POST. Each tool call is also stamped with a locally generated random `request_id` so the app can join a call to its own detections; that id carries no content.

## Failing open

If the local companion app is unreachable, every network-bound surface returns immediately and the action proceeds. The event is dropped, not queued, buffered, or retried. Antigravity's own behaviour on hook failure is not documented first-party, so every hook in this plugin catches all errors, writes an explicit allow decision, and exits 0, which means an unreachable app cannot block your session on either a fail-open or a fail-closed host.

## Disabling the plugin

- `securevector-app --uninstall-plugin antigravity`, which removes the plugin directory at `~/.gemini/config/plugins/securevector-guard/` and the staged copy under `~/.securevector/staging/antigravity-plugin/`, or
- delete `~/.gemini/config/plugins/securevector-guard/` manually.

Once uninstalled, no hook events are read and no POSTs are made.

## Source code and licence

Apache-2.0, published at <https://github.com/Secure-Vector/securevector-ai-threat-monitor> under `src/securevector/plugins/antigravity/`. The redactor, all three hook scripts, the hook manifest, and the HTTP client are auditable, and we encourage reviewing them before installation.

## Contact

Privacy questions: **privacy@securevector.io**, or open an issue at <https://github.com/Secure-Vector/securevector-ai-threat-monitor/issues>.
