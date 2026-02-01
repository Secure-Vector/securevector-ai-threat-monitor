/**
 * Rules Page
 * Detection rules management
 */

const RulesPage = {
    rules: [],
    allRules: [], // Store all rules for filtering
    filters: {
        category: '',
        severity: '',
        enabled: '', // '', 'true', 'false'
    },

    async render(container) {
        container.textContent = '';

        // Filters bar (will be populated after loading rules)
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
            this.applyFilters();
            this.renderContent();
        });

        severityGroup.appendChild(severitySelect);
        bar.appendChild(severityGroup);

        // Enabled filter
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
            this.applyFilters();
            this.renderContent();
        });

        enabledGroup.appendChild(enabledSelect);
        bar.appendChild(enabledGroup);
    },

    getUniqueCategories() {
        const categories = new Set();
        this.allRules.forEach(rule => {
            if (rule.category) {
                categories.add(rule.category);
            }
        });
        return Array.from(categories).sort();
    },

    getUniqueSeverities() {
        const severities = new Set();
        this.allRules.forEach(rule => {
            if (rule.severity) {
                severities.add(rule.severity);
            }
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
            // Category filter
            if (this.filters.category && rule.category !== this.filters.category) {
                return false;
            }
            // Severity filter
            if (this.filters.severity && rule.severity !== this.filters.severity) {
                return false;
            }
            // Enabled filter
            if (this.filters.enabled !== '') {
                const filterEnabled = this.filters.enabled === 'true';
                if (rule.enabled !== filterEnabled) {
                    return false;
                }
            }
            return true;
        });
    },

    renderContent() {
        const container = document.getElementById('rules-content');
        if (!container) return;

        container.textContent = '';

        // Header with stats
        const header = document.createElement('div');
        header.className = 'page-header';

        const stats = document.createElement('div');
        stats.className = 'rules-stats';

        const enabledCount = this.rules.filter(r => r.enabled).length;
        const totalCount = this.rules.length;
        const totalAll = this.allRules.length;

        const statText = document.createElement('span');
        if (totalAll === 0) {
            statText.textContent = 'No custom rules configured';
        } else if (totalCount === totalAll) {
            statText.textContent = enabledCount + ' of ' + totalCount + ' rules enabled';
        } else {
            statText.textContent = 'Showing ' + totalCount + ' of ' + totalAll + ' rules (' + enabledCount + ' enabled)';
        }
        stats.appendChild(statText);

        header.appendChild(stats);
        container.appendChild(header);

        if (this.rules.length === 0) {
            this.renderEmptyState(container);
            return;
        }

        // Rules list
        const rulesGrid = document.createElement('div');
        rulesGrid.className = 'rules-grid';

        this.rules.forEach(rule => {
            rulesGrid.appendChild(this.createRuleCard(rule));
        });

        container.appendChild(rulesGrid);
    },

    renderEmptyState(container) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';

        // Icon
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
        text.textContent = 'Community rules are loaded from the SDK. Custom rules can be created via the API.';
        empty.appendChild(text);

        // Hint about test analyze
        const hint = document.createElement('p');
        hint.className = 'empty-state-text';
        hint.style.fontSize = '13px';
        hint.textContent = 'Tip: Go to Settings to test the analyze endpoint with built-in pattern matching.';
        empty.appendChild(hint);

        container.appendChild(empty);
    },

    createRuleCard(rule) {
        const card = document.createElement('div');
        card.className = 'rule-card' + (rule.enabled ? ' enabled' : ' disabled');
        card.dataset.ruleId = rule.id;

        // Header
        const header = document.createElement('div');
        header.className = 'rule-header';

        const name = document.createElement('h3');
        name.className = 'rule-name';
        name.textContent = rule.name || 'Unnamed Rule';
        header.appendChild(name);

        // Toggle
        const toggle = document.createElement('label');
        toggle.className = 'toggle';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = rule.enabled;
        checkbox.addEventListener('change', () => this.toggleRule(rule.id, checkbox.checked));
        toggle.appendChild(checkbox);

        const slider = document.createElement('span');
        slider.className = 'toggle-slider';
        toggle.appendChild(slider);

        header.appendChild(toggle);
        card.appendChild(header);

        // Description
        if (rule.description) {
            const desc = document.createElement('p');
            desc.className = 'rule-description';
            desc.textContent = rule.description;
            card.appendChild(desc);
        }

        // Meta info
        const meta = document.createElement('div');
        meta.className = 'rule-meta';

        // Category badge
        if (rule.category) {
            const categoryBadge = document.createElement('span');
            categoryBadge.className = 'rule-badge category';
            categoryBadge.textContent = rule.category;
            meta.appendChild(categoryBadge);
        }

        // Severity badge
        if (rule.severity) {
            const severityBadge = document.createElement('span');
            severityBadge.className = 'rule-badge severity-' + rule.severity.toLowerCase();
            severityBadge.textContent = rule.severity;
            meta.appendChild(severityBadge);
        }

        card.appendChild(meta);

        return card;
    },

    async toggleRule(ruleId, enabled) {
        const card = document.querySelector('.rule-card[data-rule-id="' + ruleId + '"]');
        if (card) {
            card.classList.toggle('enabled', enabled);
            card.classList.toggle('disabled', !enabled);
        }

        try {
            await API.toggleRule(ruleId, enabled);
            Toast.success(enabled ? 'Rule enabled' : 'Rule disabled');

            // Update local state in both arrays
            const rule = this.rules.find(r => r.id === ruleId);
            if (rule) {
                rule.enabled = enabled;
            }
            const allRule = this.allRules.find(r => r.id === ruleId);
            if (allRule) {
                allRule.enabled = enabled;
            }
        } catch (error) {
            Toast.error('Failed to update rule');

            // Revert toggle
            if (card) {
                const checkbox = card.querySelector('input[type="checkbox"]');
                if (checkbox) {
                    checkbox.checked = !enabled;
                }
                card.classList.toggle('enabled', !enabled);
                card.classList.toggle('disabled', enabled);
            }
        }
    },
};

window.RulesPage = RulesPage;
