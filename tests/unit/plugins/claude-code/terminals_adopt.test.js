/** Sessions running outside the board, offered on the board.
 *
 * Agent sessions started in the user's own terminal already report every tool
 * call through their Guard plugin, so /sessions/unlinked can name them. Until
 * now that list only appeared inside the launch form, and only after the user
 * flipped the form from Launch to Link: a feature you had to already know
 * about to discover. The board now surfaces the same rows with a one-click
 * Govern.
 *
 * What these tests pin is the behaviour that makes it safe to put on a 3 s
 * poll cycle and in front of someone every day: the throttle, the per-session
 * dismissal, the preview cap, and a form-free adopt that cannot double-fire.
 *
 * DOM stub mirrors terminals_gov_dock.test.js, with one addition: the adopt
 * container parses the innerHTML it is handed into button stubs, so the
 * assertions below click real rendered controls rather than reading source.
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
  const listeners = {};
  return Object.assign({
    innerHTML: '',
    textContent: '',
    className: '',
    hidden: false,
    disabled: false,
    dataset: {},
    style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) { (this.attrs || (this.attrs = {}))[k] = v; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    dispatch(t, event = {}) { for (const fn of [...(listeners[t] || [])]) fn(event); },
    _listeners: listeners,
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
    isConnected: true,
  }, extra);
}

function memStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

/** Turn rendered markup into clickable button stubs, so a test can press
 *  Govern the way a person does instead of matching on source text. */
function parseButtons(html) {
  const out = [];
  const tag = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = tag.exec(html))) {
    const attrs = {};
    const attr = /([a-zA-Z-]+)="([^"]*)"/g;
    let a;
    while ((a = attr.exec(m[1]))) attrs[a[1]] = a[2];
    const dataset = {};
    for (const k of Object.keys(attrs)) {
      if (!k.startsWith('data-')) continue;
      dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = attrs[k];
    }
    out.push({
      attrs, dataset, className: attrs.class || '',
      textContent: m[2], disabled: false, onclick: null,
    });
  }
  return out;
}

/** The #terminals-adopt container: assigning innerHTML re-parses its buttons,
 *  and querySelectorAll('.cls') hands them back for the page to bind. */
function adoptEl() {
  const el = makeEl();
  let html = '';
  el._buttons = [];
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set: (v) => { html = String(v); el._buttons = parseButtons(html); },
    configurable: true,
  });
  el.querySelectorAll = (sel) => {
    const cls = sel.replace(/^\./, '');
    return el._buttons.filter((b) => b.className.split(/\s+/).includes(cls));
  };
  el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;
  return el;
}

function loadPage(extra = {}) {
  const window = {};
  const elements = {};
  const adopt = adoptEl();
  elements['terminals-adopt'] = adopt;
  const sandbox = Object.assign({
    window,
    document: {
      getElementById: (id) => elements[id] || (elements[id] = makeEl()),
      querySelector: () => null,
    },
    API: {},
    URLSearchParams,
    WebSocket: { OPEN: 1, CLOSED: 3 },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    localStorage: memStore(),
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    console: { warn() {}, error() {} },
  }, extra);
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  vm.runInNewContext(read('js/pages/terminals.js'), sandbox);
  return { page: sandbox.window.TerminalsPage, adopt, elements, sandbox };
}

/** Row i is i minutes old, so row 1 is always the newest. */
function row(i, extra = {}) {
  return Object.assign({
    executor_id: 'claude-code',
    label: 'Claude Code',
    session_id: `sess-${i}`,
    last_at: new Date(Date.now() - i * 60000).toISOString(),
    calls: i * 3,
    workspace: `/Users/me/projects/p${i}`,
  }, extra);
}

const rowCount = (html) => (html.match(/terminals-adopt-row/g) || []).length;
/** Let a resolved promise's continuations run without a real timer. */
const drain = () => new Promise((r) => setImmediate(r));

const installed = [{ id: 'claude-code', label: 'Claude Code', installed: true, governed: false }];

// --------------------------------------------------------------- rendering

test('the panel stays hidden when nothing is running outside the board', async () => {
  const { page, adopt } = loadPage({ API: { terminalsUnlinkedSessions: async () => ({ items: [] }) } });
  page._adoptAt = 0;
  await page._maybeLoadAdoptable();
  assert.equal(adopt.hidden, true, 'no rows means no panel, not an empty state box');
  assert.equal(adopt.innerHTML, '');
});

