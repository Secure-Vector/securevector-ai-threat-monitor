/**
 * Tests for tool-name normalisation (Cursor variant).
 *
 * Cursor synthesizes most tool names from its event-typed hooks ('shell',
 * 'edit', 'read'); MCP names are normalized defensively across every
 * plausible shape (MCP:<tool>, mcp__server__tool bridge, bare names with
 * event context + server slug).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, isMcpToolName, BUILTIN_TOOLS } = require('../../../../src/securevector/plugins/cursor/lib/normalize.js');

test('built-in synthesized names normalize to themselves', () => {
  assert.deepEqual(normalize('shell'), ['shell']);
  assert.deepEqual(normalize('edit'), ['edit']);
  assert.deepEqual(normalize('read'), ['read']);
});

test('documented PascalCase enum names match case-insensitively', () => {
  assert.deepEqual(normalize('Shell'), ['shell']);
  assert.deepEqual(normalize('Delete'), ['delete']);
  assert.deepEqual(normalize('Task'), ['task']);
});

test('MCP:<tool> expanded-event shape strips the prefix', () => {
  assert.deepEqual(normalize('MCP:slack_post'), ['mcp:slack_post', 'slack_post']);
});

test('MCP:<tool> with a server slug adds server-scoped candidates', () => {
  assert.deepEqual(
    normalize('MCP:echo', { serverSlug: 'everything' }),
    ['mcp:echo', 'echo', 'everything:echo', 'everything'],
  );
});

test('bridge shape mcp__server__tool yields [server:tool, tool]', () => {
  assert.deepEqual(
    normalize('mcp__slack__post_message'),
    ['slack:post_message', 'post_message'],
  );
});

test('bare name WITHOUT mcp event context is not governable (fail-open)', () => {
  assert.deepEqual(normalize('some_internal_tool'), []);
});

test('bare name WITH mcp event context is governable', () => {
  assert.deepEqual(normalize('echo', { fromMcpEvent: true }), ['echo']);
});

test('bare mcp name with server slug gets server:tool + server-wide candidates', () => {
  assert.deepEqual(
    normalize('post_message', { fromMcpEvent: true, serverSlug: 'slack' }),
    ['post_message', 'slack:post_message', 'slack'],
  );
});

test('fromMcpEvent wins over a builtin-shaped name (event context is truth)', () => {
  // An MCP server could expose a tool named "shell" — the event proves it's
  // MCP, so it must NOT short-circuit into the builtin candidate set.
  assert.deepEqual(normalize('shell', { fromMcpEvent: true }), ['shell']);
});

test('empty / non-string input returns []', () => {
  assert.deepEqual(normalize(''), []);
  assert.deepEqual(normalize(null), []);
  assert.deepEqual(normalize(undefined), []);
});

test('isMcpToolName recognises name shapes, not builtins', () => {
  assert.equal(isMcpToolName('MCP:echo'), true);
  assert.equal(isMcpToolName('mcp__slack__post'), true);
  assert.equal(isMcpToolName('shell'), false);
  assert.equal(isMcpToolName('Read'), false);
  assert.equal(isMcpToolName(''), false);
});

test('BUILTIN_TOOLS is the documented Cursor agent surface', () => {
  assert.deepEqual(
    [...BUILTIN_TOOLS].sort(),
    ['delete', 'edit', 'grep', 'read', 'shell', 'task', 'write'],
  );
});
