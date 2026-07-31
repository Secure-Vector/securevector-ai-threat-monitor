#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * beforeShellExecution hook for the SecureVector Guard plugin (Cursor).
 *
 * Cursor fires this before the agent runs a terminal command. stdin:
 *   { command, cwd, sandbox, conversation_id, generation_id, ... }
 * stdout: { permission: "allow"|"deny"|"ask", user_message?, agent_message? }
 *
 * There is no tool name on this event — the event type IS the tool — so the
 * decision runs against the synthesized 'shell' tool id. A synced rule with
 * tool_id "shell" (effect deny/prompt) therefore governs every terminal
 * command the Cursor agent attempts.
 *
 * Fail-open (locked decision #5): any error path emits an explicit allow and
 * exits 0. Cursor's own default is fail-open too (exit ≠ 0/2 proceeds), so
 * the two layers agree — a down SecureVector app can never block Cursor.
 */

'use strict';

const { normalize } = require('../lib/normalize.js');
const {
  decideForCandidates, maybeFileJitRequest, toCursorOutput, auditDecision,
  sessionIdFrom, readAllStdin, DEFAULT_BASE_URL,
} = require('../lib/decide.js');

const TOOL_NAME = 'shell';

async function main() {
  // FAIL-OPEN GUARD: the entire body is wrapped so ANY unexpected error
  // still prints an explicit allow and exits 0.
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
    const baseUrl = process.env.SECUREVECTOR_ENGINE_ENDPOINT || process.env.SV_BASE_URL || DEFAULT_BASE_URL;
    const sessionId = sessionIdFrom(event);
    let decision = { decision: 'allow' };
    try {
      decision = await decideForCandidates(normalize(TOOL_NAME), baseUrl, sessionId);
    } catch {
      decision = { decision: 'allow' };
    }
    auditDecision(baseUrl, TOOL_NAME, event && event.command, decision, sessionId);
    decision = maybeFileJitRequest(baseUrl, TOOL_NAME, decision, sessionId);
    out = toCursorOutput(decision);
  } catch {
    out = { permission: 'allow' };
  }
  process.stdout.write(JSON.stringify(out));
}

if (require.main === module) {
  main();
}

module.exports = { TOOL_NAME };
