#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * postToolUse hook handler for the SecureVector Guard plugin (GitHub Copilot CLI).
 *
 * Fire-and-forget audit: after every tool call, POST a `tool_call_audit`
 * row to the local app with `runtime_kind: "copilot-cli"`. The hook never
 * blocks the host CLI and always exits 0.
 *
 * Copilot postToolUse stdin (camelCase, per docs.github.com):
 *   { sessionId, timestamp, cwd, toolName, toolArgs, toolResult: { resultType, textResultForLlm } }
 *   — toolArgs arrives as a JSON *string*; toolResult.textResultForLlm is the
 *     text the model reads back (the IDPI / leakage surface).
 *
 * Effect → audit action mapping:  allow→allow, deny→block, prompt→log_only.
 *
 * Threat-scan gating uses Copilot's NATIVE tool names
 * (ask_user, bash, create, edit, glob, grep, powershell, task, view, web_fetch)
 * — NOT Codex/Claude names. Same prose-only / marker-gated philosophy to keep
 * the FP rate down.
 *
 * Zero npm deps. Native Node 18+.
 */

'use strict';

const { normalize } = require('../lib/normalize.js');
const { postJsonAndForget, fetchSyncedOverrides } = require('../lib/client.js');
const { redactForScan, hasCredentialMarkers } = require('../lib/redact.js');

const DEFAULT_BASE_URL = 'http://127.0.0.1:8741';
const ARGS_PREVIEW_LIMIT = 200;
const RUNTIME_KIND = 'copilot-cli';
const SOURCE = 'copilot-cli-plugin';

// OUTGOING prose scan — tool inputs that are natural-language the agent
// emitted (injection vectors). Copilot's `task` tool carries a delegated
// subagent prompt; that's the canonical prose surface. Syntax-shaped
// inputs (bash/powershell command bodies, create/edit file blobs) are
// excluded — the LLM-prose rule pack false-positives on them.
const THREAT_SCAN_TOOLS = new Set(['task']);
const THREAT_SCAN_TEXT_LIMIT = 8000;

// INCOMING IDPI scan — tool RESPONSES the agent treats as context.
// web_fetch (fetched page) + view (file content read back) are fetched/
// external content → Indirect Prompt Injection + leakage surface. Plus
// every MCP tool (third-party trust boundary).
const THREAT_SCAN_RESPONSE_TOOLS = new Set(['web_fetch', 'view']);
const THREAT_SCAN_RESPONSE_LIMIT = 16000;

// Command-output tools — scanned ONLY when the output carries a credential
// SHAPE, so benign `grep`/build-log noise doesn't flood the Threats UI but
// `printenv` / `cat .env` exfil is still caught.
const THREAT_SCAN_RESPONSE_MARKER_GATED_TOOLS = new Set(['bash', 'powershell']);

function redact(text) {
  return redactForScan(text).slice(0, ARGS_PREVIEW_LIMIT);
}

/** Copilot delivers toolArgs as a JSON string; parse defensively, never throw. */
function coerceToolInput(toolArgs) {
  if (typeof toolArgs !== 'string') return toolArgs;
  try { return JSON.parse(toolArgs); } catch { return toolArgs; }
}

