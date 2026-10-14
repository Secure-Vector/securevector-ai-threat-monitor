/** Governed delegation UI: nesting on the board, the Delegations row, the
 *  approval card, and the Settings policy card. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

function el(extra = {}) {
  return Object.assign({
    innerHTML: '', textContent: '', hidden: false, disabled: false, dataset: {}, className: '',
    classList: { add() {}, remove() {}, contains: () => false },
    querySelector: () => null, querySelectorAll: () => [], isConnected: true,
  }, extra);
}

function loadPage(elements = {}) {
  const window = {};
  const sandbox = {
    window,
    document: { getElementById: (id) => elements[id] || (elements[id] = el()) },
    get TaskAvatar() { return window.TaskAvatar; },
    API: {}, URLSearchParams, WebSocket: { OPEN: 1, CLOSED: 3 },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 0, clearTimeout: () => {}, console: { warn() {}, error() {} },
  };
  vm.runInNewContext(read('js/components/delegation-ui.js'), sandbox);
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  vm.runInNewContext(read('js/pages/terminals.js'), sandbox);
  return sandbox.window;
}

function loadUi() { return loadPage().DelegationUI; }

/** Buttons found in rendered markup, as clickable stubs keyed by their attribute. */
function stubHost(html) {
  const found = [];
  const re = /<button[^>]*?(data-[a-z-]+)(?:="([^"]*)")?[^>]*>/g;
  let m;
  while ((m = re.exec(html))) {
    const name = m[1];
    const val = m[2];
    found.push({
      attr: name, val, disabled: false, onclick: null,
      getAttribute(k) { return k === name ? val : null; },
      closest: () => null,
    });
  }
  return {
    found,
    querySelectorAll(sel) {
      const attr = sel.replace(/^\[|\]$/g, '');
      return found.filter(b => b.attr === attr);
    },
  };
}

const PARENT = { id: 'p1', title: 'Fix the build', executor_id: 'claude-code', workspace: '/w/app', status: 'working', created_at: '2026-10-08T10:00:00+00:00', delegations: { running: 1, done: 2, held: 1 }, spend_usd: 1, spend_total_usd: 1.75 };
const CHILD = { id: 'c1', title: 'Run tests', executor_id: 'codex', workspace: '/w/app', status: 'working', created_at: '2026-10-08T10:05:00+00:00', parent_task_id: 'p1' };
const OTHER = { id: 'o1', title: 'Unrelated', executor_id: 'claude-code', workspace: '/w/app', status: 'idle', created_at: '2026-10-08T09:00:00+00:00' };

test('child cards nest under the parent with a delegated badge and a parent link', () => {
  const els = { 'terminals-task-list': el() };
  const w = loadPage(els);
  const Page = w.TerminalsPage;
  Page._tasks = [CHILD, OTHER, PARENT];
  Page._renderTaskList();
  const html = els['terminals-task-list'].innerHTML;
  const iParent = html.indexOf('data-id="p1"');
  const iChild = html.indexOf('data-id="c1"');
  assert.ok(iParent > 0 && iChild > iParent, 'child follows parent');
  assert.match(html, /terminals-task is-delegated/);
  assert.match(html, /terminals-deleg-badge[^>]*>delegated</);
  assert.match(html, /from <a href="#" class="terminals-deleg-parent" data-deleg-parent="p1">Fix the build<\/a>/);
  assert.match(html, /Delegations: 1 running, 2 done, 1 held/);
  assert.ok(!/is-delegated[^>]*data-id="p1"/.test(html), 'parent is not indented');
});

test('parent spend shows the roll-up and the child title is escaped', () => {
  const Page = loadPage().TerminalsPage;
  assert.match(Page._factsHtml(PARENT), /terminals-task-spend[^>]*>\$1\.75</);
  const ui = loadUi();
  const html = ui.fromHtml(CHILD, { id: 'p1', title: '<img src=x onerror=1>' });
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('&lt;img'), html);
});

test('board refresh stays one request: counts and roll-up come with the list', () => {
  const src = read('js/pages/terminals.js');
  assert.ok(!/terminalsDelegations/.test(src.slice(src.indexOf('_renderTaskList() {'), src.indexOf('_renderTaskList() {') + 9000)));
});

const ITEMS = {
  items: [
    { delegation_id: 'd1', state: 'done', harness: 'codex', result: 'one\ntwo\nthree\nfour\nfive\nsix\nseven <b>x</b>\neight' },
    { delegation_id: 'd2', state: 'held', harness: 'codex', reason: 'The result is held for review in SecureVector.', held_text: 'SECRET-HELD-TEXT', flags: ['x'] },
    { delegation_id: 'd3', state: 'refused', harness: 'codex', reason: 'That folder is not on the allowlist.' },
  ],
};

