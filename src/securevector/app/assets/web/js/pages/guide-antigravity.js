/**
 * Antigravity Plugin, full setup guide page.
 *
 * Sibling of guide-codex.js and guide-opencode.js for the Antigravity plugin
 * (src/securevector/plugins/antigravity/). Same hand-written DOM + helper
 * pattern; the harness specifics differ because Antigravity documents only
 * three hook events and none of them carries a prompt or a tool result.
 * Keep in sync with the Antigravity install handler in routes/hooks_antigravity.py.
 */
const GuideAntigravityPage = {
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
        h1.textContent = 'Antigravity Plugin';
        header.appendChild(h1);
        const lede = document.createElement('p');
        lede.style.cssText = 'color: var(--text-secondary); margin: 0;';
        lede.textContent = 'Real-time tool-permission enforcement and tamper-evident audit for Antigravity, Google\'s Gemini-lineage agent (CLI binary agy): all on loopback, no LLM proxy in the request path. Audit rows are tagged runtime_kind=antigravity.';
        header.appendChild(lede);
        root.appendChild(header);

        // --- Helpers (mirror guide-claude-code.js) ---
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
        const note = (label, body) => { const el = document.createElement('div'); el.style.cssText = 'margin: 8px 0; color: var(--text-secondary); padding-left: 16px; text-indent: -16px;'; const strong = document.createElement('strong'); strong.style.cssText = 'color: var(--text-primary); font-weight: 600;'; strong.textContent = label + ': '; el.appendChild(strong); el.appendChild(document.createTextNode(body)); return el; };
        const table = (cols, rows) => {
            const t = document.createElement('table'); t.style.cssText = 'width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 13px;';
            t.innerHTML = '<thead><tr>' + cols.map(c => `<th style="text-align:left; padding:8px 10px; border-bottom:2px solid var(--border-default);">${c}</th>`).join('') + '</tr></thead>';
            const tb = document.createElement('tbody');
            rows.forEach(r => { const tr = document.createElement('tr'); tr.innerHTML = r.map((cell, i) => `<td style="padding:8px 10px; border-bottom:1px solid var(--border-default); ${i === 0 ? 'font-family:monospace; font-size:12px;' : 'color:var(--text-secondary);'}">${cell}</td>`).join(''); tb.appendChild(tr); });
            t.appendChild(tb); return t;
        };

        // --- What the plugin does ---
        root.appendChild(h2('What the plugin does'));
        root.appendChild(p('Three hooks register against the Antigravity plugin events documented at antigravity.google/docs/hooks and /docs/plugins. The enforcement logic is the same engine every other SecureVector Guard plugin uses.'));
        root.appendChild(table(['Hook', 'File', 'Description'], [
            ['PreToolUse', 'hooks/pre-tool-use.js', 'Reads toolCall.name and toolCall.args, enforces cloud-synced and local tool-permission rules, and returns {"decision":"allow"|"deny"|"force_ask","reason":"..."}. A deny is audited by this hook itself.'],
            ['PostToolUse', 'hooks/post-tool-use.js', 'Writes an audit row for every call, and sends an outgoing /analyze scan for tool arguments that carry prose. Returns {}.'],
            ['PreInvocation', 'hooks/pre-invocation.js', 'On the first invocation of a session only: writes a reachability notice to stderr and a __session_start__ audit row. Returns {}.'],
        ]));

        const failNote = document.createElement('div');
        failNote.style.cssText = 'margin: 12px 0; padding: 12px 14px; border: 1px solid var(--border-default); border-left: 3px solid var(--accent-primary); border-radius: 6px; background: var(--bg-tertiary);';
        const fP = document.createElement('p');
        fP.style.cssText = 'margin: 0; color: var(--text-primary); font-size: 13px; line-height: 1.55;';
        fP.appendChild(document.createTextNode('SecureVector itself fails open: an unreachable local app never blocks a call. Antigravity\'s own fail mode for a hook that errors or produces malformed output is '));
        const fStrong = document.createElement('strong'); fStrong.style.color = 'var(--text-primary)'; fStrong.textContent = 'not documented first-party';
        fP.appendChild(fStrong);
        fP.appendChild(document.createTextNode('. So every hook in this plugin writes explicit, valid JSON and exits 0 on every path, including its own error paths, which keeps behaviour correct even on a host that turns out to fail closed.'));
        failNote.appendChild(fP);
        root.appendChild(failNote);

        // --- Install ---
        root.appendChild(h2('Install'));
        root.appendChild(p('First install and start the SecureVector local app: both install paths depend on it:'));
        root.appendChild(code(`pip install 'securevector-ai-monitor[app]'   # Apache 2.0, no signup\nsecurevector-app --web                       # binds 127.0.0.1:8741`));

        root.appendChild(h3('Option A: via the app UI'));
        root.appendChild(p('Open http://127.0.0.1:8741, click Integrations → Antigravity, then click Install Plugin.'));

        root.appendChild(h3('Option B: via CLI'));
        root.appendChild(p('Same operation the UI button performs: runs the install handler in-process; the web server need not be running.'));
        root.appendChild(code('securevector-app --install-plugin antigravity'));

        const installNote = document.createElement('p');
        installNote.style.cssText = 'margin: 12px 0 4px 0; color: var(--text-secondary); font-size: 13px;';
        installNote.appendChild(document.createTextNode('Install copies the plugin tree into '));
        installNote.appendChild(inline('~/.gemini/config/plugins/securevector-guard/'));
        installNote.appendChild(document.createTextNode('. Restart Antigravity to activate it, then confirm with:'));
        root.appendChild(installNote);
        root.appendChild(code('agy plugin list'));

        // --- Remote engine ---
        root.appendChild(h2('Pointing at a remote engine (Terraform / your own cloud)'));
        root.appendChild(p('Running the engine in your own cloud (the SecureVector Terraform modules) instead of locally? Install the plugin the same way, then point its hooks at your deployment’s endpoint URL: no local app needed.'));
        root.appendChild(code(`# install the plugin (hooks only; the engine runs remotely)
securevector-app --install-plugin antigravity

# point the hooks at your engine endpoint (the URL from \`terraform output\`)
export SECUREVECTOR_ENGINE_ENDPOINT=https://<your-engine-endpoint>`));
        root.appendChild(note('Engine, not cloud', 'SECUREVECTOR_ENGINE_ENDPOINT (legacy alias SV_BASE_URL) is the engine the hooks call for analysis: your local app OR your self-host / Terraform engine. It is NOT the SecureVector cloud (scan.securevector.io).'));
        root.appendChild(p('Auth is optional. A private (in-VPC) endpoint needs no credential: the default and least friction. Only if you expose the endpoint publicly and gate it do you set a key; SECUREVECTOR_API_KEY is forwarded as a bearer token to a gated remote engine:'));
        root.appendChild(code(`export SECUREVECTOR_API_KEY=<SecureVector account key or SVET token>   # optional: public gated endpoint only`));

        // --- Verify ---
        root.appendChild(h2('Verify it works'));
        root.appendChild(p('1. Plugin status from the local app:'));
        root.appendChild(code('curl -s http://127.0.0.1:8741/api/hooks/antigravity/status | python3 -m json.tool'));
        const expectP = document.createElement('p');
        expectP.style.cssText = 'margin: 8px 0; color: var(--text-secondary);';
        expectP.appendChild(document.createTextNode('Expect '));
        expectP.appendChild(inline('"installed": true'));
        expectP.appendChild(document.createTextNode(' and '));
        expectP.appendChild(inline('"enabled": true'));
        expectP.appendChild(document.createTextNode('.'));
        root.appendChild(expectP);
        root.appendChild(p('2. Run any tool in Antigravity, then check Tool Activity for a row with runtime_kind=antigravity:'));
        root.appendChild(code(`curl -s 'http://127.0.0.1:8741/api/tool-permissions/call-audit?limit=1' | python3 -m json.tool\n# Expect runtime_kind="antigravity" on the entry.`));
        root.appendChild(p('3. Visit http://127.0.0.1:8741 → Observability. Your Antigravity run appears on the Agent Map, in Runs, and on the Timeline.'));

        // --- Governable tools ---
        root.appendChild(h2('Governable tools'));
        root.appendChild(p('Antigravity’s built-in tools, and the risk tier each is governed under:'));
        root.appendChild(table(['Tool', 'Risk', 'What it does'], [
            ['run_command', 'admin', 'Execute a shell command'],
            ['start_subagent', 'admin', 'Invoke a child subagent'],
            ['search_web', 'admin', 'Perform a web search'],
            ['read_url_content', 'admin', 'Fetch URL content'],
            ['generate_image', 'admin', 'Generate or edit images'],
            ['create_file', 'write', 'Create a new file'],
            ['edit_file', 'write', 'Edit an existing file'],
            ['view_file', 'read', 'Read file contents'],
            ['list_directory', 'read', 'List directory contents'],
            ['search_directory', 'read', 'Search within files'],
            ['find_file', 'read', 'Find files by pattern'],
            ['ask_question', 'read', 'Prompt the user for input'],
        ]));
        root.appendChild(note('finish is not governable', 'Antigravity exposes a thirteenth built-in, finish, which returns the agent’s final output. It is deliberately excluded from enforcement: blocking it would leave the session unable to terminate.'));

        root.appendChild(h3('MCP tool names'));
        const mcpP = document.createElement('p');
        mcpP.style.cssText = 'margin: 8px 0; color: var(--text-secondary);';
        mcpP.appendChild(document.createTextNode('Antigravity’s MCP tool-name shape is not documented first-party and is not yet confirmed against a live '));
        mcpP.appendChild(inline('agy'));
        mcpP.appendChild(document.createTextNode(' session. Until it is, the plugin generates candidates for every plausible shape so a rule still matches: '));
        mcpP.appendChild(inline('mcp__server__tool'));
        mcpP.appendChild(document.createTextNode(', '));
        mcpP.appendChild(inline('server__tool'));
        mcpP.appendChild(document.createTextNode(', '));
        mcpP.appendChild(inline('server.tool'));
        mcpP.appendChild(document.createTextNode(', '));
        mcpP.appendChild(inline('server-tool'));
        mcpP.appendChild(document.createTextNode(', and the bare tool name.'));
        root.appendChild(mcpP);

        // --- Known limitations ---
        root.appendChild(h2('Known limitations'));
        root.appendChild(note('No prompt scanning', 'Antigravity exposes no hook event carrying the user’s prompt. PreInvocation carries invocationNum, initialNumSteps, conversationId, workspacePaths, transcriptPath, artifactDirectoryPath, and modelName, and no prompt text.'));
        root.appendChild(note('No tool-result scanning', 'Antigravity’s documented PostToolUse payload is the PreToolUse payload plus an optional error string, and carries no tool result. Indirect-prompt-injection and output-leak detection have no input on this harness; the code path exists and is dormant.'));
        root.appendChild(note('No cost panel yet', 'There is no token-usage or cost panel for this harness yet: Antigravity’s on-disk session log format is undocumented.'));

        // --- Configuration ---
        root.appendChild(h2('Configuration'));
        root.appendChild(table(['Setting', 'Where', 'Default', 'Purpose'], [
            ['Local app port', 'svconfig.yml server.port, or SV_WEB_PORT', '8741', 'Loopback port the plugin POSTs to'],
            ['Plugin target URL', 'SECUREVECTOR_ENGINE_ENDPOINT env var (legacy alias SV_BASE_URL)', 'http://127.0.0.1:8741', 'Override for non-default app deployments'],
            ['Gated remote engine key', 'SECUREVECTOR_API_KEY env var', 'unset', 'Forwarded as a bearer token when the endpoint is a public, gated remote engine'],
            ['Tool permission rules', 'Tool Permissions page in the app', 'Default-allow + last-resort denies', 'Per-tool allow / deny / ask, cloud-syncable, local overrides'],
        ]));

        // --- Uninstall ---
        root.appendChild(h2('Uninstall'));
        root.appendChild(p('Via the app UI: Integrations → Antigravity → Uninstall. Or via CLI:'));
        root.appendChild(code('securevector-app --uninstall-plugin antigravity'));
        root.appendChild(p('Either path removes the plugin directory from ~/.gemini/config/plugins/securevector-guard/. Restart Antigravity to drop the hooks from the session.'));

        // --- Possible issues ---
        root.appendChild(h2('Possible issues'));
        root.appendChild(note('"App unreachable" / fail-open silently', 'confirm the local app is running with curl http://127.0.0.1:8741/health (200 OK). When the app is down every decision is allow and no audit row is written: the plugin never breaks the session.'));
        root.appendChild(note('agy plugin list does not show the plugin', 'restart Antigravity after install; the plugin directory is only read at startup.'));
        root.appendChild(note('An MCP rule does not match', 'the plugin matches against several candidate name shapes because Antigravity’s MCP tool-name format is unconfirmed. Try the bare tool name or the server__tool form if a rule appears to be skipped.'));
        root.appendChild(note('Audit rows show action=allow even with a synced cloud rule', 'check GET /api/tool-permissions/synced-overrides. Total: 0 means the device isn’t paired with cloud yet, pair via Settings → Cloud.'));

        // --- Privacy ---
        root.appendChild(h2('Privacy posture'));
        root.appendChild(p('All HTTP is loopback. No files are written by the hooks beyond the plugin directory itself. Argument previews sent for scanning have secrets redacted client-side before the request leaves the device. The plugin fails open, and the audit log stores a hash chain, not raw values.'));

        // --- Footer ---
        const footer = document.createElement('div');
        footer.style.cssText = 'margin: 32px 0 0 0; padding: 16px 0; border-top: 1px solid var(--border-default); color: var(--text-secondary); font-size: 12px;';
        const lic = document.createElement('div'); lic.textContent = 'License: Apache 2.0.'; footer.appendChild(lic);
        const disc = document.createElement('div'); disc.style.cssText = 'margin-top: 4px;'; disc.textContent = 'Built by SecureVector. Not affiliated with, endorsed by, or sponsored by Google. "Antigravity" and "Gemini" are product names referenced descriptively to identify the target runtime.'; footer.appendChild(disc);
        root.appendChild(footer);

        container.appendChild(root);
    },
};

window.GuideAntigravityPage = GuideAntigravityPage;
