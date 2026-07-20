// SPDX-License-Identifier: Apache-2.0
/**
 * Shared allow/deny/ask decision logic for the Cursor Guard plugin.
 *
 * Cursor splits enforcement across two event-typed hooks
 * (beforeShellExecution, beforeMCPExecution) that need IDENTICAL decision
 * semantics, so the logic lives here once instead of being duplicated per
 * script. The decision pipeline is the same as every other Guard plugin:
 * normalize the tool name into candidates → fetch synced overrides for
 * runtime "cursor" (100ms timeout, fail-open) → first candidate match wins.
 *
 * Output is Cursor's hook contract (cursor.com/docs/agent/hooks):
 *   { permission: "allow"|"deny"|"ask", user_message?, agent_message? }
 * `user_message` is shown to the human; `agent_message` goes back to the
 * model so it can route around the block. Cursor is fail-OPEN by default
 * (exit codes other than 0/2 proceed), which matches locked decision #5 —
 * but every hook still always exits 0 with an explicit permission so
 * behaviour never depends on the host's failure default.
 */

'use strict';

const { fetchSyncedOverrides, postJsonAndForget } = require('./client.js');
const { redactForScan } = require('./redact.js');

const DEFAULT_BASE_URL = 'http://127.0.0.1:8741';
const ALLOW = Object.freeze({ decision: 'allow' });
const ARGS_PREVIEW_LIMIT = 200;
const RUNTIME_KIND = 'cursor';
const REASON_PREFIX = 'SecureVector Guard';

const EFFECT_TO_DECISION = Object.freeze({
  allow: 'allow',
  deny: 'deny',
  prompt: 'ask',
});

/**
 * Pure decision logic: candidates × synced overrides → internal decision.
 * Case-insensitive index, first-seen-wins per lowercased tool_id; candidate
 * order (most-specific-first) decides precedence.
 */
function decideFromOverrides(candidates, overrides, sessionId = null) {
  if (!Array.isArray(candidates) || candidates.length === 0) return ALLOW;
  if (!overrides || !Array.isArray(overrides.synced) || overrides.synced.length === 0) {
    return ALLOW;
  }
  const byToolId = new Map();
  for (const row of overrides.synced) {
    if (row && typeof row.tool_id === 'string') {
      // A session-scoped JIT grant only applies inside the session it was
      // approved for. Skip at index time: grants are emitted first, so an
      // unskipped non-matching grant would win first-seen-wins and shadow
      // the deny it overrides — silently allowing other sessions.
      if (row.source === 'jit_grant' && row.session_id
          && row.session_id !== sessionId) continue;
      const key = row.tool_id.toLowerCase();
      if (!byToolId.has(key)) byToolId.set(key, row);
    }
  }
  for (const cand of candidates) {
    const match = byToolId.get(cand.toLowerCase());
    if (!match) continue;
    const mapped = EFFECT_TO_DECISION[match.effect];
    if (!mapped) return ALLOW; // unknown effect → fail-open
    if (mapped === 'allow') return ALLOW;
    return {
      decision: mapped,
      reason: typeof match.reason === 'string' && match.reason.length > 0
        ? match.reason
        : `Tool ${cand} matched policy with effect ${match.effect}`,
      toolId: cand,
      // Policy-marked requestable deny → the hook files a JIT access
      // request and tells the agent a human can approve it.
      requestable: match.requestable === true,
    };
  }
  return ALLOW;
}

/** Async decision for a candidate list. fetchSyncedOverrides fails open. */
async function decideForCandidates(candidates, baseUrl, sessionId = null) {
  if (!Array.isArray(candidates) || candidates.length === 0) return ALLOW;
  const overrides = await fetchSyncedOverrides(baseUrl, RUNTIME_KIND);
  return decideFromOverrides(candidates, overrides, sessionId);
}

/**
 * On a requestable deny: file a JIT access request (fire-and-forget; the
 * server dedupes per tool+runtime+session and caps the queue) and return the
 * decision with the "you can request access" hint appended. The deny stands —
 * access only opens after a human approves a time-boxed grant in the local
 * web UI, which surfaces in the overrides this plugin reads on later calls.
 */
