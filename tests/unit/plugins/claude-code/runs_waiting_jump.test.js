/** Observability > Runs: the amber "waiting for approval" badge jumps to
 *  the waiting call's details. The pure rules in js/components/runs-list.js
 *  (soonest-expiring request, the path to open, the list page, the one-shot
 *  handoff) and the wiring in agent-runs.js and the Live grid. */
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

const req = (id, extra) => Object.assign({ id, status: 'pending', session_id: 's1' }, extra);

test('soonestWaiting picks the request that expires first, within the runs asked', () => {
  const { RL } = load();
  const items = [
    req('late', { trace_id: 't1', expires_at: '2026-10-24T10:30:00Z' }),
    req('soon', { trace_id: 't2', expires_at: '2026-10-24T10:05:00Z' }),
    req('other', { trace_id: 't9', expires_at: '2026-10-24T10:01:00Z' }),
    req('deleg', { trace_id: 't1', expires_at: '2026-10-24T10:00:00Z', rule_source: 'delegate' }),
    req('done', { trace_id: 't1', expires_at: '2026-10-24T10:00:00Z', status: 'denied' }),
  ];
  const hit = RL.soonestWaiting(items, ['t1', 't2'], { newest: {} });
  assert.equal(hit.req.id, 'soon');
  assert.equal(hit.traceId, 't2');
  assert.equal(RL.soonestWaiting(items, ['t1'], { newest: {} }).req.id, 'late');
  assert.equal(RL.soonestWaiting(items, ['t5'], { newest: {} }), null);
});

test('soonestWaiting: no expiry sorts last; no trace id means the session newest run', () => {
  const { RL } = load();
  const items = [
    req('noexp', { trace_id: 't1' }),
    req('bysess', { expires_at: '2026-10-24T10:09:00Z' }),
  ];
  const hit = RL.soonestWaiting(items, ['t1'], { newest: { s1: 't1' } });
  assert.equal(hit.req.id, 'bysess');
  assert.equal(hit.traceId, 't1');
});

test('soonestWaitingRun falls back to the run whose wait expires first', () => {
  const { RL } = load();
  const runs = [
    { trace_id: 'a', waiting: 1, oldest_waiting_expires_at: '2026-10-24T10:30:00Z' },
    { trace_id: 'b', waiting: 2, oldest_waiting_expires_at: '2026-10-24T10:10:00Z' },
    { trace_id: 'c', waiting: 0, oldest_waiting_expires_at: '2026-10-24T10:00:00Z' },
  ];
  assert.equal(RL.soonestWaitingRun(runs).trace_id, 'b');
  assert.equal(RL.soonestWaitingRun([{ trace_id: 'x', waiting: 0 }]), null);
});

test('waitPath opens the turn and finds the span the panel matches by request id', () => {
  const { RL } = load();
  const tree = { key: 'run', kind: 'run', children: [
    { key: 'g1', kind: 'llm', children: [{ key: 'a', kind: 'tool', children: [], req: null }] },
    { key: 'g2', kind: 'llm', children: [
      { key: 'b', kind: 'tool', children: [], req: { id: 'r1', status: 'pending', expires_at: '2026-10-24T10:30:00Z' } },
      { key: 'c', kind: 'tool', children: [], req: { id: 'r2', status: 'pending', expires_at: '2026-10-24T10:05:00Z' } },
    ] },
    { key: 'req:r3', kind: 'tool', children: [], req: { id: 'r3', status: 'pending' } },
  ] };
  assert.deepEqual(JSON.parse(JSON.stringify(RL.waitPath(tree, 'r1'))), { key: 'b', open: ['g2'] });
  assert.deepEqual(JSON.parse(JSON.stringify(RL.waitPath(tree, 'r3'))), { key: 'req:r3', open: [] });
  // No request id: the pending call that expires soonest.
  assert.deepEqual(JSON.parse(JSON.stringify(RL.waitPath(tree, null))), { key: 'c', open: ['g2'] });
  assert.equal(RL.waitPath(tree, 'missing'), null);
});

test('waitPath works on a real span tree built from requests (an orphan request joins its turn)', () => {
  const { RL, RT } = load();
  const trace = { trace_id: 't1', session_id: 's1', spans: [
    { span_id: 'g', span_kind: 'generation', called_at: '2026-10-24T10:00:00Z' },
  ] };
  const tree = RT.buildTree(trace, { requests: [req('rq', { trace_id: 't1', requested_at: '2026-10-24T10:00:05Z' })], newest: true });
  const p = RL.waitPath(tree, 'rq');
  assert.ok(p);
  assert.equal(p.key, 'req:rq');
  assert.equal(p.open.length, 1);
});

test('pageOfRun: by run when flat, by session when grouped, -1 when not listed', () => {
  const { RL } = load();
  const runs = [];
  for (let i = 0; i < 30; i++) runs.push({ trace_id: 't' + i, session_id: 's' + Math.floor(i / 2) });
  assert.equal(RL.pageOfRun(runs, 't0', true, 10), 0);
  assert.equal(RL.pageOfRun(runs, 't25', true, 10), 2);
  assert.equal(RL.pageOfRun(runs, 't25', false, 10), 1); // session s12 is the 13th
  assert.equal(RL.pageOfRun(runs, 'nope', true, 10), -1);
});

