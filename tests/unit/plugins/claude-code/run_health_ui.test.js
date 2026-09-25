/** Run health in the UI: the findings strip and step markers
 * (window.TraceSteps), the Traces page badges, filters, strip buttons and
 * exports, the Agent Sessions card badges and stuck line, the Health view,
 * the dashboard Needs attention card, and the Observability nav labels. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

const T0 = Date.parse('2026-09-20T10:00:00Z');
const at = (ms) => new Date(T0 + ms).toISOString();
const gen = (id, ms, dur, extra = {}) => Object.assign({ span_kind: 'generation', span_id: id, called_at: at(ms), duration_ms: dur }, extra);
const call = (name, ms, extra = {}) => Object.assign({ span_kind: 'tool_call', function_name: name, tool_id: name, action: 'allow', called_at: at(ms) }, extra);

function loadTS() {
  const sandbox = { window: {} };
  vm.runInNewContext(read('js/components/trace-steps.js'), sandbox);
  return sandbox.window.TraceSteps;
}

function finding(extra = {}) {
  return Object.assign({
    id: 'same_call-1', category: 'loop', kind: 'same_call', severity: 'warn',
    title: 'Looping on Bash, same arguments 3 times',
    why: 'The agent repeated an identical call.', action: 'Stop the repeat.',
    nudge: 'You have run Bash 3 times with the same arguments.',
    step_refs: ['b3'], evidence: { counts: { calls: 3 }, tool: 'Bash', est_tokens: null, est_usd: null },
  }, extra);
}

function traceWithSteps(n) {
  const spans = [];
  for (let i = 0; i < n; i++) {
    spans.push(gen(`g${i}`, i * 1000, 100));
    spans.push(call('Bash', i * 1000 + 200, { span_id: `b${i}` }));
  }
  spans.forEach((s, i) => { s.turn_index = i; s._seq = i; });
  return { trace_id: 'tr-1', runtime_kind: 'claude-code', spans, started_at: at(0), ended_at: at(n * 1000) };
}

// ---------------- TraceSteps: strip, collapse, markers, focus ----------------

test('strip: title, why · action, Jump to step N, Copy nudge only with a nudge', () => {
  const TS = loadTS();
  const d = traceWithSteps(5);
  const health = { findings: [finding(), finding({ id: 'err-1', category: 'failing', kind: 'error_streak', title: '3 tool calls failed in a row', nudge: null, step_refs: [4] })] };
  const html = TS.html('tr-1', d, { prefix: 'trace-steps', health });
  assert.match(html, /class="trace-steps-findings"/);
  assert.match(html, /Looping on Bash, same arguments 3 times/);
  assert.match(html, /The agent repeated an identical call\. · Stop the repeat\./);
  assert.match(html, /data-step="4"[^>]*>Jump to step 4</);
  // turn_index 4 is the generation of the third step.
  assert.match(html, /data-step="3"[^>]*>Jump to step 3</);
  assert.strictEqual((html.match(/>Copy nudge</g) || []).length, 1);
  // The strip sits above the steps.
  assert.ok(html.indexOf('trace-steps-findings') < html.indexOf('trace-steps-list'));
});

test('strip: more than two findings collapse to one line with a toggle', () => {
  const TS = loadTS();
  const d = traceWithSteps(4);
  const f = [finding({ id: 'a' }), finding({ id: 'b', category: 'failing' }), finding({ id: 'c', category: 'wasteful' })];
  const shut = TS.html('t', d, { prefix: 'trace-steps', health: { findings: f } });
  assert.match(shut, /3 health findings: 1 loop, 1 failing, 1 wasteful/);
  assert.match(shut, /class="trace-steps-findings-toggle"[^>]*aria-expanded="false"[^>]*>Show</);
  assert.ok(!shut.includes('trace-steps-findings-list'));
  const open = TS.html('t', d, { prefix: 'trace-steps', health: { findings: f }, findingsOpen: true });
  assert.match(open, /aria-expanded="true"[^>]*>Hide</);
  assert.strictEqual((open.match(/class="trace-steps-finding trace-steps-finding-/g) || []).length, 3);
  const two = TS.html('t', d, { prefix: 'trace-steps', health: { findings: f.slice(0, 2) } });
  assert.ok(!two.includes('findings-toggle'), 'two findings show in full');
});

test('strip leaves blocked out; no findings, no strip', () => {
  const TS = loadTS();
  const d = traceWithSteps(2);
  const html = TS.html('t', d, { health: { findings: [finding({ category: 'blocked', kind: 'blocked', title: '1 call blocked by policy' })] } });
  assert.ok(!html.includes('findings'));
  assert.ok(!TS.html('t', d, { health: { findings: [] } }).includes('findings'));
  assert.ok(!TS.html('t', d, {}).includes('findings'));
});

test('markers: the steps a finding names get the loop or failing SVG icon, others none', () => {
  const TS = loadTS();
  const d = traceWithSteps(4);
  const health = { findings: [finding({ step_refs: ['b0', 'b2'] }), finding({ id: 'f', category: 'failing', step_refs: ['g3'] })] };
  const html = TS.html('t', d, { prefix: 'trace-steps', health });
  assert.strictEqual((html.match(/trace-steps-mark trace-steps-mark-loop/g) || []).length, 2);
  assert.strictEqual((html.match(/trace-steps-mark trace-steps-mark-failing/g) || []).length, 1);
  assert.match(html, /data-step="1">\s*<div class="trace-steps-line">\s*<span class="trace-steps-num">1<\/span><span class="trace-steps-mark trace-steps-mark-loop"[^>]*><svg class="sv-health-icon sv-health-icon-loop"/);
  assert.match(html, /trace-steps-mark-failing"[^>]*><svg class="sv-health-icon sv-health-icon-failing"/);
  assert.ok(!/[⟳]/.test(html), 'no text glyph that renders as a dot');
});

test('focusStep shows a step past stepsMax and marks it', () => {
  const TS = loadTS();
  const d = traceWithSteps(10);
  const plain = TS.html('t', d, { stepsMax: 3 });
  assert.ok(!plain.includes('data-step="8"'));
  const focused = TS.html('t', d, { stepsMax: 3, focusStep: 8 });
  assert.match(focused, /class="terminals-steps-row terminals-steps-row-focus" data-step="8"/);
});

test('escaping: server strings in text and attributes', () => {
  const TS = loadTS();
  const d = traceWithSteps(2);
  const html = TS.html('t"<', d, { health: { findings: [finding({ id: 'x"><img>', title: '<img src=x onerror=1>', why: '"quoted"', action: "it's" })] } });
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;img src=x onerror=1&gt;/);
  assert.match(html, /data-finding-id="x&quot;&gt;&lt;img&gt;"/);
  assert.match(html, /data-trace-id="t&quot;&lt;"/);
  assert.match(html, /&quot;quoted&quot; · it&#39;s/);
});

test('badges: neutral loop and wasteful, failing may be amber; none for zero', () => {
  const TS = loadTS();
  const html = TS.badgesHtml({ loop: 2, failing: 1, wasteful: 0 });
  assert.match(html, /sv-health-badge sv-health-badge-loop[^>]*><svg[^>]*sv-health-icon-loop[\s\S]*?<\/svg><span class="sv-health-badge-text">Loop<\/span>/);
  assert.match(html, /sv-health-badge sv-health-badge-failing[^>]*><svg[\s\S]*?<\/svg><span class="sv-health-badge-text">Failing<\/span>/);
  assert.ok(!html.includes('Wasteful'));
  assert.strictEqual(TS.badgesHtml(null), '');
  const css = read('css/styles.css');
  const loop = css.match(/\.sv-health-badge \{[^}]*\}/)[0];
  assert.ok(!/ef4444|f59e0b|10b981|2dd4bf/i.test(loop), 'the base badge is neutral');
  assert.match(css, /\.sv-health-badge-failing \{[^}]*#fcd34d/);
});

// ---------------- Traces page ----------------

function fakeButtons(html) {
  const out = [];
  const re = /<button([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = {};
    m[1].replace(/([a-z-]+)="([^"]*)"/g, (_, k, v) => { attrs[k] = v.replace(/&quot;/g, '"').replace(/&amp;/g, '&'); });
    const dataset = {};
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    const handlers = [];
    const btn = {
      classes: (attrs.class || '').split(/\s+/), dataset, textContent: '',
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      addEventListener: (ev, fn) => { if (ev === 'click') handlers.push(fn); },
      click() { handlers.forEach(fn => fn()); },
    };
    out.push(btn);
  }
  return out;
}

function makeBox() {
  return {
    innerHTML: '', _buttons: [], contains: () => false,
    querySelector: () => null,
    querySelectorAll(sel) {
      if (this._painted !== this.innerHTML) { this._buttons = fakeButtons(this.innerHTML); this._painted = this.innerHTML; }
      const want = sel.match(/button\.([a-z-]+)(?::not\(\.([a-z-]+)\))?/);
      if (!want) return [];
      return this._buttons.filter(b => b.classes.includes(want[1]) && !(want[2] && b.classes.includes(want[2])));
    },
  };
}

function loadRuns(api = {}) {
  const els = { 'ar-steps': makeBox() };
  const captured = { downloads: [], prints: [], copied: [] };
  const window = {};
  const sandbox = {
    window, console, API: api,
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { clipboard: { writeText: (t) => { captured.copied.push(t); return Promise.resolve(); } } },
    document: { activeElement: null, getElementById: (id) => els[id] || null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
  };
  vm.runInNewContext(read('js/components/obs-tabs.js'), sandbox);
  vm.runInNewContext(read('js/components/trace-steps.js'), sandbox);
  sandbox.ObsTabs = window.ObsTabs;
  sandbox.TraceSteps = window.TraceSteps;
  window.ObsTabs.download = (name, content) => captured.downloads.push({ name, content });
  window.ObsTabs.printDoc = (title, html) => captured.prints.push({ title, html });
  vm.runInNewContext(read('js/pages/agent-runs.js'), sandbox);
  return { P: window.AgentRunsPage, els, captured };
}

test('Traces: Loop, Failing and Wasteful views match runs by their health counts', () => {
  const { P } = loadRuns();
  const r = { health: { loop: 1, failing: 0, wasteful: 2 } };
  assert.strictEqual(P._viewMatch(r, 'loop'), true);
  assert.strictEqual(P._viewMatch(r, 'failing'), false);
  assert.strictEqual(P._viewMatch(r, 'wasteful'), true);
  assert.strictEqual(P._viewMatch({}, 'loop'), false);
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /\['loop', 'Loop'/);
  assert.match(src, /\['failing', 'Failing'/);
  assert.match(src, /\['wasteful', 'Wasteful'/);
  assert.match(src, /TraceSteps\.healthIcon\(key\)/);
  // The badges follow the agent label in their own shrinkable box.
  assert.match(src, /<span class="ar-row-health">\$\{TraceSteps\.badgesHtml\(r\.health\)\}<\/span>/);
  assert.match(src, /\.ar-row-name \.ar-run-rt \{ flex:0 1 auto; min-width:52px; \}/);
  assert.match(src, /\.ar-row-health \{[^}]*min-width:0; overflow:hidden;/);
  assert.match(src, /\.ar-layout\.split \.ar-row-health \.sv-health-badge-text \{ display:none; \}/);
  const label = src.indexOf('<span class="ar-run-rt">');
  const badges = src.indexOf('<span class="ar-row-health">');
  assert.ok(label > 0 && badges > label, 'badges come after the label');
});

test('Traces: strip renders from the cached health; jump, toggle and copy work', async () => {
  const { P, els, captured } = loadRuns();
  const trace = traceWithSteps(30);
  P.selected = 'tr-1';
  P._trace = trace;
  const many = [finding({ step_refs: ['b25'] }), finding({ id: 'b', category: 'failing', nudge: null }), finding({ id: 'c', category: 'wasteful', nudge: null })];
  P._health = { 'tr-1': { key: 'k', data: { findings: many } } };
  P._renderSteps(trace);
  const box = els['ar-steps'];
  assert.match(box.innerHTML, /3 health findings/);
  box.querySelectorAll('button.trace-steps-findings-toggle')[0].click();
  assert.strictEqual(P._healthOpen, 'tr-1');
  assert.match(box.innerHTML, /Jump to step 26/);
  assert.ok(!box.innerHTML.includes('data-step="26">'), 'step 26 is past the 20 shown');
  box.querySelectorAll('button.trace-steps-finding-jump')[0].click();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(P._stepsFocus)), { traceId: 'tr-1', step: 26 });
  assert.match(box.innerHTML, /trace-steps-row-focus" data-step="26"/);
  box.querySelectorAll('button.trace-steps-finding-copy')[0].click();
  await Promise.resolve();
  assert.deepStrictEqual(captured.copied, ['You have run Bash 3 times with the same arguments.']);
});

test('Traces: health is fetched once per opened run and again only when it grows', async () => {
  const urls = [];
  const { P } = loadRuns({ request: async (u) => { urls.push(u); return { findings: [] }; } });
  const t = { trace_id: 'tr-1', ended_at: 'a', span_count: 3 };
  P._loadHealth(t);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  P._loadHealth(t);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepStrictEqual(urls, ['/api/traces/tr-1/health']);
  P._loadHealth(Object.assign({}, t, { ended_at: 'b', span_count: 4 }));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.strictEqual(urls.length, 2);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(P._healthFor('tr-1'))), { findings: [] });
});

test('Traces exports: a Findings section in the PDF and a findings column on the first CSV row', () => {
  const { P, captured } = loadRuns();
  const t = traceWithSteps(2);
  P._trace = t;
  P._health = { 'tr-1': { data: { findings: [finding({ title: 'Loop <b>' })] } } };
  P._exportPDF();
  const html = captured.prints[0].html;
  assert.ok(html.indexOf('<h2>Findings</h2>') > 0 && html.indexOf('<h2>Findings</h2>') < html.indexOf('<h2>Steps</h2>'));
  assert.match(html, /<td>loop<\/td><td>warn<\/td><td>Loop &lt;b&gt;<\/td>/);
  P._exportCSV();
  const [head, first, second] = captured.downloads[0].content.trim().split('\n');
  assert.match(head, /,findings$/);
  assert.match(first, /\[loop\] Loop <b>$/);
  assert.match(second, /,$/);
});

// ---------------- Agent Sessions ----------------

function loadTerminals() {
  const window = {};
  const sandbox = { window, API: {}, URLSearchParams, document: { getElementById: () => null }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  vm.runInNewContext(read('js/components/trace-steps.js'), sandbox);
  vm.runInNewContext(read('js/pages/terminals.js'), sandbox);
  return window.TerminalsPage;
}

test('Agent Sessions: stuck after 2 min of no activity while working', () => {
  const P = loadTerminals();
  const now = Date.parse('2026-09-24T10:10:00Z');
  assert.strictEqual(P._stuckMinutes({ status: 'working', last_activity_at: '2026-09-24 10:05:00' }, now), 5);
  assert.strictEqual(P._stuckMinutes({ status: 'working', last_activity_at: '2026-09-24T10:09:00Z' }, now), null);
  assert.strictEqual(P._stuckMinutes({ status: 'idle', last_activity_at: '2026-09-24 10:00:00' }, now), null);
  // A fresh transcript write is activity too.
  assert.strictEqual(P._stuckMinutes({ status: 'working', last_activity_at: '2026-09-24 10:00:00', transcript_age_seconds: 30 }, now), null);
  const src = read('js/pages/terminals.js');
  assert.match(src, /no activity for \$\{this\._esc\(String\(stuckMin\)\)\} min/);
  assert.match(src, /stuckMin != null \? `no activity for \$\{stuckMin\} min` : null/);
});

test('Agent Sessions: task badges on every card whose run has findings, past tense once finished', () => {
  const P = loadTerminals();
  P._healthBySession = { s1: { loop: 1, failing: 2, wasteful: 3 } };
  const html = P._taskHealthHtml({ session_id: 's1', status: 'working' });
  assert.match(html, /badge-text">looping</);
  assert.match(html, /badge-text">failing</);
  assert.ok(!html.includes('Wasteful'));
  const done = P._taskHealthHtml({ session_id: 's1', status: 'done' });
  assert.match(done, /badge-text">looped</);
  assert.match(done, /badge-text">failed repeatedly</);
  assert.match(P._taskHealthHtml({ session_id: 's1', status: 'interrupted' }), /looped/);
  assert.strictEqual(P._taskHealthHtml({ session_id: 'nope', status: 'working' }), '');
});

test('Agent Sessions: card health is read even when every task has finished', async () => {
  const P = loadTerminals();
  let fetched = 0;
  P._fetchTraceRuns = async () => { fetched++; return { runs: [{ session_id: 's1', ended_at: 'x', health: { loop: 1 } }] }; };
  P._tasks = [{ session_id: 's1', status: 'done' }];
  P._healthAt = 0;
  await P._maybeLoadTaskHealth();
  assert.strictEqual(fetched, 1);
  assert.strictEqual(P._healthBySession.s1.loop, 1);
});

test('Agent Sessions: the rail steps carry health and refresh with the 12 s cadence', () => {
  const P = loadTerminals();
  const d = traceWithSteps(3);
  P._stepsCache = { 'tr-1': { data: d, health: { findings: [finding({ step_refs: ['b1'] })] }, at: Date.now() } };
  P._stepsDetail = {};
  const html = P._stepsPanelHtml('tr-1');
  assert.match(html, /terminals-steps-findings/);
  assert.match(html, /Jump to step/);
  const src = read('js/pages/terminals.js');
  assert.match(src, /API\.request\(`\/api\/traces\/\$\{encodeURIComponent\(traceId\)\}\/health`\)/);
  assert.strictEqual(P.HEALTH_POLL_MS, 12000);
});

// ---------------- Health view ----------------

function loadHealthPage() {
  // window is the global here, as in the browser.
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.runInNewContext(read('js/components/trace-steps.js'), sandbox);
  vm.runInNewContext(read('js/pages/run-health.js'), sandbox);
  return { H: sandbox.RunHealthPage, window: sandbox };
}

test('Health view: counts at the top, grouped rows, Open run, escaping', () => {
  const { H } = loadHealthPage();
  const html = H.html({ partial_runs: 0, findings: [
    finding({ trace_id: 'tr"1', session_id: 'abcdef123456', runtime_kind: 'claude-code', ended_at: '2026-09-24 10:00:00', title: '<script>x</script>' }),
    finding({ id: 'f2', category: 'failing', trace_id: 't2', runtime_kind: 'codex' }),
    finding({ id: 'b', category: 'blocked', title: 'blocked row' }),
  ] });
  assert.match(html, /sv-health-icon-loop[\s\S]*?<\/svg> Loop 1<\/span>/);
  assert.match(html, /sv-health-icon-failing[\s\S]*?<\/svg> Failing 1<\/span>/);
  assert.match(html, /sv-health-icon-wasteful[\s\S]*?<\/svg> Wasteful 0<\/span>/);
  assert.match(html, /Loop \(1\)[\s\S]*Failing \(1\)/);
  assert.match(html, /data-trace-id="tr&quot;1"[^>]*>Open run</);
  assert.match(html, /Run abcdef12 · claude-code/);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('blocked row'));
});

test('Health view: empty state says what it watches for; Open run sets the deep link', () => {
  const { H, window } = loadHealthPage();
  const html = H.html({ findings: [], partial_runs: 3 });
  assert.match(html, /No health findings in this window\./);
  assert.match(html, /same call repeated/);
  assert.match(html, /3 runs were checked from tool calls only/);
  window.AgentRunsPage = {};
  let went = null;
  window.Sidebar = { navigate: (p) => { went = p; } };
  H.openRun('tr-9');
  assert.strictEqual(window.AgentRunsPage._pendingTrace, 'tr-9');
  assert.strictEqual(window.AgentRunsPage._pendingHealthOpen, true);
  assert.strictEqual(went, 'agent-runs');
  assert.ok(H.html(null).includes('unavailable'));
});

// ---------------- Dashboard ----------------

test('Dashboard: Needs attention lists the top 5 by severity, escaped, linked to the run', () => {
  const window = {};
  const sandbox = { window, console, document: { getElementById: () => null } };
  vm.runInNewContext(read('js/components/trace-steps.js'), sandbox);
  sandbox.TraceSteps = window.TraceSteps;
  const src = read('js/pages/dashboard.js');
  vm.runInNewContext(src + '\nwindow.DashboardPage = DashboardPage;', sandbox);
  const D = window.DashboardPage;
  const fs_ = [
    finding({ id: '1', severity: 'info', ended_at: '2026-09-24 10:00:00' }),
    finding({ id: '2', severity: 'high', ended_at: '2026-09-24 09:00:00', title: '<b>high</b>' }),
    finding({ id: '3', severity: 'warn', ended_at: '2026-09-24 10:30:00' }),
    finding({ id: '4', severity: 'warn', ended_at: '2026-09-24 11:00:00' }),
    finding({ id: '5', category: 'blocked', severity: 'high' }),
    finding({ id: '6', severity: 'info' }), finding({ id: '7', severity: 'info' }),
  ];
  const top = D._needsAttentionItems({ findings: fs_ });
  assert.deepStrictEqual(top.map(f => f.id), ['2', '4', '3', '1', '6']);
  const html = D._needsAttentionHtml({ findings: fs_.map(f => Object.assign({ trace_id: 't"x' }, f)) });
  assert.match(html, /Needs attention/);
  assert.match(html, /&lt;b&gt;high&lt;\/b&gt;/);
  assert.match(html, /data-trace-id="t&quot;x"[^>]*>Open run</);
  assert.match(D._needsAttentionHtml({ findings: [] }), /No loops, failing steps or waste/);
  assert.match(src, /this\._renderNeedsAttentionCard\(container\);\s*\n\s*this\._renderOptimizerTile\(container\);/);
  assert.match(src, /API\.getRunHealth\(\{ window_days: 1, limit: 200 \}\)/);
});

// ---------------- Nav labels and routing ----------------

test('nav: Observability has no sub-views; Health and Map stay aliases so the row stays lit', () => {
  const sb = read('js/components/sidebar.js');
  assert.match(sb, /id: 'agent-runs', label: 'Observability', icon: 'history', aliases: \['run-health', 'agent-activity', 'storylines', 'agent-map', 'agent-timeline', 'replay'\]/);
  const views = sb.slice(sb.indexOf("label: 'Observability'"), sb.indexOf("id: 'threats'"));
  assert.doesNotMatch(views, /views:/);
  const labels = [...views.matchAll(/\{ id: '([a-z-]+)', label: '([^']+)'/g)].map(m => `${m[1]}:${m[2]}`);
  assert.deepStrictEqual(labels, []);
  assert.match(read('js/components/obs-tabs.js'), /page: 'run-health'/);
  const pal = read('js/components/command-palette.js');
  assert.match(pal, /'Observability: trace \+ run waterfall'/);
  assert.match(pal, /'Observability: Health findings'/);
  assert.ok(!/push\('[a-z-]+', 'Traces:/.test(pal));
  assert.match(read('js/components/obs-tabs.js'), /\{ label: 'Runs', page: 'agent-runs'/);
  assert.match(read('js/app.js'), /'run-health': RunHealthPage/);
  const html = read('index.html');
  assert.ok(html.indexOf('pages/run-health.js') > 0 && html.indexOf('pages/run-health.js') < html.indexOf('js/app.js?'));
  assert.match(read('js/pages/agent-runs.js'), /Header\.setPageInfo\('Observability'/);
});

test('no em dashes in the run health UI copy', () => {
  for (const f of ['js/pages/run-health.js']) assert.ok(!read(f).includes('—'), f);
  const ts = read('js/components/trace-steps.js');
  const part = ts.slice(ts.indexOf('// --- run health'), ts.indexOf("/** A run's step list as HTML."));
  assert.ok(part.length > 100 && !part.includes('—'));
  const dash = read('js/pages/dashboard.js');
  const card = dash.slice(dash.indexOf('_needsAttentionItems('), dash.indexOf('_renderOptimizerTile(container) {'));
  assert.ok(card.length > 100 && !card.includes('—'));
  const TS = loadTS();
  const html = TS.html('t', traceWithSteps(4), { health: { findings: [finding({ id: 'a' }), finding({ id: 'b' }), finding({ id: 'c' })] } });
  assert.ok(!html.includes('—'));
});

// ---------------- review fixes ----------------

test('ObsTabs: Runs | Health | Map, and the Health view renders the tabs', () => {
  const src = read('js/components/obs-tabs.js');
  const tabs = [...src.slice(src.indexOf('_TABS: ['), src.indexOf('],', src.indexOf('_TABS: ['))).matchAll(/label: '([^']+)',\s*page: '([a-z-]+)'/g)].map(m => `${m[1]}:${m[2]}`);
  assert.deepStrictEqual(tabs, ['Runs:agent-runs', 'Health:run-health', 'Map:agent-map']);
  assert.match(src, /health: 'run-health'/);
  assert.match(read('js/pages/run-health.js'), /ObsTabs\.render\(header, 'health'\)/);
});

test('Agent Sessions: card health reuses the rail runs read when fresh, else one shared read', async () => {
  const P = loadTerminals();
  let fetched = 0;
  P._fetchTraceRuns = async () => { fetched++; return { runs: [{ session_id: 's1', ended_at: '2026-09-24 10:00:00', health: { loop: 1 } }] }; };
  P._tasks = [{ session_id: 's1', status: 'working' }];
  P._allRunsCache = { at: Date.now(), runs: [{ session_id: 's1', ended_at: '2026-09-24 10:00:00', health: { failing: 2 } }] };
  P._healthAt = 0;
  await P._maybeLoadTaskHealth();
  assert.strictEqual(fetched, 0);
  assert.strictEqual(P._healthBySession.s1.failing, 2);
  P._allRunsCache = { at: Date.now() - 60000, runs: [] };
  P._healthAt = 0;
  await P._maybeLoadTaskHealth();
  assert.strictEqual(fetched, 1);
  assert.strictEqual(P._healthBySession.s1.loop, 1);
  assert.strictEqual(P._allRunsCache.runs.length, 1, 'the read is shared back');
});

test('runs list callers that do not show health ask for health=0', () => {
  assert.match(read('js/api.js'), /if \(params\.health != null\) q\.set\('health', params\.health\);/);
  for (const f of ['js/pages/instant-audit.js', 'js/pages/storylines.js', 'js/pages/governance.js']) {
    assert.match(read(f), /API\.getTraces\(\{[^}]*health: 0 \}\)/, f);
  }
});


// ---------------- failed calls ----------------

test('failed calls: their own chip state, neutral, never merged with allowed', () => {
  const TS = loadTS();
  const spans = [gen('g1', 0, 100, { tool_results: [
    { name: 'Bash', is_error: false }, { name: 'Bash', is_error: true, preview: 'Traceback (most recent call last):\n  boom' },
    { name: 'Bash', is_error: true }] }),
  call('Bash', 200, { span_id: 'b1' }), call('Bash', 300, { span_id: 'b2' }), call('Bash', 400, { span_id: 'b3' }),
  call('Read', 500, { span_id: 'r1', reason: 'tool error' })];
  const steps = TS.build(spans);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(steps[0].tools.map(t => TS.chipState(t)))), ['allowed', 'failed', 'failed', 'failed']);
  const html = TS.html('t', { spans }, { prefix: 'trace-steps', detailKey: 's:b2' });
  assert.match(html, /trace-steps-chip-allowed[^>]*>✓ Bash</);
  assert.match(html, /trace-steps-chip-failed[^>]*aria-label="Bash, failed, 2 calls">✗ Bash ×2 · failed</);
  assert.match(html, /trace-steps-chip-failed[^>]*>✗ Read · failed</);
  assert.match(html, /trace-steps-detail-failed[\s\S]*Failed: Traceback \(most recent call last\):/);
  // Text not stored: the detail says only "Failed".
  const plainSpans = JSON.parse(JSON.stringify(spans));
  delete plainSpans[0].tool_results[1].preview;
  const plainHtml = TS.html('t', { spans: plainSpans }, { prefix: 'trace-steps', detailKey: 's:b2' });
  assert.match(plainHtml, /trace-steps-detail-text">Failed<\/span>/);
  const css = read('css/styles.css');
  const rule = css.match(/\.terminals-steps-chip-failed, \.trace-steps-chip-failed \{[^}]*\}/)[0];
  assert.match(rule, /dashed/);
  assert.ok(!/ef4444|f59e0b|fca5a5|fcd34d/i.test(rule), 'failed is neither red nor amber');
});

test('failed calls in exports: state failed and "(failed)" in the step tools', () => {
  const TS = loadTS();
  const spans = [gen('g1', 0, 100, { tool_results: [{ name: 'Bash', is_error: true }, { name: 'Bash', is_error: true }] }),
    call('Bash', 200, { span_id: 'b1' }), call('Bash', 300, { span_id: 'b2' })];
  const rec = TS.records({ spans });
  assert.strictEqual(rec.steps[0].tools[0].state, 'failed');
  assert.strictEqual(TS.toolsText(rec.steps[0].tools, rec.steps[0].unchecked), 'Bash ×2 (failed)');
});

test('Health view asks for one on-demand warm-up when runs are partial', () => {
  const src = read('js/pages/run-health.js');
  assert.match(src, /Number\(this\.data\.partial_runs\) > 0 && !this\._warmed/);
  assert.match(src, /API\.getRunHealth\(\{ window_days: this\.windowDays, limit: 200, warm: true \}\)/);
  assert.match(read('js/api.js'), /if \(params\.warm\) q\.set\('warm', 'true'\);/);
});