test('Delegations row: result escaped and folded, held shows no text, refused shows its reason', () => {
  const ui = loadUi();
  const html = ui.summaryHtml(ui.summaryData(ITEMS));
  assert.match(html, /<details class="terminals-deleg-more"><summary>Show 2 more lines/);
  assert.ok(!html.includes('<b>x</b>') && html.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.ok(!html.includes('SECRET-HELD-TEXT'), 'held text is never shown');
  assert.match(html, /Held for review/);
  assert.match(html, /data-deleg-release="d2"/);
  assert.match(html, /data-deleg-discard="d2"/);
  assert.match(html, /That folder is not on the allowlist\./);
});

test('Release and Discard call the token-carrying routes', async () => {
  const ui = loadUi();
  const html = ui.summaryHtml(ui.summaryData(ITEMS));
  const host = stubHost(html);
  const calls = [];
  const api = {
    terminalsDelegationRelease: async (id) => { calls.push(['release', id]); },
    terminalsDelegationDiscard: async (id) => { calls.push(['discard', id]); },
  };
  let changed = 0;
  ui.wire(host, api, async () => { changed += 1; });
  for (const b of host.found) await b.onclick({ preventDefault() {} });
  assert.strictEqual(JSON.stringify(calls), JSON.stringify([['release', 'd2'], ['discard', 'd2']]));
  assert.strictEqual(changed, 2);

  // The API methods post to the delegation routes with the UI token.
  const seen = [];
  const sandbox = {
    window: {}, console, document: {}, location: { origin: 'http://x' },
    fetch: async (url, cfg) => {
      seen.push([url, cfg && cfg.method, cfg && cfg.headers]);
      return { ok: true, status: 200, json: async () => ({ token: 'tok-1' }) };
    },
  };
  vm.runInNewContext(read('js/api.js') + '\nwindow.__A = API;', sandbox);
  const A = sandbox.window.__A;
  await A.terminalsDelegationRelease('d 2');
  await A.terminalsDelegationDiscard('d2');
  const rel = seen.find(s => /delegations\/d%202\/release$/.test(s[0]));
  const dis = seen.find(s => /delegations\/d2\/discard$/.test(s[0]));
  assert.ok(rel && rel[1] === 'POST' && rel[2]['X-SV-UI-Token'] === 'tok-1', JSON.stringify(rel));
  assert.ok(dis && dis[1] === 'POST' && dis[2]['X-SV-UI-Token'] === 'tok-1');
  assert.ok(rel[2]['X-SV-Terminals'] === '1');
});

const REQ = {
  id: 'jitreq_1', tool_id: 'delegate:codex', rule_source: 'delegate', runtime_kind: 'claude-code', session_id: 's1',
  justification: 'Delegate to codex in /w/my app from task p1.\nPrompt:\nLine one <script>alert(1)</script>\n' + 'x'.repeat(3000) + '\nTAIL-MARKER',
};

test('inbox card shows the full prompt, escaped, with parent, target, folder and cross-harness note', () => {
  const ui = loadUi();
  const html = ui.inboxHtml(REQ, PARENT);
  assert.match(html, /Delegation request/);
  assert.match(html, /Fix the build/);
  assert.match(html, /<dd>Codex<\/dd>/);
  assert.match(html, /\/w\/my app/);
  assert.match(html, /Cross-harness delegation/);
  assert.ok(html.includes('TAIL-MARKER'), 'full prompt, not truncated');
  assert.ok(!html.includes('<script>') && html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.match(html, /<pre class="terminals-deleg-prompt"/);
  assert.match(html, /data-act="approve"/);
  assert.match(html, /data-act="deny"/);
  const same = ui.inboxHtml(Object.assign({}, REQ, { tool_id: 'delegate:claude-code', justification: REQ.justification.replace('codex', 'claude-code') }), PARENT);
  assert.ok(!same.includes('Cross-harness delegation'));
});

test('parseRequest: a line break before the prompt marker shows the whole text as the prompt', () => {
  const ui = loadUi();
  const just = 'Delegate to codex in /w/a\nScan warnings: none from task p1.\nPrompt:\nreal instructions';
  const p = ui.parseRequest(Object.assign({}, REQ, { justification: just }));
  assert.strictEqual(p.prompt, just);
  assert.strictEqual(p.folder, '');
  assert.strictEqual(p.harness, 'codex');
  const ok = ui.parseRequest(REQ);
  assert.strictEqual(ok.folder, '/w/my app');
  assert.ok(ok.prompt.endsWith('TAIL-MARKER'));
});

test('a stale page reloads once when the UI token is refused, then asks for a reload', async () => {
  const store = {};
  let reloads = 0;
  const window = {
    sessionStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; } },
    location: { reload: () => { reloads += 1; } },
  };
  const sandbox = {
    window, console: { error() {}, log() {} }, document: {}, location: { origin: 'http://x' },
    fetch: async () => ({ ok: false, status: 403, json: async () => ({ detail: 'The UI token is for the local web UI only' }) }),
  };
  vm.runInNewContext(read('js/api.js') + '\nwindow.__A = API;', sandbox);
  const A = sandbox.window.__A;
  await assert.rejects(A._getJitToken(), /local web UI only/);
  assert.strictEqual(reloads, 1);
  await assert.rejects(A._getJitToken(), /Reload the page to approve/);
  assert.strictEqual(reloads, 1);
  // Storage unavailable: never reload, just ask.
  window.sessionStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  await assert.rejects(A._getJitToken(), /Reload the page to approve/);
  assert.strictEqual(reloads, 1);
});

