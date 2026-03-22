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
        'skill-scanner': { render: (c) => { SkillScannerPage.activeTab = 'scanner'; return SkillScannerPage.render(c); } },
        'skill-permissions': { render: (c) => { SkillScannerPage.activeTab = 'permissions'; return SkillScannerPage.render(c); } },
    },

    /**
     * Initialize the application
     */
    async init() {
        // Load saved theme
        this.loadTheme();

        // Fetch live proxy port, web port, and host once — used by applyDynamicPorts()
        window.__SV_WEB_PORT = parseInt(window.location.port) || 8741;
        window.__SV_PROXY_PORT = window.__SV_WEB_PORT + 1; // optimistic fallback
        window.__SV_HOST = window.location.hostname || 'localhost';
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
        const urlParams = new URLSearchParams(window.location.search);
        if (hasSeenWelcome || urlParams.has('no-welcome')) return;

        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'modal welcome-modal';
        modal.style.cssText = 'max-width: 700px;';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        // Dismiss helper — defined early so all handlers can reference it
        const dismissModal = () => {
            localStorage.setItem('sv-welcome-seen', 'true');
            overlay.classList.remove('active');
            setTimeout(() => overlay.remove(), 150);
        };

        const navigateTo = (page, expandSection) => {
            dismissModal();
            if (window.Sidebar) {
                if (expandSection) Sidebar.expandSection(expandSection);
                Sidebar.navigate(page);
            }
        };

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
        closeBtn.style.cssText = 'background: none; border: none; font-size: 22px; line-height: 1; color: var(--text-muted); cursor: pointer; padding: 4px 8px; flex-shrink: 0;';
        closeBtn.textContent = '\u00d7';
        closeBtn.title = 'Close';
        closeBtn.addEventListener('click', () => dismissModal());
        header.appendChild(closeBtn);

        modal.appendChild(header);

        // Content
        const content = document.createElement('div');
        content.className = 'modal-content';
        content.style.cssText = 'padding: 24px 20px;';

        // What is SecureVector — clear, readable intro
        const whatIs = document.createElement('div');
        whatIs.style.cssText = 'font-size: 14px; color: var(--text-primary); line-height: 1.7; margin-bottom: 20px;';
        whatIs.textContent = 'SecureVector is a local security proxy for your AI agents. It sits between your agent and the LLM, scanning every request and response for threats, tracking costs, and monitoring tool usage.';
        content.appendChild(whatIs);

        // Proxy status bar with cyan border
        const proxyBar = document.createElement('div');
        proxyBar.style.cssText = 'padding: 14px 18px; background: var(--bg-secondary); border: 1px solid rgba(94,173,184,0.3); border-radius: 8px; margin-bottom: 20px;';

        const proxyStatus = document.createElement('div');
        proxyStatus.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 10px;';
        const proxyDot = document.createElement('span');
        proxyDot.style.cssText = 'width: 7px; height: 7px; border-radius: 50%; background: #10b981; flex-shrink: 0;';
        const proxyLabel = document.createElement('span');
        proxyLabel.style.cssText = 'font-size: 14px; font-weight: 700; color: var(--success-text);';
        proxyLabel.textContent = 'Proxy is running';
        proxyStatus.appendChild(proxyDot);
        proxyStatus.appendChild(proxyLabel);
        proxyBar.appendChild(proxyStatus);

        // Feature list — structured, not inline
        const featureList = document.createElement('div');
        featureList.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px 16px; margin-bottom: 12px;';
        ['Threat Detection', 'Cost Tracking', 'Tool Monitoring'].forEach(f => {
            const tag = document.createElement('span');
            tag.style.cssText = 'font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 5px;';
            const check = document.createElement('span');
            check.style.cssText = 'color: var(--success-text); font-size: 10px;';
            check.textContent = '\u2713';
            tag.appendChild(check);
            tag.appendChild(document.createTextNode(f));
            featureList.appendChild(tag);
        });
        proxyBar.appendChild(featureList);

        content.appendChild(proxyBar);

        // Two action paths — side by side
        const actions = document.createElement('div');
        actions.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; min-width: 0;';

        // --- Setup Integration ---
        const setupCard = document.createElement('div');
        setupCard.style.cssText = 'background: var(--bg-secondary); border-radius: 8px; padding: 16px; border: 1px solid var(--border-default); min-width: 0; cursor: pointer; transition: border-color 0.15s;';
        setupCard.addEventListener('mouseenter', () => setupCard.style.borderColor = 'rgba(94,173,184,0.3)');
        setupCard.addEventListener('mouseleave', () => setupCard.style.borderColor = 'var(--border-default)');
        setupCard.addEventListener('click', () => navigateTo('proxy-openclaw', 'integrations'));

        const setupTitle = document.createElement('div');
        setupTitle.style.cssText = 'font-size: 14px; font-weight: 700; color: var(--text-primary); margin-bottom: 6px;';
        setupTitle.textContent = 'Set up your integration';
        setupCard.appendChild(setupTitle);
        const setupDesc = document.createElement('div');
        setupDesc.style.cssText = 'font-size: 13px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 10px;';
        setupDesc.textContent = 'Point your agent\u2019s base URL to the proxy. Step-by-step setup for each framework.';
        setupCard.appendChild(setupDesc);

        // Env var with copy inside setup card
        const codeWrap = document.createElement('div');
        codeWrap.style.cssText = 'display: flex; align-items: center; background: var(--bg-tertiary); border-radius: 4px; margin-bottom: 10px; min-width: 0;';
        const codeText = document.createElement('div');
        codeText.style.cssText = 'font-size: 11px; font-family: monospace; color: var(--accent-primary); padding: 6px 10px; word-break: break-all; flex: 1; min-width: 0;';
        const envValue = `OPENAI_BASE_URL=http://localhost:${window.__SV_PROXY_PORT || 8742}/openai/v1`;
        codeText.textContent = envValue;
        const copyBtn = document.createElement('button');
        copyBtn.style.cssText = 'background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 6px 8px; font-size: 11px; flex-shrink: 0; transition: color 0.15s;';
        copyBtn.textContent = 'Copy';
        copyBtn.title = 'Copy to clipboard';
        copyBtn.addEventListener('mouseenter', () => copyBtn.style.color = 'var(--accent-primary)');
        copyBtn.addEventListener('mouseleave', () => copyBtn.style.color = 'var(--text-muted)');
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(envValue).then(() => {
                copyBtn.textContent = 'Copied!';
                copyBtn.style.color = '#10b981';
                setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.style.color = 'var(--text-muted)'; }, 1500);
            });
        });
        codeWrap.appendChild(codeText);
        codeWrap.appendChild(copyBtn);
        setupCard.appendChild(codeWrap);

        const setupLink = document.createElement('span');
        setupLink.style.cssText = 'font-size: 12px; font-weight: 600; color: var(--accent-primary);';
        setupLink.textContent = 'LangChain \u00b7 CrewAI \u00b7 OpenClaw \u00b7 Ollama \u00b7 more \u2192';
        setupCard.appendChild(setupLink);

        // --- Skill Scanner ---
        const scanCard = document.createElement('div');
        scanCard.style.cssText = 'background: var(--bg-secondary); border-radius: 8px; padding: 16px; border: 1px solid var(--border-default); min-width: 0; cursor: pointer; transition: border-color 0.15s;';
        scanCard.addEventListener('mouseenter', () => scanCard.style.borderColor = 'rgba(94,173,184,0.3)');
        scanCard.addEventListener('mouseleave', () => scanCard.style.borderColor = 'var(--border-default)');
        scanCard.addEventListener('click', () => navigateTo('skill-scanner'));

        const scanTitle = document.createElement('div');
        scanTitle.style.cssText = 'font-size: 14px; font-weight: 700; color: var(--text-primary); margin-bottom: 6px;';
        scanTitle.textContent = 'Scan a skill before you install it';
        scanCard.appendChild(scanTitle);
        const scanDesc = document.createElement('div');
        scanDesc.style.cssText = 'font-size: 13px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 10px;';
        scanDesc.textContent = 'Check any skill for risky patterns \u2014 network calls, shell commands, file writes \u2014 before adding it to your agent.';
        scanCard.appendChild(scanDesc);
        const scanLink = document.createElement('span');
        scanLink.style.cssText = 'font-size: 12px; font-weight: 600; color: var(--accent-primary);';
        scanLink.textContent = 'Open Skill Scanner \u2192';
        scanCard.appendChild(scanLink);

        actions.appendChild(setupCard);
        actions.appendChild(scanCard);
        content.appendChild(actions);

        modal.appendChild(content);

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Click outside to dismiss
        overlay.addEventListener('click', (e) => { if (e.target === overlay) dismissModal(); });

        // Escape key to dismiss
        const escHandler = (e) => { if (e.key === 'Escape') { dismissModal(); document.removeEventListener('keydown', escHandler); } };
        document.addEventListener('keydown', escHandler);

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
