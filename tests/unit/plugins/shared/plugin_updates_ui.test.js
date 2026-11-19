/** Plugin update awareness: Connect Agents status line, Update all, and the
 *  dismissible banner line. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

function loadPage() {
  const sandbox = { window: {} };
  vm.runInNewContext(read('js/pages/guide-connect-agents.js'), sandbox);
  return sandbox.window.GuideConnectAgentsPage;
}

test('guide card status line: not installed, current, update available', () => {
  const page = loadPage();
  assert.strictEqual(page.versionLine(null), null);
  assert.strictEqual(page.versionLine({ installed: false, installed_version: '1.2.0' }), null);
  assert.strictEqual(page.versionLine({ installed: true, installed_version: '1.2.0', update_available: false }), 'Installed 1.2.0');
  assert.strictEqual(
    page.versionLine({ installed: true, installed_version: '1.2.0', bundled_version: '1.3.0', update_available: true }),
    'Installed 1.2.0, 1.3.0 available');
  assert.strictEqual(page.versionLine({ installed: true, update_available: true }), 'Installed, update available');
});

test('Update all shows only when a plugin has an update', () => {
  const page = loadPage();
  assert.strictEqual(page.updateCount(null), 0);
  assert.strictEqual(page.updateCount({ plugins: [] }), 0);
  assert.strictEqual(page.updateCount({ plugins: [{ update_available: false }, { update_available: true }, null] }), 1);
  const src = read('js/pages/guide-connect-agents.js');
  assert.match(src, /updAll\.style\.display = n > 0 \? 'flex' : 'none';/);
  assert.match(src, /fetch\('\/api\/hooks\/status-all'\)/);
  assert.match(src, /fetch\('\/api\/hooks\/update-plugins', \{ method: 'POST' \}\)/);
  assert.match(src, /updAllBtn\.textContent = 'Update all';/);
  // The card's Update button calls that harness's install route, shown only on an update.
  assert.match(src, /const installUrl = plugSlug === 'openclaw' \? '\/api\/hooks\/install' : '\/api\/hooks\/' \+ plugSlug \+ '\/install';/);
  assert.match(src, /updateBtn\.style\.display = st && st\.installed === true && st\.update_available === true \? '' : 'none';/);
  assert.doesNotMatch(src, /—[^\n]*(available|Update all)/);
  // Cards read the one shared status-all result; only a card refresh calls its route.
  assert.strictEqual((src.match(/fetch\('\/api\/hooks\/status-all'\)/g) || []).length, 1);
  assert.match(src, /const all = await loadStatusAll\(\);/);
  assert.match(src, /await showVersion\(true\);/);
});

function loadBanners(localStorage, fetchImpl) {
  const window = {};
  vm.runInNewContext(read('js/components/global-banners.js'), {
    window, localStorage, console, fetch: fetchImpl, Date, Promise,
  });
  return window.GlobalBanners;
}

function memoryStorage() {
  const store = {};
  return {
    store,
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
}

test('banner: shown with updates, dismissed per app version', () => {
  const ls = memoryStorage();
  const G = loadBanners(ls, async () => ({ ok: false }));
  assert.strictEqual(G.shouldShowPluginUpdates(0, '6.2.0'), false);
  assert.strictEqual(G.shouldShowPluginUpdates(2, '6.2.0'), true);
  G.markPluginUpdatesSeen('6.2.0');
  assert.strictEqual(ls.store[G.KEY_PLUGIN_UPDATES], '6.2.0');
  assert.strictEqual(G.shouldShowPluginUpdates(2, '6.2.0'), false);
  // A new app version brings the line back.
  assert.strictEqual(G.shouldShowPluginUpdates(2, '6.3.0'), true);
});

test('banner: storage that throws never breaks the check', () => {
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const G = loadBanners(throwing, async () => ({ ok: false }));
  assert.strictEqual(G.shouldShowPluginUpdates(1, '6.2.0'), true);
  G.markPluginUpdatesSeen('6.2.0');
});

test('banner: one status-all call, counted and cached', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ plugins: [{ update_available: true }, { update_available: false }, { update_available: true }] }) };
  };
  const G = loadBanners(memoryStorage(), fetchImpl);
  assert.strictEqual(await G.pluginUpdateCount(), 2);
  assert.strictEqual(await G.pluginUpdateCount(), 2);
  assert.deepStrictEqual(calls, ['/api/hooks/status-all']);
  await G.pluginUpdateCount(true);
  assert.strictEqual(calls.length, 2);
  const failing = loadBanners(memoryStorage(), async () => { throw new Error('down'); });
  assert.strictEqual(await failing.pluginUpdateCount(), 0);
});

test('banner copy is one line linking to Connect Agents', () => {
  const src = read('js/components/global-banners.js');
  assert.match(src, /`Plugin updates available \(\$\{count\}\)\. `/);
  assert.match(src, /link\.textContent = 'Update';/);
  assert.match(src, /Sidebar\.navigate\('guide-connect-agents'\)/);
  assert.match(src, /this\.renderPluginUpdates\(\);/);
});
