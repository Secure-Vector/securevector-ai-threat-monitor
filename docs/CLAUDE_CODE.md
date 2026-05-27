# Claude Code Integration — SecureVector Guard plugin

SecureVector ships a first-class plugin for Claude Code: real-time tool-permission enforcement, tamper-evident audit, prompt-injection scanning, token-usage telemetry, and an optional one-line statusline emitter — all on loopback, with no LLM proxy in the request path.

## What the plugin does

| Hook | Mode | Description |
|---|---|---|
| `PreToolUse` | blocking; loopback HTTP with **100 ms fail-open ceiling** | Enforces cloud-synced and local tool-permission rules. Returns `permissionDecision: allow / deny / ask` with a reason that propagates to the audit row. The 100 ms cap (in `lib/client.js`) means a slow or unreachable local app can't stall Claude Code beyond that per call — the hook returns `allow` and the call proceeds. |
| `PostToolUse` | fire-and-forget | Writes the call to the SHA-256 hash-chained `tool_call_audit` table tagged `runtime_kind=claude-code`. For prose-shaped tool inputs (WebFetch, Skill, Task, Agent), also forwards to `/analyze` for prompt-injection / data-leak scanning. |
| `UserPromptSubmit` | fire-and-forget | Forwards every incoming prompt to `/analyze` for jailbreak / injection detection by the rule engine. Prompts are redacted via the shared `lib/redact.js` patterns (`sk-`/`pk-`, `gh[pousr]_` GitHub tokens, `AKIA` AWS keys, JWT triples, and labelled kv-pairs for `password`/`secret`/`token`/`api_key`/`bearer`) and capped at 8000 bytes before POST. |
| `Stop` | diagnostic | Captures shape-only Stop-event metadata to `~/.securevector/cost-probes/`. Used to investigate Claude Code's Stop payload empirically; targeted for removal in a future release. |

All hooks fail-open: any error path emits the equivalent of "allow" (or an empty response) and the plugin never breaks a Claude Code session. All HTTP targets the local app at `http://127.0.0.1:8741` (overridable via the `SECUREVECTOR_URL` env var).

### Latency — honest framing

Policy enforcement (`PreToolUse`) is **synchronous** — every tool call waits on a loopback HTTP request to the local app before it proceeds. Threat detection (`UserPromptSubmit` and the `PostToolUse` → `/analyze` leg) is **fire-and-forget** and adds no user-visible latency, but it is also **not preventive**: by the time a threat is flagged, the prompt has already gone to the model or the tool has already returned.

**Hard ceiling: 100 ms.** That's the fail-open timeout in `lib/client.js`. If the local app is unreachable or slow, the hook returns `allow` at 100 ms and the tool call proceeds — so a misbehaving local app cannot stall Claude Code beyond 100 ms per tool call.

## Install

First, install and start the SecureVector local app — both install paths below depend on it running on loopback:

```bash
pip install 'securevector-ai-monitor[app]'   # Apache 2.0, no signup
securevector-app --web                       # binds 127.0.0.1:8741
```

Then pick one of the two install paths:

### Option A — via the app UI

1. Open `http://127.0.0.1:8741` in a browser.
2. **Integrations → Claude Code**.
3. Click **Install Plugin**.

### Option B — via CLI

```bash
# Same operation the UI button performs. Does not require the web
# server to be running — runs the install handler in-process.
securevector-app --install-plugin claude-code
```

A successful response looks like:

```json
{
  "ok": true,
  "auto_installed": true,
  "enabled": true,
  "claude_install_path": "~/.claude/plugins/cache/securevector-local/securevector-guard/4.3.0",
  "files": [".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/pre-tool-use.js",
            "hooks/post-tool-use.js", "hooks/user-prompt-submit.js", "hooks/stop-hook-probe.js",
            "hooks/statusline.js", "lib/normalize.js", "lib/client.js", "lib/redact.js",
            "README.md"],
  "commands": [],
  "next_step": "Run /reload-plugins in your Claude Code session to activate."
}
```

### Final step (both paths)

In your Claude Code session, reload plugins (or restart Claude Code):

```
/reload-plugins
```

After step 3, the plugin tree is staged to `~/.securevector/staging/claude-code-plugin/` and auto-installed to `~/.claude/plugins/cache/securevector-local/securevector-guard/<version>/`. Three Claude Code config files are touched: the plugin appears under `~/.claude/plugins/known_marketplaces.json` (marketplace slug `securevector-local`), under `~/.claude/plugins/installed_plugins.json` (install entry), and `enabledPlugins["securevector-guard@securevector-local"] = true` is added to `~/.claude/settings.json`. Every other field in those files is preserved.

