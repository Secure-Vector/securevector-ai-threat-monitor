/**
 * The response rung marker check is the same in every Guard hook that has
 * it: same answers on the same cases, and the marker row is never a rule.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const HOOKS = ['claude-code', 'codex', 'copilot-cli', 'antigravity'].map((name) => [
  name, require(`../../../../src/securevector/plugins/${name}/hooks/pre-tool-use.js`),
]);

const MARKER = {
  tool_id: 'rung step-up marker', effect: 'marker', source: 'rung_marker', session_id: 's1',
  step_up: { paths: ['/.ssh/'], env_keys: ['VAULT_TOKEN'], known_tools: ['read', 'srv:x'], granted: ['srv:ok'] },
};

const CASES = [
  [['Read', { file_path: '/u/.ssh/id' }, false], 'sensitive_path'],
  [['Read', { file_path: 'a.py' }, false], null],
  [['Read', { env: { VAULT_TOKEN: '1' } }, false], 'sensitive_env'],
  [['mcp__evil__read', {}, false], 'new_tool'],
  [['mcp__srv__x', {}, false], null],
  [['mcp__srv__ok', {}, false], null],
  [['mcp__srv__new', {}, true], null],
  [['mcp__securevector__check_policy', {}, false], null],
];

for (const [name, hook] of HOOKS) {
  test(`${name}: marker cases`, () => {
    for (const [[tool, input, matched], want] of CASES) {
      assert.equal(hook.stepUpFromMarker(tool, input, MARKER, matched), want, `${tool}`);
    }
  });

  test(`${name}: the marker row is never a rule`, () => {
    const o = { synced: [MARKER] };
    assert.deepEqual(hook.decideFromOverrides(['rung step-up marker'], o, 's1'), { decision: 'allow' });
    assert.deepEqual(hook.decideFromOverrides(['x:_rung_step_up', '_rung_step_up'], o, 's1'),
      { decision: 'allow' });
  });
}
