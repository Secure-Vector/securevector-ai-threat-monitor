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


test('plugin.json: does NOT declare a hooks pointer (CC auto-discovers)', () => {
  // Empirical finding (v4.2.0): Claude Code automatically loads
  // hooks/hooks.json and rejects a plugin.json that ALSO declares it —
  // "Hook load failed: Duplicate hooks file detected" prevents the
  // plugin from loading at all. The auto-discovery is reliable so we
  // dropped the field. This guard prevents anyone re-adding it.
  const m = readJson('.claude-plugin/plugin.json');
  assert.equal(
    m.hooks,
    undefined,
    'plugin.json must NOT declare a hooks pointer — CC auto-discovers ./hooks/hooks.json and rejects duplicates',
  );
  // ...but the auto-discovered file must still exist on disk.
  const autoDiscoveredPath = path.resolve(PLUGIN_DIR, 'hooks', 'hooks.json');
  assert.ok(
    fs.existsSync(autoDiscoveredPath),
    `auto-discovered hooks file missing: ${autoDiscoveredPath}`,
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


// Tool names the matchers MUST admit so the host invokes the hook for
// them. Built-ins are listed individually because the original v1
// matcher `^mcp__` silently excluded them (#100) and the previous tests
// — which asserted the matcher contained `/mcp/` — encoded that bug.
const MUST_MATCH = [
  'mcp__server-slack__slack_post_message', // representative MCP tool
  'Bash', 'Edit', 'Read', 'Write', 'MultiEdit',
  'PowerShell', 'WebFetch', 'WebSearch', 'Glob', 'Grep',
  'Task', 'NotebookEdit', 'TodoWrite',
];


test('hooks.json: PreToolUse matcher admits MCP tools AND every governable built-in', () => {
  const h = readJson('hooks/hooks.json');
  assert.ok(Array.isArray(h.hooks.PreToolUse));
  assert.equal(h.hooks.PreToolUse.length, 1);
  const entry = h.hooks.PreToolUse[0];
  assert.equal(typeof entry.matcher, 'string');
  const re = new RegExp(entry.matcher);
  for (const name of MUST_MATCH) {
    assert.ok(re.test(name), `PreToolUse matcher must admit ${name}; got matcher='${entry.matcher}'`);
  }
  assert.ok(Array.isArray(entry.hooks));
  assert.equal(entry.hooks[0].type, 'command');
  assert.match(entry.hooks[0].command, /pre-tool-use\.js/);
  assert.match(entry.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
});


test('hooks.json: PostToolUse matcher admits MCP tools AND every governable built-in', () => {
  const h = readJson('hooks/hooks.json');
  assert.ok(Array.isArray(h.hooks.PostToolUse));
  const entry = h.hooks.PostToolUse[0];
  const re = new RegExp(entry.matcher);
  for (const name of MUST_MATCH) {
    assert.ok(re.test(name), `PostToolUse matcher must admit ${name}; got matcher='${entry.matcher}'`);
  }
  assert.equal(entry.hooks[0].type, 'command');
  assert.match(entry.hooks[0].command, /post-tool-use\.js/);
  assert.match(entry.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
});


test('hooks.json: declares PreToolUse + PostToolUse + SessionStart + UserPromptSubmit', () => {
  // Current scope: the temporary `Stop` diagnostic probe was retired and
  // `SessionStart` took its slot (session bootstrap — registers the run
  // with the local app). `UserPromptSubmit` scans incoming chat messages
  // for prompt-injection — without it, the plugin only sees tool inputs,
  // so direct injection in chat ("ignore previous instructions and …")
  // never reaches the rule engine.
  const h = readJson('hooks/hooks.json');
  const events = Object.keys(h.hooks);
  assert.deepEqual(events.sort(), [
    'PostToolUse', 'PreToolUse', 'SessionStart', 'UserPromptSubmit',
  ]);
});


test('hooks.json: SessionStart hook points at session-start.js', () => {
  // Guards against the hook file getting renamed without updating
  // hooks.json (silent no-op).
  const h = readJson('hooks/hooks.json');
  const ss = h.hooks.SessionStart;
  assert.ok(Array.isArray(ss) && ss.length === 1);
  assert.equal(ss[0].hooks[0].type, 'command');
  assert.match(ss[0].hooks[0].command, /session-start\.js/);
  const hookPath = path.resolve(PLUGIN_DIR, 'hooks', 'session-start.js');
  assert.ok(fs.existsSync(hookPath), `session-start.js missing at ${hookPath}`);
});


test('hooks.json: UserPromptSubmit hook points at user-prompt-submit.js', () => {
  // The UserPromptSubmit hook scans incoming chat messages for
  // prompt-injection. Guards against the file getting renamed without
  // updating hooks.json (silent no-op), and against the entry being
  // removed without re-introducing the bug it fixed.
  const h = readJson('hooks/hooks.json');
  const ups = h.hooks.UserPromptSubmit;
  assert.ok(Array.isArray(ups) && ups.length === 1);
  assert.equal(ups[0].hooks[0].type, 'command');
  assert.match(ups[0].hooks[0].command, /user-prompt-submit\.js/);
  const hookPath = path.resolve(PLUGIN_DIR, 'hooks', 'user-prompt-submit.js');
  assert.ok(fs.existsSync(hookPath), `user-prompt-submit.js missing at ${hookPath}`);
});
