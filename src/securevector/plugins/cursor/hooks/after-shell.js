#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * afterShellExecution hook for the SecureVector Guard plugin (Cursor).
 *
 * Fires after a terminal command completes. stdin:
 *   { command, output, duration, sandbox, conversation_id, ... }
 * stdout control: none (observe-only event) — nothing is emitted.
 *
 * Two jobs, both fire-and-forget:
 *   1. Audit row for the completed shell call (runtime_kind "cursor").
 *   2. MARKER-GATED incoming scan of the command output: shell output is
 *      mostly benign build noise, so it is scanned only when it carries a
 *      credential SHAPE (same philosophy as the Copilot plugin's bash/
 *      powershell gating) — `printenv` / `cat .env` exfil is caught without
 *      flooding the Threats UI.
 *
 * Never blocks, never crashes the host: always exits 0.
 */

'use strict';

const { normalize } = require('../lib/normalize.js');
const { hasCredentialMarkers } = require('../lib/redact.js');
const { postCallAudit, scanIncoming } = require('../lib/audit.js');
const { sessionIdFrom, readAllStdin, DEFAULT_BASE_URL } = require('../lib/decide.js');

const TOOL_NAME = 'shell';

async function main() {
  let event = {};
  try {
    const raw = await readAllStdin();
    event = raw ? JSON.parse(raw) : {};
  } catch {
    return; // malformed stdin — nothing to audit
  }
  const baseUrl = process.env.SECUREVECTOR_ENGINE_ENDPOINT || process.env.SV_BASE_URL || DEFAULT_BASE_URL;
  try {
    const sessionId = sessionIdFrom(event);
    const requestId = await postCallAudit(baseUrl, {
      toolName: TOOL_NAME,
      candidates: normalize(TOOL_NAME),
      toolInput: event && event.command,
      sessionId,
    });
    const output = event && typeof event.output === 'string' ? event.output : '';
    if (output.length > 0 && hasCredentialMarkers(output)) {
      scanIncoming(baseUrl, output, {
        requestId, sessionId, toolName: TOOL_NAME, toolId: TOOL_NAME,
      });
    }
  } catch { /* never crash the hook */ }
}

if (require.main === module) {
  main();
}

module.exports = { TOOL_NAME };
