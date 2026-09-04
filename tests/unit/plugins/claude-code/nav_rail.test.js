/**
 * Source-assertion guards for the v5.3 rail: ten destinations in three
 * groups, pages folded into `views`, a search row, live counts and the
 * icon-rail flyout. The rail is config plus a renderer, so the config is
 * what a regression would touch first.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

function navItemsSource() {
  const src = read('js/components/sidebar.js');
  const start = src.indexOf('navItems: [');
  const end = src.indexOf("currentPage: 'dashboard'", start);
  return src.slice(start, end);
}

test('the rail has nine destinations plus Guide and Settings', () => {
  const ids = [...navItemsSource().matchAll(/^\s{8}\{ id: '([a-z0-9-]+)'/gm)].map(m => m[1]);
  // Visibility is what you read, Govern is what you set: the posture report
  // moved out of Govern, and Skills Scanner folded into Policies where its
  // hub card already lived.
  assert.deepStrictEqual(ids, [
    'dashboard', 'agent-runs', 'threats', 'governance', 'costs', 'egress',
    'policies',
    'guide-connect-agents', 'siem-export',
    'guide', 'settings',
  ]);
});

test('folded pages are views of a destination, so every old page id still lands', () => {
  const nav = navItemsSource();
  for (const id of ['tool-activity', 'instant-audit', 'blocked-ledger', 'redactions',
                    'tool-permissions', 'rules', 'egress-policy', 'cost-settings', 'mcp-policies', 'cloud-activity']) {
    assert.match(nav, new RegExp(`\\{ id: '${id}', label: '[^']+'`), `${id} must be a view`);
  }
  // no page is both a destination and a stray sub-item list
  assert.doesNotMatch(nav, /subItems:/);
  // deep links to the retired group id still highlight Policies
  assert.match(nav, /id: 'policies'.*aliases: \['policies-controls'\]/);
});

test('views render under the active destination only and the flyout serves the icon rail', () => {
  const src = read('js/components/sidebar.js');
  assert.match(src, /_renderViews\(item, matchesSelf\)/);
  assert.match(src, /document\.querySelectorAll\('\.nav-views'\)\.forEach/);
  assert.match(src, /_flyoutInit\(container, nav\)/);
  assert.match(src, /if \(container\.classList\.contains\('collapsed'\)\) this\._flyoutShow\(row\);/);
  const css = read('css/styles.css');
  assert.match(css, /\.nav-views\.open \{ display: block; \}/);
  assert.match(css, /\.sidebar\.collapsed \.nav-views \{ display: none !important; \}/);
  assert.match(css, /\.nav-flyout \{ position: fixed;/);
});

test('the search row opens the palette and live counts hide at zero', () => {
  const src = read('js/components/sidebar.js');
  assert.match(src, /container\.appendChild\(this\._createSearchRow\(\)\);/);
  assert.match(src, /CommandPalette\.open\(\)/);
  assert.match(src, /count: 'threats'/);
  assert.match(src, /count: 'egress'/);
  assert.match(src, /el\.hidden = v <= 0;/);
  // counts are confirmed threats, not every scan
  assert.match(src, /API\.getThreats\(\{ page_size: 1, is_threat: true, start_date/);
  assert.match(read('js/api.js'), /queryParams\.set\('is_threat'/);
});

test('the Policies hub is routed and versioned', () => {
  const app = read('js/app.js');
  assert.match(app, /policies:\s+PoliciesHubPage,/);
  assert.match(app, /'policies-controls': PoliciesHubPage,/);
  const html = read('index.html');
  assert.match(html, /pages\/policies\.js\?v=\d+/);
  assert.match(html, /sidebar\.js\?v=133/);
  assert.match(html, /styles\.css\?v=358/);
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

test('the status block carries security state only, and names its scope', () => {
  const src = read('js/components/sidebar.js');
  // throughput telemetry was cut: it is not security state and it cost the rail
  assert.doesNotMatch(src, /nav-spark|getToolCallAuditDaily|_renderRecent|nav-recent/);
  assert.match(src, /lbl\.textContent = `This device: \$\{p\.name\}`;/);
  // nothing connected: the chip offers the next step instead of a grade
  assert.match(src, /lbl\.textContent = 'Connect an agent to start';/);
  assert.match(src, /this\._postureTarget = 'guide-connect-agents';/);
  const css = read('css/styles.css');
  assert.doesNotMatch(css, /nav-spark|nav-recent|nav-count-block/);
  assert.match(css, /\.sidebar\.collapsed \.nav-pulse-line, \.sidebar\.collapsed \.nav-posture \{ display: none; \}/);
});

test('governance credits a control only on current evidence', () => {
  const gov = read('js/pages/governance.js');
  // a harness node from 30 days ago is not evidence that anything runs now
  assert.match(gov, /const recentActivity = traceRows\.length > 0;/);
  assert.match(gov, /no agent has run in the last 7 days/);
  // an absent setting is unknown, never a pass
  assert.match(gov, /has never been configured on this device, so it cannot be reported as enforced/);
  assert.match(read('index.html'), /governance\.js\?v=23/);
});

test('the posture chip reads the governance rule set rather than its own copy', () => {
  const src = read('js/components/sidebar.js');
  assert.match(src, /GovernancePage\.computePosture\(\)/);
  // painted from cache first so the rail never flickers, recomputed rarely
  assert.match(src, /localStorage\.getItem\('sv-nav-posture'\)/);
  assert.match(src, /setInterval\(\(\) => this\.loadPosture\(\), 600000\)/);
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
  assert.match(read('index.html'), /command-palette\.js\?v=16/);
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
