/** Observability > Runs: runs open in place. The pure rules in
 *  js/components/runs-list.js (collapse defaults, flattening a span tree
 *  into indented rows, the open cap, stale answers) and the wiring in
 *  js/pages/agent-runs.js. */
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
  return { RL: window.RunsList, RT: window.RunTrace };
}

const plain = (x) => JSON.parse(JSON.stringify(x));
const node = (key, kids = []) => ({ key, kind: 'tool', children: kids });

function tree() {
  // run -> turn1 (a, b), turn2 (c), loose tool d
  return { key: 'run', kind: 'run', children: [
    node('turn1', [node('a'), node('b')]),
    node('turn2', [node('c')]),
    node('d'),
  ] };
}

test('sessions start collapsed; opened, or holding the open trace, they show', () => {
  const { RL } = load();
  const g = { key: 's1', runs: [{ trace_id: 't1' }, { trace_id: 't2' }] };
  assert.equal(RL.sessionClosed({}, g, null), true);
  assert.equal(RL.sessionClosed({ s1: true }, g, null), false);
  assert.equal(RL.sessionClosed({}, g, 't2'), false, 'the run whose full trace is open keeps its session shown');
  assert.equal(RL.sessionClosed({ s1: false }, g, 'other'), true);
});

test('an opened run shows only its top level: every node starts collapsed', () => {
  const { RL } = load();
  const rows = RL.inlineRows(tree(), {});
  assert.deepEqual(plain(rows.map(r => [r.key, r.depth, r.last, r.hasKids, r.expanded])), [
    ['turn1', 1, false, true, false],
    ['turn2', 1, false, true, false],
    ['d', 1, true, false, false],
  ]);
  assert.deepEqual(plain(rows.map(r => r.guides)), [[], [], []]);
});

test('expanding a turn indents its calls one level, guides and the last-child elbow', () => {
  const { RL } = load();
  const rows = RL.inlineRows(tree(), { turn1: true, turn2: true, d: true });
  assert.deepEqual(plain(rows.map(r => `${r.key}:${r.depth}:${r.last ? 'L' : '-'}:${r.guides.map(g => (g ? 1 : 0)).join('')}`)), [
    'turn1:1:-:', 'a:2:-:1', 'b:2:L:1',
    'turn2:1:-:', 'c:2:L:1',
    'd:1:L:',
  ]);
  assert.equal(rows.find(r => r.key === 'd').expanded, false, 'a leaf never reads as expanded');
  // Under the last top-level node the parent line stops.
  const t = tree();
  t.children[2].children = [node('e')];
  const r2 = RL.inlineRows(t, { d: true });
  assert.deepEqual(plain(r2.find(r => r.key === 'e').guides), [false]);
});

test('the same nesting as the trace view: turns, then the calls each turn issued', () => {
  const { RL, RT } = load();
  const trace = { trace_id: 'tr', spans: [
    { span_kind: 'generation', span_id: 'g1', model: 'm', called_at: '2026-10-23 14:00:00', input_tokens: 10, output_tokens: 5 },
    { span_kind: 'tool_call', span_id: 'x1', tool_id: 'Bash', parent_span_id: 'g1', called_at: '2026-10-23 14:00:01', action: 'allow' },
    { span_kind: 'generation', span_id: 'g2', model: 'm', called_at: '2026-10-23 14:00:05' },
  ] };
  const t = RT.buildTree(trace, {});
  const closed = RL.inlineRows(t, {});
  assert.deepEqual(plain(closed.map(r => r.node.kind)), ['llm', 'llm']);
  const open = RL.inlineRows(t, { [closed[0].key]: true });
  assert.deepEqual(plain(open.map(r => [r.node.kind, r.depth])), [['llm', 1], ['tool', 2], ['llm', 1]]);
});

test('at most 10 runs open; opening an 11th closes the oldest; a second click closes', () => {
  const { RL } = load();
  assert.equal(RL.INLINE_MAX_OPEN, 10);
  let open = [];
  for (let i = 1; i <= 10; i++) open = RL.inlineToggle(open, 't' + i).open;
  assert.equal(open.length, 10);
  const res = RL.inlineToggle(open, 't11');
  assert.equal(res.opened, true);
  assert.deepEqual(plain(res.evicted), ['t1']);
  assert.equal(res.open[0], 't2');
  assert.equal(res.open[9], 't11');
  const shut = RL.inlineToggle(res.open, 't5');
  assert.equal(shut.opened, false);
  assert.equal(shut.open.includes('t5'), false);
  assert.equal(shut.open.length, 9);
});

