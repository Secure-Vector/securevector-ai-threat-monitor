/** Task controls that used to hand the operator off to the OS or to a dead
 * end: restarting a harness that has not loaded its Guard, and removing a task
 * from the board. Both now resolve inside the page. Plus the live marker,
 * which is the one moving element on the rail and means exactly one thing.
 */
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
    className: '',
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

/** setTimeout fires on the next microtask turn so the restart poll and the
 *  remove-confirm timeout run to completion without real waiting. */
function fastTimers() {
  const pending = [];
  return {
    setTimeout: (fn) => { pending.push(fn); return pending.length; },
    clearTimeout: () => {},
    flush: () => { while (pending.length) pending.shift()(); },
    pending,
  };
}

function loadPage(elements, api = {}, timers = fastTimers()) {
  const src = read('js/pages/terminals.js');
  const window = {};
  const sandbox = {
    window,
    document: { getElementById: (id) => elements[id] || (elements[id] = makeEl()) },
    API: api,
    URLSearchParams,
    WebSocket: { OPEN: 1, CLOSED: 3 },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimeout: () => timers.clearTimeout(),
    console: { warn() {}, error() {} },
  };
  // The page reads its pane tree from the layout model, so the sandbox needs
  // both scripts, exactly as index.html loads them.
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  vm.runInNewContext(src, sandbox);
  return { Page: sandbox.window.TerminalsPage, timers };
}

// -------------------------------------------------------- restart harness

const PENDING_TASK = {
  id: 't1', executor_id: 'codex', status: 'working', session_id: null,
  workspace: '/w', title: 'Ship it',
};

function bannerEls() {
  return {
    'terminals-guard-banner': makeEl({ hidden: true }),
    'terminals-guard-banner-text': makeEl(),
    'terminals-guard-banner-install': makeEl({ hidden: false }),
    'terminals-guard-banner-recheck': makeEl({ hidden: true }),
    'terminals-guard-banner-restart': makeEl({ hidden: true }),
    'terminals-guard-banner-commands': makeEl({ hidden: true }),
  };
}

test('the Restart harness button ships hidden and appears only in the pending state', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /id="terminals-guard-banner-restart"[^>]*hidden/,
    'the button ships hidden in the template');

  for (const [governed, expected] of [[true, false], [false, true]]) {
    const els = bannerEls();
    const { Page } = loadPage(els);
    Page._tasks = [PENDING_TASK];
    Page._attached = PENDING_TASK.id;
    Page._executors = [{ id: 'codex', label: 'Codex', installed: true, governed }];
    Page._renderGuardBanner();
    assert.strictEqual(els['terminals-guard-banner-restart'].hidden, expected,
      governed ? 'installed but not loaded: offer the restart'
        : 'not installed yet: install first, there is nothing to load');
  }
});

test('restarting stops the task, waits for it to leave the running statuses, then relaunches it unchanged', async () => {
  const els = bannerEls();
  const calls = [];
  let statusReads = 0;
  const api = {
    terminalsStop: async (id) => { calls.push(['stop', id]); },
    terminalsTasks: async () => {
      statusReads += 1;
      // Still winding down on the first read, gone by the second.
      return { items: [{ ...PENDING_TASK, status: statusReads < 2 ? 'working' : 'done' }] };
    },
    terminalsLaunch: async (ex, ws, title) => {
      calls.push(['launch', ex, ws, title]);
      return { id: 't2' };
    },
  };
  const { Page, timers } = loadPage(els, api);
  Page._tasks = [PENDING_TASK];
  Page._attached = PENDING_TASK.id;
  Page._executors = [{ id: 'codex', label: 'Codex', installed: true, governed: true }];
  const attached = [];
  Page._refreshTasks = async () => { calls.push(['refresh']); };
  Page._attach = (id) => attached.push(id);

  const done = Page._restartHarnessFromBanner();
  // Drain the poll's sleeps; each flush releases one 500 ms wait.
  for (let i = 0; i < 6; i += 1) { await Promise.resolve(); timers.flush(); await Promise.resolve(); }
  await done;

  assert.deepStrictEqual(calls, [
    ['stop', 't1'],
    ['launch', 'codex', '/w', 'Ship it'],
    ['refresh'],
  ], 'stop, then launch with the same harness, folder and title');
  assert.ok(statusReads >= 2, 'the poll waits for the old process to be gone');
  assert.deepStrictEqual(attached, ['t2'], 'the fresh task is attached');
});

