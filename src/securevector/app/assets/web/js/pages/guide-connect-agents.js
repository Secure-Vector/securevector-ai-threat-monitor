/**
 * Connect Agents — lowest-friction "get started" as a numbered 3-step flow,
 * preceded by a slim diagram (Your agents → SecureVector engine → Monitor ·
 * Secure · Govern) that sets the mental model:
 *   ① Pick the agent or harness to monitor — a flat grouped chip grid
 *      (Frameworks · SDK / Harnesses · plugin). Anchors route-frameworks /
 *      route-plugins are preserved for the header chooser + welcome deep-link.
 *   ② Where should SecureVector run — a centered segmented TAB with two equally
 *      visible choices: "This device" (local app, brand teal) and "Your cloud"
 *      (self-hosted endpoint, red) — echoing the diagram's cyan→red spectrum.
 *   ③ Run these commands where your agents are running — the command set for the
 *      chosen tab. Local = adapter only (--no-deps, app already serving this
 *      page); Your cloud = adapter/CLI + SECUREVECTOR_ENGINE_ENDPOINT.
 * Full detail lives in the matching Integrations page (selected.integration).
 * If the app itself runs in a container the local option is dropped and a banner
 * points agents at this engine's URL.
 */
const GuideConnectAgentsPage = {
    scrollTo: null,

    AGENTS: [
        { id: 'langchain', route: 'A', label: 'LangChain', guide: 'guide-frameworks', integration: 'proxy-langchain', pkg: 'securevector-sdk-langchain',
            wire: 'from langchain.agents import create_agent\nfrom securevector_sdk_langchain import secure_middleware\n\n# requires langchain>=1.0 · observe = log-only (default); mode="enforce" blocks\nagent = create_agent(model, tools, middleware=[secure_middleware(mode="observe")])' },
        { id: 'langgraph', route: 'A', label: 'LangGraph', guide: 'guide-frameworks', integration: 'proxy-langgraph', pkg: 'securevector-sdk-langgraph',
            wire: 'from langchain.agents import create_agent  # langgraph-backed\nfrom securevector_sdk_langgraph import secure_middleware\n\n# requires langchain>=1.0 · observe = log-only (default); mode="enforce" blocks\nagent = create_agent(model, tools, middleware=[secure_middleware(mode="observe")])' },
        { id: 'crewai', route: 'A', label: 'CrewAI', guide: 'guide-frameworks', integration: 'proxy-crewai', pkg: 'securevector-sdk-crewai',
            wire: 'from crewai import Agent\nfrom securevector_sdk_crewai import secure_tools\n\n# observe = log-only (default); mode="enforce" blocks\nagent = Agent(role="Researcher", goal="...", backstory="...", tools=secure_tools(my_tools, mode="observe"))' },
        { id: 'hermes', route: 'A', label: 'Hermes', guide: 'guide-frameworks', integration: 'proxy-hermes', pkg: 'securevector-sdk-hermes',
            wire: '# Zero-config: the SDK registers a Hermes plugin (hermes_agent.plugins\n# entry point) — auto-attached when hermes starts (CLI, gateway, ACP).\nhermes                                # observe = log-only (default)\nSECUREVECTOR_SDK_MODE=enforce hermes  # blocks denied tools\n\n# Library embeddings: from securevector_sdk_hermes import install; install(mode="enforce")' },
        { id: 'claude-code', route: 'B', label: 'Claude Code', guide: 'guide-claude-code', integration: 'proxy-claude-code', slug: 'claude-code' },
        { id: 'codex', route: 'B', label: 'Codex', guide: 'guide-codex', integration: 'proxy-codex', slug: 'codex' },
        { id: 'copilot-cli', route: 'B', label: 'Copilot CLI', guide: 'guide-copilot-cli', integration: 'proxy-copilot-cli', slug: 'copilot-cli' },
        { id: 'cursor', route: 'B', label: 'Cursor', guide: 'guide-cursor', integration: 'proxy-cursor', slug: 'cursor' },
        { id: 'openclaw', route: 'B', label: 'OpenClaw', guide: 'guide-openclaw', integration: 'proxy-openclaw', slug: 'openclaw' },
    ],

    // Copy-paste blocks for an agent in the chosen mode. The self-host path
    // ASSUMES the engine is already running at an endpoint in your cloud (deploy
    // is a separate job — linked from the card), so there's no docker/infra here:
    // just point the agent at the endpoint. engineUrl pre-fills it when known.
    blocksFor(agent, selfHost, engineUrl) {
        const url = engineUrl || 'https://<your-engine-url>';
        const ENDPOINT = 'export SECUREVECTOR_ENGINE_ENDPOINT=' + url;
        // This page is SERVED BY the running local app, so a "This device" user
        // already has it — they only need the SDK or the plugin (no [app] install).
        // Self-host points a SEPARATE agent at a remote endpoint, so it installs
        // its own lightweight adapter / CLI.
        if (agent.route === 'A') {
            // SDK is self-contained (stdlib + your framework only), so --no-deps in
            // BOTH cases — the app and framework are already present. The only
            // difference for "your cloud" is the endpoint env var.
            // Hermes attaches zero-config via its plugin entry point (no code to
            // wrap), so its final step is "Run it", not "Wrap your agent".
            const wireLabel = agent.id === 'hermes' ? 'Run it' : 'Wrap your agent';
            return selfHost
                ? [ { label: 'Install the SDK', code: 'pip install ' + agent.pkg + ' --no-deps' },
                    { label: 'Point at your endpoint', code: ENDPOINT },
                    { label: wireLabel, code: agent.wire } ]
                : [ { label: 'Install the SDK', code: 'pip install ' + agent.pkg + ' --no-deps' },
                    { label: wireLabel, code: agent.wire } ];
        }
        return selfHost
            ? [ { label: 'Install the CLI once (to add plugins)', code: "pip install 'securevector-ai-monitor[app]'" },
                { label: 'Point at your endpoint', code: ENDPOINT },
                { label: 'Add the plugin', code: 'securevector-app --install-plugin ' + agent.slug } ]
            : [ { label: 'Add the plugin', code: 'securevector-app --install-plugin ' + agent.slug } ];
    },

    // Two-column layout styles (main flow + sticky detection rail). Injected
    // once; collapses to a single column below 960px so the detection rail
    // drops beneath the flow on narrow viewports instead of squeezing it.
    _injectColsStyle() {
        if (document.getElementById('ca-cols-style')) return;
        const st = document.createElement('style');
        st.id = 'ca-cols-style';
        st.textContent = `
            .ca-cols { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 22px; align-items: start; }
            .ca-main { min-width: 0; }
            .ca-rail { position: sticky; top: 16px; }
            @media (max-width: 960px) {
                .ca-cols { grid-template-columns: 1fr; }
                .ca-rail { position: static; }
            }
            /* Collapsible detection card */
            .ca-detect { border: 1px solid var(--border-default); border-radius: 12px;
                background: var(--bg-card); box-shadow: var(--elevate-1); overflow: hidden; }
            .ca-detect.open { box-shadow: var(--elevate-2); }
            .ca-detect-head { display: flex; align-items: center; gap: 10px; width: 100%;
                background: transparent; border: none; cursor: pointer; text-align: left;
                padding: 12px 14px; font: inherit; color: var(--text-primary);
                transition: background 0.14s; }
            .ca-detect-head:hover { background: var(--bg-hover); }
            .ca-detect-head:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: -2px; }
            .ca-detect-ico { flex: none; width: 26px; height: 26px; border-radius: 7px;
                display: inline-flex; align-items: center; justify-content: center;
                background: color-mix(in srgb, var(--accent-primary) 14%, transparent);
                color: var(--accent-primary); }
            .ca-detect-headtext { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
            .ca-detect-title { font-family: var(--font-display); font-size: 13px; font-weight: 600;
                letter-spacing: -0.01em; }
            .ca-detect-summary { font-size: 10.5px; color: var(--text-muted);
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .ca-detect-chev { flex: none; font-size: 11px; color: var(--text-muted);
                transition: transform 0.15s; }
            .ca-detect-body { padding: 4px 14px 14px; border-top: 1px solid var(--border-default); }
        `;
        document.head.appendChild(st);
    },

    async render(container) {
        container.textContent = '';
        const ACCENT = 'var(--accent-primary)';
        // Highlight spectrum: brand teal (This device / most common) → deep teal
        // (Your cloud / your own engine). Locations are labels, not statuses —
        // the old red end made a healthy self-host choice read as a threat.
        // Used for the engine-node gradient border + the tab dots.
        const CYAN = '#5eadb8';
        const DEEP = '#2d6a74'; // deep end of the brand teal ramp

        // Is THIS app the headless engine running in a container (self-host)? If so,
        // "monitor this device" makes no sense (the box is the engine, not where
        // agents run), so that card is hidden and agents are pointed at this URL.
        let env = { in_container: false, public_url: null, mode: 'local' };
        try { const r = await fetch('/api/system/environment'); if (r.ok) env = await r.json(); } catch (e) { /* default: treat as local desktop */ }
        // Endpoint mode = this process is itself a self-hosted engine (container
        // OR a configured public URL), so "monitor this device" makes no sense —
        // agents point AT this engine. The server computes it; fall back locally.
        const endpointMode = env.mode ? env.mode === 'endpoint' : !!(env.in_container || env.public_url);
        const engineUrl = env.public_url || (endpointMode ? window.location.origin : null);

        const root = document.createElement('div');
        // Left-anchored like every other top-level page (Dashboard, Integrations,
        // Tool Permissions) — NOT a centered docs column. page-content already
        // supplies the outer 24px gutter, so this only caps the reading width.
        root.style.cssText = 'max-width: 1240px; margin: 0; padding: 0 0 40px; color: var(--text-primary);';

        // NOTE: no in-page eyebrow/H1 here — the app header already shows the
        // page title "Connect Your Agents" + its subtitle. Rendering a second
        // "Connect Agents" heading in the body made the top read as two
        // stacked titles ("two liners"). One title (the header) is enough; the
        // page opens straight into the intro line + guided CTA.
        const lede = document.createElement('p');
        lede.style.cssText = 'color: var(--text-secondary); margin: 0 0 16px; font-size: 14px; line-height: 1.5;';
        lede.textContent = 'See what is connected and covered on this device, then connect more — the guided one-click way or by copying commands.';
        root.appendChild(lede);

        // Guided-setup CTA — the old "Connect Wizard" is no longer a separate
        // nav row (it read as a duplicate of this page). Its guided one-click
        // flow lives here as the recommended path; the manual commands are
        // below for anyone who prefers them or is setting up a remote machine.
        const guided = document.createElement('button');
        guided.type = 'button';
        guided.style.cssText = 'display:flex; align-items:center; gap:13px; width:100%; text-align:left; margin:0 0 20px; padding:14px 18px; border-radius:11px; cursor:pointer; background:color-mix(in srgb, ' + ACCENT + ' 10%, var(--bg-card)); border:1px solid color-mix(in srgb, ' + ACCENT + ' 40%, transparent); box-shadow:var(--elevate-1); transition:border-color .14s, background .14s;';
        guided.addEventListener('mouseenter', () => { guided.style.borderColor = ACCENT; });
        guided.addEventListener('mouseleave', () => { guided.style.borderColor = 'color-mix(in srgb, ' + ACCENT + ' 40%, transparent)'; });
        const gIco = document.createElement('span');
        gIco.style.cssText = 'flex:none; width:34px; height:34px; border-radius:9px; background:color-mix(in srgb, ' + ACCENT + ' 18%, transparent); color:' + ACCENT + '; display:inline-flex; align-items:center; justify-content:center;';
        gIco.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>';
        guided.appendChild(gIco);
        const gTxt = document.createElement('div');
        gTxt.style.cssText = 'flex:1; min-width:0;';
        const gT = document.createElement('div'); gT.style.cssText = 'font-family:var(--font-display); font-weight:600; font-size:14.5px; color:var(--text-primary);'; gT.textContent = 'Guided one-click setup';
        const gS = document.createElement('div'); gS.style.cssText = 'font-size:12.5px; color:var(--text-secondary); margin-top:1px;'; gS.textContent = 'Scan this device, install Guard, and verify the first protected call — recommended.';
        gTxt.appendChild(gT); gTxt.appendChild(gS);
        guided.appendChild(gTxt);
        const gArrow = document.createElement('span'); gArrow.style.cssText = 'flex:none; color:' + ACCENT + '; font-weight:700;'; gArrow.textContent = '→';
        guided.appendChild(gArrow);
        guided.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('connect-wizard'); });
        root.appendChild(guided);

        // Two-column layout: the primary connect flow (steps + commands) fills
        // the left; the "on this device" detection becomes a sticky vertical
        // box on the right, using the otherwise-empty right-hand space instead
        // of pushing the steps down. Collapses to a single column on narrow
        // viewports (detection rail drops below the main flow).
        this._injectColsStyle();
        const mainRow = document.createElement('div');
        mainRow.className = 'ca-cols';
        const leftCol = document.createElement('div');
        leftCol.className = 'ca-main';
        const rightRail = document.createElement('div');
        rightRail.className = 'ca-rail';
        mainRow.appendChild(leftCol);
        mainRow.appendChild(rightRail);
        root.appendChild(mainRow);

        // ---- state ----
        let selected = null;
        const chipButtons = [];

        // ---- tabs host (step 2) + command panel (step 3), both filled on selection ----
        const tabsHost = document.createElement('div');
        const panel = document.createElement('div');
        panel.id = 'connect-cmd-panel';
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-label', 'Commands for the selected deployment');
        panel.style.cssText = 'margin-top: 4px;';

        // Small square copy button — a clipboard icon (no "Copy" word); swaps to
        // a checkmark for ~1.2s on success.
        const SVG_NS = 'http://www.w3.org/2000/svg';
        const makeIcon = (parts) => {
            const svg = document.createElementNS(SVG_NS, 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
            svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
            parts.forEach(p => { const el = document.createElementNS(SVG_NS, p.t); Object.entries(p.a).forEach(([k, v]) => el.setAttribute(k, v)); svg.appendChild(el); });
            return svg;
        };
        const iconCopy = () => makeIcon([{ t: 'rect', a: { x: 9, y: 9, width: 13, height: 13, rx: 2, ry: 2 } }, { t: 'path', a: { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' } }]);
        const iconCheck = () => makeIcon([{ t: 'polyline', a: { points: '20 6 9 17 4 12' } }]);

        const codeBlock = (label, codeText) => {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'margin: 0 0 12px;';
            const lab = document.createElement('div');
            lab.style.cssText = 'font-size: 12px; font-weight: 700; color: var(--text-secondary); margin-bottom: 5px;';
            lab.textContent = label;
            wrap.appendChild(lab);
            const box = document.createElement('div');
            box.style.cssText = 'position: relative;';
            const pre = document.createElement('pre');
            pre.style.cssText = 'margin: 0; padding: 12px 42px 12px 14px; background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 8px; font-family: monospace; font-size: 12.5px; line-height: 1.5; overflow-x: auto; white-space: pre; color: var(--text-primary);';
            pre.textContent = codeText;
            box.appendChild(pre);
            const copy = document.createElement('button');
            copy.type = 'button';
            copy.title = 'Copy';
            copy.setAttribute('aria-label', 'Copy');
            copy.style.cssText = 'position: absolute; top: 8px; right: 8px; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; padding: 0; background: var(--bg-card); color: var(--text-secondary); border: 1px solid var(--border-default); border-radius: 6px; cursor: pointer; transition: color 0.12s, border-color 0.12s;';
            copy.appendChild(iconCopy());
            copy.addEventListener('mouseenter', () => { if (copy.title !== 'Copied') { copy.style.color = 'var(--text-primary)'; copy.style.borderColor = 'var(--text-secondary)'; } });
            copy.addEventListener('mouseleave', () => { if (copy.title !== 'Copied') { copy.style.color = 'var(--text-secondary)'; copy.style.borderColor = 'var(--border-default)'; } });
            copy.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(codeText);
                    copy.textContent = ''; copy.appendChild(iconCheck()); copy.title = 'Copied';
                    copy.style.color = '#10b981'; copy.style.borderColor = '#10b981';
                    setTimeout(() => { copy.textContent = ''; copy.appendChild(iconCopy()); copy.title = 'Copy'; copy.style.color = 'var(--text-secondary)'; copy.style.borderColor = 'var(--border-default)'; }, 1200);
                } catch { copy.title = 'Copy failed'; }
            });
            box.appendChild(copy);
            wrap.appendChild(box);
            return wrap;
        };

        // Where-does-it-run state. Default local (most common — this page is served
        // by the running app); self-host is one click away (progressive disclosure,
        // the unanimous persona pick). The choice is REMEMBERED so a returning
        // self-hoster doesn't get reset to local each visit. Forced to self-host
        // inside a container.
        let savedMode = null;
        try { savedMode = localStorage.getItem('sv-connect-mode'); } catch (e) {}
        let mode = endpointMode ? 'selfhost' : (savedMode === 'selfhost' ? 'selfhost' : 'local');

        const renderPanel = () => {
            tabsHost.textContent = '';
            panel.textContent = '';
            if (!selected) return;
            const selfHost = mode === 'selfhost';

            // Segmented tab: two PROMINENT, equally-visible choices (This device /
            // Your cloud), centered so it reads as the decision point. The diagram
            // above explains there ARE two placements; the tab is where you pick.
            // Choice is remembered. In a container only the cloud option is offered.
            const head = document.createElement('div');
            head.style.cssText = 'display: flex; justify-content: center; margin: 4px 0 4px;';

            const tabs = document.createElement('div');
            tabs.setAttribute('role', 'tablist');
            tabs.style.cssText = 'display: inline-flex; gap: 6px; padding: 4px; background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 12px; flex-wrap: wrap; justify-content: center;';
            // Segmented control: the SELECTED tab is a raised neutral pill
            // (bg-card + primary text + soft shadow) — NOT a cyan fill — so we
            // never put white text on cyan. The leading cyan/red dot is what
            // carries the "this device vs your cloud" spectrum.
            const mkTab = (key, label, tag, dot) => {
                const on = (mode === key);
                const b = document.createElement('button');
                b.type = 'button';
                b.id = 'connect-tab-' + key;
                b.setAttribute('role', 'tab');
                b.setAttribute('aria-selected', on ? 'true' : 'false');
                b.setAttribute('aria-controls', 'connect-cmd-panel');
                b.style.cssText = 'display: inline-flex; align-items: baseline; gap: 7px; border: 1px solid ' + (on ? 'var(--border-default)' : 'transparent') + '; border-radius: 9px; padding: 9px 18px; font-size: 13.5px; font-weight: ' + (on ? '700' : '600') + '; cursor: pointer; background: ' + (on ? 'var(--bg-card)' : 'transparent') + '; color: ' + (on ? 'var(--text-primary)' : 'var(--text-secondary)') + '; box-shadow: ' + (on ? '0 1px 4px rgba(0,0,0,0.18)' : 'none') + '; transition: background 0.12s, color 0.12s, border-color 0.12s, box-shadow 0.12s;';
                const dotEl = document.createElement('span');
                dotEl.setAttribute('aria-hidden', 'true');
                dotEl.style.cssText = 'flex: none; width: 8px; height: 8px; border-radius: 50%; align-self: center; background: ' + dot + '; box-shadow: 0 0 0 3px color-mix(in srgb, ' + dot + ' 22%, transparent);';
                b.appendChild(dotEl);
                b.appendChild(document.createTextNode(label));
                const tg = document.createElement('span');
                tg.style.cssText = 'font-size: 11px; font-weight: 500; color: ' + (on ? 'var(--text-secondary)' : 'var(--text-muted)') + ';';
                tg.textContent = tag;
                b.appendChild(tg);
                b.addEventListener('click', () => { if (mode !== key) { mode = key; try { localStorage.setItem('sv-connect-mode', mode); } catch (e) {} renderPanel(); } });
                return b;
            };
            if (endpointMode) {
                tabs.appendChild(mkTab('selfhost', 'Your cloud', env.in_container ? '· this container' : '· this endpoint', DEEP));
            } else {
                tabs.appendChild(mkTab('local', 'This device', '· local app', CYAN));
                tabs.appendChild(mkTab('selfhost', 'Your cloud', '· self-hosted', DEEP));
            }
            head.appendChild(tabs);
            tabsHost.appendChild(head);

            // single command set for the chosen mode (the hero)
            this.blocksFor(selected, selfHost, engineUrl).forEach(b => panel.appendChild(codeBlock(b.label, b.code)));

            // self-host only: one line clarifying what actually gets installed.
            if (selfHost) {
                const foot = document.createElement('div');
                foot.style.cssText = 'font-size: 12px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5;';
                foot.textContent = selected.route === 'B'
                    ? 'Installs the CLI + plugin hooks only — your engine stays remote.'
                    : 'Lightweight adapter — points at your endpoint.';
                panel.appendChild(foot);
            }

            // "How do I know it worked?" — the reassurance first-timers and indie
            // devs asked for. Route B needs a harness restart; both land in Agent
            // Activity, so link straight there to close the loop.
            const verify = document.createElement('div');
            verify.style.cssText = 'font-size: 12.5px; color: var(--text-secondary); margin-top: 10px; line-height: 1.55;';
            const vStrong = document.createElement('span');
            vStrong.style.cssText = 'font-weight: 700; color: var(--text-primary);';
            vStrong.textContent = selected.route === 'B' ? ('Then restart ' + selected.label + ' and run it. ') : 'Then run your agent. ';
            verify.appendChild(vStrong);
            verify.appendChild(document.createTextNode('Tool calls show up in '));
            const vLink = document.createElement('button');
            vLink.type = 'button';
            vLink.style.cssText = 'background: none; border: none; color: ' + ACCENT + '; font-size: 12.5px; font-weight: 600; cursor: pointer; padding: 0; text-decoration: underline; text-underline-offset: 2px;';
            vLink.textContent = 'Observability';
            vLink.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('agent-map'); });
            verify.appendChild(vLink);
            verify.appendChild(document.createTextNode(' within seconds — tagged by ' + (selected.route === 'B' ? 'harness.' : 'framework.')));
            panel.appendChild(verify);

            // self-host: one muted line answering "where does my data go?" — the
            // CISO/EU question. The deeper deploy + auth steps live in the full
            // setup link below (Connect stays quick; Integrations is detailed).
            if (selfHost) {
                const sh = document.createElement('div');
                sh.style.cssText = 'font-size: 12px; color: var(--text-secondary); margin-top: 6px; line-height: 1.5;';
                sh.textContent = 'Your cloud keeps all data in your cloud — nothing is sent to SecureVector.';
                panel.appendChild(sh);
            }

            // Promoted safety note — load-bearing behaviour, so give it a left
            // accent rule and a touch more size to lift it above the grey hints.
            const modeNote = document.createElement('div');
            modeNote.style.cssText = 'font-size: 12.5px; color: var(--text-secondary); margin-top: 14px; padding: 8px 12px; border-left: 3px solid ' + ACCENT + '; background: color-mix(in srgb, ' + ACCENT + ' 5%, transparent); border-radius: 0 6px 6px 0; line-height: 1.5;';
            const mnStrong = document.createElement('strong');
            mnStrong.style.color = 'var(--text-primary)';
            mnStrong.textContent = selected.route === 'A' ? 'Starts in observe (log-only). ' : 'Enforces your tool policy. ';
            modeNote.appendChild(mnStrong);
            modeNote.appendChild(document.createTextNode(selected.route === 'A' ? 'Switch to enforce to block.' : 'Fails open if the engine is down.'));
            panel.appendChild(modeNote);

            // Quiet deep-link to the full per-agent reference (Integrations). In
            // self-host it doubles as the path to deploy + auth details.
            const linkRow = document.createElement('div');
            linkRow.style.cssText = 'display: flex; justify-content: flex-end; margin-top: 12px;';
            const guideLink = document.createElement('button');
            guideLink.type = 'button';
            guideLink.style.cssText = 'background: none; border: none; color: var(--text-secondary); font-size: 12.5px; font-weight: 500; cursor: pointer; padding: 0; white-space: nowrap; text-decoration: underline; text-underline-offset: 2px;';
            guideLink.textContent = selfHost ? ('Deploy + full ' + selected.label + ' setup →') : ('Full ' + selected.label + ' setup →');
            guideLink.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate(selected.integration || selected.guide); });
            linkRow.appendChild(guideLink);
            panel.appendChild(linkRow);
        };

        const selectChip = (agent) => {
            selected = agent;
            chipButtons.forEach(c => {
                const on = c.dataset.agent === agent.id;
                // Selected = accent OUTLINE (cyan text + border + faint tint),
                // never a solid cyan fill with white text.
                c.style.background = on ? 'color-mix(in srgb, ' + ACCENT + ' 12%, transparent)' : 'transparent';
                c.style.color = on ? ACCENT : 'var(--text-primary)';
                c.style.borderColor = on ? ACCENT : 'var(--border-default)';
                c.style.fontWeight = on ? '700' : '500';
                c.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
            renderPanel();
        };

        // ---- numbered step header (① pick agent, ② where it runs) ----
        const stepHeader = (num, title, helper) => {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'display: flex; align-items: center; gap: 8px; margin: 0 0 9px;';
            const n = document.createElement('span');
            n.style.cssText = 'flex: none; width: 20px; height: 20px; border-radius: 50%; background: color-mix(in srgb, ' + ACCENT + ' 12%, transparent); color: ' + ACCENT + '; border: 1.5px solid ' + ACCENT + '; font-size: 11px; font-weight: 800; display: inline-flex; align-items: center; justify-content: center;';
            n.textContent = String(num);
            wrap.appendChild(n);
            const tw = document.createElement('div');
            const t = document.createElement('div');
            t.style.cssText = 'font-size: 14px; font-weight: 800;';
            t.textContent = title;
            tw.appendChild(t);
            if (helper) {
                const hl = document.createElement('div');
                hl.style.cssText = 'font-size: 12.5px; color: var(--text-secondary); margin-top: 1px;';
                hl.textContent = helper;
                tw.appendChild(hl);
            }
            wrap.appendChild(tw);
            return wrap;
        };

        // ---- agent chips, grouped by kind (flat grid, no heavy route boxes) ----
        const makeChip = (agent) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.dataset.agent = agent.id;
            chip.setAttribute('aria-pressed', 'false');
            chip.style.cssText = 'border: 1px solid var(--border-default); background: transparent; color: var(--text-primary); border-radius: 8px; padding: 6px 12px; font-size: 13px; font-weight: 500; cursor: pointer; transition: background 0.12s, color 0.12s, border-color 0.12s;';
            chip.textContent = agent.label;
            chip.addEventListener('click', () => selectChip(agent));
            // Hover feedback for unselected chips (selected ones keep their accent outline).
            chip.addEventListener('mouseenter', () => { if (chip.getAttribute('aria-pressed') !== 'true') { chip.style.borderColor = 'var(--text-secondary)'; chip.style.background = 'var(--bg-tertiary)'; } });
            chip.addEventListener('mouseleave', () => { if (chip.getAttribute('aria-pressed') !== 'true') { chip.style.borderColor = 'var(--border-default)'; chip.style.background = 'transparent'; } });
            chipButtons.push(chip);
            return chip;
        };
        // Compact: label sits on the LEFT, chips flow to its right on one line
        // (wraps on mobile) — much shorter than label-stacked-above-chips.
        const agentGroup = (anchor, label, routeKey) => {
            const g = document.createElement('div');
            g.id = anchor;
            g.style.cssText = 'scroll-margin-top: 80px; display: flex; align-items: center; flex-wrap: wrap; gap: 7px 10px; margin-bottom: 8px;';
            const gl = document.createElement('div');
            gl.style.cssText = 'flex: none; width: 118px; font-size: 10.5px; font-weight: 600; letter-spacing: 0.3px; text-transform: uppercase; color: var(--text-secondary);';
            gl.textContent = label;
            g.appendChild(gl);
            this.AGENTS.filter(a => a.route === routeKey).forEach(a => g.appendChild(makeChip(a)));
            return g;
        };

        // High-level flow diagram — one slim row that gives the mental model
        // behind the two steps: your agents call THROUGH the SecureVector
        // engine, which monitors/secures/governs every tool call. The engine
        // is what runs "on this device or in your cloud" (step 2). Visual, so
        // it earns its space without adding prose.
        const mkNode = (title, sub, accent) => {
            const d = document.createElement('div');
            d.style.cssText = 'flex: 1 1 0; min-width: 124px; border-radius: 10px; padding: 9px 12px; ' +
                (accent
                    // Gradient border (cyan → red) via the padding-box/border-box
                    // double-background trick so the corners stay rounded. The
                    // SecureVector engine is the node that earns the highlight.
                    ? 'border: 1.5px solid transparent; background: linear-gradient(var(--bg-card), var(--bg-card)) padding-box, linear-gradient(90deg, color-mix(in srgb, ' + ACCENT + ' 70%, transparent), color-mix(in srgb, ' + DEEP + ' 45%, transparent)) border-box;'
                    : 'border: 1px solid var(--border-default); background: var(--bg-card);');
            const t = document.createElement('div');
            t.style.cssText = 'font-size: 13px; font-weight: ' + (accent ? '800' : '700') + '; color: var(--text-primary);';
            t.textContent = title;
            const s = document.createElement('div');
            s.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-top: 1px;';
            s.textContent = sub;
            d.appendChild(t); d.appendChild(s);
            return d;
        };
        const mkArrow = () => {
            const a = document.createElement('div');
            a.style.cssText = 'flex: none; align-self: center; color: var(--text-secondary); font-size: 16px; font-weight: 700;';
            a.textContent = '→';
            return a;
        };
        const flow = document.createElement('div');
        flow.style.cssText = 'display: flex; align-items: stretch; flex-wrap: wrap; gap: 8px; margin: 0 0 22px;';
        flow.appendChild(mkNode('Your agents', 'SDKs · plugins', false));
        flow.appendChild(mkArrow());
        flow.appendChild(mkNode('SecureVector engine', 'This device · or your cloud', true));
        flow.appendChild(mkArrow());
        flow.appendChild(mkNode('Monitor · Secure · Govern', 'every tool call', false));
        leftCol.appendChild(flow);

        // --- "Detected on this device" panel — a CONSENT-GATED local probe.
        // Runs nothing until the user grants permission via a popup that spells
        // out exactly what it reads (local harness dirs + session transcripts +
        // the tool-call audit). Each detected harness links to its Integrations
        // install page. Consent is remembered + revocable. ---
        const DETECT_KEY = 'sv-detection-consent';
        // Detection is OPTIONAL — a consent-gated shortcut. Users who skip it just
        // follow steps 1-2-3 below. Renders a clean callout that flips to a results
        // card in place once granted; nothing leaves this device.
        const detectWrap = document.createElement('div');
        detectWrap.style.cssText = 'margin: 0;';
        rightRail.appendChild(detectWrap);

        // Collapsible, opt-in detection card. Collapsed by default so the rail
        // is a tight one-line affordance; expanding it IS the opt-in — it runs
        // the local probe (behind the consent gate on first use). Expand state
        // persists. The card shell owns the border/elevation; the body content
        // (consent prompt OR results) renders borderless inside it.
        const RAIL_KEY = 'sv-detect-rail-open';
        const detectCard = document.createElement('div');
        detectCard.className = 'ca-detect';
        const detectHead = document.createElement('button');
        detectHead.type = 'button';
        detectHead.className = 'ca-detect-head';
        detectHead.setAttribute('aria-expanded', 'false');
        const dhIco = document.createElement('span');
        dhIco.className = 'ca-detect-ico';
        dhIco.setAttribute('aria-hidden', 'true');
        dhIco.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
        const dhCol = document.createElement('span');
        dhCol.className = 'ca-detect-headtext';
        const dhTitle = document.createElement('span'); dhTitle.className = 'ca-detect-title'; dhTitle.textContent = 'On this device';
        const dhSummary = document.createElement('span'); dhSummary.className = 'ca-detect-summary'; dhSummary.textContent = 'Scan installed agents & coverage';
        dhCol.appendChild(dhTitle); dhCol.appendChild(dhSummary);
        const dhChev = document.createElement('span'); dhChev.className = 'ca-detect-chev'; dhChev.setAttribute('aria-hidden', 'true'); dhChev.textContent = '▸';
        detectHead.appendChild(dhIco); detectHead.appendChild(dhCol); detectHead.appendChild(dhChev);
        const detectBody = document.createElement('div');
        detectBody.className = 'ca-detect-body';
        detectBody.hidden = true;
        detectCard.appendChild(detectHead);
        detectCard.appendChild(detectBody);
        detectWrap.appendChild(detectCard);

        let _railRan = false;
        const setRailOpen = (open) => {
            detectBody.hidden = !open;
            detectCard.classList.toggle('open', open);
            dhChev.style.transform = open ? 'rotate(90deg)' : 'none';
            detectHead.setAttribute('aria-expanded', String(open));
            try { localStorage.setItem(RAIL_KEY, open ? '1' : '0'); } catch (_) {}
            if (open && !_railRan) {
                _railRan = true;
                let granted = false;
                try { granted = localStorage.getItem(DETECT_KEY) === 'granted'; } catch (_) {}
                if (granted) runDetection(); else renderDetectPrompt();
            }
        };
        detectHead.addEventListener('click', () => setRailOpen(detectBody.hidden));

        // Compact consent prompt (shown inside the expanded body on first use).
        const renderDetectPrompt = () => {
            detectBody.textContent = '';
            const s = document.createElement('div');
            s.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.55; margin-bottom: 12px;';
            s.textContent = 'Detects installed harnesses, sessions, and which already run Guard. Reads local folders only — nothing leaves this device.';
            detectBody.appendChild(s);
            const btn = document.createElement('button'); btn.type = 'button';
            const btnBg = 'color-mix(in srgb, ' + ACCENT + ' 15%, transparent)';
            const btnBd = 'color-mix(in srgb, ' + ACCENT + ' 40%, transparent)';
            btn.style.cssText = 'display: inline-flex; align-items: center; gap: 7px; background: ' + btnBg + '; border: 1px solid ' + btnBd + '; color: ' + ACCENT + '; border-radius: 8px; padding: 8px 14px; font-size: 12.5px; font-weight: 700; cursor: pointer; transition: background 0.14s, border-color 0.14s;';
            btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
            btn.appendChild(document.createTextNode('Run detection'));
            btn.addEventListener('mouseenter', () => { btn.style.background = 'color-mix(in srgb, ' + ACCENT + ' 24%, transparent)'; btn.style.borderColor = 'color-mix(in srgb, ' + ACCENT + ' 60%, transparent)'; });
            btn.addEventListener('mouseleave', () => { btn.style.background = btnBg; btn.style.borderColor = btnBd; });
            btn.addEventListener('click', openConsent);
            detectBody.appendChild(btn);
        };

        const openConsent = async () => {
            let osName = 'this device';
            try { const e = await fetch('/api/system/environment').then(r => r.json()); if (e && e.os) osName = e.os; } catch (_) {}
            const ov = document.createElement('div');
            ov.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 1200; padding: 20px;';
            const m = document.createElement('div');
            m.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 14px; max-width: 480px; width: 100%; padding: 22px; box-shadow: 0 12px 40px rgba(0,0,0,0.4);';
            const h = document.createElement('div'); h.style.cssText = 'font-size: 16px; font-weight: 800; margin-bottom: 8px;'; h.textContent = 'Detect agents on this device?';
            const body = document.createElement('div'); body.style.cssText = 'font-size: 13px; color: var(--text-secondary); line-height: 1.6;';
            body.appendChild(document.createTextNode('SecureVector will check this device (' + osName + ') to show what’s running. It reads, locally:'));
            const ul = document.createElement('ul'); ul.style.cssText = 'margin: 8px 0; padding-left: 18px;';
            ['Harness folders (~/.claude, ~/.codex, ~/.copilot, ~/.cursor, ~/.openclaw) — which are installed',
             'Their session files — to count sessions and recent activity',
             'SecureVector’s own tool-call audit — to list active agents/frameworks'].forEach(li => { const l = document.createElement('li'); l.style.cssText = 'margin-bottom: 3px;'; l.textContent = li; ul.appendChild(l); });
            body.appendChild(ul);
            const safe = document.createElement('div'); safe.style.cssText = 'font-size: 12.5px; color: var(--text-primary); font-weight: 600;'; safe.textContent = 'It runs entirely on this device — nothing is uploaded or sent anywhere.';
            body.appendChild(safe);
            const btns = document.createElement('div'); btns.style.cssText = 'display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px;';
            const cancel = document.createElement('button'); cancel.type = 'button'; cancel.style.cssText = 'background: none; border: 1px solid var(--border-default); color: var(--text-primary); border-radius: 8px; padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer;'; cancel.textContent = 'Not now';
            const ok = document.createElement('button'); ok.type = 'button'; ok.style.cssText = 'background: transparent; border: 1.5px solid color-mix(in srgb, ' + ACCENT + ' 60%, transparent); color: ' + ACCENT + '; border-radius: 8px; padding: 8px 16px; font-size: 13px; font-weight: 700; cursor: pointer;'; ok.textContent = 'Run detection';
            const close = () => ov.remove();
            cancel.addEventListener('click', close);
            ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
            ok.addEventListener('click', () => { try { localStorage.setItem(DETECT_KEY, 'granted'); } catch (_) {} close(); runDetection(); });
            btns.appendChild(cancel); btns.appendChild(ok);
            m.appendChild(h); m.appendChild(body); m.appendChild(btns);
            ov.appendChild(m); document.body.appendChild(ov);
        };

        const runDetection = async () => {
            detectBody.textContent = '';
            const loading = document.createElement('div');
            loading.style.cssText = 'font-size: 12.5px; color: var(--text-secondary); padding: 4px 0;';
            loading.textContent = 'Scanning this device…';
            detectBody.appendChild(loading);
            let d;
            try { d = await fetch('/api/detection/agents').then(r => r.json()); } catch (_) { loading.textContent = 'Detection unavailable.'; return; }
            renderDetectResults(d);
        };

        const _dotColor = (status) => ({ active: '#10b981', idle: '#f59e0b', installed: 'var(--text-muted)', not_installed: 'var(--text-muted)' })[status] || 'var(--text-muted)';

        // Authoritative Guard install state from the per-harness /status route
        // (registry-backed). OpenClaw uses a different path. Returns one of
        // 'enabled' | 'installed' | 'absent' (best-effort; 'absent' on error).
        const guardStatus = async (slug) => {
            try {
                const url = slug === 'openclaw' ? '/api/hooks/status' : '/api/hooks/' + slug + '/status';
                const st = await fetch(url).then(r => r.json());
                if (st.enabled === true) return 'enabled';
                if (st.installed === true || st.auto_installed === true || st.registered === true) return 'installed';
                return 'absent';
            } catch (_) { return 'absent'; }
        };

        const renderDetectResults = (d) => {
            detectBody.textContent = '';
            const s = d.summary || {};
            const wrap = document.createElement('div');
            // Borderless — the card shell already frames it. Tight.
            // Reflect a one-line summary up into the collapsed header so the
            // rail still communicates coverage when folded away.
            const uncovered = s.unprotected_sessions || 0;
            dhSummary.textContent = (d.os ? d.os + ' · ' : '') +
                (s.harnesses_detected || 0) + ' found' +
                (uncovered > 0 ? ' · ≈' + uncovered + ' uncovered' : '');
            dhSummary.style.color = uncovered > 0 ? 'var(--warning)' : 'var(--text-muted)';

            const ctrls = document.createElement('div'); ctrls.style.cssText = 'display: flex; gap: 14px; margin-bottom: 10px;';
            const rescan = document.createElement('button'); rescan.type = 'button'; rescan.style.cssText = 'background: none; border: none; color: ' + ACCENT + '; font-size: 12px; font-weight: 600; cursor: pointer; padding: 0; font-family: var(--font-mono);'; rescan.textContent = '↻ Re-scan'; rescan.addEventListener('click', runDetection);
            const off = document.createElement('button'); off.type = 'button'; off.style.cssText = 'background: none; border: none; color: var(--text-muted); font-size: 12px; font-weight: 500; cursor: pointer; padding: 0;'; off.textContent = 'Turn off'; off.addEventListener('click', () => { try { localStorage.removeItem(DETECT_KEY); } catch (_) {} _railRan = true; renderDetectPrompt(); });
            ctrls.appendChild(rescan); ctrls.appendChild(off);
            wrap.appendChild(ctrls);

            const sum = document.createElement('div'); sum.style.cssText = 'font-size: 11.5px; color: var(--text-secondary); font-family: var(--font-mono); margin-bottom: 3px;';
            sum.textContent = (s.harnesses_detected || 0) + ' harnesses · ' + (s.harnesses_active || 0) + ' active · ' + (s.total_sessions || 0) + ' sessions';
            wrap.appendChild(sum);
            if (uncovered > 0) {
                const warn = document.createElement('div'); warn.style.cssText = 'font-size: 11.5px; color: var(--warning); font-weight: 600; margin-bottom: 8px; cursor: help;';
                warn.textContent = '≈' + uncovered + ' of ' + (s.total_sessions || 0) + ' not covered by Guard';
                warn.title = 'Estimate: on-disk session transcripts minus the sessions seen in SecureVector’s audit. Older sessions that predate Guard count here. Connecting Guard covers new sessions going forward.';
                wrap.appendChild(warn);
            } else { sum.style.marginBottom = '8px'; }

            (d.harnesses || []).forEach(h => {
                const present = h.detected || h.plugin_connected;
                const row = document.createElement('div');
                row.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 8px 0; border-top: 1px solid var(--border-default); flex-wrap: wrap;' + (present ? '' : ' opacity: 0.5;');
                const dot = document.createElement('span'); dot.style.cssText = 'flex: none; width: 7px; height: 7px; border-radius: 50%; background: ' + _dotColor(h.status) + ';' + (h.status === 'active' ? ' box-shadow: 0 0 0 3px color-mix(in srgb, #10b981 25%, transparent);' : '');
                row.appendChild(dot);
                // Name sits INLINE with the dot; the Guard badge right-aligns on
                // the same line; sessions/coverage wrap to a compact second line.
                const name = document.createElement('span'); name.style.cssText = 'font-size: 12.5px; font-weight: 700; flex: 1 1 auto; min-width: 0;'; name.textContent = h.label;
                row.appendChild(name);

                // Guard badge — right-aligned on the SAME line as the dot+name.
                const badge = document.createElement('span'); badge.style.cssText = 'flex: none; margin-left: auto; font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 20px; border: 1px solid var(--border-default); color: var(--text-secondary); white-space: nowrap;'; badge.textContent = '…';
                if (present) {
                    guardStatus(h.slug).then(state => {
                        if (state === 'enabled') { badge.textContent = '✓ Guard'; badge.style.color = '#10b981'; badge.style.borderColor = 'color-mix(in srgb, #10b981 50%, transparent)'; badge.style.cursor = 'default'; }
                        else if (state === 'installed') { badge.textContent = 'Guard · off'; badge.style.color = 'var(--warning)'; badge.style.borderColor = 'color-mix(in srgb, #f59e0b 50%, transparent)'; }
                        else { badge.textContent = 'Install →'; badge.style.color = ACCENT; badge.style.borderColor = 'color-mix(in srgb, ' + ACCENT + ' 50%, transparent)'; badge.style.cursor = 'pointer'; badge.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('proxy-' + h.slug); }); }
                    });
                } else { badge.textContent = 'not installed'; }
                row.appendChild(badge);

                // sessions / coverage — a compact second line under the name.
                const sessTxt = document.createElement('span'); sessTxt.style.cssText = 'font-size: 11px; color: var(--text-secondary); font-family: var(--font-mono); flex: 1 1 100%; padding-left: 15px;';
                if (h.sessions && h.sessions.supported) {
                    if ((h.unprotected_sessions || 0) > 0) {
                        sessTxt.appendChild(document.createTextNode((h.protected_sessions || 0) + '/' + h.sessions.total + ' guarded · '));
                        const u = document.createElement('span'); u.style.cssText = 'color: var(--warning); font-weight: 600;'; u.title = 'Estimate — older sessions predating Guard count here.'; u.textContent = '≈' + h.unprotected_sessions + ' uncovered';
                        sessTxt.appendChild(u);
                    } else {
                        sessTxt.textContent = h.sessions.total + ' session' + (h.sessions.total === 1 ? '' : 's');
                    }
                } else {
                    sessTxt.textContent = h.detected ? 'installed' : 'not detected';
                }
                row.appendChild(sessTxt);

                if (present) { row.title = 'Open the ' + h.label + ' install page'; name.style.cursor = 'pointer'; name.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('proxy-' + h.slug); }); }
                wrap.appendChild(row);
            });

            if ((d.frameworks || []).length) {
                const fw = document.createElement('div'); fw.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-top: 9px; border-top: 1px solid var(--border-default); padding-top: 9px;';
                fw.textContent = 'Frameworks: ' + d.frameworks.map(f => f.label + (f.active ? ' (active)' : '')).join(' · ');
                wrap.appendChild(fw);
            }
            detectBody.appendChild(wrap);
        };

        // Detection scans the machine THIS app runs on. In endpoint mode that's a
        // remote engine host, not the user's agent machine — so it's meaningless
        // there and we hide it. Locally, it's the high-value "discover what you
        // already have" hook.
        if (endpointMode) {
            detectWrap.style.display = 'none';
        } else {
            // Expanded by default; still honor a manual collapse the user made.
            let _open = true;
            try { const v = localStorage.getItem(RAIL_KEY); if (v !== null) _open = v === '1'; } catch (_) {}
            setRailOpen(_open);
        }

        // When this app IS the self-hosted engine (container or configured public
        // URL), lead with a banner and drop the "monitor this device" path — the
        // whole page auto-adapts to "point your agents at this endpoint".
        if (endpointMode) {
            const cb = document.createElement('div');
            cb.style.cssText = 'margin: 0 0 20px; padding: 14px 16px; background: color-mix(in srgb, ' + DEEP + ' 9%, var(--bg-card)); border: 1px solid color-mix(in srgb, ' + DEEP + ' 45%, var(--border-default)); border-left: 3px solid ' + DEEP + '; border-radius: 10px;';
            const t = document.createElement('div');
            t.style.cssText = 'font-size: 14px; font-weight: 800; margin-bottom: 4px;';
            t.textContent = env.in_container
                ? 'Self-hosted engine (container) — point your agents here'
                : 'Self-hosted engine — point your agents here';
            cb.appendChild(t);
            const sub = document.createElement('div');
            sub.style.cssText = 'font-size: 12.5px; color: var(--text-secondary); margin-bottom: 8px; line-height: 1.5;';
            sub.textContent = 'This SecureVector is running as a network endpoint, so the local-app option is off. Every agent below points at this engine URL.';
            cb.appendChild(sub);
            cb.appendChild(codeBlock('Engine URL', engineUrl || window.location.origin));
            rightRail.insertBefore(cb, detectWrap);
        }

        // The three steps live in ONE cohesive card (the "configurator"): pick
        // agent ① / where the engine runs ② / commands ③. Numbered so users who
        // skip detection can just follow 1-2-3. Divider between each block.
        const agentWrap = document.createElement('div');
        agentWrap.style.cssText = 'margin: 0;';
        agentWrap.appendChild(agentGroup('route-frameworks', 'Frameworks · SDK', 'A'));
        agentWrap.appendChild(agentGroup('route-plugins', 'Harnesses · plugin', 'B'));

        // Each step is COLLAPSIBLE and collapsed by default — the card reads as
        // a clean three-line overview (① pick · ② where · ③ commands); clicking
        // a step's header expands its content. The header row becomes the
        // toggle; a rotating chevron signals expandability.
        const stepBlock = (headerEl, contentEl, withDivider, defaultOpen) => {
            const b = document.createElement('div');
            b.style.cssText = (withDivider ? 'border-top: 1px solid var(--border-default);' : '');
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.style.cssText = 'display: flex; align-items: center; gap: 10px; width: 100%; background: transparent; border: none; cursor: pointer; text-align: left; padding: 14px 16px; font: inherit; color: inherit; transition: background 0.12s;';
            toggle.addEventListener('mouseenter', () => { toggle.style.background = 'var(--bg-hover)'; });
            toggle.addEventListener('mouseleave', () => { toggle.style.background = 'transparent'; });
            headerEl.style.margin = '0';
            headerEl.style.flex = '1';
            headerEl.style.minWidth = '0';
            toggle.appendChild(headerEl);
            const chev = document.createElement('span');
            chev.setAttribute('aria-hidden', 'true');
            chev.textContent = '▸';
            chev.style.cssText = 'flex: none; font-size: 12px; color: var(--text-muted); transition: transform 0.15s;';
            toggle.appendChild(chev);
            const body = document.createElement('div');
            body.style.cssText = 'padding: 0 16px 16px;';
            body.appendChild(contentEl);
            const apply = (open) => {
                body.hidden = !open;
                chev.style.transform = open ? 'rotate(90deg)' : 'none';
                toggle.setAttribute('aria-expanded', String(open));
            };
            apply(!!defaultOpen);
            toggle.addEventListener('click', () => apply(body.hidden));
            b.appendChild(toggle);
            b.appendChild(body);
            return b;
        };
        const card = document.createElement('div');
        card.style.cssText = 'border: 1px solid var(--border-default); border-radius: 14px; background: var(--bg-card); box-shadow: var(--elevate-1); overflow: hidden; margin: 0 0 18px;';
        card.appendChild(stepBlock(stepHeader(1, 'Pick the agent or harness to monitor', 'Prefer to integrate manually? Pick yours here and copy the commands below.'), agentWrap, false, true));
        card.appendChild(stepBlock(stepHeader(2, endpointMode ? 'Where SecureVector runs' : 'Where should SecureVector run?', null), tabsHost, true, true));
        card.appendChild(stepBlock(stepHeader(3, 'Run these commands where your agents/harnesses are running', null), panel, true, true));
        leftCol.appendChild(card);

        // ---- compact footnotes: "more agents" (inline answer) vs the two
        // pointers (fleet rollout / other tools) kept on separate lines so a
        // platform lead can tell them apart. ----
        const notes = document.createElement('div');
        notes.style.cssText = 'margin-top: 22px; font-size: 12px; color: var(--text-secondary); line-height: 1.75; display: flex; flex-direction: column; gap: 1px;';
        ['Adding more agents? Pick another above and copy its commands (a new framework needs its own SDK install).',
         'Team or fleet rollout → Integrations in the sidebar.',
         'Other tools: n8n · Ollama → Integrations.'].forEach(t => {
            const d = document.createElement('div'); d.textContent = t; notes.appendChild(d);
        });
        leftCol.appendChild(notes);

        container.appendChild(root);

        // Default selection + deep-link. Default to a HARNESS (Claude Code) — a
        // single copy-paste plugin command — so a first-timer isn't greeted by
        // Python SDK code. Framework devs arriving via the deep-link still get A.
        const target = this.scrollTo;
        this.scrollTo = null;
        const firstOfRoute = (r) => this.AGENTS.find(a => a.route === r);
        selectChip(target === 'route-frameworks' ? firstOfRoute('A') : firstOfRoute('B'));
        if (target) {
            requestAnimationFrame(() => {
                const el = document.getElementById(target);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        }
    },
};

window.GuideConnectAgentsPage = GuideConnectAgentsPage;
