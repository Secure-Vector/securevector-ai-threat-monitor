# SecureVector MCP Server Setup

Quick setup guide for integrating SecureVector MCP server with Claude Desktop, Claude CLI, and other MCP clients.

## Installation

```bash
pip install securevector-ai-monitor[mcp]
```

## Configuration

### Sample mcp.json (Local Mode - No API Key)

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

### Sample mcp.json (Hybrid Mode - With API Key)

```json
{
  "mcpServers": {
    "securevector": {
      "command": "python",
      "args": ["-m", "securevector.mcp"],
      "env": {
        "SECUREVECTOR_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Configuration File Locations

- **Claude Desktop**: `~/.config/claude/mcp.json` (Linux/Mac) or `%APPDATA%\Claude\mcp.json` (Windows)
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
