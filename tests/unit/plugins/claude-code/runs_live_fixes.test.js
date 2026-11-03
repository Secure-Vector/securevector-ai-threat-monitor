/** Runs and Live grid fixes: the session count line, run links (?run=),
 *  the server's ended word over the recent-activity window, the Live grid
 *  tab count and per-session detail failures, and the terminal text size. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

function loadRL() {
  const window = {};
  const sandbox = { window, console, URL, URLSearchParams };
  vm.runInNewContext(read('js/components/runs-list.js'), sandbox);
  return window.RunsList;
}

function loadLGM() {
  const window = {};
  const sandbox = { window, console };
  vm.runInNewContext(read('js/components/run-trace.js'), sandbox);
  vm.runInNewContext(read('js/components/live-grid-model.js'), sandbox);
  return window.LiveGridModel;
}

function loadLivePage(API) {
  const window = { API };
  const sandbox = { window, console: { debug() {}, log() {}, warn() {}, error() {} }, API, document: { getElementById: () => null } };
  vm.runInNewContext(read('js/components/run-trace.js'), sandbox);
  vm.runInNewContext(read('js/components/live-grid-model.js'), sandbox);
  vm.runInNewContext(read('js/pages/live-grid.js'), sandbox);
  return window.LiveGridPage;
}

// -- 1. session row ----------------------------------------------------------

test('session line: runs, calls, and the cost only when there is one', () => {
  const RL = loadRL();
  assert.equal(RL.sessionSummary([{ tool_call_count: 3, cost: 0 }, { tool_call_count: 2 }]), '2 runs · 5 calls');
  assert.equal(RL.sessionSummary([{ tool_call_count: 1, cost: 0.5 }]), '1 run · 1 call · $0.50');
  assert.equal(RL.sessionSummary([{ spans: 4 }]), '1 run · 4 calls', 'older rows fall back to spans');
  assert.equal(RL.sessionSummary([{ tool_call_count: 2, cost: 0.002 }]), '1 run · 2 calls · <$0.01');
  assert.equal(RL.sessionSummary([{ tool_call_count: 2, cost: 0.006 }]), '1 run · 2 calls · $0.01');
  const src = read('js/pages/agent-runs.js');
  assert.ok(src.includes('RL.sessionSummary(sessRuns)'));
  assert.doesNotMatch(src, /cost > 0 \? '\$' \+ cost\.toFixed\(2\) : '—'/);
});

// -- 2. run links ------------------------------------------------------------

test('run links: the param is read, set and removed', () => {
  const RL = loadRL();
  assert.equal(RL.runParam('?run=abc-1'), 'abc-1');
  assert.equal(RL.runParam('?x=1'), null);
  assert.equal(RL.runParam('?run=' + 'a'.repeat(300)), null);
  assert.equal(RL.runHref('http://127.0.0.1/agent-runs', 't 1'), '/agent-runs?run=t+1');
  assert.equal(RL.runHref('http://127.0.0.1/agent-runs?run=t1&x=2', null), '/agent-runs?x=2');
  assert.equal(RL.runHref('http://127.0.0.1/agent-runs?run=t1', ''), '/agent-runs');
});

test('run links: opening and closing a run keep ?run= in step, render opens a linked run', () => {
  const src = read('js/pages/agent-runs.js');
  const toggle = src.slice(src.indexOf('    _inlineToggleRun(traceId) {'), src.indexOf('    _syncRunParam() {'));
  assert.ok(toggle.includes('this._syncRunParam();'));
  assert.ok(src.includes('history.replaceState(history.state, \'\', next)'));
  assert.ok(src.includes('const linkRun = RunsList.runParam(window.location.search);'));
  assert.ok(src.includes("this._jumpToWaiting([wantLink], null, null, { link: true });"));
  // Older than the window: widened to 90 days, as the trace deep link does.
  assert.match(src, /wantLink && this\.windowDays < 90\) \{[\s\S]{0,300}this\.range = '90d';/);
  // Not found after widening: the earlier range comes back, with a short toast.
  assert.match(src, /Toast\.error\('Run not found'\);[\s\S]{0,200}takeOnce\(this, '_linkPrevRange'\)[\s\S]{0,120}this\.windowDays = prev\.windowDays;\s*this\.range = prev\.range;/);
  const app = read('js/app.js');
  assert.ok(app.includes("url += '?run=' + encodeURIComponent(run)"));
});

// -- 3. ended sessions -------------------------------------------------------

test('a run the server says ended is not running, even within two minutes', () => {
  const RL = loadRL();
  const now = Date.parse('2026-11-02T10:00:00Z');
  const recent = '2026-11-02T09:59:30Z';
  const ctxNone = { now, live: {}, newest: {} };
  assert.equal(RL.isRunning({ trace_id: 't', ended_at: recent }, ctxNone), true, 'no word from the server: the window stands');
  assert.equal(RL.isRunning({ trace_id: 't', ended_at: recent, ended: true }, ctxNone), false);
  const ctx = { now, live: { s1: { session_id: 's1', ended: true } }, newest: { s1: 't' } };
  assert.equal(RL.isRunning({ trace_id: 't', session_id: 's1', ended_at: recent }, ctx), false);
  const src = read('js/pages/agent-runs.js');
  assert.ok(src.includes("if (v === 'live') return this._runLive(r);"));
  assert.ok(src.includes('(this._runLive(trace) ? this._liveBadge('));
});

// -- 4. live grid ------------------------------------------------------------

test('the All running count is the filtered list the grid renders', () => {
  const M = loadLGM();
  const list = [
    { session_id: 'a', harness: 'claude-code', ended: false },
    { session_id: 'b', harness: 'codex', ended: false },
    { session_id: 'c', harness: 'claude-code', ended: true },
  ];
  assert.equal(M.runningShown(list, {}), 2);
  assert.equal(M.runningShown(list, { harness: 'claude-code' }), 1);
  assert.ok(read('js/pages/live-grid.js').includes("set('lg-n-all', M.runningShown(all, this.st));"));
});

test('calls section: empty says No calls yet, an error offers Retry', () => {
  const M = loadLGM();
  const empty = M.sectionsHtml('s1', { gov: null, spans: [], traceId: null, trace: null });
  assert.match(empty, /No calls yet\./);
  assert.doesNotMatch(empty, /Loading calls/);
  const err = M.sectionsHtml('s1', { gov: null, spans: [], traceId: null, trace: null, error: true });
  assert.match(err, /data-act="retry" data-sid="s1">Retry<\/button>/);
  assert.doesNotMatch(err, /Loading calls/);
});

test('one session failing leaves the others loaded and itself in an error state', async () => {
  const API = {
    getSessionGovernance: async (sid) => ({ runs: { trace_ids: ['t-' + sid] } }),
    getTraceTree: async (tid) => { if (tid === 't-bad') throw new Error('boom'); return { trace_id: tid, spans: [{ span_kind: 'tool_call' }] }; },
    getJitRequests: async () => ({ items: [] }),
  };
  const page = loadLivePage(API);
  page._seq = 1;
  page.data = { sessions: [{ session_id: 'ok' }, { session_id: 'bad' }] };
  page.details = {};
  page._stamps = {};
  page._open = [];
  page.FETCH_CAP = 4;
  await page._loadDetails(1, ['ok', 'bad']);
  assert.equal(page.details.ok.spans.length, 1);
  assert.equal(page.details.bad.error, true);
  // A later failure keeps what a session already had.
  page.details.ok.traceId = 't-ok';
  API.getTraceTree = async () => { throw new Error('down'); };
  const [, kept] = await page._detailOf('ok');
  assert.equal(kept.spans.length, 1);
  assert.notEqual(kept.error, true);
});

// -- 9. terminal text size ---------------------------------------------------

test('terminal text is 14px and refits after construction and font load', () => {
  const src = read('js/components/terminal-view.js');
  assert.ok(src.includes('fontSize: 14,'));
  const ctor = src.slice(src.indexOf('this.term.open(container);'), src.indexOf('_selectRenderer() {'));
  assert.ok(ctor.includes('this.fitNow();'));
  assert.ok(ctor.includes('document.fonts.ready.then(() => this.fitNow())'));
});