test('a failed read leaves the panel empty rather than throwing at the board', async () => {
  const { page, adopt } = loadPage({
    API: { terminalsUnlinkedSessions: async () => { throw new Error('boom'); } },
  });
  page._adoptAt = 0;
  await assert.doesNotReject(() => page._maybeLoadAdoptable());
  assert.deepEqual(page._adoptable, []);
  assert.equal(adopt.hidden, true);
});

test('three rows render whole, five collapse to a preview with Show all', () => {
  const { page, adopt } = loadPage();
  page._adoptable = [row(1), row(2), row(3)];
  page._renderAdoptable();
  assert.equal(adopt.hidden, false);
  assert.equal(rowCount(adopt.innerHTML), 3, 'at the cap, every row is shown');
  assert.equal(adopt.querySelector('.terminals-adopt-more'), null, 'no toggle when nothing is hidden');
  assert.ok(adopt.innerHTML.includes('Running outside SecureVector'));
  assert.ok(adopt.innerHTML.includes('These sessions are reporting in but are not on your board yet.'));

  page._adoptable = [row(1), row(2), row(3), row(4), row(5)];
  page._renderAdoptable();
  assert.equal(rowCount(adopt.innerHTML), 3, 'past the cap only the preview renders');
  const more = adopt.querySelector('.terminals-adopt-more');
  assert.ok(more, 'a text toggle appears');
  assert.equal(more.textContent, 'Show all 5', 'the count names the whole list, not the preview');

  more.onclick();
  assert.equal(rowCount(adopt.innerHTML), 5, 'expanding renders every row');
  assert.equal(adopt.querySelector('.terminals-adopt-more').textContent, 'Show fewer');
});

test('every row names its session, beside the folder', () => {
  const { page, adopt } = loadPage();
  page._adoptable = [row(1, { session_id: 'ac8210e6-75d5-4402-b635-01a694a61a68' })];
  page._renderAdoptable();
  const html = adopt.innerHTML;

  assert.ok(html.includes('>ac8210e6<'), 'the first eight characters, as the unlinked list shows them');
  assert.ok(html.includes('title="ac8210e6-75d5-4402-b635-01a694a61a68"'),
    'the whole id is the tooltip, so it can be matched against --resume');
  assert.ok(html.indexOf('terminals-adopt-folder') < html.indexOf('terminals-adopt-sid'),
    'it reads after the folder, not before it');
});

test('a row whose folder was never reported is still named by its session', () => {
  const { page, adopt } = loadPage();
  // The sentinel the host writes when no hook ever reported a cwd.
  page._adoptable = [row(1, { workspace: '(unknown folder)', session_id: 'beef1234-aaaa' })];
  page._renderAdoptable();
  const html = adopt.innerHTML;

  assert.ok(html.includes('folder not reported'));
  assert.ok(html.includes('>beef1234<'),
    'otherwise the row carries nothing that tells it from any other');
});

test('rows are newest first and carry harness, folder, age and call count', () => {
  const { page, adopt } = loadPage();
  page._adoptable = [row(9), row(1, { calls: 1 })];
  page._renderAdoptable();
  const html = adopt.innerHTML;
  assert.ok(html.indexOf('sess-1') < html.indexOf('sess-9'), 'the most recent session leads');
  assert.ok(html.includes('Claude Code'), 'the harness label');
  assert.ok(html.includes('title="/Users/me/projects/p1"'), 'the full folder path is the tooltip');
  assert.ok(html.includes('1 call<'), 'one call is singular');
  assert.ok(html.includes('27 calls<'), 'more than one is plural');
  assert.ok(html.includes('aria-label="Dismiss this session"'));
});

// ------------------------------------------------------------- dismissal

test('a dismissed session leaves the panel and stays gone across a reload', () => {
  const store = memStore();
  const first = loadPage({ localStorage: store });
  first.page._adoptable = [row(1), row(2)];
  first.page._renderAdoptable();
  assert.equal(rowCount(first.adopt.innerHTML), 2);

  first.adopt.querySelectorAll('.terminals-adopt-dismiss')[0].onclick();
  assert.equal(rowCount(first.adopt.innerHTML), 1, 'dismissal is per session, not per panel');
  assert.ok(!first.adopt.innerHTML.includes('sess-1'));
  assert.ok(first.adopt.innerHTML.includes('sess-2'), 'the other session is untouched');

  const second = loadPage({ localStorage: store });
  second.page._adoptable = [row(1), row(2)];
  second.page._renderAdoptable();
  assert.ok(!second.adopt.innerHTML.includes('sess-1'), 'the dismissal survived the reload');
  assert.ok(second.adopt.innerHTML.includes('sess-2'));
});

