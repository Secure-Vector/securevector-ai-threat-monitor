#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * sessionEnd hook for the SecureVector Guard plugin (Cursor).
 *
 * UNVERIFIED: bound to Cursor's documented `sessionEnd` event, not yet
 * observed against a live Cursor build. If it never fires, the local app
 * still ends the session after ten quiet minutes.
 *
 * Fires once when a composer conversation ends. stdin:
 *   { session_id (or conversation_id), reason: "completed"|"aborted"|..., duration_ms, ... }
 * Fire-and-forget; Cursor reads no output from it. We emit {}.
 *
 * Writes the `__session_end__` audit row, so the local app ends the session
 * at once. `stop` fires per agent loop and writes `__turn_end__` instead
 * (hooks/stop.js). Always exits 0.
 */

'use strict';

const { resolveBaseUrl, postJsonAndForget } = require('../lib/client.js');
const { sessionIdFrom, readAllStdin } = require('../lib/decide.js');

const RUNTIME_KIND = 'cursor';
const AUDIT_PATH = '/api/tool-permissions/call-audit';

function buildSessionEndBody(event) {
  const sessionId = sessionIdFrom(event);
  const why = event && typeof event.reason === 'string' && event.reason ? ` (${event.reason.slice(0, 40)})` : '';
  return {
    tool_id: '__session_end__',
    function_name: '__session_end__',
    action: 'log_only',
    risk: null,
    reason: `SecureVector Guard: Cursor session ended${why}`,
    is_essential: false,
    args_preview: sessionId ? `session_id=${sessionId}`.slice(0, 200) : null,
    runtime_kind: RUNTIME_KIND,
    session_id: sessionId,
  };
}

async function main() {
  let event = {};
  try {
    const raw = await readAllStdin();
    event = raw ? JSON.parse(raw) : {};
  } catch { /* swallow: an empty event is fine */ }
  try {
    postJsonAndForget(`${resolveBaseUrl()}${AUDIT_PATH}`, buildSessionEndBody(event));
  } catch { /* swallow */ }
  process.stdout.write(JSON.stringify({}));
}

if (require.main === module) {
  main();
}

module.exports = { buildSessionEndBody, RUNTIME_KIND, AUDIT_PATH };
