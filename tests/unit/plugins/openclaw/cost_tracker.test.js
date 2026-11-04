// OpenClaw Guard cost tracker: llm_output records one cost row per run
// attempt, under agent id "openclaw" with the session key, the harness and
// a per-attempt request id.
//
// index.ts is loaded with Node's built-in type stripping, with ./config
// replaced by a stub and fetch replaced by a recorder.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const INDEX_TS = path.join(__dirname, '../../../../src/securevector/plugins/openclaw/index.ts');

function loadPlugin() {
  let src = stripTypeScriptTypes(fs.readFileSync(INDEX_TS, 'utf8'));
  src = src.replace(/import\s*\{[^}]*\}\s*from\s*["']\.\/config["'];?/, '');
  src = src.replace('export default', 'module.exports =');

  const posts = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (opts.method === 'POST') posts.push({ path: u.pathname, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({}) };
  };
  const sandbox = {
    module: { exports: {} },
    fetch, URL, AbortController, setTimeout, clearTimeout, JSON, Promise, Set, Map, String,
    process: { env: {} },
    console: { log() {}, warn() {} },
    resolveConfig: () => ({ url: 'http://127.0.0.1:8741', apiKey: '', threshold: 50 }),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: 'index.ts' });

  const handlers = {};
  sandbox.module.exports.register({ config: {}, on: (name, fn) => { handlers[name] = fn; } });
  return { handlers, posts, sandbox };
}

const flush = () => new Promise((r) => setImmediate(r));
const costs = (posts) => posts.filter((p) => p.path === '/api/costs/track');

// Shape delivered by OpenClaw 2026.10 (completeEmbeddedAttemptResult).
const event = (over = {}) => ({
  runId: 'run-1', sessionId: 'sess-uuid-1', provider: 'amazon-bedrock', model: 'us.anthropic.claude-sonnet-4-6',
  assistantTexts: ['ok'], usage: { input: 120, output: 40, cacheRead: 900, cacheWrite: 30, total: 1090 }, ...over,
});
const ctx = { runId: 'run-1', agentId: 'main', sessionKey: 'agent:main:explicit:abc', sessionId: 'sess-uuid-1' };

test('llm_output posts agent openclaw with session, harness and request id', async () => {
  const { handlers, posts } = loadPlugin();
  handlers.llm_output(event(), ctx);
  await flush();

  const rows = costs(posts);
  assert.equal(rows.length, 1);
  const b = rows[0].body;
  assert.equal(b.agent_id, 'openclaw');
  assert.equal(b.runtime_kind, 'openclaw');
  assert.equal(b.session_id, 'agent:main:explicit:abc');
  assert.equal(b.request_id, 'run-1:1');
  assert.equal(b.provider, 'amazon-bedrock');
  assert.equal(b.model_id, 'us.anthropic.claude-sonnet-4-6');
  assert.equal(b.input_tokens, 120);
  assert.equal(b.output_tokens, 40);
  assert.equal(b.input_cached_tokens, 900);
  assert.equal(b.input_cache_write_tokens, 30);
  assert.equal(b.input_includes_cached, false);
});

test('a second attempt of one run gets its own request id; runs differ', async () => {
  const { handlers, posts } = loadPlugin();
  handlers.llm_output(event(), ctx);
  handlers.llm_output(event({ model: 'fallback-model' }), ctx);
  handlers.llm_output(event({ runId: 'run-2' }), { ...ctx, runId: 'run-2' });
  await flush();
  assert.deepEqual(costs(posts).map((p) => p.body.request_id), ['run-1:1', 'run-1:2', 'run-2:1']);
});

test('falls back to the session id when there is no session key', async () => {
  const { handlers, posts } = loadPlugin();
  handlers.llm_output(event(), { runId: 'run-1' });
  await flush();
  assert.equal(costs(posts)[0].body.session_id, 'sess-uuid-1');
  assert.equal(costs(posts)[0].body.agent_id, 'openclaw');
});

test('ids are capped at 200 characters', async () => {
  const { handlers, posts } = loadPlugin();
  const long = 'x'.repeat(300);
  handlers.llm_output(event({ runId: long }), { sessionKey: long });
  await flush();
  const b = costs(posts)[0].body;
  assert.equal(b.session_id.length, 200);
  assert.equal(b.request_id, 'x'.repeat(190) + ':1');
});

test('no usage or zero usage records nothing', async () => {
  const { handlers, posts } = loadPlugin();
  handlers.llm_output(event({ usage: undefined }), ctx);
  handlers.llm_output(event({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }), ctx);
  await flush();
  assert.equal(costs(posts).length, 0);
});

test('a repeated delivery of one attempt reuses its request id', async () => {
  const { handlers, posts } = loadPlugin();
  handlers.llm_output(event(), ctx);
  handlers.llm_output(event(), ctx); // same attempt delivered again
  handlers.llm_output(event({ usage: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0 } }), ctx);
  await flush();
  assert.deepEqual(costs(posts).map((p) => p.body.request_id), ['run-1:1', 'run-1:1', 'run-1:2']);
});

test('a long runId keeps its attempt suffix', async () => {
  const { handlers, posts } = loadPlugin();
  const long = 'r'.repeat(300);
  handlers.llm_output(event({ runId: long }), ctx);
  handlers.llm_output(event({ runId: long, model: 'other-model' }), ctx);
  await flush();
  const ids = costs(posts).map((p) => p.body.request_id);
  assert.deepEqual(ids, ['r'.repeat(190) + ':1', 'r'.repeat(190) + ':2']);
});

test('a run in use is not evicted when the cap is reached', async () => {
  const { handlers, posts, sandbox } = loadPlugin();
  handlers.llm_output(event(), ctx);
  const runs = sandbox.__sv_cost_runs__;
  for (let i = 0; runs.size < 5000; i++) runs.set(`old-${i}`, new Map());
  handlers.llm_output(event(), ctx); // repeated delivery: run-1 is now the newest
  handlers.llm_output(event({ runId: 'run-new' }), { ...ctx, runId: 'run-new' });
  assert.ok(runs.has('run-1'));
  assert.ok(!runs.has('old-0'));
  handlers.llm_output(event({ model: 'fallback-model' }), ctx);
  await flush();
  assert.deepEqual(costs(posts).map((p) => p.body.request_id), ['run-1:1', 'run-1:1', 'run-new:1', 'run-1:2']);
});
