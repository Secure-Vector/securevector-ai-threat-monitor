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
    activeTab: 'overview',
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

        if (this.mode === 'settings') {
            if (window.Header) Header.setPageInfo('Cost Settings', 'Set daily budgets and manage model pricing');
        } else {
            if (window.Header) Header.setPageInfo('Cost Tracking', 'Track LLM token spend per agent');
        }

        // Settings mode: budget card + pricing reference, no tab bar
        if (this.mode === 'settings') {
            await this._renderSettingsMode(container);
            return;
        }

        // Monitor mode: Cost Summary + Request History tabs only
        const tabs = document.createElement('div');
        tabs.className = 'tab-bar';
        tabs.id = 'costs-tabs';
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

    _renderTabBar() {
        const bar = document.getElementById('costs-tabs');
        if (!bar) return;
        bar.textContent = '';

        // Monitor mode only shows summary + history
        const defs = [
            { id: 'overview', label: 'Cost Summary' },
            { id: 'history', label: 'Request History' },
        ];

        defs.forEach(({ id, label }) => {
            const btn = document.createElement('button');
            const isActive = this.activeTab === id;
            if (isActive) localStorage.setItem('sv-tab-seen-costs-' + id, '1');
            btn.className = `tab-btn${isActive ? ' active' : ''}`;
            btn.textContent = label;
            btn.addEventListener('click', async () => {
                this.activeTab = id;
                this._renderTabBar();
                await this._renderActiveTab();
            });
            bar.appendChild(btn);
        });
    },

    async _renderActiveTab() {
        const content = document.getElementById('costs-tab-content');
        if (!content) return;
        content.textContent = '';

        if (this.activeTab === 'overview') await this._loadAndRenderOverview();
        else if (this.activeTab === 'history') await this._loadAndRenderHistory();
    },

    // ==================== Overview Tab (Summary only) ====================

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

            const chartContainer = document.createElement('div');
            chartContainer.id = 'sv-costs-chart';
            content.appendChild(chartContainer);
            await this._initCostChart(chartContainer);

            // Manual refresh button for chart only
            const refreshBtn = document.createElement('button');
            refreshBtn.style.cssText = 'display: block; margin: -8px 0 12px auto; background: none; border: 1px solid var(--border-default); border-radius: 6px; color: var(--text-secondary); cursor: pointer; padding: 3px 10px; font-size: 11px;';
            refreshBtn.textContent = '↻ Refresh chart';
            refreshBtn.addEventListener('click', async () => {
                refreshBtn.textContent = '↻ Refreshing…';
                refreshBtn.disabled = true;
                await this._loadAndRenderChart(chartContainer);
                refreshBtn.textContent = '↻ Refresh chart';
                refreshBtn.disabled = false;
            });
            content.appendChild(refreshBtn);

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
    },

    _updateBudgetBar() {
        const el = document.getElementById('sv-costs-budget-bar');
        if (!el) return;
        el.textContent = '';
        const budget = this.budgetData;
        if (!budget || !budget.budget_usd) return;

        const todaySpend = (this.summaryData && this.summaryData.totals && this.summaryData.totals.today_spend_usd) || 0;
        const pct = budget.budget_usd > 0 ? Math.min(todaySpend / budget.budget_usd, 1) : 0;
        const pctDisplay = Math.round(pct * 100);
        const isOver = todaySpend >= budget.budget_usd;
        const isWarn = pct >= 0.8;
        const barColor = isOver ? '#ef4444' : isWarn ? '#f59e0b' : '#10b981';

        const bar = document.createElement('div');
        bar.style.cssText = 'display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 8px; margin-bottom: 14px; font-size: 12px;';

        const label = document.createElement('span');
        label.style.cssText = 'color: var(--text-secondary); white-space: nowrap;';
        label.textContent = `Daily budget: $${todaySpend.toFixed(4)} / $${budget.budget_usd.toFixed(2)} (${pctDisplay}%)`;
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
        const cardsRow = document.createElement('div');
        cardsRow.className = 'stats-grid';
        const cardDefs = [
            { label: 'Today\'s Spend', value: `$${(totals.today_spend_usd || 0).toFixed(4)}`, sub: 'Resets at midnight' },
            { label: 'Monthly Cost', value: `$${(totals.monthly_cost_usd || 0).toFixed(4)}`, sub: 'This billing month' },
            { label: 'Total Requests', value: (totals.total_requests || 0).toLocaleString() },
            { label: 'Input Tokens', value: this._fmtTokens(totals.total_input_tokens || 0) },
            { label: 'Output Tokens', value: this._fmtTokens(totals.total_output_tokens || 0) },
        ];
        cardDefs.forEach(({ label, value, sub }) => {
            const card = document.createElement('div');
            card.className = 'stat-card';
            const val = document.createElement('div');
            val.className = 'stat-value';
            val.textContent = value;
            const lbl = document.createElement('div');
            lbl.className = 'stat-label';
            lbl.textContent = label;
            card.appendChild(val);
            card.appendChild(lbl);
            if (sub) {
                const subEl = document.createElement('div');
                subEl.style.cssText = 'font-size: 10px; color: var(--text-secondary); opacity: 0.7; margin-top: 2px;';
                subEl.textContent = sub;
                card.appendChild(subEl);
            }
            cardsRow.appendChild(card);
        });
        el.appendChild(cardsRow);
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
            warn.textContent = 'Some requests used models with unknown pricing — costs show as $0.00. Update rates in the Pricing Reference tab.';
            el.appendChild(warn);
        }

        const sectionTitle = document.createElement('h3');
        sectionTitle.style.cssText = 'margin: 1.5rem 0 0.75rem; font-size: 15px; color: var(--text-primary);';
        sectionTitle.textContent = 'Per-Agent Breakdown';
        el.appendChild(sectionTitle);

        if (agents.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            const icon = document.createElement('div'); icon.className = 'empty-icon'; icon.textContent = '💰';
            const t = document.createElement('div'); t.className = 'empty-title'; t.textContent = 'No cost data yet';
            const m = document.createElement('div'); m.className = 'empty-message'; m.textContent = 'Costs are recorded automatically as agents route requests through the SecureVector proxy.';
            empty.appendChild(icon); empty.appendChild(t); empty.appendChild(m);
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
                { key: 'last_seen', label: 'Last Seen', sortable: true, defaultDir: 'desc', render: v => v ? new Date(v).toLocaleString() : '\u2014' },
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
            icon.textContent = '📋';
            const t = document.createElement('div');
            t.className = 'empty-title';
            t.textContent = 'No records found';
            const m = document.createElement('div');
            m.className = 'empty-message';
            m.textContent = 'Request records appear here as agents use the proxy.';
            empty.appendChild(icon);
            empty.appendChild(t);
            empty.appendChild(m);
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
                    else c.textContent = v || '\u2014';
                    return c;
                }},
                { key: 'provider', label: 'Provider', sortable: true },
                { key: 'model_id', label: 'Model', sortable: true },
                { key: 'input_tokens', label: 'Input', sortable: true, render: v => (v || 0).toLocaleString() },
                { key: 'input_cached_tokens', label: 'Cached', sortable: true, render: (v, row) => {
                    if (!v || v <= 0) return '\u2014';
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
        agentEl.textContent = r.agent_id || '\u2014';
        metaGrid.appendChild(section('Agent ID', agentEl));
        metaGrid.appendChild(section('Provider', r.provider || '\u2014'));
        wrap.appendChild(metaGrid);
        const modelEl = document.createElement('code');
        modelEl.style.cssText = 'font-size: 13px; font-weight: 600; color: var(--text-primary);';
        modelEl.textContent = r.model_id || '\u2014';
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
        tokenGrid.appendChild(tokenCard('Cached', r.input_cached_tokens > 0 ? r.input_cached_tokens.toLocaleString() + ' (' + cachedPct + ')' : '\u2014', '#10b981'));
        tokenGrid.appendChild(tokenCard('Output', r.output_tokens.toLocaleString(), '#f59e0b'));
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
        infoText.textContent = 'Set daily USD spend limits to protect against runaway agent costs. The global limit is a wallet cap — it compares against your total spend across all agents today. Per-agent budgets compare only that agent\'s own spend and override the global limit. When exceeded, the proxy will warn (log + header) or block the request. Budgets reset at midnight UTC.';
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
        globalNote.textContent = 'Wallet cap — triggers when total spend across all agents exceeds this amount today. Use per-agent budgets below for per-agent limits.';
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
        editBtn.style.cssText = 'display: ' + (hasLimit ? 'inline-flex' : 'none') + '; align-items: center; gap: 5px; padding: 4px 14px; border-radius: var(--radius-full); font-size: 12px; font-weight: 600; border: none; background: linear-gradient(135deg, #5eadb8, #ef4444); color: #fff; cursor: pointer; transition: opacity 0.15s;';
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
            titleEl.textContent = `Daily Spend — ${this._chartState.rangeStart}  →  ${this._chartState.rangeEnd}`;
        } else {
            const d = new Date(this._chartState.year, this._chartState.month - 1, 1);
            titleEl.textContent = `Daily Spend — ${d.toLocaleString('default', { month: 'long', year: 'numeric' })}`;
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
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
        return n.toString();
    },

    destroy() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    },
};

window.CostsPage = CostsPage;
