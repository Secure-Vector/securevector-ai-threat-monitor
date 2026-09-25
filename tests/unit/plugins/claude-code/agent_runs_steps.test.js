/** Traces page: a run opens on its step list (window.TraceSteps), with the
 * full timeline behind "Show full timeline", and the trace exports carry the
 * same step view. agent-runs.js is loaded in a vm sandbox with a tiny DOM. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

/** Buttons parsed back out of an innerHTML string, enough to click them. */
function fakeButtons(html) {
  const out = [];
  const re = /<button([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = {};
    m[1].replace(/([a-z-]+)="([^"]*)"/g, (_, k, v) => { attrs[k] = v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&'); });
    const dataset = {};
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    const handlers = [];
    out.push({
      classes: (attrs.class || '').split(/\s+/), dataset,
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      addEventListener: (ev, fn) => { if (ev === 'click') handlers.push(fn); },
      click() { handlers.forEach(fn => fn()); },
    });
  }
  return out;
}

function makeBox() {
  const box = {
    innerHTML: '',
    _buttons: [],
    contains: () => false,
    querySelectorAll(sel) {
      this._buttons = this._buttons.length && this._painted === this.innerHTML ? this._buttons : fakeButtons(this.innerHTML);
      this._painted = this.innerHTML;
      const want = sel.match(/button\.([a-z-]+)(?::not\(\.([a-z-]+)\))?/);
      if (!want) return [];
      return this._buttons.filter(b => b.classes.includes(want[1]) && !(want[2] && b.classes.includes(want[2])));
    },
  };
  return box;
}

function loadPage({ storage = {}, throwStorage = false } = {}) {
  const els = {};
  const toggle = { attrs: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = v; } };
  const captured = { downloads: [], prints: [] };
  const localStorage = {
    getItem: (k) => { if (throwStorage) throw new Error('blocked'); return k in storage ? storage[k] : null; },
    setItem: (k, v) => { if (throwStorage) throw new Error('blocked'); storage[k] = String(v); },
  };
  const window = {};
  const sandbox = {
    window, console, localStorage,
    document: {
      activeElement: null,
      getElementById: (id) => els[id] || null,
      querySelector: (sel) => (sel === '#ar-detail .ar-timeline-toggle' ? toggle : null),
      querySelectorAll: () => [],
      addEventListener() {},
    },
  };
  vm.runInNewContext(read('js/components/obs-tabs.js'), sandbox);
  vm.runInNewContext(read('js/components/trace-steps.js'), sandbox);
  sandbox.ObsTabs = window.ObsTabs;
  sandbox.TraceSteps = window.TraceSteps;
  window.ObsTabs.download = (name, content) => captured.downloads.push({ name, content });
  window.ObsTabs.printDoc = (title, html) => captured.prints.push({ title, html });
  vm.runInNewContext(read('js/pages/agent-runs.js'), sandbox);
  return { P: window.AgentRunsPage, els, toggle, storage, captured };
}

const T0 = Date.parse('2026-09-20T10:00:00Z');
const at = (ms) => new Date(T0 + ms).toISOString();
const gen = (id, ms, dur, extra = {}) => Object.assign({ span_kind: 'generation', span_id: id, called_at: at(ms), duration_ms: dur }, extra);
const call = (name, ms, extra = {}) => Object.assign({ span_kind: 'tool_call', function_name: name, tool_id: name, action: 'allow', called_at: at(ms) }, extra);

function sampleTrace() {
  const spans = [
    gen('g1', 0, 1000), call('bash', 1500, { span_id: 'b1' }), call('bash', 1600, { span_id: 'b2' }),
    call('WebFetch', 1700, { span_id: 'w1', action: 'block', reason: 'Host <not> allowed', detection_rules: ['egress.deny'], args_preview: 'SECRET-ARG' }),
    gen('g2', 4000, 500, { turn_start: 'tool_result' }), call('Read', 4600, { span_id: 'r1', action: 'log_only' }),
  ];
  spans.forEach((s, i) => { s._seq = i; });
  return { trace_id: 'tr-1', runtime_kind: 'claude-code', spans, blocked: 1, started_at: at(0), ended_at: at(4600), generation_total_cost: 0 };
}

