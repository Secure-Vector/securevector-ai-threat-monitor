/**
 * Tests for the Cursor hook scripts' pure helpers + the hooks.json template.
 *
 * The end-to-end stdin→stdout behaviour is covered by the integration suite
 * (live server + node child processes); these unit tests pin the helper
 * functions each event-typed script exposes and the manifest's shape.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '../../../../src/securevector/plugins/cursor');

const { serverSlugFrom } = require(path.join(PLUGIN, 'hooks/before-mcp.js'));
const { extractResultText } = require(path.join(PLUGIN, 'hooks/after-mcp.js'));
const { newContentFrom } = require(path.join(PLUGIN, 'hooks/after-file-edit.js'));
const { pickMatch, effectToAction, preview } = require(path.join(PLUGIN, 'lib/audit.js'));

// --- before-mcp: server slug derivation -----------------------------------

test('serverSlugFrom uses the URL hostname for HTTP servers', () => {
  assert.equal(serverSlugFrom({ url: 'https://mcp.linear.app/sse' }), 'mcp.linear.app');
});

test('serverSlugFrom derives a slug from a stdio command', () => {
  assert.equal(serverSlugFrom({ command: 'npx -y @upstash/context7' }), 'context7');
});

test('serverSlugFrom skips flag tokens and handles paths', () => {
  assert.equal(serverSlugFrom({ command: '/usr/local/bin/my-server --port 1234' }), 'my-server');
});

test('serverSlugFrom returns null when neither url nor command is usable', () => {
  assert.equal(serverSlugFrom({}), null);
  assert.equal(serverSlugFrom({ url: 'not a url' }), null);
  assert.equal(serverSlugFrom(null), null);
});

// --- after-mcp: result text extraction -------------------------------------

test('extractResultText prefers the MCP text envelope from result_json', () => {
  const event = {
    result_json: JSON.stringify({ content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] }),
  };
  assert.equal(extractResultText(event), 'hello\nworld');
});

test('extractResultText falls back to the raw string for non-envelope JSON', () => {
  assert.equal(extractResultText({ result_json: '{"ok":true}' }), '{"ok":true}');
  assert.equal(extractResultText({ result_json: 'plain text result' }), 'plain text result');
});

test('extractResultText handles missing/odd shapes without throwing', () => {
  assert.equal(extractResultText({}), '');
  assert.equal(extractResultText(null), '');
});

// --- after-file-edit: written-content extraction ----------------------------

test('newContentFrom joins the new_string sides of every edit', () => {
  assert.equal(
    newContentFrom({ edits: [{ old_string: 'a', new_string: 'x' }, { new_string: 'y' }] }),
    'x\ny',
  );
});

test('newContentFrom is empty for missing/empty edits', () => {
  assert.equal(newContentFrom({}), '');
  assert.equal(newContentFrom({ edits: [] }), '');
});

// --- audit lib helpers ------------------------------------------------------

test('pickMatch returns the first candidate with a rule (most-specific wins)', () => {
  const m = pickMatch(
    ['everything:echo', 'everything'],
    { synced: [{ tool_id: 'everything', effect: 'deny', reason: 'server block' }] },
  );
  assert.equal(m.tool_id, 'everything');
  assert.equal(m.effect, 'deny');
});

test('pickMatch is case-insensitive (audit row must agree with the deny decision)', () => {
  // A rule stored as "Shell" must still match the lowercase 'shell' candidate,
  // exactly like the before-hook decision path — otherwise the audit row would
  // log allow for a call that was actually blocked.
  const m = pickMatch(['shell'], { synced: [{ tool_id: 'Shell', effect: 'deny' }] });
  assert.ok(m, 'expected a match for tool_id "Shell" against candidate "shell"');
  assert.equal(m.effect, 'deny');
});

test('effectToAction maps the audit action like every sibling plugin', () => {
  assert.equal(effectToAction('deny'), 'block');
  assert.equal(effectToAction('prompt'), 'log_only');
  assert.equal(effectToAction('allow'), 'allow');
  assert.equal(effectToAction(undefined), 'allow');
});

test('preview redacts secrets and truncates to 200 chars', () => {
  const out = preview('token=ghp_0123456789abcdef0123456789abcdef0123 ' + 'x'.repeat(400));
  assert.ok(!out.includes('ghp_0123456789abcdef0123456789abcdef0123'));
  assert.ok(out.length <= 200);
});

// --- hooks.json template -----------------------------------------------------

test('hooks.json template registers all nine events with the root placeholder', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks/hooks.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  const events = Object.keys(manifest.hooks).sort();
  assert.deepEqual(events, [
    'afterFileEdit', 'afterMCPExecution', 'afterShellExecution',
    'beforeMCPExecution', 'beforeReadFile', 'beforeShellExecution',
    'beforeSubmitPrompt', 'sessionStart', 'stop',
  ]);
  for (const [event, entries] of Object.entries(manifest.hooks)) {
    assert.equal(entries.length, 1, `${event} should register exactly one entry`);
    assert.ok(entries[0].command.includes('__SV_PLUGIN_ROOT__'), `${event} command must use the root placeholder`);
    assert.ok(entries[0].command.startsWith('node '), `${event} command must run node`);
    assert.equal(typeof entries[0].timeout, 'number');
  }
});

test('every hook script named in the template exists in the plugin tree', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks/hooks.json'), 'utf8'));
  for (const entries of Object.values(manifest.hooks)) {
    const m = entries[0].command.match(/__SV_PLUGIN_ROOT__\/(hooks\/[a-z-]+\.js)/);
    assert.ok(m, `unparseable command: ${entries[0].command}`);
    assert.ok(fs.existsSync(path.join(PLUGIN, m[1])), `${m[1]} missing from plugin tree`);
  }
});
