<div align="center">

<h1><img src="docs/favicon.png" alt="SecureVector" width="40" height="40"> SecureVector</h1>

<h3>Security, Observability and Governance for AI Agents</h3>

<p><em>Every model call and every tool call your agent makes, on one timeline, and whether each was allowed or blocked. On your machine.</em></p>

<p>Free and open source (Apache 2.0). Runs on your machine. No account and no telemetry: nothing leaves your computer unless you set it up (<a href="#im-evaluating-it-for-my-team">details</a>).</p>

<p><strong>Python</strong> <code>pip install "securevector-ai-monitor[app]"</code> &nbsp;·&nbsp; <strong>Node</strong> <code>npx @securevector/cli</code> <sub>(needs Python 3.10+)</sub></p>

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge)](https://opensource.org/licenses/Apache-2.0)
[![PyPI](https://img.shields.io/pypi/v/securevector-ai-monitor.svg?style=for-the-badge)](https://pypi.org/project/securevector-ai-monitor)
[![Python](https://img.shields.io/pypi/pyversions/securevector-ai-monitor.svg?style=for-the-badge)](https://pypi.org/project/securevector-ai-monitor)
[![npm SDK](https://img.shields.io/npm/v/@securevector/sdk.svg?style=for-the-badge&logo=npm&label=%40securevector%2Fsdk&color=CB3837)](https://www.npmjs.com/package/@securevector/sdk)
[![npm CLI](https://img.shields.io/npm/v/@securevector/cli.svg?style=for-the-badge&logo=npm&label=%40securevector%2Fcli&color=CB3837)](https://www.npmjs.com/package/@securevector/cli)
[![Downloads/month](https://img.shields.io/pypi/dm/securevector-ai-monitor?style=for-the-badge&label=downloads%2Fmonth&color=orange)](https://pypistats.org/packages/securevector-ai-monitor)
[![Downloads total](https://img.shields.io/pepy/dt/securevector-ai-monitor?style=for-the-badge&label=downloads%20total&color=orange)](https://pepy.tech/project/securevector-ai-monitor)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/k3bgZuCQBC)

</div>

<p align="center"><img src="docs/screenshots/agent-sessions-governance.gif" alt="Agent Sessions: a Claude Code and a Codex session side by side in SecureVector, with each tool call and its verdict in the governance column on the right" width="100%"></p>
<p align="center"><sub><b>Agent Sessions, new in 6.0.</b> Run Claude Code, Codex, Copilot CLI or OpenCode inside the app and watch every tool call get checked as it happens. <a href="docs/AGENT_SESSIONS.md">Guide</a></sub></p>

## Start here

Pick the one that describes you.

### I use Claude Code, Codex, Copilot CLI or OpenCode

No code changes. Install the app, then install the plugin for your agent.

```bash
pip install "securevector-ai-monitor[app]" && securevector-app
npx @securevector/cli                              # or from npm (needs Python 3.10+)
```

In the app, click **Connect Agents**, pick your agent, click **Install Plugin**, then restart the agent (in Claude Code, run `/reload-plugins`). From then on every tool call it makes is checked and logged. To run sessions inside the app, click **Agents**, then **+ Launch** (full terminal on macOS and Linux; output only on Windows for now), or from a terminal:

```bash
sv-monitor session launch claude-code ~/project    # comes with the app; npm: securevector monitor session ...
```

More in the [Agent Sessions guide](docs/AGENT_SESSIONS.md).

### I build agents in Python

**LangGraph, LangChain or CrewAI:** use the SDK for your framework (it brings the app with it). It checks every tool call before it runs.

```python
# pip install securevector-sdk-langgraph
from langchain.agents import create_agent
from securevector_sdk_langgraph import secure_middleware, cost_tracking_middleware

agent = create_agent(model, tools, middleware=[
    secure_middleware(mode="enforce"),   # checks every tool call before it runs
    cost_tracking_middleware(),          # records model tokens and cost
])
```

Same idea for [LangChain](https://github.com/Secure-Vector/securevector-sdk-langchain) and [CrewAI](https://github.com/Secure-Vector/securevector-sdk-crewai); `create_react_agent` and raw `StateGraph` patterns are in the [LangGraph SDK guide](docs/USECASES.md#langgraph). The framework SDKs record model cost themselves, so do not add `instrument()` below as well ([why](docs/GUARD.md#compared-with-the-framework-sdks)).

**Plain OpenAI or Anthropic code:** the app package includes a tracer and a tool guard. [Guide](docs/GUARD.md)

```python
from openai import OpenAI            # or: from anthropic import Anthropic
from securevector import guard, instrument

instrument()                         # records every OpenAI and Anthropic call: tokens, cost, verdict
client = OpenAI()

@guard(tool_id="orders.lookup")      # checks this tool's input and output
def lookup_order(order_id): ...

with guard.session("ticket-8812"):   # groups one run on the Observability page
    ...                              # your agent loop: model calls and tool calls
```

### I build agents in JavaScript or TypeScript

**Run the app from npm.** Needs Node 20+ and Python 3.10+ on your PATH; the launcher sets up the rest on first run. No Python? Use a [binary installer](#install) instead.

```bash
npx @securevector/cli
```

That is all Claude Code, Codex and the other coding agents need; install their plugin as in the first path.

**Optional: check the tools in agents you write yourself.**

```bash
npm install @securevector/sdk
```

```ts
import { guard } from '@securevector/sdk';

const lookupOrder = guard(async ({ orderId }) => fetchOrder(orderId), { toolId: 'orders.lookup' });
```

Wrap each tool's function with `guard()` (with the Vercel AI SDK, the tool's `execute`), whichever framework you use: LangChain.js, the Vercel AI SDK, Mastra or plain Node. API and examples in the [SDK repository](https://github.com/Secure-Vector/securevector-sdk-js#readme).

Whichever path you took, open [http://localhost:8741](http://localhost:8741): every model call and tool call is there, allowed or blocked, with its cost and trace.

### I'm evaluating it for my team

- **Where it runs and what leaves it:** on each developer's machine, bound to 127.0.0.1, no telemetry. Outbound traffic only for the one-time Guardian model download, SIEM destinations you configure, and [Cloud Connect](#cloud-optional-opt-in) if someone turns it on.
- **What the record shows:** every tool call in a SHA-256 hash-chained log with a per-rule evidence ledger for blocked actions. The local hash chain shows tampering on this machine; the [SIEM Forwarder](docs/siem/README.md) gives you an off-host copy, and [Device Identity](docs/DEVICE_IDENTITY.md) ties events to a machine.
- **Who controls enforcement:** locally, the developer, and every connector fails open, so an agent keeps working unchecked while the app is stopped. Central, read-only policies come from [Cloud Sync](docs/CONFIGURATION.md#mcp-policies-cloud-sync-optional).
- **Licence:** Apache 2.0. Read the code, run it air-gapped, or [self-host the engine](docs/INSTALLATION.md#deploy-to-your-own-cloud-self-host). Full notes, including retention and what the app can see: [Evaluating it for a team](docs/FEATURES.md#evaluating-it-for-a-team).

## What you get

- **Run it here.** Launch Claude Code, Codex, Copilot CLI or OpenCode from inside SecureVector and watch the terminal live, with every call and its verdict beside it. Sessions you started in your own terminal can be adopted onto the same board.
- **See it.** One trace per agent session. Pick an agent on the left, read its whole run as a waterfall on the right. Live follow, replay, and a costliest-turn mark on every run.
- **Stop it.** Allow, block or log-only per tool, enforced by default. A blocked call is refused straight away and becomes a request you can approve for fifteen minutes or an hour, after which the agent can retry. Blocking on detected threats in prompts and responses is opt-in.
- **Catch it.** 108 rules covering the OWASP LLM Top 10, MITRE ATT&CK-mapped patterns and agent-attack chains, plus an optional offline ML model, applied while the agent is still running.
- **Know where it went.** Every external host an agent reached, when it was first seen, and a policy that decides which ones it may reach.
- **Keep the record.** Every tool call in a SHA-256 hash-chained log; the local chain shows tampering on this machine. Blocked actions get a per-rule evidence ledger.
- **Pay less.** A local scan of your own transcripts shows why sessions cost what they did, with copyable fixes.
- **Keep it.** Apache 2.0. No signup. Nothing leaves your machine unless you connect it.

## Works with

| You use | How to connect |
|---|---|
| **Claude Code, Codex, GitHub Copilot CLI, OpenCode** | **Connect Agents** in the app, pick yours, **Install Plugin**. Launch sessions from **Agents** if you like ([guide](docs/AGENT_SESSIONS.md)) |
| **Cursor, Antigravity, OpenClaw** | **Connect Agents**, pick yours, **Install Plugin** ([OpenClaw guide](docs/OPENCLAW.md)) |
| **LangGraph, LangChain, CrewAI, Hermes** | The SDK for your framework: [langgraph](https://github.com/Secure-Vector/securevector-sdk-langgraph), [langchain](https://github.com/Secure-Vector/securevector-sdk-langchain), [crewai](https://github.com/Secure-Vector/securevector-sdk-crewai), [hermes](https://github.com/Secure-Vector/securevector-sdk-hermes) |
| **Any other Python agent** (OpenAI, Anthropic, Bedrock, Gemini, plain functions) | [`@guard` and `instrument()`](docs/GUARD.md), included in the app package |
| **Any JavaScript or TypeScript agent** (LangChain.js, Vercel AI SDK, Mastra, plain Node) | [`@securevector/sdk`](https://github.com/Secure-Vector/securevector-sdk-js#readme) |
| **Anything that calls an OpenAI-compatible API** (Ollama, Groq, n8n, Dify, any HTTP client) | The LLM proxy: **Connect Agents**, **Start Proxy**, then set `OPENAI_BASE_URL` (or `baseURL` in Node) to it. [Details](docs/CONFIGURATION.md#pointing-your-agent-at-the-proxy) |
| **Claude Desktop** | [MCP server](docs/MCP_GUIDE.md) |
| **OpenTelemetry** | Send OTLP/HTTP JSON to `http://127.0.0.1:8741/v1/traces`. [Tracing guide](docs/TRACING.md) |

If ports 8741 or 8742 are taken, pass `--port`. Prefer an installer? [Windows, macOS and Linux builds](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/latest) need no Python.

<div align="center">

[Website](https://securevector.io) · [Getting Started](docs/GETTING_STARTED.md) · [Verify your install](SECURITY.md#build-provenance--verifying-your-install) · [Discord](https://discord.gg/k3bgZuCQBC) · [Screenshots](#screenshots)

</div>

> **What's new in 6.0**
> - **Agent Sessions**: launch Claude Code, Codex, GitHub Copilot CLI or OpenCode from inside SecureVector and watch every tool call get checked beside the terminal. [Guide](docs/AGENT_SESSIONS.md)
> - **Bring your own sessions**: an agent you started in your own terminal appears in the app as soon as it makes a tool call. Add it to the board, continue it in the app, or leave it where it is.
> - **Unchecked, not just quiet**: an agent that is still running but no longer reporting tool calls is marked **unverified**, so it never looks the same as an idle one.
> - **Session commands in the CLI**: `sv-monitor session list | harnesses | unlinked | launch | link | stop` (`securevector monitor session ...` with npm), each with `--json`.
> - **Live governance beside every session**: tool calls with verdicts, blocks, hosts reached and an approval inbox in a column on the right. Approve a held call for 15 minutes, 1 hour or the rest of the session without leaving it.
> - **Session board and summary**: sessions grouped by folder with cost, calls and blocked counts; a summary when a session ends (duration, tool calls by verdict, hosts, findings), exportable as JSON.
> - **Observability** (was Traces): each run shows a step list with model time vs tool time, and **Agent Health** points out loops, failing steps, waste and blocked runs. CSV and PDF exports include the steps.
> - **Governance coverage**: see how many of your agents' tool calls SecureVector recorded and checked, and a list of gaps to close.
> - **Live Runs in the cloud** (Cloud Connect): every governed session on your devices, live, with its title and folder name and the same step timeline. Metadata only.
> - **Antigravity plugin**: install it from **Connect Agents** like the others.
> - **Install from npm**: `npx @securevector/cli` runs the same app for Node developers, and [`@securevector/sdk`](https://github.com/Secure-Vector/securevector-sdk-js#readme) checks tools in JavaScript and TypeScript agents.
>
> Full release history in the [CHANGELOG](CHANGELOG.md).

## Screenshots

<table>
<tr>
<td width="50%"><img src="docs/screenshots/agent-sessions-board.png" alt="Agent Sessions board" width="100%"><br><em>Agent Sessions board: sessions grouped by folder, with calls, blocked count and age on each card.</em></td>
<td width="50%"><img src="docs/screenshots/agent-runs.png" alt="Observability" width="100%"><br><em>Observability: a step list per run with model time versus tool time, each call's verdict, and Agent Health findings.</em></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/agent-map.png" alt="Agent Map" width="100%"><br><em>Agent Map: harnesses, sessions and tools, with blocked calls in red.</em></td>
<td width="50%"><img src="docs/screenshots/tool-call-history.png" alt="Tool Activity" width="100%"><br><em>Tool Activity: every tool call in a SHA-256 hash-chained log, each row integrity-verified.</em></td>
</tr>
</table>

[More screenshots](docs/SCREENSHOTS.md): Agent Map, Dashboard, Cost / Token Optimizer, Skill Scanner.

## Install

| Method | Command |
|---|---|
| **pip** (Python 3.10+) | `pip install "securevector-ai-monitor[app]"` then `securevector-app` |
| **npm** (Node 20+, Python 3.10+ on PATH) | `npx @securevector/cli`, or `npm install -g @securevector/cli` then `securevector` |
| **Installers** (no Python) | `.exe`, `.dmg`, `.AppImage`, `.deb` or `.rpm` from the [latest release](https://github.com/Secure-Vector/securevector-ai-threat-monitor/releases/latest), SHA256 checksums beside each file. [Verify your install](SECURITY.md#build-provenance--verifying-your-install) |
| **Self-host** | Run the engine in your own cloud with one Terraform module per provider: [AWS, Azure, Google Cloud, Oracle Cloud](docs/INSTALLATION.md#deploy-to-your-own-cloud-self-host) |

Only download installers from this repository. The npm launcher details, SDK-only and MCP extras, and updating are in the [Installation guide](docs/INSTALLATION.md).

## Documentation

- [Getting Started](docs/GETTING_STARTED.md): first run, how scanning works, threat modes, AI analysis
- [Installation](docs/INSTALLATION.md): pip, npm, binary installers, self-host, upgrading
- [Configuration](docs/CONFIGURATION.md): `svconfig.yml`, MCP Policies Cloud Sync, pointing an agent at the proxy
- [Agent Sessions](docs/AGENT_SESSIONS.md): launch and govern Claude Code, Codex, Copilot CLI and OpenCode in the app
- [Features in depth](docs/FEATURES.md): every feature, performance, notes for teams evaluating it
- [Threat detection](docs/DETECTION.md): what the 108 rules catch, and the Guardian ML layer
- [Screenshots](docs/SCREENSHOTS.md): every view of the app
- [Python `@guard`](docs/GUARD.md), [Claude Code plugin](docs/CLAUDE_CODE.md), [OpenClaw plugin](docs/OPENCLAW.md): connecting each kind of agent
- [Tool Permissions](docs/TOOL_PERMISSIONS.md): allow / block / log_only per tool
- [Tracing](docs/TRACING.md): OpenTelemetry and the Observability page
- [Device Identity](docs/DEVICE_IDENTITY.md): the per-machine `device_id` on every row
- [Skill Scanner](docs/SKILL_SCANNER.md): static analysis of skill packages before you install them
- [SIEM Forwarder](docs/siem/README.md): destinations, what leaves the machine, starter dashboards
- [Use Cases & Examples](docs/USECASES.md): LangChain, LangGraph, CrewAI, Hermes, n8n, FastAPI
- [MCP Server Guide](docs/MCP_GUIDE.md): Claude Desktop, Cursor integration
- [API Reference](docs/API_SPECIFICATION.md): REST API endpoints
- [Security Policy](SECURITY.md): vulnerability disclosure and verifying your install
- [Changelog](CHANGELOG.md)

## Contributing

```bash
git clone https://github.com/Secure-Vector/securevector-ai-threat-monitor.git
cd securevector-ai-threat-monitor
pip install -e ".[dev]"
pytest tests/ -v
```

[Contributing Guidelines](docs/legal/CONTRIBUTOR_AGREEMENT.md) · [Code of Conduct](.github/CODE_OF_CONDUCT.md)

### Feedback

A wrong detection is the most useful thing you can send. Every detection in the app has a **Report this rule** link that opens a [prefilled false-positive report](https://github.com/Secure-Vector/securevector-ai-threat-monitor/issues/new?template=false_positive.yml) with the rule id, version and platform, and nothing else. Anything else: [open an issue](https://github.com/Secure-Vector/securevector-ai-threat-monitor/issues/new/choose), say hello on [Discord](https://discord.gg/k3bgZuCQBC), or email [contact@securevector.io](mailto:contact@securevector.io). If SecureVector is earning its place on your machine, a star helps others find it.

## Cloud (optional, opt-in)

A separate cloud product handles MCP tool-permission policy sync across enrolled devices, per-org audit attribution, and per-device fleet slicing. It also adds **AI Agent Governance**, your agents' governance posture rolled into a single score across the fleet ([app.securevector.io/governance](https://app.securevector.io/governance)), plus **EU AI Act orientation** that maps your action-layer logging and tamper-evident tool-call audit to the relevant obligations ([governance/eu-ai-act](https://app.securevector.io/governance/eu-ai-act)); orientation only, not legal advice. Sign in for the fleet-wide view; the local install already gives you the single-device snapshot. Strictly additive: the local install above works standalone without it. Details: [securevector.io](https://securevector.io).

## License

Apache License 2.0, see [LICENSE](LICENSE).

The starter SIEM dashboard templates under [`docs/siem/`](docs/siem/) (Splunk XML, Sentinel workbook, Datadog + Grafana JSON) are MIT-licensed; see [`docs/siem/LICENSE`](docs/siem/LICENSE) and [`docs/siem/NOTICE`](docs/siem/NOTICE) for trademark disclaimers.

**SecureVector** is a trademark of SecureVector. See [NOTICE](NOTICE).

---

<div align="center">

**[Get Started](#install)** · **[Documentation](https://docs.securevector.io)** · **[Discord](https://discord.gg/k3bgZuCQBC)** · **[GitHub Issues](https://github.com/Secure-Vector/securevector-ai-threat-monitor/issues)** · **[security@securevector.io](mailto:security@securevector.io)**

</div>
