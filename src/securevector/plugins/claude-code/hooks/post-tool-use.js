#!/usr/bin/env node
/**
 * PostToolUse hook handler for the SecureVector Guard plugin.
 *
 * Fire-and-forget audit: after every tool call, POST a `tool_call_audit`
 * row to the local app with `runtime_kind: "claude-code"`. The hook never
 * blocks the host CLI — `postJsonAndForget` returns synchronously and
 * swallows every error.
 *
 * Built-in tool names (Bash, Edit, Read, …) short-circuit and emit no
 * audit row — locked decision #3 (MCP tools only in v1). Built-in
 * enforcement + auditing returns in a follow-up version with a
 * cloud-side catalogue change.
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

const DEFAULT_BASE_URL = 'http://127.0.0.1:8741';
const ARGS_PREVIEW_LIMIT = 200;
const RUNTIME_KIND = 'claude-code';

// Inlined secret redaction. Conservative patterns covering the most
// common high-blast-radius leaks: OpenAI / Anthropic / GitHub tokens,
// AWS access keys, JWTs, and `password|secret|token|api_key` k/v pairs.
const SECRET_PATTERNS = [
  /(?:sk|pk)-[A-Za-z0-9_-]{20,}/g,                                                                // sk-/pk- API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                                                              // GitHub PAT / OAuth
  /\bAKIA[0-9A-Z]{16}\b/g,                                                                        // AWS Access Key ID
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,                               // JWT (header.payload.sig)
  /(["']?(?:password|secret|token|api[_-]?key|bearer)["']?\s*[:=]\s*["']?)[^"'\s,}\]]{6,}/gi,     // password/secret/token kv-pairs
];

function redact(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  let out = text;
  for (const pat of SECRET_PATTERNS) {
    out = out.replace(pat, (match, prefix) => (prefix ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }
  return out.slice(0, ARGS_PREVIEW_LIMIT);
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
  if (candidates.length === 0) return; // built-in / non-MCP — skip audit (locked decision #3)

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

module.exports = { redact, effectToAction, pickMatch, audit, RUNTIME_KIND };
