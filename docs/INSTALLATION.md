# Installation Guide

## Quick Installation

### Option 1: pip

**Requires:** Python 3.9+ (MCP requires 3.10+)

```bash
pip install securevector-ai-monitor[app]
securevector-app --web
```

### Option 2: npm

For Node toolchains. Same product, same version number as the PyPI release.

```bash
npm install -g @securevector/cli
securevector
```

or without installing anything globally:

```bash
npx @securevector/cli
```

**Requires:** Python 3.10+ on PATH. The npm package is a launcher, not a
reimplementation: it finds your Python, installs the matching release into a
virtual environment it manages, and hands over.

`npm install` itself makes no network request beyond fetching the package. There
is no install script. The first time you actually run `securevector` it says
what it is about to do, sets up once, and every run after that is immediate.
That is deliberate: a postinstall that downloads and executes code is the
supply-chain shape this product exists to warn you about, and it will not
install a Python runtime for you either. If Python is missing or too old,
`securevector doctor` tells you exactly what to do.

```
securevector [app]           Start the local app (default)
securevector monitor ...     The sv-monitor CLI, including session commands
securevector proxy ...       The LLM proxy
securevector mcp ...         The MCP server
securevector doctor          Check this machine, report what is missing
securevector where           Print the managed environment path
```

Anything after the verb is passed through untouched, so `securevector monitor
session list` is exactly `sv-monitor session list`.

### Option 3: Binary installers

No Python required. Download and run.

