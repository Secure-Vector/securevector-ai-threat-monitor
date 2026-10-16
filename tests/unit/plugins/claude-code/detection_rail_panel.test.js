/**
 * Detection & Response rail panel: the rail label, the section rows and
 * their order, the scroll targets on the page, the active row and counts.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

function mk(tag) {
  const el = {
    tagName: tag.toUpperCase(), className: '', dataset: {}, attrs: {}, listeners: {}, children: [], title: '', textContent: '', hidden: false,
    classList: {
      toggle(c, on) { const s = new Set(el.className.split(' ').filter(Boolean)); if (on) s.add(c); else s.delete(c); el.className = [...s].join(' '); },
      contains(c) { return el.className.split(' ').includes(c); },
      add(c) { el.classList.toggle(c, true); },
    },
    setAttribute(k, v) { el.attrs[k] = String(v); }, removeAttribute(k) { delete el.attrs[k]; },
    addEventListener(t, fn) { el.listeners[t] = fn; },
    appendChild(c) { el.children.push(c); return c; },
    _all() { return el.children.flatMap(c => [c, ...c._all()]); },
    querySelectorAll(sel) {
      const key = sel.match(/^\[data-([a-z-]+)\]$/)[1].replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
      return el._all().filter(c => c.dataset[key] !== undefined);
    },
    querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
  };
  return el;
}

function loadSidebar() {
  const ctx = {
    window: {}, console, Date,
    document: { createElement: mk, createElementNS: (_ns, t) => mk(t), querySelectorAll: () => [], getElementById: () => null },
    localStorage: { getItem: () => null, setItem() {} },
  };
  vm.runInNewContext(read('js/components/sidebar.js'), ctx);
  const S = ctx.window.Sidebar;
  S.createIcon = () => mk('svg');
  S._makeRowFocusable = () => {};
  S._drWatch = () => {};
  S._drTestDoc = ctx.document;
  return S;
}

const sections = (wrap) => wrap.children.filter(r => r.dataset.drSection);
const label = (row) => row.children[0].textContent;
const count = (row) => row.children.find(c => c.dataset && c.dataset.drCount);

test('rail button reads Detection & Response on two lines, full name in title and aria', () => {
  const S = loadSidebar();
  const rail = S._createProductRail(S._activeProductGroup('detection-response'));
  const detect = rail.children[1].children.find(b => b.dataset.productGroup === 'detect');
  assert.equal(detect.children.find(c => c.className === 'product-rail-label').textContent, 'Detection & Response');
  assert.equal(detect.title, 'Agent Detection & Response');
  assert.equal(detect.attrs['aria-label'], 'Agent Detection & Response');
  assert.ok(detect.children.find(c => c.dataset && c.dataset.drProductBadge), 'count badge kept');
  assert.match(read('css/styles.css'), /\.product-rail-button\[data-product-group="detect"\] \.product-rail-label \{ white-space: normal;/);
});

test('panel title is the full name and the hoist renders the section list', () => {
  const src = read('js/components/sidebar.js');
  assert.match(src, /contextTitle\.textContent = activeGroup\.title \|\| activeGroup\.label;/);
  assert.match(src, /if \(activeGroup\.id === 'detect'\) \{ nav\.appendChild\(this\._createDrSections\(\)\); return; \}/);
  assert.match(src, /subtitle: 'Sessions that did something unusual, and agent config changes to check', items: \['detection-response'\]/);
  // The Agents panel is untouched.
  assert.match(src, /\{ id: 'tasks', label: 'Agents', icon: 'terminal', landing: 'terminals',\s*\n\s*subtitle: 'Launch and return to governed agent sessions', items: \['terminals'\] \}/);
});

test('the panel keeps only Sessions to review and Details', () => {
  const S = loadSidebar();
  const wrap = S._createDrSections();
  const rows = sections(wrap);
  assert.deepEqual(rows.map(label), ['Sessions to review', 'Details']);
  assert.deepEqual(rows.map(r => r.dataset.drSection), ['dr-sec-sessions', 'dr-sec-details']);
  assert.deepEqual(rows.map(r => /\bnav-dr-sub\b/.test(r.className)), [false, false]);
});

test('only Sessions to review has a count, and it hides at zero', () => {
  const S = loadSidebar();
  const wrap = S._createDrSections();
  const rows = sections(wrap);
  assert.equal(count(rows[0]).hidden, true);
  assert.equal(count(rows[1]), undefined);
  S._paintDrSections({ detect: { to_review: 3 }, harden: { available: true, changes: 2 } }, wrap);
  assert.equal(count(rows[0]).textContent, '3');
  assert.equal(count(rows[0]).hidden, false);
  S._paintDrSections({ detect: { to_review: 0 }, harden: { available: false, changes: 4 } }, wrap);
  assert.equal(count(rows[0]).hidden, true);
  // Same cached summary the rail badge reads.
  assert.match(read('js/components/sidebar.js'), /this\._drSummary = d \|\| null;[\s\S]{0,140}this\._paintDrSections\(this\._drSummary\);/);
});

test('first visible row active on load; a clicked or in-view section takes over', () => {
  const S = loadSidebar();
  S._drActive = null;
  const wrap = S._createDrSections();
  const rows = sections(wrap);
  assert.match(rows[0].className, /\bactive\b/);
  assert.equal(rows[0].attrs['aria-current'], 'location');
  S._drActive = 'dr-sec-details';
  S._drSyncActive(wrap);
  assert.doesNotMatch(rows[0].className, /\bactive\b/);
  assert.match(rows[1].className, /\bactive\b/);
  // A legacy subsection id no longer in the menu falls back to a visible primary anchor.
  S._drActive = 'dr-sec-checks';
  S._drSyncActive(wrap);
  assert.match(rows[0].className, /\bactive\b/);
  const e = [{ id: 'dr-sec-sessions', top: -400 }, { id: 'dr-sec-config', top: -20 }, { id: 'dr-sec-actions', top: 300 }, { id: 'dr-sec-checks', top: 300 }, { id: 'dr-sec-how', top: 700 }];
  assert.equal(S._drPickActive(e, 96, false, 800), 'dr-sec-config');
  assert.equal(S._drPickActive(e.map(x => ({ ...x, top: x.top + 1000 })), 96, false, 800), 'dr-sec-sessions');
  assert.equal(S._drPickActive(e.map(x => ({ ...x, top: x.top - 250 })), 96, false, 800), 'dr-sec-actions');
  assert.equal(S._drPickActive(e, 96, true, 752), 'dr-sec-how');
});

test('a row navigates to the page with its section pending, or scrolls in place', () => {
  const S = loadSidebar();
  const went = [];
  S.navigate = (p) => went.push(p);
  S.currentPage = 'terminals';
  S.goToDrSection('dr-sec-how');
  assert.deepEqual(went, ['detection-response']);
  assert.equal(S._drPendingSection, 'dr-sec-how');
  assert.equal(S._drActive, 'dr-sec-how');
  const src = read('js/components/sidebar.js');
  assert.match(src, /for \(let n = el; n; n = n\.parentElement\) \{ if \(n\.tagName === 'DETAILS'\) n\.open = true; \}/);
  assert.match(src, /if \(page === 'detection-response'\) this\._drActive = this\._drPendingSection \|\| null;\s*else this\._drPendingSection = null;/);
  // Ready with nothing pending runs the position pass, not a first-row default.
  assert.match(src, /drPageReady\(\) \{[\s\S]*?this\._drPositionPass\(\);\s*\},/);
});

test('the page carries a stable id for every panel row', () => {
  const dr = read('js/pages/detection-response.js');
  assert.match(dr, /<div data-dr-start id="dr-sec-start"><\/div>\s*<div data-dr-top><\/div>\s*<div id="dr-sec-sessions">/);
  assert.match(dr, /<details class="dr-loop dr-details" id="dr-sec-details">/);
  assert.match(dr, /<div data-dr-spot id="dr-sec-why"><\/div>/);
  assert.match(dr, /<div data-dr-cloud id="dr-sec-fleet"><\/div>/);
  assert.match(dr, /<div data-dr-config id="dr-sec-config"><\/div>/);
  assert.match(dr, /<details class="dr-loop" id="dr-sec-how"/);
  assert.match(dr, /_sectionsReady\(\) \{\s*if \(window\.Sidebar && Sidebar\.drPageReady\) Sidebar\.drPageReady\(\);/);
  const ctx = { window: { location: { search: '' } }, URLSearchParams, console };
  vm.runInNewContext(dr, ctx);
  const P = ctx.window.DetectionResponsePage;
  assert.match(P._respondTile({ mode: 'shadow' }), /<section class="dr-tile" id="dr-sec-actions"/);
  assert.match(P._preflightTile({ checked: 2 }), /id="dr-sec-checks"/);
  assert.match(P._preflightTile({ checked: 0, registered: false }), /id="dr-sec-checks"/);
  const sk = P._skeletonHtml();
  assert.equal((sk.match(/id="dr-sec-actions"/g) || []).length, 1);
  assert.equal((sk.match(/id="dr-sec-checks"/g) || []).length, 1);
  assert.doesNotMatch(P._detectTile({}), /\bid="/);
});

test('copy rules hold in the new panel code', () => {
  const src = read('js/components/sidebar.js');
  const block = src.slice(src.indexOf('DR_SECTIONS: ['), src.indexOf('/** Settings, pinned above Theme'));
  assert.doesNotMatch(block, /—|\bADR\b|firewall|Mission Control/);
});

test('only the page scroller drives the active row, never the nav or an inner list', () => {
  const S = loadSidebar();
  const doc = S._drTestDoc;
  const sec = { id: 'dr-sec-sessions' };
  doc.scrollingElement = { tag: 'root' };
  doc.getElementById = (id) => (id === 'dr-sec-sessions' ? sec : null);
  const main = { contains: (x) => x === sec };
  const innerList = { contains: () => false };
  const nav = { contains: () => false };
  assert.equal(S._drIsPageScroll(doc), true);
  assert.equal(S._drIsPageScroll(doc.scrollingElement), true);
  assert.equal(S._drIsPageScroll(main), true);
  assert.equal(S._drIsPageScroll(innerList), false);
  assert.equal(S._drIsPageScroll(nav), false);
  assert.equal(S._drIsPageScroll(null), false);
  assert.match(read('js/components/sidebar.js'), /if \(this\.currentPage !== 'detection-response' \|\| !this\._drIsPageScroll\(ev\.target\)\) return;/);
});

test('a deep link to Config changes opens the closed Details first', () => {
  const S = loadSidebar();
  const doc = S._drTestDoc;
  const details = { tagName: 'DETAILS', open: false, parentElement: null };
  const body = { tagName: 'DIV', parentElement: details };
  let scrolled = 0;
  const cfg = { tagName: 'DIV', parentElement: body, scrollIntoView() { scrolled += 1; } };
  doc.getElementById = (id) => (id === 'dr-sec-config' ? cfg : null);
  S.currentPage = 'detection-response';
  S.goToDrSection('dr-sec-config');
  assert.equal(details.open, true, 'Details opened');
  assert.equal(scrolled, 1);
  // How it works is itself a disclosure inside Details: both open.
  const how = { tagName: 'DETAILS', open: false, parentElement: body, scrollIntoView() {} };
  details.open = false;
  doc.getElementById = (id) => (id === 'dr-sec-how' ? how : null);
  assert.equal(S._drScrollTo('dr-sec-how'), true);
  assert.equal(how.open, true);
  assert.equal(details.open, true);
});

test('the Details anchor remains active across its disclosure contents', () => {
  const S = loadSidebar();
  const doc = S._drTestDoc;
  const wrap = S._createDrSections();
  doc.querySelectorAll = (sel) => wrap.querySelectorAll(sel);
  const details = { tagName: 'DETAILS', open: false, parentElement: null, offsetParent: {}, getBoundingClientRect: () => ({ top: 50 }) };
  const at = (top, parent) => ({ tagName: 'DIV', parentElement: parent, offsetParent: {}, getBoundingClientRect: () => ({ top }) });
  const els = { 'dr-sec-sessions': at(-400, null), 'dr-sec-details': details, 'dr-sec-config': at(60, details), 'dr-sec-actions': at(400, details) };
  doc.getElementById = (id) => els[id] || null;
  const box = { scrollTop: 300, clientHeight: 800, scrollHeight: 4000, getBoundingClientRect: () => ({ top: 0 }) };
  doc.scrollingElement = box;
  S._drActive = null;
  S._drPositionPass(box);
  assert.equal(S._drActive, 'dr-sec-details');
  assert.equal(S._drClosedAround(els['dr-sec-config']), details);
  assert.equal(S._drClosedAround(details), null, 'never the element itself');
  details.open = true;
  S._drPositionPass(box);
  assert.equal(S._drActive, 'dr-sec-details');
});

test('legacy detail section IDs remain available for direct navigation', () => {
  const S = loadSidebar();
  const doc = S._drTestDoc;
  const details = { tagName: 'DETAILS', open: false, parentElement: null };
  const target = { tagName: 'DIV', parentElement: details, scrollIntoView() {} };
  doc.getElementById = (id) => (id === 'dr-sec-fleet' ? target : null);
  S.currentPage = 'detection-response';
  assert.equal(S._drScrollTo('dr-sec-fleet'), true);
  assert.equal(details.open, true);
  assert.match(read('js/pages/detection-response.js'), /id="dr-sec-fleet"/);
});
