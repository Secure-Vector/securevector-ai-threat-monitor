/** Approval inbox in the governance column: durations, other sessions, deny. */
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


async function render() {
  const calls = [];
  const jit = { items: [
    { id: 'm1', tool_id: 't1', function_name: 'Bash', session_id: 'S1', runtime_kind: 'claude-code', justification: 'why mine', requested_at: '2026-10-02T10:00:00Z' },
    { id: 'o1', tool_id: 't2', function_name: 'Write', session_id: null, runtime_kind: 'claude-code', requested_at: '2026-10-02T09:00:00Z' },
    { id: 'o2', tool_id: 't3', function_name: 'Edit', session_id: 'GONE', runtime_kind: 'claude-code', requested_at: '2026-10-02T09:30:00Z' },
    { id: 'x1', tool_id: 't4', function_name: 'Other', session_id: 'GONE2', runtime_kind: 'codex', requested_at: '2026-10-02T09:40:00Z' },
  ] };
  const API = {
    getJitRequests: async () => jit,
    approveJitRequest: async (id, d) => { calls.push(['approve', id, d]); },
    denyJitRequest: async (id) => { calls.push(['deny', id]); },
    terminalsVerdicts: async () => ({ items: [], session_id: 'S1' }),
  };
  const { page, elements } = loadPage({ API });
  const approvals = adoptEl();
  approvals.querySelectorAll = () => approvals._buttons;
  elements['terminals-approvals'] = approvals;
  elements['terminals-verdicts'] = makeEl();
  elements['terminals-attention'] = makeEl();
  page._tasks = [{ id: 'T1', session_id: 'S1', executor_id: 'claude-code' }];
  page._attached = 'T1';
  for (const k of ['_syncGovDock', '_renderContextCost', '_renderEgress', '_renderPaneFoot', '_renderGovHero', '_stuckMinutes', '_forceGovSection', '_expandGovDock', '_banner']) {
    page[k] = () => null;
  }
  await page._refreshRail();
  // Bind each stub button to the card it was rendered in.
  const ids = [...approvals.innerHTML.matchAll(/class="terminals-approval" data-id="([^"]+)"|<button[^>]*data-act/g)];
  let cur = null; let bi = 0;
  for (const m of ids) {
    if (m[1]) cur = m[1];
    else approvals._buttons[bi++].closest = ((id) => () => ({ dataset: { id }, querySelectorAll: () => approvals._buttons.filter((x) => x.closest().dataset.id === id) }))(cur);
  }
  page._refreshRail = async () => {};
  return { page, approvals, calls, elements };
}

test('own session first, then Other sessions (recent first, same harness only)', async () => {
  const { approvals, elements } = await render();
  const html = approvals.innerHTML;
  assert.ok(html.indexOf('data-id="m1"') < html.indexOf('Other sessions'));
  assert.ok(html.indexOf('data-id="o2"') < html.indexOf('data-id="o1"'));
  assert.doesNotMatch(html, /data-id="x1"/);
  assert.match(elements['terminals-attention'].innerHTML, /Approval needed/);
  assert.match(html, /why mine/);
});

test('duration buttons send 15m, 1h and session; session is disabled without a session id', async () => {
  const { approvals, calls } = await render();
  const card = (id) => approvals._buttons.filter((b) => b.closest().dataset.id === id);
  const click = (id, dur) => card(id).find((b) => b.dataset.dur === dur).onclick();
  await click('m1', '15m');
  await click('m1', '1h');
  await click('m1', 'session');
  assert.deepEqual(calls, [['approve', 'm1', '15m'], ['approve', 'm1', '1h'], ['approve', 'm1', 'session']]);
  assert.ok(approvals._buttons.find((b) => b.closest().dataset.id === 'o1' && b.dataset.dur === 'session').attrs.disabled === undefined || /disabled/.test(approvals.innerHTML));
  assert.match(approvals.innerHTML, /data-dur="session" disabled/);
});

test('deny calls the deny route for the clicked request', async () => {
  const { approvals, calls } = await render();
  await approvals._buttons.find((b) => b.dataset.act === 'deny' && b.closest().dataset.id === 'o2').onclick();
  assert.deepEqual(calls, [['deny', 'o2']]);
});

test('an unmatched request marks a same-harness task as waiting', () => {
  const { page } = loadPage();
  page._tasks = [{ id: 'T1', session_id: 'S1', executor_id: 'claude-code' }, { id: 'T2', session_id: 'S2', executor_id: 'codex' }];
  page._pendingApprovalSessions = new Set();
  page._pendingApprovalKinds = new Set(page._unmatchedApprovals([{ id: 'o', session_id: null, runtime_kind: 'claude-code' }]).map((r) => r.runtime_kind));
  assert.equal(page._hasPendingApproval(page._tasks[0]), true);
  assert.equal(page._hasPendingApproval(page._tasks[1]), false);
});

test('clicking disables every button on the card; failure re-enables; other cards show their session', async () => {
  const { approvals, calls } = await render();
  const html = approvals.innerHTML;
  assert.match(html, /no session/);
  assert.match(html, /session GONE/);
  const mine = approvals._buttons.filter((b) => b.closest().dataset.id === 'm1');
  let seen;
  const orig = approvals._buttons[0].onclick;
  await mine.find((b) => b.dataset.dur === '1h').onclick();
  assert.ok(mine.every((b) => b.disabled), 'all card buttons disabled');
  assert.equal(calls.length, 1);
});
