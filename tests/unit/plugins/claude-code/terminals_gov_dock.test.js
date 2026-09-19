/** Governance activity as a resizable right column.
 *
 * It used to be a fixed right column of 230-285px that was always there, even
 * with nothing attached, and the <details> around it promised a collapse that
 * only shortened its content: the grid column kept its width either way. On a
 * 1200px window that left the terminal about 600px.
 *
 * It is a right column again, because a trace reads best beside the thing it
 * traces, but not that one: the width is dragged by the column's left edge and
 * persisted, and a collapse takes the column down to a narrow vertical strip
 * that genuinely returns the width to the panes while keeping the panel named
 * beside a dedicated edge toggle. These tests pin that, plus the four-way
 * task/choice state and the persistence, because each of the old faults was
 * invisible to the suite that shipped them.
 *
 * DOM stub mirrors terminals_context_cost.test.js / terminals_pane.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

function makeEl(extra = {}) {
  const classes = new Set();
  const listeners = {};
  return Object.assign({
    innerHTML: '',
    textContent: '',
    className: '',
    hidden: false,
    disabled: false,
    dataset: {},
    style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) { (this.attrs || (this.attrs = {}))[k] = v; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    dispatch(t, event = {}) { for (const fn of [...(listeners[t] || [])]) fn(event); },
    _listeners: listeners,
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
    isConnected: true,
  }, extra);
}

function memStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

/** The workspace row, with a width the clamp can measure against. */
function workspaceEl(width = 1200) {
  return makeEl({ getBoundingClientRect: () => ({ left: 60, right: 60 + width, width, height: 800 }) });
}

function dockEls() {
  return {
    'terminals-governance': makeEl(),
    'terminals-gov-edge': makeEl(),
    'terminals-gov-gutter': makeEl(),
    'terminals-governance-toggle': makeEl(),
    'terminals-governance-head': makeEl(),
    'terminals-governance-body': makeEl(),
  };
}

function loadPage(elements, extra = {}) {
  const window = {};
  const ws = extra.workspace || workspaceEl();
  const sandbox = Object.assign({
    window,
    document: {
      getElementById: (id) => elements[id] || (elements[id] = makeEl()),
      querySelector: (sel) => (sel === '.terminals-workspace' ? ws : null),
    },
    API: {},
    URLSearchParams,
    WebSocket: { OPEN: 1, CLOSED: 3 },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    localStorage: extra.localStorage || memStore(),
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    console: { warn() {}, error() {} },
  }, extra);
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  vm.runInNewContext(read('js/pages/terminals.js'), sandbox);
  return sandbox.window.TerminalsPage;
}

// --------------------------------------------------------------- structure

test('the column is the pane area\'s right sibling, with one edge wrapper between them', () => {
  const src = read('js/pages/terminals.js');
  const open = src.indexOf('<div class="terminals-workspace">');
  const centre = src.indexOf('<section class="terminals-centre">', open);
  const edge = src.indexOf('<div class="terminals-gov-edge" id="terminals-gov-edge">', open);
  const gutter = src.indexOf('id="terminals-gov-gutter"', open);
  const toggle = src.indexOf('id="terminals-governance-toggle"', open);
  const dock = src.indexOf('<section class="terminals-governance" id="terminals-governance">', open);
  assert.ok(open > 0 && centre > open, 'the pane area opens the workspace');
  assert.ok(edge > centre, 'the edge wrapper comes after the pane area');
  assert.ok(gutter > edge && toggle > gutter, 'separator and toggle are separate controls inside the edge');
  assert.ok(dock > toggle, 'the column comes after the edge, so it sits to the right of the panes');
  const edgeMarkup = src.slice(edge, dock);
  assert.doesNotMatch(edgeMarkup, /role="separator"[^>]*>\s*<button/,
    'the real button must not be nested inside the focusable separator');
  // The old markup was a <details>, whose collapse could not reclaim the grid
  // column it lived in. Nothing should bring it back.
  assert.ok(!/<details class="terminals-governance"/.test(src),
    'the column is no longer a <details>: its collapse has to reclaim real space');
});

test('the workspace lays out in a row, and no fixed governance column survives', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-workspace \{ display: flex; flex-direction: row; min-width: 0; min-height: 0; \}/);
  assert.ok(!/\.terminals-workspace \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(230px, 285px\)/.test(css),
    'no fixed 230-285px governance column survives');
  assert.match(css, /\.terminals-workspace > \.terminals-centre \{ flex: 1 1 auto; min-width: 420px; min-height: 0; \}/,
    'desktop panes retain the same 420px floor used by the JavaScript clamp');
});

