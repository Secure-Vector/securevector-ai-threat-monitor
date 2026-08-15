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
        title: 'Block Mode Disabled: Restart OpenClaw',
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
            // Fetch analytics, recent threats, and settings (settings power the
            // posture sentence — protection on/off — without a second paint).
            const [analytics, threats, settings] = await Promise.all([
                API.getThreatAnalytics(),
                API.getThreats({ page_size: 50 }),
                API.getSettings().catch(() => null),
            ]);
            this.data = analytics;
            this.threats = threats.items || [];
            this.settings = settings;
            this.renderContent(container);
        } catch (error) {
            this.renderError(container, error);
        }
    },

    /** Global dashboard lookback (days). Persisted; drives the posture
     *  sentence and (progressively) the charts/feed windows. */
    get rangeDays() {
        const v = Number(localStorage.getItem('sv-dash-range') || 7);
        return [1, 7, 30].includes(v) ? v : 7;
    },
    set rangeDays(v) {
        try { localStorage.setItem('sv-dash-range', String(v)); } catch (_) { /* */ }
    },

    /**
     * Posture header — the v3 redesign's first row: an OUTCOME-encoded status
     * sentence ("All clear — last threat 2h ago, blocked" / "1 threat allowed
     * through"), a global 24h/7d/30d range selector whose lookback the
     * sentence itself respects, and an auto-refresh stamp. Red appears only
     * when something actually got through or protection is off.
     */
    _renderPostureHeader(container) {
        const days = this.rangeDays;
        const cutoff = Date.now() - days * 86400000;
        const parse = (iso) => {
            const d = new Date(String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z'));
            return isNaN(d) ? null : d;
        };
        const inRange = (this.threats || []).filter(t => {
            const d = parse(t.created_at);
            return t.is_threat && d && d.getTime() >= cutoff;
        });
        const blocked = inRange.filter(t => String(t.action_taken || '').toLowerCase().includes('block'));
        const allowedThrough = inRange.length - blocked.length;
        const latest = inRange[0];

        const rel = (d) => {
            const m = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
            if (m < 60) return `${m}m ago`;
            if (m < 1440) return `${Math.round(m / 60)}h ago`;
            return `${Math.round(m / 1440)}d ago`;
        };

        let tone = 'ok'; // ok | warn | alert
        let sentence;
        const rangeLabel = days === 1 ? 'last 24h' : `last ${days} days`;
        if (!inRange.length) {
            sentence = `All clear: no threats in the ${rangeLabel}`;
        } else if (allowedThrough > 0) {
            tone = 'alert';
            sentence = `${allowedThrough} threat${allowedThrough === 1 ? '' : 's'} allowed through in the ${rangeLabel} — review now`;
        } else {
            sentence = `${blocked.length} threat${blocked.length === 1 ? '' : 's'} caught in the ${rangeLabel}` +
                (latest && parse(latest.created_at) ? ` — last ${rel(parse(latest.created_at))}, blocked` : '');
        }

        const colors = { ok: 'var(--accent-primary, #5eadb8)', warn: '#f59e0b', alert: '#ef4444' };

        const head = document.createElement('div');
        head.style.cssText = 'display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin: 2px 2px 16px;';

        const dot = document.createElement('span');
        dot.style.cssText = `width:10px; height:10px; border-radius:50%; flex-shrink:0; background:${colors[tone]};` +
            (tone === 'ok' ? '' : ' box-shadow: 0 0 0 4px ' + (tone === 'alert' ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.15)') + ';');
        head.appendChild(dot);

        const text = document.createElement('div');
        text.style.cssText = "flex:1; min-width:240px; font: 600 15px 'Avenir Next',Avenir,system-ui,sans-serif; color: var(--text-primary);";
        text.textContent = sentence;
        head.appendChild(text);

        // Range pills — one semantics everywhere: a rolling lookback window.
        const pills = document.createElement('div');
        pills.style.cssText = 'display:inline-flex; gap:2px; background: var(--bg-card,#161b22); border:1px solid var(--border-default,#30363d); border-radius:8px; padding:2px;';
        [[1, '24h'], [7, '7 days'], [30, '30 days']].forEach(([v, label]) => {
            const b = document.createElement('button');
            const active = v === days;
            b.style.cssText = "border:none; cursor:pointer; font: 600 11.5px 'Avenir Next',Avenir,system-ui,sans-serif; padding: 5px 11px; border-radius:6px;" +
                (active
                    ? 'background: var(--accent-primary,#5eadb8); color:#fff;'
                    : 'background: transparent; color: var(--text-secondary,#b1bac4);');
            b.textContent = label;
            b.addEventListener('click', () => {
                if (v === this.rangeDays) return;
                this.rangeDays = v;
                if (this.currentContainer) this.renderContent(this.currentContainer);
            });
            pills.appendChild(b);
        });
        head.appendChild(pills);

        const stamp = document.createElement('div');
        stamp.style.cssText = 'font: 500 11px ui-monospace,Menlo,monospace; color: var(--text-muted,#7d8590);';
        stamp.textContent = `updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        head.appendChild(stamp);

        container.appendChild(head);
    },

    /**
     * Day-0 onboarding — shown ONLY when the install has never seen any
     * traffic (no threats, no agent sessions). Three steps with live state:
     * connect a harness → watch the first event arrive (polled every 10s,
     * with a troubleshooting hint if nothing shows up within 10 minutes) →
     * turn on Block Mode. The first observed event re-renders the real
     * dashboard automatically.
     */
    _renderDayZeroChecklist(stack, syncVis) {
        const card = document.createElement('div');
        card.style.cssText = 'padding: 16px 18px; border-radius: 10px; border: 1px solid var(--border-default); background: var(--bg-card);';

        const title = document.createElement('div');
        title.textContent = 'Get protected: connect your first agent';
        title.style.cssText = 'font-weight: 700; font-size: 14.5px; color: var(--text-primary); margin-bottom: 6px;';
        card.appendChild(title);

        const sub = document.createElement('div');
        sub.style.cssText = 'font-size: 13px; color: var(--text-secondary); line-height: 1.55; margin-bottom: 14px;';
        sub.textContent = 'The Connect Wizard scans this device for agent runtimes, installs the Guard plugin in one click, and verifies your first protected call live. This dashboard fills in automatically once your first agent runs.';
        card.appendChild(sub);

        // Single CTA — the Connect Agents page is now the one front door, so the
        // old inline 3-step checklist is replaced by a redirect. Accent-outline
        // button (no cyan fill / white text).
        const cta = document.createElement('button');
        cta.style.cssText = 'display: inline-flex; align-items: center; gap: 8px; background: color-mix(in srgb, var(--accent-primary) 15%, transparent); border: 1px solid color-mix(in srgb, var(--accent-primary) 45%, transparent); color: var(--accent-primary); border-radius: 9px; padding: 10px 18px; font-size: 13px; font-weight: 700; cursor: pointer; transition: background 0.14s, border-color 0.14s;';
        cta.textContent = 'Connect your first agent →';
        cta.addEventListener('mouseenter', () => { cta.style.background = 'color-mix(in srgb, var(--accent-primary) 24%, transparent)'; cta.style.borderColor = 'color-mix(in srgb, var(--accent-primary) 60%, transparent)'; });
        cta.addEventListener('mouseleave', () => { cta.style.background = 'color-mix(in srgb, var(--accent-primary) 15%, transparent)'; cta.style.borderColor = 'color-mix(in srgb, var(--accent-primary) 45%, transparent)'; });
        cta.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('guide-connect-agents'); });
        card.appendChild(cta);

        // First-event poll. The stall hint appears after 10 minutes of
        // silence measured from the FIRST time the checklist rendered, so
        // re-visits don't reset the clock.
        let since = Number(localStorage.getItem('sv-day0-since') || 0);
        if (!since) {
            since = Date.now();
            try { localStorage.setItem('sv-day0-since', String(since)); } catch (_) { /* */ }
        }
        const poll = setInterval(async () => {
            if (!card.isConnected) { clearInterval(poll); return; }
            try {
                const stats = await API.getToolCallAuditStats();
                if (stats && stats.total > 0) {
                    clearInterval(poll);
                    try { localStorage.removeItem('sv-day0-since'); } catch (_) { /* */ }
                    if (window.Toast) Toast.success('First event received: you are live');
                    if (this.currentContainer) this.render(this.currentContainer);
                    return;
                }
            } catch (_) { /* keep polling */ }
            if (Date.now() - since > 600000 && !card.querySelector('.sv-day0-stall')) {
                const stall = document.createElement('div');
                stall.className = 'sv-day0-stall';
                stall.style.cssText = 'margin-top: 10px; font-size: 12px; color: var(--text-secondary);';
                stall.textContent = 'No events after 10 minutes? Check that your agent restarted after connecting, and that the proxy/plugin is active. ';
                const link = document.createElement('a');
                link.href = '#';
                link.textContent = 'Troubleshooting guide →';
                link.addEventListener('click', (e) => { e.preventDefault(); if (window.Sidebar) Sidebar.navigate('gs-troubleshoot'); });
                stall.appendChild(link);
                card.appendChild(stall);
            }
        }, 10000);

        stack.appendChild(card);
        if (syncVis) syncVis();
    },

    async renderContent(container) {
        container.textContent = '';

        // ── Tier 1 — protection hero ────────────────────────────────────────
        // One card that answers "am I protected?" at a glance: the
        // outcome-encoded posture sentence (with the global 24h/7d/30d range
        // selector) plus the headline aggregates as a single stat strip.
        // Same data the old KPI grid showed — recomposed, not changed.
        const hero = document.createElement('div');
        hero.className = 'sv-dash-hero';
        hero.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 12px; padding: 18px 20px 8px; margin-bottom: 20px;';
        container.appendChild(hero);
        this._renderPostureHeader(hero);
        this._renderHeroStats(hero); // render-then-fill; never blocks the page


        // Needs-attention stack — ONE prioritized home for everything that
        // wants the operator's eyes: budget overruns first (financial, not
        // dismissible), then protection gaps (dismissible, reappear after
        // 24h, and suppressed entirely on day 0 — before any traffic has
        // flowed, "block mode is off" is setup noise, not an alert).
        try {
            const gd = await API.getBudgetGuardian().catch(() => null);
            const stack = document.createElement('div');
            stack.style.cssText = 'margin-bottom: 16px; display: flex; flex-direction: column; gap: 8px;';

            {
                const alertsBox = stack;

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

                const hasGlobalAlert = gd && gd.global_budget_usd != null && (gd.global_over_budget || gd.global_warning);
                const hasAgentAlerts = gd && gd.agent_alerts && gd.agent_alerts.some(a => a.over_budget || a.warning);
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
            }

            // Protection-gap items. Day-0 suppression: only nag once real
            // traffic exists (any analyzed request ever). Dismissals live in
            // localStorage with a timestamp and expire after 24h.
            const dayZero = !((this.data && this.data.total_threats) || (this.threats || []).length);
            const dismissedAt = (id) => {
                try { return Number(localStorage.getItem('sv-attn-dismiss-' + id) || 0); } catch (_) { return 0; }
            };
            const buildGapItem = (ids, text, cta, onRemove) => {
                const bar = document.createElement('div');
                bar.style.cssText = 'padding: 9px 14px; border-radius: 8px; border: 1px solid rgba(180,130,0,0.6); background: rgba(180,130,0,0.06); display: flex; align-items: center; gap: 12px;';
                const txt = document.createElement('div');
                txt.style.cssText = 'flex: 1; min-width: 0; font-size: 13px; font-weight: 600; color: var(--text-primary);';
                txt.textContent = text;
                bar.appendChild(txt);
                const goBtn = document.createElement('button');
                goBtn.className = 'btn btn-secondary btn-sm';
                goBtn.textContent = cta;
                goBtn.addEventListener('click', () => {
                    const sec = document.querySelector('.security-controls-section');
                    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
                });
                bar.appendChild(goBtn);
                const dismiss = document.createElement('button');
                dismiss.setAttribute('aria-label', 'Dismiss for 24 hours');
                dismiss.title = 'Dismiss for 24 hours';
                dismiss.textContent = '×';
                dismiss.style.cssText = 'background:none; border:none; color: var(--text-muted); font-size: 16px; cursor: pointer; padding: 0 2px; line-height: 1;';
                dismiss.addEventListener('click', () => {
                    try { ids.forEach(id => localStorage.setItem('sv-attn-dismiss-' + id, String(Date.now()))); } catch (_) { /* */ }
                    bar.remove();
                    if (onRemove) onRemove();
                });
                bar.appendChild(dismiss);
                return bar;
            };
            const syncVis = () => { stack.style.display = stack.children.length ? 'flex' : 'none'; };
            container.appendChild(stack);
            syncVis();

            const appendGaps = () => {
                if (!this.settings) return;
                const gaps = [];
                // Block Mode is deliberately not an alert here. It only governs
                // the OpenClaw proxy path; hook, SDK and MCP runtimes block tool
                // calls natively, so "nothing is stopped" was untrue on most
                // installs. The Governance page still reports its real state per
                // runtime, which is where the distinction can actually be made.
                if (!this.settings.scan_llm_responses) {
                    gaps.push(['output-scan', 'Output scan is off: LLM responses are not checked or redacted', 'Turn on']);
                }
                if (this.settings.guardian_ml_available !== false && this.settings.guardian_ml_enabled === false) {
                    gaps.push(['guardian-ml', 'Guardian ML is off: detection is running on rules only', 'Turn on']);
                }
                // v5 banner policy: never stack gap bars. One gap renders its
                // full sentence; several gaps merge into a single summary line
                // (same conditions, same destination, and dismissing it snoozes
                // every listed gap for the same 24h the singles always had).
                const due = gaps.filter(([id]) => Date.now() - dismissedAt(id) > 86400000);
                if (due.length === 1) {
                    stack.appendChild(buildGapItem([due[0][0]], due[0][1], due[0][2], syncVis));
                } else if (due.length > 1) {
                    const names = { 'output-scan': 'Output scan', 'guardian-ml': 'Guardian ML' };
                    const list = due.map(([id]) => names[id] || id).join(', ');
                    stack.appendChild(buildGapItem(
                        due.map(([id]) => id),
                        `${due.length} protections are off: ${list}. Threats are detected and logged, but not fully enforced.`,
                        'Review', syncVis));
                }
                syncVis();
            };
            if (!dayZero) {
                appendGaps();
            } else {
                // No threat records yet — but agents may still be running
                // through us (tool traffic without findings). Check the
                // session graph in the background; only a truly silent
                // install stays nag-free — and a truly silent install gets
                // the day-0 checklist instead of alerts.
                API.getAgentSessionGraph({ window_days: 7 }).then((g) => {
                    if ((g.nodes || []).some(n => n.kind === 'session')) appendGaps();
                    else this._renderDayZeroChecklist(stack, syncVis);
                }).catch(() => {});
            }
        } catch (e) { /* attention stack is non-critical */ }

        // No full-width trend card here. Every figure on this page has a
        // detail page that owns it, so a single-metric chart could only repeat
        // one of them at the cost of the widest element on the dashboard. The
        // shape now rides with its own number as a sparkline in the strip
        // above, which is a fifth of the space and reads as an attribute of
        // the figure rather than a section competing with it.

        // Security Controls — what is on and off, which is the page's
        // actionable half and now reads before the feed.
        const securityControls = await this.renderSecurityControls();
        container.appendChild(securityControls);

        // Governance posture moved to its own Cloud-section page
        // (GovernancePage) — kept off the dashboard to reduce clutter.

        // Reports — weekly artifacts as compact tiles; the full pages (and
        // rich PDF export) are one click away.
        this.renderReportsSection(container);

        // Recent Threat Activity closes the page. The headline above already
        // states how many threats need review, so the row-by-row feed is the
        // detail you scroll to, not the thing you land on.
        const activityCard = Card.create({ title: 'Recent Threat Activity', gradient: true });
        activityCard.style.marginTop = '20px';
        this.renderRecentActivity(activityCard.querySelector('.card-body'));
        container.appendChild(activityCard);
    },

    /**
     * Sparkline: a number's own shape, at instrument scale.
     *
     * Micro-histogram rather than a line — these are discrete daily counts,
     * and a smoothed curve would draw values that were never measured. Bars
     * sit at low opacity with the most recent at full strength, so the eye
     * lands on "now" and the rest reads as context. A measured-but-empty
     * bucket keeps a baseline hairline: absent and zero must not look alike.
     *
     * Deliberately unlabelled. Magnitude lives in the figure above it; this
     * only answers "steady, spiking, or stopped", and the tooltip carries the
     * per-bucket detail for anyone who wants it.
     */
    _sparkline(data, opts = {}) {
        const values = (data || []).map(v => Number(v) || 0);
        if (!values.length) return null;
        const color = opts.color || 'var(--text-muted)';
        const W = 4, GAP = 2, H = 16;
        const max = Math.max(...values, 1);
        const svgNS = 'http://www.w3.org/2000/svg';
        const w = values.length * W + (values.length - 1) * GAP;
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${w} ${H}`);
        svg.setAttribute('width', String(w));
        svg.setAttribute('height', String(H));
        svg.style.cssText = 'display:block; overflow:visible;';
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', opts.ariaLabel || 'recent trend');
        values.forEach((v, i) => {
            const x = i * (W + GAP);
            const isLast = i === values.length - 1;
            // Floor a real value at 2px so a small count stays visible beside
            // a large one; a true zero gets a 1px baseline tick instead.
            const h = v > 0 ? Math.max(2, Math.round((v / max) * H)) : 1;
            const bar = document.createElementNS(svgNS, 'rect');
            bar.setAttribute('x', String(x));
            bar.setAttribute('y', String(H - h));
            bar.setAttribute('width', String(W));
            bar.setAttribute('height', String(h));
            bar.setAttribute('rx', v > 0 ? '1' : '0');
            bar.setAttribute('fill', color);
            bar.setAttribute('opacity', v > 0 ? (isLast ? '1' : '0.42') : '0.18');
            svg.appendChild(bar);
        });
        if (opts.title) {
            const t = document.createElementNS(svgNS, 'title');
            t.textContent = opts.title;
            svg.appendChild(t);
        }
        return svg;
    },

    /**
     * Hero stat strip — the old 5-card KPI grid recomposed into one compact
     * row inside the protection hero, led by "Runtimes guarded" so the strip
     * reads as proof of protection, not just traffic. Same sources, same
     * lookback semantics; renders placeholders immediately and fills in the
     * background so the page never blocks on these fetches.
     */
    async _renderHeroStats(host) {
        const days = this.rangeDays;
        const rangeTag = days === 1 ? '24h' : days + 'd';

        const strip = document.createElement('div');
        strip.style.cssText = 'display: flex; flex-wrap: wrap; border-top: 1px solid var(--border-default); margin-top: 4px;';
        host.appendChild(strip);

        const makeStat = (label, color, navPage) => {
            const cell = document.createElement('div');
            cell.style.cssText = 'flex: 1 1 130px; min-width: 120px; padding: 16px 22px 14px 0; cursor: pointer;';
            const valEl = document.createElement('div');
            // v5 type signature: hero numbers in the mono face read like a
            // telemetry instrument (tabular, technical). Class hook lets the
            // stylesheet own the font so it stays consistent app-wide.
            valEl.className = 'stat-value';
            valEl.style.cssText = 'font-family: var(--font-mono); font-size: 26px; font-weight: 700; color: ' + color + '; line-height: 1.1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums;';
            valEl.textContent = '—';
            cell.appendChild(valEl);
            const lblEl = document.createElement('div');
            lblEl.className = 'stat-label';
            lblEl.style.cssText = 'font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted); font-weight: 400; margin-top: 4px; letter-spacing: 0.3px; text-transform: uppercase;';
            lblEl.textContent = label;
            cell.appendChild(lblEl);
            // Reserved slot for the number's own shape. Kept between value and
            // label so a sparkline reads as an attribute of the figure rather
            // than a chart that happens to sit nearby, and so the strip's
            // baseline never shifts when one arrives late.
            const sparkEl = document.createElement('div');
            sparkEl.style.cssText = 'height: 16px; margin-top: 7px;';
            cell.insertBefore(sparkEl, lblEl);
            cell.addEventListener('mouseenter', () => { valEl.style.textDecoration = 'underline'; });
            cell.addEventListener('mouseleave', () => { valEl.style.textDecoration = ''; });
            if (navPage) cell.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate(navPage); });
            strip.appendChild(cell);
            return { valEl, cell, sparkEl };
        };

        // v5 color policy: stat values are neutral by default — color is
        // applied per-value ONLY when it signals a security state (red when
        // threats are present, amber for needs-attention). A rainbow of
        // always-on colored stats reads as alarm soup on a security console.
        const NEUTRAL = 'var(--text-primary)';
        const guarded = makeStat('Runtimes guarded', NEUTRAL, 'guide-connect-agents');
        const calls = makeStat(`Tool calls · ${rangeTag}`, NEUTRAL, 'tool-activity');
        const blockedStat = makeStat(`Threats blocked · ${rangeTag}`, NEUTRAL, 'threats');
        const criticalStat = makeStat(`Critical · ${rangeTag}`, NEUTRAL, 'threats');
        const secretsStat = makeStat(`Secrets caught · ${rangeTag}`, NEUTRAL, 'redactions');
        const spendStat = makeStat('Spend today', NEUTRAL, 'costs');

        // In-range threat slices are synchronous — same lookback the posture
        // sentence uses. Fill them before any network round-trip.
        const cutoff = Date.now() - days * 86400000;
        const parseTs = (iso) => {
            const d = new Date(String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z'));
            return isNaN(d) ? null : d;
        };
        const inRange = (this.threats || []).filter(t => {
            const d = parseTs(t.created_at);
            return t.is_threat && d && d.getTime() >= cutoff;
        });
        const blocked = inRange.filter(t => String(t.action_taken || '').toLowerCase().includes('block')).length;
        const critical = inRange.filter(t => t.risk_score >= 80).length;

        // Calendar days across the window, oldest first. The daily tool-call
        // endpoint keys on local calendar dates, so the sparklines use the
        // same keys and the two figures cannot disagree about what "a day" is.
        const dayKeys = [];
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(Date.now() - i * 86400000);
            dayKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
        }
        const dayLabel = (k) => k.slice(5).replace('-', '/');

        if (days > 1) {
            // Must plot the SAME population as the figure it sits under, or
            // the shape quietly describes a different number than the label.
            const perDay = new Map(dayKeys.map(k => [k, 0]));
            inRange.filter(t => t.risk_score >= 80).forEach(t => {
                const d = parseTs(t.created_at);
                if (!d) return;
                const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                if (perDay.has(k)) perDay.set(k, perDay.get(k) + 1);
            });
            const series = dayKeys.map(k => perDay.get(k) || 0);
            if (series.some(v => v > 0)) {
                const spark = this._sparkline(series, {
                    color: '#ef4444',
                    ariaLabel: 'critical threats per day',
                    title: dayKeys.map((k, i) => `${dayLabel(k)}: ${series[i]}`).join('\n'),
                });
                if (spark) criticalStat.sparkEl.appendChild(spark);
            }
        }
        blockedStat.valEl.textContent = blocked.toLocaleString();
        if (blocked > 0) blockedStat.valEl.style.color = '#ef4444';
        criticalStat.valEl.textContent = critical.toLocaleString();
        if (critical > 0) criticalStat.valEl.style.color = '#ef4444';

        // Async fills — each independent, each failure-tolerant.
        try {
            const [agents, auditDaily, redactions, costData, guardian] = await Promise.all([
                fetch('/api/detection/agents').then(r => r.ok ? r.json() : null).catch(() => null),
                API.getToolCallAuditDaily(days).catch(() => null),
                API.getRedactions(days, { limit: 1 }).catch(() => null),
                API.getDashboardCostSummary().catch(() => null),
                API.getBudgetGuardian().catch(() => null),
            ]);
            if (!strip.isConnected) return; // page switched mid-fetch

            if (agents) {
                const n = (agents.harnesses || []).filter(h => h.plugin_connected).length +
                    (agents.frameworks || []).length;
                guarded.valEl.textContent = String(n);
                if (n === 0) {
                    guarded.valEl.style.color = '#f59e0b';
                    guarded.cell.title = 'Nothing is protected yet: open the Connect Wizard';
                }
            }

            // The daily endpoint buckets by calendar day and over-returns at
            // the window edge (days=1 includes yesterday) — clamp to the
            // last N calendar days client-side so 24h means "today".
            const sinceDay = (() => {
                const d = new Date(Date.now() - (days - 1) * 86400000);
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            })();
            const toolCalls = auditDaily && auditDaily.days
                ? auditDaily.days.filter(d => d.day >= sinceDay)
                    .reduce((s, d) => s + (d.blocked || 0) + (d.allowed || 0) + (d.logged || 0), 0)
                : 0;
            calls.valEl.textContent = toolCalls.toLocaleString();
            if (days > 1 && auditDaily && auditDaily.days) {
                const byDay = new Map(auditDaily.days.map(d => [d.day,
                    (d.blocked || 0) + (d.allowed || 0) + (d.logged || 0)]));
                const series = dayKeys.map(k => byDay.get(k) || 0);
                if (series.some(v => v > 0)) {
                    const spark = this._sparkline(series, {
                        ariaLabel: 'tool calls per day',
                        title: dayKeys.map((k, i) => `${dayLabel(k)}: ${series[i].toLocaleString()}`).join('\n'),
                    });
                    if (spark) calls.sparkEl.appendChild(spark);
                }
            }

            const secretsCaught = redactions && redactions.summary ? (redactions.summary.total || 0) : 0;
            secretsStat.valEl.textContent = secretsCaught.toLocaleString();
            if (secretsCaught > 0) secretsStat.valEl.style.color = '#f59e0b';

            // Format: $0.00 when zero or sub-cent (4-decimal precision feels
            // performative on a dashboard); $0.0123 only when the amount is
            // small but non-trivial. Two decimals once you've crossed $1.
            const formatCost = (n) => {
                if (!n || n < 0.005) return '$0.00';
                if (n < 1) return '$' + n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
                return '$' + n.toFixed(2);
            };
            // Two cost sources, reconciled honestly: metered spend (proxy path
            // only — $0 for hook/plugin-connected agents) vs the transcript
            // estimate (API-list-price value of today's LLM turns, same number
            // the Traces page shows). When only the estimate exists, show it
            // AS an estimate — "≈$X est." — never a flat $0 that contradicts
            // Traces, and never an unlabeled figure that reads as billed spend
            // (on a Claude/OpenAI subscription this usage is included, not
            // invoiced).
            const metered = costData ? (costData.today_cost_usd || 0) : 0;
            const estOnly = costData && metered < 0.005 && (costData.today_estimate_usd || 0) >= 0.005;
            if (estOnly) {
                spendStat.valEl.textContent = '≈' + formatCost(costData.today_estimate_usd);
                spendStat.cell.title = 'Estimated from session transcripts (token counts × API list prices): the sum of every LLM run that happened today, local time. '
                    + 'A trace that spans several days shows its lifetime total on Traces, with the today slice noted beside it. '
                    + 'Not metered billing: on a subscription plan (e.g. Claude Pro/Max) this usage is included, not invoiced. '
                    + 'Metered proxy spend today: $0.';
                const est = document.createElement('div');
                est.style.cssText = 'font-size: 10px; color: var(--text-muted); margin-top: 3px;';
                est.textContent = 'est. from transcripts · not billed';
                spendStat.cell.appendChild(est);
            } else {
                spendStat.valEl.textContent = costData ? formatCost(metered) : '$0.00';
            }

            // Budget progress bar ONLY when a budget is actually configured.
            const budgetUsd = guardian && guardian.global_budget_usd != null ? guardian.global_budget_usd : null;
            if (budgetUsd) {
                const pct = Math.min((guardian.global_pct_used || 0) * 100, 100);
                const barColor = guardian.global_over_budget ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#10b981';
                const track = document.createElement('div');
                track.style.cssText = 'height: 4px; border-radius: 2px; background: var(--bg-tertiary); overflow: hidden; margin-top: 6px; max-width: 120px;';
                const fill = document.createElement('div');
                fill.style.cssText = `height: 100%; border-radius: 2px; width: ${pct}%; background: ${barColor};`;
                track.appendChild(fill);
                spendStat.cell.appendChild(track);
                const cap = document.createElement('div');
                cap.style.cssText = 'font-size: 10px; color: var(--text-muted); margin-top: 3px;';
                cap.textContent = `of $${Number(budgetUsd).toFixed(2)} budget`;
                spendStat.cell.appendChild(cap);
            }
        } catch (_) { /* hero stats are non-critical */ }
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
        sub.textContent = 'Last 7 days: CSV here, or open the page for the rich PDF.';
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
            blurb: 'Per-device SBOM for AI tools: every (server, tool) your agents called.',
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
            blurb: 'Full threat scan log: rule hits, severity, action taken.',
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
        // Tier-3 compact tile — the whole tile opens the full report page;
        // CSV stays as a quiet inline action. The blurb survives as a
        // tooltip so no information is lost, it just stops competing with
        // the hero for space.
        const card = document.createElement('div');
        card.title = blurb;
        card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border-default);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:12px;min-width:0;cursor:pointer;transition:border-color 0.15s;';
        card.addEventListener('mouseenter', () => { card.style.borderColor = 'rgba(94,173,184,0.55)'; });
        card.addEventListener('mouseleave', () => { card.style.borderColor = 'var(--border-default)'; });
        card.addEventListener('click', () => {
            if (window.App && App.loadPage) App.loadPage(openPage);
        });

        const main = document.createElement('div');
        main.style.cssText = 'flex:1;min-width:0;';
        card.appendChild(main);

        const h = document.createElement('h3');
        h.textContent = title;
        h.style.cssText = 'margin:0 0 2px;font-size:13px;font-weight:700;color:var(--text-primary);';
        main.appendChild(h);

        // Live stats line — populated by _populateReportStats. Renders a
        // single em-dash while waiting so the layout doesn't jump.
        const stats = document.createElement('div');
        stats.className = 'sv-report-stats';
        stats.style.cssText = 'font-size:12px;color:var(--text-secondary);line-height:1.4;min-height:17px;';
        stats.textContent = '—';
        main.appendChild(stats);

        const csvBtn = document.createElement('button');
        csvBtn.className = 'sv-btn-secondary';
        csvBtn.textContent = 'CSV';
        csvBtn.title = 'Export CSV (last 7 days)';
        csvBtn.style.cssText = 'padding:4px 9px;font-size:11.5px;flex-shrink:0;';
        csvBtn.addEventListener('click', (e) => { e.stopPropagation(); onCsv(); });
        card.appendChild(csvBtn);

        const arrow = document.createElement('span');
        arrow.textContent = '→';
        arrow.style.cssText = 'color:var(--text-muted);font-size:14px;flex-shrink:0;';
        card.appendChild(arrow);

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

        // Mask obvious secret material in previews — the dashboard feed is
        // a glanceable surface; raw keys never belong on it even when the
        // stored record retains them.
        const maskSecrets = (s) => String(s)
            .replace(/(AKIA|ASIA)[A-Z0-9]{12,}/g, '$1••••••••')
            .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-••••••••')
            .replace(/(ghp|gho|ghu|ghs)_[A-Za-z0-9]{8,}/g, '$1_••••••••')
            .replace(/eyJ[A-Za-z0-9_-]{20,}/g, 'eyJ••••••••')
            .replace(/\b[0-9a-f]{32,}\b/gi, '••••••••');

        // Inline verdict — WHY this row exists: the first matched rule's
        // name, or "Guardian ML · NN%" when the ML model made the call.
        const verdictFor = (t) => {
            const rules = t.matched_rules || [];
            const first = rules[0] || {};
            let why;
            if (/guardian/i.test(first.rule_name || '') || first.rule_id === 'sv_guardian_model') {
                const score = (t.metadata && t.metadata.ml_malicious_score) || t.confidence;
                why = 'Guardian ML' + (score ? ` · ${Math.round(score * 100)}%` : '');
            } else if (first.rule_name) {
                why = first.rule_name;
            } else {
                why = 'Detected';
            }
            const action = String(t.action_taken || '').toLowerCase().includes('block') ? 'blocked' : 'logged';
            return `${why} · ${action}`;
        };

        // Rows
        threats.forEach(threat => {
            const row = document.createElement('div');
            row.className = 'activity-row';

            // Content preview + inline verdict reason
            const contentCell = document.createElement('div');
            contentCell.className = 'activity-cell content-cell';
            const content = maskSecrets(threat.text_preview || threat.text_content || threat.indicator || threat.name || 'Analyzed content');
            const preview = document.createElement('div');
            preview.textContent = content.length > 50 ? content.substring(0, 50) + '...' : content;
            preview.title = content;
            contentCell.appendChild(preview);
            const verdict = document.createElement('div');
            verdict.textContent = verdictFor(threat);
            verdict.style.cssText = 'font-size: 11px; color: var(--text-muted); margin-top: 2px;';
            contentCell.appendChild(verdict);
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

            // Deep link straight to THIS record, not just the threats page.
            row.addEventListener('click', () => {
                if (threat.request_id && window.ThreatsPage) ThreatsPage.pendingRequestId = threat.request_id;
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
            // Backend timestamps are UTC without a zone suffix; bare strings
            // parse as LOCAL, skewing "Xh ago" by the UTC offset. Same
            // normalisation as ThreatsPage.formatDate.
            const norm = /[Z+\-]\d?\d?(:?\d\d)?$/.test(dateStr)
                ? dateStr
                : (dateStr.includes('T') ? dateStr + 'Z' : dateStr.replace(' ', 'T') + 'Z');
            const date = new Date(norm);
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


    // Protection card — one home for the enforcement switches (Block Mode /
    // Output Scan / Guardian ML) plus a Rules shortcut and live agent chips.
    // Confirmations go through Modal.confirm; the checkbox only flips after
    // the user confirms AND the API write succeeds (no optimistic flip).
    // Governance posture card (#187, local funnel). A 0–100 score computed
    // ENTIRELY from on-device signals the app already has — no new data
    // collection — plus a quiet, dismissible pointer to the cloud fleet-wide
    // posture + EU AI Act orientation, shown ONLY when Cloud Connect is off
    // (when it's on, the user already has the fleet view). The rubric is
    // transparent (surfaced in the tooltip + factor rows) so the local number
    // and the eventual cloud number share one honest methodology.
    async renderSecurityControls() {
        let settings = { block_threats: false, scan_llm_responses: true, guardian_ml_enabled: false };
        try {
            settings = await API.getSettings();
        } catch (e) {}

        const card = document.createElement('div');
        card.className = 'security-controls-section';
        card.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 12px; padding: 16px 20px; margin-bottom: 24px;';

        const head = document.createElement('div');
        head.style.cssText = 'display:flex; align-items:baseline; gap:10px; margin-bottom: 10px;';
        const title = document.createElement('div');
        title.textContent = 'Protection';
        title.style.cssText = 'font-weight: 700; font-size: 15px; color: var(--text-primary);';
        head.appendChild(title);
        const sub = document.createElement('span');
        sub.textContent = 'Local protection controls applied to your connected agents';
        sub.style.cssText = 'font-size: 12px; color: var(--text-secondary);';
        head.appendChild(sub);
        card.appendChild(head);

        const rows = document.createElement('div');
        rows.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 8px 24px;';
        card.appendChild(rows);

        // One toggle row. apply(newState) performs the API write; the
        // checkbox reflects the SAVED state only.
        const toggleRow = ({ name, desc, checked, attention, disabled, disabledNote, confirmTitle, confirmMsg, apply }) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:12px; padding: 8px 0; border-top: 1px solid var(--border-default);';

            const info = document.createElement('div');
            info.style.cssText = 'min-width: 0;';
            const nm = document.createElement('div');
            nm.style.cssText = 'font-weight: 600; font-size: 13.5px; color: var(--text-primary);';
            nm.textContent = name;
            if (attention && !checked) {
                const pill = document.createElement('span');
                pill.textContent = 'off';
                pill.style.cssText = 'margin-left:8px; font-size:10px; font-weight:700; text-transform:uppercase; color:#f59e0b; border:1px solid rgba(245,158,11,0.5); border-radius:999px; padding:1px 7px; vertical-align:1px;';
                nm.appendChild(pill);
            }
            info.appendChild(nm);
            const ds = document.createElement('div');
            ds.style.cssText = 'color: var(--text-secondary); font-size: 12px;';
            ds.textContent = disabled && disabledNote ? disabledNote : desc;
            info.appendChild(ds);
            row.appendChild(info);

            const toggle = document.createElement('label');
            toggle.className = 'toggle';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = checked;
            cb.disabled = !!disabled;
            cb.addEventListener('change', (e) => {
                const newState = e.target.checked;
                e.target.checked = !newState; // revert until confirmed + saved
                Modal.confirm({
                    title: confirmTitle(newState),
                    message: confirmMsg(newState),
                    confirmLabel: newState ? 'Enable' : 'Disable',
                    onConfirm: () => {
                        Promise.resolve(apply(newState)).then(() => {
                            cb.checked = newState;
                        }).catch(() => {
                            Toast.error('Failed to update');
                        });
                    },
                });
            });
            toggle.appendChild(cb);
            const slider = document.createElement('span');
            slider.className = 'toggle-slider';
            toggle.appendChild(slider);
            row.appendChild(toggle);
            return row;
        };

        rows.appendChild(toggleRow({
            name: 'Block Mode',
            desc: 'Stops threats on the OpenClaw proxy / analyze path. Hook & SDK tool calls are blocked natively regardless.',
            checked: !!settings.block_threats,
            attention: false,
            confirmTitle: (on) => on ? 'Enable Block Mode?' : 'Disable Block Mode?',
            confirmMsg: (on) => on
                ? 'On the OpenClaw proxy / analyze path, input threats are blocked before the LLM and output threats before the client. Hook & SDK tool-call blocking is native and unaffected by this setting.'
                : 'On the proxy / analyze path, threats will be logged instead of blocked. Native hook/SDK tool-call blocking is unaffected.',
            apply: (on) => {
                if (on) showOpenClawProxyModal(); else showOpenClawProxyStopModal();
                return API.updateSettings({ block_threats: on }).then(() => {
                    Toast.success(on ? 'Block mode enabled' : 'Block mode disabled');
                });
            },
        }));

        rows.appendChild(toggleRow({
            name: 'Output Scan',
            desc: 'Scans LLM responses for data leakage. Tool input/output is always redacted regardless.',
            checked: !!settings.scan_llm_responses,
            attention: false,
            confirmTitle: (on) => on ? 'Enable Output Scan?' : 'Disable Output Scan?',
            confirmMsg: (on) => on
                ? 'LLM responses on the OpenClaw proxy will be scanned and sensitive values redacted at rest. Tool input/output is already redacted regardless of this setting.'
                : 'LLM-response scanning on the proxy stops. Tool input/output is still redacted for secrets/PII.',
            apply: (on) => API.updateSettings({ scan_llm_responses: on }).then(() => {
                Toast.success(on ? 'Output scan enabled' : 'Output scan disabled');
            }),
        }));

        rows.appendChild(toggleRow({
            name: 'Guardian ML',
            desc: 'Local ML threat detection' + (settings.guardian_model_version ? ` · v${settings.guardian_model_version}` : ''),
            checked: !!settings.guardian_ml_enabled,
            disabled: settings.guardian_ml_available === false,
            disabledNote: 'Model not installed: see Guardian ML in the sidebar',
            confirmTitle: (on) => on ? 'Enable Guardian ML?' : 'Disable Guardian ML?',
            confirmMsg: (on) => on
                ? 'The local ML model scores every prompt alongside the rule engine. Runs entirely on this machine.'
                : 'Detection falls back to rules only.',
            apply: (on) => API.updateSettings({ guardian_ml_enabled: on }).then(() => {
                Toast.success(on ? 'Guardian ML enabled' : 'Guardian ML disabled');
            }),
        }));

        // Rules shortcut row — same grid, button instead of a toggle.
        const rulesRow = document.createElement('div');
        rulesRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:12px; padding: 8px 0; border-top: 1px solid var(--border-default);';
        const rulesInfo = document.createElement('div');
        const rulesName = document.createElement('div');
        rulesName.style.cssText = 'font-weight: 600; font-size: 13.5px; color: var(--text-primary);';
        rulesName.textContent = 'Rules';
        rulesInfo.appendChild(rulesName);
        const rulesDesc = document.createElement('div');
        rulesDesc.style.cssText = 'color: var(--text-secondary); font-size: 12px;';
        rulesDesc.textContent = 'Auto-block or alert on threats matching custom criteria';
        rulesInfo.appendChild(rulesDesc);
        rulesRow.appendChild(rulesInfo);
        const rulesBtn = document.createElement('button');
        rulesBtn.className = 'btn btn-secondary btn-sm';
        rulesBtn.textContent = 'Manage →';
        rulesBtn.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('rules'); });
        rulesRow.appendChild(rulesBtn);
        rows.appendChild(rulesRow);

        // Live agent chips — who protection is watching right now. Filled in
        // the background from the agent-session graph; row stays hidden when
        // nothing has been observed.
        const chipsWrap = document.createElement('div');
        chipsWrap.style.cssText = 'display:none; align-items:center; gap:8px; flex-wrap:wrap; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border-default);';
        card.appendChild(chipsWrap);
        API.getAgentSessionGraph({ window_days: 1 }).then((g) => {
            const sessions = (g.nodes || []).filter(n => n.kind === 'session');
            if (!sessions.length) return;
            const byHarness = new Map();
            sessions.forEach(s => {
                const h = s.harness || 'unknown';
                const cur = byHarness.get(h) || { total: 0, active: 0 };
                cur.total += 1;
                if (s.active) cur.active += 1;
                byHarness.set(h, cur);
            });
            const lbl = document.createElement('span');
            lbl.textContent = 'Watching now:';
            lbl.style.cssText = 'font-size: 11.5px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em;';
            chipsWrap.appendChild(lbl);
            [...byHarness.entries()].sort((a, b) => b[1].total - a[1].total).forEach(([h, c]) => {
                const chip = document.createElement('button');
                chip.style.cssText = 'display:inline-flex; align-items:center; gap:6px; font-size:12px; color: var(--text-primary); background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 999px; padding: 3px 10px; cursor: pointer;';
                const dot = document.createElement('span');
                dot.style.cssText = `width:7px; height:7px; border-radius:50%; background:${c.active ? '#10b981' : 'var(--text-muted)'};`;
                chip.appendChild(dot);
                const txt = document.createElement('span');
                txt.textContent = `${h} · ${c.total} agent${c.total === 1 ? '' : 's'}`;
                chip.appendChild(txt);
                chip.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('agent-map'); });
                chipsWrap.appendChild(chip);
            });
            chipsWrap.style.display = 'flex';
        }).catch(() => {});

        return card;
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
    /** Stop this page's timer when the user navigates away.
     *
     * Called by App._destroyPage(). Without it the dashboard auto-refresh poll
     * kept running (and re-firing its API call) for the rest of the
     * session, and returning to the page started a second one. */
    destroy() {
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
            this.autoRefreshInterval = null;
        }
    },
};

window.DashboardPage = DashboardPage;
