# SecureVector Guard — Claude Code plugin

Real-time policy enforcement and tamper-evident audit for MCP tool calls invoked from a Claude Code session.

This plugin is a third-party integration for [Claude Code](https://www.anthropic.com/code). It is built by SecureVector and is **not affiliated with or endorsed by Anthropic**.

---

## What it does

Every MCP tool call (`mcp__<server>__<tool>`) that the host issues passes through two hooks installed by this plugin:

| Hook | What happens |
|---|---|
| **PreToolUse** | Looks up the call against cloud-pushed deny rules synced to the local SecureVector app. Returns `permissionDecision: "deny"` (with policy reason), `"ask"`, or `"allow"`. **Fails open** — if the local app is unreachable, the call proceeds. |
| **PostToolUse** | Posts a fire-and-forget audit row to the local SecureVector app with `runtime_kind: "claude-code"`, the resolved policy decision, and a redacted snippet of the arguments. Persisted in a tamper-evident hash chain. |

**Both MCP and built-in tools** (`Bash`, `Edit`, `Read`, `Write`, `MultiEdit`, `Glob`, `Grep`, `LS`, `LSP`, `PowerShell`, `WebFetch`, `WebSearch`, `Task`, `Agent`, `Skill`, `Monitor`, `NotebookEdit`, `NotebookRead`, `TodoWrite`, `TodoRead`, `ExitPlanMode`, `EnterPlanMode`, `EnterWorktree`, `ExitWorktree`) are enforced and audited. Unknown tool names short-circuit to allow (fail-open).

## Requirements

- [Claude Code](https://www.anthropic.com/code) ≥ the version that supports plugins with `.claude-plugin/plugin.json` manifests
- Node.js 18+ (the host uses its own Node runtime; no separate install required)
- A running local [SecureVector AI Threat Monitor](https://github.com/Secure-Vector/securevector-ai-threat-monitor) app on `http://127.0.0.1:8741` (or override via `SV_BASE_URL` env var)

## Installation

The recommended path is via the SecureVector app's **Integrations** page (`/integrations` in the threat-monitor UI), which stages the plugin under `~/.claude/plugins/` and shows the two commands to paste into Claude Code:

```text
/plugin marketplace add ~/.securevector/staging/claude-code-plugin
/plugin install securevector-guard
```

After installation, restart your Claude Code session.

## Verifying it works

1. Confirm SecureVector is running:
   ```bash
   curl -fsS http://127.0.0.1:8741/api/health
   ```

2. From a Claude Code session, invoke any MCP tool. The call should succeed and within a few seconds appear in the SecureVector **Tool Activity** tab with `runtime_kind=claude-code`.

3. To verify deny enforcement, push a cloud-managed deny rule for an MCP tool you control, then call that tool — the host should return a denial with the policy reason in the transcript.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Calls pass even with a deny rule active | SecureVector app not running, OR hook handler can't reach it | Confirm `curl http://127.0.0.1:8741/api/health`; check `SV_BASE_URL` if non-default port |
| Hook calls feel slow | Local app unreachable; 100ms timeout firing on every call | Restart the SecureVector app — the timeout is fail-open by design |
| No audit rows appearing | PostToolUse hook not registered | Run `/plugin list` to confirm `securevector-guard` is installed and enabled |
| Built-in tools (`Bash`, `Edit`) not enforced | A cloud rule targets a name outside the governable built-in list, OR the rule wasn't pushed | Push a synced rule with `tool_id` equal to the exact PascalCase tool name (e.g. `tool_id: "Bash"`, `tool_id: "MultiEdit"`) — see the [governable built-in list](#supported-tool-names) |

## Supported tool names

A cloud-pushed synced rule's `tool_id` must match one of these names exactly (PascalCase, case-sensitive) for built-in enforcement to fire. MCP tools are matched by `<server>:<tool>` or bare `<tool>` form.

| Category | Names |
|---|---|
| File ops | `Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `NotebookRead` |
| Search / navigation | `Glob`, `Grep`, `LS`, `LSP` |
| Shell | `Bash`, `PowerShell` |
| Web | `WebFetch`, `WebSearch` |
| Agents / planning | `Task`, `Agent`, `ExitPlanMode`, `EnterPlanMode` |
| Worktrees | `EnterWorktree`, `ExitWorktree` |
| Skills / background | `Skill`, `Monitor` |
| Todos | `TodoWrite`, `TodoRead` |

The canonical list lives in `lib/normalize.js` as the `BUILTIN_TOOLS` Set. Names outside this list short-circuit to allow without contacting the local app (fail-open).

## Configuration

The plugin reads `SV_BASE_URL` from the environment if set; otherwise defaults to `http://127.0.0.1:8741`. To point at a non-default SecureVector instance:

```bash
export SV_BASE_URL="http://localhost:9000"
# then launch Claude Code
```

## Hooks registered

- **PreToolUse** (`hooks/pre-tool-use.js`) — blocks tool calls per the synced + local override rules; returns `permissionDecision: allow|deny|ask`.
- **PostToolUse** (`hooks/post-tool-use.js`) — fire-and-forget audit POST to `/api/tool-permissions/call-audit` (tagged `runtime_kind=claude-code`). A second POST to `/analyze` runs only for tools whose `tool_input` is *prose the agent emitted in natural language* — WebFetch.prompt, Skill/Task/Agent prompts. Syntax-shaped tools (Bash, PowerShell, Write, Edit, MultiEdit, NotebookEdit) are intentionally NOT scanned at `/analyze`: the community rule pack was designed for LLM prose, and running it against shell command bodies or source-code edits produced high-volume false positives (URLs tripping credential-leak, `| python3 -m json.tool` tripping bulk-data-extraction, etc.). Tool calls for those tools still produce `/call-audit` rows — only the threat scan is skipped. Secrets are redacted via shared `lib/redact.js` before either POST.
- **UserPromptSubmit** (`hooks/user-prompt-submit.js`) — forwards every incoming prompt to local `/analyze` for injection / jailbreak scanning by the rule engine; detection happens server-side, not in the hook. Prompts are first redacted (`lib/redact.js` patterns: sk-/pk- / GitHub PAT / AWS AKIA / JWT / labelled credential kv-pairs) and capped at 8 KB before POST. Fail-open, never blocks the prompt.
- **Stop** (`hooks/stop-hook-probe.js`) — temporary v4.2.x diagnostic (targeted for removal in v4.3.x). Writes shape-only metadata (key list + `typeof`, **never payloads**) to `~/.securevector/cost-probes/`; probe files are written mode 0600, the directory itself is 0700, capped at 100 files. Used to determine empirically whether Claude Code's Stop-event payload carries token-usage data.

All hooks fail-open: every error path emits the equivalent of "allow" (or an empty response) and the plugin never breaks a Claude Code session. All POSTs target loopback (`http://127.0.0.1:8741` by default).

## Optional: statusline integration

`hooks/statusline.js` is a tiny Node script that prints one line of live SecureVector findings — threat count, allow/block tally, 7-day token usage — for Claude Code's `statusLine` slot. It reads (and ignores) the standard Claude Code statusline JSON on stdin, hits the local app on loopback in parallel, and exits within ~400 ms. **If the app is down it prints nothing**, so the host statusline always renders.

Example output: `SecureVector Guard · 2 threats detected · 5 tool calls (3 allow / 2 block) · 7d 1.4M tok`

**Wire it in (replace your statusLine):** add to `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "node ~/.claude/plugins/cache/securevector-local/securevector-guard/4.2.1/hooks/statusline.js",
  "refreshInterval": 5
}
```

**Wire it in (compose with an existing statusline):** call it from your existing script and append the output, e.g. in a Python statusline:

```python
import subprocess, sys
sv = subprocess.run(
    ["node", "/Users/me/.claude/plugins/cache/securevector-local/securevector-guard/4.2.1/hooks/statusline.js"],
    input=sys.stdin.read(), capture_output=True, text=True, timeout=1
).stdout.strip()
print(f"{your_existing_line}  {sv}" if sv else your_existing_line)
```

Override the app URL with `SECUREVECTOR_URL=http://127.0.0.1:9999` if you bind the local app to a non-default port.

## What's NOT in this plugin

- SessionStart hook coverage (none today; out of scope for v1).
- Caching, retries, or buffering of audit posts (fire-and-forget is intentional).
- Windows-specific install polish.

## License

Apache-2.0. See [LICENSE](../../../../../LICENSE) in the repository root.

## Disclaimer

Built by SecureVector. Not affiliated with or endorsed by Anthropic. "Claude Code" is a product name referenced descriptively to identify the target runtime — see Anthropic's [Trademark Policy](https://www.anthropic.com/legal/trademark) for the boundaries of nominative use.