test('the column width is one variable, and collapsing drops it to the strip', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-governance \{[^}]*width: var\(--gov-w, 320px\)/);
  assert.match(css, /\.terminals-governance\.is-collapsed \{ width: 34px; \}/,
    'collapsed is a narrow strip, not a shortened body inside a kept column');
  assert.ok(!/\.terminals-governance\.is-collapsed \{ width: 0/.test(css),
    'the strip is never zero width: the person has to be able to find it again');
  assert.match(css, /\.terminals-governance-body\[hidden\] \{ display: none; \}/,
    'the body is a grid, so [hidden] needs saying out loud or it keeps its size');
  assert.match(css, /\.terminals-gov-gutter \{[^}]*cursor: col-resize/);
  assert.match(css, /\.terminals-gov-edge \{[^}]*flex: 0 0 12px; width: 12px; min-width: 12px/,
    'the measured 12px gutter is owned by one explicit edge wrapper');
  assert.match(css, /\.terminals-gov-gutter\[hidden\] \{ display: none; \}/);
});

test('the collapsed strip shows a static vertical name while the edge owns the control', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-governance\.is-collapsed \.terminals-governance-name \{[^}]*writing-mode: vertical-rl/,
    'the name runs down the strip rather than disappearing');
  assert.match(css, /\.terminals-governance\.is-collapsed \.terminals-governance-head \{[^}]*flex: 1 1 auto/);
  assert.match(css, /\.terminals-governance-toggle \{[^}]*position: absolute;[^}]*top: 50%;[^}]*left: 50%/,
    'the independent button is centered on the panel edge');
  // The body is what goes away, not the static panel name or edge control.
  assert.match(css, /\.terminals-governance\.is-collapsed \.terminals-governance-summary \{ display: none; \}/);
});

test('the governance body is a single column, sized for the narrow panel', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-governance-body \{[^}]*grid-template-columns: minmax\(0, 1fr\)/,
    'one column: an auto-fit track with a 320px floor overflows a 320px panel');
  assert.ok(!/\.terminals-governance-body \{[^}]*repeat\(auto-fit, minmax\(320px/.test(css),
    'the full-width grid was for the bottom dock and does not fit a column');
});

test('the narrow layout still stacks into one usable column', () => {
  const css = read('css/styles.css');
  const mq = css.slice(css.indexOf('@media (max-width: 760px) { .terminals-page'));
  const block = mq.slice(0, mq.indexOf('\n'));
  assert.match(block, /\.terminals-gov-gutter \{ display: none; \}/,
    'nothing to drag when the page scrolls instead of filling the viewport');
  assert.match(block, /\.terminals-workspace \{ flex-direction: column; \}/,
    'the row becomes a stack, so the column becomes a band under the panes');
  assert.match(block, /\.terminals-workspace > \.terminals-centre \{ min-width: 0; \}/,
    'the desktop pane floor is explicitly released in the stacked layout');
  assert.match(block, /\.terminals-gov-edge \{ flex: 0 0 0; width: auto; min-width: 0; height: 0; \}/,
    'the edge becomes a zero-height boundary rather than a vertical column');
  assert.match(block, /\.terminals-governance \{ width: auto; min-width: 0; max-height: 60vh; margin-top: 12px; \}/);
  assert.match(block, /\.terminals-governance\.is-collapsed \{ width: auto; \}/,
    'a 34px strip beside nothing is not a layout');
  assert.match(block, /\.terminals-governance\.is-collapsed \.terminals-governance-name \{[^}]*writing-mode: horizontal-tb/,
    'and the name reads across again once it is a band');
  assert.match(block, /\.terminals-centre \{ min-height: 460px; \}/);
});

test('measured-workspace stacking uses the same zero-width boundary treatment', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-workspace\.is-gov-stacked \{ flex-direction: column; \}/);
  assert.match(css, /\.terminals-workspace\.is-gov-stacked > \.terminals-centre \{ width: 100%; min-width: 0; \}/);
  assert.match(css, /\.terminals-workspace\.is-gov-stacked \.terminals-gov-edge \{ flex: 0 0 0; width: auto; min-width: 0; height: 0; \}/);
  assert.match(css, /\.terminals-workspace\.is-gov-stacked \.terminals-gov-gutter \{ display: none; \}/);
  assert.match(css, /\.terminals-workspace\.is-gov-stacked \.terminals-governance \{ width: auto; min-width: 0;/);
});

