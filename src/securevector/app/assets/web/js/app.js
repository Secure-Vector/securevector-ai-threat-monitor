/**
 * SecureVector Web Application
 * Main application entry point
 */

const App = {
    currentPage: 'dashboard',

    pages: {
        guide: GettingStartedPage,
        dashboard: DashboardPage,
        threats: ThreatsPage,
        rules: RulesPage,
        'proxy-langchain': { render: (c) => IntegrationPage.render(c, 'proxy-langchain') },
        'proxy-langgraph': { render: (c) => IntegrationPage.render(c, 'proxy-langgraph') },
        'proxy-crewai': { render: (c) => IntegrationPage.render(c, 'proxy-crewai') },
        'proxy-n8n': { render: (c) => IntegrationPage.render(c, 'proxy-n8n') },
        'proxy-ollama': { render: (c) => IntegrationPage.render(c, 'proxy-ollama') },
        'proxy-openclaw': { render: (c) => IntegrationPage.render(c, 'proxy-openclaw') },
        settings: SettingsPage,
        'tool-permissions': ToolPermissionsPage,
        costs: CostsPage,
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

        // Handle browser back/forward
        window.addEventListener('popstate', (e) => {
            const page = e.state?.page || this.getPageFromURL();
            this.loadPage(page, false);
        });

        // Load initial page from URL or default to dashboard
        const initialPage = this.getPageFromURL();
        await this.loadPage(initialPage);

        // Show welcome modal on first launch
        this.showWelcomeIfFirstLaunch();
    },

    /**
     * Get page name from current URL
     */
    getPageFromURL() {
        const path = window.location.pathname.replace(/^\//, '').replace(/\/$/, '');
        return this.pages[path] ? path : 'dashboard';
    },

    /**
     * Show welcome modal on first launch
     */
    showWelcomeIfFirstLaunch() {
        const hasSeenWelcome = localStorage.getItem('sv-welcome-seen');
        // Skip welcome popup if already seen or if ?no-welcome param is present (for screenshots)
        const urlParams = new URLSearchParams(window.location.search);
        if (hasSeenWelcome || urlParams.has('no-welcome')) return;

        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'modal welcome-modal';
        modal.style.cssText = 'max-width: 500px;';

        // Header
        const header = document.createElement('div');
        header.className = 'modal-header';
        header.style.cssText = 'border-bottom: 1px solid var(--border-color); padding-bottom: 16px;';

        const title = document.createElement('h2');
        title.style.cssText = 'margin: 0; display: flex; align-items: center; gap: 10px;';

        const logoImg = document.createElement('img');
        logoImg.src = '/images/favicon.png';
        logoImg.alt = '';
        logoImg.style.cssText = 'width: 28px; height: 28px;';
        title.appendChild(logoImg);

        const titleText = document.createElement('span');
        titleText.textContent = 'Welcome to SecureVector';
        title.appendChild(titleText);

        header.appendChild(title);
        modal.appendChild(header);

        // Content
        const content = document.createElement('div');
        content.className = 'modal-content';
        content.style.cssText = 'padding: 20px 0;';

        const intro = document.createElement('div');
        intro.style.cssText = 'margin: 0 0 20px 0; padding: 12px 16px; background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); border-radius: 8px; color: white; font-weight: 600; text-align: center;';
        intro.textContent = '100% Local AI Threat Detection for Your Agents';
        content.appendChild(intro);

        // Instructions
        const instructionBox = document.createElement('div');
        instructionBox.style.cssText = 'padding: 16px; background: var(--bg-secondary); border-radius: 8px;';

        // Step 1
        const step1 = document.createElement('div');
        step1.style.cssText = 'margin: 0 0 16px 0; font-size: 14px; line-height: 1.6; display: flex; gap: 12px;';

        const step1Num = document.createElement('span');
        step1Num.style.cssText = 'width: 28px; height: 28px; background: var(--accent-primary); color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 600; flex-shrink: 0;';
        step1Num.textContent = '1';
        step1.appendChild(step1Num);

        const step1Content = document.createElement('div');
        const step1Title = document.createElement('div');
        step1Title.style.cssText = 'font-weight: 600; color: var(--text-primary);';
        step1Title.textContent = 'Go to Integrations';
        step1Content.appendChild(step1Title);
        const step1Desc = document.createElement('div');
        step1Desc.style.cssText = 'font-size: 13px; color: var(--text-secondary);';
        step1Desc.textContent = 'Choose your agent framework and LLM provider';
        step1Content.appendChild(step1Desc);
        step1.appendChild(step1Content);

        instructionBox.appendChild(step1);

        // Step 2
        const step2 = document.createElement('div');
        step2.style.cssText = 'margin: 0 0 16px 0; font-size: 14px; line-height: 1.6; display: flex; gap: 12px;';

        const step2Num = document.createElement('span');
        step2Num.style.cssText = 'width: 28px; height: 28px; background: var(--accent-primary); color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 600; flex-shrink: 0;';
        step2Num.textContent = '2';
        step2.appendChild(step2Num);

        const step2Content = document.createElement('div');
        const step2Title = document.createElement('div');
        step2Title.style.cssText = 'font-weight: 600; color: var(--text-primary);';
        step2Title.textContent = 'Start Proxy or Code Integration';
        step2Content.appendChild(step2Title);
        const step2Desc = document.createElement('div');
        step2Desc.style.cssText = 'font-size: 13px; color: var(--text-secondary);';
        step2Desc.textContent = 'Choice is yours - use proxy or integrate via SDK';
        step2Content.appendChild(step2Desc);
        step2.appendChild(step2Content);

        instructionBox.appendChild(step2);

        // Step 3 - AI Analysis
        const step3 = document.createElement('div');
        step3.style.cssText = 'margin: 0; font-size: 14px; line-height: 1.6; display: flex; gap: 12px;';

        const step3Num = document.createElement('span');
        step3Num.style.cssText = 'width: 28px; height: 28px; background: var(--accent-primary); color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 600; flex-shrink: 0;';
        step3Num.textContent = '3';
        step3.appendChild(step3Num);

        const step3Content = document.createElement('div');
        const step3Title = document.createElement('div');
        step3Title.style.cssText = 'font-weight: 600; color: var(--accent-primary);';
        step3Title.textContent = 'AI Analysis (Recommended)';
        step3Content.appendChild(step3Title);
        const step3Desc = document.createElement('div');
        step3Desc.style.cssText = 'font-size: 13px; color: var(--text-secondary);';
        step3Desc.textContent = 'Enable in Settings for enhanced LLM-powered threat detection';
        step3Content.appendChild(step3Desc);
        step3.appendChild(step3Content);

        instructionBox.appendChild(step3);

        content.appendChild(instructionBox);

        modal.appendChild(content);

        // Footer
        const footer = document.createElement('div');
        footer.className = 'modal-footer';
        footer.style.cssText = 'border-top: 1px solid var(--border-color); padding-top: 16px; display: flex; justify-content: flex-end; gap: 8px;';

        const dismissModal = () => {
            localStorage.setItem('sv-welcome-seen', 'true');
            overlay.classList.remove('active');
            setTimeout(() => overlay.remove(), 150);
        };

        const gotItBtn = document.createElement('button');
        gotItBtn.className = 'btn btn-secondary';
        gotItBtn.textContent = 'Got it';
        gotItBtn.addEventListener('click', dismissModal);
        footer.appendChild(gotItBtn);

        const docsBtn = document.createElement('button');
        docsBtn.className = 'btn btn-primary';
        docsBtn.textContent = 'Get Started';
        docsBtn.addEventListener('click', () => {
            dismissModal();
            if (window.Sidebar) Sidebar.navigate('guide');
        });
        footer.appendChild(docsBtn);

        modal.appendChild(footer);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Animate in
        requestAnimationFrame(() => overlay.classList.add('active'));
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
     * @param {boolean} pushState - Whether to update browser history
     */
    async loadPage(page, pushState = true) {
        const pageHandler = this.pages[page];
        if (!pageHandler) {
            console.error('Unknown page:', page);
            return;
        }

        this.currentPage = page;

        // Update URL
        if (pushState) {
            const url = '/' + page;
            history.pushState({ page }, '', url);
        }

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

        // Reset scroll position
        container.scrollTop = 0;

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

/**
 * makeTableSortable — attach click-to-sort to all <th> in a .data-table.
 *
 * Columns with data-no-sort attribute are skipped.
 * Detects numeric values (including $-prefix, K/M suffixes) for numeric sort.
 * Falls back to locale string comparison.
 */
function makeTableSortable(table) {
    const ths = Array.from(table.querySelectorAll('thead th'));
    const state = { col: -1, dir: 'asc' };

    function parseCell(text) {
        const t = text.trim().replace(/^\$/, '');
        const m = t.match(/^([\d.]+)\s*([KkMm]?)$/);
        if (m) {
            const n = parseFloat(m[1]);
            const s = m[2].toUpperCase();
            if (s === 'K') return n * 1_000;
            if (s === 'M') return n * 1_000_000;
            if (!isNaN(n)) return n;
        }
        return t.toLowerCase();
    }

    ths.forEach((th, idx) => {
        if (th.hasAttribute('data-no-sort')) return;
        th.classList.add('sortable');
        th.addEventListener('click', () => {
            if (state.col === idx) {
                state.dir = state.dir === 'asc' ? 'desc' : 'asc';
            } else {
                state.col = idx;
                state.dir = 'asc';
            }
            ths.forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
            th.classList.add(state.dir === 'asc' ? 'sort-asc' : 'sort-desc');

            const tbody = table.querySelector('tbody');
            const rows = Array.from(tbody.querySelectorAll('tr'));
            rows.sort((a, b) => {
                const va = parseCell(a.cells[idx]?.textContent ?? '');
                const vb = parseCell(b.cells[idx]?.textContent ?? '');
                if (typeof va === 'number' && typeof vb === 'number') {
                    return state.dir === 'asc' ? va - vb : vb - va;
                }
                const sa = String(va), sb = String(vb);
                return state.dir === 'asc' ? sa.localeCompare(sb) : sb.localeCompare(sa);
            });
            rows.forEach(r => tbody.appendChild(r));
        });
    });
}
window.makeTableSortable = makeTableSortable;

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    App.init();
});
