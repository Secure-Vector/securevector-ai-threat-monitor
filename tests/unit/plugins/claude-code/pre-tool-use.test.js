/**
 * Tests for the PreToolUse hook handler.
 *
 * Effect → permissionDecision mapping (locked):
 *   allow  → permissionDecision: "allow"
 *   deny   → permissionDecision: "deny"
 *   prompt → permissionDecision: "ask"
 *
 * Fail-open invariant: every error path returns { permissionDecision: "allow" }.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decideFromOverrides,
  decide,
} = require('../../../../src/securevector/plugins/claude-code/hooks/pre-tool-use.js');


// --- decideFromOverrides (pure) ---


test('allows when overrides is empty', () => {
  assert.deepEqual(
    decideFromOverrides(['srv:tool_a', 'tool_a'], { synced: [], total: 0 }),
    { permissionDecision: 'allow' },
  );
});


test('allows when no candidate matches', () => {
  const overrides = {
    synced: [
      { tool_id: 'srv:other_tool', effect: 'deny', reason: 'unrelated' },
    ],
    total: 1,
  };
  assert.deepEqual(
    decideFromOverrides(['srv:tool_a', 'tool_a'], overrides),
    { permissionDecision: 'allow' },
  );
});


test('denies when prefixed candidate matches with effect=deny', () => {
  const overrides = {
    synced: [
      { tool_id: 'srv:tool_a', effect: 'deny', reason: 'blocked by policy X' },
    ],
    total: 1,
  };
  const result = decideFromOverrides(['srv:tool_a', 'tool_a'], overrides);
  assert.equal(result.permissionDecision, 'deny');
  assert.match(result.message, /blocked by policy X/);
});


test('denies when bare-tool fallback candidate matches', () => {
  // The server endpoint aliases `srv:foo` to bare `foo`. Either should match.
  const overrides = {
    synced: [
      { tool_id: 'tool_a', effect: 'deny', reason: 'bare match' },
    ],
    total: 1,
  };
  const result = decideFromOverrides(['srv:tool_a', 'tool_a'], overrides);
  assert.equal(result.permissionDecision, 'deny');
  assert.match(result.message, /bare match/);
});


test('maps effect=allow → permissionDecision allow', () => {
  const overrides = {
    synced: [{ tool_id: 'srv:tool_a', effect: 'allow', reason: 'explicitly allowed' }],
    total: 1,
  };
  assert.equal(
    decideFromOverrides(['srv:tool_a', 'tool_a'], overrides).permissionDecision,
    'allow',
  );
});


test('maps effect=prompt → permissionDecision ask', () => {
  const overrides = {
    synced: [{ tool_id: 'srv:tool_a', effect: 'prompt', reason: 'needs confirmation' }],
    total: 1,
  };
  const result = decideFromOverrides(['srv:tool_a', 'tool_a'], overrides);
  assert.equal(result.permissionDecision, 'ask');
  assert.match(result.message, /needs confirmation/);
});


test('prefixed candidate wins over bare-tool candidate (priority order)', () => {
  // If BOTH are in the overrides with conflicting effects, the prefixed
  // form (server:tool) wins because it is more specific.
  const overrides = {
    synced: [
      { tool_id: 'tool_a', effect: 'allow', reason: 'bare allow' },
      { tool_id: 'srv:tool_a', effect: 'deny', reason: 'prefixed deny wins' },
    ],
    total: 2,
  };
  const result = decideFromOverrides(['srv:tool_a', 'tool_a'], overrides);
  assert.equal(result.permissionDecision, 'deny');
  assert.match(result.message, /prefixed deny wins/);
});


test('allows when candidates is empty (built-in tool, normalize returned [])', () => {
  const overrides = {
    synced: [{ tool_id: 'Bash', effect: 'deny', reason: 'built-in deny' }],
    total: 1,
  };
  // candidates=[] short-circuits before any lookup — built-in enforcement deferred (v1).
  assert.deepEqual(
    decideFromOverrides([], overrides),
    { permissionDecision: 'allow' },
  );
});


test('allows on malformed overrides (no synced array)', () => {
  assert.deepEqual(
    decideFromOverrides(['srv:tool_a', 'tool_a'], {}),
    { permissionDecision: 'allow' },
  );
  assert.deepEqual(
    decideFromOverrides(['srv:tool_a', 'tool_a'], null),
    { permissionDecision: 'allow' },
  );
});


test('allows on unknown effect value (defensive)', () => {
  const overrides = {
    synced: [{ tool_id: 'srv:tool_a', effect: 'something_else', reason: 'x' }],
    total: 1,
  };
  // Unknown effect = fail-open allow rather than guess.
  assert.equal(
    decideFromOverrides(['srv:tool_a', 'tool_a'], overrides).permissionDecision,
    'allow',
  );
});


// --- decide (integration with client.getJson via globalThis.fetch stub) ---


function stubFetch(stub) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return () => { globalThis.fetch = original; };
}


test('decide: built-in tool → allow without calling fetch', async () => {
  let called = false;
  const restore = stubFetch(async () => { called = true; return new Response('{}'); });
  try {
    const result = await decide('Bash', 'http://127.0.0.1:8741');
    assert.deepEqual(result, { permissionDecision: 'allow' });
    assert.equal(called, false, 'no fetch call for built-in tool');
  } finally { restore(); }
});


test('decide: MCP tool with matching deny rule → deny with reason', async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify({
    synced: [{ tool_id: 'server-slack:slack_post_message', effect: 'deny', reason: 'policy block' }],
    total: 1,
  }), { status: 200 }));
  try {
    const result = await decide('mcp__server-slack__slack_post_message', 'http://127.0.0.1:8741');
    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.message, /policy block/);
  } finally { restore(); }
});


test('decide: local app unreachable (fetch throws) → fail-open allow', async () => {
  const restore = stubFetch(async () => { throw new TypeError('fetch failed'); });
  try {
    const result = await decide('mcp__server-slack__slack_post_message', 'http://127.0.0.1:8741');
    assert.deepEqual(result, { permissionDecision: 'allow' });
  } finally { restore(); }
});


test('decide: 500 from local app → fail-open allow', async () => {
  const restore = stubFetch(async () => new Response('boom', { status: 500 }));
  try {
    const result = await decide('mcp__server-slack__slack_post_message', 'http://127.0.0.1:8741');
    assert.deepEqual(result, { permissionDecision: 'allow' });
  } finally { restore(); }
});


// --- client.fetchSyncedOverrides (added in this task) ---


test('client.fetchSyncedOverrides issues GET to /api/tool-permissions/synced-overrides', async () => {
  const { fetchSyncedOverrides } = require('../../../../src/securevector/plugins/claude-code/lib/client.js');
  let capturedUrl;
  const restore = stubFetch(async (url) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ synced: [], total: 0 }), { status: 200 });
  });
  try {
    const result = await fetchSyncedOverrides('http://127.0.0.1:8741');
    assert.equal(capturedUrl, 'http://127.0.0.1:8741/api/tool-permissions/synced-overrides');
    assert.deepEqual(result, { synced: [], total: 0 });
  } finally { restore(); }
});
