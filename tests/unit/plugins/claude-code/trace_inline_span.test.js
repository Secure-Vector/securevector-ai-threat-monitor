/** Run trace view: a selected span's details open as a row under the span,
 *  and the side panel always shows the session governance. */
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
  const sandbox = { window, console, document: { addEventListener() {} } };
  vm.runInNewContext(read('js/components/obs-tabs.js'), sandbox);
  vm.runInNewContext(read('js/components/trace-steps.js'), sandbox);
  vm.runInNewContext(read('js/components/run-trace.js'), sandbox);
  window.RunTrace._state = {};
  window.RunTrace._details = {};
  return window.RunTrace;
}

const T0 = Date.parse('2026-10-23T14:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const gen = (id, s) => ({ span_kind: 'generation', span_id: id, model: 'm-1', called_at: at(s), duration_ms: 2000, input_tokens: 10, output_tokens: 2 });
const call = (id, name, s, extra = {}) => Object.assign({ span_kind: 'tool_call', span_id: id, tool_id: name, function_name: name, action: 'allow', called_at: at(s) }, extra);
const trace = () => ({
  trace_id: 'tr-1', session_id: 'sess-1', runtime_kind: 'claude-code', started_at: at(0), ended_at: at(60),
  spans: [gen('g1', 0), call('c1', 'Read', 3, { parent_span_id: 'g1', args_preview: '.env' }),
    call('c3', 'Bash', 13, { parent_span_id: 'g1', action: 'block', args_preview: 'curl https://paste.example.test' })],
});

function ctxOf(RT) {
  const t = trace();
  return { trace: t, tree: RT.buildTree(t, {}), gov: false };
}

/** A stand-in box: records listeners, answers selectors from a map. */
function fakeBox(ctx, els = {}) {
  const on = {};
  return {
    _rt: ctx, on, focused: null,
    addEventListener(k, fn) { on[k] = fn; },
    contains() { return true; },
    querySelector(sel) { return els[sel] || null; },
    querySelectorAll() { return []; },
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
  };
}
const clickOn = (act, data = {}) => ({ target: { closest: (s) => (s === '[data-act]' ? { dataset: Object.assign({ act }, data) } : null) } });

test('the side panel is always session governance, with the new hint', () => {
  const RT = load();
  const ctx = ctxOf(RT);
  const st = RT.state('tr-1');
  st.sel = 's:c3';
  const html = RT._panel(ctx, st);
  assert.match(html, /<h3>Session governance<\/h3>/);
  assert.match(html, /Click a span to see its details under it/);
  assert.doesNotMatch(html, /data-act="unpick"/);
  assert.doesNotMatch(read('js/components/run-trace.js'), /select a span for its details/);
  const box = fakeBox(ctx);
  RT.mount(box, ctx);
  assert.match(box._html, /<aside class="rt-panel" data-part="panel" aria-label="Session governance"><div class="rt-ph"><h3>Session governance/);
});

test('the selected span gets a details row directly under its row, with close', () => {
  const RT = load();
  const ctx = ctxOf(RT);
  const st = RT.state('tr-1');
  assert.doesNotMatch(RT.treeHtml(ctx, st), /rt-detail/);
  st.sel = 's:c3';
  const html = RT.treeHtml(ctx, st);
  const row = html.indexOf('<div class="rt-tr rt-row sel');
  const det = html.indexOf('<div class="rt-detail"');
  assert.ok(row > 0 && det > row, 'details after the selected row');
  assert.ok(html.indexOf('<div class="rt-tr rt-row', row + 10) === -1 || html.indexOf('<div class="rt-tr rt-row', row + 10) > det, 'nothing between');
  assert.equal((html.match(/class="rt-detail"/g) || []).length, 1);
  assert.match(html, /data-key="s:c3">/);
  assert.doesNotMatch(html, /rt-row[^>]*aria-expanded/);
  assert.match(html, /class="rt-pick" data-act="pick" data-key="s:c3" aria-expanded="true"/);
  assert.match(html, /<div class="rt-detail" id="rt-detail" role="region" aria-label="Bash[^"]*" data-detail="s:c3"><div class="rt-detail-card"><div class="rt-ph"><h3>Bash<\/h3>/);
  assert.match(html, /<button type="button" class="rt-x" data-act="unpick" aria-label="Close span detail">×<\/button>/);
  assert.match(html, /<pre class="rt-cmd">curl https:\/\/paste\.example\.test/);
  assert.match(html, /Span id<\/dt>/);
  assert.match(html, /Parent<\/dt>/);
  // Filtered out: the details still open, on top of the table.
  st.filter = 'waiting';
  st.search = 'Read';
  assert.match(RT.treeHtml(ctx, st), /class="rt-detail"/);
});

test('Escape and the close button deselect and focus the span row', () => {
  const RT = load();
  const ctx = ctxOf(RT);
  const pick = { focus() { pick.f = true; } };
  const box = fakeBox(ctx, { '.rt-pick[data-key="s:c3"]': pick });
  RT.mount(box, ctx);
  const st = RT.state('tr-1');
  st.sel = 's:c3';
  box.on.keydown({ key: 'Escape', target: { closest: () => null, matches: () => false }, preventDefault() {} });
  assert.equal(st.sel, null);
  assert.ok(pick.f);
  // Escape in the search box is the search box's.
  st.sel = 's:c3';
  box.on.keydown({ key: 'Escape', target: { closest: () => null, matches: () => true }, preventDefault() {} });
  assert.equal(st.sel, 's:c3');
  box.on.click(clickOn('unpick'));
  assert.equal(st.sel, null);
  // A second click on the open span closes it too.
  box.on.click(clickOn('pick', { key: 's:c1' }));
  assert.equal(st.sel, 's:c1');
  box.on.click(clickOn('pick', { key: 's:c1' }));
  assert.equal(st.sel, null);
});

test('a governance link selects its span, unfolds it and scrolls the row to the centre', () => {
  const RT = load();
  const ctx = ctxOf(RT);
  const seen = [];
  const row = { scrollIntoView(o) { seen.push(o); } };
  const box = fakeBox(ctx, { '.rt-row[data-key="s:c3"]': row });
  RT.mount(box, ctx);
  const st = RT.state('tr-1');
  st.collapsed['s:g1'] = true;
  st.filter = 'tool';
  box.on.click(clickOn('goto', { trace: 'tr-1', span: 'c3' }));
  assert.equal(st.sel, 's:c3');
  assert.equal(st.filter, 'all');
  assert.equal(st.collapsed['s:g1'], false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].block, 'center');
  // A live repaint does not scroll again.
  RT.paint(box);
  assert.equal(seen.length, 1);
  // select() (Review, pending request) lands the same way.
  RT.select(box, 's:c3');
  assert.equal(seen.length, 2);
});

