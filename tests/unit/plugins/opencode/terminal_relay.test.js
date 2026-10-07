// Agent Terminals relay contract for the OpenCode Guard plugin.
//
// The relay is the only thing that binds a launched PTY task to the runtime
// session inside it, so two properties are pinned here:
//   - outside a task (no SV_TERMINAL_* env) it does nothing at all, and in
//     particular opens no socket, so a normal OpenCode session is unaffected;
//   - inside a task it posts the event verbatim to the per-task endpoint,
//     authenticated by the per-task token header.
//
// The OpenCode plugin is ESM (package.json "type": "module"), so the module
// is pulled in with a dynamic import() rather than require().

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const RELAY_URL = pathToFileURL(
  path.join(__dirname, '../../../../src/securevector/plugins/opencode/lib/terminal-relay.js')
).href;

const ENV_KEYS = ['SV_TERMINAL_TASK_ID', 'SV_TERMINAL_HOOK_TOKEN', 'SV_TERMINAL_PORT'];

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

test('resolves false and sends nothing outside an Agent Terminals task', async () => {
  clearEnv();
  const { postTerminalEvent } = await import(RELAY_URL);
  const result = await postTerminalEvent({ hook_event_name: 'PreToolUse' });
  assert.equal(result, false);
});

test('posts the event to the per-task endpoint with the task token', async () => {
  const { postTerminalEvent } = await import(RELAY_URL);
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ url: req.url, token: req.headers['x-sv-terminal-hook'], body });
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    process.env.SV_TERMINAL_TASK_ID = 'task-xyz';
    process.env.SV_TERMINAL_HOOK_TOKEN = 'tok-456';
    process.env.SV_TERMINAL_PORT = String(port);
    const event = { hook_event_name: 'PreToolUse', session_id: 's2', tool_name: 'bash' };
    const ok = await postTerminalEvent(event);
    assert.equal(ok, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/api/terminals/tasks/task-xyz/events');
    assert.equal(received[0].token, 'tok-456');
    assert.deepEqual(JSON.parse(received[0].body), event);
  } finally {
    clearEnv();
    await new Promise((resolve) => server.close(resolve));
  }
});
