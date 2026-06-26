#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * beforeMCPExecution hook for the SecureVector Guard plugin (Cursor).
 *
 * Cursor fires this before the agent calls an MCP tool. stdin:
 *   { tool_name, tool_input (JSON string), url? | command?, conversation_id, ... }
 * stdout: { permission: "allow"|"deny"|"ask", user_message?, agent_message? }
 *
 * The MCP server is identified by its transport (`url` for HTTP servers,
 * `command` for stdio servers), not embedded in the tool name — so a server
 * slug is derived from whichever is present and folded into the rule-lookup
 * candidates (`<server>:<tool>`, server-wide block). ⚠️ Empirical payload
 * verification against a live Cursor build is still owed (idea-page open
 * question #1); the candidate set is deliberately broad until then.
 *
 * Fail-open (locked decision #5): every error path emits an explicit allow.
 */

'use strict';

const { normalize } = require('../lib/normalize.js');
const {
  decideForCandidates, toCursorOutput, auditDecision, sessionIdFrom,
  readAllStdin, DEFAULT_BASE_URL,
} = require('../lib/decide.js');

/**
 * Derive a rule-friendly server slug from the MCP transport. Examples:
 *   url "https://mcp.linear.app/sse"      → "mcp.linear.app"
 *   command "npx -y @upstash/context7"    → "context7" (last path-ish token)
 * Best-effort only — a null slug just means no server-wide candidates.
 */
function serverSlugFrom(event) {
  if (!event || typeof event !== 'object') return null;
  if (typeof event.url === 'string' && event.url.length > 0) {
    try { return new URL(event.url).hostname.toLowerCase() || null; } catch { return null; }
  }
  if (typeof event.command === 'string' && event.command.length > 0) {
    // The program/package is the FIRST token that is neither a runner
    // (npx/uvx/node/...) nor a flag — taking the LAST token would grab a
    // flag's value ("--port 1234" → "1234").
    const RUNNERS = new Set(['npx', 'uvx', 'bunx', 'node', 'deno', 'python', 'python3', 'uv', 'pipx']);
    const tokens = event.command.trim().split(/\s+/);
    let program = '';
    for (const t of tokens) {
      if (t.startsWith('-')) continue;
      if (RUNNERS.has(t.split('/').pop() || t)) continue;
      program = t;
      break;
    }
    const base = (program.split('/').pop() || '').replace(/\.(js|mjs|py|ts)$/i, '');
    const slug = base.replace(/^@/, '').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
    return slug.length > 0 ? slug : null;
  }
  return null;
}

async function main() {
  // FAIL-OPEN GUARD: any unexpected error prints an explicit allow, exit 0.
  let out = { permission: 'allow' };
  try {
    let event = {};
    try {
      const raw = await readAllStdin();
      event = raw ? JSON.parse(raw) : {};
    } catch {
      process.stdout.write(JSON.stringify(out));
      return;
    }
    const toolName = (event && (event.tool_name || event.toolName)) || '';
    const baseUrl = process.env.SECUREVECTOR_ENGINE_ENDPOINT || process.env.SV_BASE_URL || DEFAULT_BASE_URL;
    let decision = { decision: 'allow' };
    try {
      const candidates = normalize(toolName, {
        fromMcpEvent: true,
        serverSlug: serverSlugFrom(event),
      });
      decision = await decideForCandidates(candidates, baseUrl);
    } catch {
      decision = { decision: 'allow' };
    }
    auditDecision(baseUrl, toolName, event && event.tool_input, decision, sessionIdFrom(event));
    out = toCursorOutput(decision);
  } catch {
    out = { permission: 'allow' };
  }
  process.stdout.write(JSON.stringify(out));
}

if (require.main === module) {
  main();
}

module.exports = { serverSlugFrom };
