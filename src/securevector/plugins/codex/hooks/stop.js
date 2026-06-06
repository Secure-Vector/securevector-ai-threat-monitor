#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Stop hook handler for the SecureVector Guard plugin (Codex).
 *
 * Fires when the Codex CLI session ends. Writes a session-end audit
 * row so the SHA-256 hash-chained tool_call_audit table shows clean
 * session boundaries — forensic timelines can pivot on the
 * `__session_start__` / `__session_end__` sentinels to reconstruct
 * what happened inside one session vs the next.
 *
 * Fire-and-forget: never awaited, never propagates errors. Codex's
 * Stop hook output schema (`stop.command.output`) is `additionalProperties:
 * false` and — unlike PreToolUse / SessionStart — defines NO
 * `hookSpecificOutput` field. Its only allowed keys are `continue`,
 * `decision`, `reason`, `stopReason`, `suppressOutput`, `systemMessage`,
 * all optional. Emitting `{hookSpecificOutput: {...}}` is rejected with
 * "hook returned invalid stop hook JSON output". An empty object `{}`
 * is the valid implicit "I'm done, proceed" signal.
 *
 * Zero npm deps. Native Node 18+.
 */

'use strict';

const { postJsonAndForget } = require('../lib/client.js');

const DEFAULT_BASE_URL = 'http://127.0.0.1:8741';
const RUNTIME_KIND = 'codex';

async function readAllStdin() {
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

function buildSessionEndBody(event) {
  // log_only is the closest existing action sentinel for "informational
  // row, no enforcement happened here". The `function_name` carries
  // the lifecycle event semantics so forensic timelines can pivot on
  // `__session_end__` directly. Note: Codex's Stop hook may fire on
  // every model-response end rather than only at session close —
  // treat these rows as "turn-boundary markers" rather than guaranteed
  // session-lifecycle markers, and filter by adjacency to the
  // matching `__session_start__` row to reconstruct true sessions.
  return {
    tool_id: '__session_end__',
    function_name: '__session_end__',
    action: 'log_only',
    risk: null,
    reason: 'SecureVector Guard: Codex turn boundary',
    is_essential: false,
    args_preview: typeof event.session_id === 'string'
      ? `session_id=${event.session_id}`.slice(0, 200)
      : null,
    runtime_kind: RUNTIME_KIND,
    // Forward the runtime session id so the backend derives the SAME
    // trace_id as this session's tool-call rows. Without it the boundary
    // row gets a NULL trace_id and lands in the synthetic "orphan:codex"
    // bucket, which the Agent Map would otherwise render as a SECOND agent
    // node beside the real run (one logical session → two nodes bug).
    session_id: typeof event.session_id === 'string' ? event.session_id : null,
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
