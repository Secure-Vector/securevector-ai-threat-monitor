#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * PostToolUse hook handler for the SecureVector Guard plugin.
 *
 * Fire-and-forget audit: after every tool call, POST a `tool_call_audit`
 * row to the local app with `runtime_kind: "claude-code"`. The hook never
 * blocks the host CLI — `postJsonAndForget` returns synchronously and
 * swallows every error.
 *
 * Both MCP and built-in (Bash / Edit / Read / etc.) tool names are
 * normalised to lookup candidates; unknown names short-circuit and emit
 * no audit row.
 *
 * Effect → audit action mapping (matches OpenClaw's audit table):
 *   allow  → "allow"
 *   deny   → "block"
 *   prompt → "log_only"
 *   no rule matched → "allow"
 *
 * Inlines a ~10 LOC redaction helper for `args_preview` to keep the
 * audit row useful for triage but free of obvious secrets. Conservative
 * substitution only — not a full DLP system.
 *
 * Zero npm deps. Native Node 18+.
 */

'use strict';

const { normalize } = require('../lib/normalize.js');
const { postJsonAndForget, fetchSyncedOverrides } = require('../lib/client.js');
const { SECRET_PATTERNS, redactForScan, hasCredentialMarkers } = require('../lib/redact.js');

const DEFAULT_BASE_URL = 'http://127.0.0.1:8741';
const ARGS_PREVIEW_LIMIT = 200;
const RUNTIME_KIND = 'claude-code';

// Tools whose `tool_input` is *prose the agent emitted in natural language*
// and is therefore worth running through the LLM-text rule pack at
// /analyze. Syntax-shaped tool inputs (Bash command bodies, file content
// blobs, source-code edits) are EXCLUDED — the community rule pack was
// designed for LLM prose (prompts and responses), and matching its
// regexes against shell / source syntax produces high-volume false
// positives (URLs trip credential-leak; `| python3 -m json.tool` trips
// bulk-data-extraction; etc.).
//
// What we keep:
//   - WebFetch — agent supplies a natural-language prompt about a URL
//   - Skill / Task / Agent — agent supplies a prompt / description /
//     instructions field that is, by design, prose
//
// What we DROP (was scanned in v4.2.0, removed in v4.2.1+):
//   - Bash / PowerShell — command bodies are shell syntax, not prose
//   - Write — file content is whatever the file is (often source code)
//   - Edit / MultiEdit / NotebookEdit — new_string / new_source is
//     source-code syntax (or notebook cell code)
//
// Tool calls themselves still produce a /call-audit row regardless of
// whether they're in this set — that's the always-on audit chain. This
// set ONLY gates the /analyze threat-scan POST.
const THREAT_SCAN_TOOLS = new Set([
  'WebFetch',
  'Skill',
  'Task',
  'Agent',
]);
const THREAT_SCAN_TEXT_LIMIT = 8000; // bytes — well under /analyze's 100KB cap

// Tools whose `tool_response` is content the agent will treat as context
// for its next step — and therefore an Indirect Prompt Injection vector
// AND a credential / PII / data-leakage surface. Scanned with
// direction='incoming' so the IDPI rule pack fires and the engine
// applies the tighter-threshold treatment appropriate for fetched
// content the user has no agency over.
//
// What's in:
//   - WebFetch       — page text we just pulled from the web
//   - Read           — file the agent just read off disk
//   - Grep           — matched lines from a search
//   - Every `mcp__*` tool — MCP servers are third-party trust boundaries;
//                          their responses are the supply-chain inventory
//                          problem made operational.
//
// Bash IS now in — `printenv`, `cat .env`, `cat ~/.aws/credentials`,
// `git config --get user.password` are the highest-volume credential
// exfil channel. Per issue #131 we light it up; server-side the rule
// pack's direction-tagged suppression (outgoing-only rules dropped on
// direction='incoming' — issue #136 Phase 3) already removes the noisy
// prose-tier rules, so the FP rate that originally kept Bash excluded
// is mitigated.
//
// Still deliberately out: Write / Edit results — the response is
// "ok" / a confirmation, not content. Nothing to scan.
const THREAT_SCAN_RESPONSE_TOOLS = new Set([
  'WebFetch',
  'Read',
  'Grep',
  'Bash',
  'PowerShell',
]);
const THREAT_SCAN_RESPONSE_LIMIT = 16000; // bytes — bigger than input cap; tool responses are denser content.

// Tools whose `tool_response` is command output (shell stdout/stderr) —
// syntax-shaped, high-volume, mostly benign developer noise. `strings
// <binary>` dumps, `grep`/`ripgrep` over source, `sqlite3 .dump`, package
// listings, build logs: tens of KB of plain identifiers with no secret in
// sight. Shipping these whole to /analyze trips the credential / leakage
// rules and floods the Threats UI with false positives.
//
// So the response scan for these tools is OPT-IN, matching the project
// principle the OUTGOING Bash path already follows (THREAT_SCAN_TOOLS
// excludes Bash entirely): we scan the response ONLY when it actually
// carries a credential SHAPE (`hasCredentialMarkers` — same SECRET_PATTERNS
// the redactor masks against: AKIA…, ghp_…, sk-…, JWT eyJ…, PEM blocks,
// `password=` / `api_key:` kv-pairs, etc.). A `printenv` / `cat .env` that
// leaks `AWS_ACCESS_KEY_ID=AKIA…` still gets scanned — the output-leakage
// value of the feature is preserved — but a benign `strings`-dump blob is
// skipped.
//
// Context-facing tools (WebFetch / Read / Grep / every MCP tool) are NOT
// in this set: their responses are fetched content the agent will treat as
// instructions, so they remain scanned UNCONDITIONALLY for Indirect Prompt
// Injection regardless of whether a credential shape is present.
const THREAT_SCAN_RESPONSE_MARKER_GATED_TOOLS = new Set([
  'Bash',
  'PowerShell',
]);

// `SECRET_PATTERNS` + `redactForScan` are imported from ../lib/redact.js
// so post-tool-use and user-prompt-submit can never drift apart on the
// secret surfaces they mask. The audit-preview variant below is a
// thin wrapper that adds the ARGS_PREVIEW_LIMIT truncation.

function redact(text) {
  return redactForScan(text).slice(0, ARGS_PREVIEW_LIMIT);
}

/**
 * Extract the natural-language CONTENT from a tool_input for /analyze.
 *
 * Prior versions sent `JSON.stringify(tool_input)` which dumped every
 * structural field — file_path, old_string, notebook_path, etc. — into
 * the rule engine. That produced two problems:
 *   1. Threat-rule false positives on routine path strings (e.g. a
 *      file_path of "/var/folders/..." would trip data_leakage).
 *   2. Sent more user content than the analyzer actually scans against,
 *      bloating threat_intel_records with structural JSON noise.
 *
 * The fix: extract only the field(s) carrying attacker-controllable or
 * agent-emitted text — for each supported tool, the canonical "what is
 * being written / executed / asked" field. For unknown shapes we return
 * an empty string and skip the scan (fail-closed: no analyse = no
 * false positives).
 *
 * Returns '' when no scannable text is found.
 */
function extractScanText(toolName, toolInput) {
  if (toolInput == null) return '';
  // String tool_input (rare) — assume it IS the content.
  if (typeof toolInput === 'string') return toolInput;
  if (typeof toolInput !== 'object') return '';

  switch (toolName) {
    case 'WebFetch': {
      // The agent-supplied prompt is the injection vector; the URL is
      // metadata (and a path-shaped string that trips data_leakage).
      const parts = [];
      if (typeof toolInput.prompt === 'string') parts.push(toolInput.prompt);
      return parts.join('\n');
    }
    case 'Skill':
    case 'Task':
    case 'Agent': {
      // Any natural-language field — concatenated. Tool schemas vary
      // (Task has `prompt`/`description`; Skill has `args`; Agent has
      // `prompt`). Falls back to '' if none of the known fields exist.
      const parts = [];
      for (const k of ['prompt', 'description', 'instructions', 'message', 'args', 'input']) {
        const v = toolInput[k];
        if (typeof v === 'string' && v.length > 0) parts.push(v);
      }
      return parts.join('\n');
    }
    default:
      // Syntax-shaped tools (Bash, PowerShell, Write, Edit, MultiEdit,
      // NotebookEdit) intentionally return '' here — they're not in
      // THREAT_SCAN_TOOLS, so this branch is unreachable for them in
      // the normal audit() flow. The empty-string fallback also fail-
      // closes for any unrecognised tool name.
      return '';
  }
}

/**
 * Extract scannable text from a tool_response.
 *
 * Claude Code's PostToolUse event includes `tool_response` — the value the
 * tool returned to the agent before its next reasoning step. That response
 * is what the LLM will read as context, so it's the right surface for
 * Indirect Prompt Injection detection and for catching credentials / PII
 * a tool dumped into the agent's context window.
 *
 * Tool responses come in heterogeneous shapes:
 *   - WebFetch / web tools: { content: "<page text>" } or a bare string
 *   - Read: { content: "<file body>" } or { type: "text", text: "..." }
 *   - Grep: { matches: [ "line 1", "line 2", ... ] } or a string
 *   - MCP tools: { content: [ { type:"text", text:"..." } ] } per MCP spec
 *   - Anything else: stringify and let the rule pack do its thing.
 *
 * The function is intentionally permissive — we'd rather scan a little
 * extra structural JSON than miss a leaked key.
 */
function extractScanTextFromResponse(toolResponse) {
  if (toolResponse == null) return '';
  if (typeof toolResponse === 'string') return toolResponse;
  if (typeof toolResponse !== 'object') return String(toolResponse);

  const parts = [];

  // MCP standard envelope: { content: [ { type:"text", text:"..." }, ... ] }
  if (Array.isArray(toolResponse.content)) {
    for (const item of toolResponse.content) {
      if (item && typeof item === 'object' && typeof item.text === 'string') {
        parts.push(item.text);
      } else if (typeof item === 'string') {
        parts.push(item);
      }
    }
  } else if (typeof toolResponse.content === 'string') {
    parts.push(toolResponse.content);
  }

  // Common text-bearing fields seen across Claude Code / Codex built-ins
  // and MCP responses. Listed in priority order; first match wins. No
  // de-dup — small over-scan is cheaper than missing a secret.
  //
  // `stdout` + `stderr` cover Bash / PowerShell — that's the
  // highest-volume credential-exfil channel (printenv, cat .env,
  // cat ~/.aws/credentials, git config --get user.password). Issue #131.
  for (const key of ['text', 'output', 'body', 'result', 'message', 'stdout', 'stderr']) {
    const v = toolResponse[key];
    if (typeof v === 'string' && v.length > 0) parts.push(v);
  }

  // Grep-style: { matches: [...] }
  if (Array.isArray(toolResponse.matches)) {
    for (const m of toolResponse.matches) {
      if (typeof m === 'string') parts.push(m);
    }
  }

  // Fallback: if we didn't find anything text-shaped, stringify the whole
  // thing so the rule pack still gets a chance to fire on whatever the
  // tool returned (a fully unrecognised shape shouldn't be a free pass).
  if (parts.length === 0) {
    try { return JSON.stringify(toolResponse); } catch { return ''; }
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
    if (row && typeof row.tool_id === 'string' && !byId.has(row.tool_id)) {
      byId.set(row.tool_id, row);
    }
  }
  for (const c of candidates) {
    const m = byId.get(c);
    if (m) return { tool_id: c, ...m };
  }
  return null;
}

async function audit(event, baseUrl) {
  const toolName = (event && (event.tool_name || event.toolName)) || '';
  const candidates = normalize(toolName);
  if (candidates.length === 0) return; // unknown tool name — skip audit (fail-open)

  const overrides = await fetchSyncedOverrides(baseUrl);
  const match = pickMatch(candidates, overrides);

  const toolId = match ? match.tool_id : candidates[0];
  const reason = match && typeof match.reason === 'string' ? match.reason : null;
  const action = match ? effectToAction(match.effect) : 'allow';

  let argsPreview = '';
  try {
    const ti = event && (event.tool_input || event.toolInput);
    if (ti !== undefined && ti !== null) {
      argsPreview = redact(typeof ti === 'string' ? ti : JSON.stringify(ti));
    }
  } catch { /* swallow — empty preview is acceptable */ }

  const sessionId = (event && (event.session_id || event.sessionId)) || null;
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

  // Threat-intel pass — only for tools whose `tool_input` is prose the
  // agent emitted in natural language (WebFetch.prompt, Skill/Task/Agent
  // prompts). The /analyze endpoint and the community rule pack were
  // designed for LLM prose; running them on shell syntax or source-code
  // blobs produces high-volume false positives. Syntax-shaped tools
  // (Bash, Write, Edit, MultiEdit, NotebookEdit) are deliberately
  // excluded from THREAT_SCAN_TOOLS — their tool calls still produce
  // /call-audit rows above, just no /analyze POST.
  //
  // Fire-and-forget; never blocks the host CLI.
  if (THREAT_SCAN_TOOLS.has(toolName)) {
    let rawScanText = '';
    try {
      const ti = event && (event.tool_input || event.toolInput);
      // Send RAW text to /analyze — the server's redact_secrets() is the
      // single source of truth for redaction AND owns the Secret
      // Detections audit log. Pre-redacting on the client would erase the
      // very matches the audit pipeline needs to record. Loopback-only
      // (127.0.0.1) and the server hashes immediately, never persisting
      // the raw value.
      rawScanText = extractScanText(toolName, ti);
    } catch { /* swallow */ }

    if (rawScanText.length > 0) {
      const scanText = rawScanText.length > THREAT_SCAN_TEXT_LIMIT
        ? rawScanText.slice(0, THREAT_SCAN_TEXT_LIMIT)
        : rawScanText;
      postJsonAndForget(`${baseUrl}/analyze`, {
        text: scanText,
        source: 'claude-code-plugin',
        direction: 'outgoing',
        metadata: {
          runtime_kind: RUNTIME_KIND,
          tool_name: toolName,
          tool_id: toolId,
        },
      });
    }
  }

  // ---- Tool-response scan (direction='incoming') -------------------------
  //
  // The agent will treat the tool's response as context for its next
  // reasoning step — so the response is an Indirect Prompt Injection
  // vector AND a credential / PII / data-leakage surface. We scan it
  // with direction='incoming' so the IDPI rule pack fires alongside the
  // raw-secret-shape and PII rules.
  //
  // Scanned for: WebFetch / Read / Grep (built-in) and EVERY MCP tool
  // (any tool_name prefixed `mcp__`). MCP responses are third-party
  // trust boundaries — the supply-chain inventory problem made
  // operational. Excluded: Write / Edit / Skill (responses are ack-only
  // or aren't fetched content).
  //
  // Command-output tools (Bash / PowerShell) are MARKER-GATED: their
  // stdout/stderr is scanned only when it carries a credential shape (see
  // THREAT_SCAN_RESPONSE_MARKER_GATED_TOOLS). This stops benign
  // developer-tool output (`strings` dumps, `grep`, `sqlite3`, tens of KB
  // of identifiers) from flooding the Threats UI with false positives,
  // while still catching `printenv` / `cat .env` credential exfil.
  //
  // Fire-and-forget; never blocks the host CLI.
  const isMcpTool = typeof toolName === 'string' && toolName.startsWith('mcp__');
  if (THREAT_SCAN_RESPONSE_TOOLS.has(toolName) || isMcpTool) {
    let rawResponseText = '';
    try {
      const tr = event && (event.tool_response || event.toolResponse);
      // Same posture as the outgoing path: send raw to /analyze, let the
      // server-side redact_secrets() own redaction + audit logging.
      rawResponseText = extractScanTextFromResponse(tr);
    } catch { /* swallow — fail-open */ }

    // Marker gate for syntax-shaped command output: only scan when a
    // credential shape is actually present. Context-facing tools
    // (WebFetch / Read / Grep / MCP) bypass the gate — they're scanned
    // unconditionally for Indirect Prompt Injection.
    const markerGated = THREAT_SCAN_RESPONSE_MARKER_GATED_TOOLS.has(toolName);
    const passesGate = !markerGated || hasCredentialMarkers(rawResponseText);

    if (rawResponseText.length > 0 && passesGate) {
      const scanText = rawResponseText.length > THREAT_SCAN_RESPONSE_LIMIT
        ? rawResponseText.slice(0, THREAT_SCAN_RESPONSE_LIMIT)
        : rawResponseText;
      postJsonAndForget(`${baseUrl}/analyze`, {
        text: scanText,
        source: 'claude-code-plugin',
        direction: 'incoming',
        metadata: {
          runtime_kind: RUNTIME_KIND,
          tool_name: toolName,
          tool_id: toolId,
          scan_target: 'tool_response',
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
    // Malformed stdin — exit cleanly. PostToolUse has nothing to return
    // on stdout; the audit POST simply doesn't happen.
    return;
  }
  const baseUrl = process.env.SV_BASE_URL || DEFAULT_BASE_URL;
  try {
    await audit(event, baseUrl);
  } catch {
    // Belt-and-suspenders: never crash the hook process.
  }
}

if (require.main === module) {
  main();
}

module.exports = { redact, redactForScan, hasCredentialMarkers, extractScanText, extractScanTextFromResponse, effectToAction, pickMatch, audit, THREAT_SCAN_TOOLS, THREAT_SCAN_RESPONSE_TOOLS, THREAT_SCAN_RESPONSE_MARKER_GATED_TOOLS, RUNTIME_KIND };
