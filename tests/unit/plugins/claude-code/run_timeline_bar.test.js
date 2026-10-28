/** Observability > Runs: each open run's span rows draw a waterfall in
 *  their Duration cell. The pure geometry and markup in
 *  js/components/run-trace.js (timelineSegments, timelineTotalsText,
 *  timelineCellHtml) and the wiring in js/pages/agent-runs.js. */
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

test('model turns and tool calls are kept apart and indexed by span key', () => {
  const RT = load();
  const tl = RT.timelineSegments(run100, tree(), T0 + 100000);
  assert.equal(tl.lanes[0].map(s => s.key).join(), 'g1,g2');
  assert.equal(tl.lanes[1].map(s => s.key).sort().join(), 't1,t2,t3');
  assert.ok(tl.lanes[0].every(s => s.kind === 'model'));
  assert.equal(Object.keys(tl.byKey).sort().join(), 'g1,g2,t1,t2,t3');
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
  const html = RT.timelineCellHtml(tl.byKey.t2, '0.0s');
  assert.match(html, /width:max\(2px, 0\.001%\)/);
  assert.match(html, /left:min\(20\.000%, calc\(100% - 2px\)\)/);
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

test('cache-busting versions moved', () => {
  const html = read('index.html');
  assert.match(html, /run-trace\.js\?v=13"/);
  assert.match(html, /agent-runs\.js\?v=401"/);
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

test('the Duration cell: text over a track with one segment, escaped, labelled', () => {
  const RT = load();
  const evil = [tool('<k">', 20, 1000, { span: { tool_id: '<img src=x onerror=alert(1)>' } })];
  const seg = RT.timelineSegments(run100, evil, T0 + 100000).byKey['<k">'];
  const html = RT.timelineCellHtml(seg, '1.0s');
  assert.ok(!html.includes('<img'));
  // Label above the segment, centred on it (20% + 0.5%), clamped inside the cell.
  assert.match(html, /^<span class="rl-wfl"><span class="rl-wfd" style="left:clamp\(0px, calc\(20\.500% - 24px\), calc\(100% - 48px\)\)">1\.0s<\/span><\/span><span class="rl-wft"><i class="rl-wfs rl-tl-tool" role="img" /);
  assert.match(html, /title="&lt;img src=x onerror=alert\(1\)&gt; · \+20s · 1\.0s · allowed"/);
  assert.match(html, /aria-label="Starts \+20s into the run, takes 1\.0s"/);
  assert.ok(!/<button|tabindex/.test(html), 'the cell is not a control');
});

test('a span with no timing shows the text only, no track', () => {
  const RT = load();
  const t = { key: 'run', kind: 'run', children: [{ key: 'x', kind: 'tool', span: { tool_id: 'Bash' }, children: [] }] };
  const tl = RT.timelineSegments(run100, t, T0 + 100000);
  assert.equal(tl.byKey.x, undefined);
  assert.equal(RT.timelineCellHtml(tl.byKey.x, '2.0s'), '<span class="rl-wfd rl-wfd-only">2.0s</span>');
});

test('page wiring: every span row draws its segment, totals line under the run, no top bar', () => {
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /if \(e\.trace\) list\.appendChild\(this\._timelineTotalsRow\(r, e, base, sess\)\);/);
  assert.match(src, /e\.tl = this\._inlineTimeline\(r, tree\);/);
  assert.match(src, /const seg = e\.tl && e\.tl\.byKey \? e\.tl\.byKey\[row\.key\] : null;/);
  assert.match(src, /<span class="rl-c rl-r rl-sub rl-wfc">\$\{RT\.timelineCellHtml\(seg, RT\.fmtDur\(dur\)\)\}<\/span>/);
  assert.match(src, /RunTrace\.timelineTotalsText\(this\._inlineTimeline\(r, this\._inlineTree\(r, e\)\)\.totals\)/);
  for (const gone of ['_timelineRow', '_timelineTick', '_timelineSelect', 'rl-tlbar', 'rl-tlleg', 'rl-tlseg']) assert.ok(!src.includes(gone), gone);
  assert.ok(!read('js/components/run-trace.js').includes('timelineHtml('));
  // Colour discipline: model = the one accent, tools neutral, state colours.
  assert.match(src, /\.rl-tl-model \{ background:var\(--accent-primary\); \}/);
  assert.match(src, /\.rl-tl-tool \{ background:var\(--text-muted\); \}/);
  assert.match(src, /\.rl-tl-blocked \{ background:var\(--danger/);
  assert.match(src, /\.rl-tl-waiting \{ background:var\(--warning/);
  assert.match(src, /\.rl-wfs \{[^}]*height:6px; min-width:2px/);
  assert.match(src, /\.rl-wft \{[^}]*height:6px; border-radius:3px/);
  assert.match(src, /\.rl-wfd \{[^}]*width:48px; text-align:center; font-size:10\.5px[^}]*color:var\(--text-muted\)/);
  assert.match(src, /\.rl-wfc \{[^}]*gap:2px/);
});

test('a wide list gives Duration 180px for the waterfall; narrower keeps the old width', () => {
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /@container \(min-width:1100px\) \{\s*\.rl-table \{ --rl-cols:62px minmax\(0,1\.4fr\) minmax\(0,1\.5fr\) 150px 180px 62px 62px; \}/);
  assert.match(src, /\.rl-table\.rl-flatlist \{ --rl-cols:[^}]* 150px 180px 56px 60px; min-width:1160px; \}/);
  assert.match(src, /\.rl-table \{ --rl-cols:62px minmax\(0,1\.4fr\) minmax\(0,1\.5fr\) 150px 74px 62px 62px; \}/);
});
