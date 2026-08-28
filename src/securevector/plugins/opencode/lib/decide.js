// SPDX-License-Identifier: Apache-2.0
/**
 * Pure policy/decision logic for the SecureVector Guard plugin (OpenCode).
 *
 * Everything here is side-effect-free apart from the fire-and-forget POSTs in
 * `client.js`, and none of it touches OpenCode APIs — which makes it unit
 * testable without booting a host. `index.js` is the thin hook wiring on top.
 *
 * It lives in its own module rather than in `index.js` for a load-bearing
 * reason: OpenCode's plugin loader (`getLegacyPlugins`, src/plugin/index.ts)
 * iterates `Object.values(mod)` over the entry module and throws
 * `TypeError("Plugin export is not a function")` on the FIRST export that is
 * not a plugin factory. So `index.js` may export the plugin and nothing else;
 * every helper has to be exported from here instead.
 */

import { normalize, isMcpToolName } from './normalize.js';
import { fetchSyncedOverrides, evaluateEgress } from './client.js';
import { redactForScan } from './redact.js';

const RUNTIME_KIND = 'opencode';
const SOURCE = 'opencode-plugin';
const DEFAULT_BASE_URL = 'http://127.0.0.1:8741';
const ARGS_PREVIEW_LIMIT = 200;
const REASON_PREFIX = 'SecureVector Guard';

const ALLOW = Object.freeze({ decision: 'allow' });

const EFFECT_TO_DECISION = Object.freeze({
  allow: 'allow',
  deny: 'deny',
  prompt: 'ask',
});

// OUTGOING prose scan — tool inputs that are natural language the agent
// emitted (injection vectors). OpenCode's `task` carries a delegated subagent
// prompt and `question` carries text put to the user; those are the prose
// surfaces. Syntax-shaped inputs (bash command bodies, write/edit file blobs)
// are excluded — the LLM-prose rule pack false-positives on them.
const THREAT_SCAN_TOOLS = new Set(['task', 'question']);
const THREAT_SCAN_TEXT_LIMIT = 8000;

// INCOMING IDPI scan — tool RESPONSES the agent takes as context.
// webfetch/websearch return fetched external content; `read` returns file
// content read back into the model. Plus every MCP tool (third-party trust
// boundary), handled separately via isMcpToolName().
const THREAT_SCAN_RESPONSE_TOOLS = new Set(['webfetch', 'websearch', 'read']);
const THREAT_SCAN_RESPONSE_LIMIT = 16000;

// Command-output tools — scanned ONLY when the output carries a credential
// SHAPE, so benign build-log noise doesn't flood the Threats UI while
// `printenv` / `cat .env` exfil is still caught.
const THREAT_SCAN_RESPONSE_MARKER_GATED_TOOLS = new Set(['bash']);

/**
 * Tools that can reach the network. Everything else short-circuits before any
 * egress round-trip. Mirrors NETWORK_CAPABLE_BUILTINS in
 * core/egress/destinations.py; must stay a superset of the per-runtime names.
 */
const NETWORK_CAPABLE = new Set([
  'webfetch', 'websearch', 'bash', 'powershell',
  'shell', 'exec', 'terminal', 'run_terminal_cmd', 'runcommand', 'execute_command',
]);

/**
 * A deliberate policy denial, as distinct from an accidental crash.
 *
 * OpenCode's deny mechanism IS `throw` from `tool.execute.before`, so the
 * plugin cannot simply let exceptions escape: an unhandled error would be
 * indistinguishable from a considered block and would fail CLOSED, which
 * inverts SecureVector's fail-open invariant. `index.js` therefore catches
 * everything and rethrows only this class.
 */
class SecureVectorDenial extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecureVectorDenial';
    this.secureVectorDenial = true;
  }
}

function brand(reason) {
  return String(reason).startsWith(`${REASON_PREFIX}:`)
    ? String(reason)
    : `${REASON_PREFIX}: ${reason}`;
}

function isNetworkCapable(toolName) {
  const n = String(toolName || '').toLowerCase();
  // A remote MCP server is an egress proxy: only its endpoint is observable
  // from here, but that endpoint still belongs on the record. OpenCode MCP
  // names carry no prefix, so this must use isMcpToolName(), not a
  // `startsWith('mcp__')` test (which would match nothing).
  return NETWORK_CAPABLE.has(n) || isMcpToolName(toolName);
}

/**
 * Pure decision: given normalized tool candidates and the local app's
 * synced-overrides response, return an internal decision object.
 */