// ------------------------------------------------------------ four-way state

test('with no task attached the column is still expanded', () => {
  const els = dockEls();
  const Page = loadPage(els);
  Page._bindGovDock();
  // The activity is the point of the page. A panel that hides itself until a
  // task attaches is a panel people never learn they have.
  assert.ok(!els['terminals-governance'].classList.contains('is-collapsed'),
    'governance opens expanded on an empty board');
  assert.strictEqual(els['terminals-governance-body'].hidden, false);
  assert.strictEqual(els['terminals-gov-gutter'].hidden, false, 'expanded means resizable');
  assert.strictEqual(els['terminals-governance-toggle'].attrs['aria-expanded'], 'true');
  assert.strictEqual(els['terminals-governance'].style.props['--gov-w'], '320px',
    'an expanded column reserves its width from the first paint');
  assert.strictEqual(els['terminals-governance-toggle'].hidden, false,
    'the toggle stays on screen and stays clickable');
});

test('attaching and detaching a task never moves the column on their own', () => {
  const els = dockEls();
  const Page = loadPage(els);
  Page._bindGovDock();
  Page._attached = 't1';
  Page._syncGovDock();
  assert.ok(!els['terminals-governance'].classList.contains('is-collapsed'));
  assert.strictEqual(els['terminals-governance-body'].hidden, false);
  assert.strictEqual(els['terminals-gov-gutter'].hidden, false);
  assert.strictEqual(els['terminals-governance-toggle'].attrs['aria-expanded'], 'true');
  assert.strictEqual(els['terminals-governance'].style.props['--gov-w'], '320px');

  // Detaching used to collapse it. The column no longer opens and shuts under
  // the operator as tasks come and go; only the toggle moves it.
  Page._attached = null;
  Page._syncGovDock();
  assert.ok(!els['terminals-governance'].classList.contains('is-collapsed'),
    'the last task leaving does not shut the panel');
  assert.strictEqual(els['terminals-governance-body'].hidden, false);
});

test('an explicit collapse wins over the attach, and an explicit expand over the empty board', () => {
  const els = dockEls();
  const Page = loadPage(els);
  Page._bindGovDock();
  Page._attached = 't1';
  Page._syncGovDock();
  Page._toggleGovDock();                       // the person collapses it
  assert.ok(els['terminals-governance'].classList.contains('is-collapsed'));
  Page._syncGovDock();                         // a later refresh must not undo that
  assert.ok(els['terminals-governance'].classList.contains('is-collapsed'),
    'their choice wins while a task is attached');
  Page._attached = null;
  Page._syncGovDock();
  assert.ok(els['terminals-governance'].classList.contains('is-collapsed'),
    'and it still wins once the task detaches');

  const els2 = dockEls();
  const Page2 = loadPage(els2);
  Page2._bindGovDock();
  Page2._toggleGovDock();                      // collapsed away from the default
  assert.ok(els2['terminals-governance'].classList.contains('is-collapsed'));
  Page2._toggleGovDock();                      // and opened again
  assert.ok(!els2['terminals-governance'].classList.contains('is-collapsed'));
  Page2._syncGovDock();
  assert.ok(!els2['terminals-governance'].classList.contains('is-collapsed'),
    'the toggle is a real control, not a suggestion');
});

// ---------------------------------------------------------------- resizing

test('the gutter drag clamps so neither the panes nor the column go unusable', () => {
  const els = dockEls();
  const Page = loadPage(els, { workspace: workspaceEl(1200) });   // left 60, right 1260
  Page._bindGovDock();
  Page._attached = 't1';
  Page._syncGovDock();

  Page._setGovWidth(500);
  assert.strictEqual(Page._govWidth, 500);
  // Dragged to the right edge: the column keeps its minimum.
  Page._setGovWidth(10);
  assert.strictEqual(Page._govWidth, Page.GOV_MIN_W);
  // Dragged to the left edge: the panes keep theirs.
  Page._setGovWidth(5000);
  const exactMax = 1200 - Page.PANE_MIN_W - Page.GOV_GUTTER_W;
  assert.strictEqual(Page.GOV_GUTTER_W, 12);
  assert.strictEqual(Page._govWidth, exactMax);
  assert.strictEqual(els['terminals-governance'].style.props['--gov-w'], exactMax + 'px');
});

