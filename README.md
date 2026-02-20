<div align="center">

<h1><img src="docs/favicon.png" alt="SecureVector" width="40" height="40"> SecureVector</h1>

<h3>AI Firewall for Agents — Block prompt injection, tool abuse, and data leaks before and after the LLM.</h3>

<p>Also tracks every token and enforces budget limits so you never wake up to a surprise bill.</p>

<br>

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge)](https://opensource.org/licenses/Apache-2.0)
[![PyPI](https://img.shields.io/pypi/v/securevector-ai-monitor.svg?style=for-the-badge)](https://pypi.org/project/securevector-ai-monitor)
[![Python](https://img.shields.io/pypi/pyversions/securevector-ai-monitor.svg?style=for-the-badge)](https://pypi.org/project/securevector-ai-monitor)
[![Downloads](https://img.shields.io/pepy/dt/securevector-ai-monitor?style=for-the-badge)](https://pepy.tech/project/securevector-ai-monitor)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/k3bgZuCQBC)

[Website](https://securevector.io) · [Getting Started](docs/GETTING_STARTED.md) · [Discord](https://discord.gg/k3bgZuCQBC) · [Dashboard Screenshots](#screenshots)

</div>

<br>

## The Problem

AI agents are powerful — and completely unprotected.

Your agents send every prompt, every API key, every piece of user data straight to LLM providers with zero filtering. There is no budget limit. No injection protection. No visibility into what is actually happening.

- Developers have reported API bills of hundreds of dollars appearing in days from runaway agents
- Agent frameworks commonly ship with no budget enforcement, no PII filtering, and no permission model — a risk pattern flagged by MITRE and Gartner in their AI agent security research

You don't need an enterprise security team to fix this. You need SecureVector.

<br>

## The Fix

SecureVector runs on your machine, between your AI agents and LLM providers. It starts with an OpenClaw proxy by default and supports a multi-provider proxy mode for routing across OpenAI, Anthropic, Ollama, and more — all through a single endpoint. It intercepts defined tool calls, scans every prompt and response for injection and data leaks, and hard-stops agents that exceed their budget. 100% local by default. No accounts required.

```bash
pip install securevector-ai-monitor[app]
securevector-app --web
```

Or download: [Windows](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.3/SecureVector-v2.1.3-Windows-Setup.exe) · [macOS](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.3/SecureVector-2.1.3-macOS.dmg) · [Linux](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.3/SecureVector-2.1.3-x86_64.AppImage) · [DEB](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.3/securevector_2.1.3_amd64.deb) · [RPM](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.3/securevector-2.1.3-1.x86_64.rpm)

One command to install. One command to start. Point your app to `localhost:8742/{provider}/v1` instead of the provider's API — everything else stays the same. Zero code changes.

> **Open-source. 100% local by default. No API keys required.**

<br>

## See What Your Agents Are Actually Doing

Most developers have never seen the raw traffic between their agents and LLM providers.

SecureVector gives you a live dashboard showing every request, every token, every dollar — in real time. You might be surprised what you find.

<br>

## How It Works

<img src="docs/securevector-architecture.svg" alt="SecureVector Architecture" width="100%">

**SecureVector** sits between your AI agent and the LLM provider, scanning every request and response for security threats, controlling tool permissions, and tracking spend in real time. Runs entirely on your machine — nothing leaves your infrastructure.

<br>

## Features

### Security

Prompt injection blocking, jailbreak detection, PII and credential redaction, data leak prevention — all running locally on your machine. Every request is scanned before it reaches the LLM provider. Every response is validated before it reaches your agent.

### Cost Control

Real-time token tracking across all providers. Set daily and monthly budget limits. Get alerts at custom thresholds. Hard-stop agents that exceed their budget. See per-agent, per-model cost breakdowns. Never wake up to a surprise bill again.

### Visibility

Live dashboard at `localhost:8741` showing every request flowing through your agents. See what prompts are being sent, what responses come back, how many tokens each call uses, and what it costs. The X-ray for your AI stack.

### 100% Local

No cloud. No telemetry. No accounts. No data leaves your machine. Ever. SecureVector runs entirely on localhost. Your prompts, your data, your costs — all stay on your hardware.

### Fast

Less than 50ms overhead per request. You won't notice it's there — until it blocks something.

<br>

## Quick Start

**Install**

```bash
pip install securevector-ai-monitor[app]
```

**Start**

```bash
securevector-app --web
```

Open [http://localhost:8741](http://localhost:8741) in your browser, or double-click the installed binary.

**Configure**

SecureVector writes `svconfig.yml` to your app data directory on first run. Edit it to set your security and budget policy:

```yaml
# SecureVector Configuration
# Changes take effect on next restart.
# Linux:   ~/.local/share/securevector/threat-monitor/svconfig.yml
# macOS:   ~/Library/Application Support/SecureVector/ThreatMonitor/svconfig.yml
# Windows: %LOCALAPPDATA%/SecureVector/ThreatMonitor/svconfig.yml

security:
  # Block detected threats (true) or log/warn only (false)
  block_mode: true
  # Scan LLM responses for data leakage and PII
  output_scan: true

budget:
  # Daily spend limit in USD (set to null to disable)
  daily_limit: 5.00
  # Warn in logs/headers when spend approaches the limit
  warn: true
  # Block requests when the daily budget is exceeded
  block: true

tools:
  # Enforce tool permission rules (allow/block based on your rules)
  enforcement: true

proxy:
  # Step 1: Start SecureVector  →  SecureVector proxy starts automatically on port 8742
  # Step 2: Point your agent at the proxy instead of the LLM provider
  #
  #   Linux / macOS:  export OPENAI_BASE_URL=http://localhost:8742/openai/v1
  #                   export ANTHROPIC_BASE_URL=http://localhost:8742/anthropic
  #   Windows PS:     $env:OPENAI_BASE_URL="http://localhost:8742/openai/v1"
  #   Windows CMD:    set OPENAI_BASE_URL=http://localhost:8742/openai/v1
  #   Ollama/WebUI:   set API base URL to http://localhost:8742/ollama/v1
  #   OpenClaw:       ANTHROPIC_BASE_URL=http://localhost:8742/anthropic openclaw gateway
  integration: openclaw       # or: langchain, langgraph, crewai, ollama
  mode: multi-provider        # or: single (add provider: below)
  provider: null              # required only when mode is "single"
```

The UI keeps this file in sync — changes in the dashboard are written back to `svconfig.yml` automatically.

**Use**

Point any application to SecureVector's proxy instead of the provider's API.

```bash
# OpenAI
export OPENAI_BASE_URL=http://localhost:8742/openai/v1

# Anthropic
export ANTHROPIC_BASE_URL=http://localhost:8742/anthropic

# Ollama
export OPENAI_BASE_URL=http://localhost:8742/ollama/v1

# OpenClaw
ANTHROPIC_BASE_URL=http://localhost:8742/anthropic openclaw gateway
```

Every request is scanned for prompt injection. Every response is scanned for data leaks. Every dollar is tracked.

**Supported providers (13):** `openai` `anthropic` `gemini` `ollama` `groq` `deepseek` `mistral` `xai` `together` `cohere` `cerebras` `moonshot` `minimax`

<br>

## Works With Everything

**Your AI Stack**

LangChain · LlamaIndex · CrewAI · AutoGen · LangGraph · n8n · Dify · OpenClaw/ClawdBot — or any framework that makes HTTP calls to an LLM provider.

**LLM Providers**

OpenAI · Anthropic · Ollama · Groq · and any OpenAI-compatible API.

**Run Anywhere**

| Environment | Details |
|-------------|---------|
| Local | macOS, Linux, Windows |
| Cloud | AWS, GCP, Azure |
| Containers | Docker & Kubernetes |
| Virtual Machines | EC2, Droplets, VMs |
| Edge / Serverless | Lambda, Workers, Vercel |

<br>

## Agent Integrations

| Agent/Framework | Integration |
|-----------------|-------------|
| **LangChain** | LLM Proxy or [SDK Callback](docs/USECASES.md#langchain) |
| **LangGraph** | LLM Proxy or [Security Node](docs/USECASES.md#langgraph) |
| **CrewAI** | LLM Proxy or [SDK Callback](docs/USECASES.md#crewai) |
| **Any OpenAI-compatible** | LLM Proxy — see Integrations in UI |
| **OpenClaw / ClawdBot** | LLM Proxy — see Integrations in UI |
| **n8n** | [Community Node](docs/USECASES.md#n8n) |
| **Claude Desktop** | [MCP Server Guide](docs/MCP_GUIDE.md) |
| **Any OpenAI-compatible app** | LLM Proxy — set `OPENAI_BASE_URL` to proxy |
| **Any HTTP Client** | `POST http://localhost:8741/analyze` with `{"text": "..."}` |

<br>

## What It Detects

| Input Threats (User to LLM) | Output Threats (LLM to User) |
|-----------------------------|------------------------------|
| Prompt injection | Credential leakage (API keys, tokens) |
| Jailbreak attempts | System prompt exposure |
| Data exfiltration requests | PII disclosure (SSN, credit cards) |
| Social engineering | Jailbreak success indicators |
| SQL injection patterns | Encoded malicious content |
| Tool result injection (MCP) | — |
| Multi-agent authority spoofing | — |
| Permission scope escalation | — |

Full coverage: [OWASP LLM Top 10](https://owasp.org/www-project-top-10-for-large-language-model-applications/)

### AI Agent Attack Protection (28 rules)

Built from real attack chains observed against production agent frameworks:

- **Tool Result Injection** — injected instructions hidden inside MCP tool responses
- **Multi-Agent Authority Spoofing** — impersonating trusted agents in multi-agent pipelines
- **Permission Scope Escalation** — agents requesting more permissions than granted
- **MCP Tool Call Injection** — malicious payloads delivered through MCP tool calls
- **Evasion techniques** (22 rules) — zero-width characters, encoding tricks, roleplay framing, leetspeak, semantic inversion, emotional manipulation, and more

<br>

## Tool Permissions

Every tool call your AI agent makes is logged and can be controlled. For MCP servers (Claude Desktop, GitHub MCP, etc.) and custom tool integrations, you can:

- **Audit** all tool calls with their arguments and outcomes
- **Allow / Warn / Block** specific tools by name or category
- View pre-loaded permissions for 100+ official MCP tools (GitHub, filesystem, web search, etc.)
- Add custom tools and set permission policies

<br>

## Cost Intelligence

Track exactly what your agents are spending, per agent, per model, per day:

- **Live spend dashboard** — token counts and USD cost per agent, updated in real time
- **Request history** — every LLM call with input/output tokens and cost
- **Daily budget limits** — set a per-agent cap; requests are blocked once the limit is hit
- **Pricing reference** — 49 models across 9 providers (OpenAI, Anthropic, Gemini, Grok, Groq, Mistral, Cohere, Ollama, and more)

> Pricing data is sourced from official provider pages. Rates are subject to change — always verify with your provider.

<br>

## Why SecureVector?

| Without SecureVector | With SecureVector |
|---------------------|-------------------|
| Prompt injections pass straight through | Blocked before they reach the LLM |
| API keys and PII leak in prompts | Automatically redacted |
| No idea what agents are spending | Real-time cost tracking per agent |
| One runaway agent = surprise $500 bill | Hard budget limits with auto-stop |
| Zero visibility into agent traffic | Live dashboard showing everything |

<br>

## Screenshots

<table>
<tr>
<td width="50%"><img src="docs/screenshots/dashboard.png" alt="Dashboard" width="100%"><br><em>Dashboard — threat counts, cost metrics, and tool permission status</em></td>
<td width="50%"><img src="docs/screenshots/tool-permissions-light.png" alt="Agent Tool Permissions" width="100%"><br><em>Agent Tool Permissions — allow or block tools by name or category</em></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/costs-light.png" alt="LLM Cost Tracker" width="100%"><br><em>LLM Cost Tracker — per-agent spend, budgets, and token breakdown</em></td>
<td width="50%"><img src="docs/screenshots/tool-call-history.png" alt="Tool Call History" width="100%"><br><em>Tool Call History — full audit log with decision, risk, and args</em></td>
</tr>
</table>

<br>

## Open Source

SecureVector is fully open source. No cloud required. No accounts. No tracking. Run it, fork it, contribute to it.

**Built for** solo developers and small teams who ship AI agents without a security team or a FinOps budget. If you are building with LangChain, CrewAI, OpenClaw, or any agent framework — and you do not have someone watching your agent traffic and API spend — SecureVector is for you.

<br>

## Documentation

- [Installation Guide](docs/INSTALLATION.md) — Binary installers, pip, service setup
- [Use Cases & Examples](docs/USECASES.md) — LangChain, LangGraph, CrewAI, n8n, FastAPI
- [MCP Server Guide](docs/MCP_GUIDE.md) — Claude Desktop, Cursor integration
- [API Reference](docs/API_SPECIFICATION.md) — REST API endpoints
- [Security Policy](.github/SECURITY.md) — Vulnerability disclosure

<br>

## Install

### Option 1: pip

**Requires:** Python 3.9+ (MCP requires 3.10+)

```bash
pip install securevector-ai-monitor[app]
securevector-app --web
```

### Option 2: Binary installers

No Python required. Download and run.

| Platform | Download |
|----------|----------|
| Windows | [SecureVector-v2.1.3-Windows-Setup.exe](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.3/SecureVector-v2.1.3-Windows-Setup.exe) |
| macOS | [SecureVector-2.1.3-macOS.dmg](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.3/SecureVector-2.1.3-macOS.dmg) |
| Linux (AppImage) | [SecureVector-2.1.3-x86_64.AppImage](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.3/SecureVector-2.1.3-x86_64.AppImage) |
| Linux (DEB) | [securevector_2.1.3_amd64.deb](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.3/securevector_2.1.3_amd64.deb) |
| Linux (RPM) | [securevector-2.1.3-1.x86_64.rpm](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.3/securevector-2.1.3-1.x86_64.rpm) |

[All Releases](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases) · [SHA256 Checksums](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/download/v2.1.3/SHA256SUMS.txt)

> **Security:** Only download installers from this official GitHub repository. Always verify SHA256 checksums before installation. SecureVector is not responsible for binaries obtained from third-party sources.

### Other install options

| Install | Use Case | Size |
|---------|----------|------|
| `pip install securevector-ai-monitor` | **SDK only** — lightweight, for programmatic integration | ~18MB |
| `pip install securevector-ai-monitor[mcp]` | **MCP server** — Claude Desktop, Cursor | ~38MB |

<br>

## Open Source vs Cloud

| Open Source (100% Free) | Cloud (Optional) |
|-------------------------|------------------|
| Apache 2.0 license | Expert-curated rule library |
| Community detection rules | Multi-stage ML threat analysis |
| Custom YAML rules | Real-time cloud dashboard |
| 100% local by default, no data sharing | Team collaboration |
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

**[Get Started](#install)** · **[Documentation](https://docs.securevector.io)** · **[Discord](https://discord.gg/k3bgZuCQBC)** · **[GitHub Issues](https://github.com/Secure-Vector/securevector-ai-threat-monitor/issues)** · **[security@securevector.io](mailto:security@securevector.io)**

</div>
