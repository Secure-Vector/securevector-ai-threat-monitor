#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * PreToolUse hook handler for the SecureVector Guard plugin.
 *
 * Flow per invocation:
 *   1. Read the host's tool-call event JSON from stdin.
 *   2. Extract tool_name; normalize via lib/normalize (mcp__server__tool → candidates).
 *   3. Fetch synced overrides from the local app (100ms timeout, fail-open).
 *   4. Look up the first matching candidate. Map effect → permissionDecision:
 *        allow  → "allow"
 *        deny   → "deny"
 *        prompt → "ask"
 *   5. Print the decision JSON to stdout.
 *
 * Fail-open invariant (locked decision #5): any error path — unreachable
 * local app, timeout, malformed response, unknown effect — emits
 * `{permissionDecision: "allow"}` and the tool call proceeds. The whole
 * point of fail-open is that a broken / stopped local app cannot block
 * the host CLI.
 *
 * Both MCP and built-in (Bash / Edit / Read / etc.) tool names route
 * through `normalize()` to lookup candidates and the same synced-rule
 * lookup path. Unknown names short-circuit to allow.
 *
 * Zero npm deps. Native Node 18+.
 */

'use strict';

const { normalize } = require('../lib/normalize.js');
const { fetchSyncedOverrides, postJsonAndForget } = require('../lib/client.js');
const { redactForScan } = require('../lib/redact.js');

const EFFECT_TO_DECISION = Object.freeze({
  allow: 'allow',
  deny: 'deny',
  prompt: 'ask',
});

const DEFAULT_BASE_URL = 'http://127.0.0.1:8741';
const ALLOW = Object.freeze({ decision: 'allow' });
const ARGS_PREVIEW_LIMIT = 200;
const RUNTIME_KIND = 'codex';


/**
 * Pure decision logic: given normalized tool candidates and the local app's
 * synced-overrides response, return an internal decision object. The host's
 * exact wire format is applied later by `toHookOutput`.
 *
 * @param {string[]} candidates  Output of lib/normalize.js (may be empty).
 * @param {{synced?: Array<{tool_id: string, effect: string, reason?: string}>} | null} overrides
 * @returns {{decision: 'allow'|'deny'|'ask', reason?: string}}
 */
function decideFromOverrides(candidates, overrides, sessionId = null) {
  if (!Array.isArray(candidates) || candidates.length === 0) return ALLOW;
  if (!overrides || !Array.isArray(overrides.synced) || overrides.synced.length === 0) {
    return ALLOW;
  }

  // Case-insensitive index. Cloud-pushed and local-UI rules may store
  // `tool_id` in any casing (e.g. lowercase `read`) while normalize()
  // emits canonical PascalCase built-ins (`Read`). Keying by lowercase
  // stops a deny rule from silently failing open on a casing mismatch.
  // First-seen-wins is preserved per lowercased key.
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

  // Candidates are ordered most-specific-first (prefixed before bare).
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
      // toolId is the matched candidate (most-specific). Exposed on the
      // non-allow path so the entry-point can audit the deny with the
      // canonical tool_id without re-running normalize().
      toolId: cand,
      // Policy-marked requestable deny → the entry-point files a JIT
      // access request and tells the agent a human can approve it.
      requestable: match.requestable === true,
    };
  }
  return ALLOW;
}


/**
 * Map a PreToolUse decision to the audit-row `action` value. Mirrors
 * effectToAction in post-tool-use.js so block-from-PreToolUse and
 * block-from-PostToolUse hash-chain rows are indistinguishable when
 * filtering the audit log by `action`.
 */
function decisionToAuditAction(decision) {
  switch (decision) {
    case 'deny': return 'block';
    case 'ask':  return 'log_only';
    default:     return 'allow';
  }
}


/**
 * Build the fire-and-forget audit payload for a denied (or asked) call.
 *
 * Why this exists: PostToolUse only fires after a successful tool
 * execution. When PreToolUse denies, the tool never runs and PostToolUse
 * never fires — so without auditing here, blocked attempts leave NO
 * audit trail. That's a real observability gap (denied calls are the
 * highest-value security events). This closes it by writing the row
 * before returning the deny decision.
 *
 * Args preview uses the same shared redactForScan + 200-char cap as
 * post-tool-use, so block rows and allow rows look identical apart from
 * the action.
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


/**
 * Wrap an internal decision in Codex's PreToolUse output format.
 *
 * Codex's PreToolUse contract is stricter than Claude Code's
 * (verified empirically against the
 * `codex-rs/hooks/src/engine/output_parser.rs` validator):
 *
 *   - "allow" is only valid when paired with `updatedInput` (input
 *     rewriting). Emitting bare `permissionDecision: "allow"` fails
 *     with `unsupported permissionDecision:allow`. To express an
 *     implicit allow we omit `permissionDecision` entirely — Codex
 *     treats the absence as proceed.
 *   - "ask" is unsupported. We convert to "deny" with a clarifying
 *     reason so a policy that says "prompt the user" blocks instead
 *     of silently allowing (safer side of the precedence chain).
 *   - "deny" requires a non-empty `permissionDecisionReason`. We
 *     fall back to a generic reason when the policy didn't supply
 *     one, otherwise Codex would mark the response invalid.
 *
 * Wire shape:
 *
 *   { hookSpecificOutput: { hookEventName: "PreToolUse",
 *                           permissionDecision?: "deny",
 *                           permissionDecisionReason?: "..." } }
 *
 * @param {{decision: 'allow'|'deny'|'ask', reason?: string}} d
 */
