#!/usr/bin/env node
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
const { SECRET_PATTERNS, redactForScan } = require('../lib/redact.js');

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

  postJsonAndForget(`${baseUrl}/api/tool-permissions/call-audit`, {
    tool_id: toolId,
    function_name: toolName,
    action,
    risk: null,
    reason,
    is_essential: false,
    args_preview: argsPreview || null,
    runtime_kind: RUNTIME_KIND,
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
      rawScanText = redactForScan(extractScanText(toolName, ti));
    } catch { /* swallow */ }

    if (rawScanText.length > 0) {
      // Cap the POST body to THREAT_SCAN_TEXT_LIMIT (after redaction so
      // the truncation applies to the redacted text, not raw secrets).
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

module.exports = { redact, redactForScan, extractScanText, effectToAction, pickMatch, audit, THREAT_SCAN_TOOLS, RUNTIME_KIND };
