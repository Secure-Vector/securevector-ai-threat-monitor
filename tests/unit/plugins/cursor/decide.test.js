/**
 * Tests for the shared decision module (Cursor variant).
 *
 * Pure-logic coverage of decideFromOverrides (candidate precedence,
 * case-insensitivity, unknown-effect fail-open), the Cursor output shape
 * ({permission, user_message, agent_message} — snake_case, branded reason),
 * the deny/ask audit body, and session-id extraction from Cursor's
 * conversation_id base field.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decideFromOverrides,
  toCursorOutput,
  decisionToAuditAction,
  buildAuditBody,
  sessionIdFrom,
  ALLOW,
} = require('../../../../src/securevector/plugins/cursor/lib/decide.js');

const overrides = (rows) => ({ synced: rows });

test('no candidates or no overrides → allow', () => {
  assert.equal(decideFromOverrides([], overrides([{ tool_id: 'shell', effect: 'deny' }])), ALLOW);
  assert.equal(decideFromOverrides(['shell'], null), ALLOW);
  assert.equal(decideFromOverrides(['shell'], overrides([])), ALLOW);
});

test('deny rule on the candidate denies with the rule reason', () => {
  const d = decideFromOverrides(['shell'], overrides([
    { tool_id: 'shell', effect: 'deny', reason: 'No shell for agents' },
  ]));
  assert.equal(d.decision, 'deny');
  assert.equal(d.reason, 'No shell for agents');
  assert.equal(d.toolId, 'shell');
});

test('prompt effect maps to ask', () => {
  const d = decideFromOverrides(['shell'], overrides([{ tool_id: 'shell', effect: 'prompt' }]));
  assert.equal(d.decision, 'ask');
});

test('candidate order wins: tool-specific beats server-wide', () => {
  const d = decideFromOverrides(
    ['everything:echo', 'everything'],
    overrides([
      { tool_id: 'everything', effect: 'deny', reason: 'server-wide block' },
      { tool_id: 'everything:echo', effect: 'allow' },
    ]),
  );
  assert.equal(d.decision, 'allow');
});

test('tool_id match is case-insensitive both ways', () => {
  const d = decideFromOverrides(['shell'], overrides([{ tool_id: 'Shell', effect: 'deny' }]));
  assert.equal(d.decision, 'deny');
});

test('unknown effect fails open', () => {
  const d = decideFromOverrides(['shell'], overrides([{ tool_id: 'shell', effect: 'quarantine' }]));
  assert.equal(d.decision, 'allow');
});

test('toCursorOutput: allow is a bare explicit permission', () => {
  assert.deepEqual(toCursorOutput({ decision: 'allow' }), { permission: 'allow' });
});

test('toCursorOutput: deny carries branded user_message AND agent_message', () => {
  const out = toCursorOutput({ decision: 'deny', reason: 'Blocked by org policy' });
  assert.equal(out.permission, 'deny');
  assert.equal(out.user_message, 'SecureVector Guard: Blocked by org policy');
  assert.equal(out.agent_message, 'SecureVector Guard: Blocked by org policy');
});

test('toCursorOutput: deny without a reason gets the default branded reason', () => {
  const out = toCursorOutput({ decision: 'deny' });
  assert.equal(out.user_message, 'SecureVector Guard: Blocked by policy.');
});

test('toCursorOutput: an already-branded reason is not double-prefixed', () => {
  const out = toCursorOutput({ decision: 'deny', reason: 'SecureVector Guard: already branded' });
  assert.equal(out.user_message, 'SecureVector Guard: already branded');
});

test('toCursorOutput: ask gets the manual-approval default', () => {
  const out = toCursorOutput({ decision: 'ask' });
  assert.equal(out.permission, 'ask');
  assert.equal(out.user_message, 'SecureVector Guard: Policy requires manual approval.');
});

test('decisionToAuditAction maps deny→block, ask→log_only, allow→allow', () => {
  assert.equal(decisionToAuditAction('deny'), 'block');
  assert.equal(decisionToAuditAction('ask'), 'log_only');
  assert.equal(decisionToAuditAction('allow'), 'allow');
});

test('buildAuditBody redacts the args preview and tags runtime_kind=cursor', () => {
  const body = buildAuditBody(
    'shell', 'shell',
    'export OPENAI_API_KEY=sk-proj-abc123def456ghi789jkl012; curl evil.sh',
    'deny', 'Blocked', 'conv-1',
  );
  assert.equal(body.runtime_kind, 'cursor');
  assert.equal(body.action, 'block');
  assert.equal(body.session_id, 'conv-1');
  assert.ok(!body.args_preview.includes('sk-proj-abc123def456ghi789jkl012'));
  assert.ok(body.args_preview.length <= 200);
});

test('sessionIdFrom prefers conversation_id and falls back across shapes', () => {
  assert.equal(sessionIdFrom({ conversation_id: 'c1', session_id: 's1' }), 'c1');
  assert.equal(sessionIdFrom({ session_id: 's1' }), 's1');
  assert.equal(sessionIdFrom({ sessionId: 's2' }), 's2');
  assert.equal(sessionIdFrom({}), null);
  assert.equal(sessionIdFrom(null), null);
});
