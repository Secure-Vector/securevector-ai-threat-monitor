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

test('agent-runs renders Generation (LLM turn) spans with redacted I/O previews', () => {
  const src = read('js/pages/agent-runs.js');
  // Dispatches generation spans to their own renderer.
  assert.match(src, /span_kind === 'generation'/);
  assert.match(src, /_genSpan\(/);
  assert.match(src, /_genDetail\(/);
  // Shows model + token flow + cost, and the LLM input/output preview boxes.
  assert.match(src, /LLM input — prompt/);
  assert.match(src, /LLM output — response/);
  assert.match(src, /input_preview/);
  assert.match(src, /output_preview/);
  // Honest privacy contract carried through to the detail.
  assert.match(src, /never stores the full prompt or response/);
  // Generations bypass the built-in/external tool checkbox.
  assert.match(src, /Generations aren't tools/);
});

test('agent-runs provides session replay — play/step/scrub over the event stream', () => {
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /_replay:\s*\{/);          // replay state
  assert.match(src, /_replayBar\(/);           // transport bar
  assert.match(src, /_replayPlay\(/);          // play loop
  assert.match(src, /_replaySeek\(/);          // scrubber / step
  assert.match(src, /_applyReplay\(/);         // reveal-to-playhead
  assert.match(src, /ar-replay-hidden/);       // hides events past the playhead
  assert.match(src, /ar-replay-current/);      // spotlights the current event
  assert.match(src, /data-ridx|dataset\.ridx/); // chronological index
  // Replay is reset when switching traces.
  assert.match(src, /_replayStop\(\)/);
});

test('agent-observability backend exposes generation counts on a trace', () => {
  const py = fs.readFileSync(
    path.resolve(WEB, '..', '..', 'server', 'routes', 'traces.py'), 'utf8');
  assert.match(py, /generation_count/);
  assert.match(py, /tool_call_count/);
  assert.match(py, /build_generations/);
  // One generation per API round-trip, cost best-effort from the price table.
  assert.match(py, /apply_cost/);
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
