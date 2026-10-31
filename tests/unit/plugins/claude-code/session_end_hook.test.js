/** Session-end markers: Claude Code, Codex and Cursor write `__session_end__`
 *  from their session-end hooks, and their per-turn Stop hooks write
 *  `__turn_end__`, which never ends a session. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PLUGINS = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'plugins');
const hook = (p) => path.join(PLUGINS, p);

test('Claude Code SessionEnd stdin maps to one __session_end__ row', () => {
  const { buildSessionEndBody } = require(hook('claude-code/hooks/session-end.js'));
  const body = buildSessionEndBody({ session_id: 'abc123', hook_event_name: 'SessionEnd', reason: 'prompt_input_exit', exit_code: 0, cwd: '/w' });
  assert.deepEqual(body, {
    tool_id: '__session_end__', function_name: '__session_end__', action: 'log_only', risk: null,
    reason: 'SecureVector Guard: Claude Code session ended (prompt_input_exit)', is_essential: false,
    args_preview: 'session_id=abc123', runtime_kind: 'claude-code', session_id: 'abc123',
  });
  const empty = buildSessionEndBody({});
  assert.equal(empty.session_id, null);
  assert.equal(empty.args_preview, null);
  assert.equal(buildSessionEndBody(null).tool_id, '__session_end__');
});

test('Codex and Cursor: session end writes __session_end__, the per-turn stop writes __turn_end__', () => {
  const codexEnd = require(hook('codex/hooks/session-end.js')).buildSessionEndBody({ session_id: 's1' });
  assert.equal(codexEnd.tool_id, '__session_end__');
  assert.equal(codexEnd.runtime_kind, 'codex');
  assert.equal(codexEnd.session_id, 's1');
  const codexTurn = require(hook('codex/hooks/stop.js')).buildTurnEndBody({ session_id: 's1' });
  assert.equal(codexTurn.tool_id, '__turn_end__');
  assert.equal(codexTurn.function_name, '__turn_end__');
  assert.equal(codexTurn.session_id, 's1');
  const cursorEnd = require(hook('cursor/hooks/session-end.js')).buildSessionEndBody({ conversation_id: 'c1', reason: 'completed', duration_ms: 10 });
  assert.equal(cursorEnd.tool_id, '__session_end__');
  assert.equal(cursorEnd.session_id, 'c1');
  assert.match(cursorEnd.reason, /\(completed\)$/);
  const cursorTurn = require(hook('cursor/hooks/stop.js')).buildTurnEndBody({ conversation_id: 'c1', status: 'completed' });
  assert.equal(cursorTurn.tool_id, '__turn_end__');
});

test('hook wiring: SessionEnd / sessionEnd bound to session-end.js; versions bumped', () => {
  const json = (p) => JSON.parse(fs.readFileSync(hook(p), 'utf8'));
  const cc = json('claude-code/hooks/hooks.json').hooks;
  assert.match(cc.SessionEnd[0].hooks[0].command, /session-end\.js/);
  assert.equal(cc.Stop, undefined);
  const cx = json('codex/hooks/hooks.json').hooks;
  assert.match(cx.SessionEnd[0].hooks[0].command, /session-end\.js/);
  assert.match(cx.Stop[0].hooks[0].command, /stop\.js/);
  const cu = json('cursor/hooks/hooks.json').hooks;
  assert.match(cu.sessionEnd[0].command, /__SV_PLUGIN_ROOT__\/hooks\/session-end\.js/);
  assert.equal(json('claude-code/.claude-plugin/plugin.json').version, '5.4.2');
  assert.equal(json('codex/.codex-plugin/plugin.json').version, '5.4.1');
  assert.equal(json('cursor/.cursor-plugin/plugin.json').version, '5.4.1');
});

test('Claude Code session-end.js run end to end: stdin in, one marker POST out', async () => {
  const got = [];
  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => { got.push({ url: req.url, body: JSON.parse(buf || '{}') }); res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const env = Object.assign({}, process.env, { SV_BASE_URL: `http://127.0.0.1:${port}` });
    delete env.SECUREVECTOR_ENGINE_ENDPOINT;
    delete env.SECUREVECTOR_URL;
    const child = spawn(process.execPath, [hook('claude-code/hooks/session-end.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(JSON.stringify({ session_id: 'sess-e2e', hook_event_name: 'SessionEnd', reason: 'other', exit_code: 0 }));
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 0);
    assert.equal(got.length, 1);
    assert.ok(got[0].url.endsWith('/call-audit'));
    assert.equal(got[0].body.tool_id, '__session_end__');
    assert.equal(got[0].body.session_id, 'sess-e2e');
    assert.equal(got[0].body.runtime_kind, 'claude-code');
  } finally {
    server.close();
  }
});
