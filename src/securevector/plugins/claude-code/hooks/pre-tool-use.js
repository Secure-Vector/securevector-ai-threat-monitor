#!/usr/bin/env node
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
const RUNTIME_KIND = 'claude-code';


/**
 * Pure decision logic: given normalized tool candidates and the local app's
 * synced-overrides response, return an internal decision object. The host's
 * exact wire format is applied later by `toHookOutput`.
 *
 * @param {string[]} candidates  Output of lib/normalize.js (may be empty).
 * @param {{synced?: Array<{tool_id: string, effect: string, reason?: string}>} | null} overrides
 * @returns {{decision: 'allow'|'deny'|'ask', reason?: string}}
 */
function decideFromOverrides(candidates, overrides) {
  if (!Array.isArray(candidates) || candidates.length === 0) return ALLOW;
  if (!overrides || !Array.isArray(overrides.synced) || overrides.synced.length === 0) {
    return ALLOW;
  }

  const byToolId = new Map();
  for (const row of overrides.synced) {
    if (row && typeof row.tool_id === 'string' && !byToolId.has(row.tool_id)) {
      byToolId.set(row.tool_id, row);
    }
  }

  // Candidates are ordered most-specific-first (prefixed before bare).
  for (const cand of candidates) {
    const match = byToolId.get(cand);
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
function buildAuditBody(toolName, toolId, toolInput, decision, reason) {
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
  };
}


/**
 * Wrap an internal decision in Claude Code's PreToolUse output format.
 *
 *   { hookSpecificOutput: { hookEventName: "PreToolUse",
 *                           permissionDecision: "...",
 *                           permissionDecisionReason: "..."? } }
 *
 * See: https://code.claude.com/docs/en/hooks#pretooluse-hook-decision-control
 *
 * @param {{decision: 'allow'|'deny'|'ask', reason?: string}} d
 */
// Branded prefix on every deny / ask reason so the host CLI's deny
// banner identifies SecureVector Guard as the enforcer. Without this,
// users see e.g. "User-set local override" with no indication of which
// hook produced it. Idempotent — won't double-prefix.
const REASON_PREFIX = 'SecureVector Guard';
function _brand(reason) {
  return reason.startsWith(REASON_PREFIX + ':')
    ? reason
    : `${REASON_PREFIX}: ${reason}`;
}

function toHookOutput(d) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: d.decision,
    },
  };
  if (typeof d.reason === 'string' && d.reason.length > 0) {
    // Only brand on non-allow paths — Claude Code's allow path doesn't
    // surface the reason to the user, so the prefix would just be
    // noise in any inadvertent log line.
    out.hookSpecificOutput.permissionDecisionReason =
      d.decision === 'allow' ? d.reason : _brand(d.reason);
  }
  return out;
}


/**
 * Async decision: normalize → fetch overrides → decide.
 *
 * @param {string} toolName  Host-supplied tool name (mcp__server__tool or built-in).
 * @param {string} baseUrl   Local app base URL.
 * @returns {Promise<{permissionDecision: 'allow'|'deny'|'ask', message?: string}>}
 */
async function decide(toolName, baseUrl) {
  const candidates = normalize(toolName);
  if (candidates.length === 0) return ALLOW; // unknown tool — short-circuit, no fetch
  const overrides = await fetchSyncedOverrides(baseUrl);
  return decideFromOverrides(candidates, overrides);
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
  const baseUrl = process.env.SV_BASE_URL || DEFAULT_BASE_URL;
  let decision = ALLOW;
  try {
    decision = await decide(toolName, baseUrl);
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
      buildAuditBody(toolName, decision.toolId, toolInput, decision.decision, decision.reason),
    );
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
