/** Several tasks attached at once: one pane, one xterm, and one WebSocket
 * each, splittable right and down, closeable without stopping the task, and
 * restored from storage on the next visit. The governance surfaces still key
 * off `_attached`, which is now the focused pane's task. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

// --- DOM stub ---------------------------------------------------------------
// Element enough for a tree: real children, a class list, and a querySelectorAll
// that reads back the buttons the page just wrote, so clicks run real handlers.

function makeEl(tag = 'div') {
  return {
    tag,
    children: [],
    innerHTML: '',
    textContent: '',
    hidden: false,
    className: '',
    tabIndex: 0,
    dataset: {},
    style: { setProperty(k, v) { this[k] = v; } },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    setAttribute(k, v) { this[k] = v; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((k) => k !== c); c.parentNode = null; return c; },
    replaceChildren(...kids) { this.children = kids; kids.forEach((k) => { k.parentNode = this; }); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }),
    focus() { this.focused = true; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    // Sub-elements the page addresses by selector. They outlive the innerHTML
    // cache so a handler wired onto one survives a re-render, as a real node would.
    _sub(sel) { this._subs = this._subs || {}; return this._subs[sel] || (this._subs[sel] = makeEl('span')); },
    querySelectorAll(sel) {
      if (this._html !== this.innerHTML) { this._html = this.innerHTML; this._cache = {}; }
      if (!this._cache) this._cache = {};
      if (this._cache[sel]) return this._cache[sel];
      const attrFor = { '.terminals-pane-act': 'data-act', '[data-pick-id]': 'data-pick-id',
        '[data-tab-id]': 'data-tab-id', '[data-tab-close-id]': 'data-tab-close-id' };
      // A board card carries data-id and so does the button inside it, so the
      // two are told apart by the class that precedes the attribute.
      const cardFor = {
        // The class has to end here, or terminals-task-select matches too.
        '.terminals-task[data-id]': /class="terminals-task(?: [^"]*)?" data-id="([^"]+)"/g,
        '.terminals-task-select': /class="terminals-task-select" data-id="([^"]+)"/g,
      };
      let out = [];
      if (cardFor[sel]) {
        out = [...this.innerHTML.matchAll(cardFor[sel])].map((m) => {
          const el = makeEl('article');
          el.dataset.id = m[1];
          el.classList.add('terminals-task');
          return el;
        });
      } else if (attrFor[sel]) {
        const attr = attrFor[sel];
        const key = attr.slice(5).replace(/-(\w)/g, (m, c) => c.toUpperCase());
        out = [...this.innerHTML.matchAll(new RegExp(attr + '="([^"]+)"', 'g'))]
          .map((m) => ({ dataset: { [key]: m[1] }, onclick: null }));
      } else if (sel === '.terminals-pane-picker-cancel' && /picker-cancel/.test(this.innerHTML)) {
        out = [{ dataset: {}, onclick: null }];
      } else if (sel.startsWith('#')) {
        const id = sel.slice(1);
        out = this.innerHTML.includes(`id="${id}"`) ? [{ id, dataset: {}, onclick: null }] : [];
      } else if (sel === '.terminals-pane-gov-slot' && this.innerHTML.includes('terminals-pane-gov-slot')) {
        out = [this._sub(sel)];
      } else if (sel === '.terminals-guard-banner-text' && this.innerHTML.includes('terminals-guard-banner-text')) {
        out = [this._sub(sel)];
      } else if (sel.startsWith('[data-guard=') && this.innerHTML.includes(sel.slice(1, -1))) {
        out = [this._sub(sel)];
      }
      this._cache[sel] = out;
      return out;
    },
  };
}

function makeStore() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function loadPage({ api = {}, store = makeStore(), session = makeStore(), platform = 'MacIntel' } = {}) {
  const els = {};
  const byId = (id) => { if (!els[id]) els[id] = makeEl(); return els[id]; };
  const sockets = [];
  const views = [];
  function FakeSocket(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    this.send = (frame) => this.sent.push(frame);
    this.close = () => { this.readyState = 3; this.closed = true; };
    sockets.push(this);
  }
  FakeSocket.OPEN = 1;
  function FakeView(mount, handlers) {
    this.mount = mount;
    this.handlers = handlers;
    this.size = { rows: 24, cols: 80 };
    this.fits = 0;
    this.write = () => {};
    this.focus = () => { this.focused = true; };
    this.fitNow = () => { this.fits += 1; };
    this.dispose = () => { this.disposed = true; };
    views.push(this);
  }
  const listeners = {};
  const body = makeEl('body');
  // elementFromPoint is late bound: a test lays the panes out after the page
  // has been built, and the drag reads the geometry it set.
  const ctx = { els, byId, sockets, views, store, session, listeners, body, elementAt: null };
  const sandbox = {
    window: {
      addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
      removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    },
    document: {
      getElementById: byId,
      querySelector: () => null,
      createElement: (t) => makeEl(t),
      addEventListener: () => {},
      removeEventListener: () => {},
      elementFromPoint: (x, y) => (ctx.elementAt ? ctx.elementAt(x, y) : null),
      body,
    },
    navigator: { platform },
    WebSocket: FakeSocket,
    TerminalView: FakeView,
    API: Object.assign({
      terminalsSocketUrl: (id) => 'ws://local/' + id,
      terminalsVerdicts: async () => ({ items: [], session_id: null }),
      getJitRequests: async () => ({ items: [] }),
      request: async () => ({ runs: [] }),
    }, api),
    URLSearchParams,
    localStorage: store,
    sessionStorage: session,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    console: { warn() {}, error() {} },
  };
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  vm.runInNewContext(read('js/pages/terminals.js'), sandbox);
  const Page = sandbox.window.TerminalsPage;
  Page._refreshRail = async () => {};
  ctx.Page = Page;
  return ctx;
}

const task = (id, over = {}) => ({
  id, executor_id: 'claude-code', title: id, workspace: '/w', status: 'working',
  created_at: '2026-01-01T00:00:00Z', ...over,
});

const paneIds = (Page) => Array.from(Page._panes.keys());
const paneTasks = (Page) => Array.from(Page._panes.values(), (r) => r.taskId);

// --- attaching and splitting ------------------------------------------------

test('attaching a task opens one pane with one socket and one terminal', async () => {
  const { Page, sockets, views, byId } = loadPage();
  Page._tasks = [task('t1')];
  await Page._attach('t1');

  assert.strictEqual(Page._panes.size, 1);
  assert.strictEqual(sockets.length, 1, 'one pane means one socket');
  assert.strictEqual(views.length, 1);
  assert.strictEqual(Page._attached, 't1', '_attached is the focused pane\'s task');
  assert.strictEqual(Page._layout.type, 'pane');
  assert.strictEqual(sockets[0].url, 'ws://local/t1');
  assert.ok(byId('terminals-attached-body').classList.contains('is-layout'));
});

test('splitting right opens a second pane with its own socket and focuses it', async () => {
  const { Page, sockets, views } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');

  assert.strictEqual(Page._panes.size, 2);
  assert.strictEqual(sockets.length, 2, 'the new pane gets a socket of its own');
  assert.strictEqual(views.length, 2);
  assert.strictEqual(Page._layout.type, 'split');
  assert.strictEqual(Page._layout.dir, 'row');
  assert.strictEqual(Page._layout.ratio, 0.5);
  assert.strictEqual(Page._attached, 't2', 'the new pane takes the focus');
  assert.deepStrictEqual(Array.from(paneTasks(Page)), ['t1', 't2']);
  assert.ok(!sockets[0].closed, 'the pane that was split keeps its terminal running');
});

test('splitting down nests a column split under the row', async () => {
  const { Page } = loadPage();
  Page._tasks = [task('t1'), task('t2'), task('t3')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  await Page._openInNewPane('t3', 'col');

  assert.strictEqual(Page._layout.dir, 'row');
  assert.strictEqual(Page._layout.b.type, 'split');
  assert.strictEqual(Page._layout.b.dir, 'col');
  assert.strictEqual(Page._panes.size, 3);
});

test('opening a task that is already in a pane focuses it and creates nothing', async () => {
  const { Page, sockets } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  assert.strictEqual(Page._attached, 't2');

  await Page._attach('t1');
  assert.strictEqual(Page._panes.size, 2, 'a task lives in exactly one pane');
  assert.strictEqual(sockets.length, 2, 'no second socket for a task already attached');
  assert.strictEqual(Page._attached, 't1', 'the focus moves to the pane that has it');

  await Page._openInNewPane('t1', 'col');
  assert.strictEqual(Page._panes.size, 2, 'splitting onto an attached task just focuses it');
});

test('attaching over the focused pane replaces its task and its socket', async () => {
  const { Page, sockets } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._attach('t2');

  assert.strictEqual(Page._panes.size, 1, 'attaching does not open a pane of its own');
  assert.strictEqual(sockets.length, 2);
  assert.ok(sockets[0].closed, 'the task that left the pane has its socket closed');
  assert.strictEqual(Page._attached, 't2');
});

// --- closing ----------------------------------------------------------------

test('closing a pane closes its socket and the sibling fills the space', async () => {
  const { Page, sockets, views } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  const secondPane = Page._focused;

  Page._closePane(secondPane);

  assert.strictEqual(Page._panes.size, 1);
  assert.ok(sockets[1].closed, 'the closed pane hangs up its own socket');
  assert.ok(views[1].disposed, 'and disposes its terminal');
  assert.ok(!sockets[0].closed, 'the surviving pane is untouched');
  assert.strictEqual(Page._layout.type, 'pane', 'the sibling replaces the split');
  assert.strictEqual(Page._attached, 't1', 'focus lands on the pane that is left');
});

test('closing the last pane clears the layout and the stored task id', async () => {
  const { Page, session, store } = loadPage();
  Page._tasks = [task('t1')];
  await Page._attach('t1');
  assert.strictEqual(session.getItem('sv-agent-task-id'), 't1');

  Page._closePane(Page._focused);

  assert.strictEqual(Page._layout, null);
  assert.strictEqual(Page._panes.size, 0);
  assert.strictEqual(Page._attached, null);
  assert.strictEqual(session.getItem('sv-agent-task-id'), null);
  assert.strictEqual(store.getItem('sv-terminals-layout'), null);
});

test('All tasks closes every pane at once and the tasks keep running', async () => {
  const { Page, sockets } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');

  Page._detach();

  assert.strictEqual(Page._panes.size, 0);
  assert.strictEqual(Page._layout, null);
  assert.ok(sockets.every((s) => s.closed), 'every pane hangs up');
});

// --- focus and keystroke routing --------------------------------------------

test('a keystroke reaches only the socket of the pane it was typed in', async () => {
  const { Page, sockets, views } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');

  views[0].handlers.onInput('QQ==');
  assert.deepStrictEqual(sockets[0].sent.filter((f) => f.includes('"input"')),
    ['{"t":"input","data":"QQ=="}']);
  assert.strictEqual(sockets[1].sent.filter((f) => f.includes('"input"')).length, 0,
    'the other pane must not see a keystroke it did not receive');

  views[1].handlers.onResize(40, 120);
  assert.ok(sockets[1].sent.some((f) => f.includes('"rows":40')), 'resize goes to its own pane');
  assert.ok(!sockets[0].sent.some((f) => f.includes('"rows":40')));
});

test('focusing a pane moves _attached, the stored task id, and the focus class', async () => {
  const { Page, session } = loadPage();
  let railRefreshes = 0;
  let paneGovRefreshes = 0;
  Page._refreshRail = () => { railRefreshes += 1; };
  Page._refreshPaneGov = () => { paneGovRefreshes += 1; };
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  const first = Page._focused;
  await Page._openInNewPane('t2', 'row');
  assert.strictEqual(session.getItem('sv-agent-task-id'), 't2');

  Page._focusPane(first);

  assert.strictEqual(Page._focused, first);
  assert.strictEqual(Page._attached, 't1');
  assert.strictEqual(session.getItem('sv-agent-task-id'), 't1');
  assert.ok(railRefreshes > 0, 'the workspace Governance Activity follows the focused task immediately');
  assert.ok(paneGovRefreshes > 0, 'per-pane governance counts refresh with the focus change');
  assert.ok(Page._panes.get(first).el.classList.contains('is-focused'));
  const other = paneIds(Page).find((id) => id !== first);
  assert.ok(!Page._panes.get(other).el.classList.contains('is-focused'));
});

test('the pane head offers split right, split down, and close', async () => {
  const { Page } = loadPage();
  Page._tasks = [task('t1'), task('t2'), task('t3')];
  await Page._attach('t1');
  // A single pane hides its own head, so the controls are read from a split.
  await Page._openInNewPane('t3', 'row');
  const head = Page._panes.get(Page._focused).headEl;
  assert.match(head.innerHTML, /aria-label="Split right"/);
  assert.match(head.innerHTML, /aria-label="Split down"/);
  assert.match(head.innerHTML, /aria-label="Close pane"/);
  assert.match(head.innerHTML, /terminals-pane-name/);

  const acts = head.querySelectorAll('.terminals-pane-act');
  assert.deepStrictEqual(Array.from(acts, (b) => b.dataset.act), ['row', 'col', 'close']);
  acts[0].onclick({ stopPropagation() {} });
  const empty = Page._panes.get(Page._focused);
  assert.strictEqual(Page._panes.size, 3, 'a split is visible immediately, before choosing a task');
  assert.strictEqual(empty.taskId, null, 'the new half starts empty rather than moving the active task');
  assert.match(empty.stageEl.innerHTML, /Choose a running task/);
  assert.match(empty.stageEl.innerHTML, /data-empty-pane-task="t2"/);
  assert.ok(!empty.stageEl.innerHTML.includes('data-empty-pane-task="t1"'), 'a task already in a pane is not on offer');
});

test('the picker says so when there is no other running task', async () => {
  const { Page } = loadPage();
  Page._tasks = [task('t1'), task('done', { status: 'done' })];
  await Page._attach('t1');
  Page._openSplitPicker(Page._focused, 'col');
  const picker = Page._panes.get(Page._focused).pickerEl;
  assert.match(picker.innerHTML, /No other running task\. Launch one first\./);
  assert.match(picker.innerHTML, /Open below/);
});

// --- gutters ----------------------------------------------------------------

test('a gutter drag sets the ratio from the split rect and clamps at the minimum', async () => {
  const { Page, listeners } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  const splitId = Page._layout.id;
  const splitEl = Page._splitEls.get(splitId);
  const gutter = splitEl.children[1];
  assert.strictEqual(gutter.className, 'terminals-gutter');
  assert.strictEqual(gutter['aria-orientation'], 'vertical');

  gutter.onpointerdown({ currentTarget: gutter, pointerId: 1, preventDefault() {} });
  listeners.pointermove[0]({ clientX: 200, clientY: 0 });
  assert.strictEqual(Page._layout.ratio, 0.25, '200 of 800 wide is a quarter');
  assert.strictEqual(splitEl.style['--ratio'], '0.25', 'the ratio is written straight onto the element');

  listeners.pointermove[0]({ clientX: 8, clientY: 0 });
  assert.strictEqual(Page._layout.ratio, 0.15, 'a pane can never be dragged below the minimum');
  listeners.pointerup[0]();
  assert.strictEqual((listeners.pointermove || []).length, 0, 'the drag listeners come off at the end');
});

test('a gutter resets on double click and moves by a step on arrow keys', async () => {
  const { Page } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'col');
  const gutter = Page._splitEls.get(Page._layout.id).children[1];
  assert.strictEqual(gutter['aria-orientation'], 'horizontal');

  gutter.onkeydown({ key: 'ArrowDown', preventDefault() {} });
  assert.strictEqual(Page._layout.ratio, 0.55);
  gutter.onkeydown({ key: 'ArrowUp', preventDefault() {} });
  gutter.onkeydown({ key: 'ArrowUp', preventDefault() {} });
  assert.strictEqual(Math.round(Page._layout.ratio * 100), 45);
  gutter.onkeydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.strictEqual(Math.round(Page._layout.ratio * 100), 45, 'a column split ignores the sideways keys');
  gutter.ondblclick();
  assert.strictEqual(Page._layout.ratio, 0.5);
});

// --- keyboard ---------------------------------------------------------------

test('the shortcuts split, close, and jump between panes', async () => {
  const { Page } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  const [first, second] = Page._lay().panes(Page._layout).map((p) => p.id);

  const key = (k, over = {}) => Object.assign({ key: k, metaKey: true, preventDefault() {} }, over);
  Page._onPaneKey(key('1'));
  assert.strictEqual(Page._focused, first, 'Mod+1 focuses the first pane in reading order');
  Page._onPaneKey(key('2'));
  assert.strictEqual(Page._focused, second);
  Page._onPaneKey(key('9'));
  assert.strictEqual(Page._focused, second, 'a number past the last pane does nothing');

  Page._onPaneKey(key('\\'));
  assert.strictEqual(Page._panes.get(second).pickerEl.hidden, false);
  Page._onPaneKey(key('w'));
  assert.strictEqual(Page._panes.size, 1, 'Mod+W closes the focused pane');
});

test('the shortcuts stay out of the way without the modifier', async () => {
  const { Page } = loadPage();
  Page._tasks = [task('t1')];
  await Page._attach('t1');
  Page._onPaneKey({ key: 'w', metaKey: false, ctrlKey: false, preventDefault() {} });
  assert.strictEqual(Page._panes.size, 1, 'a bare w is a keystroke for the terminal');
});

// --- persistence ------------------------------------------------------------

test('the layout is written to storage on every change', async () => {
  const { Page, store } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');

  const saved = JSON.parse(store.getItem('sv-terminals-layout'));
  assert.strictEqual(saved.v, 2);
  assert.strictEqual(saved.root.type, 'split');
  assert.strictEqual(saved.focused, Page._focused);
  assert.deepStrictEqual([saved.root.a.taskId, saved.root.b.taskId], ['t1', 't2']);
});

test('a stored layout is rebuilt on the next visit, with a socket per pane', async () => {
  const store = makeStore();
  const first = loadPage({ store });
  first.Page._tasks = [task('t1'), task('t2')];
  await first.Page._attach('t1');
  await first.Page._openInNewPane('t2', 'row');

  const next = loadPage({ store });
  next.Page._tasks = [task('t1'), task('t2')];
  await next.Page._restoreLayout();

  assert.strictEqual(next.Page._panes.size, 2);
  assert.strictEqual(next.sockets.length, 2, 'each restored pane reconnects on its own');
  assert.strictEqual(next.Page._layout.type, 'split');
  assert.deepStrictEqual(Array.from(paneTasks(next.Page)), ['t1', 't2']);
  assert.strictEqual(next.Page._attached, 't2', 'the pane that had the focus keeps it');
});

test('restoring prunes panes whose task is gone and collapses the split', async () => {
  const store = makeStore();
  const first = loadPage({ store });
  first.Page._tasks = [task('t1'), task('t2')];
  await first.Page._attach('t1');
  await first.Page._openInNewPane('t2', 'row');

  const next = loadPage({ store });
  next.Page._tasks = [task('t1')];
  await next.Page._restoreLayout();

  assert.strictEqual(next.Page._panes.size, 1);
  assert.strictEqual(next.Page._layout.type, 'pane');
  assert.strictEqual(next.Page._attached, 't1');
  assert.strictEqual(next.sockets.length, 1, 'no socket is opened for a task the board forgot');
});

test('a layout whose tasks have all gone is dropped rather than half restored', async () => {
  const store = makeStore();
  const first = loadPage({ store });
  first.Page._tasks = [task('t1')];
  await first.Page._attach('t1');

  const next = loadPage({ store });
  next.Page._tasks = [];
  await next.Page._restoreLayout();

  assert.strictEqual(next.Page._layout, null);
  assert.strictEqual(next.sockets.length, 0);
  assert.strictEqual(store.getItem('sv-terminals-layout'), null, 'the dead layout is forgotten');
});

test('a stored layout from another version is ignored', async () => {
  const store = makeStore();
  store.setItem('sv-terminals-layout', JSON.stringify({ v: 99, root: { type: 'pane', id: 'aaa', taskId: 't1' } }));
  const { Page } = loadPage({ store });
  Page._tasks = [task('t1')];
  await Page._restoreLayout();
  assert.strictEqual(Page._layout, null);
});

// --- the contract the rest of the page still relies on ----------------------

test('the tab strip, footer, and Guard banner still read the focused pane', async () => {
  const { Page, byId } = loadPage();
  Page._tasks = [task('t1', { branch: 'feat/x' }), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');

  Page._renderAttachedHead();
  // With several panes the names live in the pane heads, so the strip carries
  // the actions only and the focused pane is the one the footer follows.
  const strip = byId('terminals-attached-head').innerHTML;
  assert.ok(!strip.includes('terminals-pane-tabs'), 'no second row of the same task names');
  assert.match(strip, /terminals-pane-tab-new/, 'the launch action stays');
  const footOf = (id) => Page._panes.get(id).footEl.innerHTML;
  const [firstPane, secondPane] = Page._lay().panes(Page._layout).map((p) => p.id);
  assert.match(footOf(secondPane), /terminals-foot-path/);
  assert.match(Page._panes.get(secondPane).headEl.innerHTML, /terminals-pane-name/);

  Page._focusPane(firstPane);
  Page._renderAttachedHead();
  assert.strictEqual(Page._attached, 't1');
  assert.match(footOf(firstPane), /terminals-foot-branch">feat\/x</,
    'each pane\'s status line reads its own task');
  assert.ok(!footOf(secondPane).includes('feat/x'), 'and never the other pane\'s');
});

test('a linked task gets a pane and no socket, alongside a live terminal', async () => {
  const { Page, sockets } = loadPage();
  Page._tasks = [task('t1'), task('L1', { origin: 'linked', session_id: 'sess-1' })];
  await Page._attach('t1');
  await Page._openInNewPane('L1', 'col');

  assert.strictEqual(Page._panes.size, 2);
  assert.strictEqual(sockets.length, 1, 'there is no PTY behind a linked task');
  assert.match(Page._panes.get(Page._focused).stageEl.innerHTML, /terminals-linked-stage/);
});

test('every pane refits when the panes are resized', async () => {
  const { Page, views } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  const before = views.map((v) => v.fits);
  Page._fitAll();
  assert.deepStrictEqual(views.map((v) => v.fits), before.map((n) => n + 1));
});

// --- markup and styles ------------------------------------------------------

test('the layout renders splits, gutters, and panes with the roles it promises', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /terminals-split terminals-split-/, 'a split carries its direction as a class');
  assert.match(src, /setAttribute\('role', 'separator'\)/, 'a gutter is a separator for assistive tech');
  assert.match(src, /aria-orientation/);
  assert.match(src, /className = 'terminals-pane'/);
  assert.match(src, /className = 'terminals-pane-head'/);
  assert.match(src, /aria-label="Close pane"/, 'every pane action names itself');
});

test('the pane styles are defined, including the gutters and the focus accent', () => {
  const css = read('css/styles.css');
  for (const rule of [
    '.terminals-attached-body.is-layout',
    '.terminals-split {',
    '.terminals-split-row {',
    '.terminals-split-col {',
    '.terminals-gutter {',
    '.terminals-pane {',
    '.terminals-pane.is-focused',
    '.terminals-pane-head {',
    '.terminals-pane-act',
    '.terminals-pane-picker {',
    '.terminals-pane-stage',
  ]) {
    assert.ok(css.includes(rule), `styles.css is missing ${rule}`);
  }
  assert.match(css, /\.terminals-split > :first-child \{ flex: var\(--ratio/, 'the a side takes the ratio');
  assert.match(css, /\.terminals-split > :last-child \{ flex: calc\(1 - var\(--ratio/, 'the b side takes the rest');
});

test('index.html loads the layout model before the page that uses it', () => {
  const html = read('index.html');
  assert.match(html, /terminals-layout\.js\?v=5/);
  assert.match(html, /terminals\.js\?v=37/);
  assert.match(html, /styles\.css\?v=416/);
  assert.ok(html.indexOf('terminals-layout.js') < html.indexOf('pages/terminals.js'),
    'the model has to be defined by the time the page script runs');
});

// --- the chord tables -------------------------------------------------------

test('on macOS the pane chords are Cmd based and leave Ctrl to the terminal', async () => {
  const { Page } = loadPage({ platform: 'MacIntel' });
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  const [first, second] = Page._lay().panes(Page._layout).map((p) => p.id);

  const cmd = (over) => Object.assign({ metaKey: true, ctrlKey: false, shiftKey: false, preventDefault() { this.stopped = true; } }, over);

  Page._onPaneKey(cmd({ key: '1', code: 'Digit1' }));
  assert.strictEqual(Page._focused, first, 'Cmd+1 focuses the first pane');
  Page._onPaneKey(cmd({ key: '2', code: 'Digit2' }));
  assert.strictEqual(Page._focused, second);

  Page._onPaneKey(cmd({ key: '\\', code: 'Backslash' }));
  assert.strictEqual(Page._panes.get(second).pickerEl.innerHTML.includes('Open to the right'), true,
    'Cmd+backslash splits right');
  Page._closeSplitPicker(second);
  Page._onPaneKey(cmd({ key: '|', code: 'Backslash', shiftKey: true }));
  assert.match(Page._panes.get(second).pickerEl.innerHTML, /Open below/, 'Cmd+Shift+backslash splits down');

  const ctrlW = cmd({ key: 'w', code: 'KeyW', metaKey: false, ctrlKey: true });
  Page._onPaneKey(ctrlW);
  assert.strictEqual(Page._panes.size, 2, 'Ctrl+W is a terminal keystroke on macOS too');
  assert.strictEqual(ctrlW.stopped, undefined);

  Page._onPaneKey(cmd({ key: 'w', code: 'KeyW' }));
  assert.strictEqual(Page._panes.size, 1, 'Cmd+W closes the focused pane');
});

test('off macOS the pane chords all take Shift', async () => {
  const { Page } = loadPage({ platform: 'Linux x86_64' });
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  const [first, second] = Page._lay().panes(Page._layout).map((p) => p.id);

  // Shift rewrites the glyph on every one of these keys, so the events carry
  // the shifted character a real keyboard would send.
  const ctrl = (over) => Object.assign({ metaKey: false, ctrlKey: true, shiftKey: true, preventDefault() { this.stopped = true; } }, over);

  Page._onPaneKey(ctrl({ key: '!', code: 'Digit1' }));
  assert.strictEqual(Page._focused, first, 'Ctrl+Shift+1 focuses the first pane');
  Page._onPaneKey(ctrl({ key: '@', code: 'Digit2' }));
  assert.strictEqual(Page._focused, second);

  Page._onPaneKey(ctrl({ key: '|', code: 'Backslash' }));
  assert.match(Page._panes.get(second).pickerEl.innerHTML, /Open to the right/, 'Ctrl+Shift+backslash splits right');
  Page._closeSplitPicker(second);
  Page._onPaneKey(ctrl({ key: '_', code: 'Minus' }));
  assert.match(Page._panes.get(second).pickerEl.innerHTML, /Open below/, 'Ctrl+Shift+minus splits down');

  Page._onPaneKey(ctrl({ key: 'W', code: 'KeyW' }));
  assert.strictEqual(Page._panes.size, 1, 'Ctrl+Shift+W closes the focused pane');
});

test('off macOS a plain Ctrl+W, Ctrl+backslash, or Ctrl+digit reaches the terminal untouched', async () => {
  const { Page } = loadPage({ platform: 'Linux x86_64' });
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  const focused = Page._focused;

  const bare = (over) => Object.assign({ metaKey: false, ctrlKey: true, shiftKey: false, preventDefault() { this.stopped = true; } }, over);

  const killWord = bare({ key: 'w', code: 'KeyW' });
  Page._onPaneKey(killWord);
  assert.strictEqual(killWord.stopped, undefined, 'Ctrl+W must not be prevented: it kills a word in the shell');
  assert.strictEqual(Page._panes.size, 2, 'and it must not close a pane');

  const quit = bare({ key: '\\', code: 'Backslash' });
  Page._onPaneKey(quit);
  assert.strictEqual(quit.stopped, undefined, 'Ctrl+backslash sends SIGQUIT and belongs to the PTY');
  assert.strictEqual(Page._panes.get(focused).pickerEl.hidden, true, 'no picker opened');

  const digit = bare({ key: '1', code: 'Digit1' });
  Page._onPaneKey(digit);
  assert.strictEqual(digit.stopped, undefined, 'Ctrl+digits belong to the harness');
  assert.strictEqual(Page._focused, focused, 'and move no focus');
});

test('the chord table is the one source, and the pane head tooltips read from it', async () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /PANE_CHORDS: \{/, 'the chords live in one table');
  assert.match(src, /userAgentData/, 'the modern platform signal is read first');
  assert.ok(!/metaKey \? |navigator\.platform \|\| navigator\.userAgent/.test(src),
    'nothing may sniff the platform a second way');

  const mac = loadPage({ platform: 'macOS' });
  mac.Page._tasks = [task('t1'), task('t2')];
  await mac.Page._attach('t1');
  await mac.Page._openInNewPane('t2', 'row');
  const macHead = mac.Page._panes.get(mac.Page._focused).headEl.innerHTML;
  assert.match(macHead, /title="Split right \(Cmd\+\\\)"/);
  assert.match(macHead, /title="Split down \(Cmd\+Shift\+\\\)"/);
  assert.match(macHead, /title="Close pane \(Cmd\+W\); the task keeps running"/);

  const linux = loadPage({ platform: 'Windows' });
  linux.Page._tasks = [task('t1'), task('t2')];
  await linux.Page._attach('t1');
  await linux.Page._openInNewPane('t2', 'row');
  const otherHead = linux.Page._panes.get(linux.Page._focused).headEl.innerHTML;
  assert.match(otherHead, /title="Split right \(Ctrl\+Shift\+\\\)"/);
  assert.match(otherHead, /title="Split down \(Ctrl\+Shift\+-\)"/);
  assert.match(otherHead, /title="Close pane \(Ctrl\+Shift\+W\); the task keeps running"/);
});

// --- a task leaving the board ----------------------------------------------

test('a task that vanishes closes its own pane and leaves the others running', async () => {
  const { Page, sockets, views } = loadPage();
  Page._tasks = [task('t1'), task('t2'), task('t3')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  await Page._openInNewPane('t3', 'col');
  Page._focusPane(Page._lay().panes(Page._layout)[0].id);

  // t2 was removed from the board; it sits in a pane that is not focused.
  Page._tasks = [task('t1'), task('t3')];
  Page._pruneLayoutToTasks();

  assert.strictEqual(Page._panes.size, 2, 'only the pane whose task went is closed');
  assert.ok(sockets[1].closed, 'and only its socket hangs up');
  assert.ok(views[1].disposed);
  assert.ok(!sockets[0].closed && !sockets[2].closed, 'the other terminals are untouched');
  assert.strictEqual(Page._attached, 't1', 'the focus never moved');
  assert.deepStrictEqual(Array.from(paneTasks(Page)).sort(), ['t1', 't3']);
});

test('losing the focused pane\'s task moves the focus rather than detaching', async () => {
  const { Page, session } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  assert.strictEqual(Page._attached, 't2');

  Page._tasks = [task('t1')];
  Page._pruneLayoutToTasks();

  assert.strictEqual(Page._panes.size, 1);
  assert.strictEqual(Page._attached, 't1', 'the surviving pane takes the focus');
  assert.strictEqual(session.getItem('sv-agent-task-id'), 't1');
  assert.notStrictEqual(Page._layout, null, 'the workspace is not torn down');
});

test('when every task goes the workspace closes and forgets the layout', async () => {
  const { Page, store, session } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');

  Page._tasks = [];
  Page._pruneLayoutToTasks();

  assert.strictEqual(Page._layout, null);
  assert.strictEqual(Page._panes.size, 0);
  assert.strictEqual(store.getItem('sv-terminals-layout'), null);
  assert.strictEqual(session.getItem('sv-agent-task-id'), null);
});

test('removing a task from the board no longer detaches the whole workspace', () => {
  const src = read('js/pages/terminals.js');
  assert.ok(!/this\._attached === task\.id\) this\._detach\(\)/.test(src),
    'archiving one task must not tear down every pane');
  assert.match(src, /this\._pruneLayoutToTasks\(\);/, 'the poll prunes the layout instead');
});

// --- gutter drag teardown ---------------------------------------------------

test('a cancelled pointer ends the drag and releases the capture', async () => {
  const { Page, listeners } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  const gutter = Page._splitEls.get(Page._layout.id).children[1];
  let captured = null;
  let released = null;
  gutter.setPointerCapture = (id) => { captured = id; };
  gutter.releasePointerCapture = (id) => { released = id; };

  gutter.onpointerdown({ currentTarget: gutter, pointerId: 7, preventDefault() {} });
  assert.strictEqual(captured, 7);
  assert.strictEqual(listeners.pointercancel.length, 1, 'a cancelled gesture must end the drag too');

  listeners.pointercancel[0]();
  assert.strictEqual(released, 7, 'the capture is handed back');
  assert.strictEqual(listeners.pointermove.length, 0);
  assert.strictEqual(listeners.pointerup.length, 0);
  assert.strictEqual(listeners.pointercancel.length, 0, 'all three listeners come off');
});

test('a re-render mid drag does not snap the ratio to the clamp', async () => {
  const { Page, listeners } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  const splitId = Page._layout.id;
  const stale = Page._splitEls.get(splitId);
  const gutter = stale.children[1];

  gutter.onpointerdown({ currentTarget: gutter, pointerId: 1, preventDefault() {} });
  Page._renderLayout();
  // The element the drag started on is detached now, so it measures as zero.
  stale.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });

  listeners.pointermove[0]({ clientX: 200, clientY: 0 });
  assert.strictEqual(Page._layout.ratio, 0.25, 'the ratio is read from the element on screen');
  assert.notStrictEqual(Page._splitEls.get(splitId), stale, 'and that is not the one it started on');
});

// --- restore racing a destroy ----------------------------------------------

test('a destroy mid restore stops the remaining mounts and leaves storage alone', async () => {
  const store = makeStore();
  const first = loadPage({ store });
  first.Page._tasks = [task('t1'), task('t2')];
  await first.Page._attach('t1');
  await first.Page._openInNewPane('t2', 'row');
  const saved = store.getItem('sv-terminals-layout');

  const next = loadPage({ store });
  next.Page._tasks = [task('t1'), task('t2')];
  const realMount = next.Page._mountPane.bind(next.Page);
  let mounts = 0;
  next.Page._mountPane = async (paneId) => {
    mounts += 1;
    const out = await realMount(paneId);
    if (mounts === 1) next.Page.destroy();
    return out;
  };

  await next.Page._restoreLayout();

  assert.strictEqual(mounts, 1, 'the second pane is never mounted after destroy');
  assert.strictEqual(next.sockets.length, 1, 'and opens no socket');
  assert.strictEqual(store.getItem('sv-terminals-layout'), saved,
    'a torn down page must not write the layout back out');
});

// --- concurrent mounts ------------------------------------------------------

test('two mounts of the same pane leave exactly one socket', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fresh = task('t9');
  const { Page, sockets } = loadPage({
    api: { terminalsTasks: async () => { await gate; return { items: [fresh], running: 1 } ; } },
  });
  Page._tasks = [];

  // Both calls miss the board and queue behind the same refetch.
  const a = Page._attach('t9');
  const paneId = Page._focused;
  const b = Page._mountPane(paneId);
  release();
  await Promise.all([a, b]);

  assert.strictEqual(sockets.length, 1, 'the losing mount must not leak a socket');
  assert.strictEqual(Page._panes.get(paneId).ws, sockets[0], 'the pane holds the one that won');
  assert.ok(!sockets[0].closed);
});

// --- a finished task is not listening ---------------------------------------

test('a finished task with nothing recorded says so instead of listening', async () => {
  const { Page, byId } = loadPage();
  Page._tasks = [task('t1', { status: 'done' })];
  await Page._attach('t1');
  Page._executors = [{ id: 'claude-code', label: 'Claude Code', installed: true, governed: true }];
  Page._govHas = {};
  Page._renderGovHero();

  assert.strictEqual(byId('terminals-gov-hero-title').textContent, 'No governed activity recorded');
  assert.strictEqual(byId('terminals-gov-hero-text').textContent, 'This task ended without a governed call.');
  assert.strictEqual(byId('terminals-governance-summary').textContent, 'nothing recorded');
  assert.ok(byId('terminals-gov-hero-bot').classList.contains('is-quiet'), 'the ring stops for a finished task');

  Page._tasks = [task('t1', { status: 'working' })];
  Page._renderGovHero();
  assert.strictEqual(byId('terminals-gov-hero-title').textContent, 'Governed session, listening');
  assert.ok(!byId('terminals-gov-hero-bot').classList.contains('is-quiet'));
});

test('the quiet hero bot stops the listening ring in the stylesheet', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-gov-hero-bot\.is-quiet::before, \.terminals-gov-hero-bot\.is-quiet::after \{ animation: none/);
});

// --- odds and ends ----------------------------------------------------------

test('a pane banner has no page level fallback left to write into', () => {
  const src = read('js/pages/terminals.js');
  assert.ok(!/getElementById\('terminals-banner'\)/.test(src),
    'every banner belongs to a pane now');
});

test('replaceTask coerces its task id the way create does', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  const L = sandbox.window.TerminalsLayout;
  const root = L.create('t1');
  assert.strictEqual(L.replaceTask(root, root.id, 42).taskId, '42');
  assert.strictEqual(L.replaceTask(root, root.id, null).taskId, null);
  assert.strictEqual(L.replaceTask(L.replaceTask(root, root.id, 42), root.id, '42').taskId, '42');
});

test('a chord carrying the other platform\'s modifier is not a chord', async () => {
  const mac = loadPage({ platform: 'MacIntel' });
  mac.Page._tasks = [task('t1'), task('t2')];
  await mac.Page._attach('t1');
  await mac.Page._openInNewPane('t2', 'row');
  const both = { key: 'w', code: 'KeyW', metaKey: true, ctrlKey: true, shiftKey: false, preventDefault() { this.stopped = true; } };
  mac.Page._onPaneKey(both);
  assert.strictEqual(both.stopped, undefined, 'Cmd+Ctrl+W is not Cmd+W');
  assert.strictEqual(mac.Page._panes.size, 2);

  const linux = loadPage({ platform: 'Linux x86_64' });
  linux.Page._tasks = [task('t1'), task('t2')];
  await linux.Page._attach('t1');
  await linux.Page._openInNewPane('t2', 'row');
  const meta = { key: 'W', code: 'KeyW', metaKey: true, ctrlKey: true, shiftKey: true, preventDefault() { this.stopped = true; } };
  linux.Page._onPaneKey(meta);
  assert.strictEqual(meta.stopped, undefined, 'the window manager owns the Meta combos');
  assert.strictEqual(linux.Page._panes.size, 2);
});

// --- Phase B: dragging a pane onto another pane's edge ----------------------

/** Put the panes side by side at known coordinates so elementFromPoint and
 *  the edge bands can be driven from the test. */
