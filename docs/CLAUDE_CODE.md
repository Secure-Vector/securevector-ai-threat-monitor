# Claude Code Integration — SecureVector Guard plugin

SecureVector ships a first-class plugin for Claude Code: real-time tool-permission enforcement, tamper-evident audit, prompt-injection scanning, token-usage telemetry, and an optional one-line statusline emitter — all on loopback, with no LLM proxy in the request path.

## What the plugin does

| Hook | Mode | Description |
|---|---|---|
| `PreToolUse` | blocking (await, sub-ms) | Enforces cloud-synced and local tool-permission rules. Returns `permissionDecision: allow / deny / ask` with a reason that propagates to the audit row. |
| `PostToolUse` | fire-and-forget | Writes the call to the SHA-256 hash-chained `tool_call_audit` table tagged `runtime_kind=claude-code`. For prose-shaped tool inputs (WebFetch, Skill, Task, Agent), also forwards to `/analyze` for prompt-injection / data-leak scanning. |
| `UserPromptSubmit` | fire-and-forget | Forwards every incoming prompt to `/analyze` for jailbreak / injection detection by the rule engine. Prompts are redacted (sk- / pk- / GitHub PAT / AWS AKIA / JWT / labelled credential kv-pairs) and capped at 8 KB before POST. |
| `Stop` | diagnostic | Captures shape-only Stop-event metadata to `~/.securevector/cost-probes/`. Used to investigate Claude Code's Stop payload empirically; targeted for removal in a future release. |

All hooks fail-open: any error path emits the equivalent of "allow" (or an empty response) and the plugin never breaks a Claude Code session. All HTTP targets the local app at `http://127.0.0.1:8741` (overridable via the `SECUREVECTOR_URL` env var).

## Install

```bash
# 1. Install the SecureVector local app (Apache 2.0, no signup)
pip install 'securevector-ai-monitor[app]'

# 2. Start the local app (binds 127.0.0.1:8741)
securevector-app --web

# 3. Install the plugin — either from the app UI or via the API
curl -X POST http://127.0.0.1:8741/api/hooks/claude-code/install

# 4. In your Claude Code session, reload plugins (or restart Claude Code)
#    /reload-plugins
```

After step 3, the plugin tree is staged to `~/.securevector/staging/claude-code-plugin/` and auto-installed to `~/.claude/plugins/cache/securevector-local/securevector-guard/<version>/`. The plugin's `enabledPlugins` entry is written to `~/.claude/settings.json` automatically.

## Verify it works

```bash
# 1. Plugin status from the local app
curl -s http://127.0.0.1:8741/api/hooks/claude-code/status | python3 -m json.tool

# Expected:
#   "installed": true
#   "enabled": true
#   "claude_install_path": ".../securevector-guard/4.2.1"
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
  "command": "node ~/.claude/plugins/cache/securevector-local/securevector-guard/4.2.1/hooks/statusline.js",
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
# Via API (recommended — also strips the settings.json entries)
curl -X POST http://127.0.0.1:8741/api/hooks/claude-code/uninstall

# Manual cleanup if the API isn't available:
rm -rf ~/.claude/plugins/cache/securevector-local
# Then edit ~/.claude/settings.json and remove:
#   - the "securevector-guard@securevector-local" key under enabledPlugins
#   - the "securevector-local" entry under extraKnownMarketplaces
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
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8741/api/health
```
The plugin never breaks a Claude Code session — when the app is down, every hook decision is `allow` and no audit row is written. Restart with `securevector-app --web`.

**Audit rows show `action=allow` for everything, even when a synced cloud rule should deny.** Confirm the rule is reaching the local app:
```bash
curl -s http://127.0.0.1:8741/api/tool-permissions/synced-overrides | python3 -m json.tool
```
If `total: 0`, your local app isn't enrolled with the cloud yet — open the Settings → Cloud tab and pair the device key. Local overrides set from the Tool Permissions UI take effect immediately.

**Tokens missing from the statusline after install.** The token-usage endpoint scans Claude Code session transcripts on disk (`~/.claude/projects/<slug>/<session>.jsonl`) and takes 2–8 s on the first call after a restart. The statusline emitter caches the result for 5 min and refreshes in the background. **First-ever render shows everything except tokens for one refresh cycle (≤ 5 s);** subsequent renders include tokens reliably.

**Statusline not visible at all.** Claude Code's `statusLine.command` is set in your `~/.claude/settings.json`. If you already have a custom statusline (e.g. context-window usage), it overrides the SV emitter unless you compose them. See "Statusline integration" above.

**`Bash` calls are scanned but my custom MCP tool isn't.** `/analyze` only runs on tools whose `tool_input` is *natural-language prose* (WebFetch, Skill, Task, Agent prompts). Shell-syntax-shaped inputs (Bash, PowerShell, Write, Edit, MultiEdit, NotebookEdit) are audited to the hash chain but **not** fed to the rule pack — that scope mismatch produced high-volume false positives. Custom MCP tools that emit prose get scanned; tools that take structured inputs don't.

**macOS Gatekeeper blocks the app.** Install via pip rather than the `.dmg`. If you must use the `.dmg`, only download from the official GitHub releases page, verify the `SHA256SUMS.txt`, then run `xattr -cr /Applications/SecureVector.app` in Terminal.

**Multiple SecureVector versions installed.** The statusline emitter globs `~/.claude/plugins/cache/securevector-local/securevector-guard/*/hooks/statusline.js` and picks the highest-versioned one. Uninstall + reinstall via the app to consolidate.

**Plugin not in Claude Code's plugin list.** Check `~/.claude/settings.json` for the entries written at install time:
```json
{
  "enabledPlugins": { "securevector-guard@securevector-local": true },
  "extraKnownMarketplaces": {
    "securevector-local": { "source": { "source": "directory",
      "path": "/Users/<you>/.securevector/staging/claude-code-plugin" } }
  }
}
```

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
