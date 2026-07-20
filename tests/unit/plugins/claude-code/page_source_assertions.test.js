/**
 * Source-assertion regression guards for the Tool Permissions page
 * redesign (#103). These tests parse the page's JS as text and assert
 * that the redesign symbols are present + correctly named, so removing
 * the claude_code category or the source-of-decision badge can't slip
 * through without a deliberate test edit.
 *
 * Justification: the pages/ render code runs inside pywebview and isn't
 * easily unit-testable. Source assertions are the cheapest viable guard.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'src',
  'securevector',
  'app',
  'assets',
  'web',
  'js',
  'pages',
  'tool-permissions.js',
);


function readPage() {
  return fs.readFileSync(PAGE, 'utf8');
}


test('categoryLabels declares claude_code → "Claude Code"', () => {
  const src = readPage();
  assert.match(
    src,
    /claude_code:\s*'Claude Code'/,
    'expected categoryLabels.claude_code === "Claude Code"',
  );
});


test('categoryAccents declares claude_code with the shared brand accent (v5)', () => {
  const src = readPage();
  // v5 color policy: categories are labels, not statuses — every category
  // shares one BRAND_ACCENT object ({ color, bg }) instead of a per-category
  // rainbow. Assert the shared constant exists and claude_code uses it.
  assert.match(
    src,
    /BRAND_ACCENT\s*=\s*\{\s*color:\s*'#[0-9a-fA-F]+',\s*bg:\s*'rgba/,
    'expected the shared BRAND_ACCENT { color, bg } constant',
  );
  assert.match(
    src,
    /claude_code:\s*BRAND_ACCENT/,
    'expected categoryAccents.claude_code to use BRAND_ACCENT',
  );
});


test('CATEGORY_ORDER includes claude_code', () => {
  const src = readPage();
  // Locate the CATEGORY_ORDER array literal and assert membership.
  const m = src.match(/CATEGORY_ORDER\s*=\s*\[([^\]]+)\]/);
  assert.ok(m, 'could not locate CATEGORY_ORDER literal');
  assert.match(
    m[1],
    /'claude_code'/,
    'expected CATEGORY_ORDER to contain claude_code',
  );
});


test('source-of-decision badge function (_svRenderSourceBadge) is wired into createToolCard', () => {
  const src = readPage();
  assert.match(
    src,
    /_svRenderSourceBadge/,
    'expected the source-of-decision badge hook (_svRenderSourceBadge) to be present',
  );
  // Both labels must be addressable from JS so the badge renders the
  // right text. Don't pin formatting — just check the strings exist.
  assert.match(src, /'Local'/, 'expected "Local" badge label');
  assert.match(src, /'Default'/, 'expected "Default" badge label');
});


test('source-of-decision badge re-renders after override AND after reset', () => {
  // Both code paths (button click → has_override=true, reset → has_override=false)
  // must call the renderer. Without both, the badge would lie about state
  // until the user reloads.
  const src = readPage();
  const calls = src.match(/row\._svRenderSourceBadge\(\)/g) || [];
  assert.ok(
    calls.length >= 2,
    `expected ≥2 invocations of row._svRenderSourceBadge() (override + reset); got ${calls.length}`,
  );
});
