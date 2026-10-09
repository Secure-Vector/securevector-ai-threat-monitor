/** Session Drift Score on Agent Sessions: the facts line number, the summary
 * row with the top features in plain words, the building state, and the one
 * action, "Looks normal". Colour only for the band, and calm stays neutral.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

function loadPage(api = {}) {
  const window = {};
  const sandbox = {
    window,
    document: { getElementById: () => null },
    API: api,
    URLSearchParams,
    WebSocket: { OPEN: 1, CLOSED: 3 },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console: { warn() {}, error() {} },
  };
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  vm.runInNewContext(read('js/pages/terminals.js'), sandbox);
  return sandbox.window.TerminalsPage;
}

const TASK = { id: 'abc12345', executor_id: 'claude-code', workspace: '/w/app', session_id: 's1', created_at: '2026-10-08T10:00:00+00:00' };
const SCORED = {
  score: 62, band: 'watch', status: 'scored', feedback: null, ended: true,
  top: [
    { id: 'tool_novelty', label: 'tools this session has not used here before', detail: '4 of 31 calls' },
    { id: 'new_hosts', label: 'hosts new for this folder', detail: '3' },
    { id: 'errors_after_block', label: 'errors right after a blocked call', detail: '2' },
  ],
  baseline: { sessions: 8, needed_sessions: 5 },
};

test('facts line appends the drift number, coloured by band only above calm', () => {
  const Page = loadPage();
  const watch = Page._factsHtml(Object.assign({}, TASK, { tool_calls: 31, blocked_calls: 0, drift_score: 62, drift_band: 'watch' }));
  assert.match(watch, /terminals-task-drift is-watch[^>]*>drift 62</);
  const high = Page._factsHtml(Object.assign({}, TASK, { drift_score: 81, drift_band: 'high' }));
  assert.match(high, /is-high[^>]*>drift 81</);
  const calm = Page._factsHtml(Object.assign({}, TASK, { drift_score: 12, drift_band: 'calm' }));
  assert.match(calm, /terminals-task-drift is-calm[^>]*>drift 12</);
  assert.doesNotMatch(Page._factsHtml(Object.assign({}, TASK, { tool_calls: 3 })), /drift/);
});

test('summary row shows number, band word and the top three features in plain words', () => {
  const Page = loadPage();
  const s = Page._summaryBuild(TASK, { drift: SCORED });
  const html = Page._summaryHtml(s);
  assert.match(html, /<dt>Drift<\/dt>/);
  assert.match(html, /terminals-drift-band is-watch">62, watch<\/span>: tools this session has not used here before \(4 of 31 calls\), hosts new for this folder \(3\), errors right after a blocked call \(2\)/);
  assert.match(html, /data-drift-normal[^>]*>Looks normal</);
  // The row sits after Agent Health and before Approvals, per the design.
  assert.ok(!html.includes('—'));
});

test('building baseline reads as progress, with no number and no action', () => {
  const Page = loadPage();
  const s = Page._summaryBuild(TASK, { drift: { score: null, band: null, status: 'building_baseline', top: [], baseline: { sessions: 3, needed_sessions: 5 } } });
  const html = Page._summaryHtml(s);
  assert.match(html, /<dt>Drift<\/dt><dd>building baseline, 3 of 5 sessions<\/dd>/);
  assert.doesNotMatch(html, /Looks normal/);
});

test('partial baseline and a session already marked normal', () => {
  const Page = loadPage();
  const s = Page._summaryBuild(TASK, { drift: Object.assign({}, SCORED, { status: 'partial', feedback: 'normal' }) });
  const html = Page._summaryHtml(s);
  assert.match(html, /\(partial baseline\)/);
  assert.match(html, /Marked normal/);
  assert.doesNotMatch(html, /data-drift-normal/);
});

test('a running session gets no "Looks normal" action', () => {
  const Page = loadPage();
  const html = Page._summaryHtml(Page._summaryBuild(TASK, { drift: Object.assign({}, SCORED, { ended: false }) }));
  assert.match(html, /62, watch/);
  assert.doesNotMatch(html, /Looks normal|data-drift-normal/);
  // Without the route's flag, the task row decides.
  const viaTask = Page._summaryHtml(Page._summaryBuild(TASK, { drift: Object.assign({}, SCORED, { ended: undefined }) }));
  assert.doesNotMatch(viaTask, /Looks normal/);
  const ended = Page._summaryHtml(Page._summaryBuild(Object.assign({}, TASK, { ended_at: '2026-10-08T11:00:00+00:00' }), { drift: Object.assign({}, SCORED, { ended: undefined }) }));
  assert.match(ended, /Looks normal/);
});

test('no session or no drift leaves the row out', () => {
  const Page = loadPage();
  assert.doesNotMatch(Page._summaryHtml(Page._summaryBuild(TASK, {})), /Drift/);
  assert.doesNotMatch(Page._summaryHtml(Page._summaryBuild(TASK, { drift: { status: 'no_session' } })), /Drift/);
});

test('Looks normal posts feedback once and changes no verdict', async () => {
  const calls = [];
  const api = {
    terminalsVerdicts: async () => ({ items: [] }),
    terminalsDrift: async () => SCORED,
    terminalsDriftFeedback: async (id) => { calls.push(id); return { ok: true, feedback: 'normal' }; },
  };
  const Page = loadPage(api);
  const link = { onclick: null, outerHTML: '', textContent: '' };
  const host = {
    isConnected: true, innerHTML: '',
    querySelector: (sel) => (sel === '[data-drift-normal]' ? link : null),
  };
  await Page._summaryFill(host, TASK);
  assert.match(host.innerHTML, /62, watch/);
  await link.onclick({ preventDefault() {} });
  assert.deepStrictEqual(calls, ['abc12345']);
  assert.match(link.outerHTML, /Marked normal/);
});

test('api client exposes the three drift calls on the loopback terminals paths', () => {
  const src = read('js/api.js');
  assert.match(src, /terminalsDrift\(id\)[^]*?_terminalsRead\(`\/api\/terminals\/tasks\/\$\{encodeURIComponent\(id\)\}\/drift`\)/);
  assert.match(src, /terminalsDriftBatch\(ids\)[^]*?_terminalsRead\(`\/api\/terminals\/drift\?task_ids=/);
  assert.match(src, /terminalsDriftFeedback\(id\)[^]*?_terminalsWrite\(/);
});
