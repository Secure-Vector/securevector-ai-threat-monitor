'use strict';

// Named call-time rule "Outside content, then credential or network": the
// app sends a verified session in On mode a marker row carrying the
// credential paths and keys, with no tool-novelty check and no grants. The
// Guard holds a credential read it matches through the usual request flow.

const test = require('node:test');
const assert = require('node:assert/strict');

const { decide, stepUpFromMarker } = require(
  '../../../../src/securevector/plugins/claude-code/hooks/pre-tool-use.js');

const HOLD = 'Held: this session read outside content, then reached for a credential. '
  + 'Approve it in Approvals to continue.';

function ruleMarker(sessionId = 's1') {
  return {
    tool_id: 'rung step-up marker', effect: 'marker', priority: 0, source: 'rung_marker',
    session_id: sessionId, reason: HOLD, rule: 'outside_then_reach',
    step_up: { paths: ['/.ssh/', '/.aws/credentials'], env_keys: ['AWS_SECRET_ACCESS_KEY'],
      known_tools: null, granted: [] },
  };
}

function stubFetch(stub) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return () => { globalThis.fetch = original; };
}

function respond(rows) {
  return async () => new Response(JSON.stringify({ synced: rows, total: rows.length }), { status: 200 });
}

test('rule marker: a credential path or key is held, other reads and unseen tools are not', () => {
  assert.equal(stepUpFromMarker('Read', { file_path: '/Users/u/.aws/credentials' }, ruleMarker(), false),
    'sensitive_path');
  assert.equal(stepUpFromMarker('Edit', { new_string: 'AWS_SECRET_ACCESS_KEY=x' }, ruleMarker(), false),
    'sensitive_env');
  assert.equal(stepUpFromMarker('Read', { file_path: 'src/a.py' }, ruleMarker(), false), null);
  assert.equal(stepUpFromMarker('mcp__srv__never_seen', {}, ruleMarker(), false), null);
  assert.equal(stepUpFromMarker('mcp__securevector__check_policy', { p: '/.ssh/' }, ruleMarker(), false), null);
});

test('decide: a credential read under the rule marker is a requestable deny naming the rule', async () => {
  const restore = stubFetch(respond([ruleMarker()]));
  try {
    const held = await decide('Read', 'http://127.0.0.1:8741', 's1', { file_path: '/home/u/.ssh/id_rsa' });
    assert.equal(held.decision, 'deny');
    assert.equal(held.requestable, true);
    assert.equal(held.reason, HOLD);
    const fine = await decide('Read', 'http://127.0.0.1:8741', 's1', { file_path: 'src/a.py' });
    assert.deepEqual(fine, { decision: 'allow' });
  } finally { restore(); }
});

test('decide: an earlier approval for the tool does not lift a re-armed rule marker', async () => {
  const grant = { tool_id: 'read', effect: 'allow', source: 'jit_grant', session_id: 's1' };
  const restore = stubFetch(respond([grant, ruleMarker()]));
  try {
    const held = await decide('Read', 'http://127.0.0.1:8741', 's1', { file_path: '/home/u/.ssh/id_rsa' });
    assert.equal(held.decision, 'deny');
  } finally { restore(); }
});

test('overrides fetch binds the session with the task id and hook token', async () => {
  const seen = [];
  const restore = stubFetch(async (url, opts) => {
    seen.push({ url, headers: (opts && opts.headers) || {} });
    return new Response(JSON.stringify({ synced: [], total: 0 }), { status: 200 });
  });
  const saved = { task: process.env.SV_TERMINAL_TASK_ID, token: process.env.SV_TERMINAL_HOOK_TOKEN };
  process.env.SV_TERMINAL_TASK_ID = 'task-1';
  process.env.SV_TERMINAL_HOOK_TOKEN = 'tok-1';
  try {
    await decide('Read', 'http://127.0.0.1:8741', 's1', { file_path: 'src/a.py' });
    const get = seen.find((s) => String(s.url).includes('/synced-overrides'));
    assert.ok(get);
    assert.equal(get.headers['x-sv-terminal-task'], 'task-1');
    assert.equal(get.headers['x-sv-terminal-hook'], 'tok-1');
  } finally {
    restore();
    if (saved.task === undefined) delete process.env.SV_TERMINAL_TASK_ID; else process.env.SV_TERMINAL_TASK_ID = saved.task;
    if (saved.token === undefined) delete process.env.SV_TERMINAL_HOOK_TOKEN; else process.env.SV_TERMINAL_HOOK_TOKEN = saved.token;
  }
});

test('request post can carry the session binding headers', async () => {
  const { postJsonAndForget, terminalHeaderFields } = require(
    '../../../../src/securevector/plugins/claude-code/lib/client.js');
  let seen = null;
  const restore = stubFetch(async (url, opts) => { seen = opts.headers; return new Response('{}'); });
  const saved = { task: process.env.SV_TERMINAL_TASK_ID, token: process.env.SV_TERMINAL_HOOK_TOKEN };
  process.env.SV_TERMINAL_TASK_ID = 'task-2';
  process.env.SV_TERMINAL_HOOK_TOKEN = 'tok-2';
  try {
    postJsonAndForget('http://127.0.0.1:8741/api/jit/requests', { tool_id: 'read' }, terminalHeaderFields());
    await new Promise((r) => setImmediate(r));
    assert.equal(seen['x-sv-terminal-task'], 'task-2');
    assert.equal(seen['x-sv-terminal-hook'], 'tok-2');
    assert.equal(seen['content-type'], 'application/json');
  } finally {
    restore();
    if (saved.task === undefined) delete process.env.SV_TERMINAL_TASK_ID; else process.env.SV_TERMINAL_TASK_ID = saved.task;
    if (saved.token === undefined) delete process.env.SV_TERMINAL_HOOK_TOKEN; else process.env.SV_TERMINAL_HOOK_TOKEN = saved.token;
  }
});
