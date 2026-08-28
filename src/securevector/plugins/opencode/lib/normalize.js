// SPDX-License-Identifier: Apache-2.0
/**
 * Tool-name normalisation for the Guard plugin (OpenCode variant).
 *
 * OpenCode's tool surface is LOWERCASE single tokens, verified against the
 * tool registry in `packages/opencode/src/tool/` at opencode 1.18.23
 * (anomalyco/opencode). Each tool is declared with `Tool.define("<id>", …)`
 * and the registry exposes exactly those ids to the model.
 *
 * ⚠️  THE SHELL TOOL IS NAMED `bash`, NOT `shell`. `src/tool/shell/id.ts`
 * pins `export const ToolID = "bash"` with the comment "Keep the exposed tool
 * ID and permission key as 'bash' for compatibility … Rename with opencode
 * 2.0." So the file is shell.ts but the governable name is `bash` — and that
 * will change in a future major. Re-verify on upgrade.
 *
 * ⚠️  MCP TOOLS CARRY NO PREFIX — the hard difference from every sibling.
 * `src/mcp/catalog.ts` builds an MCP tool name as:
 *
 *     export const sanitize = (value) => value.replace(/[^a-zA-Z0-9_-]/g, "_")
 *     export const toolName = (clientName, name) => sanitize(clientName) + "_" + sanitize(name)
 *
 * i.e. `<server>_<tool>` joined by a SINGLE UNDERSCORE, with no `mcp` marker
 * of any kind. That means:
 *   - Claude Code's `mcp__server__tool` test matches NOTHING here.
 *   - Copilot's `<server>-<tool>` hyphen test matches NOTHING here.
 *   - There is NO way to tell an MCP tool from a built-in by name alone;
 *     the only reliable discriminator is "not in the built-in set".
 * Hence BUILTIN_TOOLS below is load-bearing for MCP detection, not just for
 * rule lookup — an omission here silently reclassifies a built-in as an MCP
 * tool (and vice versa).
 *
 * KNOWN AMBIGUITY (inherent to OpenCode's naming, not something we can fix):
 * built-in ids `apply_patch` and `todowrite` already contain/could collide
 * with the `<server>_<tool>` shape. An MCP server literally named `apply`
 * exposing a tool named `patch` produces `apply_patch`, indistinguishable
 * from the built-in. We resolve to the BUILT-IN (checked first), which is the
 * safe direction: the tool stays governable under a stable, documented id.
 *
 * For a non-built-in we emit candidates covering both the local and cloud rule
 * conventions, most-specific first (the lookup is first-seen-wins):
 *   1. the literal OpenCode name          `github_create_issue`
 *   2. cloud `<server>:<tool>` form       `github:create_issue`
 *   3. the bare tool name                 `create_issue`
 *   4. progressive server-prefixes        `github`  (server-wide block)
 * (2)/(3) split on the FIRST underscore; (1)/(4) cover servers whose own name
 * contains an underscore.
 *
 * Examples
 *   bash                     → ['bash']
 *   BASH                     → ['bash']                       (case-insensitive)
 *   apply_patch              → ['apply_patch']                (built-in wins)
 *   github_create_issue      → ['github_create_issue', 'github:create_issue',
 *                               'create_issue', 'github_create', 'github']
 *   mcp__slack__post_message → ['slack:post_message', 'post_message']  (defensive)
 *   someunknowntool          → []                             (skip / fail-open)
 */

'use strict';

const PREFIX = 'mcp__';
const SEP = '__';

// Canonical OpenCode built-in tool ids (lowercase), read from the `Tool.define`
// call in each `packages/opencode/src/tool/*.ts` at opencode 1.18.23. KEEP IN
// LOCKSTEP with the Python OPENCODE_BUILTINS table (enforced by
// tests/unit/app/test_tool_permissions_builtins.py).
//
// This set doubles as the MCP discriminator (see header), so it must stay
// complete: a missing built-in is not merely an unmatched rule, it is a
// built-in silently treated as a third-party MCP tool.
const BUILTIN_TOOLS = new Set([
  // Shell execution. Exposed as `bash` even though the module is shell.ts.
  'bash',
  // Filesystem
  'read',
  'write',
  'edit',
  'apply_patch',
  'glob',
  'grep',
  // Network / search
  'webfetch',
  'websearch',
  // Agents / skills / planning
  'task',
  'skill',
  'todowrite',
  'question',
  // Experimental / flag-gated. Present only when the corresponding runtime
  // flag is on, but harmless to govern unconditionally: a name OpenCode never
  // emits simply never matches.
  'lsp',
  'plan_exit',
  'execute',
]);

/**
 * True when `toolName` is an MCP server tool.
 *
 * OpenCode gives MCP tools no prefix (see header), so this is a pure
 * negative test: anything that is not a known built-in and carries the
 * `<server>_<tool>` underscore shape is MCP. Used by index.js to decide
 * whether to threat-scan the tool RESPONSE (MCP tools return untrusted
 * third-party data, like webfetch/read).
 */
function isMcpToolName(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) return false;
  if (toolName.startsWith(PREFIX)) return true;
  if (BUILTIN_TOOLS.has(toolName.toLowerCase())) return false;
  return toolName.includes('_');
}

function normalize(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) return [];

  // Built-in tool — case-insensitive match, checked FIRST so an underscored
  // built-in (apply_patch, todowrite, plan_exit) is never mistaken for an MCP
  // tool. Returns the canonical lowercase id; the synced-rule lookup
  // downstream is also case-insensitive, so a cloud rule authored as
  // `tool_id="Bash"` still matches the `bash` candidate.
  const lower = toolName.toLowerCase();
  if (BUILTIN_TOOLS.has(lower)) return [lower];

  // Claude-style MCP: mcp__<server>__<tool>. Defensive — OpenCode doesn't
  // emit this, but keep it working for any bridge that does.
  if (toolName.startsWith(PREFIX)) {
    const remainder = toolName.slice(PREFIX.length);
    const sepIdx = remainder.indexOf(SEP);
    if (sepIdx === -1) return [];
    const server = remainder.slice(0, sepIdx);
    const tool = remainder.slice(sepIdx + SEP.length);
    if (server.length === 0 || tool.length === 0) return [];
    return [`${server}:${tool}`, tool];
  }

  // OpenCode MCP: <server>_<tool>.
  if (toolName.includes('_')) {
    const candidates = [toolName];
    const us = toolName.indexOf('_');
    const server = toolName.slice(0, us);
    const tool = toolName.slice(us + 1);
    if (server.length > 0 && tool.length > 0) {
      candidates.push(`${server}:${tool}`, tool);
    }
    // progressive server-prefixes (longest already added as the literal name)
    const segs = toolName.split('_');
    for (let i = segs.length - 1; i >= 1; i--) {
      candidates.push(segs.slice(0, i).join('_'));
    }
    return [...new Set(candidates)];
  }

  // Unknown single-token name with no underscore — cannot be an MCP tool
  // (OpenCode always joins server+tool with one) and is not a known built-in,
  // so it is internal plumbing or a tool from a newer OpenCode than this
  // built-in table. Skip it (fail-open, not audited).
  return [];
}

export { normalize, isMcpToolName, BUILTIN_TOOLS };