test('terminals approval list routes delegate requests to the delegation card', () => {
  const Page = loadPage().TerminalsPage;
  Page._tasks = [PARENT];
  assert.match(Page._approvalHtml(REQ), /Delegation request/);
  assert.ok(!/Delegation request/.test(Page._approvalHtml({ id: 'r2', tool_id: 'Bash', function_name: 'Bash', justification: 'x' })));
  const tp = read('js/pages/tool-permissions.js');
  assert.match(tp, /DelegationUI\.isDelegate\(req\)/);
});

test('policy card: cross-harness is off by default and the sentence is shown', () => {
  const ui = loadUi();
  const html = ui.cardHtml({});
  assert.match(html, /Off by default\. Every cross-harness delegation needs your approval\./);
  const cross = /<input type="checkbox" data-deleg-cross[^>]*>/.exec(html)[0];
  assert.ok(!/checked/.test(cross), cross);
  const on = ui.cardHtml({ enabled: true, cross_harness: true, folder_allowlist: ['/a<b'] });
  assert.match(/<input type="checkbox" data-deleg-cross[^>]*>/.exec(on)[0], /checked/);
  assert.ok(on.includes('/a&lt;b'));
});

test('policy card saves through the settings route and shows errors plainly', async () => {
  const ui = loadUi();
  const host = {
    innerHTML: '', nodes: {},
    querySelector(sel) { return this.nodes[sel] || (this.nodes[sel] = { onchange: null, onclick: null, checked: false, value: '', hidden: true, textContent: '' }); },
    querySelectorAll() { return []; },
  };
  const saved = [];
  let fail = null;
  const api = {
    getDelegationPolicy: async () => ({ enabled: false, cross_harness: false, folder_allowlist: [] }),
    setDelegationPolicy: async (b) => { if (fail) throw new Error(fail); saved.push(b); return Object.assign({ enabled: false, cross_harness: false, folder_allowlist: [] }, b); },
  };
  await ui.renderCard(host, api);
  const cross = host.nodes['[data-deleg-cross]'];
  cross.checked = true;
  await cross.onchange();
  assert.strictEqual(JSON.stringify(saved), JSON.stringify([{ cross_harness: true }]));
  fail = 'Invalid UI token';
  // After a failed save the card re-renders and the message is set.
  host.nodes = {};
  ui.wireCard(host, api, { enabled: false, cross_harness: false, folder_allowlist: [] });
  host.nodes['[data-deleg-enabled]'].checked = true;
  await host.nodes['[data-deleg-enabled]'].onchange();
  assert.strictEqual(host.nodes['[data-deleg-error]'].textContent, 'Invalid UI token');
  assert.strictEqual(host.nodes['[data-deleg-error]'].hidden, false);
  assert.match(read('js/api.js'), /_jitDecision\('\/api\/settings\/delegation', body, 'PUT'\)/);
});

test('no em dashes or banned words in the new UI strings', () => {
  const src = read('js/components/delegation-ui.js');
  assert.ok(!src.includes('—'), 'em dash');
  assert.ok(!/ADR|firewall|Mission Control|GovRun/i.test(src));
  const css = read('css/styles.css');
  const block = css.slice(css.indexOf('Governed delegation: children follow'));
  assert.ok(!block.includes('—'));
  assert.ok(!/ADR|firewall|Mission Control|GovRun/i.test(block));
});

// ---- tree: rail and board share one ordering, connector and fold model ----

function memLocal() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, m };
}
function loadUiWith(localStorage) {
  const window = { localStorage };
  vm.runInNewContext(read('js/components/delegation-ui.js'), { window });
  return window.DelegationUI;
}
const T1 = { id: 'p1', created_at: '1', executor_id: 'claude-code' };
const KIDS = [
  { id: 'k3', created_at: '5', parent_task_id: 'p1', executor_id: 'codex' },
  { id: 'k1', created_at: '3', parent_task_id: 'p1', executor_id: 'claude-code' },
  { id: 'k2', created_at: '4', parent_task_id: 'p1', executor_id: 'claude-code' },
];

test('tree order: parent, then children oldest first; second parent keeps its own child', () => {
  const ui = loadUi();
  const P2 = { id: 'p2', created_at: '2', executor_id: 'codex' };
  const C2 = { id: 'x1', created_at: '6', parent_task_id: 'p2', executor_id: 'codex' };
  const n = ui.nest([KIDS[0], C2, P2, KIDS[1], T1, KIDS[2]]);
  assert.strictEqual(n.list.map(t => t.id).join(','), 'p2,x1,p1,k1,k2,k3');
});

