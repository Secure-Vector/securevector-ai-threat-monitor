/**
 * Agents board alert row, held-call line and the plain-row sidebar entry.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

function fakeEl() {
  const found = {};
  return {
    hidden: true, innerHTML: '', className: '', focused: false, scrolled: false, found,
    querySelector(sel) {
      const m = sel.match(/^\[([a-z-]+)\]$/);
      if (!m || !this.innerHTML.includes(m[1])) return null;
      const re = new RegExp(m[1] + '="([^"]*)"');
      const v = (this.innerHTML.match(re) || [])[1];
      const key = m[1].replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      found[sel] = found[sel] || { dataset: v !== undefined ? { [key]: v } : {}, onclick: null };
      return found[sel];
    },
    focus() { this.focused = true; },
    scrollIntoView() { this.scrolled = true; },
  };
}

function load(extra) {
  const els = { 'terminals-alert-row': fakeEl(), 'terminals-board-summary': fakeEl() };
  const sandbox = {
    window: {},
    document: { getElementById: (id) => els[id] || null, querySelector: () => null },
    API: {},
    URLSearchParams,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    localStorage: { getItem: () => null, setItem() {} },
    ...(extra || {}),
  };
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  vm.runInNewContext(read('js/pages/terminals.js'), sandbox);
  vm.runInNewContext(read('js/components/response-rungs.js'), sandbox);
  sandbox.ResponseRungs = sandbox.window.ResponseRungs;
  const T = sandbox.window.TerminalsPage;
  T._tasks = [{ id: 'a', status: 'done' }, { id: 'b', status: 'done' }];
  return { T, els, sandbox };
}

const SPOT = (band, extra) => ({
  task_id: 't1', to_review: true, harness_label: 'Claude Code', folder: 'webapp', score: band === 'high' ? 82 : 55, band,
  features: [{ id: 'new_hosts', counts: { hosts: 3 }, label: 'new hosts' }, { id: 'tool_novelty', counts: { unseen_tools: 2 }, label: 'new tools' }, { id: 'persistence', counts: { repeats: 1 } }],
  ...(extra || {}),
});

test('alert row: high spotlight is red with head, score, two signals and two actions', () => {
  const { T, els } = load();
  T._drData = { detect: { to_review: 1 }, spotlight: SPOT('high'), harden: { changes: 0 } };
  T._renderAlertRow();
  const el = els['terminals-alert-row'];
  assert.equal(el.hidden, false);
  assert.match(el.className, /terminals-alert-row is-high/);
  assert.match(el.innerHTML, /<b>Claude Code in webapp stopped behaving like itself<\/b>/);
  assert.match(el.innerHTML, / · 82 high · /);
  assert.match(el.innerHTML, /data-alert-open="t1">Open session</);
  assert.match(el.innerHTML, /data-alert-why>See why</);
  assert.equal((el.innerHTML.match(/ · /g) || []).length >= 3, true);
});

test('alert row: watch spotlight is amber; Open session attaches, See why opens an overlay', () => {
  const shown = [];
  const body = { className: '', innerHTML: '', querySelector: () => null };
  const { T, els, sandbox } = load();
  sandbox.window.Modal = { show: (o) => shown.push(o) };
  sandbox.Modal = sandbox.window.Modal;
  sandbox.document.createElement = () => body;
  sandbox.window.DetectionResponsePage = { _spotlightHtml: (d) => `<section class="dr-spot">${d.spotlight.score}</section>`, _featureSentence: (f) => `${f.label}.` };
  sandbox.DetectionResponsePage = sandbox.window.DetectionResponsePage;
  T._drData = { detect: { to_review: 1 }, spotlight: SPOT('watch') };
  const attached = [];
  T._attach = (id) => attached.push(id);
  T._renderAlertRow();
  const el = els['terminals-alert-row'];
  assert.match(el.className, /is-watch/);
  assert.match(el.innerHTML, /55 worth a look · new hosts · new tools/);
  el.found['[data-alert-open]'].onclick();
  assert.deepEqual(attached, ['t1']);
  el.found['[data-alert-why]'].onclick();
  assert.equal(shown.length, 1);
  assert.match(body.innerHTML, /dr-spot/);
});

test('alert row: calm only when nothing is pending, muted with the week high', () => {
  const { T, els } = load();
  T._drData = { detect: { to_review: 0 }, spotlight: SPOT('calm', { to_review: false, score: 21 }), harden: { changes: 0 } };
  T._renderAlertRow();
  const el = els['terminals-alert-row'];
  assert.match(el.className, /is-calm/);
  assert.match(el.innerHTML, /All sessions behaved like themselves this week · highest 21, low/);
  T._heldBySession = new Map([['s1', 1]]);
  T._renderAlertRow();
  assert.doesNotMatch(el.innerHTML, /behaved like themselves/);
});

test('alert row: pending without an unusual session lists config changes and held calls', () => {
  const { T, els, sandbox } = load();
  T._drData = { detect: { to_review: 0 }, spotlight: SPOT('calm', { to_review: false }), harden: { changes: 3 } };
  T._heldBySession = new Map([['s1', 2]]);
  T._tasks = [{ id: 'a', session_id: 's0' }, { id: 'b', session_id: 's1' }];
  T._renderAlertRow();
  const el = els['terminals-alert-row'];
  assert.match(el.className, /is-pending/);
  assert.match(el.innerHTML, /data-alert-dr>3 config changes to approve<\/button> · <button[^>]*data-alert-blocked>2 calls blocked until you decide</);
  // With sessions to review, the headline is the same count as the badge and status row.
  T._drData = { detect: { to_review: 2 }, spotlight: SPOT('calm', { to_review: false }), harden: { changes: 3 } };
  T._renderAlertRow();
  assert.match(el.innerHTML, /data-alert-dr>2 sessions need a look<\/button> · <button[^>]*data-alert-config>3 config changes to approve</);
  let went = null;
  sandbox.window.Sidebar = { navigate: (p) => { went = p; } };
  sandbox.Sidebar = sandbox.window.Sidebar;
  el.found['[data-alert-dr]'].onclick();
  assert.equal(went, 'detection-response');
  const attached = [];
  T._attach = (id) => attached.push(id);
  el.found['[data-alert-blocked]'].onclick();
  assert.deepEqual(attached, ['b']);
});

test('alert row: fixed height class, hidden without data or tasks', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-alert-row \{[^}]*height: 40px; min-height: 40px; max-height: 40px; overflow: hidden;[^}]*white-space: nowrap;/);
  assert.match(read('js/pages/terminals.js'), /id="terminals-board-summary" hidden><\/div>\n\s*<div class="terminals-alert-row" id="terminals-alert-row"/);
  const { T, els } = load();
  T._drData = null;
  T._renderAlertRow();
  assert.equal(els['terminals-alert-row'].hidden, true);
  T._drData = { detect: { to_review: 0 } };
  T._tasks = [];
  T._renderAlertRow();
  assert.equal(els['terminals-alert-row'].hidden, true);
});

test('alert row: mode chip reads test mode, on (teal) or mixed and opens the Automatic actions card', () => {
  const { T, els } = load();
  T._drData = { detect: { to_review: 0 } };
  const el = els['terminals-alert-row'];
  T._rungModes = [{ harness: 'claude-code', mode: 'shadow' }];
  T._renderAlertRow();
  assert.match(el.innerHTML, /class="terminals-alert-mode is-test"[^>]*>Automatic actions: test mode</);
  T._rungModes = [{ harness: 'claude-code', mode: 'active' }, { harness: 'codex', mode: 'active' }];
  T._renderAlertRow();
  assert.match(el.innerHTML, /is-on" data-alert-mode title="On: step-up calls are blocked until you approve them\.[^"]*">Automatic actions: on</);
  T._rungModes = [{ harness: 'claude-code', mode: 'active' }, { harness: 'codex', mode: 'shadow' }];
  T._renderAlertRow();
  assert.match(el.innerHTML, />Automatic actions: mixed</);
  let focus = null;
  T.openSettings = (f) => { focus = f; };
  el.found['[data-alert-mode]'].onclick();
  assert.equal(focus, 'rungs');
  assert.match(read('css/styles.css'), /\.terminals-alert-mode\.is-on \{ color: var\(--accent-primary\); \}/);
  T._rungModes = [];
  T._renderAlertRow();
  assert.match(el.innerHTML, />Automatic actions: test mode</, 'no rows yet reads as test mode');
  T._rungModes = null;
  T._renderAlertRow();
  assert.doesNotMatch(el.innerHTML, /terminals-alert-mode/);
  // Every variant carries the chip, between the text and the buttons.
  T._rungModes = [{ harness: 'claude-code', mode: 'shadow' }];
  T._drData = { detect: { to_review: 1 }, spotlight: SPOT('high') };
  T._renderAlertRow();
  const i = (k) => el.innerHTML.indexOf(k);
  assert.ok(i('terminals-alert-text') < i('data-alert-mode') && i('data-alert-mode') < i('data-alert-open') && i('data-alert-open') < i('data-alert-why'));
  T._drData = { detect: { to_review: 0 }, harden: { changes: 0 } };
  T._heldBySession = new Map();
  T._renderAlertRow();
  assert.match(el.innerHTML, /data-alert-mode/);
});

test('"need a look" in the status row focuses the alert row', () => {
  const { T, els } = load();
  T._drData = { detect: { to_review: 2 }, spotlight: SPOT('watch') };
  T._renderBoardSummary(T._tasks);
  const sum = els['terminals-board-summary'];
  sum.found['[data-board-dr]'].onclick({ preventDefault() {} });
  assert.equal(els['terminals-alert-row'].focused, true);
  assert.equal(els['terminals-alert-row'].scrolled, true);
});

test('blocked step-up call: red line, counts in need you, leads its folder', () => {
  const { T } = load();
  T._heldBySession = T._heldMap([
    { rule_source: 'rung', session_id: 's2' }, { rule_source: 'rung', session_id: 's2' }, { rule_source: 'manual', session_id: 's1' },
  ]);
  T._pendingApprovalSessions = new Set(['s2']);
  const t = { id: 'b', session_id: 's2', rung_word: 'step-up', rung_mode: 'active', rung_reasons: ['drift'], drift_score: 82 };
  assert.equal(T._heldLineHtml(t), '<span class="terminals-task-stepup-blocked" title="Allow or deny in the approval card beside the session">2 calls blocked until you decide · unusual activity · score 82</span>');
  T._heldBySession = new Map([['s2', 1]]);
  assert.match(T._heldLineHtml(t), />1 call blocked until you decide · /);
  assert.equal(T._hasPendingApproval(t), true);
  assert.equal(JSON.stringify(T._heldFirst(['a', 'b', 'b-kid', 'c'], [false, true, false, false], [false, false, true, false])), JSON.stringify(['b', 'b-kid', 'a', 'c']));
  assert.equal(JSON.stringify(T._heldFirst(['a', 'b', 'c'], [false, false, false], [false, false, false])), JSON.stringify(['a', 'b', 'c']));
  assert.match(read('css/styles.css'), /\.terminals-task-stepup-blocked \{[^}]*color: var\(--danger/);
});

test('test mode: a rung 3 card notes what it would have blocked, muted', () => {
  const { T } = load();
  T._heldBySession = new Map();
  assert.match(T._heldLineHtml({ id: 'a', session_id: 's', rung_word: 'step-up', rung_mode: 'shadow', rung_would_ask: 2 }),
    /class="terminals-task-wouldblock"[^>]*>would have blocked: 2 risky calls</);
  assert.match(T._heldLineHtml({ id: 'a', rung_word: 'step-up', rung_mode: 'shadow' }), />would have blocked: risky calls</);
  assert.equal(T._heldLineHtml({ id: 'a', rung_word: 'flag', rung_mode: 'shadow' }), '');
  assert.equal(T._heldLineHtml({ id: 'a', rung_word: 'step-up', rung_mode: 'active' }), '');
});

test('no Detection & Response or Settings rows in the Agents panel, and no top card', () => {
  const side = read('js/components/sidebar.js');
  assert.doesNotMatch(side, /agentFooterRows|nav-sessions-dr|nav-sessions-settings|nav-dr-badge|nav-dr-card|_drCard/);
  const css = read('css/styles.css');
  assert.doesNotMatch(css, /\.nav-dr-card|\.nav-sessions-dr|\.nav-dr-badge/);
  assert.match(side, /bottomSection\.appendChild\(statusToggle\)/, 'Plugins stays in the bottom section');
});

test('spotlight trust line and secondary Looks normal everywhere', () => {
  const dr = read('js/pages/detection-response.js');
  assert.match(dr, /<p class="dr-muted dr-spot-trust">Scored on this device from its own history\. Nothing leaves your machine\.<\/p>/);
  assert.equal((dr.match(/class="btn btn-sm btn-secondary" data-dr-normal/g) || []).length, 2);
  assert.match(read('js/pages/terminals.js'), /class="btn btn-sm btn-secondary" data-drift-normal/);
  const banned = /—|\bADR\b|firewall|Mission Control/;
  const js = read('js/pages/terminals.js');
  const block = js.slice(js.indexOf('_heldMap(items)'), js.indexOf('/** One line of state over the whole board.'));
  assert.ok(!banned.test(block));
  // UI strings never say paused or held for a step-up call.
  const strings = (block.match(/`[^`]*`|'[^']*'/g) || []).join('\n');
  assert.doesNotMatch(strings, /\bpaused\b|\b[Hh]eld\b/);
  assert.doesNotMatch(js, /Tasks paused for your decision/);
});

function loadSidebar() {
  const mk = (tag) => {
    const el = { tagName: tag, className: '', dataset: {}, attrs: {}, listeners: {}, children: [], innerHTML: '', title: '', textContent: '', hidden: false,
      setAttribute(k, v) { el.attrs[k] = String(v); }, addEventListener(t, fn) { el.listeners[t] = fn; },
      appendChild(c) { el.children.push(c); return c; } };
    return el;
  };
  const ctx = { window: {}, document: { createElement: mk, createElementNS: (_ns, t) => mk(t), querySelectorAll: () => [] }, console, localStorage: { getItem: () => null, setItem() {} } };
  vm.runInNewContext(read('js/components/sidebar.js'), ctx);
  const S = ctx.window.Sidebar;
  S.createIcon = () => mk('svg');
  return S;
}

test('rail: Detect & Respond sits right after Agents, active on its page, with a badge slot', () => {
  const S = loadSidebar();
  const rail = S._createProductRail(S._activeProductGroup('detection-response'));
  const buttons = rail.children[1].children;
  const ids = buttons.map(b => b.dataset.productGroup);
  assert.equal(JSON.stringify(ids), JSON.stringify(['tasks', 'detect', 'visibility', 'governance', 'policies', 'connect', 'more']));
  const detect = buttons[1];
  assert.match(detect.className, /product-rail-button active/);
  assert.equal(detect.attrs['aria-current'], 'page');
  assert.equal(detect.attrs['aria-label'], 'Agent Detection & Response');
  assert.equal(detect.title, 'Agent Detection & Response');
  assert.equal(detect.children.find(c => c.className === 'product-rail-label').textContent, 'Detect & Respond');
  const badge = detect.children.find(c => c.dataset && c.dataset.drProductBadge);
  assert.ok(badge && badge.hidden === true && badge.className === 'product-rail-attention');
  const onAgents = S._createProductRail(S._activeProductGroup('terminals')).children[1].children;
  assert.doesNotMatch(onAgents[1].className, /active/);
});

test('Settings: pinned above Theme on every page, out of More, and no rail button', () => {
  const S = loadSidebar();
  const src = read('js/components/sidebar.js');
  assert.match(src, /bottomSection\.appendChild\(this\._createSettingsRow\(\)\);\n\s*bottomSection\.appendChild\(this\.createThemeFooter\(\)\);/);
  for (const page of ['terminals', 'threats']) {
    S.currentPage = page;
    const row = S._createSettingsRow();
    assert.match(row.className, /nav-item nav-settings-pinned/);
    assert.doesNotMatch(row.className, /active/);
    assert.match(row.innerHTML, /<span class="nav-label">Settings<\/span>/);
  }
  S.currentPage = 'settings';
  const went = [];
  S.navigate = (p) => went.push(p);
  const row = S._createSettingsRow();
  assert.match(row.className, / active/);
  assert.equal(row.attrs['aria-current'], 'page');
  row.listeners.click({ stopPropagation() {} });
  assert.equal(JSON.stringify(went), JSON.stringify(['settings']));
  const more = S.productGroups.find(g => g.id === 'more');
  assert.equal(JSON.stringify(more.items), JSON.stringify(['guide']));
  assert.equal(S._activeProductGroup('settings').id, 'settings');
  const rail = S._createProductRail(S._activeProductGroup('settings')).children[1].children;
  assert.ok(!rail.some(b => b.dataset.productGroup === 'settings'));
  assert.ok(!rail.some(b => /active/.test(b.className)));
});

test('alert row: the unusual line counts blocked calls when there are any', () => {
  const { T, els } = load();
  T._drData = { detect: { to_review: 1 }, spotlight: SPOT('high') };
  T._heldBySession = new Map([['s1', 2]]);
  T._renderAlertRow();
  assert.match(els['terminals-alert-row'].innerHTML, / · 2 calls blocked</);
  T._heldBySession = new Map();
  T._renderAlertRow();
  assert.doesNotMatch(els['terminals-alert-row'].innerHTML, /calls? blocked/);
});

test('escaping: folder, agent tool, signal text and rung reasons never render markup', () => {
  const X = '<img src=x onerror=alert(1)>';
  const { T, els, sandbox } = load();
  sandbox.window.DetectionResponsePage = { _featureSentence: (f) => f.label };
  sandbox.DetectionResponsePage = sandbox.window.DetectionResponsePage;
  T._drData = { detect: { to_review: 1 }, spotlight: SPOT('high', { folder: X, harness_label: X, features: [{ id: 'x', label: X }] }) };
  T._renderAlertRow();
  const html = els['terminals-alert-row'].innerHTML;
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  sandbox.window.ResponseRungs.REASON_WORDS[X] = X;
  T._heldBySession = new Map([['s', 1]]);
  const line = T._heldLineHtml({ id: 'a', session_id: 's', rung_reasons: [X], drift_score: 80 });
  assert.doesNotMatch(line, /<img/);
  assert.match(line, /&lt;img/);
  // "See why" modal: the real detection page spotlight, same fixture.
  const shown = [];
  const body = { className: '', innerHTML: '', querySelector: () => null };
  sandbox.window.Modal = { show: (o) => shown.push(o) };
  sandbox.Modal = sandbox.window.Modal;
  sandbox.document.createElement = () => body;
  vm.runInNewContext(read('js/pages/detection-response.js'), sandbox);
  sandbox.DetectionResponsePage = sandbox.window.DetectionResponsePage;
  T._openSpotlight(SPOT('high', { folder: X, harness_label: X, features: [{ id: 'x', label: X }] }));
  assert.equal(shown.length, 1);
  assert.doesNotMatch(body.innerHTML, /<img/);
  assert.match(body.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('Modal.show is a dialog with aria-modal and a Tab focus trap', () => {
  const src = read('js/components/modal.js');
  assert.match(src, /modal\.setAttribute\('role', 'dialog'\);\n\s*modal\.setAttribute\('aria-modal', 'true'\);/);
  assert.match(src, /modal\.addEventListener\('keydown', \(e\) => Modal\._trapTab\(e, modal\)\);/);
  assert.match(read('index.html'), /modal\.js\?v=10"/);
  const ctx = { window: {}, console };
  vm.runInNewContext(read('js/components/modal.js') + '\nwindow.__M = Modal;', ctx);
  const M = ctx.window.__M;
  const mk = (n) => ({ n, hidden: false, offsetParent: {}, focused: false, focus() { ctx.document.activeElement = this; } });
  const a = mk('a'), b = mk('b');
  ctx.document = { activeElement: b };
  const modal = { querySelectorAll: () => [a, b], focus() {} };
  let prevented = false;
  M._trapTab({ key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } }, modal);
  assert.equal(prevented, true);
  assert.equal(ctx.document.activeElement, a);
  prevented = false;
  M._trapTab({ key: 'Tab', shiftKey: true, preventDefault() { prevented = true; } }, modal);
  assert.equal(ctx.document.activeElement, b);
});
