/**
 * Source-assertion guard that keeps the retired 5.3.0 trace upgrade notice
 * out of the app shell without disturbing the generic first-launch welcome.
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

test('obsolete 5.3.0 trace upgrade notice stays retired', () => {
  assert.doesNotMatch(src, /SecureVector 5\.3\.0: Traces now keep the full tool input/);
  assert.doesNotMatch(src, /showTraceUpgradeNotice/);
  assert.doesNotMatch(src, /TRACE_NOTICE_VERSION/);
  assert.doesNotMatch(src, /TRACE_NOTICE_KEY/);
  assert.doesNotMatch(src, /sv-trace-notice-acked/);
});

test('generic first-launch welcome behavior remains intact', () => {
  assert.match(src, /this\.showFirstLaunchWelcome\(\);/);
  assert.match(src, /async showFirstLaunchWelcome\(\)/);
  assert.match(src, /const hasSeenGeneric = localStorage\.getItem\('sv-welcome-seen-v2'\);/);
  assert.match(src, /if \(!hasSeenGeneric\) this\.showWelcomeIfFirstLaunch\(\);/);
  assert.doesNotMatch(src, /if \(hasSeenGeneric\).*Toast\.show/s);
});