function decideFromOverrides(candidates, overrides, sessionId = null) {
  if (!Array.isArray(candidates) || candidates.length === 0) return ALLOW;
  if (!overrides || !Array.isArray(overrides.synced) || overrides.synced.length === 0) {
    return ALLOW;
  }
  // Case-insensitive index, first-seen-wins per lowercased tool_id.
  const byToolId = new Map();
  for (const row of overrides.synced) {
    if (row && typeof row.tool_id === 'string') {
      // A session-scoped JIT grant only applies inside the session it was
      // approved for. Skip at index time: grants are emitted first, so an
      // unskipped non-matching grant would win first-seen-wins and shadow the
      // deny it overrides — silently allowing other sessions.
      if (row.source === 'jit_grant' && row.session_id && row.session_id !== sessionId) continue;
      const key = row.tool_id.toLowerCase();
      if (!byToolId.has(key)) byToolId.set(key, row);
    }
  }
  // Candidates are ordered most-specific-first.
  for (const cand of candidates) {
    const match = byToolId.get(cand.toLowerCase());
    if (!match) continue;
    const mapped = EFFECT_TO_DECISION[match.effect];
    if (!mapped) return ALLOW; // unknown effect → fail-open
    if (mapped === 'allow') return ALLOW;
    return {
      decision: mapped,
      reason: typeof match.reason === 'string' && match.reason.length > 0
        ? match.reason
        : `Tool ${cand} matched policy with effect ${match.effect}`,
      toolId: cand,
      requestable: match.requestable === true,
    };
  }
  return ALLOW;
}

/**
 * Second gate: does this call's network destination violate egress policy?
 * Fail-open on every error path, consistent with the fail-open invariant.
 */
async function decideEgress(toolName, toolInput, baseUrl, sessionId) {
  if (!isNetworkCapable(toolName)) return ALLOW;
  try {
    const result = await evaluateEgress(baseUrl, {
      tool_name: toolName,
      tool_input: toolInput || {},
      runtime_kind: RUNTIME_KIND,
      session_id: sessionId,
    });
    if (!result || result.action !== 'block') return ALLOW;
    const top = Array.isArray(result.verdicts)
      ? result.verdicts.find((v) => v && v.action === 'block')
      : null;
    let reason = (top && top.reason) || result.reason || 'Blocked by egress policy';
    if (top && top.remediation) reason += ` ${top.remediation}`;
    return {
      decision: 'deny',
      reason,
      toolId: toolName,
      // Egress denies are not JIT-requestable in v1: a JIT grant is keyed on
      // tool_id, which would open the tool for every host rather than the one
      // under review.
      requestable: false,
      egress: true,
    };
  } catch {
    return ALLOW;
  }
}

/**
 * Full decision for one tool call: normalize → synced overrides → egress.
 * `fetchSyncedOverrides` fails open (returns {} on any network error /
 * timeout / non-2xx), so a down app yields ALLOW here rather than throwing.
 */
async function decide(toolName, baseUrl, sessionId = null, toolInput = null) {
  const candidates = normalize(toolName);
  // Tool-permission rules key off the tool NAME. Egress rules key off the
  // DESTINATION, so a tool with no name-based rule can still be denied for
  // where it points — the egress check must run even with no candidates.
  if (candidates.length > 0) {
    const overrides = await fetchSyncedOverrides(baseUrl, RUNTIME_KIND);
    const decision = decideFromOverrides(candidates, overrides, sessionId);
    // A name-based deny already stops the call; evaluating egress on top would
    // add latency and a duplicate audit row for a call that never happens.
    if (decision.decision !== 'allow') return decision;
  }
  return decideEgress(toolName, toolInput, baseUrl, sessionId);
}

/** Map a decision to the audit-row `action`. */
function decisionToAuditAction(decision) {
  switch (decision) {
    case 'deny': return 'block';
    case 'ask': return 'log_only';
    default: return 'allow';
  }
}

