# Getting Started with SecureVector

Runtime AI firewall for agents. Scans inputs for prompt injection, outputs for data leaks. 100% local.

## Prerequisites

- **Python 3.9+** (MCP integration requires 3.10+)
- **pip** package manager

## Installation

```bash
# Full app — dashboard, LLM proxy, self-hosted (~60MB)
pip install securevector-ai-monitor[app]

# Lightweight SDK — API only (~18MB)
pip install securevector-ai-monitor

# MCP server — Claude Desktop, Cursor (~38MB)
pip install securevector-ai-monitor[mcp]
```

Binary installers: [Windows](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/latest) | [macOS](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/latest) | [Linux](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/latest)

---

## Getting Started

No code changes required. Start the proxy, set an environment variable, done.

### Step 1: Go to Integrations

Open the dashboard and click **Integrations** in the sidebar.

```bash
securevector-app --web
```

### Step 2: Select Your Integration

Choose your AI agent framework (LangChain, CrewAI, Ollama, OpenClaw) and select your LLM provider.

### Step 3: Start Proxy & Configure Your App

Click **Start Proxy** on the integration page. The proxy launches on port `8742`. Then follow the on-screen instructions to configure your client app.

Each integration page shows the environment variable to set. For example:

```bash
# OpenAI
export OPENAI_BASE_URL=http://localhost:8742/openai/v1

# Anthropic
export ANTHROPIC_BASE_URL=http://localhost:8742/anthropic

# Ollama
export OPENAI_BASE_URL=http://localhost:8742/ollama/v1
```

Your API key passes through — SecureVector never stores it. All LLM traffic is now scanned.

### Examples

**OpenClaw + Telegram**

You run OpenClaw as a Claude-powered gateway agent. Users chat with your bot on Telegram. SecureVector sits between OpenClaw and Claude, scanning every message for prompt injection before it reaches the LLM.

```bash
# Terminal 1: Start SecureVector with OpenClaw
securevector-app --proxy --provider anthropic --web --openclaw

# Terminal 2: Start OpenClaw gateway
ANTHROPIC_BASE_URL=http://localhost:8742/anthropic openclaw gateway
```

Flow: `Telegram → OpenClaw gateway → SecureVector (scans) → Claude`

**Ollama + Open WebUI**

You run Ollama locally and chat through Open WebUI. Point Open WebUI at the SecureVector proxy instead of Ollama directly — every chat message is scanned before reaching your model.

```bash
# Terminal 1: Start SecureVector proxy
securevector-app --proxy --provider ollama --web

# Open WebUI: Settings → Connections
# Set Ollama URL to: http://localhost:8742/ollama
```

Flow: `Open WebUI → SecureVector (scans) → Ollama`

---

## How Scanning Works

SecureVector scans traffic in both directions. Input scanning runs on every request by default. Output scanning is optional and can be toggled from the header.

### Input Scanning (User → LLM)

Scans the last user message **before** it reaches the LLM. Always active when the proxy is running.

Detects:
- Prompt injection (instruction override, role manipulation)
- Jailbreak attempts (DAN, hypothetical scenarios)
- Data exfiltration requests (credential seeking, system info gathering)
- Social engineering and manipulation tactics
- System override attempts

### Output Scanning (LLM → User)

Scans LLM responses **before** they reach the client. Toggle with the **Output** button in the header. Sensitive data is automatically redacted when stored.

Detects:
- Credential leakage (API keys, tokens, passwords, SSH keys)
- System prompt exposure (LLM revealing its own instructions)
- PII disclosure (SSN, credit card numbers)
- Jailbreak success indicators (signs the LLM was compromised)
- Encoded or obfuscated malicious content

---

## Threat Modes

Control what happens when a threat is detected. Toggle **Block Mode** from the header bar.

### Block Mode (Default)

Threats are actively **blocked**:
- **Input threats**: Stopped before reaching the LLM
- **Output threats**: Stopped before reaching the client
- All threats are still logged to the dashboard

