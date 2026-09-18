/** The launch form's Guard install: an installed-but-ungoverned harness stays
 * selectable so the user can install its Guard plugin in place, instead of
 * being sent to Integrations. Mirrors the DOM stub in terminals_pane.test.js
 * and terminals_executors.test.js. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

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
    isConnected: true,
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
    '#terminals-guard-row': makeEl({ hidden: true }),
    '#terminals-guard-text': makeEl(),
    '#terminals-guard-install': makeEl({ hidden: false, disabled: false, textContent: 'Install SecureVector Guard' }),
    '#terminals-guard-recheck': makeEl({ hidden: true }),
    '#terminals-guard-commands': makeEl({ hidden: true }),
    isConnected: true,
  };
  const container = { els, isConnected: true, querySelector: (sel) => els[sel] || null };
  return container;
}

function loadTerminalsPage(api = {}) {
  const src = read('js/pages/terminals.js');
  const window = {};
  const document = { getElementById: () => makeEl() };
  const sandbox = {
    window, document, API: api, URLSearchParams,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  // The page reads its pane tree from the layout model, so the sandbox needs
  // both scripts, exactly as index.html loads them.
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  vm.runInNewContext(src, sandbox);
  return sandbox.window.TerminalsPage;
}

test('api.js installGuard posts to the per-harness install endpoint', () => {
  const src = read('js/api.js');
  const idx = src.indexOf('installGuard(');
  assert.ok(idx >= 0, 'API.installGuard must exist');
  const fn = src.slice(idx, idx + 400);
  assert.match(fn, /\/api\/hooks\/\$\{encodeURIComponent\(executorId\)\}\/install/);
  assert.match(fn, /method:\s*'POST'/);
});

test('the launch form template ships the guard row elements', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /id="terminals-guard-row"[^>]*hidden/);
  assert.match(src, /id="terminals-guard-text"/);
  assert.match(src, /id="terminals-guard-install"/);
  assert.match(src, /id="terminals-guard-recheck"[^>]*hidden/);
  assert.match(src, /id="terminals-guard-commands"[^>]*hidden/);
});

test('an installed-but-ungoverned executor stays selectable and submit is enabled (it launches ungoverned)', () => {
  const Page = loadTerminalsPage();
  const container = makeContainer();
  Page._executors = [
    { id: 'codex', label: 'Codex', installed: true, governed: false, hint: 'Enable the Codex Guard plugin in Integrations before launching a task.' },
  ];
  Page._renderExecutorOptions(container);

  const sel = container.els['#terminals-executor'];
  const submit = container.els['#terminals-launch button[type="submit"]'];
  const guardRow = container.els['#terminals-guard-row'];
  const guardText = container.els['#terminals-guard-text'];

  assert.doesNotMatch(sel.innerHTML, /value="codex" disabled/, 'installed but ungoverned must stay selectable');
  assert.strictEqual(sel.value, 'codex');
  assert.strictEqual(submit.disabled, false, 'an installed harness can launch even when its Guard is not enabled');
  assert.strictEqual(guardRow.hidden, false, 'the guard row shows for the selected ungoverned executor');
  assert.match(guardText.textContent, /SecureVector Guard is not enabled for Codex/);
  assert.match(guardText.textContent, /launches ungoverned/);
});

test('a not-installed executor keeps the disabled option, the plain hint, no guard row, and a disabled submit', () => {
  const Page = loadTerminalsPage();
  const container = makeContainer();
  Page._executors = [
    { id: 'claude-code', label: 'Claude Code', installed: false, governed: true, hint: 'Install Claude Code to launch tasks with it.' },
  ];
  Page._renderExecutorOptions(container);

  const sel = container.els['#terminals-executor'];
  const submit = container.els['#terminals-launch button[type="submit"]'];
  const hint = container.els['#terminals-executor-hint'];
  const guardRow = container.els['#terminals-guard-row'];
  assert.match(sel.innerHTML, /value="claude-code" disabled/);
  // With only a not-installed option in the list, nothing gets auto-selected
  // (the stub select does not simulate a real browser's disabled-only
  // selection); select it explicitly to check its own rendering.
  sel.value = 'claude-code';
  sel.onchange();
  assert.strictEqual(hint.hidden, false);
  assert.strictEqual(hint.textContent, 'Install Claude Code to launch tasks with it.');
  assert.strictEqual(guardRow.hidden, true);
  assert.strictEqual(submit.disabled, true, 'a harness that is not installed at all cannot launch');
});

test('installing the Guard with auto_installed and a governed refetch shows the ready message and enables submit', async () => {
  let installedFor = null;
  const api = {
    installGuard: async (id) => { installedFor = id; return { ok: true, auto_installed: true, commands: [] }; },
    terminalsExecutors: async () => ({ items: [{ id: 'codex', label: 'Codex', installed: true, governed: true, hint: '' }] }),
  };
  const Page = loadTerminalsPage(api);
  const container = makeContainer();
  Page._executors = [
    { id: 'codex', label: 'Codex', installed: true, governed: false, hint: 'Enable the Codex Guard plugin in Integrations before launching a task.' },
  ];
  Page._renderExecutorOptions(container);
  container.els['#terminals-executor'].value = 'codex';

  await Page._installGuard('codex', container);

  assert.strictEqual(installedFor, 'codex');
  const guardRow = container.els['#terminals-guard-row'];
  const guardText = container.els['#terminals-guard-text'];
  const submit = container.els['#terminals-launch button[type="submit"]'];
  assert.strictEqual(guardRow.hidden, false);
  assert.match(guardText.textContent, /SecureVector Guard enabled\. Codex is ready to launch\./);
  assert.strictEqual(submit.disabled, false);
});

test('a manual install shows the paste-in commands and reveals Check again', async () => {
  const api = {
    installGuard: async () => ({ ok: true, auto_installed: false, commands: ['sv hooks install codex', 'codex restart'], next_step: 'Restart the harness.' }),
    terminalsExecutors: async () => ({ items: [{ id: 'codex', label: 'Codex', installed: true, governed: false, hint: 'x' }] }),
  };
  const Page = loadTerminalsPage(api);
  const container = makeContainer();
  Page._executors = [{ id: 'codex', label: 'Codex', installed: true, governed: false, hint: 'x' }];
  Page._renderExecutorOptions(container);
  container.els['#terminals-executor'].value = 'codex';

  await Page._installGuard('codex', container);

  const commands = container.els['#terminals-guard-commands'];
  const recheck = container.els['#terminals-guard-recheck'];
  const install = container.els['#terminals-guard-install'];
  const guardText = container.els['#terminals-guard-text'];
  assert.strictEqual(commands.hidden, false);
  assert.strictEqual(commands.textContent, 'sv hooks install codex\ncodex restart');
  assert.strictEqual(recheck.hidden, false);
  assert.strictEqual(install.hidden, true);
  assert.match(guardText.textContent, /Restart the harness\./);
});

test('an install error surfaces the message and re-enables the button', async () => {
  const api = { installGuard: async () => { throw new Error('Guard install failed (500)'); } };
  const Page = loadTerminalsPage(api);
  const container = makeContainer();
  Page._executors = [{ id: 'codex', label: 'Codex', installed: true, governed: false, hint: 'x' }];
  Page._renderExecutorOptions(container);
  container.els['#terminals-executor'].value = 'codex';

  await Page._installGuard('codex', container);

  const guardText = container.els['#terminals-guard-text'];
  const install = container.els['#terminals-guard-install'];
  assert.strictEqual(guardText.textContent, 'Guard install failed (500)');
  assert.strictEqual(install.hidden, false);
  assert.strictEqual(install.disabled, false);
  assert.strictEqual(install.textContent, 'Install SecureVector Guard');
});

test('a launch submits for an installed-but-ungoverned executor (it runs ungoverned) and refuses a not-installed one', async () => {
  let launchCalls = 0;
  const api = { terminalsLaunch: async (id) => { launchCalls++; return { id: 't1', executor_id: id }; } };
  const Page = loadTerminalsPage(api);
  const container = makeContainer();
  Page._executors = [
    { id: 'codex', label: 'Codex', installed: true, governed: false, hint: 'Enable the Codex Guard plugin in Integrations before launching a task.' },
    { id: 'claude-code', label: 'Claude Code', installed: false, governed: true, hint: 'Install Claude Code to launch tasks with it.' },
  ];
  Page._bindLaunchForm(container);
  Page._refreshTasks = async () => {};
  Page._attach = () => {};
  container.els['#terminals-executor'].value = 'codex';
  container.els['#terminals-workspace'].value = '/tmp/proj';

  const form = container.els['#terminals-launch'];
  let prevented = false;
  await form.onsubmit({ preventDefault: () => { prevented = true; } });

  assert.ok(prevented);
  assert.strictEqual(launchCalls, 1, 'an installed harness must be able to launch even when its Guard is not enabled');

  container.els['#terminals-executor'].value = 'claude-code';
  const err = container.els['#terminals-launch-error'];
  err.hidden = true;
  await form.onsubmit({ preventDefault: () => { prevented = true; } });
  assert.strictEqual(launchCalls, 1, 'a not-installed harness never launches');
  assert.strictEqual(err.hidden, false);
});

test('index.html and pin assertions moved to the bumped versions', () => {
  const html = read('index.html');
  assert.match(html, /api\.js\?v=325/);
  assert.match(html, /terminals\.js\?v=37/);
  assert.match(html, /styles\.css\?v=411/);
});

test('the launch-form recheck reports a failed executors fetch and the ready timer is cancelled on harness change', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web', 'js', 'pages', 'terminals.js'), 'utf8');
  const recheck = src.slice(src.indexOf('async _recheckGuard('), src.indexOf('async _recheckGuard(') + 1400);
  assert.match(recheck, /\} catch \(e\) \{[\s\S]*?guardText\.textContent = e\.message/, 'a failed refetch must surface its message in the guard row');
  const ready = src.slice(src.indexOf('_renderGuardReady(container, label, autoHide) {'), src.indexOf('_renderGuardReady(container, label, autoHide) {') + 1200);
  assert.match(ready, /clearTimeout\(this\._guardReadyTimer\);\s*this\._guardReadyTimer = setTimeout/, 'the auto-hide timer is stored so it can be cancelled');
  const show = src.slice(src.indexOf('_showExecutorState(container) {'), src.indexOf('_showExecutorState(container) {') + 400);
  assert.match(show, /clearTimeout\(this\._guardReadyTimer\)/, 'changing harness cancels a pending auto-hide');
});
