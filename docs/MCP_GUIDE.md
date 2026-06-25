# SecureVector MCP Server - Complete Guide

Complete guide for setting up and using the SecureVector MCP server with Claude Desktop, Claude Code, and Cursor IDE.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Available Tools](#available-tools)
3. [Platform Integration](#platform-integration)
   - [Claude Desktop](#claude-desktop)
   - [Claude Code (CLI)](#claude-code-cli)
   - [Cursor IDE](#cursor-ide)
4. [Docker Deployment](#docker-deployment)
5. [Direct Installation](#direct-installation)
6. [Configuration](#configuration)
7. [Troubleshooting](#troubleshooting)
8. [Advanced Topics](#advanced-topics)

---

## Quick Start

### Prerequisites
- Docker installed and running
- Claude Desktop, Claude Code, or Cursor IDE installed

### Start the MCP Server

```bash
# Pull the latest image
docker pull securevectorrepo/securevector-mcp-server:latest

# Start using docker-compose
docker-compose up -d

# Verify it's running
docker ps | grep securevector-mcp
docker logs -f securevector-mcp
```

**Available Images:**
- `securevectorrepo/securevector-mcp-server:latest` - Production

---

## Available Tools

The server exposes four MCP tools. All run locally against the SecureVector
engine — no prompt or tool argument leaves the machine unless you explicitly
enable cloud/hybrid mode with an API key.

| Tool | Purpose |
|------|---------|
| `analyze_prompt` | Analyze a single prompt for prompt-injection, jailbreaks, data-exfiltration and other threats. Returns `is_threat`, `risk_score` (0-100), `threat_types`, and a recommended action (`allow` / `warn` / `review` / `block`). |
| `batch_analyze` | Analyze many prompts in one call; same verdict shape per item, with aggregate statistics. |
| `get_threat_statistics` | Summary of detections over a time window (counts by threat type, action, and trend). |
| `check_tool_permission` | Decide whether a tool/function call is permitted **before it runs**, and record the decision to the tamper-evident audit chain. |

### Standalone vs companion — does this need the local app?

| Capability | App **not** running | App running (companion) |
|---|---|---|
| **Threat + secret detection** (`analyze_prompt`, `batch_analyze`) | ✅ Works. The detection engine (195+ patterns) is bundled in the MCP package and runs **in-process, offline, no API key**. | ✅ Routed through the app's `/analyze`, so detections respect the app's Cloud Connect state and land in its timeline (and, when enrolled, the cloud fleet view). |
| `get_threat_statistics` | ✅ Local stats | ✅ |
| **Tool permissions** (`check_tool_permission`) | ⚠️ Fails open (allow-all) — the policy registry + audit chain live in the app. | ✅ Real allow/deny enforcement + tamper-evident audit. |

In short: **detection works MCP-alone, offline and keyless; allow/deny governance needs the app.** Over **stdio** (Claude Desktop and other local hosts) the server needs no API key — authentication is for the HTTP/SSE transports. Set `SECUREVECTOR_API_KEY` only when you want standalone *cloud* detection without the app; when the app is running it decides cloud-vs-local for you.

### `check_tool_permission`

This brings SecureVector's **tool-permission governance** to MCP hosts. Before an
agent runs a sensitive tool (a shell command, a file write, a web fetch), the
host can ask SecureVector whether the call is allowed — and every call is logged
for replay and audit, attributed to `runtime_kind="mcp"` so MCP traffic is
distinguishable from SDK and plugin traffic on the Tool Permissions and Agent
Map views.

The decision is resolved against the running local app exactly the way the
SecureVector SDKs and the OpenClaw hook resolve it, with this precedence:

```
cloud-synced policy  >  local user override  >  essential-tool registry  >  default-allow
```

**Arguments:**

| Arg | Required | Description |
|-----|----------|-------------|
| `tool_id` | yes | Canonical tool identifier to check (e.g. `WebFetch`, `filesystem.write`, `shell.exec`). |
| `function_name` | no | Human-facing function name for the audit row (defaults to `tool_id`). |
| `args_preview` | no | Short, redaction-safe preview of the call arguments (truncated to 2 KB — never pass secrets). |
| `session_id` | no | Conversation/session id used to group calls on the Agent Map. |
| `record` | no | `true` (default) appends an audit row; set `false` for a dry-run policy lookup. |

**Returns:** `allowed` (bool), `action` (`allow` / `block`), `tier`
(`synced` / `override` / `essential` / `default`), `risk`, `reason`,
`is_essential`, `audited`, and `app_reachable`.

> **Fail-open by design:** if the local app is not reachable, the tool returns
> `allowed: true` with `app_reachable: false` rather than hard-failing the host —
> so a stopped app never blocks your agent. Start the app to enforce policy.

This tool needs the local SecureVector app running (it serves the policy and the
audit chain). Point the server at a non-default app URL with
`SECUREVECTOR_SDK_APP_URL` (see [Configuration](#configuration)).

---

## Platform Integration

### Required Flags Reference

| Platform | Flags Required | Mode Options |
|----------|----------------|--------------|
| **Claude Desktop** | None | Default |
| **Claude Code** | `--direct-mode`, `--mode` | `production`, `development` |
| **Cursor IDE** | `--direct-mode`, `--mode` | `production`, `development` |

**⚠️ CRITICAL:** The `--mode` flag is **required** for Claude Code/Cursor. Without it, you'll get a `'str' object has no attribute 'value'` error.

---

### Claude Desktop

**Step 1:** Start the MCP server container
```bash
docker-compose up -d
```

**Step 2:** Configure Claude Desktop

Add to your config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "securevector": {
      "command": "docker",
      "args": [
        "exec",
        "-i",
        "securevector-mcp",
        "python",
        "-m",
        "securevector.mcp"
      ]
    }
  }
}
```

**Step 3:** Restart Claude Desktop

---

### Claude Code (CLI)

**Configuration Location:** `.claude/mcp.json` in project root or `~/.claude.json` globally

```json
{
  "mcpServers": {
    "securevector": {
      "command": "docker",
      "args": [
        "exec",
        "-i",
        "securevector-mcp",
        "python",
        "-m",
        "securevector.mcp",
        "--direct-mode",
        "--mode",
        "production"
      ],
      "env": {
        "SECUREVECTOR_MCP_TRANSPORT": "stdio",
        "SECUREVECTOR_MCP_LOG_LEVEL": "INFO"
      }
    }
  }
}
```

---

### Cursor IDE

Use the same JSON configuration as Claude Code above. The config file location for Cursor is:
- Settings → MCP Servers
- Or `.cursor/mcp.json` in project root

---

## Docker Deployment

### Building Images

**Production:**
```bash
docker build -f Dockerfile.mcp -t securevectorrepo/securevector-mcp-server:latest .
```

**Multi-platform (for publishing):**
```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f Dockerfile.mcp \
  -t securevectorrepo/securevector-mcp-server:latest \
  --push \
  .
```

### Using Docker Compose

**Start:**
```bash
docker-compose up -d
```

**View Logs:**
```bash
docker logs -f securevector-mcp
```

**Stop:**
```bash
docker-compose down
```

**Update:**
```bash
docker-compose pull && docker-compose up -d --force-recreate
```

### Container Management

**Health Check:**
```bash
docker exec -i securevector-mcp python -m securevector.mcp --validate-only
```

**Access Shell:**
```bash
docker exec -it securevector-mcp bash
```

**View Stats:**
```bash
docker stats securevector-mcp
```

---

## Direct Installation

### Install Without Docker

```bash
# Install the package
pip install securevector[mcp]

# Or install from source
cd ai-threat-monitor
pip install -e ".[mcp]"
```

### Configuration

With a direct (non-Docker) install you can launch the server two equivalent
ways:

- `securevector-mcp` — the installed console command, or
- `python -m securevector.mcp` — the module form (handy when several Python
  environments are on PATH and you want to pin the interpreter).

Both run the same server; use whichever your host config prefers.

**Claude Desktop:**
```json
{
  "mcpServers": {
    "securevector": {
      "command": "securevector-mcp"
    }
  }
}
```

**Claude Code/Cursor:**
```json
{
  "mcpServers": {
    "securevector": {
      "command": "securevector-mcp",
      "args": ["--direct-mode", "--mode", "production"]
    }
  }
}
```

> Prefer to pin the interpreter? Swap `"command": "securevector-mcp"` for
> `"command": "python", "args": ["-m", "securevector.mcp", ...]` — the module
> form is equivalent.

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SECUREVECTOR_API_KEY` | - | API key for cloud/hybrid mode |
| `SECUREVECTOR_MCP_MODE` | `balanced` | Server mode: `development`, `balanced`, `production` |
| `SECUREVECTOR_MCP_LOG_LEVEL` | `INFO` | Log level: `DEBUG`, `INFO`, `WARNING`, `ERROR` |
| `SECUREVECTOR_MCP_TRANSPORT` | `stdio` | Transport: `stdio`, `http`, `sse` |
| `SECUREVECTOR_SDK_APP_URL` | `http://127.0.0.1:8741` | Local SecureVector app URL used by `check_tool_permission` to resolve policy and write audit rows. Point this at a remote/self-hosted instance if the app runs elsewhere. |

### Using .env File

Create `.env` file:
```bash
SECUREVECTOR_API_KEY=your_api_key_here
SECUREVECTOR_MCP_MODE=balanced
SECUREVECTOR_MCP_LOG_LEVEL=INFO
```

Reference in `docker-compose.yml`:
```yaml
services:
  securevector-mcp:
    env_file:
      - .env
```

---

## Troubleshooting

### Container Not Running

```bash
# Check if container exists
docker ps -a | grep securevector-mcp

# Start the container
docker-compose up -d

# Check logs for errors
docker logs securevector-mcp
```

### Connection Issues

**Claude Code timeout (30 seconds)?**
- Ensure `--direct-mode` and `--mode` flags are present
- Check container is running: `docker ps`
- Verify config file syntax (valid JSON)

### Module Not Found Errors

```bash
# Verify package is installed in container
docker exec -i securevector-mcp pip list | grep securevector

# Test module import
docker exec -i securevector-mcp python -c "import securevector.mcp; print('OK')"

# If failing, rebuild the image
docker-compose build --no-cache
```

### 'str' object has no attribute 'value' Error

**Cause:** Missing `--mode` flag in Claude Code/Cursor configuration

**Solution:** Add `--direct-mode` and `--mode production` (or `--mode development`) to your args:
```json
{
  "mcpServers": {
    "securevector": {
      "command": "securevector-mcp",
      "args": ["--direct-mode", "--mode", "production"]
    }
  }
}
```

### Configuration Not Loading

**Claude Desktop:**
1. Validate JSON syntax: `python -m json.tool < config.json`
2. Check file permissions
3. View logs in `~/Library/Logs/Claude/` (macOS) or equivalent

**Claude Code:**
1. Ensure `.claude/mcp.json` exists (or check `~/.claude.json`)
2. Restart Claude Code completely
3. Check for syntax errors in JSON

---

## Advanced Topics

### Resource Limits

Set limits in `docker-compose.yml`:
```yaml
deploy:
  resources:
    limits:
      cpus: '1.0'
      memory: 512M
    reservations:
      cpus: '0.25'
      memory: 128M
```

### Custom Configuration

Create `docker-compose.override.yml`:
```yaml
services:
  securevector-mcp:
    environment:
      - SECUREVECTOR_API_KEY=${MY_API_KEY}
    volumes:
      - ./my_config:/app/config
```

### Platform-Specific Notes

**macOS:**
- Docker Desktop must be running
- Check not in "Paused" state

**Windows:**
- Use Docker Desktop with WSL2 backend
- Use Windows paths for config: `%APPDATA%\Claude\claude_desktop_config.json`

**Linux:**
- Add user to docker group:
  ```bash
  sudo usermod -aG docker $USER
  newgrp docker
  ```

---

## Support

**Issues?**
1. Check container logs: `docker logs securevector-mcp`
2. Verify Docker status: `docker info`
3. Test server: `docker exec -i securevector-mcp python -m securevector.mcp --validate-only`
4. Check config file syntax
5. See platform-specific logs (Claude Desktop/Code)

**Key Files:**
- Docker: `docker-compose.yml`, `Dockerfile.mcp`
- Config: `.claude/mcp.json` (Claude Code), `.cursor/mcp.json` (Cursor), `claude_desktop_config.json` (Claude Desktop)
- Examples: `examples/mcp/.env.example`

---

## Summary

✅ **Quick Setup:** `docker-compose up -d` + configure IDE
✅ **Claude Desktop:** No special flags needed
✅ **Claude Code/Cursor:** Requires `--direct-mode --mode production`
✅ **Critical:** `--mode` flag prevents `'str' object` errors
✅ **Images:** Available on Docker Hub

For more details, see the [main README](../README.md) or [SDK documentation](SDK_USAGE.md).
