/**
 * Cursor Plugin — full setup guide page.
 *
 * Sibling of guide-claude-code.js / guide-codex.js / guide-copilot-cli.js for
 * the Cursor plugin (src/securevector/plugins/cursor/). Same hand-written DOM
 * + helper pattern; only the harness specifics differ (event-typed hooks
 * instead of one PreToolUse pair, hooks.json merge install, beforeReadFile as
 * a Cursor-only surface, no statusline). Keep in sync with
 * routes/hooks_cursor.py.
 */
const GuideCursorPage = {
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
        h1.textContent = 'Cursor Plugin';
        header.appendChild(h1);
        const lede = document.createElement('p');
        lede.style.cssText = 'color: var(--text-secondary); margin: 0;';
        lede.textContent = 'Real-time tool-permission enforcement, tamper-evident audit, and prompt-injection / secret scanning for the Cursor agent — all on loopback, no LLM proxy in the request path. Audit rows are tagged runtime_kind=cursor.';
        header.appendChild(lede);
        root.appendChild(header);

        // --- Helpers (mirror guide-copilot-cli.js) ---
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
        root.appendChild(p('Cursor splits enforcement across event-typed hooks (cursor.com/docs/agent/hooks) instead of one PreToolUse pair, so nine hooks register. The enforcement and scanning logic is the same engine the Claude Code, Codex, and Copilot CLI plugins use.'));
        root.appendChild(table(['Hook', 'Mode', 'Description'], [
            ['beforeShellExecution', 'blocking; fail-open', 'Enforces rules on the agent’s terminal commands (tool id shell). Returns allow / deny / ask with a SecureVector Guard reason shown to you AND sent back to the agent.'],
            ['beforeMCPExecution', 'blocking; fail-open', 'Same enforcement for MCP tools. Rules can target the exact tool, the &lt;server&gt;:&lt;tool&gt; form, or the whole server (slug derived from the server’s url/command).'],
            ['afterShellExecution', 'fire-and-forget', 'Audit row tagged runtime_kind=cursor. Command output is scanned via /analyze only when it carries a credential shape (marker-gated, keeps FP rate down).'],
            ['afterMCPExecution', 'fire-and-forget', 'Audit row + unconditional /analyze scan of the MCP result — third-party data is the canonical indirect-prompt-injection surface.'],
            ['afterFileEdit', 'fire-and-forget', 'Audit row (tool id edit, path + edit count). Newly written content is scanned when credential-shaped (agents writing secrets into files).'],
            ['beforeSubmitPrompt', 'fire-and-forget', 'Forwards every prompt to /analyze for jailbreak / injection detection. Observe-only — always continue:true; never blocks your prompt.'],
            ['beforeReadFile', 'fire-and-forget', 'Cursor-only surface: file content is visible BEFORE the model sees it. Credential-shaped content is recorded as a secret exposure; the read is always allowed in v1.'],
            ['sessionStart / stop', 'fire-and-forget', 'Session-boundary markers (__session_start__ / __session_end__) so the Agent Map and Runs bound each session; stderr “Guard inactive” notice when the app is down.'],
        ]));

        // --- Fail-open callout ---
        const failBox = document.createElement('div');
        failBox.style.cssText = 'margin: 12px 0; padding: 12px 14px; border: 1px solid var(--border-default); border-left: 3px solid var(--accent-primary); border-radius: 6px; background: var(--bg-tertiary);';
        const fP = document.createElement('p');
        fP.style.cssText = 'margin: 0; color: var(--text-primary); font-size: 13px; line-height: 1.55;';
        const fStrong = document.createElement('strong'); fStrong.style.color = 'var(--text-primary)'; fStrong.textContent = 'Fail-open on an unreachable app. ';
        fP.appendChild(fStrong);
        fP.appendChild(document.createTextNode('Cursor’s hooks fail open by default (an exit code other than 0/2 lets the action proceed), and every hook in this plugin additionally catches all errors and emits an explicit '));
        fP.appendChild(inline('{"permission":"allow"}'));
        fP.appendChild(document.createTextNode('. When the local app is down, Cursor keeps working — exactly like every other SecureVector harness. All HTTP targets the local app on loopback at '));
        fP.appendChild(inline('http://127.0.0.1:8741'));
        fP.appendChild(document.createTextNode(' (override with '));
        fP.appendChild(inline('SECUREVECTOR_ENGINE_ENDPOINT'));
        fP.appendChild(document.createTextNode('). Note Cursor Hooks are beta (introduced in Cursor 1.7).'));
        failBox.appendChild(fP);
        root.appendChild(failBox);

        // --- Install ---
        root.appendChild(h2('Install'));
        root.appendChild(p('First install and start the SecureVector local app — both install paths depend on it:'));
        root.appendChild(code(`pip install 'securevector-ai-monitor[app]'   # Apache 2.0, no signup\nsecurevector-app --web                       # binds 127.0.0.1:8741`));

        root.appendChild(h3('Option A — via the app UI'));
        root.appendChild(p('Open http://127.0.0.1:8741, click Integrations → Cursor, then click Install Plugin.'));

        root.appendChild(h3('Option B — via CLI'));
        root.appendChild(p('Same operation the UI button performs — runs the install handler in-process; the web server need not be running.'));
        root.appendChild(code('securevector-app --install-plugin cursor'));

        const installNote = document.createElement('p');
        installNote.style.cssText = 'margin: 12px 0 4px 0; color: var(--text-secondary); font-size: 13px;';
        installNote.appendChild(document.createTextNode('Install stages the plugin tree under '));
        installNote.appendChild(inline('~/.securevector/staging/cursor-plugin/'));
        installNote.appendChild(document.createTextNode(', then copies it (a real directory — Cursor doesn’t load symlinked local plugins) to '));
        installNote.appendChild(inline('~/.cursor/plugins/local/securevector-guard/'));
        installNote.appendChild(document.createTextNode(', the location Cursor scans for local plugins. The plugin bundles its nine hooks (the '));
        installNote.appendChild(inline('.cursor-plugin/plugin.json'));
        installNote.appendChild(document.createTextNode(' manifest references '));
        installNote.appendChild(inline('hooks/hooks.json'));
        installNote.appendChild(document.createTextNode('), so one install gives BOTH the Settings → Plugins entry and the active hooks. Reinstall replaces the plugin directory in place. If you upgraded from an earlier build, install also strips the old global-'));
        installNote.appendChild(inline('hooks.json'));
        installNote.appendChild(document.createTextNode(' entries so hooks don’t fire twice (your other entries are preserved, with a one-shot '));
        installNote.appendChild(inline('.before-securevector'));
        installNote.appendChild(document.createTextNode(' backup).'));
        root.appendChild(installNote);

        // --- Activate ---
        root.appendChild(h2('Activate — reload Cursor'));
        const act = document.createElement('div');
        act.style.cssText = 'margin: 8px 0; padding: 12px 14px; border: 1px solid var(--border-default); border-left: 3px solid var(--accent-primary); border-radius: 6px; background: var(--bg-tertiary);';
        const aP = document.createElement('p');
        aP.style.cssText = 'margin: 0; color: var(--text-primary); font-size: 13px; line-height: 1.55;';
        aP.appendChild(document.createTextNode('Cursor discovers local plugins and reads hooks at startup, so '));
        const aStrong = document.createElement('strong'); aStrong.style.color = 'var(--text-primary)'; aStrong.textContent = 'reload Cursor';
        aP.appendChild(aStrong);
        aP.appendChild(document.createTextNode(' after installing (Cmd+Shift+P → "Developer: Reload Window", or restart the app). It then appears under Settings → Plugins (as securevector-guard) and its hooks show under Settings → Hooks; the next agent session picks them up automatically.'));
        act.appendChild(aP);
        root.appendChild(act);

        // --- Verify ---
        // --- Remote engine (Terraform / self-host) ---
        root.appendChild(h2('Pointing at a remote engine (Terraform / your own cloud)'));
        root.appendChild(p('Running the engine in your own cloud (the SecureVector Terraform modules) instead of locally? Install the plugin the same way, then point its hooks at your deployment’s endpoint URL — no local app needed.'));
        root.appendChild(code(`# install the plugin (hooks only; the engine runs remotely)
securevector-app --install-plugin cursor

# point the hooks at your engine endpoint (the URL from \`terraform output\`)
export SECUREVECTOR_ENGINE_ENDPOINT=https://<your-engine-endpoint>`));
        root.appendChild(note('Engine, not cloud.', 'SECUREVECTOR_ENGINE_ENDPOINT is the engine the hooks call for analysis — your local app OR your self-host / Terraform engine. It is NOT the SecureVector cloud (scan.securevector.io). Legacy SV_BASE_URL / SECUREVECTOR_URL still work as fallbacks.'));
        root.appendChild(p('Auth is optional. A private (in-VPC) endpoint needs no credential — the default and least friction. Only if you expose the endpoint publicly and gate it (Terraform ingress_token — enforced by a v4.9.0+ engine; older images set but ignore it) do you set a key; use a free SecureVector account key or an SVET token — it gates inbound access only and forwards no data:'));
        root.appendChild(code(`export SECUREVECTOR_API_KEY=<SecureVector account key or SVET token>   # optional — public gated endpoint only`));

        root.appendChild(h2('Verify it works'));
        root.appendChild(p('1. Plugin status from the local app:'));
        root.appendChild(code('curl -s http://127.0.0.1:8741/api/hooks/cursor/status | python3 -m json.tool'));
        const expectP = document.createElement('p');
        expectP.style.cssText = 'margin: 8px 0; color: var(--text-secondary);';
        expectP.appendChild(document.createTextNode('Expect '));
        expectP.appendChild(inline('"auto_installed": true'));
        expectP.appendChild(document.createTextNode(' and '));
        expectP.appendChild(inline('"enabled": true'));
        expectP.appendChild(document.createTextNode('. You can also confirm the entries exist: '));
        expectP.appendChild(inline('grep securevector-guard ~/.cursor/hooks.json'));
        expectP.appendChild(document.createTextNode('.'));
        root.appendChild(expectP);
        root.appendChild(p('2. Ask the Cursor agent to run any terminal command, then read the most recent audit row:'));
        root.appendChild(code(`curl -s 'http://127.0.0.1:8741/api/tool-permissions/call-audit?limit=1' | python3 -m json.tool\n# Expect runtime_kind="cursor" on the entry.`));
        root.appendChild(p('3. Visit http://127.0.0.1:8741 → Agent Activity. Your Cursor session appears on the Agent Map, in Runs, and on the Timeline.'));

        // --- Governable tools ---
        root.appendChild(h2('What you can govern'));
        root.appendChild(p('Cursor’s enforcement points are event-typed, so the governable built-in surface maps to a small set of synthesized tool ids:'));
        root.appendChild(table(['Tool', 'Risk', 'What it governs'], [
            ['shell', 'admin', 'Every terminal command the agent runs (beforeShellExecution). Block this to cut shell execution entirely.'],
            ['edit', 'write', 'Agent file edits (afterFileEdit — observe/audit only; Cursor exposes no pre-edit block).'],
            ['read', 'read', 'Agent file reads (beforeReadFile — observe/audit only in v1).'],
            ['write, grep, delete, task', 'write / read / admin', 'Documented Cursor agent tools, governable when surfaced via the unified preToolUse event set.'],
        ]));
        const mcpP = document.createElement('p');
        mcpP.style.cssText = 'margin: 8px 0; color: var(--text-secondary);';
        mcpP.appendChild(document.createTextNode('MCP server tools are enforced via beforeMCPExecution. A rule can target the exact tool name, the '));
        mcpP.appendChild(inline('<server>:<tool>'));
        mcpP.appendChild(document.createTextNode(' form, or the server slug (derived from the MCP server’s url/command) to block every tool from that server. MCP results are always threat-scanned for indirect prompt injection.'));
        root.appendChild(mcpP);

        // --- Configuration ---
        root.appendChild(h2('Configuration'));
        root.appendChild(table(['Setting', 'Where', 'Default', 'Purpose'], [
            ['Local app port', 'svconfig.yml server.port, or SV_WEB_PORT', '8741', 'Loopback port the plugin POSTs to'],
            ['Plugin target URL', 'SECUREVECTOR_ENGINE_ENDPOINT env var', 'http://127.0.0.1:8741', 'Override for non-default app deployments'],
            ['Tool permission rules', 'Tool Permissions page in the app', 'Default-allow + last-resort denies', 'Per-tool allow / deny / ask, cloud-syncable, local overrides'],
        ]));
        root.appendChild(p('There is no statusline emitter for Cursor — the equivalent live findings appear on the local SecureVector dashboard (and in the SecureVector editor extension, if installed).'));

        // --- Uninstall ---
        root.appendChild(h2('Uninstall'));
        root.appendChild(p('Via the app UI: Integrations → Cursor → Uninstall. Or via CLI:'));
        root.appendChild(code('securevector-app --uninstall-plugin cursor'));
        root.appendChild(p('Either path removes the plugin directory at ~/.cursor/plugins/local/securevector-guard/ (and tears down any legacy global-hooks.json entries from older builds, preserving every other hook). Reload Cursor to drop the plugin and its hooks.'));

        // --- Possible issues ---
        root.appendChild(h2('Possible issues'));
        root.appendChild(note('Plugin / hooks don’t appear after install', 'reload Cursor — local plugins and hooks are read at startup. Confirm the plugin dir exists with ls ~/.cursor/plugins/local/securevector-guard/.cursor-plugin/plugin.json, check Settings → Plugins (securevector-guard) and Settings → Hooks, and that Cursor is recent enough (Plugins landed in Cursor 2.5; Hooks are beta from 1.7).'));
        root.appendChild(note('"App unreachable" / fail-open silently', 'confirm the local app is running with curl http://127.0.0.1:8741/health (200 OK). When the app is down every decision is allow and no audit row is written — the plugin never breaks the session.'));
        root.appendChild(note('A deny doesn’t block in some Cursor builds', 'Cursor Hooks are beta; community reports exist of ask being ignored or deny not applying in sandboxed-shell paths on specific builds. Verify enforcement with a test deny rule on shell after Cursor updates.'),);
        root.appendChild(note('An MCP tool isn’t blocked by a local override', 'MCP tools are governed by cloud-synced rules (target the tool, <server>:<tool>, or the server slug). Local UI overrides apply to the built-in tool ids; pair with cloud via Settings → Cloud to push MCP rules.'));
        root.appendChild(note('Audit rows show action=allow even with a synced cloud rule', 'check GET /api/tool-permissions/synced-overrides. Total: 0 means the device isn\'t paired with cloud yet — pair via Settings → Cloud.'));

        // --- Privacy ---
        root.appendChild(h2('Privacy posture'));
        root.appendChild(p('All HTTP is loopback. Audit previews are redacted (sk-/pk-, gh[pousr]_, AKIA, Stripe sk_live_/sk_test_, JWT triples, PEM private keys, labelled credential k/v pairs) before any POST; shell output and file content are scanned only when credential-shaped; the audit log stores a hash chain, not raw values. Nothing leaves the device unless cloud sync is explicitly enabled.'));

        // --- Footer ---
        const footer = document.createElement('div');
        footer.style.cssText = 'margin: 32px 0 0 0; padding: 16px 0; border-top: 1px solid var(--border-default); color: var(--text-secondary); font-size: 12px;';
        const lic = document.createElement('div'); lic.textContent = 'License: Apache 2.0.'; footer.appendChild(lic);
        const disc = document.createElement('div'); disc.style.cssText = 'margin-top: 4px;'; disc.textContent = 'Built by SecureVector. Not affiliated with or endorsed by Anysphere. "Cursor" is a product name referenced descriptively to identify the target runtime.'; footer.appendChild(disc);
        root.appendChild(footer);

        container.appendChild(root);
    },
};
