#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * sessionStart hook for the SecureVector Guard plugin (Cursor).
 *
 * Fires when a Cursor agent session begins. stdin:
 *   { session_id, is_background_agent, composer_mode?, conversation_id, ... }
 * stdout: { env?, additional_context? } — we emit {} (no context injection).
 *
 * Two jobs:
 *   1. **Activation / reachability notice (cold-install aware).** Probe the
 *      local SecureVector app; if unreachable, write ONE line to stderr so
 *      the user knows the Guard is installed but inactive. Fail-open —
 *      Cursor keeps working; this is purely informational.
 *   2. **Session-open audit row.** Fire-and-forget `__session_start__`
 *      sentinel so the hash-chained audit log shows clean session boundaries
 *      and the Agent Map gets its session node.
 *
 * Always exits 0. Zero npm deps. Native Node 18+.
 */

'use strict';

const { postJsonAndForget, getJson } = require('../lib/client.js');
const { sessionIdFrom, readAllStdin, DEFAULT_BASE_URL } = require('../lib/decide.js');

const RUNTIME_KIND = 'cursor';

function buildSessionOpenBody(event) {
  const sessionId = sessionIdFrom(event);
  return {
    tool_id: '__session_start__',
    function_name: '__session_start__',
    action: 'log_only',
    risk: null,
    reason: 'SecureVector Guard: Cursor agent session opened',
    is_essential: false,
    args_preview: sessionId ? `session_id=${sessionId}`.slice(0, 200) : null,
    runtime_kind: RUNTIME_KIND,
    // Forward the runtime session id so the backend derives the SAME
    // trace_id as this session's tool-call rows (one logical run → one
    // node on the Agent Map, not an orphan).
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

  // Reachability probe — keyed on the SHAPE of the response (presence of the
  // `synced` key), not on whether any rules are present. getJson fails open
  // (returns {} on error/timeout/non-2xx), so absence of `synced` is the
  // reliable "app did not respond" signal.
  try {
    const overrides = await getJson(`${baseUrl}/api/tool-permissions/synced-overrides`);
    const reachable = overrides && typeof overrides === 'object'
      && Object.prototype.hasOwnProperty.call(overrides, 'synced');
    if (!reachable) {
      process.stderr.write(
        'SecureVector Guard is installed but INACTIVE: the local SecureVector app at '
        + baseUrl + ' is not reachable, so the Cursor agent\'s tool calls are NOT being '
        + 'enforced or audited this session (failing open). Install and start the free '
        + 'SecureVector app to activate policy enforcement + tamper-evident audit. '
        + 'See https://securevector.io\n',
      );
    }
  } catch { /* fail-open — never block session startup */ }

  try {
    postJsonAndForget(`${baseUrl}/api/tool-permissions/call-audit`, buildSessionOpenBody(event));
  } catch { /* swallow */ }

  process.stdout.write(JSON.stringify({}));
}

if (require.main === module) {
  main();
}

module.exports = { buildSessionOpenBody, RUNTIME_KIND };
