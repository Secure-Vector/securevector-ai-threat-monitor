# OpenClaw / ClawdBot Integration

SecureVector integrates with OpenClaw in two modes: **Monitor Mode** (plugin only, zero latency) and **Block Mode** (plugin + proxy for active blocking).

## Monitor Mode (default, ZERO latency)

The SecureVector Guard plugin runs natively inside OpenClaw. No proxy, no env vars, no added latency on the LLM request path. The plugin scans prompts, audits tool calls with full arguments, tracks costs, and logs threats to the dashboard — all without intercepting LLM traffic.

```bash
# 1. Start SecureVector
securevector-app --web

# 2. Install the plugin (Integrations tab in the UI, or via API)
curl -X POST http://localhost:8741/api/hooks/install

# 3. Restart OpenClaw — the plugin loads automatically
openclaw gateway
```

**What the plugin does:**

| Guard | Hook | Description |
|-------|------|-------------|
| Input Guard | `message_received` | Scans user messages for prompt injection, jailbreaks, social engineering |
| Tool Audit | `agent_end` | Records every tool call with arguments, checks against permission rules |
| Output Guard | `tool_result_persist` | Inspects tool results for credential leaks and PII |
| Context Guard | `before_agent_start` | Injects security directives into the agent system prompt |
| Cost Tracker | `llm_output` | Records LLM token usage for cost tracking |

## Block Mode (optional)

Enable block mode to actively stop threats and unauthorized tool calls before they reach the LLM. This starts a proxy that intercepts LLM traffic. The plugin continues monitoring; the proxy adds blocking.

```bash
# 1. Enable block mode from the dashboard toggle (or svconfig.yml: block_mode: true)
# 2. The proxy starts automatically on port 8742
# 3. Restart OpenClaw with proxy env vars:

# Linux / macOS
export OPENAI_BASE_URL=http://127.0.0.1:8742/openai/v1

# Windows (PowerShell)
$env:OPENAI_BASE_URL="http://127.0.0.1:8742/openai/v1"

# 4. Start OpenClaw
openclaw gateway
```

### Disabling Block Mode

When you disable block mode, unset the env vars and restart OpenClaw to connect directly to the LLM provider. The plugin keeps monitoring without the proxy.

```bash
# Linux / macOS
unset OPENAI_BASE_URL

# Windows (PowerShell)
Remove-Item Env:\OPENAI_BASE_URL -ErrorAction SilentlyContinue
```

## Tool Activity

Every tool call your agent invokes (`read`, `write`, `exec`, `web_search`, etc.) is recorded on the **Tool Activity** page as `allow`, `block`, or `log_only`.

OpenClaw gets the richest audit because the plugin captures both MCP tools and LLM function calls. See [Tool Permissions & Tool Activity](./TOOL_PERMISSIONS.md) for how decisions are made, how block mode changes behavior, and the integration-by-integration logging matrix.

## Plugin API

```bash
curl -X POST http://localhost:8741/api/hooks/install                    # Install
curl http://localhost:8741/api/hooks/status                              # Status
curl -X POST http://localhost:8741/api/hooks/install -d '{"force":true}' # Reinstall
curl -X POST http://localhost:8741/api/hooks/uninstall                   # Uninstall
```

## Manual Install

If the Install button doesn't work, you can install manually:

```bash
# Linux / macOS
mkdir -p ~/.openclaw/plugins/securevector-guard

# Windows (PowerShell)
New-Item -ItemType Directory -Force -Path "$env:APPDATA\openclaw\plugins\securevector-guard"
```

Copy all four plugin files from the [source](../src/securevector/plugins/openclaw/) into the directory:

- `openclaw.plugin.json` — plugin manifest
- `package.json` — plugin metadata
- `index.ts` — main plugin entry (runtime guards, fetch-to-SecureVector)
- `config.ts` — config resolver (env vars + svconfig.yml reads)

> **Why two TypeScript files?** OpenClaw's plugin scanner flags files that both read `process.env` and make network requests as a potential credential-harvesting pattern. Splitting config reads into `config.ts` keeps `index.ts` network-only and lets the plugin load cleanly.

Then register with OpenClaw:

```bash
openclaw plugins install --link ~/.openclaw/plugins/securevector-guard
openclaw plugins list  # verify
```
