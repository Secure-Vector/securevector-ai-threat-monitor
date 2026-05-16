/**
 * Tests for MCP tool-name normalisation.
 *
 * `mcp__<server>__<tool>` → `[<server>:<tool>, <tool>]`
 * Anything else → `[]` (built-in tools deferred — see locked decision #3).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize } = require('../../../../src/securevector/plugins/claude-code/lib/normalize.js');


test('normalises mcp__<server>__<tool> to [server:tool, tool]', () => {
  assert.deepEqual(
    normalize('mcp__server-slack__slack_post_message'),
    ['server-slack:slack_post_message', 'slack_post_message'],
  );
});

test('handles a minimal mcp tool name', () => {
  assert.deepEqual(normalize('mcp__simple__do'), ['simple:do', 'do']);
});

test('preserves underscores in the tool portion (split is on the FIRST __ after server)', () => {
  assert.deepEqual(
    normalize('mcp__server__tool__with__underscores'),
    ['server:tool__with__underscores', 'tool__with__underscores'],
  );
});

test('returns [] for built-in tool names', () => {
  for (const name of ['Bash', 'Edit', 'Read', 'Write', 'Grep', 'Glob']) {
    assert.deepEqual(normalize(name), [], `expected [] for ${name}`);
  }
});

test('returns [] for empty and falsy inputs', () => {
  assert.deepEqual(normalize(''), []);
  assert.deepEqual(normalize(null), []);
  assert.deepEqual(normalize(undefined), []);
});

test('returns [] for malformed mcp prefix variants', () => {
  // No server-tool separator at all
  assert.deepEqual(normalize('mcp__noserver'), []);
  // Empty server segment
  assert.deepEqual(normalize('mcp____tool'), []);
  // Empty tool segment
  assert.deepEqual(normalize('mcp__server__'), []);
  // Just the prefix
  assert.deepEqual(normalize('mcp__'), []);
});

test('returns [] for non-string inputs', () => {
  assert.deepEqual(normalize(42), []);
  assert.deepEqual(normalize({}), []);
  assert.deepEqual(normalize([]), []);
});

test('returns [] when prefix is wrong-case (mcp prefix is exactly four chars + two underscores)', () => {
  assert.deepEqual(normalize('MCP__server__tool'), []);
  assert.deepEqual(normalize('Mcp__server__tool'), []);
});

test('returns [] when prefix uses single underscore', () => {
  assert.deepEqual(normalize('mcp_server_tool'), []);
});
