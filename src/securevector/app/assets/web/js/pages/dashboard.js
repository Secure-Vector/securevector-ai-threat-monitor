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
            sentence = `All clear — no threats in the ${rangeLabel}`;
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
        title.textContent = 'Get protected — connect your first agent';
        title.style.cssText = 'font-weight: 700; font-size: 14.5px; color: var(--text-primary); margin-bottom: 6px;';
        card.appendChild(title);

        const sub = document.createElement('div');
        sub.style.cssText = 'font-size: 13px; color: var(--text-secondary); line-height: 1.55; margin-bottom: 14px;';
        sub.textContent = 'Head to Connect Agents — pick your agent or harness, choose where SecureVector runs, and copy the commands. This dashboard fills in automatically once your first agent runs.';
        card.appendChild(sub);

        // Single CTA — the Connect Agents page is now the one front door, so the
        // old inline 3-step checklist is replaced by a redirect. Accent-outline
        // button (no cyan fill / white text).
        const cta = document.createElement('button');
        cta.style.cssText = 'display: inline-flex; align-items: center; gap: 8px; background: color-mix(in srgb, var(--accent-primary) 15%, transparent); border: 1px solid color-mix(in srgb, var(--accent-primary) 45%, transparent); color: var(--accent-primary); border-radius: 9px; padding: 10px 18px; font-size: 13px; font-weight: 700; cursor: pointer; transition: background 0.14s, border-color 0.14s;';
        cta.textContent = 'Connect Agents →';
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
                    if (window.Toast) Toast.success('First event received — you are live');
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

        // Posture header — outcome-encoded status sentence + global range
        // selector (24h/7d/30d). Banners/what's-new live in GlobalBanners.
        this._renderPostureHeader(container);


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
            const buildGapItem = (id, text, cta, onRemove) => {
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
                    try { localStorage.setItem('sv-attn-dismiss-' + id, String(Date.now())); } catch (_) { /* */ }
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
                if (!this.settings.block_threats) {
                    gaps.push(['block-mode', 'Block mode is off — threats are detected and logged, but nothing is stopped', 'Turn on']);
                }
                if (!this.settings.scan_llm_responses) {
                    gaps.push(['output-scan', 'Output scan is off — LLM responses are not checked or redacted', 'Turn on']);
                }
                if (this.settings.guardian_ml_available !== false && this.settings.guardian_ml_enabled === false) {
                    gaps.push(['guardian-ml', 'Guardian ML is off — detection is running on rules only', 'Turn on']);
                }
                gaps.forEach(([id, text, cta]) => {
                    if (Date.now() - dismissedAt(id) > 86400000) stack.appendChild(buildGapItem(id, text, cta, syncVis));
                });
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

        // ── Compact status bar + metrics grid ──────────────────────────────
        try {
            const valueSection = document.createElement('div');
            valueSection.style.cssText = 'margin-bottom: 18px;';

            // 5-KPI band data — every count respects the global range where
            // the backend can scope it (tool calls + secrets); spend is
            // always "today" because that's what the budget is set against.
            const kpiDays = this.rangeDays;
            const [auditDaily, redactions, costData, guardian] = await Promise.all([
                API.getToolCallAuditDaily(kpiDays).catch(() => null),
                API.getRedactions(kpiDays, { limit: 1 }).catch(() => null),
                API.getDashboardCostSummary().catch(() => null),
                API.getBudgetGuardian().catch(() => null),
            ]);

            // The daily endpoint buckets by calendar day and over-returns at
            // the window edge (days=1 includes yesterday) — clamp to the
            // last N calendar days client-side so 24h means "today".
            const kpiSinceDay = (() => {
                const d = new Date(Date.now() - (kpiDays - 1) * 86400000);
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            })();
            const toolCalls = auditDaily && auditDaily.days
                ? auditDaily.days.filter(d => d.day >= kpiSinceDay)
                    .reduce((s, d) => s + (d.blocked || 0) + (d.allowed || 0) + (d.logged || 0), 0)
                : 0;
            const secretsCaught = redactions && redactions.summary ? (redactions.summary.total || 0) : 0;
            // Format: $0.00 when zero or sub-cent (4-decimal precision feels
            // performative on a dashboard); $0.0123 only when the amount is
            // small but non-trivial. Two decimals once you've crossed $1.
            const _formatCost = (n) => {
                if (!n || n < 0.005) return '$0.00';
                if (n < 1) return '$' + n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
                return '$' + n.toFixed(2);
            };
            const todayCost = costData ? _formatCost(costData.today_cost_usd || 0) : '$0.00';

            // In-range threat slices \u2014 same lookback the posture sentence uses.
            const kpiCutoff = Date.now() - kpiDays * 86400000;
            const kpiParse = (iso) => {
                const d = new Date(String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z'));
                return isNaN(d) ? null : d;
            };
            const kpiThreats = (this.threats || []).filter(t => {
                const d = kpiParse(t.created_at);
                return t.is_threat && d && d.getTime() >= kpiCutoff;
            });
            const kpiBlocked = kpiThreats.filter(t => String(t.action_taken || '').toLowerCase().includes('block')).length;
            const kpiCritical = kpiThreats.filter(t => t.risk_score >= 80).length;

            // Value metrics grid
            const metricsGrid = document.createElement('div');
            metricsGrid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px;';

            const makeMetric = (value, label, color, navPage) => {
                const card = document.createElement('div');
                // KPI band is the dashboard's headline — give the cards real
                // presence (larger numbers, more padding) so the hero metrics
                // read first, ahead of the charts below.
                card.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 10px; padding: 16px 18px; cursor: pointer; transition: border-color 0.15s, transform 0.1s;';
                card.addEventListener('mouseenter', () => { card.style.borderColor = color + '66'; card.style.transform = 'translateY(-1px)'; });
                card.addEventListener('mouseleave', () => { card.style.borderColor = 'var(--border-default)'; card.style.transform = ''; });
                if (navPage) card.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate(navPage); });

                const valEl = document.createElement('div');
                valEl.style.cssText = 'font-size: 28px; font-weight: 800; color: ' + color + '; line-height: 1.05; margin-bottom: 6px; letter-spacing: -0.5px;';
                valEl.textContent = value;
                card.appendChild(valEl);

                const lblEl = document.createElement('div');
                lblEl.style.cssText = 'font-size: 11.5px; color: var(--text-secondary); font-weight: 600; line-height: 1.3; letter-spacing: 0.2px;';
                lblEl.textContent = label;
                card.appendChild(lblEl);

                return card;
            };

            const rangeTag = kpiDays === 1 ? '24h' : kpiDays + 'd';
            metricsGrid.appendChild(makeMetric(
                toolCalls.toLocaleString(),
                `Tool calls · ${rangeTag}`,
                '#5eadb8', 'tool-activity'
            ));
            metricsGrid.appendChild(makeMetric(
                kpiBlocked,
                `Threats blocked · ${rangeTag}`,
                kpiBlocked > 0 ? '#ef4444' : '#10b981', 'threats'
            ));
            metricsGrid.appendChild(makeMetric(
                kpiCritical,
                `Critical · ${rangeTag}`,
                kpiCritical > 0 ? '#ef4444' : '#10b981', 'threats'
            ));
            metricsGrid.appendChild(makeMetric(
                secretsCaught,
                `Secrets caught · ${rangeTag}`,
                secretsCaught > 0 ? '#f59e0b' : '#10b981', 'redactions'
            ));

            // Spend today — with a budget progress bar ONLY when a budget is
            // actually configured. No bar against an imaginary denominator.
            const spendCard = makeMetric(todayCost, 'Spend today', '#f59e0b', 'costs');
            const budgetUsd = guardian && guardian.global_budget_usd != null ? guardian.global_budget_usd : null;
            if (budgetUsd) {
                const pct = Math.min((guardian.global_pct_used || 0) * 100, 100);
                const barColor = guardian.global_over_budget ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#10b981';
                const track = document.createElement('div');
                track.style.cssText = 'height: 4px; border-radius: 2px; background: var(--bg-tertiary); overflow: hidden; margin-top: 7px;';
                const fill = document.createElement('div');
                fill.style.cssText = `height: 100%; border-radius: 2px; width: ${pct}%; background: ${barColor};`;
                track.appendChild(fill);
                spendCard.appendChild(track);
                const cap = document.createElement('div');
                cap.style.cssText = 'font-size: 10px; color: var(--text-muted); margin-top: 3px;';
                cap.textContent = `of $${Number(budgetUsd).toFixed(2)} budget`;
                spendCard.appendChild(cap);
            }
            metricsGrid.appendChild(spendCard);

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

        const chartDays = this.rangeDays;
        const chartLabel = chartDays === 1 ? 'Last 24h' : `Last ${chartDays} Days`;
        // Cost/token telemetry is day-grained — a 24h dollar chart would be
        // a single point, so the cost card never narrows below 7 days.
        const costDays = Math.max(chartDays, 7);

        const trendCard = Card.create({ title: `LLM Requests — ${chartLabel}`, gradient: true });
        const trendBody = trendCard.querySelector('.card-body');
        trendBody.innerHTML = '<div class="loading-container" style="height:140px;"><div class="spinner"></div></div>';
        chartsRow.appendChild(trendCard);
        this.renderTrendChart(trendBody, chartDays).catch(() => {
            trendBody.innerHTML = '<div style="height:140px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;">Chart unavailable</div>';
        });

        const costTrendCard = Card.create({ title: `Provider Cost — Last ${costDays} Days`, gradient: true });
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
        this.renderCostTrendChart(costBody, costTrendCard, costDays).catch(() => {
            costBody.innerHTML = '<div style="height:140px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;">Chart unavailable</div>';
        });

        container.appendChild(chartsRow);

        // Security Controls — moved adjacent to Recent Activity since they're
        // the "see threats / shape your response" pair. Previously they sat
        // between Reports and the charts which was a context break.
        const securityControls = await this.renderSecurityControls();
        container.appendChild(securityControls);

        // Governance posture moved to its own Cloud-section page
        // (GovernancePage) — kept off the dashboard to reduce clutter.

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

        // X-axis labels. One tick per data point collides once the window
        // grows (30 daily "MM/DD" or 24 hourly "HH:00" labels overrun 600px),
        // so thin to a stride that targets ~8 evenly-spaced ticks. First and
        // last are always shown; interior labels are dropped on the stride.
        // The text-anchor on the edge ticks is nudged inward so they don't
        // clip past the plot area.
        const targetTicks = 8;
        const stride = Math.max(1, Math.ceil(n / targetTicks));
        labels.forEach((lbl, i) => {
            const isFirst = i === 0;
            const isLast = i === n - 1;
            // Show first, last, and every stride-th label; never render a tick
            // adjacent to the last one (avoids a cramped final pair).
            if (!isFirst && !isLast && (i % stride !== 0 || (n - 1 - i) < stride / 2)) return;
            const t = document.createElementNS(svgNS, 'text');
            t.setAttribute('x', xAt(i));
            t.setAttribute('y', height - 6);
            t.setAttribute('text-anchor', isFirst ? 'start' : isLast ? 'end' : 'middle');
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

    /**
     * Requests/threats trend, scoped to the global range. Fetches the
     * window's records directly (up to 3 pages of 100) instead of reusing
     * the page-level 50-row sample, so 30-day charts aren't lies built on
     * the most recent 50 events. 24h renders hourly buckets.
     */
    async renderTrendChart(container, days = 7) {
        const parseTs = ts => new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
        const hourly = days === 1;
        const buckets = [];
        const now = new Date();
        if (hourly) {
            for (let i = 23; i >= 0; i--) {
                const d = new Date(now.getTime() - i * 3600000);
                buckets.push({ label: String(d.getHours()).padStart(2, '0') + ':00', key: `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`, total: 0, threats: 0 });
            }
        } else {
            for (let i = days - 1; i >= 0; i--) {
                const d = new Date();
                d.setDate(d.getDate() - i);
                buckets.push({ label: (d.getMonth()+1).toString().padStart(2,'0') + '/' + d.getDate().toString().padStart(2,'0'), key: `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`, total: 0, threats: 0 });
            }
        }
        const keyOf = (d) => hourly
            ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`
            : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

        // Pull the actual window from the API (start_date-scoped), not the
        // dashboard's 50-row sample. 3×100 covers typical local volume;
        // when there's more we say so instead of silently truncating.
        const startIso = new Date(Date.now() - days * 86400000).toISOString();
        let items = [];
        let total = 0;
        for (let page = 1; page <= 3; page++) {
            const resp = await API.getThreats({ page, page_size: 100, start_date: startIso }).catch(() => null);
            if (!resp) break;
            items = items.concat(resp.items || []);
            total = resp.total || items.length;
            if (items.length >= total || !(resp.items || []).length) break;
        }

        items.forEach(t => {
            const d = parseTs(t.created_at || new Date().toISOString());
            const bucket = buckets.find(b => b.key === keyOf(d));
            if (bucket) {
                bucket.total++;
                if ((t.risk_score || 0) >= 60) bucket.threats++;
            }
        });

        container.textContent = '';
        this._renderTimelineChart(container, {
            labels: buckets.map(b => b.label),
            series: [
                { label: 'Requests',           color: '#5eadb8', data: buckets.map(b => b.total) },
                { label: 'Threats (risk ≥60%)', color: '#ef4444', data: buckets.map(b => b.threats) },
            ],
            yFormat: n => Math.round(n).toLocaleString(),
        });
        if (total > items.length) {
            const note = document.createElement('div');
            note.style.cssText = 'font-size: 10.5px; color: var(--text-muted); margin-top: 4px;';
            note.textContent = `Showing the most recent ${items.length.toLocaleString()} of ${total.toLocaleString()} events in this window`;
            container.appendChild(note);
        }
    },

    async renderCostTrendChart(container, card, days = 7) {
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
            start.setDate(start.getDate() - days);
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
            { key: 'copilot-cli', label: 'Copilot CLI', color: '#4a8fe7', url: '/api/hooks/copilot-cli/token-usage' },
        ];

        const dailyByRuntime = await Promise.all(RUNTIMES.map(r => fetchDaily(r.url)));

        if (card) {
            const titleEl = card.querySelector('.card-title');
            if (titleEl) titleEl.textContent = `Token Usage — Last ${buckets.length} Days`;
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
            disabledNote: 'Model not installed — see Guardian ML in the sidebar',
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
};

window.DashboardPage = DashboardPage;
