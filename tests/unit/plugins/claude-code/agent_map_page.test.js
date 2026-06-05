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
  assert.match(src, /_layout\(/);
  assert.match(src, /window\.AgentMapPage = AgentMapPage/);
});

test('agent-map renders agents and tools as nodes with enforcement-colored edges', () => {
  const src = read('js/pages/agent-map.js');
  // node kinds
  assert.match(src, /kind === 'agent'/);
  assert.match(src, /kind === 'tool'/);
  // outcome colors incl. blocked = red
  assert.match(src, /OUTCOME_COLOR\s*=\s*\{[^}]*blocked:\s*'#ef4444'/);
  // hand-rolled SVG (no graph lib)
  assert.match(src, /createElementNS/);
  // secret / cloud-managed surfaced (ring + tooltip)
  assert.match(src, /touched_secrets/);
  assert.match(src, /cloud_managed/);
});

test('agent-map uses a force-directed layout (organic node map)', () => {
  const src = read('js/pages/agent-map.js');
  assert.match(src, /REPULSE/);   // charge repulsion
  assert.match(src, /SPRING/);    // link springs
  assert.match(src, /GRAVITY/);   // centering gravity
  assert.match(src, /golden angle|3 - Math\.sqrt\(5\)/); // deterministic seed
});

test('agent-map gives at-a-glance numbers + per-agent hover breakdown', () => {
  const src = read('js/pages/agent-map.js');
  // persona stat strip (slim summary line)
  assert.match(src, /_renderStats\(/);
  assert.match(src, /blocked/);
  assert.match(src, /secret \/ cloud/);
  // tool hover → calls broken down by agent
  assert.match(src, /_breakdownFor\(/);
  assert.match(src, /called by agent/);
});

test('agent-map has a Focus filter (blocked / secret / per-agent)', () => {
  const src = read('js/pages/agent-map.js');
  assert.match(src, /_applyFocus\(/);
  assert.match(src, /_refreshFocusOptions\(/);
  assert.match(src, /Blocked only/);
  assert.match(src, /Secret \/ cloud only/);
});

test('agent-map edges are solid lines with a travelling flow dot', () => {
  const src = read('js/pages/agent-map.js');
  assert.match(src, /sv-edge-base/);   // solid connection line
  assert.match(src, /sv-edge-flow/);   // travelling dot overlay
  assert.match(src, /@keyframes svFlow/);
});

test('agent-map animates tool-call traffic as flowing water', () => {
  const src = read('js/pages/agent-map.js');
  assert.match(src, /@keyframes svFlow/);
  assert.match(src, /stroke-dashoffset/);
  assert.match(src, /sv-edge-blocked/); // blocked edges pulse
});

test('agent-map supports zoom, pan, drag, and fit-to-view', () => {
  const src = read('js/pages/agent-map.js');
  // wheel + button zoom around a point
  assert.match(src, /_zoomAt\(/);
  assert.match(src, /addEventListener\('wheel'/);
  // background pan + node drag via pointer events
  assert.match(src, /_wireViewport\(/);
  assert.match(src, /_wireNodeDrag\(/);
  assert.match(src, /setPointerCapture/);
  // pinning a dragged node + live edge updates
  assert.match(src, /node\.pinned = true/);
  assert.match(src, /_updateEdgesFor\(/);
  // fit-to-view control + clamped zoom range
  assert.match(src, /_fit\(/);
  assert.match(src, /_clampK\(/);
});

test('agent-map preserves pinned (user-dragged) nodes across relayout', () => {
  const src = read('js/pages/agent-map.js');
  assert.match(src, /if \(n\.pinned\) return/);
});

test('agent-map is wired into the API client, sidebar, router, and index', () => {
  assert.match(read('js/api.js'), /getAgentToolGraph/);
  assert.match(read('js/api.js'), /\/api\/graph\/agent-tool/);
  // sidebar nav entry under Agent Activity
  assert.match(read('js/components/sidebar.js'), /id: 'agent-map'/);
  // App.pages route → AgentMapPage (the spa_routes symmetry requirement)
  assert.match(read('js/app.js'), /'agent-map':\s*AgentMapPage/);
  // script tag present and loaded before app.js
  const html = read('index.html');
  assert.match(html, /pages\/agent-map\.js/);
  const idxMap = html.indexOf('pages/agent-map.js');
  const idxApp = html.indexOf('js/app.js?');
  assert.ok(idxMap > -1 && idxApp > -1 && idxMap < idxApp, 'agent-map.js must load before app.js');
});
