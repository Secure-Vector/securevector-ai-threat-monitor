#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * PostToolUse hook handler for the SecureVector Guard plugin (Antigravity).
 *
 * Fire-and-forget audit: after every tool call, POST a `tool_call_audit` row
 * to the local app with `runtime_kind: "antigravity"`. The hook never blocks
 * the host CLI: `postJsonAndForget` returns synchronously and swallows every
 * error.
 *
 * Effect to audit action (matches the sibling harnesses' audit table):
 *   allow  -> "allow"
 *   deny   -> "block"
 *   prompt -> "log_only"
 *   no rule matched -> "allow"
 *
 * WHAT IS NOT HERE, AND WHY. Antigravity's documented PostToolUse payload is
 * the PreToolUse payload plus an optional `error` string. It carries NO tool
 * RESULT, which is the field the other harnesses' response scan reads. So the
 * incoming-direction scan, the one that catches indirect prompt injection in
 * fetched content and credentials in command output, has no input on this
 * host. Rather than pretend otherwise, the response scan below runs only if a
 * result field actually turns up on the event, and the plugin's README and
 * PRIVACY.md both state the gap plainly. Outgoing (tool-input) scanning and
 * the full audit chain are unaffected.
 *
 * Antigravity's PostToolUse output is documented as an empty object, and its
 * behaviour on hook error is not documented at all, so `{}` is written on
 * every path including a stdin parse failure.
 *
 * Zero npm deps. Native Node 18+.
 */

'use strict';

const { normalize, isMcpToolName } = require('../lib/normalize.js');
const { resolveBaseUrl, postJsonAndForget, fetchSyncedOverrides } = require('../lib/client.js');
const { redactForScan, hasCredentialMarkers } = require('../lib/redact.js');

const ARGS_PREVIEW_LIMIT = 8192; // 8 KB, redacted; the app redacts and caps again on write
const RUNTIME_KIND = 'antigravity';

// Tools whose args are PROSE the agent emitted in natural language, and are
// therefore worth running through the LLM-text rule pack at /analyze.
// Syntax-shaped args (a `run_command` command body, `create_file` content, an
// `edit_file` replacement) are excluded: the community rule pack was designed
// for LLM prose, and matching its regexes against shell or source syntax
// produces high-volume false positives.
//
// In:
//   search_web      - the agent's own search query
//   start_subagent  - the instructions handed to a child agent
//   ask_question    - the question text put to the user
//   generate_image  - the image prompt
//
// Out: run_command, create_file, edit_file, view_file, list_directory,
// search_directory, find_file, read_url_content (a URL is metadata, and a
// path-shaped string trips the data-leakage rules).
//
// Every tool still produces a /call-audit row regardless of membership here;
// this set ONLY gates the /analyze threat-scan POST.
const THREAT_SCAN_TOOLS = new Set([
  'search_web',
  'start_subagent',
  'ask_question',
  'generate_image',
]);
const THREAT_SCAN_TEXT_LIMIT = 8000; // bytes, well under /analyze's 100KB cap

// Tools whose result is content the agent will treat as context for its next
// step, and therefore an indirect-prompt-injection vector as well as a
// credential and PII surface. Scanned with direction='incoming' so the IDPI
// rule pack fires and the engine applies the tighter threshold appropriate to
// fetched content the user has no agency over.
//
// This set is only reachable when a result field is present on the event. See
// the file header: the documented Antigravity PostToolUse payload has none.
const THREAT_SCAN_RESPONSE_TOOLS = new Set([
  'read_url_content',
  'search_web',
  'view_file',
  'search_directory',
  'run_command',
]);
const THREAT_SCAN_RESPONSE_LIMIT = 16000; // bytes, bigger than the input cap; results are denser

// Command output is syntax-shaped, high-volume, mostly benign developer noise:
// `strings` dumps, ripgrep over source, build logs, tens of KB of identifiers
// with no secret in sight. Shipping those whole to /analyze trips the
// credential rules and floods the Threats UI. So the result scan for these is
// opt-in: scan only when the output actually carries a credential SHAPE
// (`hasCredentialMarkers`, the same SECRET_PATTERNS the redactor masks
// against). A `printenv` or `cat .env` that leaks AKIA... is still scanned, so
// the output-leakage value is preserved.
//
// Context-facing tools are deliberately not in this set: their results are
// content the agent will treat as instructions, so they stay scanned
// unconditionally for indirect prompt injection.
const THREAT_SCAN_RESPONSE_MARKER_GATED_TOOLS = new Set([
  'run_command',
]);

function redact(text) {
  return redactForScan(text).slice(0, ARGS_PREVIEW_LIMIT);
}

/**
 * Pull the tool name and args out of an Antigravity PostToolUse event.
 * Documented shape: `{ toolCall: { name, args }, stepIdx, conversationId,
 * transcriptPath, ..., error? }`. Tool args arrive as a JSON STRING often
 * enough across harnesses that parsing defensively is cheaper than an empty
 * preview on every call.
 */
function readToolCall(event) {
  const call = (event && typeof event.toolCall === 'object' && event.toolCall) || {};
  const name = (typeof call.name === 'string' && call.name)
    || (event && (event.tool_name || event.toolName))
    || '';
  let args = call.args !== undefined ? call.args : (event && (event.tool_input || event.toolInput));
  if (typeof args === 'string' && args.length > 0) {
    try { args = JSON.parse(args); } catch { /* keep the raw string */ }
  }
  return { name, args: args === undefined ? null : args };
}

/**
 * Find a tool RESULT on the event, if the running build carries one.
 *
 * The documented payload does not include a result, only an optional `error`.
 * These field names are the shapes the sibling harnesses use, probed in order
 * so that a future Antigravity build which starts sending a result lights up
 * the incoming scan without a plugin change. Returns undefined when there is
 * nothing, which is the documented case today.
 */
function readToolResult(event) {
  if (!event || typeof event !== 'object') return undefined;
  const call = (typeof event.toolCall === 'object' && event.toolCall) || {};
  for (const src of [event, call]) {
    for (const key of ['toolResult', 'tool_result', 'result', 'output', 'toolResponse', 'tool_response']) {
      const v = src[key];
      if (v !== undefined && v !== null) return v;
    }
  }
  return undefined;
}

/**
 * Extract the natural-language CONTENT from a tool's args for /analyze.
 *
 * Sending `JSON.stringify(args)` would dump every structural field (paths,
 * globs, line ranges) into the rule engine, which both trips threat rules on
 * routine path strings and bloats threat_intel_records with structural noise.
 * So only the field carrying agent-emitted text is extracted. Unknown shapes
 * return '' and the scan is skipped: no analyse means no false positives.
 */
function extractScanText(toolName, args) {
  if (args == null) return '';
  if (typeof args === 'string') return args;
  if (typeof args !== 'object') return '';

  // Tool arg schemas vary and are not fully documented, so every plausible
  // prose-bearing key is concatenated rather than guessing one name per tool.
  const parts = [];
  for (const k of ['query', 'prompt', 'question', 'instructions', 'task', 'description', 'message', 'input']) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) parts.push(v);
  }
  return parts.join('\n');
}

