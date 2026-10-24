'use strict';

// The after-call audit asks the app for the rows in force for the caller's
// session, so a call that ran under that session's JIT grant is recorded as
// allowed rather than as the deny the grant lifted. Rows that only gate a
// call before it runs (per-run limits, response rung holds) are not used to
// label a call that already ran.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PLUGINS = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'plugins');
const BASE = 'http://127.0.0.1:8741';
const SID = 'sess-grant-1';
const NAMES = ['Bash', 'bash', 'Shell', 'shell', 'run_command', 'run_shell_command'];

function rowsFor(sessionParam, withRung) {
  const rows = [];
  for (const n of NAMES) {
    if (!withRung) break;
    rows.push({ tool_id: n, effect: 'deny', priority: 140, source: 'rung', requestable: true, session_id: SID });
  }
  if (sessionParam === SID) {
    for (const n of NAMES) {
      rows.push({ tool_id: n, effect: 'allow', priority: 150, source: 'jit_grant', session_id: SID });
    }
  }
  for (const n of NAMES) {
    rows.push({ tool_id: n, effect: 'deny', priority: 100, source: 'synced', reason: 'policy deny' });
  }
  return rows;
}

function stub(withRung = true) {
  const seen = { gets: [], audit: null };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (opts && opts.method === 'POST') {
      if (u.endsWith('/call-audit')) seen.audit = JSON.parse(opts.body);
      return new Response('{}', { status: 200 });
    }
    seen.gets.push(u);
    const sp = new URL(u).searchParams;
    const synced = rowsFor(sp.get('session_id'), withRung);
    return new Response(JSON.stringify({ synced, total: synced.length }), { status: 200 });
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

function assertSessionAndAllow(seen) {
  const get = seen.gets.find((u) => u.includes('synced-overrides'));
  assert.ok(get, 'expected a synced-overrides fetch');
  assert.equal(new URL(get).searchParams.get('session_id'), SID);
  assert.ok(seen.audit, 'expected an audit row');
  assert.equal(seen.audit.action, 'allow');
}

for (const [name, file, event] of [
  ['claude-code', 'claude-code/hooks/post-tool-use.js', { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: SID }],
  ['codex', 'codex/hooks/post-tool-use.js', { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: SID }],
  ['copilot-cli', 'copilot-cli/hooks/post-tool-use.js', { toolName: 'bash', toolArgs: '{"command":"ls"}', sessionId: SID }],
  ['antigravity', 'antigravity/hooks/post-tool-use.js', { toolCall: { name: 'run_command', args: { CommandLine: 'ls' } }, conversationId: SID }],
]) {
  test(`${name}: test_post_tool_use_audit_allows_call_under_session_grant`, async () => {
    const { audit } = require(path.join(PLUGINS, file));
    const { seen, restore } = stub();
    try {
      await audit(event, BASE);
      await tick();
      assertSessionAndAllow(seen);
    } finally { restore(); }
  });
}

test('cursor: post-call audit sends the session and records a granted call as allowed', async () => {
  const { postCallAudit } = require(path.join(PLUGINS, 'cursor', 'lib', 'audit.js'));
  const { seen, restore } = stub();
  try {
    await postCallAudit(BASE, { toolName: 'Shell', candidates: ['Shell'], toolInput: { command: 'ls' }, sessionId: SID });
    await tick();
    assertSessionAndAllow(seen);
  } finally { restore(); }
});

test('opencode: test_opencode_sessionful_fetch_gets_its_sessions_grant', async () => {
  const mod = await import(pathToFileURL(path.join(PLUGINS, 'opencode', 'lib', 'decide.js')).href);
  const { seen, restore } = stub(false);
  try {
    const d = await mod.decide('bash', BASE, SID, { command: 'ls' });
    const get = seen.gets.find((u) => u.includes('synced-overrides'));
    assert.equal(new URL(get).searchParams.get('session_id'), SID);
    assert.notEqual(d.decision, 'deny');
  } finally { restore(); }
});

test('opencode: the after-call audit fetch passes the session', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(PLUGINS, 'opencode', 'index.js'), 'utf8');
  assert.match(src, /fetchSyncedOverrides\(baseUrl, RUNTIME_KIND, \{ sessionId \}\)/);
});
