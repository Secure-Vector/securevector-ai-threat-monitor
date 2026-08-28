# SecureVector Guard for OpenCode

Policy enforcement, tamper-evident audit, and threat scanning for
[OpenCode](https://opencode.ai) tool calls — backed by the free local
SecureVector app running on your own machine.

Every tool call OpenCode makes (built-in and MCP alike) is checked against your
policy before it runs, and recorded afterwards. Nothing leaves your machine: the
plugin talks only to `http://127.0.0.1:8741`.

---

## What it does

| Hook | What SecureVector does |
|---|---|
| `tool.execute.before` | **Enforce.** Checks the tool against synced policy rules and the egress policy. A denied call is blocked before it runs. |
| `tool.execute.after` | **Audit.** Writes a tamper-evident row for the call, and scans the tool's *response* for indirect prompt injection and leaked secrets. |
| `chat.message` | **Prompt scan.** Your prompt is scanned for injection patterns. Observe-only — it never blocks. |
| `permission.ask` | Collapses OpenCode's approval prompt for a call policy has already denied, so you aren't asked to approve something that will be refused. |
| `event` | Records session start so a run shows up as one node on the SecureVector Agent Map. |

## Install

```bash
pip install securevector
securevector-app --install-plugin opencode
```

That stages the plugin to `~/.securevector/staging/opencode-plugin/` and adds
that path to the `plugin` array in `~/.config/opencode/opencode.json`. Start a
new OpenCode session to load it — OpenCode resolves plugins at launch.

You can also install from the app's **Integrations → OpenCode** page.

To remove it:

```bash
securevector-app --uninstall-plugin opencode
```

which deregisters the plugin and deletes the staged tree.

## Verifying it's active

With the app running at `127.0.0.1:8741`, start an OpenCode session and run any
tool. The call appears in the app under **Tool Activity** with
`runtime_kind = opencode`, and on the **Agent Map**.

If the local app is *not* running, the plugin prints a one-line notice on
startup and then does nothing — see fail-open below.

## Governed tools

OpenCode's built-in tool ids, as of opencode 1.18.23:

`bash` · `read` · `write` · `edit` · `apply_patch` · `glob` · `grep` ·
`webfetch` · `websearch` · `task` · `skill` · `todowrite` · `question` ·
`lsp` · `plan_exit` · `execute`

> **The shell tool is named `bash`, not `shell`.** OpenCode's own source pins
> `ToolID = "bash"` "for compatibility with existing plugins, users, and saved
> permissions", with a note that it will be renamed in opencode 2.0. Write your
> rules against `bash`.

`lsp`, `plan_exit` and `execute` only appear when their experimental runtime
flags are enabled; governing them unconditionally is harmless.

### MCP tools

OpenCode names an MCP tool `<server>_<tool>` — the server name and tool name
joined by a **single underscore**, with any character outside `[A-Za-z0-9_-]`
replaced by `_`. There is **no `mcp` prefix of any kind**, which is unlike
Claude Code (`mcp__server__tool`) and GitHub Copilot CLI (`<server>-<tool>`).

A rule can target an MCP tool by any of:

- the literal name — `github_create_issue`
- the `<server>:<tool>` form — `github:create_issue`
- the bare tool name — `create_issue`
- the server alone, to cover all of its tools — `github`

> **Known ambiguity.** Because MCP names carry no marker, a server named `apply`
> exposing a tool named `patch` produces `apply_patch` — identical to the
> built-in. SecureVector resolves such a collision to the **built-in**, which
> keeps the tool governable under a stable documented id. This is inherent to
> OpenCode's naming scheme.

## Fail-open behaviour

**If the SecureVector app is unreachable, slow, or erroring, your tool calls
still run.** The plugin never blocks a session because of its own failure.

This matters more here than on other harnesses. OpenCode's documented way to
block a tool call is to *throw* from `tool.execute.before`, and its plugin
runner invokes hooks without a catch — so an accidental exception would be
indistinguishable from a deliberate block and would fail **closed**. To prevent
that, every hook body in this plugin catches all errors, and the only exception
ever rethrown is a `SecureVectorDenial` constructed on purpose after a policy
decision. Requests to the local app use a 100 ms timeout.

## Configuration

| Env var | Purpose |
|---|---|
| `SECUREVECTOR_ENGINE_ENDPOINT` | Point the plugin at a non-default engine (e.g. a self-hosted endpoint). Falls back to `SV_BASE_URL`, then `http://127.0.0.1:8741`. |
| `SECUREVECTOR_API_KEY` | Bearer token for a token-gated remote engine. Not needed for the default loopback app. |

## Privacy

See [PRIVACY.md](./PRIVACY.md). Short version: loopback only, no telemetry, no
files written, secrets redacted before any scan, and size-capped previews.

## Requirements

- OpenCode (verified against 1.18.23)
- The SecureVector local app (`pip install securevector`)
- Node 18+ / Bun — whichever runtime OpenCode is using. Zero npm dependencies.

## Licence & trademarks

Apache-2.0. See [LICENSE](./LICENSE).

This is a third-party integration published by SecureVector. It is not
affiliated with, endorsed by, or sponsored by the OpenCode project or its
maintainers. "OpenCode" is used nominatively, solely to identify the software
this plugin interoperates with.