/**
 * Extract scannable text from a tool result.
 *
 * Results come in heterogeneous shapes across tools, so this is deliberately
 * permissive: over-scanning a little structural JSON is cheaper than missing
 * a leaked key.
 */
function extractScanTextFromResult(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result !== 'object') return String(result);

  const parts = [];

  // MCP standard envelope: { content: [ { type: "text", text: "..." }, ... ] }
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item && typeof item === 'object' && typeof item.text === 'string') {
        parts.push(item.text);
      } else if (typeof item === 'string') {
        parts.push(item);
      }
    }
  } else if (typeof result.content === 'string') {
    parts.push(result.content);
  }

  // Common text-bearing fields. `stdout` and `stderr` cover run_command, the
  // highest-volume credential-exfil channel (printenv, cat .env,
  // cat ~/.aws/credentials).
  for (const key of ['text', 'output', 'body', 'result', 'message', 'stdout', 'stderr']) {
    const v = result[key];
    if (typeof v === 'string' && v.length > 0) parts.push(v);
  }

  if (Array.isArray(result.matches)) {
    for (const m of result.matches) {
      if (typeof m === 'string') parts.push(m);
    }
  }

  // A fully unrecognised shape should not be a free pass.
  if (parts.length === 0) {
    try { return JSON.stringify(result); } catch { return ''; }
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
    if (row && typeof row.tool_id === 'string') {
      const key = row.tool_id.toLowerCase();
      if (!byId.has(key)) byId.set(key, row);
    }
  }
  for (const c of candidates) {
    const m = byId.get(c.toLowerCase());
    if (m) return { ...m, tool_id: c };
  }
  return null;
}

