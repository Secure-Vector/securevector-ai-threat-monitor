/**
 * Dashboard Page
 * Enhanced overview with stats, charts, and recent activity
 */

const DashboardPage = {
    data: null,
    threats: null,

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
            // Fetch analytics and recent threats
            const [analytics, threats] = await Promise.all([
                API.getThreatAnalytics(),
                API.getThreats({ page_size: 50 }),
            ]);
            this.data = analytics;
            this.threats = threats.items || [];
            this.renderContent(container);
        } catch (error) {
            this.renderError(container, error);
        }
    },

    renderContent(container) {
        container.textContent = '';

        // Dashboard header with title
        const header = document.createElement('div');
        header.className = 'dashboard-header';

        const title = document.createElement('h1');
        title.className = 'dashboard-title';
        title.textContent = 'Threat Monitor';
        header.appendChild(title);

        const subtitle = document.createElement('p');
        subtitle.className = 'dashboard-subtitle';
        subtitle.textContent = 'Real-time AI threat detection and analysis';
        header.appendChild(subtitle);

        container.appendChild(header);

        // Stats grid
        const statsGrid = document.createElement('div');
        statsGrid.className = 'stats-grid';

        const stats = [
            {
                value: this.data.total_threats || 0,
                label: 'Total Threats',
                icon: 'shield',
                color: 'primary',
            },
            {
                value: this.data.critical_count || 0,
                label: 'Critical',
                icon: 'alert',
                color: 'danger',
            },
            {
                value: this.data.active_rules || 0,
                label: 'Active Rules',
                icon: 'activity',
                color: 'success',
            },
            {
                value: this.getAverageRiskScore(),
                label: 'Avg Risk Score',
                icon: 'gauge',
                color: this.getRiskColor(this.getAverageRiskScore()),
                suffix: '%',
            },
        ];

        stats.forEach(stat => {
            statsGrid.appendChild(this.createStatCard(stat));
        });

        container.appendChild(statsGrid);

        // Charts row
        const chartsRow = document.createElement('div');
        chartsRow.className = 'dashboard-charts-row';

        // Risk Distribution Chart
        const riskCard = Card.create({
            title: 'Risk Distribution',
            gradient: true,
        });
        this.renderRiskDistribution(riskCard.querySelector('.card-body'));
        chartsRow.appendChild(riskCard);

        // Threat Types Chart
        const typesCard = Card.create({
            title: 'Threat Categories',
            gradient: true,
        });
        this.renderThreatTypes(typesCard.querySelector('.card-body'));
        chartsRow.appendChild(typesCard);

        container.appendChild(chartsRow);

        // Recent activity
        const activityCard = Card.create({
            title: 'Recent Threat Activity',
            gradient: true,
        });
        this.renderRecentActivity(activityCard.querySelector('.card-body'));
        container.appendChild(activityCard);
    },

    createStatCard(stat) {
        const card = document.createElement('div');
        card.className = 'stat-card stat-' + (stat.color || 'primary');

        const iconWrap = document.createElement('div');
        iconWrap.className = 'stat-icon';
        iconWrap.appendChild(this.createIcon(stat.icon));
        card.appendChild(iconWrap);

        const content = document.createElement('div');
        content.className = 'stat-content';

        const value = document.createElement('div');
        value.className = 'stat-value';
        value.textContent = stat.value + (stat.suffix || '');
        content.appendChild(value);

        const label = document.createElement('div');
        label.className = 'stat-label';
        label.textContent = stat.label;
        content.appendChild(label);

        card.appendChild(content);
        return card;
    },

    createIcon(name) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');

        const paths = {
            shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
            alert: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
            activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
            gauge: 'M12 2a10 10 0 1 0 10 10H12V2zM12 12l6-6',
            check: 'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3',
        };

        const pathData = paths[name] || paths.shield;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', pathData);
        svg.appendChild(path);

        return svg;
    },

    getAverageRiskScore() {
        if (!this.threats || this.threats.length === 0) return 0;
        const total = this.threats.reduce((sum, t) => sum + (t.risk_score || 0), 0);
        return Math.round(total / this.threats.length);
    },

    getRiskColor(score) {
        if (score >= 80) return 'danger';
        if (score >= 60) return 'warning';
        if (score >= 40) return 'info';
        return 'success';
    },

    renderRiskDistribution(container) {
        // Group threats by risk level
        const levels = { critical: 0, high: 0, medium: 0, low: 0 };

        this.threats.forEach(t => {
            const score = t.risk_score || 0;
            if (score >= 80) levels.critical++;
            else if (score >= 60) levels.high++;
            else if (score >= 40) levels.medium++;
            else levels.low++;
        });

        const total = Object.values(levels).reduce((a, b) => a + b, 0);

        if (total === 0) {
            const empty = document.createElement('p');
            empty.className = 'empty-state-inline';
            empty.textContent = 'No threat data yet';
            container.appendChild(empty);
            return;
        }

        const chart = document.createElement('div');
        chart.className = 'risk-donut-chart';

        // Donut chart visualization
        const donut = document.createElement('div');
        donut.className = 'donut-container';

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('class', 'donut-svg');

        let currentAngle = -90;
        const colors = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#60a5fa' };
        const radius = 40;
        const cx = 50, cy = 50;

        Object.entries(levels).forEach(([level, count]) => {
            if (count === 0) return;

            const angle = (count / total) * 360;
            const startAngle = currentAngle;
            const endAngle = currentAngle + angle;

            const x1 = cx + radius * Math.cos((startAngle * Math.PI) / 180);
            const y1 = cy + radius * Math.sin((startAngle * Math.PI) / 180);
            const x2 = cx + radius * Math.cos((endAngle * Math.PI) / 180);
            const y2 = cy + radius * Math.sin((endAngle * Math.PI) / 180);

            const largeArc = angle > 180 ? 1 : 0;

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M ' + cx + ' ' + cy + ' L ' + x1 + ' ' + y1 + ' A ' + radius + ' ' + radius + ' 0 ' + largeArc + ' 1 ' + x2 + ' ' + y2 + ' Z');
            path.setAttribute('fill', colors[level]);
            path.setAttribute('class', 'donut-segment');
            svg.appendChild(path);

            currentAngle = endAngle;
        });

        // Center hole
        const hole = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        hole.setAttribute('cx', '50');
        hole.setAttribute('cy', '50');
        hole.setAttribute('r', '25');
        hole.setAttribute('fill', 'var(--bg-secondary)');
        svg.appendChild(hole);

        // Center text
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', '50');
        text.setAttribute('y', '53');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', 'var(--text-primary)');
        text.setAttribute('font-size', '14');
        text.setAttribute('font-weight', '600');
        text.textContent = total;
        svg.appendChild(text);

        donut.appendChild(svg);
        chart.appendChild(donut);

        // Legend
        const legend = document.createElement('div');
        legend.className = 'chart-legend';

        Object.entries(levels).forEach(([level, count]) => {
            const item = document.createElement('div');
            item.className = 'legend-item';

            const dot = document.createElement('span');
            dot.className = 'legend-dot';
            dot.style.background = colors[level];
            item.appendChild(dot);

            const label = document.createElement('span');
            label.className = 'legend-label';
            label.textContent = level.charAt(0).toUpperCase() + level.slice(1);
            item.appendChild(label);

            const value = document.createElement('span');
            value.className = 'legend-value';
            value.textContent = count;
            item.appendChild(value);

            legend.appendChild(item);
        });

        chart.appendChild(legend);
        container.appendChild(chart);
    },

    renderThreatTypes(container) {
        const types = this.data.threat_types || {};

        if (Object.keys(types).length === 0) {
            const empty = document.createElement('p');
            empty.className = 'empty-state-inline';
            empty.textContent = 'No threat categories yet';
            container.appendChild(empty);
            return;
        }

        const entries = Object.entries(types).sort((a, b) => b[1] - a[1]);
        const maxCount = Math.max(...entries.map(e => e[1]));

        const chart = document.createElement('div');
        chart.className = 'horizontal-bar-chart';

        entries.slice(0, 5).forEach(([type, count], index) => {
            const row = document.createElement('div');
            row.className = 'bar-row';

            const label = document.createElement('div');
            label.className = 'bar-label';
            label.textContent = this.formatType(type);
            row.appendChild(label);

            const barWrap = document.createElement('div');
            barWrap.className = 'bar-wrap';

            const bar = document.createElement('div');
            bar.className = 'bar bar-' + (index % 4);
            const percentage = maxCount > 0 ? (count / maxCount) * 100 : 0;
            bar.style.width = '0%';
            // Animate bar
            setTimeout(() => {
                bar.style.width = percentage + '%';
            }, 100 + index * 50);
            barWrap.appendChild(bar);

            const countEl = document.createElement('span');
            countEl.className = 'bar-count';
            countEl.textContent = count;
            barWrap.appendChild(countEl);

            row.appendChild(barWrap);
            chart.appendChild(row);
        });

        container.appendChild(chart);
    },

    renderRecentActivity(container) {
        const threats = this.threats.slice(0, 8);

        if (threats.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-state-inline';

            const emptyText = document.createElement('p');
            emptyText.textContent = 'No recent activity';
            empty.appendChild(emptyText);

            const emptySubtext = document.createElement('p');
            emptySubtext.className = 'empty-subtext';
            emptySubtext.textContent = 'Threats will appear here when detected';
            empty.appendChild(emptySubtext);

            container.appendChild(empty);
            return;
        }

        const table = document.createElement('div');
        table.className = 'activity-table';

        // Header
        const header = document.createElement('div');
        header.className = 'activity-header';

        const cols = ['Content', 'Type', 'Risk', 'Time'];
        cols.forEach(col => {
            const cell = document.createElement('div');
            cell.className = 'activity-cell';
            cell.textContent = col;
            header.appendChild(cell);
        });
        table.appendChild(header);

        // Rows
        threats.forEach(threat => {
            const row = document.createElement('div');
            row.className = 'activity-row';

            // Content preview
            const contentCell = document.createElement('div');
            contentCell.className = 'activity-cell content-cell';
            const content = threat.text_preview || threat.text_content || threat.indicator || threat.name || 'Analyzed content';
            contentCell.textContent = content.length > 50 ? content.substring(0, 50) + '...' : content;
            contentCell.title = content;
            row.appendChild(contentCell);

            // Type
            const typeCell = document.createElement('div');
            typeCell.className = 'activity-cell';
            const typeBadge = document.createElement('span');
            typeBadge.className = 'type-badge-small';
            typeBadge.textContent = this.formatType(threat.threat_type || 'detected');
            typeCell.appendChild(typeBadge);
            row.appendChild(typeCell);

            // Risk
            const riskCell = document.createElement('div');
            riskCell.className = 'activity-cell';
            const riskBadge = document.createElement('span');
            riskBadge.className = 'risk-badge risk-' + this.getRiskLevel(threat.risk_score);
            riskBadge.textContent = (threat.risk_score || 0) + '%';
            riskCell.appendChild(riskBadge);
            row.appendChild(riskCell);

            // Time
            const timeCell = document.createElement('div');
            timeCell.className = 'activity-cell time-cell';
            timeCell.textContent = this.formatTime(threat.created_at || threat.first_seen);
            row.appendChild(timeCell);

            row.addEventListener('click', () => {
                if (window.Sidebar) Sidebar.navigate('threats');
            });

            table.appendChild(row);
        });

        container.appendChild(table);
    },

    formatType(type) {
        if (!type || type === 'unknown') return 'Detected';
        return type
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    },

    formatTime(dateStr) {
        if (!dateStr) return '-';
        try {
            const date = new Date(dateStr);
            const now = new Date();
            const diffMs = now - date;
            const diffMins = Math.floor(diffMs / 60000);

            if (diffMins < 1) return 'Just now';
            if (diffMins < 60) return diffMins + 'm ago';
            if (diffMins < 1440) return Math.floor(diffMins / 60) + 'h ago';
            return Math.floor(diffMins / 1440) + 'd ago';
        } catch (e) {
            return '-';
        }
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
