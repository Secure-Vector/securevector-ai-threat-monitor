/**
 * Dashboard Page
 * Enhanced overview with stats, charts, and recent activity
 */

/** Auto-start multi-provider proxy and show env vars modal for OpenClaw users when block mode is enabled. */
async function showOpenClawProxyModal() {
    // Start the multi-provider proxy automatically
    try {
        await fetch('/api/proxy/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'openai', multi: true, integration: 'openclaw' })
        });
    } catch { /* proxy start failed — modal still useful */ }

    const providers = [
        ['OPENAI_BASE_URL', 'http://127.0.0.1:8742/openai/v1'],
        ['ANTHROPIC_BASE_URL', 'http://127.0.0.1:8742/anthropic'],
        ['GEMINI_BASE_URL', 'http://127.0.0.1:8742/gemini'],
        ['GROQ_BASE_URL', 'http://127.0.0.1:8742/groq'],
        ['MISTRAL_BASE_URL', 'http://127.0.0.1:8742/mistral'],
        ['XAI_BASE_URL', 'http://127.0.0.1:8742/xai'],
    ];

    const modalContent = document.createElement('div');

    const desc = document.createElement('p');
    desc.style.cssText = 'font-size: 13px; color: var(--text-secondary); margin-bottom: 16px;';
    desc.textContent = 'Set your AI provider base URL to the proxy address, then restart your agent.';
    modalContent.appendChild(desc);

    const grid = document.createElement('div');
    grid.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;';

    const boxOC = document.createElement('div');
    boxOC.style.cssText = 'background: var(--bg-secondary); border: 1px solid var(--border-default); border-radius: 8px; padding: 14px;';
    const boxOCTitle = document.createElement('div');
    boxOCTitle.style.cssText = 'font-weight: 600; font-size: 13px; margin-bottom: 6px;';
    boxOCTitle.textContent = 'OpenClaw / ClawdBot';
    boxOC.appendChild(boxOCTitle);
    const boxOCDesc = document.createElement('div');
    boxOCDesc.style.cssText = 'font-size: 12px; color: var(--text-secondary); margin-bottom: 10px;';
    boxOCDesc.textContent = 'Set baseUrl in openclaw.json provider config:';
    boxOC.appendChild(boxOCDesc);
    const ocCode = document.createElement('div');
    ocCode.style.cssText = 'background: var(--bg-tertiary); border-radius: 6px; padding: 10px; font-family: monospace; font-size: 12px; line-height: 1.6; word-break: break-all;';
    ocCode.textContent = '"baseUrl": "http://127.0.0.1:8742/openai/v1"';
    boxOC.appendChild(ocCode);
    grid.appendChild(boxOC);

    const boxEnv = document.createElement('div');
    boxEnv.style.cssText = 'background: var(--bg-secondary); border: 1px solid var(--border-default); border-radius: 8px; padding: 14px;';
    const boxEnvTitle = document.createElement('div');
    boxEnvTitle.style.cssText = 'font-weight: 600; font-size: 13px; margin-bottom: 6px;';
    boxEnvTitle.textContent = 'Other Agents / Frameworks';
    boxEnv.appendChild(boxEnvTitle);
    const boxEnvDesc = document.createElement('div');
    boxEnvDesc.style.cssText = 'font-size: 12px; color: var(--text-secondary); margin-bottom: 10px;';
    boxEnvDesc.textContent = 'Set the base URL environment variable:';
    boxEnv.appendChild(boxEnvDesc);
    const envCode = document.createElement('div');
    envCode.style.cssText = 'background: var(--bg-tertiary); border-radius: 6px; padding: 10px; font-family: monospace; font-size: 12px; line-height: 1.6; word-break: break-all;';
    envCode.textContent = 'export OPENAI_BASE_URL=http://127.0.0.1:8742/openai/v1';
    boxEnv.appendChild(envCode);
    grid.appendChild(boxEnv);

    modalContent.appendChild(grid);

    const note = document.createElement('p');
    note.style.cssText = 'font-size: 12px; color: var(--text-secondary);';
    note.textContent = 'Supports OpenAI, Anthropic, Gemini, and Ollama. See docs for provider-specific URLs.';
    modalContent.appendChild(note);

    Modal.show({
        title: 'Route Traffic Through Proxy',
        content: modalContent,
        size: 'medium',
        actions: [
            {
                label: 'Go to Proxy Settings',
                primary: false,
                onClick: () => { if (window.Sidebar) Sidebar.navigate('proxy-openclaw'); }
            },
            { label: 'Got it', primary: true }
        ]
    });
}

/** Stop proxy and show instructions to unset env vars and restart OpenClaw. */
async function showOpenClawProxyStopModal() {
    // Stop the proxy (best-effort — may be in-process)
    try {
        await fetch('/api/proxy/stop', { method: 'POST' });
    } catch { /* proxy may not be running or in-process */ }

    const modalContent = document.createElement('div');

    const banner = document.createElement('div');
    banner.style.cssText = 'background: color-mix(in srgb, #f59e0b 15%, var(--bg-card)); border: 1px solid color-mix(in srgb, #f59e0b 40%, var(--border-default)); border-radius: 8px; padding: 12px; margin-bottom: 12px;';
    const bannerStrong = document.createElement('strong');
    bannerStrong.style.color = '#d97706';
    bannerStrong.textContent = 'Action required: ';
    banner.appendChild(bannerStrong);
    const bannerText = document.createElement('span');
    bannerText.style.cssText = 'color: var(--text-primary); font-size: 13px;';
    bannerText.textContent = 'Unset the proxy variables below, then restart OpenClaw. The plugin will continue monitoring without the proxy.';
    banner.appendChild(bannerText);
    modalContent.appendChild(banner);

    const intro = document.createElement('p');
    intro.style.marginBottom = '12px';
    intro.textContent = 'Unset these variables to avoid connection errors:';
    modalContent.appendChild(intro);

    const codeBlock = document.createElement('div');
    codeBlock.style.cssText = 'background: var(--bg-tertiary); border-radius: 6px; padding: 12px; font-family: monospace; font-size: 13px; margin-bottom: 12px; line-height: 1.8;';

    const addLine = (text, color) => {
        const div = document.createElement('div');
        if (color) div.style.color = color;
        div.textContent = text;
        codeBlock.appendChild(div);
    };

    const vars = ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'GEMINI_BASE_URL', 'GROQ_BASE_URL', 'MISTRAL_BASE_URL', 'XAI_BASE_URL'];

    addLine('# Linux / macOS', 'var(--text-secondary)');
    vars.forEach(v => addLine(`unset ${v}`));
    addLine('');
    addLine('# Windows (PowerShell)', 'var(--text-secondary)');
    vars.forEach(v => addLine(`Remove-Item Env:\\${v} -ErrorAction SilentlyContinue`));

    modalContent.appendChild(codeBlock);

    Modal.show({
        title: 'Block Mode Disabled — Restart OpenClaw',
        content: modalContent,
        size: 'medium',
        actions: [{ label: 'Got it', primary: true }]
    });
}