test('the governance clamp reserves the full recursive pane tree', () => {
  const els = dockEls();
  const Page = loadPage(els, { workspace: workspaceEl(1200) });
  const L = Page._lay();
  let tree = L.create('t1');
  tree = L.split(tree, tree.id, 'row', 't2');
  Page._layout = tree;
  Page._bindGovDock();

  Page._setGovWidth(5000);
  const treeFloor = 2 * Page.PANE_USABLE_W + Page.GUTTER_W;
  assert.strictEqual(Page._treeMinWidth(tree), treeFloor);
  assert.strictEqual(Page._govWidth, 1200 - treeFloor - Page.GOV_GUTTER_W,
    'governance leaves enough room for both horizontal leaves, not just the legacy 420px floor');
});

test('actual workspace width stacks governance and restores the row when space returns', () => {
  let width = 900;
  const ws = workspaceEl();
  ws.getBoundingClientRect = () => ({ left: 0, right: width, width, height: 800 });
  let observer;
  class MockResizeObserver {
    constructor(cb) { this.cb = cb; observer = this; }
    observe(el) { this.observed = el; }
    disconnect() { this.disconnected = true; }
  }
  const els = dockEls();
  const Page = loadPage(els, { workspace: ws, ResizeObserver: MockResizeObserver });
  const L = Page._lay();
  let tree = L.create('t1');
  tree = L.split(tree, tree.id, 'row', 't2');
  Page._layout = tree;
  Page._panes = new Map(L.panes(tree).map((pane) => [pane.id, { id: pane.id, taskId: pane.taskId }]));
  Page._focused = tree.a.id;
  Page._bindGovDock();

  assert.ok(ws.classList.contains('is-gov-stacked'), '900px cannot hold 686px panes + edge + governance');
  assert.strictEqual(Page._govStacked, true);
  assert.strictEqual(Page._availablePaneWidth(), 900, 'stacked panes receive the full workspace width');
  assert.strictEqual(els['terminals-gov-gutter'].hidden, true);
  const preferred = Page._govWidth;

  width = 1000;
  observer.cb();
  assert.ok(!ws.classList.contains('is-gov-stacked'), 'the row returns after the container grows');
  assert.strictEqual(Page._govStacked, false);
  assert.strictEqual(els['terminals-gov-gutter'].hidden, false);
  assert.ok(Page._govWidth <= preferred, 'the restored row clamps only after it has enough room');
  assert.strictEqual(Page._availablePaneWidth(), 686, 'the recovered row still reserves the full tree minimum');

  Page.destroy();
  assert.strictEqual(observer.disconnected, true, 'destroy disconnects the workspace observer');
});

test('governance drag cancellation and lost capture remove every listener without persisting', () => {
  const listeners = {};
  const win = {
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
  };
  const store = memStore();
  const els = dockEls();
  const gutter = els['terminals-gov-gutter'];
  gutter.setPointerCapture = () => {};
  gutter.releasePointerCapture = () => {};
  const Page = loadPage(els, { window: win, localStorage: store, workspace: workspaceEl(1200) });
  Page._attached = 't1';
  Page._bindGovDock();
  const start = Page._govWidth;

  Page._startGovDrag({ currentTarget: gutter, pointerId: 7, button: 0, preventDefault() {} });
  listeners.pointermove[0]({ clientX: 800 });
  assert.notStrictEqual(Page._govWidth, start);
  gutter.dispatch('lostpointercapture');
  assert.strictEqual(Page._govWidth, start, 'lost capture rolls back the uncommitted width');
  assert.strictEqual(Page._govDrag, null);
  for (const type of ['pointermove', 'pointerup', 'pointercancel']) {
    assert.strictEqual((listeners[type] || []).length, 0, `${type} survives lost capture`);
  }
  assert.strictEqual(gutter._listeners.lostpointercapture.length, 0);
  assert.strictEqual(store.getItem(Page.GOV_KEY), null, 'cancellation never persists a transient width');

  Page._startGovDrag({ currentTarget: gutter, pointerId: 8, button: 0, preventDefault() {} });
  listeners.pointermove[0]({ clientX: 760 });
  Page._startGovDrag({ currentTarget: gutter, pointerId: 9, button: 0, preventDefault() {} });
  assert.strictEqual((listeners.pointermove || []).length, 1, 'a new gesture cancels rather than stacking on the old one');
  assert.strictEqual(gutter._listeners.lostpointercapture.length, 1);
  listeners.pointermove[0]({ clientX: 740 });
  Page.destroy();
  assert.strictEqual(Page._govDrag, null, 'destroy cancels the gesture');
  assert.strictEqual(store.getItem(Page.GOV_KEY), null, 'destroy does not persist the stale drag width');
  assert.strictEqual((listeners.pointermove || []).length, 0);
  assert.strictEqual((listeners.pointerup || []).length, 0);
  assert.strictEqual((listeners.pointercancel || []).length, 0);

  const src = read('js/pages/terminals.js');
  const renderStart = src.slice(src.indexOf('async render(container)'), src.indexOf('container.innerHTML'));
  assert.match(renderStart, /this\._cancelGovDrag\(\)/, 'a same-route render cancels the old gesture too');
});

