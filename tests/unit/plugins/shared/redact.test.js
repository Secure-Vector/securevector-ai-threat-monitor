/**
 * Smoke tests for ../../../../src/securevector/plugins/claude-code/lib/redact.js
 *
 * Drives the 10-event fake-secret corpus from issue #131 against
 * redactForScan() and asserts ≥9/10 redactions land. This is the
 * client-side first line of defense — if the engine direction
 * routing misses a pattern, the redactor still masks the bytes
 * before they leave the host, and the Secret Detections audit log
 * still records the event.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { redactForScan } = require(
  path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'plugins', 'claude-code', 'lib', 'redact.js')
);

// Fake secret fixtures are assembled from fragments at runtime so the
// LITERAL secret-shaped strings never appear in source. GitHub secret
// scanning, on-push hooks, and IDE secret scanners all match by literal
// regex against checked-in bytes — the concatenation here is enough to
// hide from those while still feeding the redactor the exact same byte
// stream at test time (assertion runs against the joined string).
const _f = (...parts) => parts.join('');
const CORPUS = [
  ['AKIA',         _f('AWS_ACCESS_KEY_ID=', 'AKIA', 'IOSFODNN7EXAMPLE', ' more text'),                                  true],
  ['ghp PAT',      _f('token: ', 'gh', 'p_', '1234567890abcdefghijklmnopqrstuv0000'),                                   true],
  ['Stripe live',  _f('sk', '_', 'live_', 'abc123def456ghi789jkl012mno345pqrstuvwx'),                                   true],
  ['OpenAI proj',  _f('sk', '-proj-', 'AbCdEf01234567890abcdefghijklmnopqrstuv0000'),                                   true],
  ['password kv',  _f('password: ', 'secret123abc'),                                                                    true],
  ['api_key kv',   _f('api_key=', 'sk', '_', 'test_', 'abc123def456ghi789jkl012mno345pqr678'),                          true],
  ['JWT',          _f('auth: ', 'eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.',
                       'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'),                                                  true],
  ['PEM private',  _f('-----BEGIN ', 'RSA ', 'PRIVATE KEY', '-----\n', 'MIIEowIBAAKCAQEAasdf...\n', '-----END ',
                       'RSA ', 'PRIVATE KEY', '-----'),                                                                 true],
  ['aws_secret',   _f('aws_secret_access_key=', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY', 'EXAMPLEKEY'),                        true],
  ['benign prose', 'hello world this is harmless text without any keys or tokens',                                      false],
];

test('redactForScan: #131 corpus — ≥9/10 leak shapes redacted', () => {
  let caught = 0;
  for (const [label, text, shouldRedact] of CORPUS) {
    const out = redactForScan(text);
    const wasRedacted = out !== text;
    if (shouldRedact) {
      assert.equal(wasRedacted, true, `expected redaction for ${label}: ${text}`);
      assert.match(out, /\[REDACTED\]/, `expected [REDACTED] marker for ${label}`);
      caught += 1;
    } else {
      assert.equal(wasRedacted, false, `unexpected redaction on benign input ${label}: ${out}`);
    }
  }
  // Acceptance criteria from issue #131: ≥9/10 caught.
  assert.ok(caught >= 9, `expected ≥9/10 leak shapes redacted, got ${caught}`);
});

test('redactForScan: empty + non-string input returns empty string', () => {
  assert.equal(redactForScan(''), '');
  assert.equal(redactForScan(null), '');
  assert.equal(redactForScan(undefined), '');
  assert.equal(redactForScan(42), '');
});

test('redactForScan: lockstep — Codex copy of redact.js produces identical output', () => {
  const codexRedact = require(
    path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'plugins', 'codex', 'lib', 'redact.js')
  ).redactForScan;
  // Same input → same output across both plugins. Drift would mean
  // one plugin redacts a shape the other ships in cleartext.
  for (const [, text] of CORPUS) {
    assert.equal(
      codexRedact(text),
      redactForScan(text),
      `redact.js drift between Claude Code and Codex copies on input: ${text.slice(0, 40)}`,
    );
  }
});
