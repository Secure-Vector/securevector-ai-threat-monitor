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

test('the page is routed, loaded and has its own rail entry', () => {
  assert.match(read('js/app.js'), /'detection-response': DetectionResponsePage,/);
  assert.match(read('index.html'), /js\/pages\/detection-response\.js\?v=\d+/);
  const sidebar = read('js/components/sidebar.js');
  assert.match(sidebar, /id: 'detection-response', label: 'Agent Detection & Response', icon: 'search',\s*\n\s*tooltip: '/);
  assert.doesNotMatch(sidebar, /items: \['governance', 'detection-response'\]/);
  assert.match(sidebar, /\{ id: 'detect', label: 'Detection & Response', title: 'Agent Detection & Response', icon: 'search', landing: 'detection-response',/);
  assert.match(sidebar, /items: \['detection-response'\]/);
});

test('tiles are four plain-word numbers with neutral counts', () => {
  const P = loadPage();
  P._data = { window_days: 7 };
  const html = P._tilesHtml({
    detect: { to_review: 3, baseline: { state: 'scored', ended_sessions: 9, needed: 5 } },
    harden: { available: true, changes: 2, harnesses: 1 },
    preflight: { checked: 12, avoided_denials: 1, registered: true },
  }, null);
  for (const w of ['Unusual sessions', 'Config changes to review', 'Automatic actions', 'Permission checks']) {
    assert.ok(html.includes(w), w);
  }
  assert.match(html, /Automatic actions[\s\S]*dr-tile-sub">nothing enforced \(test mode\)</);
  assert.match(html, /12 checks \u00b7 1 denied before it ran/);
  assert.doesNotMatch(html, /Detect|Harden|Respond|Pre-flight|Shadow/);
  assert.match(html, /in the last 7 days/);
  assert.doesNotMatch(html, /is-red|is-amber|is-high|is-watch/);
});

test('empty and partial states', () => {
  const P = loadPage();
  const building = P._detectTile({ to_review: 0, baseline: { state: 'building', ended_sessions: 0, needed: 5 } });
  assert.match(building, /A score appears after the first tool calls/);
  assert.doesNotMatch(building, /of 5 sessions|baseline/i);
  assert.match(building, /data-dr-launch>Launch a session</);
  assert.match(P._detectTile({ to_review: 2, baseline: { state: 'partial' } }), />2<[\s\S]*comparison still settling/);
  assert.match(P._preflightTile({ checked: 0, registered: false }), /MCP tools not registered/);
  const empty = P._listHtml({ sessions: [], detect: { last_scored_at: new Date(Date.now() - 4 * 60000).toISOString() } });
  assert.match(empty, /No sessions need review\.[\s\S]*Last scored 4 min ago\./);
});

test('a review row shows harness, folder, score, band, config mark, reason and its actions', () => {
  const P = loadPage();
  const row = P._rowHtml({ task_id: 't1', harness_label: 'Claude Code', folder: 'app', score: 82, band: 'high',
    status: 'scored', setup_state: 'changed', setup_changes: 2, setup_harness: 'claude-code',
    reason: 'Tools new here: 4 of 31 calls', ended: true, at: new Date().toISOString() }, true);
  assert.match(row, /is-focused/);
  assert.match(row, /<strong>Claude Code<\/strong><span class="dr-row-folder" title="app">app</);
  // Score column: the number in the band colour, the band word under it.
  assert.match(row, /<div class="dr-row-scorecell"><span class="dr-row-score is-high"[^>]*>82<\/span><span class="dr-band is-high">high</);
  assert.ok(row.indexOf('dr-row-scorecell') < row.indexOf('dr-row-open') && row.indexOf('dr-row-open') < row.indexOf('dr-row-when')
    && row.indexOf('dr-row-when') < row.indexOf('dr-row-actions'), 'score, session, when, actions');
  assert.match(row, /dr-setup is-amber">Agent config changed \(2\)</);
  assert.match(row, /Tools new here: 4 of 31 calls/);
  assert.ok(!/class="dr-row-open"[^>]*>(?:(?!<\/button>).)*data-dr-more/s.test(row), '+N more is not inside the open button');
  assert.match(row, /data-dr-normal="t1" title="Hide from this list and count it as normal for future scores" aria-describedby="dr-cap-t1">Looks normal<\/button><span class="dr-act-cap" id="dr-cap-t1">Hide from this list and count it as normal for future scores</);
  assert.match(row, /btn btn-sm" data-dr-approve="t1">Review config change<\/button>/);
  // One open control per row: the row title itself.
  assert.equal((row.match(/data-dr-open="t1"/g) || []).length, 1);
  assert.match(row, /<button type="button" class="dr-row-open" data-dr-open="t1" aria-label="Open the session summary for Claude Code in app">/);
  assert.doesNotMatch(row, />Open session</);
  assert.ok(row.indexOf('>Looks normal<') < row.indexOf('>Review config change<'), 'Looks normal, then Review config change');
  const running = P._rowHtml({ task_id: 't2', score: 50, band: 'watch', ended: false, setup_state: 'pinned' }, false);
  assert.doesNotMatch(running, /Looks normal|Review config change|Agent config/);
  assert.match(running, /class="dr-row-open" data-dr-open="t2"/);
  assert.match(running, /dr-band is-watch">worth a look</);
});

const P_plain = () => { const P = loadPage(); return (t, h) => P._plainReason(t, h); };

test('copy rules: full name, docs link, no em dash, no banned words', () => {
  const src = read('js/pages/detection-response.js');
  assert.ok(src.includes('https://docs.securevector.io/agent-detection-response'));
  assert.ok(!src.includes('—'), 'no em dash');
  assert.doesNotMatch(src, /\bADR\b|firewall|Mission Control|GovRun|defensive AI/i);
  assert.doesNotMatch(src, /LOOP_SEEN_KEY/);
  const loop = loadPage()._loopHtml(false);
  assert.doesNotMatch(loop, /<details class="dr-loop" open/);
  assert.match(loop, /How it works/);
  assert.doesNotMatch(src, /\b(Harden|Pre-flight|Shadow)\b/);
  const r = P_plain();
  assert.equal(r('Mod code-review changed (manifest or files).', 'Claude Code'), 'The code-review plugin changed.');
  assert.equal(r('Mod settings changed in ~/.codex/config.toml.', 'Codex'), 'Codex settings changed (~/.codex/config.toml).');
  assert.match(src, /title="Score \$\{this\._esc\(row\.score\)\} of 100\. Compared with this agent's earlier sessions in this folder\."/);
  assert.doesNotMatch(src, /Drift [Ss]core/);
});

test('Agent Sessions links to the page from the card and the Unusual activity and Agent config rows', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /const drLink = this\._drLinkHtml\(t, 'terminals-task-dr'\);/);
  assert.match(src, /row\('Unusual activity', this\._driftHtml\(s\.drift\) \+ \(typeof s\.drift\.score === 'number' \? dr : ''\)\)/);
  assert.match(src, /row\('Agent config', ConfigTrust\.summaryHtml\(s\.setup\) \+ dr\)/);
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
  assert.match(folder, /Trusts the current config: 1 MCP servers · 2 hooks · 0 rules files\./);
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

// ---- entry point on Agent Sessions: a count in the board status row ----

function loadSessions(api, summary) {
  const sandbox = {
    window: {},
    document: { getElementById: (id) => (id === 'terminals-board-summary' ? summary : null), querySelector: () => null },
    API: api || {},
    URLSearchParams,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    localStorage: { getItem: () => null, setItem() {} },
  };
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  vm.runInNewContext(read('js/pages/terminals.js'), sandbox);
  return { T: sandbox.window.TerminalsPage, sandbox };
}
const fakeSummary = () => {
  const btn = { onclick: null };
  return { hidden: true, innerHTML: '', btn,
    querySelector(sel) { return sel === '[data-board-dr]' && this.innerHTML.includes('data-board-dr') ? btn : null; } };
};
const twoTasks = [{ id: 'a', status: 'working' }, { id: 'b', status: 'working' }];

test('count 3 puts a "3 need a look" button in the status row; with no alert row it opens Review', () => {
  const el = fakeSummary();
  const { T, sandbox } = loadSessions({}, el);
  T._drData = { detect: { to_review: 3 } };
  T._renderBoardSummary(twoTasks);
  assert.match(el.innerHTML, /<button[^>]*data-board-dr[^>]*><b>3<\/b> need a look<\/button>/);
  assert.match(el.innerHTML, /terminals-board-stat terminals-board-orphans is-amber/);
  assert.match(el.innerHTML, /Shows the alert line below\./);
  let went = null;
  sandbox.window.Sidebar = { navigate: (p) => { went = p; } };
  sandbox.Sidebar = sandbox.window.Sidebar;
  el.btn.onclick({ preventDefault() {} });
  assert.equal(went, 'detection-response');
});

test('the strip has five items in plain words, zeros dimmed, no button at zero', () => {
  const el = fakeSummary();
  const { T } = loadSessions({}, el);
  T._drData = { detect: { to_review: 0 } };
  T._renderBoardSummary(twoTasks);
  for (const w of ['running', 'need you', 'need a look', 'not monitored', 'stopped by a restart']) assert.ok(el.innerHTML.includes(w), w);
  assert.doesNotMatch(el.innerHTML, /data-board-dr|data-board-adopt|<button/);
  assert.equal((el.innerHTML.match(/is-zero/g) || []).length, 4, 'every zero but running is dimmed');
  assert.doesNotMatch(el.innerHTML, /not governed|waiting on you|interrupted/);
  T._drData = null;
  T._renderBoardSummary(twoTasks);
  assert.doesNotMatch(el.innerHTML, /data-board-dr/);
});

test('a failed summary read leaves the count empty and logs nothing', async () => {
  const { T } = loadSessions({ detectionResponseSummary: async () => { throw new Error('x'); } }, fakeSummary());
  T._gen = 1;
  T._renderTaskList = () => {};
  await T._refreshDr();
  assert.equal(T._drToReview(), 0);
});

test('no chip, callout or slot markup remains on the page or in the styles', () => {
  const js = read('js/pages/terminals.js');
  const css = read('css/styles.css');
  for (const w of ['terminals-dr-slot', 'terminals-dr-chip', 'terminals-dr-callout', 'data-dr-chip', 'sv-dr-callout-dismissed', 'sv-dr-page-opened']) {
    assert.ok(!js.includes(w), w);
    assert.ok(!css.includes(w), w);
  }
});

test('the tour has one Review step with clean copy', () => {
  const src = read('js/components/tour.js');
  assert.equal((src.match(/nav: 'detection-response'/g) || []).length, 1);
  const i = src.indexOf("nav: 'detection-response'");
  const step = src.slice(i, src.indexOf('},', i));
  for (const w of ['Agent Detection & Response', 'unusual sessions', 'config changes', 'automatic actions', 'permission checks', 'how are my agents behaving']) assert.ok(step.includes(w), w);
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
  assert.match(c, /See unusual sessions and config changes from every device in one list\./);
  assert.match(c, />Preview fleet view \(30-day trial\)</);
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
  assert.match(t, /^Review stats, week \d{4}-W\d{2}\n/);
  for (const l of ['Page opens: 2', 'Sessions to review: 3', 'Reviewed: 2 of 3', 'Config approvals: 1',
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
  assert.match(written, /^Review stats/);
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
  assert.match(read('index.html'), /detection-response\.js\?v=25/);
  assert.match(read('index.html'), /styles\.css\?v=499/);
});

test('plain-language pass: Review label and heading, Launch first, one card status line', () => {
  const sidebar = read('js/components/sidebar.js');
  assert.match(sidebar, /title: 'Agent Detection & Response'/);
  assert.match(read('js/components/header.js'), /'detection-response': \{ title: 'Agent Detection & Response', subtitle: 'Watches each agent session for behaviour unlike its earlier sessions and shows you which ones to look at\.' \}/);
  const page = read('js/pages/terminals.js');
  assert.ok(page.indexOf('id="terminals-launch-btn"') < page.indexOf('id="terminals-settings-btn"'), 'Launch precedes Settings');
  assert.match(page, /btn btn-primary btn-sm terminals-launch-button/);
  assert.doesNotMatch(page, /terminals-adopt-line|not governed'/);
  const el = fakeSummary();
  const { T } = loadSessions({}, el);
  const facts = T._factsHtml({ id: 'x', tool_calls: 41, blocked_calls: 0, drift_score: 10, drift_band: 'calm', setup_state: 'changed' });
  assert.match(facts, /title="41 calls · 0 blocked · unusual activity low"/);
  assert.doesNotMatch(facts, /governed|setup|rung/);
  assert.equal(T._guardState({ governed_at_launch: false }).label, 'not monitored');
  assert.equal(T._guardState({}).label, 'checked');
});

// ---- spotlight ----

const SPOT = { task_id: 't-high', harness_label: 'Claude Code', folder: 'billing-api', score: 82, band: 'high',
  computed_at: new Date(2026, 9, 12, 14, 7).toISOString(), started_at: new Date(2026, 9, 12, 13, 0).toISOString(), ended_at: null,
  had_blocks: false, baseline: { sessions: 8, median: 11.4 },
  features: [
    { id: 'tool_novelty', signal: 'Novelty', points: 20, counts: { unseen_tools: 4, unseen_calls: 9, calls: 31 }, detail: '9 of 31 calls' },
    { id: 'errors_after_block', signal: 'Errors after a block', points: 15, counts: { errors: 6 }, detail: '6' },
    { id: 'enumeration', signal: 'Repeat calls', points: 10, counts: { loop_calls: 10 }, detail: '10 repeated calls' },
    { id: 'secrets_reach', signal: 'Credential reach', points: 8, counts: { locations: 2 }, detail: '2 locations' },
    { id: 'new_hosts', signal: 'New hosts', points: 5, counts: { hosts: 3 }, detail: '3' },
    { id: 'persistence', signal: 'Persistence', points: 3, counts: { repeats: 2 }, detail: '2' },
  ],
  recent_scores: [{ score: 10 }, { score: 12 }, { score: 9 }, { score: 82, current: true }] };

test('spotlight: headline, subline, band chip, folder name only, points and sentences', () => {
  const P = loadPage();
  const html = P._spotlightHtml({ spotlight: SPOT, sessions: [{ task_id: 't-high' }] });
  assert.match(html, /Claude Code in billing-api stopped behaving like itself\./);
  assert.match(html, /Scored at \d\d:\d\d\. Compared with/);
  assert.match(html, /Compared with 3 earlier sessions\. No rule had to fire\./);
  assert.match(html, /dr-spot-score is-high">82</);
  assert.match(html, /High \u00b7 70 and above/);
  assert.match(html, /Typical score for this folder over 3 sessions: 11\./);
  assert.match(html, /Same agent tool\. Same folder\. Same permissions\./);
  assert.match(html, />\+20<[\s\S]*Used 4 tools it had never used here before\./);
  assert.match(html, /Novelty \u00b7 9 of 31 calls/);
  assert.match(html, /Hit 6 errors right after a blocked call\./);
  assert.match(html, /Repeated the same call 10 times\./);
  assert.match(html, /Reached credential locations 2 times\./);
  assert.match(html, /Called 3 hosts new for this folder\./);
  assert.doesNotMatch(html, /Kept asking after a denial/, 'at most five rows');
  assert.doesNotMatch(html, /\/Users|\\\\/);
  assert.doesNotMatch(html, /data-dr-open|data-dr-normal/, 'actions live on the rows');
  assert.doesNotMatch(P._spotlightHtml({ spotlight: Object.assign({}, SPOT, { had_blocks: true }) }), /No rule had to fire/);
  assert.doesNotMatch(P._spotlightHtml({ spotlight: Object.assign({}, SPOT, { ended_at: SPOT.computed_at }) }), /data-dr-normal/);
});

test('spotlight: sparkline has N points and highlights the last; watch and low chips', () => {
  const P = loadPage();
  const svg = P._sparkHtml(SPOT);
  assert.equal((svg.match(/<circle/g) || []).length, 1, 'one highlighted last point');
  assert.match(svg, /3 sessions of normal/);
  assert.equal(svg.match(/<polyline class="dr-spark-base" fill="none" points="([^"]+)"/)[1].split(' ').length, 3);
  assert.match(svg, /dr-spark is-high/);
  assert.match(svg, /preserveAspectRatio="xMidYMid meet"/);
  assert.doesNotMatch(svg, /preserveAspectRatio="none"/);
  for (const marker of [0, 40, 70, 100]) assert.match(svg, new RegExp(`>${marker}<`));
  const timed = P._sparkHtml({ band: 'high', recent_scores: [{ score: 10, at: new Date().toISOString() }, { score: 20 }] });
  assert.match(timed, /Session 1 at \d\d:\d\d: score 10/);
  const two = P._sparkHtml({ band: 'watch', recent_scores: [{ score: 20 }, { score: 60, current: true, at: new Date().toISOString() }] });
  assert.match(two, /Session 1: score 20/);
  assert.match(two, /Current session: score 60/);
  assert.doesNotMatch(two, /Session 2 at/);
  assert.equal(P._sparkHtml({ recent_scores: [{ score: 5 }] }), '');
  assert.match(P.BAND_RANGE.watch, /Worth a look \u00b7 40 to 69/);
  assert.match(P.BAND_RANGE.calm, /Low \u00b7 below 40/);
});

test('spotlight: empty state; the list now includes the spotlight session', () => {
  const P = loadPage();
  const empty = P._spotlightHtml({ spotlight: null, sessions: [] });
  assert.match(empty, /No scored sessions yet\./);
  assert.match(empty, /A score appears after the first tool calls\./);
  assert.doesNotMatch(empty, /5 sessions/);
  assert.doesNotMatch(empty, /dr-spot-card/);
  // Sessions to review exist (config changes) but none is watch or high. Show
  // the highest listed score honestly while retaining the pending breakdown.
  const cfgOnly = P._spotlightHtml({ spotlight: null, detect: { to_review: 2 }, sessions: [{ task_id: 'x', score: 8, band: 'calm', setup_state: 'changed' }, { task_id: 'y', score: null, band: null, setup_state: 'changed' }], harden: { changes: 2 } });
  assert.match(cfgOnly, /2 sessions need a look\. 2 config changes to approve\./);
  assert.match(cfgOnly, /Highest listed session: <span class="dr-top-score is-calm">8<\/span>, low\./);
  assert.match(cfgOnly, /not enough same-folder history to show a trend yet/);
  assert.doesNotMatch(cfgOnly, /No scored sessions yet|trend.*up|trend.*down/i);
  const invalidSpotlight = P._spotlightHtml({ spotlight: { score: null }, sessions: [{ score: 17, band: 'calm' }] });
  assert.match(invalidSpotlight, /Highest listed session: <span class="dr-top-score is-calm">17<\/span>, low\./);
  assert.match(invalidSpotlight, /not enough same-folder history to show a trend yet/);
  const unusual = P._spotlightHtml({ spotlight: null, detect: { to_review: 2 }, sessions: [{ task_id: 'x', score: 80, band: 'high' }, { task_id: 'y', band: null }], harden: { changes: 1 } });
  assert.match(unusual, /2 sessions need a look\. 1 config change to approve\./);
  assert.match(unusual, /Highest listed session: <span class="dr-top-score is-high">80<\/span>, high\./);
  assert.doesNotMatch(cfgOnly, /dr-spot-card/);
  assert.match(P._spotlightHtml({ spotlight: null, sessions: [], detect: { to_review: 0 }, harden: { changes: 3 } }), /3 config changes to approve\./);
  const calm = P._spotlightHtml({ spotlight: Object.assign({}, SPOT, { to_review: false, band: 'calm', score: 25, features: [] }), sessions: [{ task_id: 'a', band: 'watch', score: 50 }, { task_id: 'b', band: 'high', score: 90 }], detect: { to_review: 2 }, harden: { changes: 17 } });
  assert.match(calm, /2 sessions need a look\. 17 config changes to approve\./);
  assert.match(calm, /Highest score this week: 25, low\. Claude Code in billing-api\./);
  assert.match(calm, /dr-spot-score is-calm">25</);
  assert.match(calm, /Low \u00b7 below 40/);
  assert.match(calm, /No signal stood out\./);
  assert.match(calm, /dr-spark is-calm/);
  // The fixes live on the rows, so the top session is listed too.
  assert.match(P._listHtml({ spotlight: SPOT, sessions: [{ task_id: 't-high', score: 82, band: 'high' }, { task_id: 'o', score: 50, band: 'watch' }] }), /data-dr-row="t-high"[\s\S]*data-dr-row="o"/);
  assert.doesNotMatch(P._listHtml({ spotlight: SPOT, sessions: [{ task_id: 't-high' }] }), /No other sessions need review/);
});

test('Detection & Response rail button carries an amber count from the cached summary', () => {
  const src = read('js/components/sidebar.js');
  assert.match(src, /if \(group\.id === 'detect'\) \{[\s\S]*?badge\.className = 'product-rail-attention';[\s\S]*?badge\.dataset\.drProductBadge = '1';/);
  const m = src.slice(src.indexOf('    loadDrCount() {'), src.indexOf('    _createSettingsRow() {'));
  assert.match(m, /API\.detectionResponseSummaryQuiet \|\| API\.detectionResponseSummary/);
  assert.match(m, /badge\.hidden = n <= 0;/);
  assert.match(m, /d\.detect\.to_review/);
  assert.match(src, /this\.loadLiveCounts\(\);\n\s*this\.loadDrCount\(\);/);
  assert.match(read('css/styles.css'), /\.product-rail-attention \{[^}]*color: var\(--warning\);/);
});

test('bulk approve: plain button with live count, confirm gate, UI-token approve path, result line', async () => {
  const P = loadPage();
  const html = P._configHtml({ harden: { available: true, changes: 17 } });
  assert.match(html, /<button type="button" class="btn btn-sm" data-dr-bulk>Approve all 17 config changes<\/button>/);
  assert.doesNotMatch(html, /btn-primary/);
  assert.doesNotMatch(P._configHtml({ harden: { available: true, changes: 0 } }), /data-dr-bulk/);
  const calls = [];
  const panel = { innerHTML: '', querySelector(q) { return this._n[q] || null; }, _n: {} };
  const host = { querySelector: (q) => (q === '[data-dr-bulk-panel]' ? panel : null) };
  const sandboxApi = { configTrustStatus: async () => ({ harnesses: [
    { harness: 'claude-code', label: 'Claude Code', state: 'changed', view_hash: 'h1', changes: new Array(11).fill({}) },
    { harness: 'codex', label: 'Codex', state: 'new', view_hash: 'h2', changes: [{}] },
    { harness: 'x', label: 'X', state: 'pinned', view_hash: 'h3' }] }),
    configTrustApprove: async (b) => { calls.push(b); return {}; },
    // One batch call: the person confirms the whole batch once.
    configTrustApproveAll: async (items) => { batches.push(items.length); items.forEach(b => calls.push(b)); return {}; } };
  const batches = [];
  const P2 = loadPage({ API: sandboxApi });
  const btn = { disabled: false, hidden: false };
  const yes = { disabled: false }; const no = {};
  panel._n = { '[data-dr-bulk-yes]': yes, '[data-dr-bulk-no]': no };
  await P2._askBulk(btn, host);
  assert.equal(calls.length, 0, 'nothing is approved before the confirm');
  assert.match(panel.innerHTML, /Claude Code: 11 changes/);
  assert.match(panel.innerHTML, /Codex: 1 change/);
  assert.doesNotMatch(panel.innerHTML, /X:/);
  assert.match(panel.innerHTML, /data-dr-bulk-yes[^>]*>Approve all/);
  await yes.onclick();
  assert.deepEqual(calls.map(c => c.harness), ['claude-code', 'codex']);
  assert.deepEqual(batches, [2], 'one batch call for the whole set');
  assert.ok(calls.every(c => c.target === 'setup' && c.expected));
  assert.match(panel.innerHTML, /Approved 12 config changes\./);
  assert.match(read('js/api.js'), /configTrustApprove\(body\) \{\s*return this\._terminalsWrite\('\/api\/terminals\/config-trust\/pins', body\);/);
});

test('calm spotlight subline skips "No rule had to fire"; chart and subline share one N', () => {
  const P = loadPage();
  const calm = P._spotlightHtml({ spotlight: Object.assign({}, SPOT, { to_review: false, band: 'calm', score: 20, had_blocks: false }), detect: {}, harden: {} });
  assert.doesNotMatch(calm, /No rule had to fire/);
  assert.match(calm, /Compared with 3 earlier sessions\./);
  assert.match(calm, /3 sessions of normal/);
  assert.match(P._spotlightHtml({ spotlight: SPOT }), /No rule had to fire\./);
});

test('fallback headline uses the band word; no Looks normal when not in the review list; no-rule sentence needs known zero blocks', () => {
  const P = loadPage();
  const mk = (o) => P._spotlightHtml({ spotlight: Object.assign({}, SPOT, { ended_at: SPOT.computed_at }, o), detect: {}, harden: {} });
  assert.match(mk({ to_review: false, band: 'calm', score: 20 }), /Highest score this week: 20, low\./);
  // Actions live on the rows only: the spotlight under Details has none.
  assert.doesNotMatch(mk({ to_review: false, band: 'calm' }), /data-dr-normal|data-dr-open|dr-spot-actions/);
  assert.doesNotMatch(mk({ to_review: true }), /data-dr-normal|data-dr-open|dr-spot-actions/);
  const normal = P._spotlightHtml({ spotlight: Object.assign({}, SPOT, { to_review: false, band: 'calm', score: 20 }), detect: { marked_normal: 2 }, harden: {} });
  assert.match(normal, /Highest score this week, not counting sessions marked normal: 20, low\./);
  assert.doesNotMatch(mk({ had_blocks: null }), /No rule had to fire/);
  assert.match(mk({ had_blocks: false }), /No rule had to fire/);
  assert.match(P._reasonHtml({ reason: 'A', setup_texts: ['A', 'B', 'C'] }), /<button type="button" class="dr-more" data-dr-more aria-expanded="false">, \+2 more<\/button>/);
});

test('the spotlight pending line uses the one sessions-to-review count', () => {
  const P = loadPage();
  const html = P._pendingLine({ detect: { to_review: 2 }, harden: { changes: 3 }, sessions: [{ band: 'high' }] });
  assert.equal(html, '<p class="dr-spot-pending">2 sessions need a look. 3 config changes to approve.</p>');
  assert.equal(P._pendingLine({ detect: { to_review: 1 }, harden: { changes: 0 } }), '<p class="dr-spot-pending">1 session needs a look.</p>');
  assert.equal(P._pendingLine({ detect: { to_review: 0 }, harden: { changes: 0 } }), '');
});

test('Getting started: all incomplete is the full list with two Not yet marks and the note', () => {
  const P = loadPage();
  const html = P._startHtml({ setup: { guard_installed: false, governed_session: false, scored: false, baseline: null } });
  assert.match(html, /<h3 id="dr-start-h">Getting started<\/h3><span class="dr-muted">0 of 2 done<\/span>/);
  assert.equal((html.match(/class="dr-start-row"/g) || []).length, 2);
  assert.equal((html.match(/>Not yet</g) || []).length, 2);
  assert.match(html, /Connect the Guard for your agent tool[\s\S]*data-dr-start-connect>Connect Agents</);
  assert.match(html, /Launch a session from this app[\s\S]*data-dr-start-launch>Launch</);
  assert.match(html, /Then it fills in on its own: launching from here registers the policy check tools, you are asked once to approve the agent&#39;s config, a score appears after the first tool calls and settles as more sessions finish, and automatic actions stay in test mode until you turn them on\./);
  assert.doesNotMatch(html, /dr-start-progress/);
  assert.doesNotMatch(html, /—|\bADR\b|firewall|Mission Control/);
});

test('Getting started: partial shows the baseline line once a session exists and nothing is scored', () => {
  const P = loadPage();
  const html = P._startHtml({ setup: { guard_installed: true, governed_session: true, scored: false, baseline: { sessions: 3, needed: 5, folder: 'webapp', harness_label: 'Claude Code' } } });
  assert.match(html, /2 of 2 done/);
  assert.match(html, /<p class="dr-muted dr-start-progress">3 sessions finished in webapp with Claude Code<\/p>/);
  const one = P._startHtml({ setup: { guard_installed: true, governed_session: false, scored: false, baseline: { sessions: 1, needed: 5, folder: 'w' } } });
  assert.match(one, /1 of 2 done/);
  assert.equal((one.match(/class="dr-start-row is-done"/g) || []).length, 1);
  assert.doesNotMatch(one, /dr-start-progress/, 'no baseline line before step 2 is done');
});

test('Getting started: scored collapses to one line while a step is open, and hides when all are done', () => {
  const P = loadPage();
  const open = { setup: { guard_installed: false, governed_session: true, scored: true, baseline: null } };
  assert.equal(P._startHtml(open), '<p class="dr-muted dr-start-line">Set up: 1 of 2 done · <a href="#" class="dr-link" data-dr-start-show>Show</a></p>');
  assert.match(P._startHtml(open, true), /Getting started/);
  assert.equal(P._startHtml({ setup: { guard_installed: true, governed_session: true, scored: true } }), '');
  assert.equal(P._startHtml({}), '');
  const src = read('js/pages/detection-response.js');
  assert.ok(src.indexOf('<div data-dr-start id="dr-sec-start"></div>') > 0, 'start slot present');
  assert.ok(src.indexOf('<div data-dr-start id="dr-sec-start"></div>') < src.indexOf('<div data-dr-spot id="dr-sec-why"></div>'), 'above the score card');
});


test('spotlight compare line: first session, still settling, settled', () => {
  const P = loadPage();
  assert.equal(P._compareText(0, 0), 'First session here, nothing to compare with yet');
  assert.equal(P._compareText(1, 0.2), 'Compared with 1 earlier session, comparison still settling');
  assert.equal(P._compareText(6, 1), 'Compared with 6 earlier sessions');
  const first = P._spotlightHtml({ spotlight: Object.assign({}, SPOT, { recent_scores: [{ score: 30, current: true }], baseline: { sessions: 0, median: null, confidence: 0 } }) });
  assert.match(first, /First session here, nothing to compare with yet\./);
  const settling = P._spotlightHtml({ spotlight: Object.assign({}, SPOT, { baseline: { sessions: 3, median: 11, confidence: 0.6 } }) });
  assert.match(settling, /Compared with 3 earlier sessions, comparison still settling\./);
});

// ---- simple page (2026-10-14): top, review list, one closed Details ----

test('Details is closed by default, sits below the list and holds the remaining sections in order', () => {
  const P = loadPage();
  const d = P._detailsHtml();
  assert.match(d, /^<details class="dr-loop dr-details" id="dr-sec-details">\s*<summary>Details<\/summary>/);
  assert.doesNotMatch(d.slice(0, d.indexOf('>') + 1), /\bopen\b/, 'closed by default');
  // The score card sits at the top of the page, above the list (owner, 2026-10-19).
  assert.equal(d.indexOf('id="dr-sec-why"'), -1, 'score card is not inside Details');
  // The four number cards sit under the score card (owner, 2026-10-19).
  assert.equal(d.indexOf('data-dr-tiles'), -1, 'number cards are not inside Details');
  const ids = ['dr-sec-fleet', 'dr-sec-config', 'dr-sec-how'];
  const at = ids.map(id => d.indexOf(`id="${id}"`));
  at.forEach((i, k) => assert.ok(i > 0, ids[k]));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'devices, config, how');
  assert.ok(d.lastIndexOf('</details>') === d.length - '</details>'.length, 'the three sit inside');
  const src = read('js/pages/detection-response.js');
  const tpl = src.slice(src.indexOf('container.innerHTML = `<div class="dr-wrap">'), src.indexOf('const soft = (f) =>'));
  assert.ok(tpl.indexOf('id="dr-sec-why"') < tpl.indexOf('id="dr-sec-sessions"') && tpl.indexOf('id="dr-sec-sessions"') < tpl.indexOf('this._detailsHtml()'), 'score card, list, Details');
  assert.doesNotMatch(tpl, /data-dr-config|data-dr-cloud|dr-copy-stats/, 'nothing else outside Details');
});

test('the top shows only the score, band word, one reason and the compare line', () => {
  const P = loadPage();
  const top = P._topHtml({ spotlight: SPOT });
  assert.match(top, /data-dr-top-score>82</);
  assert.match(top, /dr-band dr-top-band is-high" data-dr-top-band>high</);
  assert.match(top, /data-dr-top-reason>Used 4 tools it had never used here before\.</);
  assert.match(top, /data-dr-top-compare>Compared with 3 earlier sessions\.</);
  assert.equal((top.match(/<p\b/g) || []).length, 2, 'reason and compare only');
  assert.doesNotMatch(top, /<svg|dr-spark|dr-why|Hit 6 errors|<button|data-dr-normal|data-dr-open|sessions? need/);
  assert.match(top, /data-dr-top-label>Highest score to review</);
  assert.match(P._topHtml({ spotlight: Object.assign({}, SPOT, { to_review: false }), detect: {} }), /data-dr-top-label>Highest score this week</);
  assert.match(P._topHtml({ spotlight: Object.assign({}, SPOT, { to_review: false }), detect: { marked_normal: 1 } }), /data-dr-top-label>Highest score this week, not counting sessions marked normal</);
  const watch = P._topHtml({ spotlight: Object.assign({}, SPOT, { band: 'watch', score: 55, baseline: { sessions: 3, confidence: 0.5 } }) });
  assert.match(watch, /is-watch" data-dr-top-band>worth a look</);
  assert.match(watch, /Compared with 3 earlier sessions, comparison still settling\./);
  const first = P._topHtml({ spotlight: Object.assign({}, SPOT, { band: 'calm', score: 12, features: [], recent_scores: [], baseline: { sessions: 0, confidence: 0 } }) });
  assert.match(first, /data-dr-top-band>low</);
  assert.match(first, /No signal stood out\./);
  assert.match(first, /First session here, nothing to compare with yet\./);
  assert.match(P._topHtml({ spotlight: null }), /No score yet\. A score appears after the first tool calls\./);
  const listed = P._topHtml({ spotlight: null, sessions: [{ score: 21, band: 'calm' }, { score: 73, band: 'high' }, { score: null }] });
  assert.match(listed, /Highest listed session score/);
  assert.match(listed, /dr-top-score is-high">73</);
  assert.match(listed, /dr-top-band is-high">high</);
  assert.match(listed, /not enough same-folder history to show a trend yet/);
  assert.doesNotMatch(listed, /No score yet|trend.*up|trend.*down/i);
  assert.match(P._topHtml({ spotlight: null, sessions: [{ score: null }] }), /No score yet/);
  assert.equal(P._topHtml(null), '');
});

test('the approve panel says approval lasts until the files change again', () => {
  const src = read('js/pages/detection-response.js');
  assert.match(src, /<p class="dr-muted dr-approve-note">Approving trusts these files until they change again\.<\/p>/);
});

test('the +N reasons control is a transparent, keyboard-visible text button', () => {
  const css = read('css/styles.css');
  const moreCss = css.slice(css.indexOf('.dr-more {'), css.indexOf('.dr-more-list {'));
  assert.match(moreCss, /\.dr-more \{[^}]*background: transparent;/);
  assert.match(moreCss, /\.dr-more \{[^}]*border: 0;/);
  assert.match(moreCss, /\.dr-more \{[^}]*font: inherit;/);
  assert.match(moreCss, /\.dr-more \{[^}]*text-decoration: underline;/);
  assert.match(moreCss, /\.dr-more:focus-visible \{[^}]*outline: 2px solid var\(--accent-primary\);/);
  assert.match(loadPage()._reasonHtml({ reason: 'A', setup_texts: ['A', 'B'] }), /<button type="button" class="dr-more"[^>]*>.*\+1 more<\/button>/);
});

test('Sessions to review: a column header above the rows, and the rows share its grid', () => {
  const P = loadPage();
  const html = P._listHtml({ sessions: [{ task_id: 'a', score: 50, band: 'watch', ended: true, harness_label: 'Codex', folder: 'api' }] });
  assert.match(html, /<div class="dr-list-head" aria-hidden="true"><span>Score<\/span><span>Session<\/span><span>When<\/span><span><\/span><\/div><ul class="dr-list">/);
  const css = read('css/styles.css');
  assert.match(css, /\.dr-list-head, \.dr-row \{ display: grid; grid-template-columns: 84px minmax\(0, 1fr\) 110px 260px;/);
});

test('automatic actions tile captions: test mode says would have held, On mode says held', () => {
  const ctx = { window: { location: { search: '' } }, URLSearchParams, console };
  vm.runInNewContext(read('js/pages/detection-response.js'), ctx);
  const P = ctx.window.DetectionResponsePage;
  const test = P._respondTile({ modes: [{ mode: 'shadow' }], would_have: 3, taken: 0 });
  assert.match(test, /would have held 3 \(test mode\)/);
  assert.doesNotMatch(test, /\d+ held/);
  assert.match(P._respondTile({ modes: [{ mode: 'shadow' }], would_have: 0, taken: 0 }), /nothing enforced \(test mode\)/);
  const on = P._respondTile({ modes: [{ mode: 'shadow' }, { mode: 'active' }], would_have: 0, taken: 2 });
  assert.match(on, /2 held/);
  assert.doesNotMatch(on, /would have held/);
  assert.match(P._respondTile({ modes: [{ mode: 'active' }], would_have: 0, taken: 0 }), /dr-rung is-active/);
});

test('automatic actions tile in mixed modes shows both counts', () => {
  const ctx = { window: { location: { search: '' } }, URLSearchParams, console };
  vm.runInNewContext(read('js/pages/detection-response.js'), ctx);
  const P = ctx.window.DetectionResponsePage;
  const html = P._respondTile({ modes: [{ mode: 'shadow' }, { mode: 'active' }], would_have: 3, taken: 2 });
  assert.match(html, /2 held/);
  assert.match(html, /would have held 3 \(test mode\)/);
});

test('stop switch: one per agent tool, off by default, with the approval caption', () => {
  const P = loadPage();
  const html = P._stopHtml({ modes: [
    { harness: 'claude-code', mode: 'active', stop_high: false },
    { harness: 'codex', mode: 'shadow', stop_high: true },
  ] });
  assert.match(html, /Automatic actions/);
  assert.equal((html.match(/High: stop the session and alert/g) || []).length, 2);
  assert.equal((html.match(/Off by default\. Turning it off needs your approval\./g) || []).length, 2);
  assert.match(html, /data-dr-stop="claude-code" aria-describedby/);
  assert.match(html, /data-dr-stop="codex" checked/);
  assert.match(html, /In test mode: records what it would stop, stops nothing\./);
  assert.doesNotMatch(html.replace(/<[^>]+>/g, ' '), /\u2014|rung|drift|attack|rogue|trifecta|\bADR\b/i);
  assert.match(P._stopHtml({ modes: [] }), /start in test mode/);
});

test('session rows show Stopped or Would have stopped (test mode)', () => {
  const P = loadPage();
  const base = { task_id: 't1', harness_label: 'Claude Code', folder: 'app', score: 82, band: 'high', status: 'scored', reason: 'x', at: new Date().toISOString() };
  assert.match(P._rowHtml({ ...base, stop: 'stopped' }), /dr-stop-mark is-red">Stopped</);
  assert.match(P._rowHtml({ ...base, stop: 'would_stop' }), />Would have stopped \(test mode\)</);
  assert.match(P._rowHtml({ ...base, stop: 'outside' }), />Not stopped: started outside SecureVector</);
  assert.doesNotMatch(P._rowHtml({ ...base, stop: null }), /dr-stop-mark/);
});

test('the stop switch posts on or off through the UI-token write', () => {
  const api = read('js/api.js');
  assert.match(api, /async terminalsStopSwitch\(harness, on\) \{\n\s+return this\._terminalsUiWrite\(`\/api\/terminals\/rungs\/stop\/\$\{encodeURIComponent\(harness\)\}`, \{ on: !!on \}\);/);
  assert.match(read('js/pages/detection-response.js'), /<div data-dr-stop-host id="dr-sec-stop"><\/div>/);
});
