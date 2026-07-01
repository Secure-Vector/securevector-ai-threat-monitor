#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * UserPromptSubmit hook for SecureVector Guard.
 *
 * Codex fires this hook BEFORE the user's prompt reaches the
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
const { postJsonAndForget } = require('../lib/client.js');

const DEFAULT_BASE_URL = 'http://127.0.0.1:8741';
const RUNTIME_KIND = 'codex';
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

  // Send RAW text to /analyze — the server's redact_secrets() is the
  // single source of truth for redaction AND owns the Secret Detections
  // audit log. Pre-redacting on the client would erase the credential
  // shape (e.g. `sk_live_…` → `sk_live_****`) before any pattern can
  // match, which is the root cause of issue #131's prompt-path coverage
  // gap. Same posture as post-tool-use.js. The endpoint is loopback
  // (127.0.0.1) and the server hashes immediately, never persisting
  // the raw value.
  const text = prompt.length > SCAN_TEXT_LIMIT ? prompt.slice(0, SCAN_TEXT_LIMIT) : prompt;
  if (text.length === 0) return;

  const baseUrl = process.env.SECUREVECTOR_ENGINE_ENDPOINT || process.env.SV_BASE_URL || DEFAULT_BASE_URL;
  postJsonAndForget(`${baseUrl}/analyze`, {
    text,
    source: 'codex-plugin',
    // Direction is `outgoing` — convention is: outgoing = content the
    // user / agent emits (prompts, tool inputs); incoming = content
    // arriving from a tool (tool responses). User prompts ARE outgoing
    // under that semantic. Issue #131 fixed the inverted tag here: the
    // UI's `direction=outgoing` filter now correctly surfaces leaked
    // credentials in user prompts. Engine-side IDPI / prompt-injection
    // rules fire on either direction; this hook stays fail-open.
    direction: 'outgoing',
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
