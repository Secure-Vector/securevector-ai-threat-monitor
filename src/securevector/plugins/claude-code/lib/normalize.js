// SPDX-License-Identifier: Apache-2.0
/**
 * Tool-name normalisation for the Guard plugin.
 *
 * Tool calls inside the host CLI surface as `mcp__<server>__<tool>` for MCP
 * tools, or as PascalCase bare names like `Bash` / `Edit` for built-ins.
 * The local app's synced-rule table keys are either `<server>:<tool>`,
 * bare `<tool>`, or the built-in's bare name, so this helper produces the
 * candidate lookup keys the host's tool name maps to.
 *
 * Examples
 *   mcp__server-slack__slack_post_message
 *     → ['server-slack:slack_post_message', 'slack_post_message']
 *   Bash
 *     → ['Bash']
 *   foo (unknown)
 *     → []
 */

'use strict';

const PREFIX = 'mcp__';
const SEP = '__';

// Canonical list of Claude Code built-in tool names that callers may
// want to govern with synced rules. Kept as a hard-coded allow-list so
// an unknown tool name short-circuits to fail-open rather than getting
// caught by a stray cloud rule with the same string.
//
// Erring toward completeness is safe: an entry that Claude Code never
// emits costs nothing (the hook event simply never carries that name);
// a missing entry silently no-ops cloud rules targeting it, which is
// the bug we're avoiding. Includes legacy names (Task, TodoRead,
// NotebookRead) for forward/backward compatibility with older CC
// versions.
//
// NOTE: the Set is exported for test introspection only. Callers MUST
// NOT mutate it at runtime — `normalize()` reads the live reference,
// so a mutation would silently change enforcement for the rest of the
// process.
const BUILTIN_TOOLS = new Set([
  // File operations
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
  // Search / navigation
  'Glob',
  'Grep',
  'LS',
  'LSP',
  // Shell
  'Bash',
  'PowerShell',
  // Web
  'WebFetch',
  'WebSearch',
  // Agents / planning
  'Task',
  'Agent',
  'ExitPlanMode',
  'EnterPlanMode',
  // Worktrees
  'EnterWorktree',
  'ExitWorktree',
  // Skills
  'Skill',
  // Background processes
  'Monitor',
  // Todos
  'TodoWrite',
  'TodoRead',
]);

function normalize(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) return [];

  // MCP tool: mcp__<server>__<tool>
  if (toolName.startsWith(PREFIX)) {
    const remainder = toolName.slice(PREFIX.length);
    const sepIdx = remainder.indexOf(SEP);
    if (sepIdx === -1) return [];
    const server = remainder.slice(0, sepIdx);
    const tool = remainder.slice(sepIdx + SEP.length);
    if (server.length === 0 || tool.length === 0) return [];
    return [`${server}:${tool}`, tool];
  }

  // Built-in tool: bare PascalCase name. Returns the name itself as a
  // single candidate so the standard synced-rule lookup path applies
  // (cloud emits `tool_id="Bash"` etc.); no further plumbing needed in
  // the hook handlers.
  if (BUILTIN_TOOLS.has(toolName)) return [toolName];

  // Unknown tool name — fail-open by returning empty (hook short-circuits
  // to allow without contacting the local app).
  return [];
}

module.exports = { normalize, BUILTIN_TOOLS };
