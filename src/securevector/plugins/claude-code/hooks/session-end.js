#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * SessionEnd hook handler for the SecureVector Guard plugin (Claude Code).
 *
 * Fires once when the Claude Code session terminates (stdin:
 * { session_id, hook_event_name: "SessionEnd", reason, exit_code, cwd }).
 * Writes the `__session_end__` audit row, so the local app ends the session
 * at once instead of waiting ten quiet minutes. Not bound to `Stop`: Stop
 * fires at the end of every assistant turn.
 *
 * Side effects only: Claude Code ignores this hook's exit code and output.
 * Fire-and-forget; always exits 0. Zero npm deps. Native Node 18+.
 */

'use strict';

const { resolveBaseUrl, postJsonAndForget } = require('../lib/client.js');

const RUNTIME_KIND = 'claude-code';
const AUDIT_PATH = '/api/tool-permissions/call-audit';

async function readAllStdin() {
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

function buildSessionEndBody(event) {
  const e = event && typeof event === 'object' ? event : {};
  const sid = typeof e.session_id === 'string' && e.session_id ? e.session_id : null;
  const why = typeof e.reason === 'string' && e.reason ? ` (${e.reason.slice(0, 40)})` : '';
  return {
    tool_id: '__session_end__',
    function_name: '__session_end__',
    action: 'log_only',
    risk: null,
    reason: `SecureVector Guard: Claude Code session ended${why}`,
    is_essential: false,
    args_preview: sid ? `session_id=${sid}`.slice(0, 200) : null,
    runtime_kind: RUNTIME_KIND,
    // Same trace_id as the session's tool-call rows.
    session_id: sid,
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
}

if (require.main === module) {
  main();
}

module.exports = { buildSessionEndBody, RUNTIME_KIND, AUDIT_PATH };