// Branded prefix shown to the host CLI on every deny reason. Codex's
// TUI surfaces the raw `permissionDecisionReason` string ("feedback:
// <reason>") with no indication of which hook produced it — without a
// prefix, a developer using Codex sees "User-set local override" and
// has no idea SecureVector Guard is the enforcer. Prefixing here makes
// the source unambiguous in every deny banner.
const REASON_PREFIX = 'SecureVector Guard';

function _brand(reason) {
  // Idempotent: don't double-prefix on reasons we already branded
  // (e.g. when the user crafts a reason that already starts with our
  // tag).
  return reason.startsWith(REASON_PREFIX + ':')
    ? reason
    : `${REASON_PREFIX}: ${reason}`;
}

function toHookOutput(d) {
  if (d.decision === 'allow') {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse' } };
  }
  const reasonProvided = typeof d.reason === 'string' && d.reason.length > 0;
  if (d.decision === 'ask') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: _brand(
          reasonProvided
            ? `${d.reason} (Codex doesn't support 'ask'; treating as deny)`
            : "Policy requested user prompt; Codex doesn't support 'ask', treating as deny.",
        ),
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: _brand(reasonProvided ? d.reason : 'Blocked by policy.'),
    },
  };
}


/**
 * Async decision: normalize → fetch overrides → decide.
 *
 * @param {string} toolName  Host-supplied tool name (mcp__server__tool or built-in).
 * @param {string} baseUrl   Local app base URL.
 * @returns {Promise<{permissionDecision: 'allow'|'deny'|'ask', message?: string}>}
 */
async function decide(toolName, baseUrl, sessionId = null) {
  const candidates = normalize(toolName);
  if (candidates.length === 0) return ALLOW; // unknown tool — short-circuit, no fetch
  const overrides = await fetchSyncedOverrides(baseUrl, RUNTIME_KIND);
  return decideFromOverrides(candidates, overrides, sessionId);
}


// --- stdin/stdout adapter (entry point) ---------------------------------

async function readAllStdin() {
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

async function main() {
  let event = {};
  try {
    const raw = await readAllStdin();
    event = raw ? JSON.parse(raw) : {};
  } catch {
    process.stdout.write(JSON.stringify(toHookOutput(ALLOW)));
    return;
  }
  const toolName = (event && (event.tool_name || event.toolName)) || '';
  const baseUrl = process.env.SECUREVECTOR_ENGINE_ENDPOINT || process.env.SV_BASE_URL || DEFAULT_BASE_URL;
  const sessionId = (event && (event.session_id || event.sessionId)) || null;
  let decision = ALLOW;
  try {
    decision = await decide(toolName, baseUrl, sessionId);
  } catch {
    decision = ALLOW;
  }
  // Audit blocked attempts here — PostToolUse never fires on deny so
  // without this the chain has no record of the highest-value events.
  // Fire-and-forget: a slow / unreachable local app cannot delay the
  // decision return below. The enforcement decision was already
  // computed above; this is purely the audit row.
  if (decision.decision === 'deny' && decision.toolId) {
    const toolInput = event && (event.tool_input || event.toolInput);
    postJsonAndForget(
      `${baseUrl}/api/tool-permissions/call-audit`,
      buildAuditBody(toolName, decision.toolId, toolInput, decision.decision, decision.reason, sessionId),
    );
    // Requestable deny → file a JIT access request (fire-and-forget; the
    // server dedupes per tool+runtime+session and caps the queue) and tell
    // the agent a human can approve it. The deny itself stands — access
    // only opens after approval flips a time-boxed grant into the
    // overrides this hook reads on its next call.
    if (decision.requestable) {
      postJsonAndForget(`${baseUrl}/api/jit/requests`, {
        tool_id: decision.toolId,
        function_name: toolName,
        runtime_kind: RUNTIME_KIND,
        session_id: sessionId,
      });
      decision = {
        ...decision,
        reason: `${decision.reason} — an access request was filed; a human can approve ` +
          'time-boxed access in SecureVector → Tool Permissions.',
      };
    }
  }
  process.stdout.write(JSON.stringify(toHookOutput(decision)));
}

if (require.main === module) {
  main();
}

module.exports = {
  decide,
  decideFromOverrides,
  toHookOutput,
  decisionToAuditAction,
  buildAuditBody,
  EFFECT_TO_DECISION,
  ARGS_PREVIEW_LIMIT,
  RUNTIME_KIND,
};
