// SPDX-License-Identifier: Apache-2.0
/**
 * Shared secret-redaction patterns + helper.
 *
 * Used by both post-tool-use.js (outbound tool inputs) and
 * user-prompt-submit.js (inbound user prompts) so the patterns
 * stay in lockstep — a leak surface added in one place must not
 * silently miss in the other.
 *
 * The patterns are conservative, covering the highest-blast-radius
 * leaks first. Loopback-only wire path today, but matches persist
 * to threat_intel_records so redaction failures are durable.
 */

'use strict';

const SECRET_PATTERNS = [
  /(?:sk|pk)-[A-Za-z0-9_-]{20,}/g,                                                            // OpenAI / Anthropic sk-/pk-
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                                                          // GitHub PAT / OAuth
  /\bAKIA[0-9A-Z]{16}\b/g,                                                                    // AWS Access Key ID
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,                           // JWT
  /(["']?(?:password|secret|token|api[_-]?key|bearer)["']?\s*[:=]\s*["']?)[^"'\s,}\]]{6,}/gi, // labelled kv-pairs
];

/**
 * Redact secrets in `text`. Returns '' for non-string / empty input.
 * `String.prototype.replace` with a /g regex resets `lastIndex`
 * internally per ECMA-262 §22.2.6.11, so calling this repeatedly in
 * the same Node process is safe — no manual reset required.
 */
function redactForScan(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  let out = text;
  for (const pat of SECRET_PATTERNS) {
    out = out.replace(pat, (m, prefix) => (prefix ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }
  return out;
}

module.exports = { SECRET_PATTERNS, redactForScan };