function layOut(ctx, boxes) {
  for (const [paneId, box] of Object.entries(boxes)) {
    const el = ctx.Page._panes.get(paneId).el;
    el.getBoundingClientRect = () => box;
    el.classList.add('terminals-pane');
    el.dataset.paneId = paneId;
  }
  ctx.elementAt = (x, y) => {
    for (const [paneId, box] of Object.entries(boxes)) {
      if (x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height) {
        return ctx.Page._panes.get(paneId).el;
      }
    }
    return null;
  };
}

async function twoPaneDrag(platform = 'MacIntel') {
  const ctx = loadPage({ platform });
  ctx.Page._tasks = [task('t1'), task('t2')];
  await ctx.Page._attach('t1');
  await ctx.Page._openInNewPane('t2', 'row');
  const [a, b] = ctx.Page._lay().panes(ctx.Page._layout).map((p) => p.id);
  layOut(ctx, {
    [a]: { left: 0, top: 0, width: 400, height: 400 },
    [b]: { left: 400, top: 0, width: 400, height: 400 },
  });
  return Object.assign(ctx, { a, b });
}

const drag = (ctx, paneId) => ctx.Page._panes.get(paneId).headEl;

test('dragging a pane onto the right edge of another reorders the split', async () => {
  const ctx = await twoPaneDrag();
  const { Page, listeners, a, b } = ctx;
  Page._focusPane(a);

  drag(ctx, a).onpointerdown({ target: { closest: () => null }, button: 0, pointerId: 3, clientX: 100, clientY: 200 });
  listeners.pointermove[0]({ clientX: 760, clientY: 200 });   // inside pane b's right band
  assert.ok(Page._panes.get(a).el.classList.contains('is-dragging'), 'the source pane dims while it travels');
  assert.strictEqual(Page._dropEl.dataset.edge, 'right');
  assert.strictEqual(Page._dropEl.style.left, '50%', 'the zone covers the half it would land in');
  assert.strictEqual(Page._dropEl.style.width, '50%');
  listeners.pointerup[0]();

  assert.strictEqual(Page._layout.type, 'split');
  assert.strictEqual(Page._layout.dir, 'row');
  assert.deepStrictEqual(Array.from(Page._lay().panes(Page._layout), (p) => p.taskId), ['t2', 't1']);
  assert.strictEqual(Page._focused, a, 'the moved pane keeps the focus');
  assert.ok(!Page._panes.get(a).el.classList.contains('is-dragging'));
  assert.strictEqual(Page._panes.size, 2, 'nothing was recreated');
});

