/** Observability > Runs, Group: Harness. A row per harness above its
 *  sessions (js/components/runs-list.js helpers, js/pages/agent-runs.js
 *  harness header). */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');
const NOW = Date.parse('2026-10-23T14:30:00Z');
const at = (min) => new Date(NOW - min * 60000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

function loadRL() {
  const window = {};
  vm.runInNewContext(read('js/components/runs-list.js'), { window, console });
  return window.RunsList;
}

// A tiny DOM: enough for the header builders, serialised for asserts.
function el(tag) {
  const e = {
    tag, attrs: {}, dataset: {}, style: {}, kids: [], html: '', listeners: {}, textContent: '', className: '',
    classList: { add(c) { e.className += ' ' + c; }, toggle() {} },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { this.kids.push(c); return c; },
    insertAdjacentHTML(_, h) { this.kids.push({ raw: h }); },
    addEventListener(t, f) { this.listeners[t] = f; },
    click() { if (this.listeners.click) this.listeners.click({ target: this }); },
    set innerHTML(h) { this.html = h; this.kids = []; },
    get innerHTML() { return this.html; },
  };
  return e;
}
function ser(e) {
  if (e.raw != null) return e.raw;
  const a = Object.entries(e.attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
  const d = Object.entries(e.dataset).map(([k, v]) => ` data-${k}="${v}"`).join('');
  return `<${e.tag} class="${e.className.trim()}"${a}${d}>${e.html}${e.textContent}${e.kids.map(ser).join('')}</${e.tag}>`;
}
function loadPage() {
  const document = { getElementById: () => null, createElement: el };
  const sandbox = { window: {}, document, console };
  vm.runInNewContext(read('js/components/runs-list.js'), sandbox);
  sandbox.RunsList = sandbox.window.RunsList;
  vm.runInNewContext(read('js/pages/agent-runs.js'), sandbox);
  return { P: sandbox.window.AgentRunsPage, RL: sandbox.RunsList };
}

const R = (t, s, k, min, extra = {}) => Object.assign({ trace_id: t, session_id: s, runtime_kind: k, started_at: at(min), ended_at: at(min - 1), allowed: 1, waiting: 0, blocked: 0 }, extra);
function fleet() {
  return [
    R('o1', 'so1', 'openclaw', 5),
    R('h1', 'sh1', 'hermes', 50, { waiting: 1, oldest_waiting_expires_at: at(-10) }),
    R('o2', 'so2', 'openclaw', 30, { blocked: 2 }),
    R('h2', 'sh2', 'hermes', 60),
    R('c1', 'sc1', 'opencode', 2),
    R('o3', 'so1', 'openclaw', 8),
  ];
}

test('groupByHarness: waiting harness first, then newest session start; counts per harness', () => {
  const RL = loadRL();
  const ctx = RL.buildCtx(fleet(), { now: NOW });
  const ordered = RL.waitingFirst(RL.sortRuns(fleet(), 'started', 'desc', ctx));
  const hs = RL.groupByHarness(RL.groupBySession(ordered));
  assert.deepEqual([...hs.map(h => h.key)], ['hermes', 'opencode', 'openclaw']);
  const oc = hs.find(h => h.key === 'openclaw');
  assert.deepEqual([...oc.sessions.map(g => g.key)], ['so1', 'so2'], 'sessions keep their order inside a harness');
  assert.equal(oc.runs, 3);
  assert.equal(oc.blocked, 2);
  const he = hs[0];
  assert.equal(he.waiting, 1);
  assert.deepEqual([...he.sessions.map(g => g.key)], ['sh1', 'sh2'], 'the waiting session leads inside its harness');
  // harnessOrder: each harness's sessions contiguous.
  assert.deepEqual([...RL.harnessOrder(ordered).map(r => r.trace_id)], ['h1', 'h2', 'c1', 'o1', 'o3', 'o2']);
});

test('a run without runtime_kind groups under "unknown"', () => {
  const RL = loadRL();
  const hs = RL.groupByHarness(RL.groupBySession([{ trace_id: 'x', session_id: 'sx', started_at: at(1) }]));
  assert.equal(hs[0].key, 'unknown');
});

test('group preference: new select values, old boolean maps to Session or None', () => {
  const RL = loadRL();
  assert.equal(RL.groupModeFrom({}), 'session');
  assert.equal(RL.groupModeFrom(null), 'session');
  assert.equal(RL.groupModeFrom({ groupBySession: true }), 'session');
  assert.equal(RL.groupModeFrom({ groupBySession: false }), 'none');
  assert.equal(RL.groupModeFrom({ groupMode: 'harness', groupBySession: true }), 'harness');
  assert.equal(RL.groupModeFrom({ groupMode: 'bogus', groupBySession: false }), 'none');
  const { P } = loadPage();
  assert.equal(P.groupMode, 'session', 'default stays Session');
  P.groupMode = 'harness';
  const v = P._viewState();
  assert.equal(v.groupMode, 'harness');
  assert.equal(v.groupBySession, true, 'the old key stays readable');
});

test('toolbar: a Group select (Session, Harness, None) replaces the checkbox', () => {
  const src = read('js/pages/agent-runs.js');
  assert.doesNotMatch(src, /Group by session/);
  assert.match(src, /\['session', 'Session'\], \['harness', 'Harness'\], \['none', 'None'\]/);
  assert.match(src, /gsel\.id = 'rl-group'/);
});

test('harness paging: by session, a harness over a page break repeats as "(continued)"', () => {
  const RL = loadRL();
  const list = [];
  for (let i = 0; i < 3; i++) list.push(R(`a${i}`, `sa${i}`, 'openclaw', 10 + i));
  for (let i = 0; i < 3; i++) list.push(R(`b${i}`, `sb${i}`, 'hermes', 100 + i));
  const p0 = RL.pageHarness(list, 0, 4);
  const p1 = RL.pageHarness(list, 1, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(p0.harnesses.map(h => [h.key, h.sessions.length, h.continued]))), [['openclaw', 3, false], ['hermes', 1, false]]);
  assert.deepEqual(JSON.parse(JSON.stringify(p1.harnesses.map(h => [h.key, h.sessions.length, h.continued]))), [['hermes', 2, true]]);
  assert.equal(p1.harnesses[0].all.sessions.length, 3, 'the header counts the whole harness');
  assert.deepEqual([p0.hFrom, p0.hTo, p0.hTotal, p0.from, p0.to, p0.total], [1, 2, 2, 1, 4, 6]);
  assert.deepEqual([p1.hFrom, p1.hTo, p1.from, p1.to], [2, 2, 5, 6]);
  // The page of a run, over the harness order, matches pageHarness.
  const ord = RL.harnessOrder(list);
  assert.equal(RL.pageOfRun(ord, 'b2', false, 4), 1);
  assert.equal(RL.pageOfRun(ord, 'a2', false, 4), 0);
});

test('harness header: counts, waiting button, blocked, coverage, caret aria', () => {
  const { P, RL } = loadPage();
  const runs = fleet();
  P.runs = runs;
  P._ctx = RL.buildCtx(runs, { now: NOW, coverage: { hermes: { enforced: 'before_call', unchecked: ['shell'] } } });
  const info = RL.pageHarness(RL.waitingFirst(runs), 0, 50);
  const he = info.harnesses.find(h => h.key === 'hermes');
  let jumped = null;
  P._jumpToWaiting = (ids) => { jumped = ids; };
  const { head, closed } = P._harnessHead(he);
  assert.equal(closed, false, 'harness rows start open');
  const html = ser(head);
  assert.equal(head.attrs.role, 'group');
  assert.match(html, /<b>hermes<\/b>/);
  assert.match(html, /2 sessions · 2 runs/);
  assert.match(html, /1 waiting for approval/);
  assert.match(html, /partial · 1 path not checked/);
  assert.doesNotMatch(html, /\(continued\)/);
  const caret = head.kids[0];
  assert.equal(caret.attrs['aria-expanded'], 'true');
  const wait = head.kids.find(k => k.dataset && k.dataset.fk === 'wharness:hermes');
  wait.listeners.click({ stopPropagation() {} });
  assert.deepEqual([...jumped].sort(), ['h1', 'h2'], 'the waiting button jumps across all its sessions');
  // Openclaw: blocked count, no waiting button.
  const oc = ser(P._harnessHead(info.harnesses.find(h => h.key === 'openclaw')).head);
  assert.match(oc, /2 blocked/);
  assert.doesNotMatch(oc, /waiting for approval/);
  // Toggle: the caret closes it and remembers per harness.
  P.renderRuns = () => {};
  caret.click();
  assert.equal(P._openHarness.hermes, false);
  const again = P._harnessHead(he);
  assert.equal(again.closed, true);
  assert.equal(again.head.kids[0].attrs['aria-expanded'], 'false');
});

test('a continued harness header says so', () => {
  const { P, RL } = loadPage();
  const list = [];
  for (let i = 0; i < 3; i++) list.push(R(`b${i}`, `sb${i}`, 'hermes', 100 + i));
  P.runs = list;
  P._ctx = RL.buildCtx(list, { now: NOW });
  const p1 = RL.pageHarness(list, 1, 2);
  const html = ser(P._harnessHead(p1.harnesses[0]).head);
  assert.match(html, /\(continued\)/);
  assert.match(html, /3 sessions · 3 runs/);
  assert.match(html, /aria-label="Harness hermes \(continued\)"/);
});

test('renderRuns in harness mode: harness order before paging, pager text', () => {
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /byHarness \? RL\.harnessOrder\(RL\.waitingFirst\(sorted\)\)/);
  assert.match(src, /`Harnesses \$\{info\.hFrom\}–\$\{info\.hTo\} · sessions \$\{info\.from\}–\$\{info\.to\} of/);
  assert.match(src, /this\._openHarness\[RL\.harnessKey\(g \? g\.runs\[0\] : r\)\] = true/, 'a waiting jump opens the harness');
});

test('two waiting harnesses: the soonest-expiring leads; the rest follow the list sort', () => {
  const RL = loadRL();
  const list = [
    R('n1', 'sn', 'newest', 1),
    R('w1', 'sw1', 'late', 30, { waiting: 1, oldest_waiting_expires_at: at(-40) }),
    R('w2', 'sw2', 'soon', 90, { waiting: 1, oldest_waiting_expires_at: at(-5) }),
    R('o1', 'so', 'oldest', 200),
  ];
  const ctx = RL.buildCtx(list, { now: NOW });
  const desc = RL.waitingFirst(RL.sortRuns(list, 'started', 'desc', ctx));
  assert.deepEqual([...RL.groupByHarness(RL.groupBySession(desc)).map(h => h.key)], ['soon', 'late', 'newest', 'oldest']);
  const asc = RL.waitingFirst(RL.sortRuns(list, 'started', 'asc', ctx));
  assert.deepEqual([...RL.groupByHarness(RL.groupBySession(asc)).map(h => h.key)], ['soon', 'late', 'oldest', 'newest'], 'oldest first is respected');
});

test('running sessions: summary line count and harness header part', () => {
  const { P, RL } = loadPage();
  const list = [
    R('a1', 'sa', 'hermes', 3, { ended_at: at(0) }), R('a2', 'sa', 'hermes', 6, { ended_at: at(0) }),
    R('b1', 'sb', 'hermes', 50),
  ];
  const ctx = RL.buildCtx(list, { now: NOW });
  const running = list.filter(r => RL.isRunning(r, ctx)).length;
  assert.ok(running >= 1, 'fixture has running runs');
  assert.equal(RL.runningSessions(list, ctx), 1, 'distinct sessions, not runs');
  const texts = (its) => [...its.map(i => i.text)];
  assert.equal(texts(RL.summaryItems(list, ctx, '24h', RL.emptyFilters(), null))[1], '1 session running');
  assert.equal(texts(RL.summaryItems([list[2]], ctx, '24h', RL.emptyFilters(), null))[1], '0 sessions running', 'zero still shows');
  P.runs = list; P._ctx = ctx;
  const h = RL.pageHarness(list, 0, 50).harnesses[0];
  assert.match(ser(P._harnessHead(h).head), /2 sessions · 1 running · 3 runs/);
  const ended = [R('c1', 'sc', 'codex', 50), R('c2', 'sd', 'codex', 70)];
  P.runs = ended; P._ctx = RL.buildCtx(ended, { now: NOW });
  const html = ser(P._harnessHead(RL.pageHarness(ended, 0, 50).harnesses[0]).head);
  assert.match(html, /2 sessions · 2 runs/);
  assert.doesNotMatch(html, /running/);
});

test('under a harness row the session header leads with the session id, not the harness name', () => {
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /this\.groupMode === 'harness' && first\.session_id\s*\n\s*\? ''\s*\n\s*: `<b>\$\{this\._esc\(first\.runtime_kind \|\| 'unknown'\)\}<\/b>`/);
});

test('the Group choice is remembered per browser', () => {
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /localStorage\.getItem\('sv-ar-group'\)/);
  assert.match(src, /localStorage\.setItem\('sv-ar-group', this\.groupMode\)/);
});

test('the session id chip uses the theme accent so it reads as copyable', () => {
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /\.rl-copy \{[^}]*color:var\(--accent-primary,#5eadb8\); \}/);
  assert.match(src, /\.rl-copy:hover \{ background:color-mix\(in srgb, var\(--accent-primary,#5eadb8\) 22%, transparent\); \}/);
});
