/** window.TraceSteps (js/components/trace-steps.js): the step grouping, bar
 * maths, chip state and markup shared by Agent Sessions and the Traces page,
 * loaded on its own in a vm sandbox and driven directly. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

function load() {
  const sandbox = { window: {} };
  vm.runInNewContext(read('js/components/trace-steps.js'), sandbox);
  return sandbox.window.TraceSteps;
}
const plain = (v) => JSON.parse(JSON.stringify(v));

const T0 = Date.parse('2026-09-20T10:00:00Z');
const at = (ms) => new Date(T0 + ms).toISOString();
const gen = (id, ms, dur, extra = {}) => Object.assign({ span_kind: 'generation', span_id: id, called_at: at(ms), duration_ms: dur }, extra);
const call = (name, ms, extra = {}) => Object.assign({ span_kind: 'tool_call', function_name: name, action: 'allow', called_at: at(ms) }, extra);
const names = (steps) => plain(steps.map(s => s.tools.map(t => t.function_name)));

test('module: constants and no page dependency', () => {
  const TS = load();
  assert.strictEqual(TS.STEPS_CHIPS_MAX, 8);
  assert.strictEqual(TS.STEPS_FLAT_GAP_MS, 60000);
  assert.strictEqual(TS.STEPS_TOOL_CAP_MS, 300000);
  for (const fn of ['build', 'barWidths', 'maxTotal', 'fmtDur', 'durText', 'chipState', 'chipKeys', 'approvalFor', 'html', 'records']) {
    assert.strictEqual(typeof TS[fn], 'function', fn);
  }
});

test('build: parent_span_id first, then the latest preceding generation, then a leading step', () => {
  const TS = load();
  const steps = TS.build([
    call('Read', -2000), gen('g1', 0, 1000), gen('g2', 5000, 1000),
    call('Bash', 2000, { parent_span_id: 'g1' }), call('Grep', 6000, { parent_span_id: 'g1' }), call('Edit', 7000),
  ]);
  assert.strictEqual(steps.length, 3);
  assert.strictEqual(steps[0].leading, true);
  assert.deepStrictEqual(names(steps), [['Read'], ['Bash', 'Grep'], ['Edit']]);
});

test('build: no generations split on a pause over 60 s; boundary markers excluded unless refused', () => {
  const TS = load();
  const steps = TS.build([call('a', 0), call('b', 30000), call('c', 100000), call('__session_end__', 100500)]);
  assert.deepStrictEqual(names(steps), [['a', 'b'], ['c']]);
  assert.ok(steps.every(s => s.flat));
  const kept = TS.build([call('__session_start__', 0, { action: 'block' }), call('bash', 10)]);
  assert.strictEqual(kept[0].tools.length, 2);
});

test('build: model time, tool time, estimated durations and the 5 minute cap', () => {
  const TS = load();
  const s = TS.build([gen('g1', 0, 1000), call('Bash', 1500), gen('g2', 4000, 500, { turn_start: 'tool_result' })]);
  assert.strictEqual(s[0].model, 1000);
  assert.strictEqual(s[0].tool, 3000);
  const est = TS.build([gen('g1', 5000, 2000, { duration_estimated: true }), call('Bash', 6000), gen('g2', 10000, 1000, { duration_estimated: true, turn_start: 'tool_result' })]);
  assert.strictEqual(est[0].tool, 4000, 'tool time runs from called_at to the next model start');
  const capped = TS.build([gen('g1', 0, 2000), call('Bash', 2500), gen('g2', 20 * 60 * 1000, 1000, { turn_start: 'tool_result' })]);
  assert.strictEqual(capped[0].tool, 300000);
  assert.strictEqual(capped[0].capped, true);
  assert.strictEqual(TS.durText(capped[0]), '2 s + ≥5 m');
  const unknown = TS.build([gen('g1', 0, null), call('Bash', 3000)]);
  assert.strictEqual(unknown[0].step, 3000);
  assert.strictEqual(unknown[0].tool, null);
});

test('barWidths, fmtDur, chipState, chipKeys, approvalFor', () => {
  const TS = load();
  assert.deepStrictEqual(plain(TS.barWidths({ model: 10, tool: 0 }, 100000)), { model: 3, tool: 0, step: 0 });
  assert.deepStrictEqual(plain(TS.barWidths({ model: 100000 }, 100000)), { model: 64, tool: 0, step: 0 });
  assert.strictEqual(TS.fmtDur(450), '450 ms');
  assert.strictEqual(TS.fmtDur(65000), '1 m 5 s');
  assert.strictEqual(TS.fmtDur(-1), '');
  assert.strictEqual(TS.chipState({ action: 'block' }), 'blocked');
  assert.strictEqual(TS.chipState({ action: 'log_only' }), 'flagged');
  assert.strictEqual(TS.chipState({ action: 'allow', detection_rules: ['r'] }), 'flagged');
  assert.strictEqual(TS.chipState({ action: 'allow' }), 'allowed');
  const keys = TS.chipKeys([{ tools: [call('Bash', 0), call('Bash', 0), call('Read', 0, { span_id: 'x' })] }]);
  assert.deepStrictEqual(plain(keys), [[`k:${at(0)}|Bash|0`, `k:${at(0)}|Bash|1`, 's:x']]);
  const span = call('WebFetch', 0, { tool_id: 'web_fetch', action: 'block' });
  assert.ok(TS.approvalFor(span, [{ tool_id: 'web_fetch', trace_id: 't1' }], 't1'));
  assert.strictEqual(TS.approvalFor(span, [{ tool_id: 'web_fetch', trace_id: 't2' }], 't1'), null);
});

test('html: terminals prefix by default, trace-steps prefix on request', () => {
  const TS = load();
  const spans = [gen('g1', 0, 100), call('Bash', 50), call('WebFetch', 60, { action: 'block', span_id: 'w' })];
  const a = TS.html('t1', { spans });
  assert.match(a, /class="terminals-steps-chip terminals-steps-chip-blocked"/);
  assert.match(a, /See full run/);
  const b = TS.html('t1', { spans }, { prefix: 'trace-steps', fullRunLabel: '', jumpLabel: 'View in timeline', modelLabel: 'Model thinking' });
  assert.ok(!b.includes('terminals-steps'), 'no terminals classes with the trace-steps prefix');
  assert.match(b, /class="trace-steps-chip trace-steps-chip-blocked"/);
  assert.ok(!b.includes('See full run'), 'no foot button when fullRunLabel is empty');
  assert.match(b, /<button type="button" class="trace-steps-jump" data-trace-id="t1" data-step-key="s:w">View in timeline<\/button>/);
  assert.match(b, /Model thinking/);
});

test('html: 20 step cap, 8 chips, merged repeats', () => {
  const TS = load();
  const spans = [];
  for (let i = 0; i < 25; i++) spans.push(gen(`g${i}`, i * 2000, 500));
  for (let i = 0; i < 118; i++) spans.push(call('bash', 600 + i, { parent_span_id: 'g0' }));
  'abcdefghij'.split('').forEach((n, i) => spans.push(call(n, 700 + 118 + i, { parent_span_id: 'g1' })));
  spans.push(call('x', 900, { parent_span_id: 'g1', action: 'block' }));
  const html = TS.html('t1', { spans }, { prefix: 'trace-steps', stepsMax: 20, fullRunLabel: '' });
  assert.strictEqual((html.match(/class="trace-steps-row"/g) || []).length, 20);
  assert.match(html, /\+ 5 more steps<\/span>/);
  assert.match(html, />✓ bash ×118</);
  const step2 = html.split('class="trace-steps-row"')[2];
  assert.strictEqual((step2.match(/class="trace-steps-chip trace-steps-chip-/g) || []).length, 8);
  assert.match(step2, /✕ x</);
  assert.match(step2, /aria-label="3 more calls, see full run"[^>]*>\+3 more</);
});

test('html: every server string is escaped, attributes included', () => {
  const TS = load();
  const html = TS.html('t"1', { spans: [gen('g1', 0, 100), call('<img src=x>', 50, {
    action: 'block', span_id: '"><svg>', reason: '<script>alert(1)</script>', detection_rules: ['<b>r</b>'], args_preview: '<svg onload=1>',
  })] }, { prefix: 'trace-steps', jumpLabel: 'View in timeline' });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(!html.includes('<svg'));
  assert.ok(!html.includes('<b>r</b>'));
  assert.match(html, /data-trace-id="t&quot;1"/);
  assert.match(html, /data-step-key="s:&quot;&gt;&lt;svg&gt;"/);
});

test('records: the export shape mirrors the step list', () => {
  const TS = load();
  const spans = [
    gen('g1', 0, 1000, { duration_estimated: true }),
    call('bash', 1500), call('bash', 1600),
    call('WebFetch', 1700, { action: 'block', reason: 'Host not allowed', detection_rules: ['egress.deny'], args_preview: 'SECRET' }),
    call('Read', 1800, { action: 'log_only' }),
    gen('g2', 20 * 60 * 1000, 500, { turn_start: 'prompt' }),
  ];
  const rec = TS.records({ spans, started_at: at(0), ended_at: at(20 * 60 * 1000), generation_total_cost: 0.5 });
  assert.deepStrictEqual(plain(rec.summary), { took_ms: 1200000, steps: 2, blocked: 1, flagged: 1, cost: 0.5 });
  assert.deepStrictEqual(Object.keys(rec.steps[0]).sort(), ['index', 'model_estimated', 'model_ms', 'step_ms', 'tool_capped', 'tool_ms', 'tools', 'unchecked']);
  assert.strictEqual(rec.steps[0].index, 1);
  assert.strictEqual(rec.steps[0].model_estimated, true);
  assert.strictEqual(rec.steps[0].tool_ms, 1800, 'a prompt fed g2: tool time ends at the last call, the idle is not counted');
  assert.strictEqual(rec.steps[0].tool_capped, false);
  assert.strictEqual(rec.steps[1].tool_ms, null, 'no calls, no tool time');
  assert.deepStrictEqual(plain(rec.steps[0].tools), [
    { name: 'bash', count: 2, state: 'allowed', rule_ids: [], reason: null },
    { name: 'WebFetch', count: 1, state: 'blocked', rule_ids: ['egress.deny'], reason: 'Host not allowed' },
    { name: 'Read', count: 1, state: 'flagged', rule_ids: [], reason: null },
  ]);
  assert.ok(!JSON.stringify(plain(rec)).includes('SECRET'), 'arguments never reach the export records');
  assert.strictEqual(TS.toolsText(rec.steps[0].tools), 'bash ×2, WebFetch (blocked), Read (flagged)');
});

test('the module is loaded before both pages that use it', () => {
  const html = read('index.html');
  const mod = html.indexOf('/js/components/trace-steps.js?v=');
  assert.ok(mod > 0);
  assert.ok(mod < html.indexOf('/js/pages/agent-runs.js?v='));
  assert.ok(mod < html.indexOf('/js/pages/terminals.js?v='));
});

test('CSS: .trace-steps-* aliases keep the muted bar hues and the focus ring', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.trace-steps \{[^}]*--steps-model:[^}]*--steps-tool:/);
  assert.match(css, /\[data-theme="light"\] \.trace-steps \{[^}]*--steps-model:/);
  assert.match(css, /\.trace-steps-seg-model \{[^}]*var\(--steps-model\)/);
  assert.match(css, /\.trace-steps-chip:focus-visible[^{]*\{[^}]*outline/);
  assert.match(css, /\.ar-timeline-toggle:focus-visible \{[^}]*outline/);
  // The terminals names still work.
  assert.match(css, /\.terminals-steps \{[^}]*--steps-model:/);
});

test('Codex: a hook row stamped to the whole second joins the model call that asked for it', () => {
  const TS = load();
  // Generations end at their token_usage_record (ms precision); the Guard
  // hook row for the call they made is stamped to the second.
  const spans = [
    gen('g1', 0, 2469, { called_at: '2026-09-24T19:26:12.156Z', duration_estimated: true, turn_start: 'prompt' }),
    gen('g2', 0, 973, { called_at: '2026-09-24T19:26:13.323Z', duration_estimated: true, turn_start: 'tool_result' }),
    { span_kind: 'tool_call', function_name: 'Bash', action: 'allow', called_at: '2026-09-24 19:26:12' },
  ];
  const steps = TS.build(spans);
  assert.strictEqual(steps.length, 2);
  assert.deepStrictEqual(names(steps), [['Bash'], []], 'Bash belongs to the call that ended at 12.156');
  assert.strictEqual(steps[0].tool, 194, 'from 12.156 to the next model start at 12.350');
  assert.strictEqual(steps[1].tool, null);
  assert.ok(!steps[0].leading);
  assert.strictEqual(TS.wholeSecond('2026-09-24 19:26:12'), true);
  assert.strictEqual(TS.wholeSecond('2026-09-24T19:26:12.156Z'), false);
});

test('a whole-second hook row never sorts past a generation in the same second', () => {
  const TS = load();
  // Two model calls end in the same second; the hook row (stamped 12) was
  // for the first one. A full 999 ms shift would carry it past the second.
  const spans = [
    gen('g1', 0, 500, { called_at: '2026-09-24T19:26:12.156Z', turn_start: 'prompt' }),
    gen('g2', 0, 300, { called_at: '2026-09-24T19:26:12.700Z', turn_start: 'tool_result' }),
    { span_kind: 'tool_call', function_name: 'Bash', action: 'allow', called_at: '2026-09-24 19:26:12' },
  ];
  assert.deepStrictEqual(names(TS.build(spans)), [['Bash'], []]);
  // With no generation left in that second, the full shift applies.
  const late = [gen('g1', 0, 500, { called_at: '2026-09-24T19:26:11.900Z' }),
    { span_kind: 'tool_call', function_name: 'Bash', action: 'allow', called_at: '2026-09-24 19:26:12' },
    gen('g2', 0, 300, { called_at: '2026-09-24T19:26:13.100Z' })];
  assert.deepStrictEqual(names(TS.build(late)), [['Bash'], []]);
});

test('unchecked: transcript calls with no governed span, matched by name and count', () => {
  const TS = load();
  const spans = [
    gen('g1', 0, 1000, { tool_use_names: ['Bash', 'Bash', 'Bash', 'Read'] }),
    call('Bash', 1500), call('Read', 1600),
    gen('g2', 5000, 1000, { tool_use_names: ['exec'] }),
    gen('g3', 9000, 1000, { tool_use_names: [] }),
  ];
  const steps = TS.build(spans);
  assert.deepStrictEqual(plain(steps[0].unchecked), [{ name: 'Bash', count: 2 }]);
  assert.deepStrictEqual(plain(steps[1].unchecked), [{ name: 'exec', count: 1 }]);
  assert.deepStrictEqual(plain(steps[2].unchecked), []);
  const html = TS.html('t1', { spans }, { prefix: 'trace-steps' });
  assert.match(html, /class="trace-steps-chip trace-steps-chip-unrecorded"[^>]*>Bash ×2 · not recorded</);
  assert.match(html, />✓ Bash</, 'the governed call keeps its own chip');
  assert.match(html, /trace-steps-chip-unrecorded[^>]*>exec · not recorded</);
  // "no tool calls" only for the step that truly made none.
  assert.strictEqual((html.match(/no tool calls/g) || []).length, 1);
  // Its detail line says only that.
  const open = TS.html('t1', { spans }, { prefix: 'trace-steps', detailKey: `u:g2|exec` });
  assert.match(open, /trace-steps-detail-unrecorded[\s\S]*SecureVector has no record of this call\. It may have run before the plugin was active, failed, or been cancelled\./);
});

test('unchecked chips: after blocked and flagged, before allowed, inside the 8 chip cap', () => {
  const TS = load();
  const spans = [gen('g1', 0, 100, { tool_use_names: ['x', 'y', 'a', 'b', 'c', 'd', 'e', 'f', 'u1', 'u2'] })];
  spans.push(call('x', 200, { action: 'block' }), call('y', 201, { action: 'log_only' }));
  'abcdef'.split('').forEach((n, i) => spans.push(call(n, 210 + i)));
  const html = TS.html('t1', { spans }, { prefix: 'trace-steps' });
  const chips = html.match(/class="trace-steps-chip trace-steps-chip-[a-z]+"[^>]*>[^<]*</g) || [];
  assert.strictEqual(chips.length, 8);
  assert.match(chips.join(''), /✕ x/);
  assert.match(chips.join(''), /! y/);
  assert.match(chips.join(''), /u1 · not recorded/);
  assert.match(chips.join(''), /u2 · not recorded/);
  // 4 allowed fit (a to d); e and f are the "+2 more".
  assert.match(html, />\+2 more</);
});

test('unchecked calls reach the export records and text', () => {
  const TS = load();
  const rec = TS.records({ spans: [gen('g1', 0, 100, { tool_use_names: ['Bash', 'Bash'] }), call('Bash', 50)] });
  assert.deepStrictEqual(plain(rec.steps[0].unchecked), [{ name: 'Bash', count: 1 }]);
  assert.strictEqual(TS.toolsText(rec.steps[0].tools, rec.steps[0].unchecked), 'Bash, Bash (not recorded)');
});

test('Codex coordination tools are never shown as not recorded; tools with side effects always are', () => {
  const TS = load();
  const coord = ['wait', 'wait_agent', 'send_message', 'list_agents', 'interrupt_agent', 'followup_task', 'update_plan', 'request_user_input_async'];
  const risky = ['Bash', 'exec', 'exec_command', 'shell', 'apply_patch', 'js', 'spawn_agent', 'Write', 'Edit', 'WebFetch'];
  for (const n of risky) assert.ok(!TS.UNCHECKED_IGNORE.includes(n), `${n} must never be ignored`);
  const steps = TS.build([gen('g1', 0, 100, { tool_use_names: coord.concat(['apply_patch']) })]);
  assert.deepStrictEqual(plain(steps[0].unchecked), [{ name: 'apply_patch', count: 1 }]);
  const quiet = TS.html('t1', { spans: [gen('g1', 0, 100, { tool_use_names: coord })] }, { prefix: 'trace-steps' });
  assert.ok(!quiet.includes('not recorded'));
});

test('an egress deny matched to a transcript call is a governed block, not "not recorded"', () => {
  const TS = load();
  const spans = [
    gen('g1', 0, 1000, { tool_use_names: ['WebFetch', 'Bash'], turn_start: 'prompt' }),
    call('Bash', 1500),
    gen('g2', 60000, 1000, { tool_use_names: [] }),
  ];
  const T = new Date(T0 + 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const detail = {
    spans, blocked: 0,
    egress_blocks: [
      { called_at: T, tool_name: 'WebFetch', hosts: ['evil.example'], rule_ids: ['egress.deny'] },
      // No matching call in the transcript: left out, never invented.
      { called_at: T, tool_name: 'Grep', hosts: ['other.example'], rule_ids: [] },
    ],
  };
  const steps = TS.build(spans, { egressBlocks: detail.egress_blocks });
  assert.deepStrictEqual(plain(steps[0].unchecked), []);
  const blocked = steps[0].tools.filter(t => TS.chipState(t) === 'blocked');
  assert.strictEqual(blocked.length, 1);
  assert.strictEqual(blocked[0].reason, 'destination not allowed: evil.example');
  const html = TS.html('t1', detail, { prefix: 'trace-steps' });
  assert.match(html, /trace-steps-chip-blocked[^>]*>✕ WebFetch</);
  assert.match(html, /Blocked: destination not allowed: evil\.example/);
  assert.match(html, /\(egress\.deny\)/);
  assert.ok(!html.includes('not recorded'));
  assert.ok(!html.includes('other.example'));
  assert.match(html, /1 blocked/);
  const rec = TS.records(detail);
  assert.deepStrictEqual(plain(rec.steps[0].tools.find(t => t.name === 'WebFetch')), { name: 'WebFetch', count: 1, state: 'blocked', rule_ids: ['egress.deny'], reason: 'destination not allowed: evil.example' });
  assert.strictEqual(rec.summary.blocked, 1);
});

test('Claude read-only and UI helpers are ignored; tools with effects never are', () => {
  const TS = load();
  const quiet = ['ToolSearch', 'AskUserQuestion', 'BashOutput', 'TaskOutput', 'TodoWrite', 'TodoRead', 'EnterPlanMode', 'ExitPlanMode'];
  for (const n of quiet) assert.ok(TS.UNCHECKED_IGNORE.includes(n), n);
  const effects = ['KillShell', 'KillBash', 'SlashCommand', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'Task', 'Agent', 'Skill', 'Monitor', 'EnterWorktree', 'ExitWorktree', 'NotebookEdit', 'MultiEdit', 'WebSearch', 'PowerShell'];
  for (const n of effects) assert.ok(!TS.UNCHECKED_IGNORE.includes(n), `${n} must never be ignored`);
  const steps = TS.build([gen('g1', 0, 100, { tool_use_names: quiet.concat(['Task']) })]);
  assert.deepStrictEqual(plain(steps[0].unchecked), [{ name: 'Task', count: 1 }]);
});

test('Codex MCP names match the governed span in either transcript form', () => {
  const TS = load();
  const span = call('mcp__github__create_issue', 500, { tool_id: 'github:create_issue' });
  for (const name of ['mcp__github__create_issue', 'github__create_issue']) {
    assert.ok(TS.sameTool(name, span), name);
    const steps = TS.build([gen('g1', 0, 100, { tool_use_names: [name, name] }), span]);
    assert.deepStrictEqual(plain(steps[0].unchecked), [{ name, count: 1 }], `one of two ${name} calls governed`);
  }
  assert.ok(!TS.sameTool('mcp__github__close_issue', span));
  assert.ok(!TS.sameTool('github__create', span));
});

test('an egress deny only matches the step whose window holds it, never an earlier one', () => {
  const TS = load();
  const spans = [
    gen('g1', 0, 500, { tool_use_names: [] }),
    gen('g2', 10000, 500, { tool_use_names: ['Bash'] }), // Bash interrupted: no span
    gen('g3', 20000, 500, { tool_use_names: [] }),
    gen('g4', 30000, 500, { tool_use_names: [] }),
    gen('g5', 40000, 500), // no tool_use_names (proxy measured)
  ];
  const T = new Date(T0 + 41000).toISOString();
  const steps = TS.build(spans, { egressBlocks: [{ called_at: T, tool_name: 'Bash', hosts: ['evil.example'], rule_ids: [] }] });
  assert.deepStrictEqual(plain(steps[1].unchecked), [{ name: 'Bash', count: 1 }], 'step 2 stays not recorded');
  assert.ok(steps.every(s => s.tools.every(t => !t.egress)), 'the deny is left unmatched');
});

test('summary: egress_blocked from the server is added once, matched or not', () => {
  const TS = load();
  const T = new Date(T0 + 1000).toISOString();
  const spans = [gen('g1', 0, 1000, { tool_use_names: ['WebFetch'] }), call('Read', 1200)];
  const blocks = [{ called_at: T, tool_name: 'WebFetch', hosts: ['evil.example'] }];
  // Matched to the call: one block, not two.
  assert.strictEqual(TS.summary({ spans, blocked: 0, egress_blocked: 1, egress_blocks: blocks }).blocked, 1);
  // Not matched (no transcript name): still one block, from the server count.
  assert.strictEqual(TS.summary({ spans: [gen('g1', 0, 1000), call('Read', 1200)], blocked: 2, egress_blocked: 1, egress_blocks: blocks }).blocked, 3);
});
