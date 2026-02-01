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

            // Indicator
            const indicatorCell = document.createElement('td');
            const indicator = document.createElement('code');
            indicator.className = 'indicator';
            indicator.textContent = threat.indicator || threat.name || 'Unknown';
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

        const fields = [
            { label: 'Indicator', value: threat.indicator || threat.name },
            { label: 'Type', value: threat.threat_type },
            { label: 'Risk Score', value: (threat.risk_score || 0) + '%' },
            { label: 'Confidence', value: (threat.confidence || 0) + '%' },
            { label: 'First Seen', value: this.formatDate(threat.first_seen || threat.created_at) },
            { label: 'Last Seen', value: this.formatDate(threat.last_seen || threat.updated_at) },
            { label: 'Source', value: threat.source || 'Local' },
        ];

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

            content.appendChild(row);
        });

        if (threat.description) {
            const descDiv = document.createElement('div');
            descDiv.className = 'detail-description';

            const descLabel = document.createElement('strong');
            descLabel.textContent = 'Description';
            descDiv.appendChild(descLabel);

            const descText = document.createElement('p');
            descText.textContent = threat.description;
            descDiv.appendChild(descText);

            content.appendChild(descDiv);
        }

        Modal.show({
            title: 'Threat Details',
            content: content,
            size: 'medium',
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
