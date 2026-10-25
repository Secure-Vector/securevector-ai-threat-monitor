/** Observability tab row (6.1): the page filters sit right of the tabs, or
 *  fold into one "Filters · N" button with a popover. Covers the pure
 *  fit-or-fold decision, the button count, the chip list and Clear all. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));

function loadObsTabs() {
  const window = {};
  vm.runInNewContext(read('js/components/obs-tabs.js'), { window, console, document: {} });
  return window.ObsTabs;
}
function loadRunsList() {
  const window = {};
  vm.runInNewContext(read('js/components/runs-list.js'), { window, console });
  return window.RunsList;
}
function loadRunsPage() {
  const sandbox = { window: {}, document: { getElementById: () => null }, console };
  vm.runInNewContext(read('js/components/runs-list.js'), sandbox);
  sandbox.RunsList = sandbox.window.RunsList;
  vm.runInNewContext(read('js/pages/agent-runs.js'), sandbox);
  return { P: sandbox.window.AgentRunsPage, RL: sandbox.RunsList };
}

test('fit or fold: inline only when the filters fit beside the tabs', () => {
  const T = loadObsTabs();
  assert.equal(T.filterFit(900, 700), 'inline');
  assert.equal(T.filterFit(700, 700), 'popover', 'no slack left: fold');
  assert.equal(T.filterFit(708, 700), 'inline', 'exactly the slack fits');
  assert.equal(T.filterFit(707, 700), 'popover');
  assert.equal(T.filterFit(500, 700), 'popover');
  assert.equal(T.filterFit(0, 10), 'popover', 'no room at all folds');
  assert.equal(T.filterFit(-40, 10), 'popover');
  assert.equal(T.filterFit(NaN, 10), 'popover', 'an unmeasurable row folds');
  assert.equal(T.filterFit(400, 300, 0), 'inline');
});

test('the Filters button shows the active count', () => {
  const T = loadObsTabs();
  assert.equal(T.filterLabel(0), 'Filters');
  assert.equal(T.filterLabel(2), 'Filters · 2');
  assert.equal(T.filterLabel(undefined), 'Filters');
  assert.equal(T.filterLabel(-1), 'Filters');
});

test('filter chips: one per chosen value, search excluded, readable labels', () => {
  const RL = loadRunsList();
  const f = Object.assign(RL.emptyFilters(), {
    status: 'review', decision: ['blocked'], harness: ['claude-code', 'codex'], health: ['loop'], search: 'deploy',
  });
  const chips = RL.filterChips(f);
  assert.deepEqual(plain(chips.map(c => c.label)), [
    'Status: Needs review', 'Decision: Blocked', 'Harness: claude-code', 'Harness: codex', 'Health: Loop',
  ]);
  assert.equal(RL.filterChips(RL.emptyFilters()).length, 0);
  assert.equal(RL.filterChips(null).length, 0);
});

test('removing a chip drops exactly that value and the count follows', () => {
  const RL = loadRunsList();
  const f = Object.assign(RL.emptyFilters(), { status: 'ok', harness: ['claude-code', 'codex'] });
  let chips = RL.filterChips(f);
  assert.equal(chips.length, 3);
  RL.removeFilterChip(f, chips.find(c => c.value === 'claude-code'));
  assert.deepEqual(plain(f.harness), ['codex']);
  RL.removeFilterChip(f, RL.filterChips(f).find(c => c.key === 'status'));
  assert.equal(f.status, '');
  chips = RL.filterChips(f);
  assert.deepEqual(plain(chips.map(c => c.label)), ['Harness: codex']);
  assert.equal(RL.removeFilterChip(f, null), f, 'no chip is a no-op');
});

test('Clear all empties every chip and keeps the search text', () => {
  const RL = loadRunsList();
  const f = Object.assign(RL.emptyFilters(), { status: 'error', project: ['api'], model: ['m1'], search: 'span:abc' });
  const cleared = RL.clearFilterChips(f);
  assert.equal(RL.filterChips(cleared).length, 0);
  assert.equal(cleared.search, 'span:abc');
  assert.deepEqual(plain(Object.keys(cleared).sort()), plain(Object.keys(RL.emptyFilters()).sort()));
});

test('Runs page: the popover count covers the list filters and the Map hand-off filters, and Clear all resets them', () => {
  const { P, RL } = loadRunsPage();
  let renders = 0;
  P.renderRuns = () => { renders += 1; };
  P._inDetail = () => false;
  P.filters = Object.assign(RL.emptyFilters(), { decision: ['waiting'], project: ['web'], search: 'x' });
  P.toolFilter = 'github:create_issue';
  P.outcomeFilter = 'blocked';
  const chips = P._foldChips();
  assert.deepEqual(plain(chips.map(c => c.label)), ['Decision: Waiting for approval', 'Project: web', 'Tool: create_issue', 'Spans: blocked']);
  chips[1].remove();
  assert.deepEqual(plain(P.filters.project), []);
  assert.equal(P._foldChips().length, 3);
  P._clearFoldFilters();
  assert.equal(P._foldChips().length, 0);
  assert.equal(P.filters.search, 'x', 'search stays on row two');
  assert.equal(P.toolFilter, null);
  assert.equal(P.outcomeFilter, 'all');
  assert.ok(renders >= 2);
});

test('the popover is a labelled dialog with a focus trap, Esc, chips and Clear all', () => {
  const src = read('js/components/obs-tabs.js');
  assert.match(src, /btn\.setAttribute\('aria-expanded', 'false'\)/);
  assert.match(src, /btn\.setAttribute\('aria-controls', popId\)/);
  assert.match(src, /pop\.setAttribute\('role', 'dialog'\)/);
  assert.match(src, /pop\.setAttribute\('aria-label', opts\.label \|\| 'Filters'\)/);
  assert.match(src, /if \(e\.key !== 'Tab'\) return;/);
  assert.match(src, /if \(e\.key !== 'Escape' \|\| !isOpen\(\)\) return;/);
  assert.match(src, /close\(true\);/, 'Esc returns focus to the button');
  assert.match(src, /x\.setAttribute\('aria-label', `Remove \$\{c\.label\}`\)/);
  assert.match(src, /clr\.textContent = 'Clear all'/);
  assert.match(src, /new ResizeObserver\(/, 'the fold is measured, not a fixed breakpoint');
});

test('Runs and Live grid drop the heading row and keep their control ids', () => {
  const runs = read('js/pages/agent-runs.js');
  assert.doesNotMatch(runs, /<h2 class="rl-title">/);
  assert.match(runs, /id="agent-runs-toolbar"/);
  assert.match(runs, /search\.id = 'rl-search'/);
  const grid = read('js/pages/live-grid.js');
  assert.doesNotMatch(grid, /<h2 class="lg-title">/);
  assert.match(grid, /ObsTabs\.foldFilters\(head, filters,/);
  ['lg-harness', 'lg-project', 'lg-status', 'lg-group'].forEach(id => assert.match(grid, new RegExp(`sel\\('${id}'`)));
  assert.match(grid, /bar\.id = 'lg-toolbar'/);
  // Map stays a tab.
  assert.match(read('js/components/obs-tabs.js'), /\{ label: 'Map',\s+page: 'agent-map'/);
});
