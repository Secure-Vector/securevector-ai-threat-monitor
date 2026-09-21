// SPDX-License-Identifier: Apache-2.0
// Optional bridge used only for Copilot CLI sessions launched by Agent Terminals.
// It deliberately bypasses the configurable engine endpoint: this per-task
// capability is valid only at the local app that minted its token.
// Copilot CLI has no turn-end hook, so this relay never sends a Stop event;
// the task's idle state comes from the app's own process-exit handling.
'use strict';

async function postTerminalEvent(event) {
  const taskId = process.env.SV_TERMINAL_TASK_ID;
  const token = process.env.SV_TERMINAL_HOOK_TOKEN;
  const port = process.env.SV_TERMINAL_PORT;
  if (!taskId || !token || !port) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/terminals/tasks/${encodeURIComponent(taskId)}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sv-terminal-hook': token },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    return Boolean(response && response.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { postTerminalEvent };
