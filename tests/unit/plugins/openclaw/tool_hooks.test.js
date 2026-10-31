// OpenClaw Guard tool hooks: the tool audit and the output scan run on
// after_tool_call (one audit row per tool call id), and the agent_end and
// tool_result_persist fallbacks do not count a call twice.
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

const GLOBAL_KEYS = ['__sv_seen_tools__', '__sv_scanned_tool_results__', '__sv_after_tool_call_live__'];

function loadPlugin({ blockThreats = false } = {}) {
  let src = stripTypeScriptTypes(fs.readFileSync(INDEX_TS, 'utf8'));
  src = src.replace(/import\s*\{[^}]*\}\s*from\s*["']\.\/config["'];?/, '');
  src = src.replace('export default', 'module.exports =');

  const posts = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    let body = null;
    if (opts.method === 'POST') {
      body = JSON.parse(opts.body);
      posts.push({ path: u.pathname, body });
    }
    let json = {};
    if (u.pathname === '/api/settings') json = { block_threats: blockThreats, tool_permissions_enabled: true };
    if (u.pathname === '/api/tool-permissions/essential') {
      json = { tools: [{ tool_id: 'exec', default_action: 'block', effective_action: 'block', risk: 'admin', reason: 'Essential tool policy' }] };
    }
    if (u.pathname === '/api/tool-permissions/overrides') json = { overrides: [] };
    if (u.pathname === '/api/tool-permissions/synced-overrides') json = { synced: [] };
    if (u.pathname === '/analyze') json = { is_threat: false, risk_score: 0 };
    if (u.pathname === '/api/egress/evaluate') json = { action: 'allow' };
    return { ok: true, json: async () => json };
  };

  const sandbox = {
    module: { exports: {} },
    fetch, URL, AbortController, setTimeout, clearTimeout, JSON, Promise, Set, Map,
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
const audits = (posts) => posts.filter((p) => p.path === '/api/tool-permissions/call-audit');
const scans = (posts) => posts.filter((p) => p.path === '/analyze');

test('registers after_tool_call alongside the fallbacks', () => {
  const { handlers } = loadPlugin();
  for (const name of ['after_tool_call', 'agent_end', 'tool_result_persist', 'llm_output']) {
    assert.equal(typeof handlers[name], 'function', name);
  }
});

test('after_tool_call writes one audit row per call id, payload shape kept', async () => {
  const { handlers, posts } = loadPlugin();
  const event = { toolName: 'exec', toolCallId: 'call-1', params: { command: 'ls' }, result: { content: [{ type: 'text', text: 'a.txt' }] } };
  const ctx = { sessionKey: 'agent:main:1', toolName: 'exec', toolCallId: 'call-1' };

  await handlers.after_tool_call(event, ctx);
  await handlers.after_tool_call(event, ctx); // duplicate delivery
  await handlers.after_tool_call({ ...event, toolCallId: 'call-2' }, { ...ctx, toolCallId: 'call-2' });
  await flush();

  const rows = audits(posts);
  assert.equal(rows.length, 2);
  const row = rows[0].body;
  assert.equal(row.tool_id, 'exec');
  assert.equal(row.function_name, 'exec');
  assert.equal(row.runtime_kind, 'openclaw');
  assert.equal(row.session_id, 'agent:main:1');
  assert.equal(row.args_preview, JSON.stringify({ command: 'ls' }));
  // Monitor mode: the essential policy blocks exec, so the row is audit only.
  assert.equal(row.action, 'log_only');
  assert.equal(row.is_essential, true);
  for (const k of ['risk', 'reason']) assert.ok(k in row, k);
});

test('after_tool_call scans the tool result once per call id', async () => {
  const { handlers, posts } = loadPlugin();
  const event = { toolName: 'exec', toolCallId: 'c1', params: {}, result: { content: [{ type: 'text', text: 'secret output' }] } };
  await handlers.after_tool_call(event, { sessionKey: 's' });
  handlers.tool_result_persist({ toolName: 'exec', toolCallId: 'c1', message: { content: [{ type: 'text', text: 'secret output' }] } }, {});
  await flush();

  const out = scans(posts);
  assert.equal(out.length, 1);
  assert.equal(out[0].body.text, 'secret output');
  assert.equal(out[0].body.llm_response, true);
  assert.equal(out[0].body.metadata.tool, 'exec');
});

test('agent_end does not re-audit calls after_tool_call covered', async () => {
  const { handlers, posts } = loadPlugin();
  await handlers.after_tool_call({ toolName: 'exec', toolCallId: 'tc-9', params: { command: 'ls' } }, { sessionKey: 's' });
  await handlers.agent_end({
    messages: [{ role: 'assistant', content: [
      { type: 'toolCall', id: 'tc-9', name: 'exec', arguments: { command: 'ls' } },
      { type: 'toolCall', name: 'read', arguments: { path: 'x' } }, // no id
    ] }],
  }, { sessionKey: 's' });
  await flush();
  assert.equal(audits(posts).length, 1);
});

test('agent_end still audits when after_tool_call never fires (older OpenClaw)', async () => {
  const { handlers, posts } = loadPlugin();
  await handlers.agent_end({
    messages: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'old-1', name: 'exec', arguments: { command: 'ls' } }] }],
  }, { sessionKey: 's' });
  await flush();
  assert.equal(audits(posts).length, 1);

  handlers.tool_result_persist({ toolName: 'exec', toolCallId: 'old-1', message: { content: 'out' } }, {});
  await flush();
  assert.equal(scans(posts).length, 1);
});
