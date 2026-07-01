// SPDX-License-Identifier: Apache-2.0
// authHeaders() forwards SECUREVECTOR_API_KEY as a Bearer token so a hook can
// reach a token-gated remote engine (ingress_token, engine v4.9.0+). Unset =>
// no header (default loopback app needs none). Same client.js across all 4
// JS-hook plugins. (#190)
const test = require('node:test');
const assert = require('node:assert/strict');
const { authHeaders } = require('../../../../src/securevector/plugins/claude-code/lib/client.js');

test('no header when SECUREVECTOR_API_KEY is unset', () => {
  delete process.env.SECUREVECTOR_API_KEY;
  assert.deepEqual(authHeaders(), {});
});

test('forwards Bearer when SECUREVECTOR_API_KEY is set', () => {
  process.env.SECUREVECTOR_API_KEY = 'tok-abc';
  assert.deepEqual(authHeaders(), { authorization: 'Bearer tok-abc' });
  delete process.env.SECUREVECTOR_API_KEY;
});

test('empty/whitespace key => no header', () => {
  process.env.SECUREVECTOR_API_KEY = '   ';
  assert.deepEqual(authHeaders(), {});
  delete process.env.SECUREVECTOR_API_KEY;
});
