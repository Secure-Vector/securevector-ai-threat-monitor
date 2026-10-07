// SPDX-License-Identifier: Apache-2.0
/**
 * Tool-name normalisation for the Guard plugin (Antigravity variant).
 *
 * Antigravity hands the hook the proposed call as `toolCall.name`. Built-ins
 * are lowercase snake_case single names (`run_command`, `view_file`, ...),
 * taken from the first-party built-in tool reference at
 * antigravity.google/docs/sdk/tools. KEEP IN LOCKSTEP with the Python
 * ANTIGRAVITY_BUILTINS table in app/server/routes/tool_permissions.py
 * (enforced by tests/unit/app/test_tool_permissions_builtins.py).
 *
 * The MCP tool-name shape is NOT documented first-party and has NOT been
 * confirmed against a live `agy` session, so guessing one shape and returning
 * [] for the rest would silently leave every MCP tool unaudited and
 * ungoverned. Candidates are therefore generated for every plausible shape,
 * most-specific first, and an unrecognised bare token is still treated as a
 * governable name rather than discarded:
 *
 *   mcp__github__create_issue  -> ['github:create_issue', 'create_issue']
 *   github__create_issue       -> ['github:create_issue', 'create_issue', 'github__create_issue']
 *   github.create_issue        -> ['github:create_issue', 'create_issue', 'github.create_issue']
 *   github-create_issue        -> ['github:create_issue', 'create_issue', 'github-create_issue']
 *   create_issue               -> ['create_issue']
 *
 * The one class that does return [] is IGNORED_TOOLS: agent bookkeeping whose
 * only effect is to end the turn. A user who blocked `finish` would wedge
 * every session with no way to tell why, and there is nothing to audit.
 */

'use strict';

const PREFIX = 'mcp__';
const SEP = '__';

// Antigravity built-in tool names. Source: the first-party built-in tools
// reference (antigravity.google/docs/sdk/tools), which lists thirteen; twelve
// are governable and `finish` is in IGNORED_TOOLS below.
//
// Erring toward completeness is safe: a name Antigravity never emits simply
// never matches, whereas a missing name silently no-ops every rule written
// against it.
//
// NOTE: exported for test introspection only. `normalize()` reads the live
// reference, so a runtime mutation would change enforcement for the rest of
// the process.
const BUILTIN_TOOLS = new Set([
  // Filesystem reads
  'list_directory',
  'search_directory',
  'find_file',
  'view_file',
  // Filesystem writes
  'create_file',
  'edit_file',
  // Shell
  'run_command',
  // User interaction
  'ask_question',
  // Agents
  'start_subagent',
  // Model-backed generation
  'generate_image',
  // Network
  'search_web',
  'read_url_content',
]);

// Turn-control bookkeeping, not a governable surface. `finish` returns the
// agent's final output; denying it cannot prevent anything that has not
// already happened, and would leave the session unable to terminate.
const IGNORED_TOOLS = new Set([
  'finish',
]);

/**
 * True when `toolName` is not one of the documented built-ins, judged by name
 * alone. Callers use this to decide whether a tool response is a third-party
 * trust boundary worth scanning. Because Antigravity's MCP name shape is
 * unverified, "not a built-in" is the only signal available, which mirrors how
 * the OpenCode plugin has to work.
 */
function isMcpToolName(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) return false;
  const lower = toolName.toLowerCase();
  if (BUILTIN_TOOLS.has(lower) || IGNORED_TOOLS.has(lower)) return false;
  return true;
}

/**
 * Normalize a tool name into rule-lookup candidates, most-specific first.
 *
 * @param {string} toolName
 * @returns {string[]}
 */
function normalize(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) return [];
  const lower = toolName.toLowerCase();

  if (IGNORED_TOOLS.has(lower)) return [];
  if (BUILTIN_TOOLS.has(lower)) return [lower];

  // Claude-style bridge shape: mcp__<server>__<tool>. Checked first because
  // its prefix is unambiguous.
  if (lower.startsWith(PREFIX)) {
    const remainder = lower.slice(PREFIX.length);
    const sepIdx = remainder.indexOf(SEP);
    if (sepIdx === -1) return [];
    const server = remainder.slice(0, sepIdx);
    const tool = remainder.slice(sepIdx + SEP.length);
    if (server.length === 0 || tool.length === 0) return [];
    return dedupe([`${server}:${tool}`, tool]);
  }

  // Unprefixed server-qualified shapes. `<server>:<tool>` is the cloud
  // synced-rule convention, so it leads; the bare tool name and the literal
  // wire name follow so a local override written against either still fires.
  for (const sep of [SEP, '.', '-']) {
    const idx = lower.indexOf(sep);
    if (idx <= 0) continue;
    const server = lower.slice(0, idx);
    const tool = lower.slice(idx + sep.length);
    if (tool.length === 0) continue;
    return dedupe([`${server}:${tool}`, tool, lower]);
  }

  // Bare unrecognised token. Kept as a candidate rather than dropped: a
  // prefix-less MCP tool is indistinguishable from a built-in we have not
  // catalogued, and the cost of a stray cloud rule matching it is far lower
  // than the cost of every MCP call going unaudited.
  return [lower];
}

function dedupe(arr) {
  return [...new Set(arr)];
}

module.exports = { normalize, isMcpToolName, BUILTIN_TOOLS, IGNORED_TOOLS };
