/** A task the user stopped reads "Stopped by you", never "Failed".
 *
 * The app records `stopped` only when it sent the signal itself; a crash or a
 * signal from elsewhere stays `failed` and keeps its exit-code wording.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

function loadPage() {
  const window = {};
  const sandbox = {
    window,
    document: { getElementById: () => null },
    API: {},
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

test('a user-stopped task is labelled Stopped by you, not Failed', () => {
  const page = loadPage();
  const t = { status: 'stopped', exit_code: 143 };
  const state = page._taskState.call(page, t);
  assert.strictEqual(state.label, 'Stopped');
  assert.strictEqual(state.detail, 'Stopped by you');
  assert.notStrictEqual(state.kind, 'failed');
  assert.strictEqual(page._activityLine(t), 'Stopped by you');
  assert.strictEqual(page._statusLabel('stopped'), 'Stopped');
  assert.ok(page._isEnded(t), 'a stopped task is ended, so Restart is offered');
});

test('a non-zero exit the app did not cause still reads as Failed', () => {
  const page = loadPage();
  const t = { status: 'failed', exit_code: 143 };
  assert.strictEqual(page._taskState.call(page, t).label, 'Failed');
  assert.strictEqual(page._activityLine(t), 'Stopped with exit code 143');
});

test('index.html loads the bumped terminals.js asset version', () => {
  assert.match(read('index.html'), /\/js\/pages\/terminals\.js\?v=98"/);
});

test('the rail shows a user-stopped task as not active and "stopped by you"', () => {
  const src = read('js/components/sidebar.js');
  const sandbox = { window: {} };
  const body = src.slice(src.indexOf('HARNESS_LABELS:'), src.indexOf('_createDock() {'));
  vm.runInNewContext('window.o = { ' + body + ' };', sandbox);
  const o = sandbox.window.o;
  const task = { executor_id: 'claude-code', status: 'stopped' };
  const state = o._agentTaskState(task);
  assert.notStrictEqual(state, 'active');
  assert.notStrictEqual(state, 'failed');
  assert.strictEqual(o._taskSubtitle(task, state), 'Claude Code · stopped by you');
  assert.match(read('index.html'), /sidebar\.js\?v=184"/);
});
