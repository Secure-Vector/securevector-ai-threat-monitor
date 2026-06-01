/**
 * Tool-name normalisation for the Guard plugin (Codex variant).
 *
 * Codex's tool surface is *completely different* from Claude Code's: there
 * is no `Read`/`Edit`/`Write`/`Bash` etc. Every file read, file write, and
 * shell command flows through a single `exec_command` tool. The LLM also
 * emits `apply_patch` (diff-based file mutation), `update_plan` (todo
 * list), `view_image`, `web_search`, and a handful of MCP/orchestration
 * tools. The canonical list lives in `codex-rs/core/src/tools/handlers/`
 * — every `name: "<tool>"` definition there.
 *
 * Examples
 *   mcp__server-slack__slack_post_message
 *     → ['server-slack:slack_post_message', 'slack_post_message']
 *   exec_command
 *     → ['exec_command']
 *   Bash (a Claude Code name, not a Codex tool)
 *     → []  (unknown → fail-open allow)
 */

'use strict';

const PREFIX = 'mcp__';
const SEP = '__';

// Canonical list of Codex hook-payload tool names. CRITICAL distinction
// from the model-layer function_call.name: Codex's hook engine
// translates a few tool names before invoking PreToolUse / PostToolUse.
// The mapping is defined in `codex-rs/core/src/tools/hook_names.rs`:
//
//   exec_command  + shell_command   → "Bash"          (HookToolName::bash())
//   apply_patch                     → "apply_patch"   (canonical; matcher aliases: Write, Edit)
//   spawn_agent                     → "spawn_agent"   (canonical; matcher alias: Agent)
//   everything else                 → passthrough     (HookToolName::new(name))
//
// Empirical confirmation: instrumented the hook to log stdin and saw
//   `tool_name: "Bash"`  carrying  `tool_input: {"command": "ls /tmp"}`
// when the LLM emitted a `function_call` with name=exec_command.
//
// So this Set lists the HOOK-PAYLOAD names that show up on stdin —
// what synced/local rules with `tool_id="..."` must match against.
//
// Erring toward completeness is safe: an entry Codex never emits in
// a session costs nothing; a missing entry silently no-ops cloud
// rules targeting it (the bug we're avoiding).
//
// NOTE: the Set is exported for test introspection only. Callers MUST
// NOT mutate it at runtime — `normalize()` reads the live reference,
// so a mutation would silently change enforcement for the rest of the
// process.
const BUILTIN_TOOLS = new Set([
  // Shell + I/O — hook payload sends "Bash" for `exec_command` +
  // `shell_command` via HookToolName::bash(). This is the single most
  // load-bearing entry in the set; without it, every Codex shell call
  // (which is most calls) fails the candidate lookup and fail-opens.
  'Bash',
  // File mutation — apply_patch is the canonical hook payload name.
  // `Write` and `Edit` are matcher aliases at the hook engine layer,
  // but the canonical name on stdin is `apply_patch`.
  'apply_patch',
  // Planning + UI
  'update_plan',
  'view_image',
  'web_search',
  // User interaction
  'request_permissions',
  'request_user_input',
  // MCP discovery + read
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  // Plugin lifecycle
  'list_available_plugins_to_install',
  'request_plugin_install',
  // Documentation lookup
  'docs',
  // Multi-agent orchestration (Codex's "agent jobs" subsystem)
  'spawn_agent',
  'spawn_agents_on_csv',
  'wait_agent',
  'close_agent',
  'resume_agent',
  'list_agents',
  'send_input',
  'send_message',
  'followup_task',
  'report_agent_job_result',
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
