// OpenCode token usage reaches Cost & Tokens: a completed assistant message
// (message.updated) becomes one POST /api/costs/track body.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '../../../../src/securevector/plugins/opencode');
const CLIENT_URL = pathToFileURL(path.join(ROOT, 'lib/client.js')).href;

const done = {
  id: 'msg_1', sessionID: 'ses_1', role: 'assistant',
  time: { created: 1, completed: 2 },
  modelID: 'claude-sonnet-5-5', providerID: 'anthropic',
  tokens: { input: 12, output: 300, reasoning: 50, cache: { read: 40000, write: 1200 } },
};

test('a completed assistant message maps to a cost record with cache tokens', async () => {
  const { costRecordFromMessage } = await import(CLIENT_URL);
  assert.deepEqual(costRecordFromMessage(done), {
    agent_id: 'opencode', provider: 'anthropic', model_id: 'claude-sonnet-5-5',
    input_tokens: 12, output_tokens: 350, input_cached_tokens: 40000,
    input_cache_write_tokens: 1200, input_includes_cached: false, session_id: 'ses_1', request_id: 'msg_1',
  });
});

test('in-flight, user and empty messages produce no record', async () => {
  const { costRecordFromMessage } = await import(CLIENT_URL);
  assert.equal(costRecordFromMessage({ ...done, time: { created: 1 } }), null);
  assert.equal(costRecordFromMessage({ ...done, role: 'user' }), null);
  assert.equal(costRecordFromMessage({ ...done, modelID: '' }), null);
  assert.equal(costRecordFromMessage({ ...done, tokens: { input: 0, output: 0, cache: {} } }), null);
  assert.equal(costRecordFromMessage(null), null);
});

test('the plugin posts each finished message once and exports only the plugin', () => {
  const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  assert.match(src, /if \(event\.type === 'message\.updated'\) \{[\s\S]*?costRecordFromMessage\(info\);[\s\S]*?!costed\.has\(info\.id\)[\s\S]*?postJsonAndForget\(`\$\{baseUrl\}\/api\/costs\/track`, body\);/);
  // OpenCode calls every export as a plugin, so the helper lives in lib/.
  assert.deepEqual([...src.matchAll(/^export .*/gm)].map(m => m[0]), ['export const SecureVectorGuard = async ({ client }) => {', 'export default SecureVectorGuard;']);
});
