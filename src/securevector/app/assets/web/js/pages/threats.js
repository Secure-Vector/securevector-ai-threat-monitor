/**
 * Threats Page
 * Threat analytics and intel listing
 */

const ThreatsPage = {
    data: null,
    filters: {
        page: 1,
        page_size: 20,
        threat_type: '',
        min_risk: 0,
    },

    async render(container) {
        container.textContent = '';

        // Filters bar
        const filtersBar = this.createFiltersBar();
        container.appendChild(filtersBar);

        // Content area
        const content = document.createElement('div');
        content.id = 'threats-content';
        container.appendChild(content);

        await this.loadData();
    },

    createFiltersBar() {
        const bar = document.createElement('div');
        bar.className = 'filters-bar';

        // Threat type filter
        const typeGroup = document.createElement('div');
        typeGroup.className = 'filter-group';

        const typeLabel = document.createElement('label');
        typeLabel.textContent = 'Type';
        typeGroup.appendChild(typeLabel);

        const typeSelect = document.createElement('select');
        typeSelect.className = 'filter-select';

        const types = ['All Types', 'malware', 'phishing', 'botnet', 'ransomware', 'apt'];
        types.forEach((type, i) => {
            const option = document.createElement('option');
            option.value = i === 0 ? '' : type;
            option.textContent = i === 0 ? type : type.charAt(0).toUpperCase() + type.slice(1);
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
            riskSelect.appendChild(option);
        });

        riskSelect.addEventListener('change', (e) => {
            this.filters.min_risk = parseInt(e.target.value, 10);
            this.filters.page = 1;
            this.loadData();
        });

        riskGroup.appendChild(riskSelect);
        bar.appendChild(riskGroup);

        return bar;
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
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.textContent = 'No threats found matching your criteria';
            container.appendChild(empty);
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