Download the installer for your platform from the [latest release](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/latest): `.exe` for Windows, `.dmg` for macOS, `.AppImage`, `.deb` or `.rpm` for Linux. Each release lists SHA256 checksums beside the files. To check the build provenance of what you downloaded, see [Verifying your install](../SECURITY.md#build-provenance--verifying-your-install).

> **macOS binary note:** **Only download from this official GitHub repository** and verify the [SHA256 checksum](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/latest) before installing. (Prefer pip? `pip install "securevector-ai-monitor[app]"` always works too.)

| Platform | Download |
|----------|----------|
| Windows | [SecureVector-v3.4.0-Windows-Setup.exe](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v3.4.0/SecureVector-v3.4.0-Windows-Setup.exe) |
| macOS | [SecureVector-3.4.0-macOS.dmg](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v3.4.0/SecureVector-3.4.0-macOS.dmg) |
| Linux (AppImage) | [SecureVector-3.4.0-x86_64.AppImage](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v3.4.0/SecureVector-3.4.0-x86_64.AppImage) |
| Linux (DEB) | [securevector_3.4.0_amd64.deb](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v3.4.0/securevector_3.4.0_amd64.deb) |
| Linux (RPM) | [securevector-3.4.0-1.x86_64.rpm](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v3.4.0/securevector-3.4.0-1.x86_64.rpm) |

[All Releases](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases) · [SHA256 Checksums](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v3.4.0/SHA256SUMS.txt)

> **Security:** Only download installers from this official GitHub repository. Always verify SHA256 checksums before installation. SecureVector is not responsible for binaries obtained from third-party sources.

---

## Other install options

| Install | Use Case | Size |
|---------|----------|------|
| `pip install "securevector-ai-monitor[app]"` | **Full app**: web UI, LLM proxy, cost tracking, tool permissions | ~60MB |
| `pip install securevector-ai-monitor` | **SDK only**: lightweight, for programmatic integration | ~18MB |
| `pip install "securevector-ai-monitor[mcp]"` | **MCP server**: Claude Desktop, Cursor | ~38MB |

---

## Deploy to your own cloud (self-host)

Want it as shared infrastructure instead of one laptop? Run the engine in **your own cloud tenant**: one `terraform apply` stands it up with a live HTTPS dashboard, so a whole team's agents point at a single instance. Open-source modules (Apache 2.0), one per provider:

| Cloud | Terraform module |
|---|---|
| **AWS** | [terraform-aws-securevector](https://github.com/Secure-Vector/terraform-aws-securevector) |
| **Azure** | [terraform-azurerm-securevector](https://github.com/Secure-Vector/terraform-azurerm-securevector) |
| **Google Cloud** | [terraform-google-securevector](https://github.com/Secure-Vector/terraform-google-securevector) |
| **Oracle Cloud** | [terraform-oci-securevector](https://github.com/Secure-Vector/terraform-oci-securevector) |

Your data stays in your tenant. `terraform output` gives you the endpoint URL; then point your agents at it with the lightweight SDK (LangChain / LangGraph / CrewAI / Hermes, `--no-deps` install; `@securevector/sdk` for Node) and/or the SecureVector Guard plugin. See each SDK / plugin's docs for the one env var to set.

---

## Verifying Installation

### Local app

After installing with `[app]`, launch the dashboard:

```bash
securevector-app --web
```

The app opens at `http://localhost:8741` with the dashboard, integrations, and threat analytics.

### SDK only

```python
from securevector import SecureVectorClient

client = SecureVectorClient()
result = client.analyze("Hello, how are you?")

print(f"Is threat: {result.is_threat}")
print(f"Risk score: {result.risk_score}")
```

### MCP server

```bash
python -m securevector.mcp --health-check
```

Expected output:
```
Overall Status: HEALTHY
   Analyzer: HEALTHY
   Performance: OK
   Rules: 15 files loaded with 518 patterns
```

---

## System Requirements

- **Python:**
  - SDK and Local app: 3.9 or higher
  - **MCP Server: 3.10 or higher** (required for `[mcp]` extra)
  - Tested on: 3.9, 3.10, 3.11, 3.12
- **OS:** Linux, macOS, Windows
- **Memory:** Minimum 512MB RAM (1GB+ recommended for MCP server)

---

## Dependencies

### Core Dependencies (always installed)
- `PyYAML>=5.1` - YAML parsing for threat detection rules
- `requests>=2.25.0` - HTTP client for API mode
- `aiohttp>=3.12.14` - Async HTTP client
- `typing-extensions>=4.0.0` - Type hints support

### App Dependencies (`[app]`)
- `pywebview>=5.0` - Cross-platform webview
- `FastAPI>=0.100.0` - Local API server
- `uvicorn>=0.20.0` - ASGI server
- `SQLAlchemy>=2.0.0` - Database ORM
- `aiosqlite>=0.19.0` - Async SQLite
- `httpx>=0.24.0` - Async HTTP client

### MCP Dependencies (`[mcp]`)
- `mcp>=0.1.0` - Model Context Protocol library
- `fastmcp>=0.1.0` - FastMCP server framework

---

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
   pip install --force-reinstall securevector-ai-monitor[app]
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
```bash
pip install securevector-ai-monitor[mcp]
```

### Issue: Permission errors during installation

**Symptom:**
```
ERROR: Could not install packages due to an OSError: [Errno 13] Permission denied
```

**Solutions:**
```bash
# Option 1: Use --user flag
pip install --user securevector-ai-monitor[app]

# Option 2: Use virtual environment (recommended)
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install securevector-ai-monitor[app]
```

---

## Virtual Environment Setup (Recommended)

```bash
# Create virtual environment
python -m venv securevector-env

# Activate it
source securevector-env/bin/activate  # On Linux/macOS
# OR
securevector-env\Scripts\activate  # On Windows

# Install
pip install securevector-ai-monitor[app]

# Launch
securevector-app --web
```

---

## Upgrading

| Method | Command |
|--------|---------|
| **PyPI** | `pip install --upgrade "securevector-ai-monitor[app]"` |
| **npm** | `npm install -g @securevector/cli@latest`. The next run sets up the new version; the old environment stays until you remove it with `securevector where` |
| **Source** | `git pull && pip install -e ".[app]"` |
| **Windows** | Download latest [.exe installer](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/latest) and run it (overwrites previous version) |
| **macOS** | Download latest [.dmg](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/latest), drag to Applications |
| **Linux AppImage** | Download latest [.AppImage](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/latest) and replace the old file |
| **Linux DEB** | `sudo dpkg -i securevector_<version>_amd64.deb` |
| **Linux RPM** | `sudo rpm -U securevector-<version>.x86_64.rpm` |

After updating, restart SecureVector. Then reinstall the Guard plugin for each harness you use (**Connect Agents**, or `securevector-app --install-plugin <harness>`) and run `/reload-plugins` in Claude Code, or start a new session. The updated hooks send the full tool input, up to 8 KB per field, so Observability on this device shows complete arguments instead of a 200-character cut. Secrets are still redacted, and nothing leaves the device.

---

## Uninstallation

```bash
pip uninstall securevector-ai-monitor
```

---

## Next Steps

1. **Getting Started:** See [GETTING_STARTED.md](GETTING_STARTED.md) for setup and configuration
2. **Use Cases:** See [USECASES.md](USECASES.md) for LangChain, CrewAI, n8n integration examples
3. **MCP Setup:** See [MCP_GUIDE.md](MCP_GUIDE.md) for Claude Desktop and Cursor configuration
4. **API Reference:** See [API_SPECIFICATION.md](API_SPECIFICATION.md) for REST API endpoints

## Support

- **Issues:** [GitHub Issues](https://github.com/Secure-Vector/securevector-ai-threat-monitor/issues)
- **Documentation:** [docs.securevector.io](https://docs.securevector.io)