const DashboardPage = {
    data: null,
    threats: null,
    autoRefreshInterval: null,
    autoRefreshEnabled: false,
    currentContainer: null,

    async render(container) {
        this.currentContainer = container;
        container.textContent = '';

        // Loading state
        const loading = document.createElement('div');
        loading.className = 'loading-container';
        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        loading.appendChild(spinner);
        container.appendChild(loading);

        try {
            // Fetch analytics and recent threats
            const [analytics, threats] = await Promise.all([
                API.getThreatAnalytics(),
                API.getThreats({ page_size: 50 }),
            ]);
            this.data = analytics;
            this.threats = threats.items || [];
            this.renderContent(container);
        } catch (error) {
            this.renderError(container, error);
        }
    },

    async renderContent(container) {
        container.textContent = '';

        // NOTE: OpenClaw plugin nudge + "What's new" card now live as app-level
        // global banners (components/global-banners.js) so they appear on every
        // page and persist across navigation. Don't add them here.
        if (false) {  // eslint-disable-line no-constant-condition
        try {
            const hooksStatus = await fetch('/api/hooks/status').then(r => r.ok ? r.json() : null).catch(() => null);
            const dismissed = localStorage.getItem('sv-openclaw-banner-dismissed') === '1';
            if (hooksStatus && hooksStatus.openclaw_detected && !hooksStatus.installed && !dismissed) {
                const banner = document.createElement('div');
                banner.className = 'sv-dash-banner';
                banner.style.cssText = 'position: relative; display: flex; align-items: center; gap: 16px; padding: 14px 44px 14px 16px; background: var(--bg-card); border: 1px solid var(--border-default); border-left: 3px solid var(--accent-primary); border-radius: 8px; margin-bottom: 16px;';

                // Icon — compact, accent-tinted
                const icon = document.createElement('div');
                icon.style.cssText = 'flex-shrink: 0; width: 36px; height: 36px; background: rgba(94,173,184,0.14); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 18px; line-height: 1;';
                icon.textContent = '\u26A1';
                icon.setAttribute('aria-hidden', 'true');
                banner.appendChild(icon);

                // Text column
                const textCol = document.createElement('div');
                textCol.style.cssText = 'flex: 1; min-width: 0;';

                // Title row — headline + small "RECOMMENDED" pill
                const titleRow = document.createElement('div');
                titleRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 3px; flex-wrap: wrap;';

                const title = document.createElement('div');
                title.style.cssText = 'font-size: 13px; font-weight: 700; color: var(--text-primary); line-height: 1.3;';
                title.textContent = 'Run SecureVector natively inside OpenClaw';
                titleRow.appendChild(title);

                const pill = document.createElement('span');
                pill.style.cssText = 'font-size: 9.5px; font-weight: 700; letter-spacing: 0.5px; color: var(--accent-primary); background: rgba(94,173,184,0.12); border: 1px solid rgba(94,173,184,0.3); padding: 2px 6px; border-radius: 4px; text-transform: uppercase;';
                pill.textContent = 'Recommended';
                titleRow.appendChild(pill);

                textCol.appendChild(titleRow);

                const desc = document.createElement('div');
                desc.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.45;';
                desc.textContent = 'Zero latency. Full audit trail. No proxy or env vars required.';
                textCol.appendChild(desc);

                banner.appendChild(textCol);

                // Primary CTA — an actual button, not a text link
                const cta = document.createElement('button');
                cta.style.cssText = 'flex-shrink: 0; font-size: 12px; font-weight: 600; color: #fff; background: var(--accent-primary); border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; white-space: nowrap; transition: opacity 0.15s, transform 0.05s;';
                cta.textContent = 'Install plugin';
                cta.addEventListener('mouseenter', () => { cta.style.opacity = '0.9'; });
                cta.addEventListener('mouseleave', () => { cta.style.opacity = '1'; });
                cta.addEventListener('mousedown', () => { cta.style.transform = 'scale(0.98)'; });
                cta.addEventListener('mouseup', () => { cta.style.transform = 'scale(1)'; });
                cta.addEventListener('click', () => {
                    if (window.Sidebar) { Sidebar.expandSection('integrations'); Sidebar.navigate('proxy-openclaw'); }
                });
                banner.appendChild(cta);

                // Dismiss — absolute-positioned in corner, visually out of the way
                const dismissBtn = document.createElement('button');
                dismissBtn.style.cssText = 'position: absolute; top: 8px; right: 10px; background: transparent; border: none; color: var(--text-muted); font-size: 16px; cursor: pointer; padding: 2px 6px; line-height: 1; border-radius: 4px; transition: color 0.15s, background 0.15s;';
                dismissBtn.title = 'Dismiss';
                dismissBtn.setAttribute('aria-label', 'Dismiss');
                dismissBtn.textContent = '\u00D7';
                dismissBtn.addEventListener('mouseenter', () => { dismissBtn.style.color = 'var(--text-primary)'; dismissBtn.style.background = 'var(--bg-secondary)'; });
                dismissBtn.addEventListener('mouseleave', () => { dismissBtn.style.color = 'var(--text-muted)'; dismissBtn.style.background = 'transparent'; });
                dismissBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    localStorage.setItem('sv-openclaw-banner-dismissed', '1');
                    banner.remove();
                });
                banner.appendChild(dismissBtn);

                container.appendChild(banner);
            }
        } catch (e) { /* banner is non-critical */ }

        // What's New — one-time per-version announcement card
        try {
            const WHATS_NEW_VERSION = '3.4.0';
            const ackKey = 'sv-whats-new-acked';
            const ackedVersion = localStorage.getItem(ackKey);
            if (ackedVersion !== WHATS_NEW_VERSION) {
                const card = document.createElement('div');
                card.className = 'sv-dash-banner';
                card.style.cssText = 'position: relative; background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 8px; padding: 16px 44px 16px 18px; margin-bottom: 16px;';

                // Header row — version tag + title
                const header = document.createElement('div');
                header.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap;';

                const tag = document.createElement('span');
                tag.style.cssText = 'font-size: 10px; font-weight: 700; letter-spacing: 0.6px; color: var(--accent-primary); background: rgba(94,173,184,0.12); border: 1px solid rgba(94,173,184,0.3); padding: 3px 8px; border-radius: 4px; text-transform: uppercase;';
                tag.textContent = `v${WHATS_NEW_VERSION}`;
                header.appendChild(tag);

                const headerTitle = document.createElement('div');
                headerTitle.style.cssText = 'font-size: 14px; font-weight: 700; color: var(--text-primary);';
                headerTitle.textContent = 'What\u2019s new';
                header.appendChild(headerTitle);

                card.appendChild(header);

                // Feature list
                const list = document.createElement('div');
                list.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px 16px;';
                const items = [
                    { icon: '\u26A1', title: 'Native OpenClaw plugin',  body: 'Zero-latency input, output, tool, and cost monitoring \u2014 no proxy required.' },
                    { icon: '\uD83D\uDEE0', title: 'Tool audit trail',   body: 'Every tool call your agent makes \u2014 allow, block, or log\u2011only \u2014 recorded automatically.' },
                    { icon: '\uD83D\uDCB0', title: 'Cost tracking updates', body: 'Refreshed cost tracking for 76 models, incl. Opus 4.7, GPT\u20115.4, Gemini 3.x, MiniMax M2.7.' },
                    { icon: '\uD83D\uDD0D', title: 'Skill Scanner + policy',   body: 'Static analysis for agent skills with trusted publishers and per-category rules.' },
                ];
                items.forEach(({ icon, title, body }) => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display: flex; align-items: flex-start; gap: 10px;';
                    const ico = document.createElement('div');
                    ico.style.cssText = 'flex-shrink: 0; width: 28px; height: 28px; background: var(--bg-secondary); border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 14px; line-height: 1;';
                    ico.textContent = icon;
                    row.appendChild(ico);
                    const col = document.createElement('div');
                    col.style.cssText = 'min-width: 0;';
                    const t = document.createElement('div');
                    t.style.cssText = 'font-size: 12.5px; font-weight: 700; color: var(--text-primary); margin-bottom: 2px; line-height: 1.3;';
                    t.textContent = title;
                    col.appendChild(t);
                    const b = document.createElement('div');
                    b.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.45;';
                    b.textContent = body;
                    col.appendChild(b);
                    row.appendChild(col);
                    list.appendChild(row);
                });
                card.appendChild(list);

                // Footer row — "Open Guide" link + dismiss
                const footer = document.createElement('div');
                footer.style.cssText = 'display: flex; align-items: center; justify-content: flex-start; gap: 14px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border-default);';

                const guideLink = document.createElement('button');
                guideLink.style.cssText = 'background: transparent; border: none; color: var(--accent-primary); font-size: 12px; font-weight: 600; cursor: pointer; padding: 0;';
                guideLink.textContent = 'Open the Guide \u2192';
                guideLink.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('guide'); });
                footer.appendChild(guideLink);

                const gotIt = document.createElement('button');
                gotIt.style.cssText = 'margin-left: auto; background: var(--accent-primary); color: #fff; border: none; font-size: 12px; font-weight: 600; padding: 7px 14px; border-radius: 6px; cursor: pointer; transition: opacity 0.15s;';
                gotIt.textContent = 'Got it';
                gotIt.addEventListener('mouseenter', () => { gotIt.style.opacity = '0.9'; });
                gotIt.addEventListener('mouseleave', () => { gotIt.style.opacity = '1'; });
                gotIt.addEventListener('click', () => {
                    localStorage.setItem(ackKey, WHATS_NEW_VERSION);
                    card.remove();
                });
                footer.appendChild(gotIt);

                card.appendChild(footer);

                // Corner dismiss (equivalent to "Got it")
                const closeBtn = document.createElement('button');
                closeBtn.style.cssText = 'position: absolute; top: 8px; right: 10px; background: transparent; border: none; color: var(--text-muted); font-size: 16px; cursor: pointer; padding: 2px 6px; line-height: 1; border-radius: 4px; transition: color 0.15s, background 0.15s;';
                closeBtn.title = 'Dismiss';
                closeBtn.setAttribute('aria-label', 'Dismiss');
                closeBtn.textContent = '\u00D7';
                closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = 'var(--text-primary)'; closeBtn.style.background = 'var(--bg-secondary)'; });
                closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = 'var(--text-muted)'; closeBtn.style.background = 'transparent'; });
                closeBtn.addEventListener('click', () => {
                    localStorage.setItem(ackKey, WHATS_NEW_VERSION);
                    card.remove();
                });
                card.appendChild(closeBtn);

                container.appendChild(card);
            }
        } catch (e) { /* whats-new is non-critical */ }
        }  // end if (false) — legacy banner code superseded by GlobalBanners

        // Budget guardian alerts — rendered first so they're impossible to miss
        try {
            const gd = await API.getBudgetGuardian();
            if (gd) {
                const hasGlobalAlert = gd.global_budget_usd != null && (gd.global_over_budget || gd.global_warning);
                const hasAgentAlerts = gd.agent_alerts && gd.agent_alerts.some(a => a.over_budget || a.warning);
                if (hasGlobalAlert || hasAgentAlerts) {
                    const alertsBox = document.createElement('div');
                    alertsBox.style.cssText = 'margin-bottom: 16px; display: flex; flex-direction: column; gap: 8px;';

                    const buildBudgetBar = (label, today, budget, pct, over, action) => {
                        const overColor = 'rgba(220,38,38,0.75)';
                        const warnColor = 'rgba(180,130,0,0.75)';
                        const color = over ? overColor : warnColor;
                        const bar = document.createElement('div');
                        bar.style.cssText = `padding: 10px 14px; border-radius: 8px; border: 1px solid ${color}; background: ${over ? 'rgba(220,38,38,0.06)' : 'rgba(180,130,0,0.06)'}; display: flex; align-items: center; gap: 12px;`;

                        const info = document.createElement('div');
                        info.style.cssText = 'flex: 1; min-width: 0;';

                        const infoTop = document.createElement('div');
                        infoTop.style.cssText = 'font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;';
                        infoTop.textContent = `${label}: $${today.toFixed(4)} of $${budget.toFixed(2)} today (${Math.round(pct * 100)}%)`;
                        info.appendChild(infoTop);

                        const track = document.createElement('div');
                        track.style.cssText = 'height: 5px; border-radius: 3px; background: var(--bg-tertiary); overflow: hidden;';
                        const fill = document.createElement('div');
                        fill.style.cssText = `height: 100%; border-radius: 3px; background: ${color}; width: ${Math.min(pct * 100, 100)}%;`;
                        track.appendChild(fill);
                        info.appendChild(track);
                        bar.appendChild(info);

                        const badge = document.createElement('span');
                        badge.className = over && action === 'block' ? 'badge badge-error' : 'badge badge-warning';
                        badge.textContent = over && action === 'block' ? 'Blocked' : over ? 'Over limit' : '80%+ used';
                        bar.appendChild(badge);

                        const goBtn = document.createElement('button');
                        goBtn.className = 'btn btn-secondary btn-sm';
                        goBtn.textContent = 'View →';
                        goBtn.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('cost-settings'); });
                        bar.appendChild(goBtn);

                        return bar;
                    };

                    if (hasGlobalAlert) {
                        alertsBox.appendChild(buildBudgetBar(
                            'Global budget', gd.global_today_spend_usd,
                            gd.global_budget_usd, gd.global_pct_used,
                            gd.global_over_budget, gd.global_budget_action
                        ));
                    }
                    if (hasAgentAlerts) {
                        gd.agent_alerts.filter(a => a.over_budget || a.warning).forEach(a => {
                            alertsBox.appendChild(buildBudgetBar(
                                a.agent_id.length > 28 ? a.agent_id.slice(0, 28) + '…' : a.agent_id,
                                a.today_spend_usd, a.budget_usd, a.pct_used,
                                a.over_budget, a.budget_action
                            ));
                        });
                    }
                    container.appendChild(alertsBox);
                }
            }
        } catch (e) { /* budget alerts are non-critical */ }

        // ── Compact status bar + metrics grid ──────────────────────────────
        try {
            const valueSection = document.createElement('div');
            valueSection.style.cssText = 'margin-bottom: 18px;';

            // Fetch additional data in parallel
            const [toolsData, settings, scanHistory, costData] = await Promise.all([
                API.getEssentialTools().catch(() => null),
                API.getSettings().catch(() => null),
                fetch('/api/skill-scans/history?limit=10&offset=0').then(r => r.ok ? r.json() : null).catch(() => null),
                API.getDashboardCostSummary().catch(() => null),
            ]);

            const blockedTools = toolsData ? toolsData.tools.filter(t => t.effective_action === 'block').length : 0;
            const totalTools = toolsData ? toolsData.tools.length : 0;
            const toolEnforcement = settings && settings.tool_permissions_enabled;
            const blockMode = settings && settings.block_threats;
            const outputScan = settings && settings.scan_llm_responses;
            const skillScans = scanHistory ? (scanHistory.total || (scanHistory.records || []).length) : 0;
            // Format: $0.00 when zero or sub-cent (4-decimal precision feels
            // performative on a dashboard); $0.0123 only when the amount is
            // small but non-trivial. Two decimals once you've crossed $1.
            const _formatCost = (n) => {
                if (!n || n < 0.005) return '$0.00';
                if (n < 1) return '$' + n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
                return '$' + n.toFixed(2);
            };
            const todayCost = costData ? _formatCost(costData.today_cost_usd || 0) : '$0.00';

            const avgLatencyMs = this.data.avg_latency_ms;
            let latencyStr = '\u2014';
            if (avgLatencyMs != null) {
                latencyStr = avgLatencyMs >= 1000
                    ? (avgLatencyMs / 1000).toFixed(1) + 's'
                    : Math.round(avgLatencyMs) + 'ms';
            }

            // Compact status bar \u2014 just the live-state indicator. The counts
            // it used to repeat (requests scanned / blocked / skills) live in
            // the metric tiles directly below, so we don't double-print them.
            const statusBar = document.createElement('div');
            statusBar.style.cssText = 'display: flex; align-items: center; gap: 10px; padding: 8px 14px; background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 8px; margin-bottom: 14px; font-size: 12px;';
            const statusDot = document.createElement('span');
            statusDot.style.cssText = 'width: 8px; height: 8px; border-radius: 50%; background: #10b981; flex-shrink: 0;';
            statusBar.appendChild(statusDot);
            const statusLabel = document.createElement('span');
            statusLabel.style.cssText = 'font-weight: 600; color: var(--text-primary);';
            statusLabel.textContent = 'Monitoring active';
            statusBar.appendChild(statusLabel);
            const statusSep = document.createElement('span');
            statusSep.style.cssText = 'color: var(--text-muted);';
            statusSep.textContent = '\u00b7';
            statusBar.appendChild(statusSep);
            const statusHint = document.createElement('span');
            statusHint.style.cssText = 'color: var(--text-secondary);';
            statusHint.textContent = 'Last 7 days';
            statusBar.appendChild(statusHint);
            valueSection.appendChild(statusBar);

            // Value metrics grid
            const metricsGrid = document.createElement('div');
            metricsGrid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 14px;';

            const makeMetric = (value, label, color, navPage) => {
                const card = document.createElement('div');
                card.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 8px; padding: 12px 14px; cursor: pointer; transition: border-color 0.15s, transform 0.1s;';
                card.addEventListener('mouseenter', () => { card.style.borderColor = color + '66'; card.style.transform = 'translateY(-1px)'; });
                card.addEventListener('mouseleave', () => { card.style.borderColor = 'var(--border-default)'; card.style.transform = ''; });
                if (navPage) card.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate(navPage); });

                const valEl = document.createElement('div');
                valEl.style.cssText = 'font-size: 20px; font-weight: 800; color: ' + color + '; line-height: 1.1; margin-bottom: 4px;';
                valEl.textContent = value;
                card.appendChild(valEl);

                const lblEl = document.createElement('div');
                lblEl.style.cssText = 'font-size: 11px; color: var(--text-secondary); font-weight: 500; line-height: 1.3;';
                lblEl.textContent = label;
                card.appendChild(lblEl);

                return card;
            };

            metricsGrid.appendChild(makeMetric(
                this.data.total_threats.toLocaleString(),
                'Requests scanned',
                '#5eadb8', 'threats'
            ));
            metricsGrid.appendChild(makeMetric(
                this.data.critical_count || 0,
                'Critical threats',
                this.data.critical_count > 0 ? '#ef4444' : '#10b981', 'threats'
            ));
            metricsGrid.appendChild(makeMetric(
                this.data.blocked_count || 0,
                'Threats blocked',
                this.data.blocked_count > 0 ? '#ef4444' : '#10b981', 'threats'
            ));
            metricsGrid.appendChild(makeMetric(
                blockedTools + '/' + totalTools,
                'Risky tools blocked',
                blockedTools > 0 ? '#f59e0b' : '#94a3b8', 'tool-permissions'
            ));
            metricsGrid.appendChild(makeMetric(
                skillScans,
                'Skills scanned',
                '#5eadb8', 'skill-scanner'
            ));
            metricsGrid.appendChild(makeMetric(
                latencyStr,
                'Avg analysis time',
                '#8b5cf6', null
            ));
            metricsGrid.appendChild(makeMetric(
                todayCost,
                "Today's cost",
                '#f59e0b', 'costs'
            ));

            valueSection.appendChild(metricsGrid);

            container.appendChild(valueSection);
        } catch (e) { /* value section is non-critical */ }

        // Reports — surface immediately under the overview metrics so the
        // weekly artifacts (Tool Inventory, Secret Detections, Threats) are
        // one glance away.
        this.renderReportsSection(container);

        // Charts row — threat trend + cost trend side by side
        const chartsRow = document.createElement('div');
        chartsRow.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px;';

        const trendCard = Card.create({ title: 'LLM Requests — Last 7 Days', gradient: true });
        this.renderTrendChart(trendCard.querySelector('.card-body'));
        chartsRow.appendChild(trendCard);

        const costTrendCard = Card.create({ title: 'Provider Cost — Last 7 Days', gradient: true });
        const costBody = costTrendCard.querySelector('.card-body');
        // Show a lightweight placeholder and populate this chart WITHOUT
        // awaiting it. When there's no provider cost we fall back to the
        // token-usage chart, whose endpoints walk on-disk agent session logs
        // (~1.7s for Claude Code transcripts). Awaiting here previously blocked
        // the whole charts row AND everything rendered below it (security
        // controls, recent activity). Fire-and-forget so the page is
        // interactive immediately; the chart fills in when its data arrives.
        costBody.innerHTML = '<div class="loading-container" style="height:140px;"><div class="spinner"></div></div>';
        chartsRow.appendChild(costTrendCard);
        this.renderCostTrendChart(costBody, costTrendCard).catch(() => {
            costBody.innerHTML = '<div style="height:140px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;">Chart unavailable</div>';
        });

        container.appendChild(chartsRow);

        // Security Controls — moved adjacent to Recent Activity since they're
        // the "see threats / shape your response" pair. Previously they sat
        // between Reports and the charts which was a context break.
        const securityControls = await this.renderSecurityControls();
        container.appendChild(securityControls);

        // Recent activity
        const activityCard = Card.create({ title: 'Recent Threat Activity', gradient: true });
        this.renderRecentActivity(activityCard.querySelector('.card-body'));
        container.appendChild(activityCard);
    },

    renderReportsSection(container) {
        const section = document.createElement('div');
        section.style.cssText = 'margin-bottom:16px;';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:baseline;gap:10px;margin-bottom:10px;';
        const h = document.createElement('h2');
        h.textContent = 'Reports';
        h.style.cssText = 'margin:0;font-size:16px;color:var(--text-primary);';
        const sub = document.createElement('span');
        sub.textContent = 'Last 7 days — CSV here, or open the page for the rich PDF.';
        sub.style.cssText = 'font-size:12px;color:var(--text-secondary);';
        header.appendChild(h);
        header.appendChild(sub);
        section.appendChild(header);

        const grid = document.createElement('div');
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;';
        section.appendChild(grid);

        // Build the three cards with placeholder "—" stats, then patch them
        // with live counts in the background. Render-then-fill avoids a
        // blocking await inside renderContent (keeps the dashboard snappy).
        const ti = this._reportCard({
            title: 'Tool Inventory',
            blurb: 'Per-device SBOM for AI tools — every (server, tool) your agents called.',
            openPage: 'bill-of-tools',
            onCsv: () => this._exportReportCsv('tool-inventory'),
        });
        const sd = this._reportCard({
            title: 'Secret Detections',
            blurb: 'Credentials and PII caught and scrubbed mid-flight.',
            openPage: 'redactions',
            onCsv: () => this._exportReportCsv('secret-detections'),
        });
        const th = this._reportCard({
            title: 'Threats',
            blurb: 'Full threat scan log — rule hits, severity, action taken.',
            openPage: 'threats',
            onCsv: () => {
                if (window.App && App.loadPage) {
                    App.loadPage('threats');
                    if (window.Toast) Toast.show('Use Export CSV on the Threats page (filters apply).', 'info');
                }
            },
        });
        grid.appendChild(ti);
        grid.appendChild(sd);
        grid.appendChild(th);
        container.appendChild(section);

        // Fill live stats in the background — each card's stat slot is the
        // first .sv-report-stats element inside it.
        this._populateReportStats(ti, sd, th);
    },

    async _populateReportStats(toolInventoryCard, secretDetectionsCard, threatsCard) {
        const setStats = (card, parts) => {
            const slot = card.querySelector('.sv-report-stats');
            if (!slot) return;
            slot.textContent = '';
            parts.forEach((p, i) => {
                if (i > 0) {
                    const sep = document.createElement('span');
                    sep.style.cssText = 'color:var(--border-default);';
                    sep.textContent = ' · ';
                    slot.appendChild(sep);
                }
                const strong = document.createElement('strong');
                strong.style.cssText = 'color:var(--text-primary);font-weight:700;';
                strong.textContent = p.value;
                slot.appendChild(strong);
                slot.appendChild(document.createTextNode(' ' + p.label));
            });
        };

        try {
            const billPromise = (window.API && API.getBillOfTools) ? API.getBillOfTools(7) : Promise.resolve(null);
            const redactPromise = (window.API && API.getRedactions) ? API.getRedactions(7) : Promise.resolve(null);
            const [bill, redact] = await Promise.all([
                billPromise.catch(() => null),
                redactPromise.catch(() => null),
            ]);

            if (bill && Array.isArray(bill.rows)) {
                const rows = bill.rows;
                const totalCalls = rows.reduce((acc, r) => acc + (r.calls || 0), 0);
                const distinctServers = new Set(rows.map(r => r.server).filter(Boolean)).size;
                setStats(toolInventoryCard, [
                    { value: totalCalls.toLocaleString(), label: 'calls' },
                    { value: rows.length.toLocaleString(), label: 'tools' },
                    { value: distinctServers.toLocaleString(), label: 'servers' },
                ]);
            }

            if (redact && redact.summary) {
                const total = redact.summary.total ?? 0;
                const tools = redact.summary.distinct_tools ?? 0;
                const incoming = (redact.summary.by_direction || {}).incoming ?? 0;
                setStats(secretDetectionsCard, [
                    { value: total.toLocaleString(), label: 'detected' },
                    { value: tools.toLocaleString(), label: 'tools' },
                    { value: incoming.toLocaleString(), label: 'incoming' },
                ]);
            }
        } catch (_) { /* stats are non-critical */ }

        // Threats — use the analytics already loaded for the rest of the
        // dashboard. Falls back gracefully if data hasn't landed yet.
        if (this.data) {
            const total = this.data.total_threats || 0;
            const blocked = this.data.blocked_count || 0;
            const critical = this.data.critical_count || 0;
            setStats(threatsCard, [
                { value: total.toLocaleString(), label: 'scanned' },
                { value: blocked.toLocaleString(), label: 'blocked' },
                { value: critical.toLocaleString(), label: 'critical' },
            ]);
        }
    },

    _reportCard({ title, blurb, openPage, onCsv }) {
        // Match the visual treatment of sibling Card.create({gradient:true})
        // sections (bg-card + subtle gradient via accent-tinted border-top).
        const card = document.createElement('div');
        card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border-default);border-top:2px solid rgba(94,173,184,0.45);border-radius:8px;padding:14px 16px;display:flex;flex-direction:column;gap:8px;min-width:0;';

        const h = document.createElement('h3');
        h.textContent = title;
        h.style.cssText = 'margin:0;font-size:14px;font-weight:700;color:var(--text-primary);';
        card.appendChild(h);

        // Live stats line — populated by _populateReportStats. Renders a
        // single em-dash while waiting so the layout doesn't jump.
        const stats = document.createElement('div');
        stats.className = 'sv-report-stats';
        stats.style.cssText = 'font-size:12px;color:var(--text-secondary);line-height:1.4;min-height:17px;';
        stats.textContent = '—';
        card.appendChild(stats);

        const sub = document.createElement('div');
        sub.textContent = blurb;
        sub.style.cssText = 'font-size:12px;color:var(--text-secondary);line-height:1.5;flex:1;';
        card.appendChild(sub);

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;';

        const csvBtn = document.createElement('button');
        csvBtn.className = 'sv-btn-secondary';
        csvBtn.textContent = 'Export CSV';
        csvBtn.style.cssText = 'padding:5px 10px;font-size:12px;';
        csvBtn.addEventListener('click', onCsv);
        actions.appendChild(csvBtn);

        const viewBtn = document.createElement('button');
        viewBtn.className = 'sv-btn-secondary';
        viewBtn.textContent = 'View report →';
        viewBtn.style.cssText = 'padding:5px 10px;font-size:12px;';
        viewBtn.addEventListener('click', () => {
            if (window.App && App.loadPage) App.loadPage(openPage);
        });
        actions.appendChild(viewBtn);

        card.appendChild(actions);
        return card;
    },

    async _exportReportCsv(kind) {
        const days = 7;
        const escape = (v) => {
            const s = String(v ?? '');
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const triggerDownload = (filenameBase, headers, rows) => {
            if (rows.length === 0) {
                if (window.Toast) Toast.show('No data in the last 7 days', 'info');
                return;
            }
            const csvBody = rows.map((r) => headers.map((h) => escape(r[h])).join(',')).join('\n');
            const csv = headers.join(',') + '\n' + csvBody;
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const stamp = new Date().toISOString().slice(0, 10);
            a.download = `securevector-${filenameBase}-${stamp}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        };

        try {
            if (kind === 'tool-inventory') {
                const data = await API.getBillOfTools(days);
                const rows = (data.rows || []).map((r) => ({
                    server: r.server || '',
                    tool: r.tool || '',
                    harness: r.harness || '',
                    source: r.source || '',
                    auth_scope: r.auth_scope || '',
                    last_used: r.last_used || '',
                    calls: r.calls ?? 0,
                    blocked: r.blocked ?? 0,
                    touched_secrets: r.touched_secrets ? 'yes' : 'no',
                    policy_name: r.policy_name || '',
                    policy_org: r.policy_org || '',
                }));
                triggerDownload('tool-inventory',
                    ['server','tool','harness','source','auth_scope','last_used','calls','blocked','touched_secrets','policy_name','policy_org'],
                    rows);
            } else if (kind === 'secret-detections') {
                const data = await API.getRedactions(days);
                const rows = (data.events || []).map((e) => ({
                    time: e.redacted_at || '',
                    direction: e.direction || '',
                    harness: e.runtime_kind || '',
                    pattern_id: e.pattern_id || '',
                    secret_type: e.secret_type || '',
                    source_tool: e.source_tool_id || e.source_tool || '',
                    request_id: e.request_id || '',
                    redaction_hash: e.redaction_hash || '',
                }));
                triggerDownload('secret-detections',
                    ['time','direction','harness','pattern_id','secret_type','source_tool','request_id','redaction_hash'],
                    rows);
            }
        } catch (e) {
            if (window.Toast) Toast.show('Export failed: ' + (e?.message || e), 'error');
        }
    },

    createStatCard(stat) {
        const card = document.createElement('div');
        card.className = 'stat-card stat-' + (stat.color || 'primary');
        if (stat.tooltip) {
            card.style.cursor = 'help';
            card.title = stat.tooltip;
        }

        const iconWrap = document.createElement('div');
        iconWrap.className = 'stat-icon';
        iconWrap.appendChild(this.createIcon(stat.icon));
        card.appendChild(iconWrap);

        const content = document.createElement('div');
        content.className = 'stat-content';

        const value = document.createElement('div');
        value.className = 'stat-value';
        value.textContent = stat.raw ? stat.value : stat.value + (stat.suffix || '');
        content.appendChild(value);

        const labelRow = document.createElement('div');
        labelRow.style.cssText = 'display: flex; align-items: center; gap: 4px;';

        const label = document.createElement('div');
        label.className = 'stat-label';
        label.textContent = stat.label;
        labelRow.appendChild(label);

        if (stat.tooltip) {
            const hint = document.createElement('span');
            hint.style.cssText = 'font-size: 10px; color: var(--text-muted); line-height: 1; flex-shrink: 0;';
            hint.textContent = 'ⓘ';
            labelRow.appendChild(hint);
        }

        content.appendChild(labelRow);
        card.appendChild(content);
        return card;
    },

    createIcon(name) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');

        const paths = {
            shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
            alert: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
            activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
            gauge: 'M12 2a10 10 0 1 0 10 10H12V2zM12 12l6-6',
            check: 'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3',
            clock: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2',
        };

        const pathData = paths[name] || paths.shield;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', pathData);
        svg.appendChild(path);

        return svg;
    },

    getAverageRiskScore() {
        if (!this.threats || this.threats.length === 0) return 0;
        const total = this.threats.reduce((sum, t) => sum + (t.risk_score || 0), 0);
        return Math.round(total / this.threats.length);
    },

    getAverageLatency() {
        if (!this.threats || this.threats.length === 0) return 0;
        const total = this.threats.reduce((sum, t) => sum + (t.processing_time_ms || 0), 0);
        return Math.round(total / this.threats.length);
    },

    getRiskColor(score) {
        if (score >= 80) return 'danger';
        if (score >= 60) return 'warning';
        if (score >= 40) return 'info';
        return 'success';
    },

    renderRiskDistribution(container) {
        // Group threats by risk level
        const levels = { critical: 0, high: 0, medium: 0, low: 0 };

        this.threats.forEach(t => {
            const score = t.risk_score || 0;
            if (score >= 80) levels.critical++;
            else if (score >= 60) levels.high++;
            else if (score >= 40) levels.medium++;
            else levels.low++;
        });

        const total = Object.values(levels).reduce((a, b) => a + b, 0);

        if (total === 0) {
            const empty = document.createElement('p');
            empty.className = 'empty-state-inline';
            empty.textContent = 'No threat data yet';
            container.appendChild(empty);
            return;
        }

        const chart = document.createElement('div');
        chart.className = 'risk-donut-chart';

        // Donut chart visualization
        const donut = document.createElement('div');
        donut.className = 'donut-container';

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('class', 'donut-svg');

        let currentAngle = -90;
        const colors = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#60a5fa' };
        const radius = 40;
        const cx = 50, cy = 50;

        Object.entries(levels).forEach(([level, count]) => {
            if (count === 0) return;

            const angle = (count / total) * 360;
            const startAngle = currentAngle;
            const endAngle = currentAngle + angle;

            const x1 = cx + radius * Math.cos((startAngle * Math.PI) / 180);
            const y1 = cy + radius * Math.sin((startAngle * Math.PI) / 180);
            const x2 = cx + radius * Math.cos((endAngle * Math.PI) / 180);
            const y2 = cy + radius * Math.sin((endAngle * Math.PI) / 180);

            const largeArc = angle > 180 ? 1 : 0;

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M ' + cx + ' ' + cy + ' L ' + x1 + ' ' + y1 + ' A ' + radius + ' ' + radius + ' 0 ' + largeArc + ' 1 ' + x2 + ' ' + y2 + ' Z');
            path.setAttribute('fill', colors[level]);
            path.setAttribute('class', 'donut-segment');
            svg.appendChild(path);

            currentAngle = endAngle;
        });

        // Center hole
        const hole = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        hole.setAttribute('cx', '50');
        hole.setAttribute('cy', '50');
        hole.setAttribute('r', '25');
        hole.setAttribute('fill', 'var(--bg-secondary)');
        svg.appendChild(hole);

        // Center text
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', '50');
        text.setAttribute('y', '53');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', 'var(--text-primary)');
        text.setAttribute('font-size', '14');
        text.setAttribute('font-weight', '600');
        text.textContent = total;
        svg.appendChild(text);

        donut.appendChild(svg);
        chart.appendChild(donut);

        // Legend
        const legend = document.createElement('div');
        legend.className = 'chart-legend';

        Object.entries(levels).forEach(([level, count]) => {
            const item = document.createElement('div');
            item.className = 'legend-item';

            const dot = document.createElement('span');
            dot.className = 'legend-dot';
            dot.style.background = colors[level];
            item.appendChild(dot);

            const label = document.createElement('span');
            label.className = 'legend-label';
            label.textContent = level.charAt(0).toUpperCase() + level.slice(1);
            item.appendChild(label);

            const value = document.createElement('span');
            value.className = 'legend-value';
            value.textContent = count;
            item.appendChild(value);

            legend.appendChild(item);
        });

        chart.appendChild(legend);
        container.appendChild(chart);
    },

    renderThreatTypes(container) {
        const types = this.data.threat_types || {};

        if (Object.keys(types).length === 0) {
            const empty = document.createElement('p');
            empty.className = 'empty-state-inline';
            empty.textContent = 'No threat categories yet';
            container.appendChild(empty);
            return;
        }

        const entries = Object.entries(types).sort((a, b) => b[1] - a[1]);
        const maxCount = Math.max(...entries.map(e => e[1]));

        const chart = document.createElement('div');
        chart.className = 'horizontal-bar-chart';

        entries.slice(0, 5).forEach(([type, count], index) => {
            const row = document.createElement('div');
            row.className = 'bar-row';

            const label = document.createElement('div');
            label.className = 'bar-label';
            label.textContent = this.formatType(type);
            row.appendChild(label);

            const barWrap = document.createElement('div');
            barWrap.className = 'bar-wrap';

            const bar = document.createElement('div');
            bar.className = 'bar bar-' + (index % 4);
            const percentage = maxCount > 0 ? (count / maxCount) * 100 : 0;
            bar.style.width = '0%';
            // Animate bar
            setTimeout(() => {
                bar.style.width = percentage + '%';
            }, 100 + index * 50);
            barWrap.appendChild(bar);

            const countEl = document.createElement('span');
            countEl.className = 'bar-count';
            countEl.textContent = count;
            barWrap.appendChild(countEl);

            row.appendChild(barWrap);
            chart.appendChild(row);
        });

        container.appendChild(chart);
    },

    /**
     * Reusable SVG line/area timeline chart.
     *
     * Replaces the prior column-bar charts. The dashboard surface
     * benefits from a continuous-time mental model — bars segregate
     * each day into a vertical silo, while a line traces the trend
     * across days and makes spikes/dips visually obvious.
     *
     * Renderer: pure SVG, no deps. Smooth path via Catmull-Rom
     * approximation through midpoints (cardinal-spline-lite). Filled
     * area under each line at low alpha so the line stays the focus.
     * Hover dots + tooltips per data point. Y-axis: max + midpoint
     * grid line. X-axis: day labels at each bucket.
     *
     * opts:
     *   - title: optional inline header (omitted — the Card already
     *            wraps with a title)
     *   - series: [{ label, color, data: number[], format?: fn(n)→str }]
     *             All series MUST share the same x-axis (buckets) length.
     *   - labels: string[] — x-axis tick labels, same length as data
     *   - yFormat: fn(n) → str — Y-axis tick formatter (default: integer)
     *   - height: chart height in px (default 140)
     */
    _renderTimelineChart(container, opts) {
        const series = opts.series || [];
        const labels = opts.labels || [];
        const height = opts.height || 140;
        const yFormat = opts.yFormat || (n => Math.round(n).toLocaleString());
        if (series.length === 0 || labels.length === 0) return;
        // Clear any prior content (e.g. the async "Loading…" placeholder the
        // cost/token card shows while its on-disk data is fetched).
        container.textContent = '';

        const n = labels.length;
        // Compute the per-series max separately, then the global max for
        // scale. A single shared y-axis keeps the two series comparable.
        const allValues = series.flatMap(s => s.data || []);
        const maxVal = Math.max(...allValues, 1);
        // Round up to a "nice" max so the y-tick labels are clean.
        const niceMax = (() => {
            if (maxVal <= 10) return Math.ceil(maxVal);
            const pow = Math.pow(10, Math.floor(Math.log10(maxVal)));
            const norm = maxVal / pow;
            const rounded = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
            return rounded * pow;
        })();

        // SVG layout — fixed paddings so labels never get cropped.
        const padL = 36, padR = 8, padT = 8, padB = 22;
        const w = 600; // logical width; viewBox preserves aspect, host can scale
        const innerW = w - padL - padR;
        const innerH = height - padT - padB;

        const xAt = i => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
        const yAt = v => padT + innerH - (v / niceMax) * innerH;

        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${w} ${height}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.style.cssText = `width: 100%; height: ${height}px; display: block; overflow: visible;`;
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', series.map(s => s.label).join(' and ') + ' over time');

        // Grid lines + Y-axis ticks (3 lines: 0, mid, max).
        [0, 0.5, 1].forEach(frac => {
            const y = padT + innerH - frac * innerH;
            const line = document.createElementNS(svgNS, 'line');
            line.setAttribute('x1', padL);
            line.setAttribute('x2', w - padR);
            line.setAttribute('y1', y);
            line.setAttribute('y2', y);
            line.setAttribute('stroke', 'var(--border-default)');
            line.setAttribute('stroke-width', '1');
            line.setAttribute('stroke-dasharray', frac === 0 ? '0' : '3 3');
            line.setAttribute('opacity', frac === 0 ? '0.7' : '0.35');
            svg.appendChild(line);

            const tick = document.createElementNS(svgNS, 'text');
            tick.setAttribute('x', padL - 6);
            tick.setAttribute('y', y + 3);
            tick.setAttribute('text-anchor', 'end');
            tick.setAttribute('font-size', '9');
            tick.setAttribute('fill', 'var(--text-muted)');
            tick.textContent = yFormat(frac * niceMax);
            svg.appendChild(tick);
        });

        // X-axis labels.
        labels.forEach((lbl, i) => {
            const t = document.createElementNS(svgNS, 'text');
            t.setAttribute('x', xAt(i));
            t.setAttribute('y', height - 6);
            t.setAttribute('text-anchor', 'middle');
            t.setAttribute('font-size', '10');
            t.setAttribute('fill', 'var(--text-muted)');
            t.textContent = lbl;
            svg.appendChild(t);
        });

        // Catmull-Rom → cubic Bézier path for smooth lines without
        // sharp corners at each data point. Avoids degenerate splines
        // when n < 3 by falling back to straight L commands.
        const smoothPath = (data) => {
            if (data.length === 0) return '';
            if (data.length === 1) {
                return `M ${xAt(0)} ${yAt(data[0])}`;
            }
            let d = `M ${xAt(0)} ${yAt(data[0])}`;
            for (let i = 0; i < data.length - 1; i++) {
                const x0 = xAt(Math.max(i - 1, 0));
                const y0 = yAt(data[Math.max(i - 1, 0)]);
                const x1 = xAt(i);
                const y1 = yAt(data[i]);
                const x2 = xAt(i + 1);
                const y2 = yAt(data[i + 1]);
                const x3 = xAt(Math.min(i + 2, data.length - 1));
                const y3 = yAt(data[Math.min(i + 2, data.length - 1)]);
                // Cardinal spline tension 0.5.
                const cp1x = x1 + (x2 - x0) / 6;
                const cp1y = y1 + (y2 - y0) / 6;
                const cp2x = x2 - (x3 - x1) / 6;
                const cp2y = y2 - (y3 - y1) / 6;
                d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`;
            }
            return d;
        };

        series.forEach((s, sIdx) => {
            const data = s.data || [];
            const pathStr = smoothPath(data);
            if (!pathStr) return;

            // Area fill — same path closed to baseline with low alpha.
            const areaStr = `${pathStr} L ${xAt(data.length - 1)} ${padT + innerH} L ${xAt(0)} ${padT + innerH} Z`;
            const area = document.createElementNS(svgNS, 'path');
            area.setAttribute('d', areaStr);
            area.setAttribute('fill', s.color);
            area.setAttribute('fill-opacity', '0.14');
            svg.appendChild(area);

            // Line stroke.
            const line = document.createElementNS(svgNS, 'path');
            line.setAttribute('d', pathStr);
            line.setAttribute('fill', 'none');
            line.setAttribute('stroke', s.color);
            line.setAttribute('stroke-width', '2');
            line.setAttribute('stroke-linecap', 'round');
            line.setAttribute('stroke-linejoin', 'round');
            svg.appendChild(line);

            // Dot markers — every point, larger on the latest day.
            data.forEach((v, i) => {
                const dot = document.createElementNS(svgNS, 'circle');
                dot.setAttribute('cx', xAt(i));
                dot.setAttribute('cy', yAt(v));
                dot.setAttribute('r', i === data.length - 1 ? '4' : '3');
                dot.setAttribute('fill', 'var(--bg-card)');
                dot.setAttribute('stroke', s.color);
                dot.setAttribute('stroke-width', '2');
                svg.appendChild(dot);

                // Invisible, generously-sized hit target over each point so
                // the value tooltip is easy to trigger — the visible dot is
                // only r≈3 and the SVG scales with preserveAspectRatio=none,
                // which distorts tiny hover zones. A transparent r=14 circle
                // gives a forgiving target and drives a styled HTML tooltip
                // (faster + better-looking than the native SVG <title>).
                const fmt = s.format || yFormat;
                const hit = document.createElementNS(svgNS, 'circle');
                hit.setAttribute('cx', xAt(i));
                hit.setAttribute('cy', yAt(v));
                hit.setAttribute('r', '14');
                hit.setAttribute('fill', 'transparent');
                hit.style.cursor = 'pointer';
                const label = `${labels[i]} · ${s.label}: ${fmt(v)}`;
                // Native title as an accessible / no-JS fallback.
                const titleEl = document.createElementNS(svgNS, 'title');
                titleEl.textContent = label;
                hit.appendChild(titleEl);
                const show = (ev) => {
                    tooltip.textContent = label;
                    tooltip.style.opacity = '1';
                    const rect = container.getBoundingClientRect();
                    let x = ev.clientX - rect.left + 12;
                    let y = ev.clientY - rect.top - 10;
                    // Keep the tooltip inside the card horizontally.
                    const maxX = rect.width - tooltip.offsetWidth - 6;
                    if (x > maxX) x = ev.clientX - rect.left - tooltip.offsetWidth - 12;
                    tooltip.style.left = Math.max(0, x) + 'px';
                    tooltip.style.top = Math.max(0, y) + 'px';
                };
                hit.addEventListener('mouseenter', show);
                hit.addEventListener('mousemove', show);
                hit.addEventListener('mouseleave', () => { tooltip.style.opacity = '0'; });
                // Enlarge the visible dot on hover for feedback.
                hit.addEventListener('mouseenter', () => dot.setAttribute('r', '5'));
                hit.addEventListener('mouseleave', () => dot.setAttribute('r', i === data.length - 1 ? '4' : '3'));
                svg.appendChild(hit);
            });
        });

        // Host the SVG in a positioned wrapper so the HTML tooltip can be
        // absolutely placed relative to the chart.
        container.style.position = container.style.position || 'relative';
        const tooltip = document.createElement('div');
        tooltip.style.cssText = [
            'position:absolute', 'pointer-events:none', 'opacity:0',
            'transition:opacity 0.08s', 'z-index:5', 'white-space:nowrap',
            'background:var(--bg-card)', 'color:var(--text-primary)',
            'border:1px solid var(--border-default)', 'border-radius:6px',
            'padding:4px 8px', 'font-size:11px', 'font-weight:600',
            'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
        ].join(';');
        container.appendChild(tooltip);

        container.appendChild(svg);

        // Legend — uses the same color swatches as the lines.
        const legend = document.createElement('div');
        legend.style.cssText = 'display: flex; gap: 14px; margin-top: 8px; font-size: 11px; color: var(--text-secondary); flex-wrap: wrap;';
        series.forEach(s => {
            const item = document.createElement('span');
            item.style.cssText = 'display: flex; align-items: center; gap: 6px;';
            const sw = document.createElement('span');
            sw.style.cssText = `width: 16px; height: 2px; background: ${s.color}; flex-shrink: 0; border-radius: 1px;`;
            item.appendChild(sw);
            item.appendChild(document.createTextNode(s.label));
            legend.appendChild(item);
        });
        container.appendChild(legend);
    },

    renderTrendChart(container) {
        const days = 7;
        const buckets = [];
        const toLocalDateStr = ts => {
            const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
            return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        };
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
            buckets.push({
                label: (d.getMonth()+1).toString().padStart(2,'0') + '/' + d.getDate().toString().padStart(2,'0'),
                dateStr,
                total: 0,
                threats: 0,
            });
        }
        (this.threats || []).forEach(t => {
            const dateStr = toLocalDateStr(t.created_at || new Date().toISOString());
            const bucket = buckets.find(b => b.dateStr === dateStr);
            if (bucket) {
                bucket.total++;
                if ((t.risk_score || 0) >= 60) bucket.threats++;
            }
        });

        this._renderTimelineChart(container, {
            labels: buckets.map(b => b.label),
            series: [
                { label: 'Requests',           color: '#5eadb8', data: buckets.map(b => b.total) },
                { label: 'Threats (risk ≥60%)', color: '#ef4444', data: buckets.map(b => b.threats) },
            ],
            yFormat: n => Math.round(n).toLocaleString(),
        });
    },

    async renderCostTrendChart(container, card) {
        const days = 7;
        const buckets = [];
        const now = new Date();
        const toLocalDateStr2 = ts => {
            const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
            return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        };
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
            buckets.push({ label: (d.getMonth()+1).toString().padStart(2,'0') + '/' + d.getDate().toString().padStart(2,'0'), dateStr, cost: 0 });
        }
        try {
            const start = new Date(now);
            start.setDate(start.getDate() - 7);
            const records = await API.getCostRecords({ start: start.toISOString(), page_size: 200 });
            (records.items || []).forEach(r => {
                const dateStr = toLocalDateStr2(r.recorded_at || new Date().toISOString());
                const bucket = buckets.find(b => b.dateStr === dateStr);
                if (bucket) bucket.cost += r.total_cost_usd || 0;
            });
        } catch (e) {}

        // Plugin runtimes (Claude Code / Codex / OpenClaw) never produce
        // provider-cost records — token cost lives in the LLM API/SDK
        // layer that the tool-call hooks can't see, so the dollar chart is
        // a flat $0 line for plugin-only users. When there's genuinely no
        // spend in the window, fall back to a combined token-usage chart
        // (summed across the plugins that expose token telemetry — Codex +
        // Claude Code; OpenClaw has no token endpoint and contributes 0)
        // so the widget shows something honest and useful instead of $0.
        const weeklyCostUSD = buckets.reduce((sum, b) => sum + (b.cost || 0), 0);
        if (weeklyCostUSD > 0) {
            this._renderTimelineChart(container, {
                labels: buckets.map(b => b.label),
                series: [
                    {
                        label: 'Daily spend (USD)',
                        color: '#10b981',
                        data: buckets.map(b => b.cost),
                        format: n => '$' + (n || 0).toFixed(2),
                    },
                ],
                yFormat: n => '$' + (n || 0).toFixed(2),
            });
            return;
        }

        await this._renderTokenTrendChart(container, card, buckets);
    },

    /**
     * Token-usage fallback for the dashboard cost widget. Renders one
     * series PER plugin runtime that exposes token telemetry (Codex +
     * Claude Code) over the same 7-day buckets the cost chart uses, then
     * retitles the card to "Token Usage — Last 7 Days". OpenClaw has no
     * token-usage endpoint, so it contributes no series.
     *
     * Both endpoints return `daily: [{day: "YYYY-MM-DD" (local tz), ...}]`.
     * Per-day total = input + output + cache-create + cache-read
     * (+ reasoning for Codex). Each fetch is independently fail-safe — a
     * missing/unreachable endpoint just yields a flat-zero series, and a
     * runtime with no activity in the window is omitted entirely so the
     * legend only lists plugins the user actually ran.
     */
    async _renderTokenTrendChart(container, card, buckets) {
        const dayTotal = row => (
            (row.input_tokens || 0) +
            (row.output_tokens || 0) +
            (row.cache_creation_input_tokens || 0) +
            (row.cache_read_input_tokens || 0) +
            (row.reasoning_output_tokens || 0)
        );

        const fetchDaily = async (url) => {
            try {
                const resp = await fetch(url);
                if (!resp.ok) return [];
                const data = await resp.json();
                return Array.isArray(data.daily) ? data.daily : [];
            } catch (e) {
                return [];
            }
        };

        // One bucket-aligned token array per runtime. Colors match each
        // plugin's canonical accent used elsewhere in the app (Codex coral
        // #C0655E — sidebar banner, costs panel, tool-permissions; Claude Code
        // cyan #06b6d4). Keep these in sync with those surfaces.
        const RUNTIMES = [
            { key: 'codex', label: 'Codex', color: '#C0655E', url: '/api/hooks/codex/token-usage' },
            { key: 'claude-code', label: 'Claude Code', color: '#06b6d4', url: '/api/hooks/claude-code/token-usage' },
        ];

        const dailyByRuntime = await Promise.all(RUNTIMES.map(r => fetchDaily(r.url)));

        if (card) {
            const titleEl = card.querySelector('.card-title');
            if (titleEl) titleEl.textContent = 'Token Usage — Last 7 Days';
        }

        const fmtTokens = n => {
            n = n || 0;
            if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
            if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
            return Math.round(n).toLocaleString();
        };

        const series = RUNTIMES.map((r, i) => {
            const byDay = new Map((dailyByRuntime[i] || []).map(row => [row.day, dayTotal(row)]));
            const data = buckets.map(b => byDay.get(b.dateStr) || 0);
            return {
                label: r.label,
                color: r.color,
                data,
                format: fmtTokens,
                _total: data.reduce((s, n) => s + n, 0),
            };
        // Omit runtimes with zero activity in the window so the legend
        // only shows plugins the user actually ran. If BOTH are empty,
        // keep them so the chart renders an honest empty state rather
        // than a blank card.
        });
        const active = series.filter(s => s._total > 0);
        const shown = active.length > 0 ? active : series;

        this._renderTimelineChart(container, {
            labels: buckets.map(b => b.label),
            series: shown.map(s => ({ label: s.label, color: s.color, data: s.data, format: s.format })),
            yFormat: fmtTokens,
        });
    },

    renderRecentActivity(container) {
        const threats = this.threats.slice(0, 8);

        if (threats.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-state-inline';

            const emptyText = document.createElement('p');
            emptyText.textContent = 'No recent activity';
            empty.appendChild(emptyText);

            const emptySubtext = document.createElement('p');
            emptySubtext.className = 'empty-subtext';
            emptySubtext.textContent = 'Threats will appear here when detected';
            empty.appendChild(emptySubtext);

            container.appendChild(empty);
            return;
        }

        const table = document.createElement('div');
        table.className = 'activity-table';

        // Header
        const header = document.createElement('div');
        header.className = 'activity-header';

        const cols = ['Content', 'Type', 'Risk', 'Time'];
        cols.forEach(col => {
            const cell = document.createElement('div');
            cell.className = 'activity-cell';
            cell.textContent = col;
            header.appendChild(cell);
        });
        table.appendChild(header);

        // Rows
        threats.forEach(threat => {
            const row = document.createElement('div');
            row.className = 'activity-row';

            // Content preview
            const contentCell = document.createElement('div');
            contentCell.className = 'activity-cell content-cell';
            const content = threat.text_preview || threat.text_content || threat.indicator || threat.name || 'Analyzed content';
            contentCell.textContent = content.length > 50 ? content.substring(0, 50) + '...' : content;
            contentCell.title = content;
            row.appendChild(contentCell);

            // Type
            const typeCell = document.createElement('div');
            typeCell.className = 'activity-cell';
            const typeBadge = document.createElement('span');
            typeBadge.className = 'type-badge-small';
            typeBadge.textContent = this.formatType(threat.threat_type || 'detected');
            typeCell.appendChild(typeBadge);
            row.appendChild(typeCell);

            // Risk
            const riskCell = document.createElement('div');
            riskCell.className = 'activity-cell';
            const riskBadge = document.createElement('span');
            riskBadge.className = 'risk-badge risk-' + this.getRiskLevel(threat.risk_score);
            riskBadge.textContent = (threat.risk_score || 0) + '%';
            riskCell.appendChild(riskBadge);
            row.appendChild(riskCell);

            // Time
            const timeCell = document.createElement('div');
            timeCell.className = 'activity-cell time-cell';
            timeCell.textContent = this.formatTime(threat.created_at || threat.first_seen);
            row.appendChild(timeCell);

            row.addEventListener('click', () => {
                if (window.Sidebar) Sidebar.navigate('threats');
            });

            table.appendChild(row);
        });

        container.appendChild(table);
    },

    formatType(type) {
        if (!type || type === 'unknown') return 'Detected';
        return type
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    },

    formatTime(dateStr) {
        if (!dateStr) return '-';
        try {
            const date = new Date(dateStr);
            const now = new Date();
            const diffMs = now - date;
            const diffMins = Math.floor(diffMs / 60000);

            if (diffMins < 1) return 'Just now';
            if (diffMins < 60) return diffMins + 'm ago';
            if (diffMins < 1440) return Math.floor(diffMins / 60) + 'h ago';
            return Math.floor(diffMins / 1440) + 'd ago';
        } catch (e) {
            return '-';
        }
    },

    getRiskLevel(score) {
        if (score >= 80) return 'critical';
        if (score >= 60) return 'high';
        if (score >= 40) return 'medium';
        return 'low';
    },

    toggleAutoRefresh() {
        this.autoRefreshEnabled = !this.autoRefreshEnabled;
        if (this.autoRefreshEnabled) {
            this.autoRefreshInterval = setInterval(() => {
                if (this.currentContainer) {
                    this.render(this.currentContainer);
                }
            }, getPollInterval());
            const _sec = Math.round(getPollInterval() / 1000);
            if (window.Toast) Toast.info(`Auto refresh enabled (${_sec}s)`);
        } else {
            if (this.autoRefreshInterval) {
                clearInterval(this.autoRefreshInterval);
                this.autoRefreshInterval = null;
            }
            if (window.Toast) Toast.info('Auto refresh disabled');
        }
    },

    async renderCostWidget() {
        const widget = document.createElement('div');
        widget.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; margin-bottom: 20px; cursor: pointer;';
        widget.title = 'Click to open Cost Tracking';
        widget.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('costs'); });

        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;';

        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-size: 14px; font-weight: 600; color: var(--text-primary);';
        titleEl.textContent = '💰 Cost Tracking';
        header.appendChild(titleEl);

        const viewLink = document.createElement('span');
        viewLink.style.cssText = 'font-size: 12px; color: var(--accent-primary); cursor: pointer;';
        viewLink.textContent = 'View all →';
        header.appendChild(viewLink);

        widget.appendChild(header);

        try {
            const summary = await API.getDashboardCostSummary();

            const grid = document.createElement('div');
            grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px;';

            const items = [
                { label: "Today's Cost", value: `$${(summary.today_cost_usd || 0).toFixed(4)}` },
                { label: "Today's Requests", value: (summary.today_requests || 0).toLocaleString() },
                { label: 'Top Agent', value: summary.top_agent || '—' },
                { label: 'Top Model', value: summary.top_model || '—' },
            ];

            items.forEach(({ label, value }) => {
                const cell = document.createElement('div');
                cell.style.cssText = 'text-align: center;';
                const v = document.createElement('div');
                v.style.cssText = 'font-size: 18px; font-weight: 700; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
                v.textContent = value;
                v.title = value;
                const l = document.createElement('div');
                l.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-top: 2px;';
                l.textContent = label;
                cell.appendChild(v);
                cell.appendChild(l);
                grid.appendChild(cell);
            });

            widget.appendChild(grid);

            if (summary.has_unknown_pricing) {
                const warn = document.createElement('div');
                warn.style.cssText = 'margin-top: 10px; font-size: 11px; color: var(--color-warning, #f59e0b);';
                warn.textContent = '⚠ Some models have unknown pricing — costs may be understated.';
                widget.appendChild(warn);
            }
        } catch (e) {
            const err = document.createElement('div');
            err.style.cssText = 'font-size: 13px; color: var(--text-secondary);';
            err.textContent = 'Cost data unavailable.';
            widget.appendChild(err);
        }

        return widget;
    },

    async renderSecurityControls() {
        const section = document.createElement('div');
        section.className = 'security-controls-section';
        section.style.cssText = 'display: flex; gap: 16px; margin-bottom: 24px;';

        // Fetch current settings
        let settings = { block_threats: false, scan_llm_responses: true };
        try {
            settings = await API.getSettings();
        } catch (e) {}

        // Block Mode Card
        const blockCard = document.createElement('div');
        blockCard.className = 'security-control-card';
        blockCard.style.cssText = 'flex: 1; background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 12px; padding: 20px; display: flex; justify-content: space-between; align-items: center;';
        if (!settings.block_threats) blockCard.classList.add('flashing-border');

        const blockInfo = document.createElement('div');
        const blockTitle = document.createElement('div');
        blockTitle.style.cssText = 'font-weight: 600; font-size: 15px; margin-bottom: 4px;';
        blockTitle.textContent = 'Block Mode';
        blockInfo.appendChild(blockTitle);
        const blockDesc = document.createElement('div');
        blockDesc.style.cssText = 'color: var(--text-secondary); font-size: 13px;';
        blockDesc.textContent = 'Block threats on input and output';
        blockInfo.appendChild(blockDesc);
        blockCard.appendChild(blockInfo);

        const blockToggle = document.createElement('label');
        blockToggle.className = 'toggle';
        const blockCheckbox = document.createElement('input');
        blockCheckbox.type = 'checkbox';
        blockCheckbox.checked = settings.block_threats;
        blockCheckbox.addEventListener('change', async (e) => {
            const newState = e.target.checked;
            if (!confirm(newState ? 'Enable Block Mode?\n\nInput threats will be BLOCKED before reaching the LLM.\nOutput threats will be BLOCKED before reaching the client.' : 'Disable Block Mode?\n\nAll threats will be logged only.')) {
                e.target.checked = !newState;
                return;
            }
            // Show modal immediately
            if (newState) {
                showOpenClawProxyModal();
            } else {
                showOpenClawProxyStopModal();
            }

            // Save settings in background
            API.updateSettings({ block_threats: newState }).then(() => {
                Toast.success(newState ? 'Block mode enabled' : 'Block mode disabled');
            }).catch(() => {
                Toast.error('Failed to update');
                e.target.checked = !newState;
            });
        });
        blockToggle.appendChild(blockCheckbox);
        const blockSlider = document.createElement('span');
        blockSlider.className = 'toggle-slider';
        blockToggle.appendChild(blockSlider);
        blockCard.appendChild(blockToggle);
        section.appendChild(blockCard);

        // Output Scan Card
        const outputCard = document.createElement('div');
        outputCard.className = 'security-control-card';
        outputCard.style.cssText = 'flex: 1; background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 12px; padding: 20px; display: flex; justify-content: space-between; align-items: center;';
        if (!settings.scan_llm_responses) outputCard.classList.add('flashing-border');

        const outputInfo = document.createElement('div');
        const outputTitle = document.createElement('div');
        outputTitle.style.cssText = 'font-weight: 600; font-size: 15px; margin-bottom: 4px;';
        outputTitle.textContent = 'Output Scan (Redact Sensitive Info)';
        outputInfo.appendChild(outputTitle);
        const outputDesc = document.createElement('div');
        outputDesc.style.cssText = 'color: var(--text-secondary); font-size: 13px;';
        outputDesc.textContent = 'Scan LLM responses, redact secrets when stored';
        outputInfo.appendChild(outputDesc);
        outputCard.appendChild(outputInfo);

        const outputToggle = document.createElement('label');
        outputToggle.className = 'toggle';
        const outputCheckbox = document.createElement('input');
        outputCheckbox.type = 'checkbox';
        outputCheckbox.checked = settings.scan_llm_responses;
        outputCheckbox.addEventListener('change', async (e) => {
            const newState = e.target.checked;
            if (!confirm(newState ? 'Enable Output Scan?\n\nLLM responses will be scanned.' : 'Disable Output Scan?\n\nResponses will not be monitored.')) {
                e.target.checked = !newState;
                return;
            }
            try {
                await API.updateSettings({ scan_llm_responses: newState });
                Toast.success(newState ? 'Output scan enabled' : 'Output scan disabled');
            } catch (err) {
                Toast.error('Failed to update');
                e.target.checked = !newState;
            }
        });
        outputToggle.appendChild(outputCheckbox);
        const outputSlider = document.createElement('span');
        outputSlider.className = 'toggle-slider';
        outputToggle.appendChild(outputSlider);
        outputCard.appendChild(outputToggle);
        section.appendChild(outputCard);

        return section;
    },

    renderError(container, error) {
        container.textContent = '';

        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-state';

        const icon = document.createElement('div');
        icon.className = 'error-icon';
        icon.textContent = '!';
        errorDiv.appendChild(icon);

        const message = document.createElement('p');
        message.textContent = 'Failed to load dashboard data';
        errorDiv.appendChild(message);

        const retry = document.createElement('button');
        retry.className = 'btn btn-primary';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => this.render(container));
        errorDiv.appendChild(retry);

        container.appendChild(errorDiv);
    },
};

window.DashboardPage = DashboardPage;
