/**
 * Sidebar Navigation Component
 * Note: All content is static/hardcoded, no user input is rendered
 */

const Sidebar = {
    navItems: [
        { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
        { id: 'threats', label: 'Threat Monitor', icon: 'shield' },
        { id: 'tool-activity', label: 'Tool Activity', icon: 'history' },
        { id: 'costs', label: 'Cost Tracking', icon: 'costs' },
        { id: 'tool-permissions', label: 'Tool Permissions', icon: 'lock' },
        { id: 'cost-settings', label: 'Cost Settings', icon: 'sliders' },
        { id: 'rules', label: 'Rules', icon: 'rules', tooltip: 'Auto-block or alert on threats that match custom criteria' },
        { id: 'integrations', label: 'Integrations', icon: 'integrations', collapsible: true, subItems: [
            { id: 'proxy-langchain', label: 'LangChain' },
            { id: 'proxy-langgraph', label: 'LangGraph' },
            { id: 'proxy-crewai', label: 'CrewAI' },
            { id: 'proxy-n8n', label: 'n8n' },
            { id: 'proxy-ollama', label: 'Ollama' },
            { id: 'proxy-openclaw', label: 'OpenClaw/ClawdBot' },
        ]},
        { id: 'guide', label: 'Guide', icon: 'book', collapsible: true, subItems: [
            { id: 'gs-api', label: 'API Reference', section: 'section-api' },
        ]},
        { id: 'settings', label: 'Settings', icon: 'settings' },
    ],

    currentPage: 'dashboard',

    collapsed: false,

    render() {
        const container = document.getElementById('sidebar');
        if (!container) return;

        // Check saved collapsed state
        this.collapsed = localStorage.getItem('sidebar-collapsed') === 'true';
        if (this.collapsed) container.classList.add('collapsed');

        // Clear container
        container.textContent = '';

        // Create header with favicon logo (clickable)
        const header = document.createElement('div');
        header.className = 'sidebar-header';

        const logoLink = document.createElement('div');
        logoLink.className = 'sidebar-logo-link';
        logoLink.style.cursor = 'pointer';
        logoLink.addEventListener('click', () => this.navigate('dashboard'));

        // Favicon logo
        const logoImg = document.createElement('img');
        logoImg.src = '/images/favicon.png';
        logoImg.alt = 'SecureVector';
        logoImg.className = 'sidebar-logo-img';
        logoLink.appendChild(logoImg);

        const logo = document.createElement('span');
        logo.className = 'sidebar-logo';
        logo.textContent = 'SecureVector';
        logoLink.appendChild(logo);

        header.appendChild(logoLink);
        container.appendChild(header);

        // Create nav
        const nav = document.createElement('nav');
        nav.className = 'sidebar-nav';

        // Core features get an orange badge dot overlaid on their icon
        const CORE_BADGE = new Set(['threats', 'tool-permissions', 'costs']);

        // Section labels before nav items
        const SECTION_BEFORE = {
            'threats':          'Monitor',
            'tool-permissions': 'Configure',
            'integrations':     'Connect',
        };

        // Items that get a divider before them
        const DIVIDER_BEFORE = new Set(['tool-permissions', 'integrations']);

        this.navItems.forEach(item => {
            // Section label
            if (SECTION_BEFORE[item.id]) {
                const sectionLbl = document.createElement('div');
                sectionLbl.className = 'nav-section-label';
                sectionLbl.textContent = SECTION_BEFORE[item.id];
                nav.appendChild(sectionLbl);
            }

            // Divider
            if (DIVIDER_BEFORE.has(item.id)) {
                const divider = document.createElement('div');
                divider.className = 'nav-section-divider';
                nav.appendChild(divider);
            }
            const navItem = document.createElement('div');
            const hasSubItems = item.subItems && item.subItems.length > 0;
            // Collapsible parents (like Docs) stay active on their page
            const isActive = item.id === this.currentPage && (!hasSubItems || item.collapsible);
            navItem.className = 'nav-item' + (isActive ? ' active' : '');
            navItem.dataset.page = item.id;
            if (item.collapsible) navItem.dataset.collapsible = 'true';
            if (item.tooltip) navItem.title = item.tooltip;

            // Add icon (SVG) — core features get an orange badge dot overlaid on the icon
            const iconSvg = this.createIcon(item.icon);
            if (CORE_BADGE.has(item.id)) {
                const iconWrap = document.createElement('div');
                iconWrap.style.cssText = 'position: relative; width: 20px; height: 20px; flex-shrink: 0;';
                iconWrap.appendChild(iconSvg);
                const iconDot = document.createElement('div');
                iconDot.style.cssText = 'position: absolute; top: -3px; right: -3px; width: 7px; height: 7px; border-radius: 50%; background: #f59e0b; border: 1.5px solid var(--bg-secondary);';
                iconDot.title = 'Core feature';
                iconDot.dataset.coreDot = item.id;
                // Hide permanently if already visited
                if (localStorage.getItem('sv-visited-core-' + item.id)) iconDot.style.display = 'none';
                iconWrap.appendChild(iconDot);
                navItem.appendChild(iconWrap);
            } else {
                navItem.appendChild(iconSvg);
            }

            // Add label
            const label = document.createElement('span');
            label.textContent = item.label;
            label.style.cssText = 'white-space: nowrap; font-size: 12.5px; flex: 1; min-width: 0;';
            navItem.appendChild(label);

            // Add badge for rules count
            if (item.id === 'rules') {
                const badge = document.createElement('span');
                badge.className = 'nav-badge';
                badge.id = 'rules-count-badge';
                badge.textContent = '...';
                navItem.appendChild(badge);
            }

            // NEW badge (dismissible) — only on Rules
            const newBadgeItems = ['rules'];
            if (newBadgeItems.includes(item.id) && !localStorage.getItem('sv-new-dismissed-' + item.id)) {
                const newBadge = document.createElement('span');
                newBadge.style.cssText = 'display: inline-flex; align-items: center; gap: 2px; font-size: 8px; font-weight: 700; padding: 1px 3px 1px 4px; border-radius: 3px; background: #b45309; color: #fff; letter-spacing: 0.3px; line-height: 1; flex-shrink: 0;';
                const newText = document.createTextNode('NEW');
                newBadge.appendChild(newText);
                const closeX = document.createElement('span');
                closeX.textContent = '×';
                closeX.title = 'Dismiss';
                closeX.style.cssText = 'font-size: 10px; line-height: 1; cursor: pointer; opacity: 0.85; margin-left: 1px;';
                const dismissBadge = () => {
                    localStorage.setItem('sv-new-dismissed-' + item.id, '1');
                    newBadge.remove();
                };
                closeX.addEventListener('click', (e) => {
                    e.stopPropagation();
                    dismissBadge();
                });
                newBadge.appendChild(closeX);
                navItem.appendChild(newBadge);
                // Auto-dismiss after 30 seconds
                setTimeout(dismissBadge, 30000);
            }


            // Chevron for collapsible items
            let chevron = null;
            if (item.collapsible && hasSubItems) {
                const isExpanded = localStorage.getItem(`nav-${item.id}-expanded`) === 'true';
                chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                chevron.setAttribute('viewBox', '0 0 24 24');
                chevron.setAttribute('fill', 'none');
                chevron.setAttribute('stroke', 'currentColor');
                chevron.setAttribute('stroke-width', '2');
                chevron.style.cssText = 'width: 14px; height: 14px; transition: transform 0.2s; flex-shrink: 0; opacity: 0.5;';
                chevron.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)';
                const chevronPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                chevronPath.setAttribute('d', 'M6 9l6 6 6-6');
                chevron.appendChild(chevronPath);
                navItem.appendChild(chevron);
            }

            // Click handler — collapsible rows toggle on any click; others navigate
            navItem.addEventListener('click', (e) => {
                if (item.collapsible && hasSubItems) {
                    const subNav = nav.querySelector(`[data-sub-for="${item.id}"]`);
                    if (subNav) {
                        const isVisible = subNav.style.display !== 'none';
                        subNav.style.display = isVisible ? 'none' : 'block';
                        localStorage.setItem(`nav-${item.id}-expanded`, String(!isVisible));
                        if (chevron) chevron.style.transform = isVisible ? 'rotate(-90deg)' : 'rotate(0deg)';
                    }
                    return;
                }
                this.navigate(item.id);
            });

            nav.appendChild(navItem);

            // Sub-items
            if (hasSubItems) {
                const subNav = document.createElement('div');
                subNav.className = 'nav-sub-items';
                subNav.style.cssText = 'padding-left: 32px; font-size: 12px;';

                if (item.collapsible) {
                    subNav.dataset.subFor = item.id;
                    const isExpanded = localStorage.getItem(`nav-${item.id}-expanded`) === 'true';
                    subNav.style.display = isExpanded ? 'block' : 'none';
                }

                item.subItems.forEach(subItem => {
                    const subNavItem = document.createElement('div');
                    subNavItem.className = 'nav-item nav-sub-item' + (subItem.id === this.currentPage ? ' active' : '');
                    subNavItem.dataset.page = subItem.id;
                    subNavItem.style.cssText = 'padding: 6px 12px; opacity: 0.85;';

                    const subLabel = document.createElement('span');
                    subLabel.textContent = subItem.label;
                    subNavItem.appendChild(subLabel);

                    subNavItem.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (subItem.section) {
                            this.navigateToSection(item.id, subItem.section, subItem.id);
                        } else {
                            this.navigate(subItem.id);
                        }
                    });

                    subNav.appendChild(subNavItem);
                });

                nav.appendChild(subNav);
            }
        });

        // Fetch rules count
        this.loadRulesCount();

        container.appendChild(nav);

        // Collapse toggle button (at menu level)
        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'sidebar-collapse-btn';
        collapseBtn.setAttribute('aria-label', 'Toggle sidebar');

        const collapseIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        collapseIcon.setAttribute('viewBox', '0 0 24 24');
        collapseIcon.setAttribute('fill', 'none');
        collapseIcon.setAttribute('stroke', 'currentColor');
        collapseIcon.setAttribute('stroke-width', '2');
        const collapsePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        collapsePath.setAttribute('d', this.collapsed ? 'M9 18l6-6-6-6' : 'M15 18l-6-6 6-6');
        collapseIcon.appendChild(collapsePath);
        collapseBtn.appendChild(collapseIcon);

        collapseBtn.addEventListener('click', () => this.toggleCollapse());
        container.appendChild(collapseBtn);

        // Bottom section - proxy status, try it, uninstall, server status
        const bottomSection = document.createElement('div');
        bottomSection.className = 'sidebar-bottom';

        // Integration proxy status indicator — compact single line, anchored in bottom section
        const proxyBanner = document.createElement('div');
        proxyBanner.id = 'integration-proxy-banner';
        proxyBanner.className = 'proxy-banner-pulse';
        proxyBanner.style.cssText = 'display: none; margin: 8px 12px 0; padding: 4px 10px; border-radius: 6px; cursor: pointer; background: transparent; border: 1px solid rgba(0,188,212,0.35); align-items: center; gap: 6px; transition: background 0.15s;';
        proxyBanner.addEventListener('mouseenter', () => { proxyBanner.style.background = 'rgba(0,188,212,0.06)'; });
        proxyBanner.addEventListener('mouseleave', () => { proxyBanner.style.background = 'transparent'; });

        const bannerDot = document.createElement('span');
        bannerDot.style.cssText = 'width: 6px; height: 6px; border-radius: 50%; background: var(--accent-primary); flex-shrink: 0;';
        proxyBanner.appendChild(bannerDot);

        const bannerText = document.createElement('span');
        bannerText.id = 'integration-banner-text';
        bannerText.style.cssText = 'font-size: 11px; font-weight: 500; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        proxyBanner.appendChild(bannerText);
        bottomSection.appendChild(proxyBanner);

        // Check proxy status
        this.checkProxyStatus();

        // Try SecureVector gradient button
        const tryBtn = document.createElement('button');
        tryBtn.style.cssText = 'display: flex; align-items: center; justify-content: center; width: calc(100% - 24px); margin: 8px 12px 2px; padding: 7px 12px; border: none; border-radius: 7px; background: linear-gradient(135deg, #00bcd4, #f44336); color: #fff; font-size: 12px; font-weight: 600; cursor: pointer; transition: opacity 0.15s; letter-spacing: 0.2px;';
        tryBtn.textContent = 'Getting Started Guide';
        tryBtn.addEventListener('mouseenter', () => { tryBtn.style.opacity = '0.88'; });
        tryBtn.addEventListener('mouseleave', () => { tryBtn.style.opacity = '1'; });
        tryBtn.addEventListener('click', () => this.navigate('guide'));
        bottomSection.appendChild(tryBtn);

        container.appendChild(bottomSection);
    },

    toggleCollapse() {
        const container = document.getElementById('sidebar');
        this.collapsed = !this.collapsed;
        localStorage.setItem('sidebar-collapsed', this.collapsed);

        if (this.collapsed) {
            container.classList.add('collapsed');
        } else {
            container.classList.remove('collapsed');
        }

        // Update icon
        const collapseBtn = container.querySelector('.sidebar-collapse-btn');
        if (collapseBtn) {
            const path = collapseBtn.querySelector('path');
            if (path) {
                path.setAttribute('d', this.collapsed ? 'M9 18l6-6-6-6' : 'M15 18l-6-6 6-6');
            }
        }
    },

    createThemeIcon() {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');

        if (isDark) {
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', '12');
            circle.setAttribute('cy', '12');
            circle.setAttribute('r', '5');
            svg.appendChild(circle);
            const rays = ['M12 1v2', 'M12 21v2', 'M4.22 4.22l1.42 1.42', 'M18.36 18.36l1.42 1.42', 'M1 12h2', 'M21 12h2', 'M4.22 19.78l1.42-1.42', 'M18.36 5.64l1.42-1.42'];
            rays.forEach(d => {
                const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                line.setAttribute('d', d);
                svg.appendChild(line);
            });
        } else {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z');
            svg.appendChild(path);
        }
        return svg;
    },

    toggleTheme() {
        const html = document.documentElement;
        const currentTheme = html.getAttribute('data-theme') || 'dark';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        html.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
        this.render();
        if (window.Header) Header.render();
    },

    showUninstallModal() {
        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        const closeModal = () => {
            overlay.classList.remove('active');
            setTimeout(() => overlay.remove(), 150);
        };

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal();
        });

        const modal = document.createElement('div');
        modal.className = 'modal uninstall-modal';

        // Header
        const header = document.createElement('div');
        header.className = 'modal-header';

        const title = document.createElement('h2');
        title.textContent = 'Uninstall SecureVector';
        header.appendChild(title);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'modal-close';
        closeBtn.textContent = '\u00D7';
        closeBtn.addEventListener('click', closeModal);
        header.appendChild(closeBtn);

        modal.appendChild(header);

        // Content (scrollable)
        const content = document.createElement('div');
        content.className = 'modal-content';
        content.style.cssText = 'overflow-y: auto; max-height: 60vh;';

        // Windows section
        const winSection = document.createElement('div');
        winSection.className = 'uninstall-section';
        const winTitle = document.createElement('h3');
        winTitle.textContent = 'Windows';
        winSection.appendChild(winTitle);

        const winDesc = document.createElement('p');
        winDesc.textContent = 'Use the Windows uninstaller:';
        winSection.appendChild(winDesc);

        const winSteps = document.createElement('ol');
        const step1 = document.createElement('li');
        step1.textContent = 'Open Settings > Apps > Installed apps';
        winSteps.appendChild(step1);
        const step2 = document.createElement('li');
        step2.textContent = 'Search for SecureVector';
        winSteps.appendChild(step2);
        const step3 = document.createElement('li');
        step3.textContent = 'Click Uninstall';
        winSteps.appendChild(step3);
        winSection.appendChild(winSteps);

        const winAlt = document.createElement('p');
        winAlt.textContent = 'Or run from command line:';
        winSection.appendChild(winAlt);
        const winCmd = document.createElement('code');
        winCmd.textContent = 'pip uninstall securevector';
        winSection.appendChild(winCmd);
        content.appendChild(winSection);

        // macOS/Linux section
        const macSection = document.createElement('div');
        macSection.className = 'uninstall-section';
        const macTitle = document.createElement('h3');
        macTitle.textContent = 'macOS / Linux';
        macSection.appendChild(macTitle);

        const macDesc = document.createElement('p');
        macDesc.textContent = 'Run from terminal:';
        macSection.appendChild(macDesc);
        const macCmd = document.createElement('code');
        macCmd.textContent = 'pip uninstall securevector';
        macSection.appendChild(macCmd);
        content.appendChild(macSection);

        // Remove data section
        const dataSection = document.createElement('div');
        dataSection.className = 'uninstall-section';
        const dataTitle = document.createElement('h3');
        dataTitle.textContent = 'Remove Data (Optional)';
        dataSection.appendChild(dataTitle);

        const dataDesc = document.createElement('p');
        dataDesc.textContent = 'To also remove the database and settings:';
        dataSection.appendChild(dataDesc);
        const dataCmd = document.createElement('code');
        dataCmd.textContent = 'rm -rf ~/.securevector';
        dataSection.appendChild(dataCmd);

        const dataNote = document.createElement('p');
        dataNote.className = 'muted';
        dataNote.textContent = 'This will delete all threat analytics history and custom rules.';
        dataSection.appendChild(dataNote);
        content.appendChild(dataSection);

        // Warning
        const warning = document.createElement('div');
        warning.className = 'uninstall-warning';
        const warningBold = document.createElement('strong');
        warningBold.textContent = 'Note: ';
        warning.appendChild(warningBold);
        warning.appendChild(document.createTextNode('Running the pip uninstall command will remove the application. Make sure to close SecureVector before uninstalling.'));
        content.appendChild(warning);

        modal.appendChild(content);

        // Footer
        const footer = document.createElement('div');
        footer.className = 'modal-footer';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.textContent = 'Close';
        cancelBtn.addEventListener('click', closeModal);
        footer.appendChild(cancelBtn);

        modal.appendChild(footer);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Trigger animation after DOM insertion
        requestAnimationFrame(() => {
            overlay.classList.add('active');
        });
    },

    async loadRulesCount() {
        try {
            const rules = await API.getRules();
            const count = rules.total || (rules.items ? rules.items.length : 0);
            const badge = document.getElementById('rules-count-badge');
            if (badge) {
                badge.textContent = count;
            }
        } catch (e) {
            const badge = document.getElementById('rules-count-badge');
            if (badge) {
                badge.textContent = '0';
            }
        }
    },

    // Integration configurations for banner display
    integrationConfigs: {
        openclaw: { icon: '🦎', label: 'OPENCLAW PROXY', color: 'linear-gradient(135deg, #f59e0b, #d97706)', page: 'proxy-openclaw' },
        ollama: { icon: '🦙', label: 'OLLAMA PROXY', color: 'linear-gradient(135deg, #6366f1, #4f46e5)', page: 'proxy-ollama' },
        langchain: { icon: '🔗', label: 'LANGCHAIN PROXY', color: 'linear-gradient(135deg, #10b981, #059669)', page: 'proxy-langchain' },
        langgraph: { icon: '📊', label: 'LANGGRAPH PROXY', color: 'linear-gradient(135deg, #10b981, #059669)', page: 'proxy-langgraph' },
        crewai: { icon: '👥', label: 'CREWAI PROXY', color: 'linear-gradient(135deg, #8b5cf6, #7c3aed)', page: 'proxy-crewai' },
        n8n: { icon: '⚡', label: 'N8N PROXY', color: 'linear-gradient(135deg, #ef4444, #dc2626)', page: 'proxy-n8n' },
        default: { icon: '', label: 'PROXY', color: 'linear-gradient(135deg, #00bcd4, #f44336)', page: 'integrations' },
    },

    async checkProxyStatus() {
        try {
            const response = await fetch('/api/proxy/status');
            if (response.ok) {
                const data = await response.json();
                const banner = document.getElementById('integration-proxy-banner');
                const textEl = document.getElementById('integration-banner-text');

                if (banner) {
                    if (data.running) {
                        // Get integration config
                        const integration = data.integration || (data.openclaw ? 'openclaw' : 'default');
                        const config = this.integrationConfigs[integration] || this.integrationConfigs.default;

                        banner.style.display = 'flex';
                        banner.onclick = () => this.navigate(config.page);

                        if (textEl) {
                            const friendlyNames = {
                                openclaw: 'OpenClaw', ollama: 'Ollama', langchain: 'LangChain',
                                langgraph: 'LangGraph', crewai: 'CrewAI', n8n: 'n8n',
                            };
                            const name = friendlyNames[integration] || 'Proxy';
                            const mode = data.multi ? ' · Multi-provider' : '';
                            textEl.textContent = name + ' proxy running' + mode;
                        }

                        // Store state for proxy pages to use
                        window._proxyActive = true;
                        window._proxyIntegration = integration;
                        window._openclawProxyActive = data.openclaw || false;
                    } else {
                        banner.style.display = 'none';
                        window._proxyActive = false;
                        window._proxyIntegration = null;
                        window._openclawProxyActive = false;
                    }
                }
            }
        } catch (e) {
            // Ignore errors
        }
        // Refresh every 5 seconds
        setTimeout(() => this.checkProxyStatus(), 5000);
    },

    createIcon(name) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');

        const paths = {
            dashboard: [
                { tag: 'rect', attrs: { x: '3', y: '3', width: '7', height: '7', rx: '1' } },
                { tag: 'rect', attrs: { x: '14', y: '3', width: '7', height: '7', rx: '1' } },
                { tag: 'rect', attrs: { x: '3', y: '14', width: '7', height: '7', rx: '1' } },
                { tag: 'rect', attrs: { x: '14', y: '14', width: '7', height: '7', rx: '1' } },
            ],
            shield: [
                { tag: 'path', attrs: { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' } },
            ],
            rules: [
                { tag: 'path', attrs: { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' } },
                { tag: 'polyline', attrs: { points: '14 2 14 8 20 8' } },
                { tag: 'line', attrs: { x1: '16', y1: '13', x2: '8', y2: '13' } },
                { tag: 'line', attrs: { x1: '16', y1: '17', x2: '8', y2: '17' } },
            ],
            settings: [
                { tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } },
                { tag: 'path', attrs: { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z' } },
            ],
            chat: [
                { tag: 'path', attrs: { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' } },
            ],
            proxy: [
                { tag: 'path', attrs: { d: 'M12 2L2 7l10 5 10-5-10-5z' } },
                { tag: 'path', attrs: { d: 'M2 17l10 5 10-5' } },
                { tag: 'path', attrs: { d: 'M2 12l10 5 10-5' } },
            ],
            integrations: [
                { tag: 'rect', attrs: { x: '3', y: '11', width: '18', height: '10', rx: '2' } },
                { tag: 'circle', attrs: { cx: '12', cy: '5', r: '2' } },
                { tag: 'path', attrs: { d: 'M12 7v4' } },
                { tag: 'circle', attrs: { cx: '8', cy: '16', r: '1', fill: 'currentColor' } },
                { tag: 'circle', attrs: { cx: '16', cy: '16', r: '1', fill: 'currentColor' } },
            ],
            rocket: [
                { tag: 'path', attrs: { d: 'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z' } },
                { tag: 'path', attrs: { d: 'M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z' } },
                { tag: 'path', attrs: { d: 'M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0' } },
                { tag: 'path', attrs: { d: 'M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5' } },
            ],
            book: [
                { tag: 'path', attrs: { d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20' } },
                { tag: 'path', attrs: { d: 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z' } },
            ],
            lock: [
                { tag: 'rect', attrs: { x: '3', y: '11', width: '18', height: '11', rx: '2', ry: '2' } },
                { tag: 'path', attrs: { d: 'M7 11V7a5 5 0 0 1 10 0v4' } },
            ],
            uninstall: [
                { tag: 'path', attrs: { d: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' } },
                { tag: 'line', attrs: { x1: '10', y1: '11', x2: '10', y2: '17' } },
                { tag: 'line', attrs: { x1: '14', y1: '11', x2: '14', y2: '17' } },
            ],
            costs: [
                { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
                { tag: 'path', attrs: { d: 'M12 6v2m0 8v2M8.5 9.5a3.5 3.5 0 0 1 7 0c0 2-3.5 3-3.5 5m0 1h.01' } },
            ],
            history: [
                { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
                { tag: 'polyline', attrs: { points: '12 6 12 12 16 14' } },
            ],
            sliders: [
                { tag: 'line', attrs: { x1: '4', y1: '21', x2: '4', y2: '14' } },
                { tag: 'line', attrs: { x1: '4', y1: '10', x2: '4', y2: '3' } },
                { tag: 'line', attrs: { x1: '12', y1: '21', x2: '12', y2: '12' } },
                { tag: 'line', attrs: { x1: '12', y1: '8', x2: '12', y2: '3' } },
                { tag: 'line', attrs: { x1: '20', y1: '21', x2: '20', y2: '16' } },
                { tag: 'line', attrs: { x1: '20', y1: '12', x2: '20', y2: '3' } },
                { tag: 'line', attrs: { x1: '1', y1: '14', x2: '7', y2: '14' } },
                { tag: 'line', attrs: { x1: '9', y1: '8', x2: '15', y2: '8' } },
                { tag: 'line', attrs: { x1: '17', y1: '16', x2: '23', y2: '16' } },
            ],
        };

        (paths[name] || []).forEach(({ tag, attrs }) => {
            const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
            Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
            svg.appendChild(el);
        });

        return svg;
    },

    expandSection(sectionId) {
        const subNav = document.querySelector(`[data-sub-for="${sectionId}"]`);
        if (subNav) {
            subNav.style.display = 'block';
            localStorage.setItem(`nav-${sectionId}-expanded`, 'true');
            // Update chevron
            const navItem = document.querySelector(`.nav-item[data-page="${sectionId}"]`);
            if (navItem) {
                const chevron = navItem.querySelector('svg:last-child');
                if (chevron) chevron.style.transform = 'rotate(0deg)';
            }
        }
    },

    navigate(page) {
        // Auto-expand parent section when navigating to a sub-item
        for (const item of this.navItems) {
            if (item.collapsible && item.subItems && item.subItems.some(sub => sub.id === page)) {
                this.expandSection(item.id);
                break;
            }
        }

        this.currentPage = page;

        // Remove core icon badge dot on first visit
        const coreDot = document.querySelector(`[data-core-dot="${page}"]`);
        if (coreDot && !localStorage.getItem('sv-visited-core-' + page)) {
            localStorage.setItem('sv-visited-core-' + page, '1');
            coreDot.style.transition = 'opacity 0.3s';
            coreDot.style.opacity = '0';
            setTimeout(() => coreDot.remove(), 300);
        }

        // Update active state
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.page === page);
        });

        // Trigger page load
        if (window.App) {
            App.loadPage(page);
        }
    },

    navigateToSection(page, sectionId, subItemId) {
        const alreadyOnPage = this.currentPage === page;
        this.currentPage = page;

        // Highlight parent and clicked sub-item
        document.querySelectorAll('.nav-item').forEach(item => {
            const matchesParent = item.dataset.page === page && !item.classList.contains('nav-sub-item');
            const matchesSub = item.dataset.page === subItemId;
            item.classList.toggle('active', matchesParent || matchesSub);
        });

        if (alreadyOnPage) {
            const el = document.getElementById(sectionId);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
            this._pendingScroll = sectionId;
            if (window.App) App.loadPage(page);
        }
    },

    setActive(page) {
        this.currentPage = page;
        document.querySelectorAll('.nav-item').forEach(item => {
            const isSubItem = item.classList.contains('nav-sub-item');
            const matchesPage = item.dataset.page === page;
            if (isSubItem) {
                item.classList.toggle('active', matchesPage);
            } else {
                const hasSubItems = item.nextElementSibling && item.nextElementSibling.classList.contains('nav-sub-items');
                const isCollapsible = item.dataset.collapsible === 'true';
                // Collapsible parents (like Docs) stay active when on their page
                item.classList.toggle('active', matchesPage && (!hasSubItems || isCollapsible));
            }
        });
    },
};


/**
 * Side Drawer Component
 */
const SideDrawer = {
    isOpen: false,

    show(options = {}) {
        this.close(); // Close any existing drawer

        const overlay = document.createElement('div');
        overlay.className = 'side-drawer-overlay';
        overlay.addEventListener('click', () => this.close());

        const drawer = document.createElement('div');
        drawer.className = 'side-drawer';
        drawer.id = 'side-drawer';

        // Header
        const header = document.createElement('div');
        header.className = 'side-drawer-header';

        const title = document.createElement('h3');
        title.textContent = options.title || 'Details';
        header.appendChild(title);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'side-drawer-close';
        closeBtn.textContent = '\u00D7';
        closeBtn.addEventListener('click', () => this.close());
        header.appendChild(closeBtn);

        drawer.appendChild(header);

        // Content
        const content = document.createElement('div');
        content.className = 'side-drawer-content';
        if (options.content) {
            if (typeof options.content === 'string') {
                content.textContent = options.content;
            } else {
                content.appendChild(options.content);
            }
        }
        drawer.appendChild(content);

        document.body.appendChild(overlay);
        document.body.appendChild(drawer);

        // Trigger animation
        requestAnimationFrame(() => {
            overlay.classList.add('open');
            drawer.classList.add('open');
        });

        this.isOpen = true;
    },

    close() {
        const overlay = document.querySelector('.side-drawer-overlay');
        const drawer = document.getElementById('side-drawer');

        if (overlay) {
            overlay.classList.remove('open');
            setTimeout(() => overlay.remove(), 300);
        }
        if (drawer) {
            drawer.classList.remove('open');
            setTimeout(() => drawer.remove(), 300);
        }

        this.isOpen = false;
    },
};

window.Sidebar = Sidebar;
window.SideDrawer = SideDrawer;
