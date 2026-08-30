# Privacy Policy — SecureVector Guard for OpenCode

**Effective:** 2026-08-26
**Applies to:** the `@securevector/opencode-guard` plugin (the "Plugin") only.

## The short version

The Plugin sends data to exactly one place: the SecureVector app running on
**your own machine** at `http://127.0.0.1:8741`. It makes no other network
requests, writes no files, and contains no telemetry, analytics, or
crash-reporting of any kind. SecureVector, as a company, receives nothing from
this Plugin.

## What the Plugin sends, and when

All destinations below are paths on that same loopback address.

### 1. On every tool call — `POST /api/tool-permissions/call-audit`

One audit row per tool call, from `tool.execute.after`, and additionally from
`tool.execute.before` when a call is **denied** (a blocked call never reaches
the "after" hook, so without this the most security-relevant events would leave
no trace).

Each row contains:

- the tool name and the resolved policy tool id (e.g. `bash`, `github:create_issue`)
- the decision (`allow` / `block` / `log_only`) and the policy reason, if any
- `runtime_kind: "opencode"`
- OpenCode's session id and a per-call correlation id derived from OpenCode's
  `callID`
- `args_preview` — the tool's arguments, **passed through the secret redactor
  and then truncated to 200 characters**

### 2. On session start — the same audit endpoint

A single `__session_start__` row carrying the session id, so one OpenCode run
groups into one node on the Agent Map.

### 3. Threat scanning — `POST /analyze`

Text is sent for scanning in three cases. In all three the text is **truncated**
before sending, and the local app performs the analysis locally.

| Case | Source | Cap |
|---|---|---|
| Your prompt | `chat.message` | 8,000 chars |
| Outgoing prose | the arguments of `task` and `question` only | 8,000 chars |
| Tool responses | `webfetch`, `websearch`, `read`, **every MCP tool**, and `bash` | 16,000 chars |

`bash` output is **marker-gated**: it is sent only when the output already
contains something matching a credential pattern (see below). Ordinary build
logs, `grep` output, and binary dumps are never sent.

Tool arguments for tools *other* than `task` and `question` — including `bash`
command bodies and `write`/`edit` file contents — are **not** sent to `/analyze`.
They appear only as the redacted, 200-character `args_preview` on the audit row.

### 4. Policy lookups — `GET /api/tool-permissions/synced-overrides`, `POST /api/egress/evaluate`

Reads your current rules; sends the tool name and arguments for egress
evaluation on network-capable tools only (`bash`, `webfetch`, `websearch`, and
MCP tools).

### 5. Access requests — `POST /api/jit/requests`

Only when policy marks a denied tool as requestable. Sends the tool id, tool
name, runtime kind, and session id. No arguments.

## Secret redaction

Before any `args_preview` is recorded, the text passes through a redactor that
masks these shapes:

- OpenAI project keys (`sk-proj-…`) and `sk-` / `pk-` keys
- Stripe live and test keys (`sk_live_…`, `sk_test_…`)
- GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`)
- AWS access key ids (`AKIA…`) and 40-character AWS secret access keys
- JSON Web Tokens
- PEM private key blocks (RSA, EC, DSA, OpenSSH, encrypted, PGP)
- labelled key/value pairs — `password`, `secret`, `token`, `api_key`,
  `bearer`, `auth_token`, `access_token`, `client_secret`

The same pattern list is what gates whether `bash` output is scanned at all, so
the two decisions cannot drift apart.

Redaction is best-effort pattern matching. It is a safety net, not a guarantee
that no secret can ever appear in a preview.

## What the Plugin does NOT do

- No outbound network requests to SecureVector or any third party.
- No telemetry, analytics, usage statistics, or crash reporting.
- No files written to disk. No logs of its own.
- Your source code, full file contents, full command output, and model responses
  are never transmitted anywhere.
- Nothing is sent when the local app is not running — the requests simply fail
  and are discarded.

## Cloud

The Plugin has no cloud component and no ability to reach one. If you separately
enable **Cloud Connect** in the SecureVector app, that app — not this Plugin —
may forward metadata and hashes upstream under its own policy, which is off by
default and disclosed in the app.

## Fail-open

If the local app is unreachable, slow, or erroring, tool calls proceed
unaudited and unenforced. The Plugin never blocks your session because of its
own failure.

Note the harness-specific hazard this protects against: OpenCode blocks a tool
call when a `tool.execute.before` hook **throws**, and its plugin runner does
not catch hook exceptions. An accidental error would therefore read as a
deliberate block. Every hook in this Plugin catches all errors; the only
exception it ever rethrows is one it constructed after an actual policy denial.

## Data retention

The Plugin retains nothing. Audit rows and scan results live in the local
SecureVector app's database on your machine, under your control, subject to that
app's retention settings.

## Contact

privacy@securevector.io · https://securevector.io
