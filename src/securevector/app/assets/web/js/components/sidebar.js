/**
 * Sidebar Navigation Component
 * Note: All content is static/hardcoded, no user input is rendered
 */

// Load-scoped guard so the Guardian ML "sentinel" robot plays its 30s scan
// orbit exactly ONCE per page load (on launch / hard reload), not again on
// every in-app navigation. render() builds the nav once per load and a hard
// reload re-runs this whole script, resetting the flag — which is precisely
// the "every launch / hard reload" cadence we want.
let _gmRoboPlayed = false;
let _gmRoboTimer = null;

const Sidebar = {
    navItems: [
        { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
        { id: 'threats', label: 'Threat Monitor', icon: 'shield' },
        // Agent Replay umbrella — collapsible parent grouping the three
        // observability views that share the same per-agent lens. Top-level
        // 'replay' route still works as a deep-link (the Timeline sub-item
        // lands on it), and Tool Activity / Cost Tracking get prominent
        // visibility under the agent-observability story instead of being
        // buried under Configure.
        { id: 'agent-activity', label: 'Agent Activity', icon: 'history', collapsible: true, defaultExpanded: true, navigable: true, subItems: [
            // One destination, three lenses (Map / Runs / Timeline tabs via ObsTabs).
            // Lands on the Map — the hero topology view — and `aliases` keep this
            // item highlighted while the user switches to the Runs/Timeline tab
            // (those are separate page ids).
            { id: 'agent-map',      label: 'Agent Runs', aliases: ['agent-runs', 'agent-timeline'] },
            // Activity log + inventory (SBOM) are two lenses on the same
            // tool_call_audit data — one destination, two tabs on the page.
            // 'bill-of-tools' stays as an alias so deep links keep this row lit.
            { id: 'tool-activity',  label: 'Tool Activity & Inventory', aliases: ['bill-of-tools'] },
            { id: 'redactions',     label: 'Secret Detections' },
            { id: 'costs',          label: 'Cost Tracking' },
        ]},
        // Skills + Tools entries cover their primary "configure" surfaces
        // (the Permissions / Policy tabs); the Activity / Tracking tabs are
        // surfaced under Agent Replay above.
        { id: 'skill-scanner', label: 'Skills', icon: 'scan', tooltip: 'Skill scanner + skill policy management (tabs on the page)' },
        { id: 'tool-permissions', label: 'Tool Permissions', icon: 'lock', tooltip: 'Allow / block / log-only tool calls. The Activity log is under Agent Replay.' },
        // Guardian ML — local ML threat detection. A configure-time choice
        // (on/off + what it does), so it sits in Configure and deep-links to
        // the Guardian section on the Settings page. Lives here rather than as
        // a sidebar pill so the bottom status zone stays single-purpose.
        // (MCP Policies moved from this spot into the Cloud section below.)
        { id: 'guardian-ml', label: 'Guardian ML', icon: 'guardian', tooltip: 'Local ML threat detection — toggle + what it does. Opens in Settings.' },
        { id: 'cost-settings', label: 'Cost Settings', icon: 'sliders', tooltip: 'Budgets + pricing. The per-agent spend dashboard is under Agent Replay.' },
        { id: 'rules', label: 'Rules', icon: 'rules', tooltip: 'Auto-block or alert on threats that match custom criteria' },
        // ---- Cloud section (#151) ----
        // The cloud-account surfaces get their own labelled section
        // (SECTION_BEFORE maps 'mcp-policies' → 'Cloud') so enrolled-device
        // features don't blend into the local Configure items.
        // MCP Policies — read-only viewer of cloud-synced policy bundles.
        // Kept distinct from Tool Permissions: the trust artifact (what's
        // pushed to me, by whom) vs the operational surface.
        { id: 'mcp-policies', label: 'MCP Policies', icon: 'shield-check', tooltip: 'Org-managed tool rules — one change, applied to every enrolled device.' },
        // Cloud Activity — full in/out visibility for the cloud↔device pipe.
        // In CLOUD_TIER below: always shown, but dimmed/"locked" on personal-mode
        // installs (clicking lands on its enroll-CTA empty state).
        { id: 'cloud-activity', label: 'Cloud Activity', icon: 'history', tooltip: 'Everything flowing in and out of this device since enrollment — synced policies down, metadata-only audit up.' },
        // SIEM Forwarder is an outbound pipe to external SOC systems —
        // placed above Integrations (inbound pipes from agent
        // frameworks) because the SOC audit/compliance story is the
        // higher-value v4.0 positioning. Both are Connect; this is the
        // one regulated buyers ask about first.
        { id: 'siem-export', label: 'SIEM Forwarder', icon: 'costs', tooltip: 'Forward threats and tool-call audits to Splunk, Datadog, Sentinel, QRadar, Chronicle, OTLP, or any HTTPS webhook' },
        { id: 'integrations', label: 'Integrations', icon: 'integrations', collapsible: true, subItems: [
            // Grouped by integration mechanism so users pick the right install
            // path at a glance. "Plugins" = native host hooks (no proxy, no env
            // vars): Claude Code + Codex are plugin-only; OpenClaw is primarily
            // the plugin but its page also exposes a block-mode proxy.
            // "Frameworks" = agent frameworks (LangChain/LangGraph/CrewAI) whose
            // primary path is now the SecureVector SDK (tool-call layer); each
            // page keeps an optional legacy base-URL proxy. "Proxy" = the
            // remaining tools you point at the local proxy's base URL (n8n,
            // Ollama). The left-nav labels stay framework-named (not "SDK").
            // (Page ids keep their historical `proxy-` prefix to avoid breaking
            // routes.)
            { header: 'Plugins' },
            { id: 'proxy-claude-code', label: 'Claude Code' },
            { id: 'proxy-codex', label: 'Codex' },
            { id: 'proxy-copilot-cli', label: 'GitHub Copilot CLI' },
            { id: 'proxy-cursor', label: 'Cursor' },
            { id: 'proxy-openclaw', label: 'OpenClaw/ClawdBot' },
            { header: 'Frameworks' },
            { id: 'proxy-langchain', label: 'LangChain' },
            { id: 'proxy-langgraph', label: 'LangGraph' },
            { id: 'proxy-crewai', label: 'CrewAI' },
            { header: 'Proxy' },
            { id: 'proxy-n8n', label: 'n8n' },
            { id: 'proxy-ollama', label: 'Ollama' },
        ]},
        { id: 'guide', label: 'Guide', icon: 'book', collapsible: true, subItems: [
            // Harness plugin guides grouped under one header — one section per
            // harness that ships a native plugin (Claude Code, Codex, GitHub
            // Copilot CLI, OpenClaw).
            { header: 'Plugin setup' },
            { id: 'guide-claude-code', label: 'Claude Code' },
            { id: 'guide-codex', label: 'Codex' },
            { id: 'guide-copilot-cli', label: 'GitHub Copilot CLI' },
            { id: 'guide-cursor', label: 'Cursor' },
            { id: 'guide-openclaw', label: 'OpenClaw / ClawdBot' },
            { header: 'Framework SDKs' },
            { id: 'guide-frameworks', label: 'LangChain · LangGraph · CrewAI' },
            { header: 'Reading the data' },
            { id: 'gs-read-map', label: 'Reading the Map', section: 'section-read-map' },
            { id: 'gs-read-runs', label: 'Reading Runs', section: 'section-read-runs' },
            { header: 'Reference' },
            { id: 'gs-tool-inventory', label: 'Tool Inventory', section: 'section-tool-inventory' },
            { id: 'gs-secret-detections', label: 'Secret Detections', section: 'section-secret-detections' },
            { id: 'gs-mcp-policies', label: 'MCP Policies', section: 'section-mcp-policies' },
            { id: 'gs-siem-forwarder', label: 'SIEM Forwarder', section: 'section-siem-forwarder' },
            { id: 'gs-skill-scanner', label: 'Skill Scanner', section: 'section-skill-scanner' },
            { id: 'gs-api', label: 'API Reference', section: 'section-api' },
            { id: 'gs-troubleshoot', label: 'Troubleshooting', section: 'section-troubleshooting' },
        ]},
        { id: 'settings', label: 'Settings', icon: 'settings' },
    ],

    currentPage: 'dashboard',

    collapsed: false,

    // Min/max bounds for the resize handle. Stays narrower than the CSS
    // default of 240px on the low end so power users can squeeze, and wide
    // enough on the high end to avoid letting the rail eat the page.
    SIDEBAR_MIN_PX: 180,
    SIDEBAR_MAX_PX: 380,

    _applySavedSidebarWidth() {
        const saved = parseInt(localStorage.getItem('sidebar-width') || '', 10);
        if (Number.isFinite(saved) && saved >= this.SIDEBAR_MIN_PX && saved <= this.SIDEBAR_MAX_PX) {
            document.documentElement.style.setProperty('--sidebar-width', saved + 'px');
        }
    },

    // Enrollment state cache for the CLOUD_TIER lock treatment. null = not yet
    // probed; true/false once /policy-sync/status answers.
    _enrolled: null,
    _enrollmentProbed: false,

    /**
     * Probe enrollment once per page load so enrolled-only nav items (Cloud
     * Activity) can reveal themselves. Cheap idempotent GET. On resolution,
     * if the answer flips the cached value, re-render the sidebar so the item
     * appears/disappears without a full reload. Fails closed (hidden) on any
     * error — a transient API hiccup never leaks an empty page into the rail.
     */
    _probeEnrollment() {
        if (this._enrollmentProbed) return;
        this._enrollmentProbed = true;
        fetch('/api/v1/policy-sync/status')
            .then(r => (r.ok ? r.json() : null))
            .then(data => {
                const enrolled = !!(data && data.enrolled);
                if (enrolled !== this._enrolled) {
                    this._enrolled = enrolled;
                    // Only a re-render is needed; render() guards its own
                    // one-time defaults so this is safe to call again.
                    this.render();
                }
            })
            .catch(() => { /* fail closed — cloud rows stay dimmed/locked */ });
    },

    render() {
        const container = document.getElementById('sidebar');
        if (!container) return;

        // Check saved collapsed state
        this.collapsed = localStorage.getItem('sidebar-collapsed') === 'true';
        if (this.collapsed) container.classList.add('collapsed');

        // Restore the user's last sidebar width before rendering so the
        // expanded rail comes up at the right size on first paint.
        this._applySavedSidebarWidth();

        // Clean default on every app load: only "Agent Activity" opens
        // automatically. Integrations + Guide always start collapsed even if
        // the user expanded them in a prior session (navigating into a
        // sub-item persists `nav-<id>-expanded=true`, which otherwise leaks
        // an expanded section onto the next launch). Run once per page load —
        // guarded so mid-session re-renders (e.g. theme toggle) don't fight a
        // section the user just opened.
        if (!Sidebar._loadDefaultsApplied) {
            Sidebar._loadDefaultsApplied = true;
            ['integrations', 'guide'].forEach(id => localStorage.removeItem(`nav-${id}-expanded`));
        }

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

        // Wrap the brand text + tagline in a column so the tagline sits
        // under the wordmark without pushing the favicon around.
        const logoTextCol = document.createElement('div');
        logoTextCol.className = 'sidebar-logo-text';

        // Wordmark + version on one row (version sits right next to the brand).
        const brandRow = document.createElement('span');
        brandRow.style.cssText = 'display:inline-flex;align-items:baseline;gap:7px;';

        const logo = document.createElement('span');
        logo.className = 'sidebar-logo';
        logo.textContent = 'SecureVector';
        brandRow.appendChild(logo);

        // App version badge. Keep in sync with __version__ in
        // src/securevector/__init__.py on every release bump.
        const version = document.createElement('span');
        version.className = 'sidebar-version';
        version.textContent = 'v4.8.0';
        version.style.cssText = 'font:600 10px ui-monospace,Menlo,monospace;letter-spacing:.3px;color:var(--text-muted,#7d8590);';
        brandRow.appendChild(version);
        logoTextCol.appendChild(brandRow);

        // Tagline — product positioning in small caps. Uses theme
        // variables so it respects light/dark switches automatically.
        const tagline = document.createElement('span');
        tagline.className = 'sidebar-tagline';
        tagline.textContent = 'AI Agent Runtime Control';
        logoTextCol.appendChild(tagline);

        logoLink.appendChild(logoTextCol);

        header.appendChild(logoLink);
        container.appendChild(header);

        // Create nav
        const nav = document.createElement('nav');
        nav.className = 'sidebar-nav';

        // Core features get an orange badge dot overlaid on their icon
        const CORE_BADGE = new Set(['threats', 'tool-permissions', 'costs']);

        // Features that require a SecureVector cloud account — small "Cloud"
        // pill rendered next to the label so users know up-front.
        const CLOUD_TIER = new Set(['mcp-policies', 'cloud-activity']);

        // Cloud-section items stay VISIBLE but greyed-out until the device is
        // enrolled, rather than being hidden. Hiding them means local-only
        // users never discover that fleet/cloud surfaces exist — the dimmed
        // row is the cheapest in-product "this is available, not yet on"
        // signal. Both targets already render an honest enroll-CTA empty state
        // when opened in personal mode, so the row stays clickable and lands
        // there. `_enrolled` is probed asynchronously once (see
        // _probeEnrollment); until it resolves we treat enrollment as unknown
        // (`!== true`) and keep the row dimmed, then re-render when the answer
        // lands. CLOUD_TIER (above) is the set that gets this treatment.
        this._probeEnrollment();

        // Section labels before nav items. SIEM Forwarder now anchors
        // the Connect section (it sits above Integrations) so the
        // "Connect" label still renders above the outbound/inbound pipes.
        const SECTION_BEFORE = {
            'threats':          'Monitor',
            'tool-permissions': 'Configure',
            'mcp-policies':     'Cloud',
            'siem-export':      'Connect',
        };

        // Items that get a divider before them — keep the visual break
        // at the Cloud and Connect boundaries too.
        const DIVIDER_BEFORE = new Set(['tool-permissions', 'mcp-policies', 'siem-export']);

        this.navItems.forEach(item => {
            // Cloud-locked = a CLOUD_TIER surface on a device that isn't known
            // to be enrolled. The row still renders (discoverability) but gets
            // a dimmed, "locked" treatment below instead of being hidden.
            const isCloudLocked = CLOUD_TIER.has(item.id) && this._enrolled !== true;

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
            navItem.className = 'nav-item' + (isActive ? ' active' : '') + (isCloudLocked ? ' nav-item-locked' : '');
            navItem.dataset.page = item.id;
            if (item.collapsible) navItem.dataset.collapsible = 'true';
            // A locked cloud row gets an explicit "needs a cloud account"
            // tooltip; otherwise fall back to the item's own tooltip.
            if (isCloudLocked) {
                navItem.title = 'Requires a SecureVector cloud account — enroll this device to turn this on.';
            } else if (item.tooltip) {
                navItem.title = item.tooltip;
            }

            // Add icon (SVG) — core features get an orange badge dot overlaid on
            // the icon. Guardian ML uses its animated "sentinel" robot AS the
            // nav icon (in place of the generic chip) — the symbol that stands
            // for the local ML model is the bot itself. It runs a 30s scan on
            // each launch / hard reload (once per page load), then settles.
            let iconSvg;
            if (item.id === 'guardian-ml') {
                iconSvg = document.createElement('span');
                iconSvg.className = 'gm-robo';
                // Title gives sighted users a hover hint; the SVG is aria-hidden
                // and the nav row already owns the accessible name, so the bot is
                // purely decorative (no aria-label → no double-announce).
                iconSvg.title = 'Guardian ML — local AI threat detection, watching every call';
                iconSvg.innerHTML = `<svg viewBox="0 0 40 40" fill="none" aria-hidden="true">
                    <circle class="gm-ring" cx="20" cy="18" r="16"/>
                    <g class="gm-bot">
                        <line class="gm-ant" x1="17.6" y1="12.4" x2="15.5" y2="8.2" stroke-linecap="round"/>
                        <circle class="gm-ant-tip l" cx="15" cy="7.3" r="1.5"/>
                        <line class="gm-ant" x1="22.4" y1="12.4" x2="24.5" y2="8.2" stroke-linecap="round"/>
                        <circle class="gm-ant-tip r" cx="25" cy="7.3" r="1.5"/>
                        <rect class="gm-head" x="11.5" y="12.2" width="17" height="14.5" rx="4.6"/>
                        <circle class="gm-eye l" cx="17.2" cy="18.6" r="1.6"/>
                        <circle class="gm-eye r" cx="22.8" cy="18.6" r="1.6"/>
                        <path class="gm-smile" d="M16.6 22 Q20 24.6 23.4 22" stroke-linecap="round"/>
                    </g>
                    <g class="gm-orbit">
                        <!-- SMIL rotation (not CSS): rotates in SVG user units
                             around the ring's exact center (20,18), identical
                             in Blink and WebKit. CSS transform-box/view-box
                             origin handling on SVG children is inconsistent in
                             WebKit (pywebview), which made the dot orbit off
                             the ring there. -->
                        <animateTransform attributeName="transform" type="rotate"
                            from="0 20 18" to="360 20 18" dur="2.4s" repeatCount="indefinite"/>
                        <path class="gm-trail" d="M10.8 4.9 A 16 16 0 0 1 20 2" stroke-linecap="round"/>
                        <circle class="gm-sat" cx="20" cy="2" r="2.3"/>
                    </g>
                </svg>`;
                if (_gmRoboPlayed) {
                    iconSvg.classList.add('gm-static');
                } else {
                    _gmRoboPlayed = true;
                    if (_gmRoboTimer) clearTimeout(_gmRoboTimer);   // hygiene: never stack timers
                    _gmRoboTimer = setTimeout(() => iconSvg.classList.add('gm-static'), 30000);
                }
            } else {
                iconSvg = this.createIcon(item.icon);
            }
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

            // Tier pill — features that require a SecureVector account get a
            // small "Cloud" marker so users know up-front before they click.
            // When the device isn't enrolled the pill shows a tiny lock glyph
            // so the dimmed row reads as "locked, available" rather than broken.
            if (CLOUD_TIER.has(item.id)) {
                const tier = document.createElement('span');
                tier.textContent = isCloudLocked ? '🔒 Cloud' : 'Cloud';
                tier.style.cssText = 'flex-shrink: 0; margin-left: 6px; padding: 1px 6px; font-size: 9px; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase; border-radius: 999px; background: rgba(6, 182, 212, 0.14); color: var(--cyan-600, #0891b2); border: 1px solid rgba(6, 182, 212, 0.32); line-height: 1.4;';
                navItem.appendChild(tier);
            }

            // NEW badge — persistent for Rules, session-only (30s auto-dismiss) for Skill Scanner & Skill Policy.
            // Guardian ML deliberately omitted: it gets the animated "sentinel"
            // robot below instead of a NEW badge.
            const persistNewItems = ['rules'];
            // Session-only NEW badges: first-view highlight that auto-dismisses
            // after 30s so the sidebar doesn't stay permanently shouty.
            const sessionNewItems = ['siem-export', 'integrations'];
            const isPersist = persistNewItems.includes(item.id);
            const isSession = sessionNewItems.includes(item.id);
            const shouldShow = isPersist
                ? !localStorage.getItem('sv-new-dismissed-' + item.id)
                : isSession && !sessionStorage.getItem('sv-new-seen-' + item.id);
            if (shouldShow) {
                const newBadge = document.createElement('span');
                newBadge.style.cssText = 'display: inline-flex; align-items: center; gap: 2px; font-size: 8px; font-weight: 700; padding: 1px 3px 1px 4px; border-radius: 3px; background: rgba(180,83,9,0.2); color: #d97706; letter-spacing: 0.3px; line-height: 1; flex-shrink: 0;';
                const newText = document.createTextNode('NEW');
                newBadge.appendChild(newText);
                const dismissBadge = () => {
                    if (isPersist) localStorage.setItem('sv-new-dismissed-' + item.id, '1');
                    else sessionStorage.setItem('sv-new-seen-' + item.id, '1');
                    newBadge.remove();
                };
                if (isPersist) {
                    const closeX = document.createElement('span');
                    closeX.textContent = '×';
                    closeX.title = 'Dismiss';
                    closeX.style.cssText = 'font-size: 10px; line-height: 1; cursor: pointer; opacity: 0.85; margin-left: 1px;';
                    closeX.addEventListener('click', (e) => { e.stopPropagation(); dismissBadge(); });
                    newBadge.appendChild(closeX);
                }
                navItem.appendChild(newBadge);
                setTimeout(dismissBadge, 30000);
            }



            // Chevron for collapsible items
            let chevron = null;
            if (item.collapsible && hasSubItems) {
                // Resolution order: explicit user preference (localStorage) →
                // item's defaultExpanded flag → collapsed by default. Lets
                // specific groups (Agent Replay) ship expanded out of the box
                // while still respecting whatever the user clicks afterwards.
                const stored = localStorage.getItem(`nav-${item.id}-expanded`);
                const isExpanded = stored !== null ? stored === 'true' : !!item.defaultExpanded;
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

            // Click handler — collapsible rows toggle on any click; others navigate.
            // If the parent is `navigable`, an EXPAND click also navigates to
            // the first sub-item, so e.g. clicking "Agent Replay" lands the
            // user on the Timeline and shows the sub-list. A second click
            // (collapse) just hides the sub-list without changing the page.
            navItem.addEventListener('click', (e) => {
                if (item.collapsible && hasSubItems) {
                    const subNav = nav.querySelector(`[data-sub-for="${item.id}"]`);
                    if (subNav) {
                        const isVisible = subNav.style.display !== 'none';
                        const willExpand = !isVisible;
                        subNav.style.display = willExpand ? 'block' : 'none';
                        localStorage.setItem(`nav-${item.id}-expanded`, String(willExpand));
                        if (chevron) chevron.style.transform = willExpand ? 'rotate(0deg)' : 'rotate(-90deg)';
                        if (willExpand && item.navigable && item.subItems[0]) {
                            this.navigate(item.subItems[0].id);
                        }
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
                    // Same resolution as the chevron above.
                    const stored = localStorage.getItem(`nav-${item.id}-expanded`);
                    const isExpanded = stored !== null ? stored === 'true' : !!item.defaultExpanded;
                    subNav.style.display = isExpanded ? 'block' : 'none';
                }

                // Sub-items eligible for a session-only NEW badge — first-view
                // highlight that auto-dismisses after 30s so the sidebar
                // doesn't stay permanently shouty. Mirror of the top-level
                // session-NEW list above; kept separate because sub-items
                // render in a different branch and the keys aren't shared
                // with the top-level item IDs.
                const subNewItems = ['proxy-codex', 'bill-of-tools', 'redactions'];

                item.subItems.forEach(subItem => {
                    // Non-clickable section header (groups the integration list
                    // by mechanism). Rendered as a small muted uppercase label.
                    if (subItem.header) {
                        const hdr = document.createElement('div');
                        hdr.textContent = subItem.header;
                        hdr.style.cssText = 'padding: 8px 12px 2px; font-size: 9px; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase; color: var(--text-muted); opacity: 0.7; pointer-events: none;';
                        subNav.appendChild(hdr);
                        return;
                    }

                    const subNavItem = document.createElement('div');
                    const subActive = subItem.id === this.currentPage ||
                        (subItem.aliases && subItem.aliases.includes(this.currentPage));
                    subNavItem.className = 'nav-item nav-sub-item' + (subActive ? ' active' : '');
                    subNavItem.dataset.page = subItem.id;
                    if (subItem.aliases) subNavItem.dataset.aliases = subItem.aliases.join(',');
                    subNavItem.style.cssText = 'padding: 6px 12px; opacity: 0.85; display: flex; align-items: center; gap: 6px;';

                    const subLabel = document.createElement('span');
                    subLabel.textContent = subItem.label;
                    subLabel.style.cssText = 'flex: 1; min-width: 0;';
                    subNavItem.appendChild(subLabel);

                    if (subNewItems.includes(subItem.id) && !sessionStorage.getItem('sv-new-seen-' + subItem.id)) {
                        const newBadge = document.createElement('span');
                        newBadge.style.cssText = 'display: inline-flex; align-items: center; font-size: 8px; font-weight: 700; padding: 1px 4px; border-radius: 3px; background: rgba(180,83,9,0.2); color: #d97706; letter-spacing: 0.3px; line-height: 1; flex-shrink: 0;';
                        newBadge.textContent = 'NEW';
                        const dismiss = () => {
                            sessionStorage.setItem('sv-new-seen-' + subItem.id, '1');
                            newBadge.remove();
                        };
                        subNavItem.appendChild(newBadge);
                        setTimeout(dismiss, 30000);
                    }

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

        // Drag-to-resize handle on the right edge of the sidebar. Disabled
        // (display:none via CSS) while the rail is in collapsed state.
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'sidebar-resize-handle';
        resizeHandle.title = 'Drag to resize';
        resizeHandle.addEventListener('mousedown', (downEv) => {
            if (this.collapsed) return;
            downEv.preventDefault();
            const startX = downEv.clientX;
            const startWidth = container.getBoundingClientRect().width;
            container.classList.add('resizing');
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';

            const onMove = (moveEv) => {
                const next = Math.max(
                    this.SIDEBAR_MIN_PX,
                    Math.min(this.SIDEBAR_MAX_PX, startWidth + (moveEv.clientX - startX))
                );
                document.documentElement.style.setProperty('--sidebar-width', next + 'px');
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                container.classList.remove('resizing');
                document.body.style.userSelect = '';
                document.body.style.cursor = '';
                const finalWidth = parseInt(
                    getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'),
                    10
                );
                if (Number.isFinite(finalWidth)) {
                    localStorage.setItem('sidebar-width', String(finalWidth));
                }
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        container.appendChild(resizeHandle);

        // Bottom section - proxy status, try it, uninstall, server status
        const bottomSection = document.createElement('div');
        bottomSection.className = 'sidebar-bottom';

        // Collapsible status stack — the proxy / plugin / SIEM banners live
        // in one foldable group (the user asked to be able to put them away).
        // The header row renders only when at least one banner is visible,
        // shows a live count, and the collapsed state persists across loads.
        const statusToggle = document.createElement('button');
        statusToggle.type = 'button';
        statusToggle.id = 'sidebar-status-toggle';
        statusToggle.setAttribute('aria-controls', 'sidebar-status-stack');
        statusToggle.style.cssText = 'display: none; align-items: center; gap: 6px; margin: 10px 12px 2px; padding: 6px 10px; min-height: 26px; line-height: 1.4; background: transparent; border: none; border-radius: 6px; cursor: pointer; font: inherit; font-size: 10px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; color: var(--text-muted); width: calc(100% - 24px); text-align: left; overflow: visible;';
        const statusChevron = document.createElement('span');
        statusChevron.setAttribute('aria-hidden', 'true');
        statusChevron.style.cssText = 'font-size: 11px; flex-shrink: 0; line-height: 1;';
        statusToggle.appendChild(statusChevron);
        const statusLabel = document.createElement('span');
        statusLabel.textContent = 'Active plugins';
        statusToggle.appendChild(statusLabel);
        const statusCount = document.createElement('span');
        statusCount.style.cssText = 'margin-left: auto; padding: 0 6px; border-radius: 999px; background: var(--bg-tertiary); color: var(--text-secondary); font-size: 9px; line-height: 16px;';
        statusToggle.appendChild(statusCount);
        statusToggle.addEventListener('mouseenter', () => { statusToggle.style.color = 'var(--text-secondary)'; });
        statusToggle.addEventListener('mouseleave', () => { statusToggle.style.color = 'var(--text-muted)'; });
        bottomSection.appendChild(statusToggle);

        const statusStack = document.createElement('div');
        statusStack.id = 'sidebar-status-stack';
        // Bottom inset so the last banner doesn't sit flush on the rail edge.
        statusStack.style.cssText = 'padding-bottom: 10px;';
        bottomSection.appendChild(statusStack);

        const STATUS_COLLAPSE_KEY = 'sv-status-stack-collapsed';
        const applyStatusCollapsed = (collapsed) => {
            statusStack.style.display = collapsed ? 'none' : 'block';
            statusChevron.textContent = collapsed ? '\u25b8' : '\u25be';
            statusToggle.setAttribute('aria-expanded', String(!collapsed));
            statusToggle.title = collapsed ? 'Show plugin status' : 'Hide plugin status';
        };
        statusToggle.addEventListener('click', () => {
            const nowCollapsed = statusStack.style.display !== 'none';
            try { localStorage.setItem(STATUS_COLLAPSE_KEY, nowCollapsed ? '1' : '0'); } catch (_) { /* private mode */ }
            applyStatusCollapsed(nowCollapsed);
        });
        applyStatusCollapsed(localStorage.getItem(STATUS_COLLAPSE_KEY) === '1');
        // Header visibility + count track the banners' own show/hide (each
        // poller flips its banner's inline display) — observe instead of
        // threading a callback through all five pollers.
        const updateStatusToggle = () => {
            const visible = Array.from(statusStack.children).filter(el => el.style.display !== 'none').length;
            statusToggle.style.display = visible ? 'flex' : 'none';
            statusCount.textContent = String(visible);
        };
        new MutationObserver(updateStatusToggle).observe(statusStack, { attributes: true, attributeFilter: ['style'], childList: true, subtree: true });
        updateStatusToggle();

        // Guardian ML lives in Settings (Configure section) — it's a
        // configuration choice, not a sidebar control. Keeping it out of the
        // bottom zone lets the proxy/plugin/SIEM status banners (which hide
        // when inactive) read as a clean, single-purpose status stack.

        // Integration proxy status indicator — compact single line, anchored in bottom section
        const proxyBanner = document.createElement('div');
        proxyBanner.id = 'integration-proxy-banner';
        proxyBanner.className = 'proxy-banner-pulse';
        proxyBanner.style.cssText = 'display: none; margin: 8px 12px 0; padding: 4px 10px; border-radius: 6px; cursor: pointer; background: transparent; border: 1px solid rgba(94,173,184,0.35); align-items: center; gap: 6px; transition: background 0.15s;';
        proxyBanner.addEventListener('mouseenter', () => { proxyBanner.style.background = 'rgba(94,173,184,0.06)'; });
        proxyBanner.addEventListener('mouseleave', () => { proxyBanner.style.background = 'transparent'; });

        const bannerDot = document.createElement('span');
        bannerDot.style.cssText = 'width: 6px; height: 6px; border-radius: 50%; background: var(--accent-primary); flex-shrink: 0;';
        proxyBanner.appendChild(bannerDot);

        const bannerText = document.createElement('span');
        bannerText.id = 'integration-banner-text';
        bannerText.style.cssText = 'font-size: 11px; font-weight: 500; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        proxyBanner.appendChild(bannerText);
        statusStack.appendChild(proxyBanner);

        // Claude Code plugin indicator — same compact pattern as the
        // proxy/SIEM banners. Visible only when the plugin is staged
        // (or auto-installed on Claude Code) so it doesn't shout when
        // nothing is in flight. Purple accent (8b5cf6) matches the
        // Claude Code category color on Tool Permissions.
        // Use a real <button> so keyboard users can Tab into it and
        // Enter/Space activates the same handler — replaces the prior
        // clickable <div> pattern (fails WCAG 2.1 SC 2.1.1 and 4.1.2).
        // aria-live="polite" announces state transitions to screen
        // readers when the banner becomes visible / changes copy.
        // Real <button> for keyboard reach + WCAG 2.1 SC 2.1.1/4.1.2.
        // aria-label uses neutral verb ("Open Claude Code plugin
        // settings") so it doesn't exclude keyboard/touch users with
        // "click to manage" phrasing.
        // Note: aria-live is placed on the INNER text span only —
        // SRs skip live-region announcements on display:none parents,
        // and we want state transitions ("staged" → "active") to be
        // heard. The wrapper button stays hidden until needed; the
        // inner span is the live region that gets repopulated.
        const ccPluginBanner = document.createElement('button');
        ccPluginBanner.type = 'button';
        ccPluginBanner.id = 'cc-plugin-active-banner';
        ccPluginBanner.className = 'proxy-banner-pulse';
        ccPluginBanner.setAttribute('aria-label', 'Open Claude Code plugin settings');
        // Padding + margin match the OpenClaw / SIEM banners exactly
        // (4px 10px / 8px 12px 0) so the three stack as equal-height
        // rows. `min-height` is dropped — letting the row size to its
        // content keeps it the same height as the sibling banners.
        // `width: calc(100% - 24px)` is still needed because <button>
        // doesn't auto-fill the way <div> does.
        ccPluginBanner.style.cssText = 'display: none; margin: 8px 12px 0; padding: 4px 10px; border-radius: 6px; cursor: pointer; background: transparent; border: 1px solid rgba(139,92,246,0.35); align-items: center; gap: 6px; transition: background 0.15s; font: inherit; text-align: left; color: inherit; width: calc(100% - 24px);';
        ccPluginBanner.addEventListener('mouseenter', () => { ccPluginBanner.style.background = 'rgba(139,92,246,0.06)'; });
        ccPluginBanner.addEventListener('mouseleave', () => { ccPluginBanner.style.background = 'transparent'; });
        const ccDot = document.createElement('span');
        ccDot.style.cssText = 'width: 6px; height: 6px; border-radius: 50%; background: #8b5cf6; flex-shrink: 0;';
        ccDot.setAttribute('aria-hidden', 'true');
        ccPluginBanner.appendChild(ccDot);
        const ccText = document.createElement('span');
        ccText.id = 'cc-plugin-banner-text';
        // aria-live on the text-bearing inner span so SRs announce
        // state changes regardless of parent display state.
        ccText.setAttribute('aria-live', 'polite');
        ccText.setAttribute('aria-atomic', 'true');
        ccText.style.cssText = 'font-size: 11px; font-weight: 500; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        ccPluginBanner.appendChild(ccText);
        ccPluginBanner.addEventListener('click', () => this.navigate('proxy-claude-code'));
        statusStack.appendChild(ccPluginBanner);

        // Codex plugin indicator — same compact pattern as the CC banner.
        // Visible only when the plugin is staged (or auto-installed in
        // ~/.codex) so it doesn't shout when nothing is in flight.
        //
        // Coral accent (#C0655E) intentionally diverges from the Codex
        // plugin manifest's brandColor (cyan #5EADB8): cyan collides
        // with this same sidebar's integration-proxy banner border
        // (also #5EADB8 / rgba(94,173,184,*)). Two cyan single-line
        // banners stacked together are visually indistinguishable.
        // Coral picks a distinct fourth hue so the bottom-section now
        // reads: CC purple · Codex coral · proxy cyan · SIEM green.
        // Padding + margin match the CC banner exactly (`8px 12px 0`)
        // so the four banners stack as equal-rhythm rows; hover alpha
        // matches CC's `0.06`.
        const codexPluginBanner = document.createElement('button');
        codexPluginBanner.type = 'button';
        codexPluginBanner.id = 'codex-plugin-active-banner';
        codexPluginBanner.className = 'proxy-banner-pulse';
        codexPluginBanner.setAttribute('aria-label', 'Open Codex plugin settings');
        codexPluginBanner.style.cssText = 'display: none; margin: 8px 12px 0; padding: 4px 10px; border-radius: 6px; cursor: pointer; background: transparent; border: 1px solid rgba(192,101,94,0.35); align-items: center; gap: 6px; transition: background 0.15s; font: inherit; text-align: left; color: inherit; width: calc(100% - 24px);';
        codexPluginBanner.addEventListener('mouseenter', () => { codexPluginBanner.style.background = 'rgba(192,101,94,0.06)'; });
        codexPluginBanner.addEventListener('mouseleave', () => { codexPluginBanner.style.background = 'transparent'; });
        const codexDot = document.createElement('span');
        codexDot.style.cssText = 'width: 6px; height: 6px; border-radius: 50%; background: #C0655E; flex-shrink: 0;';
        codexDot.setAttribute('aria-hidden', 'true');
        codexPluginBanner.appendChild(codexDot);
        const codexText = document.createElement('span');
        codexText.id = 'codex-plugin-banner-text';
        codexText.setAttribute('aria-live', 'polite');
        codexText.setAttribute('aria-atomic', 'true');
        codexText.style.cssText = 'font-size: 11px; font-weight: 500; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        codexPluginBanner.appendChild(codexText);
        codexPluginBanner.addEventListener('click', () => this.navigate('proxy-codex'));
        statusStack.appendChild(codexPluginBanner);

        // Copilot CLI plugin indicator — same compact pattern as the CC and
        // Codex banners; polls /api/hooks/copilot-cli/status.
        //
        // Blue accent (#4a8fe7) — the bottom-section hue set is now:
        // CC purple · Codex coral · Copilot blue · proxy cyan · SIEM green.
        // GitHub's Copilot brand purple would collide with the CC banner,
        // so blue (GitHub's own link/accent family) keeps the row
        // distinguishable at a glance when several stack together.
        const copilotPluginBanner = document.createElement('button');
        copilotPluginBanner.type = 'button';
        copilotPluginBanner.id = 'copilot-plugin-active-banner';
        copilotPluginBanner.className = 'proxy-banner-pulse';
        copilotPluginBanner.setAttribute('aria-label', 'Open Copilot CLI plugin settings');
        copilotPluginBanner.style.cssText = 'display: none; margin: 8px 12px 0; padding: 4px 10px; border-radius: 6px; cursor: pointer; background: transparent; border: 1px solid rgba(74,143,231,0.35); align-items: center; gap: 6px; transition: background 0.15s; font: inherit; text-align: left; color: inherit; width: calc(100% - 24px);';
        copilotPluginBanner.addEventListener('mouseenter', () => { copilotPluginBanner.style.background = 'rgba(74,143,231,0.06)'; });
        copilotPluginBanner.addEventListener('mouseleave', () => { copilotPluginBanner.style.background = 'transparent'; });
        const copilotDot = document.createElement('span');
        copilotDot.style.cssText = 'width: 6px; height: 6px; border-radius: 50%; background: #4a8fe7; flex-shrink: 0;';
        copilotDot.setAttribute('aria-hidden', 'true');
        copilotPluginBanner.appendChild(copilotDot);
        const copilotText = document.createElement('span');
        copilotText.id = 'copilot-plugin-banner-text';
        copilotText.setAttribute('aria-live', 'polite');
        copilotText.setAttribute('aria-atomic', 'true');
        copilotText.style.cssText = 'font-size: 11px; font-weight: 500; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        copilotPluginBanner.appendChild(copilotText);
        copilotPluginBanner.addEventListener('click', () => this.navigate('proxy-copilot-cli'));
        statusStack.appendChild(copilotPluginBanner);

        // SIEM Forwarder active indicator — mirrors the proxy banner
        // styling so both stack cleanly when on together. Visible only
        // when the master toggle is enabled AND at least one destination
        // is configured (no point showing "active" if nothing receives).
        const siemBanner = document.createElement('div');
        siemBanner.id = 'siem-active-banner';
        siemBanner.className = 'proxy-banner-pulse';
        // Green accent (10b981) — different from the cyan proxy banner
        // so operators can tell them apart at a glance when stacked.
        siemBanner.style.cssText = 'display: none; margin: 6px 12px 0; padding: 4px 10px; border-radius: 6px; cursor: pointer; background: transparent; border: 1px solid rgba(16,185,129,0.35); align-items: center; gap: 6px; transition: background 0.15s;';
        siemBanner.addEventListener('mouseenter', () => { siemBanner.style.background = 'rgba(16,185,129,0.06)'; });
        siemBanner.addEventListener('mouseleave', () => { siemBanner.style.background = 'transparent'; });
        const siemDot = document.createElement('span');
        siemDot.style.cssText = 'width: 6px; height: 6px; border-radius: 50%; background: #10b981; flex-shrink: 0;';
        siemBanner.appendChild(siemDot);
        const siemText = document.createElement('span');
        siemText.id = 'siem-banner-text';
        siemText.style.cssText = 'font-size: 11px; font-weight: 500; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        siemBanner.appendChild(siemText);
        siemBanner.addEventListener('click', () => this.navigate('siem-export'));
        statusStack.appendChild(siemBanner);

        // Resume polling when the document becomes visible again. The
        // poll loops self-terminate when visibilityState !== 'visible'
        // (to save background CPU), so without this listener a window
        // that was briefly backgrounded — e.g., during a backend
        // restart — would silently stop refreshing the indicators and
        // never restart them. Idempotent because each `check*` checks
        // for its own DOM node before re-scheduling, so calling them
        // when already polling is a no-op.
        if (!this._visibilityHookInstalled) {
            this._visibilityHookInstalled = true;
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    this.checkProxyStatus();
                    this.checkSiemStatus();
                    this.checkClaudeCodePluginStatus();
                    this.checkCodexPluginStatus();
                    this.checkCopilotPluginStatus();
                }
            });
        }

        container.appendChild(bottomSection);

        // Check all five indicators — AFTER the bottom section is attached.
        // The pollers look themselves up via document.getElementById and exit
        // (without rescheduling) when the node isn't in the document yet;
        // kicking them off before appendChild meant every banner stayed
        // hidden until a visibilitychange happened to restart them.
        this.checkProxyStatus();
        this.checkSiemStatus();
        this.checkClaudeCodePluginStatus();
        this.checkCodexPluginStatus();
        this.checkCopilotPluginStatus();
    },

    // Guardian ML control — an accent-bordered pill in the sidebar bottom
    // section (above "Try SecureVector"). It's the flagship local-detection
    // toggle, so it gets a more substantial treatment than the slim status
    // banners: a highlighted border + soft shadow that brighten when active,
    // plus a status dot. Mirrors the page-level toggle (PUT /api/settings
    // {guardian_ml_enabled}); enabling it pops a confirmation explaining what
    // the model does before committing; disabling commits immediately. The
    // label opens the full Guardian section on the Settings page.
    renderGuardianToggle(parent) {
        const pill = document.createElement('div');
        pill.className = 'guardian-pill';
        pill.dataset.guardianToggle = 'true';

        // Status dot — muted when off, accent + halo when active (CSS-driven
        // off the pill's data-active attribute).
        const dot = document.createElement('span');
        dot.className = 'gp-dot';
        dot.setAttribute('aria-hidden', 'true');
        pill.appendChild(dot);

        // Title + status sub-label, stacked. Clicking opens the full Guardian
        // section in Settings (the one affordance that survives collapsed mode).
        const textCol = document.createElement('div');
        textCol.className = 'gp-text';
        textCol.title = 'SecureVector Guardian — local ML threat detection. Click to open settings.';
        const title = document.createElement('span');
        title.className = 'gp-title';
        title.textContent = 'Guardian ML';
        // One-line description of what it is — the on/off state is carried by
        // the toggle, the status dot, and the border glow, so this stays a
        // fixed explainer rather than an "Active/Off" label.
        const sub = document.createElement('span');
        sub.className = 'gp-sub';
        sub.textContent = 'Local ML threat detection';
        textCol.appendChild(title);
        textCol.appendChild(sub);
        textCol.addEventListener('click', () => this.navigate('settings'));
        pill.appendChild(textCol);

        // Toggle switch — reuses the global .toggle / .toggle-slider markup so
        // it matches the Settings page exactly, scaled down for the rail.
        const toggle = document.createElement('label');
        toggle.className = 'toggle guardian-nav-toggle';
        toggle.style.cssText = 'flex-shrink: 0; transform: scale(0.8); transform-origin: right center;';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.setAttribute('aria-label', 'Toggle Guardian ML detection');
        const slider = document.createElement('span');
        slider.className = 'toggle-slider';
        toggle.appendChild(checkbox);
        toggle.appendChild(slider);
        pill.appendChild(toggle);

        // Single place that keeps the visual state (active glow via the
        // data-active attribute → dot + border) in sync with the checkbox.
        const reflect = (on) => {
            pill.dataset.active = on ? 'true' : 'false';
        };

        // Optimistic default ON (matches server default) so the pill doesn't
        // flash "Off" before the settings fetch resolves.
        checkbox.checked = true;
        reflect(true);
        API.getSettings().then(s => {
            const on = (s && s.guardian_ml_enabled) !== false;
            checkbox.checked = on;
            reflect(on);
        }).catch(() => { /* keep optimistic default */ });

        // Guard against the change handler firing while we set state ourselves.
        let suppress = false;
        const setChecked = (val) => { suppress = true; checkbox.checked = val; reflect(val); suppress = false; };

        const commit = async (enabled) => {
            try {
                await API.updateSettings({ guardian_ml_enabled: enabled });
                reflect(enabled);
                if (window.Toast) {
                    Toast.success(enabled
                        ? 'Guardian ML detection enabled'
                        : 'Guardian ML detection disabled — regex rules still active');
                }
            } catch (e) {
                setChecked(!enabled);
                if (window.Toast) Toast.error('Failed to update Guardian setting');
            }
        };

        checkbox.addEventListener('change', (e) => {
            if (suppress) return;
            const enabled = e.target.checked;
            if (enabled) {
                // Opt-in: hold the switch OFF until the user confirms, so
                // dismissing the modal (Cancel / X / overlay) leaves it off
                // with no extra wiring. Only an explicit confirm turns it on.
                setChecked(false);
                this.showGuardianEnableConfirm(() => { setChecked(true); commit(true); });
            } else {
                commit(false);
            }
        });

        parent.appendChild(pill);
    },

    // Confirmation popup shown when the user flips Guardian ML on — explains
    // what the model does so enabling is an informed opt-in. onConfirm commits
    // the change. Dismissing the modal (Cancel / X / overlay) does nothing:
    // the caller holds the switch off until confirmed, so no revert is needed.
    showGuardianEnableConfirm(onConfirm) {
        const content = document.createElement('div');

        const lead = document.createElement('p');
        lead.style.cssText = 'margin: 0 0 12px; line-height: 1.5;';
        lead.textContent = 'Guardian adds a local ML model that runs alongside the regex rules on every analyze call — catching obfuscated, paraphrased, and base64/hex-encoded attacks the rules miss.';
        content.appendChild(lead);

        const list = document.createElement('ul');
        list.style.cssText = 'margin: 0 0 12px; padding-left: 18px; line-height: 1.6; color: var(--text-secondary);';
        [
            'Fully offline — nothing leaves your machine, no API key.',
            'Fast — sub-millisecond on a typical prompt or tool call.',
            'Additive only — it strengthens a verdict, never silences a rule: blocks on its own at high confidence, corroborates a firing rule at a lower bar.',
        ].forEach(t => {
            const li = document.createElement('li');
            li.textContent = t;
            list.appendChild(li);
        });
        content.appendChild(list);

        const foot = document.createElement('p');
        foot.style.cssText = 'margin: 0; font-size: 13px; color: var(--text-muted, #7d8590);';
        foot.textContent = 'You can turn it off anytime here or on the Settings page. Regex rules keep running either way.';
        content.appendChild(foot);

        Modal.show({
            title: 'Enable Guardian ML detection?',
            content,
            size: 'small',
            actions: [
                { label: 'Cancel', primary: false },
                { label: 'Enable Guardian', primary: true, onClick: onConfirm },
            ],
        });
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
        default: { icon: '', label: 'PROXY', color: 'linear-gradient(135deg, #5eadb8, #c0655e)', page: 'integrations' },
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
                            // Always label as SecureVector proxy to avoid conflating
                            // with the user's OpenClaw gateway. The integration is
                            // shown in parens for context (what agent started it).
                            const friendlyNames = {
                                openclaw: 'OpenClaw', ollama: 'Ollama', langchain: 'LangChain',
                                langgraph: 'LangGraph', crewai: 'CrewAI', n8n: 'n8n',
                            };
                            const name = friendlyNames[integration];
                            const modeTag = data.multi ? 'multi-provider' : (data.provider || 'single');
                            const integrationTag = name ? ` for ${name}` : '';
                            textEl.textContent = `SecureVector proxy running (${modeTag})${integrationTag}`;
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

    async checkSiemStatus() {
        // Sidebar "SIEM active" indicator. Visible only when:
        //   (a) master toggle is enabled (siem-forwarders/global-settings)
        //   (b) at least one destination is configured + enabled
        // Otherwise the banner hides — we don't mislead operators into
        // thinking something's flowing when the pipe is paused or empty.
        try {
            const [global, list] = await Promise.all([
                fetch('/api/siem-forwarders/global-settings').then(r => r.ok ? r.json() : null).catch(() => null),
                fetch('/api/siem-forwarders').then(r => r.ok ? r.json() : null).catch(() => null),
            ]);
            const banner = document.getElementById('siem-active-banner');
            const textEl = document.getElementById('siem-banner-text');
            if (banner && textEl) {
                const enabled = !!(global && global.enabled);
                const items = (list && Array.isArray(list.items)) ? list.items : [];
                const activeCount = items.filter(f => f.enabled).length;
                if (enabled && activeCount > 0) {
                    banner.style.display = 'flex';
                    textEl.textContent = `SIEM Forwarder active (${activeCount} destination${activeCount === 1 ? '' : 's'})`;
                } else {
                    banner.style.display = 'none';
                }
            }
        } catch (_) { /* ignore */ }
        setTimeout(() => this.checkSiemStatus(), 5000);
    },

    async checkClaudeCodePluginStatus() {
        // Sidebar "Claude Code plugin" indicator. Visible whenever the
        // SecureVector Guard plugin is staged (files on disk) — wording
        // varies by deployment state. Wording is now consistent with
        // the integrations page's three states (Active / Installed,
        // not enabled / Staged) so users see the same labels in both
        // surfaces.
        const banner = document.getElementById('cc-plugin-active-banner');
        const textEl = document.getElementById('cc-plugin-banner-text');
        // If the sidebar was torn down (page navigation, SPA re-render),
        // both lookups return null. Stop polling — don't leak a timer.
        if (!banner || !textEl) return;
        try {
            const res = await fetch('/api/hooks/claude-code/status');
            const status = res.ok ? await res.json() : null;
            if (!status || !status.installed) {
                banner.style.display = 'none';
            } else if (status.auto_installed && status.enabled) {
                banner.style.display = 'flex';
                textEl.textContent = 'Claude Code plugin · Active';
            } else if (status.auto_installed) {
                banner.style.display = 'flex';
                textEl.textContent = 'Claude Code plugin · Installed, not enabled';
            } else {
                banner.style.display = 'flex';
                textEl.textContent = 'Claude Code plugin · Staged';
            }
        } catch (_) { /* ignore */ }
        // Only re-schedule when the document is visible and the banner
        // is still mounted — saves CPU when the tab is in background.
        // Cadence: if the banner is currently HIDDEN (plugin not yet
        // installed, or initial fetch raced an install), poll every
        // 2s so the banner appears quickly after install completes.
        // Once visible, drop to a 10s cadence — the state is settled.
        if (document.visibilityState === 'visible'
            && document.getElementById('cc-plugin-active-banner')) {
            const visible = banner.style.display !== 'none';
            const delay = visible ? 10000 : 2000;
            setTimeout(() => this.checkClaudeCodePluginStatus(), delay);
        }
    },

    async checkCopilotPluginStatus() {
        // Sidebar "Copilot CLI plugin" indicator. Mirrors the CC/Codex
        // pollers — same three states (Active / Installed, not enabled /
        // Staged), same cadence (2s while hidden, 10s once visible). The
        // Copilot /status route reports installed/enabled from
        // ~/.copilot/config.json's installedPlugins registration.
        const banner = document.getElementById('copilot-plugin-active-banner');
        const textEl = document.getElementById('copilot-plugin-banner-text');
        if (!banner || !textEl) return;
        try {
            const res = await fetch('/api/hooks/copilot-cli/status');
            const status = res.ok ? await res.json() : null;
            if (!status || !status.installed) {
                banner.style.display = 'none';
            } else if (status.auto_installed && status.enabled) {
                banner.style.display = 'flex';
                textEl.textContent = 'Copilot CLI plugin · Active';
            } else if (status.auto_installed) {
                banner.style.display = 'flex';
                textEl.textContent = 'Copilot CLI plugin · Installed, not enabled';
            } else {
                banner.style.display = 'flex';
                textEl.textContent = 'Copilot CLI plugin · Staged';
            }
        } catch (_) { /* ignore */ }
        if (document.visibilityState === 'visible'
            && document.getElementById('copilot-plugin-active-banner')) {
            const visible = banner.style.display !== 'none';
            const delay = visible ? 10000 : 2000;
            setTimeout(() => this.checkCopilotPluginStatus(), delay);
        }
    },

    async checkCodexPluginStatus() {
        // Sidebar "Codex plugin" indicator. Mirrors the CC poller — same
        // three states (Active / Installed, not enabled / Staged), same
        // cadence (2s while hidden, 10s once visible). The Codex /status
        // route uses `codex_install_path` instead of `claude_install_path`
        // and `enabled` reflects the [plugins."..."] section in
        // ~/.codex/config.toml.
        const banner = document.getElementById('codex-plugin-active-banner');
        const textEl = document.getElementById('codex-plugin-banner-text');
        if (!banner || !textEl) return;
        try {
            const res = await fetch('/api/hooks/codex/status');
            const status = res.ok ? await res.json() : null;
            if (!status || !status.installed) {
                banner.style.display = 'none';
            } else if (status.auto_installed && status.enabled) {
                banner.style.display = 'flex';
                textEl.textContent = 'Codex plugin · Active';
            } else if (status.auto_installed) {
                banner.style.display = 'flex';
                textEl.textContent = 'Codex plugin · Installed, not enabled';
            } else {
                banner.style.display = 'flex';
                textEl.textContent = 'Codex plugin · Staged';
            }
        } catch (_) { /* ignore */ }
        if (document.visibilityState === 'visible'
            && document.getElementById('codex-plugin-active-banner')) {
            const visible = banner.style.display !== 'none';
            const delay = visible ? 10000 : 2000;
            setTimeout(() => this.checkCodexPluginStatus(), delay);
        }
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
            // Guardian ML — a CPU/chip glyph signals "local ML model", keeping
            // it visually distinct from the two shields (Threats / MCP Policies)
            // so the nav doesn't read as a triplicated shield.
            guardian: [
                { tag: 'rect', attrs: { x: '4', y: '4', width: '16', height: '16', rx: '2' } },
                { tag: 'rect', attrs: { x: '9', y: '9', width: '6', height: '6' } },
                { tag: 'line', attrs: { x1: '9', y1: '1', x2: '9', y2: '4' } },
                { tag: 'line', attrs: { x1: '15', y1: '1', x2: '15', y2: '4' } },
                { tag: 'line', attrs: { x1: '9', y1: '20', x2: '9', y2: '23' } },
                { tag: 'line', attrs: { x1: '15', y1: '20', x2: '15', y2: '23' } },
                { tag: 'line', attrs: { x1: '20', y1: '9', x2: '23', y2: '9' } },
                { tag: 'line', attrs: { x1: '20', y1: '14', x2: '23', y2: '14' } },
                { tag: 'line', attrs: { x1: '1', y1: '9', x2: '4', y2: '9' } },
                { tag: 'line', attrs: { x1: '1', y1: '14', x2: '4', y2: '14' } },
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
            // Shield with a checkmark inside — distinguishes MCP Policies
            // (cloud-pushed verified rules) from the bare 'shield' (Threat
            // Monitor) and 'lock' (local Tool Permissions).
            'shield-check': [
                { tag: 'path', attrs: { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' } },
                { tag: 'polyline', attrs: { points: '8 12 11 15 16 9' } },
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
            // Document with horizontal bar lines — read as "report" without
            // colliding with the 'rules' icon (which also looks document-y).
            report: [
                { tag: 'path', attrs: { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' } },
                { tag: 'polyline', attrs: { points: '14 2 14 8 20 8' } },
                { tag: 'line', attrs: { x1: '8', y1: '13', x2: '14', y2: '13' } },
                { tag: 'line', attrs: { x1: '8', y1: '17', x2: '16', y2: '17' } },
            ],
            scan: [
                { tag: 'circle', attrs: { cx: '11', cy: '11', r: '8' } },
                { tag: 'line', attrs: { x1: '21', y1: '21', x2: '16.65', y2: '16.65' } },
                { tag: 'line', attrs: { x1: '11', y1: '8', x2: '11', y2: '14' } },
                { tag: 'line', attrs: { x1: '8', y1: '11', x2: '14', y2: '11' } },
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
            if (el) {
                // Expand the collapsed card body before scrolling so the
                // section content is visible at the scroll target — without
                // this, clicking a sub-item while already on /guide just
                // scrolls to a closed header and the user sees "nothing".
                const body = el.querySelector('.gs-card-body');
                const indicator = el.querySelector('.gs-toggle-indicator');
                if (body && body.style.display === 'none') {
                    body.style.display = 'block';
                    if (indicator) indicator.textContent = '−';
                }
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        } else {
            this._pendingScroll = sectionId;
            if (window.App) App.loadPage(page);
        }
    },

    setActive(page) {
        this.currentPage = page;
        document.querySelectorAll('.nav-item').forEach(item => {
            const isSubItem = item.classList.contains('nav-sub-item');
            const matchesPage = item.dataset.page === page ||
                (item.dataset.aliases || '').split(',').includes(page);
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

/**
 * TryItChat — floating chat window for testing prompt analysis
 */
const TryItChat = {
    panel: null,

    open() {
        if (!this.panel) this._build();
        this.panel.classList.add('open');
        this._focusInput();
    },

    close() {
        if (this.panel) this.panel.classList.remove('open');
    },

    _focusInput() {
        if (!this.panel) return;
        const ta = this.panel.querySelector('.tryit-chat-input');
        if (ta) setTimeout(() => ta.focus(), 60);
    },

    _build() {
        const panel = document.createElement('div');
        panel.className = 'tryit-chat-panel';

        // ── Header ──────────────────────────────
        const header = document.createElement('div');
        header.className = 'tryit-chat-header';

        const headerLeft = document.createElement('div');
        headerLeft.style.cssText = 'display:flex; align-items:center; gap:8px;';

        const shieldIcon = document.createElement('img');
        shieldIcon.src = '/images/favicon.png';
        shieldIcon.style.cssText = 'width:18px; height:18px; object-fit:contain; flex-shrink:0;';
        headerLeft.appendChild(shieldIcon);

        const headerTitle = document.createElement('div');
        const titleLine = document.createElement('div');
        titleLine.style.cssText = 'font-weight:700; font-size:13px; color:var(--text-primary);';
        titleLine.textContent = 'Try SecureVector';
        const subtitleLine = document.createElement('div');
        subtitleLine.style.cssText = 'font-size:10.5px; color:var(--text-muted);';
        subtitleLine.textContent = 'Test any prompt for threats';
        headerTitle.appendChild(titleLine);
        headerTitle.appendChild(subtitleLine);
        headerLeft.appendChild(headerTitle);
        header.appendChild(headerLeft);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'tryit-chat-close';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => this.close());
        header.appendChild(closeBtn);

        const clearBtn = document.createElement('button');
        clearBtn.className = 'tryit-chat-clear';
        clearBtn.title = 'Clear chat';
        clearBtn.textContent = '🗑';
        clearBtn.style.cssText = 'background:none; border:none; font-size:13px; cursor:pointer; color:var(--text-muted); padding:2px 6px; border-radius:4px; transition:color 0.15s;';
        clearBtn.addEventListener('click', () => {
            const feed = panel.querySelector('.tryit-chat-feed');
            if (feed) { feed.textContent = ''; this._addWelcome(feed); }
        });
        header.appendChild(clearBtn);

        panel.appendChild(header);

        // ── Message feed ─────────────────────────
        const feed = document.createElement('div');
        feed.className = 'tryit-chat-feed';
        this._addWelcome(feed);
        panel.appendChild(feed);

        // ── Input row ────────────────────────────
        const inputRow = document.createElement('div');
        inputRow.className = 'tryit-chat-input-row';

        const textarea = document.createElement('textarea');
        textarea.className = 'tryit-chat-input';
        textarea.placeholder = 'Type a prompt to test… (Enter to send)';
        textarea.rows = 1;
        textarea.addEventListener('input', () => {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 96) + 'px';
        });
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendBtn.click();
            }
        });
        inputRow.appendChild(textarea);

        const sendBtn = document.createElement('button');
        sendBtn.className = 'tryit-chat-send';
        sendBtn.textContent = '→';
        sendBtn.addEventListener('click', () => this._send(textarea, feed));
        inputRow.appendChild(sendBtn);

        panel.appendChild(inputRow);

        document.body.appendChild(panel);
        this.panel = panel;
    },

    _addWelcome(feed) {
        const welcome = document.createElement('div');
        welcome.className = 'tryit-msg tryit-msg-system';
        welcome.textContent = 'Send any prompt — SecureVector will scan it for injection, jailbreaks, data leaks, and 300+ threat patterns.';
        feed.appendChild(welcome);
    },

    async _send(textarea, feed) {
        const text = textarea.value.trim();
        if (!text) return;

        textarea.value = '';
        textarea.style.height = 'auto';

        // User bubble
        const userBubble = document.createElement('div');
        userBubble.className = 'tryit-msg tryit-msg-user';
        userBubble.textContent = text;
        feed.appendChild(userBubble);
        feed.scrollTop = feed.scrollHeight;

        // Thinking bubble
        const thinking = document.createElement('div');
        thinking.className = 'tryit-msg tryit-msg-thinking';
        thinking.textContent = 'Scanning…';
        feed.appendChild(thinking);
        feed.scrollTop = feed.scrollHeight;

        try {
            const res = await API.analyze(text);
            thinking.remove();

            const isThreat = res.is_threat;
            const score = res.risk_score || 0;
            const type = res.threat_type || '';
            const rules = res.matched_rules || [];

            const resultBubble = document.createElement('div');
            resultBubble.className = 'tryit-msg tryit-msg-result ' + (isThreat ? 'threat' : 'safe');

            const topRow = document.createElement('div');
            topRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:6px;';

            const badge = document.createElement('span');
            badge.className = 'tryit-result-badge';
            badge.textContent = isThreat ? '⚠ Threat Detected' : '✓ Safe';
            topRow.appendChild(badge);

            const scoreChip = document.createElement('span');
            scoreChip.className = 'tryit-result-score';
            scoreChip.textContent = score + '% risk';
            topRow.appendChild(scoreChip);

            resultBubble.appendChild(topRow);

            if (isThreat && type) {
                const typeRow = document.createElement('div');
                typeRow.style.cssText = 'font-size:11.5px; color:var(--text-secondary); margin-bottom:4px;';
                typeRow.textContent = 'Type: ' + type;
                resultBubble.appendChild(typeRow);
            }

            if (rules.length > 0) {
                const rulesRow = document.createElement('div');
                rulesRow.style.cssText = 'display:flex; flex-wrap:wrap; gap:4px; margin-top:4px;';
                rules.slice(0, 4).forEach(r => {
                    const chip = document.createElement('span');
                    chip.style.cssText = 'font-size:10px; padding:1px 6px; border-radius:3px; background:var(--bg-tertiary); color:var(--text-muted);';
                    chip.textContent = r;
                    rulesRow.appendChild(chip);
                });
                resultBubble.appendChild(rulesRow);
            }

            feed.appendChild(resultBubble);
        } catch (e) {
            thinking.remove();
            const errBubble = document.createElement('div');
            errBubble.className = 'tryit-msg tryit-msg-result threat';
            errBubble.textContent = 'Error: ' + (e.message || 'Request failed');
            feed.appendChild(errBubble);
        }

        feed.scrollTop = feed.scrollHeight;
    },
};

window.TryItChat = TryItChat;