If `~/.claude/plugins/` doesn't exist yet (Claude Code hasn't been launched on this machine), auto-install can't run. In that case the install endpoint returns `auto_installed: false` and the UI surfaces two paste-in commands you run inside your Claude Code session as the fallback:

```
/plugin marketplace add ~/.securevector/staging/claude-code-plugin
/plugin install securevector-guard
```

## Verify it works

```bash
# 1. Plugin status from the local app
curl -s http://127.0.0.1:8741/api/hooks/claude-code/status | python3 -m json.tool

# Expected:
#   "installed": true
#   "enabled": true
#   "claude_install_path": ".../securevector-guard/4.3.0"
#   "files_present": [..11 entries..]

# 2. In your Claude Code session, run any Bash command. Then read the audit row:
curl -s 'http://127.0.0.1:8741/api/tool-permissions/call-audit?limit=1' | python3 -m json.tool
# Expect an entry with runtime_kind="claude-code" and tool_id="Bash".

# 3. Visit http://127.0.0.1:8741 in a browser. The "Tool Activity" tab shows
#    the hash-chained audit log with a one-click "Verify integrity" button.
```

## Statusline integration (optional)

`hooks/statusline.js` prints a one-line live summary for Claude Code's `statusLine` slot:

```
SecureVector Guard · 2 threats detected · 5 tool calls (3 allow / 2 block) · 7d 1.4M tok
```

The script returns in ~50 ms (background-refreshes the slow token-usage data) and fails silently if the local app is down.

**Compose with an existing statusline (recommended):** shell out from your Python / shell statusline script and append the SV line. Example for Python:

```python
import subprocess, glob, os
candidates = sorted(glob.glob(os.path.expanduser(
    "~/.claude/plugins/cache/securevector-local/securevector-guard/*/hooks/statusline.js")))
if candidates:
    sv = subprocess.run(["node", candidates[-1]], input=stdin_blob,
                        capture_output=True, text=True, timeout=2).stdout.strip()
    if sv: print(your_existing_line + "\n" + sv)
```

**Replace your statusLine outright:**

```json
"statusLine": {
  "type": "command",
  "command": "node ~/.claude/plugins/cache/securevector-local/securevector-guard/4.3.0/hooks/statusline.js",
  "refreshInterval": 5
}
```

Set `NO_COLOR=1` to disable the cyan/red ANSI styling.

## Configuration

| Setting | Where | Default | Purpose |
|---|---|---|---|
| Local app port | `svconfig.yml` `server.port`, or `SV_WEB_PORT` env | `8741` | Loopback port the plugin POSTs to |
| Plugin target URL | `SECUREVECTOR_URL` env var | `http://127.0.0.1:8741` | Override for non-default app deployments |
| Tool permission rules | `/tool-permissions` page in the app UI | Default-allow with last-resort denies | Per-tool allow / deny / ask, with cloud-syncable rules and local overrides |
| Statusline cache TTL | n/a — hardcoded | 5 min for token usage | Avoids hammering the transcript-scan endpoint |
| Statusline colors | `NO_COLOR=1` env var | colored | Disables ANSI styling |

## Uninstall

```bash
# Via CLI (recommended — also strips the marketplace + enabled-plugin entries)
securevector-app --uninstall-plugin claude-code

# Manual cleanup if the CLI isn't available — three config files to touch:
rm -rf ~/.claude/plugins/cache/securevector-local
# Edit ~/.claude/plugins/known_marketplaces.json and remove the
#   "securevector-local" key.
# Edit ~/.claude/plugins/installed_plugins.json and remove the
#   "securevector-guard@securevector-local" key.
# Edit ~/.claude/settings.json and remove the
#   "securevector-guard@securevector-local" key under enabledPlugins.
```

Optional: also clear cached data the plugin and statusline emitter wrote to disk:

```bash
rm -rf ~/.securevector/staging/claude-code-plugin
rm -f ~/.securevector/statusline-cache.json
rm -f ~/.securevector/statusline-tokens.json
rm -f ~/.securevector/statusline-refresh.lock
rm -rf ~/.securevector/cost-probes  # Stop-hook diagnostic probes
```

## Possible issues

**Hooks don't fire after install.** Reload the Claude Code plugin registry in your session: `/reload-plugins`. If that doesn't work, restart Claude Code (the plugin manifest is loaded at session start).

