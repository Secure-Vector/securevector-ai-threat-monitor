/**
 * Source-assertion guards for the Blocked-Action Ledger (agent-observability §3.2).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

test('blocked-ledger page defines the ledger with reason + tool breakdowns', () => {
  const src = read('js/pages/blocked-ledger.js');
  assert.match(src, /const BlockedLedgerPage = \{/);
  assert.match(src, /_reasonCard\(/);   // per-reason hit-count cards
  assert.match(src, /_toolRow\(/);      // per-tool breakdown
  assert.match(src, /window\.BlockedLedgerPage = BlockedLedgerPage/);
  // SOC colour discipline — no emoji, SVG ban glyph only.
  assert.doesNotMatch(src, /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
});

test('blocked-ledger is wired into API client, router, nav, and index', () => {
  assert.match(read('js/api.js'), /getBlockedLedger/);
  assert.match(read('js/app.js'), /'blocked-ledger':\s*BlockedLedgerPage/);
  assert.match(read('js/components/sidebar.js'), /id: 'blocked-ledger', label: 'Blocked Actions'/);
  const html = read('index.html');
  assert.match(html, /pages\/blocked-ledger\.js/);
});

test('blocked-ledger backend exposes the aggregation route + repo method', () => {
  const traces = fs.readFileSync(path.resolve(WEB, '..', '..', 'server', 'routes', 'traces.py'), 'utf8');
  assert.match(traces, /blocked-ledger/);
  assert.match(traces, /get_blocked_ledger/);
  const repo = fs.readFileSync(
    path.resolve(WEB, '..', '..', 'database', 'repositories', 'custom_tools.py'), 'utf8');
  assert.match(repo, /async def get_blocked_ledger/);
  // Only blocked rows, grouped by reason with hit counts.
  assert.match(repo, /action = 'block'/);
  assert.match(repo, /GROUP BY reason/);
});

test('sessions page renders generation spans as LLM nodes (no "call" fallback)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
  const src = fs.readFileSync(path.join(WEB, 'js/pages/storylines.js'), 'utf8');
  // Generation spans route to their own node, not _stepNode (which would show "call").
  assert.match(src, /span_kind === 'generation'/);
  assert.match(src, /_genNode\(/);
  assert.match(src, /_buildGenAnatomy\(/);
  // Audit report export (absorbs the queued "Export PDF on Sessions").
  assert.match(src, /_exportReport\(/);
  assert.match(src, /Agent Session Audit Report/);
  assert.match(src, /getBlockedLedger/);   // policies-fired enrichment
});

test('traces backend caps generations and discloses truncation', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
  const traces = fs.readFileSync(path.resolve(WEB, '..', '..', 'server', 'routes', 'traces.py'), 'utf8');
  assert.match(traces, /_GENERATION_CAP/);
  assert.match(traces, /generation_truncated/);
  assert.match(traces, /generation_total/);
});
