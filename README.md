<div align="center">

<h1>SecureVector AI Threat Monitor</h1>

<h3>Runtime Firewall for AI Agents & Bots</h3>

<p><strong>Block prompt injection, jailbreaks, and data leaks before they reach your AI.</strong></p>

<br>

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge)](https://opensource.org/licenses/Apache-2.0)
[![PyPI](https://img.shields.io/pypi/v/securevector-ai-monitor.svg?style=for-the-badge)](https://pypi.org/project/securevector-ai-monitor)
[![Python](https://img.shields.io/pypi/pyversions/securevector-ai-monitor.svg?style=for-the-badge)](https://pypi.org/project/securevector-ai-monitor)
[![Downloads](https://img.shields.io/pepy/dt/securevector-ai-monitor?style=for-the-badge)](https://pepy.tech/project/securevector-ai-monitor)

[Website](https://securevector.io) · [Docs](https://docs.securevector.io) · [Demo](https://securevector.io/demo) · [Getting Started](#install) · [Use Cases](docs/USECASES.md) · [API](docs/API_SPECIFICATION.md) · [Discord](https://discord.gg/securevector)

</div>

<br>

## How It Works

```
                    ┌─────────────────────────────────────┐
                    │     SecureVector AI Firewall        │
                    │                                     │
   User Input ────▶ │  ☑ Prompt injection detection       │ ────▶ LLM Provider
                    │  ☑ Jailbreak attempt blocking       │       (OpenAI, Anthropic,
                    │  ☑ Data exfiltration prevention     │        Ollama, etc.)
  LLM Response ◀─── │  ☑ PII/credential leak detection    │ ◀────
                    │  ☑ System prompt exposure check     │
                    │                                     │
                    └─────────────────────────────────────┘
                              100% Local · OWASP LLM Top 10
```

**SecureVector** sits between your AI agent and the LLM provider, scanning every request and response for security threats. Runs entirely on your machine — nothing leaves your infrastructure.

<br>

## Highlights

- ☑ **100% Local** — No data transmitted externally. Complete privacy.
- ☑ **Input Scanning** — Block prompt injection, jailbreaks, and manipulation before they reach the LLM.
- ☑ **Output Scanning** — Detect credential leaks, PII exposure, and system prompt disclosure.
- ☑ **18+ Providers** — OpenAI, Anthropic, Gemini, Ollama, Groq, Azure, and more.
- ☑ **Visual Dashboard** — Real-time threat monitoring with desktop app.
- ☑ **One Command** — `securevector-app --proxy --provider openai` and you're protected.

<br>

## Install

**Runtime:** Python 3.9+ (MCP requires 3.10+)

| Install | Use Case | Size |
|---------|----------|------|
| `pip install securevector-ai-monitor[app]` | **Local app** — dashboard, LLM proxy, self-hosted | ~60MB |
| `pip install securevector-ai-monitor` | **Cloud SDK** — lightweight, uses [cloud API](https://scan.securevector.io) | ~6MB |
| `pip install securevector-ai-monitor[mcp]` | **MCP server** — Claude Desktop, Cursor | ~20MB |

```bash
# Local users (self-hosted, OpenClaw proxy)
pip install securevector-ai-monitor[app]
securevector-app

# Cloud users (API integration)
pip install securevector-ai-monitor
```

Binary installers: [Windows](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/latest/download/SecureVector-Windows-Setup.exe) · [macOS](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/latest/download/SecureVector-macOS.dmg) · [Linux](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/latest/download/SecureVector.AppImage) · [All Releases](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases)

<br>

## Quick Start — LLM Proxy (OpenClaw / ClawdBot)

Protect your AI agent with 3 commands:

```bash
# 1. Start SecureVector
securevector-app --web

# 2. Start the LLM proxy (auto-patches OpenClaw on first run)
securevector-app --proxy --provider openai

# 3. Start OpenClaw through the proxy
OPENAI_BASE_URL=http://localhost:8742/v1 openclaw gateway
```

Every request is scanned for prompt injection. Every response is scanned for data leaks. Threats are blocked or logged based on your settings.

**Supported providers:** `openai` `anthropic` `gemini` `ollama` `groq` `openrouter` `deepseek` `mistral` `xai` `azure` `together` `fireworks` `perplexity` `cohere` `cerebras` `lmstudio` `litellm`

**Revert:** `securevector-app --revert-proxy` — restores original files, keeps your API keys.

<br>

## Agent Integrations

| Agent/Framework | Integration |
|-----------------|-------------|
| **OpenClaw / ClawdBot** | LLM Proxy — `securevector-app --proxy --provider <provider>` |
| **Claude Desktop** | [MCP Server Guide](docs/MCP_GUIDE.md) |
| **LangChain** | [Callback Integration](docs/USECASES.md#langchain) |
| **LangGraph** | [Security Node](docs/USECASES.md#langgraph) |
| **CrewAI** | [Webhook Integration](docs/USECASES.md#crewai) |
| **n8n** | [Community Node](docs/USECASES.md#n8n) |
| **Any HTTP Client** | `POST http://localhost:8741/analyze` with `{"text": "..."}` |

<br>

## What It Detects

| Input Threats (User → LLM) | Output Threats (LLM → User) |
|---------------------------|----------------------------|
| Prompt injection | Credential leakage (API keys, tokens) |
| Jailbreak attempts | System prompt exposure |
| Data exfiltration requests | PII disclosure (SSN, credit cards) |
| Social engineering | Jailbreak success indicators |
| SQL injection patterns | Encoded malicious content |

Full coverage: [OWASP LLM Top 10](https://owasp.org/www-project-top-10-for-large-language-model-applications/)

<br>

## Screenshots

<table>
<tr>
<td><img src="docs/app-dashboard.png" alt="Dashboard" width="100%"><br><em>Real-time Dashboard</em></td>
<td><img src="docs/app-proxy.png" alt="Proxy" width="100%"><br><em>LLM Proxy Control</em></td>
<td><img src="docs/app-threats.png" alt="Threats" width="100%"><br><em>Threat Analytics</em></td>
</tr>
</table>

<br>

## Documentation

- [Installation Guide](docs/INSTALLATION.md) — Binary installers, pip, service setup
- [Use Cases & Examples](docs/USECASES.md) — LangChain, LangGraph, CrewAI, n8n, FastAPI
- [MCP Server Guide](docs/MCP_GUIDE.md) — Claude Desktop, Cursor integration
- [API Reference](docs/API_SPECIFICATION.md) — REST API endpoints
- [Security Policy](.github/SECURITY.md) — Vulnerability disclosure

<br>

## Editions

| Open Source | Professional/Enterprise |
|-------------|------------------------|
| Apache 2.0 license | Expert-curated rule library |
| Community detection rules | Multi-stage ML threat analysis |
| Custom YAML rules | Real-time cloud dashboard |
| 100% local, zero data sharing | Team collaboration |
| Desktop app + local API | Priority support & SLAs |

[**Try Free**](https://app.securevector.io) · [**Pricing**](https://securevector.io/pricing) · [**Enterprise**](https://securevector.io/enterprise)

<br>

## Contributing

```bash
git clone https://github.com/Secure-Vector/securevector-ai-threat-monitor.git
cd securevector-ai-threat-monitor
pip install -e ".[dev]"
pytest tests/ -v
```

[Contributing Guidelines](docs/legal/CONTRIBUTOR_AGREEMENT.md) · [Code of Conduct](.github/CODE_OF_CONDUCT.md)

<br>

## License

Apache License 2.0 — see [LICENSE](LICENSE).

**SecureVector** is a trademark of SecureVector. See [NOTICE](NOTICE).

---

<div align="center">

**[Get Started](#install)** · **[Documentation](https://docs.securevector.io)** · **[GitHub Issues](https://github.com/Secure-Vector/securevector-ai-threat-monitor/issues)** · **[security@securevector.io](mailto:security@securevector.io)**

</div>
