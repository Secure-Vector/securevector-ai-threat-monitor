/** The Terminals layout tree: a pure, DOM-free model of the split panes.
 * Every operation returns a new tree so the page can diff old against new and
 * keep the live xterm instances that did not move. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

function loadLayout() {
  const sandbox = { window: {} };
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  return sandbox.window.TerminalsLayout;
}

test('create() makes a pane node with a fresh opaque id', () => {
  const L = loadLayout();
  const a = L.create('task-1');
  const b = L.create('task-1');
  assert.strictEqual(a.type, 'pane');
  assert.strictEqual(a.taskId, 'task-1');
  assert.match(a.id, /^[0-9a-f]{12}$/, 'pane ids are 12 hex characters');
  assert.notStrictEqual(a.id, b.id, 'two panes for the same task still get distinct ids');
});

test('create() tolerates a realm with no crypto', () => {
  const src = read('js/pages/terminals-layout.js');
  assert.match(src, /typeof crypto/, 'the id source must be feature-detected, not assumed');
  const L = loadLayout();
  assert.match(L.create(null).id, /^[0-9a-f]{12}$/);
});

test('split() turns a pane into a split with the old pane first', () => {
  const L = loadLayout();
  const root = L.create('t1');
  const next = L.split(root, root.id, 'row', 't2');
  assert.strictEqual(next.type, 'split');
  assert.strictEqual(next.dir, 'row');
  assert.strictEqual(next.ratio, 0.5);
  assert.strictEqual(next.a.id, root.id, 'the pane that was split keeps its identity');
  assert.strictEqual(next.a.taskId, 't1');
  assert.strictEqual(next.b.taskId, 't2');
  assert.notStrictEqual(next.b.id, root.id);
  assert.strictEqual(root.type, 'pane', 'the input tree is never mutated');
});

test('split() works on a column direction and on a nested pane', () => {
  const L = loadLayout();
  let root = L.create('t1');
  const first = root.id;
  root = L.split(root, first, 'row', 't2');
  const second = root.b.id;
  root = L.split(root, second, 'col', 't3');
  assert.strictEqual(root.dir, 'row');
  assert.strictEqual(root.b.type, 'split');
  assert.strictEqual(root.b.dir, 'col');
  assert.deepStrictEqual(Array.from(L.panes(root), p => p.taskId), ['t1', 't2', 't3']);
});

test('split() rejects an unknown pane id and an unknown direction', () => {
  const L = loadLayout();
  const root = L.create('t1');
  assert.strictEqual(L.split(root, 'nope', 'row', 't2'), root, 'an unknown pane leaves the tree alone');
  assert.strictEqual(L.split(root, root.id, 'diagonal', 't2'), root, 'only row and col are directions');
  assert.strictEqual(L.split(null, 'x', 'row', 't2'), null);
});

test('panes() lists panes in reading order, a before b', () => {
  const L = loadLayout();
  let root = L.create('t1');
  root = L.split(root, root.id, 'row', 't2');
  root = L.split(root, root.a.id, 'col', 't3');
  assert.deepStrictEqual(Array.from(L.panes(root), p => p.taskId), ['t1', 't3', 't2']);
  assert.strictEqual(L.panes(null).length, 0);
});

test('find() and parent() locate nodes and their splits', () => {
  const L = loadLayout();
  let root = L.create('t1');
  const first = root.id;
  root = L.split(root, first, 'row', 't2');
  const second = root.b.id;
  assert.strictEqual(L.find(root, first).taskId, 't1');
  assert.strictEqual(L.find(root, root.id).type, 'split');
  assert.strictEqual(L.find(root, 'missing'), null);
  assert.strictEqual(L.parent(root, second).id, root.id);
  assert.strictEqual(L.parent(root, root.id), null, 'the root has no parent');
});

test('close() promotes the sibling into the parent split', () => {
  const L = loadLayout();
  let root = L.create('t1');
  const first = root.id;
  root = L.split(root, first, 'row', 't2');
  const second = root.b.id;
  const afterFirst = L.close(root, first);
  assert.strictEqual(afterFirst.type, 'pane');
  assert.strictEqual(afterFirst.id, second, 'the surviving pane keeps its id so its terminal survives');
  const afterSecond = L.close(root, second);
  assert.strictEqual(afterSecond.id, first);
});

test('close() on the last pane clears the layout, and an unknown id changes nothing', () => {
  const L = loadLayout();
  const root = L.create('t1');
  assert.strictEqual(L.close(root, root.id), null);
  assert.strictEqual(L.close(root, 'nope'), root);
  assert.strictEqual(L.close(null, 'x'), null);
});

test('close() in a deep tree collapses only the split it emptied', () => {
  const L = loadLayout();
  let root = L.create('t1');
  root = L.split(root, root.id, 'row', 't2');
  const b = root.b.id;
  root = L.split(root, b, 'col', 't3');
  const t3 = root.b.b.id;
  const next = L.close(root, t3);
  assert.strictEqual(next.type, 'split');
  assert.strictEqual(next.b.type, 'pane');
  assert.deepStrictEqual(Array.from(L.panes(next), p => p.taskId), ['t1', 't2']);
});

test('setRatio() clamps to MIN_RATIO on both ends', () => {
  const L = loadLayout();
  assert.strictEqual(L.MIN_RATIO, 0.15);
  let root = L.create('t1');
  root = L.split(root, root.id, 'row', 't2');
  assert.strictEqual(L.setRatio(root, root.id, 0.7).ratio, 0.7);
  assert.strictEqual(L.setRatio(root, root.id, 0.01).ratio, 0.15);
  assert.strictEqual(L.setRatio(root, root.id, 0.99).ratio, 0.85);
  assert.strictEqual(L.setRatio(root, root.id, NaN).ratio, 0.5, 'a non-number leaves the ratio alone');
  assert.strictEqual(root.ratio, 0.5, 'the input tree is never mutated');
  assert.strictEqual(L.setRatio(root, 'nope', 0.3), root);
});

test('replaceTask() swaps the task in one pane only', () => {
  const L = loadLayout();
  let root = L.create('t1');
  const first = root.id;
  root = L.split(root, first, 'row', 't2');
  const next = L.replaceTask(root, first, 't9');
  assert.deepStrictEqual(Array.from(L.panes(next), p => p.taskId), ['t9', 't2']);
  assert.deepStrictEqual(Array.from(L.panes(root), p => p.taskId), ['t1', 't2']);
  assert.strictEqual(L.replaceTask(root, 'nope', 't9'), root);
});

test('serialize() and parse() round trip a nested tree', () => {
  const L = loadLayout();
  let root = L.create('t1');
  root = L.split(root, root.id, 'row', 't2');
  root = L.split(root, root.b.id, 'col', 't3');
  root = L.setRatio(root, root.id, 0.62);
  const back = L.parse(JSON.parse(JSON.stringify(L.serialize(root))));
  assert.deepStrictEqual(back, root);
});

test('parse() rejects shapes it does not recognise', () => {
  const L = loadLayout();
  assert.strictEqual(L.parse(null), null);
  assert.strictEqual(L.parse('t1'), null);
  assert.strictEqual(L.parse({ type: 'pane' }), null, 'a pane needs an id');
  assert.strictEqual(L.parse({ type: 'wat', id: 'abc' }), null);
  assert.strictEqual(L.parse({ type: 'split', id: 'a', dir: 'row', ratio: 0.5, a: { type: 'pane', id: 'b', taskId: 't' } }), null,
    'a split with one child is not a split');
  assert.strictEqual(L.parse({ type: 'split', id: 'a', dir: 'sideways', ratio: 0.5, a: { type: 'pane', id: 'b', taskId: 't' }, b: { type: 'pane', id: 'c', taskId: 'u' } }), null);
});

test('parse() drops unknown fields and clamps a stored ratio', () => {
  const L = loadLayout();
  const back = L.parse({
    type: 'split', id: 'aaaaaaaaaaaa', dir: 'row', ratio: 0.98, junk: 'drop me',
    a: { type: 'pane', id: 'bbbbbbbbbbbb', taskId: 't1', extra: 1 },
    b: { type: 'pane', id: 'cccccccccccc', taskId: 't2' },
  });
  assert.strictEqual(back.ratio, 0.85);
  assert.strictEqual(back.junk, undefined);
  assert.strictEqual(back.a.extra, undefined);
  assert.deepStrictEqual(Array.from(Object.keys(back.a)).sort(), ['id', 'taskId', 'taskIds', 'type']);
});

test('parse() rejects a tree that reuses an id', () => {
  const L = loadLayout();
  assert.strictEqual(L.parse({
    type: 'split', id: 'aaaaaaaaaaaa', dir: 'row', ratio: 0.5,
    a: { type: 'pane', id: 'bbbbbbbbbbbb', taskId: 't1' },
    b: { type: 'pane', id: 'bbbbbbbbbbbb', taskId: 't2' },
  }), null, 'duplicate ids would make find() ambiguous');
});

test('prune() drops panes whose task is gone and collapses the splits', () => {
  const L = loadLayout();
  let root = L.create('t1');
  root = L.split(root, root.id, 'row', 't2');
  root = L.split(root, root.b.id, 'col', 't3');
  const pruned = L.prune(root, ['t1', 't3']);
  assert.deepStrictEqual(Array.from(L.panes(pruned), p => p.taskId), ['t1', 't3']);
  assert.strictEqual(pruned.type, 'split');
  assert.strictEqual(pruned.b.type, 'pane');
  assert.strictEqual(L.prune(root, []), null, 'nothing alive means no layout');
  assert.strictEqual(L.prune(root, ['t1', 't2', 't3']), root, 'an all-alive tree is returned unchanged');
  assert.strictEqual(L.prune(null, ['t1']), null);
});

test('prune() accepts a Set as well as an array', () => {
  const L = loadLayout();
  let root = L.create('t1');
  root = L.split(root, root.id, 'row', 't2');
  const pruned = L.prune(root, new Set(['t2']));
  assert.strictEqual(pruned.type, 'pane');
  assert.strictEqual(pruned.taskId, 't2');
});

test('the module publishes itself the way the other components do', () => {
  const src = read('js/pages/terminals-layout.js');
  assert.match(src, /window\.TerminalsLayout = TerminalsLayout;/);
  assert.ok(!/document\.|innerHTML|querySelector/.test(src), 'the layout model must stay free of the DOM');
});

// --- move: dropping a pane on another pane's edge ---------------------------

function twoPanes(L) {
  const root = L.create('t1');
  return { root: L.split(root, root.id, 'row', 't2'), firstId: root.id };
}

test('move() drops a pane on the right edge of another: a row split, target first', () => {
  const L = loadLayout();
  const { root, firstId } = twoPanes(L);
  const second = root.b.id;
  const next = L.move(root, firstId, second, 'right');
  assert.strictEqual(next.type, 'split');
  assert.strictEqual(next.dir, 'row');
  assert.strictEqual(next.ratio, 0.5);
  assert.deepStrictEqual(Array.from(L.panes(next), (p) => p.taskId), ['t2', 't1']);
  assert.strictEqual(next.b.id, firstId, 'the moved pane keeps its id so its terminal survives');
});

test('move() on the left edge puts the moved pane first', () => {
  const L = loadLayout();
  const { root, firstId } = twoPanes(L);
  const next = L.move(root, root.b.id, firstId, 'left');
  assert.strictEqual(next.dir, 'row');
  assert.deepStrictEqual(Array.from(L.panes(next), (p) => p.taskId), ['t2', 't1']);
});

test('move() on the top and bottom edges makes a column split', () => {
  const L = loadLayout();
  const { root, firstId } = twoPanes(L);
  const second = root.b.id;
  const top = L.move(root, firstId, second, 'top');
  assert.strictEqual(top.dir, 'col');
  assert.deepStrictEqual(Array.from(L.panes(top), (p) => p.taskId), ['t1', 't2']);
  const bottom = L.move(root, firstId, second, 'bottom');
  assert.strictEqual(bottom.dir, 'col');
  assert.deepStrictEqual(Array.from(L.panes(bottom), (p) => p.taskId), ['t2', 't1']);
});

test('move() reshapes a deeper tree and leaves the rest of it alone', () => {
  const L = loadLayout();
  let root = L.create('t1');
  const first = root.id;
  root = L.split(root, first, 'row', 't2');
  root = L.split(root, root.b.id, 'col', 't3');
  const t3 = root.b.b.id;
  const next = L.move(root, t3, first, 'top');
  assert.deepStrictEqual(Array.from(L.panes(next), (p) => p.taskId), ['t3', 't1', 't2']);
  assert.strictEqual(next.a.type, 'split', 't1 now sits under a column split with t3');
  assert.strictEqual(next.a.dir, 'col');
  assert.strictEqual(next.b.type, 'pane', 'the split t3 left behind collapsed onto t2');
});

test('move() refuses a self move, a missing target, a bad edge, and the only pane', () => {
  const L = loadLayout();
  const { root, firstId } = twoPanes(L);
  assert.strictEqual(L.move(root, firstId, firstId, 'right'), root, 'a pane cannot land on itself');
  assert.strictEqual(L.move(root, firstId, 'gone', 'right'), root);
  assert.strictEqual(L.move(root, 'gone', firstId, 'right'), root);
  assert.strictEqual(L.move(root, firstId, root.b.id, 'middle'), root, 'only the four edges are drops');
  assert.strictEqual(L.move(root, firstId, root.b.id, undefined), root);
  const lone = L.create('t1');
  assert.strictEqual(L.move(lone, lone.id, lone.id, 'right'), lone);
  assert.strictEqual(L.move(null, 'a', 'b', 'right'), null);
});

test('move() never mutates the tree it was given', () => {
  const L = loadLayout();
  const { root, firstId } = twoPanes(L);
  const before = JSON.stringify(L.serialize(root));
  L.move(root, firstId, root.b.id, 'bottom');
  assert.strictEqual(JSON.stringify(L.serialize(root)), before);
});

// --- a pane holds a group of tasks ------------------------------------------

// The model runs in its own realm, so a group is copied into this one before
// it is compared: a sandbox array is not deep-equal to a literal here.
const ids = (node) => Array.from(node.taskIds);
const plain = (node) => JSON.parse(JSON.stringify(node));

function grouped(L) {
  // Two panes, the first holding three tasks and showing the middle one.
  let root = L.create('t1');
  const first = root.id;
  root = L.split(root, first, 'row', 't9');
  root = L.addTask(root, first, 't2');
  root = L.addTask(root, first, 't3');
  root = L.setActive(root, first, 't2');
  return { root, first, second: L.panes(root)[1].id };
}

test('create() opens a pane whose group is the one task it shows', () => {
  const L = loadLayout();
  assert.deepStrictEqual(ids(L.create('t1')), ['t1']);
  assert.deepStrictEqual(ids(L.create(null)), []);
  assert.strictEqual(L.create(null).taskId, null);
  assert.deepStrictEqual(ids(L.create(7)), ['7'], 'a task id is a string here as it is everywhere else');
});

test('addTask() puts a task in a pane and brings it forward', () => {
  const L = loadLayout();
  let root = L.create('t1');
  const first = root.id;
  root = L.split(root, first, 'row', 't9');
  const next = L.addTask(root, first, 't2');
  const pane = L.find(next, first);
  assert.deepStrictEqual(ids(pane), ['t1', 't2']);
  assert.strictEqual(pane.taskId, 't2', 'the task that arrived is the one on screen');
  assert.deepStrictEqual(ids(L.find(root, first)), ['t1'], 'the input tree is never mutated');
});

test('addTask() on a task the pane already holds only activates it', () => {
  const L = loadLayout();
  const { root, first } = grouped(L);
  const next = L.addTask(root, first, 't3');
  assert.strictEqual(L.find(next, first).taskId, 't3');
  assert.deepStrictEqual(ids(L.find(next, first)), ['t1', 't2', 't3'], 'and never twice');
  assert.strictEqual(L.addTask(root, first, 't2'), root, 'the task it already shows changes nothing');
});

test('addTask() takes a task out of the pane that had it, and closes that pane when it empties', () => {
  const L = loadLayout();
  const { root, first, second } = grouped(L);
  const next = L.addTask(root, first, 't9');
  assert.strictEqual(next.type, 'pane', 'the pane t9 left behind was its last, so the split collapsed');
  assert.strictEqual(next.id, first);
  assert.deepStrictEqual(ids(next), ['t1', 't2', 't3', 't9']);
  assert.strictEqual(L.find(next, second), null);
});

test('addTask() moves a task between groups without closing a pane that still holds one', () => {
  const L = loadLayout();
  const { root, first, second } = grouped(L);
  const next = L.addTask(root, second, 't2');
  assert.deepStrictEqual(ids(L.find(next, second)), ['t9', 't2']);
  assert.deepStrictEqual(ids(L.find(next, first)), ['t1', 't3']);
  assert.strictEqual(L.find(next, first).taskId, 't3', 'the tab after the one that left takes over');
});

test('addTask() ignores a missing pane and a null task', () => {
  const L = loadLayout();
  const { root, first } = grouped(L);
  assert.strictEqual(L.addTask(root, 'nope', 't7'), root);
  assert.strictEqual(L.addTask(root, first, null), root);
  assert.strictEqual(L.addTask(null, first, 't7'), null);
});

test('removeTask() hands the pane the next task, or the previous one at the end', () => {
  const L = loadLayout();
  const { root, first } = grouped(L);
  const middle = L.removeTask(root, 't2');
  assert.deepStrictEqual(ids(L.find(middle, first)), ['t1', 't3']);
  assert.strictEqual(L.find(middle, first).taskId, 't3', 'the tab after the one that went');

  const last = L.removeTask(L.setActive(root, first, 't3'), 't3');
  assert.strictEqual(L.find(last, first).taskId, 't2', 'the tab before it, when it was the last');

  const quiet = L.removeTask(root, 't1');
  assert.strictEqual(L.find(quiet, first).taskId, 't2', 'removing a tab that was not on screen changes nothing else');
  assert.strictEqual(L.removeTask(root, 'never-here'), root);
});

test('removeTask() closes a pane whose group it emptied', () => {
  const L = loadLayout();
  const { root, first, second } = grouped(L);
  const next = L.removeTask(root, 't9');
  assert.strictEqual(next.type, 'pane');
  assert.strictEqual(next.id, first);
  assert.strictEqual(L.find(next, second), null);
  const lone = L.create('t1');
  assert.strictEqual(L.removeTask(lone, 't1'), null, 'the last task of the last pane is no layout at all');
});

test('setActive() ignores a task that is not in the group', () => {
  const L = loadLayout();
  const { root, first, second } = grouped(L);
  assert.strictEqual(L.setActive(root, first, 't9'), root, 't9 is in the other pane');
  assert.strictEqual(L.setActive(root, first, 'nope'), root);
  assert.strictEqual(L.setActive(root, 'nope', 't2'), root);
  assert.strictEqual(L.setActive(root, first, 't2'), root, 'the task already on screen is not a change');
  assert.strictEqual(L.setActive(root, second, 't9'), root);
  assert.strictEqual(L.find(L.setActive(root, first, 't1'), first).taskId, 't1');
  assert.deepStrictEqual(ids(L.find(L.setActive(root, first, 't1'), first)), ['t1', 't2', 't3'],
    'activating never reorders the group');
});

test('swapTask() keeps the task position and whether it was on screen', () => {
  const L = loadLayout();
  const { root, first } = grouped(L);
  const shown = L.swapTask(root, 't2', 'fresh');
  assert.deepStrictEqual(ids(L.find(shown, first)), ['t1', 'fresh', 't3'], 'the restart keeps its place');
  assert.strictEqual(L.find(shown, first).taskId, 'fresh', 'and stays the tab on screen');

  const behind = L.swapTask(root, 't3', 'fresh');
  assert.deepStrictEqual(ids(L.find(behind, first)), ['t1', 't2', 'fresh']);
  assert.strictEqual(L.find(behind, first).taskId, 't2', 'a tab that was not on screen does not steal it');

  assert.strictEqual(L.swapTask(root, 'never-here', 'fresh'), root);
  assert.strictEqual(L.swapTask(root, 't2', null), root);
  assert.strictEqual(L.swapTask(root, 't2', 't2'), root);
});

test('swapTask() never leaves a task in two panes', () => {
  const L = loadLayout();
  const { root, first, second } = grouped(L);
  const next = L.swapTask(root, 't2', 't9');
  assert.deepStrictEqual(ids(L.find(next, first)), ['t1', 't9', 't3']);
  assert.strictEqual(L.find(next, second), null, 't9 left a pane that held nothing else');
});

test('serialize() writes the group, and parse() reads both stored shapes', () => {
  const L = loadLayout();
  const { root, first } = grouped(L);
  const stored = JSON.parse(JSON.stringify(L.serialize(root)));
  assert.deepStrictEqual(Array.from(stored.a.taskIds), ['t1', 't2', 't3']);
  assert.strictEqual(stored.a.taskId, 't2');
  assert.deepStrictEqual(plain(L.parse(stored)), plain(root), 'a stored group round trips');

  // The shape already in people's browsers: one task, no group.
  const v1 = L.parse({ type: 'pane', id: 'aaaaaaaaaaaa', taskId: 't1' });
  assert.deepStrictEqual(plain(v1), { type: 'pane', id: 'aaaaaaaaaaaa', taskIds: ['t1'], taskId: 't1' });
  assert.deepStrictEqual(plain(L.parse({ type: 'pane', id: 'aaaaaaaaaaaa', taskId: null })),
    { type: 'pane', id: 'aaaaaaaaaaaa', taskIds: [], taskId: null });
  assert.strictEqual(L.find(L.parse(stored), first).taskId, 't2');
});

test('parse() cleans a group up rather than trusting it', () => {
  const L = loadLayout();
  const odd = L.parse({ type: 'pane', id: 'aaaaaaaaaaaa', taskIds: ['t1', 7, 't1', '', 't2'], taskId: 'gone' });
  assert.deepStrictEqual(ids(odd), ['t1', 't2'], 'non-strings and repeats are not tasks');
  assert.strictEqual(odd.taskId, 't1', 'an active task outside the group falls back to the first');
  const empty = L.parse({ type: 'pane', id: 'bbbbbbbbbbbb', taskIds: [], taskId: 't1' });
  assert.deepStrictEqual(ids(empty), []);
  assert.strictEqual(empty.taskId, null, 'an empty pane shows nothing');
});

test('prune() trims a group and replaces an active task it dropped', () => {
  const L = loadLayout();
  const { root, first, second } = grouped(L);
  const pruned = L.prune(root, ['t1', 't3', 't9']);
  assert.deepStrictEqual(ids(L.find(pruned, first)), ['t1', 't3']);
  assert.strictEqual(L.find(pruned, first).taskId, 't1', 't2 is gone, so the pane shows what is left');
  assert.strictEqual(L.find(pruned, second).taskId, 't9', 'a pane that lost nothing is untouched');
  assert.strictEqual(L.prune(root, ['t1', 't2', 't3', 't9']), root);

  const gone = L.prune(root, ['t2']);
  assert.strictEqual(gone.type, 'pane');
  assert.deepStrictEqual(ids(gone), ['t2'], 'the pane whose group emptied took its split with it');
});

// --- what a stored tree is allowed to say -----------------------------------

test('parse() never lets one task end up in two panes', () => {
  const L = loadLayout();
  const shared = L.parse({
    type: 'split', id: 'ssssssssssss', dir: 'row', ratio: 0.5,
    a: { type: 'pane', id: 'aaaaaaaaaaaa', taskIds: ['t1', 't2'], taskId: 't1' },
    b: { type: 'pane', id: 'bbbbbbbbbbbb', taskIds: ['t2', 't3'], taskId: 't2' },
  });
  assert.deepStrictEqual(Array.from(L.panes(shared), (p) => Array.from(p.taskIds)),
    [['t1', 't2'], ['t3']], 'the pane that saw the task first keeps it');
  assert.strictEqual(L.find(shared, 'bbbbbbbbbbbb').taskId, 't3',
    'and the pane that gave it up shows what it still has');

  // Two xterms and two live sockets for one task, with only the first ever
  // findable again, so the pane that has nothing left of its own goes.
  const doubled = L.parse({
    type: 'split', id: 'ssssssssssss', dir: 'row', ratio: 0.5,
    a: { type: 'pane', id: 'aaaaaaaaaaaa', taskIds: ['t1'], taskId: 't1' },
    b: { type: 'pane', id: 'bbbbbbbbbbbb', taskIds: ['t1'], taskId: 't1' },
  });
  assert.strictEqual(doubled.type, 'pane', 'the split closed over the pane that emptied');
  assert.strictEqual(doubled.id, 'aaaaaaaaaaaa');
  assert.deepStrictEqual(Array.from(doubled.taskIds), ['t1']);
});

test('parse() drops every pane a repeat emptied, however deep', () => {
  const L = loadLayout();
  const back = L.parse({
    type: 'split', id: 'ssssssssssss', dir: 'row', ratio: 0.5,
    a: { type: 'pane', id: 'aaaaaaaaaaaa', taskIds: ['t1'], taskId: 't1' },
    b: {
      type: 'split', id: 'tttttttttttt', dir: 'col', ratio: 0.5,
      a: { type: 'pane', id: 'bbbbbbbbbbbb', taskIds: ['t1'], taskId: 't1' },
      b: { type: 'pane', id: 'cccccccccccc', taskIds: ['t1'], taskId: 't1' },
    },
  });
  assert.strictEqual(back.type, 'pane');
  assert.strictEqual(back.id, 'aaaaaaaaaaaa');
  assert.strictEqual(L.parse({
    type: 'split', id: 'ssssssssssss', dir: 'row', ratio: 0.5,
    a: { type: 'pane', id: 'aaaaaaaaaaaa', taskIds: ['t1'], taskId: 't1' },
    b: { type: 'pane', id: 'bbbbbbbbbbbb', taskIds: ['t1'], taskId: 't1', junk: 1 },
  }).type, 'pane', 'dropping a pane is not the same as refusing the tree');
});

test('parse() refuses a tree too deep to walk rather than overflowing', () => {
  const L = loadLayout();
  assert.strictEqual(L.MAX_DEPTH, 64);
  let node = { type: 'pane', id: 'p0', taskIds: ['t0'], taskId: 't0' };
  for (let i = 1; i <= 5000; i += 1) {
    node = {
      type: 'split', id: 's' + i, dir: 'row', ratio: 0.5, a: node,
      b: { type: 'pane', id: 'p' + i, taskIds: ['t' + i], taskId: 't' + i },
    };
  }
  assert.strictEqual(L.parse(node), null, 'a stored tree past the bound is not a layout');

  // And a tree inside the bound is still read in full.
  let ok = { type: 'pane', id: 'q0', taskIds: ['u0'], taskId: 'u0' };
  for (let i = 1; i <= 5; i += 1) {
    ok = {
      type: 'split', id: 'r' + i, dir: 'row', ratio: 0.5, a: ok,
      b: { type: 'pane', id: 'q' + i, taskIds: ['u' + i], taskId: 'u' + i },
    };
  }
  assert.strictEqual(L.panes(L.parse(ok)).length, 6);
});

test('parse() caps a stored group the way addTask does', () => {
  const L = loadLayout();
  const many = Array.from({ length: 30 }, (unused, i) => 't' + i);
  const back = L.parse({ type: 'pane', id: 'aaaaaaaaaaaa', taskIds: many, taskId: many[0] });
  assert.strictEqual(back.taskIds.length, L.MAX_GROUP, 'a stored group is no bigger than one a person can build');
});

test('addTask() refuses a full pane rather than growing without bound', () => {
  const L = loadLayout();
  assert.strictEqual(L.MAX_GROUP, 8);
  let root = L.create('t0');
  const pane = root.id;
  for (let i = 1; i < L.MAX_GROUP; i += 1) root = L.addTask(root, pane, 't' + i);
  assert.strictEqual(ids(root).length, L.MAX_GROUP);

  const full = L.addTask(root, pane, 'one-too-many');
  assert.strictEqual(full, root, 'a full pane takes nothing and says so by not changing');
  assert.strictEqual(L.setActive(root, pane, 't3').taskId, 't3', 'and the tabs it has still work');
});

test('_ids() reads a pane stored before groups existed', () => {
  const L = loadLayout();
  assert.deepStrictEqual(Array.from(L._ids({ type: 'pane', id: 'a', taskId: 't1' })), ['t1'],
    'a node with no group still holds one task, which is what the restore counts');
  assert.deepStrictEqual(Array.from(L._ids({ type: 'pane', id: 'a', taskId: null })), []);
});

// --- merging one pane into another ------------------------------------------

test('mergePane() appends the whole group and collapses the split behind it', () => {
  const L = loadLayout();
  const { root, first, second } = grouped(L);
  const merged = L.mergePane(root, first, second);
  assert.strictEqual(merged.type, 'pane', 'two panes became one');
  assert.strictEqual(merged.id, second, 'the pane dropped onto is the one that stays');
  assert.deepStrictEqual(ids(merged), ['t9', 't1', 't2', 't3'], 'the group arrives in order, at the end');
  assert.strictEqual(merged.taskId, 't9', 'the target keeps showing what it was showing');
  assert.deepStrictEqual(ids(L.find(root, first)), ['t1', 't2', 't3'], 'the input tree is never mutated');
});

test('mergePane() leaves the rest of a deeper tree alone', () => {
  const L = loadLayout();
  let root = L.create('t1');
  const first = root.id;
  root = L.split(root, first, 'row', 't2');
  const second = root.b.id;
  root = L.split(root, second, 'col', 't3');
  const third = L.panes(root)[2].id;
  const merged = L.mergePane(root, third, first);
  assert.deepStrictEqual(Array.from(L.panes(merged), (p) => Array.from(p.taskIds)), [['t1', 't3'], ['t2']]);
  assert.strictEqual(merged.type, 'split');
  assert.strictEqual(merged.b.type, 'pane', 'the split the source left behind collapsed');
});

test('mergePane() refuses a no-op and a merge that would not fit', () => {
  const L = loadLayout();
  const { root, first, second } = grouped(L);
  assert.strictEqual(L.mergePane(root, first, first), root, 'a pane cannot merge into itself');
  assert.strictEqual(L.mergePane(root, 'gone', second), root);
  assert.strictEqual(L.mergePane(root, first, 'gone'), root);
  assert.strictEqual(L.mergePane(null, first, second), null);
  const lone = L.create('t1');
  assert.strictEqual(L.mergePane(lone, lone.id, lone.id), lone, 'the only pane has nowhere to go');

  // Six and three do not fit in eight, and tasks are never dropped to make
  // them fit.
  let big = L.create('a0');
  const bigId = big.id;
  for (let i = 1; i < 6; i += 1) big = L.addTask(big, bigId, 'a' + i);
  big = L.split(big, bigId, 'row', 'b0');
  const other = L.panes(big)[1].id;
  big = L.addTask(big, other, 'b1');
  big = L.addTask(big, other, 'b2');
  assert.strictEqual(L.mergePane(big, other, bigId), big, 'nine tasks in one pane is refused outright');
});