test('a stored shape that is not v: 1 is dropped rather than trusted', () => {
  const store = memStore();
  const { page, adopt } = loadPage({ localStorage: store });
  store.setItem(page.ADOPT_DISMISS_KEY, JSON.stringify({ v: 2, ids: { 'sess-1': Date.now() } }));
  page._adoptable = [row(1)];
  page._renderAdoptable();
  assert.ok(adopt.innerHTML.includes('sess-1'), 'a foreign version hides nothing');

  store.setItem(page.ADOPT_DISMISS_KEY, 'not json at all');
  page._renderAdoptable();
  assert.ok(adopt.innerHTML.includes('sess-1'), 'unreadable storage hides nothing either');
});

test('dismissals older than the TTL are pruned on read so the key cannot grow', () => {
  const store = memStore();
  const { page, adopt } = loadPage({ localStorage: store });
  const stale = Date.now() - page.ADOPT_DISMISS_TTL_MS - 1000;
  store.setItem(page.ADOPT_DISMISS_KEY, JSON.stringify({ v: 1, ids: { 'sess-1': stale, 'sess-2': Date.now() } }));
  page._adoptable = [row(1), row(2)];
  page._renderAdoptable();
  assert.ok(adopt.innerHTML.includes('sess-1'), 'an expired dismissal stops hiding its session');
  assert.ok(!adopt.innerHTML.includes('sess-2'));

  page._adoptDismiss('sess-3');
  const saved = JSON.parse(store.getItem(page.ADOPT_DISMISS_KEY));
  assert.deepEqual(Object.keys(saved.ids).sort(), ['sess-2', 'sess-3'], 'the expired id is not written back');
});

// --------------------------------------------------------------- throttle

test('_maybeLoadAdoptable does not refetch inside its window, and does once past it', async () => {
  let calls = 0;
  const { page } = loadPage({
    API: { terminalsUnlinkedSessions: async () => { calls += 1; return { items: [] }; } },
  });
  page._adoptAt = 0;
  await page._maybeLoadAdoptable();
  assert.equal(calls, 1);
  await page._maybeLoadAdoptable();
  await page._maybeLoadAdoptable();
  assert.equal(calls, 1, 'the 3 s board cycle must not drag this audit aggregate with it');

  page._adoptAt = Date.now() - page.ADOPT_POLL_MS - 1;
  await page._maybeLoadAdoptable();
  assert.equal(calls, 2, 'past the window it reads again');
});

test('a slow read cannot queue a second one behind it', async () => {
  let calls = 0;
  let finish;
  const { page } = loadPage({
    API: { terminalsUnlinkedSessions: () => { calls += 1; return new Promise((r) => { finish = r; }); } },
  });
  page._adoptAt = 0;
  const inFlight = page._maybeLoadAdoptable();
  await page._maybeLoadAdoptable();
  assert.equal(calls, 1, 'the clock is stamped before the await, not after it');
  finish({ items: [] });
  await inFlight;
});

// ------------------------------------------------------------------ adopt

test('Govern links the row through the API and refuses a second click in flight', async () => {
  const linked = [];
  let finish;
  const { page, adopt } = loadPage({
    API: { terminalsLink: (...args) => { linked.push(args); return new Promise((r) => { finish = r; }); } },
  });
  page._executors = installed;
  page._refreshTasks = async () => {};
  page._adoptable = [row(1)];
  page._renderAdoptable();

  const btn = adopt.querySelectorAll('.terminals-adopt-govern')[0];
  btn.onclick();
  assert.deepEqual(linked, [['claude-code', 'sess-1', '/Users/me/projects/p1', '']],
    'executor, session and folder come from the row; the title is left empty');
  assert.equal(btn.disabled, true);
  assert.equal(btn.textContent, 'Adopting…');

  btn.onclick();
  assert.equal(linked.length, 1, 'a double click must not make two task rows');

  finish({ id: 'task-1' });
  await drain();
  assert.equal(rowCount(adopt.innerHTML), 0, 'the adopted row leaves the panel at once');
  assert.equal(page._adoptAt, 0, 'and the next cycle refetches rather than waiting out the window');
});

