/**
 * Source-assertion guard for the one-time 5.3.0 trace notice shown on
 * startup to upgraders. The app shell runs inside pywebview, so the
 * cheapest viable guard is asserting the source text.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(
  __dirname, '..', '..', '..', '..',
  'src', 'securevector', 'app', 'assets', 'web', 'js', 'app.js',
);

const src = fs.readFileSync(APP, 'utf8');

test('trace notice is versioned and shown once', () => {
  assert.match(src, /TRACE_NOTICE_VERSION: '5\.3\.0'/);
  assert.match(src, /TRACE_NOTICE_KEY: 'sv-trace-notice-acked'/);
  assert.match(src, /if \(acked === this\.TRACE_NOTICE_VERSION\) return;/);
});

test('trace notice targets upgraders only and lasts a few seconds', () => {
  assert.match(src, /if \(hasSeenGeneric\) this\.showTraceUpgradeNotice\(\);/);
  const ms = Number(src.match(/TRACE_NOTICE_MS: (\d+)/)[1]);
  assert.ok(ms >= 5000 && ms <= 15000, `duration ${ms}ms should be a few seconds`);
});

test('trace notice copy says reload the plugin and has no em dash', () => {
  const m = src.match(/message: '([^']*Reload your plugin[^']*)'/);
  assert.ok(m, 'notice copy should tell the user to reload the plugin');
  assert.match(m[1], /secrets redacted/);
  assert.doesNotMatch(m[1], /—/);
});
