/** Worktree isolation on the Agents page: the launch checkbox, the card facts,
 * the ended-task line and the in-card remove flow. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

function makeEl(extra = {}) {
  return Object.assign({
    innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, checked: false,
    dataset: {}, classList: { add() {}, remove() {}, contains: () => false },
    querySelector: () => null, querySelectorAll: () => [], focus() {}, isConnected: true,
  }, extra);
}

function loadPage(elements, api = {}) {
  const sandbox = {
    window: {},
    document: { getElementById: (id) => elements[id] || (elements[id] = makeEl()) },
    API: api, URLSearchParams, WebSocket: { OPEN: 1, CLOSED: 3 },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: (fn) => { sandbox._timers.push(fn); return sandbox._timers.length; },
    clearTimeout() {},
    console: { warn() {}, error() {} },
    _timers: [],
  };
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  vm.runInNewContext(read('js/pages/terminals.js'), sandbox);
  return { Page: sandbox.window.TerminalsPage, sandbox };
}

function harness(tasks, api = {}) {
  const store = { handlers: {} };
  const list = makeEl({ querySelectorAll: (sel) => store.handlers[sel] || [] });
  let html = '';
  Object.defineProperty(list, 'innerHTML', { get: () => html, set: (v) => { html = v; } });
  const { Page, sandbox } = loadPage({ 'terminals-task-list': list }, api);
  Page._tasks = tasks;
  Page._attached = null;
  Page._refreshTasks = async () => {};
  return { Page, store, sandbox, html: () => { Page._renderTaskList(); return html; } };
}

const BASE = { id: 'w1', executor_id: 'codex', status: 'done', workspace: '/w', title: 'Run',
  run_dir: '/w--wt', worktree_branch: 'sv/wt-1', worktree_state: 'kept', worktree_dirty: 0, worktree_commits: 0 };

// ------------------------------------------------------------ launch form

function formEls(api) {
  const box = makeEl({ disabled: true });
  const hint = makeEl({ hidden: true });
  const ws = makeEl({ value: '/repo' });
  const container = { querySelector: (sel) => ({ '#terminals-worktree': box, '#terminals-worktree-hint': hint, '#terminals-workspace': ws })[sel] || null };
  const { Page } = loadPage({}, api);
  return { Page, box, hint, ws, container };
}

test('a non-git folder disables the checkbox and shows the returned message', async () => {
  const msg = 'Not a git repository. The task runs in this folder.';
  const { Page, box, hint, container } = formEls({ terminalsGitRepo: async () => ({ git: false, worktree_ok: false, message: msg }) });
  box.checked = true;
  await Page._checkWorktreeFolder(container);
  assert.strictEqual(box.disabled, true);
  assert.strictEqual(box.checked, false);
  assert.strictEqual(hint.textContent, msg);
  assert.strictEqual(hint.hidden, false);
});

test('a git folder enables the checkbox, and checking it shows the carry-over line', async () => {
  const { Page, box, hint, container } = formEls({ terminalsGitRepo: async () => ({ git: true, worktree_ok: true, message: '' }) });
  await Page._checkWorktreeFolder(container);
  assert.strictEqual(box.disabled, false);
  assert.strictEqual(hint.hidden, true);
  box.checked = true;
  Page._renderWorktreeHint(container);
  assert.strictEqual(hint.textContent, 'Uncommitted changes in this folder are not carried over.');
  assert.strictEqual(hint.hidden, false);
});

test('the folder check is debounced by 400 ms', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /WORKTREE_DEBOUNCE_MS: 400/);
  assert.match(src, /id="terminals-worktree" disabled> Run in its own worktree/);
});

test('launch sends worktree true only when the box is checked and enabled', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /wtBox\.checked && !wtBox\.disabled/);
  assert.match(src, /terminalsLaunch\(executor, workspace, title, null, \{ worktree: true \}\)/);
  const api = read('js/api.js');
  assert.match(api, /if \(extra && extra\.worktree\) body\.worktree = true;/);
});

// ------------------------------------------------------------- facts row

test('facts row names the worktree branch with the folder as title', () => {
  const { Page } = loadPage({});
  const out = Page._factsHtml({ worktree_branch: 'sv/wt-1', run_dir: '/w--wt' });
  assert.match(out, /title="\/w--wt">worktree, sv\/wt-1</);
});

test('a delegated child says it runs in its parent\'s worktree', () => {
  const { Page } = loadPage({});
  const out = Page._factsHtml({ run_dir: '/w--wt' });
  assert.match(out, /in parent&#39;s worktree|in parent's worktree/);
});

// ------------------------------------------------------- ended task card

test('an ended task with no changes offers only Remove worktree', () => {
  const h = harness([BASE]);
  const out = h.html();
  assert.match(out, /No changes in the worktree\. Remove it\?/);
  assert.match(out, /data-worktree-remove="w1"/);
  assert.ok(!/data-worktree-open/.test(out));
});

test('an ended task with changes shows counts and both buttons', () => {
  const h = harness([Object.assign({}, BASE, { worktree_dirty: 3, worktree_commits: 1 })]);
  const out = h.html();
  assert.match(out, /3 files changed, 1 commit</);
  assert.match(out, /data-worktree-open="w1"/);
  assert.match(out, /data-worktree-remove="w1"/);
});

test('counts use singular and plural and omit a zero part', () => {
  const { Page } = loadPage({});
  assert.strictEqual(Page._worktreeChangesText({ worktree_dirty: 1, worktree_commits: 0 }), '1 file changed');
  assert.strictEqual(Page._worktreeChangesText({ worktree_dirty: 0, worktree_commits: 2 }), '2 commits');
  assert.strictEqual(Page._worktreeChangesText({ worktree_dirty: 2, worktree_commits: 2 }), '2 files changed, 2 commits');
});

test('removing and removed states', () => {
  const rem = harness([Object.assign({}, BASE, { worktree_state: 'removing' })]).html();
  assert.match(rem, /Removing worktree\.\.\./);
  assert.match(rem, /<button[^>]*disabled/);
  const gone = harness([Object.assign({}, BASE, { worktree_state: 'removed' })]).html();
  assert.ok(!/terminals-task-worktreebox/.test(gone));
});

test('a child of a worktree task shows no remove or open buttons', () => {
  const child = { id: 'c1', executor_id: 'codex', status: 'done', workspace: '/w', title: 'Kid', run_dir: '/w--wt' };
  const out = harness([child]).html();
  assert.ok(!/data-worktree-/.test(out));
  assert.match(out, /in parent/);
});

// ---------------------------------------------------------- remove flow

test('remove asks in the card, then sends confirm true', async () => {
  const calls = [];
  const task = Object.assign({}, BASE, { worktree_dirty: 4 });
  const h = harness([task], {
    terminalsWorktreeRemove: async (id, confirm, dirtySeen) => {
      calls.push([id, confirm, dirtySeen]);
      return confirm ? { removed: true, message: 'Branch kept because it has commits.' }
        : { removed: false, needs_confirm: true, dirty: 4, message: '' };
    },
  });
  await h.Page._removeWorktree('w1', false);
  const asked = h.html();
  assert.match(asked, /4 uncommitted files will be lost\. Ignored files such as build output are deleted too\./);
  assert.match(asked, /data-worktree-confirm="w1"/);
  assert.match(asked, /data-worktree-cancel="w1"/);
  await h.Page._removeWorktree('w1', true);
  assert.deepStrictEqual(calls, [['w1', false, undefined], ['w1', true, 4]]);
  assert.strictEqual(h.Page._worktreeAsk, null);
  assert.match(h.html(), /Branch kept because it has commits\./);
});

test('the api remove call carries the UI token and returns the confirm object on 409', async () => {
  const seen = [];
  const sandbox = {
    window: {}, console, encodeURIComponent,
    fetch: async (url, opt) => { seen.push([url, opt]); return { ok: false, status: 409, json: async () => ({ detail: { needs_confirm: true, dirty: 2 } }) }; },
  };
  vm.runInNewContext(read('js/api.js') + '\nthis.API = API;', sandbox);
  const A = sandbox.API;
  A.terminalsSession = async () => {};
  A._getJitToken = async () => 'tok';
  const res = await A.terminalsWorktreeRemove('w1', false);
  assert.strictEqual(res.needs_confirm, true);
  assert.strictEqual(seen[0][1].headers['X-SV-UI-Token'], 'tok');
  assert.strictEqual(JSON.parse(seen[0][1].body).confirm, false);
  assert.match(seen[0][0], /\/worktree\/remove$/);
});

test('removing a task from the board says when the worktree was kept', async () => {
  const h = harness([Object.assign({}, BASE, { worktree_state: 'kept' })], {
    terminalsArchive: async () => ({ worktree_kept: true, run_dir: '/w--wt', worktree_branch: 'sv/wt-1' }),
  });
  h.Page._renderAttachedHead = () => {};
  h.Page._refreshRail = () => {};
  await h.Page._removeFromBoard('w1');
  assert.match(h.html(), /The worktree was kept at \/w--wt\./);
});

test('no em dashes in the new strings', () => {
  const src = read('js/pages/terminals.js');
  const from = src.indexOf('WORKTREE_DEBOUNCE_MS');
  const block = src.slice(from, src.indexOf('Repo trust before the first prompt'))
    + src.slice(src.indexOf('worktree isolation: the card'), src.indexOf('    _renderTaskList() {'));
  assert.ok(!/—/.test(block));
  assert.ok(!/—/.test(src.slice(src.indexOf('terminals-worktree-field'), src.indexOf('terminals-worktree-field') + 400)));
});

// ------------------------------------------------------------ review fixes

test('an armed confirm expires on its timer and when the task stops being kept', async () => {
  const task = Object.assign({}, BASE, { worktree_dirty: 2 });
  const h = harness([task], { terminalsWorktreeRemove: async () => ({ removed: false, needs_confirm: true, dirty: 2, message: '' }) });
  await h.Page._removeWorktree('w1', false);
  assert.match(h.html(), /data-worktree-confirm/);
  h.sandbox._timers.splice(0).forEach(fn => fn());
  assert.strictEqual(h.Page._worktreeAsk, null);
  assert.ok(!/data-worktree-confirm/.test(h.html()));
  h.Page._armWorktreeAsk({ id: 'w1', dirty: 2, message: 'x' });
  h.Page._tasks = [Object.assign({}, task, { worktree_state: 'removed' })];
  h.html();
  assert.strictEqual(h.Page._worktreeAsk, null);
});

test('a second remove while one is in flight is ignored and buttons are disabled', async () => {
  let release; let calls = 0;
  const h = harness([BASE], { terminalsWorktreeRemove: () => { calls++; return new Promise(r => { release = r; }); } });
  const first = h.Page._removeWorktree('w1', false);
  await h.Page._removeWorktree('w1', false);
  assert.strictEqual(calls, 1);
  assert.match(h.html(), /data-worktree-remove="w1" disabled/);
  release({ removed: true });
  await first;
  assert.strictEqual(h.Page._worktreeBusy.has('w1'), false);
});

test('typing in the folder disables and clears the checkbox at once', () => {
  const src = read('js/pages/terminals.js');
  const i = src.indexOf('wsNode.oninput = () => {');
  assert.match(src.slice(i, i + 500), /box\.disabled = true; box\.checked = false;/);
});

test('only the newest row on a shared worktree offers Open and Remove', () => {
  const old = Object.assign({}, BASE, { id: 'old', created_at: '2026-10-01T00:00:00Z', worktree_dirty: 1 });
  const fresh = Object.assign({}, BASE, { id: 'new', created_at: '2026-10-02T00:00:00Z', worktree_dirty: 1 });
  const out = harness([old, fresh]).html();
  assert.match(out, /data-worktree-remove="new"/);
  assert.ok(!/data-worktree-remove="old"/.test(out));
});

test('an empty folder or a failed check says to enter a git folder', async () => {
  const { Page, box, hint, ws, container } = formEls({ terminalsGitRepo: async () => { throw new Error('x'); } });
  ws.value = '';
  await Page._checkWorktreeFolder(container);
  assert.strictEqual(hint.textContent, 'Enter a git folder to use a worktree.');
  ws.value = '/repo';
  await Page._checkWorktreeFolder(container);
  assert.strictEqual(hint.textContent, 'Enter a git folder to use a worktree.');
  assert.strictEqual(box.disabled, true);
});

test('resume of a removed worktree is refused before anything is sent', async () => {
  let launched = 0;
  const h = harness([], { terminalsLaunch: async () => { launched++; return { id: 'n' }; } });
  await assert.rejects(h.Page._relaunchTask(Object.assign({}, BASE, { worktree_state: 'removed' }), { resumeSessionId: 's' }),
    /The worktree was removed\. Relaunch to start in a new one\./);
  assert.strictEqual(launched, 0);
});