test('a drag onto the bottom edge makes a column split', async () => {
  const ctx = await twoPaneDrag();
  const { Page, listeners, a, b } = ctx;
  drag(ctx, a).onpointerdown({ target: { closest: () => null }, button: 0, pointerId: 1, clientX: 100, clientY: 200 });
  listeners.pointermove[0]({ clientX: 600, clientY: 390 });   // pane b, bottom band
  assert.strictEqual(Page._dropEl.dataset.edge, 'bottom');
  assert.strictEqual(Page._dropEl.style.top, '50%');
  assert.strictEqual(Page._dropEl.style.height, '50%');
  listeners.pointerup[0]();
  assert.strictEqual(Page._layout.dir, 'col');
  assert.deepStrictEqual(Array.from(Page._lay().panes(Page._layout), (p) => p.taskId), ['t2', 't1']);
});

test('a pane dropped on the centre of another joins its group', async () => {
  const ctx = await twoPaneDrag();
  const { Page, listeners, a, b } = ctx;
  Page._focusPane(a);

  drag(ctx, a).onpointerdown({ target: { closest: () => null }, button: 0, pointerId: 1, clientX: 100, clientY: 200 });
  listeners.pointermove[0]({ clientX: 600, clientY: 200 });   // dead centre of pane b
  assert.strictEqual(Page._dropEl.dataset.edge, 'centre');
  assert.strictEqual(Page._dropEl.style.width, '100%', 'the zone covers the whole pane it would join');
  assert.strictEqual(Page._dropEl.style.height, '100%');
  listeners.pointerup[0]();

  assert.strictEqual(Page._panes.size, 1, 'the pane that was dragged is gone');
  assert.strictEqual(Page._layout.type, 'pane', 'and its split collapsed');
  assert.deepStrictEqual(Array.from(Page._panes.get(b).taskIds), ['t2', 't1'],
    'its task joined the end of the group it was dropped into');
  assert.strictEqual(Page._attached, 't2', 'the target keeps showing what it was showing');
  assert.strictEqual(Page._focused, b);
});

