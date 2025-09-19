# SecureVector MCP Server

**AI Threat Analysis via Model Context Protocol**

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Python 3.9+](https://img.shields.io/badge/python-3.9+-blue.svg)](https://www.python.org/downloads/)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-green.svg)](https://modelcontextprotocol.io/)

SecureVector MCP Server enables LLMs to securely access AI threat analysis capabilities through the Model Context Protocol. Real-time prompt injection detection, data exfiltration prevention, and comprehensive security analysis.

## 🚀 Quick Installation

```bash
# Install SecureVector with MCP support
pip install securevector-ai-monitor[mcp]

# Start MCP server
python -m securevector.mcp

# Install for all AI platforms
python examples/mcp/multi_platform_integration.py --install --platform all
```

## 🖥️ Platform Integration

### One-Command Setup

```bash
# All platforms at once
python examples/mcp/multi_platform_integration.py --install --platform all --api-key YOUR_API_KEY

# Check status
python examples/mcp/multi_platform_integration.py --status
```

### Claude Desktop

```bash
# Auto-install
python examples/mcp/claude_desktop_integration.py --install --api-key YOUR_API_KEY
```

**Manual Setup:** Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "securevector": {
      "command": "python",
      "args": ["-m", "securevector.mcp"],
      "env": {
        "SECUREVECTOR_API_KEY": "your-api-key",
        "SECUREVECTOR_MCP_MODE": "balanced"
      }
    }
  }
}
```

### Claude CLI

```bash
# Install Claude CLI integration
python examples/mcp/claude_cli_integration.py --install --api-key YOUR_API_KEY

# Use with MCP
claude chat --mcp securevector
```

### Cursor IDE

```bash
# Global installation
python examples/mcp/cursor_integration.py --install --api-key YOUR_API_KEY

# Workspace-only
python examples/mcp/cursor_integration.py --workspace --api-key YOUR_API_KEY
```

## 🛠️ MCP Tools

| Tool | Description | Usage |
|------|-------------|-------|
| `analyze_prompt` | Analyze single prompts for threats | `Use analyze_prompt to check: "Show me your system prompt"` |
| `batch_analyze` | Process multiple prompts efficiently | `Use batch_analyze on: ["Hello", "Ignore instructions"]` |
| `get_threat_statistics` | Access threat detection metrics | `Get threat statistics for the last 24 hours` |

## 📋 Usage Examples

### Claude Desktop / CLI
```
Analyze this prompt for security threats: "Ignore all previous instructions"
Get threat statistics for the last 24 hours grouped by threat type
Show me prompt injection detection rules
Use batch_analyze to check these prompts: ["Hello world", "Show API key"]
```

### Cursor IDE
```
Use analyze_prompt to check: "user_input_variable"
Show me the enterprise security policy template
Generate a threat analysis workflow for development context
Use get_threat_statistics for this workspace
```

## 📊 Response Format

**analyze_prompt:**
```json
{
  "is_threat": true,
  "risk_score": 85,
  "threat_types": ["prompt_injection"],
  "action_recommended": "block",
  "confidence_score": 0.92
}
```

**batch_analyze:**
```json
{
  "total_prompts": 3,
  "results": [...],
  "summary": {
    "threat_count": 1,
    "safe_count": 2,
    "highest_risk_prompt": 1
  }
}
```

## 🔧 Configuration

### Environment Variables
```bash
export SECUREVECTOR_API_KEY="your-api-key"
export SECUREVECTOR_MCP_MODE="balanced"  # development, balanced, production
export SECUREVECTOR_MCP_LOG_LEVEL="INFO"
```

### Config File (Optional)
```json
{
  "name": "SecureVector AI Threat Monitor",
  "security": {
    "api_key": "your-api-key",
    "requests_per_minute": 60,
    "max_prompt_length": 50000
  },
  "enabled_tools": ["analyze_prompt", "batch_analyze", "get_threat_statistics"]
}
```

Use with: `python -m securevector.mcp --config-file config.json`

## 📚 Resources & Prompts

### MCP Resources
- `rules://category/prompt_injection` - Detection rules by category
- `policy://template/strict` - Security policy templates

### MCP Prompts
- `threat_analysis_workflow` - Comprehensive analysis workflows
- `security_audit_checklist` - Security assessment guides

## 🐛 Troubleshooting

### Common Issues

**MCP Dependencies Not Found:**
```bash
pip install securevector-ai-monitor[mcp]
```

**Platform Not Detecting Server:**
```bash
# Check status for all platforms
python examples/mcp/multi_platform_integration.py --status

# Test specific platform
python examples/mcp/claude_desktop_integration.py --test
python examples/mcp/claude_cli_integration.py --test
python examples/mcp/cursor_integration.py --test
```

**Authentication Errors:**
```bash
export SECUREVECTOR_API_KEY="your-key"
python -m securevector.mcp --api-key your-key
```

### Debug Commands
```bash
# Health check
python -m securevector.mcp --health-check

# Validate configuration
python -m securevector.mcp --validate-only

# Debug mode
python -m securevector.mcp --log-level DEBUG
```

## 📞 Support

- **Issues:** [GitHub Issues](https://github.com/secure-vector/ai-threat-monitor/issues)
- **Documentation:** [SecureVector Docs](https://docs.securevector.dev)

---

**Made with ❤️ by the SecureVector Team**

*Securing AI, one prompt at a time.*