test('a failed restart surfaces in the banner text and re-arms the button', async () => {
  const els = bannerEls();
  const { Page, timers } = loadPage(els, {
    terminalsStop: async () => { throw new Error('Task is gone.'); },
  });
  Page._tasks = [PENDING_TASK];
  Page._attached = PENDING_TASK.id;

  const done = Page._restartHarnessFromBanner();
  timers.flush();
  await done;

  assert.strictEqual(els['terminals-guard-banner-text'].textContent, 'Task is gone.');
  assert.strictEqual(els['terminals-guard-banner-restart'].disabled, false);
  assert.strictEqual(els['terminals-guard-banner-restart'].textContent, 'Restart harness');
});

test('restart and the card Relaunch share one code path, and restart keeps its pane', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /_relaunchTask\(task, \{ stopFirst = false, pane = null \} = \{\}\)/);
  assert.match(src, /await this\._relaunchTask\(t, \{ stopFirst: true, pane: paneId \}\)/,
    'a restart has to come back in the pane whose banner asked for it');
  assert.match(src, /_claimPane\(taskId, paneId, group = 'replace', swapFor = null\) \{/,
    'and the pane is claimed by name, not by whichever one holds the focus');
  assert.strictEqual((src.match(/API\.terminalsLaunch\(/g) || []).length, 2,
    'one launch call in the shared helper, one in the launch form');
});

// --------------------------------------------------------- remove confirm

test('terminals.js never hands the operator a native dialog', () => {
  const src = read('js/pages/terminals.js');
  assert.ok(!/window\.confirm|window\.alert/.test(src),
    'a native dialog freezes the window, cannot be styled, and cannot be tested');
});

function cardEls(store) {
  const list = makeEl({
    querySelectorAll: (sel) => (store.handlers[sel] || []),
  });
  return { 'terminals-task-list': list };
}

/** Drive the card list through its real render: capture the markup it writes
 *  and hand back stub buttons keyed by the selectors the page binds. */
function renderCards(Page, els, store) {
  const captured = { html: '' };
  els['terminals-task-list'].innerHTML = '';
  Object.defineProperty(els['terminals-task-list'], 'innerHTML', {
    configurable: true,
    get: () => captured.html,
    set: (v) => { captured.html = v; },
  });
  Page._renderTaskList();
  return captured.html;
}

const DONE_TASK = {
  id: 'd1', executor_id: 'codex', status: 'done', session_id: 's1',
  workspace: '/w', title: 'Old run',
};

function removeHarness(api = {}) {
  const store = { handlers: {} };
  const els = cardEls(store);
  const { Page, timers } = loadPage(els, Object.assign({ terminalsArchive: async () => {} }, api));
  Page._tasks = [DONE_TASK];
  Page._attached = null;
  return { Page, els, store, timers };
}

test('the first click on Remove arms an in-card confirmation and archives nothing', async () => {
  let archived = 0;
  const { Page, els, timers } = removeHarness({ terminalsArchive: async () => { archived += 1; } });

  const before = renderCards(Page, els);
  assert.match(before, /data-remove-id="d1"/);
  assert.ok(!/terminals-task-confirm/.test(before));

  Page._askRemove({ dataset: { removeId: 'd1' } });

  const after = els['terminals-task-list'].innerHTML;
  assert.match(after, /terminals-task-confirm/);
  assert.match(after, /Remove from the board\? Its audit trace is kept\./);
  assert.match(after, /data-confirm-remove-id="d1"/);
  assert.match(after, /data-cancel-remove-id="d1"/);
  assert.ok(!/data-remove-id="d1"/.test(after), 'the plain Remove button is replaced while armed');
  assert.strictEqual(archived, 0, 'arming the confirmation must not archive anything');
});

test('Keep restores the button, and so does the timeout', () => {
  const { Page, els, timers } = removeHarness();
  renderCards(Page, els);

  Page._askRemove({ dataset: { removeId: 'd1' } });
  Page._closeRemoveConfirm();
  assert.match(els['terminals-task-list'].innerHTML, /data-remove-id="d1"/);
  assert.ok(!/terminals-task-confirm/.test(els['terminals-task-list'].innerHTML));

  Page._askRemove({ dataset: { removeId: 'd1' } });
  assert.match(els['terminals-task-list'].innerHTML, /terminals-task-confirm/);
  timers.flush();
  assert.match(els['terminals-task-list'].innerHTML, /data-remove-id="d1"/,
    'a forgotten confirmation disarms itself');
});

