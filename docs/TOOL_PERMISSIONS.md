# Tool Permissions & Tool Activity

SecureVector inspects every tool call your AI agent makes and records a decision on the **Tool Activity** page: `allow`, `block`, or `log_only`. This guide explains how the decision is made, how to enforce it, and which integrations participate.

## How the decision is made

Two inputs combine to produce the `action` column in Tool Activity:

1. **The tool's permission policy** in SecureVector — one of `allow`, `block`, or `log_only`. Configurable on the **Tool Permissions** page.
2. **Block mode** — a global toggle (Dashboard → Block Mode, or `block_mode` in `svconfig.yml`) that turns on the proxy for active enforcement. With block mode off, `block` policies are demoted to `log_only` so nothing is actually rejected.

| Tool policy (SV) | Block mode | Recorded action | What actually happens |
|---|---|---|---|
| **allow** | either | `allow` | Tool call runs. Logged as allowed. |
| **block** | **ON** (proxy running) | `block` | Proxy rejects the tool call before the LLM sees a result. Gateway log: `TOOL BLOCKED — <tool>`. |
| **block** | **OFF** | `log_only` | Tool call still runs. Logged with note `(audit only — enable proxy to block)`. Gateway log: `TOOL AUDIT (would block) — <tool>`. |
| **log_only** | either | `log_only` | Tool call runs. Always logged for audit trail. |

### Quick guide

- **Want a passive audit trail without changing agent behavior?** Keep block mode OFF — everything is captured as `log_only` or `allow`.
- **Want hard enforcement?** Turn block mode ON and start the proxy — `block` policies start rejecting tool calls at the proxy layer.

## Which integrations log tool calls?

The decision logic above is universal — it's SecureVector's policy engine. **Whether a tool call actually lands in the Tool Activity log depends on the path it takes.**

| Integration path | Logged? | Captured by |
|---|---|---|
| **OpenClaw / ClawdBot with plugin installed** | ✅ | Plugin captures MCP tools (`read`, `exec`, `write`) **and** LLM tool calls. See [OpenClaw integration](./OPENCLAW.md). |
| **LangChain / LangGraph / CrewAI / n8n / direct SDK via proxy** (`OPENAI_BASE_URL=http://localhost:8742/...`) | ✅ | Proxy intercepts LLM function-call responses and enforces + logs. |
| **Direct SDK to provider** (no proxy, no plugin) | ❌ | Neither intercept path sees the traffic. |
| **Ollama local calls that bypass both** | ❌ | Same as above. |
| **Custom integration** | Optional | POST to `/api/tool-permissions/call-audit` from your own callback — useful for framework-specific audit hooks. |

OpenClaw users get the richest audit because the plugin also captures MCP-only tools (file reads, shell execs, workspace edits) that never touch the proxy. Other integrations see their function-calling tool calls when traffic routes through the multi-provider proxy on port 8742.

## Essential tools and custom tools

SecureVector ships **66 essential tool definitions** covering workspace I/O, shell execution, network calls, credentials, and more. **54 of them default to `block`** (activated when block mode is on); the rest default to `allow` or `log_only`.

To override defaults or add project-specific tools:

1. Open the **Tool Permissions** page in the SecureVector UI.
2. Edit any essential tool's policy (`allow` / `block` / `log_only`), or click **+ Add Custom Tool** to register a new one by name.

Custom tools are matched by name against the tool invocations your agent makes — so a custom entry for `my_internal_api` will catch calls to that function regardless of which framework issued them.

## API reference

```bash
# Read settings (block mode, tool_permissions_enabled)
curl http://localhost:8741/api/settings

# Enable/disable block mode
curl -X PUT http://localhost:8741/api/settings \
  -H "Content-Type: application/json" \
  -d '{"block_threats": true}'

# List recent audit entries
curl "http://localhost:8741/api/tool-permissions/call-audit?limit=50"

# Audit stats (total/blocked/allowed/log_only)
curl http://localhost:8741/api/tool-permissions/call-audit/stats

# Custom integration — log a tool call from your own code
curl -X POST http://localhost:8741/api/tool-permissions/call-audit \
  -H "Content-Type: application/json" \
  -d '{
    "tool_id": "my_custom_tool",
    "function_name": "session:my-agent",
    "action": "allow",
    "risk": "read",
    "reason": "Passed custom policy",
    "is_essential": false,
    "args_preview": "query=..."
  }'
```

## See also

- [OpenClaw integration guide](./OPENCLAW.md) — plugin install, monitor mode, block mode
- Tool Permissions page in the SecureVector UI — view and edit per-tool policies
