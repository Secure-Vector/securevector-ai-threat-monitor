#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * afterMCPExecution hook for the SecureVector Guard plugin (Cursor).
 *
 * Fires after an MCP tool call completes. stdin:
 *   { tool_name, tool_input (JSON string), result_json (JSON string),
 *     duration, conversation_id, ... }
 * stdout control: none (observe-only event).
 *
 * Two jobs, both fire-and-forget:
 *   1. Audit row for the completed MCP call.
 *   2. UNGATED incoming scan of the result: MCP tools are a third-party
 *      trust boundary returning untrusted external data — the canonical
 *      Indirect Prompt Injection surface — so every response is scanned
 *      (same rule as the sibling plugins' MCP handling).
 *
 * Never blocks, never crashes the host: always exits 0.
 */

'use strict';

const { normalize } = require('../lib/normalize.js');
const { postCallAudit, scanIncoming } = require('../lib/audit.js');
const { sessionIdFrom, readAllStdin, DEFAULT_BASE_URL } = require('../lib/decide.js');
const { serverSlugFrom } = require('./before-mcp.js');

/** Pull scannable text out of result_json (MCP envelope or raw string). */
function extractResultText(event) {
  const raw = event && (event.result_json !== undefined ? event.result_json : event.resultJson);
  if (raw == null) return '';
  if (typeof raw !== 'string') {
    try { return JSON.stringify(raw); } catch { return ''; }
  }
  // result_json is documented as a JSON string; prefer the MCP text envelope
  // when it parses, fall back to the raw string so nothing is missed.
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.content)) {
      const parts = [];
      for (const item of parsed.content) {
        if (item && typeof item === 'object' && typeof item.text === 'string') parts.push(item.text);
        else if (typeof item === 'string') parts.push(item);
      }
      if (parts.length > 0) return parts.join('\n');
    }
    return raw;
  } catch {
    return raw;
  }
}

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
    const toolName = (event && (event.tool_name || event.toolName)) || '';
    const candidates = normalize(toolName, {
      fromMcpEvent: true,
      serverSlug: serverSlugFrom(event),
    });
    const sessionId = sessionIdFrom(event);
    const requestId = await postCallAudit(baseUrl, {
      toolName,
      candidates,
      toolInput: event && event.tool_input,
      sessionId,
    });
    const resultText = extractResultText(event);
    if (resultText.length > 0) {
      scanIncoming(baseUrl, resultText, {
        requestId,
        sessionId,
        toolName,
        toolId: candidates[0] || toolName,
      });
    }
  } catch { /* never crash the hook */ }
}

if (require.main === module) {
  main();
}

module.exports = { extractResultText };
