/**
 * Rules Page
 * Detection rules management with table view, pagination, and filters
 */

const RulesPage = {
    allRules: [],
    rules: [],
    expandedRows: new Set(),
    LOCAL_RULE_LIMIT: 100,
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

        // Page header with title and create button
        const pageHeader = document.createElement('div');
        pageHeader.className = 'page-title-bar';

        const title = document.createElement('h2');
        title.className = 'page-title';
        title.textContent = 'Detection Rules';
        pageHeader.appendChild(title);

        const createBtn = document.createElement('button');
        createBtn.className = 'btn btn-primary';
        createBtn.textContent = '+ Create Rule';
        createBtn.addEventListener('click', () => this.showCreateRuleModal());
        pageHeader.appendChild(createBtn);

        container.appendChild(pageHeader);

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
        container.appendChild(header);

        if (this.rules.length === 0) {
            this.renderEmptyState(container);
            return;
        }

        // Table
        const tableWrapper = document.createElement('div');
        tableWrapper.className = 'table-wrapper';

        const table = document.createElement('table');
        table.className = 'data-table rules-table';

        // Header
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');

        const headers = ['', 'Name', 'Category', 'Severity', 'Patterns', 'Status'];
        headers.forEach((text, idx) => {
            const th = document.createElement('th');
            if (idx === 0) {
                th.style.width = '40px';
            }
            th.textContent = text;
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

        // Expand button
        const expandCell = document.createElement('td');
        expandCell.className = 'expand-cell';
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
        const nameText = document.createElement('div');
        nameText.className = 'rule-name';
        nameText.textContent = rule.name || 'Unnamed Rule';
        nameCell.appendChild(nameText);
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
        cell.colSpan = 6;
        cell.className = 'patterns-expand-cell';

        const patterns = rule.patterns || [];
        if (patterns.length === 0) {
            cell.textContent = 'No patterns defined';
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
        limitBar.innerHTML = '<span>Custom Rules: ' + currentCount + '/' + this.LOCAL_RULE_LIMIT + '</span>';
        content.appendChild(limitBar);

        // Natural language description
        const descGroup = document.createElement('div');
        descGroup.className = 'form-group';

        const descLabel = document.createElement('label');
        descLabel.textContent = 'Describe what to detect';
        descLabel.htmlFor = 'rule-description';
        descGroup.appendChild(descLabel);

        const descHelp = document.createElement('p');
        descHelp.className = 'form-help';
        descHelp.textContent = 'Enter a natural language description. We\'ll generate regex patterns automatically.';
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

        // Generated patterns preview (hidden initially)
        const previewSection = document.createElement('div');
        previewSection.className = 'patterns-preview';
        previewSection.id = 'patterns-preview';
        previewSection.style.display = 'none';
        content.appendChild(previewSection);

        // Rule name (hidden initially, shown after generation)
        const nameGroup = document.createElement('div');
        nameGroup.className = 'form-group';
        nameGroup.id = 'rule-name-group';
        nameGroup.style.display = 'none';

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

        // Severity select (hidden initially)
        const sevGroup = document.createElement('div');
        sevGroup.className = 'form-group';
        sevGroup.id = 'rule-severity-group';
        sevGroup.style.display = 'none';

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
        generateBtn.className = 'btn btn-primary';
        generateBtn.id = 'generate-btn';
        generateBtn.textContent = 'Generate Patterns';
        generateBtn.addEventListener('click', () => this.generatePatterns(descInput.value));
        buttons.appendChild(generateBtn);

        const createBtn = document.createElement('button');
        createBtn.className = 'btn btn-primary';
        createBtn.id = 'create-rule-btn';
        createBtn.textContent = 'Create Rule';
        createBtn.style.display = 'none';
        createBtn.addEventListener('click', () => this.submitCreateRule());
        buttons.appendChild(createBtn);

        content.appendChild(buttons);

        Modal.show({
            title: 'Create Custom Rule',
            content: content,
            size: 'medium',
        });
    },

    async generatePatterns(description) {
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
                    const noPatterns = document.createElement('p');
                    noPatterns.className = 'form-help';
                    noPatterns.textContent = 'No patterns could be generated. Try a different description.';
                    preview.appendChild(noPatterns);
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

            // Show name and severity fields
            document.getElementById('rule-name-group').style.display = 'block';
            document.getElementById('rule-severity-group').style.display = 'block';

            // Pre-fill suggested values
            document.getElementById('rule-name').value = this.formatLabel(result.suggested_name || 'custom_rule');
            document.getElementById('rule-severity').value = result.suggested_severity || 'medium';

            // Show create button, hide generate
            if (generateBtn) generateBtn.style.display = 'none';
            document.getElementById('create-rule-btn').style.display = 'inline-flex';

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

        if (!this.generatedPatterns || this.generatedPatterns.patterns.length === 0) {
            Toast.error('No patterns generated');
            return;
        }

        const createBtn = document.getElementById('create-rule-btn');
        if (createBtn) {
            createBtn.disabled = true;
            createBtn.textContent = 'Creating...';
        }

        try {
            await API.createRule({
                name: name,
                category: this.generatedPatterns.suggested_category || 'custom',
                description: description,
                severity: severity,
                patterns: this.generatedPatterns.patterns.map(p => p.pattern),
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
