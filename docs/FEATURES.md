# Features in depth

What each part of the local app does, in one table. For the short version, see the [README](../README.md#what-you-get).

<table>
<tr>
<th align="left" width="50%">Tool Audit & Permissions</th>
<th align="left" width="50%">Threat Detection</th>
</tr>
<tr>
<td valign="top">

Every tool call is recorded to a SHA-256-linked, tamper-evident audit log (re-verify in one click). Tool inputs are stored *after* secret redaction, up to 8 KB per field, and never leave the device (older plugin hooks cut at 200 characters, so reinstall the plugin and reload after updating). Allow / deny / ask rules per tool, enforced at the agent runtime via PreToolUse hooks or the multi-provider proxy.

</td>
<td valign="top">

Scans every prompt, response, and natural-language tool input for prompt injection (direct + indirect), jailbreaks, PII leaks, credential exfiltration, and tool-result injection. 108 rules covering the OWASP LLM Top 10, MITRE ATT&CK-mapped patterns and agent-attack chains. Monitor by default; opt-in block mode for hard-stop. Details in [DETECTION.md](DETECTION.md).

</td>
</tr>
<tr>
<th align="left">Skill Scanner</th>
<th align="left">Cost & Token Tracking</th>
</tr>
<tr>
<td valign="top">

Scan agent skills and tool packages before installing. Static analysis across 10 categories detects shell access, network calls, env var reads, code exec, base64 payloads, symlink escapes, and more. Optional AI review filters false positives automatically. Details in [SKILL_SCANNER.md](SKILL_SCANNER.md).

</td>
<td valign="top">

Per-agent, per-model token and USD spend in real time, with daily budget auto-stop. Plugins read session transcripts locally for a 7-day input/output/cache trend per runtime: no cloud round-trip, no token data leaves your machine.

</td>
</tr>
<tr>
<th align="left">Cost / Token Optimizer</th>
<th align="left">Guardian Assistant</th>
</tr>
<tr>
<td valign="top">

Opt-in local scan that explains the spend: cache waste vs compaction waste, eight detectors with ranked findings that deep-link to the exact turns in Observability, and impact receipts that only resolve when the metric actually moved: measured, never just modeled. Optional per-run limits (tool-call caps, loop breaker, cost/token ceilings) enforce on the existing deny rails; everything ships off.

</td>
<td valign="top">

An ambient character that docks in the corner and speaks only when it helps: context-fill warnings naming the exact agent, copyable fixes whose follow-through is measured from your local transcripts, and a two-sentence orientation of whatever you just opened, answered on the page you are already on. Advisory only: it never types into a session and never edits your files.

</td>
</tr>
<tr>
<th align="left">SIEM Forwarder</th>
<th align="left">Full Visibility</th>
</tr>
<tr>
<td valign="top">

Forward every threat + tool-call audit to your SOC in OCSF 1.3.0. Supports Splunk HEC, Datadog, Microsoft Sentinel, Google Chronicle, IBM QRadar, OpenTelemetry/OTLP, generic webhook, or a local NDJSON file. Metadata-only by default; raw data is opt-in per destination. Details in [siem/README.md](siem/README.md).

</td>
<td valign="top">

Live dashboard showing every LLM request, tool call, token count, and threat event. The per-agent Observability timeline merges threat scans + tool audits + cost into one feed.

</td>
</tr>
<tr>
<th align="left" colspan="2">100% Local by Default</th>
</tr>
<tr>
<td valign="top" colspan="2">

Runs entirely on your machine. No accounts required. No data leaves your infrastructure unless you configure a SIEM destination. Open source under Apache 2.0.

</td>
</tr>
</table>

## Performance

Rule-based analysis (default) adds about 10 to 50 ms to each scanned prompt or response. Native plugins add no network hop, and the optional Guardian model scores in well under a millisecond. Optional AI analysis adds 1 to 3 s depending on the model and provider, shown on the dashboard so you can measure it against your actual traffic. Tool-permission decisions (`allow` / `block` / `log_only`): see the [Tool Permissions guide](TOOL_PERMISSIONS.md).

## Evaluating it for a team

- **Where it runs:** on each developer's machine. The dashboard binds to 127.0.0.1 and has no login, so anyone with an account on that machine can use it. Rules, audit log and history live in one local database; retention is set in Settings (30 days by default), and deleting the app's data folder wipes it.
- **What leaves the machine:** no telemetry. Outbound traffic happens only for the one-time Guardian model download from GitHub (pre-place it for air-gapped installs), SIEM destinations you configure, and [Cloud Connect](../README.md#cloud-optional-opt-in) if someone turns it on.
- **What it sees:** tool calls and model calls from the agents you connect, and the agents' own session transcripts on that machine. Secrets are redacted before anything is written.
- **What the record shows:** every tool call goes into a SHA-256 hash-chained log, with a per-rule evidence ledger for blocked actions. The local hash chain shows tampering on this machine; forward it to your SIEM ([SIEM Forwarder](siem/README.md)) for an off-host copy, and tie events to a machine with [Device Identity](DEVICE_IDENTITY.md).
- **What you can control:** allow, block or require approval per tool, and decide which outside hosts agents may reach.
- **Who controls enforcement:** locally, the developer. They can stop the app or relax a rule, and while the app is not running agents keep working unchecked: every connector fails open by design, so SecureVector never breaks an agent. To set rules centrally, use Cloud Sync, whose policies are read-only on the device ([MCP Policies](CONFIGURATION.md#mcp-policies-cloud-sync-optional)), and watch your SIEM for machines that go quiet.
- **Licence:** Apache 2.0. Read the code, run it air-gapped, or [self-host the engine](INSTALLATION.md#deploy-to-your-own-cloud-self-host) in your own cloud.

## Open source

SecureVector is fully open source. No cloud required. No accounts. No tracking. Run it, fork it, contribute to it.

**Built for** solo developers and small teams who ship AI agents without a security team or a FinOps budget. If you are building with LangChain, CrewAI, OpenClaw, or any agent framework, or you run coding agents like Claude Code and Codex, and you do not have someone watching your agent traffic and API spend, SecureVector is for you.