test('arrow keys move the column edge, which is the keyboard route to a resize', () => {
  const els = dockEls();
  const Page = loadPage(els);
  Page._bindGovDock();
  Page._attached = 't1';
  Page._syncGovDock();
  const start = Page._govWidth;
  let prevented = 0;
  // Left is the direction the edge moves, so left widens.
  Page._onGovKey({ key: 'ArrowLeft', preventDefault: () => { prevented += 1; } });
  assert.strictEqual(Page._govWidth, start + Page.GOV_STEP);
  Page._onGovKey({ key: 'ArrowRight', preventDefault: () => { prevented += 1; } });
  assert.strictEqual(Page._govWidth, start);
  assert.strictEqual(prevented, 2, 'the page must not scroll under the arrow keys');
  Page._onGovKey({ key: 'ArrowUp', preventDefault: () => { prevented += 1; } });
  Page._onGovKey({ key: 'Tab', preventDefault: () => { prevented += 1; } });
  assert.strictEqual(prevented, 2, 'every other key is left alone');
  assert.strictEqual(Page._govWidth, start);
});

test('double-clicking the gutter puts the column back to its default width', () => {
  const els = dockEls();
  const Page = loadPage(els);
  Page._bindGovDock();
  Page._attached = 't1';
  Page._syncGovDock();
  Page._setGovWidth(520);
  assert.strictEqual(Page._govWidth, 520);
  els['terminals-gov-gutter'].ondblclick();
  assert.strictEqual(Page._govWidth, Page.GOV_DEFAULT_W);
  assert.strictEqual(els['terminals-governance'].style.props['--gov-w'], Page.GOV_DEFAULT_W + 'px');
});

test('the edge has a separate named toggle and focusable resize separator', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /<div class="terminals-gov-edge" id="terminals-gov-edge">[\s\S]*?<button type="button" class="terminals-governance-toggle" id="terminals-governance-toggle" aria-expanded="true" aria-controls="terminals-governance-body" aria-label="Collapse governance activity">/);
  assert.match(src, /<div class="terminals-governance-head" id="terminals-governance-head">\s*<span class="terminals-governance-name">Governance activity<\/span>/,
    'the expanded header is a static title row, not a button');
  assert.match(src, /id="terminals-gov-gutter" role="separator" aria-orientation="vertical" aria-label="Resize the governance column" tabindex="0"/);
  const separator = src.match(/<div class="terminals-gov-gutter"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(separator && !separator[1].includes('<button'), 'the button is not nested in the separator');
});

test('edge toggle aria tracks both directions and the header does not toggle', () => {
  const els = dockEls();
  const Page = loadPage(els);
  const toggle = els['terminals-governance-toggle'];
  const head = els['terminals-governance-head'];
  Page._bindGovDock();
  assert.strictEqual(toggle.attrs['aria-expanded'], 'true');
  assert.strictEqual(toggle.attrs['aria-label'], 'Collapse governance activity');
  assert.strictEqual(head.onclick, undefined, 'the static title/summary row has no click handler');
  const beforeHeaderClick = Page._govCollapsed;
  if (head.onclick) head.onclick({ target: head });
  assert.strictEqual(Page._govCollapsed, beforeHeaderClick, 'clicking the header changes nothing');
  toggle.onclick();                            // the edge is the control
  assert.strictEqual(toggle.attrs['aria-expanded'], 'false');
  assert.strictEqual(toggle.attrs['aria-label'], 'Expand governance activity');
  assert.ok(els['terminals-governance'].classList.contains('is-collapsed'),
    'clicking the edge shuts the column');
  toggle.onclick();
  assert.strictEqual(toggle.attrs['aria-expanded'], 'true');
  assert.strictEqual(toggle.attrs['aria-label'], 'Collapse governance activity');
  assert.ok(!els['terminals-governance'].classList.contains('is-collapsed'));
});

// ------------------------------------------------------------- persistence