test('an uninstalled harness is refused before any network call', async () => {
  const linked = [];
  const { page, adopt } = loadPage({
    API: { terminalsLink: (...args) => { linked.push(args); return Promise.resolve({}); } },
  });
  page._executors = [{ id: 'claude-code', label: 'Claude Code', installed: false, hint: 'Install the Claude Code CLI first.' }];
  page._refreshTasks = async () => {};
  page._adoptable = [row(1)];
  page._renderAdoptable();

  adopt.querySelectorAll('.terminals-adopt-govern')[0].onclick();
  await drain();
  assert.equal(linked.length, 0, 'no request is made for a harness that is not there');
  assert.ok(adopt.innerHTML.includes('Install the Claude Code CLI first.'), 'the harness hint is what gets shown');
  assert.equal(rowCount(adopt.innerHTML), 1, 'the row stays, because installing the harness fixes it');
});

test('an ungoverned session is adoptable: that is how it gets governed', async () => {
  const linked = [];
  const { page, adopt } = loadPage({
    API: { terminalsLink: (...args) => { linked.push(args); return Promise.resolve({ id: 'task-1' }); } },
  });
  page._executors = [{ id: 'claude-code', label: 'Claude Code', installed: true, governed: false }];
  page._refreshTasks = async () => {};
  page._adoptable = [row(1)];
  page._renderAdoptable();

  adopt.querySelectorAll('.terminals-adopt-govern')[0].onclick();
  await drain();
  assert.equal(linked.length, 1, 'installed is required, governed is deliberately not');
});

test('a session adopted elsewhere already drops out quietly instead of erroring', async () => {
  const { page, adopt } = loadPage({
    API: { terminalsLink: async () => { throw new Error('This session is already on the board.'); } },
  });
  page._executors = installed;
  page._refreshTasks = async () => {};
  page._adoptable = [row(1), row(2)];
  page._renderAdoptable();

  adopt.querySelectorAll('.terminals-adopt-govern')[0].onclick();
  await drain();
  assert.ok(!adopt.innerHTML.includes('sess-1'), 'the row it names is gone');
  assert.ok(!adopt.innerHTML.includes('terminals-adopt-error'), 'and no error the person cannot act on');
  assert.ok(adopt.innerHTML.includes('sess-2'), 'the rest of the panel is untouched');
});

test('a real failure re-enables the button and says what went wrong', async () => {
  const { page, adopt } = loadPage({
    API: { terminalsLink: async () => { throw new Error('Terminals: request not authorised'); } },
  });
  page._executors = installed;
  page._refreshTasks = async () => {};
  page._adoptable = [row(1)];
  page._renderAdoptable();

  adopt.querySelectorAll('.terminals-adopt-govern')[0].onclick();
  await drain();
  assert.ok(adopt.innerHTML.includes('Terminals: request not authorised'));
  assert.equal(rowCount(adopt.innerHTML), 1, 'the row stays so it can be retried');
  assert.equal(page._governingId, null, 'and the guard is released for that retry');
  assert.equal(adopt.querySelectorAll('.terminals-adopt-govern')[0].textContent, 'Govern');
});

// ------------------------------------------------------------------ copy

test('nothing in the adopt panel introduces an em dash', () => {
  const src = read('js/pages/terminals.js');
  assert.equal(src.includes('—'), false, 'terminals.js stays free of U+2014');
});

test('a folder that is not a folder never reaches the board', () => {
  // The host scrapes the folder out of free text. A row written before that
  // scrape was tightened can hold something that is not a path at all: one
  // held eight kilobytes of Python, because "cwd=" matched inside a tool's
  // own arguments and the value ran to the end of the blob.
  const { page } = loadPage();
  const blob = "str(workspace))''', ''' resume_args: list[str] = []\n    if resume_session_id:";

  assert.equal(page._knownWorkspace(blob), null, 'multi-line is not a path');
  // The row that prompted this sat exactly at the 1024 cap with no real
  // newlines: the blob's breaks were literal backslash-n pairs. Size and
  // newlines both passed it, so shape is what actually catches it.
  assert.equal(page._knownWorkspace("str(workspace))''', ''' resume_args = []".padEnd(1024, ' x')), null,
    'at the cap, single line, still not a path');
  assert.equal(page._knownWorkspace('~/work'), '~/work', 'home relative is a path');
  assert.equal(page._knownWorkspace('relative/path'), null, 'a relative fragment is not');
  assert.equal(page._knownWorkspace('/' + 'a'.repeat(2000)), null, 'nor is an enormous one');
  assert.equal(page._knownWorkspace('(unknown folder)'), null);
  assert.equal(page._knownWorkspace('/Users/y/repo'), '/Users/y/repo', 'a real one still passes');
});
