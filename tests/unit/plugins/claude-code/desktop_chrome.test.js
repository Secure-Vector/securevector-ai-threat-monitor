/**
 * Source-assertion guards for the desktop chrome bridge (shell Phase 2):
 * the page runs under a transparent macOS title bar and hands its theme to
 * the native window over the loopback chrome routes. Browser mode must stay
 * untouched, so everything is gated on the desktop user-agent token.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

test('the bridge is loaded before the sidebar and talks HTTP, not eval', () => {
  const html = read('index.html');
  const bridge = html.indexOf('/js/components/desktop-chrome.js');
  const sidebar = html.indexOf('/js/components/sidebar.js');
  assert.ok(bridge > 0 && bridge < sidebar, 'desktop-chrome.js must load before sidebar.js');
  const src = read('js/components/desktop-chrome.js');
  assert.match(src, /TOKEN: 'SecureVectorDesktop'/);
  assert.match(src, /navigator\.userAgent\)\.includes\(this\.TOKEN\)/);
  assert.match(src, /fetch\('\/api\/desktop\/chrome'/);
  assert.match(src, /fetch\('\/api\/desktop\/chrome\/theme'/);
  assert.match(src, /classList\.add\('desktop-mac'\)/);
  assert.match(src, /setProperty\('--titlebar-inset'/);
  assert.match(src, /addEventListener\('contextmenu'/);
  assert.match(src, /window\.DesktopChrome = DesktopChrome/);
  assert.ok(!src.includes('window.pywebview'), 'no dependency on the pywebview JS bridge');
});

test('theme changes reach the native window', () => {
  const src = read('js/components/sidebar.js');
  const setTheme = src.slice(src.indexOf('setTheme(id) {'), src.indexOf('showUninstallModal() {'));
  assert.match(setTheme, /DesktopChrome\.syncTheme\(id\)/);
  assert.ok(setTheme.indexOf('DesktopChrome.syncTheme') < setTheme.indexOf('this.render()'));
});

test('the title-bar inset only applies under the desktop-mac class', () => {
  const css = read('css/styles.css');
  assert.match(css, /--titlebar-inset: 0px;/);
  assert.match(css, /html\.desktop-mac \.sidebar-header \{\s*height: calc\(var\(--header-height\) \+ var\(--titlebar-inset\)\);\s*padding-top: var\(--titlebar-inset\);/);
  assert.match(css, /html\.desktop-mac \.header \{[^}]*padding-top: calc\(8px \+ var\(--titlebar-inset\)\)/);
  assert.match(css, /html\.desktop-mac \.sidebar-collapse-btn \{\s*top: calc\(20px \+ var\(--titlebar-inset\)\)/);
  const uses = css.split('\n').filter(l => l.includes('var(--titlebar-inset)'));
  assert.ok(uses.length >= 4);
});

test('rail rows, rail header and page header share one 8px rhythm', () => {
  const css = read('css/styles.css');
  const block = (sel) => {
    const i = css.indexOf(`\n${sel} {`);
    assert.ok(i > 0, `${sel} missing`);
    return css.slice(i, css.indexOf('}', i));
  };
  assert.match(block('.header'), /padding: 8px 24px;/);
  assert.match(block('.nav-item'), /padding: 8px 16px;/);
  assert.match(block('.sidebar-header'), /padding: 0 16px;/);
});