test('the width and the collapsed choice survive a reload', () => {
  const store = memStore();
  const els = dockEls();
  const Page = loadPage(els, { localStorage: store });
  Page._bindGovDock();
  Page._attached = 't1';
  Page._syncGovDock();
  Page._setGovWidth(330);
  Page._persistGov();
  Page._toggleGovDock();

  const saved = JSON.parse(store.getItem(Page.GOV_KEY));
  assert.strictEqual(saved.v, 2, 'the width shape is v: 2, so the old height shape cannot be read as one');
  assert.strictEqual(saved.w, 330);
  assert.strictEqual(saved.h, undefined, 'nothing claims to be a height any more');
  assert.strictEqual(saved.collapsed, true);
  assert.strictEqual(saved.userSet, true);

  // Same storage, fresh page object: the reload.
  const els2 = dockEls();
  const Page2 = loadPage(els2, { localStorage: store });
  Page2._bindGovDock();
  Page2._attached = 't1';
  Page2._syncGovDock();
  assert.strictEqual(Page2._govWidth, 330, 'the width came back');
  assert.ok(els2['terminals-governance'].classList.contains('is-collapsed'),
    'and so did the collapse, even though a task is attached');

  Page2._toggleGovDock();
  assert.ok(!els2['terminals-governance'].classList.contains('is-collapsed'));
  assert.strictEqual(els2['terminals-governance'].style.props['--gov-w'], '330px',
    'reopening restores the width that was stored, not the default');
});

test('a state written by something else, or by the bottom dock, is ignored rather than trusted', () => {
  const store = memStore();
  store.setItem('sv-terminals-gov', '{"v":99,"h":9,"collapsed":false,"userSet":true}');
  const els = dockEls();
  const Page = loadPage(els, { localStorage: store });
  Page._bindGovDock();
  assert.strictEqual(Page._govWidth, Page.GOV_DEFAULT_W);
  assert.ok(!els['terminals-governance'].classList.contains('is-collapsed'),
    'an unreadable state falls back to the expanded default');

  // The shape the bottom dock shipped. A 132px height read as a width would
  // be a column too narrow to read, so v: 1 is dropped, not mapped.
  store.setItem('sv-terminals-gov', '{"v":1,"h":132,"collapsed":false,"userSet":true}');
  const els1 = dockEls();
  const Page1 = loadPage(els1, { localStorage: store });
  Page1._bindGovDock();
  assert.strictEqual(Page1._govWidth, Page1.GOV_DEFAULT_W, 'a stored height is not a width');
  assert.strictEqual(Page1._govUserSet, false, 'and the choice that went with it is not carried over');
  assert.ok(!els1['terminals-governance'].classList.contains('is-collapsed'));

  store.setItem('sv-terminals-gov', 'not json');
  const els2 = dockEls();
  const Page2 = loadPage(els2, { localStorage: store });
  Page2._bindGovDock();
  assert.strictEqual(Page2._govWidth, Page2.GOV_DEFAULT_W);
});

// ------------------------------------------------------- content and wiring

test('every governance id the rest of the page queries still lives in the column', () => {
  const src = read('js/pages/terminals.js');
  const open = src.indexOf('<section class="terminals-governance" id="terminals-governance">');
  const body = src.slice(open, src.indexOf('</section>', open));
  for (const id of [
    'terminals-governance-summary', 'terminals-governance-body',
    'terminals-gov-hero', 'terminals-gov-hero-bot', 'terminals-gov-hero-title', 'terminals-gov-hero-text',
    'terminals-gov-context', 'terminals-context-stage', 'terminals-context',
    'terminals-verdicts', 'terminals-verdicts-count',
    'terminals-traces', 'terminals-traces-count', 'terminals-traces-all',
    'terminals-egress', 'terminals-egress-count',
    'terminals-approvals', 'terminals-approvals-count',
  ]) {
    assert.ok(body.includes(`id="${id}"`), `${id} must still be inside the column`);
  }
});

test('the approval Review button opens the column without recording a preference', () => {
  const els = dockEls();
  const Page = loadPage(els);
  Page._bindGovDock();
  Page._attached = 't1';
  Page._syncGovDock();
  Page._toggleGovDock();                       // the person collapsed it
  assert.strictEqual(Page._govUserSet, true);
  Page._expandGovDock();                       // Review needs the inbox on screen
  assert.ok(!els['terminals-governance'].classList.contains('is-collapsed'));
  assert.strictEqual(Page._govUserSet, false,
    'showing the inbox is the page acting, not the person choosing');
});
