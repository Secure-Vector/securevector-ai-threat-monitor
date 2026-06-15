#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * afterFileEdit hook for the SecureVector Guard plugin (Cursor).
 *
 * Fires after the agent edits a file. stdin:
 *   { file_path, edits: [{ old_string, new_string }], conversation_id, ... }
 * stdout control: none (observe-only event — Cursor passes edit pairs, not a
 * unified diff, so this maps to an audit row, not enforcement).
 *
 * Two jobs, both fire-and-forget:
 *   1. Audit row for the edit (tool id 'edit'), args_preview carrying the
 *      file path + edit count so Agent Runs shows WHAT was touched.
 *   2. MARKER-GATED outgoing scan of the newly written content: an agent
 *      writing credential-shaped strings INTO files is a leak/persistence
 *      vector (think "write the API key into a script"), but normal code
 *      churn is noise — so only content with a credential shape is scanned.
 *
 * Never blocks, never crashes the host: always exits 0.
 */

'use strict';

const { normalize } = require('../lib/normalize.js');
const { hasCredentialMarkers } = require('../lib/redact.js');
const { postCallAudit, scanOutgoing } = require('../lib/audit.js');
const { sessionIdFrom, readAllStdin, DEFAULT_BASE_URL } = require('../lib/decide.js');

const TOOL_NAME = 'edit';

/** Concatenate the written content (new_string sides) for the leak scan. */
function newContentFrom(event) {
  if (!event || !Array.isArray(event.edits)) return '';
  const parts = [];
  for (const e of event.edits) {
    if (e && typeof e.new_string === 'string' && e.new_string.length > 0) parts.push(e.new_string);
  }
  return parts.join('\n');
}

async function main() {
  let event = {};
  try {
    const raw = await readAllStdin();
    event = raw ? JSON.parse(raw) : {};
  } catch {
    return; // malformed stdin — nothing to audit
  }
  const baseUrl = process.env.SV_BASE_URL || DEFAULT_BASE_URL;
  try {
    const sessionId = sessionIdFrom(event);
    const filePath = (event && typeof event.file_path === 'string') ? event.file_path : '';
    const editCount = Array.isArray(event && event.edits) ? event.edits.length : 0;
    const requestId = await postCallAudit(baseUrl, {
      toolName: TOOL_NAME,
      candidates: normalize(TOOL_NAME),
      toolInput: `${filePath} (${editCount} edit${editCount === 1 ? '' : 's'})`,
      sessionId,
    });
    const written = newContentFrom(event);
    if (written.length > 0 && hasCredentialMarkers(written)) {
      scanOutgoing(baseUrl, written, {
        requestId, sessionId, toolName: TOOL_NAME, toolId: TOOL_NAME,
      });
    }
  } catch { /* never crash the hook */ }
}

if (require.main === module) {
  main();
}

module.exports = { TOOL_NAME, newContentFrom };
