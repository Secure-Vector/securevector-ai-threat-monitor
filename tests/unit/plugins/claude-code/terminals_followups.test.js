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


const page = loadPage();

test('a tool error row is recognised and its marker is split from the reason', () => {
  assert.strictEqual(page._isToolError({ action: 'allow', reason: 'tool error' }), true);
  assert.strictEqual(page._isToolError({ action: 'allow', reason: 'tool error; rule x' }), true);
  assert.strictEqual(page._isToolError({ action: 'allow', reason: 'tool errors none' }), false);
  assert.strictEqual(page._verdictReason({ reason: 'tool error' }), '');
  assert.strictEqual(page._verdictReason({ reason: 'tool error; rule x' }), 'rule x');
  assert.strictEqual(page._verdictReason({ reason: 'plain' }), 'plain');
});

test('the session summary counts tool error rows as failed', () => {
  const s = page._summaryBuild({ id: 'abc12345', executor_id: 'codex', created_at: '2026-10-08T10:00:00+00:00' }, {
    verdicts: { items: [{ action: 'allow', reason: 'tool error' }, { action: 'allow', reason: '' }] },
  });
  assert.strictEqual(s.tool_calls.failed, 1);
  assert.strictEqual(s.tool_calls.allowed, 1);
});

test('the header count follows the listed rows and no page calls the report route unguarded', () => {
  const t = read('js/pages/terminals.js');
  assert.ok(t.includes("`${listed.length} call${listed.length === 1"));
  assert.ok(!/Capabilities \(v/.test(read('js/pages/integrations.js')));
  assert.ok(read('js/pages/agent-runs.js').includes('/api/cost-optimizer/status'));
  assert.ok(!read('js/components/guardian-assistant.js').includes("API.request('/api/cost-optimizer/report')"));
});

test('a request pauses the task only without newer hook activity', () => {
  const r = { requested_at: '2026-10-08 10:00:00' };
  const t = (status, at) => ({ status, last_activity_at: at });
  assert.strictEqual(page._approvalPausesTask(t('working', '2026-10-08T10:05:00Z'), r), false);
  assert.strictEqual(page._approvalPausesTask(t('working', '2026-10-08T09:59:00Z'), r), true);
  assert.strictEqual(page._approvalPausesTask(t('blocked', '2026-10-08T10:05:00Z'), r), true);
});

test('the tool error suffix is not added to a blocked row', () => {
  assert.ok(read('js/pages/terminals.js').includes("this._isToolError(i) && i.action !== 'block' ? ' · tool error'"));
});
