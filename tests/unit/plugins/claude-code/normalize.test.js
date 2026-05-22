/**
 * Tests for tool-name normalisation.
 *
 * `mcp__<server>__<tool>` → `[<server>:<tool>, <tool>]`
 * Built-in (Bash / Edit / Read / etc.) → `[<name>]`
 * Anything else → `[]` (fail-open path)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, BUILTIN_TOOLS } = require('../../../../src/securevector/plugins/claude-code/lib/normalize.js');


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

test('returns [name] for each known built-in tool (high-blast-radius set)', () => {
  // Includes the high-priority denyable tools: shell + file write + web.
  // The full BUILTIN_TOOLS list is asserted separately below.
  for (const name of ['Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'MultiEdit', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill', 'Monitor', 'NotebookEdit', 'TodoWrite', 'ExitPlanMode']) {
    assert.deepEqual(normalize(name), [name], `expected [${name}] for ${name}`);
  }
});

test('built-in lookup is case-sensitive — PascalCase only', () => {
  // Claude Code emits PascalCase. Lowercase / camelCase / random casing
  // is treated as unknown so a rogue cloud rule for `bash` can't match.
  assert.deepEqual(normalize('bash'), []);
  assert.deepEqual(normalize('BASH'), []);
  assert.deepEqual(normalize('edit'), []);
});

test('returns [] for unknown bare tool names', () => {
  assert.deepEqual(normalize('SomeRandomTool'), []);
  assert.deepEqual(normalize('foo'), []);
});

test('BUILTIN_TOOLS Set exposes every governed built-in', () => {
  // Anchors the public surface — if a built-in is added/removed the
  // failing assert points to here as the single source of truth.
  assert.ok(BUILTIN_TOOLS instanceof Set);
  const expected = [
    // File operations
    'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead',
    // Search / navigation
    'Glob', 'Grep', 'LS', 'LSP',
    // Shell
    'Bash', 'PowerShell',
    // Web
    'WebFetch', 'WebSearch',
    // Agents / planning
    'Task', 'Agent', 'ExitPlanMode', 'EnterPlanMode',
    // Worktrees
    'EnterWorktree', 'ExitWorktree',
    // Skills + background
    'Skill', 'Monitor',
    // Todos
    'TodoWrite', 'TodoRead',
  ];
  for (const name of expected) {
    assert.ok(BUILTIN_TOOLS.has(name), `expected ${name} in BUILTIN_TOOLS`);
  }
  // Catches accidental removals that aren't covered by an explicit
  // expected-name above.
  assert.equal(BUILTIN_TOOLS.size, expected.length, 'BUILTIN_TOOLS size drifted from expected list');
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
