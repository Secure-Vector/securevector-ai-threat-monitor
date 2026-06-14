// SPDX-License-Identifier: Apache-2.0
/**
 * Shared fire-and-forget audit + threat-scan plumbing for the Cursor Guard
 * plugin's after* hooks (afterShellExecution, afterMCPExecution,
 * afterFileEdit). Three event-typed hooks share one audit contract, so it
 * lives here once — the per-event scripts only decide WHAT to audit/scan.
 *
 * Every audited call gets a per-call correlation id (`cu-` prefixed, same
 * shape as the Claude Code `cc-` / Copilot `cp-` ids). The traces backend
 * joins threat records AND redaction events to their span through this id —
 * without it, Agent Runs can't show what a call detected and the Agent Map
 * can't flag secret-touching tools.
 */

'use strict';

const { postJsonAndForget, fetchSyncedOverrides } = require('./client.js');
const { redactForScan } = require('./redact.js');

const ARGS_PREVIEW_LIMIT = 200;
const RUNTIME_KIND = 'cursor';
const SOURCE = 'cursor-plugin';
const OUTGOING_SCAN_LIMIT = 8000;
const INCOMING_SCAN_LIMIT = 16000;

function newRequestId() {
  return `cu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function effectToAction(effect) {
  switch (effect) {
    case 'allow':  return 'allow';
    case 'deny':   return 'block';
    case 'prompt': return 'log_only';
    default:       return 'allow';
  }
}

function pickMatch(candidates, overrides) {
  if (!overrides || !Array.isArray(overrides.synced) || overrides.synced.length === 0) return null;
  // Case-insensitive, first-seen-wins — MUST match decide.js:decideFromOverrides,
  // or the after-hook audit row would record `allow` for a rule the before-hook
  // actually denied (e.g. a rule stored as tool_id "Shell"), corrupting the log.
  const byId = new Map();
  for (const row of overrides.synced) {
    if (row && typeof row.tool_id === 'string') {
      const key = row.tool_id.toLowerCase();
      if (!byId.has(key)) byId.set(key, row);
    }
  }
  for (const c of candidates) {
    const m = byId.get(c.toLowerCase());
    if (m) return { tool_id: c, ...m };
  }
  return null;
}

function preview(value) {
  try {
    if (value === undefined || value === null) return null;
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    const out = redactForScan(raw).slice(0, ARGS_PREVIEW_LIMIT);
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * POST the audit row for a completed call. Resolves the action by re-checking
 * synced overrides (mirrors the sibling plugins — keeps the audit action
 * consistent with what the before* hook decided). Returns the request_id so
 * the caller can correlate follow-up /analyze scans.
 */
async function postCallAudit(baseUrl, { toolName, candidates, toolInput, sessionId }) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const overrides = await fetchSyncedOverrides(baseUrl, RUNTIME_KIND);
  const match = pickMatch(candidates, overrides);
  const requestId = newRequestId();
  postJsonAndForget(`${baseUrl}/api/tool-permissions/call-audit`, {
    tool_id: match ? match.tool_id : candidates[0],
    function_name: toolName,
    action: match ? effectToAction(match.effect) : 'allow',
    risk: null,
    reason: match && typeof match.reason === 'string' ? match.reason : null,
    is_essential: false,
    args_preview: preview(toolInput),
    runtime_kind: RUNTIME_KIND,
    session_id: sessionId || null,
    request_id: requestId,
  });
  return requestId;
}

/** Outgoing scan: agent/user-emitted prose (injection vectors). */
function scanOutgoing(baseUrl, text, { requestId, sessionId, toolName, toolId }) {
  if (typeof text !== 'string' || text.length === 0) return;
  postJsonAndForget(`${baseUrl}/analyze`, {
    text: text.slice(0, OUTGOING_SCAN_LIMIT),
    source: SOURCE,
    direction: 'outgoing',
    request_id: requestId || undefined,
    session_id: sessionId || undefined,
    metadata: { runtime_kind: RUNTIME_KIND, tool_name: toolName, tool_id: toolId },
  });
}

/** Incoming scan: tool responses / file content the agent treats as context (IDPI + leakage). */
function scanIncoming(baseUrl, text, { requestId, sessionId, toolName, toolId, scanTarget }) {
  if (typeof text !== 'string' || text.length === 0) return;
  postJsonAndForget(`${baseUrl}/analyze`, {
    text: text.slice(0, INCOMING_SCAN_LIMIT),
    source: SOURCE,
    direction: 'incoming',
    request_id: requestId || undefined,
    session_id: sessionId || undefined,
    metadata: {
      runtime_kind: RUNTIME_KIND,
      tool_name: toolName,
      tool_id: toolId,
      scan_target: scanTarget || 'tool_response',
    },
  });
}

module.exports = {
  newRequestId,
  effectToAction,
  pickMatch,
  preview,
  postCallAudit,
  scanOutgoing,
  scanIncoming,
  ARGS_PREVIEW_LIMIT,
  OUTGOING_SCAN_LIMIT,
  INCOMING_SCAN_LIMIT,
  RUNTIME_KIND,
  SOURCE,
};
