/**
 * SPA route coverage: every integration ID declared in the sidebar
 * `Integrations` sub-menu must have a matching entry in `App.pages` so
 * the URL `/proxy-<name>` resolves to the right handler instead of
 * falling through to the dashboard.
 *
 * This regression test exists because Task 12 (#68) added the
 * `proxy-claude-code` sidebar item + integrations.js registry entry
 * but missed `app.js`'s top-level `pages` object — the URL silently
 * 404'd into the dashboard fallback until users noticed in production.
 * One regex scan + symmetry assertion would have caught it.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const WEB_JS = path.join(REPO_ROOT, 'src', 'securevector', 'app', 'assets', 'web', 'js');

function readSource(relPath) {
  return fs.readFileSync(path.join(WEB_JS, relPath), 'utf8');
}

function extractProxyIds(source) {
  // Match `id: 'proxy-foo'` (sidebar style) and `'proxy-foo':` (route style).
  const ids = new Set();
  for (const m of source.matchAll(/\bid:\s*'(proxy-[a-z0-9-]+)'/g)) ids.add(m[1]);
  for (const m of source.matchAll(/'(proxy-[a-z0-9-]+)'\s*:/g)) ids.add(m[1]);
  return ids;
}

test('every proxy-* sidebar entry has a matching App.pages route', () => {
  const sidebar = readSource(path.join('components', 'sidebar.js'));
  const app = readSource('app.js');

  // Sidebar declares `id: 'proxy-foo'`; only those are nav entries.
  const sidebarIds = new Set(
    [...sidebar.matchAll(/\bid:\s*'(proxy-[a-z0-9-]+)'/g)].map(m => m[1]),
  );
  // App.pages declares `'proxy-foo': { render: ... }`.
  const pageIds = new Set(
    [...app.matchAll(/'(proxy-[a-z0-9-]+)'\s*:\s*\{/g)].map(m => m[1]),
  );

  assert.ok(sidebarIds.size > 0, 'sidebar must declare at least one proxy-* entry');

  for (const id of sidebarIds) {
    assert.ok(
      pageIds.has(id),
      `sidebar declares ${id} but app.js App.pages is missing it — URL /${id} will fall through to dashboard`,
    );
  }
});

test('every proxy-* App.pages route is referenced by either the sidebar or the integrations registry', () => {
  // Symmetry guard the other way: catches dead route entries left
  // behind after a sidebar item is removed. The integrations.js
  // registry is allowed to carry stale entries (they're internal), but
  // app.js routes are URL-addressable so a dead one is a real
  // dead-code smell.
  const sidebar = readSource(path.join('components', 'sidebar.js'));
  const integrations = readSource(path.join('pages', 'integrations.js'));
  const app = readSource('app.js');

  const referenced = extractProxyIds(sidebar);
  for (const id of extractProxyIds(integrations)) referenced.add(id);

  const routeIds = new Set(
    [...app.matchAll(/'(proxy-[a-z0-9-]+)'\s*:\s*\{/g)].map(m => m[1]),
  );

  for (const id of routeIds) {
    assert.ok(
      referenced.has(id),
      `app.js routes ${id} but no sidebar item or integrations registry entry references it`,
    );
  }
});
