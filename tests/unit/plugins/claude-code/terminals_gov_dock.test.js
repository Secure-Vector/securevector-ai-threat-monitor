/** Governance activity as a bottom dock.
 *
 * It used to be a fixed right column of 230-285px that was always there, even
 * with nothing attached, and the <details> around it promised a collapse that
 * only shortened its content: the grid column kept its width either way. On a
 * 1200px window that left the terminal about 600px, and width is the scarce
 * dimension for a terminal (wrapped output, broken diffs and tables) while the
 * governance lists read fine short and wide.
 *
 * So it docks along the bottom edge instead, full width, resizable by its top
 * edge and collapsible to its header strip, and a collapse genuinely returns
 * the space. These tests pin that, plus the four-way task/choice state and the
 * persistence, because each of the three faults above was invisible to the
 * suite that shipped them.
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

/** The workspace column, with a height the clamp can measure against. */
function workspaceEl(height = 800) {
  return makeEl({ getBoundingClientRect: () => ({ top: 100, bottom: 100 + height, height }) });
}

function dockEls() {
  return {
    'terminals-governance': makeEl(),
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
    console: { warn() {}, error() {} },
  }, extra);
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  vm.runInNewContext(read('js/pages/terminals.js'), sandbox);
  return sandbox.window.TerminalsPage;
}

// --------------------------------------------------------------- structure

test('the dock is a bottom sibling of the pane area, not a right column', () => {
  const src = read('js/pages/terminals.js');
  const open = src.indexOf('<div class="terminals-workspace">');
  const centre = src.indexOf('<section class="terminals-centre">', open);
  const gutter = src.indexOf('id="terminals-gov-gutter"', open);
  const dock = src.indexOf('<section class="terminals-governance" id="terminals-governance">', open);
  assert.ok(open > 0 && centre > open, 'the pane area opens the workspace');
  assert.ok(gutter > centre, 'the resize gutter comes after the pane area');
  assert.ok(dock > gutter, 'the dock comes after the gutter, so it sits beneath the panes');
  // The old markup was a <details>, whose collapse could not reclaim the grid
  // column it lived in. Nothing should bring it back.
  assert.ok(!/<details class="terminals-governance"/.test(src),
    'the dock is no longer a <details>: its collapse has to reclaim real space');
});

test('the workspace stacks instead of reserving a fixed right column', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-workspace \{ display: flex; flex-direction: column; min-width: 0; min-height: 0; \}/);
  assert.ok(!/\.terminals-workspace \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(230px, 285px\)/.test(css),
    'no fixed 230-285px governance column survives');
  assert.match(css, /\.terminals-workspace > \.terminals-centre \{ flex: 1 1 auto; min-height: 0; \}/,
    'the pane area takes the space the dock does not');
});

test('the dock height is one variable, and collapsing drops it', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-governance \{[^}]*height: var\(--gov-h, 240px\)/);
  assert.match(css, /\.terminals-governance\.is-collapsed \{ height: auto; margin-top: 12px; \}/,
    'collapsed is header-strip height, not a shortened body inside a kept column');
  assert.match(css, /\.terminals-governance-body\[hidden\] \{ display: none; \}/,
    'the body is a grid, so [hidden] needs saying out loud or it keeps its height');
  assert.match(css, /\.terminals-gov-gutter \{[^}]*cursor: row-resize/);
  assert.match(css, /\.terminals-gov-gutter\[hidden\] \{ display: none; \}/);
});

test('the narrow layout still stacks into one usable column', () => {
  const css = read('css/styles.css');
  const mq = css.slice(css.indexOf('@media (max-width: 760px) { .terminals-page'));
  const block = mq.slice(0, mq.indexOf('\n'));
  assert.match(block, /\.terminals-gov-gutter \{ display: none; \}/,
    'nothing to drag when the page scrolls instead of filling the viewport');
  assert.match(block, /\.terminals-governance \{ height: auto; max-height: 60vh; margin-top: 12px; \}/);
  assert.match(block, /\.terminals-centre \{ min-height: 460px; \}/);
});

// ------------------------------------------------------------ four-way state

test('with no task attached the dock is a header strip and reserves no body height', () => {
  const els = dockEls();
  const Page = loadPage(els);
  Page._bindGovDock();
  assert.ok(els['terminals-governance'].classList.contains('is-collapsed'));
  assert.strictEqual(els['terminals-governance-body'].hidden, true, 'no body, so no body height');
  assert.strictEqual(els['terminals-gov-gutter'].hidden, true, 'nothing to resize');
  assert.strictEqual(els['terminals-governance-toggle'].attrs['aria-expanded'], 'false');
  assert.strictEqual(els['terminals-governance'].style.props['--gov-h'], undefined,
    'a collapsed dock never writes a height for the panes to give up');
});

