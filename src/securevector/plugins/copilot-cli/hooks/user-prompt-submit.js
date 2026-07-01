#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * userPromptSubmitted hook for SecureVector Guard (GitHub Copilot CLI).
 *
 * Copilot fires this when the user submits a prompt. stdin (camelCase):
 *   { sessionId, timestamp, cwd, prompt }
 *
 * Copilot's userPromptSubmitted has NO stdout control mechanism — it
 * cannot block the prompt or inject context (per docs.github.com). That's
 * fine: we never block prompts anyway. We forward the prompt fire-and-forget
 * to /analyze for prompt-injection / jailbreak / credential-leak scanning;
 * detections surface post-hoc in the local Threats UI. Always exits 0.
 *
 * Caveat (documented): prompt hooks fire only for NEW interactive sessions —
 * they do NOT fire on resume. Resumed sessions are still covered by the
 * pre/postToolUse enforcement + audit path.
 *
 * Zero npm deps. Native Node 18+.
 */

'use strict';

const { postJsonAndForget } = require('../lib/client.js');

const DEFAULT_BASE_URL = 'http://127.0.0.1:8741';
const RUNTIME_KIND = 'copilot-cli';
const SOURCE = 'copilot-cli-plugin';
const SCAN_TEXT_LIMIT = 8000;
const SESSION_ID_MAX = 128;

function safeSessionId(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, SESSION_ID_MAX) || undefined;
}

async function readAllStdin() {
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

async function main() {
  let event = {};
  try {
    const raw = await readAllStdin();
    event = raw ? JSON.parse(raw) : {};
  } catch {
    return; // malformed stdin — exit silently
  }

  const prompt = typeof event.prompt === 'string' ? event.prompt : '';
  if (prompt.length === 0) return;

  // Send RAW text to /analyze — the server's redact_secrets() owns redaction
  // + the Secret Detections audit log. Loopback only (127.0.0.1); the server
  // hashes immediately and never persists the raw value.
  const text = prompt.length > SCAN_TEXT_LIMIT ? prompt.slice(0, SCAN_TEXT_LIMIT) : prompt;
  if (text.length === 0) return;

  const baseUrl = process.env.SECUREVECTOR_ENGINE_ENDPOINT || process.env.SV_BASE_URL || DEFAULT_BASE_URL;
  postJsonAndForget(`${baseUrl}/analyze`, {
    text,
    source: SOURCE,
    direction: 'outgoing', // user-emitted content (prompts) = outgoing
    metadata: {
      runtime_kind: RUNTIME_KIND,
      event: 'userPromptSubmitted',
      session_id: safeSessionId(event.sessionId || event.session_id),
    },
  });
  // No stdout control on this event — nothing to emit.
}

if (require.main === module) {
  main();
}

module.exports = { safeSessionId, RUNTIME_KIND };
