/**
 * Dashboard Page
 * Overview with stats and recent activity
 */

const DashboardPage = {
    data: null,

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
            this.data = await API.getThreatAnalytics();
            this.renderContent(container);
        } catch (error) {
            this.renderError(container, error);
        }
    },

    renderContent(container) {
        container.textContent = '';

        // Stats grid
        const statsGrid = document.createElement('div');
        statsGrid.className = 'stats-grid';

        const stats = [
            {
                value: this.data.total_threats || 0,
                label: 'Total Threats',
                icon: 'shield',
            },
            {
                value: this.data.critical_count || 0,
                label: 'Critical',
                icon: 'alert',
            },
            {
                value: this.data.blocked_count || 0,
                label: 'Blocked',
                icon: 'check',
            },
            {
                value: this.data.active_rules || 0,
                label: 'Active Rules',
                icon: 'activity',
            },
        ];

        stats.forEach(stat => {
            statsGrid.appendChild(Card.createStat(stat));
        });

        container.appendChild(statsGrid);

        // Two column layout
        const grid = document.createElement('div');
        grid.className = 'dashboard-grid';

        // Recent threats card
        const threatsCard = Card.create({
            title: 'Recent Threats',
            gradient: true,
        });
        this.renderRecentThreats(threatsCard.querySelector('.card-body'));
        grid.appendChild(threatsCard);

        // Threat types card
        const typesCard = Card.create({
            title: 'Threat Types',
            gradient: true,
        });
        this.renderThreatTypes(typesCard.querySelector('.card-body'));
        grid.appendChild(typesCard);

        container.appendChild(grid);
    },

    renderRecentThreats(container) {
        const threats = this.data.recent_threats || [];

        if (threats.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'empty-state';
            empty.textContent = 'No recent threats detected';
            container.appendChild(empty);
            return;
        }

        const list = document.createElement('div');
        list.className = 'threat-list';

        threats.slice(0, 5).forEach(threat => {
            const item = document.createElement('div');
            item.className = 'threat-item';

            const info = document.createElement('div');
            info.className = 'threat-info';

            const name = document.createElement('div');
            name.className = 'threat-name';
            name.textContent = threat.name || threat.indicator || 'Unknown';
            info.appendChild(name);

            const type = document.createElement('div');
            type.className = 'threat-type';
            type.textContent = threat.threat_type || 'Unknown';
            info.appendChild(type);

            item.appendChild(info);

            const badge = document.createElement('span');
            badge.className = 'risk-badge risk-' + this.getRiskLevel(threat.risk_score);
            badge.textContent = (threat.risk_score || 0) + '%';
            item.appendChild(badge);

            list.appendChild(item);
        });

        container.appendChild(list);
    },

    renderThreatTypes(container) {
        const types = this.data.threat_types || {};

        if (Object.keys(types).length === 0) {
            const empty = document.createElement('p');
            empty.className = 'empty-state';
            empty.textContent = 'No threat data available';
            container.appendChild(empty);
            return;
        }

        const list = document.createElement('div');
        list.className = 'type-list';

        Object.entries(types).forEach(([type, count]) => {
            const item = document.createElement('div');
            item.className = 'type-item';

            const label = document.createElement('span');
            label.className = 'type-label';
            label.textContent = type;
            item.appendChild(label);

            const countSpan = document.createElement('span');
            countSpan.className = 'type-count';
            countSpan.textContent = count;
            item.appendChild(countSpan);

            list.appendChild(item);
        });

        container.appendChild(list);
    },

    getRiskLevel(score) {
        if (score >= 80) return 'critical';
        if (score >= 60) return 'high';
        if (score >= 40) return 'medium';
        return 'low';
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
