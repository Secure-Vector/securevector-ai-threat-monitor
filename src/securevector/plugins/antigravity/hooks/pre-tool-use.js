#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * PreToolUse hook handler for the SecureVector Guard plugin (Antigravity).
 *
 * Flow per invocation:
 *   1. Read Antigravity's tool-call event JSON from stdin.
 *   2. Extract `toolCall.name`; normalize via lib/normalize.
 *   3. Fetch synced overrides from the local app (100ms timeout, fail-open).
 *   4. Look up the first matching candidate, then evaluate egress.
 *   5. Print Antigravity's decision JSON to stdout and exit 0.
 *
 * Fail-open invariant (locked decision #5): any error path, unreachable local
 * app, timeout, malformed response, unknown effect, emits
 * `{"decision":"allow"}` so a broken or stopped local app cannot block the
 * host CLI.
 *
 * Antigravity's own behaviour when a hook errors, times out, or writes
 * malformed JSON is NOT documented first-party, so this hook is written to be
 * correct on a fail-closed host as well: every path, including a stdin parse
 * failure, writes an explicit allow decision and exits 0. On a fail-open host
 * that is merely redundant; on a fail-closed one it is the difference between
 * a down app being invisible and a down app denying every tool call.
 *
 * Zero npm deps. Native Node 18+.
 */

'use strict';

const { normalize, isMcpToolName } = require('../lib/normalize.js');
const { resolveBaseUrl, fetchSyncedOverrides, postJsonAndForget, evaluateEgress } = require('../lib/client.js');
const { redactForScan } = require('../lib/redact.js');

/**
 * Tools that can reach the network. Everything else short-circuits before any
 * egress round-trip, so the common view_file / list_directory path costs one
 * Set lookup and adds zero latency.
 *
 * Mirrors NETWORK_CAPABLE_BUILTINS in core/egress/destinations.py. A name
 * missing here means egress is silently not enforced for that tool, so err
 * toward including anything plausibly network-capable: the server-side
 * extractor returns `network_capable: false` for a tool it cannot route,
 * which costs one wasted round-trip and nothing else.
 *
 * This set lists only Antigravity's own built-ins rather than the union of
 * every runtime's shell aliases, because `isNetworkCapable` falls through to
 * `isMcpToolName`, which is true for anything that is not a documented
 * built-in. A name missing from this set therefore cannot open an enforcement
 * hole here; it can only cost the round-trip the set exists to avoid.
 */
const NETWORK_CAPABLE = new Set([
  'run_command',
  'search_web',
  'read_url_content',
  'generate_image',
]);

function isNetworkCapable(toolName) {
  const n = String(toolName || '').toLowerCase();
  // A remote MCP server is an egress proxy: its endpoint is the only
  // destination observable from here, and whatever it reaches downstream is
  // structurally invisible. Still worth evaluating so the endpoint is on the
  // record. Antigravity's MCP name shape is unverified, so "not a documented
  // built-in" is the only available signal.
  return NETWORK_CAPABLE.has(n) || isMcpToolName(n);
}

/**
 * Policy effect to Antigravity `decision`.
 *
 * `prompt` maps to `force_ask`, not `ask`. Antigravity's PreToolUse contract
 * offers both, and `ask` is the variant a prior grant in the same session can
 * satisfy without showing the user anything. A SecureVector `prompt` rule
 * means a human decides on this call, so the variant that always surfaces is
 * the faithful one. (The 2026-06 design note predated `force_ask` and
 * `deny_unless_prior_grant` appearing in the documented enum.)
 */
const EFFECT_TO_DECISION = Object.freeze({
  allow: 'allow',
  deny: 'deny',
  prompt: 'force_ask',
});

/**
 * Map a policy row's effect to a decision, case-insensitively.
 *
 * The tool id is already lowercased before lookup so a deny cannot fail open
 * on a casing mismatch; the effect deserves the same treatment, and did not
 * have it. An effect that is still unrecognised after normalising is NOT an
 * allow: it is a row this plugin is too old to understand, and the engine
 * gained `deny_unless_prior_grant` exactly this way. Asking the human is the
 * only answer that is safe whichever direction the unknown effect meant.
 *
 * @param {unknown} effect
 * @returns {{ decision: string, known: boolean }}
 */
function decisionForEffect(effect) {
  const key = typeof effect === 'string' ? effect.trim().toLowerCase() : '';
  const mapped = Object.prototype.hasOwnProperty.call(EFFECT_TO_DECISION, key)
    ? EFFECT_TO_DECISION[key]
    : undefined;
  if (mapped === undefined) return { decision: 'force_ask', known: false };
  return { decision: mapped, known: true };
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8741';
const ALLOW = Object.freeze({ decision: 'allow' });
const ARGS_PREVIEW_LIMIT = 8192; // 8 KB, redacted; the app redacts and caps again on write
const RUNTIME_KIND = 'antigravity';


/**
 * Pure decision logic: given normalized tool candidates and the local app's
 * synced-overrides response, return an internal decision object. The host's
 * wire format is applied later by `toHookOutput`.
 *
 * @param {string[]} candidates  Output of lib/normalize.js (may be empty).
 * @param {{synced?: Array<{tool_id: string, effect: string, reason?: string}>} | null} overrides
 * @param {string|null} [sessionId]  The host conversation, for session-scoped JIT grants.
 * @returns {{decision: string, reason?: string}}
 */
function decideFromOverrides(candidates, overrides, sessionId = null) {
  if (!Array.isArray(candidates) || candidates.length === 0) return ALLOW;
  if (!overrides || !Array.isArray(overrides.synced) || overrides.synced.length === 0) {
    return ALLOW;
  }

  // Case-insensitive index. Cloud-pushed and local-UI rules may store
  // `tool_id` in any casing while normalize() emits lowercase, so keying by
  // lowercase stops a deny rule failing open on a casing mismatch.
  // First-seen-wins is preserved per lowercased key.
  const byToolId = new Map();
  for (const row of overrides.synced) {
    if (row && typeof row.tool_id === 'string') {
      // A session-scoped JIT grant only applies inside the session it was
      // approved for. Skipping the row here rather than at match time
      // matters: grants are emitted first, so an unskipped non-matching
      // grant would win the first-seen-wins slot and shadow the very deny it
      // was meant to override.
      if (row.source === 'jit_grant' && row.session_id
          && row.session_id !== sessionId) continue;
      const key = row.tool_id.toLowerCase();
      if (!byToolId.has(key)) byToolId.set(key, row);
    }
  }

  // Per-run limit rows are keyed '*' and apply to every tool. Checked ahead of
  // the candidates so a tool-specific allow cannot bypass a run stop. The
  // sanctioned lift suppresses these rows server-side, so any '*' row that
  // arrives is meant to act.
  const runRow = byToolId.get('*');
  if (runRow) {
    const runMapped = decisionForEffect(runRow.effect).decision;
    if (runMapped !== 'allow') {
      return {
        decision: runMapped,
        reason: typeof runRow.reason === 'string' && runRow.reason.length > 0
          ? runRow.reason
          : 'Per-run limit reached',
        toolId: candidates[0],
        requestable: runRow.requestable === true,
      };
    }
  }

  for (const cand of candidates) {
    const match = byToolId.get(cand.toLowerCase());
    if (!match) continue;
    const { decision: mapped, known } = decisionForEffect(match.effect);
    if (mapped === 'allow') return ALLOW;
    return {
      decision: mapped,
      unknownEffect: !known,
      reason: typeof match.reason === 'string' && match.reason.length > 0
        ? match.reason
        : (known
          ? `Tool ${cand} matched policy with effect ${match.effect}`
          : `Tool ${cand} matched a policy rule this plugin does not understand. Approve only if you meant to.`),
      // The matched (most-specific) candidate, exposed on the non-allow path
      // so the entry-point can audit with the canonical tool_id without
      // re-running normalize().
      toolId: cand,
      // Policy-marked requestable deny: the entry-point files a JIT access
      // request and tells the agent a human can approve it.
      requestable: match.requestable === true,
    };
  }
  return ALLOW;
}


/**
 * Map a PreToolUse decision to the audit-row `action` value. Mirrors
 * effectToAction in post-tool-use.js so a block recorded from PreToolUse and
 * one recorded from PostToolUse are indistinguishable when filtering the
 * audit log by `action`.
 */
function decisionToAuditAction(decision) {
  switch (decision) {
    case 'deny':
    case 'deny_unless_prior_grant':
      return 'block';
    case 'ask':
    case 'force_ask':
      return 'log_only';
    default:
      return 'allow';
  }
}


/**
 * Build the fire-and-forget audit payload for a denied call.
 *
 * Why this exists: PostToolUse only fires after a tool actually runs. When
 * PreToolUse denies, the tool never runs and PostToolUse never fires, so
 * without auditing here blocked attempts would leave no trail at all, and
 * denied calls are the highest-value security events.
 */
function buildAuditBody(toolName, toolId, toolInput, decision, reason, sessionId) {
  let argsPreview = null;
  try {
    if (toolInput !== undefined && toolInput !== null) {
      const raw = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);
      argsPreview = redactForScan(raw).slice(0, ARGS_PREVIEW_LIMIT);
    }
  } catch { /* swallow, an empty preview is acceptable */ }
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


// Branded prefix on every non-allow reason so Antigravity's deny banner
// identifies SecureVector Guard as the enforcer. Without it the user sees a
// bare reason with no indication of which hook produced it. Idempotent.
const REASON_PREFIX = 'SecureVector Guard';
function _brand(reason) {
  return reason.startsWith(REASON_PREFIX + ':')
    ? reason
    : `${REASON_PREFIX}: ${reason}`;
}

/**
 * Wrap an internal decision in Antigravity's PreToolUse output format:
 *
 *   { "decision": "allow" | "deny" | "ask" | "force_ask"
 *                 | "deny_unless_prior_grant",
 *     "reason": "..."? }
 *
 * `permissionOverrides` is deliberately never emitted: it grants standing
 * permission, and a Guard has no business widening what the agent may do.
 *
 * See: https://antigravity.google/docs/hooks
 */
function toHookOutput(d) {
  const out = { decision: d && d.decision ? d.decision : 'allow' };
  if (typeof d.reason === 'string' && d.reason.length > 0) {
    // Only brand on non-allow paths. Antigravity does not surface the reason
    // on allow, so the prefix would just be noise in any incidental log line.
    out.reason = out.decision === 'allow' ? d.reason : _brand(d.reason);
  }
  return out;
}


/**
 * Async decision: normalize, fetch overrides, decide, then evaluate egress.
 *
 * @param {string} toolName  Value of `toolCall.name`.
 * @param {string} baseUrl   Local app base URL.
 */
async function decide(toolName, baseUrl, sessionId = null, toolInput = null) {
  const candidates = normalize(toolName);
  // Tool-permission rules key off the tool NAME. Egress rules key off the
  // DESTINATION, so a tool with no name-based rule can still be denied for
  // where it points, which means the egress check must run even when
  // normalize() yields no candidates.
  if (candidates.length > 0) {
    const overrides = await fetchSyncedOverrides(baseUrl, RUNTIME_KIND, { sessionId });
    const decision = decideFromOverrides(candidates, overrides, sessionId);
    // A name-based deny already stops the call; evaluating egress on top would
    // add latency and a duplicate audit row for a call that never happens.
    if (decision.decision !== 'allow') return decision;
  }
  return decideEgress(toolName, toolInput, baseUrl, sessionId);
}


/**
 * Second gate: does this call's network destination violate the egress policy?
 *
 * Extraction and evaluation live server-side so there is one implementation of
 * shell-command parsing rather than one per runtime plugin. This function only
 * decides whether the round-trip is worth making.
 *
 * Fail-open on every error path. When the policy is fail-closed the server
 * returns `block` itself; an unreachable server cannot convey that intent, and
 * wedging every agent on the machine because the local app stopped is the
 * wrong failure mode.
 */
async function decideEgress(toolName, toolInput, baseUrl, sessionId) {
  if (!isNetworkCapable(toolName)) return ALLOW;
  try {
    const result = await evaluateEgress(baseUrl, {
      tool_name: toolName,
      tool_input: toolInput === undefined || toolInput === null ? {} : toolInput,
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
      // Egress denies are not JIT-requestable: the JIT flow grants access to a
      // TOOL, while an egress deny is about a DESTINATION, and a grant keyed
      // on tool_id would open the tool for every host, not the one in review.
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
 * Pull the tool name and args out of an Antigravity PreToolUse event.
 *
 * The documented shape is `{ toolCall: { name, args }, stepIdx,
 * conversationId, workspacePaths, transcriptPath, artifactDirectoryPath,
 * modelName }`. The flat `tool_name` / `toolName` fallbacks cost nothing and
 * keep the hook working if a build ever sends the sibling harnesses' shape.
 *
 * `args` is documented as an object, but tool arguments arrive as a JSON
 * STRING often enough across harnesses that parsing defensively is cheaper
 * than an empty args_preview on every call.
 */
function readToolCall(event) {
  const call = (event && typeof event.toolCall === 'object' && event.toolCall) || {};
  const name = (typeof call.name === 'string' && call.name)
    || (event && (event.tool_name || event.toolName))
    || '';
  let args = call.args !== undefined ? call.args : (event && (event.tool_input || event.toolInput));
  if (typeof args === 'string' && args.length > 0) {
    try { args = JSON.parse(args); } catch { /* keep the raw string */ }
  }
  return { name, args: args === undefined ? null : args };
}

/** Antigravity's session identity is `conversationId`. */
function readSessionId(event) {
  return (event && (event.conversationId || event.conversation_id || event.session_id)) || null;
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
  const { name: toolName, args: toolInput } = readToolCall(event);
  const baseUrl = resolveBaseUrl();
  const sessionId = readSessionId(event);
  let decision = ALLOW;
  try {
    decision = await decide(toolName, baseUrl, sessionId, toolInput);
  } catch {
    decision = ALLOW;
  }
  // Audit blocked attempts here: PostToolUse never fires on deny, so without
  // this the chain has no record of the highest-value events. Fire-and-forget,
  // so a slow or unreachable local app cannot delay the decision below.
  //
  // Egress denies are already persisted server-side (one row per destination
  // in egress_audit, written by /api/egress/evaluate before it answered), so
  // posting here too would double-count the same block.
  if (decision.decision === 'deny' && decision.toolId && !decision.egress) {
    postJsonAndForget(
      `${baseUrl}/api/tool-permissions/call-audit`,
      buildAuditBody(toolName, decision.toolId, toolInput, decision.decision, decision.reason, sessionId),
    );
    // Requestable deny: file a JIT access request (fire-and-forget; the server
    // dedupes per tool+runtime+session and caps the queue) and tell the agent
    // a human can approve it. The deny itself stands; access only opens after
    // an approval flips a time-boxed grant into the overrides this hook reads
    // on its next call.
    if (decision.requestable) {
      postJsonAndForget(`${baseUrl}/api/jit/requests`, {
        tool_id: decision.toolId,
        function_name: toolName,
        runtime_kind: RUNTIME_KIND,
        session_id: sessionId,
      });
      decision = {
        ...decision,
        reason: `${decision.reason}. An access request was filed; a human can approve `
          + 'time-boxed access in SecureVector, Tool Permissions.',
      };
    }
  }
  process.stdout.write(JSON.stringify(toHookOutput(decision)));
}

if (require.main === module) {
  // Belt-and-suspenders for a host whose fail mode is undocumented: an
  // unexpected throw anywhere above must still leave a valid allow on stdout
  // rather than an empty stream Antigravity is free to read as a refusal.
  main().catch(() => {
    process.stdout.write(JSON.stringify(toHookOutput(ALLOW)));
  });
}

module.exports = {
  decide,
  decideFromOverrides,
  toHookOutput,
  decisionToAuditAction,
  buildAuditBody,
  readToolCall,
  readSessionId,
  isNetworkCapable,
  EFFECT_TO_DECISION,
  ARGS_PREVIEW_LIMIT,
  RUNTIME_KIND,
};
