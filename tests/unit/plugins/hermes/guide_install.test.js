/** Connect Agents: Hermes gets the one-click cost plugin install, SDK kept. */
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

test('hermes entry carries the plugin install slug and keeps the pip SDK', () => {
  const page = loadPage();
  const hermes = page.AGENTS.find((a) => a.id === 'hermes');
  assert.strictEqual(hermes.installSlug, 'hermes');
  assert.strictEqual(hermes.route, 'A');
  const codes = page.blocksFor(hermes, false, null).map((b) => b.code).join('\n');
  assert.match(codes, /pip install securevector-sdk-hermes --no-deps/);
});

test('the one-click block posts to the hermes install route and reads its status', () => {
  const src = read('js/pages/guide-connect-agents.js');
  assert.match(src, /const plugSlug = selected\.route === 'B' \? selected\.slug : selected\.installSlug;/);
  assert.match(src, /if \(!selfHost && plugSlug\)/);
  assert.match(src, /'\/api\/hooks\/' \+ plugSlug \+ '\/install'/);
  assert.match(src, /guardStatus\(plugSlug\)/);
  assert.match(src, /'Or use the pip SDK'/);
  assert.doesNotMatch(src, /—[^\n]*(Installed|Not installed|pip SDK)/);
});

test('index.html loads the bumped guide-connect-agents build', () => {
  assert.match(read('index.html'), /js\/pages\/guide-connect-agents\.js\?v=72"/);
});
