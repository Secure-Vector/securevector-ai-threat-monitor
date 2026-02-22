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
        'tool-permissions': { render: (c) => { ToolPermissionsPage.activeTab = 'permissions'; ToolPermissionsPage.hideTabBar = true; return ToolPermissionsPage.render(c); } },
        costs: { render: (c) => { CostsPage.mode = 'monitor'; CostsPage.activeTab = 'overview'; CostsPage.hideTabBar = false; return CostsPage.render(c); } },
        'tool-activity': { render: (c) => { ToolPermissionsPage.activeTab = 'activity'; ToolPermissionsPage.hideTabBar = true; return ToolPermissionsPage.render(c); } },
        'cost-settings': { render: (c) => { CostsPage.mode = 'settings'; CostsPage.hideTabBar = true; return CostsPage.render(c); } },
    },

    /**
     * Initialize the application
     */
    async init() {
        // Load saved theme
        this.loadTheme();

        // Fetch live proxy port and web port once — used by applyDynamicPorts()
        window.__SV_WEB_PORT = parseInt(window.location.port) || 8741;
        window.__SV_PROXY_PORT = window.__SV_WEB_PORT + 1; // optimistic fallback
        try {
            const status = await API.getProxyStatus();
            if (status && status.port) window.__SV_PROXY_PORT = status.port;
        } catch (_) {}

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
        header.style.cssText = 'border-bottom: 1px solid var(--border-color); padding-bottom: 16px; display: flex; align-items: center; justify-content: space-between;';

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

        const closeBtn = document.createElement('button');
        closeBtn.style.cssText = 'background: none; border: none; font-size: 22px; line-height: 1; color: var(--text-muted); cursor: pointer; padding: 0; flex-shrink: 0;';
        closeBtn.textContent = '×';
        closeBtn.title = 'Close';
        closeBtn.addEventListener('click', () => dismissModal());
        header.appendChild(closeBtn);

        modal.appendChild(header);

        // Content
        const content = document.createElement('div');
        content.className = 'modal-content';
        content.style.cssText = 'padding: 20px 0;';

        const intro = document.createElement('div');
        intro.style.cssText = 'margin: 0 0 20px 0; padding: 12px 16px; background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); border-radius: 8px; color: white; font-weight: 600; text-align: center;';
        intro.textContent = '100% Local AI Threat Detection & Cost Intelligence for Your Agents';
        content.appendChild(intro);

        // Instructions
        const instructionBox = document.createElement('div');
        instructionBox.style.cssText = 'padding: 16px; background: var(--bg-secondary); border-radius: 8px; display: flex; flex-direction: column; gap: 16px;';

        const _numStyle = 'width: 28px; height: 28px; background: linear-gradient(135deg, #00bcd4, #f44336); color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 600; flex-shrink: 0; margin-top: 1px;';
        const _titleStyle = 'font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: 6px;';
        const _descStyle = 'font-size: 13px; color: var(--text-secondary); line-height: 1.5; margin-top: 3px;';

        // Step 1 — Proxy already running
        const step1 = document.createElement('div');
        step1.style.cssText = 'font-size: 14px; line-height: 1.6; display: flex; align-items: flex-start; gap: 12px;';
        const step1Num = document.createElement('span');
        step1Num.style.cssText = _numStyle;
        step1Num.textContent = '1';
        step1.appendChild(step1Num);
        const step1Body = document.createElement('div');
        const step1Title = document.createElement('div');
        step1Title.style.cssText = _titleStyle;
        step1Title.appendChild(document.createTextNode('Proxy Already Running'));
        const step1Badge = document.createElement('span');
        step1Badge.style.cssText = 'font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: rgba(16,185,129,0.15); color: #10b981; letter-spacing: 0.4px; text-transform: uppercase;';
        step1Badge.textContent = '\u25CF Active';
        step1Title.appendChild(step1Badge);
        step1Body.appendChild(step1Title);
        const step1Desc = document.createElement('div');
        step1Desc.style.cssText = _descStyle;
        step1Desc.textContent = "Your AI Firewall is live. Point your agent's LLM calls to the proxy by setting one environment variable:";
        step1Body.appendChild(step1Desc);
        const step1Code = document.createElement('div');
        step1Code.style.cssText = 'margin-top: 5px; font-size: 12px; font-family: monospace; background: var(--bg-tertiary); color: var(--accent-primary); padding: 4px 10px; border-radius: 4px; display: inline-block;';
        step1Code.textContent = `OPENAI_BASE_URL=http://localhost:${window.__SV_PROXY_PORT || 8742}/openai/v1`;
        step1Body.appendChild(step1Code);
        step1.appendChild(step1Body);
        instructionBox.appendChild(step1);

        // Step 2 — Rules already enabled
        const step2 = document.createElement('div');
        step2.style.cssText = 'font-size: 14px; line-height: 1.6; display: flex; align-items: flex-start; gap: 12px;';
        const step2Num = document.createElement('span');
        step2Num.style.cssText = _numStyle;
        step2Num.textContent = '2';
        step2.appendChild(step2Num);
        const step2Body = document.createElement('div');
        const step2Title = document.createElement('div');
        step2Title.style.cssText = _titleStyle;
        step2Title.appendChild(document.createTextNode('Threat Detection Rules Enabled'));
        const step2Badge = document.createElement('span');
        step2Badge.style.cssText = 'font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: rgba(16,185,129,0.15); color: #10b981; letter-spacing: 0.4px; text-transform: uppercase;';
        step2Badge.textContent = '\u25CF Ready';
        step2Title.appendChild(step2Badge);
        step2Body.appendChild(step2Title);
        const step2Desc = document.createElement('div');
        step2Desc.style.cssText = _descStyle;
        step2Desc.textContent = 'Prompt injection, jailbreak, data exfiltration, and 300+ other threat patterns are pre-loaded and scanning every request automatically.';
        step2Body.appendChild(step2Desc);
        step2.appendChild(step2Body);
        instructionBox.appendChild(step2);

        // Step 3 — Tool Permissions
        const step3 = document.createElement('div');
        step3.style.cssText = 'font-size: 14px; line-height: 1.6; display: flex; align-items: flex-start; gap: 12px;';
        const step3Num = document.createElement('span');
        step3Num.style.cssText = _numStyle;
        step3Num.textContent = '3';
        step3.appendChild(step3Num);
        const step3Body = document.createElement('div');
        const step3Title = document.createElement('div');
        step3Title.style.cssText = _titleStyle;
        step3Title.textContent = 'Configure Tool Permissions & Budgets';
        step3Body.appendChild(step3Title);
        const step3Desc = document.createElement('div');
        step3Desc.style.cssText = _descStyle;
        const step3b1 = document.createElement('strong'); step3b1.textContent = 'Tool Permissions';
        const step3b2 = document.createElement('strong'); step3b2.textContent = 'Cost Settings';
        step3Desc.appendChild(document.createTextNode('Go to '));
        step3Desc.appendChild(step3b1);
        step3Desc.appendChild(document.createTextNode(' to block risky agent actions, and '));
        step3Desc.appendChild(step3b2);
        step3Desc.appendChild(document.createTextNode(' to set daily spend limits.'));
        step3Body.appendChild(step3Desc);
        step3.appendChild(step3Body);
        instructionBox.appendChild(step3);

        // Step 4 — Monitor
        const step4 = document.createElement('div');
        step4.style.cssText = 'font-size: 14px; line-height: 1.6; display: flex; align-items: flex-start; gap: 12px;';
        const step4Num = document.createElement('span');
        step4Num.style.cssText = _numStyle;
        step4Num.textContent = '4';
        step4.appendChild(step4Num);
        const step4Body = document.createElement('div');
        const step4Title = document.createElement('div');
        step4Title.style.cssText = _titleStyle;
        step4Title.textContent = "Run Your Agent \u2014 Watch It Live";
        step4Body.appendChild(step4Title);
        const step4Desc = document.createElement('div');
        step4Desc.style.cssText = _descStyle;
        const step4b1 = document.createElement('strong'); step4b1.textContent = 'Monitor';
        step4Desc.appendChild(document.createTextNode('Threats, tool calls, and costs appear in real time in the '));
        step4Desc.appendChild(step4b1);
        step4Desc.appendChild(document.createTextNode(' section as your agent runs.'));
        step4Body.appendChild(step4Desc);
        step4.appendChild(step4Body);
        instructionBox.appendChild(step4);

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
        gotItBtn.textContent = 'Close';
        gotItBtn.addEventListener('click', dismissModal);
        footer.appendChild(gotItBtn);

        const configureBtn = document.createElement('button');
        configureBtn.className = 'btn btn-primary';
        configureBtn.textContent = 'Go to Configure';
        configureBtn.addEventListener('click', () => {
            dismissModal();
            if (window.Sidebar) Sidebar.navigate('tool-permissions');
        });
        footer.appendChild(configureBtn);

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
            this.applyDynamicPorts(container);
        } catch (error) {
            console.error('Failed to render page:', error);
            this.renderError(container, error);
        }
    },

    /**
     * Walk all text nodes in container and replace default ports with the
     * actual running ports. Runs after every page render so all instruction
     * code blocks, env-var examples, and URLs show the correct port.
     */
    applyDynamicPorts(container) {
        const proxyPort = window.__SV_PROXY_PORT;
        const webPort   = window.__SV_WEB_PORT;
        if (!proxyPort && !webPort) return;
        const defaultProxy = 8742;
        const defaultWeb   = 8741;
        if (proxyPort === defaultProxy && webPort === defaultWeb) return; // nothing to replace

        const walk = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                let t = node.textContent;
                if (proxyPort && proxyPort !== defaultProxy) {
                    t = t.replaceAll(':' + defaultProxy, ':' + proxyPort);
                }
                if (webPort && webPort !== defaultWeb) {
                    t = t.replaceAll(':' + defaultWeb, ':' + webPort);
                }
                if (t !== node.textContent) node.textContent = t;
            } else {
                node.childNodes.forEach(walk);
            }
        };
        walk(container);
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
 * getPollInterval — returns the user-configured polling interval in ms.
 * Default: 5000ms (5s). Stored in localStorage key 'sv-poll-interval'.
 */
window.getPollInterval = () => parseInt(localStorage.getItem('sv-poll-interval') || '5000', 10);

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