test('a drag under the threshold is a click, not a move', async () => {
  const ctx = await twoPaneDrag();
  const { Page, listeners, a } = ctx;
  const before = Page._layout;
  drag(ctx, a).onpointerdown({ target: { closest: () => null }, button: 0, pointerId: 1, clientX: 100, clientY: 200 });
  listeners.pointermove[0]({ clientX: 103, clientY: 202 });
  assert.ok(!Page._panes.get(a).el.classList.contains('is-dragging'), 'three pixels is not a drag');
  listeners.pointerup[0]();
  assert.strictEqual(Page._layout, before);
});

test('Escape cancels a drag in flight and every listener comes off', async () => {
  const ctx = await twoPaneDrag();
  const { Page, listeners, a } = ctx;
  const before = Page._layout;
  drag(ctx, a).onpointerdown({ target: { closest: () => null }, button: 0, pointerId: 1, clientX: 100, clientY: 200 });
  listeners.pointermove[0]({ clientX: 760, clientY: 200 });
  assert.strictEqual(Page._ghostEl.parentNode, ctx.body, 'the ghost is on the page while dragging');

  listeners.keydown[0]({ key: 'Escape', preventDefault() {} });

  assert.strictEqual(Page._layout, before, 'a cancelled drag changes nothing');
  assert.strictEqual(Page._ghostEl.parentNode, null, 'the ghost is taken down');
  assert.strictEqual(Page._dropEl.parentNode, null, 'and so is the drop zone');
  assert.ok(!Page._panes.get(a).el.classList.contains('is-dragging'));
  for (const type of ['pointermove', 'pointerup', 'pointercancel', 'keydown']) {
    assert.strictEqual(listeners[type].length, 0, `a ${type} listener was left behind`);
  }
  assert.strictEqual(Page._drag, null);
});

test('a cancelled pointer ends a pane drag the same way', async () => {
  const ctx = await twoPaneDrag();
  const { Page, listeners, a } = ctx;
  const before = Page._layout;
  drag(ctx, a).onpointerdown({ target: { closest: () => null }, button: 0, pointerId: 1, clientX: 100, clientY: 200 });
  listeners.pointermove[0]({ clientX: 760, clientY: 200 });
  listeners.pointercancel[0]();
  assert.strictEqual(Page._layout, before);
  assert.strictEqual(listeners.pointermove.length, 0);
});

test('a pointerdown on a head button never starts a drag', async () => {
  const ctx = await twoPaneDrag();
  const { Page, listeners, a } = ctx;
  drag(ctx, a).onpointerdown({
    target: { closest: (sel) => (sel.includes('terminals-pane-act') ? {} : null) },
    button: 0, pointerId: 1, clientX: 100, clientY: 200,
  });
  assert.strictEqual(Page._drag, undefined, 'the split and close buttons keep working');
  assert.strictEqual((listeners.pointermove || []).length, 0);
});

test('a single pane has nowhere to go, so no drag starts', async () => {
  const ctx = loadPage();
  ctx.Page._tasks = [task('t1')];
  await ctx.Page._attach('t1');
  ctx.Page._panes.get(ctx.Page._focused).headEl.onpointerdown({
    target: { closest: () => null }, button: 0, pointerId: 1, clientX: 10, clientY: 10,
  });
  assert.strictEqual(ctx.Page._drag, undefined);
  assert.strictEqual((ctx.listeners.pointermove || []).length, 0);
});

// --- Phase B: the keyboard equivalent ---------------------------------------

test('Cmd+Shift+Arrow moves the focused pane on macOS', async () => {
  const { Page } = loadPage({ platform: 'MacIntel' });
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  const focused = Page._focused;
  assert.strictEqual(Page._attached, 't2');

  const ev = { key: 'ArrowLeft', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, preventDefault() { this.stopped = true; } };
  Page._onPaneKey(ev);

  assert.strictEqual(ev.stopped, true);
  assert.deepStrictEqual(Array.from(Page._lay().panes(Page._layout), (p) => p.taskId), ['t2', 't1']);
  assert.strictEqual(Page._focused, focused, 'the pane that moved keeps the focus');
});

test('off macOS the move chord takes Ctrl+Shift+Alt', async () => {
  const { Page } = loadPage({ platform: 'Linux x86_64' });
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'col');

  const bare = { key: 'ArrowUp', metaKey: false, ctrlKey: true, shiftKey: true, altKey: false, preventDefault() { this.stopped = true; } };
  Page._onPaneKey(bare);
  assert.strictEqual(bare.stopped, undefined, 'Ctrl+Shift+Arrow alone is not the move chord off macOS');
  assert.deepStrictEqual(Array.from(Page._lay().panes(Page._layout), (p) => p.taskId), ['t1', 't2']);

  const full = { key: 'ArrowUp', metaKey: false, ctrlKey: true, shiftKey: true, altKey: true, preventDefault() { this.stopped = true; } };
  Page._onPaneKey(full);
  assert.strictEqual(full.stopped, true);
  assert.deepStrictEqual(Array.from(Page._lay().panes(Page._layout), (p) => p.taskId), ['t2', 't1']);
});

test('a move chord pointing off the edge of the layout does nothing', async () => {
  const { Page } = loadPage({ platform: 'MacIntel' });
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  const before = Page._layout;
  Page._onPaneKey({ key: 'ArrowRight', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, preventDefault() {} });
  assert.strictEqual(Page._layout, before, 'the rightmost pane cannot move further right');
  Page._onPaneKey({ key: 'ArrowUp', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, preventDefault() {} });
  assert.strictEqual(Page._layout, before, 'and there is no pane above it');
});

test('the move chord is in the table and named in the pane head', async () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /move: \{ mod: true, shift: true, alt: false, label: 'Cmd\+Shift\+Arrow' \}/);
  assert.match(src, /move: \{ mod: true, shift: true, alt: true, label: 'Ctrl\+Shift\+Alt\+Arrow' \}/);
  const mac = loadPage({ platform: 'macOS' });
  mac.Page._tasks = [task('t1'), task('t2')];
  await mac.Page._attach('t1');
  await mac.Page._openInNewPane('t2', 'row');
  assert.match(mac.Page._panes.get(mac.Page._focused).headEl.innerHTML, /drag to move, or Cmd\+Shift\+Arrow/);
});

// --- one pane needs one header ---------------------------------------------

test('a single pane hides its own head and hands its controls to the tab strip', async () => {
  const { Page, byId } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');

  const rec = Page._panes.get(Page._focused);
  assert.strictEqual(rec.headEl.hidden, true, 'the tab strip already names the task');
  assert.strictEqual(rec.headEl.innerHTML, '', 'and the hidden head holds no second copy of it');

  const strip = byId('terminals-attached-head').innerHTML;
  assert.match(strip, /id="terminals-head-pane-gov"/, 'the pane governance chip moves up');
  assert.match(strip, /aria-label="Split right"/);
  assert.match(strip, /aria-label="Split down"/);
  assert.match(strip, /aria-label="Close pane"/);
});

test('splitting gives every pane its head back, and closing back to one takes it away again', async () => {
  const { Page, byId } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');

  for (const rec of Page._panes.values()) {
    assert.strictEqual(rec.headEl.hidden, false, 'two panes each need naming');
    assert.match(rec.headEl.innerHTML, /terminals-pane-name/);
  }
  assert.ok(!byId('terminals-attached-head').innerHTML.includes('terminals-head-pane-acts'),
    'the tab strip stops carrying pane controls once the panes carry their own');

  Page._closePane(Page._focused);
  const last = Page._panes.get(Page._focused);
  assert.strictEqual(Page._panes.size, 1);
  assert.strictEqual(last.headEl.hidden, true);
  assert.match(byId('terminals-attached-head').innerHTML, /terminals-head-pane-acts/);
});

test('the page level footer goes dark once a pane carries its own', async () => {
  const { Page, byId } = loadPage();
  Page._tasks = [task('t1')];
  await Page._attach('t1');

  const pageFoot = byId('terminals-pane-foot');
  assert.strictEqual(pageFoot.hidden, true, 'one workspace shows one footer');
  assert.strictEqual(pageFoot.innerHTML, '');
  const own = Page._panes.get(Page._focused).footEl;
  assert.strictEqual(own.hidden, false);
  assert.match(own.innerHTML, /terminals-foot-path/);
});

test('the page level Guard banner goes dark once a pane carries its own', async () => {
  const { Page, byId } = loadPage();
  Page._tasks = [task('t1')];
  Page._executors = [{ id: 'claude-code', label: 'Claude Code', governed: false }];
  await Page._attach('t1');
  Page._renderGuardBanner();

  const pageBanner = byId('terminals-guard-banner');
  assert.strictEqual(pageBanner.hidden, true, 'one pane shows one Guard notice');
  assert.strictEqual(Page._panes.get(Page._focused).guardEl.hidden, false,
    'and the pane is the one showing it');
});

// --- leaving the board ------------------------------------------------------

test('showAllTasks drops the panes, the stored layout, and the stored task id', async () => {
  const { Page, store, session, byId } = loadPage();
  Page._tasks = [task('t1')];
  await Page._attach('t1');
  assert.strictEqual(session.getItem('sv-agent-task-id'), 't1');
  assert.ok(store.getItem('sv-terminals-layout'), 'the layout was stored');

  Page.showAllTasks();
  assert.strictEqual(Page._panes.size, 0);
  assert.strictEqual(session.getItem('sv-agent-task-id'), null);
  assert.strictEqual(store.getItem('sv-terminals-layout'), null);
  assert.match(byId('terminals-attached-body').innerHTML, /terminals-stage-empty/,
    'the stage keeps an empty state rather than going blank');
});

test('a board request stands down the stored layout instead of reopening it', async () => {
  const store = makeStore();
  const session = makeStore();
  const first = loadPage({ store, session });
  first.Page._tasks = [task('t1')];
  await first.Page._attach('t1');
  assert.ok(store.getItem('sv-terminals-layout'));

  // The rail's Agent Tasks row sets this on its way to the page.
  session.removeItem('sv-agent-task-id');
  session.setItem('sv-agent-tasks-board', '1');

  const next = loadPage({ store, session });
  next.Page._tasks = [task('t1')];
  next.Page._wantBoard = session.getItem('sv-agent-tasks-board') === '1';
  next.Page._layoutRestored = false;
  await next.Page._refreshTasks();
  assert.strictEqual(next.Page._panes.size, 0, 'the board was asked for, not the panes');
  assert.strictEqual(store.getItem('sv-terminals-layout'), null, 'and the stored layout is forgotten');
});

