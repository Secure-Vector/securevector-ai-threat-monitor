/**
 * Codex Plugin — full setup guide page.
 *
 * Sibling of guide-claude-code.js for the OpenAI Codex CLI plugin
 * (src/securevector/plugins/codex/). Same hand-written DOM + helper
 * pattern; only the harness specifics differ (config.toml registration,
 * the "Trust all" re-review step, no statusline emitter). Keep in sync
 * with the Codex install handler in routes/hooks_codex.py.
 */
const GuideCodexPage = {
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
        h1.textContent = 'Codex Plugin';
        header.appendChild(h1);
        const lede = document.createElement('p');
        lede.style.cssText = 'color: var(--text-secondary); margin: 0;';
        lede.textContent = 'Real-time tool-permission enforcement, tamper-evident audit, and prompt-injection / secret scanning for the OpenAI Codex CLI — all on loopback, no LLM proxy in the request path. Audit rows are tagged runtime_kind=codex.';
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
        root.appendChild(p('Five hooks register against Codex events (schema confirmed 1:1 with Claude Code against codex-cli 0.133.0). The enforcement and scanning logic is the same engine the Claude Code plugin uses.'));
        root.appendChild(table(['Hook', 'Mode', 'Description'], [
            ['PreToolUse', 'blocking; 100&nbsp;ms fail-open', 'Enforces cloud-synced and local tool-permission rules. Returns allow / deny / ask with a reason that propagates to the audit row.'],
            ['PostToolUse', 'fire-and-forget', 'Writes the call to the SHA-256 hash-chained audit log tagged runtime_kind=codex. Scans tool responses — including Bash / PowerShell stdout+stderr — via /analyze for injection, credential and PII leaks (direction=incoming).'],
            ['UserPromptSubmit', 'fire-and-forget', 'Forwards every prompt to /analyze for jailbreak / injection detection (direction=outgoing). Secrets are redacted before the POST.'],
            ['SessionStart', 'fire-and-forget', 'Records a session-boundary marker so the dashboard can bound each run.'],
            ['Stop', 'fire-and-forget', 'Records the session-end boundary marker.'],
        ]));
        root.appendChild(p('All hooks fail-open: any error path behaves like "allow" and the plugin never breaks a Codex session. All HTTP targets the local app on loopback at http://127.0.0.1:8741 (override with SECUREVECTOR_ENGINE_ENDPOINT; legacy SV_BASE_URL still works).'));

        // --- Install ---
        root.appendChild(h2('Install'));
        root.appendChild(p('First install and start the SecureVector local app — both install paths depend on it:'));
        root.appendChild(code(`pip install 'securevector-ai-monitor[app]'   # Apache 2.0, no signup\nsecurevector-app --web                       # binds 127.0.0.1:8741`));

        root.appendChild(h3('Option A — via the app UI'));
        root.appendChild(p('Open http://127.0.0.1:8741, click Integrations → Codex, then click Install Plugin.'));

        root.appendChild(h3('Option B — via CLI'));
        root.appendChild(p('Same operation the UI button performs — runs the install handler in-process; the web server need not be running.'));
        root.appendChild(code('securevector-app --install-plugin codex'));

        const installNote = document.createElement('p');
        installNote.style.cssText = 'margin: 12px 0 4px 0; color: var(--text-secondary); font-size: 13px;';
        installNote.appendChild(document.createTextNode('Install stages the plugin tree under '));
        installNote.appendChild(inline('~/.securevector/staging/codex-plugin/'));
        installNote.appendChild(document.createTextNode(', copies it into '));
        installNote.appendChild(inline('~/.codex/plugins/cache/securevector-local/securevector-guard/<version>/'));
        installNote.appendChild(document.createTextNode(', and registers two TOML sections in '));
        installNote.appendChild(inline('~/.codex/config.toml'));
        installNote.appendChild(document.createTextNode(' — '));
        installNote.appendChild(inline('[marketplaces.securevector-local]'));
        installNote.appendChild(document.createTextNode(' and '));
        installNote.appendChild(inline('[plugins."securevector-guard@securevector-local"]'));
        installNote.appendChild(document.createTextNode('. Every other TOML section, comment, and formatting choice is preserved verbatim across reinstalls.'));
        root.appendChild(installNote);

        // --- Activate / trust ---
        root.appendChild(h2('Activate — review the hooks'));
        const trust = document.createElement('div');
        trust.style.cssText = 'margin: 8px 0; padding: 12px 14px; border: 1px solid var(--border-default); border-left: 3px solid var(--accent-primary); border-radius: 6px; background: var(--bg-tertiary);';
        const tP = document.createElement('p');
        tP.style.cssText = 'margin: 0; color: var(--text-primary); font-size: 13px; line-height: 1.55;';
        tP.appendChild(document.createTextNode('Codex hashes each hook registration and persists it under '));
        tP.appendChild(inline('[hooks.state]'));
        tP.appendChild(document.createTextNode(' in '));
        tP.appendChild(inline('~/.codex/config.toml'));
        tP.appendChild(document.createTextNode(' once you accept the trust prompt. Start a '));
        const tStrong = document.createElement('strong'); tStrong.style.color = 'var(--text-primary)'; tStrong.textContent = 'fresh Codex session';
        tP.appendChild(tStrong);
        tP.appendChild(document.createTextNode(' — the TUI shows a "Review hooks" prompt automatically — and choose '));
        const tStrong2 = document.createElement('strong'); tStrong2.style.color = 'var(--text-primary)'; tStrong2.textContent = '"Trust all and continue."';
        tP.appendChild(tStrong2);
        tP.appendChild(document.createTextNode(' Until you do, newly-registered hooks are marked "Modified" and silently skipped. This is expected Codex security behaviour, not a SecureVector bug.'));
        trust.appendChild(tP);
        root.appendChild(trust);

        // --- Verify ---
        // --- Remote engine (Terraform / self-host) ---
        root.appendChild(h2('Pointing at a remote engine (Terraform / your own cloud)'));
        root.appendChild(p('Running the engine in your own cloud (the SecureVector Terraform modules) instead of locally? Install the plugin the same way, then point its hooks at your deployment’s endpoint URL — no local app needed.'));
        root.appendChild(code(`# install the plugin (hooks only; the engine runs remotely)
securevector-app --install-plugin codex

# point the hooks at your engine endpoint (the URL from \`terraform output\`)
export SECUREVECTOR_ENGINE_ENDPOINT=https://<your-engine-endpoint>`));
        root.appendChild(note('Engine, not cloud.', 'SECUREVECTOR_ENGINE_ENDPOINT is the engine the hooks call for analysis — your local app OR your self-host / Terraform engine. It is NOT the SecureVector cloud (scan.securevector.io). Legacy SV_BASE_URL / SECUREVECTOR_URL still work as fallbacks.'));
        root.appendChild(p('Auth is optional. A private (in-VPC) endpoint needs no credential — the default and least friction. Only if you expose the endpoint publicly and gate it (Terraform ingress_token — enforced by a v4.9.0+ engine; older images set but ignore it) do you set a key; use a free SecureVector account key or an SVET token — it gates inbound access only and forwards no data:'));
        root.appendChild(code(`export SECUREVECTOR_API_KEY=<SecureVector account key or SVET token>   # optional — public gated endpoint only`));

        root.appendChild(h2('Verify it works'));
        root.appendChild(p('1. Plugin status from the local app:'));
        root.appendChild(code('curl -s http://127.0.0.1:8741/api/hooks/codex/status | python3 -m json.tool'));
        const expectP = document.createElement('p');
        expectP.style.cssText = 'margin: 8px 0; color: var(--text-secondary);';
        expectP.appendChild(document.createTextNode('Expect '));
        expectP.appendChild(inline('"installed": true'));
        expectP.appendChild(document.createTextNode(' and '));
        expectP.appendChild(inline('"enabled": true'));
        expectP.appendChild(document.createTextNode('.'));
        root.appendChild(expectP);
        root.appendChild(p('2. Run any tool in Codex (e.g. a shell command), then read the most recent audit row:'));
        root.appendChild(code(`curl -s 'http://127.0.0.1:8741/api/tool-permissions/call-audit?limit=1' | python3 -m json.tool\n# Expect runtime_kind="codex" on the entry.`));
        root.appendChild(p('3. Visit http://127.0.0.1:8741 → Observability. Your Codex run appears on the Agent Map, in Runs, and on the Timeline.'));

        // --- Configuration ---
        root.appendChild(h2('Configuration'));
        root.appendChild(table(['Setting', 'Where', 'Default', 'Purpose'], [
            ['Local app port', 'svconfig.yml server.port, or SV_WEB_PORT', '8741', 'Loopback port the plugin POSTs to'],
            ['Plugin target URL', 'SECUREVECTOR_ENGINE_ENDPOINT env var', 'http://127.0.0.1:8741', 'Override for non-default app deployments'],
            ['Tool permission rules', 'Tool Permissions page in the app', 'Default-allow + last-resort denies', 'Per-tool allow / deny / ask, cloud-syncable, local overrides'],
        ]));
        const noSl = p('There is no statusline emitter for Codex — its statusline selects from built-in items only and exposes no plugin hook for rendering. The equivalent live findings appear on the local SecureVector dashboard instead.');
        root.appendChild(noSl);

        // --- Uninstall ---
        root.appendChild(h2('Uninstall'));
        root.appendChild(p('Via the app UI: Integrations → Codex → Uninstall. Or via CLI:'));
        root.appendChild(code('securevector-app --uninstall-plugin codex'));
        root.appendChild(p('Either path removes the cache dir and both TOML sections from ~/.codex/config.toml. Other config is preserved. Restart Codex to drop the hooks from the session.'));

        // --- Possible issues ---
        root.appendChild(h2('Possible issues'));
        root.appendChild(note('Hooks show as "Modified" and never fire', 'start a fresh Codex session and choose "Trust all and continue" at the Review hooks prompt — Codex skips hooks whose hash isn\'t in its trust state.'));
        root.appendChild(note('"App unreachable" / fail-open silently', 'confirm the local app is running with curl http://127.0.0.1:8741/health (200 OK). When the app is down every decision is allow and no audit row is written — the plugin never breaks the session.'));
        root.appendChild(note('No statusline in Codex', 'expected — Codex has no plugin hook for statusline rendering. Use the dashboard for live counts.'));
        root.appendChild(note('Audit rows show action=allow even with a synced cloud rule', 'check GET /api/tool-permissions/synced-overrides. Total: 0 means the device isn\'t paired with cloud yet — pair via Settings → Cloud.'));

        // --- Privacy ---
        root.appendChild(h2('Privacy posture'));
        root.appendChild(p('All HTTP is loopback. Prompts are redacted (sk-/pk-, gh[pousr]_, AKIA, JWT triples, labelled credential k/v pairs) before scanning; the audit log stores a hash chain, not raw values. Nothing leaves the device unless cloud sync is explicitly enabled.'));

        // --- Footer ---
        const footer = document.createElement('div');
        footer.style.cssText = 'margin: 32px 0 0 0; padding: 16px 0; border-top: 1px solid var(--border-default); color: var(--text-secondary); font-size: 12px;';
        const lic = document.createElement('div'); lic.textContent = 'License: Apache 2.0.'; footer.appendChild(lic);
        const disc = document.createElement('div'); disc.style.cssText = 'margin-top: 4px;'; disc.textContent = 'Built by SecureVector. Not affiliated with or endorsed by OpenAI. "Codex" is a product name referenced descriptively to identify the target runtime.'; footer.appendChild(disc);
        root.appendChild(footer);

        container.appendChild(root);
    },
};
