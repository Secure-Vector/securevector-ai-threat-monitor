/**
 * Source-assertion guards for the Agent Map page (#143). The pages/ render
 * code runs inside pywebview and isn't DOM-unit-testable, so we parse the JS
 * (and its wiring) as text and assert the load-bearing symbols are present —
 * matching the page_source_assertions.test.js approach.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

test('agent-map page defines AgentMapPage with the core render pipeline', () => {
  const src = read('js/pages/agent-map.js');
  assert.match(src, /const AgentMapPage = \{/);
  assert.match(src, /async render\(/);
  assert.match(src, /async loadData\(/);
  assert.match(src, /draw\(\)/);
  assert.match(src, /window\.AgentMapPage = AgentMapPage/);
});

test('agent-map renders harness/session/tool nodes with enforcement-colored edges', () => {
  const src = read('js/pages/agent-map.js');
  // node kinds — the map draws harness → session → tool tiers
  assert.match(src, /kind === 'tool'/);
  assert.match(src, /'harness'/);
  // outcome colors incl. blocked = red
  assert.match(src, /OUTCOME_COLOR\s*=\s*\{[^}]*blocked:\s*'#ef4444'/);
  // hand-rolled SVG (no graph lib)
  assert.match(src, /createElementNS/);
  // secret / cloud-managed surfaced (ring + tooltip)
  assert.match(src, /touched_secrets/);
  assert.match(src, /cloud_managed/);
});

test('agent-map offers three topologies (radial / tree / mesh) behind one draw()', () => {
  const src = read('js/pages/agent-map.js');
  assert.match(src, /_layoutRadial\(/);
  assert.match(src, /_layoutTree\(/);
  assert.match(src, /_layoutMesh\(/);
  assert.match(src, /this\.topo === 'tree'/);
});

test('agent-map gives at-a-glance numbers + node hover details', () => {
  const src = read('js/pages/agent-map.js');
  // slim stat strip
  assert.match(src, /_renderStats\(/);
  assert.match(src, /blocked/);
  // node hover → tooltip card with per-node detail
  assert.match(src, /#agent-map-tip/);
});

test('agent-map has outcome filter pills (allowed / blocked / logged / threats)', () => {
  const src = read('js/pages/agent-map.js');
  assert.match(src, /\['blocked', 'Blocked'\]/);
  assert.match(src, /\['log_only', 'Logged only'\]/);
  assert.match(src, /\['threat', 'Threats'\]/);
});

test('agent-map edges carry the travelling flow animation', () => {
  const src = read('js/pages/agent-map.js');
  assert.match(src, /sv-edge-flow/);   // travelling dash overlay
  assert.match(src, /@keyframes svFlow/);
  // the motion layer must switch off under prefers-reduced-motion
  assert.match(src, /prefers-reduced-motion/);
});

test('agent-map animates tool-call traffic as flowing water', () => {
  const src = read('js/pages/agent-map.js');
  assert.match(src, /@keyframes svFlow/);
  assert.match(src, /stroke-dashoffset/);
  assert.match(src, /sv-edge-blocked/); // blocked edges pulse
});

test('agent-map supports zoom, pan, and node drag', () => {
  const src = read('js/pages/agent-map.js');
  // wheel + button zoom around a point, clamped
  assert.match(src, /_zoomAt\(/);
  assert.match(src, /addEventListener\('wheel'/);
  assert.match(src, /_clampK\(/);
  // background pan + node drag via pointer events, with live edge updates
  assert.match(src, /_wireViewport\(/);
  assert.match(src, /_wireNodeDrag\(/);
  assert.match(src, /setPointerCapture/);
  assert.match(src, /_updateEdgesFor\(/);
});

test('agent-map height is viewport-fit with a user-pinnable manual override', () => {
  const src = read('js/pages/agent-map.js');
  // drag handle pins a manual height in localStorage; double-click clears it
  assert.match(src, /auto-fit/);
  assert.match(src, /localStorage\.removeItem\(KEY\)/);
});

test('agent-map is wired into the API client, sidebar, router, and index', () => {
  assert.match(read('js/api.js'), /getAgentToolGraph/);
  assert.match(read('js/api.js'), /\/api\/graph\/agent-tool/);
  // v5.1: Sessions merged into the single "Agent Activity" view (1 session =
  // 1 trace here), landing on agent-runs, with the other views as aliases so
  // the entry stays highlighted while the Map/Live-feed/legacy-Sessions tab is
  // active.
  assert.match(read('js/components/sidebar.js'), /id: 'agent-runs',\s*label: 'Traces'/);
  assert.match(read('js/components/sidebar.js'), /aliases:\s*\[[^\]]*'storylines'[^\]]*'agent-map'[^\]]*'agent-timeline'[^\]]*\]/);
  // App.pages route → AgentMapPage (the spa_routes symmetry requirement)
  assert.match(read('js/app.js'), /'agent-map':\s*AgentMapPage/);
  // script tag present and loaded before app.js
  const html = read('index.html');
  assert.match(html, /pages\/agent-map\.js/);
  const idxMap = html.indexOf('pages/agent-map.js');
  const idxApp = html.indexOf('js/app.js?');
  assert.ok(idxMap > -1 && idxApp > -1 && idxMap < idxApp, 'agent-map.js must load before app.js');
});
