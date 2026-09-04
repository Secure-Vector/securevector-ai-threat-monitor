/**
 * Sidebar Navigation Component
 * Note: All content is static/hardcoded, no user input is rendered
 */

const Sidebar = {
    navItems: [
        // v5.3 rail: ten destinations in three groups, plus Guide and Settings
        // docked at the bottom. Pages that used to be their own rows are
        // `views` of a destination: they render indented under the active row
        // (expanded rail) or inside the hover flyout (icon rail). Every old page
        // id stays routable and highlights its parent via `views` or `aliases`,
        // so deep links, the palette and Governance gap cards still land.
        { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
        { id: 'agent-runs', label: 'Traces', icon: 'history', aliases: ['agent-activity', 'storylines', 'agent-map', 'agent-timeline'],
          tooltip: 'Every agent run as a trace: turns, tool calls, verdicts and cost',
          views: [
            { id: 'agent-runs', label: 'Runs' },
            { id: 'tool-activity', label: 'Tool Activity', aliases: ['bill-of-tools'] },
            { id: 'instant-audit', label: 'Instant Audit' },
          ] },
        { id: 'threats', label: 'Threats', icon: 'shield', aliases: ['threat-monitor'], count: 'threats',
          tooltip: 'Prompt injection, jailbreak and exfiltration attempts, plus what was blocked and which secrets were caught',
          views: [
            { id: 'threats', label: 'Detections' },
            { id: 'blocked-ledger', label: 'Blocked Actions', count: 'blocked' },
            { id: 'redactions', label: 'Secret Detections', count: 'secrets' },
          ] },
        { id: 'governance', label: 'Agent Governance', icon: 'gauge', tooltip: 'How protected this one device is right now, and the gaps to close' },
        { id: 'costs', label: 'Cost & Tokens', icon: 'costs', tooltip: 'What your agents spend on model calls, per agent, model and session' },
        { id: 'egress', label: 'Agent Egress', icon: 'proxy', count: 'egress',
          tooltip: 'Every external host your agents reached, first seen and how often' },
        { id: 'policies', label: 'Policies', icon: 'lock', aliases: ['policies-controls'],
          tooltip: 'Everything that decides what an agent may do: tool permissions, rules, egress, budgets, MCP',
          views: [
            { id: 'policies', label: 'Overview' },
            { id: 'tool-permissions', label: 'Tool Permissions' },
            { id: 'rules', label: 'Rules' },
            { id: 'egress-policy', label: 'Egress Policy' },
            { id: 'cost-settings', label: 'Cost Settings' },
            { id: 'mcp-policies', label: 'MCP Policies', cloud: true },
            { id: 'skill-scanner', label: 'Skills Scanner' },
          ] },
        { id: 'guide-connect-agents', label: 'Connect Agents', icon: 'plug', aliases: ['integrations', 'proxy-claude-code', 'proxy-codex', 'proxy-copilot-cli', 'proxy-cursor', 'proxy-opencode', 'proxy-openclaw', 'proxy-python', 'proxy-langchain', 'proxy-langgraph', 'proxy-crewai', 'proxy-hermes', 'proxy-n8n', 'proxy-ollama'],
          tooltip: 'Connect any agent: Python @guard, framework SDKs, coding-agent plugins, proxies' },
        { id: 'siem-export', label: 'Cloud & Forwarders', icon: 'rocket',
          tooltip: 'SIEM forwarding and Cloud Connect activity',
          views: [
            { id: 'siem-export', label: 'SIEM Forwarder' },
            { id: 'cloud-activity', label: 'Cloud Activity', cloud: true },
          ] },
        { id: 'guide', label: 'Guide', icon: 'book', aliases: ['guide-claude-code', 'guide-codex', 'guide-copilot-cli', 'guide-cursor', 'guide-opencode', 'guide-openclaw', 'guide-frameworks', 'gs-read-map', 'gs-read-runs', 'gs-tool-inventory', 'gs-secret-detections', 'gs-mcp-policies', 'gs-siem-forwarder', 'gs-skill-scanner', 'gs-api', 'gs-troubleshoot'],
          tooltip: 'Setup guides, how to read the data, API reference, troubleshooting' },
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
        const savedCollapsed = localStorage.getItem('sidebar-collapsed');
        // Icon rail by default on narrower windows; the user's choice wins once made.
        this.collapsed = savedCollapsed !== null ? savedCollapsed === 'true' : window.innerWidth < 1280;
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

        // App version badge, read from the running server rather than typed
        // here. A literal needing a manual bump every release is how the app
        // shipped 5.1.0 while announcing 5.0.0 elsewhere; /health already
        // reports the real version, so ask it. The major-only string stays as
        // the pre-fetch value so the chip never renders empty or shifts width
        // noticeably when the answer arrives.
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
        // Reserve the settled width so the chip does not jump from 'v5' to
        // 'v5.1.0' once /health answers.
        version.style.cssText = 'font:600 10px ui-monospace,Menlo,monospace;letter-spacing:.3px;color:var(--text-muted,#7d8590);min-width:5ch;display:inline-block;';
        brandRow.appendChild(version);
        logoTextCol.appendChild(brandRow);

        // No tagline in the rail. A marketing positioning line belongs on the
        // surfaces where someone is still deciding — login, README, docs — not
        // in authenticated chrome, where the user has already adopted the
        // product. Observability and security tools conventionally leave this
        // slot for orientation (workspace, environment, tier, version); here
        // the `v5` chip beside the wordmark already fills that role.

        logoLink.appendChild(logoTextCol);

        header.appendChild(logoLink);
        container.appendChild(header);
        container.appendChild(this._createSearchRow());
        container.appendChild(this._createPulse());

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

        // v5 IA — three verbs. "Visibility" (not "Observe") heads the first
        // section: the group now contains an "Observability" destination, and
        // "Observe → Observability" stutters. "Visibility" is the word both
        // audiences use — SOC operators ("visibility into agent activity") and
        // business buyers alike — and doesn't echo the child.
        //   Visibility — what the agents are doing (dashboard, threats, observability)
        //   Govern     — what the human controls (permissions, rules, policies)
        //   Connect    — pipes in and out (wizard, integrations, SIEM, cloud)
        // Page ids are untouched, so every old deep link still lands.
        const SECTION_BEFORE = {
            'dashboard':            'Visibility',
            'policies':             'Govern',
            'guide-connect-agents': 'Connect',
            'guide':                'Help & Settings',
        };

        const DIVIDER_BEFORE = new Set(['policies', 'guide-connect-agents', 'guide']);

        const sections = [];
        let currentSection = null;

        this.navItems.forEach(item => {

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

            // Divider
            if (DIVIDER_BEFORE.has(item.id)) {
                const divider = document.createElement('div');
                divider.className = 'nav-section-divider';
                nav.appendChild(divider);
                if (currentSection) currentSection.els.push(divider);
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
                : (item.tooltip || '');
            if (navItem.dataset.tip && !this.collapsed) navItem.title = navItem.dataset.tip;

            // Add icon (SVG) — core features get an orange badge dot overlaid
            // on the icon. (The Guardian ML sentinel robot that used to render
            // here moved to the header — Header.createGuardianControl.)
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

            if (item.count) {
                const cnt = document.createElement('span');
                cnt.className = 'nav-count';
                cnt.dataset.countFor = item.count;
                cnt.hidden = true;
                navItem.appendChild(cnt);
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
            const persistNewItems = ['rules', 'governance'];
            // Session-only NEW badges: first-view highlight that auto-dismisses
            // after 30s so the sidebar doesn't stay permanently shouty.
            const sessionNewItems = [];
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



            // Collapsible parents carry a right-edge chevron: without it a
            // collapsed row is indistinguishable from a leaf, so users never
            // learn there are sub-items. Points right when collapsed, down
            // when expanded — the same glyph + rotation grammar as the
            // section headers. Appended last so expandSection()'s
            // `svg:last-child` lookup finds it.
            let rowChev = null;
            if (item.collapsible && hasSubItems) {
                const stored = localStorage.getItem(`nav-${item.id}-expanded`);
                const startsExpanded = stored !== null ? stored === 'true' : !!item.defaultExpanded;
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
            navItem.addEventListener('click', (e) => {
                if (item.collapsible && hasSubItems) {
                    const subNav = nav.querySelector(`[data-sub-for="${item.id}"]`);
                    if (subNav) {
                        const isVisible = subNav.style.display !== 'none';
                        const willExpand = !isVisible;
                        subNav.style.display = willExpand ? 'block' : 'none';
                        if (rowChev) rowChev.style.transform = willExpand ? 'rotate(0deg)' : 'rotate(-90deg)';
                        localStorage.setItem(`nav-${item.id}-expanded`, String(willExpand));
                        if (willExpand && item.navigable && item.subItems[0]) {
                            this.navigate(item.subItems[0].id);
                        }
                    }
                    return;
                }
                this.navigate(item.id);
            });

            nav.appendChild(navItem);
            if (currentSection) {
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
                const viewsEl = this._renderViews(item, matchesSelf);
                nav.appendChild(viewsEl);
                if (currentSection) currentSection.els.push(viewsEl);
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
                    const isExpanded = stored !== null ? stored === 'true' : !!item.defaultExpanded;
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

        // Wire the Observe / Govern / Connect section toggles. Collapse hides
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
            this._jitBadgeTimer = setInterval(() => this.loadJitPendingCount(), 30000);
        }

        // Live counts on the rail: threats in the last 24 hours, egress calls
        // blocked in the last 24 hours. The rail answers "where should I look"
        // before a click; zero hides the pill so quiet is quiet.
        this.loadLiveCounts();
        this.loadPulse();
        this.loadPosture();
        if (!this._countsTimer) {
            this._countsTimer = setInterval(() => { this.loadLiveCounts(); this.loadPulse(); }, 60000);
        }
        if (!this._postureTimer) {
            this._postureTimer = setInterval(() => this.loadPosture(), 600000);
        }

        container.appendChild(nav);
        this._flyoutInit(container, nav);
        this._indicatorInit(nav);
        this._chordInit();
        // First paint: rows settle in one after another; later renders are instant.
        if (!Sidebar._revealed) {
            Sidebar._revealed = true;
            nav.classList.add('nav-reveal');
            nav.querySelectorAll('.nav-item, .nav-section-label').forEach((el, i) => el.style.setProperty('--i', String(i)));
        }

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
        codexDot.style.cssText = 'width: 6px; height: 6px; border-radius: 50%; background: #c0655e; flex-shrink: 0;';
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
        opencodeDot.style.cssText = 'width: 6px; height: 6px; border-radius: 50%; background: #d99a2b; flex-shrink: 0;';
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
        bottomSection.appendChild(this.createThemeFooter());

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
        this.checkOpenCodePluginStatus();
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

    _viewActive(view) {
        return view.id === this.currentPage || !!(view.aliases && view.aliases.includes(this.currentPage));
    },

    _renderViews(item, open) {
        const wrap = document.createElement('div');
        wrap.className = 'nav-views' + (open ? ' open' : '');
        wrap.dataset.viewsFor = item.id;
        item.views.forEach(view => {
            const row = document.createElement('div');
            row.className = 'nav-item nav-view' + (this._viewActive(view) ? ' active' : '');
            row.dataset.page = view.id;
            if (view.aliases) row.dataset.aliases = view.aliases.join(',');
            const lbl = document.createElement('span');
            lbl.textContent = view.label;
            row.appendChild(lbl);
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
            if (view.id === 'tool-permissions') {
                const jitBadge = document.createElement('span');
                jitBadge.id = 'jit-pending-badge';
                jitBadge.className = 'nav-count nav-count-warn';
                jitBadge.style.display = 'none';
                row.appendChild(jitBadge);
            }
            if (view.cloud && this._enrolled !== true) {
                const tier = document.createElement('span');
                tier.className = 'nav-view-tier';
                tier.textContent = 'Cloud';
                row.appendChild(tier);
            }
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                this.navigate(view.id);
            });
            wrap.appendChild(row);
        });
        return wrap;
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

    _flyoutInit(container, nav) {
        let fly = document.getElementById('nav-flyout');
        if (!fly) {
            fly = document.createElement('div');
            fly.id = 'nav-flyout';
            fly.className = 'nav-flyout';
            fly.hidden = true;
            document.body.appendChild(fly);
            fly.addEventListener('mouseenter', () => clearTimeout(this._flyHide));
            fly.addEventListener('mouseleave', () => this._flyoutHide());
        }
        nav.querySelectorAll('.nav-item[data-page]:not(.nav-view):not(.nav-sub-item)').forEach(row => {
            row.addEventListener('mouseenter', () => {
                if (container.classList.contains('collapsed')) this._flyoutShow(row);
            });
            row.addEventListener('mouseleave', () => this._flyoutHide());
        });
    },

    _flyoutShow(row) {
        clearTimeout(this._flyHide);
        const item = this.navItems.find(i => i.id === row.dataset.page);
        const fly = document.getElementById('nav-flyout');
        if (!item || !fly) return;
        fly.textContent = '';
        const title = document.createElement('div');
        title.className = 'nav-flyout-title';
        title.textContent = item.label;
        const cnt = row.querySelector('.nav-count');
        if (cnt && !cnt.hidden) {
            const c = document.createElement('span');
            c.className = 'nav-count';
            c.textContent = cnt.textContent;
            title.appendChild(c);
        }
        fly.appendChild(title);
        if (row.dataset.tip) {
            const d = document.createElement('div');
            d.className = 'nav-flyout-desc';
            d.textContent = row.dataset.tip;
            fly.appendChild(d);
        }
        (item.views || []).forEach(v => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'nav-flyout-view' + (this._viewActive(v) ? ' active' : '');
            b.textContent = v.label;
            b.addEventListener('click', () => { this._flyoutHide(true); this.navigate(v.id); });
            fly.appendChild(b);
        });
        const r = row.getBoundingClientRect();
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

    // ---- v5.3 rail: pulse block, sliding indicator, chord shortcuts ----

    _createPulse() {
        const box = document.createElement('div');
        box.className = 'nav-pulse';
        box.id = 'nav-pulse';

        // Live agents and posture, nothing else. Tool-call volume is throughput,
        // not security state, and it was pushing real destinations off screen.
        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'nav-pulse-main';
        main.title = 'Open Traces';
        const ring = document.createElement('span');
        ring.className = 'nav-pulse-ring';
        const dot = document.createElement('span');
        dot.className = 'nav-pulse-dot';
        ring.appendChild(dot);
        main.appendChild(ring);
        const line = document.createElement('span');
        line.className = 'nav-pulse-line';
        line.id = 'nav-pulse-line';
        line.textContent = 'Watching this device';
        main.appendChild(line);
        main.addEventListener('click', () => this.navigate('agent-runs'));
        box.appendChild(main);

        const posture = document.createElement('button');
        posture.type = 'button';
        posture.className = 'nav-posture';
        posture.id = 'nav-posture';
        posture.hidden = true;
        posture.addEventListener('click', () => this.navigate(this._postureTarget || 'governance'));
        box.appendChild(posture);
        return box;
    },

    _paintPosture(p) {
        const el = document.getElementById('nav-posture');
        if (!el || !p || !p.name) return;
        el.textContent = '';
        const dot = document.createElement('span');
        dot.className = 'nav-posture-dot';
        el.appendChild(dot);
        const lbl = document.createElement('span');
        lbl.className = 'nav-posture-name';
        el.appendChild(lbl);
        // Nothing connected yet: a band would be meaningless, so the chip
        // carries the next step instead of a grade.
        if (!p.sessions) {
            this._postureTarget = 'guide-connect-agents';
            el.dataset.band = 'none';
            lbl.textContent = 'Connect an agent to start';
            el.title = 'No agent is reporting yet, so there is nothing to assess. Opens Connect Agents.';
            el.hidden = false;
            return;
        }
        this._postureTarget = 'governance';
        // Always say whose posture this is: one device, not a fleet.
        lbl.textContent = `This device: ${p.name}`;
        el.dataset.band = p.name.toLowerCase().replace(/[^a-z]+/g, '-');
        const gaps = p.gaps ? `${p.gaps} gap${p.gaps === 1 ? '' : 's'}` : 'no gaps';
        el.title = `This device only, not your other machines. ${p.name}, ${gaps}${p.def ? `, ${p.def}` : ''}. Opens Agent Governance.`;
        el.hidden = false;
    },

    loadPosture() {
        // Paint the last known band immediately so the rail never flickers,
        // then recompute. The calculation costs several requests, so it runs
        // far less often than the counts.
        try {
            const cached = JSON.parse(localStorage.getItem('sv-nav-posture') || 'null');
            if (cached && cached.name) this._paintPosture(cached);
        } catch (_) { /* private mode */ }
        if (!window.GovernancePage || typeof GovernancePage.computePosture !== 'function') return;
        if (this._postureBusy) return;
        this._postureBusy = true;
        GovernancePage.computePosture().then(p => {
            this._postureBusy = false;
            if (!p || !p.name) return;
            this._paintPosture(p);
            try { localStorage.setItem('sv-nav-posture', JSON.stringify(p)); } catch (_) { /* private mode */ }
        }).catch(() => { this._postureBusy = false; });
    },

    loadPulse() {
        if (typeof API === 'undefined') return;
        const box = document.getElementById('nav-pulse');
        if (!box) return;
        const parse = (ts) => (ts ? Date.parse(String(ts).replace(' ', 'T')) : NaN);
        API.request('/api/traces?window_days=1&limit=100').then(r => {
            const runs = (r && r.runs) || [];
            // The window is wider than the poll interval on purpose: a run that
            // is still going must never flicker to "quiet" between two polls.
            const live = runs.filter(x => (Date.now() - parse(x.ended_at)) < 120000).length;
            const line = document.getElementById('nav-pulse-line');
            if (line) {
                line.textContent = '';
                const b = document.createElement('b');
                if (live > 0) {
                    b.textContent = live === 1 ? '1 agent live' : `${live} agents live`;
                    line.appendChild(b);
                    line.appendChild(document.createTextNode(runs.length > live ? ` · ${runs.length} today` : ''));
                } else {
                    b.textContent = 'Quiet';
                    line.appendChild(b);
                    line.appendChild(document.createTextNode(runs.length ? ` · ${runs.length} agent${runs.length === 1 ? '' : 's'} today` : ' · no agent today'));
                }
            }
            box.classList.toggle('live', live > 0);
            document.querySelectorAll('.nav-live').forEach(el => { el.hidden = live <= 0; });
        }).catch(() => {});
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
        const el = rows[rows.length - 1];
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
              k: 'skill-scanner', a: 'governance', n: 'guide-connect-agents', f: 'siem-export', u: 'guide', s: 'settings' },

    _chordInit() {
        if (this._chordBound) return;
        this._chordBound = true;
        const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
        document.addEventListener('keydown', (e) => {
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
        this._flyoutHide(true);
        setTimeout(() => this._moveIndicator(true), 260);
        container.querySelectorAll('.nav-item[data-tip]').forEach(row => {
            if (this.collapsed) row.removeAttribute('title');
            else if (row.dataset.tip) row.title = row.dataset.tip;
        });

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

        return row;
    },

    setTheme(id) {
        if (!this.THEMES.some(t => t.id === id)) return;
        if (this.currentTheme() === id) return;
        document.documentElement.setAttribute('data-theme', id);
        try { localStorage.setItem('theme', id); } catch (_) { /* private mode */ }
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
            const res = await fetch('/api/hooks/opencode/status');
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
            const delay = visible ? 10000 : 2000;
            setTimeout(() => this.checkOpenCodePluginStatus(), delay);
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
            search: [
                { tag: 'circle', attrs: { cx: '11', cy: '11', r: '7' } },
                { tag: 'path', attrs: { d: 'M21 21l-4.5-4.5' } },
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
            // Plug — "connect your agents". Mirrors the header Connect Agents
            // button glyph so the two entry points read as the same action.
            plug: [
                { tag: 'path', attrs: { d: 'M9 2v6' } },
                { tag: 'path', attrs: { d: 'M15 2v6' } },
                { tag: 'path', attrs: { d: 'M7 8h10v3a5 5 0 0 1-10 0V8z' } },
                { tag: 'path', attrs: { d: 'M12 16v6' } },
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
        this.markSeen(page);

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
        document.querySelectorAll('.nav-item').forEach(item => {
            const isSubItem = item.classList.contains('nav-sub-item') || item.classList.contains('nav-view');
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
        // Views show under their destination only while it is the active one.
        document.querySelectorAll('.nav-views').forEach(v => {
            const parent = v.previousElementSibling;
            v.classList.toggle('open', !!(parent && parent.classList.contains('active')));
        });
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

