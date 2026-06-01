// Codex-specific PreToolUse contract tests.
//
// The Codex hook engine's output_parser.rs validates the JSON the hook
// writes to stdout against a stricter shape than Claude Code's:
//   - "allow" is only valid paired with `updatedInput`; bare allow
//     fails with `unsupported permissionDecision:allow`.
//   - "ask" is unsupported entirely.
//   - "deny" requires a non-empty `permissionDecisionReason`.
//
// Symptom that triggered this test file: a real Codex session running
// our v4.4.0 plugin failed every PreToolUse hook with
//   "PreToolUse hook returned unsupported permissionDecision:allow"
// because the codex copy of pre-tool-use.js was emitting Claude Code's
// shape verbatim. These tests pin the Codex-correct shape so we can't
// silently regress when the shared logic evolves.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { toHookOutput } = require(
  '../../../../src/securevector/plugins/codex/hooks/pre-tool-use.js'
);


test('Codex toHookOutput: allow OMITS permissionDecision entirely', () => {
  // Codex rejects `permissionDecision:allow` without `updatedInput`.
  // The implicit-allow signal is "no permissionDecision field at all".
  const out = toHookOutput({ decision: 'allow' });
  assert.deepEqual(out, {
    hookSpecificOutput: { hookEventName: 'PreToolUse' },
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(out.hookSpecificOutput, 'permissionDecision'),
    false,
    'permissionDecision must NOT be present on allow — Codex rejects it'
  );
});


test('Codex toHookOutput: deny with reason carries permissionDecisionReason', () => {
  const out = toHookOutput({ decision: 'deny', reason: 'blocked by policy' });
  assert.deepEqual(out, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'blocked by policy',
    },
  });
});


test('Codex toHookOutput: deny without reason supplies a generic fallback', () => {
  // Codex marks deny WITHOUT a non-empty reason as invalid_reason.
  // The hook MUST always fill the field so policy denies actually
  // block instead of silently passing through as invalid output.
  const out = toHookOutput({ decision: 'deny' });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(
    typeof out.hookSpecificOutput.permissionDecisionReason === 'string'
    && out.hookSpecificOutput.permissionDecisionReason.length > 0,
    'deny must always include a non-empty permissionDecisionReason'
  );
});


test('Codex toHookOutput: ask is converted to deny (Codex does not support ask)', () => {
  // A synced rule with effect=prompt would have been an "ask" on
  // Claude Code. Codex doesn't have an ask surface; the safe-default
  // mapping is deny so a policy that wanted user attention doesn't
  // silently allow.
  const out = toHookOutput({ decision: 'ask', reason: 'needs review' });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(
    out.hookSpecificOutput.permissionDecisionReason,
    /needs review/,
    'original policy reason should still appear in the converted deny reason'
  );
  assert.match(
    out.hookSpecificOutput.permissionDecisionReason,
    /ask/i,
    'fallback should explain the ask→deny conversion so audit log readers know why'
  );
});


test('Codex toHookOutput: ask without reason still produces a non-empty deny reason', () => {
  const out = toHookOutput({ decision: 'ask' });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(
    typeof out.hookSpecificOutput.permissionDecisionReason === 'string'
    && out.hookSpecificOutput.permissionDecisionReason.length > 0
  );
});
