/** Linking a harness session that runs outside the app: the launch form's
 * second mode, the unlinked-session picker, the linked chips, the terminal-less
 * attached stage, and the Guard banner rules for a session the app does not own.
 * Also the Tool calls list hygiene: session boundary rows are not tool calls.
 * DOM stub mirrors terminals_guard_banner.test.js. */
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
    setAttribute(name, v) { this[name] = v; },
    getAttribute(name) { return this[name]; },
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
    isConnected: true,
  }, extra);
}

/** A DOM where every id resolves to a stable stub, so a page method can look
 * up whatever it likes without the test having to enumerate the template. */
function makeDom(seed = {}) {
  const els = Object.assign({}, seed);
  const byId = (id) => {
    if (!els[id]) els[id] = makeEl();
    return els[id];
  };
  const container = makeEl({
    querySelector: (sel) => (sel.startsWith('#') ? byId(sel.slice(1)) : null),
    querySelectorAll: () => [],
  });
  const document = {
    getElementById: byId,
    querySelector: (sel) => (sel.startsWith('#') ? byId(sel.slice(1)) : makeEl()),
    createElement: () => makeEl(),
  };
  return { els, byId, container, document };
}

function loadPage(dom, api = {}, extras = {}) {
  const window = {};
  const sandbox = Object.assign({
    window, document: dom.document, API: api, URLSearchParams,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    console: { warn() {}, error() {} },
  }, extras);
  // The page reads its pane tree from the layout model, so the sandbox needs
  // both scripts, exactly as index.html loads them.
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  vm.runInNewContext(read('js/pages/terminals.js'), sandbox);
  const Page = sandbox.window.TerminalsPage;
  Page._container = dom.container;
  return Page;
}

const CODEX = { id: 'codex', label: 'Codex', installed: true, governed: true, hint: '' };
const CODEX_UNGOVERNED = { id: 'codex', label: 'Codex', installed: true, governed: false, hint: 'x' };

// --- launch form: the second mode ------------------------------------------

test('the launch form ships a mode toggle, a session id field, and an unlinked list', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /id="terminals-mode-launch"/);
  assert.match(src, /id="terminals-mode-link"/);
  assert.match(src, /Link a running session/);
  assert.match(src, /id="terminals-session-field"[^>]*hidden/);
  assert.match(src, /id="terminals-session-id"[^>]*placeholder="paste the harness session id"/);
  assert.match(src, /id="terminals-unlinked"[^>]*hidden/);
  assert.match(src, /id="terminals-launch-submit"/);
});

test('link mode shows the session field and the picker, and renames the submit', () => {
  const dom = makeDom();
  const Page = loadPage(dom, { terminalsUnlinkedSessions: async () => ({ items: [] }) });
  Page._executors = [CODEX];

  Page._setLaunchMode(dom.container, 'link');
  assert.strictEqual(Page._mode, 'link');
  assert.strictEqual(dom.byId('terminals-session-field').hidden, false);
  assert.strictEqual(dom.byId('terminals-unlinked').hidden, false);
  assert.strictEqual(dom.byId('terminals-launch-submit').textContent, 'Link session');
  assert.strictEqual(dom.byId('terminals-mode-link').classList.contains('is-active'), true);
  // Linking says nothing about how a task would launch, so the launch-time
  // Guard copy stays out of the way.
  assert.strictEqual(dom.byId('terminals-guard-row').hidden, true);

  Page._setLaunchMode(dom.container, 'launch');
  assert.strictEqual(dom.byId('terminals-session-field').hidden, true);
  assert.strictEqual(dom.byId('terminals-unlinked').hidden, true);
  assert.strictEqual(dom.byId('terminals-launch-submit').textContent, 'Launch task');
});