test('attaching a task expands the dock, and detaching collapses it again', () => {
  const els = dockEls();
  const Page = loadPage(els);
  Page._bindGovDock();
  Page._attached = 't1';
  Page._syncGovDock();
  assert.ok(!els['terminals-governance'].classList.contains('is-collapsed'));
  assert.strictEqual(els['terminals-governance-body'].hidden, false);
  assert.strictEqual(els['terminals-gov-gutter'].hidden, false);
  assert.strictEqual(els['terminals-governance-toggle'].attrs['aria-expanded'], 'true');
  assert.strictEqual(els['terminals-governance'].style.props['--gov-h'], '240px');

  Page._attached = null;
  Page._syncGovDock();
  assert.ok(els['terminals-governance'].classList.contains('is-collapsed'));
  assert.strictEqual(els['terminals-governance-body'].hidden, true);
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

  const els2 = dockEls();
  const Page2 = loadPage(els2);
  Page2._bindGovDock();
  Page2._toggleGovDock();                      // opened with nothing attached
  assert.ok(!els2['terminals-governance'].classList.contains('is-collapsed'));
  Page2._syncGovDock();
  assert.ok(!els2['terminals-governance'].classList.contains('is-collapsed'),
    'the toggle is a real control, not a suggestion');
});

// ---------------------------------------------------------------- resizing

test('the gutter drag clamps so neither the panes nor the dock go unusable', () => {
  const els = dockEls();
  const Page = loadPage(els, { workspace: workspaceEl(800) });   // top 100, bottom 900
  Page._bindGovDock();
  Page._attached = 't1';
  Page._syncGovDock();

  Page._setGovHeight(400);
  assert.strictEqual(Page._govHeight, 400);
  // Dragged to the floor: the dock keeps its minimum.
  Page._setGovHeight(10);
  assert.strictEqual(Page._govHeight, Page.GOV_MIN_H);
  // Dragged to the ceiling: the panes keep theirs.
  Page._setGovHeight(5000);
  assert.strictEqual(Page._govHeight, 800 - Page.PANE_MIN_H);
  assert.strictEqual(els['terminals-governance'].style.props['--gov-h'], (800 - Page.PANE_MIN_H) + 'px');
});

test('arrow keys move the dock edge, which is the keyboard route to a resize', () => {
  const els = dockEls();
  const Page = loadPage(els);
  Page._bindGovDock();
  Page._attached = 't1';
  Page._syncGovDock();
  const start = Page._govHeight;
  let prevented = 0;
  Page._onGovKey({ key: 'ArrowUp', preventDefault: () => { prevented += 1; } });
  assert.strictEqual(Page._govHeight, start + Page.GOV_STEP);
  Page._onGovKey({ key: 'ArrowDown', preventDefault: () => { prevented += 1; } });
  assert.strictEqual(Page._govHeight, start);
  assert.strictEqual(prevented, 2, 'the page must not scroll under the arrow keys');
  Page._onGovKey({ key: 'Tab', preventDefault: () => { prevented += 1; } });
  assert.strictEqual(prevented, 2, 'every other key is left alone');
});

test('the collapse control is a button with an accessible name, and the gutter is a focusable separator', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /<button type="button" class="terminals-governance-toggle" id="terminals-governance-toggle" aria-expanded="true" aria-controls="terminals-governance-body">/);
  assert.match(src, /<span>Governance activity<\/span><\/button>/,
    'the name is in the button, not only in the summary line beside it');
  assert.match(src, /id="terminals-gov-gutter" role="separator" aria-orientation="horizontal" aria-label="Resize the governance dock" tabindex="0"/);
});

// ------------------------------------------------------------- persistence

test('the height and the collapsed choice survive a reload', () => {
  const store = memStore();
  const els = dockEls();
  const Page = loadPage(els, { localStorage: store });
  Page._bindGovDock();
  Page._attached = 't1';
  Page._syncGovDock();
  Page._setGovHeight(330);
  Page._persistGov();
  Page._toggleGovDock();

  const saved = JSON.parse(store.getItem(Page.GOV_KEY));
  assert.strictEqual(saved.h, 330);
  assert.strictEqual(saved.collapsed, true);
  assert.strictEqual(saved.userSet, true);

  // Same storage, fresh page object: the reload.
  const els2 = dockEls();
  const Page2 = loadPage(els2, { localStorage: store });
  Page2._bindGovDock();
  Page2._attached = 't1';
  Page2._syncGovDock();
  assert.strictEqual(Page2._govHeight, 330, 'the height came back');
  assert.ok(els2['terminals-governance'].classList.contains('is-collapsed'),
    'and so did the collapse, even though a task is attached');

  Page2._toggleGovDock();
  assert.ok(!els2['terminals-governance'].classList.contains('is-collapsed'));
  assert.strictEqual(els2['terminals-governance'].style.props['--gov-h'], '330px',
    'reopening restores the height that was stored, not the default');
});

test('a dock state written by something else is ignored rather than trusted', () => {
  const store = memStore();
  store.setItem('sv-terminals-gov', '{"v":99,"h":9,"collapsed":false,"userSet":true}');
  const els = dockEls();
  const Page = loadPage(els, { localStorage: store });
  Page._bindGovDock();
  assert.strictEqual(Page._govHeight, Page.GOV_DEFAULT_H);
  assert.ok(els['terminals-governance'].classList.contains('is-collapsed'),
    'an unreadable state falls back to the no-task default');

  store.setItem('sv-terminals-gov', 'not json');
  const els2 = dockEls();
  const Page2 = loadPage(els2, { localStorage: store });
  Page2._bindGovDock();
  assert.strictEqual(Page2._govHeight, Page2.GOV_DEFAULT_H);
});

// ------------------------------------------------------- content and wiring

test('every governance id the rest of the page queries still lives in the dock', () => {
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
    assert.ok(body.includes(`id="${id}"`), `${id} must still be inside the dock`);
  }
});

test('the approval Review button opens the dock without recording a preference', () => {
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
