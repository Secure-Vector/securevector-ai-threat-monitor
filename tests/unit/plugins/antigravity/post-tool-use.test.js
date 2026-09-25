// Antigravity PostToolUse helper tests.
//
// The load-bearing fact pinned here is what the harness does NOT send. The
// documented PostToolUse payload is the PreToolUse payload plus an optional
// `error` string, and carries no tool RESULT, so the incoming-direction scan
// has no input on this harness. `readToolResult` therefore has to return
// undefined for the documented shape (so nothing is fabricated) while still
// finding a result if a future build starts sending one.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const PLUGIN = '../../../../src/securevector/plugins/antigravity';
const {
  readToolCall, readToolResult, extractScanText, extractScanTextFromResult,
  effectToAction, pickMatch, THREAT_SCAN_TOOLS,
  THREAT_SCAN_RESPONSE_MARKER_GATED_TOOLS, RUNTIME_KIND,
} = require(`${PLUGIN}/hooks/post-tool-use.js`);


test('runtime_kind is antigravity', () => {
  assert.equal(RUNTIME_KIND, 'antigravity');
});

test('readToolResult returns undefined for the documented payload', () => {
  const documented = {
    toolCall: { name: 'run_command', args: { command: 'ls' } },
    stepIdx: 3,
    conversationId: 'c-1',
    workspacePaths: ['/tmp'],
    transcriptPath: '/tmp/transcript.jsonl',
    artifactDirectoryPath: '/tmp/artifacts',
    modelName: 'gemini',
    error: 'boom',
  };
  assert.equal(readToolResult(documented), undefined);
});

test('readToolResult finds a result if a future build sends one', () => {
  assert.deepEqual(readToolResult({ toolResult: { stdout: 'x' } }), { stdout: 'x' });
  assert.deepEqual(readToolResult({ toolCall: { name: 'x', result: 'y' } }), 'y');
});

test('only prose-bearing tools are in the outgoing scan set', () => {
  for (const t of ['search_web', 'start_subagent', 'ask_question', 'generate_image']) {
    assert.equal(THREAT_SCAN_TOOLS.has(t), true, t);
  }
  // Syntax-shaped args would flood the prose rule pack with false positives.
  for (const t of ['run_command', 'create_file', 'edit_file', 'view_file', 'read_url_content']) {
    assert.equal(THREAT_SCAN_TOOLS.has(t), false, t);
  }
});

test('run_command output is marker-gated, context-facing tools are not', () => {
  assert.equal(THREAT_SCAN_RESPONSE_MARKER_GATED_TOOLS.has('run_command'), true);
  assert.equal(THREAT_SCAN_RESPONSE_MARKER_GATED_TOOLS.has('read_url_content'), false);
});

test('extractScanText pulls only the prose field, never the whole args blob', () => {
  assert.equal(extractScanText('search_web', { query: 'how to leak keys', num: 5 }), 'how to leak keys');
  assert.equal(extractScanText('start_subagent', { instructions: 'do a thing' }), 'do a thing');
  assert.equal(extractScanText('ask_question', { question: 'ok?' }), 'ok?');
  // A structural-only args object yields nothing, so the scan is skipped.
  assert.equal(extractScanText('search_web', { num: 5 }), '');
  assert.equal(extractScanText('search_web', null), '');
});

test('extractScanTextFromResult handles the shapes a result could arrive in', () => {
  assert.equal(extractScanTextFromResult('plain'), 'plain');
  assert.equal(extractScanTextFromResult({ stdout: 'out', stderr: 'err' }), 'out\nerr');
  assert.equal(
    extractScanTextFromResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
    'a\nb',
  );
  assert.equal(extractScanTextFromResult({ matches: ['m1', 'm2'] }), 'm1\nm2');
  // An unrecognised shape is stringified rather than given a free pass.
  assert.equal(extractScanTextFromResult({ weird: 1 }), '{"weird":1}');
  assert.equal(extractScanTextFromResult(null), '');
});

test('effectToAction matches the pre-tool-use audit mapping', () => {
  assert.equal(effectToAction('allow'), 'allow');
  assert.equal(effectToAction('deny'), 'block');
  assert.equal(effectToAction('prompt'), 'log_only');
  assert.equal(effectToAction('nonsense'), 'allow');
});

test('pickMatch is case-insensitive and honours candidate order', () => {
  const overrides = { synced: [
    { tool_id: 'CREATE_ISSUE', effect: 'deny' },
    { tool_id: 'github:create_issue', effect: 'prompt' },
  ] };
  // Candidates are most-specific first, so the server-qualified rule wins.
  assert.equal(pickMatch(['github:create_issue', 'create_issue'], overrides).effect, 'prompt');
  assert.equal(pickMatch(['create_issue'], overrides).effect, 'deny');
  assert.equal(pickMatch(['view_file'], overrides), null);
  assert.equal(pickMatch(['view_file'], { synced: [] }), null);
});

test('readToolCall is shared-shaped with the pre-tool-use reader', () => {
  assert.equal(readToolCall({ toolCall: { name: 'view_file' } }).name, 'view_file');
});