async function audit(event, baseUrl) {
  const { name: toolName, args } = readToolCall(event);
  const candidates = normalize(toolName);
  if (candidates.length === 0) return; // ignored bookkeeping tool, nothing to audit

  const overrides = await fetchSyncedOverrides(baseUrl, RUNTIME_KIND);
  const match = pickMatch(candidates, overrides);

  const toolId = match ? match.tool_id : candidates[0];
  const reason = match && typeof match.reason === 'string' ? match.reason : null;
  const action = match ? effectToAction(match.effect) : 'allow';

  let argsPreview = '';
  try {
    if (args !== undefined && args !== null) {
      argsPreview = redact(typeof args === 'string' ? args : JSON.stringify(args));
    }
  } catch { /* swallow, an empty preview is acceptable */ }

  const sessionId = (event && (event.conversationId || event.conversation_id || event.session_id)) || null;
  // One correlation id per tool call, stamped on the audit row AND on every
  // /analyze POST below. The app joins them
  // (tool_call_audit.request_id to threat_intel_records.request_id) to label
  // what caught a detection on Agent Runs and the Agent Map, and to attach
  // redaction events to the call that produced them. Without it the app
  // detects everything and can show none of it against the call. Loopback
  // only, random, carries no content.
  const requestId = `ag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
    request_id: requestId,
  });

  // ---- Outgoing scan (tool args) ---------------------------------------
  if (THREAT_SCAN_TOOLS.has(toolName)) {
    let rawScanText = '';
    try {
      // Send RAW text to /analyze: the server's redact_secrets() is the single
      // source of truth for redaction AND owns the Secret Detections audit
      // log, so pre-redacting here would erase the very matches that pipeline
      // records. The endpoint is loopback and the server hashes immediately,
      // never persisting the raw value.
      rawScanText = extractScanText(toolName, args);
    } catch { /* swallow */ }

    if (rawScanText.length > 0) {
      const scanText = rawScanText.length > THREAT_SCAN_TEXT_LIMIT
        ? rawScanText.slice(0, THREAT_SCAN_TEXT_LIMIT)
        : rawScanText;
      postJsonAndForget(`${baseUrl}/analyze`, {
        text: scanText,
        source: 'antigravity-plugin',
        direction: 'outgoing',
        request_id: requestId,
        session_id: sessionId,
        metadata: {
          runtime_kind: RUNTIME_KIND,
          tool_name: toolName,
          tool_id: toolId,
        },
      });
    }
  }

  // ---- Incoming scan (tool result, when one is present) ------------------
  //
  // Dormant on the documented payload, which carries no result. Kept because
  // the cost is one `undefined` check per call and the benefit, if a build
  // starts sending results, is the IDPI and output-leakage coverage the other
  // harnesses have.
  const result = readToolResult(event);
  if (result !== undefined && (THREAT_SCAN_RESPONSE_TOOLS.has(toolName) || isMcpToolName(toolName))) {
    let rawResultText = '';
    try {
      rawResultText = extractScanTextFromResult(result);
    } catch { /* swallow, fail-open */ }

    const markerGated = THREAT_SCAN_RESPONSE_MARKER_GATED_TOOLS.has(toolName);
    const passesGate = !markerGated || hasCredentialMarkers(rawResultText);

    if (rawResultText.length > 0 && passesGate) {
      const scanText = rawResultText.length > THREAT_SCAN_RESPONSE_LIMIT
        ? rawResultText.slice(0, THREAT_SCAN_RESPONSE_LIMIT)
        : rawResultText;
      postJsonAndForget(`${baseUrl}/analyze`, {
        text: scanText,
        source: 'antigravity-plugin',
        direction: 'incoming',
        request_id: requestId,
        session_id: sessionId,
        metadata: {
          runtime_kind: RUNTIME_KIND,
          tool_name: toolName,
          tool_id: toolId,
          scan_target: 'tool_result',
        },
      });
    }
  }
}


// --- stdin/stdout adapter (entry point) ---------------------------------

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
    process.stdout.write('{}');
    return;
  }
  const baseUrl = resolveBaseUrl();
  try {
    await audit(event, baseUrl);
  } catch {
    // Belt-and-suspenders: never crash the hook process.
  }
  process.stdout.write('{}');
}

if (require.main === module) {
  main().catch(() => { process.stdout.write('{}'); });
}

module.exports = {
  redact,
  redactForScan,
  hasCredentialMarkers,
  readToolCall,
  readToolResult,
  extractScanText,
  extractScanTextFromResult,
  effectToAction,
  pickMatch,
  audit,
  THREAT_SCAN_TOOLS,
  THREAT_SCAN_RESPONSE_TOOLS,
  THREAT_SCAN_RESPONSE_MARKER_GATED_TOOLS,
  RUNTIME_KIND,
};
