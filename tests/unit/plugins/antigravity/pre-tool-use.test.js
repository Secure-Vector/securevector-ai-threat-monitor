// Antigravity-specific PreToolUse contract tests.
//
// Antigravity's decision wire shape is its own: a FLAT
//   { "decision": "allow" | "deny" | "ask" | "force_ask"
//                 | "deny_unless_prior_grant", "reason"?: "..." }
// with no `hookSpecificOutput` envelope (Claude Code) and no
// `permissionDecision` key (Claude Code / Codex). Emitting a sibling
// harness's shape here would parse as an unrecognised object, which is
// exactly the class of bug that made every Codex PreToolUse hook fail in
// v4.4.0. These tests pin the Antigravity-correct shape so the shared
// decision logic cannot silently regress it.
//
// Contract source: antigravity.google/docs/hooks, read 2026-09-21.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const PLUGIN = '../../../../src/securevector/plugins/antigravity';
const {
  toHookOutput, decideFromOverrides, decisionToAuditAction,
  readToolCall, readSessionId, isNetworkCapable, EFFECT_TO_DECISION,
} = require(`${PLUGIN}/hooks/pre-tool-use.js`);


test('toHookOutput emits a flat decision object, not a hookSpecificOutput envelope', () => {
  const out = toHookOutput({ decision: 'allow' });
  assert.deepEqual(out, { decision: 'allow' });
  assert.equal(out.hookSpecificOutput, undefined);
  assert.equal(out.permissionDecision, undefined);
});

test('toHookOutput brands non-allow reasons so the deny banner names the enforcer', () => {
  const out = toHookOutput({ decision: 'deny', reason: 'Blocked by policy' });
  assert.equal(out.decision, 'deny');
  assert.equal(out.reason, 'SecureVector Guard: Blocked by policy');
});

test('toHookOutput does not double-brand an already-branded reason', () => {
  const out = toHookOutput({ decision: 'deny', reason: 'SecureVector Guard: nope' });
  assert.equal(out.reason, 'SecureVector Guard: nope');
});

test('toHookOutput leaves an allow reason unbranded', () => {
  // Antigravity does not surface the reason on allow, so the prefix would be
  // noise in any incidental log line.
  const out = toHookOutput({ decision: 'allow', reason: 'fine' });
  assert.equal(out.reason, 'fine');
});

test('toHookOutput never emits permissionOverrides', () => {
  // permissionOverrides grants standing permission. A Guard has no business
  // widening what the agent may do, so the key must never appear.
  for (const d of [{ decision: 'allow' }, { decision: 'deny', reason: 'x' }]) {
    assert.equal(Object.prototype.hasOwnProperty.call(toHookOutput(d), 'permissionOverrides'), false);
  }
});

test('a prompt effect maps to force_ask, not ask', () => {
  // `ask` can be satisfied by a prior grant in the same session without
  // showing the user anything. A SecureVector prompt rule means a human
  // decides on THIS call, so only the always-surfacing variant is faithful.
  assert.equal(EFFECT_TO_DECISION.prompt, 'force_ask');
});

test('decideFromOverrides maps effects onto Antigravity decisions', () => {
  const mk = (effect) => ({ synced: [{ tool_id: 'run_command', effect, reason: 'r' }] });
  assert.equal(decideFromOverrides(['run_command'], mk('deny')).decision, 'deny');
  assert.equal(decideFromOverrides(['run_command'], mk('prompt')).decision, 'force_ask');
  assert.equal(decideFromOverrides(['run_command'], mk('allow')).decision, 'allow');
});

test('decideFromOverrides fails open on no rules, no candidates, unknown effect', () => {
  assert.equal(decideFromOverrides([], { synced: [{ tool_id: 'run_command', effect: 'deny' }] }).decision, 'allow');
  assert.equal(decideFromOverrides(['run_command'], null).decision, 'allow');
  assert.equal(decideFromOverrides(['run_command'], { synced: [] }).decision, 'allow');
  assert.equal(
    decideFromOverrides(['run_command'], { synced: [{ tool_id: 'run_command', effect: 'wat' }] }).decision,
    'allow',
  );
});

test('decideFromOverrides matches a rule stored in a different casing', () => {
  const out = decideFromOverrides(['run_command'], { synced: [{ tool_id: 'RUN_COMMAND', effect: 'deny' }] });
  assert.equal(out.decision, 'deny');
});

test('a session-scoped JIT grant does not shadow a deny in another session', () => {
  const overrides = { synced: [
    { tool_id: 'run_command', effect: 'allow', source: 'jit_grant', session_id: 'other' },
    { tool_id: 'run_command', effect: 'deny', reason: 'no' },
  ] };
  assert.equal(decideFromOverrides(['run_command'], overrides, 'mine').decision, 'deny');
  assert.equal(decideFromOverrides(['run_command'], overrides, 'other').decision, 'allow');
});

test('a per-run limit row keyed * beats a tool-specific allow', () => {
  const overrides = { synced: [
    { tool_id: 'run_command', effect: 'allow' },
    { tool_id: '*', effect: 'deny', reason: 'Per-run limit reached' },
  ] };
  assert.equal(decideFromOverrides(['run_command'], overrides).decision, 'deny');
});

test('decisionToAuditAction covers every Antigravity decision value', () => {
  assert.equal(decisionToAuditAction('deny'), 'block');
  assert.equal(decisionToAuditAction('deny_unless_prior_grant'), 'block');
  assert.equal(decisionToAuditAction('ask'), 'log_only');
  assert.equal(decisionToAuditAction('force_ask'), 'log_only');
  assert.equal(decisionToAuditAction('allow'), 'allow');
});

test('readToolCall reads Antigravity toolCall.name / toolCall.args', () => {
  const { name, args } = readToolCall({ toolCall: { name: 'run_command', args: { command: 'ls' } } });
  assert.equal(name, 'run_command');
  assert.deepEqual(args, { command: 'ls' });
});

test('readToolCall parses args that arrive as a JSON string', () => {
  const { args } = readToolCall({ toolCall: { name: 'run_command', args: '{"command":"ls"}' } });
  assert.deepEqual(args, { command: 'ls' });
});

test('readToolCall survives a malformed args string without throwing', () => {
  const { args } = readToolCall({ toolCall: { name: 'run_command', args: 'not json' } });
  assert.equal(args, 'not json');
});

test('readToolCall returns empty name for an empty event', () => {
  assert.equal(readToolCall({}).name, '');
  assert.equal(readToolCall(null).name, '');
});

test('readSessionId reads conversationId, which is Antigravity session identity', () => {
  assert.equal(readSessionId({ conversationId: 'c-1' }), 'c-1');
  assert.equal(readSessionId({}), null);
});

test('isNetworkCapable covers the network built-ins and every non-built-in', () => {
  for (const t of ['run_command', 'search_web', 'read_url_content', 'generate_image']) {
    assert.equal(isNetworkCapable(t), true, t);
  }
  // A remote MCP server is an egress proxy, and "not a documented built-in" is
  // the only signal available because the MCP name shape is undocumented.
  assert.equal(isNetworkCapable('github__create_issue'), true);
  // Pure local reads must short-circuit before any egress round-trip.
  for (const t of ['view_file', 'list_directory', 'find_file', 'edit_file']) {
    assert.equal(isNetworkCapable(t), false, t);
  }
});
