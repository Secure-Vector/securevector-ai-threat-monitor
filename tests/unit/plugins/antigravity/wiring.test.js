// Every place the Antigravity harness has to be registered, asserted from
// source.
//
// A guide page needs THREE registrations (index.html script tag, app.js route,
// sidebar alias) and an integration card needs THREE more (registry entry,
// render dispatch, card method). Miss any one and the failure is silent in the
// only way that matters: `node --check` passes, the unit suite passes, and the
// page 404s or throws in the browser. The Claude Code harness shipped exactly
// that bug once (registry entry and sidebar item added, app.js route missed),
// which is why spa_routes.test.js exists; this file extends the same idea to
// the guide half and to the install-route endpoints the card calls.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.resolve(__dirname, '..', '..', '..', '..',
  'src', 'securevector', 'app', 'assets', 'web');
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), 'utf8');

const integrations = read('js', 'pages', 'integrations.js');
const sidebar = read('js', 'components', 'sidebar.js');
const appJs = read('js', 'app.js');
const indexHtml = read('index.html');
const guide = read('js', 'pages', 'guide-antigravity.js');
const toolPerms = read('js', 'pages', 'tool-permissions.js');


test('the guide page is registered in all three places', () => {
  assert.match(indexHtml, /<script src="\/js\/pages\/guide-antigravity\.js\?v=\d+"><\/script>/,
    'index.html is missing the guide-antigravity.js script tag, so the page object is undefined');
  assert.match(appJs, /'guide-antigravity':\s*\{\s*render:\s*\(c\)\s*=>\s*GuideAntigravityPage\.render\(c\)\s*\}/,
    'app.js has no guide-antigravity route');
  assert.ok(sidebar.includes("'guide-antigravity'"),
    'sidebar.js does not alias guide-antigravity, so the nav row never highlights');
});

test('the guide page object name matches what app.js calls', () => {
  assert.match(guide, /const GuideAntigravityPage = \{/);
  assert.match(guide, /async render\(container\)/);
});

test('the integration card is registered in all three places', () => {
  assert.match(integrations, /'proxy-antigravity':\s*\{[\s\S]{0,300}?isAntigravity:\s*true/,
    'integrations.js registry has no proxy-antigravity entry');
  assert.match(integrations, /else if \(integration\.isAntigravity\)/,
    'render() never dispatches to the Antigravity card');
  assert.match(integrations, /createAntigravityPluginCard\(\) \{/,
    'the card builder is missing');
  assert.match(integrations, /const isPlugin = .*integration\.isAntigravity/,
    'isPlugin omits Antigravity, so the card would get proxy/block-mode UI it has no use for');
  assert.ok(appJs.includes("'proxy-antigravity'"), 'app.js has no proxy-antigravity route');
  assert.ok(sidebar.includes("'proxy-antigravity'"), 'sidebar.js does not alias proxy-antigravity');
});

test('the card calls the routes the Python module actually exposes', () => {
  for (const p of ['/api/hooks/antigravity/status',
                   '/api/hooks/antigravity/install',
                   '/api/hooks/antigravity/uninstall']) {
    assert.ok(integrations.includes(p), `card never calls ${p}`);
  }
  // The status field is harness-specific; reading `cursor_detected` here (the
  // easiest copy-paste slip) would leave the card permanently unsure whether
  // Antigravity is installed.
  assert.ok(integrations.includes('antigravity_detected'),
    'card reads the wrong host-detection field');
});

test('the sidebar banner has a cancellable, self-rescheduling poller', () => {
  assert.ok(sidebar.includes("id = 'antigravity-plugin-active-banner'"));
  assert.match(sidebar, /clearTimeout\(this\._antigravityPluginStatusTimer\);\s*\n\s*this\._antigravityPluginStatusTimer = setTimeout\(\(\) => this\.checkAntigravityPluginStatus\(\)/,
    'the poller must cancel its pending tick before booking the next');
  // Started in BOTH places: the post-attach init (pollers exit without
  // rescheduling when getElementById misses) and the visibilitychange handler.
  assert.equal((sidebar.match(/this\.checkAntigravityPluginStatus\(\);/g) || []).length, 2,
    'the poller must be kicked off after the bottom section is attached AND on visibilitychange');
});

test('tool-permissions knows the antigravity category', () => {
  assert.match(toolPerms, /antigravity: 'Antigravity'/);
  assert.match(toolPerms, /antigravity: BRAND_ACCENT/,
    'category colour must stay the single brand accent: colour carries security state, not which harness a row names');
  assert.match(toolPerms, /'antigravity',\s*\/\//, 'CATEGORY_ORDER omits antigravity');
  assert.ok(toolPerms.includes("['antigravity', 'Antigravity only']"),
    'the runtime filter dropdown omits Antigravity');
});
