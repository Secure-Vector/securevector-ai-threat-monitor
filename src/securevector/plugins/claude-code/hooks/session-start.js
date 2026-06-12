#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * SessionStart hook handler for the SecureVector Guard plugin (Claude Code).
 *
 * Added for marketplace cold-install readiness (#147): before this, the
 * Claude Code plugin had NO SessionStart hook, so when the local app was
 * unreachable it failed *silently* — a cold-installed user (plugin without
 * the app) saw a security tool that did nothing. Now:
 *
 *   1. **Activation / reachability notice.** Probe the local app; if it's
 *      unreachable, write ONE line to stderr telling the user the Guard is
 *      installed but inactive and how to turn it on. We still fail open
 *      (Claude Code keeps working); this is purely informational.
 *
 *   2. **Session-open audit row.** Fire-and-forget POST so the hash-chained
 *      audit log shows clean session boundaries (`__session_start__` sentinel)
 *      and the run groups under one trace_id on the Agent Map.
 *
 * Always exits 0. Zero npm deps. Native Node 18+.
 */

'use strict';

const { postJsonAndForget, getJson } = require('../lib/client.js');

const DEFAULT_BASE_URL = 'http://127.0.0.1:8741';
const RUNTIME_KIND = 'claude-code';

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
    reason: 'SecureVector Guard: Claude Code session opened',
    is_essential: false,
    args_preview: typeof event.session_id === 'string'
      ? `session_id=${event.session_id}`.slice(0, 200)
      : null,
    runtime_kind: RUNTIME_KIND,
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

  // Reachability probe — keyed on the presence of the `synced` key in the
  // response shape (getJson fails open to {} on error/timeout/non-2xx, so its
  // absence is the reliable "app did not respond" signal). Runs under the
  // 100ms client timeout, so a down app never delays session startup.
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

  try {
    postJsonAndForget(`${baseUrl}/api/tool-permissions/call-audit`, buildSessionOpenBody(event));
  } catch { /* swallow */ }

  // Empty hookSpecificOutput — implicit-allow on SessionStart. We intentionally
  // don't inject additionalContext (would push SecureVector text into the
  // model's context window every session — noise for the agent).
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart' } }));
}

if (require.main === module) {
  main();
}

module.exports = { buildSessionOpenBody, RUNTIME_KIND };
