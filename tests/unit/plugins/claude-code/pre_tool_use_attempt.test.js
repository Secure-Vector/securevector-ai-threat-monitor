// SPDX-License-Identifier: Apache-2.0
'use strict';

// PreToolUse reports the calls the egress check did not see (name-based
// deny or ask, and calls that cannot reach the network) so the app can match
// them against pre-flight checks. It never changes the verdict.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../../../src/securevector/plugins/claude-code');
const hook = require(path.join(ROOT, 'hooks/pre-tool-use.js'));
const client = require(path.join(ROOT, 'lib/client.js'));

test('reported: file tools, name-based denies and asks', () => {
  assert.equal(hook.shouldReportAttempt('Read', { decision: 'allow' }), true);
  assert.equal(hook.shouldReportAttempt('Write', { decision: 'deny' }), true);
  assert.equal(hook.shouldReportAttempt('Bash', { decision: 'deny' }), true);
  assert.equal(hook.shouldReportAttempt('WebFetch', { decision: 'ask' }), true);
});

test('not reported: calls the egress check evaluated', () => {
  assert.equal(hook.shouldReportAttempt('Bash', { decision: 'allow' }), false);
  assert.equal(hook.shouldReportAttempt('mcp__s__t', { decision: 'allow' }), false);
  assert.equal(hook.shouldReportAttempt('Bash', { decision: 'deny', egress: true }), false);
  assert.equal(hook.shouldReportAttempt('', { decision: 'allow' }), false);
});

test('body carries the harness-native call and the decision', () => {
  const body = hook.buildAttemptBody('Write', { file_path: '/a', content: 'x' }, { decision: 'deny' }, 's-1');
  assert.deepEqual(body, {
    tool_name: 'Write', tool_input: { file_path: '/a', content: 'x' }, decision: 'deny',
    runtime_kind: 'claude-code', session_id: 's-1',
  });
  assert.deepEqual(hook.buildAttemptBody('Read', null, null, null).tool_input, {});
});

test('reportAttempt is fire-and-forget with a short timeout and a size cap', async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = (url, opts) => { calls.push({ url, opts }); return Promise.reject(new Error('down')); };
  try {
    assert.equal(client.reportAttempt('http://127.0.0.1:8741', { tool_name: 'Read', tool_input: {} }), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:8741/api/policy/attempt');
    assert.equal(calls[0].opts.headers['content-type'], 'application/json');
    assert.ok(client.ATTEMPT_TIMEOUT_MS <= 150);
    const big = { tool_name: 'Write', tool_input: { content: 'x'.repeat(300 * 1024) } };
    assert.equal(client.reportAttempt('http://127.0.0.1:8741', big), false);
    assert.equal(calls.length, 1);
  } finally {
    global.fetch = realFetch;
  }
});
