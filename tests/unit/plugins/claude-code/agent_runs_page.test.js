/**
 * Source-assertion guards for the Agent Runs trace waterfall (#142).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

test('agent-runs defines the page with runs list + waterfall pipeline', () => {
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /const AgentRunsPage = \{/);
  assert.match(src, /async render\(/);
  assert.match(src, /renderRuns\(/);
  assert.match(src, /async selectRun\(/);
  assert.match(src, /renderWaterfall\(/);
  assert.match(src, /window\.AgentRunsPage = AgentRunsPage/);
});

test('agent-runs renders spans with enforcement verdicts', () => {
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /BLOCKED/);
  assert.match(src, /ALLOW/);
  assert.match(src, /LOG/);
  assert.match(src, /turn_index/);   // ordered spans
  assert.match(src, /ar-span/);      // waterfall row
  assert.match(src, /reason/);       // blocked reason surfaced
});

test('agent-runs uses SVG icons (no emoji) and is theme-aware', () => {
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /BAN_SVG/);
  assert.match(src, /var\(--bg-card/);
  assert.doesNotMatch(src, /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
});

test('agent-runs is wired into the API client, router, index, and the Map|Runs tab', () => {
  assert.match(read('js/api.js'), /getTraces/);
  assert.match(read('js/api.js'), /getTrace\b/);
  // reached via the shared ObsTabs toggle (one sidebar entry, two views)
  assert.match(read('js/app.js'), /'agent-runs':\s*AgentRunsPage/);
  assert.match(read('js/components/obs-tabs.js'), /'agent-runs'/);
  assert.match(read('js/pages/agent-runs.js'), /ObsTabs\.render\(header, 'runs'\)/);
  const html = read('index.html');
  assert.match(html, /pages\/agent-runs\.js/);
  assert.match(html, /components\/obs-tabs\.js/);
  assert.ok(html.indexOf('components/obs-tabs.js') < html.indexOf('pages/agent-runs.js'), 'obs-tabs must load before the pages');
  assert.ok(html.indexOf('pages/agent-runs.js') < html.indexOf('js/app.js?'), 'agent-runs.js must load before app.js');
});
