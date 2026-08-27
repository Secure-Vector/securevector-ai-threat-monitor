/**
 * OpenCode Plugin — full setup guide page.
 *
 * Sibling of guide-codex.js for the OpenCode plugin
 * (src/securevector/plugins/opencode/). Same hand-written DOM + helper
 * pattern; the harness specifics differ more than usual here because
 * OpenCode loads plugins as IN-PROCESS ES modules rather than subprocess
 * hooks: registration is a path in opencode.json's "plugin" array, there
 * is no manifest, and "deny" is a thrown exception. Keep in sync with the
 * OpenCode install handler in routes/hooks_opencode.py.
 */
const GuideOpenCodePage = {
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
        h1.textContent = 'OpenCode Plugin';
        header.appendChild(h1);
        const lede = document.createElement('p');
        lede.style.cssText = 'color: var(--text-secondary); margin: 0;';
        lede.textContent = 'Real-time tool-permission enforcement, tamper-evident audit, and prompt-injection / secret scanning for OpenCode: all on loopback, no LLM proxy in the request path. Audit rows are tagged runtime_kind=opencode.';
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
        root.appendChild(p('Five hooks register against OpenCode plugin events (names verified against the exported Hooks interface in @opencode-ai/plugin 1.18.23). The enforcement and scanning logic is the same engine every other SecureVector Guard plugin uses.'));
        root.appendChild(table(['Hook', 'Mode', 'Description'], [
            ['tool.execute.before', 'blocking; 100&nbsp;ms fail-open', 'Enforces cloud-synced and local tool-permission rules plus the egress policy, on every built-in and MCP tool call. A denial throws, which is OpenCode\'s documented block mechanism; the branded reason reaches the model and a TUI toast.'],
            ['tool.execute.after', 'fire-and-forget', 'Writes the call to the SHA-256 hash-chained audit log tagged runtime_kind=opencode. Scans tool responses (webfetch, websearch, read, every MCP tool, and marker-gated bash output) via /analyze for injection, credential and PII leaks (direction=incoming).'],
            ['chat.message', 'fire-and-forget', 'Forwards every prompt to /analyze for jailbreak / injection detection (direction=outgoing). Secrets are redacted before the POST.'],
            ['permission.ask', 'blocking', 'Collapses OpenCode\'s own approval prompt for a call policy has already denied, so you are not asked to approve something that will be refused.'],
            ['event', 'fire-and-forget', 'Records a session-boundary marker on session.created so the dashboard can bound each run.'],
        ]));
        root.appendChild(p('All hooks fail-open: any error path behaves like "allow" and the plugin never breaks an OpenCode session. All HTTP targets the local app on loopback at http://127.0.0.1:8741 (override with SECUREVECTOR_ENGINE_ENDPOINT; legacy SV_BASE_URL still works).'));

        const failNote = document.createElement('div');
        failNote.style.cssText = 'margin: 12px 0; padding: 12px 14px; border: 1px solid var(--border-default); border-left: 3px solid var(--accent-primary); border-radius: 6px; background: var(--bg-tertiary);';
        const fP = document.createElement('p');
        fP.style.cssText = 'margin: 0; color: var(--text-primary); font-size: 13px; line-height: 1.55;';
        fP.appendChild(document.createTextNode('Why fail-open needs care on OpenCode: blocking a tool call IS throwing from '));
        fP.appendChild(inline('tool.execute.before'));
        fP.appendChild(document.createTextNode(', and OpenCode invokes plugin hooks without catching. So an accidental error would read as a deliberate block and would fail '));
        const fStrong = document.createElement('strong'); fStrong.style.color = 'var(--text-primary)'; fStrong.textContent = 'closed';
        fP.appendChild(fStrong);
        fP.appendChild(document.createTextNode('. Every hook body in this plugin catches all errors; the only exception it ever rethrows is one it constructed after a real policy decision.'));
        failNote.appendChild(fP);
        root.appendChild(failNote);

        // --- Install ---
        root.appendChild(h2('Install'));
        root.appendChild(p('First install and start the SecureVector local app: both install paths depend on it:'));
        root.appendChild(code(`pip install 'securevector-ai-monitor[app]'   # Apache 2.0, no signup\nsecurevector-app --web                       # binds 127.0.0.1:8741`));

        root.appendChild(h3('Option A: via the app UI'));
        root.appendChild(p('Open http://127.0.0.1:8741, click Integrations → OpenCode, then click Install Plugin.'));

        root.appendChild(h3('Option B: via CLI'));
        root.appendChild(p('Same operation the UI button performs: runs the install handler in-process; the web server need not be running.'));
        root.appendChild(code('securevector-app --install-plugin opencode'));

        const installNote = document.createElement('p');
        installNote.style.cssText = 'margin: 12px 0 4px 0; color: var(--text-secondary); font-size: 13px;';
        installNote.appendChild(document.createTextNode('Install stages the plugin tree under '));
        installNote.appendChild(inline('~/.securevector/staging/opencode-plugin/'));
        installNote.appendChild(document.createTextNode(' and appends that absolute path to the '));
        installNote.appendChild(inline('"plugin"'));
        installNote.appendChild(document.createTextNode(' array in '));
        installNote.appendChild(inline('~/.config/opencode/opencode.json'));
        installNote.appendChild(document.createTextNode('. There is no separate host store: OpenCode imports the staged directory in place, so the staged tree IS the installed plugin. Presence in that array is enablement; every other plugin entry and config key is preserved verbatim across reinstalls, and the pristine config is snapshotted once to opencode.json.before-securevector.'));
        root.appendChild(installNote);

        // --- Activate ---
        root.appendChild(h2('Activate'));
        root.appendChild(p('Start a fresh OpenCode session. OpenCode resolves the "plugin" array at launch, so an already-running session will not pick the plugin up. There is no trust prompt to clear and no manifest to approve.'));
        root.appendChild(note('Nothing to accept.', 'Unlike Codex and Copilot CLI, OpenCode does not hash or re-review hook registrations, so the plugin is live on the next launch with no further interaction.'));

        // --- Remote engine ---
        root.appendChild(h2('Pointing at a remote engine (Terraform / your own cloud)'));
        root.appendChild(p('Running the engine in your own cloud (the SecureVector Terraform modules) instead of locally? Install the plugin the same way, then point it at your deployment’s endpoint URL: no local app needed.'));
        root.appendChild(code(`# install the plugin (hooks only; the engine runs remotely)
securevector-app --install-plugin opencode

# point the plugin at your engine endpoint (the URL from \`terraform output\`)
export SECUREVECTOR_ENGINE_ENDPOINT=https://<your-engine-endpoint>`));
        root.appendChild(note('Engine, not cloud.', 'SECUREVECTOR_ENGINE_ENDPOINT is the engine the plugin calls for analysis: your local app OR your self-host / Terraform engine. It is NOT the SecureVector cloud (scan.securevector.io). Legacy SV_BASE_URL / SECUREVECTOR_URL still work as fallbacks.'));
        root.appendChild(p('Auth is optional. A private (in-VPC) endpoint needs no credential: the default and least friction. Only if you expose the endpoint publicly and gate it (Terraform ingress_token: enforced by a v4.9.0+ engine; older images set but ignore it) do you set a key:'));
        root.appendChild(code(`export SECUREVECTOR_API_KEY=<SecureVector account key or SVET token>   # optional: public gated endpoint only`));

        // --- Verify ---
        root.appendChild(h2('Verify it works'));
        root.appendChild(p('1. Plugin status from the local app:'));
        root.appendChild(code('curl -s http://127.0.0.1:8741/api/hooks/opencode/status | python3 -m json.tool'));
        const expectP = document.createElement('p');
        expectP.style.cssText = 'margin: 8px 0; color: var(--text-secondary);';
        expectP.appendChild(document.createTextNode('Expect '));
        expectP.appendChild(inline('"installed": true'));
        expectP.appendChild(document.createTextNode(' and '));
        expectP.appendChild(inline('"enabled": true'));
        expectP.appendChild(document.createTextNode('.'));
        root.appendChild(expectP);
        root.appendChild(p('2. Run any tool in OpenCode (e.g. a shell command), then read the most recent audit row:'));
        root.appendChild(code(`curl -s 'http://127.0.0.1:8741/api/tool-permissions/call-audit?limit=1' | python3 -m json.tool\n# Expect runtime_kind="opencode" on the entry.`));
        root.appendChild(p('3. Visit http://127.0.0.1:8741 → Observability. Your OpenCode run appears on the Agent Map, in Runs, and on the Timeline.'));

        // --- Governable tools ---
        root.appendChild(h2('Governable tools'));
        root.appendChild(p('OpenCode’s built-in tool ids, read from its tool registry at 1.18.23:'));
        root.appendChild(table(['Tool', 'Risk', 'What it does'], [
            ['bash', 'admin', 'Run a shell command'],
            ['read / write / edit / apply_patch', 'read / write', 'Filesystem access and mutation'],
            ['glob / grep', 'read', 'File discovery and content search'],
            ['webfetch / websearch', 'admin', 'Network egress'],
            ['task / skill', 'admin', 'Delegate to a subagent, invoke a skill'],
            ['todowrite / question', 'write / read', 'Session todo list, ask the user'],
            ['lsp / plan_exit / execute', 'varies', 'Only present when their experimental runtime flags are on'],
        ]));
        const bashNote = document.createElement('p');
        bashNote.style.cssText = 'margin: 8px 0; color: var(--text-secondary);';
        const bStrong = document.createElement('strong'); bStrong.style.color = 'var(--text-primary)'; bStrong.textContent = 'The shell tool is named bash, not shell. ';
        bashNote.appendChild(bStrong);
        bashNote.appendChild(document.createTextNode('OpenCode pins the exposed id to "bash" for compatibility with existing plugins and saved permissions, with a note in its own source that this is to be renamed in opencode 2.0. Write your rules against bash and re-check on a major upgrade.'));
        root.appendChild(bashNote);

        root.appendChild(h3('MCP tool names'));
        const mcpP = document.createElement('p');
        mcpP.style.cssText = 'margin: 8px 0; color: var(--text-secondary);';
        mcpP.appendChild(document.createTextNode('OpenCode names an MCP tool '));
        mcpP.appendChild(inline('<server>_<tool>'));
        mcpP.appendChild(document.createTextNode(': joined by a single underscore, with any character outside [A-Za-z0-9_-] replaced by _. There is no mcp prefix of any kind, unlike Claude Code ('));
        mcpP.appendChild(inline('mcp__server__tool'));
        mcpP.appendChild(document.createTextNode(') or GitHub Copilot CLI ('));
        mcpP.appendChild(inline('<server>-<tool>'));
        mcpP.appendChild(document.createTextNode('). A rule can target the literal name, the <server>:<tool> form, the bare tool name, or the server alone to cover all of its tools.'));
        root.appendChild(mcpP);
        root.appendChild(note('Known ambiguity.', 'Because MCP names carry no marker, a server named "apply" exposing a tool named "patch" produces apply_patch, identical to the built-in. SecureVector resolves such a collision to the built-in, which keeps the tool governable under a stable documented id. This is inherent to OpenCode’s naming scheme.'));

        // --- Configuration ---
        root.appendChild(h2('Configuration'));
        root.appendChild(table(['Setting', 'Where', 'Default', 'Purpose'], [
            ['Local app port', 'svconfig.yml server.port, or SV_WEB_PORT', '8741', 'Loopback port the plugin POSTs to'],
            ['Plugin target URL', 'SECUREVECTOR_ENGINE_ENDPOINT env var', 'http://127.0.0.1:8741', 'Override for non-default app deployments'],
            ['Tool permission rules', 'Tool Permissions page in the app', 'Default-allow + last-resort denies', 'Per-tool allow / deny / ask, cloud-syncable, local overrides'],
        ]));
        root.appendChild(p('There is no statusline emitter for OpenCode: its TUI exposes no persistent plugin-rendered status region. Blocked calls surface as a TUI toast instead, and the live findings appear on the local SecureVector dashboard.'));

        // --- Uninstall ---
        root.appendChild(h2('Uninstall'));
        root.appendChild(p('Via the app UI: Integrations → OpenCode → Uninstall. Or via CLI:'));
        root.appendChild(code('securevector-app --uninstall-plugin opencode'));
        root.appendChild(p('Either path removes the staged tree and drops the entry from the "plugin" array in ~/.config/opencode/opencode.json. Other plugins and config are preserved. Restart OpenCode to drop the plugin from the session.'));

        // --- Possible issues ---
        root.appendChild(h2('Possible issues'));
        root.appendChild(note('Plugin does not load', 'OpenCode resolves the "plugin" array at launch: start a fresh session. Confirm the path is listed with cat ~/.config/opencode/opencode.json, and that the staged directory still contains package.json (OpenCode resolves a directory target through it).'));
        root.appendChild(note('"App unreachable" / fail-open silently', 'confirm the local app is running with curl http://127.0.0.1:8741/health (200 OK). When the app is down every decision is allow and no audit row is written: the plugin never breaks the session. The plugin prints a one-line INACTIVE notice on load in that state.'));
        root.appendChild(note('A rule on "shell" does nothing', 'OpenCode’s shell tool is exposed as bash. Target bash instead.'));
        root.appendChild(note('Audit rows show action=allow even with a synced cloud rule', 'check GET /api/tool-permissions/synced-overrides. Total: 0 means the device isn\'t paired with cloud yet, pair via Settings → Cloud.'));

        // --- Privacy ---
        root.appendChild(h2('Privacy posture'));
        root.appendChild(p('All HTTP is loopback. Prompts and argument previews are redacted (sk-/pk-, gh[pousr]_, AKIA, Stripe keys, JWT triples, PEM blocks, labelled credential k/v pairs) before scanning; the audit log stores a hash chain, not raw values. Nothing leaves the device unless cloud sync is explicitly enabled.'));

        // --- Footer ---
        const footer = document.createElement('div');
        footer.style.cssText = 'margin: 32px 0 0 0; padding: 16px 0; border-top: 1px solid var(--border-default); color: var(--text-secondary); font-size: 12px;';
        const lic = document.createElement('div'); lic.textContent = 'License: Apache 2.0.'; footer.appendChild(lic);
        const disc = document.createElement('div'); disc.style.cssText = 'margin-top: 4px;'; disc.textContent = 'Built by SecureVector. Not affiliated with, endorsed by, or sponsored by the OpenCode project or its maintainers. "OpenCode" is used nominatively, solely to identify the target runtime.'; footer.appendChild(disc);
        root.appendChild(footer);

        container.appendChild(root);
    },
};

window.GuideOpenCodePage = GuideOpenCodePage;
