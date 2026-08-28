/**
 * Costs Page
 * LLM cost tracking — per-agent spend, pricing reference, and budget control.
 *
 * Tabs:
 *   Overview    — Summary stats + per-agent breakdown + inline budget editing
 *   History     — Per-request records with filters and pagination
 *   Pricing     — Model pricing reference with sync (last)
 */

const CostsPage = {
    activeTab: 'optimizer',
    mode: 'monitor',
    summaryData: null,
    pricingData: null,
    recordsData: null,
    budgetData: null,
    agentBudgets: null,
    pollInterval: null,
    recordsPage: 1,
    recordsPageSize: 50,
    recordsFilter: { agent_id: '', provider: '', start: null },
    recordsSelectedIds: new Set(),
    pricingFilter: '',
    syncInProgress: false,
    lastSyncedAt: null,

    async render(container) {
        container.textContent = '';
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this._optPoll) { clearTimeout(this._optPoll); this._optPoll = null; }
        // One-shot tab handoff (Optimizer spotlight CTA, trace annotation
        // click-through) — consumed after App.pages has set the default tab.
        if (this._pendingTab) { this.activeTab = this._pendingTab; this._pendingTab = null; }

        if (this.mode === 'settings') {
            if (window.Header) Header.setPageInfo('Cost Settings', 'Set daily budgets and manage model pricing');
        } else {
            if (window.Header) Header.setPageInfo('Cost & Tokens', 'Token usage and LLM spend, per connected agent');
        }

        // Settings mode: budget card + pricing reference, no tab bar
        if (this.mode === 'settings') {
            await this._renderSettingsMode(container);
            return;
        }

        // Monitor mode: the per-runtime session panels that used to stack
        // here (four full-width cards before any tab content) now live as
        // one compact card INSIDE Cost Summary — the Optimizer and History
        // tabs start at the top of the page.

        // No `.tab-bar` class — see the same note on Tool Permissions.
        const tabs = document.createElement('div');
        tabs.id = 'costs-tabs';
        tabs.style.cssText = 'margin-bottom: 24px;';
        container.appendChild(tabs);

        const content = document.createElement('div');
        content.id = 'costs-tab-content';
        container.appendChild(content);

        this._renderTabBar();
        await this._renderActiveTab();

        // Poll overview and history (skip when tab is hidden)
        this.pollInterval = setInterval(async () => {
            if (document.hidden) return;
            if (this.activeTab === 'overview') await this._loadAndRenderOverview();
            else if (this.activeTab === 'history') await this._loadAndRenderHistory();
            else if (this.activeTab === 'optimizer') await this._refreshOptSessions();
        }, getPollInterval());
    },

    async _renderSettingsMode(container) {
        // Load data needed for both sections
        try {
            [this.budgetData, this.agentBudgets] = await Promise.all([
                API.getGlobalBudget().catch(() => ({})),
                API.listAgentBudgets().catch(() => []),
            ]);
        } catch (e) { /* non-fatal */ }

        // Global budget widget
        const budgetSection = this._buildGlobalBudgetWidget();
        container.appendChild(budgetSection);

        // Cost / Token Optimizer preferences (billing mode + recommendations).
        // Controls live here on the Policies side; the findings stay on
        // Cost & Tokens — the split the app already encodes.
        const optPrefsHost = document.createElement('div');
        container.appendChild(optPrefsHost);
        this._renderOptimizerPrefsCard(optPrefsHost);

        // Per-run limits (#203): the enforcement half of the Optimizer.
        const runLimitsHost = document.createElement('div');
        container.appendChild(runLimitsHost);
        this._renderRunLimitsCard(runLimitsHost);

        // Divider / heading for pricing
        const pricingHeading = document.createElement('div');
        pricingHeading.style.cssText = 'font-size: 13px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.6px; padding: 20px 0 10px;';
        pricingHeading.textContent = 'Pricing Reference';
        container.appendChild(pricingHeading);

        // Pricing reference content rendered into a wrapper div
        const pricingWrapper = document.createElement('div');
        pricingWrapper.id = 'costs-tab-content';
        container.appendChild(pricingWrapper);

        await this._loadAndRenderPricing();
    },

    // Same segmented control as Agent Observability, Threat Monitor and Tool
    // Permissions — every "one feature, several lenses" surface in the app now
    // switches views the same way. Monitor mode only shows summary + history.
    _TABS: [
        { id: 'overview',  label: 'Cost Summary',    icon: 'M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6' },
        // Overview stays first: it is the honest baseline number. Discovery of
        // the Optimizer is handled by the unseen dot, not by reordering.
        { id: 'optimizer', label: 'Optimizer',       icon: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z' },
        { id: 'history',   label: 'Request History', icon: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01' },
    ],

    _renderTabBar() {
        const bar = document.getElementById('costs-tabs');
        if (!bar) return;
        if (window.ObsTabs && ObsTabs._injectStyle) ObsTabs._injectStyle();
        bar.textContent = '';

        const wrap = document.createElement('div');
        wrap.className = 'sv-obs-tabs';
        wrap.setAttribute('role', 'tablist');

        this._TABS.forEach(({ id, label, icon }) => {
            const btn = document.createElement('button');
            const isActive = this.activeTab === id;
            let unseen = false;
            try {
                unseen = !localStorage.getItem('sv-tab-seen-costs-' + id) && id === 'optimizer';
                if (isActive) localStorage.setItem('sv-tab-seen-costs-' + id, '1');
            } catch (_) { /* private mode */ }
            btn.type = 'button';
            btn.className = 'sv-obs-tab' + (isActive ? ' on' : '');
            btn.setAttribute('role', 'tab');
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
            btn.innerHTML =
                `<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" ` +
                `stroke-linejoin="round"><path d="${icon}"/></svg><span></span>`;
            btn.querySelector('span').textContent = label;
            if (unseen && !isActive) {
                // Unseen marker: the read side of the sv-tab-seen-costs-<id>
                // contract. Teal (interactive accent), not amber: "new to
                // you" is not a security state.
                const dot = document.createElement('span');
                dot.style.cssText =
                    'display:inline-block;width:6px;height:6px;border-radius:50%;' +
                    'margin-left:6px;background:var(--accent-primary,#5eadb8);vertical-align:middle;';
                btn.appendChild(dot);
            }
            btn.addEventListener('click', async () => {
                if (this.activeTab === id) return;
                this.activeTab = id;
                this._renderTabBar();
                await this._renderActiveTab();
            });
            wrap.appendChild(btn);
        });

        bar.appendChild(wrap);
    },

    async _renderActiveTab() {
        const content = document.getElementById('costs-tab-content');
        if (!content) return;
        content.textContent = '';

        if (this.activeTab === 'overview') await this._loadAndRenderOverview();
        else if (this.activeTab === 'optimizer') await this._loadAndRenderOptimizer();
        else if (this.activeTab === 'history') await this._loadAndRenderHistory();
    },

    /** One compact card for per-runtime session tokens (replaces the four
     *  stacked panels this page used to open with). Dollar cost is
     *  deliberately not computed for plugin-guarded runtimes: most run on
     *  flat-rate subscriptions where a list-price figure would mislead, so
     *  tokens are the honest view and dollars live at the provider console.
     *  Each row is gated on that runtime actually having session data. */
    async _renderRuntimeTokensCard(host) {
        const defs = [
            { name: 'Claude Code', base: '/api/hooks/claude-code' },
            { name: 'Codex', base: '/api/hooks/codex' },
            { name: 'Copilot CLI', base: '/api/hooks/copilot-cli' },
            { name: 'OpenCode', base: '/api/hooks/opencode' },
            { name: 'Hermes', base: '/api/hooks/hermes' },
        ];
        const rows = await Promise.all(defs.map(async (d) => {
            try {
                const res = await fetch(d.base + '/token-usage');
                if (!res.ok) return null;
                const u = await res.json();
                const any = (u.sessions || 0) > 0 || (u.input_tokens || 0) > 0
                    || (u.output_tokens || 0) > 0;
                return any ? { name: d.name, u } : null;
            } catch { return null; }
        }));
        const live = rows.filter(Boolean);
        if (!live.length) return;

        const fmt = (n) => this._fmtTokens(n || 0);
        const card = document.createElement('div');
        card.className = 'svc-card';
        card.innerHTML =
            '<div class="svc-card-head"><span class="svc-card-title">Session Tokens by Runtime</span>' +
            '<span class="svc-pill" title="Exact token counts from local session data. Plugin-guarded runtimes bill through your provider subscription, so dollars live at the provider console.">tokens, exact</span></div>' +
            '<div class="svc-rt-grid svc-rt-head">' +
            '<span>Runtime</span><span>Sessions</span><span>Input</span>' +
            '<span>Cache write</span><span>Cache read</span><span>Output</span><span>Last activity</span></div>';
        live.forEach(({ name, u }) => {
            const row = document.createElement('div');
            row.className = 'svc-rt-grid';
            const last = u.last_activity ? new Date(u.last_activity).toLocaleString() : 'no activity';
            row.innerHTML =
                '<span class="svc-rt-name"><i></i></span>' +
                `<span class="svc-mono">${(u.sessions || 0).toLocaleString()}</span>` +
                `<span class="svc-mono">${fmt(u.input_tokens)}</span>` +
                `<span class="svc-mono">${fmt(u.cache_creation_input_tokens)}</span>` +
                `<span class="svc-mono">${fmt(u.cache_read_input_tokens)}</span>` +
                `<span class="svc-mono">${fmt(u.output_tokens)}</span>` +
                '<span class="svc-rt-last"></span>';
            row.querySelector('.svc-rt-name').appendChild(document.createTextNode(name));
            row.querySelector('.svc-rt-last').textContent = last;
            card.appendChild(row);
        });
        const foot = document.createElement('div');
        foot.className = 'svc-card-foot';
        foot.textContent = 'Read from local session files, same source as each tool\u2019s own usage view. The Optimizer tab explains where these tokens went.';
        card.appendChild(foot);
        host.appendChild(card);
    },

    async _loadAndRenderOverview() {
        const content = document.getElementById('costs-tab-content');
        if (!content || this.activeTab !== 'overview') return;

        try {
            [this.summaryData, this._guardianData, this.budgetData, this.agentBudgets] = await Promise.all([
                API.getCostSummary(),
                API.getBudgetGuardian(),
                API.getGlobalBudget().catch(() => ({})),
                API.listAgentBudgets().catch(() => []),
            ]);
        } catch (e) {
            content.textContent = '';
            const err = document.createElement('p');
            err.className = 'error-message';
            err.textContent = `Failed to load cost data: ${e.message}`;
            content.appendChild(err);
            return;
        }

        this._optInjectStyle(); // svc-* overview styles ride the same sheet
        const isFirstRender = !document.getElementById('sv-costs-cards');

        if (isFirstRender) {
            content.textContent = '';

            // Budget progress bar at top (read-only summary)
            const budgetBar = document.createElement('div');
            budgetBar.id = 'sv-costs-budget-bar';
            content.appendChild(budgetBar);

            // Scaffold the layout with stable IDs — never rebuilt on polls
            const cardsEl = document.createElement('div');
            cardsEl.id = 'sv-costs-cards';
            content.appendChild(cardsEl);

            // Placeholder host: sits directly under the (hidden) spend strip
            // when there's no proxy traffic, above the runtime tokens.
            const placeholderHost = document.createElement('div');
            placeholderHost.id = 'sv-costs-placeholder-host';
            content.appendChild(placeholderHost);

            // Per-runtime session tokens (rendered once; not on the poll path)
            const runtimesEl = document.createElement('div');
            runtimesEl.id = 'sv-costs-runtimes';
            content.appendChild(runtimesEl);
            this._renderRuntimeTokensCard(runtimesEl);

            // Daily-spend chart, framed with a proper section header
            const chartSection = document.createElement('div');
            chartSection.id = 'sv-costs-chart';
            chartSection.className = 'svc-card';
            const chartHead = document.createElement('div');
            chartHead.className = 'svc-card-head';
            chartHead.innerHTML =
                '<span class="svc-card-title">Daily Spend</span>' +
                '<span class="svc-pill" title="Metered through the SecureVector proxy.">metered</span>';
            const refreshBtn = document.createElement('button');
            refreshBtn.id = 'sv-costs-chart-refresh';
            refreshBtn.type = 'button';
            refreshBtn.className = 'btn btn-secondary btn-sm';
            refreshBtn.style.cssText = 'margin-left:auto;';
            refreshBtn.textContent = 'Refresh';
            chartHead.appendChild(refreshBtn);
            chartSection.appendChild(chartHead);
            const chartContainer = document.createElement('div');
            chartSection.appendChild(chartContainer);
            content.appendChild(chartSection);
            await this._initCostChart(chartContainer);
            refreshBtn.addEventListener('click', async () => {
                refreshBtn.textContent = 'Refreshing…';
                refreshBtn.disabled = true;
                await this._loadAndRenderChart(chartContainer);
                refreshBtn.textContent = 'Refresh';
                refreshBtn.disabled = false;
            });

            const guardianEl = document.createElement('div');
            guardianEl.id = 'sv-costs-guardian';
            content.appendChild(guardianEl);

            const agentsEl = document.createElement('div');
            agentsEl.id = 'sv-costs-agents';
            content.appendChild(agentsEl);
        }

        // Update each data section in-place — chart is untouched
        this._updateBudgetBar();
        this._updateSummaryCards();
        this._updateGuardianAlerts();
        this._updateAgentsSection();

        // Hide the proxy cost UI entirely when there's no proxy traffic.
        // The Cost & Tokens page exists to surface SecureVector-proxy
        // spend; if the user is running CC-plugin-only (no proxy), the
        // 5 $0/0 tiles + empty daily-spend chart + empty per-agent
        // section collectively eat ~700px of vertical noise. The CC
        // token panel above is doing the real work. Show one quiet
        // placeholder line in its place so we don't render a ghost UI.
        const totals = (this.summaryData && this.summaryData.totals) || {};
        const proxyHasData = (
            (totals.total_requests || 0) > 0
            || (totals.today_spend_usd || 0) > 0
            || (totals.monthly_cost_usd || 0) > 0
            || (totals.total_input_tokens || 0) > 0
            || (totals.total_output_tokens || 0) > 0
        );
        const ids = ['sv-costs-cards', 'sv-costs-chart', 'sv-costs-agents'];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = proxyHasData ? '' : 'none';
        });
        // Inline placeholder when there's no proxy traffic. The CC
        // panel above already explains the "token sessions only"
        // posture; this line is about the empty proxy surface.
        // Wording calls out both possibilities the user might be in:
        // (a) proxy not running / unreachable on the local machine, or
        // (b) proxy running but nothing has been routed through it.
        let placeholder = document.getElementById('sv-proxy-cost-placeholder');
        if (!proxyHasData) {
            if (!placeholder) {
                placeholder = document.createElement('div');
                placeholder.id = 'sv-proxy-cost-placeholder';
                placeholder.style.cssText = 'padding: 28px 24px; margin-bottom: 14px; background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 12px; text-align: center;';
                placeholder.textContent = '';
                const icon = document.createElement('div');
                icon.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="var(--text-muted)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>';
                icon.style.cssText = 'margin-bottom: 8px;';
                placeholder.appendChild(icon);
                const line1 = document.createElement('div');
                line1.style.cssText = 'font-weight: 700; font-size: 13.5px; color: var(--text-primary); margin-bottom: 5px;';
                line1.textContent = 'No proxy cost data yet';
                placeholder.appendChild(line1);
                const line2 = document.createElement('div');
                line2.style.cssText = 'color: var(--text-secondary); font-size: 12px; line-height: 1.55; max-width: 560px; margin: 0 auto 4px;';
                line2.textContent = 'Cost tiles populate once LLM requests are routed through the SecureVector proxy on 127.0.0.1.';
                placeholder.appendChild(line2);
                const line3 = document.createElement('div');
                line3.style.cssText = 'color: var(--text-muted); font-size: 11.5px; line-height: 1.55; max-width: 560px; margin: 0 auto;';
                line3.textContent = 'Plugin-guarded runtimes (like Claude Code) don’t use the proxy: their token usage lives in the Session Tokens card below.';
                placeholder.appendChild(line3);
                (document.getElementById('sv-costs-placeholder-host') || content).appendChild(placeholder);
            } else {
                placeholder.style.display = '';
            }
        } else if (placeholder) {
            placeholder.style.display = 'none';
        }
    },

    _updateBudgetBar() {
        const el = document.getElementById('sv-costs-budget-bar');
        if (!el) return;
        el.textContent = '';
        const budget = this.budgetData;
        // NOTE: the API field is daily_budget_usd — this bar used to read
        // budget_usd and therefore never rendered at all.
        const limit = budget && budget.daily_budget_usd;
        if (!limit) return;

        const todaySpend = (this.summaryData && this.summaryData.totals && this.summaryData.totals.today_spend_usd) || 0;
        const pct = limit > 0 ? Math.min(todaySpend / limit, 1) : 0;
        const pctDisplay = Math.round(pct * 100);
        const isOver = todaySpend >= limit;
        const isWarn = pct >= 0.8;
        const barColor = isOver ? '#ef4444' : isWarn ? '#f59e0b' : '#10b981';

        const bar = document.createElement('div');
        bar.style.cssText = 'display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 8px; margin-bottom: 14px; font-size: 12px;';

        const label = document.createElement('span');
        label.style.cssText = 'color: var(--text-secondary); white-space: nowrap;';
        label.textContent = `Daily budget: $${todaySpend.toFixed(4)} / $${limit.toFixed(2)} (${pctDisplay}%)`;
        bar.appendChild(label);

        const track = document.createElement('div');
        track.style.cssText = 'flex: 1; height: 6px; border-radius: 3px; background: var(--bg-tertiary); overflow: hidden; min-width: 80px;';
        const fill = document.createElement('div');
        fill.style.cssText = `height: 100%; border-radius: 3px; background: ${barColor}; width: ${pct * 100}%; transition: width 0.3s;`;
        track.appendChild(fill);
        bar.appendChild(track);

        const editLink = document.createElement('a');
        editLink.style.cssText = 'font-size: 11px; color: var(--accent-primary); cursor: pointer; text-decoration: none; white-space: nowrap;';
        editLink.textContent = 'Edit';
        editLink.addEventListener('click', (e) => {
            e.preventDefault();
            if (window.Sidebar) Sidebar.navigate('cost-settings');
        });
        bar.appendChild(editLink);

        el.appendChild(bar);
    },

    _updateSummaryCards() {
        const el = document.getElementById('sv-costs-cards');
        if (!el) return;
        el.textContent = '';
        const totals = (this.summaryData && this.summaryData.totals) || {};
        const usd = (v) => '$' + ((v || 0) < 1 ? (v || 0).toFixed(4) : (v || 0).toFixed(2));
        // One strip, same visual language as the Optimizer's comparison: the
        // metered figures lead (they are invoices-in-motion, not estimates),
        // each cell one number with its label under it.
        const strip = document.createElement('div');
        strip.className = 'svc-strip';
        strip.innerHTML =
            '<div class="svc-strip-head"><span class="svo-eyebrow">Metered proxy spend</span>' +
            '<span class="svc-pill" title="Recorded per request as agents route through the SecureVector proxy. These are metered figures, not estimates.">metered</span></div>' +
            '<div class="svc-strip-row">' +
            `<div class="svc-cell"><div class="svc-v">${usd(totals.today_spend_usd)}</div><div class="svc-l">today · resets midnight</div></div>` +
            `<div class="svc-cell"><div class="svc-v">${usd(totals.monthly_cost_usd)}</div><div class="svc-l">this month</div></div>` +
            `<div class="svc-cell"><div class="svc-v">${(totals.total_requests || 0).toLocaleString()}</div><div class="svc-l">requests</div></div>` +
            `<div class="svc-cell"><div class="svc-v">${this._fmtTokens(totals.total_input_tokens || 0)} <span class="svc-arrow">→</span> ${this._fmtTokens(totals.total_output_tokens || 0)}</div><div class="svc-l">tokens in → out</div></div>` +
            '</div>';
        el.appendChild(strip);
    },

    _updateGuardianAlerts() {
        const el = document.getElementById('sv-costs-guardian');
        if (!el) return;
        el.textContent = '';
        const gd = this._guardianData;
        if (!gd) return;
        const hasGlobalAlert = gd.global_budget_usd != null && (gd.global_over_budget || gd.global_warning);
        const hasAgentAlerts = gd.agent_alerts && gd.agent_alerts.some(a => a.over_budget || a.warning);
        if (!hasGlobalAlert && !hasAgentAlerts) return;

        const guardianBox = document.createElement('div');
        guardianBox.style.cssText = 'margin-bottom: 12px; display: flex; flex-direction: column; gap: 8px;';

        const buildAlert = (label, today, budget, pct, over, action) => {
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
            track.style.cssText = 'height: 6px; border-radius: 3px; background: var(--bg-tertiary); overflow: hidden;';
            const fill = document.createElement('div');
            fill.style.cssText = `height: 100%; border-radius: 3px; background: ${color}; width: ${Math.min(pct * 100, 100)}%; transition: width 0.3s;`;
            track.appendChild(fill);
            info.appendChild(track);
            bar.appendChild(info);
            const badge = document.createElement('span');
            badge.className = over && action === 'block' ? 'badge badge-error' : 'badge badge-warning';
            badge.textContent = over && action === 'block' ? 'Blocked' : over ? 'Over limit' : '80%+ used';
            bar.appendChild(badge);
            return bar;
        };

        if (hasGlobalAlert) {
            guardianBox.appendChild(buildAlert('Global budget', gd.global_today_spend_usd, gd.global_budget_usd, gd.global_pct_used, gd.global_over_budget, gd.global_budget_action));
        }
        if (hasAgentAlerts) {
            gd.agent_alerts.filter(a => a.over_budget || a.warning).forEach(a => {
                guardianBox.appendChild(buildAlert(a.agent_id.length > 28 ? a.agent_id.slice(0, 28) + '…' : a.agent_id, a.today_spend_usd, a.budget_usd, a.pct_used, a.over_budget, a.budget_action));
            });
        }
        el.appendChild(guardianBox);
    },

    _updateAgentsSection() {
        const el = document.getElementById('sv-costs-agents');
        if (!el) return;
        el.textContent = '';
        const agents = (this.summaryData && this.summaryData.agents) || [];

        if (agents.some(a => a.has_unknown_pricing)) {
            const warn = document.createElement('div');
            warn.className = 'alert alert-warning';
            warn.textContent = 'Some requests used models with unknown pricing: costs show as $0.00. Update rates in the Pricing Reference tab.';
            el.appendChild(warn);
        }

        const sectionTitle = document.createElement('div');
        sectionTitle.className = 'svo-sec-h';
        sectionTitle.style.cssText = 'margin: 20px 0 10px;';
        sectionTitle.textContent = 'Per-Agent Breakdown';
        el.appendChild(sectionTitle);

        if (agents.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            const t = document.createElement('div'); t.className = 'empty-state-title'; t.textContent = 'No cost data yet';
            const m = document.createElement('div'); m.className = 'empty-state-text'; m.textContent = 'Costs are recorded automatically as agents route requests through the SecureVector proxy.';
            empty.appendChild(t); empty.appendChild(m);
            el.appendChild(empty);
            return;
        }

        const self = this;
        const agentDt = new DataTable({
            columns: [
                { key: 'agent_id', label: 'Agent ID', sortable: true, render: (val, row) => {
                    const wrap = document.createDocumentFragment();
                    const code = document.createElement('code');
                    code.textContent = val.length > 28 ? val.slice(0, 28) + '\u2026' : val;
                    code.title = val;
                    wrap.appendChild(code);
                    if (row.has_unknown_pricing) {
                        const badge = document.createElement('span');
                        badge.className = 'badge badge-warning'; badge.title = 'Some requests have unknown pricing'; badge.textContent = '~';
                        wrap.appendChild(badge);
                    }
                    return wrap;
                }},
                { key: 'total_requests', label: 'Requests', sortable: true, render: v => (v || 0).toLocaleString() },
                { key: 'total_input_tokens', label: 'Input Tokens', sortable: true, render: v => self._fmtTokens(v) },
                { key: 'total_output_tokens', label: 'Output Tokens', sortable: true, render: v => self._fmtTokens(v) },
                { key: 'total_cost_usd', label: 'Total Cost', sortable: true, render: v => {
                    const s = document.createElement('strong'); s.textContent = `$${(v || 0).toFixed(6)}`; return s;
                }},
                { key: null, label: 'Daily Budget', render: (_, row) => self._buildAgentBudgetCell(row, true) },
                { key: 'providers_used', label: 'Providers', render: v => (v || []).join(', ') },
                { key: 'last_seen', label: 'Last Seen', sortable: true, defaultDir: 'desc', render: v => v ? new Date(v).toLocaleString() : '—' },
            ],
            data: agents,
            sortKey: 'total_cost_usd',
            sortDir: 'desc',
            idField: 'agent_id',
            emptyText: 'No agent cost data yet.',
        });
        el.appendChild(agentDt.el);

        const actionsRow = document.createElement('div');
        actionsRow.style.cssText = 'display: flex; gap: 10px; margin-top: 0.75rem; align-items: center;';
        const exportBtn = document.createElement('a');
        exportBtn.className = 'btn btn-secondary'; exportBtn.href = API.getCostExportUrl(); exportBtn.textContent = 'Export CSV';
        actionsRow.appendChild(exportBtn);
        const histLink = document.createElement('button');
        histLink.className = 'btn btn-secondary'; histLink.textContent = 'View Request History →';
        histLink.addEventListener('click', () => { this.activeTab = 'history'; this._renderTabBar(); this._renderActiveTab(); });
        actionsRow.appendChild(histLink);
        el.appendChild(actionsRow);
    },

    // ==================== Request History Tab ====================

    async _loadAndRenderHistory() {
        const content = document.getElementById('costs-tab-content');
        if (!content || this.activeTab !== 'history') return;

        try {
            this.recordsData = await API.getCostRecords({
                agent_id: this.recordsFilter.agent_id || undefined,
                provider: this.recordsFilter.provider || undefined,
                page: this.recordsPage,
                page_size: this.recordsPageSize,
            });
        } catch (e) {
            content.textContent = '';
            const err = document.createElement('p');
            err.className = 'error-message';
            err.textContent = `Failed to load request history: ${e.message}`;
            content.appendChild(err);
            return;
        }

        content.textContent = '';

        // Filters toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'filters-bar';

        const todayBtn = document.createElement('button');
        todayBtn.className = 'btn btn-secondary btn-sm' + (this.recordsFilter.start ? ' active' : '');
        todayBtn.textContent = 'Today';
        todayBtn.title = 'Show only today\'s requests (UTC)';
        todayBtn.addEventListener('click', async () => {
            if (this.recordsFilter.start) {
                this.recordsFilter.start = null;
                todayBtn.classList.remove('active');
            } else {
                const now = new Date();
                const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
                this.recordsFilter.start = startOfDay.toISOString();
                todayBtn.classList.add('active');
            }
            this.recordsPage = 1;
            await this._reloadRecords();
        });
        toolbar.appendChild(todayBtn);

        const agentInput = document.createElement('input');
        agentInput.type = 'text';
        agentInput.className = 'filter-input';
        agentInput.placeholder = 'Filter by agent ID…';
        agentInput.value = this.recordsFilter.agent_id;
        agentInput.addEventListener('change', async () => {
            this.recordsFilter.agent_id = agentInput.value.trim();
            this.recordsPage = 1;
            await this._reloadRecords();
        });
        toolbar.appendChild(agentInput);

        const providerInput = document.createElement('input');
        providerInput.type = 'text';
        providerInput.className = 'filter-input';
        providerInput.placeholder = 'Filter by provider…';
        providerInput.value = this.recordsFilter.provider;
        providerInput.addEventListener('change', async () => {
            this.recordsFilter.provider = providerInput.value.trim();
            this.recordsPage = 1;
            await this._reloadRecords();
        });
        toolbar.appendChild(providerInput);

        const exportRecBtn = document.createElement('a');
        exportRecBtn.className = 'btn btn-secondary';
        exportRecBtn.textContent = 'Export CSV';
        exportRecBtn.href = API.getCostExportUrl({
            agent_id: this.recordsFilter.agent_id || undefined,
            provider: this.recordsFilter.provider || undefined,
        });
        toolbar.appendChild(exportRecBtn);

        const deleteSelectedBtn = document.createElement('button');
        deleteSelectedBtn.id = 'records-delete-selected-btn';
        deleteSelectedBtn.className = 'btn btn-danger';
        deleteSelectedBtn.style.cssText = 'margin-left: auto; display: none;';
        deleteSelectedBtn.textContent = 'Delete Selected (0)';
        deleteSelectedBtn.addEventListener('click', () => this._confirmDeleteSelected());
        toolbar.appendChild(deleteSelectedBtn);

        content.appendChild(toolbar);

        const recordsContainer = document.createElement('div');
        recordsContainer.id = 'records-container';
        content.appendChild(recordsContainer);

        this._renderRecordsTable(recordsContainer);
    },

    async _reloadRecords() {
        try {
            this.recordsData = await API.getCostRecords({
                agent_id: this.recordsFilter.agent_id || undefined,
                provider: this.recordsFilter.provider || undefined,
                start: this.recordsFilter.start || undefined,
                page: this.recordsPage,
                page_size: this.recordsPageSize,
            });
        } catch (e) {
            return;
        }
        const container = document.getElementById('records-container');
        if (container) {
            container.textContent = '';
            this._renderRecordsTable(container);
        }
    },

    _updateDeleteSelectedBtn() {
        const btn = document.getElementById('records-delete-selected-btn');
        if (!btn) return;
        const count = this.recordsSelectedIds.size;
        if (count > 0) {
            btn.style.display = '';
            btn.textContent = `Delete Selected (${count})`;
        } else {
            btn.style.display = 'none';
        }
        const tbl = document.getElementById('costs-records-table');
        if (tbl) tbl.classList.toggle('has-selection', count > 0);
    },

    _toggleSelectAll(checked, records) {
        if (checked) {
            records.forEach(r => this.recordsSelectedIds.add(r.id));
        } else {
            records.forEach(r => this.recordsSelectedIds.delete(r.id));
        }
        document.querySelectorAll('.record-checkbox').forEach(cb => { cb.checked = checked; });
        document.querySelectorAll('tbody tr').forEach(tr => tr.classList.toggle('selected', checked));
        this._updateDeleteSelectedBtn();
    },

    _toggleSelectRecord(id, checked, records) {
        if (checked) {
            this.recordsSelectedIds.add(id);
        } else {
            this.recordsSelectedIds.delete(id);
        }
        // Update select-all state
        const selectAllCb = document.getElementById('records-select-all');
        if (selectAllCb) {
            selectAllCb.checked = records.length > 0 && this.recordsSelectedIds.size === records.length;
            selectAllCb.indeterminate = this.recordsSelectedIds.size > 0 && this.recordsSelectedIds.size < records.length;
        }
        this._updateDeleteSelectedBtn();
    },

    async _confirmDeleteSelected() {
        const count = this.recordsSelectedIds.size;
        if (count === 0) return;
        const confirmed = confirm(`Delete ${count} selected record${count !== 1 ? 's' : ''}?\n\nThis action cannot be undone.`);
        if (!confirmed) return;
        try {
            const ids = Array.from(this.recordsSelectedIds);
            const result = await API.deleteCostRecords(null, ids);
            window.UI && UI.showNotification(`Deleted ${result.deleted} record(s)`, 'success');
            this.recordsSelectedIds.clear();
            this.recordsPage = 1;
            await this._reloadRecords();
        } catch (e) {
            window.UI && UI.showNotification(`Failed: ${e.message}`, 'error');
        }
    },

    _renderRecordsTable(container) {
        container.textContent = '';
        const records = this.recordsData ? (this.recordsData.items || []) : [];
        const total = this.recordsData ? (this.recordsData.total || 0) : 0;

        if (records.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            const icon = document.createElement('div');
            icon.className = 'empty-icon';
            icon.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" ' +
                'stroke="var(--text-muted)" stroke-width="1.6" stroke-linecap="round" ' +
                'stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>';
            const t = document.createElement('div');
            t.className = 'empty-title';
            t.textContent = 'No metered requests yet';
            const m = document.createElement('div');
            m.className = 'empty-message';
            m.textContent = 'This table lists requests billed through the SecureVector proxy. '
                + 'Plugin runtimes like Claude Code do not use the proxy: their per-request '
                + 'history lives in Traces, and their token totals in Cost Summary.';
            const go = document.createElement('button');
            go.type = 'button';
            go.className = 'btn btn-secondary btn-sm';
            go.style.marginTop = '10px';
            go.textContent = 'View session requests in Traces';
            go.addEventListener('click', () => {
                if (window.Sidebar && Sidebar.navigate) Sidebar.navigate('agent-runs');
            });
            empty.appendChild(icon);
            empty.appendChild(t);
            empty.appendChild(m);
            empty.appendChild(go);
            container.appendChild(empty);
            return;
        }

        const self = this;
        const recordsDt = new DataTable({
            columns: [
                { key: 'recorded_at', label: 'Time', sortable: true, defaultDir: 'desc', render: v => new Date(v).toLocaleString() },
                { key: 'agent_id', label: 'Agent', sortable: true, render: v => {
                    const c = document.createElement('code');
                    if (v && v.length > 28) { c.textContent = v.slice(0, 28) + '\u2026'; c.title = v; }
                    else c.textContent = v || '—';
                    return c;
                }},
                { key: 'provider', label: 'Provider', sortable: true },
                { key: 'model_id', label: 'Model', sortable: true },
                { key: 'input_tokens', label: 'Input', sortable: true, render: v => (v || 0).toLocaleString() },
                { key: 'input_cached_tokens', label: 'Cached', sortable: true, render: (v, row) => {
                    if (!v || v <= 0) return '—';
                    const pct = row.input_tokens > 0 ? ` (${Math.round(v / row.input_tokens * 100)}%)` : '';
                    return v.toLocaleString() + pct;
                }},
                { key: 'output_tokens', label: 'Output', sortable: true, render: v => (v || 0).toLocaleString() },
                { key: 'total_cost_usd', label: 'Cost', sortable: true, render: v => `$${(v || 0).toFixed(6)}` },
                { key: 'pricing_known', label: 'Pricing', render: v => {
                    const b = document.createElement('span');
                    b.className = v ? 'badge badge-success' : 'badge badge-warning';
                    b.textContent = v ? 'Known' : 'Unknown';
                    return b;
                }},
            ],
            data: records,
            selectable: true,
            bulkActions: [
                { label: 'Delete', className: 'btn btn-sm btn-danger', onClick: (ids) => self._bulkDeleteRecords(ids) },
            ],
            idField: 'id',
            sortKey: 'recorded_at',
            sortDir: 'desc',
            onRowClick: (r) => SideDrawer.show({ title: 'Request Detail', content: self._buildCostDrawerContent(r) }),
            onSelectChange: (ids) => {
                self.recordsSelectedIds = ids;
                self._updateRecordsDeleteBtn();
            },
            tableId: 'costs-records-table',
            emptyText: 'No cost records found.',
        });
        // Sync initial selection
        recordsDt.selectedIds = new Set(this.recordsSelectedIds);
        container.appendChild(recordsDt.el);

        this._renderPagination(container, total);
    },

    _buildCostDrawerContent(r) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display: flex; flex-direction: column; gap: 16px;';
        const section = (label, node) => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
            const lbl = document.createElement('div');
            lbl.style.cssText = 'font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.6px;';
            lbl.textContent = label;
            row.appendChild(lbl);
            if (typeof node === 'string') {
                const val = document.createElement('div');
                val.style.cssText = 'font-size: 13px; color: var(--text-primary);';
                val.textContent = node;
                row.appendChild(val);
            } else { row.appendChild(node); }
            return row;
        };
        const banner = document.createElement('div');
        banner.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-radius: 8px; background: rgba(94,173,184,0.08); border: 1px solid rgba(94,173,184,0.25);';
        const costVal = document.createElement('div');
        costVal.style.cssText = 'font-size: 28px; font-weight: 800; color: var(--accent-primary); font-family: monospace;';
        costVal.textContent = '$' + r.total_cost_usd.toFixed(6);
        banner.appendChild(costVal);
        const pricingBadge = document.createElement('span');
        pricingBadge.className = r.pricing_known ? 'badge badge-success' : 'badge badge-warning';
        pricingBadge.textContent = r.pricing_known ? 'Pricing known' : 'Pricing estimated';
        banner.appendChild(pricingBadge);
        wrap.appendChild(banner);
        wrap.appendChild(section('Time', new Date(r.recorded_at).toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })));
        const metaGrid = document.createElement('div');
        metaGrid.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 12px;';
        const agentEl = document.createElement('code');
        agentEl.style.cssText = 'font-size: 12px; color: var(--text-primary); word-break: break-all;';
        agentEl.textContent = r.agent_id || '—';
        metaGrid.appendChild(section('Agent ID', agentEl));
        metaGrid.appendChild(section('Provider', r.provider || '—'));
        wrap.appendChild(metaGrid);
        const modelEl = document.createElement('code');
        modelEl.style.cssText = 'font-size: 13px; font-weight: 600; color: var(--text-primary);';
        modelEl.textContent = r.model_id || '—';
        wrap.appendChild(section('Model', modelEl));
        const tokenGrid = document.createElement('div');
        tokenGrid.style.cssText = 'display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;';
        const tokenCard = (label, value, color) => {
            const card = document.createElement('div');
            card.style.cssText = 'background: var(--bg-tertiary); border-radius: 6px; padding: 10px 12px; text-align: center;';
            const v = document.createElement('div');
            v.style.cssText = 'font-size: 18px; font-weight: 700; color: ' + (color || 'var(--text-primary)') + '; font-family: monospace;';
            v.textContent = value;
            const l = document.createElement('div');
            l.style.cssText = 'font-size: 11px; color: var(--text-muted); margin-top: 2px;';
            l.textContent = label;
            card.appendChild(v); card.appendChild(l); return card;
        };
        tokenGrid.appendChild(tokenCard('Input', r.input_tokens.toLocaleString(), '#60a5fa'));
        const cachedPct = r.input_tokens > 0 && r.input_cached_tokens > 0
            ? Math.round(r.input_cached_tokens / r.input_tokens * 100) + '%' : '0%';
        tokenGrid.appendChild(tokenCard('Cached', r.input_cached_tokens > 0 ? r.input_cached_tokens.toLocaleString() + ' (' + cachedPct + ')' : '—', 'var(--text-primary)'));
        tokenGrid.appendChild(tokenCard('Output', r.output_tokens.toLocaleString(), 'var(--text-primary)'));
        wrap.appendChild(section('Token Usage', tokenGrid));
        return wrap;
    },

    _renderPagination(container, total) {
        const totalPages = Math.ceil(total / this.recordsPageSize);
        if (totalPages <= 1) return;

        const pager = document.createElement('div');
        pager.className = 'pagination';

        const prev = document.createElement('button');
        prev.className = 'btn btn-secondary btn-sm';
        prev.textContent = '← Prev';
        prev.disabled = this.recordsPage <= 1;
        prev.addEventListener('click', async () => {
            this.recordsPage--;
            await this._reloadRecords();
        });

        const info = document.createElement('span');
        info.className = 'pagination-info';
        info.textContent = `Page ${this.recordsPage} of ${totalPages} (${total.toLocaleString()} records)`;

        const next = document.createElement('button');
        next.className = 'btn btn-secondary btn-sm';
        next.textContent = 'Next →';
        next.disabled = this.recordsPage >= totalPages;
        next.addEventListener('click', async () => {
            this.recordsPage++;
            await this._reloadRecords();
        });

        pager.appendChild(prev);
        pager.appendChild(info);
        pager.appendChild(next);
        container.appendChild(pager);
    },

    // ==================== Pricing Tab ====================

    async _loadAndRenderPricing() {
        const content = document.getElementById('costs-tab-content');
        if (!content) return;

        try {
            this.pricingData = await API.getModelPricing(this.pricingFilter || undefined);
        } catch (e) {
            const err = document.createElement('p');
            err.className = 'error-message';
            err.textContent = `Failed to load pricing: ${e.message}`;
            content.textContent = '';
            content.appendChild(err);
            return;
        }

        content.textContent = '';

        const toolbar = document.createElement('div');
        toolbar.className = 'filters-bar';

        const providers = this.pricingData.providers || [];
        const select = document.createElement('select');
        select.className = 'filter-select';
        const allOpt = document.createElement('option');
        allOpt.value = '';
        allOpt.textContent = 'All Providers';
        select.appendChild(allOpt);
        providers.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p;
            opt.textContent = p.charAt(0).toUpperCase() + p.slice(1);
            if (p === this.pricingFilter) opt.selected = true;
            select.appendChild(opt);
        });
        select.addEventListener('change', async () => {
            this.pricingFilter = select.value;
            await this._loadAndRenderPricing();
        });
        toolbar.appendChild(select);

        const syncBtn = document.createElement('button');
        syncBtn.className = 'btn btn-primary';
        syncBtn.id = 'sync-pricing-btn';
        syncBtn.textContent = this.syncInProgress ? 'Syncing…' : 'Sync Prices';
        syncBtn.disabled = this.syncInProgress;
        syncBtn.title = 'Fetches the latest model_pricing.yml from Secure-Vector/securevector-ai-threat-monitor (master) and updates the local database. Pricing is also refreshed from the bundled YAML on app startup.';
        syncBtn.addEventListener('click', () => this._syncPricing());
        toolbar.appendChild(syncBtn);

        const syncInfo = document.createElement('span');
        syncInfo.style.cssText = 'font-size: 12px; color: var(--text-muted); margin-left: 8px;';
        syncInfo.textContent = 'Pulls from Secure-Vector/securevector-ai-threat-monitor. Also auto-updates on app restart.';
        toolbar.appendChild(syncInfo);

        if (this.lastSyncedAt) {
            const syncTime = document.createElement('span');
            syncTime.style.cssText = 'font-size: 11px; color: var(--text-muted); margin-left: 6px;';
            syncTime.textContent = `Last synced: ${new Date(this.lastSyncedAt).toLocaleTimeString()}`;
            toolbar.appendChild(syncTime);
        }

        content.appendChild(toolbar);

        const pricing = this.pricingData.pricing || [];
        if (pricing.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'empty-message';
            empty.textContent = 'No pricing entries found.';
            content.appendChild(empty);
            return;
        }

        const tableWrap = document.createElement('div');
        tableWrap.className = 'table-container';

        const table = document.createElement('table');
        table.className = 'data-table';

        const thead = document.createElement('thead');
        const hrow = document.createElement('tr');
        ['Provider', 'Model', 'Input / 1M', 'Output / 1M', 'Verified', 'Status', ''].forEach(h => {
            const th = document.createElement('th');
            th.textContent = h;
            hrow.appendChild(th);
        });
        thead.appendChild(hrow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        pricing.forEach(entry => {
            const tr = document.createElement('tr');

            const tdProv = document.createElement('td');
            tdProv.textContent = entry.provider;
            tr.appendChild(tdProv);

            const tdModel = document.createElement('td');
            const modelSpan = document.createElement('span');
            modelSpan.title = entry.display_name;
            modelSpan.textContent = entry.model_id;
            tdModel.appendChild(modelSpan);
            tr.appendChild(tdModel);

            const tdInput = document.createElement('td');
            tdInput.textContent = `$${entry.input_per_million.toFixed(2)}`;
            tr.appendChild(tdInput);

            const tdOutput = document.createElement('td');
            tdOutput.textContent = `$${entry.output_per_million.toFixed(2)}`;
            tr.appendChild(tdOutput);

            const tdVerified = document.createElement('td');
            tdVerified.textContent = entry.verified_at || '—';
            tr.appendChild(tdVerified);

            const tdStatus = document.createElement('td');
            const badge = document.createElement('span');
            if (entry.is_stale) {
                badge.className = 'badge badge-warning';
                badge.title = 'Not updated in 30+ days';
                badge.textContent = 'Stale';
            } else {
                badge.className = 'badge badge-success';
                badge.textContent = 'Current';
            }
            tdStatus.appendChild(badge);
            tr.appendChild(tdStatus);

            // Edit / Save / Cancel actions
            const tdActions = document.createElement('td');
            tdActions.style.cssText = 'white-space: nowrap;';

            const fieldStyle = 'width: 72px; padding: 2px 6px; border: 1px solid var(--accent-primary); border-radius: 4px; font-size: 12px; background: var(--bg-secondary); color: var(--text-primary);';

            const exitEdit = () => {
                tdInput.textContent = `$${entry.input_per_million.toFixed(2)}`;
                tdOutput.textContent = `$${entry.output_per_million.toFixed(2)}`;
                tdActions.textContent = '';
                tdActions.appendChild(editBtn);
            };

            const enterEdit = () => {
                tdInput.textContent = '';
                const inField = document.createElement('input');
                inField.type = 'number'; inField.min = '0'; inField.step = '0.01';
                inField.value = entry.input_per_million.toFixed(2);
                inField.style.cssText = fieldStyle;
                tdInput.appendChild(inField);

                tdOutput.textContent = '';
                const outField = document.createElement('input');
                outField.type = 'number'; outField.min = '0'; outField.step = '0.01';
                outField.value = entry.output_per_million.toFixed(2);
                outField.style.cssText = fieldStyle;
                tdOutput.appendChild(outField);

                tdActions.textContent = '';

                const saveBtn = document.createElement('button');
                saveBtn.className = 'btn btn-primary';
                saveBtn.style.cssText = 'font-size: 11px; padding: 2px 8px; margin-right: 4px;';
                saveBtn.textContent = 'Save';
                saveBtn.addEventListener('click', async () => {
                    const newIn = parseFloat(inField.value);
                    const newOut = parseFloat(outField.value);
                    if (isNaN(newIn) || isNaN(newOut) || newIn < 0 || newOut < 0) return;
                    saveBtn.textContent = 'Saving…';
                    saveBtn.disabled = true;
                    try {
                        await API.updateModelPricing(entry.provider, entry.model_id, {
                            input_per_million: newIn,
                            output_per_million: newOut,
                        });
                        entry.input_per_million = newIn;
                        entry.output_per_million = newOut;
                        exitEdit();
                    } catch (e) {
                        saveBtn.textContent = 'Save';
                        saveBtn.disabled = false;
                    }
                });

                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'btn btn-secondary';
                cancelBtn.style.cssText = 'font-size: 11px; padding: 2px 8px;';
                cancelBtn.textContent = 'Cancel';
                cancelBtn.addEventListener('click', exitEdit);

                tdActions.appendChild(saveBtn);
                tdActions.appendChild(cancelBtn);
            };

            const editBtn = document.createElement('button');
            editBtn.style.cssText = 'background: none; border: none; cursor: pointer; color: var(--text-secondary); padding: 2px 6px; border-radius: 3px; font-size: 13px; transition: color 0.15s;';
            editBtn.title = 'Edit pricing';
            editBtn.textContent = '✎';
            editBtn.addEventListener('mouseenter', () => { editBtn.style.color = 'var(--accent-primary)'; });
            editBtn.addEventListener('mouseleave', () => { editBtn.style.color = 'var(--text-secondary)'; });
            editBtn.addEventListener('click', enterEdit);
            tdActions.appendChild(editBtn);

            tr.appendChild(tdActions);
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        tableWrap.appendChild(table);
        content.appendChild(tableWrap);
        makeTableSortable(table);

        const note = document.createElement('p');
        note.className = 'help-text';
        note.textContent = `${pricing.length} models across ${providers.length} provider(s). Prices verified from official provider pages. Use Sync Prices to refresh.`;
        content.appendChild(note);
    },

    async _syncPricing() {
        if (this.syncInProgress) return;
        this.syncInProgress = true;
        const btn = document.getElementById('sync-pricing-btn');
        if (btn) { btn.textContent = 'Syncing…'; btn.disabled = true; }

        try {
            const result = await API.syncPricing();
            this.lastSyncedAt = new Date().toISOString();
            const msg = `Sync complete: ${result.updated} updated, ${result.skipped} skipped.`;
            if (result.changes && result.changes.length > 0) {
                const changed = result.changes.map(c => `${c.provider}/${c.model_id}`).join(', ');
                window.UI && UI.showNotification(`${msg} Changed: ${changed}`, 'success');
            } else {
                window.UI && UI.showNotification(msg, 'success');
            }
            await this._loadAndRenderPricing();
        } catch (e) {
            window.UI && UI.showNotification(`Sync failed: ${e.message}`, 'error');
        } finally {
            this.syncInProgress = false;
            // Reset button state — if _loadAndRenderPricing rebuilt the toolbar,
            // the new button already reflects syncInProgress=false. If it didn't
            // (e.g. a failure before re-render), we must restore it manually.
            const freshBtn = document.getElementById('sync-pricing-btn');
            if (freshBtn) {
                freshBtn.textContent = 'Sync Prices';
                freshBtn.disabled = false;
            }
        }
    },

    // ==================== Budget Tab ====================

    async _loadAndRenderBudget() {
        const content = document.getElementById('costs-tab-content');
        if (!content) return;

        try {
            [this.budgetData, this.agentBudgets] = await Promise.all([
                API.getGlobalBudget(),
                API.listAgentBudgets(),
            ]);
        } catch (e) {
            const err = document.createElement('p');
            err.className = 'error-message';
            err.textContent = `Failed to load budget settings: ${e.message}`;
            content.textContent = '';
            content.appendChild(err);
            return;
        }

        content.textContent = '';

        // Info banner explaining budget feature
        const infoBanner = document.createElement('div');
        infoBanner.className = 'alert';
        infoBanner.style.cssText = 'background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; padding: 14px 16px; margin-bottom: 1.5rem;';

        const infoTitle = document.createElement('div');
        infoTitle.style.cssText = 'font-weight: 600; margin-bottom: 6px; color: var(--text-primary); display: flex; align-items: center; gap: 6px;';
        const infoIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        infoIcon.setAttribute('viewBox', '0 0 24 24');
        infoIcon.setAttribute('fill', 'none');
        infoIcon.setAttribute('stroke', 'currentColor');
        infoIcon.setAttribute('stroke-width', '2');
        infoIcon.setAttribute('stroke-linecap', 'round');
        infoIcon.style.cssText = 'width: 14px; height: 14px; color: var(--text-secondary); flex-shrink: 0;';
        const infoCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        infoCircle.setAttribute('cx', '12'); infoCircle.setAttribute('cy', '12'); infoCircle.setAttribute('r', '10');
        const infoLine1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        infoLine1.setAttribute('x1', '12'); infoLine1.setAttribute('y1', '8'); infoLine1.setAttribute('x2', '12'); infoLine1.setAttribute('y2', '12');
        const infoLine2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        infoLine2.setAttribute('x1', '12'); infoLine2.setAttribute('y1', '16'); infoLine2.setAttribute('x2', '12.01'); infoLine2.setAttribute('y2', '16');
        [infoCircle, infoLine1, infoLine2].forEach(el => infoIcon.appendChild(el));
        infoTitle.appendChild(infoIcon);
        infoTitle.appendChild(document.createTextNode('How Budget Limits Work'));
        infoBanner.appendChild(infoTitle);

        const infoText = document.createElement('div');
        infoText.style.cssText = 'font-size: 13px; color: var(--text-secondary); line-height: 1.6;';
        infoText.textContent = 'Set daily USD spend limits to protect against runaway agent costs. The global limit is a wallet cap: it compares against your total spend across all agents today. Per-agent budgets compare only that agent\'s own spend and override the global limit. When exceeded, the proxy will warn (log + header) or block the request. Budgets reset at midnight UTC.';
        infoBanner.appendChild(infoText);
        content.appendChild(infoBanner);

        // ─── Global Budget ────────────────────────────────────────────────
        const globalSection = document.createElement('div');
        globalSection.style.cssText = 'margin-bottom: 2rem;';

        const globalTitle = document.createElement('h3');
        globalTitle.style.cssText = 'font-size: 15px; margin-bottom: 1rem; color: var(--text-primary);';
        globalTitle.textContent = 'Global Daily Budget';
        globalSection.appendChild(globalTitle);

        const globalCard = document.createElement('div');
        globalCard.style.cssText = 'background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; padding: 16px;';

        const globalForm = document.createElement('div');
        globalForm.style.cssText = 'display: flex; align-items: center; gap: 12px; flex-wrap: wrap;';

        const budgetLabel = document.createElement('label');
        budgetLabel.style.cssText = 'font-size: 13px; color: var(--text-secondary); white-space: nowrap;';
        budgetLabel.textContent = 'Daily limit (USD):';
        globalForm.appendChild(budgetLabel);

        const budgetInput = document.createElement('input');
        budgetInput.type = 'number';
        budgetInput.className = 'filter-input';
        budgetInput.style.cssText = 'width: 120px;';
        budgetInput.placeholder = 'e.g. 5.00';
        budgetInput.min = '0';
        budgetInput.step = '0.01';
        budgetInput.value = this.budgetData.daily_budget_usd != null ? this.budgetData.daily_budget_usd : '';
        globalForm.appendChild(budgetInput);

        const actionLabel = document.createElement('label');
        actionLabel.style.cssText = 'font-size: 13px; color: var(--text-secondary); white-space: nowrap;';
        actionLabel.textContent = 'When exceeded:';
        globalForm.appendChild(actionLabel);

        const actionSelect = document.createElement('select');
        actionSelect.className = 'filter-select';
        [['warn', 'Warn only (log + header)'], ['block', 'Block request (429)']].forEach(([val, label]) => {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = label;
            if (val === (this.budgetData.budget_action || 'warn')) opt.selected = true;
            actionSelect.appendChild(opt);
        });
        globalForm.appendChild(actionSelect);

        const saveGlobalBtn = document.createElement('button');
        saveGlobalBtn.className = 'btn btn-primary';
        saveGlobalBtn.textContent = 'Save';
        saveGlobalBtn.addEventListener('click', async () => {
            const val = budgetInput.value.trim();
            const daily = val === '' ? null : parseFloat(val);
            if (daily !== null && (isNaN(daily) || daily < 0)) {
                window.UI && UI.showNotification('Enter a valid amount (or leave blank to disable)', 'error');
                return;
            }
            try {
                saveGlobalBtn.textContent = 'Saving…';
                saveGlobalBtn.disabled = true;
                this.budgetData = await API.setGlobalBudget({
                    daily_budget_usd: daily,
                    budget_action: actionSelect.value,
                });
                window.UI && UI.showNotification(
                    daily != null
                        ? `Global budget set to $${daily.toFixed(2)}/day (${actionSelect.value})`
                        : 'Global budget cleared',
                    'success'
                );
            } catch (e) {
                window.UI && UI.showNotification(`Save failed: ${e.message}`, 'error');
            } finally {
                saveGlobalBtn.textContent = 'Save';
                saveGlobalBtn.disabled = false;
            }
        });
        globalForm.appendChild(saveGlobalBtn);

        if (this.budgetData.daily_budget_usd != null) {
            const clearBtn = document.createElement('button');
            clearBtn.className = 'btn btn-secondary';
            clearBtn.textContent = 'Clear Limit';
            clearBtn.addEventListener('click', async () => {
                try {
                    this.budgetData = await API.setGlobalBudget({ daily_budget_usd: null, budget_action: 'warn' });
                    budgetInput.value = '';
                    window.UI && UI.showNotification('Global budget cleared', 'success');
                } catch (e) {
                    window.UI && UI.showNotification(`Clear failed: ${e.message}`, 'error');
                }
            });
            globalForm.appendChild(clearBtn);
        }

        globalCard.appendChild(globalForm);

        const globalNote = document.createElement('p');
        globalNote.className = 'help-text';
        globalNote.style.marginTop = '10px';
        globalNote.textContent = 'Wallet cap: triggers when total spend across all agents exceeds this amount today. Use per-agent budgets below for per-agent limits.';
        globalCard.appendChild(globalNote);

        globalSection.appendChild(globalCard);
        content.appendChild(globalSection);

        // ─── Per-Agent Budgets ────────────────────────────────────────────
        const agentSection = document.createElement('div');

        const agentTitleRow = document.createElement('div');
        agentTitleRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;';

        const agentTitle = document.createElement('h3');
        agentTitle.style.cssText = 'font-size: 15px; color: var(--text-primary); margin: 0;';
        agentTitle.textContent = 'Per-Agent Budgets';
        agentTitleRow.appendChild(agentTitle);

        const addBtn = document.createElement('button');
        addBtn.className = 'btn btn-primary';
        addBtn.textContent = '+ Add Agent Budget';
        addBtn.addEventListener('click', () => this._showAddAgentBudgetForm(agentSection));
        agentTitleRow.appendChild(addBtn);

        agentSection.appendChild(agentTitleRow);

        const agentIdHelp = document.createElement('div');
        agentIdHelp.className = 'help-text';
        agentIdHelp.style.cssText = 'margin-bottom: 1rem; padding: 10px 14px; background: var(--bg-secondary); border-radius: 6px; border-left: 3px solid var(--accent-primary);';
        const helpStrong = document.createElement('strong');
        helpStrong.textContent = 'How to find your agent ID: ';
        agentIdHelp.appendChild(helpStrong);
        const helpSpan = document.createElement('span');
        helpSpan.textContent = 'Agent IDs appear in the Request History tab. If your agent sends an ';
        agentIdHelp.appendChild(helpSpan);
        const helpCode = document.createElement('code');
        helpCode.textContent = 'X-Agent-ID';
        agentIdHelp.appendChild(helpCode);
        const helpSpan2 = document.createElement('span');
        helpSpan2.textContent = ' header, that value is used. Otherwise the proxy auto-generates an ID like ';
        agentIdHelp.appendChild(helpSpan2);
        const helpCode2 = document.createElement('code');
        helpCode2.textContent = 'client:127.0.0.1:PORT';
        agentIdHelp.appendChild(helpCode2);
        helpSpan2.textContent += '.';
        agentSection.appendChild(agentIdHelp);

        const agentBudgetList = document.createElement('div');
        agentBudgetList.id = 'agent-budget-list';
        this._renderAgentBudgetList(agentBudgetList);
        agentSection.appendChild(agentBudgetList);

        content.appendChild(agentSection);
    },

    _renderAgentBudgetList(container) {
        container.textContent = '';
        const budgets = this.agentBudgets || [];

        if (budgets.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'help-text';
            empty.textContent = 'No per-agent budgets configured. Add one above to override the global limit for a specific agent.';
            container.appendChild(empty);
            return;
        }

        const tableWrap = document.createElement('div');
        tableWrap.className = 'table-container';

        const table = document.createElement('table');
        table.className = 'data-table';

        const thead = document.createElement('thead');
        const hrow = document.createElement('tr');
        ['Agent ID', 'Daily Limit', 'Action', 'Updated', ''].forEach((h, i) => {
            const th = document.createElement('th');
            th.textContent = h;
            if (i === 4) th.setAttribute('data-no-sort', '');
            hrow.appendChild(th);
        });
        thead.appendChild(hrow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        budgets.forEach(b => {
            const tr = document.createElement('tr');

            const tdAgent = document.createElement('td');
            const code = document.createElement('code');
            code.textContent = b.agent_id;
            tdAgent.appendChild(code);
            tr.appendChild(tdAgent);

            const tdLimit = document.createElement('td');
            tdLimit.textContent = `$${b.daily_budget_usd.toFixed(2)}/day`;
            tr.appendChild(tdLimit);

            const tdAction = document.createElement('td');
            const badge = document.createElement('span');
            badge.className = b.budget_action === 'block' ? 'badge badge-warning' : 'badge badge-success';
            badge.textContent = b.budget_action === 'block' ? 'Block' : 'Warn';
            tdAction.appendChild(badge);
            tr.appendChild(tdAction);

            const tdUpdated = document.createElement('td');
            tdUpdated.textContent = b.updated_at ? new Date(b.updated_at).toLocaleDateString() : '—';
            tr.appendChild(tdUpdated);

            const tdDel = document.createElement('td');
            const delBtn = document.createElement('button');
            delBtn.className = 'btn btn-secondary btn-sm';
            delBtn.textContent = 'Remove';
            delBtn.addEventListener('click', async () => {
                try {
                    await API.deleteAgentBudget(b.agent_id);
                    this.agentBudgets = this.agentBudgets.filter(x => x.agent_id !== b.agent_id);
                    this._renderAgentBudgetList(container);
                    window.UI && UI.showNotification(`Budget removed for ${b.agent_id}`, 'success');
                } catch (e) {
                    window.UI && UI.showNotification(`Failed: ${e.message}`, 'error');
                }
            });
            tdDel.appendChild(delBtn);
            tr.appendChild(tdDel);

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        tableWrap.appendChild(table);
        container.appendChild(tableWrap);
        makeTableSortable(table);
    },

    _showAddAgentBudgetForm(parentSection) {
        // Remove existing form if open
        const existing = document.getElementById('add-agent-budget-form');
        if (existing) { existing.remove(); return; }

        const form = document.createElement('div');
        form.id = 'add-agent-budget-form';
        form.style.cssText = 'background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; margin-bottom: 1rem;';

        const row = document.createElement('div');
        row.style.cssText = 'display: flex; align-items: center; gap: 12px; flex-wrap: wrap;';

        const agentIdInput = document.createElement('input');
        agentIdInput.type = 'text';
        agentIdInput.className = 'filter-input';
        agentIdInput.placeholder = 'Agent ID (e.g. my-langchain-bot)';
        agentIdInput.style.cssText = 'flex: 1; min-width: 200px;';
        row.appendChild(agentIdInput);

        const limitInput = document.createElement('input');
        limitInput.type = 'number';
        limitInput.className = 'filter-input';
        limitInput.placeholder = 'Daily limit $';
        limitInput.min = '0.01';
        limitInput.step = '0.01';
        limitInput.style.cssText = 'width: 120px;';
        row.appendChild(limitInput);

        const actionSelect = document.createElement('select');
        actionSelect.className = 'filter-select';
        [['warn', 'Warn only'], ['block', 'Block request']].forEach(([val, label]) => {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = label;
            actionSelect.appendChild(opt);
        });
        row.appendChild(actionSelect);

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-primary';
        saveBtn.textContent = 'Add';
        saveBtn.addEventListener('click', async () => {
            const agentId = agentIdInput.value.trim();
            const limit = parseFloat(limitInput.value);
            if (!agentId) {
                window.UI && UI.showNotification('Enter an agent ID', 'error');
                return;
            }
            if (isNaN(limit) || limit <= 0) {
                window.UI && UI.showNotification('Enter a valid limit amount', 'error');
                return;
            }
            try {
                saveBtn.textContent = 'Saving…';
                saveBtn.disabled = true;
                const newEntry = await API.setAgentBudget(agentId, {
                    daily_budget_usd: limit,
                    budget_action: actionSelect.value,
                });
                if (!this.agentBudgets) this.agentBudgets = [];
                const idx = this.agentBudgets.findIndex(x => x.agent_id === agentId);
                if (idx >= 0) this.agentBudgets[idx] = newEntry;
                else this.agentBudgets.push(newEntry);
                const listEl = document.getElementById('agent-budget-list');
                if (listEl) this._renderAgentBudgetList(listEl);
                form.remove();
                window.UI && UI.showNotification(`Budget set: ${agentId} → $${limit.toFixed(2)}/day`, 'success');
            } catch (e) {
                window.UI && UI.showNotification(`Failed: ${e.message}`, 'error');
                saveBtn.textContent = 'Add';
                saveBtn.disabled = false;
            }
        });
        row.appendChild(saveBtn);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => form.remove());
        row.appendChild(cancelBtn);

        form.appendChild(row);

        // Insert before agent-budget-list
        const listEl = document.getElementById('agent-budget-list');
        if (listEl) parentSection.insertBefore(form, listEl);
        else parentSection.appendChild(form);

        agentIdInput.focus();
    },

    // ==================== Global Budget Widget ====================

    _buildGlobalBudgetWidget() {
        const bd = this.budgetData || {};
        const hasLimit = bd.daily_budget_usd != null;

        const widget = document.createElement('div');
        widget.id = 'global-budget-widget';
        widget.style.cssText = 'margin-bottom: 1.5rem; background: var(--bg-secondary); border: 2px solid rgba(94,173,184,0.35); border-radius: 12px; overflow: hidden; box-shadow: 0 0 0 4px rgba(94,173,184,0.06);';

        // ── Header ──────────────────────────────────────────────────────
        const topRow = document.createElement('div');
        topRow.style.cssText = 'padding: 16px 20px 0; display: flex; align-items: center; justify-content: space-between;';

        const titleWrap = document.createElement('div');
        titleWrap.style.cssText = 'display: flex; align-items: center; gap: 8px;';

        // Wallet SVG icon
        const walletSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        walletSvg.setAttribute('viewBox', '0 0 24 24');
        walletSvg.setAttribute('fill', 'none');
        walletSvg.setAttribute('stroke', 'currentColor');
        walletSvg.setAttribute('stroke-width', '2');
        walletSvg.setAttribute('stroke-linecap', 'round');
        walletSvg.setAttribute('stroke-linejoin', 'round');
        walletSvg.style.cssText = 'width: 15px; height: 15px; color: var(--accent-primary); flex-shrink: 0;';
        [
            { tag: 'path', d: 'M21 12V7H5a2 2 0 0 1 0-4h14v4' },
            { tag: 'path', d: 'M3 5v14a2 2 0 0 0 2 2h16v-5' },
            { tag: 'path', d: 'M18 12a2 2 0 0 0 0 4h4v-4Z' },
        ].forEach(({ tag, d }) => {
            const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
            el.setAttribute('d', d);
            walletSvg.appendChild(el);
        });
        titleWrap.appendChild(walletSvg);

        const titleLbl = document.createElement('span');
        titleLbl.style.cssText = 'font-size: 13px; font-weight: 700; color: var(--text-primary); text-transform: uppercase; letter-spacing: 0.6px;';
        titleLbl.textContent = 'Global Daily Budget';
        titleWrap.appendChild(titleLbl);
        const titleSub = document.createElement('span');
        titleSub.style.cssText = 'font-size: 11px; color: var(--text-muted); font-weight: 400; text-transform: none; letter-spacing: 0;';
        titleSub.textContent = '— wallet cap across all agents';
        titleWrap.appendChild(titleSub);
        topRow.appendChild(titleWrap);

        // Edit button (right — only when limit is set) — gradient so it's visible
        const editBtn = document.createElement('button');
        editBtn.style.cssText = 'display: ' + (hasLimit ? 'inline-flex' : 'none') + '; align-items: center; gap: 5px; padding: 4px 14px; border-radius: var(--radius-full); font-size: 12px; font-weight: 600; border: none; background: var(--gradient); color: #fff; cursor: pointer; transition: opacity 0.15s;';
        editBtn.textContent = '✏ Edit';
        editBtn.addEventListener('mouseenter', () => { editBtn.style.opacity = '0.85'; });
        editBtn.addEventListener('mouseleave', () => { editBtn.style.opacity = '1'; });
        topRow.appendChild(editBtn);

        widget.appendChild(topRow);

        // ── Value area ───────────────────────────────────────────────────
        const valueArea = document.createElement('div');
        valueArea.style.cssText = 'padding: 10px 20px 6px;';

        const valueEl = document.createElement('div');
        valueEl.style.cssText = 'display: flex; align-items: center; gap: 10px;';
        this._refreshGlobalBudgetValue(valueEl, bd);
        valueArea.appendChild(valueEl);

        const subEl = document.createElement('div');
        subEl.style.cssText = 'font-size: 11px; color: var(--text-muted); margin-top: 3px;';
        subEl.textContent = 'Wallet cap across all agents · resets midnight UTC';
        valueArea.appendChild(subEl);

        widget.appendChild(valueArea);

        // "+ Set Limit" primary button (shown only when no limit set)
        const setLimitBtn = document.createElement('button');
        setLimitBtn.className = 'btn btn-primary btn-sm';
        setLimitBtn.style.cssText = 'margin: 2px 20px 16px; display: ' + (hasLimit ? 'none' : 'inline-flex') + ';';
        setLimitBtn.textContent = '+ Set Limit';
        widget.appendChild(setLimitBtn);

        // Spacer when limit IS set
        const setLimitSpacer = document.createElement('div');
        setLimitSpacer.style.cssText = 'height: ' + (hasLimit ? '10px' : '0') + ';';
        widget.appendChild(setLimitSpacer);

        // Wire both "Edit" and "+ Set Limit" to toggle the form
        const toggleForm = () => {
            const showing = form.style.display === 'flex';
            form.style.display = showing ? 'none' : 'flex';
            if (!showing) amtInput.focus();
        };
        editBtn.addEventListener('click', toggleForm);
        setLimitBtn.addEventListener('click', toggleForm);

        // ── Inline edit form (collapsed by default) ──────────────────────
        const form = document.createElement('div');
        form.style.cssText = 'display: none; padding: 12px 20px 16px; border-top: 1px solid var(--border-color); align-items: center; gap: 10px; flex-wrap: wrap;';

        const amtLbl = document.createElement('label');
        amtLbl.style.cssText = 'font-size: 12px; color: var(--text-secondary); white-space: nowrap;';
        amtLbl.textContent = 'Daily limit (USD):';
        form.appendChild(amtLbl);

        const amtInput = document.createElement('input');
        amtInput.type = 'number';
        amtInput.className = 'filter-input';
        amtInput.style.cssText = 'width: 110px;';
        amtInput.placeholder = 'e.g. 5.00';
        amtInput.min = '0';
        amtInput.step = '0.01';
        amtInput.value = bd.daily_budget_usd != null ? bd.daily_budget_usd : '';
        form.appendChild(amtInput);

        const whenLbl = document.createElement('label');
        whenLbl.style.cssText = 'font-size: 12px; color: var(--text-secondary); white-space: nowrap;';
        whenLbl.textContent = 'When exceeded:';
        form.appendChild(whenLbl);

        const actionSel = document.createElement('select');
        actionSel.className = 'filter-select';
        [['warn', 'Warn (log + header)'], ['block', 'Block (429)']].forEach(([val, label]) => {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = label;
            if (val === (bd.budget_action || 'warn')) opt.selected = true;
            actionSel.appendChild(opt);
        });
        form.appendChild(actionSel);

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-primary btn-sm';
        saveBtn.textContent = 'Save';
        form.appendChild(saveBtn);

        const clearBtn = document.createElement('button');
        clearBtn.className = 'btn btn-secondary btn-sm';
        clearBtn.textContent = 'Clear Limit';
        clearBtn.style.display = bd.daily_budget_usd != null ? '' : 'none';
        clearBtn.addEventListener('click', async () => {
            try {
                this.budgetData = await API.setGlobalBudget({ daily_budget_usd: null, budget_action: 'warn' });
                this._refreshGlobalBudgetValue(valueEl, this.budgetData);
                amtInput.value = '';
                editBtn.style.display = 'none';
                setLimitBtn.style.display = '';
                setLimitSpacer.style.height = '0';
                clearBtn.style.display = 'none';
                form.style.display = 'none';
                window.UI && UI.showNotification('Global budget cleared', 'success');
            } catch (e) {
                window.UI && UI.showNotification(`Failed: ${e.message}`, 'error');
            }
        });
        form.appendChild(clearBtn);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn btn-secondary btn-sm';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => { form.style.display = 'none'; });
        form.appendChild(cancelBtn);

        saveBtn.addEventListener('click', async () => {
            const val = amtInput.value.trim();
            const daily = val === '' ? null : parseFloat(val);
            if (daily !== null && (isNaN(daily) || daily < 0)) {
                window.UI && UI.showNotification('Enter a valid amount (or clear to disable)', 'error');
                return;
            }
            try {
                saveBtn.textContent = 'Saving…';
                saveBtn.disabled = true;
                this.budgetData = await API.setGlobalBudget({ daily_budget_usd: daily, budget_action: actionSel.value });
                this._refreshGlobalBudgetValue(valueEl, this.budgetData);
                const nowSet = this.budgetData.daily_budget_usd != null;
                editBtn.style.display = nowSet ? '' : 'none';
                setLimitBtn.style.display = nowSet ? 'none' : '';
                setLimitSpacer.style.height = nowSet ? '10px' : '0';
                clearBtn.style.display = nowSet ? '' : 'none';
                form.style.display = 'none';
                window.UI && UI.showNotification(
                    daily != null ? `Global budget set to $${daily.toFixed(2)}/day (${actionSel.value})` : 'Global budget cleared',
                    'success'
                );
            } catch (e) {
                window.UI && UI.showNotification(`Save failed: ${e.message}`, 'error');
            } finally {
                saveBtn.textContent = 'Save';
                saveBtn.disabled = false;
            }
        });

        widget.appendChild(form);
        return widget;
    },

    _refreshGlobalBudgetValue(el, bd) {
        el.textContent = '';
        el.style.cssText = 'display: flex; align-items: baseline; gap: 10px;';
        if (bd && bd.daily_budget_usd != null) {
            const amtEl = document.createElement('span');
            amtEl.style.cssText = 'font-size: 28px; font-weight: 700; color: var(--text-primary); line-height: 1;';
            amtEl.textContent = `$${parseFloat(bd.daily_budget_usd).toFixed(2)}`;
            el.appendChild(amtEl);

            const perDay = document.createElement('span');
            perDay.style.cssText = 'font-size: 13px; color: var(--text-secondary);';
            perDay.textContent = '/day';
            el.appendChild(perDay);

            const badge = document.createElement('span');
            badge.className = bd.budget_action === 'block' ? 'badge badge-warning' : 'badge badge-success';
            badge.textContent = bd.budget_action === 'block' ? 'Block' : 'Warn';
            el.appendChild(badge);
        } else {
            const notSetEl = document.createElement('span');
            notSetEl.style.cssText = 'font-size: 22px; font-weight: 600; color: var(--text-muted);';
            notSetEl.textContent = 'Not set';
            el.appendChild(notSetEl);
        }
    },

    // ==================== Per-Agent Budget Cell ====================

    _buildAgentBudgetCell(agent, contentOnly) {
        const td = document.createElement(contentOnly ? 'div' : 'td');
        const budget = (this.agentBudgets || []).find(b => b.agent_id === agent.agent_id) || null;
        this._renderAgentBudgetCellContent(td, agent.agent_id, budget);
        return td;
    },

    _renderAgentBudgetCellContent(td, agentId, budget) {
        td.textContent = '';
        if (budget) {
            const wrap = document.createElement('span');
            wrap.style.cssText = 'display: inline-flex; align-items: center; gap: 5px; flex-wrap: wrap;';

            wrap.appendChild(document.createTextNode(`$${parseFloat(budget.daily_budget_usd).toFixed(2)}/day`));

            const badge = document.createElement('span');
            badge.className = budget.budget_action === 'block' ? 'badge badge-warning' : 'badge badge-success';
            badge.textContent = budget.budget_action === 'block' ? 'Block' : 'Warn';
            wrap.appendChild(badge);

            const editBtn = document.createElement('button');
            editBtn.className = 'btn btn-secondary btn-sm';
            editBtn.title = 'Edit budget';
            editBtn.textContent = '✏';
            editBtn.style.cssText = 'padding: 1px 5px; font-size: 11px;';
            editBtn.addEventListener('click', () => this._showAgentBudgetInlineEdit(td, agentId, budget));
            wrap.appendChild(editBtn);

            td.appendChild(wrap);
        } else {
            const addBtn = document.createElement('button');
            addBtn.className = 'btn btn-secondary btn-sm';
            addBtn.textContent = '+ Set';
            addBtn.style.cssText = 'font-size: 11px; padding: 2px 8px; opacity: 0.7;';
            addBtn.addEventListener('click', () => this._showAgentBudgetInlineEdit(td, agentId, null));
            td.appendChild(addBtn);
        }
    },

    _showAgentBudgetInlineEdit(td, agentId, currentBudget) {
        td.textContent = '';
        const form = document.createElement('div');
        form.style.cssText = 'display: inline-flex; align-items: center; gap: 5px; flex-wrap: wrap;';

        const amtInput = document.createElement('input');
        amtInput.type = 'number';
        amtInput.className = 'filter-input';
        amtInput.style.cssText = 'width: 72px; font-size: 12px; padding: 2px 6px;';
        amtInput.placeholder = '$';
        amtInput.min = '0.01';
        amtInput.step = '0.01';
        if (currentBudget) amtInput.value = currentBudget.daily_budget_usd;
        form.appendChild(amtInput);

        const actionSel = document.createElement('select');
        actionSel.className = 'filter-select';
        actionSel.style.cssText = 'font-size: 12px; padding: 2px 4px;';
        [['warn', 'Warn'], ['block', 'Block']].forEach(([val, label]) => {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = label;
            if (val === ((currentBudget && currentBudget.budget_action) || 'warn')) opt.selected = true;
            actionSel.appendChild(opt);
        });
        form.appendChild(actionSel);

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-primary btn-sm';
        saveBtn.textContent = '✓';
        saveBtn.title = 'Save';
        saveBtn.style.cssText = 'padding: 2px 7px; font-size: 12px;';
        saveBtn.addEventListener('click', async () => {
            const limit = parseFloat(amtInput.value.trim());
            if (isNaN(limit) || limit <= 0) {
                window.UI && UI.showNotification('Enter a valid limit amount', 'error');
                return;
            }
            try {
                const newEntry = await API.setAgentBudget(agentId, {
                    daily_budget_usd: limit,
                    budget_action: actionSel.value,
                });
                if (!this.agentBudgets) this.agentBudgets = [];
                const idx = this.agentBudgets.findIndex(b => b.agent_id === agentId);
                if (idx >= 0) this.agentBudgets[idx] = newEntry;
                else this.agentBudgets.push(newEntry);
                this._renderAgentBudgetCellContent(td, agentId, newEntry);
                window.UI && UI.showNotification(`Budget set for ${agentId}: $${limit.toFixed(2)}/day`, 'success');
            } catch (e) {
                window.UI && UI.showNotification(`Failed: ${e.message}`, 'error');
                this._renderAgentBudgetCellContent(td, agentId, currentBudget);
            }
        });
        form.appendChild(saveBtn);

        if (currentBudget) {
            const delBtn = document.createElement('button');
            delBtn.className = 'btn btn-secondary btn-sm';
            delBtn.textContent = '✕';
            delBtn.title = 'Remove budget';
            delBtn.style.cssText = 'padding: 2px 7px; font-size: 12px;';
            delBtn.addEventListener('click', async () => {
                try {
                    await API.deleteAgentBudget(agentId);
                    this.agentBudgets = (this.agentBudgets || []).filter(b => b.agent_id !== agentId);
                    this._renderAgentBudgetCellContent(td, agentId, null);
                    window.UI && UI.showNotification(`Budget removed for ${agentId}`, 'success');
                } catch (e) {
                    window.UI && UI.showNotification(`Failed: ${e.message}`, 'error');
                    this._renderAgentBudgetCellContent(td, agentId, currentBudget);
                }
            });
            form.appendChild(delBtn);
        }

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn btn-secondary btn-sm';
        cancelBtn.textContent = '←';
        cancelBtn.title = 'Cancel';
        cancelBtn.style.cssText = 'padding: 2px 6px; font-size: 12px;';
        cancelBtn.addEventListener('click', () => this._renderAgentBudgetCellContent(td, agentId, currentBudget));
        form.appendChild(cancelBtn);

        td.appendChild(form);
        amtInput.focus();
        amtInput.select();
    },

    // ==================== Monthly cost chart ====================

    _chartState: { year: null, month: null, rangeStart: null, rangeEnd: null, mode: 'month', _draftStart: null, _draftEnd: null },

    async _initCostChart(container) {
        const now = new Date();
        this._chartState = { year: now.getFullYear(), month: now.getMonth() + 1, rangeStart: null, rangeEnd: null, mode: 'month', _draftStart: null, _draftEnd: null };
        await this._loadAndRenderChart(container);
    },

    async _loadAndRenderChart(container) {
        container.textContent = '';
        let data;
        try {
            if (this._chartState.mode === 'range' && this._chartState.rangeStart && this._chartState.rangeEnd) {
                data = await API.getMonthlyCostChart({ start: this._chartState.rangeStart, end: this._chartState.rangeEnd });
            } else {
                data = await API.getMonthlyCostChart({ year: this._chartState.year, month: this._chartState.month });
            }
        } catch (e) {
            return;
        }
        container.appendChild(this._buildChartWidget(data, container));
    },

    _buildChartWidget(data, container) {
        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10);
        const isCurrentMonth = this._chartState.mode === 'month' &&
            this._chartState.year === now.getFullYear() &&
            this._chartState.month === (now.getMonth() + 1);

        const wrap = document.createElement('div');
        wrap.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 10px; padding: 16px 18px; margin-bottom: 16px;';

        // ── Header ────────────────────────────────────────────────────────
        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap;';

        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-size: 13px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; flex: 1; min-width: 0;';
        if (this._chartState.mode === 'range') {
            titleEl.textContent = `Daily Spend: ${this._chartState.rangeStart}  →  ${this._chartState.rangeEnd}`;
        } else {
            const d = new Date(this._chartState.year, this._chartState.month - 1, 1);
            titleEl.textContent = `Daily Spend: ${d.toLocaleString('default', { month: 'long', year: 'numeric' })}`;
        }
        header.appendChild(titleEl);

        if (this._chartState.mode === 'month') {
            const navStyle = 'background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 6px; color: var(--text-primary); cursor: pointer; width: 28px; height: 26px; font-size: 15px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;';
            const prevBtn = document.createElement('button');
            prevBtn.style.cssText = navStyle;
            prevBtn.textContent = '‹';
            prevBtn.title = 'Previous month';
            prevBtn.addEventListener('click', async () => {
                let { month: m, year: y } = this._chartState;
                m--; if (m < 1) { m = 12; y--; }
                this._chartState.month = m; this._chartState.year = y;
                await this._loadAndRenderChart(container);
            });
            const nextBtn = document.createElement('button');
            nextBtn.style.cssText = navStyle + (isCurrentMonth ? 'opacity:0.35;cursor:default;' : '');
            nextBtn.textContent = '›';
            nextBtn.title = 'Next month';
            nextBtn.addEventListener('click', async () => {
                if (isCurrentMonth) return;
                let { month: m, year: y } = this._chartState;
                m++; if (m > 12) { m = 1; y++; }
                this._chartState.month = m; this._chartState.year = y;
                await this._loadAndRenderChart(container);
            });
            header.appendChild(prevBtn);
            header.appendChild(nextBtn);
        }
        wrap.appendChild(header);

        // ── Date range row ────────────────────────────────────────────────
        const rangeRow = document.createElement('div');
        rangeRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 14px; flex-wrap: wrap;';

        const iStyle = 'background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 6px; color: var(--text-primary); padding: 4px 8px; font-size: 12px; outline: none; cursor: pointer;';
        const startInput = document.createElement('input');
        startInput.type = 'date'; startInput.style.cssText = iStyle;
        // Restore from draft (survives poll rebuilds) then committed range
        startInput.value = this._chartState._draftStart || this._chartState.rangeStart || '';

        const sep = document.createElement('span');
        sep.textContent = '→'; sep.style.cssText = 'color: var(--text-secondary); font-size: 12px;';

        const endInput = document.createElement('input');
        endInput.type = 'date'; endInput.style.cssText = iStyle;
        endInput.value = this._chartState._draftEnd || this._chartState.rangeEnd || '';

        const applyBtn = document.createElement('button');
        applyBtn.textContent = 'Apply';
        applyBtn.style.cssText = 'background: rgba(94,173,184,0.15); border: 1px solid rgba(94,173,184,0.4); border-radius: 6px; color: rgba(94,173,184,1); cursor: pointer; padding: 4px 12px; font-size: 12px; white-space: nowrap;';

        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear';
        clearBtn.style.cssText = 'background: none; border: none; color: var(--text-secondary); cursor: pointer; padding: 4px 8px; font-size: 12px;';

        const self = this;

        // Save to draft immediately on change so poll rebuilds don't lose the value
        startInput.addEventListener('change', function() {
            self._chartState._draftStart = startInput.value || null;
        });
        endInput.addEventListener('change', function() {
            self._chartState._draftEnd = endInput.value || null;
        });

        applyBtn.addEventListener('click', async function() {
            const s = startInput.value;
            const e = endInput.value;
            if (s && e && s <= e) {
                self._chartState.mode = 'range';
                self._chartState.rangeStart = s;
                self._chartState.rangeEnd = e;
                self._chartState._draftStart = null;
                self._chartState._draftEnd = null;
                await self._loadAndRenderChart(container);
            }
        });
        clearBtn.addEventListener('click', async function() {
            const n = new Date();
            self._chartState.mode = 'month';
            self._chartState.year = n.getFullYear();
            self._chartState.month = n.getMonth() + 1;
            self._chartState.rangeStart = null;
            self._chartState.rangeEnd = null;
            self._chartState._draftStart = null;
            self._chartState._draftEnd = null;
            await self._loadAndRenderChart(container);
        });

        rangeRow.appendChild(startInput);
        rangeRow.appendChild(sep);
        rangeRow.appendChild(endInput);
        rangeRow.appendChild(applyBtn);
        rangeRow.appendChild(clearBtn);
        wrap.appendChild(rangeRow);

        // ── Build day array ───────────────────────────────────────────────
        const dayMap = {};
        (data.days || []).forEach(d => { dayMap[d.date] = d.cost_usd; });

        const allDays = [];
        if (this._chartState.mode === 'range' && this._chartState.rangeStart && this._chartState.rangeEnd) {
            let cur = new Date(this._chartState.rangeStart + 'T00:00:00');
            const endD = new Date(this._chartState.rangeEnd + 'T00:00:00');
            while (cur <= endD) {
                const key = cur.toISOString().slice(0, 10);
                allDays.push({ label: key.slice(5), cost: dayMap[key] || 0, future: key > todayStr, dateKey: key });
                cur.setDate(cur.getDate() + 1);
            }
        } else {
            const totalDays = new Date(this._chartState.year, this._chartState.month, 0).getDate();
            for (let i = 1; i <= totalDays; i++) {
                const d = new Date(this._chartState.year, this._chartState.month - 1, i);
                const key = d.toISOString().slice(0, 10);
                allDays.push({ label: String(i), cost: dayMap[key] || 0, future: key > todayStr, dateKey: key });
            }
        }

        // ── CSS bar chart (no SVG — no stretching) ────────────────────────
        const maxCost = Math.max(...allDays.filter(d => !d.future).map(d => d.cost), 0.000001);
        const CHART_H = 90; // px — fixed height of the bar area

        const chartWrap = document.createElement('div');
        chartWrap.style.cssText = `position: relative; height: ${CHART_H + 20}px; display: flex; align-items: flex-end; gap: 2px; padding-bottom: 20px; box-sizing: border-box;`;

        allDays.forEach(d => {
            const isToday = d.dateKey === todayStr;
            const pct = d.future ? 4 : Math.max(2, Math.round((d.cost / maxCost) * CHART_H));

            const col = document.createElement('div');
            col.style.cssText = 'flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; position: relative; min-width: 0;';

            const bar = document.createElement('div');
            bar.style.cssText = `width: 100%; height: ${pct}px; border-radius: 2px 2px 0 0; transition: background 0.1s; box-sizing: border-box;`;
            bar.style.background = d.future
                ? 'rgba(94,173,184,0.08)'
                : isToday ? 'rgba(94,173,184,0.85)' : 'rgba(94,173,184,0.4)';
            bar.title = d.future ? `${d.dateKey}: —` : `${d.dateKey}: $${d.cost.toFixed(4)}`;

            if (!d.future) {
                bar.addEventListener('mouseenter', () => { bar.style.background = 'rgba(94,173,184,0.9)'; });
                bar.addEventListener('mouseleave', () => { bar.style.background = isToday ? 'rgba(94,173,184,0.85)' : 'rgba(94,173,184,0.4)'; });
            }
            col.appendChild(bar);

            // Day label below bar (show day 1, every 5th, today)
            const dayNum = parseInt(d.label.split('-').pop() || d.label, 10);
            if (dayNum === 1 || dayNum % 5 === 0 || isToday) {
                const lbl = document.createElement('div');
                lbl.style.cssText = `position: absolute; bottom: 0; left: 50%; transform: translateX(-50%); font-size: 9px; line-height: 14px; white-space: nowrap; color: ${isToday ? 'rgba(94,173,184,0.9)' : 'var(--text-secondary)'};`;
                lbl.textContent = d.label;
                col.appendChild(lbl);
            }

            chartWrap.appendChild(col);
        });

        wrap.appendChild(chartWrap);

        // ── Footer stats ──────────────────────────────────────────────────
        const pastDays = allDays.filter(d => !d.future);
        const rangeTotal = pastDays.reduce((s, d) => s + d.cost, 0);
        const rangeAvg = pastDays.length > 0 ? rangeTotal / pastDays.length : 0;

        const footer = document.createElement('div');
        footer.style.cssText = 'margin-top: 10px; font-size: 13px; color: var(--text-secondary); display: flex; gap: 24px;';

        const tSpan = document.createElement('span');
        tSpan.textContent = 'Total: ';
        const tStrong = document.createElement('strong');
        tStrong.style.color = 'var(--text-primary)';
        tStrong.textContent = `$${rangeTotal.toFixed(4)}`;
        tSpan.appendChild(tStrong);

        const aSpan = document.createElement('span');
        aSpan.textContent = 'Daily avg: ';
        const aStrong = document.createElement('strong');
        aStrong.style.color = 'var(--text-primary)';
        aStrong.textContent = `$${rangeAvg.toFixed(4)}`;
        aSpan.appendChild(aStrong);

        footer.appendChild(tSpan);
        footer.appendChild(aSpan);
        wrap.appendChild(footer);

        return wrap;
    },

    _renderMonthlyCostChart(days) {
        // Legacy shim — not used directly anymore; chart is initialized via _initCostChart
        return document.createElement('div');
    },

    // ==================== Helpers ====================

    _fmtTokens(n) {
        if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
        return n.toString();
    },

    /** Cost Settings card: billing mode (which unit leads in the Optimizer)
     *  and the reversible Recommendations switch. */
    async _renderOptimizerPrefsCard(host) {
        const st = await API.getOptimizerStatus();
        if (!st) return; // server unreachable: settings page stays usable
        const prefs = st.prefs || {};
        const card = document.createElement('div');
        card.style.cssText =
            'background: var(--bg-secondary); border: 1px solid var(--border-default); ' +
            'border-radius: 12px; padding: 18px 22px; margin-top: 16px;';
        const modeVal = prefs.billing_mode || '';
        const derivedNote = !prefs.billing_mode && prefs.billing_mode_derived === 'api'
            ? ' (currently auto-detected: metered, from proxy activity)' : '';
        card.innerHTML =
            '<div style="font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-secondary);margin-bottom:6px;">Cost / Token Optimizer</div>' +
            '<div style="color:var(--text-muted);font-size:13px;line-height:1.5;margin-bottom:14px;">Display preferences for the Optimizer tab on Cost &amp; Tokens. One shared analysis: billing mode only changes which unit leads.</div>' +
            '<div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-end;">' +
            '<label style="display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--text-secondary);">Billing mode' + this._esc(derivedNote) +
            '<select class="filter-select" id="svo-pref-mode">' +
            `<option value=""${modeVal === '' ? ' selected' : ''}>Not set (ask on first open)</option>` +
            `<option value="api"${modeVal === 'api' ? ' selected' : ''}>Metered API billing (dollars lead)</option>` +
            `<option value="subscription"${modeVal === 'subscription' ? ' selected' : ''}>Subscription plan (tokens lead)</option>` +
            '</select></label>' +
            '<label style="display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--text-secondary);">Recommendations' +
            '<select class="filter-select" id="svo-pref-rec">' +
            `<option value=""${prefs.recommend_enabled == null ? ' selected' : ''}>Not decided (ask when findings exist)</option>` +
            `<option value="1"${prefs.recommend_enabled === true ? ' selected' : ''}>On: findings state what to change</option>` +
            `<option value="0"${prefs.recommend_enabled === false ? ' selected' : ''}>Off: detect only</option>` +
            '</select></label></div>' +
            '<div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin:16px 0 2px;">Live advisor</div>' +
            '<div style="color:var(--text-muted);font-size:12px;line-height:1.5;margin-bottom:10px;">The Guardian watches live sessions on this machine and speaks up when tokens are being wasted and when it is time to compact. Advisory only: fixes go to your clipboard, nothing is ever sent into a session.</div>' +
            '<div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-end;">' +
            '<label style="display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--text-secondary);">Watch live sessions' +
            '<select class="filter-select" id="svo-pref-live">' +
            `<option value="1"${prefs.live_advisor_enabled !== false ? ' selected' : ''}>On (default)</option>` +
            `<option value="0"${prefs.live_advisor_enabled === false ? ' selected' : ''}>Off</option>` +
            '</select></label>' +
            '<label style="display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--text-secondary);">Advisor sounds' +
            '<select class="filter-select" id="svo-pref-sounds">' +
            `<option value="1"${prefs.live_sounds_enabled !== false ? ' selected' : ''}>On: a short beep on act-now nudges</option>` +
            `<option value="0"${prefs.live_sounds_enabled === false ? ' selected' : ''}>Off: badge and bubble only</option>` +
            '</select></label>' +
            '<label style="display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--text-secondary);" title="Context fill percentages for the three compact nudges: heads-up, act now, last call.">Compact nudges at (% full)' +
            '<span style="display:flex;gap:6px;">' +
            `<input class="filter-input" style="width:64px" id="svo-pref-st1" type="number" min="10" max="95" value="${Number(prefs.stage_heads_up || 60)}">` +
            `<input class="filter-input" style="width:64px" id="svo-pref-st2" type="number" min="10" max="98" value="${Number(prefs.stage_act_now || 75)}">` +
            `<input class="filter-input" style="width:64px" id="svo-pref-st3" type="number" min="10" max="99" value="${Number(prefs.stage_last_call || 90)}">` +
            '</span></label>' +
            '<label style="display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--text-secondary);" title="A single tool result larger than this (about, in tokens) triggers the trim alert.">Big tool result (tokens)' +
            `<input class="filter-input" style="width:96px" id="svo-pref-big" type="number" min="200" max="100000" value="${Number(prefs.big_result_tokens || 2000)}">` +
            '</label></div>';
        card.querySelector('#svo-pref-mode').addEventListener('change', async (ev) => {
            const v = ev.target.value;
            if (!v) return; // "not set" is the absence of a choice, not a write
            try { await API.setOptimizerPrefs({ billing_mode: v }); }
            catch (e) { if (window.Toast) Toast.error('Could not save: ' + e.message); }
        });
        card.querySelector('#svo-pref-rec').addEventListener('change', async (ev) => {
            const v = ev.target.value;
            if (v === '') return;
            try { await API.setOptimizerPrefs({ recommend_enabled: v === '1' }); }
            catch (e) { if (window.Toast) Toast.error('Could not save: ' + e.message); }
        });
        card.querySelector('#svo-pref-live').addEventListener('change', async (ev) => {
            try { await API.setOptimizerPrefs({ live_advisor_enabled: ev.target.value === '1' }); }
            catch (e) { if (window.Toast) Toast.error('Could not save: ' + e.message); }
        });
        card.querySelector('#svo-pref-sounds').addEventListener('change', async (ev) => {
            try { await API.setOptimizerPrefs({ live_sounds_enabled: ev.target.value === '1' }); }
            catch (e) { if (window.Toast) Toast.error('Could not save: ' + e.message); }
        });
        const stageField = { 'svo-pref-st1': 'stage_heads_up', 'svo-pref-st2': 'stage_act_now',
            'svo-pref-st3': 'stage_last_call', 'svo-pref-big': 'big_result_tokens' };
        Object.entries(stageField).forEach(([id, key]) => {
            card.querySelector('#' + id).addEventListener('change', async (ev) => {
                const n = parseInt(ev.target.value, 10);
                if (!Number.isFinite(n)) return;
                try { await API.setOptimizerPrefs({ [key]: n }); }
                catch (e) { if (window.Toast) Toast.error('Could not save: ' + e.message); }
            });
        });
        host.appendChild(card);
    },

    /** Cost Settings card: per-run limits (#203). Everything defaults to
     *  off. The tool-call cap and loop breaker stop calls at the tool
     *  boundary; the cost/token ceilings stop LLM requests at the proxy.
     *  Every stop is audited and promotable ("allow this run to continue"). */
    async _renderRunLimitsCard(host) {
        const [limits, status, stopsRes] = await Promise.all([
            API.getRunLimits(),
            API.getOptimizerStatus(),
            API.getRunLimitStops(7),
        ]);
        if (!limits) return; // server unreachable: settings page stays usable
        const mode = (status && status.prefs
            && (status.prefs.billing_mode || status.prefs.billing_mode_derived)) || null;
        const stops = (stopsRes && stopsRes.stops) || [];

        const card = document.createElement('div');
        card.style.cssText =
            'background: var(--bg-secondary); border: 1px solid var(--border-default); ' +
            'border-radius: 12px; padding: 18px 22px; margin-top: 16px;';

        const num = (id, label, value, placeholder, stepAttr) =>
            '<label style="display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--text-secondary);">' +
            label +
            `<input type="number" min="1" ${stepAttr || ''} class="filter-input" id="${id}" ` +
            `value="${value != null ? value : ''}" placeholder="${placeholder}" style="width:170px;"></label>`;

        // Billing mode decides which ceiling leads: tokens for subscription,
        // dollars for metered API. Same controls either way, never a split.
        const costField = num('svo-run-cost', 'Max cost per run ($)',
            limits.run_max_cost_usd, 'off', 'step="0.5"');
        const tokenField = num('svo-run-tokens', 'Max tokens per run',
            limits.run_max_tokens, 'off');
        const ceilingFields = mode === 'subscription'
            ? tokenField + costField : costField + tokenField;

        card.innerHTML =
            '<div style="font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-secondary);margin-bottom:6px;">Per-Run Limits</div>' +
            '<div style="color:var(--text-muted);font-size:13px;line-height:1.5;margin-bottom:14px;">' +
            'Stop a runaway run before the money is spent. All controls are off by default and every stop is audited and reversible: ' +
            'the tool-call cap and loop breaker deny further tool calls in Claude Code, Codex, Copilot CLI and Cursor ' +
            '(OpenClaw cannot deny at the plugin layer, so enforcement there is proxy-only); ' +
            'the per-run ceilings stop LLM requests at the proxy, and without the proxy running they do not apply. ' +
            'No control ever modifies a request or changes the model.</div>' +
            '<div style="display:flex;gap:22px;flex-wrap:wrap;align-items:flex-end;">' +
            num('svo-run-calls', 'Max tool calls per run', limits.run_max_tool_calls, 'off') +
            '<label style="display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--text-secondary);">Loop breaker' +
            '<select class="filter-select" id="svo-run-loop">' +
            `<option value="0"${limits.run_loop_breaker ? '' : ' selected'}>Off</option>` +
            `<option value="1"${limits.run_loop_breaker ? ' selected' : ''}>On: stop identical-call loops</option>` +
            '</select></label>' +
            ceilingFields +
            '<label style="display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--text-secondary);">Ceiling action' +
            '<select class="filter-select" id="svo-run-action">' +
            `<option value="warn"${limits.run_limit_action !== 'block' ? ' selected' : ''}>Warn (log + header)</option>` +
            `<option value="block"${limits.run_limit_action === 'block' ? ' selected' : ''}>Block (429)</option>` +
            '</select></label>' +
            '<button type="button" class="btn btn-primary btn-sm" id="svo-run-save">Save</button>' +
            '</div>' +
            '<div style="color:var(--text-muted);font-size:11px;line-height:1.5;margin-top:10px;">' +
            `Loop breaker thresholds are published, not tuned per install: ${this._esc(String(limits.loop_thresholds.repeat_limit))} identical calls ` +
            `or a sustained ${this._esc(String(limits.loop_thresholds.rate_per_min))}/min call rate within ${this._esc(String(limits.loop_thresholds.window_seconds))}s. ` +
            'The cap and breaker stop calls whenever set; the ceiling action above applies to the cost/token ceilings.</div>' +
            '<div id="svo-run-stops"></div>';

        card.querySelector('#svo-run-save').addEventListener('click', async () => {
            const val = (id) => {
                const v = card.querySelector('#' + id).value;
                return v === '' ? null : Number(v);
            };
            try {
                await API.setRunLimits({
                    run_max_tool_calls: val('svo-run-calls'),
                    run_max_cost_usd: val('svo-run-cost'),
                    run_max_tokens: val('svo-run-tokens'),
                    run_limit_action: card.querySelector('#svo-run-action').value,
                    run_loop_breaker: card.querySelector('#svo-run-loop').value === '1',
                });
                if (window.Toast) Toast.success('Per-run limits saved. They apply to the next call, no restarts.');
            } catch (e) {
                if (window.Toast) Toast.error('Could not save: ' + e.message);
            }
        });

        // Recent stops: the one-click "approve continuation" surface.
        if (stops.length) {
            const list = card.querySelector('#svo-run-stops');
            const head = document.createElement('div');
            head.style.cssText = 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-secondary);margin:16px 0 6px;';
            head.textContent = 'Recent stops (7 days)';
            list.appendChild(head);
            stops.forEach(s => {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid var(--border-default);font-size:12px;color:var(--text-secondary);flex-wrap:wrap;';
                const sess = document.createElement('span');
                sess.style.cssText = 'font-family:var(--font-mono,monospace);';
                sess.textContent = (s.session_id ? String(s.session_id).slice(0, 12) : 'unknown') +
                    (s.runtime_kind ? ' · ' + s.runtime_kind : '');
                const reason = document.createElement('span');
                reason.style.cssText = 'flex:1 1 260px;min-width:200px;color:var(--text-muted);';
                reason.textContent = (s.reason || '').split('.')[0] + ` (${s.stops} stopped)`;
                row.appendChild(sess);
                row.appendChild(reason);
                if (s.exempted) {
                    const tag = document.createElement('span');
                    tag.style.cssText = 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--accent-primary,#5eadb8);';
                    tag.textContent = 'continuation approved';
                    row.appendChild(tag);
                } else if (s.session_id) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'btn btn-secondary btn-sm';
                    btn.textContent = 'Allow run to continue';
                    btn.title = 'Creates a session-scoped exemption, revocable from the JIT grants list. The grant is audited.';
                    btn.addEventListener('click', async () => {
                        try {
                            await API.exemptRun({ session_id: s.session_id, runtime_kind: s.runtime_kind || null });
                            btn.replaceWith(Object.assign(document.createElement('span'), {
                                textContent: 'continuation approved',
                            }));
                            if (window.Toast) Toast.success('This run may continue. The exemption is audited and revocable.');
                        } catch (e) {
                            if (window.Toast) Toast.error('Could not approve: ' + e.message);
                        }
                    });
                    row.appendChild(btn);
                }
                list.appendChild(row);
            });
        }
        host.appendChild(card);
    },

    // ================= Cost / Token Optimizer tab (v5.2.0, #202) =========
    // Why a session cost what it did, and what to change. Findings come from
    // the local transcript scan (consent-gated, same contract as Instant
    // Audit); every number here is an estimate at list price, never metered
    // billing, and the copy says so everywhere a figure appears.

    _optWindow: 30,
    _pendingTab: null,   // one-shot tab handoff (spotlight CTA, trace chips)

    async _loadAndRenderOptimizer() {
        const content = document.getElementById('costs-tab-content');
        if (!content) return;
        this._optInjectStyle();
        if (this._optPoll) { clearTimeout(this._optPoll); this._optPoll = null; }
        // The live poll re-renders this whole tab when a session flips
        // between live and idle. Wiping the DOM collapses the document, and
        // the browser clamps the reader's scroll back to the top mid-read.
        // Hold the old height while the new content is fetched, then put
        // the scroll back exactly where it was.
        const scroller = content.closest('.page-content') || document.scrollingElement;
        const keepScroll = scroller ? scroller.scrollTop : 0;
        const keepH = content.offsetHeight;
        if (keepH) content.style.minHeight = keepH + 'px';
        content.textContent = '';
        const host = document.createElement('div');
        host.id = 'sv-optimizer';
        content.appendChild(host);

        try {
            const st = await API.getOptimizerStatus();
            if (!st) {
                host.innerHTML = '<div class="empty-state"><div class="empty-state-title">Optimizer unavailable</div>' +
                    '<div class="empty-state-text">The local server did not answer. The Optimizer runs entirely on this machine, no cloud is involved.</div></div>';
                return;
            }
            if (st.running) { this._optScanning(host, st); return; }
            if (!st.has_report) { this._optConsent(host, st); return; }
            const [rep, act, liveData] = await Promise.all([
                API.getOptimizerReport(),
                API.getOptimizerSessions(30),
                API.getOptimizerLive(),
            ]);
            if (!rep) { this._optConsent(host, st); return; }
            this._optActivity = act;
            this._optLive = liveData;
            this._optReportView(host, rep, st);
        } finally {
            content.style.minHeight = '';
            if (scroller && keepScroll) {
                scroller.scrollTop = Math.min(
                    keepScroll, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
            }
        }
    },

    _optMode(st, rep) {
        // Billing mode picks the LEADING unit: dollars for API-metered,
        // tokens for subscription. One shared analysis, one display mode,
        // never a tier split. Unset and unknown lead with tokens: honest by
        // default, since tokens are the ground truth.
        const p = (st && st.prefs) || {};
        return p.billing_mode || p.billing_mode_derived || null;
    },

    _optFmtTok(n) {
        if (n == null) return '–';
        if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return Math.round(n / 1e3) + 'K';
        return String(Math.round(n));
    },

    _optFmtUsd(v) {
        if (v == null) return null;
        return '$' + (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2));
    },

    /** Leading + secondary value strings for a finding or the strip. */
    _optValue(tokens, usd, mode) {
        const tok = this._optFmtTok(tokens) + ' tok';
        const dollars = usd != null ? '≈' + this._optFmtUsd(usd) : null;
        if (mode === 'api' && dollars) return { lead: dollars, sub: tok };
        return { lead: tok, sub: dollars ? dollars + ' est' : null };
    },

    // ---------------- consent (first open, no report yet) ----------------

    _optConsent(host, st) {
        const consented = !!st.consented_at;
        host.innerHTML =
            '<div class="svo-hero">' +
            '<div class="svo-eyebrow">Runs entirely on this machine</div>' +
            '<h2 class="svo-h">Find out why your sessions cost what they did.</h2>' +
            '<p class="svo-p">Cost tracking answers how much. The Optimizer reads the session transcripts already on this device and answers <b>why</b>: repeated context, cache misses, retry loops, duplicate requests, each finding named to the exact session and turn that produced it.</p>' +
            '<div class="svo-points">' +
            '<div class="svo-point"><b>Attributable or absent</b><span>Every finding names a session and a turn, and links to it in Traces. A claim that cannot say where it came from does not appear.</span></div>' +
            '<div class="svo-point"><b>Estimates, labelled</b><span>Token counts are exact, from the transcript. Dollar figures are tokens times list price, always marked as estimates, never an invoice.</span></div>' +
            '</div>' +
            (consented ? '' :
                '<div class="svo-consent">' +
                '<div class="svo-consent-t">Before scanning, know exactly what happens:</div>' +
                '<ul>' +
                '<li>Transcripts under <code>~/.claude</code> and <code>~/.codex</code> are read locally, once per scan.</li>' +
                '<li>The report keeps aggregate numbers and content hashes only: no prompt text, no tool arguments, no file paths.</li>' +
                '<li>The report lives in this app’s local data folder and can be deleted from this tab.</li>' +
                '<li>Nothing is uploaded. The scan works with the device offline.</li>' +
                '</ul></div>') +
            '<div class="svo-actions">' +
            [7, 30, 90].map(d =>
                `<button type="button" class="svo-winbtn${d === this._optWindow ? ' on' : ''}" data-days="${d}">${d} days</button>`
            ).join('') +
            `<button type="button" class="btn btn-primary svo-go">${consented ? 'Scan my sessions' : 'Agree and scan'}</button>` +
            '</div><div class="svo-err" hidden></div></div>';

        host.querySelectorAll('.svo-winbtn').forEach(b => b.addEventListener('click', () => {
            this._optWindow = Number(b.dataset.days) || 30;
            host.querySelectorAll('.svo-winbtn').forEach(x => x.classList.toggle('on', x === b));
        }));
        host.querySelector('.svo-go').addEventListener('click', async () => {
            try {
                await API.runOptimizer({ consent: true, window_days: this._optWindow });
                await this._loadAndRenderOptimizer();
            } catch (e) {
                const err = host.querySelector('.svo-err');
                if (err) { err.hidden = false; err.textContent = 'Could not start the scan: ' + e.message; }
            }
        });
    },

    // ---------------- scanning progress ----------------

    _optScanning(host, st) {
        const p = st.progress || {};
        const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
        host.innerHTML =
            '<div class="svo-hero" style="text-align:center;">' +
            '<div class="svo-eyebrow">Scanning locally</div>' +
            `<h2 class="svo-h">Reading ${p.total || '…'} sessions on this machine.</h2>` +
            '<div class="svo-prog" style="max-width:420px;margin-left:auto;margin-right:auto;"><div class="svo-prog-fill" style="width:' + pct + '%"></div></div>' +
            `<p class="svo-p" style="margin-left:auto;margin-right:auto;">${p.done || 0} of ${p.total || '?'} sessions analyzed. Nothing leaves the device.</p></div>`;
        this._optPoll = setTimeout(() => {
            if (this.activeTab === 'optimizer') this._loadAndRenderOptimizer();
        }, 1200);
    },

    // ---------------- the report ----------------

    _optReportView(host, rep, st) {
        const mode = this._optMode(st, rep);
        host.textContent = '';
        host.appendChild(this._optStrip(rep, mode));
        // Live first: what is still fixable NOW, told with the same data the
        // Guardian bot speaks from, so the page and the bot agree.
        const liveSec = this._optLiveSec();
        if (liveSec) host.appendChild(liveSec);
        if (!mode && !(st.prefs && st.prefs.billing_mode)) this._optBillingAsk(host, st);

        // Proof leads: a measured receipt is the feature's strongest artifact,
        // so it renders directly under the comparison, before the findings.
        this._optReceipts(host, rep, mode, 'resolved');
        const prefs = (st && st.prefs) || {};
        const findings = rep.findings || [];
        if (findings.length && (prefs.recommend_enabled == null)) {
            this._optRecommendAsk(host);
        }
        // Sessions are the unit users think in: live ones first (still
        // fixable NOW), then recent ones as patterns. The trim ledger and
        // the practices scorecard are informative depth, so they sit below
        // the sessions; the findings-by-type wall stays the last drill-down,
        // collapsed by default. There is deliberately no separate "do this
        // first" digest: it restated what the session cards and the wall
        // already rank, and a page that says everything twice reads huge.
        this._optSessionsSec(host, rep, st);
        // What happened after the last few copies. A fix that never got pasted
        // saved nothing, so the loop has to close somewhere the user can see.
        const fixSec = this._optFixesSec();
        if (fixSec) host.appendChild(fixSec);
        const ledger = this._optTrimLedger(rep, mode);
        if (ledger) host.appendChild(ledger);
        const playbook = this._optPlaybook(rep, mode);
        if (playbook) host.appendChild(playbook);
        this._optFindings(host, rep, st);
        this._optFooter(host, rep);
        // Guardian deep link: an advisory click lands on its session row.
        if (this._pendingScrollSid) {
            const sid = this._pendingScrollSid;
            this._pendingScrollSid = null;
            requestAnimationFrame(() => {
                const el = host.querySelector('[data-sid="' + CSS.escape(sid) + '"]')
                    || host.querySelector('[data-live-sid="' + CSS.escape(sid) + '"]');
                if (!el) return;
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.classList.add('svo-flash');
                setTimeout(() => el.classList.remove('svo-flash'), 2600);
            });
        }
    },

    /** The with/without comparison strip: observed next to the modeled
     *  lossless figure (trim + caching, nothing dropped). Derived, never
     *  computed here: both figures come straight off the report, so this
     *  strip and the findings list cannot disagree. The full-compaction
     *  figure (rep.modeled) is a ceiling and only appears as the Session
     *  length row plus the note, never as the headline promise. */
    _optStrip(rep, mode) {
        const obs = rep.observed || {};
        // The headline promises the lossless counterfactual only (trim +
        // caching, nothing dropped). The full-compaction figure stays a
        // ceiling, surfaced in the Session length row and the note, never
        // as the promise. Older persisted reports lack modeled_lossless;
        // fall back to the full figure until a rescan.
        const mod = rep.modeled_lossless || rep.modeled || {};
        const b = rep.buckets || {};
        const wrap = document.createElement('div');
        wrap.className = 'svo-strip';
        const from = this._optValue(obs.total_tokens, obs.est_cost_usd, mode);
        const to = this._optValue(mod.total_tokens, mod.est_cost_usd, mode);
        const savedTok = (obs.total_tokens || 0) - (mod.total_tokens || 0);
        const savedUsd = obs.est_cost_usd != null && mod.est_cost_usd != null
            ? obs.est_cost_usd - mod.est_cost_usd : null;
        const saved = this._optValue(savedTok, savedUsd, mode);
        const headline = mode === 'subscription'
            ? 'headroom back with nothing dropped'
            : 'avoidable spend, lossless fixes only';
        const split = this._optBucketSplit(rep);
        const trimV = this._optValue(split.trim.tokens, split.trim.est_value_usd, mode);
        const sessV = this._optValue(split.sess.tokens, split.sess.est_value_usd, mode);
        let note = '';
        if (split.trim.tokens > 0) {
            note = '<div class="svo-strip-note">The headline counts only lossless fixes: ' +
                `<b>${trimV.lead}</b> of oversized tool results re-billed on every later turn (itemized by tool right below, and under each session with the turn that produced each one) plus cheaper caching rates. ` +
                `A further <b>${sessV.lead}</b> sits in long sessions re-sending their history; recovering it takes ending or splitting those sessions (fresh session, state note, or subagents). Treat that as a ceiling, not a promise.</div>`;
        } else if (split.sess.tokens > 0) {
            note = `<div class="svo-strip-note">No lossless trim opportunities were found in this window. A further <b>${sessV.lead}</b> sits in long sessions re-sending their history; recovering it takes ending or splitting those sessions (fresh session, state note, or subagents). Treat it as a ceiling, not a promise.</div>`;
        }
        wrap.innerHTML =
            '<div class="svo-strip-head"><span class="svo-eyebrow">What your sessions used, and what they could have used</span>' +
            '<span class="svo-strip-label" title="Modeled from the lower-bound waste buckets below. List-price estimate, not an invoice.">modeled estimate</span></div>' +
            '<div class="svo-strip-row">' +
            `<div class="svo-strip-cell"><div class="svo-strip-v">${from.lead}</div><div class="svo-strip-l">actually used, last ${rep.window_days} days${from.sub ? ' · ' + from.sub : ''}</div></div>` +
            '<div class="svo-strip-arrow">→</div>' +
            `<div class="svo-strip-cell"><div class="svo-strip-v svo-accent">${to.lead}</div><div class="svo-strip-l">with the lossless fixes applied: trimmed tool results and caching${to.sub ? ' · ' + to.sub : ''}</div></div>` +
            `<div class="svo-strip-cell svo-strip-save"><div class="svo-strip-v">${saved.lead}</div><div class="svo-strip-l">${headline}${saved.sub ? ' · ' + saved.sub : ''}</div></div>` +
            '</div>' +
            '<div class="svo-buckets">' +
            this._optBucketRow('Trim tool results at the source', split.trim, obs, mode, 'lossless',
                'Oversized tool results this scan caught being re-billed on later turns. Trimming them where they are produced loses nothing.') +
            this._optBucketRow('Prompt caching', b.cache, obs, mode, 'lossless',
                'Context re-billed at the full input rate because the stable prefix was not cache-friendly. Fixing it changes the rate, not the content.') +
            this._optBucketRow('Session length', split.sess, obs, mode, 'quality tradeoff',
                'History long sessions re-send every turn. Only ending or splitting those sessions (fresh session, state note, subagents) recovers it.',
                'Not in the headline above: getting this back costs context, not just tokens.') +
            '</div>' +
            // The method and the caveats matter, but they are a second read:
            // as always-on prose they cost a third of the card's height and
            // pushed the actual numbers up against the fold. One click away,
            // never further.
            '<div class="svo-strip-foot">' +
            '<button type="button" class="svo-strip-why" aria-expanded="false">How this number is built</button>' +
            '<button type="button" class="btn btn-secondary btn-sm svo-share">Share as image</button></div>' +
            `<div class="svo-strip-more"${this._optStripMoreOpen ? '' : ' hidden'}>` + note +
            '<div class="svo-strip-caveat">Token counts are exact; dollar figures are list-price estimates and are labelled. The modeled changes touch re-sent context only: model outputs are never altered. Nothing here claims your invoice will change.</div></div>';
        wrap.querySelector('.svo-share').addEventListener('click',
            (ev) => this._optShareCard(ev.currentTarget, rep, mode, null));
        const why = wrap.querySelector('.svo-strip-why');
        const setMore = (open) => {
            this._optStripMoreOpen = open;
            wrap.querySelector('.svo-strip-more').toggleAttribute('hidden', !open);
            why.setAttribute('aria-expanded', String(open));
            why.textContent = open ? 'Hide how this is built' : 'How this number is built';
        };
        setMore(!!this._optStripMoreOpen);
        why.addEventListener('click', () => setMore(!this._optStripMoreOpen));
        // Daily shape of the window total, so "already billed, window total"
        // has a silhouette. Exact per-day token sums from the scan.
        const daily = rep.daily || [];
        if (daily.length > 1) {
            const w = 560, h = 42, max = Math.max(...daily.map(d => d.tokens), 1);
            const step = w / (daily.length - 1);
            const pts = daily.map((d, i) =>
                `${(i * step).toFixed(1)},${(h - 3 - (d.tokens / max) * (h - 8)).toFixed(1)}`).join(' ');
            const spark = document.createElement('div');
            spark.className = 'svo-spark';
            spark.innerHTML =
                `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">` +
                `<polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>` +
                `<span>tokens per day across the window · peak ${this._optFmtTok(max)} on ${
                    this._esc((daily.find(d => d.tokens === max) || {}).date || '')}</span>`;
            wrap.appendChild(spark);
        }
        return wrap;
    },

    /** Split the compaction bucket by the kind of fix it takes. The scan
     *  attributes part of it to specific oversized tool results re-billed on
     *  later turns (tool_result_carry findings): that share is recoverable
     *  losslessly by trimming at the source. Only the remainder genuinely
     *  requires session hygiene (fresh session, state note, subagents). */
    _optBucketSplit(rep) {
        const comp = (rep.buckets && rep.buckets.compaction) || { tokens: 0, est_value_usd: 0 };
        let carryTok = 0, carryUsd = 0;
        (rep.findings || []).forEach(f => {
            if (f.type !== 'tool_result_carry') return;
            carryTok += f.tokens_wasted || 0;
            carryUsd += f.est_value_usd || 0;
        });
        const trimTok = Math.min(carryTok, comp.tokens || 0);
        const trimUsd = Math.min(carryUsd, comp.est_value_usd || 0);
        return {
            trim: { tokens: trimTok, est_value_usd: trimUsd },
            sess: {
                tokens: Math.max(0, (comp.tokens || 0) - trimTok),
                est_value_usd: Math.max(0, (comp.est_value_usd || 0) - trimUsd),
            },
        };
    },

    /** The trim ledger: every oversized tool result the scan caught, rolled
     *  up by the tool that produced it, each row a before → after token
     *  story (result size → excerpt) with what re-billing it actually cost.
     *  Observed numbers only: sizes, turns and totals come straight off the
     *  carry findings; the excerpt figure is a stated modeling assumption. */
    _OPT_EXCERPT_TOK: 2000,

    _optTrimLedger(rep, mode) {
        const carries = (rep.findings || []).filter(
            f => f.type === 'tool_result_carry' && f.tool != null);
        if (!carries.length) return null;
        const byTool = new Map();
        carries.forEach(f => {
            const k = f.tool || 'tool';
            const t = byTool.get(k) || { tool: k, n: 0, biggest: 0, rebilled: 0, tok: 0, usd: 0 };
            t.n += 1;
            t.biggest = Math.max(t.biggest, f.result_tokens_est || 0);
            t.rebilled += f.carried_turns || 0;
            t.tok += f.tokens_wasted || 0;
            t.usd += f.est_value_usd || 0;
            byTool.set(k, t);
        });
        const rows = [...byTool.values()].sort((a, b) => b.tok - a.tok);
        const maxTok = rows[0].tok || 1;
        const shown = rows.slice(0, 8);
        const card = document.createElement('div');
        card.className = 'svo-trim';
        card.innerHTML =
            '<div class="svo-trim-head"><span class="svo-sess-h"><span>Where trimming pays</span>' +
            `<span class="svo-chip">${carries.length} oversized results, by tool</span></span></div>` +
            '<p class="svo-trim-p">Each result below entered context whole and was re-billed on every later turn of its session. ' +
            `The after figure models the same result trimmed to a ${(this._OPT_EXCERPT_TOK / 1000).toFixed(0)}K-token excerpt (head, tail, or grep matches) before it entered context. ` +
            `<button type="button" class="svo-copyfix" data-fix="tool_result_carry" title="${this._esc(this._OPT_COPYFIX_TITLE)}">Copy trim request</button></p>` +
            '<div class="svo-trim-rows">' + shown.map(t => {
                const avoid = this._optValue(t.tok, t.usd, mode);
                const pct = Math.max(3, Math.round((t.tok / maxTok) * 100));
                const ba = t.biggest > this._OPT_EXCERPT_TOK
                    ? `biggest ${this._optFmtTok(t.biggest)} tok <span class="svo-trim-arrow">→</span> ~${this._optFmtTok(this._OPT_EXCERPT_TOK)} tok excerpt`
                    : `already excerpt-sized (biggest ${this._optFmtTok(t.biggest)} tok); the cost is the re-billing`;
                return '<div class="svo-trim-row">' +
                    `<span class="svo-trim-tool">${this._esc(t.tool)}</span>` +
                    `<span class="svo-trim-n">${t.n} result${t.n === 1 ? '' : 's'}</span>` +
                    `<span class="svo-trim-ba">${ba}</span>` +
                    `<span class="svo-trim-turns">re-billed on ${t.rebilled.toLocaleString()} turns</span>` +
                    `<span class="svo-bucket-bar"><span style="width:${pct}%"></span></span>` +
                    `<span class="svo-trim-v">${avoid.lead}${avoid.sub ? ' · ' + avoid.sub : ''} avoidable</span>` +
                    '</div>';
            }).join('') + '</div>' +
            (rows.length > shown.length
                ? `<div class="svo-trim-more">${rows.length - shown.length} more tools below the top 8, all listed under their sessions.</div>`
                : '');
        const cbtn = card.querySelector('.svo-copyfix');
        if (cbtn) cbtn.addEventListener('click', () =>
            this._optCopyText(cbtn, this._optFixSnippet('tool_result_carry', null).text,
                { type: 'tool_result_carry', label: 'Copy trim request' }));
        return this._optCollapsible(card, '_optTrimOpen');
    },

    /** Tooltip for a collecting receipt: when the comparison unlocks. */
    _optEta(p) {
        const sLeft = Math.max(0, (p.needed_sessions || 0) - (p.after_sessions || 0));
        const dLeft = Math.max(0, (p.needed_days || 0) - (p.after_days || 0));
        const parts = [];
        if (sLeft > 0) parts.push(`${sLeft} more session${sLeft === 1 ? '' : 's'}`);
        if (dLeft > 0) parts.push(`about ${dLeft % 1 ? dLeft.toFixed(1) : dLeft} more day${dLeft <= 1 ? '' : 's'} of use`);
        const when = parts.length ? `Available after ${parts.join(' and ')}` : 'Available on the next rescan';
        return `${when} (needs ${p.needed_sessions} sessions and ${p.needed_days} days on the after side). No number is shown until then: a thin after side would be a guess, not a measurement.`;
    },

    /** Collapse wiring for the informative depth cards: header stays as a
     *  one-line summary, the body opens on demand. State persists across
     *  re-renders within the tab so an opened card stays open. */
    _optCollapsible(card, stateKey) {
        const open = this[stateKey] === true;
        const head = card.querySelector('.svo-trim-head');
        const body = document.createElement('div');
        while (head.nextSibling) body.appendChild(head.nextSibling);
        card.appendChild(body);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'svo-sess-toggle';
        const set = (on) => {
            body.style.display = on ? '' : 'none';
            btn.textContent = on ? 'Hide' : 'Show';
        };
        set(open);
        btn.addEventListener('click', () => {
            this[stateKey] = !(this[stateKey] === true);
            set(this[stateKey]);
        });
        head.appendChild(btn);
        return card;
    },

    /** Industry playbook, scored on the user's own data. Each practice is
     *  the standard advice for LLM cost control, but instead of quoting it
     *  as a blog list, every row is checked against this report's findings:
     *  a practice either shows measured waste here or reads healthy. */
    _optPlaybook(rep, mode) {
        const findings = rep.findings || [];
        const sumFor = (types) => {
            let tok = 0, usd = 0;
            findings.forEach(f => {
                if (!types.includes(f.type)) return;
                tok += f.tokens_wasted || 0;
                usd += f.est_value_usd || 0;
            });
            return { tok, usd };
        };
        const rows = [
            { name: 'Cache the stable prefix', types: ['low_cache_utilization'],
              why: 'Cache reads bill at roughly a tenth of fresh input. Keep the system prompt and tool definitions byte-stable so the prefix stays cacheable.' },
            { name: 'Trim tool results at the source', types: ['tool_result_carry'],
              why: 'Only the excerpt a turn needs should enter context. A full dump is re-billed on every later turn of the session.' },
            { name: 'Keep sessions short and stateful', types: ['repeated_context'],
              why: 'Re-sent context grows with every turn. Finish the task, write a short state note, and continue in a fresh session.' },
            { name: 'Right-size the model per task', types: ['model_right_sizing'],
              why: 'Route easy work (classification, extraction, small edits) to a smaller model and keep the frontier model for hard reasoning.' },
            { name: 'Never pay for the same call twice', types: ['duplicate_llm'],
              why: 'Deduplicate identical requests and cache repeat answers at the application layer.' },
            { name: 'Cap and shape outputs', types: ['excessive_output'],
              why: 'Set max_tokens and ask for the answer, not a recap. Output tokens are the most expensive tokens.' },
            { name: 'Stop failure loops early', types: ['retry_loop', 'abnormal_loop'],
              why: 'Every retry re-bills the full context. Back off, change the plan, or surface the error instead of re-asking.' },
        ];
        if (mode === 'api') {
            rows.push({ name: 'Batch what nobody is waiting for', types: null,
                why: 'Non-interactive work (evals, backfills, bulk summaries) runs at half price on batch endpoints. Local transcripts cannot show whether you already use them.' });
        }
        let hits = 0;
        const body = rows.map(r => {
            let chip;
            if (!r.types) {
                chip = '<span class="svo-play-chip na" title="This practice lives outside the transcripts SecureVector can read locally.">beyond local visibility</span>';
            } else {
                const agg = sumFor(r.types);
                if (agg.tok > 0) {
                    hits += 1;
                    const v = this._optValue(agg.tok, agg.usd, mode);
                    chip = `<span class="svo-play-chip hit" title="Findings of this kind exist in your last scan; the amount is what they add up to. The matching rows under All findings each carry the fix and a copy-paste request.">seen here · ${v.lead}</span>`;
                } else {
                    chip = '<span class="svo-play-chip ok" title="The last scan found no waste of this kind.">looks healthy</span>';
                }
            }
            return '<div class="svo-play-row">' +
                `<span class="svo-play-n">${this._esc(r.name)}</span>` +
                `<span class="svo-play-w">${this._esc(r.why)}</span>` +
                chip + '</div>';
        }).join('');
        const scored = rows.filter(r => r.types).length;
        const card = document.createElement('div');
        card.className = 'svo-trim svo-play';
        card.innerHTML =
            '<div class="svo-trim-head"><span class="svo-sess-h"><span>Good practice, scored on your data</span>' +
            `<span class="svo-chip">${hits} of ${scored} need attention</span></span></div>` +
            '<p class="svo-trim-p">The standard playbook for LLM cost control, checked against your own transcripts from the last scan instead of quoted as generic advice.</p>' +
            `<div class="svo-play-rows">${body}</div>`;
        return this._optCollapsible(card, '_optPlayOpen');
    },

    _optBucketRow(label, bucket, obs, mode, nature, tip, caption) {
        if (!bucket || !bucket.tokens) return '';
        const total = obs.total_tokens || 1;
        const pct = Math.min(100, Math.round((bucket.tokens / total) * 100));
        const v = this._optValue(bucket.tokens, bucket.est_value_usd, mode);
        const tag = nature
            ? `<span class="svo-bucket-tag${nature === 'quality tradeoff' ? ' warn' : ''}">${nature}</span>`
            : '';
        const cap = caption ? `<span class="svo-bucket-cap">${this._esc(caption)}</span>` : '';
        return `<div class="svo-bucket"><span class="svo-bucket-l"${tip ? ` title="${this._esc(tip)}"` : ''}>` + label + tag + cap + '</span>' +
            '<span class="svo-bucket-bar"><span style="width:' + Math.max(pct, 2) + '%"></span></span>' +
            `<span class="svo-bucket-v">${v.lead}${v.sub ? ' · ' + v.sub : ''}</span></div>`;
    },

    // ---------------- one-time asks ----------------

    _optBillingAsk(host, st) {
        const card = document.createElement('div');
        card.className = 'svo-ask';
        card.innerHTML =
            '<div class="svo-ask-t">How do you pay for these models?</div>' +
            '<p class="svo-ask-p">This only changes which unit leads. On a subscription the invoice will not move, so the Optimizer talks in tokens: usage headroom you get back before hitting limits. On metered API billing it leads with dollar estimates.</p>' +
            '<div class="svo-ask-btns">' +
            '<button type="button" class="btn btn-secondary btn-sm" data-mode="subscription">Subscription plan</button>' +
            '<button type="button" class="btn btn-secondary btn-sm" data-mode="api">Metered API billing</button>' +
            '</div>';
        card.querySelectorAll('button[data-mode]').forEach(btn => btn.addEventListener('click', async () => {
            try {
                await API.setOptimizerPrefs({ billing_mode: btn.dataset.mode });
                await this._loadAndRenderOptimizer();
            } catch (e) { if (window.Toast) Toast.error('Could not save: ' + e.message); }
        }));
        host.appendChild(card);
    },

    _optRecommendAsk(host) {
        // Recommendations are offered, not imposed: one-time card, reversible
        // in Cost Settings. Same consent pattern as Instant Audit.
        const card = document.createElement('div');
        card.className = 'svo-ask';
        card.innerHTML =
            '<div class="svo-ask-t">Want recommendations on how to fix these?</div>' +
            '<p class="svo-ask-p">Each one states what it saves you before you act, with the evidence: what was observed, on what share of calls, in which sessions. You can turn this off any time under Cost Settings.</p>' +
            '<div class="svo-ask-btns">' +
            '<button type="button" class="btn btn-primary btn-sm" data-rec="1">Show recommendations</button>' +
            '<button type="button" class="btn btn-secondary btn-sm" data-rec="0">Not now</button>' +
            '</div>';
        card.querySelectorAll('button[data-rec]').forEach(btn => btn.addEventListener('click', async () => {
            try {
                await API.setOptimizerPrefs({ recommend_enabled: btn.dataset.rec === '1' });
                await this._loadAndRenderOptimizer();
            } catch (e) { if (window.Toast) Toast.error('Could not save: ' + e.message); }
        }));
        host.appendChild(card);
    },

    // ---------------- findings ----------------

    // The finding types the headline's lossless counterfactual subtracts.
    // Keep in step with `modeled_lossless` in cost_optimizer.py: anything
    // outside this set is real waste but is not what the headline promises.
    _OPT_LOSSLESS_TYPES: { tool_result_carry: 1, low_cache_utilization: 1 },

    _OPT_TYPE_LABELS: {
        repeated_context: 'Repeated context',
        tool_result_carry: 'Tool-result carry',
        low_cache_utilization: 'Low cache utilisation',
        retry_loop: 'Retry loop',
        duplicate_llm: 'Duplicate requests',
        excessive_output: 'Excessive output',
        abnormal_loop: 'Abnormal loop shape',
        model_right_sizing: 'Model right-sizing',
    },

    /** Sessions view: one card per agent session, live first. Joins three
     *  local sources by session id: the activity sweep (live or stale, and
     *  the context size a live session is re-sending right now), the last
     *  scan's session summaries (tokens, turns), and the scan's findings
     *  (why it cost what it did + what to change). Subagent streams
     *  (sid:agent-*) fold into their parent session's card. */
    /** Live-status refresh between full renders: updates the context-now
     *  figure on live cards in place, and only re-renders the tab when a
     *  session actually starts or stops (so expanded cards stay expanded). */
    async _refreshOptSessions() {
        // The live band must stay as current as the Guardian bot: both read
        // the same endpoint, so the page and the bot never disagree. It
        // refreshes independently of the sessions list, which discovers over
        // a different window and could in principle be absent.
        await this._refreshLiveBand();
        const sec = document.getElementById('svo-sessions-sec');
        if (!sec) return;
        const act = await API.getOptimizerSessions(30);
        if (!act || !act.sessions) return;
        this._optActivity = act;
        const liveNow = new Set(act.sessions.filter(x => x.active).map(x => x.session_id));
        const cards = [...sec.querySelectorAll('.svo-sess-card')];
        const changed = cards.some(c =>
            (c.dataset.live === '1') !== liveNow.has(c.dataset.sid));
        if (changed) { await this._loadAndRenderOptimizer(); return; }
        act.sessions.forEach(x => {
            if (!x.active || x.context_tokens_now == null) return;
            const card = sec.querySelector(`.svo-sess-card[data-sid="${CSS.escape(x.session_id)}"]`);
            const fact = card && card.querySelector('.svo-accent-t');
            if (fact) fact.textContent =
                `re-sending ${this._optFmtTok(x.context_tokens_now)} tok each turn`;
        });
    },

    _optSessionsSec(host, rep, st) {
        const mode = this._optMode(st, rep);
        const recOn = !!(st.prefs && st.prefs.recommend_enabled);
        const act = (this._optActivity && this._optActivity.sessions) || [];
        if (!act.length) return;

        const summaries = new Map();
        (rep.session_summaries || []).forEach(x => summaries.set(x.session_id, x));
        const findsBySid = new Map();
        (rep.findings || []).forEach(f => {
            if (!f.session_id) return;
            const parent = String(f.session_id).split(':')[0];
            if (!findsBySid.has(parent)) findsBySid.set(parent, []);
            findsBySid.get(parent).push(f);
        });

        const rows = act.map(a => {
            const sid = a.session_id;
            let turns = 0, promptTok = 0, outTok = 0, streams = 0;
            summaries.forEach((x, key) => {
                if (key === sid || key.startsWith(sid + ':')) {
                    turns += x.turns || 0;
                    promptTok += x.prompt_tokens || 0;
                    outTok += x.output_tokens || 0;
                    streams += 1;
                }
            });
            const finds = findsBySid.get(sid) || [];
            const wasted = finds.reduce((n, f) => n + (f.tokens_wasted || 0), 0);
            const value = finds.reduce((n, f) => n + (f.est_value_usd || 0), 0);
            // Same set the row displays, so the order and the number agree.
            const lossless = finds.reduce(
                (n, f) => n + (this._OPT_LOSSLESS_TYPES[f.type] ? (f.tokens_wasted || 0) : 0), 0);
            return { a, sid, turns, promptTok, outTok, streams, finds, wasted, value, lossless,
                     scanned: streams > 0 };
        });

        const live = rows.filter(r => r.a.active);
        const stale = rows.filter(r => !r.a.active)
            .sort((x, y) => (y.lossless - x.lossless) || (y.wasted - x.wasted));

        const sec = document.createElement('div');
        sec.className = 'svo-sec';
        sec.id = 'svo-sessions-sec';

        const h = document.createElement('div');
        h.className = 'svo-sec-h svo-sess-h';
        h.innerHTML = '<span>Sessions</span>' +
            (live.length ? `<span class="svo-chip svo-chip-live">${live.length} live</span>` : '') +
            `<span class="svo-chip" title="Ordered by the lossless waste in each session: the part you can trim with nothing dropped.">${stale.length} recent, most fixable first</span>`;
        sec.appendChild(h);

        // One list, one pattern: every session is a collapsible row.
        // Agent numbers follow recency (Agent #1 is the newest), matching
        // how the Agent Map numbers sessions. Every row starts closed when
        // the live band is up: the band already tells the live story in
        // full, and opening the same sessions again here repeated half a
        // screen of identical guidance. With the band off, live rows still
        // open so the act-now step is never hidden behind a click.
        const bandShown = !!(this._optLive && this._optLive.enabled !== false
            && (this._optLive.sessions || []).length);
        const ordered = [...live, ...stale];
        const list = document.createElement('div');
        list.className = 'svo-sess-list';
        const PAGE = 8 + live.length;
        const shown = this._optShowAllSessions ? ordered : ordered.slice(0, PAGE);
        shown.forEach((r, i) => list.appendChild(
            this._optSessionRow(r, rep, mode, recOn, r.a.active, i + 1,
                r.a.active && !bandShown)));
        if (!this._optShowAllSessions && ordered.length > PAGE) {
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'svo-sess-more';
            more.textContent = `Show all ${ordered.length} sessions`;
            more.addEventListener('click', async () => {
                this._optShowAllSessions = true;
                await this._loadAndRenderOptimizer();
            });
            list.appendChild(more);
        }
        sec.appendChild(list);
        host.appendChild(sec);
    },

    /** One row per session, live or recent: a click toggles the inline
     *  story (why it cost what it did, what to change). `autoOpen` decides
     *  the starting state, so live rows stay closed while the live band is
     *  saying the same thing; agent numbers follow recency. */
    _optSessionRow(r, rep, mode, recOn, isLive, num, autoOpen) {
        const { a, sid, finds } = r;
        const wrap = document.createElement('div');
        wrap.className = 'svo-sess-rowwrap' + (isLive ? ' live' : '');
        wrap.dataset.sid = sid;
        wrap.dataset.live = isLive ? '1' : '0';
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'svo-sess-row';
        // One "avoidable" number per row used to sum both buckets, so a row
        // could read 3.8B while the page headline promised 143.8M: the row was
        // 26x the whole page and looked authoritative. Split it the way the
        // strip does, and the two reconcile: the lossless figures across rows
        // are what the headline counts.
        // Only the types the headline's lossless counterfactual actually
        // subtracts, so a row's figure and the strip's promise are the same
        // quantity. Duplicate calls and retry loops are real waste, but their
        // tokens_wasted is the repeat turn's whole prompt, which overlaps the
        // re-sent context already counted below: adding them here would make
        // the rows sum past the headline again. They stay visible as their own
        // count, and in full when the row is open.
        const QT = 'repeated_context';
        let lossTok = 0, lossUsd = 0, histTok = 0, histUsd = 0, otherN = 0;
        (finds || []).forEach(f => {
            if (f.type === QT) { histTok += f.tokens_wasted || 0; histUsd += f.est_value_usd || 0; }
            else if (this._OPT_LOSSLESS_TYPES[f.type]) {
                lossTok += f.tokens_wasted || 0; lossUsd += f.est_value_usd || 0;
            } else { otherN += 1; }
        });
        const lossV = this._optValue(lossTok, lossUsd, mode);
        const histV = this._optValue(histTok, histUsd, mode);
        // "3.7B tok" says how much but not whether that is a lot. The share of
        // the session's own traffic is the anchor that makes it readable.
        const sessTotal = (r.promptTok || 0) + (r.outTok || 0);
        const histPct = histTok > 0 && sessTotal > 0
            ? Math.min(99, Math.max(1, Math.round((histTok / sessTotal) * 100)))
            : null;
        const status = isLive
            ? '<span class="svo-live-badge">LIVE</span>'
            : `<span class="svo-sess-row-when">ended ${this._esc(this._optAgo(a.last_activity))}</span>`;
        const liveFact = isLive && a.context_tokens_now != null
            ? `<span class="svo-sess-row-ctx svo-accent-t" title="Input plus cache tokens on the newest turn: the context this session re-sends with every message.">re-sending ${this._optFmtTok(a.context_tokens_now)} tok/turn</span>`
            : `<span class="svo-sess-row-turns">${r.scanned ? r.turns.toLocaleString() + ' turns' : 'not scanned yet'}</span>`;
        row.innerHTML =
            '<span class="svo-sess-row-chev"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' +
            `<span class="svo-sess-row-num">Agent #${num}</span>` +
            `<span class="svo-sess-row-id" title="Session ${this._esc(sid)}">${this._esc(String(sid).slice(0, 8))}…</span>` +
            `<span class="svo-sess-row-h">${this._esc(a.harness || '')}</span>` +
            status + liveFact +
            `<span class="svo-sess-row-waste" title="${this._esc(
                lossTok > 0
                    ? 'Lossless: oversized tool results re-billed on later turns, plus caching. This is the part the headline above counts. Open the row for each cause and its fix.'
                    : (!r.scanned
                        ? 'This session started after the last scan. Rescan to include it.'
                        : otherN > 0
                            ? 'Nothing here is counted in the headline, but this session has findings of other kinds, such as duplicate or retried calls. Open the row to see them.'
                            : 'No waste found in this session.'))}">${
                lossTok > 0 ? 'lossless ' + lossV.lead
                    : (!r.scanned ? 'not in last scan'
                        : otherN > 0
                            ? otherN + (otherN === 1 ? ' other finding' : ' other findings')
                            : 'clean')}</span>` +
            `<span class="svo-sess-row-hist"${histTok > 0 ? ' title="' + this._esc(
                'Context this session re-sent as history' + (histPct != null ? ', ' + histPct + '% of everything it sent and received' : '')
                + '. Not counted in the headline: recovering it means ending or splitting the session, not a lossless fix.') + '"' : ''}>${
                histTok > 0 ? 'session length ' + histV.lead : ''}</span>`;
        wrap.appendChild(row);

        const buildPanel = () => {
            const panel = document.createElement('div');
            panel.className = 'svo-sess-panel';
            const why = this._optSessionWhy(r, mode, recOn, isLive);
            if (why) panel.appendChild(why);
            else {
                const none = document.createElement('div');
                none.className = 'svo-sess-hint';
                none.textContent = r.scanned
                    ? 'Nothing avoidable above the noise floor in this session.'
                    : 'This session started after the last scan. Rescan to analyze it.';
                panel.appendChild(none);
            }
            return panel;
        };
        const setOpen = (open) => {
            let panel = wrap.querySelector('.svo-sess-panel');
            if (open && !panel) { panel = buildPanel(); wrap.appendChild(panel); }
            if (panel) panel.style.display = open ? '' : 'none';
            row.setAttribute('aria-expanded', String(open));
            wrap.classList.toggle('open', open);
        };
        row.addEventListener('click', () => {
            const panel = wrap.querySelector('.svo-sess-panel');
            setOpen(!(panel && panel.style.display !== 'none'));
        });
        setOpen(!!autoOpen); // see _optSessionsSec: the live band opens instead
        return wrap;
    },

    /** The per-session story: why it cost what it did (top causes with
     *  amounts) and what to change (deduped by cause). Live sessions lead
     *  with the act-now step. */
    _optSessionWhy(r, mode, recOn, isLive) {
        const byType = new Map();
        r.finds.forEach(f => {
            const t = byType.get(f.type) || { tokens: 0, value: 0, rec: null };
            t.tokens += f.tokens_wasted || 0;
            t.value += f.est_value_usd || 0;
            if (!t.rec && f.recommendation && f.recommendation.change) {
                t.rec = f.recommendation;
            }
            byType.set(f.type, t);
        });
        const top = [...byType.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 3);
        if (!top.length && !isLive) return null;

        const box = document.createElement('div');
        box.className = 'svo-sess-why';
        const items = [];

        if (isLive && r.a.context_tokens_now != null && r.a.context_tokens_now >= 60000
            && r.a.harness === 'claude-code') {
            items.push('<div class="svo-sess-act"><span class="svo-rec-k">Act now</span>' +
                `<span class="svo-rec-t">This session is live and re-sends about ${this._optFmtTok(r.a.context_tokens_now)} tokens of context with every turn. Cheapest for quality: finish this task and continue in a fresh session, or save a short state note and restart from it.</span>` +
                `<button type="button" class="svo-copyfix" data-fix="repeated_context" title="${this._esc(this._OPT_COPYFIX_TITLE)}">Copy state note</button></div>`);
        }

        // why: top causes with their share of this session's avoidable tokens
        if (top.length) {
            const maxTok = top[0][1].tokens || 1;
            items.push('<div class="svo-sess-part">Why it cost what it did' +
                '<span class="svo-spent-tag" title="These totals are what this session already spent across the whole window. They are receipts, not gauges: compacting or fixing a habit lowers the live tokens-per-turn figure above, it does not refund what was billed.">already billed, window total</span></div>');
            top.forEach(([type, agg]) => {
                const v = this._optValue(agg.tokens, agg.value, mode);
                const label = this._esc(this._OPT_TYPE_LABELS[type] || type);
                const pct = Math.max(4, Math.round((agg.tokens / maxTok) * 100));
                items.push('<div class="svo-sess-cause">' +
                    `<span class="svo-sess-cause-n">${label}</span>` +
                    `<span class="svo-sess-cause-bar"><span style="width:${pct}%"></span></span>` +
                    `<span class="svo-sess-cause-v">${v.lead}${v.sub ? ' · ' + v.sub : ''}</span>` +
                    '</div>');
            });
        }

        // what to change: one sentence per cause, deduped
        const recs = top.map(([type, agg]) => (agg.rec ? { type, rec: agg.rec } : null)).filter(Boolean);
        if (recs.length && recOn) {
            items.push('<div class="svo-sess-part">What to change</div>');
            recs.forEach(({ type, rec }) => {
                const snip = this._optFixSnippet(type, null);
                items.push('<div class="svo-sess-rec">' +
                    `<span class="svo-sess-rec-c">${this._esc(rec.change)}</span>` +
                    (rec.how ? `<span class="svo-sess-rec-kv"><b>How</b>${this._esc(rec.how)}</span>` : '') +
                    (rec.risk ? `<span class="svo-sess-rec-kv"><b>Risk</b>${this._esc(rec.risk)}</span>` : '') +
                    (snip ? `<button type="button" class="svo-copyfix" data-fix="${this._esc(type)}" title="${this._esc(this._OPT_COPYFIX_TITLE)}">${snip.label}</button>` : '') +
                    '</div>');
            });
        } else if (top.length && !recOn) {
            items.push('<div class="svo-sess-hint">Turn on recommendations above to see the suggested change for each cause.</div>');
        }
        if (recs.length && recOn) {
            items.push('<div class="svo-sess-note">SecureVector recommends from what it observed in this transcript. Reviewing and applying any change is yours to decide: nothing is executed for you.</div>');
        }
        box.innerHTML = items.join('');
        box.querySelectorAll('.svo-copyfix').forEach(btn => {
            const snip = this._optFixSnippet(btn.dataset.fix, null);
            if (snip) btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this._optCopyText(btn, snip.text,
                    { type: btn.dataset.fix, session_id: r.sid, label: snip.label });
            });
        });
        return box;
    },

    _optAgo(iso) {
        const t = Date.parse(iso || '');
        if (!Number.isFinite(t)) return '';
        const mins = Math.max(1, Math.round((Date.now() - t) / 60000));
        if (mins < 60) return mins + 'm ago';
        const hrs = Math.round(mins / 60);
        if (hrs < 48) return hrs + 'h ago';
        return Math.round(hrs / 24) + 'd ago';
    },

    // ---------------- live right now: the page tells the bot's story ----------

    /** Copy-paste fix for a live advisory. Shares texts with the findings
     *  snippets where the cause is the same; live-only causes get their own.
     *  Clipboard only, always: the human is the only writer into a session. */
    _optLiveFix(type, a) {
        a = a || {};
        if (type === 'tool_result_carry') {
            return this._optFixSnippet('tool_result_carry',
                { tool: a.tool, result_tokens_est: a.tokens });
        }
        const stateNote = this._optFixSnippet('repeated_context', {}).text;
        if (type === 'duplicate_calls') {
            return {
                label: 'Copy dedupe request',
                text: `The same ${a.tool || 'tool'} call ran ${a.count || 'several'} times with identical input. Reuse the earlier result instead of calling again, and tell me before repeating any call with the same input.`,
            };
        }
        if (type === 'failure_loop') {
            return {
                label: 'Copy stop-loop request',
                text: 'Stop retrying the failing command. State what failed, what you already tried, and propose a different approach before running anything else. Repeated failing runs bill the full context on every attempt.',
            };
        }
        if (type === 'compact_act_now' || type === 'compact_last_call') {
            return {
                label: 'Copy state note + compact step',
                text: stateNote + '\n\nAfter the note is written I will type: /compact keep the current task, the decisions made, the files in flight, and the exact next step. Drop everything else. If I am switching to an unrelated task instead, I will use /clear.',
            };
        }
        return { label: 'Copy state note template', text: stateNote };
    },

    _optLiveAdvText(a) {
        if (a.type === 'tool_result_carry') {
            return `A tool result of about ${this._optFmtTok(a.tokens || 0)} tokens from ${a.tool || 'a tool'} just entered this context. Every later turn re-bills it.`;
        }
        if (a.type === 'resend_growth') {
            return `Context re-sent per turn grew from ${this._optFmtTok(a.from_tokens || 0)} to ${this._optFmtTok(a.to_tokens || 0)} tokens.`;
        }
        if (a.type === 'duplicate_calls') {
            return `The same ${a.tool || 'tool'} call ran ${a.count} times in a row.`;
        }
        if (a.type === 'failure_loop') {
            return `${a.streak} tool calls failed back to back: this session is paying to fail repeatedly.`;
        }
        if (a.type === 'long_session') {
            return 'Long session: its whole history is re-billed on every turn.';
        }
        return '';
    },

    /** Re-read the live endpoint and patch the band in place. A session
     *  appearing or leaving, or a compact stage or advisory changing, needs
     *  the full rebuild; fill percent and re-send rate patch without one. */
    async _refreshLiveBand() {
        const live = await API.getOptimizerLive();
        if (!live) return;
        const prev = this._optLive;
        this._optLive = live;
        const band = document.querySelector('.svo-liveband');
        const now = live.sessions || [];
        const before = (prev && prev.sessions) || [];
        const key = (arr) => arr.map(s => s.session_id + ':' + (s.compact_stage || '')
            + ':' + (s.advisories || []).map(a => a.type).sort().join(',')).join('|');
        if (!band || key(now) !== key(before)) {
            await this._loadAndRenderOptimizer();
            return;
        }
        now.forEach((s) => {
            const row = band.querySelector(
                `.svo-live-row[data-live-sid="${CSS.escape(s.session_id)}"]`);
            if (!row) return;
            const pct = s.fill_pct != null ? Math.min(100, s.fill_pct) : null;
            const label = row.querySelector('.svo-live-top span');
            if (label && pct != null) {
                label.textContent = `${Math.round(pct)}% of a ${this._optFmtTok(s.context_window || 200000)} token window, re-sending ${this._optFmtTok(s.context_tokens_now || 0)} tok/turn`;
            }
            const fill = row.querySelector('.svo-live-fill i');
            if (fill && pct != null) fill.style.width = pct + '%';
        });
    },

    /** "Fixes you copied" band: the follow-through on every copy button on
     *  this page. Three states, and the difference between them is the whole
     *  point: copied is certain, pasted is read from the local transcript, and
     *  worked is measured. Nothing here is celebrated on a paste alone. */
    _optFixesSec() {
        const fixes = (this._optLive && this._optLive.fixes) || null;
        const rows = (fixes && fixes.recent) || [];
        if (!rows.length) return null;
        const card = document.createElement('div');
        card.className = 'svo-trim';
        const worked = rows.filter(f => f.status === 'worked').length;
        const head = document.createElement('div');
        head.className = 'svo-trim-head';
        head.innerHTML = '<span class="svo-sess-h" style="display:inline-flex">' +
            '<span>Fixes you copied</span>' +
            (worked ? `<span class="svo-chip">${worked} verified</span>` : '') +
            '</span>' +
            '<span class="svo-live-note" title="SecureVector looks for the copied text in the transcript on this device, then re-measures what the advice was about. A fix is only called verified once the number moves.">measured, not assumed</span>';
        card.appendChild(head);
        rows.forEach(f => {
            const row = document.createElement('div');
            row.className = 'svo-live-item';
            const t = document.createElement('span');
            t.textContent = this._optFixLine(f);
            row.appendChild(t);
            card.appendChild(row);
        });
        const note = document.createElement('div');
        note.className = 'svo-sess-note';
        note.textContent = 'Nothing is executed for you. SecureVector only reads '
            + 'the transcripts already on this machine to see whether a fix you '
            + 'pasted changed anything.';
        card.appendChild(note);
        return card;
    },

    /** One line per copied fix, in the state it actually reached. Wording is
     *  deliberately flat for the states that are not wins: an unused fix is
     *  the user's call, not a failure to point out. */
    _optFixLine(f) {
        const label = f.label || this._optFixName(f.type);
        const who = f.session_id
            ? `Agent ${String(f.session_id).slice(0, 8)}…` : 'a session';
        const before = (f.before || {}).context_tokens;
        const after = (f.after || {}).context_tokens;
        switch (f.status) {
            case 'worked':
                // "your compact" appears only when a manual compact boundary
                // was seen in the transcript after the paste: measured fact,
                // same honesty rule as everything else on this band.
                return before && after && after < before
                    ? `${label}: worked. Context in ${who} went from `
                        + `${this._fmtTokens(before)} to ${this._fmtTokens(after)} tokens`
                        + (f.compacted === 'manual' ? ' after your compact.' : '.')
                    : `${label}: worked. The ${this._optFixName(f.type)} has not `
                        + `come back in ${who}.`;
            case 'pasted':
                return `${label}: pasted into ${who}. Watching the next few turns.`;
            case 'copied':
                return `${label}: copied, not pasted yet.`;
            case 'no_paste':
                return `${label}: copied, never pasted. No harm done.`;
            case 'auto_compacted':
                return `${label}: context in ${who} came down, but auto-compact `
                    + 'did it. Not counting that one as yours.';
            default:
                return `${label}: pasted, but the numbers have not moved yet.`;
        }
    },

    _optFixName(type) {
        switch (type) {
            case 'tool_result_carry': return 'oversized tool result';
            case 'duplicate_calls': return 'repeated tool call';
            case 'failure_loop': return 'failure loop';
            case 'resend_growth': return 'context resend growth';
            case 'repeated_context': return 're-sent context';
            case 'excessive_output': return 'over-long output';
            default:
                return type && type.indexOf('compact') === 0
                    ? 'full context window' : 'flagged problem';
        }
    },

    /** "Live right now" band: same data the Guardian speaks from, so the bot
     *  and the page never tell different stories. Compact staging follows the
     *  practice the design doc records: advice at task boundaries, state note
     *  first, and never a savings figure on a compact nudge. */
    _optLiveSec() {
        const live = this._optLive;
        if (!live || live.enabled === false || !(live.sessions || []).length) return null;
        const card = document.createElement('div');
        card.className = 'svo-trim svo-liveband';
        const head = document.createElement('div');
        head.className = 'svo-trim-head';
        head.innerHTML = '<span class="svo-sess-h" style="display:inline-flex">' +
            '<span>Live right now</span>' +
            `<span class="svo-chip svo-chip-live">${live.sessions.length} session${live.sessions.length === 1 ? '' : 's'}</span></span>` +
            '<span class="svo-live-note" title="Read from the transcript tail on this machine, refreshed while the session runs. Everything here is advisory: fixes are copied to your clipboard, never sent into a session.">live gauge, not a receipt</span>';
        card.appendChild(head);
        // The sessions list numbers live sessions first, in activity order:
        // matching that here keeps one session from having two names.
        const liveIds = ((this._optActivity && this._optActivity.sessions) || [])
            .filter(a => a.active).map(a => a.session_id);
        const stageLine = {
            heads_up: 'Heads-up: finish the current step, write a state note, then compact.',
            act_now: 'Act now: compact at the next stopping point, before quality drops.',
            last_call: 'Last call: auto-compact is imminent and will pick its own moment. Compact now.',
        };
        // an advisor session with no activity row has no number: it sorts last
        const rank = (x) => { const i = liveIds.indexOf(x.session_id); return i < 0 ? 1e6 : i; };
        const ordered = [...live.sessions].sort((x, y) => rank(x) - rank(y));
        for (const s of ordered) {
            const row = document.createElement('div');
            row.className = 'svo-live-row';
            row.dataset.liveSid = s.session_id;
            const pct = s.fill_pct != null ? Math.min(100, s.fill_pct) : null;
            const stage = s.compact_stage || 'quiet';
            const top = document.createElement('div');
            top.className = 'svo-live-top';
            top.innerHTML = '<b></b><span></span>';
            const num = liveIds.indexOf(s.session_id) + 1;
            const shortId = String(s.session_id || '').slice(0, 8) + '…';
            top.querySelector('b').textContent = num > 0
                ? `Agent #${num} · ${shortId}` : `Session ${shortId}`;
            top.querySelector('span').textContent = pct != null
                ? `${Math.round(pct)}% of a ${this._optFmtTok(s.context_window || 200000)} token window, re-sending ${this._optFmtTok(s.context_tokens_now || 0)} tok/turn`
                : 'context size unknown yet';
            row.appendChild(top);
            if (pct != null) {
                const bar = document.createElement('div');
                bar.className = 'svo-live-fill';
                bar.innerHTML = '<i></i>';
                bar.querySelector('i').style.width = pct + '%';
                row.appendChild(bar);
            }
            const items = [];
            if (stage !== 'quiet') items.push({ type: 'compact_' + stage, text: stageLine[stage] });
            (s.advisories || []).forEach(a => items.push({ type: a.type, data: a, text: this._optLiveAdvText(a) }));
            if (!items.length) {
                const ok = document.createElement('div');
                ok.className = 'svo-live-item';
                ok.innerHTML = '<span>Looks healthy: nothing worth interrupting for.</span>';
                row.appendChild(ok);
            }
            for (const it of items) {
                const item = document.createElement('div');
                item.className = 'svo-live-item';
                const t = document.createElement('span');
                t.textContent = it.text;
                item.appendChild(t);
                const fix = this._optLiveFix(it.type, it.data);
                if (fix) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'svo-copyfix';
                    btn.title = this._OPT_COPYFIX_TITLE;
                    btn.textContent = fix.label;
                    btn.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        this._optCopyText(btn, fix.text,
                            { type: it.type, session_id: s.session_id, label: fix.label });
                    });
                    item.appendChild(btn);
                }
                row.appendChild(item);
            }
            card.appendChild(row);
        }
        return card;
    },

    _optFindings(host, rep, st) {
        const mode = this._optMode(st, rep);
        const recOn = !!(st.prefs && st.prefs.recommend_enabled);
        const findings = rep.findings || [];
        const sec = document.createElement('div');
        sec.className = 'svo-sec';
        if (!findings.length) {
            const scannedAny = (rep.scanned && (rep.scanned.claude_code || rep.scanned.codex));
            const ok = document.createElement('div');
            ok.className = 'svo-ok';
            const okText = document.createElement('span');
            okText.textContent = scannedAny
                ? 'No material waste above the noise floor in this window. The comparison above still shows the observed totals.'
                : 'No agent sessions found in this window. Run some sessions, then rescan.';
            ok.appendChild(okText);
            sec.appendChild(ok);
            host.appendChild(sec);
            return;
        }
        // Collapsed by default: the session cards above already tell the
        // story per session; this is the full ranking for people who want
        // to work the list by type.
        const open = this._optFindingsOpen === true;
        // Lossless first: the ranking mirrors the strip. Session-length
        // findings (repeated_context) are real observations but their fix
        // is a quality tradeoff, so they sink below every lossless item
        // instead of burying the list under one mechanism.
        const QT_TYPES = new Set(['repeated_context']);
        const ranked = [
            ...findings.filter(f => !QT_TYPES.has(f.type)),
            ...findings.filter(f => QT_TYPES.has(f.type)),
        ];
        const h = document.createElement('button');
        h.type = 'button';
        h.className = 'svo-sec-h svo-sec-toggle';
        h.setAttribute('aria-expanded', String(open));
        h.innerHTML = '<span class="svo-sess-h" style="display:inline-flex"><span>All findings</span>' +
            `<span class="svo-chip">${findings.length} · lossless first, then quality tradeoffs</span></span>` +
            `<span class="svo-sec-chev">${open ? 'Hide' : 'Show'}</span>`;
        h.addEventListener('click', async () => {
            this._optFindingsOpen = !open;
            await this._loadAndRenderOptimizer();
        });
        sec.appendChild(h);
        if (!open) { host.appendChild(sec); return; }

        // Digest-first: a by-type summary bar answers "where did the waste
        // go?" in one glance and doubles as a filter. The wall of cards is
        // the drill-down, not the landing view.
        const byType = new Map();
        findings.forEach(f => {
            const t = byType.get(f.type) || { count: 0, tokens: 0, value: 0 };
            t.count += 1;
            t.tokens += f.tokens_wasted || 0;
            t.value += f.est_value_usd || 0;
            byType.set(f.type, t);
        });
        const chips = document.createElement('div');
        chips.className = 'svo-typebar';
        const mkChip = (label, sub, key, active) => {
            const c = document.createElement('button');
            c.type = 'button';
            c.className = 'svo-typechip' + (active ? ' on' : '');
            c.innerHTML = '<b></b><span></span>';
            c.querySelector('b').textContent = label;
            c.querySelector('span').textContent = sub;
            c.addEventListener('click', async () => {
                this._optTypeFilter = key;
                this._optShowAllFindings = false;
                await this._loadAndRenderOptimizer();
            });
            return c;
        };
        const activeType = this._optTypeFilter || null;
        chips.appendChild(mkChip('All', String(findings.length), null, !activeType));
        [...byType.entries()]
            .sort((a, b) =>
                (QT_TYPES.has(a[0]) - QT_TYPES.has(b[0])) || (b[1].tokens - a[1].tokens))
            .forEach(([type, agg]) => {
                chips.appendChild(mkChip(
                    this._OPT_TYPE_LABELS[type] || type,
                    `${agg.count} · ${this._optFmtTok(agg.tokens)} tok`,
                    type, activeType === type));
            });
        sec.appendChild(chips);

        // The ranking is the product; a wall of hundreds of cards is not.
        // Long-running agent sessions can legitimately produce hundreds of
        // per-segment findings, so filter by the chip bar, then render the
        // top of the ranking and expand on demand.
        const FINDINGS_PAGE = 30;
        const filtered = activeType ? ranked.filter(f => f.type === activeType) : ranked;
        const shown = this._optShowAllFindings ? filtered : filtered.slice(0, FINDINGS_PAGE);
        shown.forEach(f => {
            const v = this._optValue(f.tokens_wasted, f.est_value_usd, mode);
            const snip = (recOn && f.recommendation) ? this._optFixSnippet(f.type, f) : null;
            const row = document.createElement('div');
            row.className = 'svo-find';
            const label = this._OPT_TYPE_LABELS[f.type] || f.type;
            const conf = f.confidence || 'low';
            const sessRef = f.session_id
                ? `<span class="svo-sess" title="Session ${this._esc(f.session_id)}">${this._esc(String(f.session_id).slice(0, 8))}… · ${this._esc(f.harness || '')}</span>`
                : '<span class="svo-sess">all sessions</span>';
            const turnsTxt = (f.turns && f.turns.length)
                ? (f.turns.length > 2 ? `turns ${f.turns[0]}–${f.turns[f.turns.length - 1]}`
                    : 'turn ' + f.turns.join(', '))
                : '';
            row.innerHTML =
                '<div class="svo-find-top">' +
                `<span class="svo-find-type">${label}</span>` +
                `<span class="svo-conf svo-conf-${conf}" title="Detector confidence: ${conf}">${conf}</span>` +
                (f.potential_only ? '<span class="svo-tag" title="Flagged for review only; the long outputs may be intentional.">potential</span>' : '') +
                (f.observation_only ? '<span class="svo-tag" title="An observation with no verdict: evaluate before acting.">observation</span>' : '') +
                (QT_TYPES.has(f.type) ? '<span class="svo-bucket-tag warn" title="Recovering this means ending or splitting the session; it is a ceiling, not a lossless fix.">quality tradeoff</span>' : '') +
                `<span class="svo-find-val" title="Token counts are exact; dollar values are list-price estimates.">${v.lead}${v.sub ? ' <i>' + v.sub + '</i>' : ''}</span>` +
                '</div>' +
                `<div class="svo-find-ev">${this._esc((f.evidence && f.evidence.observed) || '')}</div>` +
                '<div class="svo-find-meta">' + sessRef +
                (turnsTxt ? `<span class="svo-turns">${turnsTxt}</span>` : '') +
                (f.trace_id ? '<a class="svo-view" role="button" tabindex="0">View in Traces</a>' : '') +
                (f.beyond_trace_cap
                    ? '<span class="svo-cap" title="The analysis used the full transcript. The Traces view keeps only the most recent 1500 runs, so some referenced turns are not visible there.">exceeds the Traces 1500-run view</span>'
                    : '') +
                '</div>' +
                (recOn && f.recommendation
                    ? '<div class="svo-rec"><span class="svo-rec-k">Change</span>' +
                      `<span class="svo-rec-t">${this._esc(this._optBenefitFirst(f, mode))}</span>` +
                      (snip ? `<button type="button" class="svo-copyfix" title="${this._esc(this._OPT_COPYFIX_TITLE)}">${snip.label}</button>` : '') +
                      '</div>'
                    : '');
            const view = row.querySelector('.svo-view');
            if (view) view.addEventListener('click', () => {
                if (!window.AgentRunsPage) return;
                AgentRunsPage._pendingTrace = f.trace_id;
                const sample = f.evidence && f.evidence.sample_turns && f.evidence.sample_turns[0];
                if (sample && sample.request_id) AgentRunsPage._pendingGenRid = sample.request_id;
                if (window.Sidebar && Sidebar.navigate) Sidebar.navigate('agent-runs');
            });
            const copyBtn = row.querySelector('.svo-copyfix');
            if (copyBtn && snip) copyBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this._optCopyText(copyBtn, snip.text,
                    { type: f.type, label: snip.label });
            });
            sec.appendChild(row);
        });
        if (!this._optShowAllFindings && filtered.length > FINDINGS_PAGE) {
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'btn btn-secondary btn-sm';
            more.style.cssText = 'align-self: flex-start;';
            more.textContent = `Show all ${filtered.length}${activeType ? ' of this type' : ' findings'}`;
            more.addEventListener('click', async () => {
                this._optShowAllFindings = true;
                await this._loadAndRenderOptimizer();
            });
            sec.appendChild(more);
        }
        host.appendChild(sec);
    },

    _OPT_COPYFIX_TITLE: 'Copies a ready-to-paste request to your clipboard. You paste it into the session yourself; SecureVector never sends anything to a session.',

    /** Paste-ready fix snippets, one per finding type where pasting a
     *  request into the session actually helps. The human stays the only
     *  writer into the session: this only fills the clipboard. */
    _optFixSnippet(type, f) {
        if (type === 'repeated_context') {
            return {
                label: 'Copy state note template',
                text: 'Pause here. Write a short state note to STATE.md so a fresh session can continue this work: the task in one line, decisions already made, files in flight with their paths, and the exact next step. Keep it under 40 lines and do not copy transcript history into it.',
            };
        }
        if (type === 'tool_result_carry') {
            const tool = f && f.tool ? String(f.tool) : null;
            const big = f && f.result_tokens_est ? this._optFmtTok(f.result_tokens_est) : null;
            return {
                label: 'Copy trim request',
                text: 'From now on, keep tool results small: search first, then read only the specific line ranges you need, and keep any single tool result under about 2K tokens. Oversized results stay in context and are re-billed on every later turn.'
                    + (tool && big ? ` In this session, ${tool} results reached about ${big} tokens.` : ''),
            };
        }
        if (type === 'duplicate_llm') {
            return {
                label: 'Copy dedupe request',
                text: 'Before repeating any request or tool call with the same input, reuse the earlier result instead. If a retry is genuinely needed, say why first. Identical requests re-bill the full context each time.',
            };
        }
        if (type === 'excessive_output') {
            return {
                label: 'Copy brevity request',
                text: 'From now on, keep responses brief: answer directly, do not restate files or code back to me, and end after the answer without a recap.',
            };
        }
        return null;
    },

    /** Clipboard write with a textarea fallback, plus button feedback.
     *  `meta` (type, session_id, label) starts the follow-through clock: the
     *  service looks for this text in a local transcript and then measures
     *  whether it changed anything. Recording is best effort and never blocks
     *  or fails the copy itself. */
    async _optCopyText(btn, text, meta) {
        let ok = false;
        try {
            await navigator.clipboard.writeText(text);
            ok = true;
        } catch (_) { /* fall through to the textarea path */ }
        if (!ok) {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position: fixed; opacity: 0;';
            document.body.appendChild(ta);
            ta.select();
            try { ok = document.execCommand('copy'); } catch (_) { /* stays false */ }
            ta.remove();
        }
        if (ok && meta && meta.type) {
            API.optimizerFixCopied({
                type: meta.type,
                text,
                session_id: meta.session_id || null,
                label: meta.label || null,
            });
        }
        const prev = btn.textContent;
        btn.textContent = ok ? 'Copied, paste it into your session' : 'Copy failed';
        btn.classList.add('on');
        btn.disabled = true;
        setTimeout(() => {
            btn.textContent = prev;
            btn.classList.remove('on');
            btn.disabled = false;
        }, 1800);
    },

    /** Recommendation phrasing: the benefit leads, in the billing mode's
     *  leading unit, then the change and its evidence. */
    _optBenefitFirst(f, mode) {
        const v = this._optValue(f.tokens_wasted, f.est_value_usd, mode);
        const benefit = (f.tokens_wasted || f.est_value_usd)
            ? (mode === 'api' && f.est_value_usd != null
                ? `Saves ≈${this._optFmtUsd(f.est_value_usd)} of the observed window (estimate). `
                : `Gets back ~${this._optFmtTok(f.tokens_wasted)} tokens in the observed window. `)
            : '';
        const rec = f.recommendation || {};
        return benefit + (rec.change || '')
            + (rec.how ? ' How: ' + rec.how : '')
            + (rec.risk ? ' Risk: ' + rec.risk : '');
    },

    // ---------------- receipts ----------------

    _optReceipts(host, rep, mode, which) {
        const rec = rep.receipts || {};
        const resolved = rec.resolved || [];
        const pending = rec.pending || [];
        const sec = document.createElement('div');
        sec.className = 'svo-sec';

        if (which === 'resolved') {
            if (!resolved.length) return;
            const h = document.createElement('div');
            h.className = 'svo-sec-h';
            h.textContent = 'Proof: measured impact';
            sec.appendChild(h);
            resolved.forEach(r => {
                const label = this._OPT_TYPE_LABELS[r.type] || r.type;
                const pred = r.predicted;
                const q = (r.quality_before && r.quality_after)
                    ? { b: r.quality_before, a: r.quality_after } : null;
                const pct = (v) => v == null ? '–' : (v * 100).toFixed(1) + '%';
                const card = document.createElement('div');
                card.className = 'svo-proof';
                card.innerHTML =
                    '<div class="svo-proof-head">' +
                    '<span class="svo-eyebrow">Proof · measured, not modeled</span>' +
                    '<span class="svo-tag svo-tag-measured" title="Measured from real same-harness sessions across comparable windows. Never an estimate.">measured</span>' +
                    '</div>' +
                    '<div class="svo-proof-headline">' +
                    `<span class="svo-proof-big">${this._optMetricFmt(r.metric, r.before)} <span class="svo-proof-arrow">→</span> <b>${this._optMetricFmt(r.metric, r.after)}</b></span>` +
                    `<span class="svo-proof-what">${this._esc(this._optMetricLabel(r.metric))} · ${label} resolved</span>` +
                    '</div>' +
                    '<div class="svo-proof-grid">' +
                    (pred && (pred.tokens || pred.est_value_usd)
                        ? '<div class="svo-proof-cell"><div class="svo-proof-k">Predicted</div>' +
                          `<div class="svo-proof-v">~${this._optFmtTok(pred.tokens)} tok back` +
                          (pred.est_value_usd ? ` <i>≈$${pred.est_value_usd} est</i>` : '') + '</div>' +
                          '<div class="svo-proof-s">frozen when the finding first appeared</div></div>'
                        : '') +
                    '<div class="svo-proof-cell"><div class="svo-proof-k">Measured</div>' +
                    `<div class="svo-proof-v">${this._optMetricFmt(r.metric, r.before)} → ${this._optMetricFmt(r.metric, r.after)}</div>` +
                    `<div class="svo-proof-s">${r.before_sessions} sessions before · ${r.after_sessions} after, like-for-like</div></div>` +
                    (q
                        ? '<div class="svo-proof-cell"><div class="svo-proof-k">Output quality</div>' +
                          `<div class="svo-proof-v">output ${this._optFmtTok(q.b.output_avg)} → ${this._optFmtTok(q.a.output_avg)}</div>` +
                          `<div class="svo-proof-s">tool errors ${pct(q.b.tool_error_rate)} → ${pct(q.a.tool_error_rate)} · turns ${q.b.turns_avg ?? '–'} → ${q.a.turns_avg ?? '–'} · truncated ${pct(q.b.max_tokens_share)} → ${pct(q.a.max_tokens_share)}</div></div>`
                        : '') +
                    '</div>' +
                    '<div class="svo-proof-foot"><span>Medians across real same-harness sessions in comparable windows. Failed tool calls, session length and truncated answers rise when an optimization hurts the work; semantic quality is not judged and no model is involved. Token movement is fact; dollar readings stay estimates.</span>' +
                    '<a class="svo-view svo-share-receipt" role="button" tabindex="0">Share as image</a></div>';
                card.querySelector('.svo-share-receipt').addEventListener('click',
                    (ev) => this._optShareCard(ev.currentTarget, rep, mode, r));
                sec.appendChild(card);
            });
            host.appendChild(sec);
            return;
        }

        // pending: the comparisons we refuse to show, each with its reason
        if (!pending.length) return;
        const h = document.createElement('div');
        h.className = 'svo-sec-h';
        h.textContent = 'Receipts in waiting';
        sec.appendChild(h);
        // every non-resolution is explained, never silently absent, but the
        // waiting list reads as one sentence, not a wall of raw counters
        const name = (p) => this._OPT_TYPE_LABELS[p.type] || p.type;
        const insuff = pending.filter(p => p.status === 'insufficient');
        if (insuff.length) {
            const row = document.createElement('div');
            row.className = 'svo-pending';
            const need = insuff[0].needed_sessions;
            row.textContent = 'A before/after is only shown once it is measured: ' +
                `${need} comparable sessions on each side. Still collecting for ` +
                insuff.map(name).join(', ').toLowerCase() + '.';
            sec.appendChild(row);
        }
        pending.filter(p => p.status !== 'insufficient').forEach(p => {
            const row = document.createElement('div');
            row.className = 'svo-pending';
            row.textContent = p.status === 'reopened'
                ? `${name(p)}: previously resolved but the metric regressed; reopened with its history intact.`
                : `${name(p)}: ${p.reason}`;
            sec.appendChild(row);
        });
        host.appendChild(sec);
    },

    _optMetricLabel(m) {
        return { cache_hit_rate: 'cache hit rate', avg_prompt_slope: 'prompt growth' }[m] || m;
    },

    _optMetricFmt(m, v) {
        if (v == null) return '–';
        if (m === 'cache_hit_rate') return Math.round(v * 100) + '%';
        return this._optFmtTok(v);
    },

    // ---------------- footnotes + footer ----------------

    _optFootnotes(host, rep) {
        const notes = rep.capability_notes || [];
        if (!notes.length) return;
        const div = document.createElement('div');
        div.className = 'svo-note';
        div.textContent = notes.map(n =>
            `${n.harness}: ${n.reason}`).join(' ');
        host.appendChild(div);
    },

    /** One quiet card for everything meta: what was scanned, where the
     *  detectors abstain, and which measured receipts are still collecting.
     *  Replaces the loose lines of text that used to trail the page. */
    _optFooter(host, rep) {
        const name = (t) => this._OPT_TYPE_LABELS[t] || t;
        const rows = [];
        rows.push(['Scope',
            `Scanned ${(rep.scanned && rep.scanned.claude_code) || 0} Claude Code and ${(rep.scanned && rep.scanned.codex) || 0} Codex sessions` +
            ((rep.scanned && rep.scanned.claude_code_subagents) ? ` plus ${rep.scanned.claude_code_subagents} subagent streams` : '') +
            `, last ${rep.window_days} days` +
            ((rep.scanned && rep.scanned.sessions_capped) ? ', capped at ' + rep.scanned.caps.max_sessions_per_harness + ' per harness (disclosed, never silent)' : '') +
            '. Analysis runs locally and works offline.']);
        const notes = rep.capability_notes || [];
        if (notes.length) {
            rows.push(['Limits', notes.map(n => `${n.harness}: ${n.reason}`).join(' ')]);
        }

        const foot = document.createElement('div');
        foot.className = 'svo-about';
        foot.innerHTML =
            '<div class="svo-about-head"><span class="svo-about-t">About this scan</span>' +
            '<span class="svo-foot-btns">' +
            (rep.generated_at ? `<span class="svo-scan-age" title="Findings and totals are a snapshot from this scan. Sessions and turns after it are not counted until you rescan.">scanned ${this._esc(this._optAgo(rep.generated_at) || 'just now')}</span>` : '') +
            '<button type="button" class="btn btn-secondary btn-sm svo-rescan">Rescan</button>' +
            '<button type="button" class="btn btn-secondary btn-sm svo-del">Delete report</button></span></div>' +
            rows.map(([k, v]) =>
                `<div class="svo-about-row"><span class="svo-about-k">${k}</span><span>${this._esc(v)}</span></div>`
            ).join('');
        foot.querySelector('.svo-rescan').addEventListener('click', async () => {
            try {
                this._optShowAllFindings = false; // a fresh scan restarts at the top slice
                this._optTypeFilter = null;
                await API.runOptimizer({ window_days: rep.window_days || this._optWindow });
                await this._loadAndRenderOptimizer();
            } catch (e) { if (window.Toast) Toast.error('Could not start the scan: ' + e.message); }
        });
        foot.querySelector('.svo-del').addEventListener('click', async () => {
            try {
                await API.deleteOptimizerReport();
                await this._loadAndRenderOptimizer();
            } catch (e) { if (window.Toast) Toast.error('Could not delete: ' + e.message); }
        });
        host.appendChild(foot);
    },

    // ---------------- share card (PNG, local only) ----------------

    /** One-click export of the comparison strip (or a measured receipt) as an
     *  image. Aggregate numbers only: window, buckets, deltas, app version.
     *  The estimate/measured label is baked into the pixels so the honesty
     *  caveat travels with the screenshot. No session identifiers, no prompt
     *  text, no paths, no hostnames. PNG to clipboard or file, no social
     *  integrations, no cloud round-trip. */
    async _optShareCard(btn, rep, mode, receipt) {
        try { await (document.fonts && document.fonts.ready); } catch (_) { /* draw anyway */ }
        const W = 1200, H = 630;
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const ctx = cv.getContext('2d');
        const TEAL = '#5eadb8';
        const mono = (px) => `${px}px 'Space Mono', monospace`;
        const disp = (px, w) => `${w || 700} ${px}px 'Space Grotesk', sans-serif`;

        ctx.fillStyle = '#0e1218';
        ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = 'rgba(94,173,184,0.45)';
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, W - 2, H - 2);
        ctx.fillStyle = TEAL;
        ctx.fillRect(0, 0, 6, H);

        ctx.fillStyle = TEAL;
        ctx.font = disp(20, 700);
        ctx.fillText('SECUREVECTOR', 60, 72);
        ctx.fillStyle = '#aeb7c2';
        ctx.font = disp(20, 500);
        ctx.fillText('Cost / Token Optimizer', 260, 72);
        ctx.fillStyle = '#7f8a97';
        ctx.font = mono(16);
        ctx.fillText(`last ${rep.window_days} days · local-first analysis`, 60, 104);

        if (receipt) {
            ctx.fillStyle = '#eef2f7';
            ctx.font = disp(34, 700);
            ctx.fillText((this._OPT_TYPE_LABELS[receipt.type] || receipt.type) + ': resolved', 60, 200);
            ctx.font = mono(64);
            ctx.fillStyle = TEAL;
            ctx.fillText(
                `${this._optMetricLabel(receipt.metric)} ${this._optMetricFmt(receipt.metric, receipt.before)} → ${this._optMetricFmt(receipt.metric, receipt.after)}`,
                60, 300);
            ctx.fillStyle = '#aeb7c2';
            ctx.font = mono(20);
            ctx.fillText(`measured across ${receipt.before_sessions} sessions before and ${receipt.after_sessions} after`, 60, 350);
            ctx.fillStyle = '#0e1218';
            const tag = 'MEASURED · LIKE-FOR-LIKE WINDOWS, REAL SESSIONS';
            ctx.font = disp(16, 700);
            const tw = ctx.measureText(tag).width;
            ctx.fillStyle = TEAL;
            ctx.fillRect(60, 400, tw + 32, 36);
            ctx.fillStyle = '#0e1218';
            ctx.fillText(tag, 76, 424);
        } else {
            const obs = rep.observed || {}, mod = rep.modeled_lossless || rep.modeled || {}, b = rep.buckets || {};
            const from = this._optValue(obs.total_tokens, obs.est_cost_usd, mode);
            const to = this._optValue(mod.total_tokens, mod.est_cost_usd, mode);
            ctx.fillStyle = '#eef2f7';
            ctx.font = mono(72);
            ctx.fillText(from.lead, 60, 240);
            const w1 = ctx.measureText(from.lead).width;
            ctx.fillStyle = '#7f8a97';
            ctx.fillText(' → ', 60 + w1, 240);
            const w2 = ctx.measureText(' → ').width;
            ctx.fillStyle = TEAL;
            ctx.fillText(to.lead, 60 + w1 + w2, 240);
            ctx.fillStyle = '#aeb7c2';
            ctx.font = disp(24, 500);
            ctx.fillText(mode === 'subscription'
                ? 'observed usage, and what it models to with lossless fixes only'
                : 'observed window, and its modeled figure with lossless fixes only', 60, 288);

            const split = this._optBucketSplit(rep);
            const total = obs.total_tokens || 1;
            let y = 370;
            [['Trim tool results', split.trim], ['Prompt caching', b.cache], ['Session length', split.sess]].forEach(([label, bucket]) => {
                if (!bucket || !bucket.tokens) return;
                const pct = Math.min(100, Math.round((bucket.tokens / total) * 100));
                ctx.fillStyle = '#aeb7c2';
                ctx.font = disp(20, 500);
                ctx.fillText(label, 60, y);
                ctx.fillStyle = 'rgba(94,173,184,0.18)';
                ctx.fillRect(340, y - 16, 430, 18);
                ctx.fillStyle = TEAL;
                ctx.fillRect(340, y - 16, Math.max(430 * pct / 100, bucket.tokens ? 8 : 0), 18);
                ctx.fillStyle = '#eef2f7';
                ctx.font = mono(18);
                const bv = this._optValue(bucket.tokens, bucket.est_value_usd, mode);
                const bvText = `${bv.lead}${bv.sub ? ' · ' + bv.sub : ''} · ${pct}%`;
                ctx.fillText(bvText, W - 60 - ctx.measureText(bvText).width, y);
                y += 52;
            });

            const tag = 'MODELED ESTIMATE · LIST-PRICE TOKENS, NOT AN INVOICE';
            ctx.font = disp(16, 700);
            const tw = ctx.measureText(tag).width;
            ctx.fillStyle = TEAL;
            ctx.fillRect(60, 500, tw + 32, 36);
            ctx.fillStyle = '#0e1218';
            ctx.fillText(tag, 76, 524);
        }

        ctx.fillStyle = '#7f8a97';
        ctx.font = mono(16);
        ctx.fillText(`SecureVector ${rep.app_version ? 'v' + rep.app_version : ''} · securevector.io`, 60, H - 42);

        const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
        if (!blob) { if (window.Toast) Toast.error('Could not render the image.'); return; }
        // Clipboard first (feature-detected), file download as the fallback.
        if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
            try {
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                if (window.Toast) Toast.success('Image copied to clipboard.');
                return;
            } catch (_) { /* fall through to download */ }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = receipt ? 'securevector-optimizer-receipt.png' : 'securevector-optimizer.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        if (window.Toast) Toast.success('Image downloaded.');
    },

    _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g,
            c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },

    _optInjectStyle() {
        if (document.getElementById('sv-optimizer-style')) return;
        const st = document.createElement('style');
        st.id = 'sv-optimizer-style';
        st.textContent = `
#sv-optimizer { display: flex; flex-direction: column; gap: 12px; }
.svo-hero { background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 12px; padding: 28px; position: relative; }
.svo-eyebrow { font-size: 10px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: var(--accent-primary, #5eadb8); }
.svo-h { font-family: var(--font-display, inherit); font-size: 24px; margin: 10px 0 8px; color: var(--text-primary); }
.svo-p { color: var(--text-secondary); font-size: 14px; line-height: 1.55; max-width: 720px; }
.svo-points { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin: 16px 0; }
.svo-point { background: var(--bg-secondary); border: 1px solid var(--border-default); border-radius: 8px; padding: 12px 14px; font-size: 13px; }
.svo-point b { display: block; color: var(--text-primary); margin-bottom: 4px; }
.svo-point span { color: var(--text-muted); line-height: 1.45; }
.svo-consent { border-left: 3px solid var(--accent-primary, #5eadb8); background: var(--bg-secondary); border-radius: 0 8px 8px 0; padding: 14px 18px; margin: 14px 0; }
.svo-consent-t { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-secondary); margin-bottom: 8px; }
.svo-consent ul { margin: 0; padding-left: 18px; color: var(--text-secondary); font-size: 13px; line-height: 1.7; }
.svo-actions { display: flex; align-items: center; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
.svo-winbtn { background: var(--bg-secondary); border: 1px solid var(--border-default); color: var(--text-secondary); border-radius: 9999px; padding: 5px 14px; font-size: 12px; cursor: pointer; }
.svo-winbtn.on { border-color: var(--accent-primary, #5eadb8); color: var(--accent-primary, #5eadb8); }
.svo-go { margin-left: auto; }
.svo-err { color: var(--error, #ef4444); font-size: 13px; margin-top: 10px; }
.svo-prog { height: 8px; border-radius: 9999px; background: var(--bg-secondary); overflow: hidden; margin: 18px 0 10px; }
.svo-prog-fill { height: 100%; background: var(--accent-primary, #5eadb8); transition: width 300ms ease; }
.svo-strip { background: var(--bg-card); border: 2px solid color-mix(in srgb, var(--accent-primary, #5eadb8) 35%, transparent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent-primary, #5eadb8) 6%, transparent); border-radius: 12px; padding: 20px 24px; }
.svo-strip-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.svo-strip-label { font-size: 10px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; color: var(--text-muted); border: 1px solid var(--border-light); border-radius: 9999px; padding: 2px 10px; cursor: help; }
.svo-strip-row { display: flex; align-items: center; gap: 22px; flex-wrap: wrap; }
.svo-strip-cell { min-width: 150px; }
.svo-strip-v { font-family: var(--font-mono, monospace); font-size: 30px; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.svo-strip-v.svo-accent { color: var(--accent-primary, #5eadb8); }
.svo-strip-l { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
.svo-strip-arrow { font-size: 26px; color: var(--text-muted); }
.svo-strip-save { margin-left: auto; text-align: right; }
.svo-buckets { margin-top: 18px; display: flex; flex-direction: column; gap: 8px; }
.svo-bucket { display: flex; align-items: center; gap: 12px; font-size: 13px; }
.svo-bucket-l { width: 250px; flex-shrink: 0; color: var(--text-secondary); }
.svo-bucket-cap { display: block; font-size: 11px; color: var(--text-muted); line-height: 1.35; margin-top: 2px; }
.svo-bucket-bar { flex: 1; height: 8px; border-radius: 9999px; background: var(--bg-secondary); overflow: hidden; }
.svo-bucket-bar span { display: block; height: 100%; background: var(--accent-primary, #5eadb8); }
.svo-bucket-v { font-family: var(--font-mono, monospace); color: var(--text-secondary); white-space: nowrap; }
.svo-strip-foot { display: flex; justify-content: space-between; align-items: center; gap: 14px; margin-top: 12px; font-size: 12px; color: var(--text-muted); flex-wrap: wrap; }
.svo-strip-why { background: none; border: none; padding: 0; font: inherit; color: var(--text-muted); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.svo-strip-why:hover { color: var(--text-secondary); }
.svo-strip-more { margin-top: 10px; border-top: 1px solid var(--border-default); padding-top: 10px; }
.svo-strip-caveat { font-size: 11px; color: var(--text-muted); line-height: 1.55; margin-top: 8px; }
.svo-ask { background: var(--bg-card); border-left: 3px solid var(--accent-primary, #5eadb8); border-radius: 0 10px 10px 0; padding: 16px 20px; }
.svo-ask-t { font-weight: 600; color: var(--text-primary); font-size: 14px; }
.svo-ask-p { color: var(--text-secondary); font-size: 13px; line-height: 1.5; margin: 6px 0 12px; max-width: 680px; }
.svo-ask-btns { display: flex; gap: 8px; }
.svo-sec { display: flex; flex-direction: column; gap: 10px; }
.svc-card { background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 12px; padding: 16px 20px; margin-bottom: 14px; }
.svc-card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.svc-card-title { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-secondary); }
.svc-card-foot { font-size: 11px; color: var(--text-muted); margin-top: 10px; line-height: 1.5; }
.svc-pill { font-size: 10px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; color: var(--text-muted); border: 1px solid var(--border-light); border-radius: 9999px; padding: 2px 10px; cursor: help; }
.svc-strip { background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 12px; padding: 18px 22px; margin-bottom: 14px; }
.svc-strip-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.svc-strip-row { display: flex; gap: 28px; flex-wrap: wrap; }
.svc-cell { min-width: 130px; }
.svc-v { font-family: var(--font-mono, monospace); font-size: 26px; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.svc-arrow { color: var(--text-muted); font-weight: 400; }
.svc-l { font-size: 11.5px; color: var(--text-muted); margin-top: 2px; }
.svc-rt-grid { display: grid; grid-template-columns: minmax(110px, 1.3fr) repeat(5, minmax(76px, 1fr)) minmax(120px, 1.1fr); gap: 8px; align-items: center; padding: 7px 0; border-top: 1px solid var(--border-default); font-size: 12.5px; color: var(--text-secondary); }
.svc-rt-head { border-top: none; padding-top: 0; font-size: 10px; font-weight: 700; letter-spacing: 0.7px; text-transform: uppercase; color: var(--text-muted); }
.svc-rt-name { display: flex; align-items: center; gap: 8px; color: var(--text-primary); font-weight: 600; }
.svc-rt-name i { width: 8px; height: 8px; border-radius: 50%; background: #8b949e; flex-shrink: 0; }
.svc-rt-last { font-size: 11px; color: var(--text-muted); }
.svc-mono { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; }
@media (max-width: 900px) { .svc-rt-grid { grid-template-columns: minmax(100px, 1.2fr) repeat(3, 1fr); } .svc-rt-grid span:nth-child(4), .svc-rt-grid span:nth-child(5), .svc-rt-grid span:nth-child(7) { display: none; } }
.svo-typebar { display: flex; gap: 8px; flex-wrap: wrap; }
.svo-typechip { display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
  background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 10px;
  padding: 7px 12px; cursor: pointer; text-align: left; }
.svo-typechip b { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.svo-typechip span { font-size: 10.5px; color: var(--text-muted); font-family: var(--font-mono, monospace); }
.svo-typechip.on { border-color: var(--accent-primary, #5eadb8);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-primary, #5eadb8) 8%, transparent); }
.svo-typechip.on b { color: var(--accent-primary, #5eadb8); }
.svo-sec-h { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-secondary); padding-top: 6px; }
.svo-sec-toggle { display: flex; justify-content: space-between; align-items: center; width: 100%;
  background: none; border: none; cursor: pointer; text-align: left; padding: 6px 0 0; }
.svo-sec-toggle:hover .svo-sec-chev { color: var(--accent-primary); }
.svo-sec-chev { font-size: 11px; font-weight: 600; text-transform: none; letter-spacing: 0;
  color: var(--text-muted); }
/* session cards: live first, why-it-cost + what-to-change per session */
.svo-sess-card { background: var(--bg-card); border: 1px solid var(--border-default);
  border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
.svo-sess-card.live { border-color: color-mix(in srgb, var(--accent-primary) 55%, transparent); }
.svo-sess-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.svo-sess-name { font-weight: 600; font-size: 13px; color: var(--text-primary); }
.svo-sess-h { font-family: var(--font-mono, monospace); font-size: 11px; color: var(--text-muted); }
.svo-live-badge { font-size: 10px; font-weight: 700; letter-spacing: 1px; color: var(--accent-primary);
  border: 1px solid color-mix(in srgb, var(--accent-primary) 60%, transparent);
  border-radius: 999px; padding: 2px 9px; animation: svo-live-pulse 2.2s ease-in-out infinite; }
@keyframes svo-live-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
@media (prefers-reduced-motion: reduce) { .svo-live-badge { animation: none; } }
.svo-stale-badge { font-size: 11px; color: var(--text-muted); }
.svo-sess-spacer { flex: 1; }
.svo-sess-toggle { background: none; border: 1px solid var(--border-default); border-radius: 8px;
  color: var(--text-secondary); font-size: 11px; padding: 3px 10px; cursor: pointer; }
.svo-sess-toggle:hover { border-color: var(--accent-primary); }
.svo-sess-facts { display: flex; gap: 14px; flex-wrap: wrap; }
.svo-sess-fact { font-family: var(--font-mono, monospace); font-size: 11.5px; color: var(--text-secondary); }
.svo-sess-waste { color: var(--text-primary); font-weight: 700; }
.svo-accent-t { color: var(--accent-primary); font-weight: 700; }
.svo-sess-why { display: flex; flex-direction: column; gap: 6px; }
.svo-sess-act { background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-primary) 35%, transparent);
  border-radius: 8px; padding: 8px 10px; display: flex; gap: 8px; align-items: baseline; }
.svo-sess-cause { display: grid; grid-template-columns: 150px minmax(60px, 220px) auto;
  gap: 2px 12px; padding: 6px 2px; align-items: baseline; }
.svo-sess-cause-n { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.svo-sess-cause-v { font-family: var(--font-mono, monospace); font-size: 11.5px; color: var(--text-secondary); }
.svo-sess-cause-r { grid-column: 1 / -1; font-size: 11.5px; color: var(--text-muted); line-height: 1.45; }
.svo-sess-hint { font-size: 11px; color: var(--text-muted); }
.svo-spent-tag { font-size: 9.5px; font-weight: 700; letter-spacing: 0.4px; margin-left: 8px;
  padding: 1px 6px; border-radius: 999px; background: var(--bg-secondary);
  color: var(--text-muted); border: 1px dashed var(--border-default); white-space: nowrap;
  text-transform: none; cursor: help; vertical-align: middle; }
.svo-scan-age { font-size: 11px; color: var(--text-muted); align-self: center;
  margin-right: 10px; cursor: help; font-family: var(--font-mono, monospace); }
.svo-trim-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.svo-sess-finds { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--border-default); padding-top: 8px; }
.svo-sess-find { display: flex; gap: 10px; align-items: baseline; font-size: 11.5px; }
.svo-sess-find-ev { flex: 1; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.svo-sess-find-more { font-size: 11px; color: var(--text-muted); padding-top: 2px; }
.svo-sess-list { background: var(--bg-card); border: 1px solid var(--border-default);
  border-radius: 12px; overflow: hidden; }
.svo-sess-rowwrap + .svo-sess-rowwrap { border-top: 1px solid var(--border-default); }
.svo-sess-row { display: grid; width: 100%;
  grid-template-columns: 18px 72px 84px 92px 96px 1fr auto auto;
  gap: 10px; align-items: center; padding: 7px 14px;
  background: none; border: none; cursor: pointer; text-align: left;
  color: var(--text-primary); }
.svo-sess-row > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.svo-sess-row-num { font-size: 11.5px; font-weight: 700; letter-spacing: 0.2px;
  color: var(--text-primary); }
.svo-live-badge, .svo-sess-row-when { justify-self: start; }
.svo-sess-row:hover { background: var(--bg-secondary); }
.svo-sess-row-id { font-family: var(--font-mono, monospace); font-size: 12px; font-weight: 700;
  color: var(--text-primary); }
.svo-sess-row-h, .svo-sess-row-when, .svo-sess-row-turns { font-size: 11px; color: var(--text-muted); }
.svo-sess-row-waste { font-family: var(--font-mono, monospace); font-size: 11px; font-weight: 700;
  color: var(--text-secondary); justify-self: end; white-space: nowrap; }
.svo-sess-row-hist { font-family: var(--font-mono, monospace); font-size: 11px;
  color: var(--text-muted); justify-self: end; white-space: nowrap; }
.svo-sess-row-chev { display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border-radius: 6px; color: var(--text-muted);
  justify-self: start; transition: transform 0.18s ease, color 0.18s ease; }
.svo-sess-row:hover .svo-sess-row-chev { color: var(--text-primary); }
.svo-sess-row[aria-expanded="true"] .svo-sess-row-chev { transform: rotate(90deg); color: var(--accent-primary); }
.svo-sess-rowwrap.open { background: color-mix(in srgb, var(--bg-secondary) 45%, transparent); }
@media (prefers-reduced-motion: reduce) { .svo-sess-row-chev { transition: none; } }
.svo-sess-panel { padding: 2px 14px 10px; }
.svo-sess-part { font-size: 10px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase;
  color: var(--text-muted); padding: 6px 0 2px; }
.svo-sess-h { display: flex; align-items: center; gap: 8px; }
.svo-chip { font-size: 10px; font-weight: 700; letter-spacing: 0.4px; text-transform: none;
  padding: 1px 8px; border-radius: 999px; background: var(--bg-secondary);
  color: var(--text-secondary); border: 1px solid var(--border-default); }
.svo-chip-live { color: var(--accent-primary);
  border-color: color-mix(in srgb, var(--accent-primary) 45%, transparent);
  background: color-mix(in srgb, var(--accent-primary) 10%, transparent); }
.svo-sess-note { font-size: 10.5px; color: var(--text-muted); line-height: 1.5;
  margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--border-default); }
.svo-sess-rec-c { display: block; font-weight: 600; color: var(--text-primary); }
.svo-sess-rec-kv { display: block; font-size: 11.5px; color: var(--text-muted); line-height: 1.5; }
.svo-sess-rec-kv b { color: var(--text-secondary); font-weight: 700; font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.5px; margin-right: 6px; }
.svo-bucket-tag { font-size: 9.5px; font-weight: 700; letter-spacing: 0.4px; margin-left: 8px;
  padding: 1px 6px; border-radius: 999px; background: var(--bg-secondary);
  color: var(--text-muted); border: 1px solid var(--border-default); white-space: nowrap; }
.svo-bucket-tag.warn { color: var(--text-secondary); border-style: dashed; }
.svo-strip-note { font-size: 11px; color: var(--text-secondary); line-height: 1.55;
  padding: 8px 10px; border-radius: 8px; background: var(--bg-secondary); margin-top: 4px; }
.svo-trim { background: var(--bg-card); border: 1px solid var(--border-default);
  border-radius: 12px; padding: 14px 18px; margin-top: 14px; }
.svo-trim-p { font-size: 11px; color: var(--text-muted); line-height: 1.55; margin: 6px 0 10px; }
.svo-trim-rows { display: flex; flex-direction: column; }
.svo-trim-row { display: grid; align-items: center; gap: 10px; padding: 6px 0;
  grid-template-columns: minmax(80px, 130px) 64px minmax(180px, 1fr) auto minmax(90px, 150px) auto;
  border-top: 1px solid var(--border-default); }
.svo-trim-row > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.svo-trim-tool { font-family: var(--font-mono, monospace); font-size: 12px; font-weight: 700;
  color: var(--text-primary); }
.svo-trim-n, .svo-trim-turns { font-size: 11px; color: var(--text-muted); }
.svo-trim-ba { font-size: 11.5px; color: var(--text-secondary); }
.svo-trim-arrow { color: var(--accent-primary); }
.svo-trim-v { font-family: var(--font-mono, monospace); font-size: 11px; font-weight: 700;
  color: var(--text-secondary); justify-self: end; }
.svo-trim-more { font-size: 10.5px; color: var(--text-muted); padding-top: 8px; }
.svo-play-rows { display: flex; flex-direction: column; }
.svo-play-row { display: grid; grid-template-columns: minmax(170px, 220px) 1fr auto;
  gap: 12px; align-items: baseline; padding: 8px 0; border-top: 1px solid var(--border-default); }
.svo-play-n { font-size: 12.5px; font-weight: 600; color: var(--text-primary); }
.svo-play-w { font-size: 11.5px; color: var(--text-muted); line-height: 1.5; }
.svo-play-chip { font-size: 10px; font-weight: 700; letter-spacing: 0.3px; white-space: nowrap;
  padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border-default);
  color: var(--text-secondary); background: var(--bg-secondary); justify-self: end; cursor: help;
  font-family: var(--font-mono, monospace); }
.svo-play-chip.hit { border-style: dashed; color: var(--text-primary); }
.svo-play-chip.ok { color: var(--accent-primary, #5eadb8);
  border-color: color-mix(in srgb, var(--accent-primary) 40%, transparent); }
.svo-play-chip.na { color: var(--text-muted); }
@media (max-width: 900px) { .svo-play-row { grid-template-columns: 1fr auto; }
  .svo-play-w { display: none; } }
@media (max-width: 900px) { .svo-trim-row { grid-template-columns: minmax(80px, 130px) 1fr auto; }
  .svo-trim-n, .svo-trim-turns, .svo-trim-row .svo-bucket-bar { display: none; } }
.svo-sess-cause-bar { display: inline-block; height: 5px; border-radius: 3px;
  background: var(--bg-secondary); overflow: hidden; align-self: center; }
.svo-sess-cause-bar span { display: block; height: 100%; border-radius: 3px;
  background: var(--accent-primary); opacity: 0.75; }
.svo-sess-rec { font-size: 12px; color: var(--text-secondary); line-height: 1.5;
  padding: 3px 0 3px 14px; position: relative; }
.svo-sess-rec::before { content: ''; position: absolute; left: 0; top: 10px;
  width: 6px; height: 6px; border-radius: 50%; background: var(--accent-primary); opacity: 0.8; }
@media (max-width: 1180px) { .svo-sess-row-hist { display: none; } }
@media (max-width: 900px) { .svo-sess-row { grid-template-columns: 18px 72px 1fr auto auto; }
  .svo-sess-row-h, .svo-sess-row-turns, .svo-sess-row-ctx { display: none; } }
.svo-sess-more { width: 100%; background: none; border: none;
  border-top: 1px solid var(--border-default); color: var(--text-secondary);
  font-size: 11.5px; padding: 9px; cursor: pointer; }
.svo-sess-more:hover { color: var(--accent-primary); }
.svo-find { background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 10px; padding: 14px 18px; }
.svo-find-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.svo-find-type { font-weight: 600; color: var(--text-primary); font-size: 14px; }
.svo-conf { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; border-radius: 9999px; padding: 1px 8px; border: 1px solid var(--border-light); color: var(--text-muted); cursor: help; }
.svo-conf-high { border-color: color-mix(in srgb, var(--accent-primary, #5eadb8) 55%, transparent); color: var(--accent-primary, #5eadb8); }
.svo-tag { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; border-radius: 9999px; padding: 1px 8px; background: var(--bg-secondary); color: var(--text-muted); cursor: help; }
.svo-tag-measured { color: var(--accent-primary, #5eadb8); background: color-mix(in srgb, var(--accent-primary, #5eadb8) 10%, transparent); }
.svo-find-val { margin-left: auto; font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; color: var(--text-primary); font-size: 15px; font-weight: 700; cursor: help; }
.svo-find-val i { font-style: normal; font-weight: 400; color: var(--text-muted); font-size: 12px; }
.svo-find-ev { color: var(--text-secondary); font-size: 13px; line-height: 1.5; margin-top: 6px; }
.svo-find-meta { display: flex; align-items: center; gap: 12px; margin-top: 8px; font-size: 12px; color: var(--text-muted); flex-wrap: wrap; }
.svo-sess { font-family: var(--font-mono, monospace); }
.svo-view { color: var(--accent-primary, #5eadb8); cursor: pointer; text-decoration: none; }
.svo-view:hover { text-decoration: underline; }
.svo-cap { border: 1px dashed var(--border-light); border-radius: 9999px; padding: 1px 8px; cursor: help; }
.svo-rec { display: flex; gap: 10px; align-items: baseline; margin-top: 10px; border-top: 1px dashed var(--border-default); padding-top: 10px; }
.svo-rec-k { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: var(--accent-primary, #5eadb8); flex-shrink: 0; }
.svo-rec-t { color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
.svo-copyfix { margin-left: auto; flex-shrink: 0; align-self: center; background: none;
  border: 1px solid var(--border-default); border-radius: 6px; padding: 3px 9px;
  color: var(--accent-primary, #5eadb8); font-size: 11px; font-weight: 600;
  cursor: pointer; white-space: nowrap; }
.svo-copyfix:hover { border-color: var(--accent-primary, #5eadb8);
  background: color-mix(in srgb, var(--accent-primary) 8%, transparent); }
.svo-copyfix.on { color: var(--text-primary); border-style: dashed; }
.svo-copyfix:disabled { cursor: default; }
.svo-sess-rec .svo-copyfix { display: inline-block; margin-left: 0; margin-top: 4px; }
.svo-proof { background: var(--bg-card); border: 2px solid color-mix(in srgb, var(--accent-primary, #5eadb8) 55%, transparent);
  box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent-primary, #5eadb8) 8%, transparent);
  border-radius: 14px; padding: 20px 24px; }
.svo-proof-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.svo-proof-headline { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; }
.svo-proof-big { font-family: var(--font-mono, monospace); font-size: 34px; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.svo-proof-big b { color: var(--accent-primary, #5eadb8); font-weight: 700; }
.svo-proof-arrow { color: var(--text-muted); font-weight: 400; font-size: 26px; }
.svo-proof-what { font-size: 13px; color: var(--text-secondary); }
.svo-proof-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
.svo-proof-cell { background: var(--bg-secondary); border: 1px solid var(--border-default); border-radius: 10px; padding: 12px 14px; }
.svo-proof-k { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: var(--accent-primary, #5eadb8); margin-bottom: 5px; }
.svo-proof-v { font-family: var(--font-mono, monospace); font-size: 15px; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.svo-proof-v i { font-style: normal; font-weight: 400; color: var(--text-muted); font-size: 12px; }
.svo-proof-s { font-size: 11px; color: var(--text-muted); margin-top: 4px; line-height: 1.5; }
.svo-proof-foot { display: flex; justify-content: space-between; align-items: flex-end; gap: 14px; margin-top: 14px; font-size: 11px; color: var(--text-muted); line-height: 1.5; }
.svo-pending { color: var(--text-muted); font-size: 12px; padding: 4px 2px; }
.svo-ok { background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 10px; padding: 18px; color: var(--text-secondary); font-size: 13px; display: flex; align-items: center; gap: 18px; line-height: 1.5; }
.svo-note { color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.svo-foot { display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap; padding: 6px 2px 20px; }
.svo-about { background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 12px;
  padding: 12px 16px 14px; display: flex; flex-direction: column; gap: 7px; margin-bottom: 20px; }
.svo-about-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.svo-about-t { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px;
  color: var(--text-secondary); }
.svo-about-row { display: grid; grid-template-columns: 72px 1fr; gap: 10px;
  font-size: 11.5px; color: var(--text-muted); line-height: 1.55; }
.svo-about-k { font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
  color: var(--text-secondary); padding-top: 2px; }
.svo-foot-meta { color: var(--text-muted); font-size: 12px; max-width: 680px; }
.svo-foot-btns { display: flex; gap: 8px; }
.svo-liveband { border-color: color-mix(in srgb, var(--accent-primary) 35%, var(--border-light)); }
.svo-live-note { font-size: 10.5px; color: var(--text-muted); }
.svo-live-row { border-top: 1px solid var(--border-light); padding: 9px 0 2px; margin-top: 8px; }
.svo-live-top { display: flex; justify-content: space-between; gap: 10px;
  font-size: 12px; color: var(--text-primary); }
.svo-live-top b { font-weight: 600; }
.svo-live-top span { color: var(--text-muted); font-size: 11px; text-align: right; }
.svo-live-fill { height: 4px; border-radius: 2px; margin-top: 6px; overflow: hidden;
  background: color-mix(in srgb, var(--border-light) 60%, transparent); }
.svo-live-fill i { display: block; height: 100%; border-radius: 2px; background: var(--text-muted); }
.svo-live-item { display: flex; gap: 10px; align-items: center; justify-content: space-between;
  margin-top: 7px; font-size: 11.5px; color: var(--text-secondary); line-height: 1.45; }
.svo-top3-row span { color: var(--text-primary); }
.svo-spark { margin-top: 10px; color: var(--text-muted); }
.svo-spark svg { display: block; width: 100%; height: 42px; color: var(--text-muted); }
.svo-spark span { font-size: 10.5px; }
.svo-flash { outline: 1px solid var(--accent-primary); border-radius: 10px;
  transition: outline-color 600ms ease; }
`;
        document.head.appendChild(st);
    },

    destroy() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        if (this._optPoll) {
            clearTimeout(this._optPoll);
            this._optPoll = null;
        }
    },
};

window.CostsPage = CostsPage;
