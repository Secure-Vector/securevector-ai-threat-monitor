#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * stop hook for the SecureVector Guard plugin (Cursor).
 *
 * Fires when the Cursor agent finishes a loop. stdin:
 *   { status: "completed"|"aborted"|"error", loop_count, conversation_id, ... }
 * stdout: { followup_message? } — we emit {} (never auto-continue the agent).
 *
 * Writes a `__turn_end__` sentinel row: stop fires per agent loop, not at
 * the end of the conversation, so the local app never reads it as the end
 * of the session. The session end is `__session_end__`, written by the
 * sessionEnd hook (hooks/session-end.js).
 *
 * Fire-and-forget; always exits 0.
 */

'use strict';

const { resolveBaseUrl, postJsonAndForget } = require('../lib/client.js');
const { sessionIdFrom, readAllStdin } = require('../lib/decide.js');

const RUNTIME_KIND = 'cursor';

function buildTurnEndBody(event) {
  const sessionId = sessionIdFrom(event);
  const status = typeof event.status === 'string' ? event.status : 'completed';
  return {
    tool_id: '__turn_end__',
    function_name: '__turn_end__',
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

  const baseUrl = resolveBaseUrl();
  try {
    postJsonAndForget(`${baseUrl}/api/tool-permissions/call-audit`, buildTurnEndBody(event));
  } catch { /* swallow */ }

  process.stdout.write(JSON.stringify({}));
}

if (require.main === module) {
  main();
}

module.exports = { buildTurnEndBody, RUNTIME_KIND };
