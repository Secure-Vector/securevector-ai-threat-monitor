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
const { fetchSyncedOverrides, postJsonAndForget, evaluateEgress } = require('../lib/client.js');
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
function decideFromOverrides(candidates, overrides, sessionId = null) {
  if (!Array.isArray(candidates) || candidates.length === 0) return ALLOW;
  if (!overrides || !Array.isArray(overrides.synced) || overrides.synced.length === 0) {
    return ALLOW;
  }
  // Case-insensitive index, first-seen-wins per lowercased tool_id.
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
      // Policy-marked requestable deny → the entry-point files a JIT
      // access request and tells the agent a human can approve it.
      requestable: match.requestable === true,
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
/**
 * Tools that can reach the network. Everything else short-circuits before any
 * egress round-trip. Kept in sync with NETWORK_CAPABLE_BUILTINS in
 * core/egress/destinations.py.
 */
const NETWORK_CAPABLE = new Set([
  'webfetch', 'websearch', 'bash', 'powershell',
  // Runtimes name their shell tool differently; this must stay a superset.
  // Mirrors NETWORK_CAPABLE_BUILTINS in core/egress/destinations.py.
  'shell', 'exec', 'terminal', 'run_terminal_cmd', 'runcommand', 'execute_command',
]);

function isNetworkCapable(toolName) {
  const n = String(toolName || '').toLowerCase();
  // A remote MCP server is an egress proxy: only its endpoint is observable
  // from here, but that endpoint still belongs on the record.
  return NETWORK_CAPABLE.has(n) || n.startsWith('mcp__');
}

async function decide(toolName, baseUrl, sessionId = null, toolInput = null) {
  const candidates = normalize(toolName);
  // Tool-permission rules key off the tool NAME. Egress rules key off the
  // DESTINATION, so a tool with no name-based rule can still be denied for
  // where it points — the egress check must run even with no candidates.
  if (candidates.length > 0) {
    const overrides = await fetchSyncedOverrides(baseUrl, RUNTIME_KIND);
    const decision = decideFromOverrides(candidates, overrides, sessionId);
    // A name-based deny already stops the call; evaluating egress on top would
    // add latency and a duplicate audit row for a call that never happens.
    if (decision.decision !== 'allow') return decision;
  }
  return decideEgress(toolName, toolInput, baseUrl, sessionId);
}


/**
 * Second gate: does this call's network destination violate the egress policy?
 * Fail-open on every error path, consistent with the fail-open invariant.
 */
async function decideEgress(toolName, toolInput, baseUrl, sessionId) {
  if (!isNetworkCapable(toolName)) return ALLOW;
  try {
    const result = await evaluateEgress(baseUrl, {
      tool_name: toolName,
      tool_input: toolInput || {},
      runtime_kind: RUNTIME_KIND,
      session_id: sessionId,
    });
    if (!result || result.action !== 'block') return ALLOW;
    const top = Array.isArray(result.verdicts)
      ? result.verdicts.find((v) => v && v.action === 'block')
      : null;
    let reason = (top && top.reason) || result.reason || 'Blocked by egress policy';
    if (top && top.remediation) reason += ` ${top.remediation}`;
    return {
      decision: 'deny',
      reason,
      toolId: toolName,
      // Egress denies are not JIT-requestable in v1: a JIT grant is keyed on
      // tool_id, which would open the tool for every host rather than the one
      // under review.
      requestable: false,
      egress: true,
    };
  } catch {
    return ALLOW;
  }
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
    const baseUrl = process.env.SECUREVECTOR_ENGINE_ENDPOINT || process.env.SV_BASE_URL || DEFAULT_BASE_URL;
    const sessionId = (event && (event.sessionId || event.session_id)) || null;
    const toolInputForCall = (event && (event.tool_input || event.toolInput)) || null;
    let decision = ALLOW;
    try {
      decision = await decide(toolName, baseUrl, sessionId, toolInputForCall);
    } catch {
      decision = ALLOW;
    }
    if (decision.decision === 'deny' && decision.toolId) {
      const toolInput = coerceToolInput(event && (event.toolArgs !== undefined ? event.toolArgs : event.tool_input));
      try {
        postJsonAndForget(
          `${baseUrl}/api/tool-permissions/call-audit`,
          buildAuditBody(toolName, decision.toolId, toolInput, decision.decision, decision.reason, sessionId),
        );
      } catch { /* swallow — audit is best-effort, must not affect the decision */ }
      // Requestable deny → file a JIT access request (fire-and-forget; the
      // server dedupes and caps the queue) and tell the agent a human can
      // approve time-boxed access. The deny itself stands.
      if (decision.requestable) {
        try {
          postJsonAndForget(`${baseUrl}/api/jit/requests`, {
            tool_id: decision.toolId,
            function_name: toolName,
            runtime_kind: RUNTIME_KIND,
            session_id: sessionId,
          });
        } catch { /* best-effort */ }
        decision = {
          ...decision,
          reason: `${decision.reason} — an access request was filed; a human can approve ` +
            'time-boxed access in SecureVector → Tool Permissions.',
        };
      }
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
