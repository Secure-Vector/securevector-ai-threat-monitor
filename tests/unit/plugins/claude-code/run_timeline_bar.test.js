/** Observability > Runs: the timeline bar over an open run. The pure
 *  geometry and markup in js/components/run-trace.js (timelineSegments,
 *  timelineTotalsText, timelineHtml) and the wiring in js/pages/agent-runs.js. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

function load() {
  const window = {};
  const sandbox = { window, console };
  vm.runInNewContext(read('js/components/trace-steps.js'), sandbox);
  vm.runInNewContext(read('js/components/run-trace.js'), Object.assign(sandbox, { TraceSteps: window.TraceSteps }));
  return window.RunTrace;
}

const T0 = Date.parse('2026-10-27T10:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const llm = (key, s, dur, kids = []) => ({ key, kind: 'llm', turn: 1, span: { span_kind: 'generation', model: 'm', called_at: at(s), duration_ms: dur }, children: kids });
const tool = (key, s, dur, extra = {}) => Object.assign({ key, kind: 'tool', span: Object.assign({ span_kind: 'tool_call', tool_id: 'Bash', called_at: at(s), duration_ms: dur }, extra.span || {}), children: [] }, extra.node || {});
const run100 = { started_at: at(0), ended_at: at(100) };

function tree() {
  return { key: 'run', kind: 'run', children: [
    llm('g1', 0, 10000, [tool('t1', 10, 5000), tool('t2', 20, 1, { span: { action: 'block' } })]),
    llm('g2', 50, 20000, [tool('t3', 70, 0, { node: { req: { id: 'q', status: 'pending', requested_at: at(70) } } })]),
  ] };
}

test('segments sit at their offset and width on the run axis', () => {
  const RT = load();
  const tl = RT.timelineSegments(run100, tree(), T0 + 100000);
  assert.equal(tl.axis.start, T0);
  assert.equal(tl.axis.end, T0 + 100000);
  const g1 = tl.lanes[0].find(s => s.key === 'g1');
  assert.equal(g1.left, 0);
  assert.equal(g1.width, 10);
  const g2 = tl.lanes[0].find(s => s.key === 'g2');
  assert.equal(g2.left, 50);
  assert.equal(g2.width, 20);
  const t1 = tl.lanes[1].find(s => s.key === 't1');
  assert.equal(t1.left, 10);
  assert.equal(t1.width, 5);
});

test('model turns use lane 1 and tool calls lane 2, so nested calls do not overlap', () => {
  const RT = load();
  const tl = RT.timelineSegments(run100, tree(), T0 + 100000);
  assert.equal(tl.lanes[0].map(s => s.key).join(), 'g1,g2');
  assert.equal(tl.lanes[1].map(s => s.key).sort().join(), 't1,t2,t3');
  assert.ok(tl.lanes[0].every(s => s.kind === 'model'));
});

test('blocked is red kind, a pending hold is waiting and runs to now', () => {
  const RT = load();
  const now = T0 + 100000;
  const tl = RT.timelineSegments(run100, tree(), now);
  const t2 = tl.lanes[1].find(s => s.key === 't2');
  const t3 = tl.lanes[1].find(s => s.key === 't3');
  const t1 = tl.lanes[1].find(s => s.key === 't1');
  assert.equal(t2.kind, 'blocked');
  assert.equal(t2.decision, 'blocked');
  assert.equal(t3.kind, 'waiting');
  assert.equal(t3.width, 30);
  assert.equal(t1.kind, 'tool');
  assert.match(t2.label, /^Bash · \+20s · 0\.0s · blocked$/);
});

test('a tiny call keeps a 2px minimum in markup and never runs off the end', () => {
  const RT = load();
  const tl = RT.timelineSegments(run100, tree(), T0 + 100000);
  const html = RT.timelineHtml(tl, 'tr1');
  assert.match(html, /width:max\(2px, 0\.001%\)/);
  assert.match(html, /left:min\(20\.000%, calc\(100% - 2px\)\)/);
  assert.match(read('js/pages/agent-runs.js'), /\.rl-tlseg \{[^}]*min-width:2px/);
});

test('a running run spans to now; the axis is the run row, not the loaded spans', () => {
  const RT = load();
  const now = T0 + 200000;
  const tl = RT.timelineSegments({ started_at: at(0), ended_at: at(80), running: true }, tree(), now);
  assert.equal(tl.axis.end, now);
  const g2 = tl.lanes[0].find(s => s.key === 'g2');
  assert.equal(g2.left, 25);
  // Only one page loaded (a later span): the axis still starts at the run start.
  const one = RT.timelineSegments(run100, [llm('g9', 90, 1000)], T0 + 100000);
  assert.equal(one.axis.start, T0);
  assert.equal(one.lanes[0][0].left, 90);
  // No run end and not running: the latest loaded span end.
  const open = RT.timelineSegments({ started_at: at(0) }, tree(), T0 + 500000);
  assert.ok(open.axis.end >= T0 + 70000 && open.axis.end <= T0 + 500000);
});

test('totals sum model, tool and waiting time and count calls', () => {
  const RT = load();
  const now = T0 + 100000;
  const tl = RT.timelineSegments(run100, tree(), now);
  assert.equal(tl.totals.model, 30000);
  assert.equal(tl.totals.tool, 5001);
  assert.equal(tl.totals.waiting, 30000);
  assert.equal(tl.totals.calls, 3);
  assert.equal(RT.timelineTotalsText(tl.totals), 'Model 30s · Tools 5.0s · Waiting 30s · 3 calls');
  // A decided hold counts its requested-to-decided time.
  const decided = [tool('x', 0, 2000, { node: { req: { status: 'approved', requested_at: at(0), decided_at: at(12) } } })];
  assert.equal(RT.timelineSegments(run100, decided, now).totals.waiting, 12000);
  // No hold data: no Waiting item.
  const plainRun = RT.timelineSegments(run100, [llm('g', 0, 130000), tool('a', 1, 48000)], now);
  assert.equal(plainRun.totals.waiting, null);
  assert.equal(RT.timelineTotalsText(plainRun.totals), 'Model 2m 10s · Tools 48s · 1 call');
});

test('markup escapes span names and keys, has a legend and buttons with aria-labels', () => {
  const RT = load();
  const evil = [tool('<k">', 1, 10, { span: { tool_id: '<img src=x onerror=alert(1)>' } })];
  const html = RT.timelineHtml(RT.timelineSegments(run100, evil, T0 + 100000), 't"r');
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<k">'));
  assert.match(html, /data-tlkey="&lt;k&quot;&gt;"/);
  assert.match(html, /<button type="button" class="rl-tlseg rl-tl-tool"[^>]*aria-label="&lt;img/);
  assert.match(html, /class="rl-vh">Legend: Model time, Tool calls, Blocked, Waiting</);
  assert.match(html, /class="rl-tlleg" aria-hidden="true"/);
  assert.match(html, /class="rl-tltot">Model 0\.0s · Tools 0\.0s · 1 call</);
});

test('page wiring: bar under the open run, click opens the span, live tick redraws the box only', () => {
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /if \(e\.trace\) list\.appendChild\(this\._timelineRow\(r, e, base, sess\)\);\n\s*if \(fkind\) list\.appendChild\(this\._spanFilterNote/);
  assert.match(src, /closest\('\[data-tlkey\]'\)[\s\S]{0,120}this\._timelineSelect\(r\.trace_id, b\.dataset\.tlkey\)/);
  const sel = src.slice(src.indexOf('    _timelineSelect('), src.indexOf('    _timelineSelect(') + 1200);
  assert.match(sel, /RunsList\.inlineReveal\(tree, path/);
  assert.match(sel, /e\.det\[key\] = true/);
  assert.match(sel, /this\._revealWait\(traceId, key\)/);
  assert.match(src, /this\._inlineRefresh\(\);\n\s*this\._timelineTick\(\);/);
  const tick = src.slice(src.indexOf('    _timelineTick() {'), src.indexOf('    _timelineTick() {') + 1400);
  assert.match(tick, /if \(row\._tlHtml === html\) return;/);
  assert.ok(!/box\.innerHTML !==/.test(tick));
  assert.match(tick, /box\.contains\(act\)[\s\S]*act\.dataset\.fk[\s\S]*box\.innerHTML = html;[\s\S]*b\.focus\(\{ preventScroll: true \}\)/);
  assert.match(src, /el\._tlHtml = this\._timelineHtml\(r, e\);/);
  // Colour discipline: model = the one accent, tools neutral, state colours.
  assert.match(src, /\.rl-tl-model \{ background:var\(--accent-primary\); \}/);
  assert.match(src, /\.rl-tl-tool \{ background:var\(--text-muted\); \}/);
  assert.match(src, /\.rl-tl-blocked \{ background:var\(--danger/);
  assert.match(src, /\.rl-tl-waiting \{ background:var\(--warning/);
});

test('cache-busting versions moved', () => {
  const html = read('index.html');
  assert.match(html, /run-trace\.js\?v=11"/);
  assert.match(html, /agent-runs\.js\?v=398"/);
});

test('roving tabindex: one tab stop per bar, arrows, Home and End move it', () => {
  const RT = load();
  const tl = RT.timelineSegments(run100, tree(), T0 + 100000);
  const html = RT.timelineHtml(tl, 'tr1');
  assert.equal((html.match(/tabindex="0"/g) || []).length, 1);
  assert.match(html, /tabindex="0" data-tlkey="g1"/);
  const moved = RT.timelineHtml(tl, 'tr1', 't2');
  assert.equal((moved.match(/tabindex="0"/g) || []).length, 1);
  assert.match(moved, /tabindex="0" data-tlkey="t2"/);
  assert.match(RT.timelineHtml(tl, 'tr1', 'gone'), /tabindex="0" data-tlkey="g1"/);
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]\.includes\(ev\.key\)/);
  assert.match(src, /segs\.forEach\(\(s, k\) => \{ s\.tabIndex = k === j \? 0 : -1; \}\);/);
});

test('a span that starts before the run start is clipped, not shifted', () => {
  const RT = load();
  const tl = RT.timelineSegments({ started_at: at(10), ended_at: at(110) }, [llm('early', 0, 30000)], T0 + 200000);
  const g = tl.lanes[0][0];
  assert.equal(g.left, 0);
  assert.equal(g.width, 20);
});

test('a paged run labels its totals as loaded', () => {
  const RT = load();
  const t = tree();
  t.totals = { tokens: 1, cost: 0, block: 0 };
  const tl = RT.timelineSegments(run100, t, T0 + 100000);
  assert.equal(tl.totals.loaded, true);
  assert.match(RT.timelineTotalsText(tl.totals), /· 3 calls loaded$/);
  assert.equal(RT.timelineSegments(run100, tree(), T0 + 100000).totals.loaded, false);
});
