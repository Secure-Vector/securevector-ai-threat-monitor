#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * sessionStart hook handler for the SecureVector Guard plugin (GitHub Copilot CLI).
 *
 * Fires when a Copilot CLI session begins (stdin: { sessionId, timestamp,
 * cwd, source: "startup"|"resume"|"new", initialPrompt? }). Two jobs:
 *
 *   1. **Activation / reachability notice (cold-install aware).** Probe the
 *      local SecureVector app. If it's unreachable, write ONE line to stderr
 *      so the user knows the Guard is installed but inactive and how to turn
 *      it on. This matters most for marketplace COLD installs — someone who
 *      installed the plugin without the app would otherwise see a security
 *      tool that silently does nothing. We still fail open (Copilot keeps
 *      working); this is purely informational. Per Copilot docs, sessionStart
 *      stdout is ignored for control, so stderr is the right channel for a
 *      human-visible banner.
 *
 *   2. **Session-open audit row.** Fire-and-forget POST so the hash-chained
 *      audit log shows clean session boundaries (`__session_start__` sentinel).
 *
 * Always exits 0. Zero npm deps. Native Node 18+.
 */

'use strict';

const { postJsonAndForget, getJson } = require('../lib/client.js');

const DEFAULT_BASE_URL = 'http://127.0.0.1:8741';
const RUNTIME_KIND = 'copilot-cli';

async function readAllStdin() {
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

function buildSessionOpenBody(event) {
  return {
    tool_id: '__session_start__',
    function_name: '__session_start__',
    action: 'log_only',
    risk: null,
    reason: 'SecureVector Guard: Copilot CLI session opened',
    is_essential: false,
    args_preview: typeof event.sessionId === 'string'
      ? `session_id=${event.sessionId}`.slice(0, 200)
      : null,
    runtime_kind: RUNTIME_KIND,
    // Forward the runtime session id so the backend derives the SAME
    // trace_id as this session's tool-call rows (one logical run → one
    // node on the Agent Map, not an orphan).
    session_id: typeof event.sessionId === 'string' ? event.sessionId : null,
  };
}

async function main() {
  let event = {};
  try {
    const raw = await readAllStdin();
    event = raw ? JSON.parse(raw) : {};
  } catch { /* swallow — empty event is fine */ }

  const baseUrl = process.env.SECUREVECTOR_ENGINE_ENDPOINT || process.env.SV_BASE_URL || DEFAULT_BASE_URL;

  // Reachability probe — keyed on the SHAPE of the response (presence of the
  // `synced` key), not on whether any rules are present. getJson fails open
  // (returns {} on error/timeout/non-2xx), so absence of `synced` is the
  // reliable "app did not respond" signal — avoids false warnings on a
  // healthy-but-empty app. Runs under lib/client.js's 100ms timeout.
  try {
    const overrides = await getJson(`${baseUrl}/api/tool-permissions/synced-overrides`);
    const reachable = overrides && typeof overrides === 'object'
      && Object.prototype.hasOwnProperty.call(overrides, 'synced');
    if (!reachable) {
      process.stderr.write(
        'SecureVector Guard is installed but INACTIVE: the local SecureVector app at '
        + baseUrl + ' is not reachable, so tool calls are NOT being enforced or audited '
        + 'this session (failing open). Install and start the free SecureVector app to '
        + 'activate policy enforcement + tamper-evident audit. See https://securevector.io\n',
      );
    }
  } catch { /* fail-open — never block session startup */ }

  // Fire-and-forget session-open audit row.
  try {
    postJsonAndForget(`${baseUrl}/api/tool-permissions/call-audit`, buildSessionOpenBody(event));
  } catch { /* swallow */ }

  // No stdout control needed; Copilot ignores sessionStart stdout for control.
}

if (require.main === module) {
  main();
}

module.exports = { buildSessionOpenBody, RUNTIME_KIND };