test('full timeline: collapsed by default, remembered in sv-ar-timeline, storage errors fall back to collapsed', () => {
  const a = loadPage();
  assert.strictEqual(a.P._timelineIsOpen('x'), false);
  const b = loadPage({ storage: { 'sv-ar-timeline': 'open' } });
  assert.strictEqual(b.P._timelineIsOpen('x'), true);
  const c = loadPage({ throwStorage: true });
  assert.strictEqual(c.P._timelineIsOpen('x'), false);
  assert.doesNotThrow(() => c.P._setTimeline(true, { persist: true }));
});

test('toggle: aria-expanded, label, hidden, and the choice is saved', () => {
  const { P, els, toggle, storage } = loadPage();
  els['ar-timeline'] = { hidden: true };
  P._trace = { trace_id: 'tr-1' };
  P._setTimeline(true, { persist: true });
  assert.strictEqual(els['ar-timeline'].hidden, false);
  assert.strictEqual(toggle.attrs['aria-expanded'], 'true');
  assert.strictEqual(toggle.textContent, 'Hide full timeline ▴');
  assert.strictEqual(storage['sv-ar-timeline'], 'open');
  P._setTimeline(false, { persist: true });
  assert.strictEqual(els['ar-timeline'].hidden, true);
  assert.strictEqual(toggle.attrs['aria-expanded'], 'false');
  assert.strictEqual(toggle.textContent, 'Show full timeline ▾');
  assert.strictEqual(storage['sv-ar-timeline'], 'closed');
});

test('a deep link opens the full timeline for that trace without changing the saved choice', () => {
  const { P, storage } = loadPage({ storage: { 'sv-ar-timeline': 'closed' } });
  P._timelineForce = 'tr-1';
  assert.strictEqual(P._timelineIsOpen('tr-1'), true);
  assert.strictEqual(P._timelineIsOpen('tr-2'), false);
  assert.strictEqual(storage['sv-ar-timeline'], 'closed');
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /this\._timelineForce = wantTrace;\s*this\.selectRun\(wantTrace\);/);
});

test('step list: trace-steps markup from the fetched trace, 20 step cap, no See full run', () => {
  const { P, els } = loadPage();
  els['ar-steps'] = makeBox();
  const trace = sampleTrace();
  P._renderSteps(trace);
  const html = els['ar-steps'].innerHTML;
  assert.match(html, /class="trace-steps-summary">Took 5 s · 2 steps · 1 blocked</);
  assert.match(html, />✓ bash ×2</);
  assert.match(html, /Claude thinking/);
  assert.ok(!html.includes('terminals-steps'));
  assert.ok(!html.includes('See full run'));
  // The first blocked call's detail is open by default, reason escaped.
  assert.match(html, /Blocked: Host &lt;not&gt; allowed/);
  assert.match(html, /class="trace-steps-jump"[^>]*>View in timeline</);
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /stepsMax: 20,/);
  assert.match(src, /chipsMax: 8,/);
});

test('clicking a chip shows its detail; clicking it again shuts it', () => {
  const { P, els } = loadPage();
  els['ar-steps'] = makeBox();
  const trace = sampleTrace();
  P._renderSteps(trace);
  const read1 = els['ar-steps'].querySelectorAll('button.trace-steps-chip:not(.trace-steps-more)').find(b => b.dataset.stepKey === 's:r1');
  read1.click();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(P._stepsDetail)), { traceId: 'tr-1', key: 's:r1' });
  assert.match(els['ar-steps'].innerHTML, /trace-steps-detail-flagged/);
  const again = els['ar-steps'].querySelectorAll('button.trace-steps-chip:not(.trace-steps-more)').find(b => b.dataset.stepKey === 's:r1');
  again.click();
  assert.ok(!els['ar-steps'].innerHTML.includes('trace-steps-detail'), 'shut by hand stays shut');
});

test('View in timeline expands the timeline and jumps to that span', () => {
  const { P, els } = loadPage();
  els['ar-steps'] = makeBox();
  els['ar-timeline'] = { hidden: true };
  const trace = sampleTrace();
  P._trace = trace;
  const jumps = [];
  P._jumpToSpan = (seq) => jumps.push(seq);
  P._renderSteps(trace);
  const jump = els['ar-steps'].querySelectorAll('button.trace-steps-jump')[0];
  jump.click();
  assert.strictEqual(els['ar-timeline'].hidden, false);
  assert.deepStrictEqual(jumps, [3], 'the blocked WebFetch span');
  assert.strictEqual(P._timelineForce, 'tr-1', 'opened for this trace, not saved');
});

