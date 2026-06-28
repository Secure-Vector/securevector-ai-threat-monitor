/**
 * Connect Your Agents — the single "start here" page that routes every persona
 * to the right integration path, whether they run the local app or deployed the
 * engine to their own cloud with the Terraform modules.
 *
 * Two routes, mutually exclusive by how you run your agents:
 *   Route A — Framework SDKs (LangChain / LangGraph / CrewAI)  → guide-frameworks
 *   Route B — Coding-agent plugins (Claude Code / Codex / Copilot CLI / Cursor /
 *             OpenClaw)                                         → guide-<harness>
 *
 * This page is intentionally an OVERVIEW + decision aid: it states the one thing
 * common to every integration (the engine endpoint), splits into the two routes,
 * and links out to the per-integration guide that already carries the full
 * step-by-step. The header "Connect Agents" button and the first-run welcome
 * both deep-link here via GuideConnectAgentsPage.scrollTo = 'route-frameworks'
 * | 'route-plugins'.
 *
 * Keep the engine-endpoint copy in lockstep with guide-frameworks.js and the
 * per-harness guides (SECUREVECTOR_ENGINE_ENDPOINT, --no-deps, ingress_token
 * enforced from engine v4.9.0+).
 */
const GuideConnectAgentsPage = {
    // Set by callers (header chooser / welcome modal) to deep-link to a route.
    scrollTo: null,

    async render(container) {
        container.textContent = '';

        const root = document.createElement('div');
        root.style.cssText = 'max-width: 920px; margin: 0 auto; padding: 24px 32px; font-size: 14px; line-height: 1.6; color: var(--text-primary);';

        // --- Header ---
        const header = document.createElement('div');
        header.style.cssText = 'margin-bottom: 28px;';
        const eyebrow = document.createElement('div');
        eyebrow.style.cssText = 'font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: var(--accent-primary); margin-bottom: 6px;';
        eyebrow.textContent = 'Start here';
        header.appendChild(eyebrow);
        const h1 = document.createElement('h1');
        h1.style.cssText = 'font-size: 28px; font-weight: 700; margin: 0 0 8px 0; color: var(--text-primary);';
        h1.textContent = 'Connect Your Agents';
        header.appendChild(h1);
        const lede = document.createElement('p');
        lede.style.cssText = 'color: var(--text-secondary); margin: 0;';
        lede.textContent = 'You have the engine running — now point your existing agents at it. There are two routes depending on how you build your agents. Pick one below; each links to the full step-by-step. Works the same whether this is the local app or an engine you deployed to your own cloud with the SecureVector Terraform modules.';
        header.appendChild(lede);
        root.appendChild(header);

        // --- Helpers (mirror guide-frameworks.js) ---
        const h2 = (text) => { const el = document.createElement('h2'); el.style.cssText = 'font-size: 18px; font-weight: 700; margin: 28px 0 10px 0; color: var(--text-primary); border-bottom: 1px solid var(--border-default); padding-bottom: 6px;'; el.textContent = text; return el; };
        const h3 = (text) => { const el = document.createElement('h3'); el.style.cssText = 'font-size: 14px; font-weight: 700; margin: 18px 0 6px 0; color: var(--text-primary);'; el.textContent = text; return el; };
        const p = (text) => { const el = document.createElement('p'); el.style.cssText = 'margin: 8px 0; color: var(--text-secondary);'; el.textContent = text; return el; };
        const code = (text) => {
            const wrap = document.createElement('div'); wrap.style.cssText = 'position: relative; margin: 8px 0;';
            const pre = document.createElement('pre'); pre.style.cssText = 'padding: 12px 14px; background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 6px; font-family: monospace; font-size: 12px; user-select: all; overflow-x: auto; margin: 0; white-space: pre; color: var(--text-primary);'; pre.textContent = text; wrap.appendChild(pre);
            const copyBtn = document.createElement('button'); copyBtn.type = 'button'; copyBtn.setAttribute('aria-label', 'Copy code to clipboard'); copyBtn.style.cssText = 'position: absolute; top: 6px; right: 6px; padding: 4px 10px; font-size: 11px; background: var(--bg-secondary); border: 1px solid var(--border-default); border-radius: 4px; color: var(--text-secondary); cursor: pointer;'; copyBtn.textContent = 'Copy';
            copyBtn.onclick = async () => { try { await navigator.clipboard.writeText(text); copyBtn.textContent = 'Copied'; setTimeout(() => copyBtn.textContent = 'Copy', 1200); } catch { copyBtn.textContent = 'Copy failed'; } };
            wrap.appendChild(copyBtn); return wrap;
        };
        const table = (cols, rows) => {
            const t = document.createElement('table'); t.style.cssText = 'width: 100%; border-collapse: collapse; margin: 0; font-size: 13px;';
            t.innerHTML = '<thead><tr>' + cols.map(c => `<th style="text-align:left; padding:8px 10px; border-bottom:2px solid var(--border-default); white-space:nowrap;">${c}</th>`).join('') + '</tr></thead>';
            const tb = document.createElement('tbody');
            rows.forEach(r => { const tr = document.createElement('tr'); tr.innerHTML = r.map((cell, i) => `<td style="padding:8px 10px; border-bottom:1px solid var(--border-default); ${i === 0 ? 'font-weight:600;' : 'color:var(--text-secondary);'}">${cell}</td>`).join(''); tb.appendChild(tr); });
            t.appendChild(tb);
            // Wrap in a horizontally-scrollable box so a wide table (long URLs /
            // code chips) scrolls within its own bounds on narrow screens
            // instead of overflowing and forcing the whole page to scroll.
            const wrap = document.createElement('div');
            wrap.style.cssText = 'margin: 8px 0; overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%;';
            wrap.appendChild(t);
            return wrap;
        };
        const callout = (label, body) => {
            const el = document.createElement('div');
            el.style.cssText = 'margin: 12px 0; padding: 12px 14px; border: 1px solid var(--border-default); border-left: 3px solid var(--accent-primary); border-radius: 6px; background: var(--bg-tertiary);';
            const ip = document.createElement('p'); ip.style.cssText = 'margin: 0; color: var(--text-primary); font-size: 13px; line-height: 1.55;';
            const strong = document.createElement('strong'); strong.style.color = 'var(--text-primary)'; strong.textContent = label + ' ';
            ip.appendChild(strong); ip.appendChild(document.createTextNode(body)); el.appendChild(ip); return el;
        };
        // Route card: a big clickable tile linking to a guide page.
        const routeCard = (badge, title, blurb, ctaLabel, targetPage) => {
            const card = document.createElement('button');
            card.type = 'button';
            card.style.cssText = 'display: block; width: 100%; text-align: left; background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 10px; padding: 18px 20px; margin: 12px 0; cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s; color: var(--text-primary);';
            card.onmouseenter = () => { card.style.borderColor = 'var(--accent-primary)'; card.style.boxShadow = '0 2px 12px rgba(0,0,0,0.08)'; };
            card.onmouseleave = () => { card.style.borderColor = 'var(--border-default)'; card.style.boxShadow = 'none'; };
            const b = document.createElement('div'); b.style.cssText = 'display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: var(--accent-primary); background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 4px; padding: 2px 8px; margin-bottom: 8px;'; b.textContent = badge; card.appendChild(b);
            const t = document.createElement('div'); t.style.cssText = 'font-size: 16px; font-weight: 700; margin-bottom: 4px;'; t.textContent = title; card.appendChild(t);
            const desc = document.createElement('div'); desc.style.cssText = 'font-size: 13px; color: var(--text-secondary); margin-bottom: 10px; line-height: 1.5;'; desc.textContent = blurb; card.appendChild(desc);
            const cta = document.createElement('span'); cta.style.cssText = 'font-size: 13px; font-weight: 600; color: var(--accent-primary);'; cta.textContent = ctaLabel + ' →'; card.appendChild(cta);
            card.onclick = () => { if (window.Sidebar) Sidebar.navigate(targetPage); };
            return card;
        };

        // --- The one common thing: the engine endpoint ---
        root.appendChild(h2('First: where is your engine?'));
        root.appendChild(p('Every integration sends tool calls and prompts to one place — your SecureVector engine — for analysis. Everything else is the same; only the endpoint URL changes with how you run it:'));
        // Inline-code chip style so code fragments inside table cells match the
        // app's code-block design language instead of rendering as bare text.
        const ic = 'background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 4px; padding: 1px 5px; font-family: monospace; font-size: 12px; color: var(--text-primary);';
        root.appendChild(table(['You run…', 'Engine endpoint', 'Auth'], [
            ['The local app on this machine', `<code style="${ic}">http://127.0.0.1:8741</code> — the default, nothing to set`, 'None (loopback)'],
            ['A self-host engine via Terraform / your own cloud', `The URL from <code style="${ic}">terraform output</code> — set <code style="${ic}">SECUREVECTOR_ENGINE_ENDPOINT</code>`, 'None if private; a key only if you expose it publicly'],
        ]));
        root.appendChild(callout('Engine, not cloud.', 'SECUREVECTOR_ENGINE_ENDPOINT is where your agents send calls for analysis — your local app OR your Terraform/self-host engine. It is NOT the SecureVector cloud (scan.securevector.io). Your prompt and tool content stay within whatever you point this at.'));

        // --- Which route? ---
        root.appendChild(h2('Which route?'));
        root.appendChild(p('Pick by how you build your agents. You can use both — SDKs for framework agents, plugins for coding agents — and they all report into the same dashboard.'));
        root.appendChild(table(['If your agents are…', 'Use', 'Route'], [
            ['Built on LangChain, LangGraph, or CrewAI', 'The framework SDK (one import)', 'Route A below'],
            ['Coding agents — Claude Code, Codex, GitHub Copilot CLI, Cursor, OpenClaw', 'The native Guard plugin', 'Route B below'],
            ['n8n / Dify / Ollama / anything HTTP', 'The proxy or node — point it at the endpoint URL', 'See Integrations'],
        ]));

        // --- Route A: Framework SDKs ---
        const anchorA = document.createElement('div'); anchorA.id = 'route-frameworks'; anchorA.style.cssText = 'position: relative; top: -80px;'; root.appendChild(anchorA);
        root.appendChild(h2('Route A — Framework SDKs (LangChain · LangGraph · CrewAI)'));
        root.appendChild(p('One import brings tool-call permissions, secret/data-leak detection, and threat detection to every tool your agent calls. Install the SDK for your framework — each one also installs the local app, so a single command gives you the adapter and the engine.'));
        root.appendChild(code('pip install securevector-sdk-langchain     # or -langgraph, or -crewai'));
        root.appendChild(h3('Already have an engine (Terraform / your own cloud)?'));
        root.appendChild(p('Your environment already has the framework, and the engine lives elsewhere — so install the adapter only (--no-deps) and point it at your deployment’s endpoint:'));
        root.appendChild(code(`# adapter only — skip the bundled app
pip install securevector-sdk-langchain --no-deps     # or -langgraph / -crewai

# point at your engine endpoint (the URL from \`terraform output\`)
export SECUREVECTOR_ENGINE_ENDPOINT=https://<your-engine-endpoint>`));
        root.appendChild(routeCard('Route A', 'Framework SDK setup', 'Full step-by-step: install, wrap your agent with the middleware, and verify calls land on the Agent Map — for LangChain, LangGraph, and CrewAI.', 'Open the Framework SDK guide', 'guide-frameworks'));

        // --- Route B: Plugins ---
        const anchorB = document.createElement('div'); anchorB.id = 'route-plugins'; anchorB.style.cssText = 'position: relative; top: -80px;'; root.appendChild(anchorB);
        root.appendChild(h2('Route B — Coding-agent plugins'));
        root.appendChild(p('Native Guard plugins hook your coding agent directly — enforcing tool permissions and writing every call to the tamper-evident audit chain. Install the app, then register the plugin for your harness:'));
        root.appendChild(code(`pip install 'securevector-ai-monitor[app]'
securevector-app --web                     # binds 127.0.0.1:8741
securevector-app --install-plugin codex    # or claude-code / copilot-cli / cursor / openclaw`));
        root.appendChild(p('Pick your coding agent for the full setup (hooks, activation, verification, and uninstall):'));
        const pluginGrid = document.createElement('div');
        pluginGrid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; margin: 12px 0;';
        [
            ['Claude Code', 'guide-claude-code'],
            ['Codex', 'guide-codex'],
            ['GitHub Copilot CLI', 'guide-copilot-cli'],
            ['Cursor', 'guide-cursor'],
            ['OpenClaw / ClawdBot', 'guide-openclaw'],
        ].forEach(([label, page]) => {
            const b = document.createElement('button'); b.type = 'button';
            b.style.cssText = 'text-align: left; background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 8px; padding: 12px 14px; cursor: pointer; color: var(--text-primary); font-size: 13px; font-weight: 600; transition: border-color 0.15s;';
            b.onmouseenter = () => { b.style.borderColor = 'var(--accent-primary)'; };
            b.onmouseleave = () => { b.style.borderColor = 'var(--border-default)'; };
            b.textContent = label;
            const arrow = document.createElement('span'); arrow.style.cssText = 'float: right; color: var(--accent-primary);'; arrow.textContent = '→'; b.appendChild(arrow);
            b.onclick = () => { if (window.Sidebar) Sidebar.navigate(page); };
            pluginGrid.appendChild(b);
        });
        root.appendChild(pluginGrid);
        root.appendChild(h3('Already have an engine (Terraform / your own cloud)?'));
        root.appendChild(p('The plugins run wherever your coding agent runs, and talk to the engine over HTTP. Point them at your deployment with the same variable, then activate as usual:'));
        root.appendChild(code('export SECUREVECTOR_ENGINE_ENDPOINT=https://<your-engine-endpoint>'));

        // --- Auth (shared) ---
        root.appendChild(h2('Auth — only if your endpoint is public'));
        root.appendChild(p('A private (in-VPC) engine needs no credential — that’s the default and the least friction. Only if you expose the endpoint publicly and gate it (Terraform ingress_token — enforced by a v4.9.0+ engine; older images set but ignore it) do you set a key. Use a free SecureVector account key or an SVET token — it gates inbound access only and forwards no data:'));
        root.appendChild(code('export SECUREVECTOR_API_KEY=<SecureVector account key or SVET token>   # optional — public gated endpoint only'));
        root.appendChild(callout('Local app users: ignore this.', 'On 127.0.0.1 there is nothing to set — no endpoint, no key. This section is only for self-host / Terraform deployments that are reachable from the public internet.'));

        container.appendChild(root);

        // Honor a deep-link request (set by the header chooser / welcome modal),
        // then clear it so a later plain navigation lands at the top.
        const target = this.scrollTo;
        this.scrollTo = null;
        if (target) {
            requestAnimationFrame(() => {
                const el = document.getElementById(target);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        }
    },
};

window.GuideConnectAgentsPage = GuideConnectAgentsPage;
