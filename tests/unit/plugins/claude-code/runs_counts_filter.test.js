/** Runs counts and the run-row badge filter: card scope words, cost that
 *  was never recorded, span filtering by blocked / error (path kept), the
 *  200-row cap with Show more, the waiting jump past the cap, newest-first
 *  spans; the Dashboard counts and the Detection & Response badge. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

function load() {
  const window = {};
  const sandbox = { window, console };
  vm.runInNewContext(read('js/components/trace-steps.js'), sandbox);
  vm.runInNewContext(read('js/components/run-trace.js'), Object.assign(sandbox, { TraceSteps: window.TraceSteps }));
  vm.runInNewContext(read('js/components/runs-list.js'), sandbox);
  return { RL: window.RunsList, RT: window.RunTrace, TS: window.TraceSteps };
}

const T0 = Date.parse('2026-10-24T10:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const gen = (id, s) => ({ span_kind: 'generation', span_id: id, called_at: at(s) });
const call = (id, s, extra = {}) => Object.assign({ span_kind: 'tool_call', span_id: id, tool_id: 'Bash', function_name: 'Bash', action: 'allow', called_at: at(s) }, extra);

// turn g1: a (allow), b (block); turn g2: c (error), d (allow); turn g3: e (allow)
function trace() {
  return { trace_id: 't1', session_id: 's1', spans: [
    gen('g1', 0), call('a', 1), call('b', 2, { action: 'block' }),
    gen('g2', 10), call('c', 11, { is_error: true }), call('d', 12),
    gen('g3', 20), call('e', 21),
  ] };
}
const plain = (x) => JSON.parse(JSON.stringify(x));
const keys = (rows) => Array.from(rows, r => (r.more ? `more(${r.left})` : r.node.span.span_id));

test('cards: scope words follow the range; cost never recorded is "Not recorded", a measured zero stays', () => {
  const { RL } = load();
  assert.equal(RL.windowShort('24h'), 'last 24h');
  assert.equal(RL.windowShort('7d'), 'last 7 days');
  assert.equal(RL.windowShort('1h'), 'last hour');
  assert.equal(RL.costText([{ cost: 0, generations: 0 }, {}]), 'Not recorded');
  assert.equal(RL.costText([{ cost: 0, generations: 3 }]), '$0.00');
  assert.equal(RL.costText([{ cost: 1.234, generations: 1 }, { cost: 0.5 }]), '$1.73');
  const src = read('js/components/runs-list.js');
  assert.match(src, /`\$\{blocked\} call\$\{blocked === 1 \? '' : 's'\} refused`/);
  assert.match(src, /`tool policy \+ egress · listed runs · \$\{this\.windowShort\(rangeKey\)\}`/);
  assert.doesNotMatch(read('js/pages/agent-runs.js'), /'Blocked calls'/);
});

test('span kinds keep blocked, error, waiting and recorded apart', () => {
  const { RL, RT, TS } = load();
  const tool = (span, req) => ({ kind: 'tool', key: 'k', span, req, children: [] });
  assert.deepEqual(Array.from(RL.spanKinds(tool({ action: 'block' }), RT, TS)), ['blocked']);
  assert.deepEqual(Array.from(RL.spanKinds(tool({ action: 'allow', is_error: true }), RT, TS)), ['error']);
  assert.deepEqual(Array.from(RL.spanKinds(tool({ action: 'log_only' }), RT, TS)), ['recorded']);
  assert.deepEqual(Array.from(RL.spanKinds(tool({ action: 'hold' }, { status: 'pending' }), RT, TS)), ['waiting']);
  assert.deepEqual(Array.from(RL.spanKinds(tool({ action: 'allow' }), RT, TS)), []);
  assert.deepEqual(Array.from(RL.spanKinds({ kind: 'llm', span: {} }, RT, TS)), []);
});

test('filtering by blocked keeps only the blocked call and the turn on its path', () => {
  const { RL, RT, TS } = load();
  const tree = RT.buildTree(trace());
  const f = RL.filterSpans(tree, 'blocked', RT, TS);
  assert.equal(f.matches, 1);
  const rows = RL.inlineRows(f.tree, f.open);
  assert.deepEqual(keys(rows), ['g1', 'b']);
  assert.deepEqual(plain(rows.map(r => [r.depth, r.last])), [[1, true], [2, true]]);
  assert.deepEqual(Array.from(rows[1].guides, Boolean), [false], 'the only turn is last: no guide continues past it');
  assert.equal(tree.children[0].children.length, 2, 'the source tree is not changed');
});

test('filtering by error keeps its turn; a folded parent hides its match; none matches gives no rows', () => {
  const { RL, RT, TS } = load();
  const tree = RT.buildTree(trace(), { newestFirst: true });
  const f = RL.filterSpans(tree, 'error', RT, TS);
  assert.equal(f.matches, 1);
  assert.deepEqual(keys(RL.inlineRows(f.tree, f.open)), ['g2', 'c']);
  const g2 = tree.children.find(n => n.span.span_id === 'g2').key;
  const shut = RL.filterSpans(tree, 'error', RT, TS, { [g2]: true });
  assert.deepEqual(keys(RL.inlineRows(shut.tree, shut.open)), ['g2']);
  const none = RL.filterSpans(tree, 'waiting', RT, TS);
  assert.equal(none.matches, 0);
  assert.equal(RL.inlineRows(none.tree, none.open).length, 0);
});

test('two blocked calls in two turns: guides stay correct and counts add up', () => {
  const { RL, RT, TS } = load();
  const t = trace();
  t.spans.push(call('f', 22, { action: 'block' }));
  const f = RL.filterSpans(RT.buildTree(t, { newestFirst: true }), 'blocked', RT, TS);
  assert.equal(f.matches, 2);
  const rows = RL.inlineRows(f.tree, f.open);
  assert.deepEqual(keys(rows), ['g3', 'f', 'g1', 'b']);
  assert.deepEqual(plain(rows.map(r => r.last)), [false, true, true, true]);
  assert.deepEqual(Array.from(rows[1].guides, Boolean), [true], 'g3 is not the last turn: its guide continues');
});

test('the badge toggles: same kind again clears; filters of closed runs drop', () => {
  const { RL } = load();
  assert.equal(RL.nextSpanFilter(null, 'blocked'), 'blocked');
  assert.equal(RL.nextSpanFilter('blocked', 'blocked'), null);
  assert.equal(RL.nextSpanFilter('blocked', 'error'), 'error');
  assert.equal(RL.nextSpanFilter('error', null), null);
  const f = { t1: 'blocked', t2: 'error' };
  RL.pruneSpanFilters(f, ['t2']);
  assert.deepEqual(plain(Object.keys(f)), ['t2']);
});

test('the run row wires the badge filter, Show all, and keeps the waiting jump', () => {
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /data-act="filter" data-kind="\$\{kind\}"/);
  assert.match(src, /aria-pressed="\$\{fk === kind \? 'true' : 'false'\}"/);
  assert.match(src, /fbtn\('blocked', 'rl-b rl-red'/);
  assert.match(src, /fbtn\('error', 'rl-st'/);
  assert.match(src, /btn\.dataset\.act === 'filter'\) \{ ev\.stopPropagation\(\); this\._setSpanFilter\(r\.trace_id, btn\.dataset\.kind\)/);
  assert.match(src, /btn\.dataset\.act === 'wait'\) \{ ev\.stopPropagation\(\); this\._jumpToWaiting\(\[r\.trace_id\]\)/);
  assert.match(src, />Show all<\/button>/);
  assert.match(src, /RunsList\.pruneSpanFilters\(this\._spanFilter \|\| \{\}, this\._openRuns\)/);
  assert.match(src, /if \(this\._spanFilter\) delete this\._spanFilter\[traceId\];/);
});

// ------------------------------------------------------------ the cap
function bigTree(RT, nTools, opts) {
  const spans = [gen('g', 0)];
  for (let i = 0; i < nTools; i++) spans.push(call('c' + i, 1 + i));
  return RT.buildTree({ trace_id: 'big', spans }, opts);
}

test('a turn with 450 calls shows 200, then "Show more" pages through the rest', () => {
  const { RL, RT } = load();
  const tree = bigTree(RT, 450, { newestFirst: true });
  const g = tree.children[0].key;
  const caps = {};
  let rows = RL.inlineRows(tree, { [g]: true }, caps);
  assert.equal(rows.length, 1 + 200 + 1);
  const more = rows[rows.length - 1];
  assert.equal(more.more, true);
  assert.equal(more.left, 250);
  assert.equal(more.parentKey, g);
  assert.equal(more.depth, 2);
  assert.equal(more.last, true, 'the more row takes the elbow');
  assert.equal(rows[rows.length - 2].last, false, 'the last shown call is not the last child');
  assert.equal(rows[1].node.span.span_id, 'c449', 'newest first: the cap keeps the newest 200');
  RL.inlineShowMore(caps, g);
  rows = RL.inlineRows(tree, { [g]: true }, caps);
  assert.equal(rows.length, 1 + 400 + 1);
  assert.equal(rows[rows.length - 1].left, 50);
  RL.inlineShowMore(caps, g);
  rows = RL.inlineRows(tree, { [g]: true }, caps);
  assert.equal(rows.length, 1 + 450);
  assert.equal(rows[rows.length - 1].node.span.span_id, 'c0');
  assert.equal(rows[rows.length - 1].last, true);
});

test('the top level is capped too, and a filter applies before the cap', () => {
  const { RL, RT, TS } = load();
  const spans = [];
  for (let i = 0; i < 260; i++) spans.push(call('x' + i, i, i % 100 === 7 ? { action: 'block' } : {}));
  const tree = RT.buildTree({ trace_id: 'flat', spans }, { newestFirst: true });
  const rows = RL.inlineRows(tree, {}, {});
  assert.equal(rows.length, 201);
  assert.equal(rows[200].left, 60);
  const f = RL.filterSpans(tree, 'blocked', RT, TS);
  assert.equal(f.matches, 3);
  assert.deepEqual(keys(RL.inlineRows(f.tree, f.open, {})), ['x207', 'x107', 'x7']);
});

test('the waiting jump reveals a span past the cap', () => {
  const { RL, RT } = load();
  const spans = [gen('g', 0)];
  for (let i = 0; i < 500; i++) spans.push(call('c' + i, 1 + i));
  const reqs = [{ id: 'rq', tool_id: 'Bash', function_name: 'Bash', status: 'pending', trace_id: 'big', session_id: 's', requested_at: at(0.5) }];
  // In time order the waiting call (an orphan request) is the 501st child.
  const tree = RT.buildTree({ trace_id: 'big', session_id: 's', spans }, { requests: reqs, newest: true });
  const p = RL.waitPath(tree, 'rq');
  assert.ok(p);
  const caps = {};
  const open = {};
  p.open.forEach(k => { open[k] = true; });
  assert.ok(!RL.inlineRows(tree, open, caps).some(r => r.key === p.key), 'hidden behind the cap at first');
  RL.inlineReveal(tree, p, caps);
  const rows = RL.inlineRows(tree, open, caps);
  assert.ok(rows.some(r => r.key === p.key), 'revealed');
  assert.equal(caps[p.open[0]] % RL.INLINE_CAP, 0, 'the cap grows by whole pages');
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /RL\.inlineReveal\(this\._inlineTree\(r, e\), path, e\.caps \|\| \(e\.caps = \{\}\)\);/);
});

test('a huge run refetches on a live tick at most every 30 s', () => {
  const { RL } = load();
  const now = 1e9;
  const e = { trace: {}, sig: '100|0', fetchedAt: now - 5000 };
  assert.equal(RL.inlineNeedsFetch(e, { spans: 101, waiting: 0 }, now), true, 'small runs refetch on change');
  e.sig = '5000|0';
  assert.equal(RL.inlineNeedsFetch(e, { spans: 5001, waiting: 0 }, now), false);
  assert.equal(RL.inlineNeedsFetch(e, { spans: 5001, waiting: 0 }, now + 30000), true);
  assert.equal(RL.inlineNeedsFetch(e, { spans: 5001, waiting: 0 }), true, 'no clock: unchanged behaviour');
});

test('newest first: turns and calls list the latest on top; turn numbers and exports stay in time order', () => {
  const { RT } = load();
  const tree = RT.buildTree(trace(), { newestFirst: true });
  assert.deepEqual(plain(tree.children.map(n => n.span.span_id)), ['g3', 'g2', 'g1']);
  assert.deepEqual(plain(tree.children.map(n => n.turn)), [3, 2, 1]);
  assert.deepEqual(plain(tree.children[2].children.map(n => n.span.span_id)), ['b', 'a']);
  const rows = RT.rows(tree, {});
  assert.equal(rows[rows.length - 1].node.span.span_id, 'a');
  assert.equal(rows[rows.length - 1].last, true, 'the oldest call takes the elbow');
  const chrono = RT.chrono(tree);
  assert.deepEqual(plain(chrono.children.map(n => n.span.span_id)), ['g1', 'g2', 'g3']);
  const ex = RT.exportRows({ tree, trace: trace() });
  assert.deepEqual(plain(ex.map(r => r.time)), plain(ex.map(r => r.time).slice().sort()));
  assert.match(read('js/components/run-trace.js'), /title: ctx\.title, newestFirst: true \}\);/);
  assert.match(read('js/pages/agent-runs.js'), /title: RunsList\.name\(r, this\._ctx\), newestFirst: true \}\);/);
});

// ------------------------------------------------------------ dashboard
function loadDashboard() {
  const window = {};
  const sandbox = { window, console, document: {}, localStorage: { getItem() { return null; }, setItem() {} } };
  vm.runInNewContext(read('js/api.js') + '\nwindow.API = API;', sandbox);
  vm.runInNewContext(read('js/pages/dashboard.js'), sandbox);
  return { API: window.API, D: window.DashboardPage };
}

test('dashboard: one blocked-threat rule, an honest sample label, egress blocked summed like the sidebar', () => {
  const { API, D } = loadDashboard();
  assert.equal(API.threatBlocked({ action_taken: 'blocked' }), true);
  assert.equal(API.threatBlocked({ action_taken: 'auto_block' }), true);
  assert.equal(API.threatBlocked({ action_taken: 'logged' }), false);
  assert.equal(API.threatBlocked({}), false);
  assert.equal(D.threatsBlockedLabel({ sample_size: 50, total_threats: 312 }), 'blocked in the latest 50');
  assert.equal(D.threatsBlockedLabel({ sample_size: 12, total_threats: 12 }), 'blocked');
  assert.equal(D.egressBlockedCount({ destinations: [{ blocked: 2 }, { blocked: 0 }, { blocked: '3' }] }), 5);
  assert.equal(D.egressBlockedCount(null), 0);
  const src = read('js/pages/dashboard.js');
  assert.match(src, /makeStat\('Tool calls blocked', NEUTRAL, 'blocked-ledger', `tool policy · this device · \$\{scopeWin\}`\)/);
  assert.match(src, /makeStat\('Egress blocked', NEUTRAL, 'egress', `egress policy · this device · \$\{scopeWin\}`\)/);
  assert.match(src, /API\.getEgressDestinations\(days\)/);
  assert.doesNotMatch(src, /Actions blocked/);
  assert.equal((src.match(/API\.threatBlocked\(t\)/g) || []).length, 2, 'posture sentence and hero slice share it');
  assert.match(read('js/api.js'), /blocked_count: items\.filter\(t => this\.threatBlocked\(t\)\)\.length,/);
  assert.match(src, /costData \? formatCost\(metered\) : 'Not recorded'/);
});

// ------------------------------------------------- Detection & Response badge
test('the D&R badge says its scope and takes the page summary', () => {
  const badge = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, closest() { return null; } };
  const document = { querySelectorAll: (sel) => (sel === '[data-dr-product-badge]' ? [badge] : []) };
  const window = { API: {} };
  const sandbox = { window, console, document, localStorage: { getItem() { return null; }, setItem() {} } };
  window.window = window;
  sandbox.API = window.API;
  vm.runInNewContext(read('js/components/sidebar.js'), sandbox);
  const S = window.Sidebar || sandbox.Sidebar;
  assert.ok(S, 'Sidebar loaded');
  S._paintDrSections = () => {};
  S.applyDrSummary({ window_days: 7, detect: { to_review: 3 } });
  assert.equal(badge.textContent, '3');
  assert.equal(badge.hidden, false);
  assert.equal(badge.title, '3 sessions to review · this device · last 7 days');
  assert.equal(S.drBadgeTitle(1, {}), '1 session to review · this device · last 7 days');
  assert.ok(window.API._drQuiet, 'the page summary primes the shared cache');
  S.applyDrSummary({ detect: { to_review: 0 } });
  assert.equal(badge.hidden, true);
  const dr = read('js/pages/detection-response.js');
  assert.match(dr, /this\._data = data;\n\s*this\._rungs = rungs;\n\s*this\._syncBadge\(data\);/);
  assert.match(dr, /if \(d\) \{ this\._data = d; this\._syncBadge\(d\); \}/);
  assert.match(dr, /`to review · \$\{this\._esc\(this\._scopeText\(\)\)\}`/);
  assert.match(dr, /data-dr-scope>this device · last 7 days\.<\/span>/);
});
