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

function loadPage(api = {}, withDeleg = false) {
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
  if (withDeleg) vm.runInNewContext(read('js/components/delegation-ui.js') + '\nwindow.DelegationUI = DelegationUI; globalThis.DelegationUI = DelegationUI;', sandbox);
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
  assert.match(watch, /terminals-task-drift is-watch[^>]*>unusual activity worth a look</);
  const high = Page._factsHtml(Object.assign({}, TASK, { drift_score: 81, drift_band: 'high' }));
  assert.match(high, /is-high[^>]*>unusual activity high</);
  const calm = Page._factsHtml(Object.assign({}, TASK, { drift_score: 12, drift_band: 'calm' }));
  assert.match(calm, /terminals-task-drift is-calm[^>]*>unusual activity low</);
  assert.doesNotMatch(Page._factsHtml(Object.assign({}, TASK, { tool_calls: 3 })), /drift/);
});

test('summary row shows number, band word and the top three features in plain words', () => {
  const Page = loadPage();
  const s = Page._summaryBuild(TASK, { drift: SCORED });
  const html = Page._summaryHtml(s);
  assert.match(html, /<dt>Unusual activity<\/dt>/);
  assert.match(html, /terminals-drift-band is-watch">62, worth a look<\/span>: tools this session has not used here before \(4 of 31 calls\), hosts new for this folder \(3\), errors right after a blocked call \(2\)/);
  assert.match(html, /data-drift-normal[^>]*>Looks normal</);
  // The row sits after Agent Health and before Approvals, per the design.
  assert.ok(!html.includes('—'));
});

test('building baseline reads as progress, with no number and no action', () => {
  const Page = loadPage();
  const s = Page._summaryBuild(TASK, { drift: { score: null, band: null, status: 'building_baseline', top: [], baseline: { sessions: 3, needed_sessions: 5 } } });
  const html = Page._summaryHtml(s);
  assert.match(html, /<dt>Unusual activity<\/dt><dd>learning what is normal, 3 of 5 sessions<\/dd>/);
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
  assert.match(html, /62, worth a look/);
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
  assert.match(host.innerHTML, /62, worth a look/);
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

test('summary: rows for status, tool calls, unusual activity, config, worth a look; Details is a collapsed button', () => {
  const Page = loadPage();
  const mk = (over) => Object.assign({ id: 'abc12345', status: 'done', duration_seconds: 6060, started_at: '2026-10-01T10:00:00Z', ended_at: '2026-10-01T11:41:00Z',
    harness: 'Claude Code', tool_calls: { allowed: 40, flagged: 0, blocked: 0, failed: 0 }, hosts: { count: 0, top: [] },
    findings: [], findings_total: 0, approvals: { approved: 0, denied: 0 }, drift: { score: 15, band: 'calm', status: 'scored', top: [], sessions: 8, needed: 5, ended: true },
    rung: null, deleg: null, setup: null, task_id: 't' }, over);
  const quiet = Page._summaryHtml(mk({}));
  assert.match(quiet, /<dt>Status<\/dt><dd>Finished in 1h 41m\. Nothing unusual\.<\/dd>/);
  assert.match(quiet, /<dt>Tool calls<\/dt><dd>40 calls \u00b7 40 allowed \u00b7 0 blocked<\/dd>/);
  assert.match(quiet, /<dt>Unusual activity<\/dt>[\s\S]*Drift Score 15 of 100\. Compared with this agent's own recent sessions in this folder\.[\s\S]*low<\/span> \(15 of 100\)/);
  assert.doesNotMatch(quiet, /terminals-summary-fact|<dt>Worth a look/);
  assert.match(quiet, /<button type="button" class="terminals-summary-toggle" data-summary-toggle aria-expanded="false"[^>]*>[\s\S]*Show details/);
  assert.match(quiet, /data-summary-details id="[^"]+" hidden>/);
  const busy = Page._summaryHtml(mk({ tool_calls: { allowed: 10, flagged: 1, blocked: 2, failed: 0 },
    findings: [{ category: 'x', title: 'Repeated the same Bash call 6 times' }, { category: 'x', title: 'Slow step' }, { category: 'x', title: 'Another' }], findings_total: 3 }));
  assert.match(busy, /Finished in 1h 41m\. 4 things worth a look\./);
  assert.match(busy, /13 calls \u00b7 10 allowed \u00b7 2 blocked \u00b7 1 other/);
  assert.match(busy, /<dt>Worth a look<\/dt>/);
  assert.match(busy, /and 1 more/);
  assert.match(busy, /Export evidence/);
  const running = Page._summaryHtml(mk({ status: 'working', ended_at: null }));
  assert.match(running, /Running for .*Nothing unusual so far\./);
  const many = Page._summaryHtml(mk({ setup: { state: 'changed', changes: Array.from({ length: 12 }, (_, i) => ({ text: `Mod p${i} changed (manifest or files).` })).concat([{ text: 'Hooks changed in ~/.x/settings.json.' }]) } }));
  assert.match(many, /Finished in 1h 41m\. 1 thing worth a look\./);
  assert.match(many, /Config changed: 12 plugins and 1 settings file\./);
  assert.ok(many.indexOf('Worth a look') > many.indexOf('<dt>Config</dt>'));
});

test('summary: one line per sub-agent, markdown stripped, file names only, held opens Details', () => {
  const Page = loadPage({}, true);
  const html = Page._summaryHtml({ id: 'abc12345', status: 'done', duration_seconds: 60, started_at: '2026-10-01T10:00:00Z', ended_at: '2026-10-01T10:01:00Z',
    harness: 'Claude Code', tool_calls: { allowed: 1, flagged: 0, blocked: 0, failed: 0 }, hosts: { count: 0, top: [] }, findings: [], findings_total: 0,
    approvals: { approved: 0, denied: 0 }, drift: null, rung: null, setup: null, task_id: 't',
    deleg: [{ id: 'a', state: 'done', harness: 'codex', result: 'Created [page1.html](page1.html) with a header. More text.' },
            { id: 'b', state: 'held', harness: 'codex', result: '' },
            { id: 'c', state: 'failed', harness: 'codex', reason: 'SecureVector Guard did not report from this Codex session.' }] });
  const summ = html.match(/<summary>[^<]*<\/summary>/)[0];
  assert.match(summ, /Codex \u00b7 done \u00b7 Created page1\.html with a header/);
  assert.doesNotMatch(summ, /\]\(/);
  assert.match(html, /<dt>Sub-agents<\/dt>/);
  assert.match(html, /Codex \u00b7 held for review/);
  assert.match(html, /1 sub-agent ran without monitoring\./);
  assert.match(html, /aria-expanded="true"[^>]*>[\s\S]*Hide details/);
  assert.doesNotMatch(html, /data-summary-details id="[^"]+" hidden/);
});
