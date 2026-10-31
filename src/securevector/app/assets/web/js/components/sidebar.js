/**
 * Sidebar Navigation Component
 * Note: All content is static/hardcoded, no user input is rendered
 */

const Sidebar = {
    navItems: [
        // v6 session-first navigation. Agent Sessions is the first/default work
        // surface. Pages that used to be their own rows are
        // `views` of a destination: they render indented under the active row
        // or inside the hover flyout. Every old page
        // id stays routable and highlights its parent via `views` or `aliases`,
        // so deep links, the palette and Governance gap cards still land.
        { id: 'terminals', label: 'Agent Sessions', icon: 'terminal',
          tooltip: 'Launch, return to, and govern an agent task', views: [] },
        { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
        // Observability has no left-nav sub-items. Its four views (Runs,
        // Live grid, Health, Map) are the in-page tabs, which switch views.
        // Every Observability page id is an alias so the row stays lit; the
        // older trace pages are aliases too. Tool Activity moved under
        // Policies > Tool Permissions; Instant Audit is a button on the
        // Threats page. liveWaiting puts the waiting-approvals badge here.
        { id: 'agent-runs', label: 'Observability', icon: 'history', liveWaiting: true,
          aliases: ['run-health', 'agent-activity', 'storylines', 'agent-map', 'agent-timeline', 'replay', 'live-grid'],
          tooltip: 'Every agent run as a trace: turns, tool calls, verdicts and cost' },
        { id: 'threats', label: 'Threats', icon: 'shield', aliases: ['threat-monitor', 'instant-audit'], count: 'threats',
          tooltip: 'Prompt injection, jailbreak and exfiltration attempts, plus what was blocked and which secrets were caught',
          views: [
            { id: 'threats', label: 'Detections' },
            { id: 'blocked-ledger', label: 'Blocked Actions', count: 'blocked' },
            { id: 'redactions', label: 'Secret Detections', count: 'secrets' },
          ] },
        { id: 'governance', label: 'Agent Governance', icon: 'gauge', tooltip: 'How protected this one device is right now, and the gaps to close' },
        { id: 'detection-response', label: 'Agent Detection & Response', icon: 'radar',
          tooltip: 'Sessions that did something unusual, and agent config changes to check.' },
        { id: 'costs', label: 'Cost & Tokens', icon: 'costs', tooltip: 'What your agents spend on model calls, per agent, model and session' },
        { id: 'egress', label: 'Agent Egress', icon: 'proxy', count: 'egress',
          tooltip: 'Every external host your agents reached, first seen and how often' },
        // Configure: Policies is the one destination; each policy surface is
        // a view with its own icon, shown under the row only while you are in
        // it. Same fold as Traces and Threats, so the rail stays short at rest.
        { id: 'policies', label: 'Policies', icon: 'sliders', aliases: ['policies-controls'],
          tooltip: 'Everything that decides what an agent may do, with live status for each control',
          views: [
            // The hoist (below, where a group's sole item is also its
            // landing) skips the parent `policies` row entirely, which was
            // the only row carrying `policies-controls` (the item's own
            // alias). Without this, that live route resolves to no active
            // row and the sliding indicator hides. Carried here instead so
            // the hoisted Overview row still matches it.
            { id: 'policies', label: 'Overview', aliases: ['policies-controls'], tooltip: 'Every control at a glance, with live status for each' },
            { id: 'tool-permissions', label: 'Tool Permissions', icon: 'lock', aliases: ['tool-activity', 'bill-of-tools'],
              tooltip: 'Which tools each agent may call, and requests waiting on you' },
            { id: 'rules', label: 'Rules', icon: 'rules',
              tooltip: 'Detection rules: the community library plus your own' },
            { id: 'egress-policy', label: 'Egress Policy', icon: 'proxy',
              tooltip: 'Which external hosts agents may reach' },
            { id: 'cost-settings', label: 'Cost Settings', icon: 'costs',
              tooltip: 'Budgets and model pricing used for spend tracking' },
            { id: 'mcp-policies', label: 'MCP Policies', icon: 'integrations', cloud: true,
              tooltip: 'Allow and block MCP servers, synced from your SecureVector account' },
            { id: 'skill-scanner', label: 'Skills Scanner', icon: 'scan', aliases: ['skill-permissions'],
              tooltip: 'Static scan of installed agent skills before they run' },
          ] },
        { id: 'guide-connect-agents', label: 'Connect Agents', icon: 'plug', aliases: ['connect-wizard', 'integrations', 'proxy-claude-code', 'proxy-codex', 'proxy-copilot-cli', 'proxy-cursor', 'proxy-opencode', 'proxy-antigravity', 'proxy-openclaw', 'proxy-python', 'proxy-node', 'proxy-langchain', 'proxy-langgraph', 'proxy-crewai', 'proxy-hermes', 'proxy-n8n', 'proxy-ollama'],
          tooltip: 'Connect any agent: Python @guard, framework SDKs, coding-agent plugins, proxies' },
        { id: 'siem-export', label: 'Cloud & Forwarders', icon: 'rocket',
          tooltip: 'SIEM forwarding and Cloud Connect activity',
          views: [
            { id: 'siem-export', label: 'SIEM Forwarder' },
            { id: 'cloud-activity', label: 'Cloud Activity', cloud: true },
          ] },
        { id: 'guide', label: 'Guide', icon: 'book', aliases: ['guide-claude-code', 'guide-codex', 'guide-copilot-cli', 'guide-cursor', 'guide-opencode', 'guide-antigravity', 'guide-openclaw', 'guide-frameworks', 'gs-read-map', 'gs-read-runs', 'gs-tool-inventory', 'gs-secret-detections', 'gs-mcp-policies', 'gs-siem-forwarder', 'gs-skill-scanner', 'gs-api', 'gs-troubleshoot'],
          tooltip: 'Setup guides, how to read the data, API reference, troubleshooting' },
        { id: 'settings', label: 'Settings', icon: 'settings', aliases: ['guardian-ml'] },
    ],
    productGroups: [
        { id: 'visibility', label: 'Visibility', icon: 'dashboard', landing: 'dashboard',
          subtitle: 'See agent activity, threats, spend, and egress', items: ['dashboard', 'agent-runs', 'threats', 'costs', 'egress'] },
        { id: 'tasks', label: 'Agents', icon: 'terminal', landing: 'terminals',
          subtitle: 'Launch and return to governed agent sessions', items: ['terminals'] },
        { id: 'detect', label: 'Detection & Response', title: 'Agent Detection & Response', icon: 'radar', landing: 'detection-response',
          subtitle: 'Sessions that did something unusual, and agent config changes to check', items: ['detection-response'] },
        { id: 'governance', label: 'Governance', icon: 'gauge', landing: 'governance',
          subtitle: 'Review protection posture and approvals', items: ['governance'] },
        { id: 'policies', label: 'Policies', icon: 'sliders', landing: 'policies',
          subtitle: 'Set the controls agents must follow', items: ['policies'] },
        { id: 'connect', label: 'Connect', icon: 'plug', landing: 'guide-connect-agents',
          subtitle: 'Connect agents and forward security events', items: ['guide-connect-agents', 'siem-export'] },
        { id: 'more', label: 'More', icon: 'more', landing: 'guide',
          subtitle: 'Open product guides', items: ['guide'] },
        // Settings has no rail button: it is pinned beside Theme at the foot
        // of the panel on every page. The group only gives the page a home.
        { id: 'settings', label: 'Settings', icon: 'settings', landing: 'settings', rail: false,
          subtitle: 'App settings', items: ['settings'] },
    ],
    currentPage: 'dashboard',

    // The parent is the consolidated command centre; these direct session
    // entries are hydrated once terminal authentication is ready.
    _agentTaskViewsLoading: false,
    _agentTaskViewsLoaded: false,
    _agentTaskViewsRerun: false,

    collapsed: false,

    // Min/max bounds apply to the full two-column navigation. The minimum
    // leaves a readable context panel beside the 72px product rail.
    SIDEBAR_MIN_PX: 300,
    SIDEBAR_MAX_PX: 440,

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

        // A group switch clears the container below, detaching whatever
        // product-rail button opened the flyout — its mouseleave never fires,
        // so the flyout would otherwise be stranded open over the content
        // area. Hide it up front, before anything is torn down.
        this._flyoutHide(true);

        // Check saved collapsed state
        const savedCollapsed = localStorage.getItem('sidebar-collapsed');
        // Desktop opens EXPANDED. The icon rail is a deliberate space-saving
        // choice, never a state someone lands in by accident: the desktop shell
        // opens at 1200px, so a width-derived default started every fresh
        // profile collapsed, with six destinations behind a hover. The user's
        // own choice still wins once they have made one.
        // Owner decision (6.1): every app load opens with the icon rail
        // collapsed; a toggle still holds for the rest of the session.
        if (!Sidebar._railDefaultApplied) {
            Sidebar._railDefaultApplied = true;
            this.collapsed = true;
            // Persist it, or the next render in this session reads an older
            // saved "expanded" and reopens the rail.
            try { localStorage.setItem('sidebar-collapsed', 'true'); } catch (_) {}
        } else {
            this.collapsed = savedCollapsed !== null ? savedCollapsed === 'true' : true;
        }
        // Mobile uses an off-canvas drawer: once open, it always needs both
        // product and context columns regardless of the saved desktop state.
        if (window.innerWidth <= 768) this.collapsed = false;
        container.classList.toggle('collapsed', this.collapsed);

        // Restore the user's last sidebar width before rendering so the
        // expanded rail comes up at the right size on first paint.
        this._applySavedSidebarWidth();

        // Clean default on every app load: only "Observability" opens
        // automatically. Integrations + Guide always start collapsed even if
        // the user expanded them in a prior session (navigating into a
        // sub-item persists `nav-<id>-expanded=true`, which otherwise leaks
        // an expanded section onto the next launch). Run once per page load —
        // guarded so mid-session re-renders (e.g. theme toggle) don't fight a
        // section the user just opened.
        if (!Sidebar._loadDefaultsApplied) {
            Sidebar._loadDefaultsApplied = true;
            // Owner decision (6.1): every expandable menu starts closed.
            try {
                Object.keys(localStorage).filter(k => /^nav-.+-expanded$/.test(k))
                    .forEach(k => localStorage.removeItem(k));
            } catch (_) { /* storage unavailable: defaults below apply */ }
        }

        // A group switch re-renders the whole rail, so the node the user is
        // standing on is removed and focus falls back to <body>. Record where
        // focus and the destination list were, and put them back after the
        // rebuild. Only a rail button inside THIS sidebar counts, so a render
        // triggered while the user is typing in the page never steals focus.
        const priorFocus = document.activeElement;
        const focusedRailGroup = priorFocus && container.contains(priorFocus)
            && priorFocus.classList && priorFocus.classList.contains('product-rail-button')
            ? priorFocus.dataset.productGroup : null;
        const priorNav = container.querySelector('.sidebar-nav');
        const priorNavScroll = priorNav ? priorNav.scrollTop : 0;
        // Only meaningful alongside the group it was captured from — applying
        // it after a group switch drops the old offset onto a different,
        // possibly shorter, list.
        const priorContext = container.querySelector('.sidebar-context');
        const priorNavGroup = priorContext ? priorContext.dataset.productGroup : null;

        // Clear container
        container.textContent = '';

        const activeGroup = this._activeProductGroup(this.currentPage);
        this._renderedProductGroup = activeGroup.id;
        const productRail = this._createProductRail(activeGroup);
        const contextPanel = document.createElement('div');
        contextPanel.className = 'sidebar-context';
        contextPanel.dataset.productGroup = activeGroup.id;
        container.appendChild(productRail);
        container.appendChild(contextPanel);

        // The compact product rail owns the shield. The context header keeps
        // the existing wordmark and version so product identity remains clear
        // without duplicating the logo in both columns.
        const header = document.createElement('div');
        header.className = 'sidebar-header';

        const logoLink = document.createElement('div');
        logoLink.className = 'sidebar-logo-link';
        logoLink.style.cursor = 'pointer';
        logoLink.addEventListener('click', () => this.navigate('terminals'));

        // Wrap the brand text + tagline in a column so the tagline sits
        // under the wordmark without pushing the favicon around.
        const logoTextCol = document.createElement('div');
        logoTextCol.className = 'sidebar-logo-text';

        // Wordmark on the first line, version on its own line beneath it.
        const logo = document.createElement('span');
        logo.className = 'sidebar-logo';
        logo.textContent = 'SecureVector';
        logoTextCol.appendChild(logo);

        // App version, read from the running server rather than typed
        // here. A literal needing a manual bump every release is how the app
        // shipped 5.1.0 while announcing 5.0.0 elsewhere; /health already
        // reports the real version, so ask it. The major-only string stays as
        // the pre-fetch value so the line never renders empty.
        const version = document.createElement('span');
        version.className = 'sidebar-version';
        version.textContent = 'v5';
        fetch('/health')
            .then(r => r.ok ? r.json() : null)
            // Shape-check before it lands in chrome: a version is short and
            // alphanumeric, and nothing else belongs in this slot.
            .then(d => {
                const v = d && d.version ? String(d.version) : '';
                if (/^[\w.+-]{1,20}$/.test(v)) version.textContent = 'v' + v;
            })
            .catch(() => {});   // offline or mid-restart: the fallback stands
        logoTextCol.appendChild(version);

        // No tagline in the rail. A marketing positioning line belongs on the
        // surfaces where someone is still deciding — login, README, docs — not
        // in authenticated chrome, where the user has already adopted the
        // product. Observability and security tools conventionally leave this
        // slot for orientation (workspace, environment, tier, version); here
        // the version line under the wordmark already fills that role.

        logoLink.appendChild(logoTextCol);

        header.appendChild(logoLink);
        contextPanel.appendChild(header);
        contextPanel.appendChild(this._createSearchRow());

        const contextHeading = document.createElement('div');
        contextHeading.className = 'sidebar-context-heading';
        const contextTitle = document.createElement('div');
        contextTitle.className = 'sidebar-context-title';
        contextTitle.textContent = activeGroup.title || activeGroup.label;
        const contextSubtitle = document.createElement('div');
        contextSubtitle.className = 'sidebar-context-subtitle';
        contextSubtitle.textContent = activeGroup.subtitle;
        contextHeading.appendChild(contextTitle);
        contextHeading.appendChild(contextSubtitle);
        // The heading is the group's own landing, and for a single-item group
        // it is the ONLY way to reach it from this panel: the hoist below drops
        // the destination row to avoid saying the same label three times, which
        // also drops the one thing that led to the landing page. The rail button
        // still goes there, but nothing in the panel did.
        if (activeGroup.landing) {
            // The tasks group wants the board, not the task the person left
            // attached. navigate() alone restores that task, so this takes the
            // same route the rail button and the logo already take.
            const goToLanding = () => {
                if (activeGroup.id === 'tasks') { this._showAgentTasksBoard(); return; }
                this.navigate(activeGroup.landing);
            };
            contextHeading.classList.add('is-clickable');
            contextHeading.title = `Open ${activeGroup.title || activeGroup.label}`;
            contextHeading.addEventListener('click', goToLanding);
            this._makeRowFocusable(contextHeading, goToLanding);
        }
        contextPanel.appendChild(contextHeading);

        // Create nav
        const nav = document.createElement('nav');
        nav.className = 'sidebar-nav';

        // Core features get an orange badge dot overlaid on their icon

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

        // The product rail is the only top-level grouping. Keep the existing
        // row/view renderer below, filtered to the active group's destinations.
        const SECTION_BEFORE = {};

        const sections = [];
        let currentSection = null;

        this.navItems.forEach(item => {
            if (!activeGroup.items.includes(item.id)) return;

            // A group with exactly one item, which is that group's own
            // landing page, would otherwise show the same label three times:
            // the rail button, the context heading, and this single
            // destination row. Skip the row and hoist the item's views (if
            // it has any) straight into the list instead, so every page
            // behind it stays reachable without the redundant parent.
            if (activeGroup.items.length === 1 && activeGroup.landing === item.id) {
                // Detection & Response lists the page's own sections instead.
                if (activeGroup.id === 'detect') { nav.appendChild(this._createDrSections()); return; }
                if (item.views && item.views.length) {
                    const viewsEl = this._renderViews(item, true);
                    viewsEl.classList.add('nav-views-flat');
                    nav.appendChild(viewsEl);
                }
                return;
            }

            // Cloud-locked = a CLOUD_TIER surface on a device that isn't known
            // to be enrolled. The row still renders (discoverability) but gets
            // a dimmed, "locked" treatment below instead of being hidden.
            const isCloudLocked = CLOUD_TIER.has(item.id) && this._enrolled !== true;

            // Section label — a clickable group header. Clicking collapses /
            // expands every row in the section (wired after the loop, once
            // the group's rows are known); state persists per section.
            if (SECTION_BEFORE[item.id]) {
                const name = SECTION_BEFORE[item.id];
                const sectionLbl = document.createElement('button');
                sectionLbl.type = 'button';
                sectionLbl.className = 'nav-section-label nav-section-toggle';
                const lblText = document.createElement('span');
                lblText.textContent = name;
                lblText.style.cssText = 'text-align: left;';
                sectionLbl.appendChild(lblText);
                // Real SVG chevron (the old 9px "▾" read as a stray dot, so a
                // collapsed section looked like an empty header, not a door).
                const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                chev.setAttribute('viewBox', '0 0 24 24');
                chev.setAttribute('fill', 'none');
                chev.setAttribute('stroke', 'currentColor');
                chev.setAttribute('stroke-width', '2.4');
                chev.setAttribute('aria-hidden', 'true');
                // The only chevron on the rail: top-level rows dropped theirs,
                // so this header hint (firms up on hover) is the sole
                // collapse affordance glyph.
                chev.style.cssText = 'width: 10px; height: 10px; flex-shrink: 0; opacity: 0.4; transition: transform 0.15s, opacity 0.15s;';
                const chevPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                chevPath.setAttribute('d', 'M6 9l6 6 6-6');
                chev.appendChild(chevPath);
                sectionLbl.appendChild(chev);
                nav.appendChild(sectionLbl);
                currentSection = {
                    name,
                    key: `nav-sec-${name.toLowerCase()}-collapsed`,
                    btn: sectionLbl,
                    chev,
                    els: [],
                    containsActive: false,
                };
                sections.push(currentSection);
            }

            const navItem = document.createElement('div');
            const hasSubItems = item.subItems && item.subItems.length > 0;
            // Collapsible parents (like Docs) stay active on their page
            // Top-level rows honour `aliases` too. Sub-items already did (see the
            // subItem branch below), but top-level never needed it until Threat
            // Monitor absorbed the blocked/secrets ledgers — without this the row
            // goes unlit on those routes and the user cannot tell where they are.
            const matchesSelf = this._itemMatches(item, this.currentPage);
            const isActive = matchesSelf && (!hasSubItems || item.collapsible);
            navItem.className = 'nav-item' + (isActive ? ' active' : '') + (isCloudLocked ? ' nav-item-locked' : '');
            navItem.dataset.page = item.id;
            const reach = this._itemPageIds(item);
            if (reach.length) navItem.dataset.aliases = reach.join(',');
            if (item.collapsible) navItem.dataset.collapsible = 'true';
            // A locked cloud row gets an explicit "needs a cloud account"
            // tooltip; otherwise the item's own. Native tooltip on the expanded
            // rail only; the icon rail shows the flyout instead.
            navItem.dataset.tip = isCloudLocked
                ? 'Requires a SecureVector cloud account: enroll this device to turn this on.'
                : (item.id === 'terminals' && window.API && API.terminalsRemote && API.terminalsRemote())
                    ? 'Works only when the app is opened on this machine (localhost)'
                    : (item.tooltip || '');
            if (navItem.dataset.tip && !this.collapsed) navItem.title = navItem.dataset.tip;

            // Icon (SVG). The Guardian ML sentinel that used to render here
            // moved to the header (Header.createGuardianControl).
            navItem.appendChild(this.createIcon(item.icon));

            // Add label
            const label = document.createElement('span');
            label.textContent = item.label;
            label.style.cssText = 'white-space: nowrap; font-size: 12.5px; flex: 1; min-width: 0;';
            navItem.appendChild(label);

            if (item.count) {
                const cnt = document.createElement('span');
                cnt.className = 'nav-count';
                cnt.dataset.countFor = item.count;
                cnt.hidden = true;
                navItem.appendChild(cnt);
            }
            if (item.liveWaiting) {
                // Approvals waiting on the person, amber, hidden at zero.
                // Filled by loadJitPendingCount() from the same poll. The
                // collapsed rail positions .nav-item > .nav-count itself.
                const wait = document.createElement('span');
                wait.className = 'nav-count nav-count-warn';
                wait.dataset.liveWaiting = '1';
                wait.hidden = true;
                navItem.appendChild(wait);
            }
            if (item.id === 'agent-runs') {
                const live = document.createElement('span');
                live.className = 'nav-live';
                live.title = 'An agent is running right now';
                live.hidden = true;
                navItem.appendChild(live);
            }
            const chordKey = Object.keys(this.CHORDS).find(k => this.CHORDS[k] === item.id);
            if (chordKey) {
                const hint = document.createElement('kbd');
                hint.className = 'nav-chord-hint';
                hint.textContent = `g ${chordKey}`;
                navItem.appendChild(hint);
            }

            // Pending-approval badge lives on the rail buttons instead
            // (`data-jit-product-badge`, see _createProductRail below): the
            // `policies` navItem is always hoisted (its group's sole item),
            // so this row is never reached — see the hoist in render() above.
            // Collapsible parents carry a right-edge chevron: without it a
            // collapsed row is indistinguishable from a leaf, so users never
            // learn there are sub-items. Points right when collapsed, down
            // when expanded — the same glyph + rotation grammar as the
            // section headers. Appended last so expandSection()'s
            // `svg:last-child` lookup finds it.
            let rowChev = null;
            const isCollapsibleRow = item.collapsible && hasSubItems;
            let startsExpanded = false;
            if (isCollapsibleRow) {
                const stored = localStorage.getItem(`nav-${item.id}-expanded`);
                startsExpanded = stored !== null ? stored === 'true' : false;
                rowChev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                rowChev.setAttribute('viewBox', '0 0 24 24');
                rowChev.setAttribute('fill', 'none');
                rowChev.setAttribute('stroke', 'currentColor');
                rowChev.setAttribute('stroke-width', '2.4');
                rowChev.setAttribute('aria-hidden', 'true');
                rowChev.style.cssText = 'width: 10px; height: 10px; flex-shrink: 0; opacity: 0.45; transition: transform 0.15s;';
                rowChev.style.transform = startsExpanded ? 'rotate(0deg)' : 'rotate(-90deg)';
                const rowChevPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                rowChevPath.setAttribute('d', 'M6 9l6 6 6-6');
                rowChev.appendChild(rowChevPath);
                navItem.appendChild(rowChev);
            }

            // Click handler — collapsible rows toggle on any click; others navigate.
            // If the parent is `navigable`, an EXPAND click also navigates to
            // the first sub-item, so e.g. clicking "Agent Replay" lands the
            // user on the Timeline and shows the sub-list. A second click
            // (collapse) just hides the sub-list without changing the page.
            const activateRow = () => {
                if (isCollapsibleRow) {
                    const subNav = nav.querySelector(`[data-sub-for="${item.id}"]`);
                    if (subNav) {
                        const isVisible = subNav.style.display !== 'none';
                        const willExpand = !isVisible;
                        subNav.style.display = willExpand ? 'block' : 'none';
                        if (rowChev) rowChev.style.transform = willExpand ? 'rotate(0deg)' : 'rotate(-90deg)';
                        navItem.setAttribute('aria-expanded', String(willExpand));
                        localStorage.setItem(`nav-${item.id}-expanded`, String(willExpand));
                        if (willExpand && item.navigable && item.subItems[0]) {
                            this.navigate(item.subItems[0].id);
                        }
                    }
                    return;
                }
                // The `terminals` item is always hoisted (its group's sole
                // item — see the hoist in render() above), so this row is
                // never reached; its own click handling lives on the
                // hoisted views and the rail button instead.
                this.navigate(item.id);
            };
            navItem.addEventListener('click', activateRow);
            // A collapsible parent toggles a sub-list rather than navigating.
            // Every other row here genuinely navigates.
            this._makeRowFocusable(navItem, activateRow, {
                role: isCollapsibleRow ? 'button' : 'link',
                expanded: isCollapsibleRow ? startsExpanded : undefined,
            });

            nav.appendChild(navItem);
            const foldsWithSection = currentSection;
            if (foldsWithSection) {
                currentSection.els.push(navItem);
                // A section holding the active page must never start
                // collapsed — a hidden "where am I" is worse than a stale
                // collapse preference.
                const activeHere = this._itemMatches(item, this.currentPage) ||
                    (item.subItems || []).some(s => s.id === this.currentPage ||
                        (s.aliases && s.aliases.includes(this.currentPage)));
                if (activeHere) currentSection.containsActive = true;
            }

            if (item.views && item.views.length) {
                // A folded destination carries a chevron: down while the fold
                // is open, right while it is closed. Without it the Policies
                // row reads as a leaf and the six pages behind it stay
                // undiscovered until the first click. Hidden in the icon rail,
                // where the flyout is the affordance.
                const foldChev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                foldChev.setAttribute('viewBox', '0 0 24 24');
                foldChev.setAttribute('fill', 'none');
                foldChev.setAttribute('stroke', 'currentColor');
                foldChev.setAttribute('stroke-width', '2.4');
                foldChev.setAttribute('aria-hidden', 'true');
                foldChev.setAttribute('class', 'nav-fold-chev');
                const foldChevPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                foldChevPath.setAttribute('d', 'M6 9l6 6 6-6');
                foldChev.appendChild(foldChevPath);
                navItem.classList.add('nav-has-views');
                if (matchesSelf) navItem.classList.add('nav-fold-open');
                navItem.appendChild(foldChev);

                const viewsEl = this._renderViews(item, matchesSelf);
                nav.appendChild(viewsEl);
                if (foldsWithSection) currentSection.els.push(viewsEl);

                // Hover peek: a closed fold opens while the pointer rests on
                // its row or on the peeked views, so every page behind it is
                // one hover away without a trip through Overview. The fold
                // closes 160ms after the pointer leaves both, long enough to
                // cross the gap between row and views. Not in the icon rail
                // (the flyout does that job) and a no-op once the fold is open.
                let peekTimer = null;
                const peekOn = () => {
                    if (this.collapsed || viewsEl.classList.contains('open')) return;
                    clearTimeout(peekTimer);
                    viewsEl.classList.add('peek');
                    navItem.classList.add('nav-fold-open');
                };
                const peekOff = () => {
                    clearTimeout(peekTimer);
                    if (viewsEl.classList.contains('open')) return;
                    peekTimer = setTimeout(() => {
                        viewsEl.classList.remove('peek');
                        navItem.classList.remove('nav-fold-open');
                    }, 160);
                };
                navItem.addEventListener('mouseenter', peekOn);
                navItem.addEventListener('mouseleave', peekOff);
                viewsEl.addEventListener('mouseenter', peekOn);
                viewsEl.addEventListener('mouseleave', peekOff);
            }

            // Sub-items
            if (hasSubItems) {
                const subNav = document.createElement('div');
                subNav.className = 'nav-sub-items';
                // Guide line ties children to their parent — plain indentation
                // read as a second flat list.
                // Guide line sits on the PARENT ICON'S CENTRE (row left 12 +
                // nav-item padding 16 + half of the 20px icon = 38, i.e.
                // margin-left 26 from the nav container). The children's text
                // then lands 4px to the RIGHT of the parent's label instead of
                // 3px to its left, which is where it used to sit: the rows
                // were indented but the text — the thing you actually read —
                // was not, so nesting read backwards. Child text x now works
                // out to 26 + 1 border + 4 pad + 21 item-pad = 52 vs the
                // parent label's 48.
                subNav.style.cssText = 'margin-left: 26px; padding-left: 4px; font-size: 12px; border-left: 1px solid var(--border-default);';

                if (item.collapsible) {
                    subNav.dataset.subFor = item.id;
                    // Same resolution as the chevron above.
                    const stored = localStorage.getItem(`nav-${item.id}-expanded`);
                    const isExpanded = stored !== null ? stored === 'true' : false;
                    subNav.style.display = isExpanded ? 'block' : 'none';
                }

                // Sub-items eligible for a session-only NEW badge — first-view
                // highlight that auto-dismisses after 30s so the sidebar
                // doesn't stay permanently shouty. Mirror of the top-level
                // session-NEW list above; kept separate because sub-items
                // render in a different branch and the keys aren't shared
                // with the top-level item IDs.
                const subNewItems = ['proxy-codex', 'bill-of-tools'];

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
                    // No `opacity` here: dimming already means "cloud-locked"
                    // on this rail (nav-item-locked, 0.5), so reusing it at
                    // 0.85 to mean "child" put two different states on one
                    // device. Children recede via colour instead — see
                    // `.nav-item.nav-sub-item` in styles.css.
                    subNavItem.style.cssText = 'padding: 6px 12px 6px 21px; display: flex; align-items: center; gap: 6px;';

                    const subLabel = document.createElement('span');
                    subLabel.textContent = subItem.label;
                    subLabel.style.cssText = 'flex: 1; min-width: 0;';
                    subNavItem.appendChild(subLabel);

                    // Pending JIT requests — an agent is waiting on a human
                    // decision, the one genuinely time-sensitive signal on
                    // Tool Permissions. Without this badge a request is only
                    // visible on the page itself, so an agent could sit
                    // blocked for hours. Filled by loadJitPendingCount().
                    if (subItem.id === 'tool-permissions') {
                        const jitBadge = document.createElement('span');
                        jitBadge.id = 'jit-pending-badge';
                        jitBadge.style.cssText = 'display: none; flex-shrink: 0; font-size: 9.5px; font-weight: 800; padding: 1px 7px; border-radius: 999px; background: rgba(245,158,11,0.18); color: #f59e0b; line-height: 1.5;';
                        subNavItem.appendChild(jitBadge);
                    }

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
                if (currentSection) currentSection.els.push(subNav);
            }
        });

        // Wire the Visibility / Configure / Connect section toggles. Collapse hides
        // rows via a class (not inline display) so each row's own inline
        // display state — sub-nav expand/collapse, banner visibility — is
        // preserved intact when the section reopens.
        sections.forEach(sec => {
            const apply = (collapsed) => {
                sec.collapsed = collapsed;
                sec.els.forEach(el => el.classList.toggle('nav-sec-hidden', collapsed));
                sec.chev.style.transform = collapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
                sec.btn.setAttribute('aria-expanded', String(!collapsed));
                sec.btn.title = (collapsed ? 'Expand ' : 'Collapse ') + sec.name;
                if (this._indicator) requestAnimationFrame(() => this._moveIndicator(false));
            };
            sec.apply = apply;
            apply(localStorage.getItem(sec.key) === '1' && !sec.containsActive);
            sec.btn.addEventListener('click', () => {
                const next = !sec.collapsed;
                try { localStorage.setItem(sec.key, next ? '1' : '0'); } catch (_) { /* private mode */ }
                apply(next);
            });
        });
        // navigate() uses this to re-open a collapsed section when the user
        // lands on a page inside it — the active row must never be hidden.
        this._sections = sections;

        // Fetch rules count
        this.loadRulesCount();

        // JIT pending-request badge: load now, then poll. Guarded so repeated
        // render() calls (every navigation) never stack intervals — the timer
        // survives re-renders because the badge element is recreated with the
        // same id each time.
        this.loadJitPendingCount();
        if (!this._jitBadgeTimer) {
            this._jitBadgeTimer = setInterval(() => (window.API && API.asPoll ? API.asPoll(() => this.loadJitPendingCount()) : this.loadJitPendingCount()), 30000);
        }

        // Live counts on the rail: threats in the last 24 hours, egress calls
        // blocked in the last 24 hours. The rail answers "where should I look"
        // before a click; zero hides the pill so quiet is quiet.
        this.loadLiveCounts();
        this.loadDrCount();
        if (!this._countsTimer) {
            this._countsTimer = setInterval(() => (window.API && API.asPoll ? API.asPoll(() => Promise.all([this.loadLiveCounts(), this.loadDrCount()])) : Promise.all([this.loadLiveCounts(), this.loadDrCount()])), 60000);
        }

        // A hoisted single-item group (see the hoist above) with no views at
        // all (Governance) or none yet (Agent Sessions before any task exists —
        // its views arrive asynchronously via _loadAgentTaskViews) would
        // otherwise render only a heading, a subtitle and an empty list.
        // When the group's context list would render zero destination rows,
        // skip the context panel entirely: the rail stays visible and its
        // button still navigates to the group's landing. Every non-hoisted
        // group always adds at least one row per item, so `nav` is empty
        // only in that hoisted, no-rows case.
        const contextEmpty = nav.children.length === 0;
        container.classList.toggle('sidebar-context-empty', contextEmpty);

        contextPanel.appendChild(nav);
        this._flyoutInit(container);
        this._indicatorInit(nav);
        this._loadAgentTaskViews();
        if (!this._agentTaskTimer) {
            this._agentTaskTimer = setInterval(() => {
                if (document.hidden) return;
                (window.API && API.asPoll ? API.asPoll(() => this._loadAgentTaskViews(true)) : this._loadAgentTaskViews(true));
            }, 30000);
        }
        this._fadeInit(nav);
        this._chordInit();
        // First paint: rows settle in one after another; later renders are instant.
        if (!Sidebar._revealed) {
            Sidebar._revealed = true;
            nav.classList.add('nav-reveal');
            nav.querySelectorAll('.nav-item, .nav-section-label').forEach((el, i) => el.style.setProperty('--i', String(i)));
        }

        // Collapse toggle button — a chevron puck straddling the sidebar's
        // right edge, the position every shell that has one puts it in.
        const collapseBtn = document.createElement('button');
        collapseBtn.type = 'button';
        collapseBtn.className = 'sidebar-collapse-btn';

        const collapseIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        collapseIcon.setAttribute('viewBox', '0 0 24 24');
        collapseIcon.setAttribute('fill', 'none');
        collapseIcon.setAttribute('stroke', 'currentColor');
        collapseIcon.setAttribute('stroke-width', '2');
        collapseIcon.setAttribute('aria-hidden', 'true');
        const collapsePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        collapseIcon.appendChild(collapsePath);
        collapseBtn.appendChild(collapseIcon);

        // No text label: on the divider the chevron is the convention and
        // reads on its own, and a word here would sit half outside the rail.
        // The tooltip and the accessible name carry the wording instead.
        this._syncCollapseBtn(collapseBtn);

        collapseBtn.addEventListener('click', () => this.toggleCollapse());
        // Mounted on the sidebar itself, not the rail: the sidebar is the two
        // columns together, so its box is the outer edge whether the context
        // panel is showing, collapsed away, or empty for this group. Mounting
        // it on the rail pinned it to the rail's edge, which is an interior
        // seam whenever the context panel is up.
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
        statusToggle.style.cssText = 'display: none; align-items: center; gap: 10px; margin: 0 10px 0; padding: 5px 12px; min-height: 24px; line-height: 1.4; background: transparent; border: none; border-radius: var(--radius-md); cursor: pointer; font: inherit; font-size: 12.5px; color: var(--text-secondary); width: calc(100% - 20px); text-align: left; overflow: visible;';
        const statusChevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        statusChevron.setAttribute('viewBox', '0 0 24 24');
        statusChevron.setAttribute('fill', 'none');
        statusChevron.setAttribute('stroke', 'currentColor');
        statusChevron.setAttribute('stroke-width', '2');
        statusChevron.setAttribute('aria-hidden', 'true');
        statusChevron.style.cssText = 'width: 20px; height: 20px; flex-shrink: 0; opacity: .7; transition: transform 0.15s;';
        const statusChevPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        statusChevPath.setAttribute('d', 'M9 6l6 6-6 6');
        statusChevron.appendChild(statusChevPath);
        statusToggle.appendChild(statusChevron);
        const statusLabel = document.createElement('span');
        statusLabel.textContent = 'Plugins';
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
            statusChevron.style.transform = collapsed ? 'none' : 'rotate(90deg)';
            statusToggle.setAttribute('aria-expanded', String(!collapsed));
            statusToggle.title = collapsed ? 'Show plugin status' : 'Hide plugin status';
        };
        statusToggle.addEventListener('click', () => {
            const nowCollapsed = statusStack.style.display !== 'none';
            try { localStorage.setItem(STATUS_COLLAPSE_KEY, nowCollapsed ? '1' : '0'); } catch (_) { /* private mode */ }
            applyStatusCollapsed(nowCollapsed);
        });
        const savedCollapse = localStorage.getItem(STATUS_COLLAPSE_KEY);
        applyStatusCollapsed(savedCollapse === null ? window.innerHeight < 900 : savedCollapse === '1');
        // Header visibility + count track the banners' own show/hide (each
        // poller flips its banner's inline display) — observe instead of
        // threading a callback through all five pollers.
        const updateStatusToggle = () => {
            const rows = Array.from(statusStack.children).filter(el => el.style.display !== 'none');
            statusToggle.style.display = rows.length ? 'flex' : 'none';
            statusCount.textContent = String(rows.length);
            statusCount.title = rows.length === 1 ? '1 plugin reporting' : `${rows.length} plugins reporting`;
            // Colour is state, not runtime: the dot goes accent once the
            // plugin is active, amber while it still needs a step (staged,
            // or installed but not enabled). Runtime brand hues were the
            // one place the rail broke the single-accent rule.
            // Write the dot only when its state changes. This callback runs
            // from an observer that watches inline styles under the stack,
            // and WebKit queues a mutation even for a same-value write, so
            // an unconditional write here re-enters forever and the desktop
            // app never leaves the splash.
            rows.forEach(row => {
                const dot = row.querySelector('span[aria-hidden]');
                if (!dot || !/plugin/.test(row.textContent)) return;
                const state = /\bActive$/.test(row.textContent.trim()) ? 'active' : 'pending';
                if (dot.dataset.state === state) return;
                dot.dataset.state = state;
                dot.style.background = state === 'active' ? 'var(--accent-primary)' : '#f59e0b';
            });
        };
        new MutationObserver(updateStatusToggle).observe(statusStack, { attributes: true, attributeFilter: ['style'], childList: true, characterData: true, subtree: true });
        updateStatusToggle();

        // Guardian ML lives in the header (Header.createGuardianControl) —
        // it's a global on/off, not a sidebar destination. Keeping it out of
        // the bottom zone lets the proxy/plugin/SIEM status banners (which
        // hide when inactive) read as a clean, single-purpose status stack.

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
        // nothing is in flight. Neutral dot (v5: runtimes are labels) — see
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
        // v5: neutral border, runtime colour on the DOT (a label, like the
        // Traces card dots) — coloured borders made the footer read as four
        // competing alerts.
        ccPluginBanner.style.cssText = 'display: none; margin: 8px 12px 0; padding: 4px 10px; border-radius: 6px; cursor: pointer; background: transparent; border: 1px solid var(--border-default); align-items: center; gap: 6px; transition: background 0.15s; font: inherit; text-align: left; color: inherit; width: calc(100% - 24px);';
        ccPluginBanner.addEventListener('mouseenter', () => { ccPluginBanner.style.background = 'var(--bg-hover)'; });
        ccPluginBanner.addEventListener('mouseleave', () => { ccPluginBanner.style.background = 'transparent'; });
        const ccDot = document.createElement('span');
        ccDot.style.cssText = 'width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); flex-shrink: 0;';
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
        // Neutral dot (v5: runtimes are labels, not statuses) — see the Codex
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
        codexPluginBanner.style.cssText = 'display: none; margin: 8px 12px 0; padding: 4px 10px; border-radius: 6px; cursor: pointer; background: transparent; border: 1px solid var(--border-default); align-items: center; gap: 6px; transition: background 0.15s; font: inherit; text-align: left; color: inherit; width: calc(100% - 24px);';
        codexPluginBanner.addEventListener('mouseenter', () => { codexPluginBanner.style.background = 'var(--bg-hover)'; });
        codexPluginBanner.addEventListener('mouseleave', () => { codexPluginBanner.style.background = 'transparent'; });
        const codexDot = document.createElement('span');
        codexDot.style.cssText = 'width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); flex-shrink: 0;';
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
        // Neutral dot (v5) — the bottom-section plugin rows all share:
        // CC purple · Codex coral · Copilot blue · proxy cyan · SIEM green.
        // GitHub's Copilot brand purple would collide with the CC banner,
        // so blue (GitHub's own link/accent family) keeps the row
        // distinguishable at a glance when several stack together.
        const copilotPluginBanner = document.createElement('button');
        copilotPluginBanner.type = 'button';
        copilotPluginBanner.id = 'copilot-plugin-active-banner';
        copilotPluginBanner.className = 'proxy-banner-pulse';
        copilotPluginBanner.setAttribute('aria-label', 'Open Copilot CLI plugin settings');
        copilotPluginBanner.style.cssText = 'display: none; margin: 8px 12px 0; padding: 4px 10px; border-radius: 6px; cursor: pointer; background: transparent; border: 1px solid var(--border-default); align-items: center; gap: 6px; transition: background 0.15s; font: inherit; text-align: left; color: inherit; width: calc(100% - 24px);';
        copilotPluginBanner.addEventListener('mouseenter', () => { copilotPluginBanner.style.background = 'var(--bg-hover)'; });
        copilotPluginBanner.addEventListener('mouseleave', () => { copilotPluginBanner.style.background = 'transparent'; });
        const copilotDot = document.createElement('span');
        copilotDot.style.cssText = 'width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); flex-shrink: 0;';
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

        // OpenCode plugin indicator — same compact pattern as the CC, Codex
        // and Copilot banners; polls /api/hooks/opencode/status.
        //
        // Neutral dot (v5) — bottom-section plugin rows each take a distinct
        // hue so a stack stays readable: CC purple · Codex coral · Copilot
        // blue · OpenCode amber · proxy cyan · SIEM green.
        const opencodePluginBanner = document.createElement('button');
        opencodePluginBanner.type = 'button';
        opencodePluginBanner.id = 'opencode-plugin-active-banner';
        opencodePluginBanner.className = 'proxy-banner-pulse';
        opencodePluginBanner.setAttribute('aria-label', 'Open OpenCode plugin settings');
        opencodePluginBanner.style.cssText = 'display: none; margin: 8px 12px 0; padding: 4px 10px; border-radius: 6px; cursor: pointer; background: transparent; border: 1px solid var(--border-default); align-items: center; gap: 6px; transition: background 0.15s; font: inherit; text-align: left; color: inherit; width: calc(100% - 24px);';
        opencodePluginBanner.addEventListener('mouseenter', () => { opencodePluginBanner.style.background = 'var(--bg-hover)'; });
        opencodePluginBanner.addEventListener('mouseleave', () => { opencodePluginBanner.style.background = 'transparent'; });
        const opencodeDot = document.createElement('span');
        opencodeDot.style.cssText = 'width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); flex-shrink: 0;';
        opencodeDot.setAttribute('aria-hidden', 'true');
        opencodePluginBanner.appendChild(opencodeDot);
        const opencodeText = document.createElement('span');
        opencodeText.id = 'opencode-plugin-banner-text';
        opencodeText.setAttribute('aria-live', 'polite');
        opencodeText.setAttribute('aria-atomic', 'true');
        opencodeText.style.cssText = 'font-size: 11px; font-weight: 500; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        opencodePluginBanner.appendChild(opencodeText);
        opencodePluginBanner.addEventListener('click', () => this.navigate('proxy-opencode'));
        statusStack.appendChild(opencodePluginBanner);

        // Antigravity plugin indicator. Same three states and cadence as the
        // four banners above; polls /api/hooks/antigravity/status. Neutral dot
        // like its siblings: on this page colour carries security state, and
        // which harness a row names is not one.
        const antigravityPluginBanner = document.createElement('button');
        antigravityPluginBanner.type = 'button';
        antigravityPluginBanner.id = 'antigravity-plugin-active-banner';
        antigravityPluginBanner.className = 'proxy-banner-pulse';
        antigravityPluginBanner.setAttribute('aria-label', 'Open Antigravity plugin settings');
        antigravityPluginBanner.style.cssText = 'display: none; margin: 8px 12px 0; padding: 4px 10px; border-radius: 6px; cursor: pointer; background: transparent; border: 1px solid var(--border-default); align-items: center; gap: 6px; transition: background 0.15s; font: inherit; text-align: left; color: inherit; width: calc(100% - 24px);';
        antigravityPluginBanner.addEventListener('mouseenter', () => { antigravityPluginBanner.style.background = 'var(--bg-hover)'; });
        antigravityPluginBanner.addEventListener('mouseleave', () => { antigravityPluginBanner.style.background = 'transparent'; });
        const antigravityDot = document.createElement('span');
        antigravityDot.style.cssText = 'width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); flex-shrink: 0;';
        antigravityDot.setAttribute('aria-hidden', 'true');
        antigravityPluginBanner.appendChild(antigravityDot);
        const antigravityText = document.createElement('span');
        antigravityText.id = 'antigravity-plugin-banner-text';
        antigravityText.setAttribute('aria-live', 'polite');
        antigravityText.setAttribute('aria-atomic', 'true');
        antigravityText.style.cssText = 'font-size: 11px; font-weight: 500; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        antigravityPluginBanner.appendChild(antigravityText);
        antigravityPluginBanner.addEventListener('click', () => this.navigate('proxy-antigravity'));
        statusStack.appendChild(antigravityPluginBanner);

        // SIEM Forwarder active indicator — mirrors the proxy banner
        // styling so both stack cleanly when on together. Visible only
        // when the master toggle is enabled AND at least one destination
        // is configured (no point showing "active" if nothing receives).
        const siemBanner = document.createElement('div');
        siemBanner.id = 'siem-active-banner';
        siemBanner.className = 'proxy-banner-pulse';
        // Green accent (10b981) — different from the cyan proxy banner
        // so operators can tell them apart at a glance when stacked.
        siemBanner.style.cssText = 'display: none; margin: 6px 12px 0; padding: 4px 10px; border-radius: 6px; cursor: pointer; background: transparent; border: 1px solid var(--border-default); align-items: center; gap: 6px; transition: background 0.15s;';
        siemBanner.addEventListener('mouseenter', () => { siemBanner.style.background = 'var(--bg-hover)'; });
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
                    this.checkOpenCodePluginStatus();
                    this.checkAntigravityPluginStatus();
                }
            });
        }

        // Theme toggle — pinned to the foot of the rail (v5). It used to sit in
        // the header, where a once-a-session display preference competed for
        // width with Guardian ML, Connect Agents and Cloud Connect, and where
        // it was part of what pushed Cloud Connect off-screen on a narrowed
        // window. `.sidebar-bottom` is already `margin-top: auto` under a
        // `flex: 1; overflow-y: auto` nav, so this stays put while the nav
        // list scrolls — genuinely fixed to the bottom, not merely last.
        bottomSection.appendChild(this._createSettingsRow());
        bottomSection.appendChild(this.createThemeFooter());

        contextPanel.appendChild(bottomSection);

        // Collapsed hides the context panel, which used to take the search row,
        // the plugin banners and the theme control down with it. Move them into
        // the product rail instead — the same single nodes, relocated.
        this._syncCollapsedControls(container);

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
        this.checkOpenCodePluginStatus();
        this.checkAntigravityPluginStatus();

        // Put the user back where the rebuild found them (see the capture at
        // the top of render): same rail button focused, same scroll offset —
        // but only the scroll offset of the SAME group; a group switch always
        // starts its list at the top.
        if (priorNavScroll && priorNavGroup === activeGroup.id) nav.scrollTop = priorNavScroll;
        if (focusedRailGroup) {
            const refocus = productRail.querySelector(`.product-rail-button[data-product-group="${focusedRailGroup}"]`);
            if (refocus) {
                // Chromium focuses a button on click, so this restore can
                // itself trigger the collapsed rail's focus-opens-flyout
                // handler (wired above by _flyoutInit) and reopen the flyout
                // we just hid at the top of this render. Mark this one
                // programmatic focus so that handler skips it.
                this._suppressFlyoutFocus = true;
                refocus.focus();
                this._suppressFlyoutFocus = false;
            }
        }
        const flyGroup = this._flyoutAfterRender;
        this._flyoutAfterRender = null;
        // Only the group this render is for: a flag left by a click that
        // did not re-render (same group) must never open on the next one.
        if (flyGroup && flyGroup === activeGroup.id && container.classList.contains('collapsed')) {
            const btn = productRail.querySelector(`.product-rail-button[data-product-group="${flyGroup}"]`);
            if (btn) this._flyoutShow(btn);
        }
    },

    // Context destination rows are divs, so they carry counts, badges and drag
    // behaviour but get no keyboard path of their own. Make them real tab stops
    // that activate on Enter and Space; the focus ring already defined for
    // `.sidebar-context .nav-item:focus-visible` then has something to paint.
    // `role` defaults to 'link' for rows that genuinely navigate to a page.
    // A row that instead toggles a sub-list or opens something other than a
    // URL (a collapsible parent, the task board) must pass role: 'button',
    // and a collapsible parent also passes its open/closed state as
    // `expanded` so the two stay in sync instead of each caller hardcoding
    // the ARIA attribute itself.
    _makeRowFocusable(row, activate, { role = 'link', expanded } = {}) {
        row.tabIndex = 0;
        row.setAttribute('role', role);
        if (expanded !== undefined) row.setAttribute('aria-expanded', String(expanded));
        row.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
            // Space scrolls the page by default, which a destination row must not.
            if (e.key !== 'Enter') e.preventDefault();
            activate(e);
        });
    },

    // One instance of each control, relocated between the two columns — never
    // cloned, so no state is duplicated and no copy is ever visible twice.
    _syncCollapsedControls(container) {
        const rail = container.querySelector('.sidebar-product-rail');
        const context = container.querySelector('.sidebar-context');
        if (!rail || !context) return;
        const search = container.querySelector('.nav-search');
        const bottom = container.querySelector('.sidebar-bottom');
        // The context panel is also absent — not just visually collapsed —
        // when the active group's destination list would render zero rows
        // (see the `sidebar-context-empty` toggle in render()). These
        // controls need the same rail relocation as a real collapse then,
        // without touching the user's own expand/collapse preference.
        const toRail = this.collapsed || container.classList.contains('sidebar-context-empty');
        if (search) {
            if (toRail) rail.insertBefore(search, rail.querySelector('.product-rail-groups'));
            else context.insertBefore(search, context.querySelector('.sidebar-context-heading'));
        }
        if (bottom) (toRail ? rail : context).appendChild(bottom);
    },

    // ---- v5.3 rail: views, search row, live counts, icon-rail flyout ----

    _itemPageIds(item) {
        const ids = [...(item.aliases || [])];
        (item.views || []).forEach(v => { ids.push(v.id); (v.aliases || []).forEach(a => ids.push(a)); });
        return ids.filter(id => id !== item.id);
    },

    _itemMatches(item, page) {
        return item.id === page || this._itemPageIds(item).includes(page);
    },

    _activeProductGroup(page) {
        return this.productGroups.find(group => (group.extraPages || []).includes(page) || group.items.some(itemId => {
            const item = this.navItems.find(candidate => candidate.id === itemId);
            return item && this._itemMatches(item, page);
        })) || this.productGroups[0];
    },

    /** Sessions to review on the Detection & Response rail button, from the
     *  shared quiet summary read (cached 15 s by the API). Zero hides it. */
    loadDrCount() {
        if (!window.API || typeof document === 'undefined') return;
        try {
            Promise.resolve((API.detectionResponseSummaryQuiet || API.detectionResponseSummary).call(API))
                .then(d => this.applyDrSummary(d, { fromPoll: true })).catch(() => {});
        } catch (e) { /* no count */ }
    },

    /** "3 sessions to review · this device · last 7 days": the badge's
     *  meaning, the same scope the page's tile and queue heading state. */
    drBadgeTitle(n, d) {
        const days = Math.max(1, Number(d && d.window_days) || 7);
        return `${n} ${n === 1 ? 'session' : 'sessions'} to review · this device · last ${days} days`;
    },

    /** Paint the rail badge and panel counts from one summary. The
     *  Detection & Response page calls this with the summary it just read
     *  (and after each decision), so the badge always equals its queue; it
     *  also primes the shared 15 s cache so the next poll agrees. */
    applyDrSummary(d, opts) {
        if (typeof document === 'undefined') return;
        if (!(opts && opts.fromPoll) && d && window.API) API._drQuiet = { at: Date.now(), p: Promise.resolve(d) };
        this._drSummary = d || null;
        const n = Math.max(0, Number(d && d.detect && d.detect.to_review) || 0);
        const meaning = this.drBadgeTitle(n, d);
        document.querySelectorAll('[data-dr-product-badge]').forEach(badge => {
            badge.textContent = String(n);
            badge.title = meaning;
            badge.setAttribute('aria-label', meaning);
            badge.hidden = n <= 0;
            const button = badge.closest ? badge.closest('.product-rail-button') : null;
            if (button) button.setAttribute('aria-label', n > 0 ? `${button.dataset.baseLabel}: ${meaning}` : button.dataset.baseLabel);
        });
        this._paintDrSections(this._drSummary);
    },

    /** The Detection & Response panel keeps the two main page anchors. */
    DR_SECTIONS: [
        { id: 'dr-sec-sessions', label: 'Sessions to review', count: 'review' },
        { id: 'dr-sec-details', label: 'Details' },
    ],

    /** Counts beside the panel rows, from the cached summary the badge reads. */
    _drCounts(d) {
        const n = (v) => Math.max(0, Number(v) || 0);
        return { review: n(d && d.detect && d.detect.to_review) };
    },

    _createDrSections() {
        const wrap = document.createElement('div');
        wrap.className = 'nav-views open nav-views-flat nav-dr-sections';
        this.DR_SECTIONS.forEach(sec => {
            const row = document.createElement('div');
            row.className = 'nav-item nav-view nav-dr-section' + (sec.inDetails ? ' nav-dr-sub' : '');
            row.dataset.drSection = sec.id;
            row.title = sec.label;
            if (sec.onlyIncomplete || sec.onlyIfShown) row.hidden = true;
            const lbl = document.createElement('span');
            lbl.textContent = sec.label;
            row.appendChild(lbl);
            if (sec.count) {
                const ct = document.createElement('span');
                ct.className = 'nav-count nav-count-warn';
                ct.dataset.drCount = sec.count;
                ct.hidden = true;
                row.appendChild(ct);
            }
            const go = (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.goToDrSection(sec.id); };
            row.addEventListener('click', go);
            this._makeRowFocusable(row, go);
            wrap.appendChild(row);
        });
        this._paintDrSections(this._drSummary, wrap);
        this._drWatch();
        return wrap;
    },

    _drRows(root) {
        const from = root && root.querySelectorAll ? root : document;
        return [...from.querySelectorAll('[data-dr-section]')];
    },

    _paintDrSections(d, root) {
        if (typeof document === 'undefined') return;
        const counts = this._drCounts(d);
        this._drRows(root).forEach(row => {
            const ct = row.querySelector ? row.querySelector('[data-dr-count]') : null;
            if (ct) {
                const n = counts[ct.dataset.drCount] || 0;
                ct.textContent = String(n);
                ct.hidden = n <= 0;
            }
        });
        this._drHideEmpty(root);
        this._drSyncActive(root);
    },

    /** Rows marked onlyIfShown hide while their section is not on the page
     *  or is empty (the devices card is rendered only when it is due). */
    _drHideEmpty(root) {
        if (typeof document === 'undefined' || !document.getElementById) return;
        this._drRows(root).forEach(row => {
            const sec = this.DR_SECTIONS.find(s => s.id === row.dataset.drSection);
            if (!sec || !sec.onlyIfShown) return;
            const el = document.getElementById(sec.id);
            row.hidden = !(el && el.children && el.children.length);
        });
    },

    /** Lights the chosen section row, or the first visible one. */
    _drSyncActive(root) {
        if (typeof document === 'undefined') return;
        const rows = this._drRows(root).filter(r => !r.hidden);
        const act = rows.find(r => r.dataset.drSection === this._drActive) || rows[0];
        rows.concat(this._drRows(root).filter(r => r.hidden)).forEach(r => {
            const on = r === act;
            r.classList.toggle('active', on);
            if (on) r.setAttribute('aria-current', 'location'); else if (r.removeAttribute) r.removeAttribute('aria-current');
        });
        // The edge bar follows the lit section.
        if (this._indicator && typeof requestAnimationFrame === 'function') requestAnimationFrame(() => this._moveIndicator(false));
    },

    /** Which section is in view: the one whose top most recently passed the
     *  line (ties keep panel order); at the bottom of the page, the lowest
     *  section that is on screen; before any, the first. */
    _drPickActive(entries, line, atBottom, viewBottom) {
        if (!entries.length) return null;
        let best = null;
        entries.forEach(e => {
            const limit = atBottom ? viewBottom : line;
            if (e.top <= limit && (!best || e.top > best.top)) best = e;
        });
        return (best || entries[0]).id;
    },

    goToDrSection(id) {
        this._drActive = id;
        this._drLockUntil = Date.now() + 900;
        if (this.currentPage === 'detection-response' && this._drScrollTo(id)) { this._drSyncActive(); return; }
        this._drPendingSection = id;
        this.navigate('detection-response');
    },

    _drScrollTo(id) {
        const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
        if (!el) return false;
        // Open every disclosure on the way: the target itself and the
        // closed Details it sits in.
        for (let n = el; n; n = n.parentElement) { if (n.tagName === 'DETAILS') n.open = true; }
        if (el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return true;
    },

    /** The page calls this once its sections are filled in. */
    drPageReady() {
        const id = this._drPendingSection;
        this._drPendingSection = null;
        this._drHideEmpty();
        if (id) { this._drActive = id; this._drLockUntil = Date.now() + 900; this._drScrollTo(id); this._drSyncActive(); return; }
        this._drPositionPass();
    },

    /** The element that scrolls the page: the nearest scrolling ancestor of
     *  the sessions section, else the document. */
    _drScroller() {
        if (typeof document === 'undefined') return null;
        let el = document.getElementById('dr-sec-sessions');
        while (el && el.parentElement) {
            el = el.parentElement;
            const oy = typeof getComputedStyle === 'function' ? getComputedStyle(el).overflowY : '';
            if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
        }
        return document.scrollingElement || null;
    },

    /** The closed disclosure an element sits inside (not the element itself),
     *  or null. A section inside a closed Details has no position of its own. */
    _drClosedAround(el) {
        for (let n = el && el.parentElement; n; n = n.parentElement) {
            if (n.tagName === 'DETAILS' && !n.open) return n;
        }
        return null;
    },

    /** Lights the section in view, from where the sections sit right now.
     *  While Details is closed its sections drop out and the Details row
     *  stands for all of them. */
    _drPositionPass(scroller) {
        const box = scroller || this._drScroller();
        if (!box || !box.getBoundingClientRect) { this._drSyncActive(); return; }
        const top = box === document.scrollingElement ? 0 : box.getBoundingClientRect().top;
        const atBottom = box.scrollTop > 0 && box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
        const entries = this._drRows().filter(r => !r.hidden).map(r => {
            const el = document.getElementById(r.dataset.drSection);
            if (!el || this._drClosedAround(el)) return null;
            return el.offsetParent !== null ? { id: r.dataset.drSection, top: el.getBoundingClientRect().top } : null;
        }).filter(Boolean);
        const id = this._drPickActive(entries, top + 96, atBottom, top + box.clientHeight - 48);
        if (id) this._drActive = id;
        this._drSyncActive();
    },

    /** Only the page's own scroll counts: never the nav or an inner list. */
    _drIsPageScroll(target) {
        if (!target || typeof document === 'undefined') return false;
        if (target === document || target === document.scrollingElement) return true;
        const sec = document.getElementById('dr-sec-sessions');
        return !!(sec && target.contains && target !== sec && target.contains(sec));
    },

    _drWatch() {
        if (this._drWatching || typeof document === 'undefined' || !document.addEventListener) return;
        this._drWatching = true;
        let queued = false;
        document.addEventListener('scroll', (ev) => {
            if (this.currentPage !== 'detection-response' || !this._drIsPageScroll(ev.target)) return;
            // A click's own smooth scroll keeps the clicked row lit.
            if (Date.now() < (this._drLockUntil || 0)) { this._drLockUntil = Date.now() + 150; return; }
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => {
                queued = false;
                this._drPositionPass(ev.target === document ? document.scrollingElement : ev.target);
            });
        }, true);
    },

    /** Settings, pinned above Theme at the foot of the panel on every page. */
    _createSettingsRow() {
        const row = document.createElement('div');
        const on = this.currentPage === 'settings' || this.currentPage === 'guardian-ml';
        row.className = 'nav-item nav-settings-pinned' + (on ? ' active' : '');
        row.dataset.page = 'settings';
        row.title = 'Settings';
        row.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM19.4 13.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V19a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H5a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h0a1.6 1.6 0 0 0 1-1.5V5a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v0a1.6 1.6 0 0 0 1.5 1H19a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg><span class="nav-label">Settings</span>';
        if (on) row.setAttribute('aria-current', 'page');
        const go = (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.navigate('settings'); };
        row.addEventListener('click', go);
        this._makeRowFocusable(row, go);
        return row;
    },

    _createProductRail(activeGroup) {
        const rail = document.createElement('div');
        rail.className = 'sidebar-product-rail';
        rail.setAttribute('role', 'navigation');
        rail.setAttribute('aria-label', 'SecureVector product areas');

        const home = document.createElement('button');
        home.type = 'button';
        home.className = 'product-rail-home';
        home.title = 'SecureVector Agent Sessions';
        home.setAttribute('aria-label', 'SecureVector Agent Sessions');
        const shield = document.createElement('img');
        shield.src = '/images/favicon.png';
        shield.alt = '';
        shield.setAttribute('aria-hidden', 'true');
        shield.className = 'sidebar-logo-img';
        home.appendChild(shield);
        home.addEventListener('click', () => this._showAgentTasksBoard());
        rail.appendChild(home);

        const groupList = document.createElement('div');
        groupList.className = 'product-rail-groups';
        this.productGroups.forEach(group => {
            if (group.rail === false) return;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'product-rail-button' + (group.id === activeGroup.id ? ' active' : '');
            button.dataset.productGroup = group.id;
            button.dataset.baseLabel = group.title || group.label;
            button.title = group.title || group.label;
            button.setAttribute('aria-label', group.title || group.label);
            if (group.id === activeGroup.id) button.setAttribute('aria-current', 'page');
            button.appendChild(this.createIcon(group.icon));

            const label = document.createElement('span');
            label.className = 'product-rail-label';
            label.textContent = group.label;
            button.appendChild(label);

            if (group.id === 'tasks' || group.id === 'governance') {
                const badge = document.createElement('span');
                badge.className = 'product-rail-attention';
                badge.dataset.jitProductBadge = group.id;
                badge.hidden = true;
                button.appendChild(badge);
            }
            if (group.id === 'detect') {
                const badge = document.createElement('span');
                badge.className = 'product-rail-attention';
                badge.dataset.drProductBadge = '1';
                badge.hidden = true;
                button.appendChild(badge);
            }

            button.addEventListener('click', () => {
                // On the collapsed rail a click opens the group's landing and
                // keeps its menu visible, so the other destinations stay one
                // click away (owner, 6.1).
                const multi = !!(group.items && group.items.length > 1);
                const sameGroup = group.id === this._renderedProductGroup;
                this._flyoutAfterRender = multi && !sameGroup ? group.id : null;
                if (group.id === 'tasks') this._showAgentTasksBoard();
                else this.navigate(group.landing);
                // Same group: no re-render follows, so open the menu here.
                if (multi && sameGroup) {
                    const live = document.querySelector(`.product-rail-button[data-product-group="${group.id}"]`);
                    if (live && document.getElementById('sidebar')?.classList.contains('collapsed')) this._flyoutShow(live);
                }
            });
            groupList.appendChild(button);
        });
        rail.appendChild(groupList);
        return rail;
    },

    _showAgentTasksBoard() {
        try {
            sessionStorage.removeItem('sv-agent-task-id');
            sessionStorage.setItem('sv-agent-tasks-board', '1');
        } catch (err) { /* storage unavailable */ }
        if (this.currentPage === 'terminals' && window.TerminalsPage?.showAllTasks) {
            try { sessionStorage.removeItem('sv-agent-tasks-board'); } catch (err) { /* storage unavailable */ }
            TerminalsPage.showAllTasks();
            return;
        }
        this.navigate('terminals');
    },

    _viewActive(view) {
        if (view.taskId) {
            return this.currentPage === 'terminals' && sessionStorage.getItem('sv-agent-task-id') === view.taskId;
        }
        return view.id === this.currentPage || !!(view.aliases && view.aliases.includes(this.currentPage));
    },

    _renderViews(item, open) {
        const wrap = document.createElement('div');
        wrap.className = 'nav-views' + (open ? ' open' : '') + (item.id === 'terminals' ? ' nav-views-tasks' : '');
        wrap.dataset.viewsFor = item.id;
        // One folder needs no headers; several do, or the rail reads as one
        // undifferentiated pile of tasks.
        // Folder sections: name and count, collapsible, with "Other" last.
        // The helpers live on the Agent Sessions page so the board and this
        // rail share one definition; without it the rows stay ungrouped.
        const TP = window.TerminalsPage;
        const grouping = !!(TP && TP._collapsedFolders && item.id === 'terminals' && item.views.some(v => v.taskId));
        let views = item.views;
        // Delegated children sit under their parent, in the parent's folder.
        const DU = window.DelegationUI;
        let nested = null;
        let folded = new Set();
        let activeTaskId = null;
        if (DU && item.id === 'terminals') {
            nested = DU.nest(item.views.filter(v => v.taskId), { id: 'taskId', parent: 'parentId', created: 'created' });
            folded = DU.collapsed();
            const act = item.views.find(v => v.taskId && this._viewActive(v));
            activeTaskId = act ? act.taskId : null;
        }
        const folderOf = (v) => {
            const p = nested && nested.parentOf.get(v.taskId);
            return (p || v).folder || 'Other';
        };
        const counts = new Map();
        const openFolders = new Set();
        let collapsed = new Set();
        if (grouping) {
            const plain = views.filter(v => !v.taskId);
            const tasks = views.filter(v => v.taskId);
            const order = [];
            tasks.forEach(v => { const f = folderOf(v); if (!counts.has(f)) { counts.set(f, 0); order.push(f); } counts.set(f, counts.get(f) + 1); if (this._viewActive(v)) openFolders.add(f); });
            order.sort((a, b) => (a === 'Other') - (b === 'Other'));
            const ordered = nested ? DU.visible(nested, folded, activeTaskId) : tasks;
            // Within a folder, sessions that need the person come first; a
            // delegated child stays with its parent.
            const sortFolder = (list) => {
                const chunks = [];
                list.forEach(v => { if (v.parentId && chunks.length) chunks[chunks.length - 1].push(v); else chunks.push([v]); });
                const need = (c) => c.some(v => v.needs) ? 0 : 1;
                return chunks.map((c, i) => [c, i]).sort((a, b) => need(a[0]) - need(b[0]) || a[1] - b[1]).flatMap(x => x[0]);
            };
            views = [...plain, ...order.flatMap(f => sortFolder(ordered.filter(v => folderOf(v) === f)))];
            collapsed = TP._collapsedFolders();
        }
        const headed = new Set();
        views.forEach(view => {
            const folder = folderOf(view);
            const folderOpen = !grouping || !view.taskId || openFolders.has(folder) || !collapsed.has(folder);
            if (grouping && view.taskId && !headed.has(folder)) {
                headed.add(folder);
                const head = document.createElement('div');
                head.className = 'nav-tasks-group';
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'nav-tasks-group-toggle';
                btn.setAttribute('aria-expanded', folderOpen ? 'true' : 'false');
                const nm = document.createElement('span');
                nm.className = 'nav-tasks-group-name';
                nm.textContent = folder;
                const ct = document.createElement('span');
                ct.className = 'nav-tasks-group-count';
                ct.textContent = String(counts.get(folder));
                btn.appendChild(nm);
                btn.appendChild(ct);
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // The open session's folder cannot be folded away.
                    if (openFolders.has(folder)) return;
                    const now = TP._collapsedFolders();
                    if (now.has(folder)) now.delete(folder); else now.add(folder);
                    TP._saveCollapsedFolders(now);
                    this.render();
                });
                head.appendChild(btn);
                wrap.appendChild(head);
            }
            const row = document.createElement('div');
            if (!folderOpen) row.hidden = true;
            row.className = 'nav-item nav-view' + (this._viewActive(view) ? ' active' : '');
            const delegParent = nested && view.taskId ? nested.parentOf.get(view.taskId) : null;
            const delegKids = nested && view.taskId ? (nested.kidsOf.get(view.taskId) || []) : [];
            if (delegParent) {
                row.classList.add('nav-view-child', DU.position(nested, view) === 'last' ? 'is-last' : 'is-mid');
                row.dataset.parentTask = delegParent.taskId;
            }
            if (delegKids.length) {
                row.dataset.childCount = String(delegKids.length);
                if (delegKids.some(k => k.taskId === activeTaskId)) row.classList.add('is-parent-of-active');
            }
            row.dataset.page = view.id;
            if (view.taskId) row.dataset.taskId = view.taskId;
            if (view.needs) row.classList.add('needs-you');
            if (view.aliases) row.dataset.aliases = view.aliases.join(',');
            const locked = !!view.cloud && this._enrolled !== true;
            row.dataset.tip = locked
                ? 'Requires a SecureVector cloud account: enroll this device to turn this on.'
                : (view.tooltip || '');
            if (row.dataset.tip && !this.collapsed) row.title = row.dataset.tip;
            if (locked) row.classList.add('nav-item-locked');
            if (view.icon) row.appendChild(this.createIcon(view.icon));
            if (view.taskId) {
                if (window.TaskAvatar) {
                    row.appendChild(TaskAvatar.el({ id: view.taskId, harness: view.harness, state: view.state, size: 30, delegated: !!view.parentId, parentTitle: view.fromTitle || (delegParent && delegParent.label) || '', cross: !!delegParent && delegParent.harness !== view.harness }));
                } else {
                    const agent = document.createElement('span');
                    agent.className = `sv-task-agent sv-task-agent-${view.state || 'active'}`;
                    agent.setAttribute('aria-hidden', 'true');
                    agent.appendChild(document.createElement('i'));
                    agent.appendChild(document.createElement('i'));
                    row.appendChild(agent);
                }
            }
            if (view.taskId) {
                const text = document.createElement('span');
                text.className = 'nav-task-text';
                const title = document.createElement('span');
                title.className = 'nav-task-title';
                title.textContent = view.label;
                // A live task is the one thing on this rail that changes while
                // nobody is looking at it, so it gets the only moving element.
                if (view.state === 'active') {
                    const live = document.createElement('i');
                    live.className = 'nav-task-live';
                    live.setAttribute('aria-hidden', 'true');
                    title.appendChild(live);
                }
                // A session running in the user's own terminal reads the same
                // on the rail as one the app launched, so it says which it is.
                if (view.linked) {
                    const chip = document.createElement('span');
                    chip.className = 'nav-task-linked';
                    chip.textContent = 'linked';
                    title.appendChild(chip);
                }
                if (delegParent) {
                    // Status dot for a delegated child: neutral unless it needs attention.
                    const dot = document.createElement('i');
                    dot.className = 'nav-deleg-dot is-' + (view.state || 'active');
                    dot.setAttribute('aria-hidden', 'true');
                    title.insertBefore(dot, title.firstChild);
                }
                const sub = document.createElement('span');
                sub.className = 'nav-task-sub';
                sub.textContent = view.sub || '';
                text.appendChild(title);
                text.appendChild(sub);
                if (delegParent && DU.crossAgent(view.harness, delegParent.harness)) {
                    const x = document.createElement('span');
                    x.className = 'nav-task-cross';
                    x.innerHTML = DU.crossHtml();
                    text.appendChild(x);
                }
                if (!delegParent && view.parentId && view.fromTitle) {
                    const from = document.createElement('span');
                    from.className = 'nav-task-from';
                    from.textContent = `from ${view.fromTitle}`;
                    text.appendChild(from);
                }
                if (view.facts) {
                    const facts = document.createElement('span');
                    facts.className = 'nav-task-facts';
                    facts.innerHTML = view.facts;
                    if (window.ConfigTrust && ConfigTrust.bindChips) ConfigTrust.bindChips(facts);
                    text.appendChild(facts);
                }
                row.appendChild(text);
                if (delegKids.length) {
                    const fold = document.createElement('button');
                    fold.type = 'button';
                    fold.className = 'nav-deleg-toggle';
                    const isFolded = folded.has(view.taskId);
                    fold.setAttribute('aria-expanded', isFolded ? 'false' : 'true');
                    fold.setAttribute('aria-label', `${isFolded ? 'Show' : 'Hide'} ${DU.childrenText(delegKids.length)}`);
                    fold.innerHTML = '<span class="deleg-caret" aria-hidden="true"></span>';
                    fold.addEventListener('click', (e) => {
                        e.stopPropagation();
                        DU.toggle(view.taskId);
                        this.render();
                    });
                    fold.addEventListener('pointerdown', (e) => e.stopPropagation());
                    row.appendChild(fold);
                }
            } else {
                const lbl = document.createElement('span');
                lbl.textContent = view.label;
                row.appendChild(lbl);
            }
            if (view.count) {
                const cnt = document.createElement('span');
                cnt.className = 'nav-count';
                cnt.dataset.countFor = view.count;
                cnt.hidden = true;
                row.appendChild(cnt);
            }
            if (view.id === 'rules') {
                const badge = document.createElement('span');
                badge.className = 'nav-count nav-count-quiet';
                badge.id = 'rules-count-badge';
                row.appendChild(badge);
            }
            if (view.liveWaiting) {
                // Approvals waiting on the person, amber, hidden at zero.
                // Filled by loadJitPendingCount() from the same poll.
                const wait = document.createElement('span');
                wait.className = 'nav-count nav-count-warn';
                wait.dataset.liveWaiting = '1';
                wait.hidden = true;
                row.appendChild(wait);
            }
            if (view.id === 'tool-permissions') {
                const jitBadge = document.createElement('span');
                jitBadge.id = 'jit-pending-badge';
                jitBadge.className = 'nav-count nav-count-warn';
                jitBadge.style.display = 'none';
                row.appendChild(jitBadge);
            }
            if (locked) {
                const tier = document.createElement('span');
                tier.className = 'nav-view-tier';
                tier.textContent = 'Cloud';
                tier.title = 'Needs a SecureVector account. Connect one under Cloud & Forwarders.';
                row.appendChild(tier);
            }
            const chordKey = Object.keys(this.CHORDS).find(k => this.CHORDS[k] === view.id && view.id !== item.id);
            if (chordKey) {
                const hint = document.createElement('kbd');
                hint.className = 'nav-chord-hint';
                hint.textContent = `g ${chordKey}`;
                row.appendChild(hint);
            }
            // The rail is the one list that always has every task, so it is
            // where a task is picked up from to drop into a pane. The drag
            // itself belongs to the terminals page, which is the only thing
            // that knows whether there is a pane to drop onto; this only
            // offers, and a row that is merely clicked is untouched.
            if (view.taskId) {
                row.addEventListener('pointerdown', (ev) => {
                    if (window.TerminalsPage?.beginTaskDrag) TerminalsPage.beginTaskDrag(view.taskId, ev);
                });
            }
            const activateView = (e) => {
                if (e) e.stopPropagation();
                if (view.taskId) {
                    // The click that ends a drag belongs to the drag.
                    if (window.TerminalsPage?.consumeDragClick && TerminalsPage.consumeDragClick()) return;
                    sessionStorage.setItem('sv-agent-task-id', view.taskId);
                    // Already looking at the page: hand the task straight to
                    // it. navigate() would call App.loadPage(), which has no
                    // already-on-page guard and re-renders from scratch, and
                    // the layout restore then rewrites this very key with the
                    // previously focused task, so the second agent clicked in
                    // the rail never opened.
                    if (this.currentPage === 'terminals' && window.TerminalsPage?.openTask) {
                        TerminalsPage.openTask(view.taskId);
                        this.setActive('terminals');
                        return;
                    }
                    this.navigate('terminals');
                    return;
                }
                this.navigate(view.id);
            };
            row.addEventListener('click', activateView);
            this._makeRowFocusable(row, activateView);
            wrap.appendChild(row);
        });
        return wrap;
    },

    _loadAgentTaskViews(force = false) {
        // A forced tick (timer, external refresh) that lands while a fetch is
        // already in flight cannot just be dropped, or a state change during
        // the in-flight request never gets picked up. Remember it and rerun
        // once the current fetch settles. An unforced call (e.g. render()'s
        // first paint) never needs to latch: it only wants whatever load is
        // already in flight to finish, not a guaranteed extra refetch.
        if (this._agentTaskViewsLoading) { if (force) this._agentTaskViewsRerun = true; return; }
        if ((this._agentTaskViewsLoaded && !force) || !window.API) return;
        // Opened by a network address: Agent Sessions answer only on this
        // machine, so the task list is not asked for at all.
        if (API.terminalsLocked && API.terminalsLocked()) { this._agentTaskViewsLoaded = true; return; }
        this._agentTaskViewsLoading = true;
        Promise.all([API.terminalsTasks(), API.getJitRequests('pending').catch(() => ({ items: [] }))])
            .then(([result, approvals]) => {
                const parent = this.navItems.find(item => item.id === 'terminals');
                if (!parent) return;
                const pendingSessions = new Set((approvals.items || []).map(item => item.session_id).filter(Boolean));
                const childCount = {};
                const known = new Set((result.items || []).map(x => x.id));
                (result.items || []).forEach(x => { if (x.parent_task_id && known.has(x.parent_task_id)) childCount[x.parent_task_id] = (childCount[x.parent_task_id] || 0) + 1; });
                parent.views = [
                    ...(result.items || []).map(task => {
                        const state = this._agentTaskState(task, pendingSessions.has(task.session_id));
                        return {
                            id: 'terminals', taskId: task.id, harness: task.executor_id,
                            parentId: task.parent_task_id || null,
                            created: task.created_at || '',
                            fromTitle: task.parent_task_id ? ((((result.items || []).find(x => x.id === task.parent_task_id)) || {}).title || '') : '',
                            state,
                            needs: pendingSessions.has(task.session_id) || task.drift_band === 'watch' || task.drift_band === 'high',
                            label: task.title || task.executor_id,
                            linked: task.origin === 'linked',
                            sub: this._taskSubtitle(task, state) + (childCount[task.id] ? ` · ${childCount[task.id] === 1 ? '1 child' : childCount[task.id] + ' children'}` : ''),
                            group: task.workspace || '',
                            folder: window.TerminalsPage && TerminalsPage._folderName ? TerminalsPage._folderName(task) : '',
                            facts: window.TerminalsPage && TerminalsPage._factsHtml ? TerminalsPage._factsHtml(task) : '',
                            factsSig: [task.spend_usd, task.spend_total_usd, task.tool_calls, task.blocked_calls, task.drift_score, task.drift_band, task.parent_task_id, task.setup_state, task.setup_changes].join(','),
                            tooltip: `${task.executor_id} · ${task.workspace}`,
                        };
                    }),
                ];
                // Rows and states only: this signature does not include which
                // row is selected, so it never forces a re-render on its own
                // when only the attached/selected task changes.
                const sig = parent.views.map(v => [v.taskId, v.state || '', v.label, v.sub || '', v.group || '', v.factsSig || ''].join(':')).join('|');
                // Same rows, same states, same folders: only the subtitles can
                // differ. Kept as its own signature rather than parsed back out
                // of `sig`, whose fields may themselves contain a separator.
                const rowSig = parent.views.map(v => [v.taskId, v.state || '', v.label, v.group || '', v.factsSig || ''].join(':')).join('|');
                this._agentTaskViewsLoaded = true;
                if (sig !== this._agentTaskSig) {
                    const sameRows = this._agentTaskRowSig === rowSig;
                    this._agentTaskSig = sig;
                    this._agentTaskRowSig = rowSig;
                    // The subtitle carries a clock, so it changes on its own
                    // every minute. Re-rendering the whole rail for that would
                    // drop keyboard focus and reset scroll once a minute.
                    if (sameRows && this._patchTaskSubtitles(parent.views)) return;
                    this.render();
                } else {
                    this._agentTaskRowSig = rowSig;
                }
            })
            .catch(() => { this._agentTaskViewsLoaded = true; })
            .finally(() => {
                this._agentTaskViewsLoading = false;
                if (this._agentTaskViewsRerun) {
                    this._agentTaskViewsRerun = false;
                    this._loadAgentTaskViews(true);
                }
            });
    },

    // Writes each task row's subtitle in place. Returns false when the rail is
    // not on screen in the expected shape, so the caller falls back to a full
    // render rather than leaving stale text behind.
    _patchTaskSubtitles(views) {
        const root = document.querySelector('.nav-views.nav-views-tasks');
        if (!root) return false;
        const rows = new Map();
        root.querySelectorAll('.nav-item.nav-view[data-task-id]').forEach(row => {
            const sub = row.querySelector('.nav-task-sub');
            if (sub) rows.set(row.dataset.taskId, sub);
        });
        const tasks = views.filter(v => v.taskId);
        if (!tasks.length || rows.size !== tasks.length) return false;
        for (const view of tasks) {
            if (!rows.has(view.taskId)) return false;
        }
        for (const view of tasks) rows.get(view.taskId).textContent = view.sub || '';
        // The age in the facts line ticks too; counts changing forces a full render.
        root.querySelectorAll('.nav-item.nav-view[data-task-id]').forEach(row => {
            const f = row.querySelector('.nav-task-facts');
            const v = tasks.find(x => x.taskId === row.dataset.taskId);
            if (f && v && v.facts) {
                f.innerHTML = v.facts;
                if (window.ConfigTrust && ConfigTrust.bindChips) ConfigTrust.bindChips(f);
            }
        });
        return true;
    },

    refreshAgentTaskViews() {
        this._agentTaskViewsLoaded = false;
        this._loadAgentTaskViews(true);
    },

    HARNESS_LABELS: { 'claude-code': 'Claude Code', codex: 'Codex', 'copilot-cli': 'Copilot CLI', opencode: 'OpenCode', govrun: 'GovRun', hermes: 'Hermes', openclaw: 'OpenClaw' },
    // The rail answers "which harness, and is it waiting on me". A live task
    // shows how long it has been going instead of repeating what the avatar
    // already says with its ring.
    _taskSubtitle(task, state) {
        const harness = this.HARNESS_LABELS[task.executor_id] || task.executor_id;
        if (state === 'approval') return `${harness} · needs approval`;
        if (state === 'blocked') return `${harness} · blocked`;
        if (state === 'completed') return `${harness} · done`;
        if (state === 'failed') return `${harness} · stopped`;
        if (state === 'interrupted' && task.status === 'stopped') return `${harness} · stopped by you`;
        if (state === 'interrupted') return `${harness} · interrupted`;
        return `${harness} · ${this._sinceShort(task.created_at)}`;
    },
    // Minute granularity on purpose: the rail signature includes the subtitle,
    // so a finer unit would redraw the whole rail every poll.
    _sinceShort(iso) {
        const s = Date.parse(iso);
        if (!s) return 'running';
        const m = Math.max(0, Math.floor((Date.now() - s) / 60000));
        if (m < 1) return 'just launched';
        if (m < 60) return `${m}m`;
        return `${Math.floor(m / 60)}h ${m % 60}m`;
    },
    _shortFolder(p) {
        const parts = (p || '').split('/').filter(Boolean);
        return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : (p || '');
    },

    _agentTaskState(task, waitingApproval = false) {
        if (waitingApproval) return 'approval';
        if (task.status === 'blocked') return 'blocked';
        if (task.status === 'done') return 'completed';
        if (task.status === 'interrupted') return 'interrupted';
        // A user Stop is not a failure: neutral, like interrupted.
        if (task.status === 'stopped') return 'interrupted';
        if (task.status === 'failed') return 'failed';
        return 'active';
    },

    _createDock() {
        const dock = document.createElement('div');
        dock.className = 'nav-dock';
        this.navItems.filter(i => i.dock).forEach(item => {
            const row = document.createElement('div');
            row.className = 'nav-item nav-dock-row' + (this._itemMatches(item, this.currentPage) ? ' active' : '');
            row.dataset.page = item.id;
            const reach = this._itemPageIds(item);
            if (reach.length) row.dataset.aliases = reach.join(',');
            row.title = item.tooltip || item.label;
            row.appendChild(this.createIcon(item.icon));
            const label = document.createElement('span');
            label.textContent = item.label;
            row.appendChild(label);
            const chordKey = Object.keys(this.CHORDS).find(k => this.CHORDS[k] === item.id);
            if (chordKey) {
                const hint = document.createElement('kbd');
                hint.className = 'nav-chord-hint';
                hint.textContent = `g ${chordKey}`;
                row.appendChild(hint);
            }
            row.addEventListener('click', () => this.navigate(item.id));
            dock.appendChild(row);
        });
        return dock;
    },

    _createSearchRow() {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'nav-search';
        row.title = 'Search pages and actions';
        row.setAttribute('aria-label', 'Search pages and actions');
        row.appendChild(this.createIcon('search'));
        const lbl = document.createElement('span');
        lbl.className = 'nav-search-label';
        lbl.textContent = 'Search';
        row.appendChild(lbl);
        const kbd = document.createElement('kbd');
        kbd.className = 'nav-search-kbd';
        kbd.textContent = /Mac/i.test(navigator.platform || '') ? '⌘K' : 'Ctrl K';
        row.appendChild(kbd);
        row.addEventListener('click', () => {
            if (window.CommandPalette && typeof CommandPalette.open === 'function') CommandPalette.open();
        });
        return row;
    },

    // Where the rail's numbers come from. Two rules hold everywhere:
    // a loud pill always means "something got through", and a pill that is
    // showing means there is something you have not looked at yet.
    _seenKey(page) { return `sv-nav-seen-${page}`; },

    _seenSince(page) {
        // Nothing looked at yet, or looked at long ago: fall back to 24 hours,
        // so the pill can never grow without bound.
        const floor = Date.now() - 24 * 3600 * 1000;
        let seen = 0;
        try { seen = Number(localStorage.getItem(this._seenKey(page))) || 0; } catch (_) { /* private mode */ }
        return new Date(Math.max(floor, seen)).toISOString();
    },

    markSeen(page) {
        const key = { threats: 'threats', 'blocked-ledger': 'blocked-ledger', redactions: 'redactions' }[page];
        if (!key) return;
        try { localStorage.setItem(this._seenKey(key), String(Date.now())); } catch (_) { /* private mode */ }
        setTimeout(() => this.loadLiveCounts(), 300);
    },

    loadLiveCounts() {
        const set = (key, n, title) => {
            const v = Number(n) || 0;
            document.querySelectorAll(`.nav-count[data-count-for="${key}"]`).forEach(el => {
                el.textContent = v > 999 ? '999+' : String(v);
                el.hidden = v <= 0;
                if (title) el.title = title;
            });
        };
        if (typeof API === 'undefined') return;
        // Threats always means detections. A blocked action is a different
        // outcome and gets its own row, never the same pill in the same colour.
        API.getThreats({ page_size: 1, is_threat: true, start_date: this._seenSince('threats') })
            .then(r => {
                const n = Number((r && r.total) || 0);
                set('threats', n, `${n} detection${n === 1 ? '' : 's'} you have not opened yet`);
            }).catch(() => {});
        API.getBlockedLedger({ window_days: 1 })
            .then(r => {
                const n = Number((r && r.summary && r.summary.blocked_total) || 0);
                set('blocked', n, `${n} action${n === 1 ? '' : 's'} blocked in the last 24 hours`);
            }).catch(() => {});
        API.getRedactions(1, { limit: 1 })
            .then(r => {
                const n = Number((r && r.summary && r.summary.total) || 0);
                set('secrets', n, `${n} secret${n === 1 ? '' : 's'} caught in the last 24 hours`);
            }).catch(() => {});
        API.getEgressDestinations(1)
            .then(r => {
                const n = ((r && r.destinations) || []).reduce((a, d) => a + (d.blocked || 0), 0);
                set('egress', n, `${n} egress call${n === 1 ? '' : 's'} blocked in the last 24 hours`);
            }).catch(() => {});
    },

    _flyoutInit(container) {
        let fly = document.getElementById('nav-flyout');
        if (!fly) {
            fly = document.createElement('div');
            fly.id = 'nav-flyout';
            fly.className = 'nav-flyout';
            fly.hidden = true;
            document.body.appendChild(fly);
            fly.addEventListener('mouseenter', () => clearTimeout(this._flyHide));
            fly.addEventListener('mouseleave', () => this._flyoutHide());
            fly.addEventListener('focusin', () => clearTimeout(this._flyHide));
            fly.addEventListener('focusout', () => this._flyoutHide());
            fly.addEventListener('keydown', (e) => {
                if (e.key !== 'Escape') return;
                const opener = this._flyoutOpener;
                this._flyoutHide(true);
                if (opener && opener.isConnected) opener.focus();
            });
        }
        // The flyout hangs off the PRODUCT RAIL, not off the context rows.
        // Collapsed hides the context panel outright, so the flyout is how
        // the other destinations stay reachable. Hover opens it after a short
        // pause (hover intent, 6.1.0), so a cursor crossing the rail on its
        // way elsewhere opens nothing. A click, Enter or ArrowRight/ArrowDown
        // also open it; keyboard focus alone does not. Escape closes it.
        const HOVER_INTENT_MS = 250;
        container.querySelectorAll('.product-rail-button').forEach(button => {
            let intent = null;
            button.addEventListener('mouseenter', () => {
                clearTimeout(intent);
                intent = setTimeout(() => {
                    if (button.isConnected && button.matches(':hover') && container.classList.contains('collapsed')) this._flyoutShow(button);
                }, HOVER_INTENT_MS);
            });
            button.addEventListener('mouseleave', () => { clearTimeout(intent); this._flyoutHide(); });
            button.addEventListener('blur', () => this._flyoutHide());
            button.addEventListener('keydown', (e) => {
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowDown') return;
                if (!container.classList.contains('collapsed')) return;
                e.preventDefault();
                this._flyoutShow(button);
                const first = document.querySelector('#nav-flyout .nav-flyout-view');
                if (first) first.focus();
            });
        });
    },

    _flyoutShow(button) {
        clearTimeout(this._flyHide);
        const group = this.productGroups.find(g => g.id === button.dataset.productGroup);
        const fly = document.getElementById('nav-flyout');
        if (!group || !fly) return;
        this._flyoutOpener = button;
        fly.textContent = '';
        const title = document.createElement('div');
        title.className = 'nav-flyout-title';
        title.textContent = group.label;
        // Whatever the button itself is already showing — the pending-approval
        // count is the only one — is mirrored here rather than polled again.
        const cnt = [...button.querySelectorAll('.nav-count, .product-rail-attention')]
            .find(el => !el.hidden);
        if (cnt) {
            const c = document.createElement('span');
            c.className = 'nav-count';
            c.textContent = cnt.textContent;
            title.appendChild(c);
        }
        fly.appendChild(title);
        if (group.subtitle) {
            const d = document.createElement('div');
            d.className = 'nav-flyout-desc';
            d.textContent = group.subtitle;
            fly.appendChild(d);
        }
        // Every destination in the group, which is what makes the collapsed
        // rail complete. Views stay inside their destination: the page that
        // owns them is one click away and lists them itself.
        group.items
            .map(id => this.navItems.find(item => item.id === id))
            .filter(Boolean)
            .forEach(v => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'nav-flyout-view' + (this._itemMatches(v, this.currentPage) ? ' active' : '');
                if (v.icon) b.appendChild(this.createIcon(v.icon));
                const lbl = document.createElement('span');
                lbl.textContent = v.label;
                b.appendChild(lbl);
                if (v.tooltip) b.title = v.tooltip;
                b.addEventListener('click', () => {
                    // The flyout lives on document.body, outside #sidebar, so
                    // render()'s own focus-restore guard (container.contains)
                    // never matches it and focus would otherwise fall to
                    // <body> once navigation replaces the rail. Send it back
                    // to the rail button that opened this flyout instead —
                    // by group id, since navigate() may rebuild the rail and
                    // `button` itself can end up detached.
                    const openerGroupId = button.dataset.productGroup;
                    this._flyoutHide(true);
                    if (v.id === 'terminals') {
                        this._showAgentTasksBoard();
                    } else {
                        this.navigate(v.id);
                    }
                    const rail = document.querySelector('.sidebar-product-rail');
                    const refocus = rail && rail.querySelector(`.product-rail-button[data-product-group="${openerGroupId}"]`);
                    if (refocus) {
                        // Same reopen risk as render()'s own restore: this
                        // focus() would otherwise immediately trip the
                        // focus-opens-flyout handler and pop the flyout back
                        // open right after we just hid it above.
                        this._suppressFlyoutFocus = true;
                        refocus.focus();
                        this._suppressFlyoutFocus = false;
                    }
                });
                fly.appendChild(b);
            });
        const r = button.getBoundingClientRect();
        fly.style.left = `${Math.round(r.right + 6)}px`;
        fly.hidden = false;
        const h = fly.offsetHeight || 120;
        fly.style.top = `${Math.round(Math.max(8, Math.min(r.top, window.innerHeight - 8 - h)))}px`;
    },

    _flyoutHide(now) {
        clearTimeout(this._flyHide);
        const fly = document.getElementById('nav-flyout');
        if (!fly) return;
        if (now) { fly.hidden = true; return; }
        this._flyHide = setTimeout(() => { fly.hidden = true; }, 160);
    },

    // ---- v5.3 rail: sliding indicator, chord shortcuts ----
    // The rail is navigation only. Live agent counts live on Traces and
    // device posture on Agent Governance; both used to be repeated here.

    _fadeInit(nav) {
        const sync = () => nav.classList.toggle('nav-more', nav.scrollHeight - nav.clientHeight - nav.scrollTop > 4);
        nav.addEventListener('scroll', sync, { passive: true });
        nav.addEventListener('scrollend', sync, { passive: true });
        // render() runs this on every navigation, so the previous listener has
        // to come off first — the same discipline the observers below already
        // follow, and without it every group switch leaks another callback.
        if (this._fadeResize) window.removeEventListener('resize', this._fadeResize);
        this._fadeResize = sync;
        window.addEventListener('resize', sync);
        if (typeof ResizeObserver !== 'undefined') {
            if (this._fadeRo) this._fadeRo.disconnect();
            this._fadeRo = new ResizeObserver(sync);
            this._fadeRo.observe(nav);
        }
        // The rail's own box is fixed by the layout; its contents grow and
        // shrink as sections and views open, so watch those too.
        if (typeof MutationObserver !== 'undefined') {
            if (this._fadeMo) this._fadeMo.disconnect();
            this._fadeMo = new MutationObserver(sync);
            this._fadeMo.observe(nav, { subtree: true, attributes: true, attributeFilter: ['class', 'style'], childList: true });
        }
        requestAnimationFrame(sync);
    },

    _indicatorInit(nav) {
        nav.style.position = 'relative';
        const ind = document.createElement('div');
        ind.className = 'nav-indicator';
        nav.appendChild(ind);
        this._indicator = ind;
        this._indicatorNav = nav;
        requestAnimationFrame(() => this._moveIndicator(true));
    },

    _moveIndicator(instant) {
        const ind = this._indicator;
        const nav = this._indicatorNav;
        if (!ind || !nav || !nav.isConnected) return;
        const rows = [...nav.querySelectorAll('.nav-item.active')].filter(el => el.offsetParent !== null);
        // A view lights its label; the bar stays on the parent row so the
        // edge marker and the tinted row always agree. The Detection &
        // Response panel is the exception: its section rows are the whole
        // panel, so the bar follows the section in view.
        const el = rows.find(r => r.classList.contains('nav-dr-section'))
            || rows.find(r => !r.classList.contains('nav-view')) || rows[rows.length - 1];
        if (!el) { ind.style.opacity = '0'; return; }
        if (instant) ind.style.transition = 'none';
        ind.style.top = `${el.offsetTop}px`;
        ind.style.height = `${el.offsetHeight}px`;
        ind.style.opacity = '1';
        if (instant) requestAnimationFrame(() => { ind.style.transition = ''; });
    },

    // "g then key" jumps, the Linear and Gmail convention. The hints show on
    // the rows while the chord is armed, so nobody has to memorise them.
    CHORDS: { d: 'dashboard', t: 'agent-runs', h: 'threats', c: 'costs', e: 'egress', p: 'policies',
              k: 'skill-scanner', a: 'governance', n: 'guide-connect-agents', f: 'siem-export', u: 'guide', s: 'settings',
              // Pages folded under Policies: the fold must not cost a keystroke.
              l: 'tool-permissions', r: 'rules', x: 'egress-policy', b: 'cost-settings', m: 'mcp-policies' },

    /** True for the platform's sidebar chord and nothing else. Mac reads Cmd
     *  without Ctrl, everywhere else Ctrl without Cmd; Alt or Shift on top
     *  makes it somebody else's combo, so it is left alone. */
    _sidebarChord(e) {
        if (e.altKey || e.shiftKey) return false;
        const mac = /Mac|iPhone|iPad/i.test(
            (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ''
        );
        const mod = mac ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey);
        if (!mod) return false;
        return e.code === 'KeyB' || String(e.key || '').toLowerCase() === 'b';
    },

    _chordInit() {
        if (this._chordBound) return;
        this._chordBound = true;
        const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
        document.addEventListener('keydown', (e) => {
            // Cmd+B / Ctrl+B toggles the sidebar, the binding every editor
            // and workspace app already uses. Only the platform's own
            // modifier counts: Cmd+Ctrl+B on a Mac is a different chord, and
            // a field with focus keeps the key (bold in a rich-text box, and
            // the browser's own Ctrl+B, both stay the user's).
            if (this._sidebarChord(e) && !typing(e.target)) {
                if (!document.getElementById('sidebar')) return;
                e.preventDefault();
                this.toggleCollapse();
                return;
            }
            if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
            const sidebar = document.getElementById('sidebar');
            if (!sidebar) return;
            if (this._chordArmed) {
                clearTimeout(this._chordTimer);
                this._chordArmed = false;
                sidebar.classList.remove('nav-chord');
                const page = this.CHORDS[e.key.toLowerCase()];
                if (page) { e.preventDefault(); this.navigate(page); }
                return;
            }
            if (e.key === 'g' || e.key === 'G') {
                this._chordArmed = true;
                sidebar.classList.add('nav-chord');
                this._chordTimer = setTimeout(() => {
                    this._chordArmed = false;
                    sidebar.classList.remove('nav-chord');
                }, 1500);
            }
        });
    },

    toggleCollapse() {
        const container = document.getElementById('sidebar');
        this.collapsed = !this.collapsed;
        localStorage.setItem('sidebar-collapsed', this.collapsed);

        container.classList.toggle('collapsed', this.collapsed);
        this._syncCollapsedControls(container);
        this._flyoutHide(true);
        setTimeout(() => this._moveIndicator(true), 260);
        container.querySelectorAll('.nav-item[data-tip]').forEach(row => {
            if (this.collapsed) row.removeAttribute('title');
            else if (row.dataset.tip) row.title = row.dataset.tip;
        });

        // Update icon and accessible name together: a control whose name says
        // "Collapse" while it would expand is worse than one with no name.
        this._syncCollapseBtn(container.querySelector('.sidebar-collapse-btn'));
    },

    /** Point the chevron the way the click goes, and say so in two places:
     *  the tooltip and the accessible name. Called on build and again on
     *  every toggle, so both follow the state. */
    _syncCollapseBtn(btn) {
        if (!btn) return;
        const path = btn.querySelector('path');
        if (path) path.setAttribute('d', this.collapsed ? 'M9 18l6-6-6-6' : 'M15 18l-6-6 6-6');
        const word = this.collapsed ? 'Expand' : 'Collapse';
        btn.title = `${word} sidebar`;
        btn.setAttribute('aria-label', `${word} sidebar`);
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

    // Theme picker at the rail foot. Started as a dark/light circle; it is a
    // swatch row now because two options was not much of a choice. Each swatch
    // is painted in that theme's own page and card colours, so the control
    // previews rather than describes. Only the shell changes between themes —
    // see the variant blocks in styles.css for why the accent is fixed.
    // `page` and `edge` are each theme's darkest and lightest shell tones. The
    // swatch runs one into the other rather than showing a single flat fill:
    // three dark themes painted only in their page colour are three
    // indistinguishable black dots at 18px, and the widest tonal span each
    // theme actually contains is what separates them by eye.
    THEMES: [
        { id: 'dark',  label: 'Dark',  page: '#090b0f', edge: '#1a2029' },
        { id: 'black', label: 'Black', page: '#000000', edge: '#16181c' },
        { id: 'slate', label: 'Slate', page: '#151a23', edge: '#2a3340' },
        { id: 'azure', label: 'Azure', page: '#071019', edge: '#1b3149' },
        { id: 'ember', label: 'Ember', page: '#100c09', edge: '#2d2019' },
        { id: 'light', label: 'Light', page: '#ffffff', edge: '#dfe5ec' },
    ],

    currentTheme() {
        const t = document.documentElement.getAttribute('data-theme') || 'dark';
        return this.THEMES.some(x => x.id === t) ? t : 'dark';
    },

    _swatchFill(t) {
        return `linear-gradient(135deg, ${t.page} 0 50%, ${t.edge} 50% 100%)`;
    },

    createThemeFooter() {
        const active = this.currentTheme();
        const cur = this.THEMES.find(t => t.id === active) || this.THEMES[0];

        const row = document.createElement('div');
        row.className = 'sidebar-theme-fixed';

        // Collapsed to a single row showing only the CURRENT theme; the full
        // palette lives in a menu that opens on hover or focus. Six swatches
        // sitting in the rail permanently spent the footer's whole width on a
        // control that gets touched about once, and three of them were
        // near-identical dark dots without their labels to tell them apart.
        // The menu gives every option its name back.
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'sidebar-theme-trigger';
        trigger.setAttribute('aria-haspopup', 'true');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.title = `Theme: ${cur.label}`;

        // No swatch on the closed row. A lone dark circle sitting under the
        // nav read as a stray control rather than a setting, and at rail size
        // it could not show which of the dark themes was active anyway. The
        // row states the theme by NAME; the colours appear in the menu, where
        // they are being compared and actually mean something.
        const label = document.createElement('span');
        label.className = 'sidebar-theme-name';
        label.textContent = 'Theme';
        trigger.appendChild(label);

        const cur_ = document.createElement('span');
        cur_.className = 'sidebar-theme-current';
        cur_.textContent = cur.label;
        trigger.appendChild(cur_);

        const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        chev.setAttribute('viewBox', '0 0 24 24');
        chev.setAttribute('fill', 'none');
        chev.setAttribute('stroke', 'currentColor');
        chev.setAttribute('stroke-width', '2');
        chev.setAttribute('aria-hidden', 'true');
        chev.classList.add('sidebar-theme-chev');
        const chevPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        chevPath.setAttribute('d', 'M6 15l6-6 6 6');
        chev.appendChild(chevPath);
        trigger.appendChild(chev);

        row.appendChild(trigger);

        const menu = document.createElement('div');
        menu.className = 'sv-theme-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', 'Colour theme');

        this.THEMES.forEach(t => {
            const opt = document.createElement('button');
            opt.type = 'button';
            opt.className = 'sv-theme-opt' + (t.id === active ? ' on' : '');
            opt.setAttribute('role', 'menuitemradio');
            opt.setAttribute('aria-checked', t.id === active ? 'true' : 'false');
            opt.dataset.theme = t.id;

            const sw = document.createElement('span');
            sw.className = 'sv-swatch';
            sw.style.background = this._swatchFill(t);
            opt.appendChild(sw);

            const nm = document.createElement('span');
            nm.className = 'sv-theme-opt-name';
            nm.textContent = t.label;
            opt.appendChild(nm);

            opt.addEventListener('click', () => this.setTheme(t.id));
            menu.appendChild(opt);
        });

        row.appendChild(menu);

        // Open on hover AND on click/focus. Hover alone would leave the
        // control unreachable by keyboard and unusable by touch, and a
        // hover-only menu on the very bottom row of the window is easy to
        // open by accident on the way to somewhere else.
        let closeTimer = null;
        const open = () => {
            if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
            menu.classList.add('open');
            trigger.setAttribute('aria-expanded', 'true');
        };
        const close = () => {
            menu.classList.remove('open');
            trigger.setAttribute('aria-expanded', 'false');
        };
        // Small grace period so crossing the gap between row and menu, or
        // clipping a corner, does not snap it shut mid-reach.
        const closeSoon = () => {
            if (closeTimer) clearTimeout(closeTimer);
            closeTimer = setTimeout(close, 220);
        };

        row.addEventListener('mouseenter', open);
        row.addEventListener('mouseleave', closeSoon);
        row.addEventListener('focusin', open);
        row.addEventListener('focusout', (e) => {
            if (!row.contains(e.relatedTarget)) close();
        });
        trigger.addEventListener('click', () => {
            menu.classList.contains('open') ? close() : open();
        });
        row.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { close(); trigger.focus(); }
        });

        // One foot row: theme on the left, GitHub and Discord as two quiet
        // icons on the right. Same line so the rail foot stays one row; the
        // theme hover menu keeps its own wrapper so the icons do not open it.
        const foot = document.createElement('div');
        foot.className = 'sidebar-foot';
        foot.appendChild(row);
        if (window.Community) foot.appendChild(Community.createLinks());
        return foot;
    },

    setTheme(id) {
        if (!this.THEMES.some(t => t.id === id)) return;
        if (this.currentTheme() === id) return;
        document.documentElement.setAttribute('data-theme', id);
        try { localStorage.setItem('theme', id); } catch (_) { /* private mode */ }
        if (window.DesktopChrome) DesktopChrome.syncTheme(id);
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

        // The people who leave are the ones we most need to hear from. One
        // optional line, one click, a prefilled issue; no survey.
        if (window.Community) {
            const leaving = document.createElement('p');
            leaving.style.cssText = 'margin: 12px 0 0; font-size: 12px; color: var(--text-secondary);';
            leaving.appendChild(document.createTextNode('Leaving because something did not work? '));
            const tell = Community.createReportLink('Tell us in a GitHub issue', Community.bugUrl({ title: 'Uninstalling because: ' }));
            tell.style.cssText = 'color: var(--accent-primary);';
            leaving.appendChild(tell);
            leaving.appendChild(document.createTextNode(' or '));
            const mail = Community.createReportLink('email us', Community.mailUrl('feedback'));
            mail.removeAttribute('target');
            mail.style.cssText = 'color: var(--accent-primary);';
            leaving.appendChild(mail);
            leaving.appendChild(document.createTextNode('. Version and platform are prefilled, nothing else.'));
            modal.appendChild(leaving);
        }

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

    async loadJitPendingCount() {
        try {
            const r = await API.getJitRequests('pending');
            const n = (r && typeof r.pending === 'number') ? r.pending
                : ((r && r.items) ? r.items.length : 0);
            const badge = document.getElementById('jit-pending-badge');
            if (badge) {
                badge.textContent = n === 1 ? '1 waiting' : n + ' waiting';
                badge.style.display = n > 0 ? 'inline-flex' : 'none';
            }
            document.querySelectorAll('[data-live-waiting]').forEach(el => {
                const meaning = n === 1 ? '1 approval waiting' : n + ' approvals waiting';
                el.textContent = el.dataset.obsLabel ? n + ' ' + el.dataset.obsLabel : String(n);
                el.title = meaning;
                el.setAttribute('aria-label', meaning);
                el.hidden = n <= 0;
            });
            const parent = document.getElementById('jit-pending-parent-badge');
            if (parent) {
                parent.textContent = String(n);
                parent.title = n === 1 ? '1 request waiting for you' : n + ' requests waiting for you';
                parent.hidden = n === 0;
            }
            // Reuse this single poll for the persistent product rail. Agent
            // Tasks and Governance both need to signal that an agent is
            // waiting for a human decision, even while another group is open.
            document.querySelectorAll('[data-jit-product-badge]').forEach(productBadge => {
                const meaning = n === 1 ? '1 pending approval' : n + ' pending approvals';
                productBadge.textContent = String(n);
                productBadge.setAttribute('aria-label', meaning);
                productBadge.title = meaning;
                productBadge.hidden = n === 0;
                const productButton = productBadge.closest('.product-rail-button');
                if (productButton) {
                    productButton.setAttribute('aria-label', n > 0
                        ? `${productButton.dataset.baseLabel}: ${meaning}`
                        : productButton.dataset.baseLabel);
                }
            });
        } catch (_) { /* fail-quiet: badge just stays hidden */ }
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
        python: { icon: '🐍', label: 'PYTHON @GUARD', color: 'linear-gradient(135deg, #8b949e, #6e7681)', page: 'proxy-python' },
        hermes: { icon: '🪽', label: 'HERMES PROXY', color: 'linear-gradient(135deg, #f59e0b, #d97706)', page: 'proxy-hermes' },
        n8n: { icon: '⚡', label: 'N8N PROXY', color: 'linear-gradient(135deg, #ef4444, #dc2626)', page: 'proxy-n8n' },
        default: { icon: '', label: 'PROXY', color: 'linear-gradient(135deg, #5eadb8, #c0655e)', page: 'integrations' },
    },

    // Status pollers (proxy, SIEM, each harness's Guard). A harness that is
    // not installed, the proxy and SIEM are checked every STATUS_IDLE_MS,
    // only while the tab is visible, and again when it becomes visible. They
    // used to run every 2 s (harness not installed) and 5 s (proxy, SIEM,
    // hidden tabs included): about 190 requests a minute per open window.
    STATUS_IDLE_MS: 30000,
    _statusInflight: null,

    /** fetch() for the status pollers, one request per URL in flight: a
     *  render() and a visibility change that land together share it. The
     *  answer is read once and handed to every caller as { ok, json() }. */
    _sharedFetch(url) {
        if (!this._statusInflight) this._statusInflight = new Map();
        const hit = this._statusInflight.get(url);
        if (hit) return hit;
        const p = fetch(url).then(async (r) => {
            const data = r.ok ? await r.json().catch(() => null) : null;
            return { ok: r.ok && data !== null, status: r.status, json: () => Promise.resolve(data) };
        }).finally(() => this._statusInflight.delete(url));
        this._statusInflight.set(url, p);
        return p;
    },

    async checkProxyStatus() {
        // Hidden tab: no request and no next tick; the visibility hook runs
        // this again when the tab is shown.
        if (document.visibilityState === 'hidden') return;
        try {
            const response = await this._sharedFetch('/api/proxy/status');
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
                                langgraph: 'LangGraph', crewai: 'CrewAI', hermes: 'Hermes', n8n: 'n8n',
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
        // Refresh every 30 seconds. render() runs on every group switch and
        // kicks all six pollers again, so each one owns a single timer handle
        // and cancels its own pending tick before booking the next: calling a
        // poller twice leaves exactly one chain, never two.
        // Every 30 s; a hidden tab stops the chain (see the top of this
        // method) and the visibility hook in render() restarts it.
        clearTimeout(this._proxyStatusTimer);
        this._proxyStatusTimer = setTimeout(() => this.checkProxyStatus(), this.STATUS_IDLE_MS);
    },

    async checkSiemStatus() {
        if (document.visibilityState === 'hidden') return; // as checkProxyStatus
        // Sidebar "SIEM active" indicator. Visible only when:
        //   (a) master toggle is enabled (siem-forwarders/global-settings)
        //   (b) at least one destination is configured + enabled
        // Otherwise the banner hides — we don't mislead operators into
        // thinking something's flowing when the pipe is paused or empty.
        try {
            const [global, list] = await Promise.all([
                this._sharedFetch('/api/siem-forwarders/global-settings').then(r => r.ok ? r.json() : null).catch(() => null),
                this._sharedFetch('/api/siem-forwarders').then(r => r.ok ? r.json() : null).catch(() => null),
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
        clearTimeout(this._siemStatusTimer);
        this._siemStatusTimer = setTimeout(() => this.checkSiemStatus(), this.STATUS_IDLE_MS);
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
            const res = await this._sharedFetch('/api/hooks/claude-code/status');
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
        // installed), check every STATUS_IDLE_MS (30 s) and on each
        // return to the tab; it was 2 s, the bulk of the app's requests.
        // Once visible, a 10s cadence.
        if (document.visibilityState === 'visible'
            && document.getElementById('cc-plugin-active-banner')) {
            const visible = banner.style.display !== 'none';
            const delay = visible ? 10000 : this.STATUS_IDLE_MS;
            clearTimeout(this._ccPluginStatusTimer);
            this._ccPluginStatusTimer = setTimeout(() => this.checkClaudeCodePluginStatus(), delay);
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
            const res = await this._sharedFetch('/api/hooks/copilot-cli/status');
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
            const delay = visible ? 10000 : this.STATUS_IDLE_MS;
            clearTimeout(this._copilotPluginStatusTimer);
            this._copilotPluginStatusTimer = setTimeout(() => this.checkCopilotPluginStatus(), delay);
        }
    },

    async checkOpenCodePluginStatus() {
        // Sidebar "OpenCode plugin" indicator. Mirrors the CC/Codex/Copilot
        // pollers — same three states (Active / Installed, not enabled /
        // Staged), same cadence (2s while hidden, 10s once visible). The
        // OpenCode /status route reports installed from the staged tree and
        // enabled from the "plugin" array in ~/.config/opencode/opencode.json.
        const banner = document.getElementById('opencode-plugin-active-banner');
        const textEl = document.getElementById('opencode-plugin-banner-text');
        if (!banner || !textEl) return;
        try {
            const res = await this._sharedFetch('/api/hooks/opencode/status');
            const status = res.ok ? await res.json() : null;
            if (!status || !status.installed) {
                banner.style.display = 'none';
            } else if (status.auto_installed && status.enabled) {
                banner.style.display = 'flex';
                textEl.textContent = 'OpenCode plugin \u00b7 Active';
            } else if (status.auto_installed) {
                banner.style.display = 'flex';
                textEl.textContent = 'OpenCode plugin \u00b7 Installed, not enabled';
            } else {
                banner.style.display = 'flex';
                textEl.textContent = 'OpenCode plugin \u00b7 Staged';
            }
        } catch (_) { /* ignore */ }
        if (document.visibilityState === 'visible'
            && document.getElementById('opencode-plugin-active-banner')) {
            const visible = banner.style.display !== 'none';
            const delay = visible ? 10000 : this.STATUS_IDLE_MS;
            clearTimeout(this._opencodePluginStatusTimer);
            this._opencodePluginStatusTimer = setTimeout(() => this.checkOpenCodePluginStatus(), delay);
        }
    },

    async checkAntigravityPluginStatus() {
        // Sidebar "Antigravity plugin" indicator. Mirrors the CC/Codex/Copilot/
        // OpenCode pollers: same three states (Active / Installed, not enabled /
        // Staged), same cadence (2s while hidden, 10s once visible). The
        // Antigravity /status route reports installed from the staged tree, and
        // enabled from the presence of the plugin dir plus its manifest under
        // ~/.gemini/config/plugins, because Antigravity documents discovery by
        // directory and names no registry recording enabled state.
        const banner = document.getElementById('antigravity-plugin-active-banner');
        const textEl = document.getElementById('antigravity-plugin-banner-text');
        if (!banner || !textEl) return;
        try {
            const res = await this._sharedFetch('/api/hooks/antigravity/status');
            const status = res.ok ? await res.json() : null;
            if (!status || !status.installed) {
                banner.style.display = 'none';
            } else if (status.auto_installed && status.enabled) {
                banner.style.display = 'flex';
                textEl.textContent = 'Antigravity plugin \u00b7 Active';
            } else if (status.auto_installed) {
                banner.style.display = 'flex';
                textEl.textContent = 'Antigravity plugin \u00b7 Installed, not enabled';
            } else {
                banner.style.display = 'flex';
                textEl.textContent = 'Antigravity plugin \u00b7 Staged';
            }
        } catch (_) { /* ignore */ }
        if (document.visibilityState === 'visible'
            && document.getElementById('antigravity-plugin-active-banner')) {
            const visible = banner.style.display !== 'none';
            const delay = visible ? 10000 : this.STATUS_IDLE_MS;
            clearTimeout(this._antigravityPluginStatusTimer);
            this._antigravityPluginStatusTimer = setTimeout(() => this.checkAntigravityPluginStatus(), delay);
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
            const res = await this._sharedFetch('/api/hooks/codex/status');
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
            const delay = visible ? 10000 : this.STATUS_IDLE_MS;
            clearTimeout(this._codexPluginStatusTimer);
            this._codexPluginStatusTimer = setTimeout(() => this.checkCodexPluginStatus(), delay);
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
            search: [
                { tag: 'circle', attrs: { cx: '11', cy: '11', r: '7' } },
                { tag: 'path', attrs: { d: 'M21 21l-4.5-4.5' } },
            ],
            // Detection & Response: a radar sweep with a contact, so it never
            // reads as the search magnifier above it on the rail (6.1.0).
            radar: [
                { tag: 'circle', attrs: { cx: '12', cy: '12', r: '9' } },
                { tag: 'circle', attrs: { cx: '12', cy: '12', r: '4.5' } },
                { tag: 'path', attrs: { d: 'M12 12l6.4-6.4' } },
                { tag: 'circle', attrs: { cx: '16.5', cy: '14.5', r: '1' } },
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
            // Speedometer dial (needle + arc) — reads as a posture "level",
            // matching the Agent Governance band (Minimal / Partial / Strong)
            // and keeping it distinct from the MCP Policies shield-check.
            gauge: [
                { tag: 'path', attrs: { d: 'm12 14 4-4' } },
                { tag: 'path', attrs: { d: 'M3.34 19a10 10 0 1 1 17.32 0' } },
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
                { tag: 'path', attrs: { d: 'M12 6.5v11M15 9.4a3.2 3.2 0 0 0-3-1.6c-1.7 0-3 .9-3 2.1s1.3 2.1 3 2.1 3 .9 3 2.1-1.3 2.1-3 2.1a3.2 3.2 0 0 1-3-1.6' } },
            ],
            history: [
                { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
                { tag: 'polyline', attrs: { points: '12 6 12 12 16 14' } },
            ],
            terminal: [
                { tag: 'path', attrs: { d: 'M4 17l6-5-6-5' } },
                { tag: 'path', attrs: { d: 'M12 19h8' } },
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
            // Plug — "connect your agents". Mirrors the header Connect Agents
            // button glyph so the two entry points read as the same action.
            plug: [
                { tag: 'path', attrs: { d: 'M9 2v6' } },
                { tag: 'path', attrs: { d: 'M15 2v6' } },
                { tag: 'path', attrs: { d: 'M7 8h10v3a5 5 0 0 1-10 0V8z' } },
                { tag: 'path', attrs: { d: 'M12 16v6' } },
            ],
            more: [
                { tag: 'circle', attrs: { cx: '5', cy: '12', r: '1', fill: 'currentColor' } },
                { tag: 'circle', attrs: { cx: '12', cy: '12', r: '1', fill: 'currentColor' } },
                { tag: 'circle', attrs: { cx: '19', cy: '12', r: '1', fill: 'currentColor' } },
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
                // Keep the ARIA state in sync with the visible one — without
                // this a `_makeRowFocusable(..., { role: 'button', expanded })`
                // row would announce "collapsed" while visibly open.
                navItem.setAttribute('aria-expanded', 'true');
            }
        }
    },

    navigate(page) {
        const targetGroup = this._activeProductGroup(page);
        const groupChanged = targetGroup.id !== this._renderedProductGroup;
        // Auto-expand parent section when navigating to a sub-item
        for (const item of this.navItems) {
            if (item.collapsible && item.subItems && item.subItems.some(sub => sub.id === page)) {
                this.expandSection(item.id);
                break;
            }
        }

        this.currentPage = page;
        this.markSeen(page);
        if (page === 'detection-response') this._drActive = this._drPendingSection || null;
        else this._drPendingSection = null;

        if (groupChanged) this.render();

        // Remove core icon badge dot on first visit

        // Update active state
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.page === page);
        });
        this._drSyncActive();

        // Landing on a page whose section is collapsed would hide the active
        // row ("where am I?") — re-open that section. The render-time guard
        // only covers page load; this covers in-app navigation.
        const activeEl = document.querySelector(`.nav-item.active[data-page="${page}"]`);
        if (activeEl && (activeEl.classList.contains('nav-sec-hidden') || activeEl.closest('.nav-sec-hidden'))) {
            const sec = (this._sections || []).find(s => s.els.includes(activeEl)
                || s.els.some(el => el.contains && el.contains(activeEl)));
            if (sec && sec.collapsed && sec.apply) {
                try { localStorage.setItem(sec.key, '0'); } catch (_) { /* private mode */ }
                sec.apply(false);
            }
        }

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
        this.markSeen(page);
        const activeGroup = this._activeProductGroup(page);
        if (activeGroup.id !== this._renderedProductGroup) {
            this.render();
            return;
        }
        document.querySelectorAll('.nav-item').forEach(item => {
            const isSubItem = item.classList.contains('nav-sub-item') || item.classList.contains('nav-view');
            const matchesPage = item.dataset.page === page ||
                (item.dataset.aliases || '').split(',').includes(page);
            if (isSubItem) {
                const isTaskView = !!item.dataset.taskId;
                const isSelectedTask = page === 'terminals' && sessionStorage.getItem('sv-agent-task-id') === item.dataset.taskId;
                item.classList.toggle('active', isTaskView ? isSelectedTask : matchesPage);
                if (isTaskView) {
                    // A parent of the selected delegated child reads as related.
                    const sel = page === 'terminals' ? sessionStorage.getItem('sv-agent-task-id') : null;
                    const selRow = sel ? document.querySelector(`.nav-view[data-task-id="${CSS.escape(sel)}"]`) : null;
                    item.classList.toggle('is-parent-of-active', !!(selRow && selRow.dataset.parentTask === item.dataset.taskId));
                }
            } else {
                const hasSubItems = item.nextElementSibling && item.nextElementSibling.classList.contains('nav-sub-items');
                const isCollapsible = item.dataset.collapsible === 'true';
                // Collapsible parents (like Docs) stay active when on their page
                item.classList.toggle('active', matchesPage && (!hasSubItems || isCollapsible));
            }
        });
        // Views show under their destination only while it is the active one.
        // A hoisted top-level group (see render(): a single-item group whose
        // item is its own landing) has no parent row to key off, and stays
        // open unconditionally, so its views are excluded here.
        document.querySelectorAll('.nav-views').forEach(v => {
            if (v.classList.contains('nav-views-flat')) return;
            const parent = v.previousElementSibling;
            const open = !!(parent && parent.classList.contains('active'));
            v.classList.toggle('open', open);
            v.classList.remove('peek');
            if (parent) parent.classList.toggle('nav-fold-open', open);
        });
        this._drSyncActive();
        requestAnimationFrame(() => this._moveIndicator(false));
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