function maybeFileJitRequest(baseUrl, toolName, d, sessionId) {
  if (d.decision !== 'deny' || !d.requestable || !d.toolId) return d;
  try {
    postJsonAndForget(`${baseUrl}/api/jit/requests`, {
      tool_id: d.toolId,
      function_name: toolName,
      runtime_kind: RUNTIME_KIND,
      session_id: sessionId || null,
    });
  } catch { /* best-effort */ }
  return {
    ...d,
    reason: `${d.reason} — an access request was filed; a human can approve ` +
      'time-boxed access in SecureVector → Tool Permissions.',
  };
}

function _brand(reason) {
  return reason.startsWith(REASON_PREFIX + ':') ? reason : `${REASON_PREFIX}: ${reason}`;
}

/**
 * Wrap an internal decision in Cursor's snake_case output shape. An explicit
 * `permission: "allow"` is always emitted (never an empty object) so the
 * allow path is unambiguous regardless of the host's defaults.
 */
function toCursorOutput(d) {
  if (d.decision === 'allow') {
    return { permission: 'allow' };
  }
  const reason = typeof d.reason === 'string' && d.reason.length > 0
    ? d.reason
    : (d.decision === 'ask' ? 'Policy requires manual approval.' : 'Blocked by policy.');
  return {
    permission: d.decision,
    user_message: _brand(reason),
    // The agent gets the same branded reason so it can explain the block
    // and try a policy-compliant alternative instead of retrying blind.
    agent_message: _brand(reason),
  };
}

/** Map a decision to the audit-row `action`. */
function decisionToAuditAction(decision) {
  switch (decision) {
    case 'deny': return 'block';
    case 'ask':  return 'log_only';
    default:     return 'allow';
  }
}

/**
 * Build the fire-and-forget audit payload for a denied/asked call. The
 * after* hooks never fire when a before* hook denies, so without this the
 * highest-value security events (blocked attempts) leave no audit trail.
 */
function buildAuditBody(toolName, toolId, toolInput, decision, reason, sessionId) {
  let argsPreview = null;
  try {
    if (toolInput !== undefined && toolInput !== null) {
      const raw = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);
      argsPreview = redactForScan(raw).slice(0, ARGS_PREVIEW_LIMIT);
    }
  } catch { /* swallow — empty preview is acceptable */ }
  return {
    tool_id: toolId,
    function_name: toolName,
    action: decisionToAuditAction(decision),
    risk: null,
    reason: typeof reason === 'string' && reason.length > 0 ? reason : null,
    is_essential: false,
    args_preview: argsPreview,
    runtime_kind: RUNTIME_KIND,
    session_id: sessionId || null,
  };
}

/** POST the deny/ask audit row, best-effort. */
function auditDecision(baseUrl, toolName, toolInput, d, sessionId) {
  if (d.decision === 'allow' || !d.toolId) return;
  try {
    postJsonAndForget(
      `${baseUrl}/api/tool-permissions/call-audit`,
      buildAuditBody(toolName, d.toolId, toolInput, d.decision, d.reason, sessionId),
    );
  } catch { /* swallow — audit is best-effort, must not affect the decision */ }
}

/** Cursor's common base fields carry conversation_id; use it as session id. */
function sessionIdFrom(event) {
  if (!event || typeof event !== 'object') return null;
  for (const key of ['conversation_id', 'session_id', 'conversationId', 'sessionId']) {
    if (typeof event[key] === 'string' && event[key].length > 0) return event[key];
  }
  return null;
}

async function readAllStdin() {
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

module.exports = {
  decideFromOverrides,
  decideForCandidates,
  maybeFileJitRequest,
  toCursorOutput,
  decisionToAuditAction,
  buildAuditBody,
  auditDecision,
  sessionIdFrom,
  readAllStdin,
  ALLOW,
  EFFECT_TO_DECISION,
  ARGS_PREVIEW_LIMIT,
  RUNTIME_KIND,
  DEFAULT_BASE_URL,
};
