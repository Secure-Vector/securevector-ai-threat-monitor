#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Stop hook handler for the SecureVector Guard plugin (Codex).
 *
 * Fires at the end of every Codex turn (not at session end). Writes a
 * `__turn_end__` audit row, a turn boundary the local app never reads as
 * the end of the session. The session end is `__session_end__`, written
 * by the SessionEnd hook (hooks/session-end.js).
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

const { resolveBaseUrl, postJsonAndForget } = require('../lib/client.js');
const { postTerminalEvent } = require('../lib/terminal-relay.js');

const RUNTIME_KIND = 'codex';

async function readAllStdin() {
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

function buildTurnEndBody(event) {
  // log_only is the closest existing action sentinel for "informational
  // row, no enforcement happened here". The `function_name` carries
  // the lifecycle event: Stop fires per turn, so this is a turn marker.
  return {
    tool_id: '__turn_end__',
    function_name: '__turn_end__',
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

  const baseUrl = resolveBaseUrl();

  try {
    postJsonAndForget(`${baseUrl}/api/tool-permissions/call-audit`, buildTurnEndBody(event));
  } catch { /* swallow */ }

  await postTerminalEvent({ hook_event_name: 'Stop', session_id: event.session_id });

  process.stdout.write(JSON.stringify({}));
}

if (require.main === module) {
  main();
}

module.exports = { buildTurnEndBody, RUNTIME_KIND };
