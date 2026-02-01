/**
 * Header Component
 * Displays app title, server status, and theme toggle
 */

const Header = {
    serverStatus: 'checking',

    render() {
        const container = document.getElementById('header');
        if (!container) return;

        container.textContent = '';

        // Left side - page title
        const left = document.createElement('div');
        left.className = 'header-left';

        const title = document.createElement('h1');
        title.className = 'header-title';
        title.textContent = this.getPageTitle();
        left.appendChild(title);

        container.appendChild(left);

        // Right side - status and theme toggle
        const right = document.createElement('div');
        right.className = 'header-right';

        // Server status indicator
        const statusBadge = document.createElement('div');
        statusBadge.className = 'status-badge ' + this.serverStatus;
        statusBadge.id = 'server-status';

        const statusDot = document.createElement('span');
        statusDot.className = 'status-dot';
        statusBadge.appendChild(statusDot);

        const statusText = document.createElement('span');
        statusText.textContent = this.getStatusText();
        statusBadge.appendChild(statusText);

        right.appendChild(statusBadge);

        // Theme toggle
        const themeToggle = document.createElement('button');
        themeToggle.className = 'theme-toggle';
        themeToggle.setAttribute('aria-label', 'Toggle theme');
        themeToggle.appendChild(this.createThemeIcon());
        themeToggle.addEventListener('click', () => this.toggleTheme());

        right.appendChild(themeToggle);

        container.appendChild(right);

        // Check server status
        this.checkStatus();
    },

    getPageTitle() {
        const titles = {
            dashboard: 'Dashboard',
            threats: 'Threat Analytics',
            rules: 'Rules',
            settings: 'Settings',
        };
        const currentPage = window.Sidebar ? Sidebar.currentPage : 'dashboard';
        return titles[currentPage] || 'Dashboard';
    },

    getStatusText() {
        const texts = {
            checking: 'Checking...',
            healthy: 'Server Online',
            degraded: 'Degraded',
            offline: 'Offline',
        };
        return texts[this.serverStatus] || 'Unknown';
    },

    createThemeIcon() {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');

        if (isDark) {
            // Sun icon for dark mode (click to go light)
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', '12');
            circle.setAttribute('cy', '12');
            circle.setAttribute('r', '5');
            svg.appendChild(circle);

            const rays = [
                'M12 1v2', 'M12 21v2', 'M4.22 4.22l1.42 1.42',
                'M18.36 18.36l1.42 1.42', 'M1 12h2', 'M21 12h2',
                'M4.22 19.78l1.42-1.42', 'M18.36 5.64l1.42-1.42'
            ];
            rays.forEach(d => {
                const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                line.setAttribute('d', d);
                svg.appendChild(line);
            });
        } else {
            // Moon icon for light mode (click to go dark)
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z');
            svg.appendChild(path);
        }

        return svg;
    },

    async toggleTheme() {
        const html = document.documentElement;
        const currentTheme = html.getAttribute('data-theme') || 'dark';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

        html.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);

        // Update server
        try {
            await API.setTheme(newTheme);
        } catch (e) {
            // Ignore errors, local storage is sufficient
        }

        // Re-render to update icon
        this.render();
    },

    async checkStatus() {
        try {
            const health = await API.health();
            this.serverStatus = health.status || 'healthy';
        } catch (e) {
            this.serverStatus = 'offline';
        }
        this.updateStatusBadge();
    },

    updateStatusBadge() {
        const badge = document.getElementById('server-status');
        if (!badge) return;

        badge.className = 'status-badge ' + this.serverStatus;
        const textSpan = badge.querySelector('span:last-child');
        if (textSpan) {
            textSpan.textContent = this.getStatusText();
        }
    },

    updateTitle() {
        const title = document.querySelector('.header-title');
        if (title) {
            title.textContent = this.getPageTitle();
        }
    },
};

window.Header = Header;
