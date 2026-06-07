#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * SessionStart hook handler for the SecureVector Guard plugin (Codex).
 *
 * Fires once when the Codex CLI session opens. Two responsibilities:
 *
 *   1. **Reachability probe** — verify the local SecureVector app is
 *      running. If not, write a one-line note to stderr so the user
 *      knows enforcement is offline (we still fail-open, so the host
 *      CLI keeps working — this is purely informational).
 *
 *   2. **Session-open audit row** — fire-and-forget POST to the local
 *      app's call-audit endpoint so the audit chain shows clean
 *      session boundaries. `function_name=__session_start__` is a
 *      sentinel — easy to filter out of normal tool-activity views,
 *      easy to spot in forensic timelines.
 *
 * Fail-open invariant (locked decision #5): every error path is
 * swallowed; the hook always emits an empty hookSpecificOutput (the
 * implicit-allow contract Codex expects on SessionStart) and exits 0.
 *
 * Zero npm deps. Native Node 18+.
 */

'use strict';

const { postJsonAndForget, getJson } = require('../lib/client.js');

const DEFAULT_BASE_URL = 'http://127.0.0.1:8741';
const RUNTIME_KIND = 'codex';

async function readAllStdin() {
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

function buildSessionOpenBody(event) {
  // The local app's call-audit endpoint validates action against
  // ^(block|allow|log_only)$ — `log_only` is the closest existing
  // sentinel for "informational row, no enforcement happened here".
  // The `function_name` carries the lifecycle event semantics so
  // forensic timelines can pivot on `__session_start__` directly.
  return {
    tool_id: '__session_start__',
    function_name: '__session_start__',
    action: 'log_only',
    risk: null,
    reason: 'SecureVector Guard: Codex session opened',
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

  // Reachability probe — fail-quiet to stderr. The probe runs with the
  // default 100ms client-side timeout in lib/client.js, so a slow / down
  // local app never delays session startup beyond that bound.
  //
  // Reachability is keyed on the SHAPE of the response, not on whether it
  // carries any rules. The `/synced-overrides` endpoint ALWAYS includes a
  // `synced` key (e.g. `{synced:[],total:0}` when enforcement is off or no
  // rules are synced — a perfectly healthy app). getJson's fail-open path
  // returns a bare `{}` (no `synced` key) on network error / timeout /
  // non-2xx / malformed body. So the presence of the `synced` key is the
  // reliable "app responded" signal, and its absence is the only thing we
  // warn on. This avoids falsely warning on a healthy-but-empty app.
  try {
    const overrides = await getJson(`${baseUrl}/api/tool-permissions/synced-overrides`);
    const reachable = overrides && typeof overrides === 'object'
      && Object.prototype.hasOwnProperty.call(overrides, 'synced');
    if (!reachable) {
      process.stderr.write(
        'SecureVector Guard: local app at ' + baseUrl + ' did not respond; '
        + 'enforcement will fail-open this session. Start the SecureVector app to '
        + 'restore policy enforcement and audit logging.\n',
      );
    }
  } catch { /* fail-open — never block session startup */ }

  // Fire-and-forget audit row. Never awaited; never propagates errors.
  try {
    postJsonAndForget(`${baseUrl}/api/tool-permissions/call-audit`, buildSessionOpenBody(event));
  } catch { /* swallow */ }

  // Empty hookSpecificOutput — Codex's implicit-allow contract on
  // SessionStart. We intentionally don't emit additionalContext (the
  // only Codex-supported payload field for SessionStart) because that
  // would push SecureVector text into the model's context window every
  // session — noise for the agent, no value for the user.
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart' } }));
}

if (require.main === module) {
  main();
}

module.exports = { buildSessionOpenBody, RUNTIME_KIND };