test('renderWaterfall puts the step list first and the unchanged waterfall behind the toggle', () => {
  const src = read('js/pages/agent-runs.js');
  const start = src.indexOf('    renderWaterfall(trace) {');
  const end = src.indexOf('    _timelineIsOpen(traceId) {');
  const body = src.slice(start, end);
  const i = (s) => body.indexOf(s);
  assert.ok(i("stepsBox.id = 'ar-steps'") > 0);
  assert.ok(i("tBtn.className = 'ar-timeline-toggle'") > i("stepsBox.id = 'ar-steps'"));
  assert.ok(i("timeline.id = 'ar-timeline'") > i("tBtn.className = 'ar-timeline-toggle'"));
  assert.ok(i('this._renderTimeline(trace, timeline);') > 0);
  assert.match(body, /setAttribute\('aria-controls', 'ar-timeline'\)/);
  assert.ok(!/—/.test(body), 'no em dashes in the new copy');
});

test('CSV export: per call step number, step times and the merged tool list; no arguments added', () => {
  const { P, captured } = loadPage();
  P._trace = sampleTrace();
  P._exportCSV();
  const csv = captured.downloads[0].content;
  const [head, ...lines] = csv.trim().split('\n');
  assert.match(head, /,reason,step,step_model_ms,step_model_estimated,step_tool_ms,step_tool_capped,step_time_ms,step_tools,findings$/);
  assert.strictEqual(lines.length, 4);
  assert.match(lines[0], /,1,1000,false,3000,false,,"bash ×2, WebFetch \(blocked\)",$/);
  assert.match(lines[3], /,2,500,false,100,false,,Read \(flagged\),$/);
  assert.ok(!csv.includes('SECRET-ARG'));
});

test('PDF export: a Steps section before the tool calls, escaped, with a step column', () => {
  const { P, captured } = loadPage();
  const t = sampleTrace();
  t.spans[1].function_name = '<img src=x>';
  P._trace = t;
  P._exportPDF();
  const html = captured.prints[0].html;
  assert.ok(html.indexOf('<h2>Steps</h2>') > 0);
  assert.ok(html.indexOf('<h2>Steps</h2>') < html.indexOf('<h2>Tool calls</h2>'));
  assert.match(html, /Took 5 s · 2 steps · 1 blocked · 1 flagged/);
  assert.match(html, /<th>step<\/th><th>model time<\/th><th>tool time<\/th><th>step time<\/th><th>tool calls<\/th>/);
  assert.match(html, /<td>1<\/td><td>1 s<\/td><td>3 s<\/td><td><\/td><td>&lt;img src=x&gt;, bash, WebFetch \(blocked\)<\/td>/);
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(!html.includes('SECRET-ARG'));
  assert.match(html, /<h2>Tool calls<\/h2><table><thead><tr><th>step<\/th><th>turn<\/th>/);
});

/** A small element tree: enough DOM for renderWaterfall to run. */
function fakeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(), id: '', className: '', hidden: false, title: '', type: '',
    children: [], dataset: {}, attrs: {}, listeners: {}, style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    _html: '', _text: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.children = []; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this._html = ''; this.children = []; },
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    querySelector() { return { addEventListener() {} }; },
    querySelectorAll() { return []; },
    contains: () => false,
  };
  return el;
}
function findById(root, id) {
  if (!root) return null;
  if (root.id === id) return root;
  for (const c of root.children || []) { const f = findById(c, id); if (f) return f; }
  return null;
}

