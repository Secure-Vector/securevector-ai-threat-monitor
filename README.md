<div align="center">

<h1><img src="docs/favicon.png" alt="SecureVector" width="40" height="40"> SecureVector</h1>

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

<img src="docs/securevector-architecture.svg" alt="SecureVector Architecture" width="100%">

**SecureVector** sits between your AI agent and the LLM provider, scanning every request and response for security threats. Runs entirely on your machine — nothing leaves your infrastructure.

```bash
pip install securevector-ai-monitor[app]
securevector-app --web
```

Or download: [Windows](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.0/SecureVector-v2.1.0-Windows-Setup.exe) · [macOS](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.0/SecureVector-2.1.0-macOS.dmg) · [Linux](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.0/SecureVector-2.1.0-x86_64.AppImage) · [DEB](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.0/securevector_2.1.0_amd64.deb) · [RPM](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.0/securevector-2.1.0-1.x86_64.rpm)

> **Open-source. 100% local. No API keys. No cloud. No data sharing.**

<br>

## Highlights

- ☑ **100% Local** — No data transmitted externally. Complete privacy.
- ☑ **Agents Protected** — LangChain, LangGraph, CrewAI, n8n, OpenClaw, and any OpenAI-compatible app.
- ☑ **Input Scanning** — Block prompt injection, jailbreaks, and manipulation before they reach the LLM.
- ☑ **Output Scanning** — Detect credential leaks, PII exposure, and system prompt disclosure.
- ☑ **18+ Providers** — OpenAI, Anthropic, Gemini, Ollama, Groq, Azure, and more.
- ☑ **Full Visibility** — Real-time dashboard shows every threat, who sent it, and what was blocked.
- ☑ **Protect Your API Account** — Block abuse before it triggers ToS violations or key suspension.
- ☑ **One Command** — `securevector-app --web` and follow the UI to start protecting.

<br>

## What SecureVector Catches

1. **Your API account is the real target.** One successful jailbreak generating prohibited content gets your key suspended. All your users lose service.

2. **You have zero visibility.** Without SecureVector, you don't know who's abusing your app until OpenAI sends you a ToS violation notice.

3. **LLMs can't police their own output.** When your bot has access to user data, it doesn't know what's sensitive. SecureVector catches leaked credentials, PII, and system prompts in responses.

4. **Blocked requests are free requests.** Junk gets stopped locally in ~50ms — you never pay the API for processing it.

**Example:** You built an image generation app with 100 users on DALL-E 3 ($0.04/image). Ten users discover they can jailbreak your bot and start generating free images for fun — 20 junk requests/day each. That's 200 × $0.04 × 30 = **$240/month in abuse.** SecureVector blocks them all locally for $0.

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

**Binary installers:**

| Platform | Download |
|----------|----------|
| Windows | [SecureVector-v2.1.0-Windows-Setup.exe](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.0/SecureVector-v2.1.0-Windows-Setup.exe) |
| macOS | [SecureVector-2.1.0-macOS.dmg](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.0/SecureVector-2.1.0-macOS.dmg) |
| Linux (AppImage) | [SecureVector-2.1.0-x86_64.AppImage](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.0/SecureVector-2.1.0-x86_64.AppImage) |
| Linux (DEB) | [securevector_2.1.0_amd64.deb](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.0/securevector_2.1.0_amd64.deb) |
| Linux (RPM) | [securevector-2.1.0-1.x86_64.rpm](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.0/securevector-2.1.0-1.x86_64.rpm) |

[All Releases](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases) · [SHA256 Checksums](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.0/SHA256SUMS.txt)

> **Security:** Only download installers from this official GitHub repository. Always verify SHA256 checksums before installation. SecureVector is not responsible for binaries obtained from third-party sources.

<br>

## Quick Start

**Step 1:** Start SecureVector app

```bash
securevector-app --web
```

**Step 2:** Go to **Integrations** in the UI, choose your agent framework and LLM provider, then click **Start Proxy**.

**Step 3:** Point your app to the proxy (shown in the UI).

That's it! Every request is scanned for prompt injection. Every response is scanned for data leaks.

**Supported providers:** `openai` `anthropic` `gemini` `ollama` `groq` `openrouter` `deepseek` `mistral` `xai` `azure` `together` `fireworks` `perplexity` `cohere` `cerebras` `lmstudio` `litellm`

<br>

## Agent Integrations

| Agent/Framework | Integration |
|-----------------|-------------|
| **LangChain** | LLM Proxy or [SDK Callback](docs/USECASES.md#langchain) |
| **LangGraph** | LLM Proxy or [Security Node](docs/USECASES.md#langgraph) |
| **CrewAI** | LLM Proxy or [SDK Callback](docs/USECASES.md#crewai) |
| **Ollama / Open WebUI** | LLM Proxy — see Integrations in UI |
| **OpenClaw / ClaudBot** | LLM Proxy — see Integrations in UI |
| **n8n** | [Community Node](docs/USECASES.md#n8n) |
| **Claude Desktop** | [MCP Server Guide](docs/MCP_GUIDE.md) |
| **Any OpenAI-compatible app** | LLM Proxy — set `OPENAI_BASE_URL` to proxy |
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
<td><img src="docs/app-dashboard.png" alt="Dashboard" width="100%"><br><em>Dashboard — stats, risk distribution, recent threats</em></td>
<td><img src="docs/app-threats.png" alt="Threats" width="100%"><br><em>Threat Analytics — blocked, redacted, logged</em></td>
</tr>
<tr>
<td><img src="docs/app-integrations.png" alt="Integrations" width="100%"><br><em>Integrations — LangChain, Ollama, OpenClaw, and more</em></td>
<td><img src="docs/app-proxy.png" alt="Proxy" width="100%"><br><em>LLM Proxy — provider configuration</em></td>
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

| Open Source (100% Free) | Cloud (Optional) |
|-------------------------|------------------|
| Apache 2.0 license | Expert-curated rule library |
| Community detection rules | Multi-stage ML threat analysis |
| Custom YAML rules | Real-time cloud dashboard |
| 100% local, zero data sharing | Team collaboration |
| Desktop app + local API | Priority support |

> **Cloud is optional.** SecureVector runs entirely locally by default. Connect to [app.securevector.io](https://app.securevector.io) only if you want enterprise-grade threat intelligence with specialized algorithms designed to minimize false positives.

[**Try Free**](https://app.securevector.io)

<br>

## Update

| Method | Command |
|--------|---------|
| **PyPI** | `pip install --upgrade securevector-ai-monitor[app]` |
| **Source** | `git pull && pip install -e ".[app]"` |
| **Windows** | Download latest [.exe installer](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/latest) and run it (overwrites previous version) |
| **macOS** | Download latest [.dmg](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/latest), drag to Applications (replace existing) |
| **Linux AppImage** | Download latest [.AppImage](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/latest) and replace the old file |
| **Linux DEB** | `sudo dpkg -i securevector_<version>_amd64.deb` |
| **Linux RPM** | `sudo rpm -U securevector-<version>.x86_64.rpm` |

After updating, restart SecureVector.

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
