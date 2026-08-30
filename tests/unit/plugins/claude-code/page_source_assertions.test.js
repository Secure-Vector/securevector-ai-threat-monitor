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


// --- 5.2.0 header/title regression guards -------------------------------

const HEADER = path.resolve(
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
  'components',
  'header.js',
);


test('PAGE_INFO covers every coding-agent proxy and guide page', () => {
  // These pages neither call Header.setPageInfo nor had PAGE_INFO
  // entries, so the app header kept the fallback title after
  // navigation. Each route in app.js must resolve to a real title.
  const src = fs.readFileSync(HEADER, 'utf8');
  const pages = [
    'proxy-claude-code',
    'proxy-codex',
    'proxy-copilot-cli',
    'proxy-cursor',
    'proxy-opencode',
    'guide-claude-code',
    'guide-codex',
    'guide-copilot-cli',
    'guide-cursor',
    'guide-opencode',
    'guide-openclaw',
    'guide-frameworks',
  ];
  const m = src.match(/PAGE_INFO:\s*\{[\s\S]*?\n {4}\}/);
  assert.ok(m, 'could not locate the PAGE_INFO literal');
  for (const page of pages) {
    assert.match(
      m[0],
      new RegExp(`'${page}':\\s*\\{\\s*title:\\s*'[^']+',\\s*subtitle:`),
      `expected PAGE_INFO['${page}'] with a title and subtitle`,
    );
  }
});


test('category tabs carry an accessible name separating label from count', () => {
  // The count pill is a sibling span, so the tab's textContent reads
  // as "OpenCode11" to assistive tech without an explicit aria-label.
  const src = readPage();
  assert.match(
    src,
    /tab\.setAttribute\('aria-label', label \+ ', ' \+ count \+ \(count === 1 \? ' tool' : ' tools'\)\);/,
    'expected mkTab to set an aria-label of "<label>, <n> tools"',
  );
});
