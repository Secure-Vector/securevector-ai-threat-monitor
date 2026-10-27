/** Observability > Runs: the one-line summary (no cards), its waiting and
 *  refused buttons that toggle the Decision filter, the "now" segment on a
 *  running session's header; and the Guardian's findings, which are a badge
 *  and one brief toast, never a bubble, while the egress alert still shows. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

const NOW = Date.parse('2026-10-26T14:30:00Z');
const at = (min) => new Date(NOW - min * 60000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
const iso = (sec) => new Date(NOW - sec * 1000).toISOString();

function loadAll() {
  const window = {};
  const sandbox = { window, console };
  vm.createContext(sandbox);
  vm.runInContext(read('js/components/trace-steps.js'), sandbox);
  sandbox.TraceSteps = window.TraceSteps;
  vm.runInContext(read('js/components/run-trace.js'), sandbox);
  vm.runInContext(read('js/components/runs-list.js'), sandbox);
  vm.runInContext(read('js/components/live-grid-model.js'), sandbox);
  return { RL: window.RunsList, LGM: window.LiveGridModel, RT: window.RunTrace, window, sandbox };
}

const fmtDur = (ms) => `${Math.round(ms / 60000)}m`;
const texts = (items) => JSON.parse(JSON.stringify(items.map(i => i.text)));

// --------------------------------------------------------------- summary

test('summary line: runs, waiting, refused, then median; cost omitted when not recorded', () => {
  const { RL } = loadAll();
  const shown = [
    { trace_id: 'a', started_at: at(30), ended_at: at(28), waiting: 1, blocked: 0 },
    { trace_id: 'b', started_at: at(20), ended_at: at(10), waiting: 0, blocked: 2 },
    { trace_id: 'c', started_at: at(15), ended_at: at(11), waiting: 0, blocked: 0 },
  ];
  const ctx = RL.buildCtx(shown, { now: NOW });
  const items = RL.summaryItems(shown, ctx, '24h', RL.emptyFilters(), fmtDur);
  assert.deepEqual(texts(items), ['3 runs', '1 waiting for approval', '2 calls refused', 'median run 4m']);
  assert.equal(items[1].tone, 'amber');
  assert.equal(items[2].tone, 'red');
  assert.equal(items[2].title, 'tool policy + egress · listed runs · last 24h');
  assert.ok(!texts(items).some(t => /Not recorded|\$/.test(t)), 'no cost item when cost was not recorded');
});

test('summary line: cost and tokens show only when cost was recorded; median not p95; none under two finished runs', () => {
  const { RL } = loadAll();
  const shown = [
    { trace_id: 'a', started_at: at(60), ended_at: at(59), cost: 0.5, generations: 2, tokens: 12000 },
    { trace_id: 'b', started_at: at(50), ended_at: at(48), cost: 0.25, generations: 1, tokens: 3000 },
    { trace_id: 'c', started_at: at(40), ended_at: at(37) },
    { trace_id: 'd', started_at: at(240), ended_at: at(40) },
  ];
  const ctx = RL.buildCtx(shown, { now: NOW });
  const items = RL.summaryItems(shown, ctx, '24h', RL.emptyFilters(), fmtDur);
  assert.ok(texts(items).includes('$0.75 · 15k tokens'));
  // durations 1, 2, 3, 200 minutes: the median is 2.5m, p95 would be 200m
  assert.equal(items[items.length - 1].text, 'median run 3m');
  assert.equal(RL.median([1, 2, 3, 200]), 2.5);
  assert.equal(RL.median([5]), 5);
  assert.equal(RL.median([]), 0);
  // one finished run: no median; zero counts stay plain and neutral
  const one = [shown[0]];
  const t1 = texts(RL.summaryItems(one, RL.buildCtx(one, { now: NOW }), '1h', RL.emptyFilters(), fmtDur));
  assert.deepEqual(t1, ['1 run', '0 waiting for approval', '0 calls refused', '$0.50 · 12k tokens']);
});

function pageHarness() {
  const { RL, LGM, RT, window } = loadAll();
  const box = { innerHTML: '', onclick: null };
  const sandbox = {
    window, console, RunsList: RL, LiveGridModel: LGM, RunTrace: RT,
    document: { getElementById: (id) => (id === 'rl-summary' ? box : null) },
  };
  vm.runInNewContext(read('js/pages/agent-runs.js'), sandbox);
  const P = window.AgentRunsPage;
  P.filters = RL.emptyFilters();
  P.range = '24h';
  let renders = 0;
  P.renderRuns = () => { renders++; };
  return { P, RL, box, renders: () => renders };
}

const click = (box, key) => box.onclick({ target: { closest: (sel) => (sel === '[data-sum]' ? { dataset: { sum: key } } : null) } });

test('waiting and refused are buttons that toggle the Decision filter; a zero count is plain text', () => {
  const { P, RL, box, renders } = pageHarness();
  const shown = [
    { trace_id: 'a', started_at: at(30), ended_at: at(28), waiting: 2, blocked: 0 },
    { trace_id: 'b', started_at: at(20), ended_at: at(10), waiting: 0, blocked: 1 },
  ];
  P._ctx = RL.buildCtx(shown, { now: NOW });
  P._renderSummary(shown);
  assert.match(box.innerHTML, /<button type="button" class="rl-sum-i rl-amb-t" data-sum="waiting" aria-pressed="false">2 waiting for approval<\/button>/);
  assert.match(box.innerHTML, /<button type="button" class="rl-sum-i rl-red-t" data-sum="blocked" aria-pressed="false" title="tool policy \+ egress · listed runs · last 24h">1 call refused<\/button>/);
  assert.doesNotMatch(box.innerHTML, /rl-card|<svg/);

  click(box, 'waiting');
  assert.deepEqual([...P.filters.decision], ['waiting']);
  assert.equal(renders(), 1);
  P._renderSummary(shown.filter(r => r.waiting));
  assert.match(box.innerHTML, /data-sum="waiting" aria-pressed="true"/);
  click(box, 'waiting');
  assert.deepEqual([...P.filters.decision], [], 'clicking again clears it');

  click(box, 'blocked');
  assert.deepEqual([...P.filters.decision], ['blocked']);
  // the refused filter is on but nothing is refused in view: still a button, so it can be cleared
  P._renderSummary([{ trace_id: 'z', started_at: at(5), ended_at: at(4) }]);
  assert.match(box.innerHTML, /data-sum="blocked" aria-pressed="true"/);
  assert.match(box.innerHTML, /<span class="rl-sum-i">0 waiting for approval<\/span>/);
  click(box, 'blocked');
  assert.deepEqual([...P.filters.decision], []);
});

test('the page has no cards left and the summary sits where they were', () => {
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /<section class="rl-summary" id="rl-summary" aria-label="Summary for the runs in view"><\/section>/);
  assert.doesNotMatch(src, /rl-cards|_renderCards|Run duration, p95|_spark\(/);
  assert.match(src, /this\._renderSummary\(shown\);/);
});

// --------------------------------------------------- running session "now"

function live(extra = {}) {
  return Object.assign({
    session_id: 's1', harness: 'claude-code', quiet_seconds: 12, waiting: 0, blocked: 0,
    egress_visible: true, last_egress: null,
    last_call: { tool_id: 'Bash', function_name: 'Bash', action: 'allow', args_preview: '{"command":"npm test"}', at: iso(12) },
    last_activity_at: iso(12),
  }, extra);
}

test('a running session says what it is doing now: tool, target, age; Governed; egress in Live grid words', () => {
  const { RL, LGM, RT } = loadAll();
  const n = RL.sessionNow(live(), NOW, LGM, RT);
  assert.equal(n.activity, 'Bash · npm test · 12s ago');
  assert.deepEqual({ ...n.gov }, { key: 'governed', text: 'Governed' });
  assert.equal(LGM.egressState(live()).key, n.egress.key);
  assert.equal(n.egress.text, 'Egress none observed');
  assert.equal(RL.sessionNow(live({ egress_visible: false }), NOW, LGM, RT).egress.text, 'Egress not monitored');
  const missing = live(); delete missing.egress_visible; delete missing.last_egress;
  assert.equal(RL.sessionNow(missing, NOW, LGM, RT).egress.text, 'Egress not synced yet');
  assert.equal(RL.sessionNow(live({ last_egress: { host: 'api.example.test', action: 'allow' } }), NOW, LGM, RT).egress.text, 'Egress api.example.test');
  assert.equal(RL.sessionNow(live({ last_egress: { host: 'x.example.test', action: 'block' } }), NOW, LGM, RT).egress.key, 'blocked');
  assert.equal(RL.sessionNow(null, NOW, LGM, RT), null);
});

test('quiet past 5 minutes reads "Quiet 7m"; blocked shows Blocked N; waiting leaves the badge to the waiting button', () => {
  const { RL, LGM, RT } = loadAll();
  assert.equal(RL.sessionNow(live({ quiet_seconds: 420 }), NOW, LGM, RT).activity, 'Quiet 7m');
  assert.equal(RL.sessionNow(live({ quiet_seconds: 300 }), NOW, LGM, RT).activity, 'Bash · npm test · 12s ago');
  assert.deepEqual({ ...RL.sessionNow(live({ blocked: 2 }), NOW, LGM, RT).gov }, { key: 'blocked', text: 'Blocked 2' });
  assert.equal(RL.sessionNow(live({ waiting: 1 }), NOW, LGM, RT).gov, null);
  // a long target is cut to 48 characters
  const long = 'x'.repeat(120);
  const act = RL.sessionNow(live({ last_call: { function_name: 'Bash', args_preview: JSON.stringify({ command: long }), at: iso(3) } }), NOW, LGM, RT).activity;
  const target = act.split(' · ')[1];
  assert.ok(target.length <= 48, `target ${target.length} chars`);
  assert.ok(target.endsWith('…'));
});

// A tiny DOM: enough for _sessionHead to build its header.
function fakeNode(tag) {
  const n = {
    tagName: tag, className: '', children: [], html: '', attrs: {}, dataset: {}, style: {}, textContent: '', title: '',
    classList: { add(c) { n.className += ' ' + c; }, remove() {}, toggle() {}, contains: () => false },
    setAttribute(k, v) { n.attrs[k] = v; }, getAttribute(k) { return n.attrs[k]; },
    addEventListener() {}, appendChild(c) { n.children.push(c); n.html += `<${c.tagName} class="${c.className}">${c.textContent || ''}${c.innerHTML || ''}</${c.tagName}>`; return c; },
    insertAdjacentHTML(_, h) { n.html += h; },
    set innerHTML(v) { n._inner = v; }, get innerHTML() { return n._inner || ''; },
    querySelector() { return fakeNode('span'); },
  };
  return n;
}

function headHarness(liveRows) {
  const { RL, LGM, RT, window } = loadAll();
  const sandbox = {
    window, console, RunsList: RL, LiveGridModel: LGM, RunTrace: RT,
    document: { getElementById: () => null, createElement: (t) => fakeNode(t) },
  };
  vm.runInNewContext(read('js/pages/agent-runs.js'), sandbox);
  const P = window.AgentRunsPage;
  P.filters = RL.emptyFilters();
  P._liveData = { sessions: liveRows };
  P._openSessions = {};
  P._expandedSessions = {};
  return { P, RL };
}

test('a running session header carries the now segment; an ended header is unchanged', () => {
  const runRunning = { trace_id: 't1', session_id: 's1', runtime_kind: 'claude-code', started_at: at(3), ended_at: null, is_live: true, status: 'running' };
  const { P, RL } = headHarness([live({ blocked: 1, last_call: { function_name: 'Bash', args_preview: '{"command":"echo <b>hi</b>"}', at: iso(12) } })]);
  P.runs = [runRunning];
  P._ctx = RL.buildCtx(P.runs, { now: NOW, live: P._liveData });
  const running = RL.isRunning(runRunning, P._ctx);
  const { head } = P._sessionHead({ key: 's1', runs: [runRunning] }, 0);
  if (running) {
    assert.match(head.html, /<span class="rl-now" title="[^"]*">/);
    assert.match(head.html, /<span class="rl-now-act">Bash · echo &lt;b&gt;hi&lt;\/b&gt; · 12s ago<\/span>/);
    assert.match(head.html, /<span class="rl-now-gov rl-red">Blocked 1<\/span>/);
    assert.match(head.html, /<span class="rl-now-eg">Egress none observed<\/span>/);
  } else {
    assert.fail('the fixture run should read as running from the live row');
  }

  const ended = { trace_id: 't2', session_id: 's2', runtime_kind: 'codex', started_at: at(90), ended_at: at(80) };
  const h2 = headHarness([live({ session_id: 's2' })]);
  h2.P.runs = [ended];
  h2.P._ctx = h2.RL.buildCtx(h2.P.runs, { now: NOW });
  const { head: endedHead } = h2.P._sessionHead({ key: 's2', runs: [ended] }, 0);
  assert.doesNotMatch(endedHead.html, /rl-now/);
});

test('the now segment shrinks rather than overflowing the header', () => {
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /\.rl-now \{ display:inline-block; min-width:0; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;/);
  assert.match(src, /\.rl-sh\.rl-sh-wait \.rl-now \{ flex-shrink:1; \}/);
  assert.match(src, /if \(running && first\.session_id\) \{/);
});

// --------------------------------------------------------------- Guardian

function fakeEl() {
  const el = {
    dataset: {}, isConnected: true, className: '', _attrs: {}, _kids: {}, innerHTML: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(k, v) { this._attrs[k] = v; },
    addEventListener(t, fn) { this._on = fn; },
    remove() { this.isConnected = false; },
    appendChild(c) { this._kids[c.className] = c; return c; },
    querySelector(sel) {
      if (sel === '.sv-ga-bubble-mute' && !/sv-ga-bubble-mute/.test(this.innerHTML)) return null;
      if (sel === '.sv-ga-badge') { const b = this._kids['sv-ga-badge']; return b && b.isConnected ? b : null; }
      if (!this._kids[sel]) this._kids[sel] = fakeEl();
      return this._kids[sel];
    },
  };
  return el;
}

function loadGuardian(store, page) {
  const m = new Map(Object.entries(store || {}));
  const localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
  const body = { appended: [], appendChild(el) { this.appended.push(el); } };
  const sandbox = {
    console, localStorage, setTimeout: () => 0, clearTimeout: () => {},
    requestAnimationFrame: (fn) => fn(),
    document: { createElement: () => fakeEl(), body, addEventListener() {}, removeEventListener() {} },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('js/components/guardian-assistant.js'), sandbox);
  const GA = sandbox.window.GuardianAssistant;
  GA._fab = fakeEl();
  GA._placeNear = () => {};
  GA._react = () => {};
  GA._thoughtPlace = () => {};
  let cur = page || 'agent-runs';
  GA._currentPage = () => cur;
  return { GA, m, body, win: sandbox.window, setPage: (p) => { cur = p; } };
}

function api(totals) {
  return {
    request: async (url) => (url.startsWith('/api/threat-intel') ? { total: totals.threats }
      : url.startsWith('/api/egress/destinations') ? { destinations: [] } : null),
    getRedactions: async () => ({ summary: { total: totals.redactions } }),
    getBlockedLedger: async () => ({ summary: { blocked_total: totals.blocked } }),
    getOptimizerSessions: async () => ({ sessions: [] }),
  };
}

const badge = (GA) => { const b = GA._fab.querySelector('.sv-ga-badge'); return b ? b.textContent : ''; };

test('a new threat is a badge count and one brief toast with a review action, never a bubble', async () => {
  const { GA, body, win, m } = loadGuardian({ 'sv-guardian-quiet': '1' });
  win.API = api({ threats: 4, redactions: 1, blocked: 0 });
  await GA._sentinelTick(); // baseline: says nothing
  assert.equal(body.appended.length, 0);
  win.API = api({ threats: 6, redactions: 2, blocked: 0 });
  await GA._sentinelTick();
  assert.equal(GA._bubbleEl == null, true, 'no bubble for a finding');
  const toasts = body.appended.filter(e => e.className === 'sv-ga-toast');
  assert.equal(toasts.length, 1, 'never more than one toast');
  assert.equal(toasts[0]._kids['.sv-ga-toast-t'].textContent, '2 new threats flagged.');
  assert.equal(toasts[0]._kids['.sv-ga-toast-go'].textContent, 'Review threats');
  assert.ok(!/Mute tips/.test(toasts[0].innerHTML), 'a finding never offers Mute tips');
  assert.equal(badge(GA), '3', 'muted or not, both findings are counted');
  assert.deepEqual(JSON.parse(m.get('sv-ga-findings')), { threats: 2, redactions: 1 });
  // the toast's action opens the page and reads that finding
  let went = null;
  win.Sidebar = { navigate: (p) => { went = p; } };
  toasts[0]._kids['.sv-ga-toast-go']._on();
  assert.equal(went, 'threats');
  assert.deepEqual(JSON.parse(m.get('sv-ga-findings')), { redactions: 1 });
  assert.equal(badge(GA), '1');
});

test('the per-category cooldown holds the next toast; the badge still counts', async () => {
  const { GA, body, win } = loadGuardian();
  win.API = api({ threats: 1, redactions: 0, blocked: 0 });
  await GA._sentinelTick();
  win.API = api({ threats: 2, redactions: 0, blocked: 0 });
  await GA._sentinelTick();
  GA._toastHide();
  win.API = api({ threats: 3, redactions: 0, blocked: 0 });
  await GA._sentinelTick();
  assert.equal(body.appended.filter(e => e.className === 'sv-ga-toast').length, 1, 'cooldown: no second toast');
  assert.equal(badge(GA), '2');
});

test('the badge clears when the Guardian opens or the finding page is visited', async () => {
  const { GA, setPage } = loadGuardian();
  GA._findingAdd('threats', 2, false);
  GA._findingAdd('blocked', 1, false);
  assert.equal(badge(GA), '3');
  setPage('blocked-ledger');
  GA._findingsVisit();
  assert.equal(badge(GA), '2');
  // already on the page: nothing new to count
  GA._findingAdd('blocked', 4, true);
  assert.equal(badge(GA), '2');
  // opening the panel reads the rest and lists them with their links
  GA._build = () => { GA._panel = fakeEl(); };
  GA._panelRestore = () => true;
  GA._fill = async () => {};
  await GA.open();
  assert.equal(badge(GA), '');
  assert.deepEqual(JSON.parse(JSON.stringify(GA._openFindings)), { threats: 2 });
  const rows = [];
  GA._row = (o) => { rows.push(o); return fakeEl(); };
  GA._findingsSection(fakeEl());
  assert.deepEqual(rows.map(r => [r.label, r.page, r.sub]), [['Review threats', 'threats', '2 new threats flagged.']]);
});

test('tips and recaps never open a bubble; they wait in the panel notes, and mute still applies', () => {
  const { GA } = loadGuardian();
  assert.equal(GA._speak({ text: 'a tip', cta: 'See', page: 'costs' }), true);
  assert.equal(GA._bubbleEl == null, true);
  assert.equal(GA._notes[0].text, 'a tip');
  GA._setQuiet(true);
  assert.equal(GA._speak({ text: 'another tip', cta: 'See', page: 'costs' }), false);
  // an answer the user asked for still speaks
  GA._setQuiet(false);
  assert.equal(GA._speak({ text: 'This one.', cta: 'Why', page: 'costs', asked: true }), true);
  assert.ok(GA._bubbleEl);
});

test('the suspicious egress alert still shows, in the bottom-right corner, muted or not', () => {
  const { GA, body } = loadGuardian({ 'sv-guardian-quiet': '1' });
  const ALERT = { id: 's|paste.example.test', session_id: 's', host: 'paste.example.test', text: 'Codex s sent data to paste.example.test.' };
  assert.equal(GA._securityShow([ALERT]), true);
  const b = body.appended[body.appended.length - 1];
  assert.equal(b.className, 'sv-ga-bubble sv-ga-security sv-ga-corner');
  assert.equal(b.dataset.kind, 'security');
  const src = read('js/components/guardian-assistant.js');
  assert.match(src, /\.sv-ga-bubble\.sv-ga-corner \{ left: auto !important; top: auto !important; right: 16px; bottom: 100px;\n\s+width: min\(320px, calc\(100vw - 32px\)\);/);
  assert.match(src, /max-width: min\(320px, calc\(100vw - 32px\)\)/);
  assert.match(src, /@media \(max-width: 700px\) \{\n\s+\.sv-ga-toast, \.sv-ga-bubble\.sv-ga-corner \{ right: 16px; left: 16px !important;/);
  assert.match(src, /\.sv-ga-toast \{ position: fixed; right: 16px; bottom: 100px;/);
  assert.match(src, /\.sv-ga-fab \{ position: fixed; right: 22px; bottom: 18px;/, 'both sit above the Guardian button');
  assert.match(src, /if \(!security\) this\._placeNear\(b\);\n\s+else this\._toastStack\(\);/);
});

test('a toast shown with the egress alert up stacks above it', () => {
  const { GA } = loadGuardian();
  GA._securityShow([{ id: 'x|h.example.test', session_id: 'x', host: 'h.example.test', text: 'x reached h.example.test.' }]);
  GA._bubbleEl.offsetHeight = 120;
  GA._bubbleEl.style = {};
  assert.equal(GA._findingAdd('threats', 1, true), true);
  GA._toastEl.style = GA._toastEl.style || {};
  GA._toastStack();
  assert.equal(GA._toastEl.style.bottom, '228px');
  GA._hideBubble();
  assert.equal(GA._toastEl.style.bottom, '');
});

test('time-sensitive advice still speaks; notes keep their in-page action', () => {
  const { GA } = loadGuardian();
  assert.equal(GA._speak({ text: 'At 85% of the daily budget.', cta: 'See the spend', page: 'costs', urgent: true }), true);
  assert.ok(GA._bubbleEl, 'urgent advice opens its bubble');
  const src = read('js/components/guardian-assistant.js');
  for (const cta of ["cta: 'See the destinations', page: 'egress', mood: 'alert', urgent: true",
                     "cta: 'See what changed', page: 'guide-connect-agents', mood: 'alert', urgent: true",
                     "tab: 'optimizer', mood: 'concerned', urgent: true",
                     "tab: 'overview', mood: 'concerned', urgent: true",
                     "text, mood: 'concerned', urgent: true,"]) {
    assert.ok(src.includes(cta), `urgent: ${cta}`);
  }
  // a brief with an in-page action survives into Notes and runs it
  GA._hideBubble();
  assert.equal(GA._speak({ text: 'Looking at traces.', cta: 'Show me the costliest trace', act: 'costliest-trace' }), true);
  const rows = [];
  GA._row = (o) => { rows.push(o); return fakeEl(); };
  GA._findingsSection(fakeEl());
  assert.equal(rows[0].act, 'costliest-trace');
  assert.match(src, /if \(act\) \{ this\._act\(act\); return; \} \/\/ a note that answers on this page/);
  // the saved count shows as soon as the button exists
  assert.match(src, /this\._fab = fab;\n\s+this\._badgeRender\(\);/);
});

test('after a summary button toggles, focus returns to the same button', () => {
  const { P, RL, box } = pageHarness();
  const shown = [{ trace_id: 'a', started_at: at(30), ended_at: at(28), waiting: 1 }];
  P._ctx = RL.buildCtx(shown, { now: NOW });
  P._renderSummary(shown);
  let focused = null;
  box.querySelector = (sel) => ({ focus: () => { focused = sel; } });
  click(box, 'waiting');
  assert.equal(focused, '[data-sum="waiting"]');
});