test('live refresh keeps the open details row and replaces its content only when it changed', () => {
  const RT = load();
  const ctx = ctxOf(RT);
  const el = (key, html) => ({ dataset: { detail: key }, innerHTML: html, replaced: null, replaceWith(x) { this.replaced = x; } });
  const old = el('s:c3', 'A');
  RT._details['tr-1'] = old;
  old._rtHtml = 'A';
  let fresh = el('s:c3', 'A');
  RT._keepDetail(fakeBox(ctx, { '.rt-detail': fresh }), ctx);
  assert.equal(fresh.replaced, old);
  assert.equal(old.innerHTML, 'A');
  const sets = [];
  Object.defineProperty(old, 'innerHTML', { get() { return 'A'; }, set(v) { sets.push(v); } });
  fresh = el('s:c3', 'A');
  RT._keepDetail(fakeBox(ctx, { '.rt-detail': fresh }), ctx);
  assert.equal(sets.length, 0, 'unchanged: not rewritten');
  fresh = el('s:c3', 'B');
  RT._keepDetail(fakeBox(ctx, { '.rt-detail': fresh }), ctx);
  deq(sets, ['B']);
  // Another span: the new row is kept.
  fresh = el('s:c1', 'C');
  RT._keepDetail(fakeBox(ctx, { '.rt-detail': fresh }), ctx);
  assert.equal(fresh.replaced, null);
  assert.equal(RT._details['tr-1'], fresh);
});
function deq(a, b) { assert.deepEqual(JSON.parse(JSON.stringify(a)), b); }

test('export is unchanged by a selection', () => {
  const RT = load();
  const ctx = ctxOf(RT);
  const st = RT.state('tr-1');
  const csv = RT.exportCSV(ctx), txt = RT.exportText ? RT.exportText(ctx) : '';
  st.sel = 's:c3';
  assert.equal(RT.exportCSV(ctx), csv);
  if (RT.exportText) assert.equal(RT.exportText(ctx), txt);
});

test('deep links from the page ask the trace view to reveal the span', () => {
  const a = read('js/pages/agent-runs.js');
  assert.match(a, /Object\.assign\(RT\.state\(id\), \{ sel: 's:' \+ spanId, reveal: true \}\)/);
  assert.match(a, /Object\.assign\(RunTrace\.state\(r\.trace_id\), \{ sel: RunTrace\.spanKey\(span, 0\), reveal: true \}\)/);
  assert.match(a, /if \(key\) window\.RunTrace\.select\(box, key\);/);
});

