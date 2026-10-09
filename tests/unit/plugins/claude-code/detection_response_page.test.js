/**
 * Agent Detection & Response page: tile wording, the review list, the empty
 * state and the copy rules (full name, no em dash, neutral counts).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

function loadPage(extra) {
  const ctx = { window: { location: { search: '' } }, URLSearchParams, console, ...(extra || {}) };
  if (ctx.Toast) ctx.window.Toast = ctx.Toast;
  vm.runInNewContext(read('js/pages/detection-response.js'), ctx);
  return ctx.window.DetectionResponsePage;
}

test('the page is routed, loaded and on the rail beside Agent Governance', () => {
  assert.match(read('js/app.js'), /'detection-response': DetectionResponsePage,/);
  assert.match(read('index.html'), /js\/pages\/detection-response\.js\?v=\d+/);
  const sidebar = read('js/components/sidebar.js');
  assert.match(sidebar, /id: 'detection-response', label: 'Agent Detection & Response', icon: 'search',\s*\n\s*tooltip: '/);
  assert.match(sidebar, /items: \['governance', 'detection-response'\]/);
});

test('tiles read the four verbs with neutral counts', () => {
  const P = loadPage();
  P._data = { window_days: 7 };
  const html = P._tilesHtml({
    detect: { to_review: 3, baseline: { state: 'scored', ended_sessions: 9, needed: 5 } },
    harden: { available: true, changes: 2, harnesses: 1 },
    preflight: { checked: 12, avoided_denials: 1, registered: true },
  }, null);
  for (const w of ['Detect', 'Sessions to review', 'Harden', 'Setup changes', 'Respond', 'Steps taken', 'Pre-flight', 'Checks answered']) {
    assert.ok(html.includes(w), w);
  }
  assert.match(html, /Shadow<\/span><\/div>\s*<div class="dr-tile-sub">watching, nothing enforced/);
  assert.match(html, /1 denial avoided/);
  assert.match(html, /in the last 7 days/);
  assert.doesNotMatch(html, /is-red|is-amber|is-high|is-watch/);
});

test('empty and partial states', () => {
  const P = loadPage();
  const building = P._detectTile({ to_review: 0, baseline: { state: 'building', ended_sessions: 0, needed: 5 } });
  assert.match(building, /Building baseline/);
  assert.match(building, /0 of 5 sessions/);
  assert.match(building, /data-dr-launch>Launch a session</);
  assert.match(P._detectTile({ to_review: 2, baseline: { state: 'partial' } }), />2<[\s\S]*partial baseline/);
  assert.match(P._preflightTile({ checked: 0, registered: false }), /MCP tools not registered/);
  const empty = P._listHtml({ sessions: [], detect: { last_scored_at: new Date(Date.now() - 4 * 60000).toISOString() } });
  assert.match(empty, /No sessions need review\.[\s\S]*Last scored 4 min ago\./);
});

test('a review row shows harness, folder, band, setup state, reason and the two actions', () => {
  const P = loadPage();
  const row = P._rowHtml({ task_id: 't1', harness_label: 'Claude Code', folder: 'app', score: 82, band: 'high',
    status: 'scored', setup_state: 'changed', setup_changes: 2, setup_harness: 'claude-code',
    reason: 'Tools new here: 4 of 31 calls', ended: true, at: new Date().toISOString() }, true);
  assert.match(row, /is-focused/);
  assert.match(row, /<strong>Claude Code<\/strong><span class="dr-row-folder">app</);
  assert.match(row, /dr-band is-high">82, high</);
  assert.match(row, /dr-setup is-red">setup changed \(2\)</);
  assert.match(row, /Tools new here: 4 of 31 calls/);
  assert.match(row, /data-dr-normal="t1">Looks normal</);
  assert.match(row, /data-dr-approve="t1">Approve this setup</);
  const running = P._rowHtml({ task_id: 't2', score: 50, band: 'watch', ended: false, setup_state: 'pinned' }, false);
  assert.doesNotMatch(running, /Looks normal|Approve this setup/);
});

test('copy rules: full name, docs link, no em dash, no banned words', () => {
  const src = read('js/pages/detection-response.js');
  assert.ok(src.includes('https://docs.securevector.io/agent-detection-response'));
  assert.ok(!src.includes('—'), 'no em dash');
  assert.doesNotMatch(src, /\bADR\b|firewall|Mission Control|GovRun|defensive AI/i);
  assert.match(src, /localStorage\.getItem\(this\.LOOP_SEEN_KEY\)/);
  assert.match(src, /try \{ localStorage\.setItem\(this\.LOOP_SEEN_KEY, '1'\); \} catch/);
});

test('Agent Sessions links to the page from the card and the Drift and Setup rows', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /const drLink = this\._drLinkHtml\(t, 'terminals-task-dr'\);/);
  assert.match(src, /row\('Drift', this\._driftHtml\(s\.drift\) \+ \(typeof s\.drift\.score === 'number' \? dr : ''\)\)/);
  assert.match(src, /row\('Setup', ConfigTrust\.summaryHtml\(s\.setup\) \+ dr\)/);
  assert.match(read('js/api.js'), /\/api\/terminals\/detection-response\/summary/);
});

test('approve panel lists each target with all its items and its own button', () => {
  const P = loadPage();
  const items = Array.from({ length: 10 }, (_, i) => ({ severity: i % 2 ? 'amber' : 'red', text: `change ${i}` }));
  const setup = P._targetHtml({ kind: 'setup', state: 'changed', title: 'Claude Code setup', items, counts: {}, truncated: 0 }, 0);
  for (let i = 0; i < 10; i++) assert.ok(setup.includes(`change ${i}`), `item ${i}`);
  assert.match(setup, /dr-approve-list is-scroll/);
  assert.match(setup, /data-dr-confirm="0">Approve this setup</);
  const folder = P._targetHtml({ kind: 'folder', state: 'new', title: 'This folder: app', items: [],
    counts: { mcp_servers: 1, hooks: 2, rules: 0 }, truncated: 0 }, 1);
  assert.match(folder, /Pins the current setup: 1 MCP servers · 2 hooks · 0 rules files\./);
  assert.match(folder, /data-dr-confirm="1">Approve this folder</);
  const cut = P._targetHtml({ kind: 'folder', state: 'changed', title: 'This folder: app',
    items: [{ severity: 'red', text: 'x' }], counts: {}, truncated: 4 }, 2);
  assert.doesNotMatch(cut, /data-dr-confirm/);
  assert.match(cut, /4 more not shown here/);
});

test('the approve flow reads the folder from the task, not the summary', () => {
  const src = read('js/pages/detection-response.js');
  assert.match(src, /API\.terminalsTask\(row\.task_id\)/);
  assert.doesNotMatch(src, /row\.workspace/);
});

// ---- entry points on Agent Sessions: chip, one-time callout, tour step ----

function loadSessions(store, api, slot) {
  const sandbox = {
    window: {},
    document: { getElementById: (id) => (id === 'terminals-dr-slot' ? slot : null), querySelector: () => null },
    API: api || {},
    URLSearchParams,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
  };
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  vm.runInNewContext(read('js/pages/terminals.js'), sandbox);
  return sandbox.window.TerminalsPage;
}
const fakeSlot = () => ({ innerHTML: '', querySelector: () => null });

test('the chip hides at zero and reads the count otherwise', () => {
  const T = loadSessions({});
  assert.equal(T._drChipHtml(0), '');
  assert.equal(T._drChipHtml(undefined), '');
  assert.match(T._drChipHtml(1), /Detection &amp; Response: 1 session to review/);
  assert.match(T._drChipHtml(4), /Detection &amp; Response: 4 sessions to review/);
});

test('a failed or empty summary leaves the slot empty and logs nothing', async () => {
  const slot = fakeSlot();
  const T = loadSessions({}, { detectionResponseSummary: async () => { throw new Error('x'); } }, slot);
  T._gen = 1;
  await T._refreshDr();
  assert.equal(slot.innerHTML, '');
});

test('the callout shows for a scored baseline or a setup change, and never after dismissal or a visit', () => {
  const scored = { detect: { to_review: 0, baseline: { state: 'scored' } }, harden: { changes: 0 } };
  const building = { detect: { to_review: 0, baseline: { state: 'building' } }, harden: { changes: 0 } };
  const change = { detect: { to_review: 0, baseline: { state: 'building' } }, harden: { changes: 1 } };
  const store = {};
  const T = loadSessions(store);
  assert.equal(T._drCalloutDue(building), false);
  assert.equal(T._drCalloutDue(scored), true);
  assert.equal(T._drCalloutDue(change), true);
  assert.equal(T._drCalloutDue(null), false);
  store['sv-dr-callout-dismissed'] = '1';
  assert.equal(T._drCalloutDue(scored), false);
  delete store['sv-dr-callout-dismissed'];
  store['sv-dr-page-opened'] = '1';
  assert.equal(T._drCalloutDue(change), false);
  assert.match(T._drCalloutHtml(), /Your sessions now have a Drift Score\. See what Agent Detection &amp; Response found\./);
});

test('the callout survives unavailable storage', () => {
  const T = loadSessions({});
  T._drStore = T._drStore.bind(T);
  const sandboxed = loadSessions({});
  assert.doesNotThrow(() => sandboxed._drStore('set', 'k', '1'));
  const slot = fakeSlot();
  const T2 = loadSessions({}, {}, slot);
  T2._drRender({ detect: { to_review: 2, baseline: { state: 'scored' } }, harden: { changes: 0 } });
  assert.match(slot.innerHTML, /2 sessions to review/);
  assert.match(slot.innerHTML, /data-dr-callout-dismiss/);
});

test('the tour has one Agent Detection & Response step with clean copy', () => {
  const src = read('js/components/tour.js');
  assert.equal((src.match(/nav: 'detection-response'/g) || []).length, 1);
  const i = src.indexOf("nav: 'detection-response'");
  const step = src.slice(i, src.indexOf('},', i));
  for (const w of ['Detect', 'Harden', 'Respond', 'Pre-flight', 'how are my agents behaving']) assert.ok(step.includes(w), w);
  assert.doesNotMatch(step, /—|–|firewall|Mission Control|GovRun|\bADR\b/i);
});

function memStore() {
  const m = {};
  return { m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } };
}

const SCORED = { window_days: 7, detect: { to_review: 3, marked_normal: 1, flagged: 5, baseline: { state: 'scored' },
  first_task_at: '2026-10-01T10:00:00+00:00', first_scored_at: '2026-10-03T10:00:00+00:00' }, harden: { changes: 0 } };
const BUILDING = { detect: { to_review: 0, baseline: { state: 'building' } }, harden: { changes: 0 } };

test('the fleet row stays hidden before a scored session or setup change', () => {
  const P = loadPage({ localStorage: memStore() });
  assert.equal(P._fleetDue(BUILDING, null), false);
  assert.equal(P._fleetDue(null, null), false);
  assert.equal(P._fleetDue(SCORED, null), true);
  assert.equal(P._fleetDue({ detect: { baseline: { state: 'building' } }, harden: { changes: 2 } }, null), true);
});

test('Community and enrolled variants', () => {
  const P = loadPage({ localStorage: memStore() });
  const c = P._fleetHtml({ credentials_configured: false });
  assert.match(c, /Across your devices/);
  assert.match(c, /Pro shows drift, setup changes and response activity across every device you enrol\. 30-day trial\./);
  assert.match(c, />See the fleet view</);
  assert.match(c, /href="https:\/\/docs\.securevector\.io\/agent-detection-response"[^>]*>How it works</);
  assert.match(c, /data-dr-fleet-dismiss/);
  const e = P._fleetHtml({ credentials_configured: true });
  assert.match(e, />Open fleet view</);
  assert.match(e, /href="https:\/\/app\.securevector\.io"/);
  assert.doesNotMatch(e, /30-day trial|data-dr-fleet-dismiss/);
  assert.equal(P._fleetDue(SCORED, { credentials_configured: true }), true);
});

test('dismissal hides the Community row for 30 days, not the enrolled one', () => {
  const store = memStore();
  const P = loadPage({ localStorage: store });
  store.m['sv-dr-cloud-dismissed'] = String(Date.now() - 5 * 86400000);
  assert.equal(P._fleetDue(SCORED, null), false);
  assert.equal(P._fleetDue(SCORED, { credentials_configured: true }), true);
  store.m['sv-dr-cloud-dismissed'] = String(Date.now() - 31 * 86400000);
  assert.equal(P._fleetDue(SCORED, null), true);
  const btn = {};
  const slot = { innerHTML: '<x>', querySelector: (q) => (q === '[data-dr-fleet-dismiss]' ? btn : null) };
  P._bindFleet(slot);
  btn.onclick();
  assert.equal(slot.innerHTML, '');
  assert.equal(P._fleetDismissed(), true);
  assert.equal(JSON.parse(store.m['sv-dr-stats'])[P._isoWeek(new Date())].cloudDismissed, 1);
});

test('counters work without storage', () => {
  const P = loadPage();
  assert.doesNotThrow(() => P._bump('opens'));
  assert.equal(P._fleetDismissed(), false);
  assert.match(P._statsText(SCORED), /Page opens: 0/);
});

test('Copy stats is counts only: no path, folder or session id', () => {
  const P = loadPage({ localStorage: memStore() });
  ['opens', 'opens', 'normal', 'approvals', 'cloudShown', 'cloudClicked', 'register'].forEach(k => P._bump(k));
  const data = { ...SCORED, sessions: [{ task_id: 't-9f', folder: 'secret-project', session_id: 'abc-123' }] };
  const t = P._statsText(data);
  assert.match(t, /^Agent Detection & Response stats, week \d{4}-W\d{2}\n/);
  for (const l of ['Page opens: 2', 'Sessions to review: 3', 'Reviewed: 2 of 3', 'Setup approvals: 1',
    'False-flag rate (7 days): 1 of 5', 'Cloud row: shown 1, dismissed 0, clicked 1', 'Install to first scored session: 2 days']) {
    assert.ok(t.includes(l), l);
  }
  assert.doesNotMatch(t, /secret-project|t-9f|abc-123|\/Users|\\/);
  assert.doesNotMatch(t, /—|–|firewall|Mission Control|GovRun|\bADR\b/i);
});

test('Copy stats uses the clipboard and toasts, with a textarea fallback', async () => {
  const toasts = [];
  const Toast = { success: (m) => toasts.push(m), error: (m) => toasts.push('err ' + m) };
  let written = null;
  const P = loadPage({ localStorage: memStore(), Toast, navigator: { clipboard: { writeText: async (t) => { written = t; } } } });
  P._data = SCORED;
  await P._copyStats();
  assert.match(written, /^Agent Detection & Response stats/);
  assert.deepEqual(toasts, ['Stats copied']);
  const ta = { setAttribute() {}, style: {}, select() {}, remove() {} };
  let copied = false;
  const doc = { createElement: () => ta, body: { appendChild() {} }, execCommand: () => { copied = true; return true; } };
  const F = loadPage({ localStorage: memStore(), Toast, document: doc, navigator: {} });
  F._data = SCORED;
  await F._copyStats();
  assert.equal(copied, true);
  assert.match(ta.value, /Page opens/);
});

test('fleet row copy rules and cache pins', () => {
  const src = read('js/pages/detection-response.js');
  const block = src.slice(src.indexOf('_fleetHtml(cloud)'), src.indexOf('_bindFleet(slot)'));
  assert.doesNotMatch(block, /—|–|firewall|Mission Control|GovRun|\bADR\b|banner/i);
  assert.match(read('index.html'), /detection-response\.js\?v=4/);
  assert.match(read('index.html'), /styles\.css\?v=473/);
});
