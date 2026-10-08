// Codex PostToolUse: a failed tool call must be audited as a failure.
//
// Codex has no PostToolUseFailure event; the one PostToolUse carries the
// outcome inside tool_response. The app reads a "tool error" reason prefix as
// the failure marker (run_health.py, trace-steps.js), so a failed call that
// arrives without it renders as a success.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { audit, isToolFailure, TOOL_ERROR_REASON } =
  require('../../../../src/securevector/plugins/codex/hooks/post-tool-use.js');

function captureAudit(synced = []) {
  const posts = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.method === 'POST' && url.endsWith('/call-audit')) posts.push(JSON.parse(opts.body));
    if (opts && opts.method === 'POST') return new Response('{}');
    return new Response(JSON.stringify({ synced, total: synced.length }));
  };
  return { posts, restore: () => { globalThis.fetch = original; } };
}

// Fixture: a failed Codex shell call, in the model-facing text form.
const FAILED_SHELL = {
  hook_event_name: 'PostToolUse',
  session_id: 'codex-sess-1',
  tool_name: 'Bash',
  tool_use_id: 'call_1',
  tool_input: { command: 'ls /does-not-exist' },
  tool_response: 'Exit code: 2\nWall time: 0.1 seconds\nOutput:\nls: /does-not-exist: No such file or directory\n',
};

test('a failed Codex shell call is audited as a tool error', async () => {
  const { posts, restore } = captureAudit();
  try {
    await audit(FAILED_SHELL, 'http://127.0.0.1:8741');
    await new Promise(r => setTimeout(r, 5));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].reason, TOOL_ERROR_REASON);
    assert.ok(/^tool error\b/.test(posts[0].reason), 'the app reads this prefix as a failure');
    assert.equal(posts[0].action, 'allow');
    assert.equal(posts[0].session_id, 'codex-sess-1');
  } finally { restore(); }
});

test('a successful Codex shell call carries no error marker', async () => {
  const { posts, restore } = captureAudit();
  try {
    await audit({ ...FAILED_SHELL, tool_response: 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\nok\n' }, 'http://127.0.0.1:8741');
    await new Promise(r => setTimeout(r, 5));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].reason, null);
  } finally { restore(); }
});

test('the error marker keeps the policy reason behind it', async () => {
  const { posts, restore } = captureAudit([{ tool_id: 'Bash', effect: 'allow', reason: 'synced allow' }]);
  try {
    await audit(FAILED_SHELL, 'http://127.0.0.1:8741');
    await new Promise(r => setTimeout(r, 5));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].tool_id, 'Bash');
    assert.equal(posts[0].reason, 'tool error; synced allow');
  } finally { restore(); }
});

test('failure shapes Codex sends are recognised', () => {
  assert.ok(isToolFailure({ isError: true, content: [{ type: 'text', text: 'boom' }] }), 'MCP CallToolResult');
  assert.ok(isToolFailure({ exit_code: 1, stdout: '' }));
  assert.ok(isToolFailure({ exitCode: 127 }));
  assert.ok(isToolFailure({ output: 'x', metadata: { exit_code: 1, duration_seconds: 0.2 } }));
  assert.ok(isToolFailure(JSON.stringify({ output: 'x', metadata: { exit_code: 3 } })));
  assert.ok(isToolFailure('Chunk ID: a1\nWall time: 0.2 seconds\nProcess exited with code 1\nOutput:\nerr\n'));
  assert.ok(isToolFailure({ success: false }));
});

test('success and output text that only looks like a failure are not failures', () => {
  assert.equal(isToolFailure(null), false);
  assert.equal(isToolFailure({ stdout: 'hello' }), false);
  assert.equal(isToolFailure({ isError: false, content: [] }), false);
  assert.equal(isToolFailure({ exit_code: 0 }), false);
  assert.equal(isToolFailure({ output: 'x', metadata: { exit_code: 0 } }), false);
  // The command's own output says "Exit code: 1"; only the header counts.
  assert.equal(isToolFailure('Exit code: 0\nWall time: 0 seconds\nOutput:\nExit code: 1\n'), false);
  assert.equal(isToolFailure('plain output mentioning Exit code: 9 inline'), false);
  // No "Output:" line means no header: a body that says "Exit code: 1" on a
  // line of its own (an MCP text result, a file read) is not a failure.
  assert.equal(isToolFailure('build log\nExit code: 1\nretrying\n'), false);
  assert.equal(isToolFailure('Exit code: 1'), false);
  assert.equal(isToolFailure({ output: 'notes.txt:\nProcess exited with code 3\n' }), false);
});