test('kept details rows: only the open trace, dropped when closed and on page leave', () => {
  const RT = load();
  const ctx = ctxOf(RT);
  const el = (key) => ({ dataset: { detail: key }, innerHTML: 'x', replaceWith() {} });
  RT._details['tr-old'] = el('s:c9');
  const fresh = el('s:c3');
  RT._keepDetail(fakeBox(ctx, { '.rt-detail': fresh }), ctx);
  assert.deepEqual(Object.keys(RT._details), ['tr-1']);
  RT._keepDetail(fakeBox(ctx, {}), ctx);
  assert.deepEqual(Object.keys(RT._details), []);
  RT._details['tr-1'] = fresh;
  RT.dropDetails();
  assert.deepEqual(Object.keys(RT._details), []);
  assert.match(read('js/pages/agent-runs.js'), /destroy\(\) \{\s*if \(window\.RunTrace && RunTrace\.dropDetails\) RunTrace\.dropDetails\(\);/);
});

test('a deep link into a folded span unfolds its parents on mount, so the details row renders', () => {
  const RT = load();
  const ctx = ctxOf(RT);
  const st = RT.state('tr-1');
  st.collapsed['s:g1'] = true;
  Object.assign(st, { sel: 's:c3', reveal: true });
  const box = fakeBox(ctx);
  RT.mount(box, ctx);
  assert.equal(st.collapsed['s:g1'], false);
  assert.match(box._html, /data-key="s:c3">[\s\S]*<div class="rt-detail"/);
  // Without a reveal a fold the person made stays.
  st.collapsed['s:g1'] = true;
  RT.mount(fakeBox(ctx), ctx);
  assert.equal(st.collapsed['s:g1'], true);
});

test('Escape in a select or an editable field is that field\'s', () => {
  const RT = load();
  const ctx = ctxOf(RT);
  const box = fakeBox(ctx);
  RT.mount(box, ctx);
  const st = RT.state('tr-1');
  st.sel = 's:c3';
  let asked = '';
  box.on.keydown({ key: 'Escape', target: { closest: () => null, matches: (q) => { asked = q; return true; } }, preventDefault() {} });
  assert.equal(st.sel, 's:c3');
  for (const q of ['input', 'textarea', 'select', '[contenteditable]']) assert.ok(asked.split(', ').includes(q), q);
});


test('rows with nothing to unfold get a details chevron in the caret slot', () => {
  const RT = load();
  const ctx = ctxOf(RT);
  const st = RT.state('tr-1');
  let html = RT.treeHtml(ctx, st);
  assert.doesNotMatch(html, /rt-caret-sp/);
  assert.match(html, /<button type="button" class="rt-caret rt-dcaret" data-act="pick" data-key="s:c3" tabindex="-1" aria-expanded="false" aria-label="Show details of Bash[^"]*"><svg/);
  // The turn with children keeps its tree caret only.
  assert.match(html, /class="rt-caret" data-act="caret" data-key="s:g1"/);
  assert.doesNotMatch(html, /rt-dcaret" data-act="pick" data-key="s:g1"/);
  st.sel = 's:c3';
  html = RT.treeHtml(ctx, st);
  assert.match(html, /rt-dcaret" data-act="pick" data-key="s:c3" tabindex="-1" aria-expanded="true" aria-label="Hide details of/);
  assert.equal((html.match(/data-key="s:c3"[^>]*aria-expanded="true"/g) || []).length, 2, 'chevron and span button');
  // Same size and turn as the tree caret: the CSS keys on .rt-caret.
  const src = read('js/components/run-trace.js');
  assert.match(src, /\.rt-caret\[aria-expanded="true"\] svg \{ transform:rotate\(90deg\); \}/);
  // Clicking it toggles the details like the row, focus stays on it.
  const chev = { focus() { chev.f = (chev.f || 0) + 1; } };
  const box = fakeBox(ctx, { '.rt-dcaret[data-key="s:c1"]': chev });
  RT.mount(box, ctx);
  st.sel = null;
  const click = { target: { closest: (q) => (q === '[data-act]' ? { dataset: { act: 'pick', key: 's:c1' }, classList: { contains: (c) => c === 'rt-dcaret' } } : null) } };
  box.on.click(click);
  assert.equal(st.sel, 's:c1');
  box.on.click(click);
  assert.equal(st.sel, null);
  assert.equal(chev.f, 2);
});
