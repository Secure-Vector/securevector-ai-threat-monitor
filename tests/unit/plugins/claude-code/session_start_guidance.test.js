// SPDX-License-Identifier: Apache-2.0
'use strict';

// The one session-start line naming the SecureVector check_policy tool:
// on by default, off with SECUREVECTOR_MCP_GUIDANCE_LINE=0, and only when the
// local app answered.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const hook = require(path.resolve(__dirname, '../../../../src/securevector/plugins/claude-code/hooks/session-start.js'));

test('guidance line is sent by default when the app is reachable and the tools are registered', () => {
  const out = hook.buildSessionStartOutput(true, {}, true);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(out.hookSpecificOutput.additionalContext, hook.MCP_GUIDANCE_LINE);
  assert.match(hook.MCP_GUIDANCE_LINE, /check_policy/);
  assert.match(hook.MCP_GUIDANCE_LINE, /deny means do not attempt/);
  assert.ok(!hook.MCP_GUIDANCE_LINE.includes('\u2014'));
});

test('flag off or app unreachable: no context is added', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    const out = hook.buildSessionStartOutput(true, { SECUREVECTOR_MCP_GUIDANCE_LINE: v });
    assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'SessionStart' } });
  }
  assert.deepEqual(hook.buildSessionStartOutput(false, {}),
    { hookSpecificOutput: { hookEventName: 'SessionStart' } });
  assert.equal(hook.mcpGuidanceEnabled({ SECUREVECTOR_MCP_GUIDANCE_LINE: '1' }), true);
});

test('no guidance line when the MCP entry is not registered for Claude Code', () => {
  assert.deepEqual(hook.buildSessionStartOutput(true, {}, false),
    { hookSpecificOutput: { hookEventName: 'SessionStart' } });
  assert.equal(hook.mcpRegistered({ harnesses: { 'claude-code': { state: 'registered' } } }), true);
  for (const state of ['not_registered', 'unavailable', 'other_entry']) {
    assert.equal(hook.mcpRegistered({ harnesses: { 'claude-code': { state } } }), false);
  }
  assert.equal(hook.mcpRegistered({}), false);
  assert.equal(hook.mcpRegistered(null), false);
});
