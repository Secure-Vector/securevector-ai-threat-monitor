/**
 * Threats Page
 * Threat analytics and intel listing
 */

const ThreatsPage = {
    data: null,
    categories: [],
    filters: {
        page: 1,
        page_size: 20,
        threat_type: '',
        min_risk: 0,
    },

    async render(container) {
        container.textContent = '';

        // Filters bar (will be populated after loading categories)
        const filtersBar = document.createElement('div');
        filtersBar.className = 'filters-bar';
        filtersBar.id = 'threats-filters';
        container.appendChild(filtersBar);

        // Content area
        const content = document.createElement('div');
        content.id = 'threats-content';
        container.appendChild(content);

        // Load data first, then build filters from available categories
        await this.loadData();
        this.buildFiltersBar();
    },

    buildFiltersBar() {
        const bar = document.getElementById('threats-filters');
        if (!bar) return;

        bar.textContent = '';

        // Threat type filter - populated from database categories
        const typeGroup = document.createElement('div');
        typeGroup.className = 'filter-group';

        const typeLabel = document.createElement('label');
        typeLabel.textContent = 'Type';
        typeGroup.appendChild(typeLabel);

        const typeSelect = document.createElement('select');
        typeSelect.className = 'filter-select';
        typeSelect.id = 'threat-type-filter';

        // Default option
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = 'All Types';
        typeSelect.appendChild(defaultOption);

        // Add categories from data
        const uniqueTypes = this.getUniqueCategories();
        uniqueTypes.forEach(type => {
            const option = document.createElement('option');
            option.value = type;
            option.textContent = this.formatCategoryLabel(type);
            if (type === this.filters.threat_type) {
                option.selected = true;
            }
            typeSelect.appendChild(option);
        });

        typeSelect.addEventListener('change', (e) => {
            this.filters.threat_type = e.target.value;
            this.filters.page = 1;
            this.loadData();
        });

        typeGroup.appendChild(typeSelect);
        bar.appendChild(typeGroup);

        // Min risk filter
        const riskGroup = document.createElement('div');
        riskGroup.className = 'filter-group';

        const riskLabel = document.createElement('label');
        riskLabel.textContent = 'Min Risk';
        riskGroup.appendChild(riskLabel);

        const riskSelect = document.createElement('select');
        riskSelect.className = 'filter-select';

        const risks = [
            { value: 0, label: 'All' },
            { value: 40, label: 'Medium+' },
            { value: 60, label: 'High+' },
            { value: 80, label: 'Critical' },
        ];

        risks.forEach(risk => {
            const option = document.createElement('option');
            option.value = risk.value;
            option.textContent = risk.label;
            if (risk.value === this.filters.min_risk) {
                option.selected = true;
            }
            riskSelect.appendChild(option);
        });

        riskSelect.addEventListener('change', (e) => {
            this.filters.min_risk = parseInt(e.target.value, 10);
            this.filters.page = 1;
            this.loadData();
        });

        riskGroup.appendChild(riskSelect);
        bar.appendChild(riskGroup);
    },

    getUniqueCategories() {
        // Get unique threat types from loaded data
        const items = this.data?.items || [];
        const types = new Set();

        items.forEach(item => {
            if (item.threat_type) {
                types.add(item.threat_type);
            }
        });

        return Array.from(types).sort();
    },

    formatCategoryLabel(category) {
        // Convert snake_case to Title Case
        if (!category) return 'Unknown';
        return category
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    },

    async loadData() {
        const content = document.getElementById('threats-content');
        if (!content) return;

        content.textContent = '';

        // Loading state
        const loading = document.createElement('div');
        loading.className = 'loading-container';
        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        loading.appendChild(spinner);
        content.appendChild(loading);

        try {
            this.data = await API.getThreats(this.filters);
            this.renderContent(content);
        } catch (error) {
            this.renderError(content, error);
        }
    },

    renderContent(container) {
        container.textContent = '';

        const threats = this.data.items || this.data.threats || [];

        if (threats.length === 0) {
            this.renderEmptyState(container);
            return;
        }

        // Threats table
        const tableWrapper = document.createElement('div');
        tableWrapper.className = 'table-wrapper';

        const table = document.createElement('table');
        table.className = 'data-table';

        // Header
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');

        const headers = ['Indicator', 'Type', 'Risk Score', 'First Seen', 'Actions'];
        headers.forEach(text => {
            const th = document.createElement('th');
            th.textContent = text;
            headerRow.appendChild(th);
        });

        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Body
        const tbody = document.createElement('tbody');

        threats.forEach(threat => {
            const row = document.createElement('tr');

            // Indicator (use text content if available)
            const indicatorCell = document.createElement('td');
            indicatorCell.className = 'indicator-cell';
            const indicator = document.createElement('code');
            indicator.className = 'indicator';
            const indicatorText = threat.indicator || threat.name || threat.text_preview || threat.text || 'Unknown';
            indicator.textContent = indicatorText.length > 60 ? indicatorText.substring(0, 60) + '...' : indicatorText;
            indicator.title = indicatorText;
            indicatorCell.appendChild(indicator);
            row.appendChild(indicatorCell);

            // Type
            const typeCell = document.createElement('td');
            const typeBadge = document.createElement('span');
            typeBadge.className = 'type-badge';
            typeBadge.textContent = threat.threat_type || 'Unknown';
            typeCell.appendChild(typeBadge);
            row.appendChild(typeCell);

            // Risk Score
            const riskCell = document.createElement('td');
            const riskBadge = document.createElement('span');
            riskBadge.className = 'risk-badge risk-' + this.getRiskLevel(threat.risk_score);
            riskBadge.textContent = (threat.risk_score || 0) + '%';
            riskCell.appendChild(riskBadge);
            row.appendChild(riskCell);

            // First Seen
            const dateCell = document.createElement('td');
            dateCell.textContent = this.formatDate(threat.first_seen || threat.created_at);
            row.appendChild(dateCell);

            // Actions
            const actionsCell = document.createElement('td');
            const viewBtn = document.createElement('button');
            viewBtn.className = 'btn btn-small';
            viewBtn.textContent = 'View';
            viewBtn.addEventListener('click', () => this.showThreatDetails(threat));
            actionsCell.appendChild(viewBtn);
            row.appendChild(actionsCell);

            tbody.appendChild(row);
        });

        table.appendChild(tbody);
        tableWrapper.appendChild(table);
        container.appendChild(tableWrapper);

        // Pagination
        if (this.data.total_pages > 1) {
            const pagination = this.createPagination();
            container.appendChild(pagination);
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
            this.loadData();
        });
        pagination.appendChild(prevBtn);

        const pageInfo = document.createElement('span');
        pageInfo.className = 'page-info';
        pageInfo.textContent = 'Page ' + this.filters.page + ' of ' + (this.data.total_pages || 1);
        pagination.appendChild(pageInfo);

        const nextBtn = document.createElement('button');
        nextBtn.className = 'btn btn-small';
        nextBtn.textContent = 'Next';
        nextBtn.disabled = this.filters.page >= (this.data.total_pages || 1);
        nextBtn.addEventListener('click', () => {
            this.filters.page++;
            this.loadData();
        });
        pagination.appendChild(nextBtn);

        return pagination;
    },

    showThreatDetails(threat) {
        const content = document.createElement('div');
        content.className = 'threat-details';

        // Risk badge at top
        const riskHeader = document.createElement('div');
        riskHeader.className = 'threat-detail-risk';
        const riskBadge = document.createElement('span');
        riskBadge.className = 'risk-badge risk-' + this.getRiskLevel(threat.risk_score);
        riskBadge.textContent = (threat.risk_score || 0) + '% Risk';
        riskHeader.appendChild(riskBadge);
        const typeBadge = document.createElement('span');
        typeBadge.className = 'type-badge';
        typeBadge.textContent = threat.threat_type || 'Unknown';
        typeBadge.style.marginLeft = '8px';
        riskHeader.appendChild(typeBadge);
        content.appendChild(riskHeader);

        // Content preview
        const textContent = threat.text_content || threat.text_preview || threat.indicator || threat.name || '';
        if (textContent) {
            const textSection = document.createElement('div');
            textSection.className = 'threat-detail-section';

            const textLabel = document.createElement('div');
            textLabel.className = 'detail-section-label';
            textLabel.textContent = 'Analyzed Content';
            textSection.appendChild(textLabel);

            const textBox = document.createElement('div');
            textBox.className = 'threat-detail-text';
            textBox.textContent = textContent;
            textSection.appendChild(textBox);

            content.appendChild(textSection);
        }

        // Details grid
        const detailsSection = document.createElement('div');
        detailsSection.className = 'threat-detail-section';

        const detailsLabel = document.createElement('div');
        detailsLabel.className = 'detail-section-label';
        detailsLabel.textContent = 'Details';
        detailsSection.appendChild(detailsLabel);

        const fields = [
            { label: 'Confidence', value: (threat.confidence || 0) + '%' },
            { label: 'First Seen', value: this.formatDate(threat.first_seen || threat.created_at) },
            { label: 'Processing Time', value: (threat.processing_time_ms || 0) + 'ms' },
            { label: 'Source', value: threat.source_identifier || 'Local' },
        ];

        const grid = document.createElement('div');
        grid.className = 'detail-grid';

        fields.forEach(field => {
            if (!field.value) return;

            const row = document.createElement('div');
            row.className = 'detail-row';

            const label = document.createElement('span');
            label.className = 'detail-label';
            label.textContent = field.label;
            row.appendChild(label);

            const value = document.createElement('span');
            value.className = 'detail-value';
            value.textContent = field.value;
            row.appendChild(value);

            grid.appendChild(row);
        });

        detailsSection.appendChild(grid);
        content.appendChild(detailsSection);

        // Matched rules
        if (threat.matched_rules && threat.matched_rules.length > 0) {
            const rulesSection = document.createElement('div');
            rulesSection.className = 'threat-detail-section';

            const rulesLabel = document.createElement('div');
            rulesLabel.className = 'detail-section-label';
            rulesLabel.textContent = 'Matched Rules (' + threat.matched_rules.length + ')';
            rulesSection.appendChild(rulesLabel);

            const rulesList = document.createElement('div');
            rulesList.className = 'matched-rules-list';

            threat.matched_rules.forEach(rule => {
                const ruleItem = document.createElement('div');
                ruleItem.className = 'matched-rule-item';

                const ruleName = document.createElement('div');
                ruleName.className = 'matched-rule-name';
                ruleName.textContent = rule.rule_name || rule.name || rule.rule_id || 'Unknown Rule';
                ruleItem.appendChild(ruleName);

                if (rule.category) {
                    const ruleCat = document.createElement('span');
                    ruleCat.className = 'matched-rule-cat';
                    ruleCat.textContent = rule.category;
                    ruleItem.appendChild(ruleCat);
                }

                rulesList.appendChild(ruleItem);
            });

            rulesSection.appendChild(rulesList);
            content.appendChild(rulesSection);
        }

        // LLM Review Analytics (if LLM review was performed)
        if (threat.llm_reviewed) {
            const llmSection = document.createElement('div');
            llmSection.className = 'threat-detail-section llm-review-section';

            const llmHeader = document.createElement('div');
            llmHeader.className = 'detail-section-label llm-section-header';

            const llmIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            llmIcon.setAttribute('viewBox', '0 0 24 24');
            llmIcon.setAttribute('fill', 'none');
            llmIcon.setAttribute('stroke', 'currentColor');
            llmIcon.setAttribute('stroke-width', '2');
            llmIcon.setAttribute('class', 'llm-icon');
            const llmPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            llmPath.setAttribute('d', 'M12 2a10 10 0 1 0 10 10H12V2zM12 12l6-6');
            llmIcon.appendChild(llmPath);
            llmHeader.appendChild(llmIcon);

            const llmTitle = document.createElement('span');
            llmTitle.textContent = 'LLM Review';
            llmHeader.appendChild(llmTitle);

            // Model badge
            if (threat.llm_model_used) {
                const modelBadge = document.createElement('span');
                modelBadge.className = 'llm-model-badge';
                modelBadge.textContent = threat.llm_model_used;
                llmHeader.appendChild(modelBadge);
            }

            llmSection.appendChild(llmHeader);

            // LLM Verdict
            const verdictRow = document.createElement('div');
            verdictRow.className = 'llm-verdict-row';

            const verdictLabel = document.createElement('span');
            verdictLabel.className = 'llm-verdict-label';
            verdictLabel.textContent = 'LLM Verdict:';
            verdictRow.appendChild(verdictLabel);

            const verdictBadge = document.createElement('span');
            verdictBadge.className = 'llm-verdict-badge ' + (threat.llm_agrees ? 'agrees' : 'disagrees');
            verdictBadge.textContent = threat.llm_agrees ? 'Agrees with Detection' : 'Disagrees';
            verdictRow.appendChild(verdictBadge);

            llmSection.appendChild(verdictRow);

            // LLM Confidence
            if (threat.llm_confidence !== undefined) {
                const confRow = document.createElement('div');
                confRow.className = 'llm-stat-row';

                const confLabel = document.createElement('span');
                confLabel.className = 'llm-stat-label';
                confLabel.textContent = 'LLM Confidence';
                confRow.appendChild(confLabel);

                const confValue = document.createElement('span');
                confValue.className = 'llm-stat-value';
                confValue.textContent = Math.round(threat.llm_confidence * 100) + '%';
                confRow.appendChild(confValue);

                llmSection.appendChild(confRow);
            }

            // Risk Adjustment
            if (threat.llm_risk_adjustment && threat.llm_risk_adjustment !== 0) {
                const adjRow = document.createElement('div');
                adjRow.className = 'llm-stat-row';

                const adjLabel = document.createElement('span');
                adjLabel.className = 'llm-stat-label';
                adjLabel.textContent = 'Risk Adjustment';
                adjRow.appendChild(adjLabel);

                const adjValue = document.createElement('span');
                adjValue.className = 'llm-stat-value ' + (threat.llm_risk_adjustment > 0 ? 'risk-up' : 'risk-down');
                adjValue.textContent = (threat.llm_risk_adjustment > 0 ? '+' : '') + threat.llm_risk_adjustment + '%';
                adjRow.appendChild(adjValue);

                llmSection.appendChild(adjRow);
            }

            // LLM Recommendation
            if (threat.llm_recommendation) {
                const recBox = document.createElement('div');
                recBox.className = 'llm-recommendation-box';

                const recLabel = document.createElement('div');
                recLabel.className = 'llm-recommendation-label';
                recLabel.textContent = 'Recommended Action';
                recBox.appendChild(recLabel);

                const recText = document.createElement('div');
                recText.className = 'llm-recommendation-text';
                recText.textContent = threat.llm_recommendation;
                recBox.appendChild(recText);

                llmSection.appendChild(recBox);
            }

            // LLM Reasoning
            if (threat.llm_reasoning || threat.llm_explanation) {
                const reasoningBox = document.createElement('div');
                reasoningBox.className = 'llm-reasoning-box';

                const reasoningLabel = document.createElement('div');
                reasoningLabel.className = 'llm-reasoning-label';
                reasoningLabel.textContent = 'LLM Analysis';
                reasoningBox.appendChild(reasoningLabel);

                const reasoningText = document.createElement('div');
                reasoningText.className = 'llm-reasoning-text';
                reasoningText.textContent = threat.llm_reasoning || threat.llm_explanation;
                reasoningBox.appendChild(reasoningText);

                llmSection.appendChild(reasoningBox);
            }

            content.appendChild(llmSection);
        }

        // Use side drawer instead of modal
        SideDrawer.show({
            title: 'Threat Details',
            content: content,
        });
    },

    getRiskLevel(score) {
        if (score >= 80) return 'critical';
        if (score >= 60) return 'high';
        if (score >= 40) return 'medium';
        return 'low';
    },

    formatDate(dateStr) {
        if (!dateStr) return '-';
        try {
            const date = new Date(dateStr);
            return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (e) {
            return dateStr;
        }
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
        path.setAttribute('d', 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z');
        svg.appendChild(path);
        iconWrapper.appendChild(svg);
        empty.appendChild(iconWrapper);

        const title = document.createElement('div');
        title.className = 'empty-state-title';
        title.textContent = 'No Threat Analytics';
        empty.appendChild(title);

        const text = document.createElement('p');
        text.className = 'empty-state-text';
        text.textContent = 'No threats have been detected yet. Use the Test Analyze feature in Settings to analyze content.';
        empty.appendChild(text);

        const btn = document.createElement('button');
        btn.className = 'btn btn-primary';
        btn.textContent = 'Go to Settings';
        btn.addEventListener('click', () => {
            if (window.Sidebar) Sidebar.navigate('settings');
        });
        empty.appendChild(btn);

        container.appendChild(empty);
    },

    renderError(container, error) {
        container.textContent = '';

        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-state';

        const message = document.createElement('p');
        message.textContent = 'Failed to load threats';
        errorDiv.appendChild(message);

        const retry = document.createElement('button');
        retry.className = 'btn btn-primary';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => this.loadData());
        errorDiv.appendChild(retry);

        container.appendChild(errorDiv);
    },
};

window.ThreatsPage = ThreatsPage;
