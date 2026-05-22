/**
 * Tests for the fetch wrapper used by the Guard plugin hooks.
 *
 * Invariants under test:
 *   - getJson returns parsed JSON on 2xx
 *   - getJson returns {} on every error path (4xx, 5xx, timeout, network, malformed JSON)
 *   - postJsonAndForget never throws and returns synchronously
 *   - Default timeout is 100ms (locked decision #5: fail-open)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getJson,
  postJsonAndForget,
  DEFAULT_TIMEOUT_MS,
} = require('../../../../src/securevector/plugins/claude-code/lib/client.js');


function stubFetch(stub) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return () => { globalThis.fetch = original; };
}


test('default timeout is 100ms', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 100);
});


test('getJson returns parsed JSON on 2xx', async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify({ ok: true, rules: [1, 2] }), { status: 200 }));
  try {
    const result = await getJson('http://x/y');
    assert.deepEqual(result, { ok: true, rules: [1, 2] });
  } finally { restore(); }
});


test('getJson returns {} on non-2xx', async () => {
  for (const status of [400, 401, 403, 404, 500, 502, 503]) {
    const restore = stubFetch(async () => new Response('{}', { status }));
    try {
      assert.deepEqual(await getJson('http://x/y'), {}, `status ${status}`);
    } finally { restore(); }
  }
});


test('getJson returns {} on network error', async () => {
  const restore = stubFetch(async () => { throw new TypeError('fetch failed'); });
  try {
    assert.deepEqual(await getJson('http://x/y'), {});
  } finally { restore(); }
});


test('getJson returns {} on malformed JSON', async () => {
  const restore = stubFetch(async () => new Response('not-json', { status: 200 }));
  try {
    assert.deepEqual(await getJson('http://x/y'), {});
  } finally { restore(); }
});


test('getJson aborts after the configured timeout and returns {}', async () => {
  // Stub fetch to hang until aborted, then reject like real fetch does.
  const restore = stubFetch((url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }));
  try {
    const start = Date.now();
    const result = await getJson('http://x/y', { timeoutMs: 20 });
    const elapsed = Date.now() - start;
    assert.deepEqual(result, {});
    // Allow loose upper bound; the point is it didn't hang.
    assert.ok(elapsed < 200, `elapsed=${elapsed}ms should be well under 200ms`);
  } finally { restore(); }
});


test('getJson honours an explicit timeout option', async () => {
  let capturedSignal;
  const restore = stubFetch(async (url, opts) => {
    capturedSignal = opts.signal;
    return new Response(JSON.stringify({}), { status: 200 });
  });
  try {
    await getJson('http://x/y', { timeoutMs: 250 });
    assert.ok(capturedSignal instanceof AbortSignal);
  } finally { restore(); }
});


test('postJsonAndForget sends a POST with JSON body and content-type', async () => {
  let captured;
  const restore = stubFetch(async (url, opts) => {
    captured = { url, opts };
    return new Response('{}', { status: 200 });
  });
  try {
    postJsonAndForget('http://x/audit', { tool_id: 'svr:a', action: 'allow' });
    // Give the fire-and-forget call a tick to run.
    await new Promise(r => setImmediate(r));
    assert.equal(captured.url, 'http://x/audit');
    assert.equal(captured.opts.method, 'POST');
    assert.equal(captured.opts.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(captured.opts.body), { tool_id: 'svr:a', action: 'allow' });
  } finally { restore(); }
});


test('postJsonAndForget swallows rejected fetch', async () => {
  const restore = stubFetch(async () => { throw new TypeError('fetch failed'); });
  try {
    // Should NOT throw, NOT raise an unhandled rejection.
    postJsonAndForget('http://x/audit', { any: 'payload' });
    await new Promise(r => setImmediate(r));
  } finally { restore(); }
});


test('postJsonAndForget swallows synchronous throws from fetch construction', () => {
  const restore = stubFetch(() => { throw new Error('synchronous boom'); });
  try {
    // Must NOT throw — caller can rely on this never raising.
    postJsonAndForget('http://x/audit', { any: 'payload' });
  } finally { restore(); }
});


test('postJsonAndForget returns undefined immediately (synchronous return)', () => {
  const restore = stubFetch(async () => new Response('{}', { status: 200 }));
  try {
    const ret = postJsonAndForget('http://x/audit', {});
    assert.equal(ret, undefined);
  } finally { restore(); }
});
