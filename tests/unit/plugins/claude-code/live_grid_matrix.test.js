/** Observability > Live grid: two or more open panels sit together above
 *  the tiles as a matrix (columns ceil(sqrt(N)), fewer on narrow widths). */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

function load() {
  const window = {};
  const sandbox = { window, console };
  vm.runInNewContext(read('js/components/run-trace.js'), sandbox);
  vm.runInNewContext(read('js/components/live-grid-model.js'), sandbox);
  return window.LiveGridModel;
}

const sess = (id) => ({ session_id: id, harness: 'claude-code', project: 'proj', quiet_seconds: 10, waiting: 0, blocked: 0 });

test('matrix columns: none for one panel, ceil(sqrt(N)) up to nine', () => {
  const M = load();
  const want = [0, 2, 2, 2, 3, 3, 3, 3, 3];
  for (let n = 1; n <= 9; n++) assert.equal(M.matrixCols(n), want[n - 1], `N=${n}`);
  assert.equal(M.matrixCols(0), 0);
  // Rows follow: 2 → 1, 4 → 2, 6 → 2, 9 → 3.
  assert.equal(M.matrixRows(2, 2), 1);
  assert.equal(M.matrixRows(4, 2), 2);
  assert.equal(M.matrixRows(6, 3), 2);
  assert.equal(M.matrixRows(9, 3), 3);
});

test('matrix columns drop on narrow widths: 360px per panel, one under 700px', () => {
  const M = load();
  assert.equal(M.matrixCols(9, 1400), 3);
  assert.equal(M.matrixCols(9, 1000), 2);
  assert.equal(M.matrixCols(4, 760), 2);
  assert.equal(M.matrixCols(4, 699), 1);
  assert.equal(M.matrixCols(1, 1400), 0);
});

test('one open panel stays under its tile; two or more move into the matrix in open order', () => {
  const M = load();
  const list = ['a', 'b', 'c', 'd'].map(sess);
  assert.equal(M.matrixList(['b'], list).length, 0);
  const mx = M.matrixList(['c', 'a', 'gone'], list);
  assert.equal(mx.map(s => s.session_id).join(','), 'c,a');
  const grid = M.compactHtml(M.groups(list, 'none'), { group: 'none', open: ['c', 'a'], details: {}, panelsAbove: true });
  assert.equal((grid.match(/class="lg-cx"/g) || []).length, 0);
  // Open tiles keep their outline and chevron.
  assert.match(grid, /class="lg-cw st-[a-z]+ open" data-tsid="c"/);
  assert.match(grid, /data-act="expand" data-sid="a" aria-expanded="true" aria-controls="lg-cx-a"/);
  const top = M.matrixHtml(mx, { details: {} });
  assert.equal((top.match(/class="lg-cx"/g) || []).length, 2);
  assert.ok(top.indexOf('id="lg-cx-c"') < top.indexOf('id="lg-cx-a"'));
  assert.match(top, /Open sessions \(2\)/);
  assert.match(top, /data-act="close-all">Close all</);
  assert.match(top, /data-act="close-panel" data-sid="c"/);
  assert.match(top, /style="--lg-mx-cols:2;--lg-mx-rows:1"/);
  const nine = M.matrixHtml('abcdefghi'.split('').map(sess), { details: {} });
  assert.match(nine, /--lg-mx-cols:3;--lg-mx-rows:3/);
  assert.equal(M.matrixHtml([sess('a')], {}), '');
  assert.doesNotMatch(top, /—/);
});

test('page wiring: matrix above the tiles, CSS vars, scroll kept, close actions', () => {
  const page = read('js/pages/live-grid.js');
  assert.match(page, /M\.matrixList\(this\._open, shown\)/);
  assert.match(page, /panelsAbove: !!mx\.above/);
  assert.match(page, /return strip \+ \(mx\.matrix \|\| ''\) \+ grid \+ foot;/);
  assert.match(page, /setProperty\('--lg-mx-cols'/);
  assert.match(page, /setProperty\('--lg-mx-rows'/);
  assert.match(page, /\.lg-mx-grid \{[^}]*repeat\(var\(--lg-mx-cols, 2\), minmax\(0, 1fr\)\)/);
  assert.match(page, /\.lg-mx \.lg-cx \{[^}]*max-height:[^}]*var\(--lg-mx-rows/);
  assert.match(page, /@media \(max-width: 700px\) \{ \.lg-mx-grid \{ grid-template-columns:minmax\(0, 1fr\); \} \}/);
  assert.match(page, /scrolls\[el\.id\] = el\.scrollTop/);
  assert.match(page, /act === 'close-panel' \|\| act === 'close-all'\) \{/);
  assert.match(page, /this\._open = act === 'close-all' \? \[\] : this\._open\.filter/);
  assert.match(page, /\[data-act="expand"\]\[data-sid="\$\{this\._css\(back\)\}"\]/);
  assert.match(page, /if \(opening && this\._body\(\)\.querySelector\('\.lg-mx'\)\)/);
  assert.match(page, /if \(this\._onResize\) window\.removeEventListener\('resize', this\._onResize\);\n\s*this\._onResize = \(\) =>/);
  assert.match(page, /sc\.getBoundingClientRect\(\)\.top - sc\.scrollTop/);
  assert.match(page, /removeEventListener\('resize', this\._onResize\)/);
});