test('submitting in link mode calls terminalsLink with harness, session, folder, title', async () => {
  const dom = makeDom();
  let called = null;
  const Page = loadPage(dom, {
    terminalsLink: async (...args) => { called = args; return { id: 'L1' }; },
    terminalsTasks: async () => ({ items: [], running: 0 }),
    getJitRequests: async () => ({ items: [] }),
  });
  Page._executors = [CODEX];
  Page._mode = 'link';
  dom.byId('terminals-executor').value = 'codex';
  dom.byId('terminals-session-id').value = ' sess-abc12345 ';
  dom.byId('terminals-workspace').value = '/repo';
  dom.byId('terminals-title').value = 'Outside run';

  await Page._submitLink(dom.container);

  assert.deepStrictEqual(called, ['codex', 'sess-abc12345', '/repo', 'Outside run']);
  assert.strictEqual(dom.byId('terminals-launch').hidden, true);
});

test('link mode refuses an empty session id and surfaces a server error', async () => {
  const dom = makeDom();
  const Page = loadPage(dom, { terminalsLink: async () => { throw new Error('This session is already on the board.'); } });
  Page._executors = [CODEX];
  Page._mode = 'link';
  dom.byId('terminals-executor').value = 'codex';
  dom.byId('terminals-session-id').value = '';

  await Page._submitLink(dom.container);
  assert.strictEqual(dom.byId('terminals-launch-error').textContent, 'Paste the harness session id.');
  assert.strictEqual(dom.byId('terminals-launch-error').hidden, false);

  dom.byId('terminals-session-id').value = 'sess-abc12345';
  await Page._submitLink(dom.container);
  assert.strictEqual(dom.byId('terminals-launch-error').textContent, 'This session is already on the board.');
});

// --- the unlinked-session picker -------------------------------------------

test('the picker lists reported sessions and its Link button fills and submits', async () => {
  const buttons = [];
  const list = makeEl({ querySelectorAll: (sel) => (sel === '.terminals-unlinked-link' ? buttons : []) });
  const dom = makeDom({ 'terminals-unlinked': list });
  let linked = null;
  const Page = loadPage(dom, {
    terminalsUnlinkedSessions: async () => ({
      items: [{
        session_id: 'sess-abc12345', executor_id: 'codex', label: 'Codex',
        last_at: new Date(Date.now() - 2 * 60000).toISOString(), calls: 7, workspace: '/a/b/repo',
      }],
    }),
    terminalsLink: async (...args) => { linked = args; return { id: 'L1' }; },
    terminalsTasks: async () => ({ items: [], running: 0 }),
    getJitRequests: async () => ({ items: [] }),
  });
  Page._executors = [CODEX];
  Page._mode = 'link';
  buttons.push(makeEl({ dataset: { sessionId: 'sess-abc12345', executorId: 'codex', workspace: '/a/b/repo' } }));

  await Page._loadUnlinked();

  assert.match(list.innerHTML, /Codex/);
  assert.match(list.innerHTML, /sess-abc/, 'the row shows a short session id');
  assert.match(list.innerHTML, /2m ago/);
  assert.match(list.innerHTML, /7 calls/);
  assert.match(list.innerHTML, /terminals-unlinked-link/);

  await buttons[0].onclick();

  assert.deepStrictEqual(linked, ['codex', 'sess-abc12345', '/a/b/repo', '']);
});

test('the picker says so when nothing has been reported', async () => {
  const dom = makeDom();
  const Page = loadPage(dom, { terminalsUnlinkedSessions: async () => ({ items: [] }) });
  await Page._loadUnlinked();
  assert.match(dom.byId('terminals-unlinked').innerHTML,
    /No unlinked sessions reported in the last 24 hours\./);
});

// --- chips -----------------------------------------------------------------

test('a linked task carries a linked chip on the board and on the rail', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /origin === 'linked' \? '<span class="terminals-task-linked">linked<\/span>'/);
  const rail = read('js/components/sidebar.js');
  assert.match(rail, /nav-task-linked/);
  assert.match(rail, /linked: task\.origin === 'linked'/);
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-task-linked, \.nav-task-linked \{/);
});

