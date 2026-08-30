'use strict';

// Per-run limits (#203) — plugin-side behaviour: the wildcard run-limit deny
// row outranks tool-specific rules in every deny-capable runtime, the session
// travels on the decision path, and the Cost Settings card exists with its
// honesty copy (off by default, OpenClaw carve-out, proxy dependency stated).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PLUGINS = path.join(ROOT, 'src', 'securevector', 'plugins');
const WEB = path.join(ROOT, 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(p, 'utf8');

const cc = require(path.join(PLUGINS, 'claude-code', 'hooks', 'pre-tool-use.js'));
const codex = require(path.join(PLUGINS, 'codex', 'hooks', 'pre-tool-use.js'));
const copilot = require(path.join(PLUGINS, 'copilot-cli', 'hooks', 'pre-tool-use.js'));
const cursor = require(path.join(PLUGINS, 'cursor', 'lib', 'decide.js'));

const RUN_ROW = {
  tool_id: '*', effect: 'deny', priority: 200, policy_id: '_run_limit',
  policy_name: 'Per-run limit', source: 'run_limit',
  reason: 'Per-run tool-call cap: this session has made 50 tool calls (limit 50). Approve continuation under Cost Settings to resume.',
  requestable: false,
};

for (const [name, mod] of [['claude-code', cc], ['codex', codex], ['copilot-cli', copilot], ['cursor', cursor]]) {
  test(`${name}: wildcard run-limit deny stops any tool`, () => {
    const d = mod.decideFromOverrides(['Bash'], { synced: [RUN_ROW] });
    assert.equal(d.decision, 'deny');
    assert.match(d.reason, /Per-run tool-call cap/);
    assert.equal(d.toolId, 'Bash'); // audited under the real tool, not '*'
  });

  test(`${name}: a tool-specific allow cannot bypass a run stop`, () => {
    const allowRow = { tool_id: 'Bash', effect: 'allow', source: 'local' };
    const d = mod.decideFromOverrides(['Bash'], { synced: [allowRow, RUN_ROW] });
    assert.equal(d.decision, 'deny');
  });

  test(`${name}: no wildcard row means unchanged behaviour`, () => {
    const d = mod.decideFromOverrides(['Bash'], {
      synced: [{ tool_id: 'Read', effect: 'deny', source: 'local' }],
    });
    assert.equal(d.decision, 'allow');
  });

  test(`${name}: a stray wildcard allow fails open, never denies`, () => {
    const d = mod.decideFromOverrides(['Bash'], {
      synced: [{ tool_id: '*', effect: 'allow', source: 'run_limit' }],
    });
    assert.equal(d.decision, 'allow');
  });
}

test('all four clients send the session on the decision path', () => {
  for (const p of ['claude-code', 'codex', 'copilot-cli', 'cursor']) {
    const src = read(path.join(PLUGINS, p, 'lib', 'client.js'));
    assert.match(src, /session_id/, `${p} client must pass session_id`);
    assert.match(src, /opts\.sessionId/, `${p} client must read opts.sessionId`);
  }
  // and the decision call sites actually pass it
  for (const f of [
    path.join(PLUGINS, 'claude-code', 'hooks', 'pre-tool-use.js'),
    path.join(PLUGINS, 'codex', 'hooks', 'pre-tool-use.js'),
    path.join(PLUGINS, 'copilot-cli', 'hooks', 'pre-tool-use.js'),
    path.join(PLUGINS, 'cursor', 'lib', 'decide.js'),
  ]) {
    assert.match(read(f), /fetchSyncedOverrides\(baseUrl, RUNTIME_KIND, \{ sessionId \}\)/);
  }
});

test('cost settings carries the per-run limits card with the honesty copy', () => {
  const src = read(path.join(WEB, 'js', 'pages', 'costs.js'));
  assert.match(src, /_renderRunLimitsCard/);
  assert.match(src, /off by default/);
  assert.match(src, /OpenClaw cannot deny at the plugin layer/);
  assert.match(src, /without the proxy running they do not apply/);
  assert.match(src, /No control ever modifies a request or changes the model/);
  assert.match(src, /Allow run to continue/);
});

test('API client exposes the run-limit endpoints', () => {
  const src = read(path.join(WEB, 'js', 'api.js'));
  for (const m of ['getRunLimits', 'setRunLimits', 'getRunLimitStops', 'exemptRun']) {
    assert.match(src, new RegExp(m));
  }
});
