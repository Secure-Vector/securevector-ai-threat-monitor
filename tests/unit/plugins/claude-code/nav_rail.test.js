/** Source-assertion guards for the v6 session-first product rail. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

function navItemsSource() {
  const src = read('js/components/sidebar.js');
  const start = src.indexOf('navItems: [');
  const end = src.indexOf('productGroups: [', start);
  return src.slice(start, end);
}

function productGroupsSource() {
  const src = read('js/components/sidebar.js');
  const start = src.indexOf('productGroups: [');
  const end = src.indexOf("currentPage: 'terminals'", start);
  return src.slice(start, end);
}

test('product rail order and contextual route mappings are stable', () => {
  const groups = productGroupsSource();
  const ids = [...groups.matchAll(/^\s{8}\{ id: '([a-z0-9-]+)'/gm)].map(m => m[1]);
  assert.deepStrictEqual(ids, ['tasks', 'visibility', 'governance', 'policies', 'connect', 'more']);
  assert.match(groups, /id: 'tasks'[\s\S]*?landing: 'terminals',[\s\S]*?items: \['terminals'\]/);
  assert.match(groups, /id: 'visibility'[\s\S]*?items: \['dashboard', 'agent-runs', 'threats', 'costs', 'egress'\]/);
  assert.match(groups, /id: 'governance'[\s\S]*?items: \['governance'\]/);
  assert.match(groups, /id: 'policies'[\s\S]*?items: \['policies'\]/);
  assert.match(groups, /id: 'connect'[\s\S]*?items: \['guide-connect-agents', 'siem-export'\]/);
  assert.match(groups, /id: 'more'[\s\S]*?items: \['guide', 'settings'\]/);
  assert.match(read('js/components/sidebar.js'), /return this\.productGroups\.find\(group => group\.items\.some/);
});

test('Agent Tasks is first and root/fallback navigation is session-first', () => {
  const ids = [...navItemsSource().matchAll(/^\s{8}\{ id: '([a-z0-9-]+)'/gm)].map(m => m[1]);
  assert.equal(ids[0], 'terminals');
  // Every destination the product rail offers must resolve to a real navItems
  // entry, and every navItem must be reachable from some group. Deleting a
  // destination (say `threats`) has to fail here, instead of silently
  // degrading its deep link into the Agent Tasks context.
  const navIds = new Set(ids);
  const groupItemIds = [...productGroupsSource().matchAll(/items: \[([^\]]*)\]/g)]
    .flatMap(m => [...m[1].matchAll(/'([a-z0-9-]+)'/g)].map(x => x[1]));
  assert.equal(groupItemIds.length, 12, 'the rail must offer all twelve destinations');
  assert.equal(new Set(groupItemIds).size, groupItemIds.length, 'a destination belongs to one group only');
  for (const id of groupItemIds) {
    assert.ok(navIds.has(id), `productGroups lists '${id}', which is not a navItems destination`);
  }
  for (const id of navIds) {
    assert.ok(groupItemIds.includes(id), `navItems destination '${id}' is in no product group`);
  }
  const sidebar = read('js/components/sidebar.js');
  const app = read('js/app.js');
  assert.match(sidebar, /currentPage: 'terminals'/);
  assert.match(app, /currentPage: 'terminals'/);
  assert.match(app, /return this\.pages\[path\] \? path : 'terminals';/);
  assert.match(app, /initialPage = await this\.maybeAutoLaunchWizard\(initialPage\)/);
  assert.match(app, /if \(initialPage !== 'terminals'\) return initialPage;/);
});

test('product controls are real accessible buttons and retain the SecureVector shield', () => {
  const src = read('js/components/sidebar.js');
  assert.match(src, /home = document\.createElement\('button'\)/);
  assert.match(src, /shield\.src = '\/images\/favicon\.png'/);
  assert.match(src, /button = document\.createElement\('button'\)/);
  assert.match(src, /button\.setAttribute\('aria-label', group\.label\)/);
  assert.match(src, /button\.title = group\.label/);
  assert.doesNotMatch(src, /sv-nav-redesign|reference-logo|logo-mark/);
});

test('folded pages are views of a destination, so every old page id still lands', () => {
  const nav = navItemsSource();
  for (const id of ['tool-activity', 'instant-audit', 'blocked-ledger', 'redactions', 'cloud-activity']) {
    assert.match(nav, new RegExp(`\\{ id: '${id}', label: '[^']+'`), `${id} must be a view`);
  }
  // the policy surfaces fold under Policies as views, each with an icon, so
  // Configure is one row at rest and seven while you are inside it
  for (const id of ['tool-permissions', 'rules', 'egress-policy', 'cost-settings', 'mcp-policies', 'skill-scanner']) {
    assert.match(nav, new RegExp(`^\\s{12}\\{ id: '${id}', label: '[^']+', icon: '[a-z]+'`, 'm'), `${id} must be a view with an icon`);
  }
  const src = read('js/components/sidebar.js');
  assert.match(src, /if \(view\.icon\) row\.appendChild\(this\.createIcon\(view\.icon\)\);/);
  assert.match(read('css/styles.css'), /\.nav-item\.nav-view svg \{ width: 14px; height: 14px;/);
  // no page is both a destination and a stray sub-item list
  assert.doesNotMatch(nav, /subItems:/);
  // deep links to the retired group id still highlight Policies
  assert.match(nav, /id: 'policies'.*aliases: \['policies-controls'\]/);
});

test('single-item groups whose item is the landing hoist views instead of duplicating the label', () => {
  const src = read('js/components/sidebar.js');
  // Tasks, Governance and Policies each have exactly one item, and that item
  // is the group's own landing page. Rendering it as a normal row would show
  // the same label three times: the rail button, the context heading, and
  // this single destination row.
  const groups = productGroupsSource();
  for (const id of ['tasks', 'governance', 'policies']) {
    const m = groups.match(new RegExp(`id: '${id}'[\\s\\S]*?landing: '([a-z0-9-]+)',[\\s\\S]*?items: \\[([^\\]]*)\\]`));
    assert.ok(m, `${id} group must exist`);
    const landing = m[1];
    const items = [...m[2].matchAll(/'([a-z0-9-]+)'/g)].map(x => x[1]);
    assert.deepStrictEqual(items, [landing], `${id} must stay a single-item group whose item is its own landing`);
  }
  assert.match(src, /if \(activeGroup\.items\.length === 1 && activeGroup\.landing === item\.id\) \{/);
  assert.match(src, /viewsEl\.classList\.add\('nav-views-flat'\);/);
  // No parent row exists for the hoisted wrap, so it cannot key its open
  // state off a previous sibling the way a folded destination's views do.
  assert.match(src, /if \(v\.classList\.contains\('nav-views-flat'\)\) return;/);
  const css = read('css/styles.css');
  assert.match(css, /\.nav-views\.nav-views-flat \{ margin: 0; padding-left: 0; border-left: 0; \}/);
});

test('every Policies view stays a reachable destination once the parent row is hoisted away', () => {
  const nav = navItemsSource();
  const policiesBlock = nav.match(/\{ id: 'policies', label: 'Policies'[\s\S]*?\] \},/)[0];
  const viewIds = [...policiesBlock.matchAll(/\{ id: '([a-z0-9-]+)', label: '([^']+)'/g)]
    // the outer item itself is uniquely labelled 'Policies'; everything else
    // matched here is one of its views (the first of which reuses the
    // 'policies' id for its Overview view)
    .filter(m => m[2] !== 'Policies')
    .map(m => m[1]);
  assert.deepStrictEqual(viewIds,
    ['policies', 'tool-permissions', 'rules', 'egress-policy', 'cost-settings', 'mcp-policies', 'skill-scanner'],
    'every policy surface must still exist as a view, in order');
  // The Overview view keeps the 'policies' id itself, so deep links and
  // aliases that used to hit the parent row still resolve to the same group.
  assert.match(policiesBlock, /\{ id: 'policies', label: 'Overview'/);
  const src = read('js/components/sidebar.js');
  // Hoisting only changes where a view renders, not what clicking it does —
  // _renderViews still wires every row to navigate to its own page.
  assert.match(src, /this\.navigate\(view\.id\);/);
});

test('views render under the active destination only and the flyout serves the icon rail', () => {
  const src = read('js/components/sidebar.js');
  assert.match(src, /_renderViews\(item, matchesSelf\)/);
  assert.match(src, /document\.querySelectorAll\('\.nav-views'\)\.forEach/);
  assert.match(src, /this\._flyoutInit\(container\);/);
  // The flyout hangs off the PRODUCT RAIL. Bound to the context rows it could
  // never open, because collapsed hides the context panel outright — which is
  // also what stranded six of the twelve destinations.
  assert.match(src, /container\.querySelectorAll\('\.product-rail-button'\)\.forEach\(button => \{/);
  assert.match(src, /if \(container\.classList\.contains\('collapsed'\)\) this\._flyoutShow\(button\);/);
  assert.match(src, /if \(this\._suppressFlyoutFocus\) return;\s*\n\s*open\(\);/);
  assert.match(src, /group\.items\s*\n\s*\.map\(id => this\.navItems\.find\(item => item\.id === id\)\)/);
  assert.doesNotMatch(src, /nav\.querySelectorAll\('\.nav-item\[data-page\]/,
    'no dead flyout path may be left on the context rows');
  const css = read('css/styles.css');
  assert.match(css, /\.nav-views\.open \{ display: block; \}/);
  assert.match(css, /\.sidebar\.collapsed \.nav-views \{ display: none !important; \}/);
  assert.match(css, /\.nav-flyout \{ position: fixed;/);
});

test('the search row opens the palette and live counts hide at zero', () => {
  const src = read('js/components/sidebar.js');
  assert.match(src, /contextPanel\.appendChild\(this\._createSearchRow\(\)\);/);
  assert.match(src, /CommandPalette\.open\(\)/);
  assert.match(src, /count: 'threats'/);
  assert.match(src, /count: 'egress'/);
  assert.match(src, /el\.hidden = v <= 0;/);
  // counts are confirmed threats, not every scan
  assert.match(src, /API\.getThreats\(\{ page_size: 1, is_threat: true, start_date/);
  assert.match(read('js/api.js'), /queryParams\.set\('is_threat'/);
});

test('context rendering filters destinations and More owns Guide and Settings', () => {
  const src = read('js/components/sidebar.js');
  assert.match(src, /if \(!activeGroup\.items\.includes\(item\.id\)\) return;/);
  assert.match(src, /contextTitle\.textContent = activeGroup\.label/);
  assert.match(src, /contextSubtitle\.textContent = activeGroup\.subtitle/);
  assert.match(productGroupsSource(), /id: 'more'.*landing: 'guide',[\s\S]*?items: \['guide', 'settings'\]/);
  assert.doesNotMatch(navItemsSource(), /dock: true/);
  assert.doesNotMatch(src, /bottomSection\.appendChild\(this\._createDock\(\)\)/);
});

test('the Policies hub is routed and touched assets are versioned', () => {
  const app = read('js/app.js');
  assert.match(app, /policies:\s+PoliciesHubPage,/);
  assert.match(app, /'policies-controls': PoliciesHubPage,/);
  const html = read('index.html');
  assert.match(html, /pages\/policies\.js\?v=\d+/);
  assert.match(html, /sidebar\.js\?v=180/);
  assert.match(html, /styles\.css\?v=458/);
  assert.match(html, /app\.js\?v=71/);
  assert.match(read('js/components/command-palette.js'), /'mcp-policies', 'policies'\]/);
});

test('a loud pill always means something got through, and clears when read', () => {
  const src = read('js/components/sidebar.js');
  // the pill must never change meaning under the same colour
  assert.doesNotMatch(src, /nav-count-block|const lead = blocked/);
  assert.match(src, /Threats always means detections/);
  // detections you have not opened yet, not a fixed rolling window
  assert.match(src, /start_date: this\._seenSince\('threats'\)/);
  assert.match(src, /markSeen\(page\)/);
  // blocked actions and secrets each carry their own count
  assert.match(src, /\{ id: 'blocked-ledger', label: 'Blocked Actions', count: 'blocked' \}/);
  assert.match(src, /\{ id: 'redactions', label: 'Secret Detections', count: 'secrets' \}/);
});

test('the rail is navigation only: no pulse, posture or throughput rows', () => {
  const src = read('js/components/sidebar.js');
  // throughput telemetry was cut first (not security state); the live-agent
  // pulse and the device posture chip followed, since Traces and Agent
  // Governance already carry them and the rail read as a second dashboard
  assert.doesNotMatch(src, /nav-spark|getToolCallAuditDaily|_renderRecent|nav-recent/);
  assert.doesNotMatch(src, /_createPulse|loadPulse|loadPosture|_paintPosture|nav-pulse|nav-posture|sv-nav-posture/);
  const css = read('css/styles.css');
  assert.doesNotMatch(css, /nav-spark|nav-recent|nav-count-block|nav-pulse|nav-posture/);
  // the plugin status stack folds under a plain row, not a shouting label
  assert.match(src, /statusLabel\.textContent = 'Plugins';/);
  assert.doesNotMatch(src, /text-transform: uppercase; color: var\(--text-muted\); width: calc\(100% - 24px\)/);
});

test('governance credits a control only on current evidence', () => {
  const gov = read('js/pages/governance.js');
  // a harness node from 30 days ago is not evidence that anything runs now
  assert.match(gov, /const recentActivity = traceRows\.length > 0;/);
  assert.match(gov, /no agent has run in the last 7 days/);
  // an absent setting is unknown, never a pass
  assert.match(gov, /has never been configured on this device, so it cannot be reported as enforced/);
  assert.match(read('index.html'), /governance\.js\?v=24/);
});

test('posture is computed once, in governance, and the rail no longer reads it', () => {
  const src = read('js/components/sidebar.js');
  assert.doesNotMatch(src, /GovernancePage\.computePosture\(\)/);
  const gov = read('js/pages/governance.js');
  assert.match(gov, /async _gather\(\) \{/);
  assert.match(gov, /async computePosture\(\) \{/);
  // render() consumes the same gather, so there is one implementation
  assert.match(gov, /const \{ settings, cloud, cloudOn, traceRows, ctx, agentTxt \} = await this\._gather\(\);/);
});

test('the Guardian can still point at a folded page through its destination row', () => {
  const a = read('js/components/guardian-assistant.js');
  // views are hidden unless their destination is active, so the fallback must
  // know the new container, not just the retired sub-item one
  assert.match(a, /el\.closest\('\.nav-views, \.nav-sub-items'\)/);
});

test('picking a search result with the mouse actually navigates', () => {
  const p = read('js/components/command-palette.js');
  // Rebuilding the list on hover destroyed the row between mousedown and
  // mouseup, so the click never completed and nothing happened.
  assert.doesNotMatch(p, /mouseenter'.*_renderList\(\)/);
  assert.match(p, /row\.addEventListener\('mouseenter', \(\) => \{ this\._sel = i; this\._syncSel\(\); \}\);/);
  assert.match(p, /_syncSel\(\) \{/);
  assert.match(p, /row\.addEventListener\('mousedown'/);
  assert.match(p, /row\.addEventListener\('click', \(\) => this\._go\(item\)\);/);
  assert.match(read('index.html'), /command-palette\.js\?v=18/);
});

test('the collapse button is reachable, not buried under the resize handle', () => {
  const css = read('css/styles.css');
  const btn = css.slice(css.indexOf('.sidebar-collapse-btn {'));
  const handle = css.slice(css.indexOf('.sidebar-resize-handle {'));
  const z = (s) => Number((s.slice(0, s.indexOf('}')).match(/z-index:\s*(\d+)/) || [])[1]);
  // The handle spans the full height of the rail, so it sits over the button.
  // If it wins the stack, the icon rail and its flyout cannot be reached.
  assert.ok(z(btn) > z(handle), 'collapse button must stack above the resize handle');
});

test('the desktop chrome block makes the rail behave like a window, not a page', () => {
  const css = read('css/styles.css');
  const block = css.slice(css.indexOf('v5.3 desktop chrome: the SPA runs inside a pywebview window'));
  assert.ok(block.length > 0, 'desktop chrome block header must exist');
  // chrome regions do not highlight on drag, but content and inputs still do
  assert.match(block, /^\.sidebar,\n\.header,[\s\S]*?user-select: none;/m);
  assert.match(block, /input, textarea, select, \[contenteditable="true"\][\s\S]*?user-select: text;/);
  // arrow cursor on chrome, hand kept for real hyperlinks
  assert.match(block, /html body a\[href\] \{ cursor: pointer; \}/);
  // pointer clicks drop the ring; keyboard focus keeps it
  assert.match(block, /button:focus:not\(:focus-visible\)/);
  assert.match(css, /\[role="tab"\]:focus-visible \{/);
  // pywebview has no drag regions, so none may be declared
  assert.doesNotMatch(css, /-webkit-app-region/);
  // the pin moves with the stylesheet
  assert.match(read('index.html'), /styles\.css\?v=458/);
});

test('the plugin status observer settles on WebKit, which re-fires a style mutation for an unchanged value', () => {
  // The desktop shell is WKWebView. Setting an inline style to the value it
  // already holds queues a fresh mutation record there (Chromium drops it), so
  // an observer that rewrites a style it also watches must guard the write or
  // the callback re-enters itself forever and the app never leaves the splash.
  const js = read('js/components/sidebar.js');
  const start = js.indexOf('const updateStatusToggle = () => {');
  const end = js.indexOf('new MutationObserver(updateStatusToggle)', start);
  assert.ok(start > 0 && end > start, 'status toggle callback and observer present');
  const body = js.slice(start, end);

  let calls = 0;
  let observer = null;
  const dot = { dataset: {}, style: {} };
  Object.defineProperty(dot.style, 'background', {
    get() { return this._bg; },
    set(v) { this._bg = v; if (observer) observer(); },   // WebKit: fires even when v is unchanged
  });
  const row = { style: { display: 'flex' }, textContent: 'Claude Code plugin Active', querySelector: () => dot };
  const statusStack = { children: [row] };
  const statusToggle = { style: {} };
  const statusCount = {};
  const fn = new Function('statusStack', 'statusToggle', 'statusCount', body + '; return updateStatusToggle;')(statusStack, statusToggle, statusCount);
  observer = () => { calls++; if (calls > 50) throw new Error('observer loop'); fn(); };

  fn();
  assert.ok(calls <= 2, `observer re-entered ${calls} times`);
  assert.strictEqual(dot.style.background, 'var(--accent-primary)');
});

test('folding Policies keeps every signal reachable from outside it', () => {
  const src = read('js/components/sidebar.js');
  // pending just-in-time count lives on the product-rail button instead: the
  // `policies` navItem is always hoisted (its group's sole item — see the
  // hoist in render()), so the parent-row badge creation was dead code and
  // has been removed; the (null-safe) reader stays so nothing throws.
  assert.doesNotMatch(src, /jitBadge\.id = 'jit-pending-parent-badge';/);
  assert.match(src, /getElementById\('jit-pending-parent-badge'\)/);
  assert.match(src, /badge\.dataset\.jitProductBadge = group\.id/);
  // views keep their own badges, the cloud lock and the chord hint
  assert.match(src, /badge\.id = 'rules-count-badge';\s+row\.appendChild/);
  assert.match(src, /if \(locked\) row\.classList\.add\('nav-item-locked'\);/);
  assert.match(src, /this\.CHORDS\[k\] === view\.id/);
  // the edge indicator stays on the parent row while a view is active
  assert.match(src, /rows\.find\(r => !r\.classList\.contains\('nav-view'\)\)/);
  // the flyout shows icons and tooltips for views
  assert.match(src, /if \(v\.icon\) b\.appendChild\(this\.createIcon\(v\.icon\)\);/);
  // the palette walks views so the folded pages stay searchable, under the rail's group name
  const pal = read('js/components/command-palette.js');
  assert.match(pal, /\(item\.views \|\| \[\]\)\.forEach/);
  assert.match(pal, /'mcp-policies', 'policies'\]\.includes\(id\)\) return 'Configure';/);
  // no dead top-level branches for pages that are now views
  assert.doesNotMatch(src, /if \(item\.id === 'rules'\)/);
  assert.doesNotMatch(src, /if \(item\.id === 'tool-permissions'\)/);
  assert.doesNotMatch(src, /if \(CLOUD_TIER\.has\(item\.id\)\) \{\s+const tier/);
});

test('one JIT poll updates accessible Agent Tasks and Governance attention badges', () => {
  const src = read('js/components/sidebar.js');
  const loader = src.slice(src.indexOf('async loadJitPendingCount()'), src.indexOf('async loadRulesCount()'));
  assert.equal((loader.match(/API\.getJitRequests\('pending'\)/g) || []).length, 1,
    'the product badges must be updated by the existing approval poll');
  assert.match(src, /group\.id === 'tasks' \|\| group\.id === 'governance'/);
  assert.match(src, /badge\.dataset\.jitProductBadge = group\.id/);
  assert.match(src, /document\.querySelectorAll\('\[data-jit-product-badge\]'\)/);
  assert.match(src, /productBadge\.setAttribute\('aria-label', meaning\)/);
  assert.match(src, /productBadge\.textContent = String\(n\)/);
  assert.match(src, /productButton\.setAttribute\('aria-label', n > 0/);
  assert.match(read('css/styles.css'), /\.product-rail-attention \{[\s\S]*?color: var\(--warning\)/);
});

test('collapse hides only context on desktop and mobile restores both columns', () => {
  const src = read('js/components/sidebar.js');
  const css = read('css/styles.css');
  assert.match(src, /contextPanel\.className = 'sidebar-context'/);
  assert.match(src, /rail\.className = 'sidebar-product-rail'/);
  // The collapse control belongs to the sidebar, not to either column: the
  // outer right edge is the context panel's when that panel is up and the
  // rail's when it is not, and only `.sidebar` spans both.
  assert.match(src, /container\.appendChild\(collapseBtn\);/);
  assert.doesNotMatch(src, /productRail\.appendChild\(collapseBtn\)/);
  assert.match(css, /\.sidebar\.collapsed \.sidebar-context \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*?\.sidebar\.collapsed \.sidebar-context \{ display: flex; \}/);
  assert.match(css, /width: clamp\(300px, var\(--sidebar-width\), 440px\)/);
  assert.match(css, /\.product-rail-home,\s*\.product-rail-button \{[\s\S]*?min-height: 52px/);
  assert.match(css, /\.product-rail-button:focus-visible/);
});

test('the Policies fold has a chevron, a hover peek and a chord for every page behind it', () => {
  const src = read('js/components/sidebar.js');
  const css = read('css/styles.css');
  // chevron: down while open, right while closed, gone in the icon rail
  assert.match(src, /foldChev\.setAttribute\('class', 'nav-fold-chev'\)/);
  assert.match(src, /if \(matchesSelf\) navItem\.classList\.add\('nav-fold-open'\)/);
  assert.match(css, /\.nav-item \.nav-fold-chev \{[^}]*rotate\(-90deg\)/);
  assert.match(css, /\.nav-item\.nav-fold-open \.nav-fold-chev \{ transform: rotate\(0deg\); \}/);
  assert.match(css, /\.sidebar\.collapsed \.nav-fold-chev \{ display: none; \}/);
  // hover peek: closed fold only, expanded rail only, closes after the pointer leaves row and views
  assert.match(src, /if \(this\.collapsed \|\| viewsEl\.classList\.contains\('open'\)\) return;/);
  assert.match(src, /viewsEl\.classList\.add\('peek'\)/);
  assert.match(src, /viewsEl\.addEventListener\('mouseleave', peekOff\)/);
  assert.match(css, /\.nav-views\.peek \{ display: block; \}/);
  // chords: g then a letter reaches each folded page directly
  const chordStart = src.indexOf('CHORDS: {');
  const chords = src.slice(chordStart, src.indexOf('_chordInit() {', chordStart));
  for (const [key, page] of [['l', 'tool-permissions'], ['r', 'rules'], ['x', 'egress-policy'], ['b', 'cost-settings'], ['m', 'mcp-policies'], ['k', 'skill-scanner'], ['p', 'policies']]) {
    assert.match(chords, new RegExp(`\\b${key}: '${page}'`), `chord g ${key} -> ${page}`);
  }
  // the map must stay a function: one letter, one page
  const letters = [...chords.matchAll(/\b([a-z]): '/g)].map(m => m[1]);
  assert.equal(new Set(letters).size, letters.length);
});

// -- terminal-view.js: risky OSC handlers are disabled locally, not just
// via the xterm.js upstream default (F2) ---------------------------------

test('terminal-view.js swallows clipboard, iTerm2 file transfer, cwd and notification OSC sequences', () => {
  const src = read('js/components/terminal-view.js');
  const registerStart = src.indexOf('this._oscDisposables =');
  assert.ok(registerStart >= 0, 'this._oscDisposables assignment must exist in terminal-view.js');
  const registerEnd = src.indexOf(';', registerStart);
  assert.ok(registerEnd >= 0, 'this._oscDisposables assignment must be terminated by a semicolon');
  const registerCall = src.slice(registerStart, registerEnd + 1);
  for (const osc of [52, 1337, 7, 9]) {
    assert.match(registerCall, new RegExp(`\\b${osc}\\b`), `OSC ${osc} must be in the swallow list`);
  }
  assert.match(registerCall, /registerOscHandler\(osc, \(\) => true\)/);
  const disposeStart = src.indexOf('dispose() {');
  assert.ok(disposeStart >= 0, 'dispose() must exist in terminal-view.js');
  const disposeEnd = src.indexOf('}\n    }\n\n    window.TerminalView');
  assert.ok(disposeEnd >= 0, 'end-of-dispose sentinel not found; did the class layout change?');
  const disposeBody = src.slice(disposeStart, disposeEnd);
  assert.match(disposeBody, /\(this\._oscDisposables \|\| \[\]\)\.forEach\(\(d\) => d\.dispose\(\)\)/);
});

test('Agent Tasks keeps its full-width session rows inside the Tasks context', () => {
  const src = read('js/components/sidebar.js');
  assert.ok(src.includes('nav-views-tasks'),
    'the task views need their own class so they can take the whole rail width');
  assert.match(productGroupsSource(), /id: 'tasks'[\s\S]*?items: \['terminals'\]/,
    'the task destination belongs only to the first product group');
  assert.ok(!src.includes('allTasks'),
    'the top-level Agent Tasks row is the all-tasks destination, so the extra row is gone');
  const css = read('css/styles.css');
  assert.match(css, /\.nav-views\.nav-views-tasks \.nav-item\.nav-view\.active/,
    'an active task row must light its whole rectangle, like a top-level row');
});

test('the product-group filter keeps Agent Tasks out of Connect', () => {
  const sidebar = read('js/components/sidebar.js');
  assert.match(sidebar, /if \(!activeGroup\.items\.includes\(item\.id\)\) return;/);
  assert.match(productGroupsSource(), /id: 'connect'[\s\S]*?items: \['guide-connect-agents', 'siem-export'\]/);
  assert.doesNotMatch(productGroupsSource(), /id: 'connect'[\s\S]*?items: \[[^\]]*'terminals'/);
});

test('the rail Agent Tasks row asks for the board, not the task it left attached', () => {
  const src = read('js/components/sidebar.js');
  assert.match(src, /sessionStorage\.setItem\('sv-agent-tasks-board', '1'\)/,
    'the request has to survive the navigation, because a fresh mount restores its panes');
  assert.match(src, /if \(this\.currentPage === 'terminals' && window\.TerminalsPage\?\.showAllTasks\)/,
    'already on the page, the board is shown at once instead of waiting for a poll');
  const terminals = read('js/pages/terminals.js');
  assert.match(terminals, /sessionStorage\.getItem\('sv-agent-tasks-board'\) === '1'/,
    'the page reads the request at mount');
  assert.match(terminals, /this\._wantBoard = false;\s*\n\s*this\._clearStoredLayout\(\);/,
    'and a board request forgets the stored panes rather than reopening them');
});

test('the collapsed rail is complete, and nothing it owns is stranded, leaked or unreachable', () => {
  const src = read('js/components/sidebar.js');
  const css = read('css/styles.css');

  // Desktop opens expanded: the shell window is 1200px, so a width-derived
  // default put every fresh profile into the icon rail.
  assert.match(src, /this\.collapsed = savedCollapsed !== null \? savedCollapsed === 'true' : false;/);
  assert.doesNotMatch(src, /window\.innerWidth < 1280/);
  assert.match(src, /if \(window\.innerWidth <= 768\) this\.collapsed = false;/);

  // The controls that must outlive the context panel are moved, never cloned,
  // and both render() and the collapse toggle have to place them. They also
  // relocate when the context panel is absent for having zero rows (not just
  // when truly collapsed) — see `toRail` below.
  assert.match(src, /_syncCollapsedControls\(container\) \{/);
  assert.match(src, /const toRail = this\.collapsed \|\| container\.classList\.contains\('sidebar-context-empty'\);/);
  assert.match(src, /if \(bottom\) \(toRail \? rail : context\)\.appendChild\(bottom\);/);
  assert.equal((src.match(/this\._syncCollapsedControls\(container\);/g) || []).length, 2,
    'render() and toggleCollapse() must both place the movable controls');
  assert.match(css, /\.sidebar\.collapsed \.sidebar-product-rail \.sidebar-bottom,\n\.sidebar\.sidebar-context-empty \.sidebar-product-rail \.sidebar-bottom \{/);
  assert.match(css, /\.sidebar\.collapsed \.sidebar-product-rail \.nav-search,\n\.sidebar\.sidebar-context-empty \.sidebar-product-rail \.nav-search \{/);

  // render() is on the navigation path now, so every self-rescheduling poller
  // owns one cancellable handle: calling it twice must leave one pending tick.
  for (const [handle, method] of [
    ['_proxyStatusTimer', 'checkProxyStatus'],
    ['_siemStatusTimer', 'checkSiemStatus'],
    ['_ccPluginStatusTimer', 'checkClaudeCodePluginStatus'],
    ['_copilotPluginStatusTimer', 'checkCopilotPluginStatus'],
    ['_opencodePluginStatusTimer', 'checkOpenCodePluginStatus'],
    ['_codexPluginStatusTimer', 'checkCodexPluginStatus'],
  ]) {
    assert.match(src, new RegExp(`clearTimeout\\(this\\.${handle}\\);\\s*\\n\\s*this\\.${handle} = setTimeout\\(\\(\\) => this\\.${method}\\(\\)`),
      `${method} must cancel its pending tick before booking the next`);
  }
  assert.doesNotMatch(src, /^\s*setTimeout\(\(\) => this\.check/m,
    'an unassigned poll timer cannot be cancelled and stacks on every render');

  // A group switch rebuilds the rail, so focus and scroll have to survive it.
  assert.match(src, /priorFocus && container\.contains\(priorFocus\)/);
  assert.match(src, /const priorNavScroll = priorNav \? priorNav\.scrollTop : 0;/);
  // The offset only means something next to the group it was captured from —
  // a group switch always starts the new list at the top.
  assert.match(src, /const priorNavGroup = priorContext \? priorContext\.dataset\.productGroup : null;/);
  assert.match(src, /if \(priorNavScroll && priorNavGroup === activeGroup\.id\) nav\.scrollTop = priorNavScroll;/);
  // Programmatic focus restore must not trip the collapsed rail's
  // focus-opens-flyout handler and reopen what render() just hid.
  assert.match(src, /this\._suppressFlyoutFocus = true;\s*\n\s*refocus\.focus\(\);\s*\n\s*this\._suppressFlyoutFocus = false;/);

  // One resize listener, replaced on each render like the observers beside it.
  assert.match(src, /if \(this\._fadeResize\) window\.removeEventListener\('resize', this\._fadeResize\);/);

  // Context destination rows are divs, so they need their own keyboard path
  // before the focus ring the stylesheet defines can ever be seen.
  assert.match(src, /_makeRowFocusable\(row, activate, \{ role = 'link', expanded \} = \{\}\) \{/);
  assert.match(src, /row\.tabIndex = 0;/);
  assert.match(src, /row\.setAttribute\('role', role\);/);
  assert.match(src, /if \(e\.key !== 'Enter'\) e\.preventDefault\(\);/);
  // Collapsible parents toggle rather than navigate to a URL, so they are
  // not links. The `terminals` navItem is always hoisted (its group's sole
  // item), so its own row-level click/role branch was dead code and has
  // been removed; the hoisted views and the rail button own that behaviour.
  assert.match(src, /role: isCollapsibleRow \? 'button' : 'link',/);
  assert.doesNotMatch(src, /item\.id === 'terminals'\) \? 'button' : 'link'/);
  assert.match(src, /this\._makeRowFocusable\(row, activateView\);/);
  assert.match(css, /\.sidebar-context \.nav-item:focus-visible/);
});

test('clicking an agent row while already on the page hands it over, never reloads', () => {
  // App.loadPage has no already-on-page guard, so navigate() would re-render
  // the whole page; the layout restore then rewrote sv-agent-task-id with the
  // previously focused task and the click was lost. Going straight to the page
  // also keeps the panes and sockets that are already open.
  const src = read('js/components/sidebar.js');
  const i = src.indexOf("sessionStorage.setItem('sv-agent-task-id', view.taskId);");
  assert.ok(i > 0, 'the rail still records which task was asked for');
  const after = src.slice(i, i + 1200);
  assert.match(after, /if \(this\.currentPage === 'terminals' && window\.TerminalsPage\?\.openTask\) \{/);
  assert.match(after, /TerminalsPage\.openTask\(view\.taskId\);/);
  assert.match(after, /this\.setActive\('terminals'\);/);
  // Coming from any other page still navigates, which is what loads it.
  assert.match(after, /this\.navigate\('terminals'\);/);
});

test('the collapse control sits on the sidebar edge, icon-only, and names itself', () => {
  const js = read('js/components/sidebar.js');
  const css = read('css/styles.css');

  // No visible word in the rail. On the divider the chevron is the
  // convention, and a label there would sit half outside the rail.
  assert.doesNotMatch(js, /sidebar-collapse-label/);
  assert.doesNotMatch(js, /collapseLabel/);
  assert.doesNotMatch(css, /\.sidebar-collapse-label/);

  // Mounted on `.sidebar`, not on the rail: the rail's right border is an
  // interior seam whenever the context panel is up, so anchoring there put
  // the control inside the sidebar instead of on its outer edge.
  const build = js.slice(js.indexOf('// Collapse toggle button'));
  assert.match(build.slice(0, 1800), /container\.appendChild\(collapseBtn\);/);
  assert.doesNotMatch(js, /productRail\.appendChild\(collapseBtn\)/);

  // One place sets the chevron, the tooltip and the accessible name, and it
  // says which way the click goes rather than "Toggle".
  assert.match(js, /_syncCollapseBtn\(btn\) \{/);
  assert.match(js, /const word = this\.collapsed \? 'Expand' : 'Collapse';/);
  assert.match(js, /btn\.title = `\$\{word\} sidebar`;/);
  assert.match(js, /btn\.setAttribute\('aria-label', `\$\{word\} sidebar`\);/);
  assert.doesNotMatch(js, /aria-label', 'Toggle sidebar'/);
  // A real button, not a div with a click handler.
  assert.match(build.slice(0, 400), /collapseBtn\.type = 'button';/);
  // The chevron still points the way it always did.
  assert.match(js, /path\.setAttribute\('d', this\.collapsed \? 'M9 18l6-6-6-6' : 'M15 18l-6-6 6-6'\)/);
  // Build and toggle both go through it, so the name can never drift.
  assert.match(build.slice(0, 1800), /this\._syncCollapseBtn\(collapseBtn\);/);
  const toggle = js.slice(js.indexOf('    toggleCollapse() {'), js.indexOf('    _syncCollapseBtn(btn) {'));
  assert.match(toggle, /this\._syncCollapseBtn\(container\.querySelector\('\.sidebar-collapse-btn'\)\)/);

  // Straddling the sidebar's right edge, near the top: the standard slot, and
  // the one this control held before it was moved into the rail foot.
  const btn = css.slice(css.indexOf('.sidebar-collapse-btn {'));
  const block = btn.slice(0, btn.indexOf('}'));
  assert.match(block, /position: absolute;/);
  assert.match(block, /right: -12px;/);
  // Level with the first content row, not the logo. Anchored to the header
  // height so it moves with the header rather than drifting from a literal.
  assert.match(block, /top: calc\(var\(--header-height\) \+ 7px\);/);
  assert.doesNotMatch(block, /bottom:/, 'never pinned to the foot again');
  // Visible at rest: a raised fill, the heavier of the two hairline tokens,
  // and the icon at --text-secondary rather than the muted grey it had.
  assert.match(block, /background: var\(--bg-tertiary\)/);
  assert.match(block, /border: 1px solid var\(--border-light\)/);
  assert.match(block, /color: var\(--text-secondary\)/);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}/, 'tokens only, no new colour literals');
  assert.doesNotMatch(block, /opacity: 0/, 'must not be a hover-only reveal');
  // The rail no longer redresses it as a rail row.
  assert.doesNotMatch(css, /\.sidebar-product-rail \.sidebar-collapse-btn \{/);
  // Teal stays the hover state; at rest the control is neutral.
  const hover = css.slice(css.indexOf('.sidebar-collapse-btn:hover {'));
  assert.match(hover.slice(0, hover.indexOf('}')), /background: var\(--accent-primary\)/);
  // Keyboard focus is still visible.
  const focus = css.slice(css.indexOf('.sidebar-collapse-btn:focus-visible {'));
  assert.match(focus.slice(0, focus.indexOf('}')), /outline: 2px solid var\(--accent-primary\)/);

  // Nothing is pinned to the rail foot any more, so the clearances tuned for
  // the labelled control are gone and the rail lays out on its own padding.
  assert.doesNotMatch(css, /clears the labelled collapse control/);
  assert.doesNotMatch(css, /padding: 6px 0 60px;/);
  assert.doesNotMatch(css, /padding-bottom: 56px;/);
  const groups = css.slice(css.indexOf('.product-rail-groups {'));
  assert.match(groups.slice(0, groups.indexOf('}')), /padding: 6px 0;/);
  // Still hidden in the mobile drawer, where collapse is not a mode.
  assert.match(css, /\.sidebar-resize-handle,\n    \.sidebar-collapse-btn \{ display: none; \}/);
  assert.match(read('index.html'), /sidebar\.js\?v=180/);
});

test('Cmd+B / Ctrl+B toggles the sidebar, and never while the user is typing', () => {
  const js = read('js/components/sidebar.js');

  // Only the platform's own modifier counts, so Cmd+Ctrl+B on a Mac and
  // Ctrl+Meta+B elsewhere stay somebody else's chord, as do Alt and Shift.
  const chord = js.slice(js.indexOf('    _sidebarChord(e) {'), js.indexOf('    _chordInit() {'));
  assert.ok(chord.length > 0, '_sidebarChord must exist');
  assert.match(chord, /if \(e\.altKey \|\| e\.shiftKey\) return false;/);
  assert.match(chord, /mac \? \(e\.metaKey && !e\.ctrlKey\) : \(e\.ctrlKey && !e\.metaKey\)/);
  assert.match(chord, /e\.code === 'KeyB' \|\| String\(e\.key \|\| ''\)\.toLowerCase\(\) === 'b'/);

  // Bound inside the one existing global keydown listener (the `g` chords),
  // not a second competing one.
  const init = js.slice(js.indexOf('    _chordInit() {'), js.indexOf('    toggleCollapse() {'));
  assert.equal((init.match(/document\.addEventListener\('keydown'/g) || []).length, 1);
  assert.match(init, /if \(this\._sidebarChord\(e\) && !typing\(e\.target\)\) \{/);
  assert.match(init, /e\.preventDefault\(\);\n\s*this\.toggleCollapse\(\);/);
  // A field with focus keeps the key: bold in a rich-text box and the
  // browser's own Ctrl+B stay the user's.
  assert.match(init, /const typing = \(t\) => t && \(t\.tagName === 'INPUT' \|\| t\.tagName === 'TEXTAREA' \|\| t\.tagName === 'SELECT' \|\| t\.isContentEditable\);/);
  // The chord is checked before the `g`-chord guard drops modified keys,
  // otherwise it could never fire.
  assert.ok(
    init.indexOf('this._sidebarChord(e)') < init.indexOf('if (e.metaKey || e.ctrlKey || e.altKey'),
    'the sidebar chord must be handled before the modifier-key bail-out'
  );

  // No other handler in the app owns Cmd/Ctrl+B.
  assert.doesNotMatch(read('js/components/command-palette.js'), /'b' \|\| e\.key === 'B'/);
  assert.doesNotMatch(read('js/pages/terminals.js'), /key: 'b'/);
});
