// SPDX-License-Identifier: Apache-2.0
/**
 * Tool-name normalisation for the Guard plugin (Cursor IDE variant).
 *
 * Cursor splits enforcement across EVENT-TYPED hooks instead of one unified
 * PreToolUse, so most "tool names" here are synthesized by our own hook
 * scripts from the event type, not read off the payload:
 *
 *   beforeShellExecution / afterShellExecution → 'shell'
 *   afterFileEdit                              → 'edit'
 *   beforeReadFile                             → 'read'
 *
 * The documented agent tool inventory (cursor.com/docs/agent/hooks,
 * preToolUse `tool_name` enum) is PascalCase single words:
 *   Shell | Read | Write | Grep | Delete | Task | MCP:<tool_name>
 * We store + match lowercase canonical names. KEEP IN LOCKSTEP with the
 * Python CURSOR_BUILTINS table (enforced by
 * tests/unit/app/test_tool_permissions_builtins.py).
 *
 * MCP tools: `beforeMCPExecution` carries `tool_name` plus the server's
 * `url`/`command`; the expanded `preToolUse` event prefixes MCP tools as
 * `MCP:<tool_name>`. ⚠️ The exact on-the-wire MCP name shape is NOT yet
 * verified against a live Cursor build (open question #1 on the idea page —
 * same empirical bar the Copilot plugin met against CLI 1.0.60). Candidates
 * are therefore generated defensively for every plausible shape:
 *
 *   MCP:slack_post                 → ['mcp:slack_post', 'slack_post']
 *   mcp__slack__post_message       → ['slack:post_message', 'post_message']  (bridge shape)
 *   serverless tool name `echo`    → ['echo']            (bare MCP tool name)
 *
 * Unknown names that reach the shell/MCP hooks are still governable surface
 * (the event type proves what they are), so — unlike Copilot's internal
 * bookkeeping tools — we do NOT return [] for bare MCP names; the event
 * context, not the name shape, establishes trust boundary here.
 */

'use strict';

const PREFIX = 'mcp__';
const SEP = '__';
const MCP_EVENT_PREFIX = 'mcp:';

// Canonical Cursor agent built-in tool names (lowercase). Derived from the
// documented preToolUse tool_name enum + the event-typed hook surfaces.
// 'edit' and 'shell' are the synthesized names our own hooks emit for
// afterFileEdit / beforeShellExecution.
const BUILTIN_TOOLS = new Set([
  'shell',
  'read',
  'write',
  'edit',
  'grep',
  'delete',
  'task',
]);

/**
 * True when `toolName` looks like an MCP server tool rather than a Cursor
 * built-in, judged by NAME SHAPE alone. The dedicated MCP hooks
 * (before/afterMCPExecution) don't need this — the event type already proves
 * MCP — so this only serves the unified preToolUse shape (`MCP:<tool>`) and
 * bridge shapes.
 */
function isMcpToolName(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) return false;
  const lower = toolName.toLowerCase();
  if (BUILTIN_TOOLS.has(lower)) return false;
  return lower.startsWith(MCP_EVENT_PREFIX) || toolName.startsWith(PREFIX);
}

/**
 * Normalize a tool name into rule-lookup candidates, most-specific first.
 *
 * @param {string} toolName
 * @param {{fromMcpEvent?: boolean, serverSlug?: string}} [opts] — pass
 *   `fromMcpEvent: true` from the beforeMCPExecution/afterMCPExecution hooks
 *   so bare names are kept as governable candidates; `serverSlug` (derived
 *   from the server url/command) adds `<server>:<tool>` + server-wide
 *   candidates mirroring the cloud rule convention.
 * @returns {string[]}
 */
function normalize(toolName, opts) {
  if (typeof toolName !== 'string' || toolName.length === 0) return [];
  const fromMcpEvent = Boolean(opts && opts.fromMcpEvent);
  const serverSlug = opts && typeof opts.serverSlug === 'string' && opts.serverSlug.length > 0
    ? opts.serverSlug.toLowerCase()
    : null;

  const lower = toolName.toLowerCase();

  // Built-in tool — case-insensitive canonical match (covers both our
  // synthesized lowercase names and the documented PascalCase enum).
  if (!fromMcpEvent && BUILTIN_TOOLS.has(lower)) return [lower];

  // Expanded-event shape: MCP:<tool_name>
  if (lower.startsWith(MCP_EVENT_PREFIX)) {
    const bare = toolName.slice(MCP_EVENT_PREFIX.length);
    if (bare.length === 0) return [];
    return dedupe([lower, bare.toLowerCase(), ...serverCandidates(bare, serverSlug)]);
  }

  // Claude-style bridge shape: mcp__<server>__<tool> (defensive)
  if (toolName.startsWith(PREFIX)) {
    const remainder = toolName.slice(PREFIX.length);
    const sepIdx = remainder.indexOf(SEP);
    if (sepIdx === -1) return [];
    const server = remainder.slice(0, sepIdx);
    const tool = remainder.slice(sepIdx + SEP.length);
    if (server.length === 0 || tool.length === 0) return [];
    return dedupe([`${server}:${tool}`.toLowerCase(), tool.toLowerCase()]);
  }

  // Bare name from an MCP event — governable by event context.
  if (fromMcpEvent) {
    return dedupe([lower, ...serverCandidates(toolName, serverSlug)]);
  }

  // Unknown single token outside any MCP context — not a governable surface.
  return [];
}

function serverCandidates(tool, serverSlug) {
  if (!serverSlug) return [];
  // `<server>:<tool>` is the cloud synced-rule convention; the bare server
  // slug enables a server-wide block.
  return [`${serverSlug}:${tool.toLowerCase()}`, serverSlug];
}

function dedupe(arr) {
  return [...new Set(arr)];
}

module.exports = { normalize, isMcpToolName, BUILTIN_TOOLS };
