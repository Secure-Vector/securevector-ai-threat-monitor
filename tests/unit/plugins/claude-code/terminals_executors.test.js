/** Executor availability in the Terminals launch form: disable harnesses
 * that are not installed or not governed, show a hint, and refuse submit
 * on a non-launchable choice. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

// --- vm sandbox for behavioural tests -----------------------------------

function makeEl(extra = {}) {
  return Object.assign({
    innerHTML: '',
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    dataset: {},
    classList: { add() {}, remove() {}, contains: () => false },
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
  }, extra);
}

function makeContainer() {
  const els = {
    '#terminals-launch': makeEl(),
    '#terminals-launch-btn': makeEl(),
    '#terminals-launch-cancel': makeEl(),
    '#terminals-workspace': makeEl(),
    '#terminals-title': makeEl(),
    '#terminals-launch-error': makeEl(),
    '#terminals-executor': makeEl(),
    '#terminals-executor-hint': makeEl(),
    '#terminals-launch button[type="submit"]': makeEl({ disabled: false }),
  };
  return { els, querySelector: (sel) => els[sel] || null };
}

function loadTerminalsPage(api = {}) {
  const src = read('js/pages/terminals.js');
  const window = {};
  const document = { getElementById: () => makeEl() };
  const sandbox = {
    window, document, API: api, URLSearchParams,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  // The page reads its pane tree from the layout model, so the sandbox needs
  // both scripts, exactly as index.html loads them.
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  vm.runInNewContext(src, sandbox);
  return sandbox.window.TerminalsPage;
}

test('terminals.js has _renderExecutorOptions and the disabled/suffix markup', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /_renderExecutorOptions\(/);
  assert.match(src, /' disabled'/);
  assert.match(src, /\(not installed\)/);
  assert.match(src, /\(Guard not enabled\)/);
});

test('terminals.js _launchable treats missing installed/governed keys as launchable', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /e\.installed !== false && e\.governed !== false/);
});

test('terminals.js onsubmit refuses only a not-installed executor (an ungoverned one still launches)', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /!chosen \|\| chosen\.installed === false/);
});

test('styles.css defines .terminals-executor-hint', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-executor-hint/);
});

test('index.html pins the bumped executor cache versions', () => {
  const html = read('index.html');
  assert.match(html, /terminals\.js\?v=41/);
  assert.match(html, /styles\.css\?v=421/);
});

test('no em dash in the executor-hint UI strings', () => {
  const src = read('js/pages/terminals.js');
  const idx = src.indexOf('_renderExecutorOptions');
  assert.ok(idx >= 0, '_renderExecutorOptions must exist');
  assert.ok(!/—/.test(src.slice(idx)), 'no em dash (U+2014) after _renderExecutorOptions');
});

test('_renderExecutorOptions: all launchable selects the first option and enables submit', () => {
  const Page = loadTerminalsPage();
  const container = makeContainer();
  Page._executors = [
    { id: 'claude-code', label: 'Claude Code', installed: true, governed: true, hint: '' },
    { id: 'codex', label: 'Codex', installed: true, governed: true, hint: '' },
  ];
  Page._renderExecutorOptions(container);

  const sel = container.els['#terminals-executor'];
  const submit = container.els['#terminals-launch button[type="submit"]'];
  const hint = container.els['#terminals-executor-hint'];
  assert.strictEqual(sel.value, 'claude-code');
  assert.strictEqual(submit.disabled, false);
  assert.ok(!sel.innerHTML.includes('disabled'), 'no option should be disabled');
  assert.strictEqual(hint.hidden, true, 'no hint text means the hint stays hidden');
});

test('_renderExecutorOptions: mixed availability disables only the not-installed option, keeps an ungoverned one selectable, picks the first launchable', () => {
  const Page = loadTerminalsPage();
  const container = makeContainer();
  Page._executors = [
    { id: 'claude-code', label: 'Claude Code', installed: false, governed: true, hint: 'Install Claude Code to launch tasks with it.' },
    { id: 'codex', label: 'Codex', installed: true, governed: false, hint: 'Enable the Codex Guard plugin in Integrations before launching a task.' },
    { id: 'copilot-cli', label: 'GitHub Copilot CLI', installed: true, governed: true, hint: '' },
  ];
  Page._renderExecutorOptions(container);

  const sel = container.els['#terminals-executor'];
  const submit = container.els['#terminals-launch button[type="submit"]'];
  const hint = container.els['#terminals-executor-hint'];

  assert.match(sel.innerHTML, /value="claude-code" disabled>Claude Code \(not installed\)/);
  assert.match(sel.innerHTML, /value="codex">Codex \(Guard not enabled\)/, 'installed but ungoverned stays selectable, not disabled');
  assert.doesNotMatch(sel.innerHTML, /value="codex" disabled/);
  assert.doesNotMatch(sel.innerHTML, /value="copilot-cli" disabled/);
  assert.strictEqual(sel.value, 'copilot-cli', 'the first launchable executor must be selected');
  assert.strictEqual(submit.disabled, false);

  // Switch to the ungoverned option: it can still launch (ungoverned), and
  // the plain hint stays hidden because the guard row (tested separately)
  // takes over.
  sel.value = 'codex';
  sel.onchange();
  assert.strictEqual(submit.disabled, false, 'an installed harness can launch even when its Guard is not enabled');
  assert.strictEqual(hint.hidden, true);
});

test('_renderExecutorOptions: nothing installed disables submit and shows the fallback text', () => {
  const Page = loadTerminalsPage();
  const container = makeContainer();
  Page._executors = [
    { id: 'claude-code', label: 'Claude Code', installed: false, governed: true, hint: 'Install Claude Code to launch tasks with it.' },
    { id: 'codex', label: 'Codex', installed: false, governed: false, hint: 'Install Codex to launch tasks with it.' },
  ];
  Page._renderExecutorOptions(container);

  const submit = container.els['#terminals-launch button[type="submit"]'];
  const hint = container.els['#terminals-executor-hint'];
  assert.strictEqual(submit.disabled, true);
  assert.strictEqual(hint.hidden, false);
  assert.strictEqual(hint.textContent, 'No harness is ready to launch. Install one and enable its Guard plugin in Integrations.');
});

test('_renderExecutorOptions: an installed-but-ungoverned executor is the only option, is auto-selected, and submit is enabled', () => {
  const Page = loadTerminalsPage();
  const container = makeContainer();
  Page._executors = [
    { id: 'codex', label: 'Codex', installed: true, governed: false, hint: 'Enable the Codex Guard plugin in Integrations before launching a task.' },
  ];
  Page._renderExecutorOptions(container);

  const sel = container.els['#terminals-executor'];
  const submit = container.els['#terminals-launch button[type="submit"]'];
  assert.strictEqual(sel.value, 'codex', 'falls back to the only installed executor when none is fully governed');
  assert.strictEqual(submit.disabled, false);
});

test('form.onsubmit refuses a not-installed executor and shows its hint as the error', async () => {
  const Page = loadTerminalsPage();
  const container = makeContainer();
  Page._executors = [
    { id: 'claude-code', label: 'Claude Code', installed: false, governed: true, hint: 'Install Claude Code to launch tasks with it.' },
    { id: 'codex', label: 'Codex', installed: true, governed: false, hint: 'Enable the Codex Guard plugin in Integrations before launching a task.' },
  ];
  Page._bindLaunchForm(container);

  const sel = container.els['#terminals-executor'];
  const err = container.els['#terminals-launch-error'];
  const workspace = container.els['#terminals-workspace'];
  sel.value = 'claude-code';
  workspace.value = '/tmp/some/project';

  const form = container.els['#terminals-launch'];
  let prevented = false;
  await form.onsubmit({ preventDefault: () => { prevented = true; } });

  assert.ok(prevented);
  assert.strictEqual(err.hidden, false);
  assert.strictEqual(err.textContent, 'Install Claude Code to launch tasks with it.');
});

test('form.onsubmit still launches an installed-but-ungoverned executor', async () => {
  let launchCalls = 0;
  const api = { terminalsLaunch: async (id) => { launchCalls++; return { id: 'task-1', executor_id: id }; } };
  const Page = loadTerminalsPage(api);
  const container = makeContainer();
  Page._executors = [
    { id: 'codex', label: 'Codex', installed: true, governed: false, hint: 'Enable the Codex Guard plugin in Integrations before launching a task.' },
  ];
  Page._bindLaunchForm(container);
  Page._refreshTasks = async () => {};
  Page._attach = () => {};

  const sel = container.els['#terminals-executor'];
  const workspace = container.els['#terminals-workspace'];
  sel.value = 'codex';
  workspace.value = '/tmp/some/project';

  const form = container.els['#terminals-launch'];
  let prevented = false;
  await form.onsubmit({ preventDefault: () => { prevented = true; } });

  assert.ok(prevented);
  assert.strictEqual(launchCalls, 1);
});

test('rejected executors fetch: submit stays disabled, the fallback hint shows, and submit never calls API.terminalsLaunch', async () => {
  let launchCalls = 0;
  const api = { terminalsLaunch: async () => { launchCalls++; return { id: 'task-1' }; } };
  const Page = loadTerminalsPage(api);
  const container = makeContainer();

  // Simulate the render() catch path: the executors fetch rejected, so
  // _executors is reset to [] and _renderExecutorOptions is re-run.
  Page._executors = [];
  Page._renderExecutorOptions(container);

  const submit = container.els['#terminals-launch button[type="submit"]'];
  const hint = container.els['#terminals-executor-hint'];
  assert.strictEqual(submit.disabled, true);
  assert.strictEqual(hint.hidden, false);
  assert.strictEqual(hint.textContent, 'No harness is ready to launch. Install one and enable its Guard plugin in Integrations.');

  Page._bindLaunchForm(container);
  const workspace = container.els['#terminals-workspace'];
  workspace.value = '/tmp/some/project';
  const err = container.els['#terminals-launch-error'];
  const form = container.els['#terminals-launch'];
  let prevented = false;
  await form.onsubmit({ preventDefault: () => { prevented = true; } });

  assert.ok(prevented);
  assert.strictEqual(launchCalls, 0, 'a submit attempt with no launchable executor must never call API.terminalsLaunch');
  assert.strictEqual(err.hidden, false);
  assert.strictEqual(err.textContent, 'This harness is not ready to launch.');
});
