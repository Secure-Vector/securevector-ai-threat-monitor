# Installation Guide

## Quick Installation

```bash
# Basic installation
pip install securevector-ai-monitor

# With MCP server support
pip install securevector-ai-monitor[mcp]

# With all optional features
pip install securevector-ai-monitor[all]
```

## Installation Options

### Available Extras

| Extra | Description | Includes |
|-------|-------------|----------|
| `[mcp]` | MCP server support for Claude Desktop | `mcp`, `fastmcp` |
| `[all]` | All optional features | MCP support + utilities |

### Examples

```bash
# For SDK use only (Python integration)
pip install securevector-ai-monitor

# For Claude Desktop MCP server
pip install securevector-ai-monitor[mcp]

# Install everything
pip install securevector-ai-monitor[all]
```

## Verifying Installation

After installation, verify it works:

```python
from securevector import SecureVectorClient

# Create a client
client = SecureVectorClient()

# Analyze a prompt
result = client.analyze("Hello, how are you?")

print(f"Is threat: {result.is_threat}")
print(f"Risk score: {result.risk_score}")
```

### Verify MCP Installation

If you installed with `[mcp]` extra:

```python
from securevector import MCP_AVAILABLE, check_mcp_dependencies

print(f"MCP available: {MCP_AVAILABLE}")
print(f"Dependencies check: {check_mcp_dependencies()}")
```

Or test the MCP server directly:

```bash
python -m securevector.mcp --health-check
```

Expected output:
```
✅ Overall Status: HEALTHY
   • Analyzer: HEALTHY
   • Performance: OK
   • Rules: 15 files loaded with 518 patterns
```

## System Requirements

- **Python:** 3.9 or higher (tested on 3.9, 3.10, 3.11, 3.12)
- **OS:** Linux, macOS, Windows
- **Memory:** Minimum 512MB RAM (1GB+ recommended for MCP server)

## Dependencies

### Core Dependencies (always installed)
- `PyYAML>=5.1` - YAML parsing for threat detection rules
- `requests>=2.25.0` - HTTP client for API mode
- `aiohttp>=3.8.0` - Async HTTP client
- `typing-extensions>=4.0.0` - Type hints support

### Optional Dependencies

**MCP Support (`[mcp]`):**
- `mcp>=0.1.0` - Model Context Protocol library
- `fastmcp>=0.1.0` - FastMCP server framework

**All Features (`[all]`):**
- Includes all MCP dependencies

## Troubleshooting

### Issue: Import errors after installation

**Symptom:**
```python
ImportError: No module named 'securevector'
```

**Solutions:**
1. Ensure you're in the correct Python environment:
   ```bash
   which python
   pip list | grep securevector
   ```

2. Reinstall the package:
   ```bash
   pip install --force-reinstall securevector-ai-monitor
   ```

3. Check Python version:
   ```bash
   python --version  # Should be 3.9 or higher
   ```

### Issue: MCP dependencies not found

**Symptom:**
```python
ImportError: No module named 'mcp'
```

**Solution:**
Install with MCP extras:
```bash
pip install securevector-ai-monitor[mcp]
```

### Issue: MCP server won't start

**Symptom:**
```
ModuleNotFoundError: No module named 'fastmcp'
```

**Solution:**
```bash
# Uninstall and reinstall with MCP support
pip uninstall securevector-ai-monitor
pip install securevector-ai-monitor[mcp]

# Verify
python -m securevector.mcp --health-check
```

### Issue: Permission errors during installation

**Symptom:**
```
ERROR: Could not install packages due to an OSError: [Errno 13] Permission denied
```

**Solutions:**
```bash
# Option 1: Use --user flag
pip install --user securevector-ai-monitor[mcp]

# Option 2: Use virtual environment (recommended)
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install securevector-ai-monitor[mcp]
```

### Issue: Slow analysis response times

**Solutions:**
1. **Use local mode** for fastest performance (5-15ms):
   ```python
   from securevector import SecureVectorClient
   from securevector.models.config_models import OperationMode

   client = SecureVectorClient(mode=OperationMode.LOCAL)
   ```

2. **Enable caching** (enabled by default):
   ```python
   client = SecureVectorClient(enable_caching=True)
   ```

3. **Check rule loading**: Should see "Loaded X rule files with Y total patterns" in logs

## Virtual Environment Setup (Recommended)

Using a virtual environment isolates your dependencies:

```bash
# Create virtual environment
python -m venv securevector-env

# Activate it
source securevector-env/bin/activate  # On Linux/macOS
# OR
securevector-env\Scripts\activate  # On Windows

# Install
pip install securevector-ai-monitor[mcp]

# Verify
python -c "from securevector import SecureVectorClient; print('✅ Installation successful!')"
```

## Upgrading

To upgrade to the latest version:

```bash
# Upgrade basic package
pip install --upgrade securevector-ai-monitor

# Upgrade with MCP support
pip install --upgrade securevector-ai-monitor[mcp]
```

## Uninstallation

To remove the package:

```bash
pip uninstall securevector-ai-monitor
```

## Next Steps

After installation:

1. **Quick Start:** See [README.md](README.md) for usage examples
2. **SDK Guide:** See [SDK_USAGE.md](SDK_USAGE.md) for complete Python SDK integration
3. **MCP Setup:** See [MCP_GUIDE.md](MCP_GUIDE.md) for Claude Desktop MCP server configuration
4. **Use Cases:** See [USECASES.md](USECASES.md) for real-world integration examples

## Support

- **Installation Issues:** [GitHub Issues](https://github.com/secure-vector/ai-threat-monitor/issues)
- **Questions:** [GitHub Discussions](https://github.com/secure-vector/ai-threat-monitor/discussions)
- **Documentation:** [docs.securevector.dev](https://docs.securevector.dev)
