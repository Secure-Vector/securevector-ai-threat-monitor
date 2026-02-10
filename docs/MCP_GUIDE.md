# SecureVector MCP Server - Complete Guide

Complete guide for setting up and using the SecureVector MCP server with Claude Desktop, Claude Code, and Cursor IDE.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Platform Integration](#platform-integration)
   - [Claude Desktop](#claude-desktop)
   - [Claude Code (CLI)](#claude-code-cli)
   - [Cursor IDE](#cursor-ide)
3. [Docker Deployment](#docker-deployment)
4. [Direct Installation](#direct-installation)
5. [Configuration](#configuration)
6. [Troubleshooting](#troubleshooting)
7. [Advanced Topics](#advanced-topics)

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

**Claude Desktop:**
```json
{
  "mcpServers": {
    "securevector": {
      "command": "python",
      "args": ["-m", "securevector.mcp"]
    }
  }
}
```

**Claude Code/Cursor:**
```json
{
  "mcpServers": {
    "securevector": {
      "command": "python",
      "args": ["-m", "securevector.mcp", "--direct-mode", "--mode", "production"]
    }
  }
}
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SECUREVECTOR_API_KEY` | - | API key for cloud/hybrid mode |
| `SECUREVECTOR_MCP_MODE` | `balanced` | Server mode: `development`, `balanced`, `production` |
| `SECUREVECTOR_MCP_LOG_LEVEL` | `INFO` | Log level: `DEBUG`, `INFO`, `WARNING`, `ERROR` |
| `SECUREVECTOR_MCP_TRANSPORT` | `stdio` | Transport: `stdio`, `http`, `sse` |

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

**Solution:** Add `--mode production` or `--mode development` to your args:
```json
"args": [..., "--direct-mode", "--mode", "production"]
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
