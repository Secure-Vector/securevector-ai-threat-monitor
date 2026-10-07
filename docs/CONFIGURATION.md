# Configuration

The config file, Cloud Sync for MCP policies, and how to point an agent at the LLM proxy. Install steps are in [INSTALLATION.md](INSTALLATION.md); first-run setup is in [GETTING_STARTED.md](GETTING_STARTED.md).

## The config file

SecureVector writes `svconfig.yml` to your app data directory on first run with sensible defaults.

The config path is printed at startup: `~/.local/share/securevector/threat-monitor/svconfig.yml` (Linux), `~/Library/Application Support/SecureVector/ThreatMonitor/svconfig.yml` (macOS), `%LOCALAPPDATA%/SecureVector/ThreatMonitor/svconfig.yml` (Windows). Key settings (all editable from the dashboard, which writes back to this file):

```yaml
server:   { host: 127.0.0.1, port: 8741 }        # change port if 8741 is taken
security: { block_mode: false, output_scan: true } # log/warn by default; flip block_mode to hard-stop
budget:   { daily_limit: 5.00, warn: true, block: true }  # USD/day, LLM proxy traffic only; null to disable
tools:    { enforcement: true }                   # apply allow/block tool rules
proxy:    { integration: openclaw, mode: multi-provider, host: 127.0.0.1, port: 8742 }
          # integration: openclaw | langchain | langgraph | crewai | hermes | ollama; port defaults to server.port + 1
```

## MCP Policies: Cloud Sync (optional)

If your org distributes signed MCP tool-policy bundles from SecureVector Cloud, enroll the device once and let the local app long-poll for updates.

**1. Admin mints a token** in the cloud admin UI (`app.securevector.io` → Onboarding → Invite users) and shares the install command.

**2. User enrolls locally:**

```bash
securevector-app enroll svet_<token>
```

The local app POSTs `/api/v1/devices/enroll`, persists `org_id` + signing key + auth credentials to `~/Library/Application Support/.credentials` (macOS; equivalent path on Linux/Windows), and starts the cloud sync loop on next launch.

**3. Set `SECUREVECTOR_API_KEY` for stable sync auth (recommended).**

The local app accepts two auth methods on `/policy/sync`. The API key path is **canonical**: it eliminates the short-lived-JWT refresh fragility that can leave a device unable to sync if the refresh token goes stale.

```bash
export SECUREVECTOR_API_KEY=sk-<long-lived-key>
```

| Auth method | Header sent | Source | Lifetime | Sync stability |
|---|---|---|---|---|
| **API key** (recommended) | `X-Api-Key: sk-...` | `SECUREVECTOR_API_KEY` env, then `creds.api_key` | Long-lived | Robust: no refresh path needed |
| JWT (fallback) | `Authorization: Bearer ...` | Stored from enrollment | ~1h, auto-refresh on 401/403 | Breaks if the refresh token expires; requires re-enrollment to recover |

When both are present, the API key wins. `device_id` rides as `X-SecureVector-Device-Id` on every request regardless of auth method; `org_id` is resolved server-side from the auth principal.

You can mint API keys in the cloud admin UI under Access Management. Set the env var in your shell profile or systemd service unit so it survives restarts.

**4. Cloud Sync starts automatically** once enrolled, with no further configuration. Only then does the app contact the cloud endpoints (`auth.securevector.io` and `engine.securevector.io`); an app that never enrolled does not call them. Override env vars exist for self-hosted / on-prem deployments only.

Synced rules are read-only on the device; authoring lives in the cloud admin. The MCP Policies page (sidebar → Configure → MCP Policies) shows verification status, applied policies + rules, and a Sync Now button for manual refresh.

## Pointing your agent at the proxy

For frameworks without an SDK (Ollama, n8n, Dify, raw HTTP clients), point your application at SecureVector's proxy instead of the provider's API. LangChain, LangGraph and CrewAI should use their SDK instead; do not use both, or model calls are counted twice. If the proxy is not running, calls through it fail rather than skip the check. OpenClaw/ClawdBot users only need this when block mode is enabled.

Start the proxy from **Connect Agents** → **Start Proxy**, then set the base URL in your agent's environment:

<table>
<tr>
<th align="left" width="50%">Windows</th>
<th align="left" width="50%">Linux / macOS</th>
</tr>
<tr>
<td valign="top">

**Command Prompt** (current session)
<pre>set OPENAI_BASE_URL=http://localhost:8742/openai/v1
set ANTHROPIC_BASE_URL=http://localhost:8742/anthropic</pre>

**PowerShell** (current session)
<pre>$env:OPENAI_BASE_URL="http://localhost:8742/openai/v1"
$env:ANTHROPIC_BASE_URL="http://localhost:8742/anthropic"</pre>

**PowerShell** (persistent, per user)
<pre>[Environment]::SetEnvironmentVariable(
  "OPENAI_BASE_URL",
  "http://localhost:8742/openai/v1",
  "User"
)</pre>

</td>
<td valign="top">

**Terminal** (current session)
<pre>export OPENAI_BASE_URL=http://localhost:8742/openai/v1
export ANTHROPIC_BASE_URL=http://localhost:8742/anthropic</pre>

**Persistent** (add to `~/.bashrc` or `~/.zshrc`)
<pre>echo 'export OPENAI_BASE_URL=http://localhost:8742/openai/v1' >> ~/.bashrc
echo 'export ANTHROPIC_BASE_URL=http://localhost:8742/anthropic' >> ~/.bashrc
source ~/.bashrc</pre>

</td>
</tr>
</table>

Every request is scanned for prompt injection. Every response is scanned for data leaks. Every dollar is tracked, whether via native plugin (OpenClaw) or proxy (all other frameworks).

**Supported providers (13):** `openai` `anthropic` `gemini` `ollama` `groq` `deepseek` `mistral` `xai` `together` `cohere` `cerebras` `moonshot` `minimax`

## Related

- [Tool Permissions](TOOL_PERMISSIONS.md): allow / block / log_only rules per tool
- [Device Identity](DEVICE_IDENTITY.md): the `device_id` that Cloud Sync and the SIEM Forwarder carry
- [SIEM Forwarder](siem/README.md): destinations, what leaves the machine, reliability