test('the drag styles are defined', () => {
  const css = read('css/styles.css');
  for (const rule of ['.terminals-pane.is-dragging', '.terminals-drag-ghost', '.terminals-drop-zone']) {
    assert.ok(css.includes(rule), `styles.css is missing ${rule}`);
  }
  assert.match(css, /\.terminals-drop-zone \{[^}]*rgba\(45, 212, 191/, 'the drop zone is the one teal accent');
});

// --- Phase C: each pane answers for its own task ----------------------------

test('each pane renders its own Guard banner from its own task', async () => {
  const { Page } = loadPage();
  Page._executors = [
    { id: 'claude-code', label: 'Claude Code', installed: true, governed: false },
    { id: 'codex', label: 'Codex', installed: true, governed: true },
  ];
  Page._tasks = [task('t1'), task('t2', { executor_id: 'codex', session_id: 'sess-2' })];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  Page._renderGuardBanner();

  const [a, b] = Page._lay().panes(Page._layout).map((p) => p.id);
  const banner = (id) => Page._panes.get(id).guardEl;
  assert.strictEqual(banner(a).hidden, false, 'the ungoverned task gets the loud banner');
  const textOf = (id) => banner(id).querySelector('.terminals-guard-banner-text').textContent;
  assert.match(textOf(a), /running without SecureVector Guard for Claude Code/);
  assert.strictEqual(banner(b).hidden, true, 'the governed task that reported in gets none');
  assert.strictEqual(textOf(b), '', 'and no text was ever written into it');
});

test('each pane renders its own status line and counts', async () => {
  const { Page } = loadPage();
  Page._tasks = [task('t1', { workspace: '/w/one', branch: 'main' }), task('t2', { workspace: '/w/two' })];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  const [a, b] = Page._lay().panes(Page._layout).map((p) => p.id);
  Page._panes.get(a).gov = { calls: 7, blocked: 2, hosts: 3 };
  Page._panes.get(a).footSig = null;
  // The page level tally belongs to the focused pane; a pane whose own read
  // has not landed must show nothing rather than borrow it.
  Page._govCounts = { governed: 99, blocked: 9 };
  Page._renderPaneFoot();

  assert.match(Page._panes.get(a).footEl.innerHTML, /7 governed · 2 blocked/,
    'a pane reports its own counts, not the focused pane\'s');
  assert.match(Page._panes.get(a).footEl.innerHTML, /terminals-foot-branch">main</);
  assert.match(Page._panes.get(b).footEl.innerHTML, /0 governed · 0 blocked/,
    'a pane with no reading of its own borrows no other pane\'s counts');
  assert.ok(!Page._panes.get(b).footEl.innerHTML.includes('99 governed'));
  assert.ok(!Page._panes.get(b).footEl.innerHTML.includes('main'));
});

test('the governance strip shows calls, blocked, and hosts per pane', async () => {
  const verdicts = {
    t1: { items: [{ action: 'allow' }, { action: 'block' }, { action: 'allow' }] },
    t2: { items: [{ action: 'allow' }] },
  };
  const { Page } = loadPage({
    api: {
      terminalsVerdicts: async (id) => verdicts[id],
      getEgressSessionDestinations: async (sid) => ({ destinations: sid === 's1' ? [{ host: 'a' }, { host: 'b' }] : [] }),
    },
  });
  Page._tasks = [task('t1', { session_id: 's1' }), task('t2', { session_id: 's2' })];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');

  await Page._refreshPaneGov();

  const [a, b] = Page._lay().panes(Page._layout).map((p) => p.id);
  assert.match(Page._panes.get(a).govEl.innerHTML, /3 calls/);
  assert.match(Page._panes.get(a).govEl.innerHTML, /1 blocked/);
  assert.match(Page._panes.get(a).govEl.innerHTML, /2 hosts/);
  assert.match(Page._panes.get(a).govEl.innerHTML, /is-blocked/, 'a blocked call is the only colour');
  assert.match(Page._panes.get(b).govEl.innerHTML, /1 calls/);
  assert.match(Page._panes.get(b).govEl.innerHTML, /0 hosts/);
  assert.ok(!Page._panes.get(b).govEl.innerHTML.includes('is-blocked'));
});

test('the strip is throttled per pane and reset when the pane changes task', async () => {
  let reads = 0;
  const { Page } = loadPage({
    api: {
      terminalsVerdicts: async () => { reads += 1; return { items: [] }; },
      getEgressSessionDestinations: async () => ({ destinations: [] }),
    },
  });
  Page._tasks = [task('t1', { session_id: 's1' }), task('t2', { session_id: 's2' })];
  await Page._attach('t1');
  await Page._refreshPaneGov();
  assert.strictEqual(reads, 1);
  await Page._refreshPaneGov();
  assert.strictEqual(reads, 1, 'a second tick inside the window reuses the cache');

  await Page._attach('t2');
  await Page._refreshPaneGov();
  assert.strictEqual(reads, 2, 'a new session in the same pane is read straight away');
});

test('the strip collapses to icons when narrow and hides when very narrow', async () => {
  const { Page } = loadPage();
  Page._tasks = [task('t1', { session_id: 's1' })];
  await Page._attach('t1');
  const pane = Page._panes.get(Page._focused);
  pane.gov = { calls: 4, blocked: 0, hosts: 1 };

  pane.el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 400 });
  pane.govSig = null;
  Page._renderPaneGov(pane.id);
  assert.strictEqual(pane.govEl.hidden, false);
  assert.ok(!pane.govEl.classList.contains('is-compact'));

  pane.el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 400 });
  Page._renderPaneGov(pane.id);
  assert.ok(pane.govEl.classList.contains('is-compact'), 'a narrow pane keeps the numbers and hides the words');
  assert.match(pane.govEl.innerHTML, /title="4 calls"/, 'the words come back as tooltips');

  pane.el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 380, height: 400 });
  Page._renderPaneGov(pane.id);
  assert.strictEqual(pane.govEl.hidden, true, 'a truncated count is worse than none');
});

test('changing the focus clears the governance panels for the new pane', async () => {
  const { Page, byId } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  Page._egress = { destinations: [{ host: 'evil.test' }] };
  Page._egressSid = 'sess-2';
  Page._contextSig = 'stale';
  byId('terminals-context').innerHTML = 'STALE GAUGE';
  byId('terminals-egress').innerHTML = 'STALE HOSTS';

  Page._focusPane(Page._lay().panes(Page._layout)[0].id);

  assert.strictEqual(Page._egress, null, 'no host list carries across the focus change');
  assert.strictEqual(Page._egressSid, null);
  assert.strictEqual(Page._contextSig, null);
  assert.ok(!byId('terminals-context').innerHTML.includes('STALE GAUGE'));
  assert.ok(!byId('terminals-egress').innerHTML.includes('STALE HOSTS'));
});

// --- Phase C: restore rules -------------------------------------------------

test('a stored layout of more than six panes is trimmed and says so', async () => {
  const store = makeStore();
  const ids = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
  const first = loadPage({ store });
  first.Page._tasks = ids.map((id) => task(id));
  await first.Page._attach('t1');
  for (const id of ids.slice(1)) await first.Page._openInNewPane(id, 'row');
  assert.strictEqual(first.Page._panes.size, 8);

  const next = loadPage({ store });
  next.Page._tasks = ids.map((id) => task(id));
  await next.Page._restoreLayout();

  assert.strictEqual(next.Page._panes.size, 6, 'six panes is the memory bound');
  assert.strictEqual(next.sockets.length, 6);
  const kept = Array.from(next.Page._lay().panes(next.Page._layout), (p) => p.taskId);
  assert.deepStrictEqual(kept, ['t1', 't2', 't3', 't4', 't5', 't6'], 'the first six in reading order');
  const last = next.Page._panes.get(next.Page._lay().panes(next.Page._layout)[5].id);
  assert.strictEqual(last.bannerEl.textContent, 'Layout trimmed to six panes.');
  assert.strictEqual(last.bannerEl.hidden, false);
});

test('a linked pane restores without a socket, beside one that has a terminal', async () => {
  const store = makeStore();
  const linked = task('L1', { origin: 'linked', session_id: 'sess-a' });
  const first = loadPage({ store });
  first.Page._tasks = [task('t1'), linked];
  await first.Page._attach('t1');
  await first.Page._openInNewPane('L1', 'row');
  assert.strictEqual(first.sockets.length, 1);

  const next = loadPage({ store });
  next.Page._tasks = [task('t1'), linked];
  await next.Page._restoreLayout();

  assert.strictEqual(next.Page._panes.size, 2);
  assert.strictEqual(next.sockets.length, 1, 'the linked pane opens none');
  const linkedPane = Array.from(next.Page._panes.values()).find((r) => r.taskId === 'L1');
  assert.strictEqual(linkedPane.ws, null);
  assert.match(linkedPane.stageEl.innerHTML, /terminals-linked-stage/);
});

test('a task interrupted while the app was closed still restores', async () => {
  const store = makeStore();
  const first = loadPage({ store });
  first.Page._tasks = [task('t1')];
  await first.Page._attach('t1');

  const next = loadPage({ store });
  next.Page._tasks = [task('t1', { status: 'interrupted', ended_at: '2026-01-01T01:00:00Z' })];
  await next.Page._restoreLayout();

  assert.strictEqual(next.Page._panes.size, 1, 'replay is worth keeping');
  const rec = next.Page._panes.get(next.Page._focused);
  assert.match(rec.footEl.innerHTML, /terminals-foot-state-/, 'the status line reads its ended state');
  assert.match(rec.footEl.innerHTML, /interrupted/);
});

// --- Phase C: Stop all ------------------------------------------------------

test('Stop all confirms inline and stops every running task in a pane', async () => {
  const stopped = [];
  const { Page, byId } = loadPage({ api: { terminalsStop: async (id) => { stopped.push(id); }, terminalsTasks: async () => ({ items: [] }) } });
  Page._tasks = [task('t1'), task('t2'), task('L1', { origin: 'linked' })];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  await Page._openInNewPane('L1', 'col');
  Page._renderAttachedHead();

  const head = byId('terminals-attached-head');
  assert.match(head.innerHTML, /id="terminals-stop-all-btn"/, 'two running tasks in panes earns a Stop all');
  head.querySelector('#terminals-stop-all-btn').onclick();
  assert.match(head.innerHTML, /Stop 2 running tasks\?/, 'it asks before it acts');
  assert.match(head.innerHTML, /id="terminals-stop-all-keep"/);
  assert.strictEqual(stopped.length, 0, 'nothing is stopped by arming the confirm');

  await head.querySelector('#terminals-stop-all-yes').onclick();
  assert.deepStrictEqual(stopped.sort(), ['t1', 't2'], 'a linked session has no process to stop');
});

test('Keep cancels Stop all and stops nothing', async () => {
  const stopped = [];
  const { Page, byId } = loadPage({ api: { terminalsStop: async (id) => { stopped.push(id); } } });
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  Page._renderAttachedHead();

  const head = byId('terminals-attached-head');
  head.querySelector('#terminals-stop-all-btn').onclick();
  head.querySelector('#terminals-stop-all-keep').onclick();

  assert.strictEqual(Page._stopAllArmed, false);
  assert.ok(!head.innerHTML.includes('Stop 2 running tasks?'));
  assert.match(head.innerHTML, /id="terminals-stop-all-btn"/, 'the button comes back');
  assert.deepStrictEqual(stopped, []);
});

test('one running pane needs no Stop all', async () => {
  const { Page, byId } = loadPage();
  Page._tasks = [task('t1'), task('t2', { status: 'done' })];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  Page._renderAttachedHead();
  assert.ok(!byId('terminals-attached-head').innerHTML.includes('terminals-stop-all-btn'),
    'the per-pane Stop already covers a single running task');
});

test('the per-pane governance styles are defined', () => {
  const css = read('css/styles.css');
  for (const rule of [
    '.terminals-pane-gov {',
    '.terminals-pane-gov.is-compact',
    '.terminals-pane-gov-item.is-blocked',
    '.terminals-pane > .terminals-guard-banner',
    '.terminals-pane > .terminals-pane-foot',
    '.terminals-stop-all-confirm',
  ]) {
    assert.ok(css.includes(rule), `styles.css is missing ${rule}`);
  }
});

// --- fix round: per-pane Restart, Stop all, and a drag that outlives nothing --

test('Restart in an unfocused pane restarts that pane\'s task, not the focused one', async () => {
  const { Page } = loadPage();
  Page._executors = [{ id: 'claude-code', label: 'Claude Code', installed: true, governed: true }];
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  const [a, b] = Page._lay().panes(Page._layout).map((p) => p.id);
  assert.strictEqual(Page._focused, b, 't2 holds the focus');

  const relaunched = [];
  Page._relaunchTask = async (t, opts) => { relaunched.push([t.id, opts.stopFirst]); };
  Page._renderGuardBanner();

  const banner = Page._panes.get(a).guardEl;
  assert.strictEqual(banner.hidden, false, 'an installed Guard the session has not loaded gets the pending banner');
  const restart = banner.querySelector('[data-guard="restart"]');
  assert.strictEqual(restart.hidden, false);
  await restart.onclick();

  assert.deepStrictEqual(relaunched, [['t1', true]], 'the unfocused pane restarts its own task');
  assert.strictEqual(Page._attached, 't2', 'and the focus never moved');
});

test('a restarted harness comes back in the same pane, not the focused one', async () => {
  const launched = [];
  const { Page } = loadPage({
    api: {
      terminalsTasks: async () => ({ items: [task('t1', { status: 'done' }), task('t2'), task('t3')] }),
      terminalsLaunch: async (ex, ws, title) => { launched.push([ex, ws, title]); return { id: 't3' }; },
    },
  });
  Page._executors = [{ id: 'claude-code', label: 'Claude Code', installed: true, governed: true }];
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  const [a, b] = Page._lay().panes(Page._layout).map((p) => p.id);
  assert.strictEqual(Page._focused, b, 't2 holds the focus');
  Page._refreshTasks = async () => { Page._tasks = [task('t1', { status: 'done' }), task('t2'), task('t3')]; };

  // No stopFirst: the stop poll waits on a real timer the sandbox does not run.
  await Page._relaunchTask(task('t1'), { pane: a });

  assert.strictEqual(launched.length, 1, 'the fresh task was launched once');
  assert.strictEqual(Page._panes.get(a).taskId, 't3', 'the restart landed in its own pane');
  assert.strictEqual(Page._panes.get(b).taskId, 't2', 'and left the other pane alone');
  assert.strictEqual(Page._panes.size, 2, 'no pane was opened or closed for it');
});

