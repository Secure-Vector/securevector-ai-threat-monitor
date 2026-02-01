/**
 * Rules Page
 * Detection rules management
 */

const RulesPage = {
    rules: [],

    async render(container) {
        container.textContent = '';

        // Loading state
        const loading = document.createElement('div');
        loading.className = 'loading-container';
        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        loading.appendChild(spinner);
        container.appendChild(loading);

        try {
            const response = await API.getRules();
            this.rules = response.rules || response || [];
            this.renderContent(container);
        } catch (error) {
            this.renderError(container, error);
        }
    },

    renderContent(container) {
        container.textContent = '';

        // Header with stats
        const header = document.createElement('div');
        header.className = 'page-header';

        const stats = document.createElement('div');
        stats.className = 'rules-stats';

        const enabledCount = this.rules.filter(r => r.enabled).length;
        const totalCount = this.rules.length;

        const statText = document.createElement('span');
        statText.textContent = enabledCount + ' of ' + totalCount + ' rules enabled';
        stats.appendChild(statText);

        header.appendChild(stats);
        container.appendChild(header);

        if (this.rules.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.textContent = 'No detection rules configured';
            container.appendChild(empty);
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

            // Update local state
            const rule = this.rules.find(r => r.id === ruleId);
            if (rule) {
                rule.enabled = enabled;
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

    renderError(container, error) {
        container.textContent = '';

        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-state';

        const message = document.createElement('p');
        message.textContent = 'Failed to load rules';
        errorDiv.appendChild(message);

        const retry = document.createElement('button');
        retry.className = 'btn btn-primary';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => this.render(container));
        errorDiv.appendChild(retry);

        container.appendChild(errorDiv);
    },
};

window.RulesPage = RulesPage;
