/**
 * Source-assertion guards for the community surfaces: GitHub and Discord
 * links at the foot of the rail, and the one-time milestone prompt. The
 * header carries no permanent ask.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

test('the header no longer carries a permanent feedback ask', () => {
  const header = read('js/components/header.js');
  assert.ok(!header.includes('createFeedbackPrompt'));
  assert.ok(!header.includes('header-feedback'));
  assert.ok(!read('css/styles.css').includes('header-feedback'));
});

test('community.js owns the links and opens them in the system browser', () => {
  const src = read('js/components/community.js');
  assert.match(src, /GITHUB_URL: 'https:\/\/github\.com\/Secure-Vector\/securevector-ai-threat-monitor'/);
  assert.match(src, /ISSUES_URL: 'https:\/\/github\.com\/Secure-Vector\/securevector-ai-threat-monitor\/issues\/new'/);
  assert.match(src, /DISCORD_URL: 'https:\/\/discord\.gg\/[A-Za-z0-9]+'/);
  assert.match(src, /a\.target = '_blank';\s*a\.rel = 'noopener noreferrer';/);
  assert.match(src, /window\.Community = Community;/);
  assert.ok(!/fetch\((?!'\/health')/.test(src), 'the only request is the local version read');
  assert.ok(!src.includes('—'), 'no em dashes in product copy');
});

test('the rail footer shows the two links under the theme row', () => {
  const sidebar = read('js/components/sidebar.js');
  const footer = sidebar.slice(sidebar.indexOf('createThemeFooter() {'), sidebar.indexOf('setTheme(id) {'));
  assert.match(footer, /foot\.className = 'sidebar-foot';\s*foot\.appendChild\(row\);\s*if \(window\.Community\) foot\.appendChild\(Community\.createLinks\(\)\);/);
  assert.ok(!sidebar.includes('bottomSection.appendChild(Community.createLinks())'), 'one foot row, not two');
  const src = read('js/components/community.js');
  assert.match(src, /'Give us a star on GitHub'/);
  assert.match(src, /'Join us on Discord'/);
  const css = read('css/styles.css');
  assert.match(css, /\.sidebar-foot \{\s*display: flex;/);
  assert.match(css, /\.sidebar\.collapsed \.sidebar-links \{\s*display: none;/);
});

test('the milestone prompt asks once, first block wins, volume is the fallback', () => {
  const src = read('js/components/community.js');
  assert.match(src, /MILESTONE: 100,/);
  assert.match(src, /STORAGE_KEY: 'sv-milestone-answered',/);
  assert.match(src, /if \(blocked < 1 && events < this\.MILESTONE\) return false;/);
  assert.match(src, /if \(this\._card \|\| this\.answered\(\)\) return false;/);
  assert.match(src, /localStorage\.getItem\('sv-welcome-seen-v2'\)/, 'first-run screens finish first');
  assert.match(src, /SecureVector has blocked \$\{blocked\.toLocaleString\(\)\}/);
  assert.match(src, /link\('Star on GitHub', this\.GITHUB_URL, 'primary', 'starred'\)/);
  assert.match(src, /link\('Report a problem', this\.bugUrl\(\), '', 'feedback'\)/);
  assert.match(src, /later\.textContent = 'Not now';/);
  assert.match(src, /e\.key === 'Escape'/);
  assert.match(src, /The Star button is at the top right of the repo page\. This is the only time the app will ask\./);
  const dash = read('js/pages/dashboard.js');
  assert.match(dash, /Community\.consider\(\{\s*blocked: blockedActions,\s*events: \(\(this\.data && this\.data\.total_threats\) \|\| 0\) \+ toolCalls,\s*\}\)/);
  const css = read('css/styles.css');
  assert.match(css, /\.sv-milestone \{\s*position: fixed;\s*right: 24px;\s*top: calc\(var\(--header-height\) \+ var\(--titlebar-inset\) \+ 12px\);\s*z-index: 1090;/);
  assert.match(css, /\.sv-milestone-action\.primary \{\s*background: var\(--accent-primary\);/);
});

test('issue links are prefilled with version and platform, never event text', () => {
  const src = read('js/components/community.js');
  assert.match(src, /q\.set\('template', template\);/);
  assert.match(src, /version: env\.version, os: env\.os, install_method: env\.install/);
  assert.match(src, /fetch\('\/health'\)/, 'version comes from the local server');
  assert.ok(!src.includes('fetch(\'http'), 'no outbound requests');
  const fp = src.slice(src.indexOf('falsePositiveUrl(threat) {'), src.indexOf('/** Rail footer'));
  assert.match(fp, /'false_positive\.yml'/);
  assert.match(fp, /rule: rules,/);
  assert.ok(!fp.includes('text_preview') && !fp.includes('.text') && !fp.includes('content'), 'no prompt text in the URL');
  assert.match(read('js/app.js'), /Community\.init\(\);/);
  assert.match(src, /CONTACT_EMAIL: 'contact@securevector\.io'/, 'the alias already public on the repo, never a personal inbox');
  assert.match(src, /return `mailto:\$\{this\.CONTACT_EMAIL\}\?subject=\$\{encodeURIComponent\(subject\)\}`;/);
  assert.match(read('js/components/sidebar.js'), /Community\.createReportLink\('email us', Community\.mailUrl\('feedback'\)\)/);
});

test('friction points carry a report link: threat drawer and uninstall screen', () => {
  const threats = read('js/pages/threats.js');
  assert.match(threats, /Community\.createReportLink\('Report this rule', Community\.falsePositiveUrl\(threat\)\)/);
  const sidebar = read('js/components/sidebar.js');
  assert.match(sidebar, /Community\.createReportLink\('Tell us in a GitHub issue', Community\.bugUrl\(\{ title: 'Uninstalling because: ' \}\)\)/);
  const form = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', '.github', 'ISSUE_TEMPLATE', 'false_positive.yml'), 'utf8');
  for (const id of ['rule', 'detection', 'source', 'what_happened', 'version', 'os', 'install_method']) {
    assert.match(form, new RegExp(`id: ${id}\\n`), `form field ${id}`);
  }
  assert.match(form, /labels: \["false-positive"\]/);
});

test('community.js loads before the rail and the pins moved', () => {
  const html = read('index.html');
  const community = html.indexOf('community.js?v=4');
  const sidebar = html.indexOf('sidebar.js?v=142');
  assert.ok(community > 0 && community < sidebar);
  assert.match(html, /header\.js\?v=54/);
  assert.match(html, /dashboard\.js\?v=90/);
  assert.match(html, /styles\.css\?v=367/);
});
