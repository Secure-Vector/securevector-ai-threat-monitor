/**
 * MCP tool-name normalisation for the Guard plugin.
 *
 * Tool calls inside the host CLI surface as `mcp__<server>__<tool>` for MCP
 * tools, or as bare names like `Bash` / `Edit` for built-ins. The local app's
 * synced-rule table keys are either `<server>:<tool>` or bare `<tool>`, so
 * this helper produces both candidate lookup keys for an MCP name. Built-in
 * tools are deferred (locked decision #3 — built-in enforcement needs a
 * cloud-side catalogue change that is out of scope for v1) so they return
 * an empty array.
 *
 * Examples
 *   mcp__server-slack__slack_post_message
 *     → ['server-slack:slack_post_message', 'slack_post_message']
 *   Bash
 *     → []
 */

'use strict';

const PREFIX = 'mcp__';
const SEP = '__';

function normalize(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) return [];
  if (!toolName.startsWith(PREFIX)) return [];

  const remainder = toolName.slice(PREFIX.length);
  const sepIdx = remainder.indexOf(SEP);
  // No server-tool separator at all (e.g. "mcp__noserver", "mcp__").
  if (sepIdx === -1) return [];

  const server = remainder.slice(0, sepIdx);
  const tool = remainder.slice(sepIdx + SEP.length);
  // Reject empty server or empty tool segments.
  if (server.length === 0 || tool.length === 0) return [];

  return [`${server}:${tool}`, tool];
}

module.exports = { normalize };