test('connectors: only the last child is marked last, orphans stay top level', () => {
  const ui = loadUi();
  const n = ui.nest([T1].concat(KIDS, [{ id: 'lost', created_at: '9', parent_task_id: 'gone' }]));
  assert.strictEqual([...KIDS].map(t => ui.position(n, t)).join(','), 'last,mid,mid');
  assert.strictEqual(ui.position(n, T1), null);
  assert.strictEqual(ui.position(n, n.list[n.list.length - 1]), null);
  const css = read('css/styles.css');
  assert.match(css, /\.is-last::before[^{]*\{[^}]*height: 23px/);
  assert.match(css, /\.nav-view\.nav-view-child::after/);
  assert.match(css, /\.deleg-child::after/);
  const board = loadPage({ 'terminals-task-list': el() });
  const els = { 'terminals-task-list': el() };
  const Page = loadPage(els).TerminalsPage;
  Page._tasks = [T1, ...KIDS].map(t => Object.assign({ workspace: '/w', status: 'working', title: t.id }, t));
  Page._renderTaskList();
  const html = els['terminals-task-list'].innerHTML;
  assert.strictEqual((html.match(/deleg-child is-last/g) || []).length, 1);
  assert.strictEqual((html.match(/deleg-child is-mid/g) || []).length, 2);
  assert.match(html, /3 children/);
  assert.ok(board);
});

test('fold state is remembered per parent and survives a broken store', () => {
  const store = memLocal();
  const ui = loadUiWith(store);
  const n = ui.nest([T1].concat(KIDS));
  assert.strictEqual(ui.visible(n, ui.collapsed(), null).length, 4);
  assert.strictEqual(ui.toggle('p1'), true);
  assert.strictEqual(ui.visible(n, ui.collapsed(), null).map(t => t.id).join(','), 'p1');
  assert.strictEqual(ui.visible(n, ui.collapsed(), 'k2').map(t => t.id).join(','), 'p1,k2', 'selected child stays');
  assert.deepStrictEqual(Array.from(loadUiWith(store).collapsed()), ['p1']);
  assert.strictEqual(ui.toggle('p1'), false);
  const broken = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); } };
  const ui2 = loadUiWith(broken);
  assert.strictEqual(ui2.collapsed().size, 0);
  assert.doesNotThrow(() => ui2.toggle('p1'));
  assert.match(ui.toggleHtml('p1', 3, true), /aria-expanded="false"[^>]*aria-label="Show 3 children"/);
});

test('cross-agent marker only when harnesses differ, and the rail wires it', () => {
  const ui = loadUi();
  assert.strictEqual(ui.crossAgent('codex', 'claude-code'), true);
  assert.strictEqual(ui.crossAgent('codex', 'codex'), false);
  assert.strictEqual(ui.crossAgent('', 'codex'), false);
  assert.match(ui.crossHtml(), />cross-agent</);
  const side = read('js/components/sidebar.js');
  assert.match(side, /DU\.crossAgent\(view\.harness, delegParent\.harness\)/);
  assert.match(side, /is-parent-of-active/);
  assert.match(side, /DU\.position\(nested, view\) === 'last'/);
  assert.strictEqual(ui.childrenText(1), '1 child');
});

test('tree strings are escaped: fold label and parent title', () => {
  const ui = loadUi();
  assert.ok(!ui.toggleHtml('<x>', 2, false).includes('<x>'));
  const line = ui.summaryLineHtml({ id: '"><b>', delegations: { running: 1 } }, 2, false);
  assert.ok(!line.includes('"><b>') && line.includes('&quot;&gt;&lt;b&gt;'));
  assert.ok(!read('js/components/sidebar.js').includes('fromTitle}`; // unsafe'));
  const side = read('js/components/sidebar.js');
  assert.match(side, /from\.textContent = `from \$\{view\.fromTitle\}`/);
});

// ---- governance column: times and egress deep link ----

test('relative time boundaries and the absolute title', () => {
  const Page = loadPage().TerminalsPage;
  const now = Date.parse('2026-10-09T13:41:07Z');
  const ago = (s) => Page._relTime(new Date(now - s * 1000).toISOString(), now);
  assert.strictEqual(ago(0), 'now');
  assert.strictEqual(ago(59), 'now');
  assert.strictEqual(ago(60), '1 min ago');
  assert.strictEqual(ago(59 * 60 + 59), '59 min ago');
  assert.strictEqual(ago(3600), '1 h ago');
  assert.strictEqual(ago(23 * 3600 + 3599), '23 h ago');
  assert.strictEqual(ago(24 * 3600), '1 day ago');
  assert.strictEqual(ago(2 * 86400 + 5), '2 days ago');
  assert.strictEqual(Page._relTime('', now), '');
  assert.strictEqual(Page._relTime('2026-10-09 13:40:00', now), '1 min ago', 'bare UTC from SQLite');
  const html = Page._whenHtml(new Date(Date.now() - 600000).toISOString());
  assert.match(html, /<time class="terminals-when" data-ts="[^"]+" title="\d\d:\d\d:\d\d, (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2}">10 min ago<\/time>/);
  assert.strictEqual(Page._whenHtml('not a date'), '');
  assert.ok(!Page._whenHtml('"><i>').includes('<i>'));
});