// --- the attached stage ----------------------------------------------------

test('attaching a linked task renders the linked stage and opens no WebSocket', async () => {
  const dom = makeDom();
  let sockets = 0;
  const Page = loadPage(dom, {
    terminalsVerdicts: async () => ({ items: [], session_id: null }),
    getJitRequests: async () => ({ items: [] }),
    terminalsSocketUrl: () => 'ws://x',
  }, {
    WebSocket: function () { sockets += 1; },
  });
  Page._tasks = [{ id: 'L1', executor_id: 'codex', status: 'working', origin: 'linked', session_id: 'sess-abc12345', created_at: new Date().toISOString() }];

  await Page._attach('L1');

  assert.strictEqual(sockets, 0, 'there is no PTY behind a linked task');
  assert.strictEqual(Page._ws, null, 'the focused pane holds no socket');
  const stage = Page._panes.get(Page._focused).stageEl;
  assert.match(stage.innerHTML, /terminals-linked-stage/);
  assert.match(stage.innerHTML, /Runs outside SecureVector/);
  assert.match(stage.innerHTML, /This session was started in your own terminal\. There is no terminal here; governance is live\./);
});

test('the pane offers no Stop for a linked task', () => {
  const src = read('js/pages/terminals.js');
  const head = src.slice(src.indexOf('_renderAttachedHead() {'), src.indexOf('_renderPaneFoot() {'));
  assert.match(head, /t\.origin !== 'linked'/, 'Stop is gated on the app owning the process');
});

test('attaching an unknown task re-reads the board once, then says so without a socket', async () => {
  const dom = makeDom();
  let sockets = 0;
  let refetches = 0;
  const Page = loadPage(dom, {
    terminalsTasks: async () => { refetches += 1; return { items: [], running: 0 }; },
    terminalsVerdicts: async () => ({ items: [], session_id: null }),
    getJitRequests: async () => ({ items: [] }),
    terminalsSocketUrl: () => 'ws://x',
  }, { WebSocket: function () { sockets += 1; } });
  Page._tasks = [];

  await Page._attach('gone');

  assert.strictEqual(refetches, 1, 'the board is re-read exactly once before giving up');
  assert.strictEqual(sockets, 0, 'a task the board cannot describe never gets a socket');
  const banner = Page._panes.get(Page._focused).bannerEl;
  assert.strictEqual(banner.textContent, 'Task not found.', 'the pane that asked for it says so');
  assert.strictEqual(banner.hidden, false);
});

test('a stale board that the refetch fixes still attaches normally', async () => {
  const dom = makeDom();
  let sockets = 0;
  const fresh = { id: 'L9', executor_id: 'codex', status: 'working', origin: 'linked', session_id: 'sess-abc12345' };
  const Page = loadPage(dom, {
    terminalsTasks: async () => ({ items: [fresh], running: 1 }),
    terminalsVerdicts: async () => ({ items: [], session_id: null }),
    getJitRequests: async () => ({ items: [] }),
    terminalsSocketUrl: () => 'ws://x',
  }, { WebSocket: function () { sockets += 1; } });
  Page._tasks = [];

  await Page._attach('L9');

  assert.strictEqual(sockets, 0);
  assert.match(Page._panes.get(Page._focused).stageEl.innerHTML, /terminals-linked-stage/);
});

