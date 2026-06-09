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
 * MCP tools: the exact on-the-wire `toolName` format for an MCP server tool
 * is NOT documented by GitHub and was not captured in the 1.0.60 smoke test
 * (no MCP server was configured). We keep the conventional `mcp__server__tool`
 * handling so MCP rules work IF Copilot uses that shape — VERIFY against a
 * real MCP-configured Copilot session before relying on MCP-targeted rules.
 *
 * Examples
 *   bash                              → ['bash']
 *   BASH                              → ['bash']   (case-insensitive)
 *   mcp__server-slack__post_message   → ['server-slack:post_message', 'post_message']
 *   read (a Claude/Codex name)        → []  (unknown → fail-open allow)
 */

'use strict';

const PREFIX = 'mcp__';
const SEP = '__';

// Canonical Copilot CLI built-in tool names (lowercase). Copilot emits these
// lowercase on the hook payload, so we store + match lowercase. Erring toward
// the documented set is safe: a name Copilot never emits costs nothing; a
// missing name silently no-ops rules targeting it (the bug this fixes — the
// v4.6.0 dev build shipped Codex's tool list here by mistake, so every Copilot
// `bash`/`view`/etc. call failed the lookup and fail-opened).
const BUILTIN_TOOLS = new Set([
  'ask_user',
  'bash',
  'create',
  'edit',
  'glob',
  'grep',
  'powershell',
  'task',
  'view',
  'web_fetch',
]);

function normalize(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) return [];

  // MCP tool: mcp__<server>__<tool> (format pending empirical confirmation
  // for Copilot — see file header).
  if (toolName.startsWith(PREFIX)) {
    const remainder = toolName.slice(PREFIX.length);
    const sepIdx = remainder.indexOf(SEP);
    if (sepIdx === -1) return [];
    const server = remainder.slice(0, sepIdx);
    const tool = remainder.slice(sepIdx + SEP.length);
    if (server.length === 0 || tool.length === 0) return [];
    return [`${server}:${tool}`, tool];
  }

  // Built-in tool — case-insensitive match. Returns the canonical lowercase
  // name as the single candidate; the synced-rule lookup downstream is also
  // case-insensitive, so a cloud rule authored as `tool_id="Bash"` still
  // matches the `bash` candidate.
  const lower = toolName.toLowerCase();
  if (BUILTIN_TOOLS.has(lower)) return [lower];

  // Unknown tool name — fail-open (hook short-circuits to allow).
  return [];
}

module.exports = { normalize, BUILTIN_TOOLS };
