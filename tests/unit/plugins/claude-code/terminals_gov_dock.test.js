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
 * and clickable. These tests pin that, plus the four-way task/choice state and
 * the persistence, because each of the old faults was invisible to the suite
 * that shipped them.
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

/** The workspace row, with a width the clamp can measure against. */
function workspaceEl(width = 1200) {
  return makeEl({ getBoundingClientRect: () => ({ left: 60, right: 60 + width, width, height: 800 }) });
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

test('the column is the pane area\'s right sibling, with the gutter between them', () => {
  const src = read('js/pages/terminals.js');
  const open = src.indexOf('<div class="terminals-workspace">');
  const centre = src.indexOf('<section class="terminals-centre">', open);
  const gutter = src.indexOf('id="terminals-gov-gutter"', open);
  const dock = src.indexOf('<section class="terminals-governance" id="terminals-governance">', open);
  assert.ok(open > 0 && centre > open, 'the pane area opens the workspace');
  assert.ok(gutter > centre, 'the resize gutter comes after the pane area');
  assert.ok(dock > gutter, 'the column comes after the gutter, so it sits to the right of the panes');
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
  assert.match(css, /\.terminals-workspace > \.terminals-centre \{ flex: 1 1 auto; min-width: 0; min-height: 0; \}/,
    'the pane area takes the width the column does not');
});

test('the column width is one variable, and collapsing drops it to the strip', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-governance \{[^}]*width: var\(--gov-w, 320px\)/);
  assert.match(css, /\.terminals-governance\.is-collapsed \{ width: 34px; margin-left: 12px; \}/,
    'collapsed is a narrow strip, not a shortened body inside a kept column');
  assert.ok(!/\.terminals-governance\.is-collapsed \{ width: 0/.test(css),
    'the strip is never zero width: the person has to be able to find it again');
  assert.match(css, /\.terminals-governance-body\[hidden\] \{ display: none; \}/,
    'the body is a grid, so [hidden] needs saying out loud or it keeps its size');
  assert.match(css, /\.terminals-gov-gutter \{[^}]*cursor: col-resize/);
  assert.match(css, /\.terminals-gov-gutter\[hidden\] \{ display: none; \}/);
});

test('the collapsed strip still shows the panel name, running vertically', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-governance\.is-collapsed \.terminals-governance-toggle \{[^}]*writing-mode: vertical-rl/,
    'the name runs down the strip rather than disappearing');
  assert.match(css, /\.terminals-governance\.is-collapsed \.terminals-governance-toggle \{[^}]*flex: 1 1 auto/,
    'the button fills the strip, so the whole strip is the click target');
  assert.match(css, /\.terminals-governance\.is-collapsed \.terminals-governance-head \{[^}]*flex: 1 1 auto/);
  assert.ok(!/\.terminals-governance\.is-collapsed \.terminals-governance-toggle \{[^}]*display: none/.test(css),
    'the strip is visible, not hidden');
  // The body is what goes away, not the control that brings it back.
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
  assert.match(block, /\.terminals-governance \{ width: auto; max-height: 60vh; margin-top: 12px; \}/);
  assert.match(block, /\.terminals-governance\.is-collapsed \{ width: auto; margin-left: 0; \}/,
    'a 34px strip beside nothing is not a layout');
  assert.match(block, /\.terminals-governance\.is-collapsed \.terminals-governance-toggle \{[^}]*writing-mode: horizontal-tb/,
    'and the name reads across again once it is a band');
  assert.match(block, /\.terminals-centre \{ min-height: 460px; \}/);
});

// ------------------------------------------------------------ four-way state

test('with no task attached the column is a strip and reserves no body width', () => {
  const els = dockEls();
  const Page = loadPage(els);
  Page._bindGovDock();
  assert.ok(els['terminals-governance'].classList.contains('is-collapsed'));
  assert.strictEqual(els['terminals-governance-body'].hidden, true, 'no body, so no body width');
  assert.strictEqual(els['terminals-gov-gutter'].hidden, true, 'nothing to resize');
  assert.strictEqual(els['terminals-governance-toggle'].attrs['aria-expanded'], 'false');
  assert.strictEqual(els['terminals-governance'].style.props['--gov-w'], undefined,
    'a collapsed column never writes a width for the panes to give up');
  // The strip is the one thing that stays: hiding the toggle would leave the
  // panel unreachable, which is worse than the column it replaced.
  assert.strictEqual(els['terminals-governance-toggle'].hidden, false,
    'the strip stays on screen and stays clickable');
});

test('attaching a task expands the column, and detaching collapses it again', () => {
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
  assert.strictEqual(Page._govWidth, 1200 - Page.PANE_MIN_W);
  assert.strictEqual(els['terminals-governance'].style.props['--gov-w'], (1200 - Page.PANE_MIN_W) + 'px');
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

test('the collapse control is a button with an accessible name, and the gutter is a focusable vertical separator', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /<button type="button" class="terminals-governance-toggle" id="terminals-governance-toggle" aria-expanded="true" aria-controls="terminals-governance-body">/);
  assert.match(src, /<span class="terminals-governance-name">Governance activity<\/span><\/button>/,
    'the name is in the button, not only in the summary line beside it, so the collapsed strip has one');
  assert.match(src, /id="terminals-gov-gutter" role="separator" aria-orientation="vertical" aria-label="Resize the governance column" tabindex="0"/);
});

test('aria-expanded tracks the strip in both directions', () => {
  const els = dockEls();
  const Page = loadPage(els);
  const toggle = els['terminals-governance-toggle'];
  Page._bindGovDock();
  assert.strictEqual(toggle.attrs['aria-expanded'], 'false');
  toggle.onclick();                            // the strip is the control
  assert.strictEqual(toggle.attrs['aria-expanded'], 'true');
  assert.ok(!els['terminals-governance'].classList.contains('is-collapsed'),
    'clicking the strip reopens the column');
  toggle.onclick();
  assert.strictEqual(toggle.attrs['aria-expanded'], 'false');
  assert.ok(els['terminals-governance'].classList.contains('is-collapsed'));
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
  assert.ok(els['terminals-governance'].classList.contains('is-collapsed'),
    'an unreadable state falls back to the no-task default');

  // The shape the bottom dock shipped. A 132px height read as a width would
  // be a column too narrow to read, so v: 1 is dropped, not mapped.
  store.setItem('sv-terminals-gov', '{"v":1,"h":132,"collapsed":false,"userSet":true}');
  const els1 = dockEls();
  const Page1 = loadPage(els1, { localStorage: store });
  Page1._bindGovDock();
  assert.strictEqual(Page1._govWidth, Page1.GOV_DEFAULT_W, 'a stored height is not a width');
  assert.strictEqual(Page1._govUserSet, false, 'and the choice that went with it is not carried over');
  assert.ok(els1['terminals-governance'].classList.contains('is-collapsed'));

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