### Log Mode

Threats are detected and recorded in the dashboard. Traffic is **not** interrupted. Use this to monitor your AI agent's traffic and understand threat patterns.

---

## AI Analysis (Optional)

SecureVector uses a two-stage detection pipeline.

### Stage 1: Pattern Matching (Default)

- Always active — no configuration needed
- Regex-based community rules + your custom rules
- Processing time: **< 5ms** per scan
- No external dependencies
- Covers 90-97% of known attack patterns

### Stage 2: AI Analysis (Optional)

- Uses a secondary LLM to evaluate flagged input
- Provides semantic understanding beyond regex patterns
- **Runs on input scans only** — output scanning always uses fast regex
- Adds **1-3 seconds** of latency per scan (depends on model and provider)
- Reduces false positives by combining regex confidence (40%) with LLM confidence (60%)

### When to Enable AI Analysis

| Scenario | Recommendation |
|----------|---------------|
| Maximum throughput, minimal latency | Use pattern matching alone |
| Need to reduce false positives | Enable AI Analysis |
| Running Ollama locally | Good option — keeps everything local |
| Can't tolerate added latency | Stay with pattern matching |
| High-security environment | Enable both AI Analysis and Block Mode |

### How to Enable

1. Click **AI Analysis** in the header bar
2. Select a provider (Ollama for fully local, or OpenAI/Anthropic)
3. Click **Test Connection**, then **Save**

---

## Cloud Mode (Optional)

SecureVector works 100% locally by default. Optionally connect to SecureVector Cloud for multi-stage ML-powered analysis designed to minimize false positives through proprietary threat intelligence.

**What Cloud Mode adds:**
- Advanced ML-powered threat detection beyond regex
- Centralized dashboard at [app.securevector.io](https://app.securevector.io)
- Replaces local AI Analysis when active
- Falls back to local analysis if cloud is unreachable

### Setup

1. **Create Account** — Sign up at [app.securevector.io](https://app.securevector.io) (free tier available)
2. **Get API Key** — Go to Access Management and create a new key
3. **Add Key** — Go to **Settings** in the sidebar and paste your key under Cloud
4. **Connect** — Click **Cloud Connect** in the header

When connected, scans are routed to `scan.securevector.io` and results appear in both the local dashboard and the cloud dashboard.

---

## Agent Framework Integrations

SecureVector has dedicated integration pages for popular AI agent frameworks. Go to **Integrations** in the sidebar:

| Framework | Description |
|-----------|-------------|
| **LangChain** | Python LLM framework — proxy integration |
| **LangGraph** | Stateful multi-agent workflows — proxy integration |
| **CrewAI** | Agent orchestration — proxy integration |
| **n8n** | Workflow automation — published [n8n community node](https://www.npmjs.com/package/n8n-nodes-securevector) |
| **Ollama** | Local LLMs — proxy with OpenAI-compatible API |
| **OpenClaw** | AI gateway agent — proxy integration |

Each integration page shows how to set up the proxy and configure your app.

---

## API Reference

SecureVector exposes a full REST API with interactive documentation:

- **OpenAPI Spec (Swagger)**: `http://localhost:8741/docs` — interactive API explorer with all endpoints, request/response schemas, and try-it-out functionality
- **Analyze endpoint**: `POST /analyze` — scan any text for threats
- **Threat Intel**: `GET /api/threat-intel` — list detected threats
- **Rules**: `GET /api/rules` — list all detection rules
- **Health**: `GET /health` — server status check

---

## Further Reading

- [API Specification](API_SPECIFICATION.md) — Full REST API reference with schemas
- [Use Cases & Examples](USECASES.md) — Real-world integration examples
- [MCP Server Guide](MCP_GUIDE.md) — Claude Desktop and Cursor setup
- [Installation Guide](INSTALLATION.md) — Binary installers, service setup
- [SDK Usage](SDK_USAGE.md) — Python SDK reference
- Interactive API docs: `http://localhost:8741/docs`
