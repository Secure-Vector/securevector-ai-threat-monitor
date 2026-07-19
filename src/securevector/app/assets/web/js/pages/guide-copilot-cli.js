/**
 * GitHub Copilot CLI Plugin — full setup guide page.
 *
 * Sibling of guide-claude-code.js / guide-codex.js for the GitHub Copilot CLI
 * plugin (src/securevector/plugins/copilot-cli/). Same hand-written DOM +
 * helper pattern; only the harness specifics differ (camelCase events, root
 * plugin.json, fail-CLOSED host so the hook forces fail-open, auto-install into
 * ~/.copilot/config.json + store, MCP tools named <server>-<tool>, no
 * statusline). Keep in sync with routes/hooks_copilot_cli.py.
 */
const GuideCopilotCliPage = {
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
        h1.textContent = 'GitHub Copilot CLI Plugin';
        header.appendChild(h1);
        const lede = document.createElement('p');
        lede.style.cssText = 'color: var(--text-secondary); margin: 0;';
        lede.textContent = 'Real-time tool-permission enforcement, tamper-evident audit, and prompt-injection / secret scanning for the GitHub Copilot CLI — all on loopback, no LLM proxy in the request path. Audit rows are tagged runtime_kind=copilot-cli.';
        header.appendChild(lede);
        root.appendChild(header);

        // --- Helpers (mirror guide-codex.js) ---
        const h2 = (text) => { const el = document.createElement('h2'); el.style.cssText = 'font-size: 18px; font-weight: 700; margin: 28px 0 10px 0; color: var(--text-primary); border-bottom: 1px solid var(--border-default); padding-bottom: 6px;'; el.textContent = text; return el; };
        const h3 = (text) => { const el = document.createElement('h3'); el.style.cssText = 'font-size: 14px; font-weight: 700; margin: 18px 0 6px 0; color: var(--text-primary);'; el.textContent = text; return el; };
        const p = (text) => { const el = document.createElement('p'); el.style.cssText = 'margin: 8px 0; color: var(--text-secondary);'; el.textContent = text; return el; };
        const code = (text) => {
            const wrap = document.createElement('div'); wrap.style.cssText = 'position: relative; margin: 8px 0;';
            const pre = document.createElement('pre'); pre.style.cssText = 'padding: 12px 14px; background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 6px; font-family: monospace; font-size: 12px; user-select: all; overflow-x: auto; margin: 0; white-space: pre; color: var(--text-primary);'; pre.textContent = text; wrap.appendChild(pre);
            const copyBtn = document.createElement('button'); copyBtn.style.cssText = 'position: absolute; top: 6px; right: 6px; padding: 4px 10px; font-size: 11px; background: var(--bg-secondary); border: 1px solid var(--border-default); border-radius: 4px; color: var(--text-secondary); cursor: pointer;'; copyBtn.textContent = 'Copy';
            copyBtn.onclick = async () => { try { await navigator.clipboard.writeText(text); copyBtn.textContent = 'Copied'; setTimeout(() => copyBtn.textContent = 'Copy', 1200); } catch { copyBtn.textContent = 'Copy failed'; } };
            wrap.appendChild(copyBtn); return wrap;
        };
        const inline = (text) => { const el = document.createElement('code'); el.style.cssText = 'padding: 1px 6px; background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 3px; font-family: monospace; font-size: 12px;'; el.textContent = text; return el; };
        const note = (label, body) => { const el = document.createElement('div'); el.style.cssText = 'margin: 8px 0; color: var(--text-secondary); padding-left: 16px; text-indent: -16px;'; const strong = document.createElement('strong'); strong.style.cssText = 'color: var(--text-primary); font-weight: 600;'; strong.textContent = label + ' — '; el.appendChild(strong); el.appendChild(document.createTextNode(body)); return el; };
        const table = (cols, rows) => {
            const t = document.createElement('table'); t.style.cssText = 'width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 13px;';
            t.innerHTML = '<thead><tr>' + cols.map(c => `<th style="text-align:left; padding:8px 10px; border-bottom:2px solid var(--border-default);">${c}</th>`).join('') + '</tr></thead>';
            const tb = document.createElement('tbody');
            rows.forEach(r => { const tr = document.createElement('tr'); tr.innerHTML = r.map((cell, i) => `<td style="padding:8px 10px; border-bottom:1px solid var(--border-default); ${i === 0 ? 'font-family:monospace; font-size:12px;' : 'color:var(--text-secondary);'}">${cell}</td>`).join(''); tb.appendChild(tr); });
            t.appendChild(tb); return t;
        };

        // --- What the plugin does ---
        root.appendChild(h2('What the plugin does'));
        root.appendChild(p('Four hooks register against Copilot CLI events (camelCase, confirmed against Copilot CLI 1.0.60). The enforcement and scanning logic is the same engine the Claude Code and Codex plugins use.'));
        root.appendChild(table(['Hook', 'Mode', 'Description'], [
            ['preToolUse', 'blocking; fail-open', 'Enforces cloud-synced and local tool-permission rules. Returns allow / deny / ask with a reason that propagates to the audit row and to Copilot’s own UI.'],
            ['postToolUse', 'fire-and-forget', 'Writes the call to the SHA-256 hash-chained audit log tagged runtime_kind=copilot-cli. Scans tool responses — web_fetch / view / any MCP tool, plus Bash / PowerShell stdout (credential-marker-gated) — via /analyze for injection, credential and PII leaks (direction=incoming).'],
            ['userPromptSubmitted', 'fire-and-forget', 'Forwards every prompt to /analyze for jailbreak / injection detection (direction=outgoing). Observe-only — Copilot’s prompt hook has no stdout control, so it never blocks the prompt. Secrets are redacted before the POST.'],
            ['sessionStart', 'fire-and-forget', 'Records a session-boundary marker so the dashboard can bound each run, and emits a one-line "Guard inactive" notice to stderr if the local app is unreachable.'],
        ]));

        // --- Fail-open callout (Copilot is fail-CLOSED) ---
        const failBox = document.createElement('div');
        failBox.style.cssText = 'margin: 12px 0; padding: 12px 14px; border: 1px solid var(--border-default); border-left: 3px solid var(--accent-primary); border-radius: 6px; background: var(--bg-tertiary);';
        const fP = document.createElement('p');
        fP.style.cssText = 'margin: 0; color: var(--text-primary); font-size: 13px; line-height: 1.55;';
        const fStrong = document.createElement('strong'); fStrong.style.color = 'var(--text-primary)'; fStrong.textContent = 'Fail-open on an unreachable app. ';
        fP.appendChild(fStrong);
        fP.appendChild(document.createTextNode('Unlike Claude Code / Codex, Copilot CLI’s preToolUse hook fails '));
        const fEm = document.createElement('strong'); fEm.style.color = 'var(--text-primary)'; fEm.textContent = 'closed';
        fP.appendChild(fEm);
        fP.appendChild(document.createTextNode(' — a hook crash, non-zero exit, or timeout would DENY the tool call. SecureVector’s invariant is the opposite, so this plugin’s hook catches every error, emits an explicit '));
        fP.appendChild(inline('{"permissionDecision":"allow"}'));
        fP.appendChild(document.createTextNode(', and always exits 0. When the local app is down, Copilot keeps working — exactly like every other SecureVector harness. All HTTP targets the local app on loopback at '));
        fP.appendChild(inline('http://127.0.0.1:8741'));
        fP.appendChild(document.createTextNode(' (override with '));
        fP.appendChild(inline('SECUREVECTOR_ENGINE_ENDPOINT'));
        fP.appendChild(document.createTextNode(').'));
        failBox.appendChild(fP);
        root.appendChild(failBox);

        // --- Install ---
        root.appendChild(h2('Install'));
        root.appendChild(p('First install and start the SecureVector local app — both install paths depend on it:'));
        root.appendChild(code(`pip install 'securevector-ai-monitor[app]'   # Apache 2.0, no signup\nsecurevector-app --web                       # binds 127.0.0.1:8741`));

        root.appendChild(h3('Option A — via the app UI'));
        root.appendChild(p('Open http://127.0.0.1:8741, click Integrations → GitHub Copilot CLI, then click Install Plugin.'));

        root.appendChild(h3('Option B — via CLI'));
        root.appendChild(p('Same operation the UI button performs — runs the install handler in-process; the web server need not be running.'));
        root.appendChild(code('securevector-app --install-plugin copilot-cli'));

        const installNote = document.createElement('p');
        installNote.style.cssText = 'margin: 12px 0 4px 0; color: var(--text-secondary); font-size: 13px;';
        installNote.appendChild(document.createTextNode('Install stages the plugin tree under '));
        installNote.appendChild(inline('~/.securevector/staging/copilot-cli-plugin/'));
        installNote.appendChild(document.createTextNode(', copies it into Copilot’s own store at '));
        installNote.appendChild(inline('~/.copilot/installed-plugins/_direct/copilot-cli-plugin/'));
        installNote.appendChild(document.createTextNode(', and registers it enabled in '));
        installNote.appendChild(inline('~/.copilot/config.json'));
        installNote.appendChild(document.createTextNode(' (the installedPlugins[] array). Verified interchangeable with '));
        installNote.appendChild(inline('copilot plugin install'));
        installNote.appendChild(document.createTextNode(' — '));
        installNote.appendChild(inline('copilot plugin list'));
        installNote.appendChild(document.createTextNode(' shows it. A one-shot backup of the pristine config.json is written before the first change. If Copilot CLI isn’t installed yet, install stages the files and hands you the '));
        installNote.appendChild(inline('copilot plugin install <dir>'));
        installNote.appendChild(document.createTextNode(' command instead.'));
        root.appendChild(installNote);

        // --- Activate ---
        root.appendChild(h2('Activate — start a fresh session'));
        const act = document.createElement('div');
        act.style.cssText = 'margin: 8px 0; padding: 12px 14px; border: 1px solid var(--border-default); border-left: 3px solid var(--accent-primary); border-radius: 6px; background: var(--bg-tertiary);';
        const aP = document.createElement('p');
        aP.style.cssText = 'margin: 0; color: var(--text-primary); font-size: 13px; line-height: 1.55;';
        aP.appendChild(document.createTextNode('Copilot CLI loads plugin hooks at launch, so start a '));
        const aStrong = document.createElement('strong'); aStrong.style.color = 'var(--text-primary)'; aStrong.textContent = 'fresh Copilot CLI session';
        aP.appendChild(aStrong);
        aP.appendChild(document.createTextNode(' after installing. There is no separate trust prompt — once the plugin is enabled in config.json, the next session picks up the hooks automatically.'));
        act.appendChild(aP);
        root.appendChild(act);

        // --- Verify ---
        // --- Remote engine (Terraform / self-host) ---
        root.appendChild(h2('Pointing at a remote engine (Terraform / your own cloud)'));
        root.appendChild(p('Running the engine in your own cloud (the SecureVector Terraform modules) instead of locally? Install the plugin the same way, then point its hooks at your deployment’s endpoint URL — no local app needed.'));
        root.appendChild(code(`# install the plugin (hooks only; the engine runs remotely)
securevector-app --install-plugin copilot-cli

# point the hooks at your engine endpoint (the URL from \`terraform output\`)
export SECUREVECTOR_ENGINE_ENDPOINT=https://<your-engine-endpoint>`));
        root.appendChild(note('Engine, not cloud.', 'SECUREVECTOR_ENGINE_ENDPOINT is the engine the hooks call for analysis — your local app OR your self-host / Terraform engine. It is NOT the SecureVector cloud (scan.securevector.io). Legacy SV_BASE_URL / SECUREVECTOR_URL still work as fallbacks.'));
        root.appendChild(p('Auth is optional. A private (in-VPC) endpoint needs no credential — the default and least friction. Only if you expose the endpoint publicly and gate it (Terraform ingress_token — enforced by a v4.9.0+ engine; older images set but ignore it) do you set a key; use a free SecureVector account key or an SVET token — it gates inbound access only and forwards no data:'));
        root.appendChild(code(`export SECUREVECTOR_API_KEY=<SecureVector account key or SVET token>   # optional — public gated endpoint only`));

        root.appendChild(h2('Verify it works'));
        root.appendChild(p('1. Plugin status from the local app:'));
        root.appendChild(code('curl -s http://127.0.0.1:8741/api/hooks/copilot-cli/status | python3 -m json.tool'));
        const expectP = document.createElement('p');
        expectP.style.cssText = 'margin: 8px 0; color: var(--text-secondary);';
        expectP.appendChild(document.createTextNode('Expect '));
        expectP.appendChild(inline('"auto_installed": true'));
        expectP.appendChild(document.createTextNode(' and '));
        expectP.appendChild(inline('"enabled": true'));
        expectP.appendChild(document.createTextNode('. Confirm Copilot agrees with '));
        expectP.appendChild(inline('copilot plugin list'));
        expectP.appendChild(document.createTextNode('.'));
        root.appendChild(expectP);
        root.appendChild(p('2. Run any tool in Copilot (e.g. a shell command), then read the most recent audit row:'));
        root.appendChild(code(`curl -s 'http://127.0.0.1:8741/api/tool-permissions/call-audit?limit=1' | python3 -m json.tool\n# Expect runtime_kind="copilot-cli" on the entry.`));
        root.appendChild(p('3. Visit http://127.0.0.1:8741 → Observability. Your Copilot run appears on the Agent Map, in Runs, and on the Timeline.'));

        // --- Governable tools ---
        root.appendChild(h2('What you can govern'));
        root.appendChild(p('Built-in Copilot tools are matched by their exact (lowercase) names. The shell family is listed in full so blocking shell access is complete:'));
        root.appendChild(table(['Tool(s)', 'Risk', 'What it does'], [
            ['bash, write_bash, stop_bash', 'admin', 'Run / send input to / terminate a Bash session. Block all three to fully cut shell execution.'],
            ['read_bash, list_bash', 'read', 'Inspect Bash session output / list sessions.'],
            ['create, edit', 'write', 'Create or modify files.'],
            ['view, glob, grep', 'read', 'Read files, match by glob, search contents.'],
            ['web_fetch', 'read', 'Fetch a URL.'],
            ['task, skill', 'admin', 'Launch a sub-agent / execute a skill.'],
            ['sql, session_store_sql', 'write / read', 'Execute SQL against the session store.'],
        ]));
        const mcpP = document.createElement('p');
        mcpP.style.cssText = 'margin: 8px 0; color: var(--text-secondary);';
        mcpP.appendChild(document.createTextNode('MCP server tools arrive as '));
        mcpP.appendChild(inline('<server>-<tool>'));
        mcpP.appendChild(document.createTextNode(' (e.g. '));
        mcpP.appendChild(inline('everything-echo'));
        mcpP.appendChild(document.createTextNode('). A rule can target the exact tool or the whole server (e.g. block '));
        mcpP.appendChild(inline('everything'));
        mcpP.appendChild(document.createTextNode(' to block every tool from that MCP server). Their responses are also threat-scanned for indirect prompt injection.'));
        root.appendChild(mcpP);

        // --- Configuration ---
        root.appendChild(h2('Configuration'));
        root.appendChild(table(['Setting', 'Where', 'Default', 'Purpose'], [
            ['Local app port', 'svconfig.yml server.port, or SV_WEB_PORT', '8741', 'Loopback port the plugin POSTs to'],
            ['Plugin target URL', 'SECUREVECTOR_ENGINE_ENDPOINT env var', 'http://127.0.0.1:8741', 'Override for non-default app deployments'],
            ['Tool permission rules', 'Tool Permissions page in the app', 'Default-allow + last-resort denies', 'Per-tool allow / deny / ask, cloud-syncable, local overrides'],
        ]));
        root.appendChild(p('There is no statusline emitter for Copilot CLI — it exposes no plugin hook for rendering a status line. The equivalent live findings appear on the local SecureVector dashboard instead.'));

        // --- Uninstall ---
        root.appendChild(h2('Uninstall'));
        root.appendChild(p('Via the app UI: Integrations → GitHub Copilot CLI → Uninstall. Or via CLI:'));
        root.appendChild(code('securevector-app --uninstall-plugin copilot-cli'));
        root.appendChild(p('Either path removes the cached plugin copy and deregisters the entry from ~/.copilot/config.json (every other plugin and field preserved). Start a fresh Copilot session to drop the hooks.'));

        // --- Possible issues ---
        root.appendChild(h2('Possible issues'));
        root.appendChild(note('Hooks don’t fire after install', 'start a fresh Copilot CLI session — hooks are loaded at launch. Confirm copilot plugin list shows securevector-guard.'));
        root.appendChild(note('"App unreachable" / fail-open silently', 'confirm the local app is running with curl http://127.0.0.1:8741/health (200 OK). When the app is down every decision is allow and no audit row is written — the plugin never breaks the session.'));
        root.appendChild(note('No statusline in Copilot', 'expected — Copilot has no plugin hook for statusline rendering. Use the dashboard for live counts.'));
        root.appendChild(note('An MCP tool isn’t blocked by a local override', 'MCP tools are governed by cloud-synced rules (target <server>-<tool> or the server name). Local UI overrides apply to Copilot’s built-in tools; pair with cloud via Settings → Cloud to push MCP rules.'));
        root.appendChild(note('Audit rows show action=allow even with a synced cloud rule', 'check GET /api/tool-permissions/synced-overrides. Total: 0 means the device isn\'t paired with cloud yet — pair via Settings → Cloud.'));

        // --- Privacy ---
        root.appendChild(h2('Privacy posture'));
        root.appendChild(p('All HTTP is loopback. Prompts and tool I/O are redacted (sk-/pk-, gh[pousr]_, AKIA, Stripe sk_live_/sk_test_, JWT triples, PEM private keys, labelled credential k/v pairs) before scanning; the audit log stores a hash chain, not raw values. Nothing leaves the device unless cloud sync is explicitly enabled.'));

        // --- Footer ---
        const footer = document.createElement('div');
        footer.style.cssText = 'margin: 32px 0 0 0; padding: 16px 0; border-top: 1px solid var(--border-default); color: var(--text-secondary); font-size: 12px;';
        const lic = document.createElement('div'); lic.textContent = 'License: Apache 2.0.'; footer.appendChild(lic);
        const disc = document.createElement('div'); disc.style.cssText = 'margin-top: 4px;'; disc.textContent = 'Built by SecureVector. Not affiliated with or endorsed by GitHub or Microsoft. "GitHub Copilot" is a product name referenced descriptively to identify the target runtime.'; footer.appendChild(disc);
        root.appendChild(footer);

        container.appendChild(root);
    },
};
