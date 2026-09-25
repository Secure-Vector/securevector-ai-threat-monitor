/** Agent Governance from gaps in real activity: coverage card, the gaps
 * list with its Fix buttons, the empty state, and the collapsed setup
 * checklist (js/pages/governance.js). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

function loadGov(extra = {}) {
  const sandbox = Object.assign({ window: {} }, extra);
  vm.runInNewContext(read('js/pages/governance.js'), sandbox);
  return sandbox.window.GovernancePage;
}

const cov = (extra = {}) => ({ window_days: 7, coverage: Object.assign({ governed_calls: 45, total_calls: 60, pct: 75, prev_pct: 70, prev_total_calls: 40 }, extra), gaps: [] });

test('coverage: big pct, N of M checked, and the change against the previous window', () => {
  const G = loadGov();
  const html = G._coverageHtml(cov());
  assert.match(html, /Governed coverage, last 7 days/);
  assert.match(html, /class="gov-cov-pct">75</);
  assert.match(html, /45 of 60 tool calls were checked/);
  assert.match(html, /▲ 5 pts vs previous 7 days</);
  assert.match(G._coverageHtml(cov({ pct: 62.5, prev_pct: 70 })), /▼ 7\.5 pts/);
  assert.match(G._coverageHtml(cov({ prev_partial: true })), /vs previous 7 days \(partial\)/);
  // recording began inside the window: say since when
  assert.match(G._coverageHtml(cov({ recording_since: '2026-09-24T19:16:34+00:00' })), /\(since 2026-09-24, when recording began\)/);
  assert.doesNotMatch(html, /since/);
  // either window under 20 calls: no delta
  assert.doesNotMatch(G._coverageHtml(cov({ prev_total_calls: 19 })), /previous 7 days/);
  assert.doesNotMatch(G._coverageHtml(cov({ total_calls: 19, governed_calls: 10 })), /previous 7 days/);
  // partial answer: say older sessions are still being checked
  assert.match(G._coverageHtml(Object.assign(cov(), { partial: true })), /Still checking older sessions/);
  assert.doesNotMatch(html, /Still checking/);
  // no previous window: no delta line
  assert.doesNotMatch(G._coverageHtml(cov({ prev_pct: null })), /previous 7 days/);
});

test('coverage: null pct shows "Not enough data yet" with the reason, never 100%', () => {
  const G = loadGov();
  const html = G._coverageHtml(cov({ pct: null, prev_pct: null, governed_calls: 0, total_calls: 0, note: 'No Claude Code or Codex transcripts were found.' }));
  assert.match(html, /Not enough data yet/);
  assert.match(html, /No Claude Code or Codex transcripts were found\./);
  assert.doesNotMatch(html, /100/);
  assert.doesNotMatch(html, /gov-cov-pct/);
  // API failure: same honest state
  assert.match(G._coverageHtml(null), /Not enough data yet/);
});

test('gaps list: severity icon, title, detail and Fix buttons carrying route or action', () => {
  const G = loadGov();
  const data = { window_days: 7, coverage: {}, gaps: [
    { id: 'unrecorded_calls:codex', kind: 'unrecorded_calls', severity: 'high', title: '4 tool calls from Codex not recorded', detail: 'Most often: shell x4.', count: 4, fix: { label: 'How to connect', route: 'guide-codex' } },
    { id: 'plugin_not_active:claude-code', kind: 'plugin_not_active', severity: 'high', title: 'Claude Code Guard plugin is not active', detail: 'Staged.', count: 1, fix: { label: 'Install', action: 'install_plugin:claude-code' } },
    { id: 'codex_hooks_untrusted', kind: 'codex_hooks_untrusted', severity: 'high', title: 'Codex has not trusted the Guard hooks', detail: 'x', count: 2, fix: { label: 'In Codex, run /hooks and press t to trust' } },
    { id: 'egress_uncovered_hosts', kind: 'egress_uncovered_hosts', severity: 'warn', title: '2 hosts', detail: 'a.example', count: 2, fix: { label: 'Egress Policy', route: 'egress-policy' } },
    { id: 'approvals_pending', kind: 'approvals_pending', severity: 'info', title: '1 approval waiting on you', detail: 'x', count: 1, fix: { label: 'Open Agent Sessions', route: 'terminals' } },
  ] };
  const html = G._gapsHtml(data);
  assert.match(html, /Gaps to close/);
  assert.strictEqual((html.match(/class="gov-gap gov-gap-/g) || []).length, 5);
  assert.match(html, /class="gov-gap gov-gap-high" data-kind="unrecorded_calls"/);
  assert.match(html, /class="gov-gap gov-gap-warn" data-kind="egress_uncovered_hosts"/);
  assert.match(html, /data-route="guide-codex">How to connect<\/button>/);
  assert.match(html, /data-action="install_plugin:claude-code">Install<\/button>/);
  // instructions only: shown as text, not a button
  assert.match(html, /class="gov-gap-hint">In Codex, run \/hooks and press t to trust</);
  // high is amber, never red: nothing was blocked
  const css = read('js/pages/governance.js');
  assert.match(css, /\.gov-gap-high \.gov-gap-ico\{color:var\(--warning/);
  assert.doesNotMatch(css.slice(css.indexOf('.gov-gap{'), css.indexOf('.gov-checklist>summary')), /--danger/);
});

test('gaps list: install_plugin fix runs the existing install API, then refreshes', async () => {
  const calls = [];
  const api = {
    installGuard: async (h) => { calls.push(['install', h]); return {}; },
    getGovernanceGaps: async (p) => { calls.push(['gaps', p.refresh]); return { window_days: 7, coverage: {}, gaps: [] }; },
  };
  const G = loadGov({ window: { API: api }, API: api, document: { querySelector: () => null } });
  G._fillGaps = () => {};
  const filled = [];
  G._fillGaps = (card, data) => filled.push(data);
  const card = {};
  const btn = { disabled: false, textContent: 'Install', closest: () => card };
  await G._runFix(null, 'install_plugin:claude-code', btn);
  assert.deepStrictEqual(calls, [['install', 'claude-code'], ['gaps', true]]);
  assert.strictEqual(filled.length, 1);
  // anything else is ignored, never evaluated
  calls.length = 0;
  await G._runFix(null, 'install_plugin:../../x', btn);
  await G._runFix(null, 'eval:alert(1)', btn);
  assert.deepStrictEqual(calls, []);
  // a failed refresh still resets the button
  api.getGovernanceGaps = async () => { throw new Error('down'); };
  const btn2 = { disabled: false, textContent: 'Install', closest: () => ({}) };
  await G._runFix(null, 'install_plugin:codex', btn2);
  assert.strictEqual(btn2.disabled, false);
  assert.strictEqual(btn2.textContent, 'Install failed, retry');
  const btn3 = { disabled: false, textContent: 'Install', closest: () => ({}) };
  api.getGovernanceGaps = async () => ({ gaps: [] });
  await G._runFix(null, 'install_plugin:codex', btn3);
  assert.strictEqual(btn3.disabled, false);
  assert.strictEqual(btn3.textContent, 'Install');
  const src = read('js/api.js');
  assert.match(src, /async getGovernanceGaps\(params = \{\}\)/);
  assert.match(src, /\/api\/governance\/gaps\?window_days=/);
});

test('empty state: no gaps plus one line on what is watched', () => {
  const G = loadGov();
  const html = G._gapsHtml({ window_days: 7, coverage: {}, gaps: [] });
  assert.match(html, /No gaps in the last 7 days\./);
  assert.match(html, /Watched: tool calls SecureVector has no record of/);
  assert.match(G._gapsHtml(null), /could not be loaded/);
});

test('server strings are escaped', () => {
  const G = loadGov();
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const html = G._gapsHtml({ window_days: 7, gaps: [{ kind: evil, severity: evil, title: evil, detail: evil, count: 1, fix: { label: evil, route: evil } }] });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);
  const c = G._coverageHtml({ window_days: 7, coverage: { pct: null, note: evil } });
  assert.doesNotMatch(c, /<img/);
});

test('setup checklist: the 7 controls sit in a collapsed <details> with the score', () => {
  const src = read('js/pages/governance.js');
  const r = src.slice(src.indexOf('async render(container) {'));
  assert.match(r, /document\.createElement\('details'\)/);
  assert.match(r, /clSummary\.textContent = 'Setup checklist ' \+ \(counts\.on \+ counts\.native\) \+ '\/' \+ rows\.length/);
  assert.doesNotMatch(r, /checklist\.open\s*=\s*true|setAttribute\('open'/);
  // coverage and gaps lead as skeletons before anything is awaited, the
  // checklist follows, the framework footer stays
  const iCov = r.indexOf("covCard.className = 'gov-card gov-cov-card'");
  const iGaps = r.indexOf("gapsCard.className = 'gov-card gov-gaps-card'");
  const iAwait = r.indexOf('await this._gather()');
  assert.ok(iGaps < r.indexOf('container.appendChild(wrap)') && r.indexOf('container.appendChild(wrap)') < iAwait);
  assert.match(r, /covCard\.innerHTML = this\._coverageSkeletonHtml\(\)/);
  assert.match(r, /gapsPromise\.catch\(\(\) => null\)\.then\(\(gapsData\) => \{/);
  const iList = r.indexOf('wrap.appendChild(checklist)');
  const iMeta = r.indexOf('wrap.appendChild(meta)');
  assert.ok(iCov > 0 && iCov < iGaps && iGaps < iList && iList < iMeta);
  assert.match(r, /clBody\.appendChild\(bandCard\)/);
  assert.match(r, /clBody\.appendChild\(nextCard\)/);
  assert.match(r, /clBody\.appendChild\(list\)/);
  assert.match(r, /this\.FRAMEWORKS/);
  assert.match(read('index.html'), /governance\.js\?v=26/);
});

test('no em dashes in the governance UI copy', () => {
  const src = read('js/pages/governance.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/ .*$/, '')).join('\n');
  assert.ok(!src.includes('—'), 'em dash in governance.js copy');
  const th = read('js/pages/threats.js');
  const part = th.slice(th.indexOf('const headerActions'), th.indexOf('// Filters bar'));
  assert.ok(part.length > 50 && !part.includes('—'));
});

test('skeletons say the page is still checking', () => {
  const G = loadGov();
  assert.match(G._coverageSkeletonHtml(), /Governed coverage, last 7 days[\s\S]*aria-busy="true"/);
  assert.match(G._gapsSkeletonHtml(), /Gaps to close[\s\S]*aria-busy="true"/);
});

test('Claude coordination tools are not reported as unrecorded; Agent still is', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(read('js/components/trace-steps.js'), sandbox);
  const TS = sandbox.window.TraceSteps;
  for (const n of ['SendMessage', 'ListAgents', 'ReadNotifications']) assert.ok(TS.UNCHECKED_IGNORE.includes(n), n);
  for (const n of ['Agent', 'Task', 'Bash']) assert.ok(!TS.UNCHECKED_IGNORE.includes(n), n);
  const step = { gen: { tool_use_names: ['SendMessage', 'SendMessage', 'Agent'] }, tools: [] };
  assert.deepStrictEqual(JSON.parse(JSON.stringify(TS.unchecked(step))), [{ name: 'Agent', count: 1 }]);
  assert.match(read('index.html'), /trace-steps\.js\?v=10/);
});

test('Tool Permissions links to Tool Activity, and the palette files it under Policies', () => {
  const tp = read('js/pages/tool-permissions.js');
  assert.match(tp, /if \(this\.hideTabBar && this\.activeTab === 'permissions'\)/);
  assert.match(tp, /act\.textContent = 'Tool Activity'/);
  assert.match(tp, /Sidebar\.navigate\('tool-activity'\)/);
  assert.match(read('index.html'), /tool-permissions\.js\?v=88/);
  const pal = read('js/components/command-palette.js');
  const visibility = pal.slice(pal.indexOf("if (['dashboard'"), pal.indexOf("return 'Visibility'"));
  assert.ok(!visibility.includes("'tool-activity'"));
  assert.match(pal, /if \(\['tool-permissions', 'tool-activity', 'rules',/);
});
