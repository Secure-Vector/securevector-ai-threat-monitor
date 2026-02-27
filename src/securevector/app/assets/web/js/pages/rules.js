/**
 * Rules Page
 * Detection rules management with table view, pagination, and filters
 */

const RulesPage = {
    allRules: [],
    rules: [],
    expandedRows: new Set(),
    LOCAL_RULE_LIMIT: 100,
    bannerDismissed: false,
    rulesSelectedIds: new Set(),
    sortField: 'created_at',
    sortDir: 'desc',
    filters: {
        category: '',
        severity: '',
        enabled: '',
        page: 1,
        page_size: 15,
    },

    async render(container) {
        container.textContent = '';
        this.expandedRows.clear();
        this.rulesSelectedIds = new Set();

        // Filters bar
        const filtersBar = document.createElement('div');
        filtersBar.className = 'filters-bar';
        filtersBar.id = 'rules-filters';
        container.appendChild(filtersBar);

        // Content area
        const content = document.createElement('div');
        content.id = 'rules-content';
        container.appendChild(content);

        // Loading state
        const loading = document.createElement('div');
        loading.className = 'loading-container';
        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        loading.appendChild(spinner);
        content.appendChild(loading);

        try {
            const response = await API.getRules();
            this.allRules = response.items || [];
            this.applyFilters();
            this.buildFiltersBar();
            this.renderContent();
        } catch (error) {
            this.allRules = [];
            this.rules = [];
            this.buildFiltersBar();
            this.renderContent();
        }
    },

    buildFiltersBar() {
        const bar = document.getElementById('rules-filters');
        if (!bar) return;

        bar.textContent = '';

        // Category filter
        const categoryGroup = document.createElement('div');
        categoryGroup.className = 'filter-group';

        const categoryLabel = document.createElement('label');
        categoryLabel.textContent = 'Category';
        categoryGroup.appendChild(categoryLabel);

        const categorySelect = document.createElement('select');
        categorySelect.className = 'filter-select';
        categorySelect.id = 'rules-category-filter';

        const defaultCatOption = document.createElement('option');
        defaultCatOption.value = '';
        defaultCatOption.textContent = 'All Categories';
        categorySelect.appendChild(defaultCatOption);

        const uniqueCategories = this.getUniqueCategories();
        uniqueCategories.forEach(cat => {
            const option = document.createElement('option');
            option.value = cat;
            option.textContent = this.formatLabel(cat);
            if (cat === this.filters.category) {
                option.selected = true;
            }
            categorySelect.appendChild(option);
        });

        categorySelect.addEventListener('change', (e) => {
            this.filters.category = e.target.value;
            this.filters.page = 1;
            this.applyFilters();
            this.renderContent();
        });

        categoryGroup.appendChild(categorySelect);
        bar.appendChild(categoryGroup);

        // Severity filter
        const severityGroup = document.createElement('div');
        severityGroup.className = 'filter-group';

        const severityLabel = document.createElement('label');
        severityLabel.textContent = 'Severity';
        severityGroup.appendChild(severityLabel);

        const severitySelect = document.createElement('select');
        severitySelect.className = 'filter-select';
        severitySelect.id = 'rules-severity-filter';

        const defaultSevOption = document.createElement('option');
        defaultSevOption.value = '';
        defaultSevOption.textContent = 'All Severities';
        severitySelect.appendChild(defaultSevOption);

        const uniqueSeverities = this.getUniqueSeverities();
        uniqueSeverities.forEach(sev => {
            const option = document.createElement('option');
            option.value = sev;
            option.textContent = this.formatLabel(sev);
            if (sev === this.filters.severity) {
                option.selected = true;
            }
            severitySelect.appendChild(option);
        });

        severitySelect.addEventListener('change', (e) => {
            this.filters.severity = e.target.value;
            this.filters.page = 1;
            this.applyFilters();
            this.renderContent();
        });

        severityGroup.appendChild(severitySelect);
        bar.appendChild(severityGroup);

        // Status filter
        const enabledGroup = document.createElement('div');
        enabledGroup.className = 'filter-group';

        const enabledLabel = document.createElement('label');
        enabledLabel.textContent = 'Status';
        enabledGroup.appendChild(enabledLabel);

        const enabledSelect = document.createElement('select');
        enabledSelect.className = 'filter-select';

        const statusOptions = [
            { value: '', label: 'All' },
            { value: 'true', label: 'Enabled' },
            { value: 'false', label: 'Disabled' },
        ];

        statusOptions.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            if (opt.value === this.filters.enabled) {
                option.selected = true;
            }
            enabledSelect.appendChild(option);
        });

        enabledSelect.addEventListener('change', (e) => {
            this.filters.enabled = e.target.value;
            this.filters.page = 1;
            this.applyFilters();
            this.renderContent();
        });

        enabledGroup.appendChild(enabledSelect);
        bar.appendChild(enabledGroup);

        // Spacer to push Create Rule button to the right
        const spacer = document.createElement('div');
        spacer.style.cssText = 'flex: 1;';
        bar.appendChild(spacer);

        // Create Rule button
        const createBtn = document.createElement('button');
        createBtn.className = 'btn btn-primary';
        createBtn.textContent = '+ Create Rule';
        createBtn.addEventListener('click', () => this.showCreateRuleModal());
        bar.appendChild(createBtn);
    },

    getUniqueCategories() {
        const categories = new Set();
        this.allRules.forEach(rule => {
            if (rule.category) categories.add(rule.category);
        });
        return Array.from(categories).sort();
    },

    getUniqueSeverities() {
        const severities = new Set();
        this.allRules.forEach(rule => {
            if (rule.severity) severities.add(rule.severity);
        });
        return Array.from(severities).sort();
    },

    formatLabel(value) {
        if (!value) return 'Unknown';
        return value
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
    },

    applyFilters() {
        this.rules = this.allRules.filter(rule => {
            if (this.filters.category && rule.category !== this.filters.category) return false;
            if (this.filters.severity && rule.severity !== this.filters.severity) return false;
            if (this.filters.enabled !== '') {
                const filterEnabled = this.filters.enabled === 'true';
                if (rule.enabled !== filterEnabled) return false;
            }
            return true;
        });
        // Sort by current sort state
        const field = this.sortField;
        const dir = this.sortDir === 'asc' ? 1 : -1;
        this.rules.sort((a, b) => {
            let av, bv;
            if (field === 'created_at') {
                av = a.created_at ? new Date(a.created_at) : new Date(0);
                bv = b.created_at ? new Date(b.created_at) : new Date(0);
                return dir * (av - bv);
            } else if (field === 'patterns') {
                av = (a.patterns || []).length;
                bv = (b.patterns || []).length;
            } else if (field === 'enabled') {
                av = a.enabled ? 1 : 0;
                bv = b.enabled ? 1 : 0;
            } else if (field === 'severity') {
                const order = { critical: 4, high: 3, medium: 2, low: 1 };
                av = order[a.severity] || 0;
                bv = order[b.severity] || 0;
            } else {
                av = (a[field] || '').toLowerCase();
                bv = (b[field] || '').toLowerCase();
            }
            if (av < bv) return -1 * dir;
            if (av > bv) return 1 * dir;
            return 0;
        });
    },

    _isNewRule(rule) {
        if (!rule.created_at) return false;
        const added = new Date(rule.created_at);
        const now = new Date();
        return (now - added) < 30 * 24 * 60 * 60 * 1000; // within 30 days
    },

    _formatDate(isoStr) {
        if (!isoStr) return '—';
        const d = new Date(isoStr);
        if (isNaN(d)) return '—';
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    },

    getPaginatedRules() {
        const start = (this.filters.page - 1) * this.filters.page_size;
        const end = start + this.filters.page_size;
        return this.rules.slice(start, end);
    },

    getTotalPages() {
        return Math.ceil(this.rules.length / this.filters.page_size) || 1;
    },

    renderContent() {
        const container = document.getElementById('rules-content');
        if (!container) return;

        container.textContent = '';

        // Stats header
        const header = document.createElement('div');
        header.className = 'page-header';

        const stats = document.createElement('div');
        stats.className = 'rules-stats';

        const enabledCount = this.rules.filter(r => r.enabled).length;
        const totalFiltered = this.rules.length;
        const totalAll = this.allRules.length;

        const statText = document.createElement('span');
        if (totalAll === 0) {
            statText.textContent = 'No rules configured';
        } else if (totalFiltered === totalAll) {
            statText.textContent = enabledCount + ' of ' + totalFiltered + ' rules enabled';
        } else {
            statText.textContent = 'Showing ' + totalFiltered + ' of ' + totalAll + ' rules (' + enabledCount + ' enabled)';
        }
        stats.appendChild(statText);
        header.appendChild(stats);

        const deleteBtn = document.createElement('button');
        deleteBtn.id = 'rules-delete-selected-btn';
        deleteBtn.className = 'btn btn-danger';
        deleteBtn.style.display = 'none';
        deleteBtn.addEventListener('click', () => this._confirmDeleteSelectedRules());
        header.appendChild(deleteBtn);

        container.appendChild(header);

        if (this.rules.length === 0) {
            this.renderEmptyState(container);
            return;
        }

        // ── New-rules protection banner ─────────────────────────────────
        const newRules = this.rules.filter(r => this._isNewRule(r));
        if (newRules.length > 0 && !this.bannerDismissed) {
            const banner = document.createElement('div');
            banner.style.cssText = 'margin-bottom: 16px; padding: 14px 18px; border-radius: 8px; border: 1px solid rgba(180,83,9,0.3); background: rgba(245,158,11,0.08); display: flex; gap: 12px; align-items: flex-start; position: relative;';

            const bannerBody = document.createElement('div');
            bannerBody.style.cssText = 'flex: 1; min-width: 0; padding-right: 24px;';

            const bannerTitle = document.createElement('div');
            bannerTitle.style.cssText = 'font-weight: 700; font-size: 13px; color: var(--warning-text); margin-bottom: 4px;';
            bannerTitle.textContent = newRules.length + ' new detection rule' + (newRules.length > 1 ? 's' : '') + ' added — AI Agent Attack Protection';
            bannerBody.appendChild(bannerTitle);

            const bannerDesc = document.createElement('div');
            bannerDesc.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.5;';
            bannerDesc.textContent = 'SecureVector now detects the latest AI agent attack patterns: injected instructions inside tool results, multi-agent authority spoofing, and permission scope escalation. These cover real attack chains used against OpenClaw, GitHub MCP, and other agent frameworks in 2025\u20132026. Expand any highlighted rule below to see how it protects your agents.';
            bannerBody.appendChild(bannerDesc);

            const bannerList = document.createElement('div');
            bannerList.style.cssText = 'margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px;';
            newRules.forEach(r => {
                const chip = document.createElement('span');
                chip.style.cssText = 'font-size: 11px; padding: 2px 8px; border-radius: 99px; background: var(--warning-chip-bg); color: var(--warning-text-muted); border: 1px solid var(--warning-chip-border); font-weight: 500;';
                chip.textContent = r.name;
                bannerList.appendChild(chip);
            });
            bannerBody.appendChild(bannerList);

            banner.appendChild(bannerBody);

            // Close button
            const closeBtn = document.createElement('button');
            closeBtn.style.cssText = 'position: absolute; top: 10px; right: 12px; background: none; border: none; cursor: pointer; color: var(--warning-text-muted); font-size: 18px; line-height: 1; padding: 0 4px; opacity: 0.6;';
            closeBtn.textContent = '\u00D7';
            closeBtn.title = 'Dismiss';
            closeBtn.addEventListener('click', () => { this.bannerDismissed = true; banner.remove(); });
            banner.appendChild(closeBtn);

            container.appendChild(banner);
        }

        // Table
        const tableWrapper = document.createElement('div');
        tableWrapper.className = 'table-wrapper';

        const table = document.createElement('table');
        table.className = 'data-table rules-table';
        table.id = 'custom-rules-table';

        // Header
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');

        const colDefs = [
            { label: '', field: null },
            { label: 'Name', field: 'name' },
            { label: 'Category', field: 'category' },
            { label: 'Severity', field: 'severity' },
            { label: 'Patterns', field: 'patterns' },
            { label: 'Added', field: 'created_at' },
            { label: 'Status', field: 'enabled' },
        ];
        const self = this;
        colDefs.forEach((col, idx) => {
            const th = document.createElement('th');
            if (idx === 0) {
                th.style.cssText = 'width: 52px; text-align: center;';
                const allCb = document.createElement('input');
                allCb.type = 'checkbox';
                allCb.id = 'rules-select-all';
                allCb.className = 'rule-select-all';
                allCb.title = 'Select all custom rules';
                allCb.addEventListener('change', (e) => {
                    const customOnPage = self.getPaginatedRules().filter(r => r.source === 'custom');
                    customOnPage.forEach(r => {
                        if (e.target.checked) self.rulesSelectedIds.add(r.id);
                        else self.rulesSelectedIds.delete(r.id);
                    });
                    document.querySelectorAll('.rule-row-cb').forEach(cb => { cb.checked = e.target.checked; });
                    self._updateRulesDeleteBtn();
                });
                th.appendChild(allCb);
                headerRow.appendChild(th);
                return;
            }
            th.style.whiteSpace = 'nowrap';
            if (col.field) {
                th.style.cursor = 'pointer';
                th.style.userSelect = 'none';
                const indicator = this.sortField === col.field
                    ? (this.sortDir === 'asc' ? ' \u25B2' : ' \u25BC')
                    : ' \u25B7';
                th.textContent = col.label + indicator;
                th.addEventListener('click', () => {
                    if (this.sortField === col.field) {
                        this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
                    } else {
                        this.sortField = col.field;
                        this.sortDir = col.field === 'created_at' ? 'desc' : 'asc';
                    }
                    this.filters.page = 1;
                    this.applyFilters();
                    this.renderContent();
                });
            } else {
                th.textContent = col.label;
            }
            headerRow.appendChild(th);
        });

        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Body
        const tbody = document.createElement('tbody');
        tbody.id = 'rules-tbody';
        const paginatedRules = this.getPaginatedRules();

        paginatedRules.forEach(rule => {
            // Main row
            const row = this.createRuleRow(rule);
            tbody.appendChild(row);

            // Expandable patterns row
            const patternsRow = this.createPatternsRow(rule);
            tbody.appendChild(patternsRow);
        });

        table.appendChild(tbody);
        tableWrapper.appendChild(table);
        container.appendChild(tableWrapper);

        // Pagination
        if (this.getTotalPages() > 1) {
            const pagination = this.createPagination();
            container.appendChild(pagination);
        }
    },

    createRuleRow(rule) {
        const row = document.createElement('tr');
        row.className = 'rule-row' + (rule.enabled ? '' : ' disabled-row');
        row.dataset.ruleId = rule.id;

        // First cell: checkbox (custom rules only) + expand button
        const expandCell = document.createElement('td');
        expandCell.className = 'expand-cell';
        expandCell.style.cssText = 'text-align: center; white-space: nowrap;';

        if (rule.source === 'custom') {
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'rule-row-cb';
            cb.checked = this.rulesSelectedIds.has(rule.id);
            cb.title = 'Select for deletion';
            cb.addEventListener('click', (e) => e.stopPropagation());
            cb.addEventListener('change', () => {
                if (cb.checked) this.rulesSelectedIds.add(rule.id);
                else this.rulesSelectedIds.delete(rule.id);
                const allCb = document.getElementById('rules-select-all');
                if (allCb) {
                    const customOnPage = this.getPaginatedRules().filter(r => r.source === 'custom');
                    allCb.checked = customOnPage.length > 0 && this.rulesSelectedIds.size === customOnPage.length;
                    allCb.indeterminate = this.rulesSelectedIds.size > 0 && this.rulesSelectedIds.size < customOnPage.length;
                }
                this._updateRulesDeleteBtn();
            });
            expandCell.appendChild(cb);
        }

        const expandBtn = document.createElement('button');
        expandBtn.className = 'expand-btn';
        expandBtn.textContent = this.expandedRows.has(rule.id) ? '\u25BC' : '\u25B6';
        expandBtn.title = 'Show patterns';
        expandBtn.addEventListener('click', () => this.toggleExpand(rule.id));
        expandCell.appendChild(expandBtn);
        row.appendChild(expandCell);

        // Name
        const nameCell = document.createElement('td');
        nameCell.className = 'rule-name-cell';

        const nameLine = document.createElement('div');
        nameLine.style.cssText = 'display: flex; align-items: center; gap: 6px;';
        const nameText = document.createElement('span');
        nameText.className = 'rule-name';
        nameText.textContent = rule.name || 'Unnamed Rule';
        nameLine.appendChild(nameText);
        if (this._isNewRule(rule)) {
            const newBadge = document.createElement('span');
            newBadge.style.cssText = 'font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 99px; background: var(--warning-chip-bg); color: var(--warning-text); border: 1px solid var(--warning-chip-border); letter-spacing: 0.3px; flex-shrink: 0;';
            newBadge.textContent = 'NEW';
            nameLine.appendChild(newBadge);
        }
        nameCell.appendChild(nameLine);

        if (rule.description) {
            const descText = document.createElement('div');
            descText.className = 'rule-desc';
            descText.textContent = rule.description.substring(0, 100) + (rule.description.length > 100 ? '...' : '');
            nameCell.appendChild(descText);
        }
        row.appendChild(nameCell);

        // Category
        const categoryCell = document.createElement('td');
        const categoryBadge = document.createElement('span');
        categoryBadge.className = 'type-badge';
        categoryBadge.textContent = this.formatLabel(rule.category);
        categoryCell.appendChild(categoryBadge);
        row.appendChild(categoryCell);

        // Severity
        const severityCell = document.createElement('td');
        const severityBadge = document.createElement('span');
        severityBadge.className = 'risk-badge risk-' + this.getSeverityLevel(rule.severity);
        severityBadge.textContent = this.formatLabel(rule.severity);
        severityCell.appendChild(severityBadge);
        row.appendChild(severityCell);

        // Patterns count
        const patternsCell = document.createElement('td');
        patternsCell.className = 'patterns-cell';
        const patterns = rule.patterns || [];
        const patternCount = document.createElement('span');
        patternCount.className = 'pattern-count';
        patternCount.textContent = patterns.length + ' pattern' + (patterns.length !== 1 ? 's' : '');
        patternsCell.appendChild(patternCount);
        row.appendChild(patternsCell);

        // Date added
        const dateCell = document.createElement('td');
        dateCell.style.cssText = 'white-space: nowrap; font-size: 12px; color: var(--text-muted);';
        dateCell.textContent = this._formatDate(rule.created_at);
        row.appendChild(dateCell);

        // Status toggle
        const statusCell = document.createElement('td');
        statusCell.className = 'status-cell';

        const statusLabel = document.createElement('span');
        statusLabel.className = 'status-label ' + (rule.enabled ? 'enabled' : 'disabled');
        statusLabel.textContent = rule.enabled ? 'Enabled' : 'Disabled';
        statusLabel.style.cursor = 'pointer';
        statusLabel.title = 'Click to ' + (rule.enabled ? 'disable' : 'enable');
        statusLabel.addEventListener('click', () => this.confirmToggle(rule));
        statusCell.appendChild(statusLabel);
        row.appendChild(statusCell);

        return row;
    },

    createPatternsRow(rule) {
        const row = document.createElement('tr');
        row.className = 'patterns-row';
        row.id = 'patterns-' + rule.id;
        row.style.display = this.expandedRows.has(rule.id) ? 'table-row' : 'none';

        const cell = document.createElement('td');
        cell.colSpan = 7;
        cell.className = 'patterns-expand-cell';

        // Protection rationale for new/agent-attack rules
        const agentRuleIds = ['sv_community_020_github_mcp_injection', 'sv_community_021_tool_result_injection', 'sv_community_022_multiagent_authority_spoof', 'sv_community_023_permission_scope_escalation'];
        if (agentRuleIds.includes(rule.id) && rule.description) {
            const rationale = document.createElement('div');
            rationale.style.cssText = 'margin-bottom: 12px; padding: 12px 14px; border-radius: 6px; border: 1px solid rgba(245,158,11,0.3); background: rgba(245,158,11,0.06);';

            const rationaleHeader = document.createElement('div');
            rationaleHeader.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 6px;';
            const shieldIcon = document.createElement('span');
            shieldIcon.textContent = '\uD83D\uDEE1\uFE0F';
            shieldIcon.style.fontSize = '13px';
            rationaleHeader.appendChild(shieldIcon);
            const rationaleTitle = document.createElement('span');
            rationaleTitle.style.cssText = 'font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--warning-text);';
            rationaleTitle.textContent = 'How SecureVector Protects';
            rationaleHeader.appendChild(rationaleTitle);
            rationale.appendChild(rationaleHeader);

            const rationaleText = document.createElement('p');
            rationaleText.style.cssText = 'font-size: 12px; color: var(--text-color, #4b5563); line-height: 1.6; margin: 0;';
            rationaleText.textContent = rule.description.replace(/\s+/g, ' ').trim();
            rationale.appendChild(rationaleText);
            cell.appendChild(rationale);
        }

        const patterns = rule.patterns || [];
        if (patterns.length === 0) {
            const noPatterns = document.createElement('span');
            noPatterns.style.cssText = 'color: var(--text-muted); font-size: 12px;';
            noPatterns.textContent = 'No patterns defined';
            cell.appendChild(noPatterns);
        } else {
            const list = document.createElement('div');
            list.className = 'patterns-list';

            patterns.forEach((pattern, index) => {
                const item = document.createElement('div');
                item.className = 'pattern-item';

                const num = document.createElement('span');
                num.className = 'pattern-num';
                num.textContent = (index + 1) + '.';
                item.appendChild(num);

                const code = document.createElement('code');
                code.className = 'pattern-code';
                code.textContent = pattern;
                item.appendChild(code);

                list.appendChild(item);
            });

            cell.appendChild(list);
        }

        row.appendChild(cell);
        return row;
    },

    toggleExpand(ruleId) {
        const patternsRow = document.getElementById('patterns-' + ruleId);
        const mainRow = document.querySelector('.rule-row[data-rule-id="' + ruleId + '"]');
        const expandBtn = mainRow?.querySelector('.expand-btn');

        if (this.expandedRows.has(ruleId)) {
            this.expandedRows.delete(ruleId);
            if (patternsRow) patternsRow.style.display = 'none';
            if (expandBtn) expandBtn.textContent = '\u25B6';
        } else {
            this.expandedRows.add(ruleId);
            if (patternsRow) patternsRow.style.display = 'table-row';
            if (expandBtn) expandBtn.textContent = '\u25BC';
        }
    },

    confirmToggle(rule) {
        const action = rule.enabled ? 'disable' : 'enable';
        const content = document.createElement('div');
        content.className = 'confirm-content';

        const message = document.createElement('p');
        message.textContent = 'Are you sure you want to ' + action + ' this rule?';
        content.appendChild(message);

        const ruleName = document.createElement('p');
        const strong = document.createElement('strong');
        strong.textContent = rule.name || 'Unnamed Rule';
        ruleName.appendChild(strong);
        ruleName.style.marginTop = '12px';
        content.appendChild(ruleName);

        if (action === 'disable') {
            const warning = document.createElement('p');
            warning.className = 'confirm-warning';
            warning.textContent = 'Disabling this rule will stop it from detecting threats.';
            content.appendChild(warning);
        }

        const buttons = document.createElement('div');
        buttons.className = 'confirm-buttons';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => Modal.close());
        buttons.appendChild(cancelBtn);

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'btn ' + (action === 'disable' ? 'btn-danger' : 'btn-primary');
        confirmBtn.textContent = action.charAt(0).toUpperCase() + action.slice(1) + ' Rule';
        confirmBtn.addEventListener('click', () => {
            Modal.close();
            this.toggleRule(rule.id, !rule.enabled);
        });
        buttons.appendChild(confirmBtn);

        content.appendChild(buttons);

        Modal.show({
            title: 'Confirm ' + action.charAt(0).toUpperCase() + action.slice(1),
            content: content,
            size: 'small',
        });
    },

    async toggleRule(ruleId, enabled) {
        const row = document.querySelector('.rule-row[data-rule-id="' + ruleId + '"]');
        const statusLabel = row?.querySelector('.status-label');

        try {
            await API.toggleRule(ruleId, enabled);
            Toast.success(enabled ? 'Rule enabled' : 'Rule disabled');

            // Update local state
            const rule = this.allRules.find(r => r.id === ruleId);
            if (rule) rule.enabled = enabled;
            const filteredRule = this.rules.find(r => r.id === ruleId);
            if (filteredRule) filteredRule.enabled = enabled;

            // Update UI
            if (row) {
                row.className = 'rule-row' + (enabled ? '' : ' disabled-row');
            }
            if (statusLabel) {
                statusLabel.className = 'status-label ' + (enabled ? 'enabled' : 'disabled');
                statusLabel.textContent = enabled ? 'Enabled' : 'Disabled';
                statusLabel.title = 'Click to ' + (enabled ? 'disable' : 'enable');
            }
        } catch (error) {
            Toast.error('Failed to update rule');
        }
    },

    createPagination() {
        const pagination = document.createElement('div');
        pagination.className = 'pagination';

        const prevBtn = document.createElement('button');
        prevBtn.className = 'btn btn-small';
        prevBtn.textContent = 'Previous';
        prevBtn.disabled = this.filters.page <= 1;
        prevBtn.addEventListener('click', () => {
            this.filters.page--;
            this.renderContent();
        });
        pagination.appendChild(prevBtn);

        const pageInfo = document.createElement('span');
        pageInfo.className = 'page-info';
        pageInfo.textContent = 'Page ' + this.filters.page + ' of ' + this.getTotalPages();
        pagination.appendChild(pageInfo);

        const nextBtn = document.createElement('button');
        nextBtn.className = 'btn btn-small';
        nextBtn.textContent = 'Next';
        nextBtn.disabled = this.filters.page >= this.getTotalPages();
        nextBtn.addEventListener('click', () => {
            this.filters.page++;
            this.renderContent();
        });
        pagination.appendChild(nextBtn);

        return pagination;
    },

    getSeverityLevel(severity) {
        const levels = { critical: 'critical', high: 'high', medium: 'medium', low: 'low' };
        return levels[severity?.toLowerCase()] || 'medium';
    },

    renderEmptyState(container) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';

        const iconWrapper = document.createElement('div');
        iconWrapper.className = 'empty-state-icon';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.5');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z');
        svg.appendChild(path);
        iconWrapper.appendChild(svg);
        empty.appendChild(iconWrapper);

        const title = document.createElement('div');
        title.className = 'empty-state-title';
        title.textContent = 'No Rules Found';
        empty.appendChild(title);

        const text = document.createElement('p');
        text.className = 'empty-state-text';
        text.textContent = 'Community rules are loaded from the SDK. Click "Create Rule" to add custom rules.';
        empty.appendChild(text);

        container.appendChild(empty);
    },

    async showCreateRuleModal() {
        // Check custom rules count
        const customCount = this.allRules.filter(r => r.source === 'custom').length;

        if (customCount >= this.LOCAL_RULE_LIMIT) {
            this.showCloudUpgradeModal(customCount);
            return;
        }

        this.showRuleFormModal(customCount);
    },

    _updateRulesDeleteBtn() {
        const btn = document.getElementById('rules-delete-selected-btn');
        if (!btn) return;
        const count = this.rulesSelectedIds.size;
        if (count > 0) {
            btn.style.display = '';
            btn.textContent = 'Delete Selected (' + count + ')';
        } else {
            btn.style.display = 'none';
        }
        const tbl = document.getElementById('custom-rules-table');
        if (tbl) tbl.classList.toggle('has-selection', count > 0);
    },

    async _confirmDeleteSelectedRules() {
        const count = this.rulesSelectedIds.size;
        if (!count) return;
        const confirmed = confirm('Delete ' + count + ' selected rule' + (count !== 1 ? 's' : '') + '?\n\nThis action cannot be undone.');
        if (!confirmed) return;
        try {
            const ids = [...this.rulesSelectedIds];
            for (const id of ids) {
                await API.deleteRule(id);
            }
            this.rulesSelectedIds.clear();
            this._updateRulesDeleteBtn();
            const container = document.getElementById('rules-content');
            if (container) {
                this.applyFilters();
                this.renderContent();
            }
            if (window.Toast) Toast.show('Deleted ' + count + ' rule' + (count !== 1 ? 's' : ''), 'success');
        } catch (e) {
            if (window.Toast) Toast.show('Failed to delete rules', 'error');
        }
    },

    showCloudUpgradeModal(currentCount) {
        const content = document.createElement('div');
        content.className = 'cloud-upgrade-content';

        const icon = document.createElement('div');
        icon.className = 'upgrade-icon';
        icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"/></svg>';
        content.appendChild(icon);

        const heading = document.createElement('h3');
        heading.textContent = 'Local Rule Limit Reached';
        heading.style.margin = '16px 0 8px';
        content.appendChild(heading);

        const message = document.createElement('p');
        message.style.color = 'var(--text-secondary)';
        message.style.marginBottom = '16px';
        message.textContent = 'You have ' + currentCount + ' of ' + this.LOCAL_RULE_LIMIT + ' local custom rules. Upgrade to Cloud for unlimited rules with ML-powered detection.';
        content.appendChild(message);

        const features = document.createElement('ul');
        features.className = 'upgrade-features';
        const featureList = [
            'Unlimited custom rules',
            'ML-powered threat detection',
            'Real-time cloud sync',
            'Advanced analytics',
        ];
        featureList.forEach(f => {
            const li = document.createElement('li');
            li.textContent = f;
            features.appendChild(li);
        });
        content.appendChild(features);

        const buttons = document.createElement('div');
        buttons.className = 'confirm-buttons';
        buttons.style.marginTop = '24px';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.textContent = 'Maybe Later';
        cancelBtn.addEventListener('click', () => Modal.close());
        buttons.appendChild(cancelBtn);

        const upgradeBtn = document.createElement('button');
        upgradeBtn.className = 'btn btn-primary';
        upgradeBtn.textContent = 'Sign Up for Cloud';
        upgradeBtn.addEventListener('click', () => {
            window.open('https://app.securevector.io', '_blank');
            Modal.close();
        });
        buttons.appendChild(upgradeBtn);

        content.appendChild(buttons);

        Modal.show({
            title: 'Upgrade to Cloud',
            content: content,
            size: 'medium',
        });
    },

    showRuleFormModal(currentCount) {
        const content = document.createElement('div');
        content.className = 'create-rule-form';

        // Rule limit indicator
        const limitBar = document.createElement('div');
        limitBar.className = 'rule-limit-bar';
        const limitSpan = document.createElement('span');
        limitSpan.textContent = 'Custom Rules: ' + currentCount + '/' + this.LOCAL_RULE_LIMIT;
        limitBar.appendChild(limitSpan);
        content.appendChild(limitBar);

        // Description
        const descGroup = document.createElement('div');
        descGroup.className = 'form-group';

        const descLabel = document.createElement('label');
        descLabel.textContent = 'Describe what to detect';
        descLabel.htmlFor = 'rule-description';
        descGroup.appendChild(descLabel);

        const descHelp = document.createElement('p');
        descHelp.className = 'form-help';
        descHelp.textContent = 'Plain language description — patterns are generated automatically when you create the rule.';
        descGroup.appendChild(descHelp);

        const descInput = document.createElement('textarea');
        descInput.id = 'rule-description';
        descInput.className = 'form-textarea';
        descInput.placeholder = 'e.g., "block credit card numbers" or "detect attempts to ignore instructions"';
        descInput.maxLength = 500;
        descInput.rows = 3;
        descGroup.appendChild(descInput);

        const charCount = document.createElement('div');
        charCount.className = 'char-count';
        charCount.textContent = '0 / 500';
        descInput.addEventListener('input', () => {
            charCount.textContent = descInput.value.length + ' / 500';
        });
        descGroup.appendChild(charCount);

        content.appendChild(descGroup);

        // Patterns preview (shown after clicking Preview Patterns)
        const previewSection = document.createElement('div');
        previewSection.className = 'patterns-preview';
        previewSection.id = 'patterns-preview';
        previewSection.style.display = 'none';
        content.appendChild(previewSection);

        // Rule name
        const nameGroup = document.createElement('div');
        nameGroup.className = 'form-group';

        const nameLabel = document.createElement('label');
        nameLabel.textContent = 'Rule Name';
        nameLabel.htmlFor = 'rule-name';
        nameGroup.appendChild(nameLabel);

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.id = 'rule-name';
        nameInput.className = 'form-input';
        nameInput.placeholder = 'e.g., Block Credit Cards';
        nameInput.maxLength = 100;
        nameGroup.appendChild(nameInput);

        content.appendChild(nameGroup);

        // Severity
        const sevGroup = document.createElement('div');
        sevGroup.className = 'form-group';

        const sevLabel = document.createElement('label');
        sevLabel.textContent = 'Severity';
        sevLabel.htmlFor = 'rule-severity';
        sevGroup.appendChild(sevLabel);

        const sevSelect = document.createElement('select');
        sevSelect.id = 'rule-severity';
        sevSelect.className = 'form-select';
        ['low', 'medium', 'high', 'critical'].forEach(sev => {
            const option = document.createElement('option');
            option.value = sev;
            option.textContent = sev.charAt(0).toUpperCase() + sev.slice(1);
            if (sev === 'medium') option.selected = true;
            sevSelect.appendChild(option);
        });
        sevGroup.appendChild(sevSelect);

        content.appendChild(sevGroup);

        // Buttons
        const buttons = document.createElement('div');
        buttons.className = 'confirm-buttons';
        buttons.style.marginTop = '24px';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => Modal.close());
        buttons.appendChild(cancelBtn);

        const generateBtn = document.createElement('button');
        generateBtn.className = 'btn btn-secondary';
        generateBtn.id = 'generate-btn';
        generateBtn.textContent = 'Preview Patterns';
        generateBtn.addEventListener('click', () => this.generateAndPreviewPatterns(descInput.value));
        buttons.appendChild(generateBtn);

        const createBtn = document.createElement('button');
        createBtn.className = 'btn btn-primary';
        createBtn.id = 'create-rule-btn';
        createBtn.textContent = 'Create Rule';
        createBtn.addEventListener('click', () => this.submitCreateRule());
        buttons.appendChild(createBtn);

        content.appendChild(buttons);

        Modal.show({
            title: 'Create Custom Rule',
            content: content,
            size: 'medium',
        });
    },

    async generateAndPreviewPatterns(description) {
        if (!description || description.trim().length < 5) {
            Toast.error('Please enter a description (at least 5 characters)');
            return;
        }

        const generateBtn = document.getElementById('generate-btn');
        if (generateBtn) {
            generateBtn.disabled = true;
            generateBtn.textContent = 'Generating...';
        }

        try {
            const result = await API.generatePatterns(description);
            this.generatedPatterns = result;

            // Show preview
            const preview = document.getElementById('patterns-preview');
            if (preview) {
                preview.style.display = 'block';
                preview.innerHTML = '';

                const title = document.createElement('div');
                title.className = 'preview-title';
                title.textContent = 'Generated Patterns (' + result.patterns.length + ')';
                preview.appendChild(title);

                if (result.patterns.length === 0) {
                    // Apply keyword fallback so preview shows something useful
                    const stopWords = new Set(['that', 'this', 'with', 'from', 'have', 'will', 'when', 'then', 'than', 'they', 'their', 'there', 'detect', 'block', 'flag', 'find', 'match']);
                    const words = description.toLowerCase()
                        .replace(/[^a-z0-9\s]/g, ' ')
                        .split(/\s+/)
                        .filter(w => w.length > 3 && !stopWords.has(w));
                    if (words.length > 0) {
                        const fallbackPattern = '(?i)' + words.slice(0, 3).join('.*');
                        result.patterns = [{ pattern: fallbackPattern, confidence: 0.5 }];
                        this.generatedPatterns = result;
                    }
                }

                if (result.patterns.length === 0) {
                    const noPatterns = document.createElement('p');
                    noPatterns.className = 'form-help';
                    noPatterns.style.marginBottom = '8px';
                    noPatterns.textContent = 'No patterns could be auto-generated. Enter a regex pattern manually:';
                    preview.appendChild(noPatterns);

                    const manualInput = document.createElement('input');
                    manualInput.type = 'text';
                    manualInput.id = 'manual-pattern-input';
                    manualInput.className = 'form-input';
                    manualInput.placeholder = 'e.g. (?i)give.*discount|free.*offer';
                    manualInput.style.cssText = 'width: 100%; font-family: monospace; font-size: 13px;';
                    preview.appendChild(manualInput);
                } else {
                    const list = document.createElement('div');
                    list.className = 'generated-patterns-list';

                    result.patterns.forEach((p, idx) => {
                        const item = document.createElement('div');
                        item.className = 'generated-pattern-item';

                        const num = document.createElement('span');
                        num.className = 'pattern-num';
                        num.textContent = (idx + 1) + '.';
                        item.appendChild(num);

                        const code = document.createElement('code');
                        code.className = 'pattern-code';
                        code.textContent = p.pattern;
                        item.appendChild(code);

                        const confidence = document.createElement('span');
                        confidence.className = 'pattern-confidence';
                        confidence.textContent = Math.round(p.confidence * 100) + '%';
                        item.appendChild(confidence);

                        list.appendChild(item);
                    });

                    preview.appendChild(list);
                }
            }

            // Pre-fill name/severity if empty
            const nameEl = document.getElementById('rule-name');
            if (nameEl && !nameEl.value) nameEl.value = this.formatLabel(result.suggested_name || 'custom_rule');
            const sevEl = document.getElementById('rule-severity');
            if (sevEl && result.suggested_severity) sevEl.value = result.suggested_severity;

            // Re-enable generate button
            if (generateBtn) {
                generateBtn.disabled = false;
                generateBtn.textContent = 'Preview Patterns';
            }
            // Store generated patterns for use in submitCreateRule
            this.generatedPatterns = result;

        } catch (error) {
            Toast.error('Failed to generate patterns: ' + error.message);
            if (generateBtn) {
                generateBtn.disabled = false;
                generateBtn.textContent = 'Generate Patterns';
            }
        }
    },

    async submitCreateRule() {
        const name = document.getElementById('rule-name').value.trim();
        const severity = document.getElementById('rule-severity').value;
        const description = document.getElementById('rule-description').value.trim();

        if (!name) {
            Toast.error('Please enter a rule name');
            return;
        }

        const createBtn = document.getElementById('create-rule-btn');
        if (createBtn) {
            createBtn.disabled = true;
            createBtn.textContent = 'Creating...';
        }

        try {
            // Auto-generate patterns from the description
            let patterns = [];
            let category = 'custom';
            try {
                const result = await API.generatePatterns(description);
                patterns = result.patterns.map(p => p.pattern);
                category = result.suggested_category || 'custom';
            } catch (_) { /* fall through to keyword fallback */ }

            // Fallback: build a simple keyword pattern from meaningful words
            if (patterns.length === 0) {
                const stopWords = new Set(['that', 'this', 'with', 'from', 'have', 'will', 'when', 'then', 'than', 'they', 'their', 'there', 'detect', 'block', 'flag', 'find', 'match']);
                const words = description.toLowerCase()
                    .replace(/[^a-z0-9\s]/g, ' ')
                    .split(/\s+/)
                    .filter(w => w.length > 3 && !stopWords.has(w));
                if (words.length > 0) {
                    patterns = ['(?i)' + words.slice(0, 3).join('.*')];
                }
            }

            if (patterns.length === 0) {
                Toast.error('Could not generate patterns. Try using more specific keywords (e.g. "credit card", "ignore instructions").');
                if (createBtn) { createBtn.disabled = false; createBtn.textContent = 'Create Rule'; }
                return;
            }

            await API.createRule({
                name: name,
                category: category,
                description: description,
                severity: severity,
                patterns: patterns,
                enabled: true,
            });

            Toast.success('Rule created successfully');
            Modal.close();
            this.generatedPatterns = null;

            // Refresh the rules list
            const container = document.getElementById('rules-content').parentElement;
            if (container) {
                await this.render(container);
            }

        } catch (error) {
            Toast.error('Failed to create rule: ' + error.message);
            if (createBtn) {
                createBtn.disabled = false;
                createBtn.textContent = 'Create Rule';
            }
        }
    },
};

window.RulesPage = RulesPage;