/** Extract agent-emitted prose from a tool input for the outgoing /analyze scan. */
function extractScanText(toolName, toolInput) {
  if (toolInput == null) return '';
  if (typeof toolInput === 'string') return toolInput;
  if (typeof toolInput !== 'object') return '';
  if (toolName === 'task') {
    const parts = [];
    for (const k of ['prompt', 'description', 'instructions', 'task', 'text', 'message', 'input']) {
      const v = toolInput[k];
      if (typeof v === 'string' && v.length > 0) parts.push(v);
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * Extract scannable text from Copilot's toolResult.
 * Primary field is `toolResult.textResultForLlm` (the documented shape).
 * Falls back to the MCP envelope / common text fields / stringify so an
 * unrecognised shape still gets a chance to fire.
 */
function extractScanTextFromResponse(toolResult) {
  if (toolResult == null) return '';
  if (typeof toolResult === 'string') return toolResult;
  if (typeof toolResult !== 'object') return String(toolResult);

  const parts = [];
  if (typeof toolResult.textResultForLlm === 'string') parts.push(toolResult.textResultForLlm);

  // MCP standard envelope: { content: [ { type:"text", text } ] }
  if (Array.isArray(toolResult.content)) {
    for (const item of toolResult.content) {
      if (item && typeof item === 'object' && typeof item.text === 'string') parts.push(item.text);
      else if (typeof item === 'string') parts.push(item);
    }
  } else if (typeof toolResult.content === 'string') {
    parts.push(toolResult.content);
  }
  for (const key of ['text', 'output', 'body', 'result', 'message', 'stdout', 'stderr']) {
    const v = toolResult[key];
    if (typeof v === 'string' && v.length > 0) parts.push(v);
  }
  if (parts.length === 0) {
    try { return JSON.stringify(toolResult); } catch { return ''; }
  }
  return parts.join('\n');
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
  const byId = new Map();
  for (const row of overrides.synced) {
    if (row && typeof row.tool_id === 'string' && !byId.has(row.tool_id)) byId.set(row.tool_id, row);
  }
  for (const c of candidates) {
    const m = byId.get(c);
    if (m) return { tool_id: c, ...m };
  }
  return null;
}

async function audit(event, baseUrl) {
  const toolName = (event && (event.toolName || event.tool_name)) || '';
  const candidates = normalize(toolName);
  if (candidates.length === 0) return; // unknown tool — skip (fail-open)

  const overrides = await fetchSyncedOverrides(baseUrl, RUNTIME_KIND);
  const match = pickMatch(candidates, overrides);
  const toolId = match ? match.tool_id : candidates[0];
  const reason = match && typeof match.reason === 'string' ? match.reason : null;
  const action = match ? effectToAction(match.effect) : 'allow';

  const toolInput = coerceToolInput(event && (event.toolArgs !== undefined ? event.toolArgs : event.tool_input));
  let argsPreview = '';
  try {
    if (toolInput !== undefined && toolInput !== null) {
      argsPreview = redact(typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput));
    }
  } catch { /* swallow */ }

  const sessionId = (event && (event.sessionId || event.session_id)) || null;
  postJsonAndForget(`${baseUrl}/api/tool-permissions/call-audit`, {
    tool_id: toolId,
    function_name: toolName,
    action,
    risk: null,
    reason,
    is_essential: false,
    args_preview: argsPreview || null,
    runtime_kind: RUNTIME_KIND,
    session_id: sessionId,
  });

  // Outgoing prose scan (task prompt etc.)
  if (THREAT_SCAN_TOOLS.has(toolName)) {
    let rawScanText = '';
    try { rawScanText = extractScanText(toolName, toolInput); } catch { /* swallow */ }
    if (rawScanText.length > 0) {
      postJsonAndForget(`${baseUrl}/analyze`, {
        text: rawScanText.slice(0, THREAT_SCAN_TEXT_LIMIT),
        source: SOURCE,
        direction: 'outgoing',
        metadata: { runtime_kind: RUNTIME_KIND, tool_name: toolName, tool_id: toolId },
      });
    }
  }

  // Incoming IDPI / leakage scan on the tool response.
  const isMcpTool = typeof toolName === 'string' && toolName.startsWith('mcp__');
  if (THREAT_SCAN_RESPONSE_TOOLS.has(toolName) || isMcpTool || THREAT_SCAN_RESPONSE_MARKER_GATED_TOOLS.has(toolName)) {
    let rawResponseText = '';
    try {
      const tr = event && (event.toolResult || event.tool_response || event.toolResponse);
      rawResponseText = extractScanTextFromResponse(tr);
    } catch { /* swallow */ }
    const markerGated = THREAT_SCAN_RESPONSE_MARKER_GATED_TOOLS.has(toolName);
    const passesGate = !markerGated || hasCredentialMarkers(rawResponseText);
    if (rawResponseText.length > 0 && passesGate) {
      postJsonAndForget(`${baseUrl}/analyze`, {
        text: rawResponseText.slice(0, THREAT_SCAN_RESPONSE_LIMIT),
        source: SOURCE,
        direction: 'incoming',
        metadata: { runtime_kind: RUNTIME_KIND, tool_name: toolName, tool_id: toolId, scan_target: 'tool_response' },
      });
    }
  }
}

async function readAllStdin() {
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
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
    await audit(event, baseUrl);
  } catch { /* never crash the hook */ }
  // postToolUse: no stdout control needed (we don't modify the result).
}

if (require.main === module) {
  main();
}

module.exports = {
  redact, coerceToolInput, extractScanText, extractScanTextFromResponse,
  effectToAction, pickMatch, audit,
  THREAT_SCAN_TOOLS, THREAT_SCAN_RESPONSE_TOOLS, THREAT_SCAN_RESPONSE_MARKER_GATED_TOOLS, RUNTIME_KIND,
};