test('a stale answer is dropped: only the newest fetch per run counts', () => {
  const { RL } = load();
  const e = {};
  const first = RL.inlineBegin(e);
  const second = RL.inlineBegin(e);
  assert.equal(RL.inlineCurrent(e, first), false);
  assert.equal(RL.inlineCurrent(e, second), true);
  // Fetch again only when the span count (or waiting count) moved.
  assert.equal(RL.inlineSig({ spans: 3, waiting: 0 }), RL.inlineSig({ spans: 3 }));
  assert.notEqual(RL.inlineSig({ spans: 3 }), RL.inlineSig({ spans: 4 }));
  assert.notEqual(RL.inlineSig({ spans: 3, waiting: 1 }), RL.inlineSig({ spans: 3 }));
});

test('page wiring: the row opens in place, Details opens the full trace, spans load only on open', () => {
  const src = read('js/pages/agent-runs.js');
  const row = src.slice(src.indexOf('    _runRow(r, flat, guide, last) {'), src.indexOf('    _copyBtn(text, label) {'));
  assert.match(row, /document\.createElement\('div'\)/, 'the run row is not a button: it holds buttons');
  assert.match(row, /data-act="toggle"[^`]*aria-expanded/);
  assert.match(row, /class="rl-det" data-act="details"/);
  assert.match(row, /btn\.dataset\.act === 'details'\) \{ ev\.stopPropagation\(\); this\.selectRun\(r\.trace_id\)/);
  assert.match(row, /this\._inlineToggleRun\(r\.trace_id\)/);
  assert.match(row, /ev\.key !== 'Enter'/);
  // Lazy: the trace detail API is called from the inline fetch only, with a per-run sequence.
  const fetch = src.slice(src.indexOf('    async _inlineFetch(traceId, force) {'), src.indexOf('    /** Live poll: refetch only'));
  assert.match(fetch, /RL\.inlineBegin\(e\)/);
  assert.match(fetch, /if \(!RL\.inlineCurrent\(e, seq\)\) return;/);
  // Paged: the newest page, then only the spans after the newest loaded.
  assert.match(fetch, /this\._traceDelta\(traceId, e\.trace\)/);
  assert.match(src, /this\._inlineRefresh\(\);/);
  // Span details reuse the trace view's span panel, approvals included.
  assert.match(src, /RT\.spanPanelHtml\(ctx, found\)/);
  assert.match(src, /RunTrace\.buildTree\(e\.trace/);
  // Sessions start collapsed.
  assert.match(src, /RL\.sessionClosed\(this\._openSessions, g, this\.selected\)/);
  assert.doesNotMatch(src, /_collapsedSessions/);
});

test('cache-busting: runs-list.js and agent-runs.js versions moved', () => {
  const html = read('index.html');
  assert.match(html, /runs-list\.js\?v=8"/);
  assert.match(html, /agent-runs\.js\?v=394"/);
});

test('a failed fetch retries on the next live tick; a fetch in flight never doubles', () => {
  const { RL } = load();
  const r = { spans: 3, waiting: 0 };
  assert.equal(RL.inlineNeedsFetch({ error: true, loading: false }, r), true);
  assert.equal(RL.inlineNeedsFetch({ error: true, loading: true }, r), false);
  assert.equal(RL.inlineNeedsFetch({ loading: false, trace: null }, r), false);
  const ok = { loading: false, error: false, trace: {}, sig: RL.inlineSig(r) };
  assert.equal(RL.inlineNeedsFetch(ok, r), false);
  assert.equal(RL.inlineNeedsFetch(ok, { spans: 4 }), true);
  assert.equal(RL.inlineNeedsFetch(null, r), false);
});

test('closed runs and runs pushed out by the cap drop their cached spans', () => {
  const { RL } = load();
  const cache = { t1: {}, t2: {}, t3: {} };
  const res = RL.inlineToggle(['t1', 't2'], 't3', 2);
  RL.inlinePrune(cache, res.open);
  assert.deepEqual(Object.keys(cache).sort(), ['t2', 't3']);
  RL.inlinePrune(cache, RL.inlineToggle(res.open, 't2').open);
  assert.deepEqual(Object.keys(cache), ['t3']);
});

test('follow-ups wired: allow once needs a fingerprint, raw arguments stay open, span rows say expanded', () => {
  const src = read('js/pages/agent-runs.js');
  const guard = /if \(duration === 'once' && !\(req && req\.call_fingerprint\)\) return;/;
  assert.match(src.slice(src.indexOf('    async _inlineDecide('), src.indexOf('    /** Optimizer finding')), guard);
  assert.match(src.slice(src.indexOf('    async _rtDecide('), src.indexOf('    async _rtRevoke(')), guard);
  assert.match(src, /RunsList\.inlinePrune\(this\._inline, this\._openRuns\)/);
  assert.match(src, /RunsList\.inlineNeedsFetch\(e, r, Date\.now\(\)\)/);
  assert.match(src, /raw\.open = !!e\.raw\[row\.key\]/);
  assert.match(src, /el\.setAttribute\('aria-expanded', open \? 'true' : 'false'\)/);
});
