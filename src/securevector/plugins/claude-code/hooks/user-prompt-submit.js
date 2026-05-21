#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * UserPromptSubmit hook for SecureVector Guard.
 *
 * Claude Code fires this hook BEFORE the user's prompt reaches the
 * model. The payload is JSON on stdin shaped roughly:
 *   { "prompt": "...", "session_id": "...", ... }
 *
 * Without this hook, the plugin only sees TOOL inputs (Pre/PostToolUse)
 * — meaning prompt-injection attempts in chat ("ignore previous
 * instructions and …") never reach the rule engine. With it, the
 * incoming prompt is redacted (secrets) and POSTed fire-and-forget to
 * `/analyze`. The endpoint runs the prompt-injection / jailbreak
 * rule packs and records matches to threat_intel_records, surfacing
 * automatically in the Threats UI.
 *
 * Fail-open: this hook ALWAYS exits 0 and never blocks the prompt.
 * Threats are recorded post-hoc; enforcement is the user's call on
 * the Threats UI / Tool Permissions surface, not in-line at submit
 * time. (Blocking inline would mean every offline / slow-network
 * dev sees their prompts hang on the analyzer — unacceptable UX for
 * a defense-in-depth layer.)
 *
 * Zero npm deps. Native Node 18+.
 */

'use strict';

const { redactForScan } = require('../lib/redact.js');

const DEFAULT_BASE_URL = 'http://127.0.0.1:8741';
const RUNTIME_KIND = 'claude-code';
const SCAN_TEXT_LIMIT = 8000; // bytes, matches PostToolUse cap
const SESSION_ID_MAX = 128;

/**
 * Sanitise an incoming session_id before forwarding to /analyze
 * metadata. Clamps length and strips control chars to prevent log
 * injection in any future structured-log sink. Returns undefined for
 * non-strings.
 */
function safeSessionId(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  // Strip C0 controls + DEL, then clamp length.
  return value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, SESSION_ID_MAX) || undefined;
}

async function readAllStdin() {
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

/**
 * Fire-and-forget POST. We deliberately don't `await` the fetch so a
 * slow / down /analyze backend never blocks prompt submission. Errors
 * are swallowed — fail-open is the only correct posture here.
 */
function postJsonAndForget(url, body) {
  try {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => { /* swallow */ });
  } catch { /* swallow */ }
}

async function main() {
  let event = {};
  try {
    const raw = await readAllStdin();
    event = raw ? JSON.parse(raw) : {};
  } catch {
    return; // malformed stdin — exit silently, never block
  }

  const prompt = typeof event.prompt === 'string' ? event.prompt : '';
  if (prompt.length === 0) return;

  const redacted = redactForScan(prompt);
  const text = redacted.length > SCAN_TEXT_LIMIT ? redacted.slice(0, SCAN_TEXT_LIMIT) : redacted;
  if (text.length === 0) return;

  const baseUrl = process.env.SV_BASE_URL || DEFAULT_BASE_URL;
  postJsonAndForget(`${baseUrl}/analyze`, {
    text,
    source: 'claude-code-plugin',
    // Direction is `incoming` — this is content arriving from the
    // user, distinct from PostToolUse scans where direction='outgoing'
    // (content the agent is about to emit / execute).
    direction: 'incoming',
    metadata: {
      runtime_kind: RUNTIME_KIND,
      event: 'UserPromptSubmit',
      session_id: safeSessionId(event.session_id),
    },
  });
}

if (require.main === module) {
  main();
}

module.exports = { redactForScan };
