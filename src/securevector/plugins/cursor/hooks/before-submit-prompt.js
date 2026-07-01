#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * beforeSubmitPrompt hook for the SecureVector Guard plugin (Cursor).
 *
 * Fires when the user submits a prompt to the agent. stdin:
 *   { prompt, attachments: [{type, file_path}], conversation_id, ... }
 * stdout: { continue: boolean, user_message? }
 *
 * Direct parity with the Claude Code plugin's UserPromptSubmit: the raw
 * prompt goes fire-and-forget to /analyze for prompt-injection / jailbreak /
 * credential-leak scanning; detections surface post-hoc in the local Threats
 * UI. We NEVER block prompts (`continue: true` always) — scanning the
 * human's own words is observability, not enforcement.
 *
 * The raw text goes to the local app on loopback only; the server's
 * redact_secrets() owns redaction + hashes immediately, never persisting the
 * raw value.
 *
 * Always exits 0.
 */

'use strict';

const { postJsonAndForget } = require('../lib/client.js');
const { sessionIdFrom, readAllStdin, DEFAULT_BASE_URL } = require('../lib/decide.js');

const RUNTIME_KIND = 'cursor';
const SOURCE = 'cursor-plugin';
const SCAN_TEXT_LIMIT = 8000;

const CONTINUE = { continue: true };

async function main() {
  let event = {};
  try {
    const raw = await readAllStdin();
    event = raw ? JSON.parse(raw) : {};
  } catch {
    process.stdout.write(JSON.stringify(CONTINUE));
    return;
  }

  try {
    const prompt = typeof event.prompt === 'string' ? event.prompt : '';
    if (prompt.length > 0) {
      const baseUrl = process.env.SECUREVECTOR_ENGINE_ENDPOINT || process.env.SV_BASE_URL || DEFAULT_BASE_URL;
      postJsonAndForget(`${baseUrl}/analyze`, {
        text: prompt.slice(0, SCAN_TEXT_LIMIT),
        source: SOURCE,
        direction: 'outgoing', // user-emitted content (prompts) = outgoing
        session_id: sessionIdFrom(event) || undefined,
        metadata: {
          runtime_kind: RUNTIME_KIND,
          event: 'beforeSubmitPrompt',
        },
      });
    }
  } catch { /* swallow — scan is best-effort */ }

  process.stdout.write(JSON.stringify(CONTINUE));
}

if (require.main === module) {
  main();
}

module.exports = { RUNTIME_KIND, SCAN_TEXT_LIMIT };
