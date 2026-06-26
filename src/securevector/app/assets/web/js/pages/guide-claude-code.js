/**
 * Claude Code Plugin — full setup guide page.
 *
 * In-app mirror of docs/CLAUDE_CODE.md so users don't have to leave
 * the app to find install / verify / statusline / configuration /
 * uninstall / troubleshooting details. Hand-written DOM (no
 * runtime markdown parser) — the source doc is stable and the page
 * count is one. Keep this file in sync with docs/CLAUDE_CODE.md when
 * either changes.
 */

const GuideClaudeCodePage = {
    async render(container) {
        container.textContent = '';

        const root = document.createElement('div');
        root.style.cssText = 'max-width: 920px; margin: 0 auto; padding: 24px 32px; font-size: 14px; line-height: 1.6; color: var(--text-primary);';

        // --- Header ---
        const header = document.createElement('div');
        header.style.cssText = 'margin-bottom: 28px;';
        const eyebrow = document.createElement('div');
        eyebrow.style.cssText = 'font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: var(--accent-primary); margin-bottom: 6px;';
        eyebrow.textContent = 'Integration Guide';
        header.appendChild(eyebrow);
        const h1 = document.createElement('h1');
        h1.style.cssText = 'font-size: 28px; font-weight: 700; margin: 0 0 8px 0; color: var(--text-primary);';
        h1.textContent = 'Claude Code Plugin';
        header.appendChild(h1);
        const lede = document.createElement('p');
        lede.style.cssText = 'color: var(--text-secondary); margin: 0;';
        lede.textContent = 'Real-time tool-permission enforcement, tamper-evident audit, prompt-injection scanning, token-usage telemetry, and an optional one-line statusline emitter — all on loopback, no LLM proxy in the request path.';
        header.appendChild(lede);
        root.appendChild(header);

        // --- Helpers ---
        const h2 = (text) => {
            const el = document.createElement('h2');
            el.style.cssText = 'font-size: 18px; font-weight: 700; margin: 28px 0 10px 0; color: var(--text-primary); border-bottom: 1px solid var(--border-default); padding-bottom: 6px;';
            el.textContent = text;
            return el;
        };
        const h3 = (text) => {
            const el = document.createElement('h3');
            el.style.cssText = 'font-size: 14px; font-weight: 700; margin: 18px 0 6px 0; color: var(--text-primary);';
            el.textContent = text;
            return el;
        };
        const p = (text) => {
            const el = document.createElement('p');
            el.style.cssText = 'margin: 8px 0; color: var(--text-secondary);';
            el.textContent = text;
            return el;
        };
        const code = (text) => {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'position: relative; margin: 8px 0;';
            const pre = document.createElement('pre');
            pre.style.cssText = 'padding: 12px 14px; background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 6px; font-family: monospace; font-size: 12px; user-select: all; overflow-x: auto; margin: 0; white-space: pre; color: var(--text-primary);';
            pre.textContent = text;
            wrap.appendChild(pre);
            const copyBtn = document.createElement('button');
            copyBtn.style.cssText = 'position: absolute; top: 6px; right: 6px; padding: 4px 10px; font-size: 11px; background: var(--bg-secondary); border: 1px solid var(--border-default); border-radius: 4px; color: var(--text-secondary); cursor: pointer;';
            copyBtn.textContent = 'Copy';
            copyBtn.onclick = async () => {
                try { await navigator.clipboard.writeText(text); copyBtn.textContent = 'Copied'; setTimeout(() => copyBtn.textContent = 'Copy', 1200); }
                catch { copyBtn.textContent = 'Copy failed'; }
            };
            wrap.appendChild(copyBtn);
            return wrap;
        };
        const inline = (text) => {
            const el = document.createElement('code');
            el.style.cssText = 'padding: 1px 6px; background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 3px; font-family: monospace; font-size: 12px;';
            el.textContent = text;
            return el;
        };
        const note = (label, body) => {
            const el = document.createElement('div');
            el.style.cssText = 'margin: 8px 0; color: var(--text-secondary); padding-left: 16px; text-indent: -16px;';
            const strong = document.createElement('strong');
            strong.style.cssText = 'color: var(--text-primary); font-weight: 600;';
            strong.textContent = label + ' — ';
            el.appendChild(strong);
            el.appendChild(document.createTextNode(body));
            return el;
        };

        // --- What the plugin does ---
        root.appendChild(h2('What the plugin does'));
        const hooksTable = document.createElement('table');
        hooksTable.style.cssText = 'width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 13px;';
        const hdr = document.createElement('thead');
        hdr.innerHTML = '<tr><th style="text-align:left; padding:8px 10px; border-bottom:2px solid var(--border-default); width:25%;">Hook</th><th style="text-align:left; padding:8px 10px; border-bottom:2px solid var(--border-default); width:22%;">Mode</th><th style="text-align:left; padding:8px 10px; border-bottom:2px solid var(--border-default);">Description</th></tr>';
        hooksTable.appendChild(hdr);
        const tbody = document.createElement('tbody');
        const hookRows = [
            ['PreToolUse', 'blocking; 100 ms fail-open ceiling', 'Enforces cloud-synced and local tool-permission rules. Returns permissionDecision: allow / deny / ask with a reason that propagates to the audit row.'],
            ['PostToolUse', 'fire-and-forget', 'Writes the call to the SHA-256 hash-chained tool_call_audit table tagged runtime_kind=claude-code. For prose-shaped tool inputs (WebFetch, Skill, Task, Agent), also forwards to /analyze for prompt-injection / data-leak scanning.'],
            ['UserPromptSubmit', 'fire-and-forget', 'Forwards every incoming prompt to /analyze for jailbreak / injection detection. Prompts are redacted via lib/redact.js (sk-/pk-, gh[pousr]_, AKIA, JWT triples, and labelled kv-pairs for password/secret/token/api_key/bearer) and capped at 8000 bytes before POST.'],
            ['Stop', 'diagnostic', 'Captures shape-only Stop-event metadata to ~/.securevector/cost-probes/. Used to investigate Claude Code\'s Stop payload empirically; targeted for removal in a future release.'],
        ];
        hookRows.forEach(([h, m, d]) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td style="padding:8px 10px; border-bottom:1px solid var(--border-default); font-family:monospace; font-size:12px;">${h}</td><td style="padding:8px 10px; border-bottom:1px solid var(--border-default); color:var(--text-secondary);">${m}</td><td style="padding:8px 10px; border-bottom:1px solid var(--border-default); color:var(--text-secondary);">${d}</td>`;
            tbody.appendChild(tr);
        });
        hooksTable.appendChild(tbody);
        root.appendChild(hooksTable);
        const failopen = p('All hooks fail-open: any error path emits the equivalent of "allow" (or an empty response) and the plugin never breaks a Claude Code session. All HTTP targets the local app on loopback at http://127.0.0.1:8741 (override with the SECUREVECTOR_ENGINE_ENDPOINT env var; legacy SV_BASE_URL still works).');
        root.appendChild(failopen);

        // --- Latency (honest framing — no "zero-latency" marketing copy) ---
        root.appendChild(h3('Latency'));
        const latencyCallout = document.createElement('div');
        latencyCallout.style.cssText = 'margin: 8px 0; padding: 12px 14px; border: 1px solid var(--border-default); border-left: 3px solid var(--accent-primary); border-radius: 6px; background: var(--bg-tertiary);';
        const latencyP1 = document.createElement('p');
        latencyP1.style.cssText = 'margin: 0 0 6px 0; color: var(--text-primary); font-size: 13px; line-height: 1.5;';
        latencyP1.textContent = 'Policy enforcement (PreToolUse) is synchronous — every tool call waits on a loopback HTTP request to the local app before it proceeds. Threat detection (UserPromptSubmit and the PostToolUse → /analyze leg) is fire-and-forget and adds no user-visible latency, but is also not preventive: by the time a threat is flagged, the prompt has already gone to the model or the tool has already returned.';
        latencyCallout.appendChild(latencyP1);
        const latencyP2 = document.createElement('p');
        latencyP2.style.cssText = 'margin: 0; color: var(--text-secondary); font-size: 13px; line-height: 1.5;';
        const latencyStrong = document.createElement('strong');
        latencyStrong.style.color = 'var(--text-primary)';
        latencyStrong.textContent = 'Hard ceiling: 100 ms.';
        latencyP2.appendChild(latencyStrong);
        latencyP2.appendChild(document.createTextNode(' That is the fail-open timeout in lib/client.js. If the local app is unreachable or slow, the hook returns allow at 100 ms and the tool call proceeds — so a misbehaving local app cannot stall Claude Code beyond 100 ms per tool call.'));
        latencyCallout.appendChild(latencyP2);
        root.appendChild(latencyCallout);

        // --- Install ---
        root.appendChild(h2('Install'));
        root.appendChild(p('First, install and start the SecureVector local app — both install paths below depend on it running on loopback:'));
        root.appendChild(code(`pip install 'securevector-ai-monitor[app]'   # Apache 2.0, no signup\nsecurevector-app --web                       # binds 127.0.0.1:8741`));

        root.appendChild(h3('Option A — via the app UI'));
        root.appendChild(p('Open http://127.0.0.1:8741, click Integrations → Claude Code, then click Install Plugin.'));

        root.appendChild(h3('Option B — via CLI'));
        root.appendChild(p('Same operation the UI button performs. Runs the install handler in-process — the web server does not need to be running.'));
        root.appendChild(code('securevector-app --install-plugin claude-code'));
        const respLabel = document.createElement('p');
        respLabel.style.cssText = 'margin: 8px 0 4px 0; color: var(--text-secondary); font-size: 13px;';
        respLabel.textContent = 'A successful response looks like:';
        root.appendChild(respLabel);
        root.appendChild(code(`{
  "ok": true,
  "auto_installed": true,
  "enabled": true,
  "claude_install_path": "~/.claude/plugins/cache/securevector-local/securevector-guard/4.6.0",
  "files": [".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/pre-tool-use.js",
            "hooks/post-tool-use.js", "hooks/user-prompt-submit.js", "hooks/stop-hook-probe.js",
            "hooks/statusline.js", "lib/normalize.js", "lib/client.js", "lib/redact.js",
            "README.md"],
  "commands": [],
  "next_step": "Run /reload-plugins in your Claude Code session to activate."
}`));

        root.appendChild(h3('Final step (both paths)'));
        root.appendChild(p('In your Claude Code session:'));
        root.appendChild(code('/reload-plugins'));
        const installNote = document.createElement('p');
        installNote.style.cssText = 'margin: 12px 0 4px 0; color: var(--text-secondary); font-size: 13px;';
        installNote.appendChild(document.createTextNode('Auto-install touches three Claude Code config files: '));
        installNote.appendChild(inline('~/.claude/plugins/known_marketplaces.json'));
        installNote.appendChild(document.createTextNode(' (marketplace slug '));
        installNote.appendChild(inline('securevector-local'));
        installNote.appendChild(document.createTextNode('), '));
        installNote.appendChild(inline('~/.claude/plugins/installed_plugins.json'));
        installNote.appendChild(document.createTextNode(' (install entry), and '));
        installNote.appendChild(inline('~/.claude/settings.json'));
        installNote.appendChild(document.createTextNode(' ('));
        installNote.appendChild(inline('enabledPlugins["securevector-guard@securevector-local"] = true'));
        installNote.appendChild(document.createTextNode('). Every other field is preserved.'));
        root.appendChild(installNote);

        const fallbackNote = document.createElement('p');
        fallbackNote.style.cssText = 'margin: 8px 0; color: var(--text-secondary); font-size: 13px;';
        fallbackNote.textContent = 'If ~/.claude/plugins/ doesn\'t exist yet (Claude Code hasn\'t been launched on this machine), auto-install can\'t run. In that case the install endpoint returns auto_installed: false and the Integrations page shows two paste-in commands to run inside your Claude Code session as fallback:';
        root.appendChild(fallbackNote);
        root.appendChild(code('/plugin marketplace add ~/.securevector/staging/claude-code-plugin\n/plugin install securevector-guard'));

        // --- Verify it works ---
        // --- Remote engine (Terraform / self-host) ---
        root.appendChild(h2('Pointing at a remote engine (Terraform / your own cloud)'));
        root.appendChild(p('Running the engine in your own cloud (the SecureVector Terraform modules) instead of locally? Install the plugin the same way, then point its hooks at your deployment’s endpoint URL — no local app needed.'));
        root.appendChild(code(`# install the plugin (hooks only; the engine runs remotely)
securevector-app --install-plugin claude-code

# point the hooks at your engine endpoint (the URL from \`terraform output\`)
export SECUREVECTOR_ENGINE_ENDPOINT=https://<your-engine-endpoint>`));
        root.appendChild(callout('Engine, not cloud.', 'SECUREVECTOR_ENGINE_ENDPOINT is the engine the hooks call for analysis — your local app OR your self-host / Terraform engine. It is NOT the SecureVector cloud (scan.securevector.io). Legacy SV_BASE_URL / SECUREVECTOR_URL still work as fallbacks.'));
        root.appendChild(p('Auth is optional. A private (in-VPC) endpoint needs no credential — the default and least friction. Only if you expose the endpoint publicly and gate it (Terraform ingress_token) do you set a key; use a free SecureVector account key or an SVET token — it gates inbound access only and forwards no data:'));
        root.appendChild(code(`export SECUREVECTOR_API_KEY=<SecureVector account key or SVET token>   # optional — public gated endpoint only`));

        root.appendChild(h2('Verify it works'));
        root.appendChild(p('1. Plugin status from the local app:'));
        root.appendChild(code('curl -s http://127.0.0.1:8741/api/hooks/claude-code/status | python3 -m json.tool'));
        const expectP = document.createElement('p');
        expectP.style.cssText = 'margin: 8px 0; color: var(--text-secondary);';
        expectP.appendChild(document.createTextNode('Expect '));
        expectP.appendChild(inline('"installed": true'));
        expectP.appendChild(document.createTextNode(', '));
        expectP.appendChild(inline('"enabled": true'));
        expectP.appendChild(document.createTextNode(', the install path under '));
        expectP.appendChild(inline('securevector-guard/<version>'));
        expectP.appendChild(document.createTextNode(', and 11 files present.'));
        root.appendChild(expectP);

        root.appendChild(p('2. Run any Bash command in Claude Code, then read the audit row:'));
        root.appendChild(code(`curl -s 'http://127.0.0.1:8741/api/tool-permissions/call-audit?limit=1' | python3 -m json.tool\n# Expect runtime_kind="claude-code" on the entry.`));

        root.appendChild(p('3. Visit http://127.0.0.1:8741 → Tool Activity tab. The hash-chained audit log appears with a one-click "Verify integrity" button.'));

        // --- Statusline ---
        root.appendChild(h2('Statusline integration (optional)'));
        const slP1 = document.createElement('p');
        slP1.style.cssText = 'margin: 8px 0; color: var(--text-secondary);';
        slP1.appendChild(document.createTextNode('hooks/statusline.js prints a one-line live summary for Claude Code\'s '));
        slP1.appendChild(inline('statusLine'));
        slP1.appendChild(document.createTextNode(' slot:'));
        root.appendChild(slP1);
        root.appendChild(code('SecureVector Guard · 2 threats detected · 5 tool calls (3 allow / 2 block) · 7d 1.4M tok'));
        root.appendChild(p('Warm renders return in ~50 ms. Token usage (the slow leg, ~2–8 s server-side) is fetched in a detached background process and served from a 5-minute on-disk cache, so first-ever render shows everything except tokens — the next 1–2 statusline refreshes pick them up.'));

        root.appendChild(h3('Compose with an existing statusline (recommended)'));
        root.appendChild(p('Shell out from your existing statusline script and append the SV line. Example for Python:'));
        root.appendChild(code(`import subprocess, glob, os
candidates = sorted(glob.glob(os.path.expanduser(
    "~/.claude/plugins/cache/securevector-local/securevector-guard/*/hooks/statusline.js")))
if candidates:
    sv = subprocess.run(["node", candidates[-1]], input=stdin_blob,
                        capture_output=True, text=True, timeout=2).stdout.strip()
    if sv: print(your_existing_line + "\\n" + sv)`));

        root.appendChild(h3('Replace your statusLine outright'));
        root.appendChild(p('This uses the version-stable staging copy, so it survives plugin upgrades (the cache path is versioned and would break on the next bump):'));
        root.appendChild(code(`"statusLine": {
  "type": "command",
  "command": "node ~/.securevector/staging/claude-code-plugin/hooks/statusline.js",
  "refreshInterval": 5
}`));
        root.appendChild(p('Set NO_COLOR=1 to disable the cyan/red ANSI styling.'));

        // --- Configuration ---
        root.appendChild(h2('Configuration'));
        const cfgTable = document.createElement('table');
        cfgTable.style.cssText = 'width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 13px;';
        cfgTable.innerHTML = `<thead><tr>
            <th style="text-align:left; padding:8px 10px; border-bottom:2px solid var(--border-default);">Setting</th>
            <th style="text-align:left; padding:8px 10px; border-bottom:2px solid var(--border-default);">Where</th>
            <th style="text-align:left; padding:8px 10px; border-bottom:2px solid var(--border-default);">Default</th>
            <th style="text-align:left; padding:8px 10px; border-bottom:2px solid var(--border-default);">Purpose</th>
        </tr></thead>`;
        const cfgBody = document.createElement('tbody');
        const cfgRows = [
            ['Local app port', 'svconfig.yml server.port, or SV_WEB_PORT env', '8741', 'Loopback port the plugin POSTs to'],
            ['Plugin target URL', 'SECUREVECTOR_ENGINE_ENDPOINT env var', 'http://127.0.0.1:8741', 'Override for non-default app deployments'],
            ['Tool permission rules', 'Tool Permissions page in the app', 'Default-allow + last-resort denies', 'Per-tool allow / deny / ask, cloud-syncable, local overrides'],
            ['Statusline cache TTL', 'hardcoded in hooks/statusline.js', '60s line / 5 min tokens', 'Avoids hammering the transcript-scan endpoint'],
            ['Statusline colors', 'NO_COLOR=1 env var', 'colored', 'Disables ANSI styling'],
        ];
        cfgRows.forEach(([s, w, d, pp]) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td style="padding:8px 10px; border-bottom:1px solid var(--border-default); font-weight:600;">${s}</td><td style="padding:8px 10px; border-bottom:1px solid var(--border-default); font-family:monospace; font-size:12px; color:var(--text-secondary);">${w}</td><td style="padding:8px 10px; border-bottom:1px solid var(--border-default); font-family:monospace; font-size:12px; color:var(--text-secondary);">${d}</td><td style="padding:8px 10px; border-bottom:1px solid var(--border-default); color:var(--text-secondary);">${pp}</td>`;
            cfgBody.appendChild(tr);
        });
        cfgTable.appendChild(cfgBody);
        root.appendChild(cfgTable);

        // --- Uninstall ---
        root.appendChild(h2('Uninstall'));
        root.appendChild(p('Via the app UI: Integrations → Claude Code → Uninstall.'));
        root.appendChild(p('Or via CLI:'));
        root.appendChild(code('securevector-app --uninstall-plugin claude-code'));
        root.appendChild(p('Either path removes the cache dir, the marketplace entry from known_marketplaces.json, the install entry from installed_plugins.json, and the enabled flag from settings.json. Then run /reload-plugins in your Claude Code session.'));

        root.appendChild(h3('Optional: clear cached data'));
        root.appendChild(code(`rm -rf ~/.securevector/staging/claude-code-plugin
rm -f ~/.securevector/statusline-cache.json
rm -f ~/.securevector/statusline-tokens.json
rm -f ~/.securevector/statusline-refresh.lock
rm -rf ~/.securevector/cost-probes`));

        // --- Possible issues ---
        root.appendChild(h2('Possible issues'));
        root.appendChild(note("Hooks don't fire after install", 'run /reload-plugins in your Claude Code session, or restart Claude Code (the plugin manifest is loaded at session start).'));
        root.appendChild(note('"App unreachable" / fail-open silently', 'confirm the local app is running with curl http://127.0.0.1:8741/health (200 OK expected). The plugin never breaks a Claude Code session — when the app is down every decision is allow and no audit row is written.'));
        root.appendChild(note('Audit rows show action=allow even with a synced cloud rule', 'confirm the rule is reaching the local app: GET /api/tool-permissions/synced-overrides. Total: 0 means the device isn\'t enrolled with cloud yet — pair via Settings → Cloud.'));
        root.appendChild(note('Tokens missing from the statusline after install', 'the token-usage endpoint scans Claude Code session transcripts on disk and takes 2–8 s the first time. The statusline caches the result for 5 min and refreshes in the background. First render shows everything except tokens; the next 1–2 statusline refreshes pick up the freshly-cached value.'));
        root.appendChild(note('Statusline not visible at all', 'Claude Code\'s statusLine.command is set in ~/.claude/settings.json. If you already have a custom statusline (e.g. context-window usage), it overrides the SV emitter unless you compose them (see "Statusline integration").'));
        root.appendChild(note('Bash calls are scanned but my custom MCP tool isn\'t', '/analyze only runs on tools whose tool_input is natural-language prose (WebFetch, Skill, Task, Agent prompts). Shell-syntax-shaped inputs (Bash, PowerShell, Write, Edit, MultiEdit, NotebookEdit) are audited to the hash chain but NOT fed to the rule pack — that scope mismatch produced high-volume false positives.'));
        root.appendChild(note('macOS Gatekeeper blocks the app', 'install via pip rather than the .dmg. If you must use the .dmg, only download from the official GitHub releases page, verify SHA256SUMS.txt, then xattr -cr /Applications/SecureVector.app in Terminal.'));
        root.appendChild(note('Plugin not in Claude Code\'s plugin list', 'auto-install writes to three config files (settings.json, known_marketplaces.json, installed_plugins.json) — check each contains the securevector-local / securevector-guard entries. If they\'re absent, auto-install returned auto_installed: false; run the two paste-in commands shown on the Integrations page from inside your Claude Code session.'));

        // --- Privacy posture ---
        root.appendChild(h2('Privacy posture'));
        const privTable = document.createElement('table');
        privTable.style.cssText = 'width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 13px;';
        privTable.innerHTML = `<thead><tr>
            <th style="text-align:left; padding:8px 10px; border-bottom:2px solid var(--border-default); width:22%;">Surface</th>
            <th style="text-align:left; padding:8px 10px; border-bottom:2px solid var(--border-default); width:39%;">What it sees</th>
            <th style="text-align:left; padding:8px 10px; border-bottom:2px solid var(--border-default);">What it stores</th>
        </tr></thead>`;
        const privBody = document.createElement('tbody');
        const privRows = [
            ['PreToolUse body', 'tool name + arguments', 'one audit row per call (action + reason + hash-chained sequence)'],
            ['PostToolUse /analyze body', 'redacted natural-language prose from prose-shaped tool inputs', 'threat detection record if matched; nothing otherwise'],
            ['UserPromptSubmit body', 'redacted user prompt, first 8000 bytes', 'threat detection record if matched; nothing otherwise'],
            ['Statusline reads', 'aggregate counts + token totals from the local app', '60s line cache + 5 min token cache, mode 0600, under ~/.securevector/'],
        ];
        privRows.forEach(([s, sees, stores]) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td style="padding:8px 10px; border-bottom:1px solid var(--border-default); font-weight:600; vertical-align:top;">${s}</td><td style="padding:8px 10px; border-bottom:1px solid var(--border-default); color:var(--text-secondary); vertical-align:top;">${sees}</td><td style="padding:8px 10px; border-bottom:1px solid var(--border-default); color:var(--text-secondary); vertical-align:top;">${stores}</td>`;
            privBody.appendChild(tr);
        });
        privTable.appendChild(privBody);
        root.appendChild(privTable);
        root.appendChild(p('All HTTP is loopback. Nothing leaves the device unless cloud sync is explicitly enabled in the app settings.'));

        // --- What's NOT in the plugin ---
        root.appendChild(h2("What's NOT in the plugin"));
        const notList = document.createElement('ul');
        notList.style.cssText = 'margin: 8px 0 8px 18px; color: var(--text-secondary); padding-left: 8px;';
        ['LLM request interception or rewriting — the plugin observes via hooks; it does not sit in the LLM request path.',
         'Caching, retries, or buffering of audit posts — PostToolUse is fire-and-forget by design.',
         'A Windows-native installer for the plugin tree — the pip path works on Windows but binary builds are best-effort.'].forEach(t => {
            const li = document.createElement('li');
            li.style.cssText = 'margin: 4px 0;';
            li.textContent = t;
            notList.appendChild(li);
        });
        root.appendChild(notList);

        // --- Footer ---
        const footer = document.createElement('div');
        footer.style.cssText = 'margin: 32px 0 0 0; padding: 16px 0; border-top: 1px solid var(--border-default); color: var(--text-secondary); font-size: 12px;';
        const lic = document.createElement('div');
        lic.textContent = 'License: Apache 2.0.';
        footer.appendChild(lic);
        const disc = document.createElement('div');
        disc.style.cssText = 'margin-top: 4px;';
        disc.textContent = 'Built by SecureVector. Not affiliated with or endorsed by Anthropic. "Claude Code" is a product name referenced descriptively to identify the target runtime.';
        footer.appendChild(disc);
        root.appendChild(footer);

        container.appendChild(root);
    },
};

window.GuideClaudeCodePage = GuideClaudeCodePage;
