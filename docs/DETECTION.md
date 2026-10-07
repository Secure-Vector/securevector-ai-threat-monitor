# Threat detection

What the rule engine and the optional Guardian model catch, and how each is installed and tuned. How scanning fits into the request path is in [GETTING_STARTED.md](GETTING_STARTED.md#how-scanning-works).

## What it detects

| Input Threats (User to LLM) | Output Threats (LLM to User) |
|-----------------------------|------------------------------|
| Prompt injection | Credential leakage (API keys, tokens) |
| Jailbreak attempts | System prompt exposure |
| Data exfiltration requests | PII disclosure (SSN, credit cards) |
| Social engineering | Jailbreak success indicators |
| SQL injection patterns | Encoded malicious content |
| Tool result injection (MCP) | |
| Multi-agent authority spoofing | |
| Permission scope escalation | |

Full coverage: [OWASP LLM Top 10](https://owasp.org/www-project-top-10-for-large-language-model-applications/)

## The rule set

The app ships 108 rules in 12 YAML files under `src/securevector/rules/community`: OWASP LLM Top 10 coverage, MITRE ATT&CK-mapped patterns, and the community packs for prompt injection, indirect prompt injection, jailbreaks, data extraction, output leakage, PII, social engineering, harmful content, evasion and essential patterns. Every detection in the app has a **Report this rule** link for false positives.

### AI agent attack protection

Built from real attack chains observed against production agent frameworks:

- **Tool Result Injection**: injected instructions hidden inside MCP tool responses
- **Multi-Agent Authority Spoofing**: impersonating trusted agents in multi-agent pipelines
- **Permission Scope Escalation**: agents requesting more permissions than granted
- **MCP Tool Call Injection**: malicious payloads delivered through MCP tool calls
- **Evasion techniques** (22 rules): zero-width characters, encoding tricks, roleplay framing, leetspeak, semantic inversion, emotional manipulation, and more

## Optional ML detection layer: SecureVector Guardian

Alongside the 108 rules, the app ships an **optional ML detection layer**, [**SecureVector Guardian**](https://github.com/Secure-Vector/securevector-guardian-model), a stdlib-only semantic threat classifier. It runs in parallel with the rule engine and catches obfuscated, paraphrased, buried, or encoded attacks that literal patterns miss, folding its verdict into the same allow / alert / block decision. The model is fully local and runs offline: no cloud round-trip, no prompt text leaves your machine.

**Install: comes with the `[app]` extra.** Guardian is the [`securevector-guardian-model`](https://github.com/Secure-Vector/securevector-guardian-model) package, installed as a dependency of `pip install "securevector-ai-monitor[app]"` on Python 3.10 or newer (pure Python, zero ML dependencies). The SDK-only install (`pip install securevector-ai-monitor`) does not include it, and on Python 3.9 the app installs without it and runs rules only. `pip install -U securevector-guardian-model` + restart updates the model independently of app releases, and the loaded version is shown in **Settings → Guardian ML Detection**. The model runtime (~1.8 MB) is downloaded once, on first use, from this project's GitHub releases, then cached and used offline; for air-gapped installs, pre-place it and point `SV_GUARDIAN_RUNTIME` at the file.

**On by default.** Toggle it from **Settings → Guardian ML Detection** (default ON), or force it off globally with the `SECUREVECTOR_ML_ENABLED=false` environment flag. With Guardian disabled the rules keep running unchanged, and the layer is fail-open: any model error silently falls back to rules-only so it never breaks the analyze path.

**What to expect when it's on.** The model is pure Python (zero dependencies, no GPU, no network), so it runs on any machine. It analyzes **in parallel** with the rules, adding roughly **~0.15 ms per typical analysis** (a prompt, tool call, or response: sub-millisecond), a few ms for ~1 KB of text, and up to ~100 ms only for very large documents (bounded, never unbounded). One-time startup is ~200 ms + ~34 MB RAM. Older/slower CPUs scale proportionally, but everyday inputs stay sub-millisecond. Full benchmark: [model performance](https://github.com/Secure-Vector/securevector-guardian-model#performance--what-to-expect).

## Related

- [Features in depth](FEATURES.md), including performance figures for the rule engine
- [Tool Permissions](TOOL_PERMISSIONS.md): the allow / block / log_only decision per tool
- [Skill Scanner](SKILL_SCANNER.md): static analysis of skill packages before you install them