function effectToAction(effect) {
  switch (effect) {
    case 'allow': return 'allow';
    case 'deny': return 'block';
    case 'prompt': return 'log_only';
    default: return 'allow';
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

function redact(text) {
  return redactForScan(text).slice(0, ARGS_PREVIEW_LIMIT);
}

/**
 * Per-call correlation key shared by the audit row and every /analyze POST for
 * this tool call. The traces backend joins threat records AND redaction events
 * to their span through this id — without it, Agent Runs can't show what a
 * call detected and the Agent Map can't flag secret-touching tools.
 *
 * OpenCode gives the SAME `callID` to `tool.execute.before` and
 * `tool.execute.after`, so deriving the id from it (rather than randomly, as
 * the subprocess harnesses must) makes a pre-tool deny row and its post-tool
 * audit row share one key for free.
 */
function requestIdFor(callID) {
  if (typeof callID === 'string' && callID.length > 0) return `oc-${callID}`;
  return `oc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Build the audit payload for a denied / asked call. */
function buildAuditBody(toolName, toolId, toolInput, decision, reason, sessionId, requestId) {
  let argsPreview = null;
  try {
    if (toolInput !== undefined && toolInput !== null) {
      const raw = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);
      argsPreview = redact(raw);
    }
  } catch { /* swallow — empty preview is acceptable */ }
  return {
    tool_id: toolId,
    function_name: toolName,
    action: decisionToAuditAction(decision),
    risk: null,
    reason: typeof reason === 'string' && reason.length > 0 ? reason : null,
    is_essential: false,
    args_preview: argsPreview,
    runtime_kind: RUNTIME_KIND,
    session_id: sessionId || null,
    request_id: requestId || null,
  };
}

/** Extract agent-emitted prose from a tool input for the outgoing scan. */
function extractScanText(toolName, toolInput) {
  if (toolInput == null) return '';
  if (typeof toolInput === 'string') return toolInput;
  if (typeof toolInput !== 'object') return '';
  if (!THREAT_SCAN_TOOLS.has(toolName)) return '';
  const parts = [];
  for (const k of ['prompt', 'description', 'instructions', 'task', 'text', 'message', 'input', 'question']) {
    const v = toolInput[k];
    if (typeof v === 'string' && v.length > 0) parts.push(v);
  }
  return parts.join('\n');
}

/**
 * Extract scannable text from an OpenCode tool result.
 *
 * The two execution paths in `src/session/tools.ts` hand `tool.execute.after`
 * DIFFERENT shapes and the docs only describe the first:
 *   - built-in tools → `{ title, output, metadata, attachments? }`
 *   - MCP tools      → the raw MCP envelope `{ content: [{type:"text",text}] }`
 * Both are handled here, plus a stringify fallback so an unrecognised shape
 * still gets a chance to fire.
 */
function extractScanTextFromResponse(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result !== 'object') return String(result);

  const parts = [];
  // Built-in shape.
  if (typeof result.output === 'string' && result.output.length > 0) parts.push(result.output);
  // MCP envelope.
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item && typeof item === 'object' && typeof item.text === 'string') parts.push(item.text);
      else if (typeof item === 'string') parts.push(item);
    }
  } else if (typeof result.content === 'string') {
    parts.push(result.content);
  }
  for (const key of ['text', 'body', 'result', 'message', 'stdout', 'stderr']) {
    const v = result[key];
    if (typeof v === 'string' && v.length > 0) parts.push(v);
  }
  if (parts.length === 0) {
    try { return JSON.stringify(result); } catch { return ''; }
  }
  return parts.join('\n');
}

/** Extract the user's prompt text from a `chat.message` output. */
function extractPromptText(output) {
  if (!output || typeof output !== 'object') return '';
  const parts = [];
  if (Array.isArray(output.parts)) {
    for (const part of output.parts) {
      if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
  }
  if (parts.length === 0 && output.message && typeof output.message === 'object') {
    const t = output.message.text ?? output.message.content;
    if (typeof t === 'string') parts.push(t);
  }
  return parts.join('\n');
}

function resolveBaseUrl() {
  // Unified engine endpoint (#190) — HOP 1, agent -> engine (the local app OR a
  // self-host / Terraform deployment). NOT the SecureVector cloud. The legacy
  // SV_BASE_URL name stays as a fallback only. Kept as one literal expression
  // so the cross-plugin drift guard can verify the precedence order.
  return process.env.SECUREVECTOR_ENGINE_ENDPOINT || process.env.SV_BASE_URL || DEFAULT_BASE_URL;
}

export {
  ALLOW,
  ARGS_PREVIEW_LIMIT,
  DEFAULT_BASE_URL,
  EFFECT_TO_DECISION,
  NETWORK_CAPABLE,
  REASON_PREFIX,
  RUNTIME_KIND,
  SOURCE,
  SecureVectorDenial,
  THREAT_SCAN_RESPONSE_LIMIT,
  THREAT_SCAN_RESPONSE_MARKER_GATED_TOOLS,
  THREAT_SCAN_RESPONSE_TOOLS,
  THREAT_SCAN_TEXT_LIMIT,
  THREAT_SCAN_TOOLS,
  brand,
  buildAuditBody,
  decide,
  decideEgress,
  decideFromOverrides,
  decisionToAuditAction,
  effectToAction,
  extractPromptText,
  extractScanText,
  extractScanTextFromResponse,
  isNetworkCapable,
  pickMatch,
  redact,
  requestIdFor,
  resolveBaseUrl,
};
