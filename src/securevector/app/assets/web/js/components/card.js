/**
 * Card Component
 * Reusable card with optional gradient accent
 */

const Card = {
    /**
     * Create a card element
     * @param {Object} options - Card options
     * @param {string} options.title - Card title
     * @param {string} options.className - Additional CSS classes
     * @param {boolean} options.gradient - Show gradient accent bar
     * @returns {HTMLElement} Card element
     */
    create(options = {}) {
        const card = document.createElement('div');
        card.className = 'card' + (options.className ? ' ' + options.className : '');

        if (options.gradient) {
            card.classList.add('card-gradient');
        }

        if (options.title) {
            const header = document.createElement('div');
            header.className = 'card-header';

            const title = document.createElement('h3');
            title.className = 'card-title';
            title.textContent = options.title;
            header.appendChild(title);

            if (options.actions) {
                const actions = document.createElement('div');
                actions.className = 'card-actions';
                options.actions.forEach(action => {
                    actions.appendChild(action);
                });
                header.appendChild(actions);
            }

            card.appendChild(header);
        }

        const body = document.createElement('div');
        body.className = 'card-body';
        card.appendChild(body);

        return card;
    },

    /**
     * Create a stat card with value and label
     * @param {Object} options - Stat options
     * @param {string} options.value - Main value
     * @param {string} options.label - Description label
     * @param {string} options.icon - Icon name
     * @param {string} options.trend - Trend direction (up/down)
     * @param {string} options.trendValue - Trend percentage
     * @returns {HTMLElement} Stat card element
     */
    createStat(options = {}) {
        const card = document.createElement('div');
        card.className = 'stat-card';

        const content = document.createElement('div');
        content.className = 'stat-content';

        const value = document.createElement('div');
        value.className = 'stat-value';
        value.textContent = options.value || '0';
        content.appendChild(value);

        const label = document.createElement('div');
        label.className = 'stat-label';
        label.textContent = options.label || '';
        content.appendChild(label);

        if (options.trend && options.trendValue) {
            const trend = document.createElement('div');
            trend.className = 'stat-trend ' + options.trend;
            trend.textContent = (options.trend === 'up' ? '+' : '-') + options.trendValue;
            content.appendChild(trend);
        }

        card.appendChild(content);

        if (options.icon) {
            const iconWrapper = document.createElement('div');
            iconWrapper.className = 'stat-icon';
            iconWrapper.appendChild(this.createIcon(options.icon));
            card.appendChild(iconWrapper);
        }

        return card;
    },

    createIcon(name) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');

        const icons = {
            shield: [
                { tag: 'path', attrs: { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' } },
            ],
            alert: [
                { tag: 'path', attrs: { d: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' } },
                { tag: 'line', attrs: { x1: '12', y1: '9', x2: '12', y2: '13' } },
                { tag: 'line', attrs: { x1: '12', y1: '17', x2: '12.01', y2: '17' } },
            ],
            check: [
                { tag: 'polyline', attrs: { points: '20 6 9 17 4 12' } },
            ],
            activity: [
                { tag: 'polyline', attrs: { points: '22 12 18 12 15 21 9 3 6 12 2 12' } },
            ],
        };

        (icons[name] || []).forEach(({ tag, attrs }) => {
            const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
            Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
            svg.appendChild(el);
        });

        return svg;
    },
};

window.Card = Card;
