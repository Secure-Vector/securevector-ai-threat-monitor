#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * preToolUse hook handler for the SecureVector Guard plugin (GitHub Copilot CLI).
 *
 * Flow per invocation:
 *   1. Read the host's tool-call event JSON from stdin (camelCase fields).
 *   2. Extract toolName; normalize via lib/normalize (mcp__server__tool → candidates).
 *   3. Fetch synced overrides from the local app (100ms timeout, fail-open).
 *   4. Look up the first matching candidate. Map effect → permissionDecision:
 *        allow  → "allow"
 *        deny   → "deny"
 *        prompt → "ask"   (Copilot supports "ask"; under a cloud agent it is treated as deny)
 *   5. Print the decision JSON to stdout (Copilot's BARE object form, not hookSpecificOutput).
 *
 * ⚠️  FAIL-CLOSED INVERSION (the one thing that differs from every other harness).
 * Copilot CLI's preToolUse is **fail-CLOSED**: a non-zero exit, a timeout, or a
 * crash DENIES the tool call ("Denied by preToolUse hook (hook errored)"). That is
 * the opposite of Claude Code / Codex / Cursor / Devin, which fail open. SecureVector's
 * locked decision #5 is fail-OPEN — a broken / stopped local app must NEVER block the
 * host CLI. To honour that here we MUST:
 *   - catch every error path and emit an explicit {"permissionDecision":"allow"};
 *   - ALWAYS exit 0 (never throw to a non-zero exit);
 *   - rely on lib/client.js's 100ms client-side timeout so a slow app returns fast,
 *     well under Copilot's hook timeoutSec, before Copilot's fail-closed timeout fires.
 * If any of those slip, a down SecureVector app would start denying every tool call.
 *
 * Both MCP and built-in tool names route through normalize(). Unknown names
 * short-circuit to allow. Zero npm deps. Native Node 18+.
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
const RUNTIME_KIND = 'copilot-cli';
const REASON_PREFIX = 'SecureVector Guard';


/**
 * Pure decision logic: given normalized tool candidates and the local app's
 * synced-overrides response, return an internal decision object.
 *
 * @param {string[]} candidates
 * @param {{synced?: Array<{tool_id: string, effect: string, reason?: string}>} | null} overrides
 * @returns {{decision: 'allow'|'deny'|'ask', reason?: string, toolId?: string}}
 */
function decideFromOverrides(candidates, overrides) {
  if (!Array.isArray(candidates) || candidates.length === 0) return ALLOW;
  if (!overrides || !Array.isArray(overrides.synced) || overrides.synced.length === 0) {
    return ALLOW;
  }
  // Case-insensitive index, first-seen-wins per lowercased tool_id.
  const byToolId = new Map();
  for (const row of overrides.synced) {
    if (row && typeof row.tool_id === 'string') {
      const key = row.tool_id.toLowerCase();
      if (!byToolId.has(key)) byToolId.set(key, row);
    }
  }
  // Candidates are ordered most-specific-first.
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
    };
  }
  return ALLOW;
}


/** Map a decision to the audit-row `action` (mirrors post-tool-use). */
function decisionToAuditAction(decision) {
  switch (decision) {
    case 'deny': return 'block';
    case 'ask':  return 'log_only';
    default:     return 'allow';
  }
}


/**
 * Build the fire-and-forget audit payload for a denied / asked call.
 * PostToolUse never fires when preToolUse denies, so without this the
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


function _brand(reason) {
  return reason.startsWith(REASON_PREFIX + ':') ? reason : `${REASON_PREFIX}: ${reason}`;
}

/**
 * Wrap an internal decision in Copilot CLI's preToolUse output format.
 *
 * Copilot's contract (docs.github.com/en/copilot/reference/hooks-configuration):
 *   stdout = { permissionDecision: "allow"|"deny"|"ask",
 *              permissionDecisionReason?: string (REQUIRED when deny) }
 * — a BARE object, NOT wrapped in hookSpecificOutput (that's the Claude/Codex shape).
 * Unlike Codex, Copilot supports an explicit "allow" and supports "ask"
 * (treated as deny under a cloud agent, where no human can answer).
 *
 * We always emit an explicit "allow" (never empty output) on the allow path so
 * fail-open is unambiguous regardless of Copilot's default behavior.
 */
function toHookOutput(d) {
  if (d.decision === 'allow') {
    return { permissionDecision: 'allow' };
  }
  const reasonProvided = typeof d.reason === 'string' && d.reason.length > 0;
  if (d.decision === 'ask') {
    return {
      permissionDecision: 'ask',
      permissionDecisionReason: _brand(reasonProvided ? d.reason : 'Policy requires manual approval.'),
    };
  }
  return {
    permissionDecision: 'deny',
    permissionDecisionReason: _brand(reasonProvided ? d.reason : 'Blocked by policy.'),
  };
}


/**
 * Async decision: normalize → fetch overrides → decide. fetchSyncedOverrides
 * fails open (returns {} on any network error / timeout / non-2xx), so a down
 * app yields ALLOW here, not a throw.
 */
async function decide(toolName, baseUrl) {
  const candidates = normalize(toolName);
  if (candidates.length === 0) return ALLOW; // unknown tool — short-circuit, no fetch
  const overrides = await fetchSyncedOverrides(baseUrl, RUNTIME_KIND);
  return decideFromOverrides(candidates, overrides);
}


// --- stdin/stdout adapter (entry point) ---------------------------------

async function readAllStdin() {
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

/**
 * Copilot delivers `toolArgs` as a JSON *string* (per the docs tutorial),
 * while the reference types it `unknown`. Parse defensively so the audit
 * preview is meaningful either way; never throw.
 */
function coerceToolInput(toolArgs) {
  if (typeof toolArgs !== 'string') return toolArgs;
  try { return JSON.parse(toolArgs); } catch { return toolArgs; }
}

async function main() {
  // FAIL-OPEN GUARD: the entire body is wrapped so that ANY unexpected error
  // still prints an explicit allow and exits 0 — never a non-zero exit, which
  // Copilot would convert into a deny.
  let out = { permissionDecision: 'allow' };
  try {
    let event = {};
    try {
      const raw = await readAllStdin();
      event = raw ? JSON.parse(raw) : {};
    } catch {
      process.stdout.write(JSON.stringify(out));
      return;
    }
    const toolName = (event && (event.toolName || event.tool_name)) || '';
    const baseUrl = process.env.SV_BASE_URL || DEFAULT_BASE_URL;
    let decision = ALLOW;
    try {
      decision = await decide(toolName, baseUrl);
    } catch {
      decision = ALLOW;
    }
    if (decision.decision === 'deny' && decision.toolId) {
      const toolInput = coerceToolInput(event && (event.toolArgs !== undefined ? event.toolArgs : event.tool_input));
      const sessionId = (event && (event.sessionId || event.session_id)) || null;
      try {
        postJsonAndForget(
          `${baseUrl}/api/tool-permissions/call-audit`,
          buildAuditBody(toolName, decision.toolId, toolInput, decision.decision, decision.reason, sessionId),
        );
      } catch { /* swallow — audit is best-effort, must not affect the decision */ }
    }
    out = toHookOutput(decision);
  } catch {
    out = { permissionDecision: 'allow' };
  }
  process.stdout.write(JSON.stringify(out));
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
  coerceToolInput,
  EFFECT_TO_DECISION,
  ARGS_PREVIEW_LIMIT,
  RUNTIME_KIND,
};
