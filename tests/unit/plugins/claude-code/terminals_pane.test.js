/** The attached terminal is a pane: a tab per running task across the top and a
 * status line along the bottom carrying folder, branch, harness, state, elapsed
 * time, and the governed/blocked call counts. The rail's task rows carry a
 * state-and-harness subtitle and group by folder once more than one is in play. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

test('the pane head renders a tab strip with a launch tab and a bounded tab count', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /terminals-pane-tabs/, 'the tab strip needs its own container class');
  assert.match(src, /role="tablist"/, 'the strip is a tablist for assistive tech');
  assert.match(src, /terminals-pane-tab-new/, 'a launch tab must sit at the end of the strip');
  assert.match(src, /terminals-pane-tab-more/, 'the overflow tab shows the tasks that did not fit');
  assert.match(src, /aria-selected/, 'the active tab must be announced as selected');
  assert.match(src, /is-active/, 'the active tab carries a state class');
  assert.match(src, /TAB_LIMIT\s*:\s*8/, 'the strip is capped at 8 tabs');
});

test('the tab strip only lists live tasks plus whatever is attached', () => {
  const src = read('js/pages/terminals.js');
  const fn = src.slice(src.indexOf('_tabTasks('), src.indexOf('_renderPaneFoot(paneId)'));
  assert.match(fn, /'starting'/);
  assert.match(fn, /'working'/);
  assert.match(fn, /'blocked'/);
  assert.match(fn, /'idle'/);
  assert.match(fn, /this\._attached/, 'the attached task stays on the strip whatever its status');
  assert.match(fn, /slice\(0, this\.TAB_LIMIT\)/, 'the cap is applied by slicing, not by an unbounded render');
});

test('the status footer exists in the template, hidden until a task is attached', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /id="terminals-pane-foot" hidden/, 'the footer ships hidden in the page template');
  assert.match(src, /_renderPaneFoot\(paneId\)\s*\{/, 'the footer has its own render method, now per pane');
  const foot = src.slice(src.indexOf('_renderPaneFoot(paneId) {'));
  assert.match(foot, /hidden = true/, 'with nothing attached the footer hides itself');
});

test('the footer shows the branch only when the backend supplied one', () => {
  const src = read('js/pages/terminals.js');
  const foot = src.slice(src.indexOf('_renderPaneFoot(paneId) {'), src.indexOf('_renderPaneFoot(paneId) {') + 4200);
  assert.match(foot, /t\.branch/, 'the footer reads the branch the tasks route now returns');
  assert.match(foot, /terminals-foot-branch/);
  assert.match(foot, /terminals-foot-path/);
  assert.match(foot, /terminals-foot-state-/);
  assert.match(foot, /terminals-foot-gov/);
  assert.match(foot, /governed/);
  assert.match(foot, /blocked/);
});

test('the governed and blocked counts come from the verdict loader and reset on detach', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /_govCounts/, 'the pane keeps its own counts so the footer can render without refetching');
  assert.match(src, /governed: items\.length/, 'governed is the number of verdicts for the attached task');
  assert.match(src, /action === 'block'/, 'blocked counts the block verdicts, matching the verdict list');
  const detach = src.slice(src.indexOf('_detach() {'), src.indexOf('_banner(text) {'));
  assert.match(detach, /_govCounts/, 'detaching must clear the counts so they cannot leak to the next task');
});

test('rail task rows carry a state and harness subtitle', () => {
  const src = read('js/components/sidebar.js');
  assert.match(src, /HARNESS_LABELS/, 'the rail needs harness display names of its own');
  assert.match(src, /_taskSubtitle\(/);
  assert.match(src, /nav-task-title/);
  assert.match(src, /nav-task-sub/);
  assert.match(src, /nav-task-text/);
  assert.ok(!/nav-task-sub[^]{0,400}innerHTML/.test(src.slice(src.indexOf('_renderViews(item, open) {'), src.indexOf('_renderViews(item, open) {') + 4000)),
    'task text is set with textContent, never innerHTML');
});

test('the rail subtitle leads with the harness and shows elapsed time while live', () => {
  const src = read('js/components/sidebar.js');
  const sandbox = { window: {} };
  const body = src.slice(src.indexOf('HARNESS_LABELS:'), src.indexOf('_shortFolder(p) {'));
  vm.runInNewContext('window.o = { ' + body + ' };', sandbox);
  const o = sandbox.window.o;
  assert.strictEqual(o._taskSubtitle({ executor_id: 'codex' }, 'approval'), 'Codex \u00b7 needs approval');
  assert.strictEqual(o._taskSubtitle({ executor_id: 'opencode' }, 'completed'), 'OpenCode \u00b7 done');
  assert.strictEqual(o._taskSubtitle({ executor_id: 'copilot-cli' }, 'failed'), 'Copilot CLI \u00b7 stopped');
  assert.strictEqual(o._taskSubtitle({ executor_id: 'claude-code' }, 'interrupted'), 'Claude Code \u00b7 interrupted');
  assert.strictEqual(o._taskSubtitle({ executor_id: 'mystery' }, 'blocked'), 'mystery \u00b7 blocked',
    'an unknown harness falls back to its id rather than rendering undefined');
  const now = new Date(Date.now() - 95 * 60000).toISOString();
  assert.strictEqual(o._taskSubtitle({ executor_id: 'claude-code', created_at: now }, 'active'), 'Claude Code \u00b7 1h 35m');
  assert.strictEqual(o._taskSubtitle({ executor_id: 'codex', created_at: new Date().toISOString() }, 'active'), 'Codex \u00b7 just launched');
  assert.strictEqual(o._taskSubtitle({ executor_id: 'codex' }, 'active'), 'Codex \u00b7 running',
    'a task with no launch time still reads as running rather than NaN');
  assert.strictEqual(o._sinceShort(new Date(Date.now() - 7 * 60000).toISOString()), '7m');
});

test('rail task rows group by folder and the signature notices subtitle or group changes', () => {
  const src = read('js/components/sidebar.js');
  assert.match(src, /nav-tasks-group/);
  assert.match(src, /_shortFolder\(/);
  assert.match(src, /groups\.size > 1/, 'a single folder needs no group headers');
  const loader = src.slice(src.indexOf('_loadAgentTaskViews(force = false) {'), src.indexOf('_agentTaskState(task, waitingApproval'));
  assert.match(loader, /sub:/);
  assert.match(loader, /group:/);
  assert.match(loader, /v\.sub/, 'the rail signature must include the subtitle or the row never redraws');
  assert.match(loader, /v\.group/);
});

test('the pane and rail styles are defined and survive the collapsed rail', () => {
  const css = read('css/styles.css');
  for (const rule of [
    '.terminals-pane-tabs',
    '.terminals-pane-tab.is-active',
    '.terminals-pane-tab-new',
    '.terminals-pane-tab-actions',
    '.terminals-attention[hidden]',
    '[data-theme="light"] .terminals-governance',
    '[data-theme="light"] .terminals-task ',
    '[data-theme="light"] .terminals-launch ',
    '[data-theme="light"] .terminals-verdict-tool',
    '[data-theme="light"] .terminals-gov-count',
    '.terminals-pane-foot',
    '.terminals-foot-path',
    '.terminals-foot-state-blocked',
    '.nav-task-text',
    '.nav-task-sub',
    '.nav-tasks-group',
    '.sidebar.collapsed .nav-tasks-group',
  ]) {
    assert.ok(css.includes(rule), `styles.css is missing ${rule}`);
  }
});

test('index.html pins the versions this change ships', () => {
  const html = read('index.html');
  assert.match(html, /styles\.css\?v=410/);
  assert.match(html, /sidebar\.js\?v=167/);
  assert.match(html, /terminals\.js\?v=35/);
});

// --- DOM stub for the behavioural pane tests ---------------------------
// Mirrors the approach in terminals_traces.test.js: a minimal element stub,
// except the head also hands back the tab buttons it was just asked to
// render, so a click exercises the real handler wiring.

function makeEl() {
  return {
    innerHTML: '',
    textContent: '',
    hidden: false,
    dataset: {},
    classList: { add() {}, remove() {}, contains: () => false },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function makeHeadEl() {
  const el = makeEl();
  // Memoised per innerHTML so the buttons the page wired handlers onto are the
  // same objects the test later clicks, exactly as real elements would be.
  let cache = { html: null, tabs: [] };
  el.querySelectorAll = (sel) => {
    if (sel !== '.terminals-pane-tab[data-id]') return [];
    if (cache.html !== el.innerHTML) {
      const ids = [...el.innerHTML.matchAll(/role="tab" data-id="([^"]+)"/g)].map(m => m[1]);
      cache = { html: el.innerHTML, tabs: ids.map(id => ({ dataset: { id }, onclick: null })) };
    }
    return cache.tabs;
  };
  return el;
}

function loadTerminalsPage(elements, api = {}) {
  const src = read('js/pages/terminals.js');
  const sandbox = {
    window: {},
    document: { getElementById: (id) => elements[id] || makeEl(), querySelector: () => null },
    API: api,
    URLSearchParams,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  // The page reads its pane tree from the layout model, so the sandbox needs
  // both scripts, exactly as index.html loads them.
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  vm.runInNewContext(src, sandbox);
  return sandbox.window.TerminalsPage;
}

const task = (id, over = {}) => ({
  id, executor_id: 'claude-code', title: id, workspace: '/w/' + id,
  status: 'working', created_at: '2026-01-01T00:00:00Z', ...over,
});

test('clicking a tab attaches that task, and does nothing for the one already attached', () => {
  const head = makeHeadEl();
  const Page = loadTerminalsPage({ 'terminals-attached-head': head, 'terminals-pane-foot': makeEl() });
  Page._tasks = [task('t1'), task('t2'), task('t3')];
  Page._attached = 't1';
  const attached = [];
  Page._attach = (id) => attached.push(id);
  Page._renderAttachedHead();

  const tabs = head.querySelectorAll('.terminals-pane-tab[data-id]');
  assert.deepStrictEqual(tabs.map(b => b.dataset.id), ['t1', 't2', 't3']);
  tabs.find(b => b.dataset.id === 't2').onclick();
  assert.deepStrictEqual(attached, ['t2'], 'clicking another tab attaches it');
  tabs.find(b => b.dataset.id === 't1').onclick();
  assert.deepStrictEqual(attached, ['t2'], 'clicking the attached tab must not re-attach');
});

test('the attached tab is marked selected and the others are not', () => {
  const head = makeHeadEl();
  const Page = loadTerminalsPage({ 'terminals-attached-head': head, 'terminals-pane-foot': makeEl() });
  Page._tasks = [task('t1'), task('t2')];
  Page._attached = 't2';
  Page._renderAttachedHead();
  assert.match(head.innerHTML, /data-id="t2" aria-selected="true"/);
  assert.match(head.innerHTML, /data-id="t1" aria-selected="false"/);
  assert.ok(head.innerHTML.indexOf('terminals-pane-tab-actions') > head.innerHTML.indexOf('terminals-pane-tabs'),
    'the launch and overflow tabs sit outside the scrolling strip');
});

test('the head is not rebuilt when nothing about the strip changed', () => {
  const head = makeHeadEl();
  const Page = loadTerminalsPage({ 'terminals-attached-head': head, 'terminals-pane-foot': makeEl() });
  Page._tasks = [task('t1')];
  Page._attached = 't1';
  Page._renderAttachedHead();
  head.innerHTML = 'SENTINEL';
  Page._renderAttachedHead();
  assert.strictEqual(head.innerHTML, 'SENTINEL', 'an unchanged poll must leave focus and DOM alone');
  Page._tasks = [task('t1', { status: 'blocked' })];
  Page._renderAttachedHead();
  assert.notStrictEqual(head.innerHTML, 'SENTINEL', 'a state change must rebuild the strip');
});

test('_tabTasks() keeps the attached task on the strip when there are more than eight live tasks', () => {
  const Page = loadTerminalsPage({});
  Page._tasks = Array.from({ length: 12 }, (_, i) => task('t' + i));
  Page._attached = 't11';
  const { shown, overflow } = Page._tabTasks();
  assert.strictEqual(shown.length, 8, 'the strip stays capped at eight tabs');
  assert.ok(shown.some(t => t.id === 't11'), 'the attached task can never fall into the overflow');
  assert.strictEqual(shown[0].id, 't11');
  assert.strictEqual(overflow, 4);
  Page._attached = 't0';
  assert.strictEqual(Page._tabTasks().shown[0].id, 't0', 'an in-range attached task keeps its position');
});

test('the footer reports the governed and blocked counts the verdict loader found', async () => {
  const elements = {
    'terminals-attached-head': makeHeadEl(),
    'terminals-pane-foot': makeEl(),
    'terminals-verdicts': makeEl(),
    'terminals-approvals': makeEl(),
    'terminals-traces': makeEl(),
    'terminals-attention': makeEl(),
    'terminals-governance-summary': makeEl(),
  };
  const api = {
    terminalsVerdicts: async () => ({
      items: [
        { tool_id: 'Bash', action: 'allow', risk: 'green' },
        { tool_id: 'Write', action: 'block', risk: 'red' },
        { tool_id: 'Read', action: 'allow', risk: 'amber' },
      ],
      session_id: 'sess-1',
    }),
    getJitRequests: async () => ({ items: [] }),
    request: async () => ({ runs: [] }),
  };
  const Page = loadTerminalsPage(elements, api);
  Page._tasks = [task('task-1', { branch: 'feat/x' })];
  Page._attached = 'task-1';
  await Page._refreshRail();

  const foot = elements['terminals-pane-foot'];
  assert.strictEqual(foot.hidden, false);
  assert.ok(foot.innerHTML.includes('3 governed \u00b7 1 blocked'), `footer read: ${foot.innerHTML}`);
  assert.match(foot.innerHTML, /terminals-foot-branch">feat\/x</, 'the branch shows when the backend supplied one');
});

test('the footer hides and forgets its counts once nothing is attached', async () => {
  const elements = {
    'terminals-pane-foot': makeEl(),
    'terminals-verdicts': makeEl(),
    'terminals-approvals': makeEl(),
    'terminals-traces': makeEl(),
    'terminals-attention': makeEl(),
    'terminals-governance-summary': makeEl(),
  };
  const Page = loadTerminalsPage(elements, { getJitRequests: async () => ({ items: [] }) });
  Page._govCounts = { governed: 9, blocked: 4 };
  Page._attached = null;
  await Page._refreshRail();
  assert.strictEqual(elements['terminals-pane-foot'].hidden, true);
  // Compared field by field: the object is built inside the vm realm, so it is
  // not reference-comparable against a literal from this one.
  assert.strictEqual(Page._govCounts.governed, 0);
  assert.strictEqual(Page._govCounts.blocked, 0);
});

test('a task with no branch renders no branch segment', () => {
  const foot = makeEl();
  const Page = loadTerminalsPage({ 'terminals-pane-foot': foot });
  Page._tasks = [task('t1', { branch: null })];
  Page._attached = 't1';
  Page._renderPaneFoot();
  assert.ok(!foot.innerHTML.includes('terminals-foot-branch'), 'no branch means no separator and no segment');
  assert.match(foot.innerHTML, /terminals-foot-path/);
});

test('_elapsed() rolls over to hours instead of a three-digit minute count', () => {
  const Page = loadTerminalsPage({});
  const at = (mins) => Page._elapsed(new Date(Date.now() - mins * 60000).toISOString(), null);
  assert.strictEqual(at(0), '0s');
  assert.strictEqual(at(5), '5m 0s');
  assert.strictEqual(at(59), '59m 0s');
  assert.strictEqual(at(60), '1h 0m');
  assert.strictEqual(at(863), '14h 23m');
});

test('sidebar patches subtitles in place when only the subtitle changed', () => {
  const src = read('js/components/sidebar.js');
  assert.match(src, /_patchTaskSubtitles\(/);
  assert.match(src, /_agentTaskRowSig/, 'the row identity signature is kept apart from the subtitle one');
  const loader = src.slice(src.indexOf('_loadAgentTaskViews(force = false) {'), src.indexOf('_agentTaskState(task, waitingApproval'));
  assert.match(loader, /sameRows && this\._patchTaskSubtitles\(/, 'the in-place patch only applies when the rows themselves are unchanged');
  assert.match(loader, /this\.render\(\);/, 'any other difference still does a full render');
  const patch = src.slice(src.indexOf('_patchTaskSubtitles(views) {'), src.indexOf('refreshAgentTaskViews() {'));
  assert.match(patch, /data-task-id/);
  assert.match(patch, /\.nav-task-sub/);
  assert.match(patch, /textContent/);
  assert.match(patch, /return false;/, 'it must bail out to a full render when the rail is not in the expected shape');
});