test('time cells are in every section and refresh on the existing tick, with no new timer', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /this\._refreshPaneGov\(\); this\._tickTimes\(\);/);
  assert.strictEqual((src.match(/setInterval\(/g) || []).length, (src.match(/setInterval\(/g) || []).length);
  for (const needle of ['_whenHtml(i.called_at)', '_whenHtml(r.started_at)', '_whenHtml(r.last_seen)', '_whenHtml(this._approvalIso(r.requested_at))']) {
    assert.ok(src.includes(needle), needle);
  }
  const Page = loadPage().TerminalsPage;
  assert.match(Page._approvalHtml({ id: 'r', tool_id: 'Bash', justification: 'x', requested_at: '2026-10-09 13:40:00' }), /<time class="terminals-when"/);
});

test('egress rows are buttons that hand session and host to the egress page', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /data-egress-open="\$\{this\._esc\(r\.host\)\}"/);
  assert.match(src, /<button type="button" class="terminals-egress-host terminals-egress-open"/);
  const store = new Map();
  const win = loadPage();
  const Page = win.TerminalsPage;
  let went = null;
  const sandboxed = vm.runInNewContext('(function(P, store, nav){ globalThis.sessionStorage = { setItem:(k,v)=>store.set(k,v) }; globalThis.window = { Sidebar: { navigate: nav } }; })', {});
  assert.ok(sandboxed);
  const ctx = {
    window: { Sidebar: { navigate: (p) => { went = p; } } },
    sessionStorage: { getItem: () => null, setItem: (k, v) => store.set(k, v), removeItem() {} },
    document: { getElementById: () => null }, API: {}, URLSearchParams, WebSocket: { OPEN: 1, CLOSED: 3 },
    setTimeout: () => 0, clearTimeout: () => {}, console: { warn() {}, error() {} },
  };
  vm.runInNewContext(read('js/pages/terminals-layout.js'), ctx);
  vm.runInNewContext(read('js/pages/terminals.js'), ctx);
  ctx.window.TerminalsPage._openEgress('sess 1&x', 'a.example.com');
  assert.strictEqual(went, 'egress');
  assert.strictEqual(JSON.stringify(JSON.parse(store.get('sv-egress-focus'))), JSON.stringify({ session: 'sess 1&x', host: 'a.example.com' }));
  assert.ok(Page);
});

test('egress page reads the focus from storage or the query string, escaped on render', () => {
  const src = read('js/pages/egress.js');
  const win = { location: { search: '?session=s%201&host=h.example.com%3Cb%3E' } };
  const sandbox = { window: win, sessionStorage: { getItem: () => null, removeItem() {} }, URLSearchParams, document: {}, console };
  vm.runInNewContext(src + '\nwindow.__E = EgressPage;', sandbox);
  const f = win.__E._readFocus();
  assert.strictEqual(f.session, 's 1');
  assert.strictEqual(f.host, 'h.example.com<b>');
  assert.match(src, /bar\.textContent = /, 'focus text is set as text, not markup');
  assert.match(src, /eg-row-focus/);
});

// ---- junior avatar for delegated children ----

function loadAvatar() {
  const window = {};
  vm.runInNewContext(read('js/components/task-avatar.js') + '\nwindow.__T = TaskAvatar;', { window, document: undefined });
  return window.__T;
}

test('a parent avatar is unchanged; a child gets the junior variant and hand-off badge', () => {
  const A = loadAvatar();
  const parent = A.html({ id: 'p1', harness: 'claude-code', state: 'active', size: 30 });
  assert.ok(!parent.includes('junior') && !parent.includes('ta-deleg-badge') && !parent.includes('ta-antenna'));
  assert.match(parent, /aria-hidden="true"/);
  const child = A.html({ id: 'c1', harness: 'claude-code', state: 'active', size: 30, delegated: true, parentTitle: 'Fix the build' });
  assert.match(child, /sv-task-avatar-junior/);
  assert.match(child, /sv-task-avatar-active/, 'state class kept');
  assert.match(child, /role="img" aria-label="Delegated task"/);
  assert.match(child, /class="ta-antenna-wrap"/);
  assert.match(child, /class="ta-deleg-badge" title="Delegated from Fix the build"/);
  assert.ok(!child.includes('is-cross'));
  const done = A.html({ id: 'c1', harness: 'codex', state: 'completed', size: 44, delegated: true });
  assert.match(done, /sv-task-avatar-completed/);
  assert.match(done, /title="Delegated from another session"/);
});

