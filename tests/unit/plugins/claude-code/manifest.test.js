/**
 * Manifest validation tests.
 *
 * Verifies that .claude-plugin/plugin.json and hooks/hooks.json parse as
 * valid JSON and conform to the canonical Claude Code plugin schema
 * (see https://code.claude.com/docs/en/plugins-reference).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_DIR = path.resolve(__dirname, '../../../../src/securevector/plugins/claude-code');


function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, rel), 'utf8'));
}


// --- plugin.json ---


test('plugin.json parses as valid JSON', () => {
  const m = readJson('.claude-plugin/plugin.json');
  assert.equal(typeof m, 'object');
  assert.ok(m, 'manifest must be non-null');
});


test('plugin.json: name is kebab-case and present (the only required field)', () => {
  const m = readJson('.claude-plugin/plugin.json');
  assert.equal(typeof m.name, 'string');
  assert.match(m.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'name must be kebab-case');
});


test('plugin.json: version tracks the app version (4.x semver)', () => {
  const m = readJson('.claude-plugin/plugin.json');
  assert.match(m.version, /^4\.\d+\.\d+$/);
});


test('plugin.json: hooks pointer references the existing hooks/hooks.json', () => {
  const m = readJson('.claude-plugin/plugin.json');
  assert.equal(typeof m.hooks, 'string');
  const hooksPath = path.resolve(PLUGIN_DIR, '.claude-plugin', m.hooks);
  // Resolve relative to .claude-plugin/ (where the manifest lives) — should
  // exist as a real file.
  // Some hosts resolve relative to plugin root; check both.
  const altPath = path.resolve(PLUGIN_DIR, m.hooks);
  assert.ok(
    fs.existsSync(hooksPath) || fs.existsSync(altPath),
    `hooks pointer must resolve to an existing file (tried: ${hooksPath}, ${altPath})`,
  );
});


test('plugin.json: author shape is an object with at least a name', () => {
  const m = readJson('.claude-plugin/plugin.json');
  assert.equal(typeof m.author, 'object');
  assert.equal(typeof m.author.name, 'string');
});


// --- hooks/hooks.json ---


test('hooks.json parses as valid JSON', () => {
  const h = readJson('hooks/hooks.json');
  assert.equal(typeof h, 'object');
});


test('hooks.json: top-level wraps event names under a "hooks" key', () => {
  const h = readJson('hooks/hooks.json');
  assert.equal(typeof h.hooks, 'object');
  assert.ok(h.hooks, 'top-level "hooks" key required');
});


test('hooks.json: PreToolUse registered + matcher is regex + command references pre-tool-use.js', () => {
  const h = readJson('hooks/hooks.json');
  assert.ok(Array.isArray(h.hooks.PreToolUse));
  assert.equal(h.hooks.PreToolUse.length, 1);
  const entry = h.hooks.PreToolUse[0];
  assert.equal(typeof entry.matcher, 'string');
  // Should be a regex matching mcp tools (v1 scope)
  assert.match(entry.matcher, /mcp/);
  assert.ok(Array.isArray(entry.hooks));
  assert.equal(entry.hooks[0].type, 'command');
  assert.match(entry.hooks[0].command, /pre-tool-use\.js/);
  assert.match(entry.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
});


test('hooks.json: PostToolUse registered + matcher is regex + command references post-tool-use.js', () => {
  const h = readJson('hooks/hooks.json');
  assert.ok(Array.isArray(h.hooks.PostToolUse));
  const entry = h.hooks.PostToolUse[0];
  assert.match(entry.matcher, /mcp/);
  assert.equal(entry.hooks[0].type, 'command');
  assert.match(entry.hooks[0].command, /post-tool-use\.js/);
  assert.match(entry.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
});


test('hooks.json: only PreToolUse + PostToolUse declared (v1 scope)', () => {
  const h = readJson('hooks/hooks.json');
  const events = Object.keys(h.hooks);
  assert.deepEqual(events.sort(), ['PostToolUse', 'PreToolUse']);
});