test('a failed Restart writes into its own pane\'s banner', async () => {
  const { Page } = loadPage();
  Page._executors = [{ id: 'claude-code', label: 'Claude Code', installed: true, governed: true }];
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  const [a, b] = Page._lay().panes(Page._layout).map((p) => p.id);
  Page._relaunchTask = async () => { throw new Error('The task did not stop; try again.'); };
  Page._renderGuardBanner();

  const own = Page._panes.get(a).guardEl;
  const other = Page._panes.get(b).guardEl;
  await own.querySelector('[data-guard="restart"]').onclick();

  assert.strictEqual(own.querySelector('.terminals-guard-banner-text').textContent,
    'The task did not stop; try again.');
  assert.notStrictEqual(other.querySelector('.terminals-guard-banner-text').textContent,
    'The task did not stop; try again.', 'the other pane says nothing about it');
  const btn = own.querySelector('[data-guard="restart"]');
  assert.strictEqual(btn.disabled, false, 'the button comes back so it can be tried again');
  assert.strictEqual(btn.textContent, 'Restart harness');
});

test('Stop all counts only tasks it can actually stop', async () => {
  const stopped = [];
  const { Page, byId } = loadPage({ api: { terminalsStop: async (id) => { stopped.push(id); }, terminalsTasks: async () => ({ items: [] }) } });
  Page._tasks = [
    task('t1'), task('t2'),
    task('L1', { origin: 'linked', session_id: 'sess-a' }),
    task('done1', { status: 'done' }),
  ];
  await Page._attach('t1');
  await Page._openInNewPane('L1', 'row');
  await Page._openInNewPane('done1', 'col');
  await Page._openInNewPane('t2', 'row');
  Page._renderAttachedHead();

  assert.deepStrictEqual(Array.from(Page._stoppablePanes(), (t) => t.id), ['t1', 't2'],
    'a linked session runs in the user\'s own terminal and a finished task has no process');
  const head = byId('terminals-attached-head');
  assert.match(head.innerHTML, /Stop all/);
  head.querySelector('#terminals-stop-all-btn').onclick();
  assert.match(head.innerHTML, /Stop 2 running tasks\?/, 'the count names only what it will act on');
  await head.querySelector('#terminals-stop-all-yes').onclick();
  assert.deepStrictEqual(stopped.sort(), ['t1', 't2']);
});

test('an armed Stop all confirm survives a poll that rebuilds the strip', async () => {
  const { Page, byId } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  await Page._openInNewPane('t2', 'row');
  Page._renderAttachedHead();
  const head = byId('terminals-attached-head');
  head.querySelector('#terminals-stop-all-btn').onclick();
  assert.match(head.innerHTML, /Stop 2 running tasks\?/);

  // An unchanged tick leaves the DOM, and so the armed confirm, alone.
  Page._renderAttachedHead();
  assert.match(head.innerHTML, /Stop 2 running tasks\?/);

  // A tick that really did change something rebuilds the strip; the confirm
  // must be rebuilt with it rather than silently disarming.
  Page._tasks = [task('t1', { status: 'blocked' }), task('t2')];
  Page._renderAttachedHead();
  assert.strictEqual(Page._stopAllArmed, true);
  assert.match(head.innerHTML, /Stop 2 running tasks\?/, 'a poll must not cancel a confirm the user armed');
  assert.match(head.innerHTML, /id="terminals-stop-all-keep"/);
});

test('navigating away mid drag takes the window listeners with it', async () => {
  const ctx = await twoPaneDrag();
  const { Page, listeners, a } = ctx;
  const before = Page._layout;
  drag(ctx, a).onpointerdown({ target: { closest: () => null }, button: 0, pointerId: 4, clientX: 100, clientY: 200 });
  listeners.pointermove[0]({ clientX: 760, clientY: 200 });
  assert.strictEqual(listeners.pointermove.length, 1);

  Page.destroy();

  for (const type of ['pointermove', 'pointerup', 'pointercancel', 'keydown']) {
    assert.strictEqual(listeners[type].length, 0, `a ${type} listener survived destroy()`);
  }
  assert.strictEqual(Page._drag, null);
  assert.strictEqual(Page._ghostEl.parentNode, null, 'and the ghost is off the page');
  assert.strictEqual(Page._layout, null, 'the workspace is gone, not rearranged');
  assert.notStrictEqual(before, null);
});

test('a pane banner sits in the stack rather than over its own status line', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-pane > \.terminals-banner \{ position: static; flex: 0 0 auto; \}/);
});

test('the status line gov cell is a class, so no id repeats across panes', () => {
  const src = read('js/pages/terminals.js');
  assert.ok(!/id="terminals-foot-gov"/.test(src), 'every pane renders this line; the id would repeat');
  assert.match(src, /terminals-foot-gov">/);
});

test('nothing writes parentNode by hand', () => {
  const src = read('js/pages/terminals.js');
  assert.ok(!/\.parentNode = /.test(src), 'parentNode is the DOM\'s to set, not ours');
});

// --- a pane holding a group of tasks ----------------------------------------
//
// Dragging sessions together is a later phase; these drive the model the drag
// will call, then let the page re-render from it.

function groupInto(Page, paneId, taskId) {
  const L = Page._lay();
  Page._layout = L.addTask(Page._layout, paneId, taskId);
  Page._renderLayout();
  return Page._panes.get(paneId);
}

test('a pane holding a group names each task as a tab in its own head', async () => {
  const { Page } = loadPage();
  Page._tasks = [task('t1'), task('t2', { title: 'Second task' })];
  await Page._attach('t1');
  const pane = Page._focused;
  groupInto(Page, pane, 't2');
  Page._renderPaneHead(pane);

  const head = Page._panes.get(pane).headEl;
  assert.strictEqual(head.hidden, false, 'a grouped pane keeps its head, because the tabs live there');
  assert.match(head.innerHTML, /data-tab-id="t1"/);
  assert.match(head.innerHTML, /data-tab-id="t2"/);
  assert.match(head.innerHTML, /Second task/);
  assert.match(head.innerHTML, /data-tab-close-id="t2"/, 'each tab closes on its own');
  assert.match(head.innerHTML, /data-tab-id="t2" title="Second task"/);
  assert.ok(!head.innerHTML.includes('terminals-pane-name'), 'the single name gives way to the tabs');
  assert.match(head.innerHTML, /aria-label="Split right"/, 'and the pane controls stay to the right');
});

test('a single pane still hides its head while it holds one task', async () => {
  const { Page, byId } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  const pane = Page._focused;
  assert.strictEqual(Page._panes.get(pane).headEl.hidden, true);

  groupInto(Page, pane, 't2');
  Page._renderPaneHead(pane);
  Page._renderAttachedHead();
  assert.strictEqual(Page._panes.get(pane).headEl.hidden, false,
    'the one pane shows its head once it has tabs to show');
  assert.ok(!byId('terminals-attached-head').innerHTML.includes('terminals-head-pane-acts'),
    'and takes its controls back from the strip above');
});

test('clicking a pane tab moves the socket to that task', async () => {
  const { Page, sockets, views } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  const pane = Page._focused;
  groupInto(Page, pane, 't2');
  Page._renderPaneHead(pane);
  assert.strictEqual(sockets.length, 1, 'a tab costs nothing until it is brought forward');

  const head = Page._panes.get(pane).headEl;
  const tabs = head.querySelectorAll('[data-tab-id]');
  await tabs[1].onclick({ stopPropagation() {} });

  assert.strictEqual(Page._panes.size, 1, 'the group is one pane, whatever it is showing');
  assert.strictEqual(Page._attached, 't2');
  assert.strictEqual(sockets.length, 2);
  assert.strictEqual(sockets[1].url, 'ws://local/t2');
  assert.ok(sockets[0].closed, 'one socket per pane, so the tab that left hangs up');
  assert.ok(views[0].disposed);
  assert.deepStrictEqual(Array.from(Page._panes.get(pane).taskIds), ['t1', 't2'],
    'and the group is untouched by the switch');

  await tabs[0].onclick({ stopPropagation() {} });
  assert.strictEqual(Page._attached, 't1', 'and back again');
  assert.strictEqual(sockets.length, 3);
});

test('attaching a task that is behind a tab switches to it rather than moving it', async () => {
  const { Page, sockets } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  const pane = Page._focused;
  groupInto(Page, pane, 't2');
  Page._renderPaneHead(pane);

  await Page._attach('t2');
  assert.strictEqual(Page._panes.size, 1, 'a task lives in exactly one pane, group or not');
  assert.strictEqual(Page._attached, 't2');
  assert.strictEqual(sockets.length, 2);
  assert.strictEqual(Page._paneForTask('t1'), pane, 'a task behind a tab is still in its pane');
});

test('closing one tab keeps the pane and hands it the next task', async () => {
  const { Page, sockets } = loadPage();
  Page._tasks = [task('t1'), task('t2'), task('t3')];
  await Page._attach('t1');
  const pane = Page._focused;
  groupInto(Page, pane, 't2');
  groupInto(Page, pane, 't3');
  await Page._activatePaneTask(pane, 't2');
  Page._renderPaneHead(pane);

  const head = Page._panes.get(pane).headEl;
  const closes = head.querySelectorAll('[data-tab-close-id]');
  await closes[1].onclick({ stopPropagation() {} });

  assert.strictEqual(Page._panes.size, 1);
  assert.deepStrictEqual(Array.from(Page._panes.get(pane).taskIds), ['t1', 't3']);
  assert.strictEqual(Page._attached, 't3', 'the tab after the one that closed takes over');
  assert.strictEqual(sockets[sockets.length - 1].url, 'ws://local/t3');
});

test('closing the last tab of the only pane closes the workspace', async () => {
  const { Page, session, store } = loadPage();
  Page._tasks = [task('t1')];
  await Page._attach('t1');
  const pane = Page._focused;

  await Page._closePaneTask(pane, 't1');

  assert.strictEqual(Page._layout, null);
  assert.strictEqual(Page._panes.size, 0);
  assert.strictEqual(session.getItem('sv-agent-task-id'), null);
  assert.strictEqual(store.getItem('sv-terminals-layout'), null);
});

test('a task that vanishes leaves the group and the pane stays', async () => {
  const { Page } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  const pane = Page._focused;
  groupInto(Page, pane, 't2');

  Page._tasks = [task('t1')];
  Page._pruneLayoutToTasks();

  assert.strictEqual(Page._panes.size, 1);
  assert.deepStrictEqual(Array.from(Page._panes.get(pane).taskIds), ['t1']);
});

test('Stop all reaches a task that is behind a tab', async () => {
  const stopped = [];
  const { Page } = loadPage({ api: { terminalsStop: async (id) => { stopped.push(id); } } });
  Page._tasks = [task('t1'), task('t2')];
  Page._refreshTasks = async () => {};
  await Page._attach('t1');
  const pane = Page._focused;
  groupInto(Page, pane, 't2');

  assert.deepStrictEqual(Array.from(Page._stoppablePanes(), (t) => t.id), ['t1', 't2']);
  await Page._stopAllPanes();
  assert.deepStrictEqual(stopped, ['t1', 't2'], 'a tab nobody is looking at is still a running task');
});

test('a split offers no task that is already behind a tab', async () => {
  const { Page } = loadPage();
  Page._tasks = [task('t1'), task('t2'), task('t3')];
  await Page._attach('t1');
  const pane = Page._focused;
  groupInto(Page, pane, 't2');

  Page._openSplitPicker(pane, 'row');
  const picker = Page._panes.get(pane).pickerEl;
  assert.match(picker.innerHTML, /data-pick-id="t3"/);
  assert.ok(!picker.innerHTML.includes('data-pick-id="t2"'), 't2 already has a pane, behind a tab');
});

test('a restarted harness comes back in the tab it was in, with the group intact', async () => {
  const { Page } = loadPage({
    api: {
      terminalsStop: async () => {},
      terminalsLaunch: async () => ({ id: 'fresh' }),
      terminalsTasks: async () => ({ items: [task('t1'), task('fresh')] }),
    },
  });
  Page._tasks = [task('t1'), task('t2')];
  Page._refreshTasks = async () => { Page._tasks = [task('t1'), task('fresh')]; };
  await Page._attach('t1');
  const pane = Page._focused;
  groupInto(Page, pane, 't2');
  await Page._activatePaneTask(pane, 't1');

  await Page._relaunchTask(task('t1'), { pane });

  assert.strictEqual(Page._panes.size, 1);
  assert.deepStrictEqual(Array.from(Page._panes.get(pane).taskIds), ['fresh', 't2'],
    'the new session takes the old one\'s place rather than disbanding the group');
  assert.strictEqual(Page._attached, 'fresh');
});

test('a restored layout is capped on tasks as well as on panes', async () => {
  const store = makeStore();
  const ids = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'];
  const first = loadPage({ store });
  first.Page._tasks = ids.map((id) => task(id));
  await first.Page._attach('t1');
  await first.Page._openInNewPane('t2', 'row');
  await first.Page._openInNewPane('t3', 'row');
  const panes = first.Page._lay().panes(first.Page._layout).map((p) => p.id);
  groupInto(first.Page, panes[0], 't4');
  groupInto(first.Page, panes[0], 't5');
  groupInto(first.Page, panes[1], 't6');
  groupInto(first.Page, panes[1], 't7');
  groupInto(first.Page, panes[2], 't8');
  groupInto(first.Page, panes[2], 't9');
  first.Page._persistLayout();

  const next = loadPage({ store });
  next.Page._tasks = ids.map((id) => task(id));
  await next.Page._restoreLayout();

  const kept = next.Page._lay().panes(next.Page._layout);
  assert.strictEqual(kept.length, 3, 'three panes is under the pane cap');
  assert.deepStrictEqual(Array.from(kept, (p) => Array.from(p.taskIds)),
    [['t1', 't4', 't5'], ['t2', 't6', 't7'], ['t3', 't8']], 'the ninth task is trimmed from the end');
  assert.strictEqual(next.sockets.length, 3, 'still one socket per pane, not one per task');
  const last = next.Page._panes.get(kept[2].id);
  assert.strictEqual(last.bannerEl.textContent, 'Layout trimmed to eight tasks.');
});

test('a v1 layout written before panes held groups still restores', async () => {
  const store = makeStore();
  store.setItem('sv-terminals-layout', JSON.stringify({
    v: 1, focused: 'bbbbbbbbbbbb',
    root: {
      type: 'split', id: 'aaaaaaaaaaaa', dir: 'row', ratio: 0.5,
      a: { type: 'pane', id: 'bbbbbbbbbbbb', taskId: 't1' },
      b: { type: 'pane', id: 'cccccccccccc', taskId: 't2' },
    },
  }));
  const { Page, sockets } = loadPage({ store });
  Page._tasks = [task('t1'), task('t2')];
  await Page._restoreLayout();

  assert.strictEqual(Page._panes.size, 2);
  assert.strictEqual(sockets.length, 2);
  assert.deepStrictEqual(Array.from(paneTasks(Page)), ['t1', 't2']);
  assert.deepStrictEqual(Array.from(Page._panes.get('bbbbbbbbbbbb').taskIds), ['t1'],
    'one stored task reads back as a group of one');
  assert.strictEqual(JSON.parse(store.getItem('sv-terminals-layout')).v, 2,
    'and is written back in the shape this version keeps');
});

test('the pane tab styles are defined', () => {
  const css = read('css/styles.css');
  for (const rule of [
    '.terminals-pane-sessions {',
    '.terminals-pane-session.is-active',
    '.terminals-pane-session-title',
    '.terminals-pane-session-close',
    '.terminals-pane-session:hover .terminals-pane-session-close',
  ]) {
    assert.ok(css.includes(rule), `styles.css is missing ${rule}`);
  }
});

// --- fix round: what a group does to the rest of the page -------------------

test('attaching a new task joins the focused group rather than ending it', async () => {
  const { Page, sockets } = loadPage();
  Page._tasks = [task('t1'), task('t2'), task('t3')];
  await Page._attach('t1');
  const pane = Page._focused;
  groupInto(Page, pane, 't2');

  // What the task list and the rail do: attach by id, naming no pane.
  await Page._attach('t3');

  assert.strictEqual(Page._panes.size, 1);
  assert.deepStrictEqual(Array.from(Page._panes.get(pane).taskIds), ['t1', 't2', 't3'],
    'a group the user assembled is not thrown away by a click elsewhere');
  assert.strictEqual(Page._attached, 't3', 'and the task that was asked for is the one on screen');
  assert.strictEqual(sockets[sockets.length - 1].url, 'ws://local/t3');
});

test('attaching over a pane holding one task still replaces it', async () => {
  const { Page } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  const pane = Page._focused;

  await Page._attach('t2');

  assert.strictEqual(Page._panes.size, 1);
  assert.deepStrictEqual(Array.from(Page._panes.get(pane).taskIds), ['t2'],
    'one task is not a group, so attaching feels exactly as it did');
  assert.strictEqual(Page._paneForTask('t1'), null);
});

test('a full pane refuses a new task instead of dropping one', async () => {
  const { Page } = loadPage();
  const ids = Array.from({ length: 9 }, (unused, i) => 't' + i);
  Page._tasks = ids.map((id) => task(id));
  await Page._attach('t0');
  const pane = Page._focused;
  for (const id of ids.slice(1, 8)) groupInto(Page, pane, id);
  assert.strictEqual(Page._paneTasks(Page._panes.get(pane)).length, 8);

  await Page._attach('t8');

  assert.deepStrictEqual(Array.from(Page._panes.get(pane).taskIds), ids.slice(0, 8),
    'nothing the user put in the pane is quietly lost');
  assert.strictEqual(Page._paneForTask('t8'), null);
  assert.strictEqual(Page._panes.get(pane).bannerEl.textContent, 'This pane is full. Close a tab first.');
});

test('a destroy inside an attach leaves the stored layout alone', async () => {
  const store = makeStore();
  let page = null;
  // A task the board cannot describe makes the mount re-read the board, and
  // the page is torn down inside that wait.
  const ctx = loadPage({ store, api: { terminalsTasks: async () => { page.destroy(); return { items: [] }; } } });
  page = ctx.Page;
  page._tasks = [task('t1')];
  await page._attach('t1');
  assert.notStrictEqual(store.getItem('sv-terminals-layout'), null);

  await page._attach('gone');

  assert.strictEqual(page._layout, null, 'the torn down page keeps no layout');
  assert.notStrictEqual(store.getItem('sv-terminals-layout'), null,
    'and must not remove the layout the next visit is meant to restore');
});

test('a stored tree the reader gives up on leaves the page on the board', async () => {
  const store = makeStore();
  let node = { type: 'pane', id: 'p0', taskIds: ['t1'], taskId: 't1' };
  for (let i = 1; i <= 200; i += 1) {
    node = { type: 'split', id: 's' + i, dir: 'row', ratio: 0.5, a: node, b: { type: 'pane', id: 'p' + i, taskIds: [], taskId: null } };
  }
  store.setItem('sv-terminals-layout', JSON.stringify({ v: 2, root: node, focused: 'p0' }));
  const { Page, sockets } = loadPage({ store });
  Page._tasks = [task('t1')];

  await Page._restoreLayout();

  assert.strictEqual(Page._layout, null);
  assert.strictEqual(sockets.length, 0);
  assert.strictEqual(store.getItem('sv-terminals-layout'), null, 'the layout it cannot read is forgotten');
});

test('a reader that throws is caught with the read it belongs to', async () => {
  const store = makeStore();
  const first = loadPage({ store });
  first.Page._tasks = [task('t1')];
  await first.Page._attach('t1');

  const { Page } = loadPage({ store });
  Page._tasks = [task('t1')];
  Page._lay().parse = () => { throw new RangeError('Maximum call stack size exceeded'); };

  await Page._restoreLayout();

  assert.strictEqual(Page._layout, null, 'the page falls back to the board rather than throwing out of the render');
  assert.strictEqual(store.getItem('sv-terminals-layout'), null);
});

test('the restore counts a pane through the model, not its field', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /L\._ids\(p\)\.length/,
    'prune hands a node straight back when it drops nothing, so it can still be in the older shape');
});

