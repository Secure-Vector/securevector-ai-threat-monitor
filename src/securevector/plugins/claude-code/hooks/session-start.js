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

const { resolveBaseUrl, postJsonAndForget, getJson } = require('../lib/client.js');

const RUNTIME_KIND = 'claude-code';

// One line of context at session start naming the SecureVector MCP
// check_policy tool. On by default; SECUREVECTOR_MCP_GUIDANCE_LINE=0 turns it
// off. Only sent when the local app answered and reports the MCP entry as
// registered for Claude Code, so the agent is never pointed at a tool that
// is not there.
const MCP_GUIDANCE_LINE = 'SecureVector check_policy is available: before a shell, network, '
  + 'file write or MCP action you are unsure of, call it with the tool name and input you '
  + 'would send. A deny means do not attempt the action.';

function mcpGuidanceEnabled(env = process.env) {
  const v = String(env.SECUREVECTOR_MCP_GUIDANCE_LINE || '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

function mcpRegistered(registration) {
  const h = registration && registration.harnesses && registration.harnesses[RUNTIME_KIND];
  return !!(h && h.state === 'registered');
}

function buildSessionStartOutput(reachable, env = process.env, registered = true) {
  const out = { hookEventName: 'SessionStart' };
  if (reachable && registered && mcpGuidanceEnabled(env)) out.additionalContext = MCP_GUIDANCE_LINE;
  return { hookSpecificOutput: out };
}

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

  const baseUrl = resolveBaseUrl();

  // Reachability probe — keyed on the presence of the `synced` key in the
  // response shape (getJson fails open to {} on error/timeout/non-2xx, so its
  // absence is the reliable "app did not respond" signal). Runs under the
  // 100ms client timeout, so a down app never delays session startup.
  let reachable = false;
  let registered = false;
  try {
    const [overrides, registration] = await Promise.all([
      getJson(`${baseUrl}/api/tool-permissions/synced-overrides`),
      mcpGuidanceEnabled()
        ? getJson(`${baseUrl}/api/policy/mcp-registration?harness=${RUNTIME_KIND}`)
        : Promise.resolve(null),
    ]);
    registered = mcpRegistered(registration);
    reachable = !!(overrides && typeof overrides === 'object'
      && Object.prototype.hasOwnProperty.call(overrides, 'synced'));
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

  // Implicit-allow on SessionStart. The only context added is the one
  // check_policy line above, behind its flag; nothing else enters the
  // model's context window.
  process.stdout.write(JSON.stringify(buildSessionStartOutput(reachable, process.env, registered)));
}

if (require.main === module) {
  main();
}

module.exports = {
  buildSessionOpenBody, buildSessionStartOutput, mcpGuidanceEnabled, mcpRegistered, MCP_GUIDANCE_LINE,
  RUNTIME_KIND,
};
