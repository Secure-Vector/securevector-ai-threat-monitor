/** Observability > Runs: the list rules in js/components/runs-list.js and
 *  the list part of js/pages/agent-runs.js. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

function load(extra = {}) {
  const window = {};
  const sandbox = Object.assign({ window, console }, extra);
  vm.runInNewContext(read('js/components/runs-list.js'), sandbox);
  return window.RunsList;
}

const NOW = Date.parse('2026-10-23T14:30:00Z');
const plain = (x) => JSON.parse(JSON.stringify(x));
const at = (min) => new Date(NOW - min * 60000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

function runs() {
  return [
    { trace_id: 't1', session_id: 's1', runtime_kind: 'claude-code', started_at: at(30), ended_at: at(25), allowed: 3, waiting: 0, blocked: 0, cost: 0.1, tokens: 1000, terminal_task: { id: 'k', title: 'look up', workspace_name: 'payments-api' } },
    { trace_id: 't2', session_id: 's1', runtime_kind: 'claude-code', started_at: at(20), ended_at: at(15), allowed: 4, waiting: 0, blocked: 2, cost: 0.2, tokens: 2000, terminal_task: { id: 'k', title: 'change', workspace_name: 'payments-api' } },
    { trace_id: 't3', session_id: 's1', runtime_kind: 'claude-code', started_at: at(10), ended_at: at(1), allowed: 1, waiting: 1, blocked: 0, oldest_waiting_expires_at: at(-6), cost: 0.3, tokens: 3000 },
    { trace_id: 't4', session_id: 's2', runtime_kind: 'codex', started_at: at(12), ended_at: at(8), allowed: 9, waiting: 1, blocked: 0, oldest_waiting_expires_at: at(-20), models: ['gpt-x'] },
    { trace_id: 't5', session_id: 's3', runtime_kind: 'openclaw', started_at: at(60 * 30), ended_at: at(60 * 29), allowed: 5, waiting: 0, blocked: 0, health: { failing: 2 } },
  ];
}

test('runs group under their session, sessions in the order of their first run', () => {
  const RL = load();
  const ctx = RL.buildCtx(runs(), { now: NOW });
  const sorted = RL.sortRuns(runs(), 'started', 'desc', ctx);
  assert.deepEqual(sorted.map(r => r.trace_id), ['t3', 't4', 't2', 't1', 't5']);
  const groups = RL.groupBySession(sorted);
  assert.deepEqual(plain(groups.map(g => g.session_id)), ['s1', 's2', 's3']);
  assert.deepEqual(plain(groups[0].runs.map(r => r.trace_id)), ['t3', 't2', 't1']);
  // Run numbers count up inside each session, oldest first.
  assert.equal(RL.name(runs()[0], ctx), 'Run 1 · look up');
  assert.equal(RL.name(runs()[2], ctx), 'Run 3');
});

test('filters: status, decision, harness, project, model, range and search', () => {
  const RL = load();
  const all = runs();
  const ctx = RL.buildCtx(all, { now: NOW });
  const pick = (f) => all.filter(r => RL.inRange(r, '24h', NOW) && RL.matches(r, Object.assign(RL.emptyFilters(), f), ctx)).map(r => r.trace_id);
  assert.deepEqual(pick({}), ['t1', 't2', 't3', 't4'], 't5 is outside the last 24 hours');
  assert.deepEqual(pick({ status: 'running' }), ['t3']);
  assert.deepEqual(pick({ decision: ['waiting'] }), ['t3', 't4']);
  assert.deepEqual(pick({ decision: ['blocked'] }), ['t2']);
  assert.deepEqual(pick({ decision: ['allowed'] }), ['t1']);
  assert.deepEqual(pick({ harness: ['codex'] }), ['t4']);
  assert.deepEqual(pick({ project: ['payments-api'] }), ['t1', 't2']);
  assert.deepEqual(pick({ model: ['gpt-x'] }), ['t4']);
  assert.deepEqual(pick({ search: 'session:s2' }), ['t4']);
  assert.deepEqual(pick({ search: 'harness:claude decision:blocked' }), ['t2']);
  assert.deepEqual(pick({ search: 'project:payments change' }), ['t2']);
  const wide = all.filter(r => RL.inRange(r, '7d', NOW) && RL.matches(r, Object.assign(RL.emptyFilters(), { status: 'error' }), ctx));
  assert.deepEqual(wide.map(r => r.trace_id), ['t5']);
  assert.equal(RL.activeCount(Object.assign(RL.emptyFilters(), { status: 'ok', harness: ['codex'], search: 'x' })), 3);
  assert.equal(RL.looksLikeHash('a1b2c3d4e5'), true);
  assert.equal(RL.looksLikeHash('deploy'), false);
});

test('needs review: waiting first, oldest request first, then blocked; score 70+ counts', () => {
  const RL = load();
  const all = runs();
  const pending = { items: [
    { trace_id: 't4', requested_at: at(9) },
    { trace_id: 't3', requested_at: at(2) },
  ] };
  const live = { sessions: [{ session_id: 's3', score: 82 }] };
  const ctx = RL.buildCtx(all, { now: NOW, pending, live });
  const review = all.filter(r => RL.needsReview(r, ctx));
  assert.deepEqual(review.map(r => r.trace_id), ['t2', 't3', 't4', 't5']);
  assert.deepEqual(RL.reviewOrder(review, ctx).map(r => r.trace_id), ['t4', 't3', 't2', 't5']);
  assert.equal(RL.score(all[4], ctx), 82);
  assert.equal(RL.status(all[4], ctx), 'running', 'a live session keeps its newest run running');
});

test('coverage badge text says how much was checked', () => {
  const RL = load();
  assert.equal(RL.coverageLabel({ enforced: 'before_call', unchecked: ['a', 'b'] }), 'partial · 2 paths not checked');
  assert.equal(RL.coverageLabel({ enforced: 'before_call', unchecked: ['a'] }), 'partial · 1 path not checked');
  assert.equal(RL.coverageLabel({ enforced: 'after_call', unchecked: [] }), 'not enforced · recorded after the call');
  assert.equal(RL.coverageLabel({ enforced: 'before_call', unchecked: [] }), 'enforced before the call');
  assert.equal(RL.coverageLabel(null), 'not enforced · not checked');
  assert.equal(RL.coverageLabel({ label: 'from the server' }), 'from the server');
});

test('saved views survive storage that is missing or throws', () => {
  const RL = load();
  const mem = {};
  const ok = { getItem: (k) => mem[k] || null, setItem: (k, v) => { mem[k] = v; } };
  assert.equal(RL.saveView('Waiting', { filters: { decision: ['waiting'] }, range: '24h' }, ok), true);
  assert.deepEqual(plain(RL.loadViews(ok).map(v => v.name)), ['Waiting']);
  RL.deleteView('Waiting', ok);
  assert.deepEqual(plain(RL.loadViews(ok)), []);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(plain(RL.loadViews(broken)), []);
  assert.equal(RL.saveView('x', { filters: {} }, broken), false);
  assert.doesNotThrow(() => RL.deleteView('x', broken));
  const garbage = { getItem: () => '{not json', setItem() {} };
  assert.deepEqual(plain(RL.loadViews(garbage)), []);
  assert.equal(RL.saveView('  ', { filters: {} }, ok), false, 'a view needs a name');
});

test('paging and sparkline buckets', () => {
  const RL = load();
  const list = Array.from({ length: 120 }, (_, i) => ({ trace_id: 'r' + i }));
  const p = RL.page(list, 2, 50);
  assert.deepEqual([p.from, p.to, p.total, p.pages, p.page], [101, 120, 120, 3, 2]);
  assert.equal(RL.page(list, 9, 50).page, 2, 'a page past the end clamps');
  const b = RL.buckets(runs(), '24h', NOW, () => 1, 'count');
  assert.equal(b.length, 24);
  assert.equal(b.reduce((a, x) => a + x, 0), 4);
  assert.equal(RL.p95([1, 2, 3, 4, 100]), 100);
});

test('the runs list has no approve or deny control', () => {
  const src = read('js/pages/agent-runs.js');
  const list = src.slice(src.indexOf('    /** The runs in range after every list filter'), src.indexOf('    async selectRun(traceId, opts) {'));
  assert.ok(list.length > 5000, 'list section found');
  assert.doesNotMatch(list, /approveJit|denyJit|jit\/requests\/|>\s*(Approve|Allow once|Deny)\s*</i);
  assert.doesNotMatch(read('js/components/runs-list.js'), /approveJit|denyJit|\/approve|\/deny/);
  // Waiting badges jump to the waiting call's details for the decision.
  assert.match(list, /Open the call that expires soonest to decide\./);
});

test('the Observability row carries an amber waiting badge, hidden at zero', () => {
  const sb = read('js/components/sidebar.js');
  assert.match(sb, /if \(item\.liveWaiting\) \{[\s\S]*?wait\.className = 'nav-count nav-count-warn';[\s\S]*?wait\.hidden = true;/);
  assert.match(sb, /querySelectorAll\('\[data-live-waiting\]'\)\.forEach\(el => \{[\s\S]*?el\.hidden = n <= 0;/);
});

test('duration: a running run shows time since start, a finished one its span, and p95 skips running runs', () => {
  const RL = load();
  const running = { trace_id: 'a', session_id: 'x', started_at: at(3), ended_at: at(0.5) };
  const done = { trace_id: 'b', session_id: 'y', started_at: at(90), ended_at: at(80) };
  const instant = { trace_id: 'c', session_id: 'z', started_at: at(60), ended_at: at(60) };
  const ctx = RL.buildCtx([running, done, instant], { now: NOW });
  assert.equal(RL.status(running, ctx), 'running');
  assert.equal(RL.shownDuration(running, ctx), 3 * 60000);
  assert.equal(RL.shownDuration(done, ctx), 10 * 60000);
  assert.equal(RL.shownDuration(instant, ctx), 0);
  assert.equal(RL.shownDuration({ trace_id: 'd' }, ctx), null);
  assert.deepEqual(plain(RL.finishedDurations([running, done, instant], ctx)), [10 * 60000, 0]);
});

test('the Duration cell reads "<1s" for a zero run and a dash when unknown', () => {
  const sandbox = { window: {}, document: { getElementById: () => null }, console };
  vm.runInNewContext(read('js/pages/agent-runs.js'), sandbox);
  const P = sandbox.window.AgentRunsPage;
  assert.equal(P._fmtDur(0), '<1s');
  assert.equal(P._fmtDur(400), '<1s');
  assert.equal(P._fmtDur(null), '—');
  assert.equal(P._fmtDur(65000), '1m 05s');
  assert.match(read('js/pages/agent-runs.js'), /this\._fmtDur\(RL\.shownDuration\(r, ctx\)\)/);
  assert.match(read('js/pages/agent-runs.js'), /RL\.p95\(RL\.finishedDurations\(shown, this\._ctx\)\)/);
});

test('the Waterfall / Live feed toggle shows on the Live feed page only, not on Runs', () => {
  const src = read('js/components/obs-tabs.js');
  assert.match(src, /if \(active === 'timeline'\) \{\s*container\.appendChild\(this\._viewToggle\(active\)\);/);
  assert.doesNotMatch(src, /active === 'runs' \|\| active === 'timeline'/);
});

test('list timers and totals: minute tick, debounce cleared, one session total', () => {
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /Math\.floor\(Date\.now\(\) \/ 60000\),/);
  assert.match(src, /if \(this\._searchTimer\) \{ clearTimeout\(this\._searchTimer\); this\._searchTimer = null; \}/);
  assert.match(src, /RL\.pageSessions\(ordered, this\.pageIdx, RL\.PAGE_SIZE\)/);
  assert.match(src, /Sessions \$\{info\.from\}–\$\{info\.to\} of/);
  assert.match(src, /\$\{sessRuns\.length\} run\$\{sessRuns\.length === 1/);
});

test('grouped paging is by session: no run on two pages, exact hidden count, big sessions stay whole', () => {
  const RL = load();
  const list = [];
  // 120 sessions of 2 runs, plus one session with 70 runs.
  for (let i = 0; i < 120; i++) for (let j = 0; j < 2; j++) list.push({ trace_id: `s${i}-r${j}`, session_id: `s${i}` });
  for (let j = 0; j < 70; j++) list.splice(60, 0, { trace_id: `big-r${j}`, session_id: 'big' });
  const pages = [0, 1, 2].map(p => RL.pageSessions(list, p, 50));
  assert.deepEqual(pages.map(p => p.groups.length), [50, 50, 21]);
  assert.equal(pages[0].total, 121);
  assert.equal(pages[0].totalRuns, list.length);
  const seen = new Set();
  pages.forEach(p => p.groups.forEach(g => g.runs.forEach(r => {
    assert.ok(!seen.has(r.trace_id), `${r.trace_id} on two pages`);
    seen.add(r.trace_id);
  })));
  assert.equal(seen.size, list.length);
  const big = pages.flatMap(p => p.groups).filter(g => g.key === 'big');
  assert.equal(big.length, 1, 'the big session is on one page');
  assert.equal(big[0].runs.length, 70);
  // Hidden count: matching runs minus the rows shown.
  assert.equal(RL.sessionRows(big[0], false, null).hidden, 67);
  assert.equal(RL.sessionRows(big[0], false, 'big-r10').hidden, 66, 'the open run shows and is not counted hidden');
  assert.equal(RL.sessionRows(big[0], true, null).hidden, 0);
  const two = pages[0].groups.find(g => g.runs.length === 2);
  assert.equal(RL.sessionRows(two, false, null).hidden, 0);
});

test('a finished zero-length run renders "<1s" in its row', () => {
  const el = () => ({ attrs: {}, classList: { add() {} }, dataset: {}, innerHTML: '', setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {} });
  const sandbox = { window: {}, document: { getElementById: () => null, createElement: el }, console };
  vm.runInNewContext(read('js/components/runs-list.js'), sandbox);
  sandbox.RunsList = sandbox.window.RunsList;
  vm.runInNewContext(read('js/pages/agent-runs.js'), sandbox);
  const P = sandbox.window.AgentRunsPage;
  const r = { trace_id: 'z', session_id: 'z', started_at: at(60), ended_at: at(60), allowed: 1 };
  P._ctx = sandbox.RunsList.buildCtx([r], { now: NOW });
  const row = P._runRow(r, false, false);
  assert.match(row.innerHTML, /rl-r rl-sub">&lt;1s</);
  assert.doesNotMatch(row.innerHTML, />0s</);
});