test('a task title is escaped where the pane tabs are written', async () => {
  const { Page } = loadPage();
  const nasty = '"><script>alert(1)</script>';
  Page._tasks = [task('t1'), task('t2', { title: nasty })];
  await Page._attach('t1');
  const pane = Page._focused;
  groupInto(Page, pane, 't2');
  Page._renderPaneHead(pane);

  const html = Page._panes.get(pane).headEl.innerHTML;
  assert.ok(!html.includes('<script>'), 'a task title is never markup');
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;'), 'it is escaped where it is written');
});

test('the pane tabs are the children of their tablist', async () => {
  const { Page } = loadPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  const pane = Page._focused;
  groupInto(Page, pane, 't2');
  Page._renderPaneHead(pane);

  const html = Page._panes.get(pane).headEl.innerHTML;
  assert.match(html, /role="tablist"/);
  assert.match(html, /class="terminals-pane-session is-active" role="tab" aria-selected="true"/,
    'the tab is the wrapper, so the close control is not a stray child of the tablist');
  assert.ok(!/role="tab"[^>]*data-tab-close-id/.test(html));
});

// A relaunch page: the task list's Relaunch names no pane, so the fresh
// session has to find its way back to the tab the old one was in.
function relaunchPage(store) {
  const ctx = loadPage({
    api: {
      terminalsStop: async () => {},
      terminalsLaunch: async () => ({ id: 'fresh' }),
      terminalsTasks: async () => ({ items: [task('t1'), task('t2'), task('fresh')] }),
    },
    store,
  });
  ctx.Page._refreshTasks = async () => { ctx.Page._tasks = [task('t1'), task('t2'), task('fresh')]; };
  return ctx;
}

test('relaunching the tab a grouped pane is showing replaces it in place', async () => {
  const { Page } = relaunchPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  const pane = Page._focused;
  groupInto(Page, pane, 't2');
  await Page._activatePaneTask(pane, 't1');

  // The task list's Relaunch: no pane, no options at all.
  await Page._relaunchTask(task('t1'));

  assert.strictEqual(Page._panes.size, 1);
  assert.deepStrictEqual(Array.from(Page._panes.get(pane).taskIds), ['fresh', 't2'],
    'the group keeps its size and the dead task does not stay tabbed');
  assert.strictEqual(Page._attached, 'fresh');
});

test('relaunching a background tab swaps that task, not the one on screen', async () => {
  const { Page } = relaunchPage();
  Page._tasks = [task('t1'), task('t2')];
  await Page._attach('t1');
  const pane = Page._focused;
  groupInto(Page, pane, 't2');
  await Page._activatePaneTask(pane, 't2');
  assert.strictEqual(Page._attached, 't2', 'the pane is showing t2, and t1 is behind a tab');

  await Page._relaunchTask(task('t1'));

  assert.deepStrictEqual(Array.from(Page._panes.get(pane).taskIds), ['fresh', 't2'],
    'the tab that was restarted is the one that changed');
  assert.strictEqual(Page._attached, 'fresh', 'and the pane shows the session it just started');
  assert.strictEqual(Page._paneForTask('t1'), null);
  assert.strictEqual(Page._lay().find(Page._layout, pane).taskId, 'fresh',
    'the model and the pane agree on which tab is on screen');
});

// --- Phase B, section 0: one strip owns the tabs ----------------------------

const stripOf = (ctx) => ctx.byId('terminals-attached-head').innerHTML;

test('a lone pane with one task keeps its tab in the top strip', async () => {
  const ctx = loadPage();
  ctx.Page._tasks = [task('t1'), task('t2')];
  await ctx.Page._attach('t1');

  assert.match(stripOf(ctx), /terminals-pane-tabs/, 'the one layout with nothing else to name it');
  assert.match(stripOf(ctx), /data-id="t1" aria-selected="true"/);
  assert.strictEqual(ctx.Page._panes.get(ctx.Page._focused).headEl.hidden, true);
});

test('a lone pane holding a group names its tasks once, in its own head', async () => {
  const ctx = loadPage();
  ctx.Page._tasks = [task('t1'), task('t2')];
  await ctx.Page._attach('t1');
  const pane = ctx.Page._focused;
  groupInto(ctx.Page, pane, 't2');
  ctx.Page._renderPaneHead(pane);
  ctx.Page._renderAttachedHead();

  const strip = stripOf(ctx);
  assert.ok(!strip.includes('terminals-pane-tabs'), 'the strip stops listing tasks');
  assert.ok(!strip.includes('data-id="t1"'));
  assert.match(strip, /terminals-pane-tab-new/, 'the launch action stays');
  assert.match(strip, /terminals-all-tasks-btn/, 'and so does All tasks');
  assert.match(ctx.Page._panes.get(pane).headEl.innerHTML, /data-tab-id="t2"/, 'the pane head names them');
});

test('several panes leave no task tabs in the top strip', async () => {
  const ctx = loadPage();
  ctx.Page._tasks = [task('t1'), task('t2')];
  await ctx.Page._attach('t1');
  await ctx.Page._openInNewPane('t2', 'row');
  ctx.Page._renderAttachedHead();

  const strip = stripOf(ctx);
  assert.ok(!strip.includes('terminals-pane-tabs'));
  assert.ok(!strip.includes('aria-selected'));
  for (const rec of ctx.Page._panes.values()) {
    assert.match(rec.headEl.innerHTML, /terminals-pane-name/, 'each pane names its own task');
  }
});

test('the overflow count goes with the tabs it counted', async () => {
  const ctx = loadPage();
  ctx.Page._tasks = Array.from({ length: 12 }, (unused, i) => task('t' + i));
  await ctx.Page._attach('t0');
  assert.match(stripOf(ctx), /terminals-pane-tab-more/, 'one pane, one task: the strip still counts the rest');

  const pane = ctx.Page._focused;
  groupInto(ctx.Page, pane, 't1');
  ctx.Page._renderAttachedHead();
  assert.ok(!stripOf(ctx).includes('terminals-pane-tab-more'),
    'a count of tabs nobody can see from here would be a puzzle, not a hint');
});

// --- Phase B: dragging a task into a pane -----------------------------------

// The drop is committed after the release without anything awaiting it, the
// way a real pointerup does, so a test waits for the microtasks to drain.
const settle = () => new Promise((r) => setImmediate(r));

async function railDrag() {
  const ctx = await twoPaneDrag();
  ctx.Page._tasks = [task('t1'), task('t2'), task('t3')];
  return ctx;
}

const railEvent = (over = {}) => Object.assign({ button: 0, pointerId: 9, clientX: 0, clientY: 0 }, over);

test('a task dragged from the rail onto a pane centre joins that group', async () => {
  const ctx = await railDrag();
  const { Page, listeners, b } = ctx;

  assert.strictEqual(Page.beginTaskDrag('t3', railEvent()), true);
  listeners.pointermove[0]({ clientX: 600, clientY: 200 });   // centre of pane b
  assert.strictEqual(Page._dropEl.dataset.edge, 'centre');
  assert.strictEqual(Page._dropEl.style.width, '100%');
  listeners.pointerup[0]();
  await settle();

  assert.strictEqual(Page._panes.size, 2, 'it joined a pane rather than opening one');
  assert.deepStrictEqual(Array.from(Page._panes.get(b).taskIds), ['t2', 't3']);
  assert.strictEqual(Page._attached, 't3', 'the task that was dropped is the one on screen');
  assert.strictEqual(Page._focused, b);
});

