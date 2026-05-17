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
 * Built-in tool enforcement (Bash / Edit / Read / etc.) is deferred per
 * locked decision #3 — those names short-circuit to allow without
 * touching the local app.
 *
 * Zero npm deps. Native Node 18+.
 */

'use strict';

const { normalize } = require('../lib/normalize.js');
const { fetchSyncedOverrides } = require('../lib/client.js');

const EFFECT_TO_DECISION = Object.freeze({
  allow: 'allow',
  deny: 'deny',
  prompt: 'ask',
});

const DEFAULT_BASE_URL = 'http://127.0.0.1:8741';
const ALLOW = Object.freeze({ decision: 'allow' });


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
    };
  }
  return ALLOW;
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
function toHookOutput(d) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: d.decision,
    },
  };
  if (typeof d.reason === 'string' && d.reason.length > 0) {
    out.hookSpecificOutput.permissionDecisionReason = d.reason;
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
  if (candidates.length === 0) return ALLOW; // built-in — short-circuit, no fetch
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
  process.stdout.write(JSON.stringify(toHookOutput(decision)));
}

if (require.main === module) {
  main();
}

module.exports = { decide, decideFromOverrides, toHookOutput, EFFECT_TO_DECISION };
