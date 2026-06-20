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
        replay: ReplayPage,
        'agent-map': AgentMapPage,
        'agent-runs': AgentRunsPage,
        'agent-timeline': AgentTimelinePage,
        rules: RulesPage,
        'proxy-langchain': { render: (c) => IntegrationPage.render(c, 'proxy-langchain') },
        'proxy-langgraph': { render: (c) => IntegrationPage.render(c, 'proxy-langgraph') },
        'proxy-crewai': { render: (c) => IntegrationPage.render(c, 'proxy-crewai') },
        'proxy-n8n': { render: (c) => IntegrationPage.render(c, 'proxy-n8n') },
        'proxy-ollama': { render: (c) => IntegrationPage.render(c, 'proxy-ollama') },
        'proxy-openclaw': { render: (c) => IntegrationPage.render(c, 'proxy-openclaw') },
        'proxy-claude-code': { render: (c) => IntegrationPage.render(c, 'proxy-claude-code') },
        'proxy-codex': { render: (c) => IntegrationPage.render(c, 'proxy-codex') },
        'proxy-copilot-cli': { render: (c) => IntegrationPage.render(c, 'proxy-copilot-cli') },
        'proxy-cursor': { render: (c) => IntegrationPage.render(c, 'proxy-cursor') },
        'guide-claude-code': { render: (c) => GuideClaudeCodePage.render(c) },
        'guide-codex': { render: (c) => GuideCodexPage.render(c) },
        'guide-copilot-cli': { render: (c) => GuideCopilotCliPage.render(c) },
        'guide-cursor': { render: (c) => GuideCursorPage.render(c) },
        'guide-openclaw': { render: (c) => GuideOpenclawPage.render(c) },
        'guide-frameworks': { render: (c) => GuideFrameworksPage.render(c) },
        settings: SettingsPage,
        // Guardian ML deep-link — same Settings page, but flags the Guardian
        // section to scroll into view + highlight on load. Lets the Configure
        // nav entry land the user directly on the toggle.
        'guardian-ml': { render: (c) => { SettingsPage.focusGuardian = true; return SettingsPage.render(c); } },
        // Bundle 0.4 follow-up — Agent Replay umbrella in sidebar.
        // Tool Activity / Cost Tracking are sub-items under Agent Replay;
        // Tool Permissions / Cost Settings are top-level configure entries.
        // Each nav entry maps to ONE tab — tab bar hidden so the nav stays
        // the single source of truth for which view is shown.
        'tool-permissions':  { render: (c) => { ToolPermissionsPage.activeTab = 'permissions'; ToolPermissionsPage.hideTabBar = true; ToolPermissionsPage.visibleTabs = null; return ToolPermissionsPage.render(c); } },
        'mcp-policies':      McpPoliciesPage,
        // Cloud Activity (story #113) — full in/out visibility for enrolled
        // devices. Sidebar gates its visibility on enrollment; the page also
        // self-guards with a not-enrolled empty-state if deep-linked.
        'cloud-activity':    CloudActivityPage,
        // Tool Activity + Tool Inventory — one merged destination, two tabs.
        // Both legacy page ids stay routable (deep links / bookmarks); they
        // differ only in which tab is active on landing.
        'tool-activity':     { render: (c) => { ToolPermissionsPage.activeTab = 'activity';    ToolPermissionsPage.hideTabBar = false; ToolPermissionsPage.visibleTabs = ['activity', 'bill']; return ToolPermissionsPage.render(c); } },
        'bill-of-tools':     { render: (c) => { ToolPermissionsPage.activeTab = 'bill';        ToolPermissionsPage.hideTabBar = false; ToolPermissionsPage.visibleTabs = ['activity', 'bill']; return ToolPermissionsPage.render(c); } },
        'redactions':        RedactionsPage,
        costs:               { render: (c) => { CostsPage.mode = 'monitor';  CostsPage.activeTab = 'overview'; CostsPage.hideTabBar = true; return CostsPage.render(c); } },
        'cost-settings':     { render: (c) => { CostsPage.mode = 'settings'; CostsPage.hideTabBar = true; return CostsPage.render(c); } },
        'siem-export':       SiemExportPage,
        'skill-scanner':     { render: (c) => { SkillScannerPage.activeTab = 'scanner';     return SkillScannerPage.render(c); } },
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
        if (window.GlobalBanners) GlobalBanners.render();

        // Handle browser back/forward
        window.addEventListener('popstate', (e) => {
            const page = e.state?.page || this.getPageFromURL();
            this.loadPage(page, false);
        });

        // Load initial page from URL or default to dashboard
        const initialPage = this.getPageFromURL();
        await this.loadPage(initialPage);

        // Show welcome modal on first launch. For OpenClaw users we surface
        // a tailored "install the plugin" welcome; everyone else gets the
        // generic SecureVector intro.
        this.showFirstLaunchWelcome();
    },

    async showFirstLaunchWelcome() {
        // v2 — refreshed welcome now leads with "What's new" (OpenClaw plugin,
        // Tool Inventory, Secret Detections, Reports on Dashboard). Bumping the
        // storage key so existing users see the updated welcome once.
        const hasSeenGeneric = localStorage.getItem('sv-welcome-seen-v2');
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('no-welcome')) return;

        // The OpenClaw-detected welcome modal was removed — an interrupting
        // dialog on first launch was too aggressive for what the plugins
        // nudge banner and the Integrations page already cover.
        if (!hasSeenGeneric) this.showWelcomeIfFirstLaunch();
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
        const hasSeenWelcome = localStorage.getItem('sv-welcome-seen-v2');
        const urlParams = new URLSearchParams(window.location.search);
        if (hasSeenWelcome || urlParams.has('no-welcome')) return;

        // Fresh install: the welcome modal IS the orientation, so the
        // "what's new in vX.Y" upgrade banner is meaningless noise — mark it
        // acked. Deliberately does NOT touch the Guardian consent notice:
        // that must reach every user (fresh installs AND updaters) until
        // they make an explicit keep-on / turn-off choice.
        try {
            if (window.GlobalBanners) {
                localStorage.setItem(GlobalBanners.KEY_WHATS_NEW, GlobalBanners.WHATS_NEW_VERSION);
            }
        } catch (_) { /* private mode */ }

        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'modal welcome-modal';
        // Cap height to viewport so the integration / scanner action cards at
        // the bottom stay reachable via scroll on shorter screens. Header stays
        // pinned (flex-shrink:0); the content region scrolls.
        modal.style.cssText = 'max-width: 700px; max-height: 90vh; display: flex; flex-direction: column;';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        // Dismiss helper — defined early so all handlers can reference it
        const dismissModal = () => {
            localStorage.setItem('sv-welcome-seen-v2', 'true');
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
        header.style.cssText = 'border-bottom: 1px solid var(--border-color); padding: 18px 20px 16px; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;';

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

        // Content (scrollable so bottom action cards stay reachable when
        // the What's-new section pushes the modal past viewport height)
        const content = document.createElement('div');
        content.className = 'modal-content';
        content.style.cssText = 'padding: 24px 20px; overflow-y: auto; flex: 1 1 auto; min-height: 0;';

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

        // What's new in this release — lead with the OpenClaw plugin, follow
        // with the new audit/observability surfaces (Tool Inventory, Secret
        // Detections, Reports on Dashboard). Each item is clickable and routes
        // to the relevant page so users can actually try the new thing.
        const whatsNew = document.createElement('div');
        whatsNew.style.cssText = 'margin-bottom: 20px;';
        const whatsNewHead = document.createElement('div');
        whatsNewHead.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';
        const whatsNewLabel = document.createElement('span');
        whatsNewLabel.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:var(--accent-primary);';
        whatsNewLabel.textContent = 'Highlights';
        const whatsNewRule = document.createElement('div');
        whatsNewRule.style.cssText = 'flex:1;height:1px;background:var(--border-default);';
        whatsNewHead.appendChild(whatsNewLabel);
        whatsNewHead.appendChild(whatsNewRule);
        whatsNew.appendChild(whatsNewHead);

        const whatsNewList = document.createElement('div');
        // Fixed 2-up grid: with four cards, auto-fit picked 3 columns at
        // modal width and orphaned the fourth card alone on row two. 2x2
        // stays balanced; single column below ~480px via the minmax floor.
        whatsNewList.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;';
        if (window.matchMedia('(min-width: 520px)').matches) {
            whatsNewList.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
        }

        const makeNewItem = (badge, title, desc, page, expandSection) => {
            const card = document.createElement('div');
            card.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:12px 14px;background:var(--bg-secondary);border:1px solid var(--border-default);border-radius:8px;cursor:pointer;transition:border-color 0.15s,transform 0.05s;min-width:0;';
            card.addEventListener('mouseenter', () => card.style.borderColor = 'rgba(94,173,184,0.35)');
            card.addEventListener('mouseleave', () => card.style.borderColor = 'var(--border-default)');
            card.addEventListener('mousedown', () => card.style.transform = 'scale(0.99)');
            card.addEventListener('mouseup', () => card.style.transform = 'scale(1)');
            card.addEventListener('click', () => navigateTo(page, expandSection));

            const badgeEl = document.createElement('span');
            badgeEl.style.cssText = 'align-self:flex-start;font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;background:rgba(180,83,9,0.2);color:#d97706;letter-spacing:0.4px;line-height:1.4;text-transform:uppercase;';
            badgeEl.textContent = badge;
            card.appendChild(badgeEl);

            const titleEl = document.createElement('div');
            titleEl.style.cssText = 'font-size:13px;font-weight:700;color:var(--text-primary);line-height:1.3;';
            titleEl.textContent = title;
            card.appendChild(titleEl);

            const descEl = document.createElement('div');
            descEl.style.cssText = 'font-size:12px;color:var(--text-secondary);line-height:1.5;flex:1;';
            descEl.textContent = desc;
            card.appendChild(descEl);

            const linkRow = document.createElement('div');
            linkRow.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:var(--accent-primary);margin-top:2px;';
            linkRow.textContent = 'Open →';
            card.appendChild(linkRow);

            return card;
        };

        // Four cards max — the modal is the first thing a new user sees;
        // a six-card wall buried the v4.6.0 headliners (Guardian ML and the
        // Copilot CLI plugin) under older release notes.
        whatsNewList.appendChild(makeNewItem(
            'NEW',
            'Guardian ML',
            'Local AI threat detection alongside the regex rules — fully offline, nothing leaves your device, every catch labelled Rule / ML.',
            'guardian-ml'
        ));
        whatsNewList.appendChild(makeNewItem(
            'NEW',
            'GitHub Copilot CLI plugin',
            'Copilot CLI joins the guarded harnesses — native hooks, tool-permission enforcement, tamper-evident audit.',
            'proxy-copilot-cli',
            'integrations'
        ));
        whatsNewList.appendChild(makeNewItem(
            'PLUGINS',
            'Claude Code · Codex · OpenClaw',
            'Native plugins for every major agent runtime — no proxy, no env vars, full audit trail.',
            'integrations',
            'integrations'
        ));
        whatsNewList.appendChild(makeNewItem(
            'OBSERVE',
            'Agent Map, Runs & Secrets',
            'Live device → agent → tool topology, step-by-step run traces, tool inventory (SBOM), and mid-flight secret detection.',
            'agent-map',
            'agent-activity'
        ));

        whatsNew.appendChild(whatsNewList);
        content.appendChild(whatsNew);

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
