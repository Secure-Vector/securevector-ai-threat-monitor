/**
 * OpenClaw / ClawdBot Plugin — full setup guide page.
 *
 * Sibling of guide-claude-code.js. In-app mirror of docs/OPENCLAW.md.
 * OpenClaw is the one harness with two modes: Monitor (plugin only, zero
 * latency) and Block (plugin + proxy). Keep in sync with docs/OPENCLAW.md
 * and the install handler in routes/hooks.py.
 */
const GuideOpenclawPage = {
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
        h1.textContent = 'OpenClaw / ClawdBot Plugin';
        header.appendChild(h1);
        const lede = document.createElement('p');
        lede.style.cssText = 'color: var(--text-secondary); margin: 0;';
        lede.textContent = 'The SecureVector Guard plugin runs natively inside OpenClaw — scanning prompts, auditing tool calls with full arguments, tracking cost, and logging threats. OpenClaw gets the richest audit because the plugin captures MCP tools (read / exec / write) the proxy never sees. Audit rows are tagged runtime_kind=openclaw.';
        header.appendChild(lede);
        root.appendChild(header);

        // --- Helpers ---
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
            rows.forEach(r => { const tr = document.createElement('tr'); tr.innerHTML = r.map((cell, i) => `<td style="padding:8px 10px; border-bottom:1px solid var(--border-default); ${i === 0 ? 'font-weight:600;' : (i === 1 ? 'font-family:monospace; font-size:12px; color:var(--text-secondary);' : 'color:var(--text-secondary);')}">${cell}</td>`).join(''); tb.appendChild(tr); });
            t.appendChild(tb); return t;
        };

        // --- Two modes ---
        root.appendChild(h2('Two modes'));
        root.appendChild(p('Monitor Mode is the default and adds zero latency on the LLM request path — the plugin observes via OpenClaw\'s hook API and never intercepts traffic. Block Mode layers a proxy on top so threats and unauthorized tool calls can be stopped before they reach the LLM.'));

        // --- What the plugin does ---
        root.appendChild(h2('What the plugin does (Monitor Mode)'));
        root.appendChild(table(['Guard', 'Hook', 'Description'], [
            ['Input Guard', 'message_received', 'Scans user messages for prompt injection, jailbreaks, and social engineering.'],
            ['Tool Audit', 'agent_end', 'Records every tool call with arguments and checks it against permission rules.'],
            ['Output Guard', 'tool_result_persist', 'Inspects tool results for credential leaks and PII.'],
            ['Context Guard', 'before_agent_start', 'Injects security directives into the agent system prompt.'],
            ['Cost Tracker', 'llm_output', 'Records LLM token usage for cost tracking.'],
        ]));

        // --- Install (Monitor) ---
        root.appendChild(h2('Install (Monitor Mode)'));
        root.appendChild(p('Start the local app, install the plugin, then restart the OpenClaw gateway — it loads the plugin automatically.'));
        root.appendChild(code(`# 1. Start SecureVector\nsecurevector-app --web                 # binds 127.0.0.1:8741\n\n# 2. Install the plugin (or use Integrations → OpenClaw → Install in the UI)\ncurl -X POST http://localhost:8741/api/hooks/install\n\n# 3. Restart OpenClaw — the plugin loads automatically\nopenclaw gateway`));

        // --- Block mode ---
        root.appendChild(h2('Block Mode (optional)'));
        root.appendChild(p('Block Mode starts a proxy on port 8742 that intercepts LLM traffic so threats can be actively blocked. The plugin keeps monitoring; the proxy adds blocking. Enable it from the dashboard toggle (or svconfig.yml: block_mode: true), then point OpenClaw at the proxy and restart:'));
        root.appendChild(code(`# Linux / macOS\nexport OPENAI_BASE_URL=http://127.0.0.1:8742/openai/v1\n\n# Windows (PowerShell)\n$env:OPENAI_BASE_URL="http://127.0.0.1:8742/openai/v1"\n\n# then\nopenclaw gateway`));
        root.appendChild(h3('Disabling Block Mode'));
        root.appendChild(p('Unset the env var and restart OpenClaw to connect directly to the provider. The plugin keeps monitoring without the proxy.'));
        root.appendChild(code(`# Linux / macOS\nunset OPENAI_BASE_URL\n\n# Windows (PowerShell)\nRemove-Item Env:\\OPENAI_BASE_URL -ErrorAction SilentlyContinue`));

        // --- Verify ---
        // --- Remote engine (Terraform / self-host) ---
        root.appendChild(h2('Pointing at a remote engine (Terraform / your own cloud)'));
        root.appendChild(p('Running the engine in your own cloud (the SecureVector Terraform modules) instead of locally? Install the plugin the same way, then point its hooks at your deployment’s endpoint URL — no local app needed.'));
        root.appendChild(code(`# install the plugin (hooks only; the engine runs remotely)
curl -X POST https://<your-engine-endpoint>/api/hooks/install

# point the hooks at your engine endpoint (the URL from \`terraform output\`)
export SECUREVECTOR_ENGINE_ENDPOINT=https://<your-engine-endpoint>`));
        root.appendChild(callout('Engine, not cloud.', 'SECUREVECTOR_ENGINE_ENDPOINT is the engine the hooks call for analysis — your local app OR your self-host / Terraform engine. It is NOT the SecureVector cloud (scan.securevector.io). Legacy SV_BASE_URL / SECUREVECTOR_URL still work as fallbacks.'));
        root.appendChild(p('Auth is optional. A private (in-VPC) endpoint needs no credential — the default and least friction. Only if you expose the endpoint publicly and gate it (Terraform ingress_token — enforced by a v4.9.0+ engine; older images set but ignore it) do you set a key; use a free SecureVector account key or an SVET token — it gates inbound access only and forwards no data:'));
        root.appendChild(code(`export SECUREVECTOR_API_KEY=<SecureVector account key or SVET token>   # optional — public gated endpoint only`));

        root.appendChild(h2('Verify it works'));
        root.appendChild(p('1. Plugin status from the local app:'));
        root.appendChild(code('curl -s http://localhost:8741/api/hooks/status | python3 -m json.tool'));
        root.appendChild(p('2. Send a message through your OpenClaw gateway, then check Agent Activity → Tool Activity in the app. Every tool call (read, write, exec, web_search, …) appears as allow, block, or log_only, tagged runtime_kind=openclaw.'));

        // --- Plugin API ---
        root.appendChild(h2('Plugin API'));
        root.appendChild(code(`curl -X POST http://localhost:8741/api/hooks/install                     # Install\ncurl http://localhost:8741/api/hooks/status                               # Status\ncurl -X POST http://localhost:8741/api/hooks/install -d '{"force":true}'  # Reinstall\ncurl -X POST http://localhost:8741/api/hooks/uninstall                    # Uninstall`));

        // --- Manual install ---
        root.appendChild(h2('Manual install'));
        root.appendChild(p('If the Install button doesn\'t work, create the plugin directory and copy the four source files into it:'));
        root.appendChild(code(`# Linux / macOS\nmkdir -p ~/.openclaw/plugins/securevector-guard\n\n# Windows (PowerShell)\nNew-Item -ItemType Directory -Force -Path "$env:APPDATA\\openclaw\\plugins\\securevector-guard"`));
        const fileList = document.createElement('ul');
        fileList.style.cssText = 'margin: 8px 0 8px 18px; color: var(--text-secondary); padding-left: 8px;';
        [['openclaw.plugin.json', 'plugin manifest'], ['package.json', 'plugin metadata'], ['index.ts', 'main entry — runtime guards, fetch-to-SecureVector'], ['config.ts', 'config resolver (env vars + svconfig.yml reads)']].forEach(([f, d]) => {
            const li = document.createElement('li'); li.style.cssText = 'margin: 4px 0;';
            li.appendChild(inline(f)); li.appendChild(document.createTextNode(' — ' + d)); fileList.appendChild(li);
        });
        root.appendChild(fileList);
        root.appendChild(p('Then register and verify:'));
        root.appendChild(code(`openclaw plugins install --link ~/.openclaw/plugins/securevector-guard\nopenclaw plugins list`));
        const whyTwo = document.createElement('div');
        whyTwo.style.cssText = 'margin: 8px 0; padding: 12px 14px; border: 1px solid var(--border-default); border-left: 3px solid var(--accent-primary); border-radius: 6px; background: var(--bg-tertiary); color: var(--text-secondary); font-size: 13px;';
        const whyStrong = document.createElement('strong'); whyStrong.style.color = 'var(--text-primary)'; whyStrong.textContent = 'Why two TypeScript files? ';
        whyTwo.appendChild(whyStrong);
        whyTwo.appendChild(document.createTextNode('OpenClaw\'s plugin scanner flags files that both read process.env and make network requests as a potential credential-harvesting pattern. Splitting config reads into config.ts keeps index.ts network-only, so the plugin loads cleanly.'));
        root.appendChild(whyTwo);

        // --- Possible issues ---
        root.appendChild(h2('Possible issues'));
        root.appendChild(note('Plugin not loaded after install', 'restart the OpenClaw gateway — the plugin is loaded at gateway start. Confirm it appears in openclaw plugins list.'));
        root.appendChild(note('No tool activity showing', 'check curl http://localhost:8741/api/hooks/status returns installed: true, and that the gateway was restarted after install.'));
        root.appendChild(note('Block Mode not blocking', 'confirm OPENAI_BASE_URL points at the proxy (port 8742) and the gateway was restarted with the env var set. The toggle/​svconfig must have block_mode enabled for the proxy to start.'));

        // --- Privacy ---
        root.appendChild(h2('Privacy posture'));
        root.appendChild(p('In Monitor Mode all HTTP is loopback and the plugin never sits in the LLM request path. Prompts are scanned and threats logged locally; the audit log is a SHA-256 hash chain, not raw values. Nothing leaves the device unless cloud sync is explicitly enabled.'));

        // --- Footer ---
        const footer = document.createElement('div');
        footer.style.cssText = 'margin: 32px 0 0 0; padding: 16px 0; border-top: 1px solid var(--border-default); color: var(--text-secondary); font-size: 12px;';
        const lic = document.createElement('div'); lic.textContent = 'License: Apache 2.0.'; footer.appendChild(lic);
        const disc = document.createElement('div'); disc.style.cssText = 'margin-top: 4px;'; disc.textContent = 'Built by SecureVector. "OpenClaw" and "ClawdBot" are referenced descriptively to identify the target runtime.'; footer.appendChild(disc);
        root.appendChild(footer);

        container.appendChild(root);
    },
};