**`"App unreachable"` / fail-open silently.** Confirm the local app is running:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8741/health
```
The plugin never breaks a Claude Code session — when the app is down, every hook decision is `allow` and no audit row is written. Restart with `securevector-app --web`.

**Audit rows show `action=allow` for everything, even when a synced cloud rule should deny.** Confirm the rule is reaching the local app:
```bash
curl -s http://127.0.0.1:8741/api/tool-permissions/synced-overrides | python3 -m json.tool
```
If `total: 0`, your local app isn't enrolled with the cloud yet — open the Settings → Cloud tab and pair the device key. Local overrides set from the Tool Permissions UI take effect immediately.

**Tokens missing from the statusline after install.** The token-usage endpoint scans Claude Code session transcripts on disk (`~/.claude/projects/<slug>/<session>.jsonl`) and takes 2–8 s on the first call after a restart. The statusline emitter caches the result for 5 min and refreshes in the background. First-ever render shows everything except tokens; the next 1–2 statusline refreshes (`refreshInterval` default is 5 s) pick up the freshly-cached value.

**Statusline not visible at all.** Claude Code's `statusLine.command` is set in your `~/.claude/settings.json`. If you already have a custom statusline (e.g. context-window usage), it overrides the SV emitter unless you compose them. See "Statusline integration" above.

**`Bash` calls are scanned but my custom MCP tool isn't.** `/analyze` only runs on tools whose `tool_input` is *natural-language prose* (WebFetch, Skill, Task, Agent prompts). Shell-syntax-shaped inputs (Bash, PowerShell, Write, Edit, MultiEdit, NotebookEdit) are audited to the hash chain but **not** fed to the rule pack — that scope mismatch produced high-volume false positives. Custom MCP tools that emit prose get scanned; tools that take structured inputs don't.

**macOS Gatekeeper blocks the app.** Install via pip rather than the `.dmg`. If you must use the `.dmg`, only download from the official GitHub releases page, verify the `SHA256SUMS.txt`, then run `xattr -cr /Applications/SecureVector.app` in Terminal.

**Multiple SecureVector versions installed.** The statusline emitter globs `~/.claude/plugins/cache/securevector-local/securevector-guard/*/hooks/statusline.js` and picks the highest-versioned one. Uninstall + reinstall via the app to consolidate.

**Plugin not in Claude Code's plugin list.** Auto-install writes to three config files; check each:
- `~/.claude/settings.json` should contain `"enabledPlugins": { "securevector-guard@securevector-local": true }`.
- `~/.claude/plugins/known_marketplaces.json` should contain the `securevector-local` slug with `source: directory` pointing at `~/.securevector/staging/claude-code-plugin/`.
- `~/.claude/plugins/installed_plugins.json` should contain the `securevector-guard@securevector-local` install entry.

If any are missing, the install endpoint returned `auto_installed: false` (most often because `~/.claude/plugins/` didn't exist). Run the two paste-in commands from the Integrations page in your Claude Code session to register manually.

## Privacy posture

| Surface | What it sees | What it stores |
|---|---|---|
| `PreToolUse` body | tool name + arguments | one audit row per call (action + reason + hash-chained sequence) |
| `PostToolUse` body (`/analyze`) | natural-language prose from prose-shaped tool inputs, redacted | threat detection record if matched; nothing otherwise |
| `UserPromptSubmit` body | the user's prompt, redacted (first 8 KB) | threat detection record if matched; nothing otherwise |
| Statusline reads | aggregate counts + token totals from the local app | a 60 s line cache and a 5 min token cache, mode 0600, under `~/.securevector/` |

All HTTP is loopback. Nothing leaves the device unless cloud sync is explicitly enabled in the app settings.

## What's NOT in the plugin

- LLM request interception or rewriting — the plugin observes via hooks; it does not sit in the LLM request path.
- Caching, retries, or buffering of audit posts — `PostToolUse` is fire-and-forget by design.
- A Windows-native installer for the plugin tree — the pip path works on Windows but binary builds are best-effort.

## License

Apache 2.0. See the [LICENSE](../LICENSE) at the repository root.

## Disclaimer

Built by SecureVector. Not affiliated with or endorsed by Anthropic. "Claude Code" is a product name referenced descriptively to identify the target runtime — see Anthropic's [Trademark Policy](https://www.anthropic.com/legal/trademark) for the boundaries of nominative use.
