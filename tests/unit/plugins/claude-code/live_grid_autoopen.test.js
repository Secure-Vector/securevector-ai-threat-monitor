/** Live grid: one running rule shared with the Runs page, the strip text,
 *  quiet from two minutes, and every running session's panel open on
 *  first paint (newest first, capped at twelve, closed ones remembered). */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');
const deq = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b);

function loadAll() {
  const window = {};
  const sandbox = { window, console };
  vm.createContext(sandbox);
  vm.runInContext(read('js/components/run-trace.js'), sandbox);
  vm.runInContext(read('js/components/runs-list.js'), sandbox);
  vm.runInContext(read('js/components/live-grid-model.js'), sandbox);
  return { RL: window.RunsList, M: window.LiveGridModel };
}

const NOW = Date.parse('2026-10-28T14:00:00Z');
const at = (sAgo) => new Date(NOW - sAgo * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
// Newer sessions have smaller quiet_seconds and a later last activity.
const sess = (id, quiet, extra = {}) => Object.assign({
  session_id: id, harness: 'claude-code', quiet_seconds: quiet, last_activity_at: at(quiet), started_at: at(quiet + 60),
  waiting: 0, blocked: 0, ended: false, tool_calls: {},
}, extra);

test('one running rule: the Runs summary, the strip and the counters agree', () => {
  const { RL, M } = loadAll();
  const live = { sessions: [sess('a', 5), sess('b', 30), sess('q', 200), sess('e1', 40, { ended: true, ended_at: at(40) }),
    sess('e2', 700, { ended: true })] };
  live.counters = M.counters(live.sessions);
  const runs = ['a', 'b', 'q', 'e1', 'e2'].map((sid, i) => ({ trace_id: 't' + i, session_id: sid, started_at: at(900), ended_at: at(30) }));
  const ctx = RL.buildCtx(runs, { live, now: NOW });
  assert.equal(typeof M.sessionRunning, 'function');
  assert.equal(M.sessionRunning(live.sessions[0]), true);
  assert.equal(M.sessionRunning(live.sessions[3]), false);
  assert.equal(M.sessionRunning(null), false);
  // e1 ended at its marker 40 s ago: not running, even though its run
  // ended inside the old two-minute window.
  assert.equal(RL.isRunning(runs[3], ctx), false);
  assert.equal(RL.runningSessions(runs, ctx), 3);
  assert.equal(live.counters.running, 3);
  assert.equal(live.counters.quiet, 1);
  assert.equal(live.counters.ended, 2);
  assert.equal(M.stripText(live.counters), '3 running · 1 quiet · 2 ended');
  // A session missing from the live list (cut at its limit) falls back to
  // the old rule: a run that ended under two minutes ago still runs.
  const cut = [{ trace_id: 'x', session_id: 'zz', ended_at: at(5) }, { trace_id: 'y', session_id: 'yy', ended_at: at(600) }];
  const cctx = RL.buildCtx(cut, { live, now: NOW });
  assert.equal(RL.isRunning(cut[0], cctx), true);
  assert.equal(RL.isRunning(cut[1], cctx), false);
  // Without live data the old rule stands.
  const bare = RL.buildCtx(runs, { now: NOW });
  assert.equal(RL.isRunning(runs[3], bare), true);
});

test('quiet starts at 120 s, stays running, and the tile says "Quiet 2m"', () => {
  const { M } = loadAll();
  assert.equal(M.QUIET_S, 120);
  assert.equal(M.isQuiet(sess('a', 119)), false);
  assert.equal(M.isQuiet(sess('a', 120)), true);
  assert.equal(M.isQuiet(sess('a', 900, { ended: true })), false);
  assert.equal(M.state(sess('a', 125)), 'quiet');
  assert.equal(M.matchToggle(sess('a', 125), 'running'), true);
  const html = M.compactTileHtml(sess('a', 125), false, false, { now: NOW });
  assert.match(html, /<span class="lg-c-quiet">Quiet 2m<\/span>/);
  assert.doesNotMatch(M.compactTileHtml(sess('b', 30), false, false, { now: NOW }), /lg-c-quiet/);
  assert.ok(M.TOGGLES.some(t => t[1] === 'Quiet over 2m'));
});

test('first paint opens every running session, newest first; ended ones stay closed', () => {
  const { M } = loadAll();
  const list = [sess('old', 90), sess('new', 5), sess('mid', 40), sess('gone', 50, { ended: true })];
  const r = M.autoOpen([], list, null, [], false);
  // Opening order keeps the newest last; the matrix draws in tile order.
  deq(r.open, ['old', 'mid', 'new']);
  assert.equal(r.more, 0);
  deq(r.seen.slice().sort(), ['gone', 'mid', 'new', 'old']);
  const tiles = M.arrange(list, M.order(null, list));
  deq(tiles.map(s => s.session_id), ['new', 'mid', 'old', 'gone']);
  deq(M.matrixList(r.open, tiles).map(s => s.session_id), ['new', 'mid', 'old']);
});

test('more than twelve running: the twelve newest open and a line says how many more', () => {
  const { M } = loadAll();
  const list = Array.from({ length: 15 }, (_, i) => sess('s' + String(i).padStart(2, '0'), 10 + i * 10));
  const r = M.autoOpen([], list, null, [], false);
  assert.equal(r.open.length, 12);
  assert.equal(r.more, 3);
  assert.ok(!r.open.includes('s12') && !r.open.includes('s14'));
  assert.equal(r.open[r.open.length - 1], 's00');
  const html = M.matrixHtml(M.matrixList(r.open, list), { details: {}, more: 3 });
  assert.match(html, /<p class="lg-mx-more">3 more sessions below<\/p>/);
  assert.match(html, /--lg-mx-cols:4;--lg-mx-rows:3/);
  assert.doesNotMatch(M.matrixHtml(M.matrixList(r.open, list), { details: {} }), /lg-mx-more/);
});

test('new sessions open at the top while watching; a closed panel never reopens; Close all stops it', () => {
  const { M } = loadAll();
  const first = [sess('a', 30), sess('b', 60)];
  let r = M.autoOpen([], first, null, [], false);
  deq(r.open, ['b', 'a']);
  // The person closed a; then c and d appear (d ended).
  const open = r.open.filter(x => x !== 'a');
  const next = [sess('c', 2), sess('d', 3, { ended: true })].concat(first);
  r = M.autoOpen(open, next, r.seen, ['a'], false);
  deq(r.open, ['b', 'c']);
  // c joins the top of the grid and the matrix.
  const order = M.order(['a', 'b'], next);
  deq(order.slice(0, 1), ['c']);
  deq(M.matrixList(r.open, M.arrange(next, order)).map(s => s.session_id), ['c', 'b']);
  // A session seen before never opens on its own again, and closed ids
  // never come back on the next poll.
  r = M.autoOpen(r.open, next, r.seen, ['a'], false);
  deq(r.open, ['b', 'c']);
  // Close all: nothing new opens until reload.
  r = M.autoOpen([], next.concat([sess('e', 1)]), r.seen, ['a', 'b', 'c'], true);
  deq(r.open, []);
  // Pinned focus (off on first paint) opens nothing extra.
  deq(M.autoOpen(['p'], first, null, [], true).open, ['p']);
});

test('page wiring: auto-open per visit, closed ids remembered, strip text', () => {
  const page = read('js/pages/live-grid.js');
  assert.match(page, /M\.autoOpen\(this\._open, M\.arrange\(data\.sessions \|\| \[\], this\._order\), this\._autoSeen,/);
  assert.match(page, /this\._autoOff \|\| this\.st\.mode === 'large'/);
  assert.match(page, /this\._autoSeen = null; this\._closedIds = \[\]; this\._autoOff = false;/);
  assert.match(page, /if \(act === 'close-all'\) \{ this\._autoOff = true;/);
  assert.match(page, /M\.stripParts\(c\)/);
  assert.match(page, /\.lg-mx-more \{/);
  const runs = read('js/components/runs-list.js');
  assert.match(runs, /LGM\.sessionRunning\(s\)/);
});

test('open panels refetch only when their session moved; first loads four per poll', () => {
  const { M } = loadAll();
  const list = Array.from({ length: 12 }, (_, i) => sess('p' + i, 10 + i));
  const ids = list.map(s => s.session_id);
  // First poll: nothing loaded yet, four fetch.
  let plan = M.detailPlan(ids, list, {}, {});
  deq(plan.fetch, ['p0', 'p1', 'p2', 'p3']);
  deq(plan.keep, []);
  const details = {}, stamps = {};
  plan.fetch.forEach(id => { details[id] = { gov: {} }; stamps[id] = plan.stamps[id]; });
  // Second poll, nothing moved: the four loaded are kept, four more load.
  plan = M.detailPlan(ids, list, stamps, details);
  deq(plan.keep, ['p0', 'p1', 'p2', 'p3']);
  deq(plan.fetch, ['p4', 'p5', 'p6', 'p7']);
  // A session with new activity, or a new waiting call, refetches.
  const moved = list.map(s => (s.session_id === 'p1' ? Object.assign({}, s, { last_activity_at: at(0) })
    : s.session_id === 'p2' ? Object.assign({}, s, { waiting: 1 }) : s));
  plan = M.detailPlan(['p0', 'p1', 'p2', 'p3'], moved, stamps, details);
  deq(plan.fetch, ['p1', 'p2']);
  deq(plan.keep, ['p0', 'p3']);
  const page = read('js/pages/live-grid.js');
  assert.match(page, /this\.M\(\)\.detailPlan\(ids \|\| this\.pins, \(this\.data && this\.data\.sessions\) \|\| \[\], this\._stamps, this\.details\)/);
  assert.match(page, /this\._pool\(plan\.fetch, this\.FETCH_CAP/);
});
