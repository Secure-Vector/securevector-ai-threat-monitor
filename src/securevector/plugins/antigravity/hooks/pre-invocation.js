#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * PreInvocation hook handler for the SecureVector Guard plugin (Antigravity).
 *
 * Antigravity has no SessionStart event, so PreInvocation is the earliest
 * point at which the plugin can speak. It fires before every model call, and
 * `invocationNum` says which one, so the session-open work is gated on the
 * first invocation and every later turn is a no-op costing one integer
 * comparison.
 *
 * On the first invocation:
 *
 *   1. Reachability notice. Probe the local app; if it is unreachable, write
 *      ONE line to stderr telling the user the Guard is installed but
 *      inactive and how to turn it on. This is the cold-install case: a
 *      plugin without the app is a security tool that silently does nothing,
 *      and the user deserves to be told. We still fail open.
 *
 *   2. Session-open audit row. Fire-and-forget POST so the hash-chained audit
 *      log shows clean session boundaries (the `__session_start__` sentinel)
 *      and the run groups under one trace on the Agent Map.
 *
 * This hook does NOT scan the user's prompt, because Antigravity's documented
 * PreInvocation payload does not carry it: the fields are `invocationNum`,
 * `initialNumSteps`, `conversationId`, `workspacePaths`, `transcriptPath`,
 * `artifactDirectoryPath` and `modelName`. The 2026-06 design note left that
 * as an open question and the answer is no. Reconstructing the prompt by
 * reading `transcriptPath` was considered and rejected: the transcript format
 * is undocumented, so the plugin would be guessing at a file's schema in order
 * to ship user text to an analyzer. See the README for the resulting coverage
 * gap.
 *
 * `injectSteps` is never emitted. It would push SecureVector text into the
 * model's context window on every turn, which is noise for the agent and a
 * prompt-injection surface of our own making.
 *
 * Always writes valid JSON and exits 0. Zero npm deps. Native Node 18+.
 */

'use strict';

const { resolveBaseUrl, postJsonAndForget, getJson } = require('../lib/client.js');

const DEFAULT_BASE_URL = 'http://127.0.0.1:8741';
const RUNTIME_KIND = 'antigravity';

async function readAllStdin() {
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

/**
 * True on the session's first model call. `invocationNum` is documented as an
 * integer; a missing or unparseable value is treated as first so a payload
 * change degrades into one extra audit row rather than into silence.
 */
function isFirstInvocation(event) {
  const n = event && (event.invocationNum !== undefined ? event.invocationNum : event.invocation_num);
  if (typeof n !== 'number' || !Number.isFinite(n)) return true;
  return n <= 1;
}

function sessionIdOf(event) {
  const id = event && (event.conversationId || event.conversation_id || event.session_id);
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function buildSessionOpenBody(event) {
  const sessionId = sessionIdOf(event);
  return {
    tool_id: '__session_start__',
    function_name: '__session_start__',
    action: 'log_only',
    risk: null,
    reason: 'SecureVector Guard: Antigravity session opened',
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
  } catch { /* swallow, an empty event is fine */ }

  if (!isFirstInvocation(event)) {
    process.stdout.write('{}');
    return;
  }

  const baseUrl = resolveBaseUrl();

  // Reachability probe, keyed on the presence of the `synced` key in the
  // response. getJson fails open to {} on error, timeout or non-2xx, so the
  // key's absence is the reliable "app did not respond" signal. Runs under the
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
        + 'activate policy enforcement and tamper-evident audit. See https://securevector.io\n',
      );
    }
  } catch { /* fail-open, never block session startup */ }

  try {
    postJsonAndForget(`${baseUrl}/api/tool-permissions/call-audit`, buildSessionOpenBody(event));
  } catch { /* swallow */ }

  // Empty object: no injected steps, no termination behaviour change.
  process.stdout.write('{}');
}

if (require.main === module) {
  main().catch(() => { process.stdout.write('{}'); });
}

module.exports = { buildSessionOpenBody, isFirstInvocation, sessionIdOf, RUNTIME_KIND };
