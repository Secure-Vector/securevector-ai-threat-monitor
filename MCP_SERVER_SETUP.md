# SecureVector MCP Server Setup

Quick setup guide for integrating SecureVector MCP server with Claude Desktop, Claude CLI, and other MCP clients.

## Installation

```bash
pip install securevector-ai-monitor[mcp]
```

## Configuration

### Analysis Operation Modes

**IMPORTANT:** You must explicitly set the `SECUREVECTOR_MODE` environment variable to use local community rules. Without this variable, the MCP server will use auto mode.

SecureVector supports four analysis modes controlled by the `SECUREVECTOR_MODE` environment variable:

- **`local`** - Offline mode using community threat detection rules (195+ patterns from 9 rule files). No API key required. **Recommended for development and when API key is not available.**
- **`api`** - Cloud-based detection using SecureVector API. Requires API key.
- **`hybrid`** - Intelligent combination of local + API detection. Uses local first, API for enhanced analysis. Requires API key.
- **`auto`** - Automatic mode selection (defaults to `local` without API key, `hybrid` with API key).

### Sample Configurations

#### Local Mode (Offline, No API Key Required)

Works completely offline with community threat detection rules.

```json
{
  "mcpServers": {
    "securevector": {
      "command": "python",
      "args": ["-m", "securevector.mcp"],
      "env": {
        "SECUREVECTOR_MODE": "local"
      }
    }
  }
}
```

#### API Mode (Cloud Detection, API Key Required)

Uses SecureVector cloud API for enhanced threat detection.

```json
{
  "mcpServers": {
    "securevector": {
      "command": "python",
      "args": ["-m", "securevector.mcp"],
      "env": {
        "SECUREVECTOR_MODE": "api",
        "SECUREVECTOR_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

#### Hybrid Mode (Best of Both, API Key Required)

Combines local rules with cloud API for optimal detection.

```json
{
  "mcpServers": {
    "securevector": {
      "command": "python",
      "args": ["-m", "securevector.mcp"],
      "env": {
        "SECUREVECTOR_MODE": "hybrid",
        "SECUREVECTOR_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

#### Auto Mode (Automatic Selection)

Automatically selects the best mode based on API key availability.

```json
{
  "mcpServers": {
    "securevector": {
      "command": "python",
      "args": ["-m", "securevector.mcp"],
      "env": {
        "SECUREVECTOR_MODE": "auto",
        "SECUREVECTOR_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

**Or use empty env (defaults to auto mode, selects local without API key):**

```json
{
  "mcpServers": {
    "securevector": {
      "command": "python",
      "args": ["-m", "securevector.mcp"],
      "env": {}
    }
  }
}
```

### Advanced Configuration Options

#### Server Configuration Modes

The MCP server supports three configuration modes via `--mode` argument or `args` in mcp.json:

- **`balanced`** (default) - Balanced security and performance settings
- **`development`** - Relaxed settings for development/testing
- **`production`** - Strict security settings, requires API key

Example with server mode:

```json
{
  "mcpServers": {
    "securevector": {
      "command": "python",
      "args": ["-m", "securevector.mcp", "--mode", "production"],
      "env": {
        "SECUREVECTOR_MODE": "hybrid",
        "SECUREVECTOR_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

#### Additional Environment Variables

```json
{
  "mcpServers": {
    "securevector": {
      "command": "python",
      "args": ["-m", "securevector.mcp"],
      "env": {
        "SECUREVECTOR_MODE": "local",
        "SECUREVECTOR_LOG_LEVEL": "INFO",
        "SECUREVECTOR_RISK_THRESHOLD": "70",
        "SECUREVECTOR_ENABLE_CACHE": "true",
        "SECUREVECTOR_RULES_PATH": "/path/to/custom/rules"
      }
    }
  }
}
```

**Available Environment Variables:**

- `SECUREVECTOR_MODE` - Analysis mode: `local`, `api`, `hybrid`, `auto`
- `SECUREVECTOR_API_KEY` - API key for cloud/hybrid modes
- `SECUREVECTOR_API_URL` - Custom API endpoint (optional)
- `SECUREVECTOR_LOG_LEVEL` - Logging level: `DEBUG`, `INFO`, `WARNING`, `ERROR`
- `SECUREVECTOR_RISK_THRESHOLD` - Risk score threshold (0-100, default: 70)
- `SECUREVECTOR_ENABLE_CACHE` - Enable caching: `true`, `false`
- `SECUREVECTOR_RULES_PATH` - Custom rules directory path
- `SECUREVECTOR_LOG_ALL` - Log all requests: `true`, `false`
- `SECUREVECTOR_RAISE_ON_THREAT` - Raise exception on threats: `true`, `false`

#### Command-Line Arguments

When running the MCP server directly (for testing):

```bash
# Basic usage
python -m securevector.mcp

# With specific mode and API key
python -m securevector.mcp --mode production --api-key YOUR_KEY

# Validate configuration
python -m securevector.mcp --validate-only

# Health check
python -m securevector.mcp --health-check

# Install to Claude Desktop
python -m securevector.mcp --install-claude
```

**Available Arguments:**

- `--mode` - Server config mode: `development`, `production`, `balanced`
- `--api-key` - SecureVector API key
- `--transport` - Transport protocol: `stdio`, `http`, `sse`
- `--host` - Server host (default: localhost)
- `--port` - Server port (default: 8000)
- `--log-level` - Logging level: `DEBUG`, `INFO`, `WARNING`, `ERROR`
- `--validate-only` - Validate configuration and exit
- `--health-check` - Perform health check and exit
- `--install-claude` - Install to Claude Desktop
- `--direct-mode` - Use FastMCP direct mode (for stdio)

### Configuration File Locations

- **Claude Desktop**: `~/.config/claude/mcp.json` (Linux/Mac) or `%APPDATA%\Claude\mcp.json` (Windows)
- **Claude Code/Cursor**: `~/.cursor/mcp.json` (Linux/Mac) or `%APPDATA%\Cursor\mcp.json` (Windows)
- **Claude CLI**: `~/.config/claude-cli/mcp.json`

## Quick Setup

```bash
# Auto-install for Claude Desktop
python examples/mcp/claude_desktop_integration.py --install

# Auto-install for Claude CLI
python examples/mcp/claude_cli_integration.py --install

# Validate setup
python -m securevector.mcp --validate-only
```

## Available MCP Tools

- `analyze_prompt` - Analyze prompts for security threats
- `batch_analyze` - Process multiple prompts
- `get_threat_statistics` - View detection metrics
