/**
 * SecureVector Web Application
 * Main application entry point
 */

const App = {
    currentPage: 'dashboard',

    pages: {
        dashboard: DashboardPage,
        threats: ThreatsPage,
        rules: RulesPage,
        proxy: ProxyPage,
        settings: SettingsPage,
    },

    /**
     * Initialize the application
     */
    async init() {
        // Load saved theme
        this.loadTheme();

        // Render components
        Sidebar.render();
        Header.render();

        // Load initial page
        await this.loadPage('dashboard');
    },

    /**
     * Load saved theme from localStorage
     */
    loadTheme() {
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme) {
            document.documentElement.setAttribute('data-theme', savedTheme);
        }
    },

    /**
     * Navigate to a page
     * @param {string} page - Page name
     */
    async loadPage(page) {
        const pageHandler = this.pages[page];
        if (!pageHandler) {
            console.error('Unknown page:', page);
            return;
        }

        this.currentPage = page;

        // Update sidebar
        if (window.Sidebar) {
            Sidebar.setActive(page);
        }

        // Update header title
        if (window.Header) {
            Header.updateTitle();
        }

        // Get content container
        const container = document.getElementById('page-content');
        if (!container) {
            console.error('Page content container not found');
            return;
        }

        // Render page
        try {
            await pageHandler.render(container);
        } catch (error) {
            console.error('Failed to render page:', error);
            this.renderError(container, error);
        }
    },

    /**
     * Render an error state
     * @param {HTMLElement} container - Container element
     * @param {Error} error - Error object
     */
    renderError(container, error) {
        container.textContent = '';

        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-state';

        const icon = document.createElement('div');
        icon.className = 'error-icon';
        icon.textContent = '!';
        errorDiv.appendChild(icon);

        const message = document.createElement('p');
        message.textContent = 'Something went wrong';
        errorDiv.appendChild(message);

        const details = document.createElement('p');
        details.className = 'error-details';
        details.textContent = error.message || 'Unknown error';
        errorDiv.appendChild(details);

        const retry = document.createElement('button');
        retry.className = 'btn btn-primary';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => this.loadPage(this.currentPage));
        errorDiv.appendChild(retry);

        container.appendChild(errorDiv);
    },
};

// Make App globally available
window.App = App;

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    App.init();
});
