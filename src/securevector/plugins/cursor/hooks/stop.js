#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * stop hook for the SecureVector Guard plugin (Cursor).
 *
 * Fires when the Cursor agent finishes a loop. stdin:
 *   { status: "completed"|"aborted"|"error", loop_count, conversation_id, ... }
 * stdout: { followup_message? } — we emit {} (never auto-continue the agent).
 *
 * Writes a `__session_end__` sentinel row so the SHA-256 hash-chained
 * tool_call_audit table shows session boundaries — forensic timelines pivot
 * on the `__session_start__` / `__session_end__` sentinels to reconstruct
 * what happened inside one session vs the next. Like Codex's Stop, Cursor's
 * stop fires per agent loop end rather than only at window close, so treat
 * these rows as turn-boundary markers.
 *
 * Fire-and-forget; always exits 0.
 */

'use strict';

const { postJsonAndForget } = require('../lib/client.js');
const { sessionIdFrom, readAllStdin, DEFAULT_BASE_URL } = require('../lib/decide.js');

const RUNTIME_KIND = 'cursor';

function buildSessionEndBody(event) {
  const sessionId = sessionIdFrom(event);
  const status = typeof event.status === 'string' ? event.status : 'completed';
  return {
    tool_id: '__session_end__',
    function_name: '__session_end__',
    action: 'log_only',
    risk: null,
    reason: `SecureVector Guard: Cursor agent loop ended (${status})`,
    is_essential: false,
    args_preview: sessionId ? `session_id=${sessionId}`.slice(0, 200) : null,
    runtime_kind: RUNTIME_KIND,
    // Forward the runtime session id so the boundary row derives the SAME
    // trace_id as the session's tool-call rows (a NULL here would orphan it
    // into a second Agent Map node).
    session_id: sessionId,
  };
}

async function main() {
  let event = {};
  try {
    const raw = await readAllStdin();
    event = raw ? JSON.parse(raw) : {};
  } catch { /* swallow — empty event is fine */ }

  const baseUrl = process.env.SV_BASE_URL || DEFAULT_BASE_URL;
  try {
    postJsonAndForget(`${baseUrl}/api/tool-permissions/call-audit`, buildSessionEndBody(event));
  } catch { /* swallow */ }

  process.stdout.write(JSON.stringify({}));
}

if (require.main === module) {
  main();
}

module.exports = { buildSessionEndBody, RUNTIME_KIND };