test('a task dragged onto a pane edge opens in a half of its own', async () => {
  const ctx = await railDrag();
  const { Page, listeners } = ctx;

  Page.beginTaskDrag('t3', railEvent());
  listeners.pointermove[0]({ clientX: 790, clientY: 200 });   // pane b, right band
  assert.strictEqual(Page._dropEl.dataset.edge, 'right');
  assert.strictEqual(Page._dropEl.style.width, '50%', 'an edge promises half a pane, not the whole one');
  listeners.pointerup[0]();
  await settle();

  assert.strictEqual(Page._panes.size, 3);
  assert.deepStrictEqual(Array.from(Page._lay().panes(Page._layout), (p) => p.taskId), ['t1', 't2', 't3']);
  assert.strictEqual(Page._attached, 't3');
});

test('a task dropped on the pane already holding it is not a target at all', async () => {
  const ctx = await railDrag();
  const { Page, listeners, a } = ctx;
  const before = Page._layout;

  Page.beginTaskDrag('t1', railEvent());
  listeners.pointermove[0]({ clientX: 200, clientY: 200 });   // centre of pane a, which has t1
  assert.strictEqual(Page._dropEl, undefined, 'a zone has to promise something real');
  listeners.pointerup[0]();
  await settle();

  assert.strictEqual(Page._layout, before, 'the tree is untouched');
  assert.strictEqual(Page._panes.size, 2);
});

test('a task drag under the threshold is a click, and one pixel more is a drag', async () => {
  const ctx = await railDrag();
  const { Page, listeners } = ctx;

  Page.beginTaskDrag('t3', railEvent({ clientX: 100, clientY: 100 }));
  listeners.pointermove[0]({ clientX: 106, clientY: 106 });
  assert.strictEqual(Page._ghostEl, undefined, 'six pixels is still a click');
  listeners.pointermove[0]({ clientX: 107, clientY: 106 });
  assert.ok(Page._ghostEl, 'seven is a drag');
  assert.strictEqual(Page._ghostEl.textContent, 't3', 'and the ghost names what is being dragged');
  listeners.pointercancel[0]();
  assert.strictEqual(Page._drag, null);
});

test('Escape tears a task drag down and takes every listener with it', async () => {
  const ctx = await railDrag();
  const { Page, listeners } = ctx;
  const before = Page._layout;

  Page.beginTaskDrag('t3', railEvent());
  listeners.pointermove[0]({ clientX: 600, clientY: 200 });
  assert.ok(Page._dropEl.parentNode, 'a zone is up');
  listeners.keydown[0]({ key: 'Escape', preventDefault() {} });

  assert.strictEqual(Page._drag, null);
  assert.strictEqual(Page._dropEl.parentNode, null, 'the zone comes down');
  assert.strictEqual(Page._ghostEl.parentNode, null, 'and so does the ghost');
  assert.strictEqual((listeners.pointermove || []).length, 0);
  assert.strictEqual((listeners.keydown || []).length, 0);
  assert.strictEqual(Page._layout, before);
});

test('a task that ends mid drag tears the drag down', async () => {
  const ctx = await railDrag();
  const { Page, listeners } = ctx;
  // What the 3 s poll does when a task has ended and left the board.
  Page._refreshTasks = async () => {
    Page._tasks = [task('t1'), task('t2')];
    Page._renderTaskList();
    Page._renderPaneHeads();
    Page._checkDragAlive();
  };

  Page.beginTaskDrag('t3', railEvent());
  listeners.pointermove[0]({ clientX: 600, clientY: 200 });
  assert.ok(Page._drag);

  await Page._refreshTasks();

  assert.strictEqual(Page._drag, null, 'there is nothing left to drop');
  assert.strictEqual(Page._dropEl.parentNode, null);
  assert.strictEqual((listeners.pointermove || []).length, 0);
});

test('beginTaskDrag refuses when there is nowhere to drop', async () => {
  const ctx = loadPage();
  const { Page } = ctx;
  Page._tasks = [task('t1')];
  assert.strictEqual(Page.beginTaskDrag('t1', railEvent()), false, 'no panes, no drop');

  await Page._attach('t1');
  assert.strictEqual(Page.beginTaskDrag('nope', railEvent()), false, 'a task the board does not have');
  assert.strictEqual(Page.beginTaskDrag('t1', railEvent({ button: 2 })), false, 'the right button is not a drag');
  assert.strictEqual(Page._drag, undefined, 'and a refusal leaves no drag behind');
});

// --- Phase B: dragging one board card onto another --------------------------

async function cardDrag() {
  const ctx = loadPage();
  ctx.Page._tasks = [task('t1'), task('t2')];
  ctx.Page._renderTaskList();
  const cards = ctx.byId('terminals-task-list').querySelectorAll('.terminals-task[data-id]');
  const at = {};
  for (const card of cards) at[card.dataset.id] = card;
  // Card t1 on the left, card t2 on the right.
  ctx.elementAt = (x) => (x < 100 ? at.t1 : at.t2);
  return Object.assign(ctx, { cards, at });
}

const cardEvent = (card, over = {}) => Object.assign(
  { button: 0, pointerId: 4, clientX: 10, clientY: 10, currentTarget: card, target: { closest: () => null } }, over);

test('a card dragged onto another card opens both in one pane', async () => {
  const ctx = await cardDrag();
  const { Page, listeners, at } = ctx;

  at.t1.onpointerdown(cardEvent(at.t1));
  listeners.pointermove[0]({ clientX: 300, clientY: 40 });
  assert.ok(at.t2.classList.contains('is-drop-target'), 'the card it would land on says so');
  assert.strictEqual(Page._ghostEl.textContent, 't1');
  listeners.pointerup[0]();
  await settle();

  assert.strictEqual(Page._panes.size, 1, 'one pane, holding both');
  const rec = Page._panes.get(Page._focused);
  assert.deepStrictEqual(Array.from(rec.taskIds), ['t2', 't1'],
    'the card that was dropped on opens first, the dragged one joins it');
  assert.strictEqual(Page._attached, 't1', 'and the dragged one is the tab on screen');
  assert.ok(!at.t2.classList.contains('is-drop-target'), 'the drop state comes off');
});

test('a card dropped on itself or on empty space does nothing', async () => {
  const ctx = await cardDrag();
  const { Page, listeners, at } = ctx;

  at.t1.onpointerdown(cardEvent(at.t1));
  listeners.pointermove[0]({ clientX: 50, clientY: 40 });   // still over its own card
  assert.ok(!at.t1.classList.contains('is-drop-target'));
  listeners.pointerup[0]();
  await settle();
  assert.strictEqual(Page._layout, null, 'nothing opened');

  ctx.elementAt = () => null;
  at.t1.onpointerdown(cardEvent(at.t1, { pointerId: 5 }));
  listeners.pointermove[0]({ clientX: 600, clientY: 400 });
  listeners.pointerup[0]();
  await settle();
  assert.strictEqual(Page._layout, null, 'and empty space is not a card');
});

test('the click that ends a card drag does not also open the card', async () => {
  const ctx = await cardDrag();
  const { Page, listeners, at, byId } = ctx;
  const opened = [];
  Page._attach = async (id) => { opened.push(id); };

  at.t1.onpointerdown(cardEvent(at.t1));
  listeners.pointermove[0]({ clientX: 300, clientY: 40 });
  listeners.pointerup[0]();
  await settle();
  const select = byId('terminals-task-list').querySelectorAll('.terminals-task-select')
    .find((b) => b.dataset.id === 't2');
  select.onclick();
  assert.deepStrictEqual(opened, ['t2'], 'only the drop opened anything, not the click after it');

  // The next click, with no drag before it, opens normally.
  select.onclick();
  assert.deepStrictEqual(opened, ['t2', 't2']);
});

test('the rail and the board ask the same question before opening a task', () => {
  const src = read('js/components/sidebar.js');
  assert.match(src, /TerminalsPage\.beginTaskDrag\(view\.taskId, ev\)/,
    'the rail offers a row as a drag source and lets the page decide');
  assert.match(src, /TerminalsPage\.consumeDragClick\(\)/,
    'and the click that ends a drag is not a request to open a task');
});

test('the drop affordances are defined', () => {
  const css = read('css/styles.css');
  for (const rule of [
    '.terminals-drop-zone[data-edge="centre"]',
    '.terminals-task.is-drop-target',
  ]) {
    assert.ok(css.includes(rule), `styles.css is missing ${rule}`);
  }
});

// --- fix round: a drag that ends in no click leaves no click owed -----------

test('a committed pane drag leaves no click owed to anyone else', async () => {
  const ctx = await twoPaneDrag();
  const { Page, listeners, a } = ctx;
  Page._focusPane(a);

  drag(ctx, a).onpointerdown({ target: { closest: () => null }, button: 0, pointerId: 3, clientX: 100, clientY: 200 });
  listeners.pointermove[0]({ clientX: 760, clientY: 200 });
  listeners.pointerup[0]();

  // The click after a pane drag lands on the pane head, where nothing asks.
  // A flag left standing here is eaten by the next rail row instead.
  assert.strictEqual(Page.consumeDragClick(), false, 'the next rail click must still open its task');
});

test('Escape, a cancelled pointer, and a task that ends leave no click owed', async () => {
  const ctx = await railDrag();
  const { Page, listeners } = ctx;

  Page.beginTaskDrag('t3', railEvent());
  listeners.pointermove[0]({ clientX: 600, clientY: 200 });
  listeners.keydown[0]({ key: 'Escape', preventDefault() {} });
  assert.strictEqual(Page.consumeDragClick(), false, 'an abandoned drag is followed by no click');

  Page.beginTaskDrag('t3', railEvent());
  listeners.pointermove[0]({ clientX: 600, clientY: 200 });
  listeners.pointercancel[0]();
  assert.strictEqual(Page.consumeDragClick(), false, 'and neither is a cancelled pointer');

  Page.beginTaskDrag('t3', railEvent());
  listeners.pointermove[0]({ clientX: 600, clientY: 200 });
  Page._tasks = [task('t1'), task('t2')];
  Page._checkDragAlive();
  assert.strictEqual(Page._drag, null);
  assert.strictEqual(Page.consumeDragClick(), false, 'nor a task that ended under the pointer');
});

test('a destroy mid drag leaves no click owed on the next visit', async () => {
  const ctx = await railDrag();
  const { Page, listeners } = ctx;

  Page.beginTaskDrag('t3', railEvent());
  listeners.pointermove[0]({ clientX: 600, clientY: 200 });
  Page.destroy();

  assert.strictEqual(Page._drag, null);
  assert.strictEqual(Page.consumeDragClick(), false, 'coming back to a swallowed first click is a bug nobody can explain');
});

test('a drag that does open a task still swallows its own click', async () => {
  const ctx = await railDrag();
  const { Page, listeners } = ctx;

  Page.beginTaskDrag('t3', railEvent());
  listeners.pointermove[0]({ clientX: 600, clientY: 200 });
  listeners.pointerup[0]();
  await settle();

  assert.strictEqual(Page.consumeDragClick(), true, 'the release lands on the row that was dragged');
  assert.strictEqual(Page.consumeDragClick(), false, 'and it is owed once, not forever');
});

test('a destroy inside a centre drop opens no pane and keeps the stored layout', async () => {
  const store = makeStore();
  let page = null;
  const ctx = loadPage({ store, api: { terminalsTasks: async () => { page.destroy(); return { items: [] }; } } });
  page = ctx.Page;
  page._tasks = [task('t1'), task('t2')];
  await page._attach('t1');
  await page._openInNewPane('t2', 'row');
  const L = page._lay();
  const [a, b] = L.panes(page._layout).map((p) => p.id);
  // A tab that has already left the board is what sends the pane it settles
  // on back to the server, and the teardown lands inside that wait.
  page._layout = L.setActive(L.addTask(page._layout, a, 'ended'), a, 't1');
  page._renderLayout();
  const sockets = ctx.sockets.length;

  await page._dropTaskOnPane('t1', b, 'centre');

  assert.strictEqual(page._layout, null, 'a torn down page builds no workspace');
  assert.strictEqual(page._panes.size, 0, 'and no pane comes back from nothing');
  assert.strictEqual(ctx.sockets.length, sockets, 'no socket is opened on a page that is gone');
  // What must not happen is the stored workspace being replaced by a fresh
  // pane built after the teardown; the drop that really happened is fine.
  const stored = JSON.parse(store.getItem('sv-terminals-layout'));
  assert.strictEqual(stored.root.type, 'split', 'the stored layout is still the one that existed');
  assert.deepStrictEqual(stored.root.b.taskIds, ['t2', 't1']);
  assert.strictEqual(stored.root.b.id, b, 'and its panes are the panes that were there');
});

test('a claim cannot rebuild a workspace on a torn down page', async () => {
  const ctx = loadPage();
  const { Page } = ctx;
  Page._tasks = [task('t1')];
  await Page._attach('t1');
  Page.destroy();

  assert.strictEqual(Page._claimFocusedPane('t1'), null, 'the first pane of a visit is not built by a page that ended');
  assert.strictEqual(Page._layout, null);
  assert.strictEqual(Page._panes.size, 0);
});

test('a torn-down page is marked so before anything else in destroy can throw', () => {
  const src = read('js/pages/terminals.js');
  const destroyFn = src.slice(src.indexOf('    destroy() {'), src.indexOf('    _detach() {'));
  const flag = destroyFn.indexOf('this._destroyed = true;');
  const firstCall = destroyFn.indexOf('clearInterval(');
  assert.ok(flag > -1 && flag < firstCall,
    'destroy() runs inside a try/catch, so the guard must be set before anything that could throw');
});

test('a drag source clears an owed click before it decides whether to drag', () => {
  const src = read('js/pages/terminals.js');
  for (const fn of ['beginTaskDrag(taskId, ev) {', '_onCardPointerDown(ev, taskId) {']) {
    const body = src.slice(src.indexOf(fn), src.indexOf(fn) + 400);
    const clear = body.indexOf('this._clickAfterDrag = false;');
    const firstRefusal = body.indexOf('return');
    assert.ok(clear > -1 && clear < firstRefusal,
      `${fn} must clear the owed click before any refusal, or a source that declines strands it`);
  }
});
