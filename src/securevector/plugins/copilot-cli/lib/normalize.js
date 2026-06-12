// SPDX-License-Identifier: Apache-2.0
/**
 * Tool-name normalisation for the Guard plugin (GitHub Copilot CLI variant).
 *
 * Copilot's tool surface differs from both Claude Code and Codex. Its
 * built-in tools are LOWERCASE single words, confirmed empirically against
 * Copilot CLI 1.0.60 — a `postToolUse` payload for a shell command carries
 * `toolName: "bash"` (NOT "Bash"/"exec_command"). The documented built-in
 * set (docs.github.com/.../hooks-configuration) is:
 *
 *   ask_user, bash, create, edit, glob, grep, powershell, task, view, web_fetch
 *
 * MCP tools: Copilot names an MCP server tool `<server>-<tool>` (a single
 * hyphen joining the configured server name and the registered tool name).
 * CONFIRMED empirically against Copilot CLI 1.0.60 — an MCP server configured
 * as `everything` exposing `echo` arrives at the hook as
 * `toolName: "everything-echo"` (the debug log shows `Adding tool:
 * everything-echo`, the model calls `name: "everything-echo"`, and the
 * preToolUse hook fires on it). This is NOT Claude Code's `mcp__server__tool`
 * double-underscore shape.
 *
 * For a hyphenated (non-built-in) name we emit progressive hyphen-prefix
 * candidates, LONGEST FIRST, so a synced rule can target either the exact
 * tool (`everything-echo`) or the whole server (`everything`) — mirroring
 * Copilot's own `<server>(tool?)` permission model. Longest-first ordering
 * makes a tool-specific override win over a server-wide one. The Claude-style
 * `mcp__server__tool` shape is still handled defensively (harmless; Copilot
 * doesn't emit it, but a future bridge might).
 *
 * A non-built-in name WITHOUT a hyphen (Copilot's internal bookkeeping tools
 * such as the intent/SQL/todo helpers) returns [] → the hook skips it (not
 * audited, fail-open). That keeps the audit trail to governable surface —
 * built-ins + MCP tools — instead of internal agent plumbing.
 *
 * Examples
 *   bash                              → ['bash']
 *   BASH                              → ['bash']            (case-insensitive)
 *   everything-echo                   → ['everything-echo', 'everything']
 *   everything-get-sum                → ['everything-get-sum', 'everything-get', 'everything']
 *   mcp__slack__post_message          → ['slack:post_message', 'post_message']  (defensive)
 *   intent (internal, no hyphen)      → []  (skip / fail-open)
 */

'use strict';

const PREFIX = 'mcp__';
const SEP = '__';

// Canonical Copilot CLI built-in tool names (lowercase). Copilot emits these
// lowercase on the hook payload, so we store + match lowercase. KEEP IN
// LOCKSTEP with the Python COPILOT_CLI_BUILTINS table (enforced by
// tests/unit/app/test_tool_permissions_builtins.py). Erring toward the
// documented set is safe: a name Copilot never emits costs nothing; a missing
// name silently no-ops rules targeting it (the bug an earlier dev build hit —
// it shipped Codex's tool list here by mistake, so every Copilot `bash`/`view`
// call failed the lookup and fail-opened).
const BUILTIN_TOOLS = new Set([
  // Shell execution + background-session management. Blocking only `bash`
  // would leave write_bash/stop_bash open, so the whole family is governable.
  'bash',
  'write_bash',
  'stop_bash',
  'read_bash',
  'list_bash',
  'powershell',
  // Filesystem
  'view',
  'edit',
  'create',
  'glob',
  'grep',
  // Network / data
  'web_fetch',
  'sql',
  'session_store_sql',
  // Agents / skills
  'task',
  'skill',
  'list_agents',
  'read_agent',
  // Misc. `report_intent` is deliberately omitted (cosmetic UI bookkeeping —
  // returns [] below, never audited/enforced).
  'fetch_copilot_cli_documentation',
  'ask_user',
]);

/**
 * True when `toolName` is an MCP server tool (Copilot `<server>-<tool>` shape,
 * or the defensive Claude `mcp__…` shape). A built-in is never MCP. Used by
 * post-tool-use.js to decide whether to threat-scan the tool RESPONSE (MCP
 * tools return untrusted external data, like web_fetch/view).
 */
function isMcpToolName(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) return false;
  if (toolName.startsWith(PREFIX)) return true;
  if (BUILTIN_TOOLS.has(toolName.toLowerCase())) return false;
  return toolName.includes('-');
}

function normalize(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) return [];

  // Built-in tool — case-insensitive match. Checked FIRST so a (hypothetical)
  // hyphenated built-in is never mistaken for an MCP tool. Returns the
  // canonical lowercase name; the synced-rule lookup downstream is also
  // case-insensitive, so a cloud rule authored as `tool_id="Bash"` still
  // matches the `bash` candidate.
  const lower = toolName.toLowerCase();
  if (BUILTIN_TOOLS.has(lower)) return [lower];

  // Claude-style MCP: mcp__<server>__<tool>. Defensive — Copilot doesn't emit
  // this, but keep it working for any bridge that does.
  if (toolName.startsWith(PREFIX)) {
    const remainder = toolName.slice(PREFIX.length);
    const sepIdx = remainder.indexOf(SEP);
    if (sepIdx === -1) return [];
    const server = remainder.slice(0, sepIdx);
    const tool = remainder.slice(sepIdx + SEP.length);
    if (server.length === 0 || tool.length === 0) return [];
    return [`${server}:${tool}`, tool];
  }

  // Copilot MCP: <server>-<tool>. Emit candidates covering BOTH the local and
  // cloud rule conventions, most-specific first (pickMatch is first-seen-wins):
  //   1. the literal Copilot name           `everything-echo`   (local override by exact name)
  //   2. cloud `<server>:<tool>` form        `everything:echo`   (cloud synced rules compose this)
  //   3. the bare tool name                  `echo`              (synced-overrides aliases <server>:<tool> → bare)
  //   4. progressive server-prefixes         `everything`        (server-wide block)
  // (2)/(3) split on the FIRST hyphen (assumes the server name has no hyphen);
  // the literal + prefix forms in (1)/(4) cover the hyphenated-server case.
  if (toolName.includes('-')) {
    const candidates = [toolName];
    const dash = toolName.indexOf('-');
    const server = toolName.slice(0, dash);
    const tool = toolName.slice(dash + 1);
    if (server.length > 0 && tool.length > 0) {
      candidates.push(`${server}:${tool}`, tool);
    }
    // progressive server-prefixes (longest already added as the literal name)
    const segs = toolName.split('-');
    for (let i = segs.length - 1; i >= 1; i--) {
      candidates.push(segs.slice(0, i).join('-'));
    }
    return [...new Set(candidates)];
  }

  // Unknown single-token name — internal Copilot bookkeeping tool (intent,
  // sql, todo, …). Skip it (fail-open, not audited): not a governable surface.
  return [];
}

module.exports = { normalize, isMcpToolName, BUILTIN_TOOLS };