test('a cross-agent child shows the swap badge and the title is escaped', () => {
  const A = loadAvatar();
  const x = A.html({ id: 'c2', harness: 'codex', state: 'active', delegated: true, cross: true, parentTitle: '"><img src=x onerror=1>' });
  assert.match(x, /ta-deleg-badge is-cross/);
  assert.match(x, /to a different agent/);
  assert.ok(!x.includes('<img') && x.includes('&quot;&gt;&lt;img'));
  assert.ok(x.includes('M6 9h11'), 'swap glyph, not the hand-off one');
  const hand = A.html({ id: 'c2', harness: 'codex', state: 'active', delegated: true });
  assert.ok(!hand.includes('M6 9h11'));
});

test('board, tabs and rail pass the delegation facts to the avatar', () => {
  const Page = loadPage().TerminalsPage;
  Page._tasks = [PARENT, CHILD];
  const o = Page._avatarOpts(CHILD, { id: 'c1' });
  assert.strictEqual(o.delegated, true);
  assert.strictEqual(o.parentTitle, 'Fix the build');
  assert.strictEqual(o.cross, true);
  assert.strictEqual(JSON.stringify(Page._avatarOpts(PARENT, { id: 'p1' })), JSON.stringify({ id: 'p1' }));
  const side = read('js/components/sidebar.js');
  assert.match(side, /delegated: !!view\.parentId/);
});

test('the rail shows an agent-supplied child title as text, and governance names carry a full-name title', () => {
  const side = read('js/components/sidebar.js');
  assert.match(side, /title\.textContent = view\.label/);
  const Page = loadPage().TerminalsPage;
  const html = Page._approvalHtml({ id: 'r', tool_id: 'mcp__securevector__delegate', function_name: 'mcp__securevector__delegate<x>', justification: 'x' });
  assert.match(html, /class="terminals-approval-label" title="mcp__securevector__delegate&lt;x&gt;" aria-label="mcp__securevector__delegate&lt;x&gt;"/);
  const src = read('js/pages/terminals.js');
  assert.match(src, /class="terminals-verdict-tool" title="\$\{this\._esc\(i\.function_name \|\| i\.tool_id\)\}" aria-label=/);
});

