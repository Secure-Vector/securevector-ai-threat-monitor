#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * beforeReadFile hook for the SecureVector Guard plugin (Cursor).
 *
 * Fires before file content reaches the model. stdin:
 *   { file_path, content, attachments, conversation_id, ... }
 * stdout: { permission: "allow"|"deny", user_message? }
 *
 * This surface has no analogue in the Claude Code / Codex / Copilot plugins —
 * Cursor is the only harness that exposes content BEFORE the model sees it.
 * v1 policy is observe-only: when the content carries a credential SHAPE the
 * read is allowed but a marker-gated incoming scan records the exposure
 * (secret-touching session → lock badge on the Agent Map via request_id
 * correlation). Denying here would break legitimate workflows (.env reads,
 * key rotation work), so blocking stays a future per-rule decision, not a
 * default.
 *
 * Fail-open: every path emits an explicit allow and exits 0. This hook fires
 * on EVERY file the agent reads, so the no-marker fast path does no network
 * I/O at all.
 */

'use strict';

const { hasCredentialMarkers } = require('../lib/redact.js');
const { newRequestId, scanIncoming } = require('../lib/audit.js');
const { sessionIdFrom, readAllStdin, DEFAULT_BASE_URL } = require('../lib/decide.js');

const ALLOW = { permission: 'allow' };
const TOOL_NAME = 'read';

async function main() {
  let out = ALLOW;
  try {
    let event = {};
    try {
      const raw = await readAllStdin();
      event = raw ? JSON.parse(raw) : {};
    } catch {
      process.stdout.write(JSON.stringify(out));
      return;
    }
    const content = typeof event.content === 'string' ? event.content : '';
    if (content.length > 0 && hasCredentialMarkers(content)) {
      const baseUrl = process.env.SECUREVECTOR_ENGINE_ENDPOINT || process.env.SV_BASE_URL || DEFAULT_BASE_URL;
      const filePath = typeof event.file_path === 'string' ? event.file_path : '';
      scanIncoming(baseUrl, `${filePath ? `# file: ${filePath}\n` : ''}${content}`, {
        requestId: newRequestId(),
        sessionId: sessionIdFrom(event),
        toolName: TOOL_NAME,
        toolId: TOOL_NAME,
        scanTarget: 'file_read',
      });
    }
  } catch {
    out = ALLOW;
  }
  process.stdout.write(JSON.stringify(out));
}

if (require.main === module) {
  main();
}

module.exports = { TOOL_NAME };