function loadWithDom() {
  const detail = fakeEl('div');
  detail.id = 'ar-detail';
  const window = {};
  const sandbox = {
    window, console,
    localStorage: { getItem: () => null, setItem() {} },
    navigator: {},
    document: {
      activeElement: null, body: fakeEl('body'),
      createElement: (t) => fakeEl(t),
      getElementById: (id) => findById(detail, id),
      querySelector: (sel) => (sel === '#ar-detail .ar-timeline-toggle'
        ? detail.children.find(c => c.className === 'ar-timeline-toggle') || null : null),
      querySelectorAll: () => [],
      addEventListener() {},
    },
  };
  vm.runInNewContext(read('js/components/obs-tabs.js'), sandbox);
  vm.runInNewContext(read('js/components/trace-steps.js'), sandbox);
  sandbox.ObsTabs = window.ObsTabs;
  sandbox.TraceSteps = window.TraceSteps;
  vm.runInNewContext(read('js/pages/agent-runs.js'), sandbox);
  return { P: window.AgentRunsPage, detail };
}

for (const [label, setup] of [
  ['a Tool filter', (P) => { P.toolFilter = 'nothing:matches'; }],
  ['an Outcome filter', (P) => { P.outcomeFilter = 'secret'; }],
]) {
  test(`${label} that matches nothing leaves the step list and the toggle in place`, () => {
    const { P, detail } = loadWithDom();
    setup(P);
    const trace = sampleTrace();
    P._trace = trace;
    P.renderWaterfall(trace);
    const steps = findById(detail, 'ar-steps');
    const timeline = findById(detail, 'ar-timeline');
    assert.ok(steps, '#ar-steps is still there');
    assert.match(steps.innerHTML, /trace-steps-summary/);
    assert.ok(detail.children.some(c => c.className === 'ar-timeline-toggle'), 'the toggle is still there');
    assert.match(timeline.innerHTML, /calls in this trace\./, 'the empty message lands in #ar-timeline');
  });
}

test('collapsing the timeline stops a running replay', () => {
  const { P, els } = loadPage();
  els['ar-timeline'] = { hidden: false };
  P._trace = { trace_id: 'tr-1' };
  let exited = 0;
  P._replayExit = () => { exited++; P._replay.on = false; };
  P._replay.on = true;
  P._setTimeline(false, { persist: true });
  assert.strictEqual(exited, 1);
  P._setTimeline(false, { persist: true });
  assert.strictEqual(exited, 1, 'nothing to stop when replay is off');
});

test('PDF export escapes the runtime; the audit report names enforced calls', () => {
  const { P, captured } = loadPage();
  const t = sampleTrace();
  t.runtime_kind = '<b>x</b>';
  P._trace = t;
  P._exportPDF();
  assert.ok(!captured.prints[0].html.includes('<b>x</b>'));
  assert.match(captured.prints[0].html, /&lt;b&gt;x&lt;\/b&gt; · /);
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /\{ label: 'enforced calls', get: r => r\.steps \}/);
  assert.ok(!/\{ label: 'steps', get: r => r\.steps \}/.test(src));
});

test('Agent Sessions: _isBoundaryRow uses TraceSteps, with a local fallback', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /_isBoundaryRow\(row\) \{\s*if \(window\.TraceSteps && window\.TraceSteps\.isBoundaryRow\) return window\.TraceSteps\.isBoundaryRow\(row\);/);
  for (const dead of ['STEPS_BAR_W', 'STEPS_SEG_MIN_W', 'STEPS_TOOL_CAP_MS', 'STEPS_FLAT_GAP_MS', '_stepTime']) {
    assert.ok(!src.includes(dead), `${dead} is gone from terminals.js`);
  }
});

test('CSV step_tools names calls the plugin did not see', () => {
  const { P, captured } = loadPage();
  const t = sampleTrace();
  t.spans[0].tool_use_names = ['bash', 'bash', 'bash', 'WebFetch'];
  P._trace = t;
  P._exportCSV();
  assert.match(captured.downloads[0].content, /"bash ×2, WebFetch \(blocked\), bash \(not recorded\)"/);
});

test('trace masthead and PDF count tool blocks plus egress denies once', () => {
  const { P, captured } = loadPage();
  assert.strictEqual(P._blockedTotal({ blocked: 1, egress_blocked: 2 }), 3);
  assert.strictEqual(P._blockedTotal({ blocked: 0 }), 0);
  const t = sampleTrace();
  t.egress_blocked = 1;
  P._trace = t;
  P._exportPDF();
  assert.match(captured.prints[0].html, / · 2 blocked · trace /);
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /this\._blockedTotal\(trace\)\s*\? stat\(/);
});