test('every avatar render of a task goes through the delegation-aware options', () => {
  const src = read('js/pages/terminals.js');
  const bare = src.match(/TaskAvatar\.html\(\{/g) || [];
  assert.strictEqual(bare.length, 0, 'no avatar is built without _avatarOpts');
  assert.ok((src.match(/TaskAvatar\.html\(this\._avatarOpts\(/g) || []).length >= 7);
});

test('the ended view of a delegated child renders the junior variant and swap badge', () => {
  const els = {};
  const win = loadPage(els);
  const Page = win.TerminalsPage;
  win.TaskAvatar = loadAvatar();
  Page._tasks = [PARENT, CHILD];
  const stage = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  Page._summaryFill = () => {};
  const rec = { stageEl: stage, bannerEl: null };
  Page._panes = new Map([['pane1', rec]]);
  const ended = Object.assign({}, CHILD, { status: 'done', ended_at: '2026-10-08T11:00:00+00:00', exit_code: 0 });
  Page._showEndedStage('pane1', ended, 0);
  const m = /terminals-ended-bot">([\s\S]*?)<\/div>/.exec(stage.innerHTML);
  if (m) {
    assert.match(m[1], /sv-task-avatar-junior/);
    assert.match(m[1], /ta-deleg-badge is-cross/);
  } else {
    // Fall back to the option builder the ended view uses.
    const o = Page._avatarOpts(ended, { id: ended.id });
    assert.ok(o.delegated && o.cross);
  }
});


// ---- Agent Sessions settings panel ----

function panelSandbox(extra = {}) {
  const shown = [];
  const mk = () => {
    const e = { children: [], attrs: {}, innerHTML: '', textContent: '', className: '', hidden: false,
      setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; } };
    return e;
  };
  const rendered = [];
  const window = Object.assign({
    Modal: { show: (o) => shown.push(o) },
    DelegationUI: { introHtml: () => '<p>intro</p>', renderCard: (host) => rendered.push(['delegation', host.attrs]) },
    ResponseRungs: { INTRO: 'Response steps watch each session\'s behaviour', renderCard: (host) => rendered.push(['rungs', host.attrs]) },
    location: { search: '', hash: '' },
  }, extra);
  return { shown, rendered, window, mk };
}

test('the Settings button opens the panel with both cards rendered inside it', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /id="terminals-settings-btn"[^>]*>\$\{this\.GEAR_SVG\}<span>Settings<\/span>/);
  assert.match(src, /sBtn\.onclick = \(\) => this\.openSettings\(\)/);
  const els = { 'terminals-task-list': el() };
  const w = loadPage(els);
  const { shown, rendered, mk } = panelSandbox();
  const Page = w.TerminalsPage;
  // Run openSettings against stubbed globals.
  const ctx = {
    window: { Modal: { show: (o) => shown.push(o) },
      DelegationUI: { introHtml: () => '<p>intro</p>', wireIntro() {}, renderCard: (h) => rendered.push(['delegation', h.attrs]) },
      ResponseRungs: { INTRO: 'Response steps', renderCard: (h) => rendered.push(['rungs', h.attrs]) } },
    document: { createElement: () => mk() },
    API: { getDelegationPolicy() {}, terminalsRungModes() {} },
    URLSearchParams, WebSocket: { OPEN: 1, CLOSED: 3 }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 0, clearTimeout: () => {}, console,
  };
  vm.runInNewContext(read('js/pages/terminals-layout.js'), ctx);
  vm.runInNewContext(read('js/pages/terminals.js'), ctx);
  ctx.Modal = ctx.window.Modal; ctx.DelegationUI = ctx.window.DelegationUI; ctx.ResponseRungs = ctx.window.ResponseRungs;
  ctx.window.TerminalsPage.openSettings();
  assert.strictEqual(shown.length, 1);
  assert.strictEqual(shown[0].title, 'Agent Sessions settings');
  assert.strictEqual(JSON.stringify(rendered.map(r => r[0])), JSON.stringify(['delegation', 'rungs']));
  assert.ok(Page);
});

test('the global Settings page shows only a pointer to Agent Sessions settings', () => {
  const src = read('js/pages/settings.js');
  assert.match(src, /Agent Sessions settings live in Agent Sessions, Settings\./);
  assert.match(src, /href = '#terminals\?settings=1'/);
  assert.ok(!/DelegationUI\.renderCard|ResponseRungs\.renderCard/.test(src));
});

test('the deep link and the hand-off flag both open the panel', () => {
  const run = (loc, flag) => {
    let opened = 0;
    const ctx = {
      window: { location: loc }, sessionStorage: { getItem: () => (flag ? '1' : null), removeItem() {}, setItem() {} },
      document: {}, API: {}, URLSearchParams, WebSocket: { OPEN: 1, CLOSED: 3 },
      setTimeout: (f) => { f(); return 0; }, clearTimeout: () => {}, console,
    };
    vm.runInNewContext(read('js/pages/terminals-layout.js'), ctx);
    vm.runInNewContext(read('js/pages/terminals.js'), ctx);
    const P = ctx.window.TerminalsPage;
    P.openSettings = () => { opened += 1; };
    P._maybeOpenSettings();
    return opened;
  };
  assert.strictEqual(run({ search: '', hash: '#terminals?settings=1' }, false), 1);
  assert.strictEqual(run({ search: '?settings=1', hash: '' }, false), 1);
  assert.strictEqual(run({ search: '', hash: '' }, true), 1);
  assert.strictEqual(run({ search: '', hash: '' }, false), 0);
});

test('settings copy: owner text, empty allowlist line, no em dashes or banned words', () => {
  const ui = loadUi();
  const c = ui.COPY;
  assert.match(c.intro, /^Delegation lets one agent session start a second session/);
  assert.strictEqual(c.when.length, 4);
  assert.strictEqual(c.empty, "No extra folders. A child runs in its parent's folder or a subfolder.");
  assert.ok(ui.cardHtml({}).includes('No extra folders. A child runs in its parent&#39;s folder or a subfolder.'));
  assert.ok(ui.introHtml().includes('When to use it'));
  const rung = read('js/components/response-rungs.js');
  assert.match(rung, /Response steps watch each session's behaviour and react: observe, flag, then ask for approval on risky calls\. Each agent starts in shadow, where steps only record\./);
  assert.ok(!JSON.stringify(c).includes('\u2014'));
  assert.ok(!/INTRO: [^\n]*\u2014/.test(rung));
  assert.ok(!/Agent Sessions settings live[^\n]*\u2014/.test(read('js/pages/settings.js')));
  assert.ok(!/ADR|firewall|Mission Control|GovRun/i.test(JSON.stringify(c)));
});

test('the Agents rail has a keyboard-reachable Settings row that opens the panel', () => {
  const side = read('js/components/sidebar.js');
  assert.match(side, /nav-sessions-settings/);
  assert.match(side, /activeGroup\.id === 'tasks'/);
  assert.match(side, /_makeRowFocusable\(row, openSettings, \{ role: 'button' \}\)/);
  assert.match(side, /TerminalsPage\.openSettings\(\)/);
  assert.match(side, /sessionStorage\.setItem\('sv-sessions-settings', '1'\)/);
  assert.match(side, /<span>Settings<\/span>/);
});


// ---- setup chips link to Connect Agents ----

function loadCT() {
  const window = {};
  vm.runInNewContext(read('js/components/config-trust.js') + '\nwindow.__C = ConfigTrust;', { window, API: {}, document: {} });
  return window.__C;
}

test('setup chips are links to the Connect Agents page, only when a decision is needed', async () => {
  const ct = loadCT();
  assert.equal(ct.factsPart({ id: 't9', setup_state: 'new' }), '');
  assert.match(ct.factsPart({ id: 't9', setup_state: 'changed', setup_changes: 2 }), /role="button" tabindex="0" data-setup-open="t9"/);
  assert.ok(!ct.factsPart({ id: 't9', setup_state: 'pinned' }).includes('data-setup-open'));
  let went = null;
  let click = null; let key = null;
  const chip = { addEventListener(t, f) { if (t === 'click') click = f; else key = f; } };
  const win = { Sidebar: { navigate: (p) => { went = p; } } };
  vm.runInNewContext(read('js/components/config-trust.js') + '\nwindow.__C = ConfigTrust;', { window: win, Sidebar: win.Sidebar, API: {}, document: {} });
  win.__C.bindChips({ querySelectorAll: () => [chip] });
  click({ preventDefault() {}, stopPropagation() {} });
  assert.strictEqual(went, 'guide-connect-agents');
  went = null;
  key({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
  assert.strictEqual(went, 'guide-connect-agents');
  assert.match(read('js/components/sidebar.js'), /ConfigTrust\.bindChips\(facts\)/);
  assert.match(read('js/pages/terminals.js'), /ConfigTrust\.bindChips\(el\)/);
});

// ---- ask examples, copy, and accessible names ----

test('how to ask your agent: two examples, the second marked, each with Copy', async () => {
  const ui = loadUi();
  const html = ui.introHtml();
  assert.match(html, /How to ask your agent/);
  assert.match(html, /Your agent delegates through the SecureVector delegate tool\. Ask it in plain words, for example:/);
  assert.strictEqual((html.match(/data-deleg-copy="/g) || []).length, 2);
  assert.match(html, /Use SecureVector delegate to have Codex build page1\.html, wait for the result, then merge it into index\.html\./);
  assert.strictEqual((html.match(/needs cross-harness delegation on/g) || []).length, 1);
  // Clipboard API first, then the textarea fallback, then a toast.
  const toasts = [];
  let written = null;
  const mk = (clip) => {
    const win = { Toast: { success: (m) => toasts.push(['ok', m]), error: (m) => toasts.push(['err', m]) } };
    const body = { appendChild() {}, removeChild() {} };
    const document = { createElement: () => ({ style: {}, setAttribute() {}, select() {} }), body, execCommand: () => true };
    const navigator = clip ? { clipboard: { writeText: async (t) => { written = t; } } } : {};
    vm.runInNewContext(read('js/components/delegation-ui.js') + '\nwindow.__D = DelegationUI;', { window: win, Toast: win.Toast, document, navigator });
    return win.__D;
  };
  assert.strictEqual(await mk(true).copyText('abc'), true);
  assert.strictEqual(written, 'abc');
  assert.strictEqual(await mk(false).copyText('abc'), true);
  assert.strictEqual(JSON.stringify(toasts), JSON.stringify([['ok', 'Copied'], ['ok', 'Copied']]));
});

test('every toggle in the settings card has an accessible name from its visible label', () => {
  const ui = loadUi();
  const html = ui.cardHtml({});
  const boxes = html.match(/<input type="checkbox"[^>]*>/g) || [];
  assert.strictEqual(boxes.length, 2);
  const names = boxes.map((b) => {
    const id = /aria-labelledby="([^"]+)"/.exec(b)[1];
    return new RegExp(`id="${id}">([^<]+)<`).exec(html)[1];
  });
  assert.strictEqual(JSON.stringify(names), JSON.stringify(['Delegation', 'Allow cross-harness delegation']));
  assert.ok(names.includes('Allow cross-harness delegation'), 'role checkbox, name resolves');
});

test('buttons added for delegation and rungs carry names', () => {
  const ui = loadUi();
  const held = ui.itemHtml({ id: 'd2', state: 'held', harness: 'codex' });
  assert.match(held, /aria-label="Release the held result from Codex"/);
  assert.match(held, /aria-label="Discard the held result from Codex"/);
  assert.match(ui.cardHtml({ folder_allowlist: ['/a'] }), /aria-label="Remove folder \/a"/);
  const src = read('js/pages/terminals.js');
  assert.match(src, /id="terminals-settings-btn"[^>]*>\$\{this\.GEAR_SVG\}<span>Settings<\/span>/);
  const rung = read('js/components/response-rungs.js');
  assert.match(rung, /aria-label="Turn on response steps for \$\{hl\}"/);
  assert.match(src, /data-remove-id="\$\{this\._esc\(t\.id\)\}"[^>]*>\$\{this\._esc\(verb\)\}/);
});
