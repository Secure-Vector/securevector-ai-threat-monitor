/** The in-session Guard banner: a task may launch before its Guard plugin is
 * installed, so the attached session says so until the Guard reports in, and
 * offers the install in place. DOM stub mirrors terminals_pane.test.js. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

function makeEl(extra = {}) {
  const classes = new Set();
  return Object.assign({
    innerHTML: '',
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    dataset: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
    isConnected: true,
  }, extra);
}

function bannerElements() {
  return {
    'terminals-guard-banner': makeEl({ hidden: true }),
    'terminals-guard-banner-text': makeEl(),
    'terminals-guard-banner-install': makeEl({ hidden: false }),
    'terminals-guard-banner-recheck': makeEl({ hidden: true }),
    'terminals-guard-banner-commands': makeEl({ hidden: true }),
    'terminals-guard-banner-restart': makeEl({ hidden: true }),
  };
}

function loadTerminalsPage(elements, api = {}) {
  const src = read('js/pages/terminals.js');
  const window = {};
  const document = { getElementById: (id) => elements[id] || makeEl() };
  const sandbox = {
    window, document, API: api, URLSearchParams,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console: { warn() {}, error() {} },
  };
  // The page reads its pane tree from the layout model, so the sandbox needs
  // both scripts, exactly as index.html loads them.
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  vm.runInNewContext(src, sandbox);
  return sandbox.window.TerminalsPage;
}

function attach(Page, task, executor) {
  Page._tasks = [task];
  Page._attached = task.id;
  Page._executors = executor ? [executor] : [];
}

const RUNNING_TASK = { id: 't1', executor_id: 'codex', status: 'working', session_id: null };
const CODEX_UNGOVERNED = { id: 'codex', label: 'Codex', installed: true, governed: false, hint: 'x' };
const CODEX_GOVERNED = { id: 'codex', label: 'Codex', installed: true, governed: true, hint: '' };

test('the attached view template ships the guard banner elements', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /id="terminals-guard-banner"[^>]*hidden/);
  assert.match(src, /id="terminals-guard-banner-text"/);
  assert.match(src, /id="terminals-guard-banner-install"/);
  assert.match(src, /id="terminals-guard-banner-recheck"[^>]*hidden/);
  assert.match(src, /id="terminals-guard-banner-commands"[^>]*hidden/);
  // It sits directly after the approvals strip, inside the attached pane.
  assert.match(src, /id="terminals-attention"[\s\S]{0,120}id="terminals-guard-banner"/);
});

test('an ungoverned running task gets the loud banner and the install action', () => {
  const els = bannerElements();
  const Page = loadTerminalsPage(els);
  attach(Page, RUNNING_TASK, CODEX_UNGOVERNED);

  Page._renderGuardBanner();

  const banner = els['terminals-guard-banner'];
  assert.strictEqual(banner.hidden, false);
  assert.strictEqual(banner.classList.contains('is-pending'), false);
  assert.strictEqual(
    els['terminals-guard-banner-text'].textContent,
    'This task is running without SecureVector Guard for Codex. Nothing is being checked, recorded, or held for approval.',
  );
  assert.strictEqual(els['terminals-guard-banner-install'].hidden, false);
  assert.strictEqual(els['terminals-guard-banner-recheck'].hidden, true);
});

test('an installed Guard the session has not loaded yet gets the pending banner and Check again', () => {
  const els = bannerElements();
  const Page = loadTerminalsPage(els);
  attach(Page, RUNNING_TASK, CODEX_GOVERNED);

  Page._renderGuardBanner();

  const banner = els['terminals-guard-banner'];
  assert.strictEqual(banner.hidden, false);
  assert.strictEqual(banner.classList.contains('is-pending'), true);
  assert.strictEqual(
    els['terminals-guard-banner-text'].textContent,
    'SecureVector Guard installed. This session started before it, so restart the harness to load it.',
  );
  assert.strictEqual(els['terminals-guard-banner-install'].hidden, true);
  assert.strictEqual(els['terminals-guard-banner-recheck'].hidden, false);
});

test('Claude Code names /reload-plugins rather than a restart', () => {
  const els = bannerElements();
  const Page = loadTerminalsPage(els);
  attach(Page,
    { id: 't2', executor_id: 'claude-code', status: 'idle', session_id: null },
    { id: 'claude-code', label: 'Claude Code', installed: true, governed: true, hint: '' });

  Page._renderGuardBanner();

  assert.strictEqual(els['terminals-guard-banner-text'].textContent,
    'SecureVector Guard installed. This session started before it, so run /reload-plugins in the terminal, or restart the harness.');
});

test('the banner hides once the Guard reports in, and for a finished task', () => {
  const els = bannerElements();
  const Page = loadTerminalsPage(els);

  attach(Page, { ...RUNNING_TASK, session_id: 'sess-1' }, CODEX_UNGOVERNED);
  Page._renderGuardBanner();
  assert.strictEqual(els['terminals-guard-banner'].hidden, true, 'a session id means the Guard is governing');

  attach(Page, { ...RUNNING_TASK, status: 'done' }, CODEX_UNGOVERNED);
  Page._renderGuardBanner();
  assert.strictEqual(els['terminals-guard-banner'].hidden, true, 'a finished task cannot be governed any more');

  Page._tasks = [];
  Page._attached = null;
  Page._renderGuardBanner();
  assert.strictEqual(els['terminals-guard-banner'].hidden, true, 'nothing attached, nothing to say');
});

test('Install SecureVector Guard installs for the attached task executor and refetches', async () => {
  const els = bannerElements();
  let installedFor = null;
  let refetched = 0;
  const api = {
    installGuard: async (id) => { installedFor = id; return { ok: true, auto_installed: true, commands: [] }; },
    terminalsExecutors: async () => { refetched += 1; return { items: [CODEX_GOVERNED] }; },
  };
  const Page = loadTerminalsPage(els, api);
  attach(Page, RUNNING_TASK, CODEX_UNGOVERNED);
  Page._renderGuardBanner();

  await els['terminals-guard-banner-install'].onclick();

  assert.strictEqual(installedFor, 'codex');
  assert.strictEqual(refetched, 1);
  assert.deepStrictEqual(Page._executors, [CODEX_GOVERNED]);
  assert.strictEqual(els['terminals-guard-banner'].classList.contains('is-pending'), true,
    'a successful install moves the banner to the load-it state');
  assert.strictEqual(els['terminals-guard-banner-recheck'].hidden, false);
});

test('a manual install shows the paste-in commands in the banner and survives a re-render', async () => {
  const els = bannerElements();
  const api = {
    installGuard: async () => ({ ok: true, auto_installed: false, commands: ['sv hooks install codex'] }),
    terminalsExecutors: async () => ({ items: [CODEX_UNGOVERNED] }),
  };
  const Page = loadTerminalsPage(els, api);
  attach(Page, RUNNING_TASK, CODEX_UNGOVERNED);
  Page._renderGuardBanner();

  await els['terminals-guard-banner-install'].onclick();

  const commands = els['terminals-guard-banner-commands'];
  assert.strictEqual(commands.hidden, false);
  assert.strictEqual(commands.textContent, 'sv hooks install codex');
  assert.match(els['terminals-guard-banner-text'].textContent, /Finish in Codex: run the commands below, then click Check again\./);
  assert.strictEqual(els['terminals-guard-banner-install'].hidden, true);
  assert.strictEqual(els['terminals-guard-banner-recheck'].hidden, false);

  // The 3 s poll re-renders; the commands must still be there.
  Page._renderGuardBanner();
  assert.strictEqual(commands.hidden, false);
});

test('an install error shows the message in the banner and re-enables the button', async () => {
  const els = bannerElements();
  const api = { installGuard: async () => { throw new Error('Guard install failed (500)'); } };
  const Page = loadTerminalsPage(els, api);
  attach(Page, RUNNING_TASK, CODEX_UNGOVERNED);
  Page._renderGuardBanner();

  await els['terminals-guard-banner-install'].onclick();

  assert.strictEqual(els['terminals-guard-banner-text'].textContent, 'Guard install failed (500)');
  const install = els['terminals-guard-banner-install'];
  assert.strictEqual(install.hidden, false);
  assert.strictEqual(install.disabled, false);
  assert.strictEqual(install.textContent, 'Install SecureVector Guard');
});

test('Check again refetches executors and tasks, then re-renders', async () => {
  const els = bannerElements();
  let executorCalls = 0;
  let taskCalls = 0;
  const api = {
    terminalsExecutors: async () => { executorCalls += 1; return { items: [CODEX_GOVERNED] }; },
    terminalsTasks: async () => { taskCalls += 1; return { items: [RUNNING_TASK], running: 1 }; },
  };
  const Page = loadTerminalsPage(els, api);
  attach(Page, RUNNING_TASK, CODEX_UNGOVERNED);
  Page._renderGuardBanner();
  const recheckClick = () => els['terminals-guard-banner-recheck'].onclick;

  // The ungoverned state hides Check again; drive the pending state first.
  Page._guardBannerPending = { executorId: 'codex', text: 'Finish in Codex', commands: ['x'] };
  Page._guardBannerSig = null;
  Page._renderGuardBanner();
  assert.strictEqual(els['terminals-guard-banner-recheck'].hidden, false);

  await recheckClick()();

  assert.strictEqual(executorCalls, 1);
  assert.strictEqual(taskCalls, 1);
  assert.strictEqual(els['terminals-guard-banner'].classList.contains('is-pending'), true);
});

test('styles.css carries the banner rule and the full-width launch form rows', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-guard-banner\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.terminals-guard-banner\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.terminals-guard-banner\.is-pending\s*\{/);
  // The launch form is a grid: a one-line error must not be squeezed into
  // one narrow cell.
  assert.match(css, /\.terminals-launch-error[^{]*\{[^}]*grid-column:\s*1 \/ -1/);
  assert.match(css, /\.terminals-launch-error\s*\{[^}]*white-space:\s*normal/);
});

test('a hidden button is really hidden, and Install never keeps its Installing label', () => {
  const css = fs.readFileSync(path.join(WEB, 'css', 'styles.css'), 'utf8');
  assert.match(css, /\.btn\[hidden\] \{ display: none; \}/,
    'the btn class sets display, which beats the UA rule for [hidden]');
  assert.ok(css.indexOf('.btn[hidden] { display: none; }') < css.indexOf('\n.btn {'),
    'and the rule has to be defined alongside the class it corrects');

  const src = fs.readFileSync(path.join(WEB, 'js', 'pages', 'terminals.js'), 'utf8');
  assert.match(src, /_resetInstallButton\(install\) \{\s*\n\s*install\.hidden = true;\s*\n\s*install\.disabled = false;\s*\n\s*install\.textContent = 'Install SecureVector Guard';/,
    'putting the button away has to restore its label and re-enable it');
  assert.doesNotMatch(src, /if \(install\) install\.hidden = true;/,
    'nothing may hide the Install button without resetting it');
});

test('a task launched with the Guard already in place shows no restart banner', () => {
  const els = bannerElements();
  const Page = loadTerminalsPage(els);
  // No session id yet: the first tool call has not happened. The task was
  // still spawned governed, so there is no ungoverned window to warn about.
  attach(Page, { ...RUNNING_TASK, session_id: null, governed_at_launch: true }, CODEX_GOVERNED);

  Page._renderGuardBanner();

  assert.strictEqual(els['terminals-guard-banner'].hidden, true,
    'a governed launch must not be told to restart the harness it just started');
});

test('Check again says what it found, so an unchanged banner does not look like a dead button', async () => {
  const els = bannerElements();
  const Page = loadTerminalsPage(els, {
    terminalsExecutors: async () => ({ items: [CODEX_GOVERNED] }),
    terminalsTasks: async () => ({ items: [RUNNING_TASK] }),
  });
  attach(Page, RUNNING_TASK, CODEX_GOVERNED);
  // The real refresh repaints the whole page; the banner is what is under test.
  Page._refreshTasks = async () => {};
  Page._renderGuardBanner();

  await Page._recheckGuardFromBanner();

  assert.match(els['terminals-guard-banner-text'].textContent,
    /Checked just now: no call from this session yet\.$/,
    'the check is about the session, and it has to report its result');
  assert.strictEqual(els['terminals-guard-banner-recheck'].disabled, false,
    'and the button comes back ready to be pressed again');
});