test('takeOnce consumes a pending target exactly once', () => {
  const { RL } = load();
  const page = { _pendingWait: { traceId: 't1', reqId: 'r1' } };
  assert.deepEqual(RL.takeOnce(page, '_pendingWait'), { traceId: 't1', reqId: 'r1' });
  assert.equal(page._pendingWait, null);
  assert.equal(RL.takeOnce(page, '_pendingWait'), null);
});

test('wiring: badges are buttons named "Review the waiting call"; Deny gets focus; the grid hands off once', () => {
  const ar = read('js/pages/agent-runs.js');
  assert.ok((ar.match(/Review the waiting call/g) || []).length >= 3, 'session, run and span badges');
  assert.match(ar, /data-act="wait"/);
  assert.match(ar, /scrollIntoView\(\{ block: 'center' \}\)/);
  assert.match(ar, /querySelector\('\[data-act="deny"\]'\)/);
  assert.match(ar, /RunsList\.takeOnce\(this, '_pendingWait'\)/);
  assert.match(ar, /this\._pendingReq = wantReq; this\.selectRun\(traceId\)/, 'fallback: Details with the request preselected');
  assert.match(ar, /RL\.inlineToggle\(this\._openRuns, traceId, RL\.INLINE_MAX_OPEN\)/, 'open-runs cap');
  const lg = read('js/pages/live-grid.js');
  assert.match(lg, /AgentRunsPage\._pendingWait = \{ traceId: tid, reqId: reqId \|\| null \}/);
  assert.match(lg, /act === 'open-panel'[^\n]*\n\s*this\.openTrace\(sid, null\)/, 'Open trace unchanged');
  const lm = read('js/components/live-grid-model.js');
  assert.match(lm, /data-act="\$\{wait \? 'review' : 'peek'\}"/);
});

test('waitingFirst: waiting runs lead, soonest expiry first; the rest keep their order', () => {
  const { RL } = load();
  const runs = [
    { trace_id: 'n1', session_id: 'sA' },
    { trace_id: 'w-late', session_id: 'sB', waiting: 1, oldest_waiting_expires_at: '2026-10-24T10:30:00Z' },
    { trace_id: 'n2', session_id: 'sB' },
    { trace_id: 'w-noexp', session_id: 'sC', waiting: 1 },
    { trace_id: 'w-soon', session_id: 'sD', waiting: 2, oldest_waiting_expires_at: '2026-10-24T10:05:00Z' },
    { trace_id: 'n3', session_id: 'sD' },
  ];
  const ids = RL.waitingFirst(runs).map(r => r.trace_id);
  assert.deepEqual([...ids], ['w-soon', 'w-late', 'w-noexp', 'n1', 'n2', 'n3']);
  // Grouped: waiting sessions lead in expiry order, waiting runs first inside.
  const groups = RL.groupBySession(RL.waitingFirst(runs)).map(g => g.key + ':' + g.runs.map(r => r.trace_id).join(','));
  assert.deepEqual([...groups], ['sD:w-soon,n3', 'sB:w-late,n2', 'sC:w-noexp', 'sA:n1']);
});

test('waitingFirst keeps a waiting session on page 1 however many newer sessions there are', () => {
  const { RL } = load();
  const runs = [];
  for (let i = 0; i < 40; i++) runs.push({ trace_id: 't' + i, session_id: 's' + i });
  runs.push({ trace_id: 'old', session_id: 'sOld', waiting: 1, oldest_waiting_expires_at: '2026-10-24T10:05:00Z' });
  const info = RL.pageSessions(RL.waitingFirst(runs), 0, 10);
  assert.equal(info.groups[0].key, 'sOld');
  assert.equal(RL.pageOfRun(RL.waitingFirst(runs), 'old', false, 10), 0);
});

test('wiring: the grouped list orders waiting first; the session header stays on one line', () => {
  const ar = read('js/pages/agent-runs.js');
  assert.equal((ar.match(/const ordered = flat \? sorted : byHarness \? RL\.harnessOrder\(RL\.waitingFirst\(sorted\)\) : RL\.waitingFirst\(sorted\);/g) || []).length, 2, 'list and jump agree');
  assert.match(ar, /\.rl-sh\.rl-sh-wait \{ flex-wrap:nowrap; \}/);
  assert.ok(ar.indexOf("head.classList.add('rl-sh-wait')") < ar.indexOf("badge.className = 'rl-cov'"), 'badge before coverage chip');
});

test('wiring: the jump focuses the panel heading, session badge has its own focus key, latest jump wins', () => {
  const ar = read('js/pages/agent-runs.js');
  assert.match(ar, /h3\.tabIndex = -1;/);
  assert.match(ar, /const h = el\.querySelector\('\.rt-ph h3'\);\s*if \(h\) h\.focus\(\{ preventScroll: true \}\);/);
  assert.doesNotMatch(ar, /deny\.focus\(/);
  assert.match(ar, /wb\.dataset\.fk = 'wsess:' \+ g\.key;/);
  assert.match(ar, /const seq = this\._jumpSeq = \(this\._jumpSeq \|\| 0\) \+ 1;/);
  assert.match(ar, /await this\._inlineFetch\(traceId, false\);\s*if \(seq !== this\._jumpSeq\) return;/);
});