test('only one card can be armed at a time', () => {
  const { Page, els } = removeHarness();
  Page._tasks = [DONE_TASK, { ...DONE_TASK, id: 'd2', title: 'Other run' }];
  renderCards(Page, els);

  Page._askRemove({ dataset: { removeId: 'd1' } });
  Page._askRemove({ dataset: { removeId: 'd2' } });

  const html = els['terminals-task-list'].innerHTML;
  assert.strictEqual((html.match(/terminals-task-confirm"/g) || []).length, 1);
  assert.match(html, /data-confirm-remove-id="d2"/);
  assert.match(html, /data-remove-id="d1"/, 'the first card goes back to its plain button');
});

test('the confirm control archives the task and does not open the card it sits in', () => {
  const src = read('js/pages/terminals.js');
  const fn = src.slice(src.indexOf("el.querySelectorAll('[data-confirm-remove-id]')"),
    src.indexOf('REMOVE_CONFIRM_MS'));
  assert.match(fn, /ev\.stopPropagation\(\)/, 'the click must not reach the card open handler');
  // The archive itself moved into _removeFromBoard so the card and the linked
  // pane cannot drift apart on what removal means. Follow it there.
  assert.match(fn, /this\._removeFromBoard\(task\.id\)/);
  const shared = src.slice(src.indexOf('async _removeFromBoard(taskId) {'));
  assert.match(shared.slice(0, 700), /API\.terminalsArchive\(taskId\)/);
  assert.match(shared.slice(0, 700), /this\._refreshTasks\(\)/);
  assert.match(src, /REMOVE_CONFIRM_MS: 6000/, 'the timeout is a named constant, not a literal in the timer');
  assert.match(src, /\.terminals-task-confirm|terminals-task-confirm/);
  const confirmSpan = src.slice(src.indexOf("el.querySelectorAll('.terminals-task-confirm')"));
  assert.match(confirmSpan.slice(0, 200), /ev\.stopPropagation\(\)/,
    'the confirm span itself swallows clicks');
});

test('the confirm control carries its own styles, danger colour on the destructive half only', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-task-confirm \{[^}]*inline-flex/);
  assert.match(css, /\.terminals-task-confirm-yes[^{]*\{[^}]*#fca5a5/);
  assert.match(css, /\.terminals-task-confirm-no \{[^}]*--text-muted/);
  assert.match(css, /\[data-theme="light"\] \.terminals-task-confirm-yes \{[^}]*#b91c1c/);
  assert.match(css, /\.terminals-task-confirm-yes, \.terminals-task-confirm-no \{[^}]*background: transparent/);
});

// ------------------------------------------------------------ live marker

test('the rail marks a live task, and only a live task', () => {
  const src = read('js/components/sidebar.js');
  const at = src.indexOf("text.className = 'nav-task-text'");
  const fn = src.slice(at, at + 900);
  assert.match(fn, /view\.state === 'active'/, 'the marker is gated on the live state');
  assert.match(fn, /nav-task-live/);
  assert.match(fn, /createElement\('i'\)/, 'built as an element, never injected as markup');
  assert.match(fn, /aria-hidden/, 'decorative to assistive tech; the subtitle already says the state');
});

test('the pane tab carries the same marker for a running task', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /terminals-pane-live/);
  assert.match(src, /st\.kind === 'active' \? '<i class="terminals-pane-live"/);
});

test('the live marker animates, stops for reduced motion, and reads in both themes', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.nav-task-live, \.terminals-pane-live \{[^}]*#22c55e/);
  assert.match(css, /@keyframes sv-nav-live/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.nav-task-live, \.terminals-pane-live \{ animation: none; \}/);
  assert.match(css, /\[data-theme="light"\] \.nav-task-live[^{]*\{[^}]*#16a34a/);
});

// ------------------------------------------- review fixes: launch guarding

/** Render the card list and hand back the Relaunch button the page bound,
 *  the way the real DOM would: the stub is rebuilt on every render, so a
 *  guard living on the button cannot survive a poll. */
function relaunchHarness(api) {
  const buttons = [];
  const els = {
    'terminals-task-list': makeEl({
      querySelectorAll: (sel) => {
        if (sel !== '[data-relaunch-id]') return [];
        if (!/data-relaunch-id="d1"/.test(els['terminals-task-list'].innerHTML)) return [];
        const b = makeEl({ dataset: { relaunchId: 'd1' } });
        buttons.push(b);
        return [b];
      },
    }),
  };
  const { Page, timers } = loadPage(els, api);
  Page._tasks = [{
    id: 'd1', executor_id: 'codex', status: 'done', session_id: 's1',
    workspace: '/w', title: 'Old run',
  }];
  Page._attached = null;
  return { Page, els, buttons, timers };
}

test('a second Relaunch click while the first is in flight launches nothing new', async () => {
  let launches = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const { Page, els, buttons } = relaunchHarness({
    terminalsLaunch: async () => { launches += 1; await gate; return { id: 'd2' }; },
  });
  Page._refreshTasks = async () => {};
  Page._attach = () => {};

  Page._renderTaskList();
  const first = buttons[buttons.length - 1];
  const inFlight = first.onclick({ stopPropagation() {} });
  await Promise.resolve();

  assert.strictEqual(Page._relaunchingId, 'd1', 'the in-flight id is held on the page');
  assert.match(els['terminals-task-list'].innerHTML, /terminals-task-relaunch[^>]*disabled/);
  assert.match(els['terminals-task-list'].innerHTML, /Launching…/);

  // The 3 s poll rebuilds the card; the rebuilt button must still refuse.
  Page._renderTaskList();
  const rebuilt = buttons[buttons.length - 1];
  assert.notStrictEqual(rebuilt, first, 'the poll really did hand back a new node');
  await rebuilt.onclick({ stopPropagation() {} });

  assert.strictEqual(launches, 1, 'exactly one launch, whatever the rebuilt DOM looks like');
  release();
  await inFlight;
  assert.strictEqual(Page._relaunchingId, null, 'the guard clears in finally');
  assert.match(els['terminals-task-list'].innerHTML, /data-relaunch-id="d1"/);
  assert.ok(!/Launching…/.test(els['terminals-task-list'].innerHTML));
});

test('a failed relaunch clears the guard and restores the button', async () => {
  const banners = [];
  const { Page, els, buttons } = relaunchHarness({
    terminalsLaunch: async () => { throw new Error('No slots left.'); },
  });
  Page._banner = (m) => banners.push(m);

  Page._renderTaskList();
  await buttons[buttons.length - 1].onclick({ stopPropagation() {} });

  assert.deepStrictEqual(banners, ['No slots left.']);
  assert.strictEqual(Page._relaunchingId, null);
  assert.ok(!/Launching…/.test(els['terminals-task-list'].innerHTML),
    'the card must not be stuck in the launching state after a failure');
});

test('a restart that never stops the old task does not start a second one', async () => {
  const els = bannerEls();
  const calls = [];
  const api = {
    terminalsStop: async (id) => { calls.push(['stop', id]); },
    // The task stays running for the whole poll window.
    terminalsTasks: async () => ({ items: [{ ...PENDING_TASK, status: 'working' }] }),
    terminalsLaunch: async () => { calls.push(['launch']); return { id: 't2' }; },
  };
  const { Page, timers } = loadPage(els, api);
  Page._tasks = [PENDING_TASK];
  Page._attached = PENDING_TASK.id;
  Page._refreshTasks = async () => { calls.push(['refresh']); };
  Page._attach = () => { calls.push(['attach']); };

  const done = Page._restartHarnessFromBanner();
  for (let i = 0; i < 60; i += 1) { await Promise.resolve(); timers.flush(); await Promise.resolve(); }
  await done;

  assert.deepStrictEqual(calls, [['stop', 't1']],
    'two harnesses in one folder is worse than the ungoverned session; nothing is launched');
  assert.strictEqual(els['terminals-guard-banner-text'].textContent,
    'The task did not stop; try again.');
  assert.strictEqual(els['terminals-guard-banner-restart'].disabled, false,
    'the operator can try again');
  assert.strictEqual(els['terminals-guard-banner-restart'].textContent, 'Restart harness');
});