test('a second link submit is refused while the first is still in flight', async () => {
  const buttons = [makeEl({ dataset: {} })];
  const list = makeEl({ querySelectorAll: (sel) => (sel === '.terminals-unlinked-link' ? buttons : []) });
  const dom = makeDom({ 'terminals-unlinked': list });
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const Page = loadPage(dom, {
    terminalsLink: async () => { calls += 1; await gate; return { id: 'L1' }; },
    terminalsTasks: async () => ({ items: [], running: 0 }),
    getJitRequests: async () => ({ items: [] }),
    terminalsVerdicts: async () => ({ items: [], session_id: null }),
  });
  Page._executors = [CODEX];
  Page._mode = 'link';
  dom.byId('terminals-executor').value = 'codex';
  dom.byId('terminals-session-id').value = 'sess-abc12345';

  const first = Page._submitLink(dom.container);
  assert.strictEqual(dom.byId('terminals-launch-submit').disabled, true);
  assert.strictEqual(buttons[0].disabled, true, 'the picker cannot fire a second link either');

  await Page._submitLink(dom.container);
  assert.strictEqual(calls, 1, 'the second submit never reaches the API');

  release();
  await first;
  assert.strictEqual(dom.byId('terminals-launch-submit').disabled, false);
  assert.strictEqual(buttons[0].disabled, false);
  assert.strictEqual(Page._linking, false);
});

// --- the Guard banner on a linked session ----------------------------------

function bannerDom() {
  return makeDom({
    'terminals-guard-banner': makeEl({ hidden: true }),
    'terminals-guard-banner-install': makeEl({ hidden: false }),
    'terminals-guard-banner-recheck': makeEl({ hidden: true }),
    'terminals-guard-banner-commands': makeEl({ hidden: true }),
    'terminals-guard-banner-restart': makeEl({ hidden: true }),
  });
}

const LINKED = { id: 'L1', executor_id: 'codex', status: 'working', origin: 'linked', session_id: 'sess-abc12345' };

test('a linked session on an ungoverned harness gets the install banner', () => {
  const dom = bannerDom();
  const Page = loadPage(dom);
  Page._tasks = [LINKED];
  Page._attached = 'L1';
  Page._executors = [CODEX_UNGOVERNED];
  Page._sessionReported = false;

  Page._renderGuardBanner();

  assert.strictEqual(dom.byId('terminals-guard-banner').hidden, false);
  assert.strictEqual(dom.byId('terminals-guard-banner-text').textContent,
    'This task is running without SecureVector Guard for Codex. Nothing is being checked, recorded, or held for approval.');
  assert.strictEqual(dom.byId('terminals-guard-banner-install').hidden, false);
});

test('a linked session pending the Guard names /reload-plugins and hides Restart harness', () => {
  const dom = bannerDom();
  const Page = loadPage(dom);
  Page._tasks = [LINKED];
  Page._attached = 'L1';
  Page._executors = [CODEX];
  Page._sessionReported = false;

  Page._renderGuardBanner();

  assert.strictEqual(dom.byId('terminals-guard-banner').classList.contains('is-pending'), true);
  assert.strictEqual(dom.byId('terminals-guard-banner-text').textContent,
    'SecureVector Guard installed. Run /reload-plugins in that terminal (Claude Code) or restart the harness in your terminal, then link the new session id if it changed.');
  assert.strictEqual(dom.byId('terminals-guard-banner-restart').hidden, true,
    'the app does not own the process, so it cannot restart it');
  assert.strictEqual(dom.byId('terminals-guard-banner-recheck').hidden, false);
});

test('the banner clears for a linked session once the Guard has reported', () => {
  const dom = bannerDom();
  const Page = loadPage(dom);
  Page._tasks = [LINKED];
  Page._attached = 'L1';
  Page._executors = [CODEX_UNGOVERNED];

  // Nothing read yet: say nothing rather than accuse a governed session.
  Page._sessionReported = null;
  Page._renderGuardBanner();
  assert.strictEqual(dom.byId('terminals-guard-banner').hidden, true);

  Page._sessionReported = true;
  Page._guardBannerSig = null;
  Page._renderGuardBanner();
  assert.strictEqual(dom.byId('terminals-guard-banner').hidden, true);
});

