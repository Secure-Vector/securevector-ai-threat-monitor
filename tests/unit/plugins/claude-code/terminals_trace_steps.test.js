/** Traces section: a run expands into its steps (one per model turn) with a
 * two part time bar (model time, tool time) and the tool calls each turn made.
 * The grouping and bar maths are pure helpers on TerminalsPage, driven here
 * directly; one behavioural test drives the toggle through _renderTraceList. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

function makeEl() {
  return {
    innerHTML: '',
    textContent: '',
    hidden: false,
    dataset: {},
    classList: { add() {}, remove() {}, contains: () => false },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function loadPage(elements = {}, api = {}) {
  const window = {};
  const sandbox = {
    window, API: api, URLSearchParams,
    document: { getElementById: (id) => elements[id] || null },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  vm.runInNewContext(read('js/components/trace-steps.js'), sandbox);
  vm.runInNewContext(read('js/pages/terminals.js'), sandbox);
  return sandbox.window.TerminalsPage;
}

// Values built inside the vm sandbox have that realm's prototypes.
const plain = (v) => JSON.parse(JSON.stringify(v));

const T0 = Date.parse('2026-09-20T10:00:00Z');
const at = (ms) => new Date(T0 + ms).toISOString();
const gen = (id, ms, dur, extra = {}) => Object.assign({ span_kind: 'generation', span_id: id, called_at: at(ms), duration_ms: dur }, extra);
const call = (name, ms, extra = {}) => Object.assign({ span_kind: 'tool_call', function_name: name, action: 'allow', called_at: at(ms) }, extra);

test('tool calls join the generation named by parent_span_id', () => {
  const P = loadPage();
  // Read happens after g2 started but belongs to g1 by parent.
  const steps = P._buildTraceSteps([
    gen('g1', 0, 1000), gen('g2', 5000, 1000),
    call('Bash', 2000, { parent_span_id: 'g1' }),
    call('Read', 6000, { parent_span_id: 'g1' }),
    call('Grep', 7000, { parent_span_id: 'g2' }),
  ]);
  assert.strictEqual(steps.length, 2);
  assert.deepStrictEqual(plain(steps[0].tools.map(t => t.function_name)), ['Bash', 'Read']);
  assert.deepStrictEqual(plain(steps[1].tools.map(t => t.function_name)), ['Grep']);
});

test('without a matching parent, a call joins the latest preceding generation', () => {
  const P = loadPage();
  const steps = P._buildTraceSteps([
    call('Edit', 6000, { parent_span_id: 'nope' }), gen('g2', 5000, 500), gen('g1', 0, 500), call('Bash', 1000),
  ]);
  assert.strictEqual(steps.length, 2);
  assert.deepStrictEqual(plain(steps[0].tools.map(t => t.function_name)), ['Bash']);
  assert.deepStrictEqual(plain(steps[1].tools.map(t => t.function_name)), ['Edit']);
});

test('calls before the first generation form a leading step', () => {
  const P = loadPage();
  const steps = P._buildTraceSteps([call('Read', 0), call('Grep', 1000), gen('g1', 4000, 1000, { turn_start: 'tool_result' }), call('Bash', 6000)]);
  assert.strictEqual(steps.length, 2);
  assert.strictEqual(steps[0].leading, true);
  assert.strictEqual(steps[0].gen, null);
  assert.deepStrictEqual(plain(steps[0].tools.map(t => t.function_name)), ['Read', 'Grep']);
  assert.strictEqual(steps[0].model, null);
  assert.strictEqual(steps[0].tool, 4000, 'leading tool time runs from its first call to the first generation');
});

test('no generation spans: one flat row of calls with no bar', () => {
  const P = loadPage();
  const steps = P._buildTraceSteps([call('Read', 0), call('Bash', 1000), call('Edit', 2000)]);
  assert.strictEqual(steps.length, 1);
  assert.strictEqual(steps[0].flat, true);
  assert.strictEqual(steps[0].tools.length, 3);
  assert.strictEqual(steps[0].model, null);
  assert.strictEqual(steps[0].tool, null);
  const html = P._traceStepsHtml('t1', { spans: [call('Read', 0), call('Bash', 1000)] });
  assert.ok(!html.includes('terminals-steps-seg'), 'no bar segments');
  assert.ok(!html.includes('terminals-steps-legend'), 'no legend without bars');
  assert.match(html, /2 tool calls/);
});

test('segment maths: model is duration_ms, tool runs from generation end to the next step', () => {
  const P = loadPage();
  const steps = P._buildTraceSteps([
    gen('g1', 0, 3000), call('Bash', 3500), gen('g2', 5000, 1000, { turn_start: 'tool_result' }), call('Read', 6500), call('Edit', 8000),
  ]);
  assert.strictEqual(steps[0].model, 3000);
  assert.strictEqual(steps[0].tool, 2000, 'g1 ends at 3 s, g2 starts at 5 s');
  assert.strictEqual(steps[1].model, 1000);
  assert.strictEqual(steps[1].tool, 2000, 'last step: g2 ends at 6 s, last call at 8 s');
  assert.strictEqual(P._stepDurText(steps[0]), '3 s + 2 s');
  const max = P._stepsMaxTotal(steps);
  assert.strictEqual(max, 5000);
  assert.deepStrictEqual(plain(P._stepBarWidths(steps[0], max)), { model: 38, tool: 26, step: 0 });
  // A step with no calls has no tool segment; only the model part shows.
  const lone = P._buildTraceSteps([gen('g1', 0, 1500)]);
  assert.strictEqual(lone[0].tool, null);
  assert.strictEqual(P._stepDurText(lone[0]), '2 s');
});

test('unknown duration_ms: one neutral step-time segment, never labelled Tools', () => {
  const P = loadPage();
  const spans = [gen('g1', 0, undefined), call('Bash', 1000), gen('g2', 4000, null, { turn_start: 'tool_result' }), call('Read', 5000)];
  const steps = P._buildTraceSteps(spans);
  assert.strictEqual(steps[0].model, null);
  assert.strictEqual(steps[0].tool, null);
  assert.strictEqual(steps[0].step, 4000);
  assert.strictEqual(P._stepDurText(steps[0]), '4 s');
  const w = P._stepBarWidths(steps[0], 4000);
  assert.strictEqual(w.model, 0);
  assert.strictEqual(w.tool, 0);
  assert.strictEqual(w.step, 64);
  const html = P._traceStepsHtml('t1', { spans });
  assert.match(html, /terminals-steps-seg-step/);
  assert.match(html, /Step time/);
  assert.ok(!html.includes('Claude thinking'), 'legend shows only what is drawn');
  assert.ok(!html.includes('</span> Tools'), 'no Tools legend when no tool segment is drawn');
});

test('estimated durations: model runs up to called_at, tool time starts there', () => {
  const P = loadPage();
  // g1 stamped at 3 s with 3 s of estimated model time: it ran 0-3 s.
  // g2 stamped at 9 s with 2 s estimated: its model started at 7 s.
  const steps = P._buildTraceSteps([
    gen('g1', 3000, 3000, { duration_estimated: true }), call('Bash', 4000),
    gen('g2', 9000, 2000, { duration_estimated: true, turn_start: 'tool_result' }),
  ]);
  assert.strictEqual(steps[0].model, 3000);
  assert.strictEqual(steps[0].tool, 4000, 'from g1 at 3 s to g2 model start at 7 s');
  assert.strictEqual(steps[1].tool, null, 'no calls, no tool segment');
  const html = P._traceStepsHtml('t1', { spans: [gen('g1', 3000, 3000, { duration_estimated: true }), call('Bash', 4000), gen('g2', 9000, 2000, { duration_estimated: true, turn_start: 'tool_result' })] });
  assert.match(html, /Claude thinking[\s\S]*Tools/);
  assert.ok(!html.includes('Step time'));
});

test('tool time is capped at 5 minutes and reads as a floor', () => {
  const P = loadPage();
  const steps = P._buildTraceSteps([gen('g1', 0, 2000), call('Bash', 2500), gen('g2', 20 * 60 * 1000, 1000, { turn_start: 'tool_result' })]);
  assert.strictEqual(steps[0].tool, 300000);
  assert.strictEqual(steps[0].capped, true);
  assert.strictEqual(P._stepDurText(steps[0]), '2 s + ≥5 m');
  assert.strictEqual(steps[1].capped, false);
});

test('bar widths: a short non-zero segment is at least 3px, zero draws nothing', () => {
  const P = loadPage();
  assert.deepStrictEqual(plain(P._stepBarWidths({ model: 10, tool: 0 }, 100000)), { model: 3, tool: 0, step: 0 });
  assert.deepStrictEqual(plain(P._stepBarWidths({ model: 100000, tool: null }, 100000)), { model: 64, tool: 0, step: 0 });
  assert.deepStrictEqual(plain(P._stepBarWidths({ model: null, tool: null }, 0)), { model: 0, tool: 0, step: 0 });
});

test('duration formatting', () => {
  const P = loadPage();
  assert.strictEqual(P._fmtStepDur(450), '450 ms');
  assert.strictEqual(P._fmtStepDur(3000), '3 s');
  assert.strictEqual(P._fmtStepDur(12400), '12 s');
  assert.strictEqual(P._fmtStepDur(65000), '1 m 5 s');
  assert.strictEqual(P._fmtStepDur(120000), '2 m');
  assert.strictEqual(P._fmtStepDur(null), '');
  assert.strictEqual(P._fmtStepDur(-5), '');
  assert.strictEqual(P._fmtStepDur('x'), '');
});

test('chip state: blocked, flagged, allowed', () => {
  const P = loadPage();
  assert.strictEqual(P._stepChipState({ action: 'block' }), 'blocked');
  assert.strictEqual(P._stepChipState({ action: 'allow', risk: 'amber' }), 'flagged');
  assert.strictEqual(P._stepChipState({ action: 'log_only' }), 'flagged');
  assert.strictEqual(P._stepChipState({ action: 'allow', detection_rules: ['pii.email'] }), 'flagged');
  assert.strictEqual(P._stepChipState({ action: 'allow', risk: 'write' }), 'allowed');
  const html = P._traceStepsHtml('t1', { spans: [gen('g1', 0, 100), call('Bash', 50), call('WebFetch', 60, { action: 'block' }), call('Read', 70, { action: 'log_only' })] });
  assert.match(html, /terminals-steps-chip-allowed[^>]*>✓ Bash</);
  assert.match(html, /terminals-steps-chip-blocked[^>]*>✕ WebFetch</);
  assert.match(html, /terminals-steps-chip-flagged[^>]*>! Read</);
});

test('the first blocked call opens its detail by default, with rule ids and args', () => {
  const P = loadPage();
  const detail = { blocked: 1, spans: [gen('g1', 0, 100), call('Bash', 50), call('WebFetch', 60, {
    action: 'block', reason: 'Host not on the egress list', detection_rules: ['egress.deny'], args_preview: 'x'.repeat(120),
  })] };
  const html = P._traceStepsHtml('t1', detail);
  assert.match(html, /Blocked: Host not on the egress list/);
  assert.match(html, /\(egress\.deny\)/);
  assert.match(html, new RegExp(`<code class="terminals-steps-args">${'x'.repeat(80)}…</code>`));
  assert.match(html, /aria-pressed="true"[^>]*>✕ WebFetch/);
  assert.ok(!html.includes('terminals-steps-approve'), 'no Approve without a matching pending approval');
  const shut = P._traceStepsHtml('t1', detail, { detailKey: '' });
  assert.ok(!shut.includes('terminals-steps-detail'), 'closed by hand stays closed');
});

test('Approve shows only for a pending approval of the same tool in the same trace', () => {
  const P = loadPage();
  const detail = { spans: [gen('g1', 0, 100), call('WebFetch', 60, { action: 'block', tool_id: 'web_fetch' })] };
  const has = (approvals) => P._traceStepsHtml('t1', detail, { approvals }).includes('terminals-steps-approve');
  assert.ok(has([{ id: 'j1', tool_id: 'web_fetch', trace_id: 't1' }]));
  assert.ok(!has([{ id: 'j1', tool_id: 'web_fetch', trace_id: 'other' }]), 'another trace');
  assert.ok(!has([{ id: 'j2', tool_id: 'bash', trace_id: 't1' }]), 'another tool');
  // No trace_id: only an approval requested at or after the call counts.
  // SQLite stamps are UTC with no zone.
  const after = new Date(T0 + 5000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const before = new Date(T0 - 60000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  assert.ok(has([{ id: 'j3', tool_id: 'web_fetch', requested_at: after }]));
  assert.ok(!has([{ id: 'j4', tool_id: 'web_fetch', requested_at: before }]), 'requested before the call');
  assert.ok(!has([{ id: 'j5', tool_id: 'web_fetch' }]), 'no trace and no time');
});

test('chip keys follow the call, not its position', () => {
  const P = loadPage();
  const blocked = call('WebFetch', 3000, { action: 'block', span_id: 'sp-9' });
  const one = P._traceStepsHtml('t1', { spans: [gen('g1', 0, 100), blocked] });
  assert.match(one, /data-step-key="s:sp-9"/);
  // A new step lands before it: the key and the open detail stay with the call.
  const two = P._traceStepsHtml('t1', { spans: [call('Read', -1000), gen('g1', 0, 100), blocked] }, { detailKey: 's:sp-9' });
  assert.match(two, /aria-pressed="true"[^>]*>✕ WebFetch/);
  // Without span_id: called_at|name|ordinal among identical calls.
  const keys = P._stepChipKeys([{ tools: [call('Bash', 0), call('Bash', 0), call('Read', 0)] }]);
  assert.deepStrictEqual(plain(keys), [[`k:${at(0)}|Bash|0`, `k:${at(0)}|Bash|1`, `k:${at(0)}|Read|0`]]);
});

test('server strings are escaped, including a reason carrying a script tag', () => {
  const P = loadPage();
  const html = P._traceStepsHtml('t"1', { spans: [gen('g1', 0, 100), call('<img src=x>', 50, {
    action: 'block', reason: '<script>alert(1)</script>', detection_rules: ['<b>r</b>'], args_preview: '<svg onload=1>',
  })] });
  assert.ok(!html.includes('<script>'), 'raw script tag must not appear');
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(!html.includes('<svg'));
  assert.ok(!html.includes('<b>r</b>'));
  assert.match(html, /Blocked: &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /data-trace-id="t&quot;1"/);
});

test('summary line, legend, cost, and the 6 step cap', () => {
  const P = loadPage();
  const spans = [];
  for (let i = 0; i < 8; i++) { spans.push(gen(`g${i}`, i * 2000, 1000)); spans.push(call('Bash', i * 2000 + 1500)); }
  spans.push(call('WebFetch', 15800, { action: 'block' }));
  const html = P._traceStepsHtml('t1', {
    spans, blocked: 1, started_at: at(0), ended_at: at(15800), generation_total_cost: 0.042,
  });
  assert.match(html, /<div class="terminals-steps-summary">Took 16 s · 8 steps · 1 blocked · \$0\.04<\/div>/);
  assert.match(html, /terminals-steps-legend[\s\S]*Claude thinking[\s\S]*Tools/);
  assert.strictEqual((html.match(/class="terminals-steps-row"/g) || []).length, 6);
  assert.match(html, /\+ 2 more steps · <\/span><button type="button" class="terminals-steps-full"/);
  const few = P._traceStepsHtml('t1', { spans: spans.slice(0, 4), blocked: 0, generation_total_cost: 0 });
  assert.ok(!few.includes('more step'));
  assert.ok(!few.includes('blocked'));
  assert.ok(!few.includes('$'));
  assert.match(few, /See full run/);
});

test('Show steps toggle: one run open, lazy fetch cached per trace, errors not cached', async () => {
  const tEl = makeEl();
  const buttons = [];
  tEl.querySelectorAll = (sel) => (sel === 'button.terminals-steps-toggle' ? buttons : []);
  const calls = [];
  let fail = true;
  // Run health rides the same fetch (its own URL); these assertions count the steps fetches.
  const api = { request: async (url) => { if (String(url).endsWith('/health')) return null; calls.push(url); if (fail) throw new Error('down'); return { spans: [gen('g1', 0, 1000)] }; } };
  const P = loadPage({ 'terminals-traces': tEl }, api);
  P._ago = () => '6m ago';
  P._traceRender = { sessionId: 's1', runs: [
    { trace_id: 'a1', session_id: 's1', blocked: 1, spans: 4 },
    { trace_id: 'b2', session_id: 's1', detections: 2, spans: 3 },
  ], failed: false };
  const toggle = (id) => ({ dataset: { traceId: id } });
  buttons.push(toggle('a1'), toggle('b2'));
  P._renderTraceList(tEl);
  assert.match(tEl.innerHTML, /6m ago · 1 blocked · 4 spans/);
  assert.match(tEl.innerHTML, /6m ago · 2 flagged · 3 spans/);
  assert.match(tEl.innerHTML, /aria-expanded="false"[^>]*>Show steps ▾/);

  buttons[0].onclick();
  assert.strictEqual(P._stepsOpen, 'a1');
  assert.match(tEl.innerHTML, /Loading steps…/);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.match(tEl.innerHTML, /Steps unavailable\./);
  assert.deepStrictEqual(calls, ['/api/traces/a1']);

  // Opening another run closes the first; reopening a failed one retries.
  fail = false;
  buttons[1].onclick();
  assert.strictEqual(P._stepsOpen, 'b2');
  for (let i = 0; i < 10; i++) await Promise.resolve();
  buttons[0].onclick();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.strictEqual(P._stepsOpen, 'a1');
  assert.deepStrictEqual(calls, ['/api/traces/a1', '/api/traces/b2', '/api/traces/a1']);
  assert.strictEqual((tEl.innerHTML.match(/aria-expanded="true"/g) || []).length, 1);
  assert.match(tEl.innerHTML, /class="terminals-steps-row"/);

  // Reopening a cached run reuses it.
  buttons[1].onclick();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.strictEqual(calls.length, 3, 'b2 came from the cache');
  buttons[1].onclick();
  assert.strictEqual(P._stepsOpen, null);
});

test('an overlapping tick during a pending traces fetch keeps the open run and the list', async () => {
  const tEl = makeEl();
  const elements = { 'terminals-verdicts': makeEl(), 'terminals-approvals': makeEl(), 'terminals-traces': tEl };
  let resolveRuns;
  let traceFetches = 0;
  const runs = [{ trace_id: 'r1', session_id: 's1', started_at: '2026-09-20T10:00:00Z', spans: 2 }];
  const api = {
    terminalsVerdicts: async () => ({ items: [], session_id: 's1' }),
    getJitRequests: async () => ({ items: [] }),
    request: (url) => {
      if (url.startsWith('/api/traces?')) {
        traceFetches++;
        if (traceFetches === 1) return Promise.resolve({ runs });
        return new Promise((r) => { resolveRuns = r; });
      }
      return Promise.resolve({ spans: [gen('g1', 0, 100)] });
    },
  };
  const P = loadPage(elements, api);
  P._attached = 'task-1';
  await P._refreshRail();
  P._stepsOpen = 'r1';
  P._stepsCache.r1 = { data: { spans: [gen('g1', 0, 100)] }, at: Date.now() };
  P._tracesCache.at -= 13000; // expire, so the next tick refetches
  const slow = P._refreshRail();
  for (let i = 0; i < 20 && !resolveRuns; i++) await Promise.resolve();
  assert.ok(resolveRuns, 'second fetch in flight');
  await P._refreshRail(); // overlapping tick: pending-hit
  assert.strictEqual(P._stepsOpen, 'r1', 'open run survives');
  assert.ok(P._stepsCache.r1, 'its steps stay cached');
  assert.ok(!tEl.innerHTML.includes('No traces yet.'));
  assert.match(tEl.innerHTML, /class="terminals-steps"/);
  resolveRuns({ runs });
  await slow;
});

test('switching task or session drops the open run, paint and caches', async () => {
  let session = 's1';
  const tEl = makeEl();
  const elements = { 'terminals-verdicts': makeEl(), 'terminals-approvals': makeEl(), 'terminals-traces': tEl };
  const api = {
    terminalsVerdicts: async () => ({ items: [], session_id: session }),
    getJitRequests: async () => ({ items: [] }),
    request: async () => ({ runs: [{ trace_id: 'r1', session_id: 's1' }, { trace_id: 'r1', session_id: 's2' }] }),
  };
  const P = loadPage(elements, api);
  P._attached = 'task-1';
  await P._refreshRail();
  P._stepsOpen = 'r1';
  P._stepsCache.r1 = { data: { spans: [] }, at: Date.now() };
  session = 's2';
  P._tracesCache = null;
  await P._refreshRail();
  assert.strictEqual(P._stepsOpen, null);
  assert.ok(!P._stepsCache.r1);
  assert.strictEqual(P._traceRender.sessionId, 's2');
});

test('a steps answer for a task the rail has left does not repaint', async () => {
  let resolve;
  const P = loadPage({}, { request: () => new Promise((r) => { resolve = r; }) });
  let paints = 0;
  P._renderTraceList = () => { paints++; };
  P._traceRender = { taskId: 'a', sessionId: 's1', runs: [], failed: false };
  P._stepsOpen = 'r1';
  P._loadTraceSteps('r1');
  for (let i = 0; i < 10 && !resolve; i++) await Promise.resolve();
  P._traceRender = { taskId: 'b', sessionId: 's9', runs: [], failed: false };
  resolve({ spans: [] });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.strictEqual(paints, 0);
});

test('a steps fetch pending for more than 20s is retried', async () => {
  let n = 0;
  const P = loadPage({}, { request: (url) => { if (String(url).endsWith('/health')) return new Promise(() => {}); n++; return new Promise(() => {}); } });
  P._loadTraceSteps('r1');
  for (let i = 0; i < 5; i++) await Promise.resolve();
  P._loadTraceSteps('r1');
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.strictEqual(n, 1, 'a fresh pending fetch is not duplicated');
  P._stepsCache.r1.pendingAt -= 21000;
  P._loadTraceSteps('r1');
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.strictEqual(n, 2, 'a stuck pending fetch is retried');
});

test('panel id and aria-controls are keyed on the trace id', () => {
  const tEl = makeEl();
  const P = loadPage({ 'terminals-traces': tEl });
  P._traceRender = { sessionId: 's1', runs: [{ trace_id: 'ab"c', session_id: 's1' }], failed: false };
  P._stepsOpen = 'ab"c';
  P._stepsCache = { 'ab"c': { pending: true, pendingAt: Date.now() } };
  P._renderTraceList(tEl);
  assert.match(tEl.innerHTML, /aria-controls="terminals-steps-ab&quot;c"/);
  assert.match(tEl.innerHTML, /id="terminals-steps-ab&quot;c"/);
});

test('CSS: step classes, muted non-state bar hues with light overrides, focus ring', () => {
  const css = read('css/styles.css');
  const m = css.match(/\.terminals-steps \{[^}]*--steps-model:\s*([^;]+);[^}]*--steps-tool:\s*([^;]+);/);
  assert.ok(m, 'bar hues are custom properties on .terminals-steps');
  assert.match(css, /\[data-theme="light"\] \.terminals-steps \{[^}]*--steps-model:[^}]*--steps-tool:/);
  for (const v of [m[1], m[2]]) {
    assert.ok(!/2dd4bf|ef4444|f59e0b|10b981|22c55e|teal|red|amber|green/i.test(v), `bar hue must not be a state colour: ${v}`);
  }
  assert.match(css, /\.terminals-steps-seg-model \{[^}]*var\(--steps-model\)/);
  assert.match(css, /\.terminals-steps-seg-tool \{[^}]*var\(--steps-tool\)/);
  assert.match(css, /\.terminals-steps-seg-step \{[^}]*var\(--steps-step\)/);
  assert.match(css, /\[data-theme="light"\] \.terminals-steps \{[^}]*--steps-step:/);
  assert.match(css, /\.terminals-steps-chip:focus-visible[^{]*\{[^}]*outline/);
});

test('Traces never auto-open, and the toggle has no em dash in its copy', () => {
  const src = read('js/pages/terminals.js');
  assert.ok(!/_forceGovSection\('terminals-gov-traces'\)/.test(src));
  const start = src.indexOf('_buildTraceSteps(spans)');
  const end = src.indexOf('_renderTraceList(tEl) {');
  assert.ok(start > 0 && end > start);
  assert.ok(!src.slice(start, end + 6000).includes('—'), 'no em dashes in the steps UI copy');
});

test('refresh refetches an open run only once its copy is older than 12s', async () => {
  let n = 0;
  const P = loadPage({}, { request: async (url) => { if (String(url).endsWith('/health')) return null; n++; return { spans: [] }; } });
  P._loadTraceSteps('r1');
  for (let i = 0; i < 10; i++) await Promise.resolve();
  P._loadTraceSteps('r1', true);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.strictEqual(n, 1, 'fresh copy is reused');
  P._stepsCache.r1.at -= 13000;
  P._loadTraceSteps('r1', true);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.strictEqual(n, 2, 'stale copy is refetched');
  const src = read('js/pages/terminals.js');
  assert.match(src, /traceRuns\[0\]\.trace_id === this\._stepsOpen\) \{\s*this\._loadTraceSteps\(this\._stepsOpen, true\);/);
});

test('session marker spans are not steps, chips, counts or summary', () => {
  const P = loadPage();
  const marker = (name, ms, extra = {}) => call(name, ms, Object.assign({ tool_id: name, action: 'log_only', reason: 'session opened' }, extra));
  const spans = [marker('__session_start__', 0), call('bash', 1000), call('Read', 2000), marker('__session_end__', 3000)];
  const steps = P._buildTraceSteps(spans);
  assert.strictEqual(steps.length, 1);
  assert.deepStrictEqual(plain(steps[0].tools.map(t => t.function_name)), ['bash', 'Read']);
  const html = P._traceStepsHtml('t1', { spans });
  assert.ok(!html.includes('__session'), 'no marker chip');
  assert.ok(!html.includes('terminals-steps-chip-flagged'), 'markers no longer read as flagged');
  assert.match(html, /2 tool calls/);
  // A marker that was actually refused is a real verdict and stays.
  const kept = P._buildTraceSteps([marker('__session_start__', 0, { action: 'block' }), call('bash', 1000)]);
  assert.strictEqual(kept[0].tools.length, 2);
  // Only when the whole run is markers: nothing to show.
  assert.strictEqual(P._buildTraceSteps([marker('__session_start__', 0)]).length, 0);
});

test('consecutive same-name same-state calls share one chip; a block never merges', () => {
  const P = loadPage();
  const spans = [gen('g1', 0, 100)];
  for (let i = 0; i < 12; i++) spans.push(call('bash', 200 + i, { span_id: `b${i}` }));
  spans.push(call('bash', 300, { action: 'block', span_id: 'blk', reason: 'nope' }));
  spans.push(call('bash', 301, { span_id: 'after' }));
  const html = P._traceStepsHtml('t1', { spans }, { detailKey: 's:b0' });
  assert.match(html, /data-step-key="s:b0"[^>]*>✓ bash ×12</);
  assert.match(html, /terminals-steps-chip-blocked[^>]*>✕ bash</);
  assert.match(html, /data-step-key="s:after"[^>]*>✓ bash</);
  assert.strictEqual((html.match(/class="terminals-steps-chip /g) || []).length, 3);
  // The group opens the detail of its first call.
  assert.match(html, /aria-pressed="true"[^>]*>✓ bash ×12/);
  assert.match(html, /terminals-steps-detail-allowed/);
});

test('at most 8 chips per step, blocked and flagged first, then +N more', () => {
  const P = loadPage();
  const spans = [gen('g1', 0, 100)];
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  names.forEach((n, i) => spans.push(call(n, 200 + i * 2)));
  spans.push(call('x', 300, { action: 'block' }));
  spans.push(call('y', 301, { action: 'log_only' }));
  spans.push(call('k', 302));
  spans.push(call('k', 303));
  const html = P._traceStepsHtml('t1', { spans });
  const chips = html.match(/class="terminals-steps-chip terminals-steps-chip-[a-z]+"/g) || [];
  assert.strictEqual(chips.length, 8, '8 chips');
  assert.match(html, /✕ x</);
  assert.match(html, /! y</);
  // 6 allowed chips fit (a to f); g, h, i, j and k ×2 are hidden: 6 calls.
  assert.match(html, />✓ f</);
  assert.ok(!html.includes('>✓ g<'));
  assert.match(html, /class="terminals-steps-chip terminals-steps-more" data-trace-id="t1"[^>]*>\+6 more</);
});

test('with no model turns, a pause over 60 s starts a new step', () => {
  const P = loadPage();
  const steps = P._buildTraceSteps([call('a', 0), call('b', 30000), call('c', 100000), call('d', 101000), call('e', 200000)]);
  assert.deepStrictEqual(plain(steps.map(s => s.tools.map(t => t.function_name))), [['a', 'b'], ['c', 'd'], ['e']]);
  assert.ok(steps.every(s => s.flat));
  const html = P._traceStepsHtml('t1', { spans: [call('a', 0), call('c', 100000)] });
  assert.match(html, /2 tool calls · 2 steps/);
  assert.ok(!html.includes('terminals-steps-seg'));
});

test('real shape: user idle before a prompt is never tool time', () => {
  const P = loadPage();
  // Step 1 calls tools; step 2 (fed by their result) calls none; the person
  // is away 6 minutes; step 3 starts from a new prompt and calls tools.
  const spans = [
    gen('g1', 0, 2000, { duration_estimated: true, turn_start: 'prompt' }), call('Bash', 500), call('Read', 1500),
    gen('g2', 5000, 3000, { duration_estimated: true, turn_start: 'tool_result' }),
    gen('g3', 5000 + 6 * 60000 + 2000, 2000, { duration_estimated: true, turn_start: 'prompt' }),
    call('Edit', 5000 + 6 * 60000 + 3000),
  ];
  const steps = P._buildTraceSteps(spans);
  assert.strictEqual(steps.length, 3);
  assert.strictEqual(steps[0].tool, 2000, 'g1 at 0 s to g2 model start at 2 s: the tool result fed it');
  assert.strictEqual(steps[1].tool, null, 'the tool-less step has no tool segment');
  assert.strictEqual(steps[1].capped, false);
  assert.strictEqual(P._stepDurText(steps[1]), '3 s', 'no ≥ on the tool-less step');
  assert.strictEqual(steps[2].tool, 1000, 'last step runs to its last call');
  assert.ok(steps.every(s => !s.capped), 'the 6 minute idle is not counted anywhere');
  // The bar scale is set by real work, not by the idle.
  assert.strictEqual(P._stepsMaxTotal(steps), 4000);
  const html = P._traceStepsHtml('t1', { spans });
  assert.ok(!html.includes('≥'));
});

test('a turn fed by a prompt ends the tool segment at the last call', () => {
  const P = loadPage();
  const steps = P._buildTraceSteps([gen('g1', 0, 1000), call('Bash', 1500), call('Read', 3000), gen('g2', 10 * 60000, 1000, { turn_start: 'prompt' })]);
  assert.strictEqual(steps[0].tool, 2000, 'g1 ends at 1 s, last call at 3 s');
  assert.strictEqual(steps[0].capped, false);
  // No turn_start (proxy or SDK measured): the old rule, to the next model
  // start, capped at 5 minutes.
  const old = P._buildTraceSteps([gen('g1', 0, 1000), call('Bash', 1500), gen('g2', 4000, 1000), gen('g3', 10 * 60000, 1000)]);
  assert.strictEqual(old[0].tool, 3000, 'g1 ends at 1 s, g2 starts at 4 s');
  const far = P._buildTraceSteps([gen('g1', 0, 1000), call('Bash', 1500), gen('g2', 10 * 60000, 1000)]);
  assert.strictEqual(far[0].tool, 300000);
  assert.strictEqual(far[0].capped, true);
  // Calls that all land inside the model time: tool time 0, no segment drawn.
  const zero = P._buildTraceSteps([gen('g1', 0, 5000), call('Bash', 1000)]);
  assert.strictEqual(zero[0].tool, 0);
  assert.strictEqual(P._stepBarWidths(zero[0], 5000).tool, 0);
});

test('the legend says Claude thinking only for Claude Code runs', () => {
  const P = loadPage();
  const spans = [gen('g1', 0, 1000), call('Bash', 1500)];
  assert.match(P._traceStepsHtml('t1', { spans, runtime_kind: 'claude-code' }), /Claude thinking/);
  const codex = P._traceStepsHtml('t1', { spans, runtime_kind: 'codex' });
  assert.match(codex, /Model thinking/);
  assert.ok(!codex.includes('Claude thinking'));
});

test('header strip: a session egress deny counts as blocked alongside the verdicts', async () => {
  // The strip already reads the verdicts and the session's destinations.
  const P = loadPage({}, {
    terminalsVerdicts: async () => ({ items: [{ action: 'allow' }, { action: 'block' }] }),
    // One call refused two hosts: per-host totals say 2, the call count 1.
    getEgressSessionDestinations: async () => ({ blocked_calls: 1, destinations: [{ host: 'evil.example', blocked: 1 }, { host: 'evil2.example', blocked: 1 }] }),
  });
  P._tasks = [{ id: 't1', session_id: 's1', status: 'working', executor_id: 'claude-code' }];
  P._panes = new Map([['p1', { taskId: 't1' }]]);
  P._renderPaneGov = () => {};
  await P._refreshPaneGov();
  assert.deepStrictEqual(plain(P._panes.get('p1').gov), { calls: 2, blocked: 2, hosts: 2 }, '1 verdict block + 1 refused call');
  assert.strictEqual(P._egressBlockedOf(null), 0);
  // No call count in the answer: nothing is guessed from per-host totals.
  assert.strictEqual(P._egressBlockedOf({ destinations: [{ blocked: 3 }] }), 0);
});

test('footer: governed and blocked, with the session egress denies added once', () => {
  const foot = makeEl();
  const P = loadPage({ 'terminals-pane-foot': foot });
  P._tasks = [{ id: 't1', session_id: 's1', status: 'working', executor_id: 'claude-code', workspace: '/w', created_at: new Date().toISOString() }];
  // The focused pane before its own footer exists: the page level line.
  P._panes = new Map([['p1', { id: 'p1', taskId: 't1' }]]);
  P._focused = 'p1';
  P._govCounts = { governed: 2, blocked: 0 };
  P._egressSid = 's1';
  P._egress = { blocked_calls: 1, destinations: [{ host: 'evil.example', blocked: 1 }, { host: 'evil2.example', blocked: 1 }] };
  P._renderPaneFoot();
  assert.match(foot.innerHTML, /2 governed · 1 blocked/);
  // Another session's egress reading is not this task's.
  P._egressSid = 's2';
  P._footSig = null;
  P._renderPaneFoot();
  assert.match(foot.innerHTML, /2 governed · 0 blocked/);
});