test('a launched task still reads its session id, not the audit trail', () => {
  const dom = bannerDom();
  const Page = loadPage(dom);
  assert.strictEqual(Page._guardReportedIn({ origin: 'launch', session_id: 'sess-1' }), true);
  assert.strictEqual(Page._guardReportedIn({ origin: 'launch', session_id: null }), false);
  assert.strictEqual(Page._guardReportedIn({ origin: 'linked', session_id: 'sess-1' }), true);
  Page._sessionReported = false;
  assert.strictEqual(Page._guardReportedIn({ origin: 'linked', session_id: 'sess-1' }), false);
});

// --- Tool calls list hygiene -----------------------------------------------

test('session boundary rows are not tool calls: one Bash row, a count of 1, hero hidden', async () => {
  const dom = makeDom();
  const Page = loadPage(dom, {
    terminalsVerdicts: async () => ({
      session_id: null,
      items: [
        { tool_id: '__session_start__', function_name: '__session_start__', action: 'log_only' },
        { tool_id: 'Bash', function_name: 'Bash', action: 'allow', reason: 'ok' },
        { tool_id: '__session_end__', function_name: '__session_end__', action: 'log_only' },
      ],
    }),
    getJitRequests: async () => ({ items: [] }),
  });
  Page._tasks = [{ id: 'L1', executor_id: 'codex', status: 'working', origin: 'linked', session_id: 'sess-abc12345' }];
  Page._attached = 'L1';
  Page._executors = [CODEX];

  await Page._refreshRail();

  const list = dom.byId('terminals-verdicts');
  assert.strictEqual((list.innerHTML.match(/class="terminals-verdict /g) || []).length, 1);
  assert.doesNotMatch(list.innerHTML, /__session_start__|__session_end__/);
  assert.strictEqual(dom.byId('terminals-verdicts-count').textContent, '1');
  assert.match(dom.byId('terminals-governance-summary').textContent, /^1 call checked/);
  assert.strictEqual(Page._govCounts.governed, 1);
  assert.strictEqual(Page._govCounts.blocked, 0);
  // A session start still proves the Guard reported in, so the empty-state
  // hero stays away.
  assert.strictEqual(Page._sessionReported, true);
  assert.strictEqual(dom.byId('terminals-gov-hero').hidden, true);
});

test('a session that has only reported its boundaries lists no calls but counts as reported', async () => {
  const dom = makeDom();
  const Page = loadPage(dom, {
    terminalsVerdicts: async () => ({
      session_id: null,
      items: [{ tool_id: '__session_start__', function_name: '__session_start__', action: 'log_only' }],
    }),
    getJitRequests: async () => ({ items: [] }),
  });
  Page._tasks = [{ id: 'L1', executor_id: 'codex', status: 'working', origin: 'linked', session_id: 'sess-abc12345' }];
  Page._attached = 'L1';
  Page._executors = [CODEX];

  await Page._refreshRail();

  assert.match(dom.byId('terminals-verdicts').innerHTML, /No tool calls yet\./);
  assert.strictEqual(dom.byId('terminals-verdicts-count').textContent, '');
  assert.strictEqual(Page._sessionReported, true);
});

// --- api.js ----------------------------------------------------------------

test('api.js exposes the link and discovery calls on the terminals write/read paths', () => {
  const api = read('js/api.js');
  assert.match(api, /async terminalsLink\(executorId, sessionId, workspace, title\)/);
  assert.match(api, /_terminalsWrite\('\/api\/terminals\/tasks\/link'/);
  assert.match(api, /session_id: sessionId/);
  assert.match(api, /async terminalsUnlinkedSessions\(\)/);
  assert.match(api, /_terminalsRead\('\/api\/terminals\/sessions\/unlinked'\)/);
});

test('index.html pins the bumped asset versions', () => {
  const html = read('index.html');
  assert.match(html, /api\.js\?v=326/);
  assert.match(html, /terminals\.js\?v=77/);
  assert.match(html, /sidebar\.js\?v=178/);
  assert.match(html, /styles\.css\?v=451/);
});
