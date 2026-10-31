'use strict';

// Live grid ended sessions ("Keep it, dimmed") and Guardian security alerts
// that break mute (owner, 6.1).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

function loadModel() {
  const window = {};
  vm.runInNewContext(read('js/components/run-trace.js'), { window, console });
  vm.runInNewContext(read('js/components/live-grid-model.js'), { window, console });
  return window.LiveGridModel;
}

function sess(id, extra = {}) {
  return Object.assign({
    session_id: id, harness: 'codex', project: null, quiet_seconds: 10, waiting: 0, blocked: 0,
    score: null, cost_usd: null, tokens: 0, coverage_level: 'partial',
    tool_calls: { total: 1, allowed: 1, logged: 0, waiting: 0, blocked: 0 },
  }, extra);
}

const NOW = Date.parse('2026-10-25T12:00:00Z');

test('an ended session keeps a dimmed tile that says "ended 4m ago"', () => {
  const M = loadModel();
  const s = sess('4ad2e7c0-aaaa', { ended: true, quiet_seconds: 240, last_activity_at: new Date(NOW - 240000).toISOString() });
  const html = M.compactTileHtml(s, false, false, { now: NOW });
  assert.match(html, /class="lg-cw st-ended[^"]* ended"/);
  assert.match(html, /data-ended="1">ended 4m ago</);
  assert.ok(!/updated 4m ago/.test(html));
  assert.equal(M.state(s), 'ended');
  assert.equal(M.stateLine(s), 'ended 4m ago');
  // a running tile still says "updated"
  const r = M.compactTileHtml(sess('r1', { last_activity_at: new Date(NOW - 5000).toISOString() }), false, false, { now: NOW });
  assert.match(r, /updated 5s ago/);
  assert.ok(!/ ended"/.test(r));
  assert.equal(M.agoText(NOW - 60000, NOW, true), 'ended 1m ago');
});

test('"Running only" sits next to Waiting, Blocked and Quiet and hides ended tiles', () => {
  const M = loadModel();
  const list = [sess('a'), sess('b', { ended: true, quiet_seconds: 900 }), sess('c', { waiting: 1 }),
    sess('d', { ended: true, blocked: 2, quiet_seconds: 700 })];
  const html = M.chipsHtml(list, '');
  const labels = [...html.matchAll(/data-key="(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(labels, ['waiting', 'blocked', 'quiet', 'running']);
  assert.match(html, /Running only<span class="lg-chip-n">2<\/span>/);
  // attention chips count running sessions only
  assert.deepEqual(JSON.parse(JSON.stringify(M.chipCounts(list))), { waiting: 1, blocked: 0, quiet: 0, running: 2 });
  assert.deepEqual(M.filter(list, { chip: 'running' }).map(s => s.session_id), ['a', 'c']);
  assert.deepEqual(M.filter(list, {}).map(s => s.session_id), ['a', 'b', 'c', 'd']);
  const c = M.counters(list);
  assert.equal(c.running, 2);
  assert.equal(c.ended, 2);
  assert.equal(c.blocked_sessions, 0);
  assert.equal(M.chipToggle('running', 'running'), '');
});

test('a session that ends keeps its place: the tile neither moves nor vanishes', () => {
  const M = loadModel();
  const first = [sess('a', { score: 90 }), sess('b', { score: 50 }), sess('c', { score: 10 })];
  const prev = M.order(null, first, false, []);
  assert.deepEqual(prev, ['a', 'b', 'c']);
  const later = [sess('a', { score: 90, ended: true, quiet_seconds: 700 }), sess('b', { score: 50 }), sess('c', { score: 10 }),
    sess('n', { score: 99 })];
  const next = M.order(prev, later, false, M.waitingIds(first));
  // The new running session joins at the top; the ended one stays put.
  assert.deepEqual(next, ['n', 'a', 'b', 'c']);
  assert.deepEqual(M.arrange(later, next).map(s => s.session_id), ['n', 'a', 'b', 'c']);
  // a fresh sort puts ended tiles last
  assert.deepEqual(M.order(null, later, true).slice(-1), ['a']);
  // the signature changes when a session ends, so the tile repaints dimmed
  const sig = (l) => M.signature({ sessions: l }, {}, NOW);
  assert.notEqual(sig(first.slice(0, 1)), sig([sess('a', { score: 90, ended: true })]));
});

test('a suspicious egress turns the tile red with the reason', () => {
  const M = loadModel();
  const s = sess('4ad2e7c0-bbbb', {
    alert: { id: '4ad2e7c0-bbbb|paste.ee', host: 'paste.ee', label: 'paste site, after reading .env',
      text: 'Codex 4ad2e7c0 sent data to paste.ee, a paste site, right after reading .env.' },
  });
  const html = M.compactTileHtml(s, false, false, { now: NOW });
  assert.match(html, /class="lg-cw st-running alert"/);
  assert.match(html, /class="lg-c st-running alert"/);
  assert.match(html, /<span class="lg-c-alert-w">Check egress<\/span> paste\.ee: paste site, after reading \.env/);
  assert.match(html, /aria-label="[^"]*suspicious egress: Codex 4ad2e7c0 sent data to paste\.ee/);
  const css = read('js/pages/live-grid.js');
  assert.match(css, /\.lg-cw\.alert[^{]*\{[^}]*var\(--lg-bad\)/);
  assert.match(css, /\.lg-cw\.ended \{ opacity:/);
  assert.ok(!/—/.test(css.slice(css.indexOf('Ended: the tile'))), 'no em dashes');
});

// --------------------------------------------------------------- Guardian

function fakeEl() {
  const el = {
    dataset: {}, isConnected: true, className: '', _attrs: {}, _kids: {}, innerHTML: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(k, v) { this._attrs[k] = v; },
    addEventListener(t, fn) { this._on = fn; },
    remove() { this.isConnected = false; },
    querySelector(sel) {
      if (sel === '.sv-ga-bubble-mute' && !/sv-ga-bubble-mute/.test(this.innerHTML)) return null;
      if (!this._kids[sel]) this._kids[sel] = fakeEl();
      return this._kids[sel];
    },
  };
  return el;
}

function loadGuardian(store) {
  const m = new Map(Object.entries(store || {}));
  const localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
  const body = { appended: [], appendChild(el) { this.appended.push(el); } };
  const sandbox = {
    window: {}, console, localStorage, setTimeout: () => 0, clearTimeout: () => {},
    requestAnimationFrame: (fn) => fn(),
    document: { createElement: () => fakeEl(), body },
  };
  sandbox.window = sandbox; // globals and window.* are one object, as in a browser
  vm.createContext(sandbox);
  vm.runInContext(read('js/components/guardian-assistant.js'), sandbox);
  const GA = sandbox.window.GuardianAssistant;
  GA._fab = {};
  GA._placeNear = () => {};
  GA._react = () => {};
  GA._thoughtPlace = () => {};
  GA._currentPage = () => 'terminals'; // a page where tips never bubble
  return { GA, m, body, win: sandbox.window };
}

const ALERT = { id: '4ad2e7c0-x|paste.example.test', session_id: '4ad2e7c0-x', host: 'paste.example.test',
  text: 'Codex 4ad2e7c0 sent data to paste.example.test, a paste site, right after reading .env.' };

test('mute silences tips only: a security alert still shows', () => {
  const { GA, body } = loadGuardian({ 'sv-guardian-quiet': '1' });
  assert.equal(GA._speak({ text: 'a tip', cta: 'See' }), false, 'a tip stays quiet when muted');
  assert.equal(GA._securityShow([ALERT]), true);
  const b = body.appended[body.appended.length - 1];
  assert.equal(b.dataset.kind, 'security');
  assert.equal(b._attrs.role, 'alert');
  assert.match(b.innerHTML, /Security alert/);
  assert.ok(!/sv-ga-bubble-mute/.test(b.innerHTML), 'no mute button on a security alert');
  assert.equal(b._kids['.sv-ga-bubble-t'].textContent, ALERT.text);
  assert.equal(b._kids['.sv-ga-bubble-go'].textContent, 'Review');
  // muting while it shows does not hide it
  GA._setQuiet(true);
  assert.equal(GA._bubbleEl, b);
});

test('each (session, host) alerts once, and more alerts are counted, not stacked', () => {
  const { GA, m } = loadGuardian();
  const two = [ALERT, Object.assign({}, ALERT, { id: 'other|h.example.test', host: 'h.example.test', text: 'Codex other reached h.example.test.' })];
  assert.equal(GA._securityShow(two), true);
  assert.equal(GA._bubbleEl._kids['.sv-ga-bubble-t'].textContent, `${ALERT.text} 1 more on the Live grid.`);
  GA._hideBubble();
  assert.equal(GA._securityShow(two), false, 'already shown');
  assert.deepEqual(Object.keys(JSON.parse(m.get('sv-ga-egress-seen'))).sort(), ['4ad2e7c0-x|paste.example.test', 'other|h.example.test']);
  assert.equal(GA._egressPick([ALERT, ALERT], {}).length, 1);
});

test('"Alert me on suspicious egress" is on by default and turning it off is separate from mute', () => {
  const { GA } = loadGuardian();
  assert.equal(GA._egressAlertsOn(), true);
  GA._setQuiet(false);
  GA._setEgressAlertsOn(false);
  assert.equal(GA._egressAlertsOn(), false);
  assert.equal(GA._quiet(), false);
  assert.equal(GA._securityShow([ALERT]), false);
  const src = read('js/components/guardian-assistant.js');
  assert.match(src, /Alert me on suspicious egress: on, even when tips are muted\. Turn off/);
  assert.match(src, /LiveGridPage\._pendingOpen = openSession/);
  assert.match(read('js/pages/live-grid.js'), /if \(this\._pendingOpen\) \{ this\._open = M\.ensureOpen\(this\._open, this\._pendingOpen\)/);
});

test('a security alert outranks a tip already on screen and Review opens the Live grid tile', () => {
  const { GA, win } = loadGuardian();
  GA._currentPage = () => 'costs';
  assert.equal(GA._speak({ text: 'a tip', cta: 'See' }), true);
  assert.equal(GA._securityShow([ALERT]), true);
  const b = GA._bubbleEl;
  assert.equal(b.dataset.kind, 'security');
  let went = null;
  win.LiveGridPage = {};
  win.Sidebar = { navigate: (p) => { went = p; } };
  b._kids['.sv-ga-bubble-go']._on();
  assert.equal(went, 'live-grid');
  assert.equal(win.LiveGridPage._pendingOpen, ALERT.session_id);
});

test('the server endpoint is wrapped and the versions are bumped', () => {
  assert.match(read('js/api.js'), /getEgressAlerts\(params = \{\}\) \{[\s\S]{0,200}observability\/egress-alerts\$\{qs\}/);
  const html = read('index.html');
  assert.match(html, /api\.js\?v=349/);
  assert.match(html, /guardian-assistant\.js\?v=54/);
});

test('a session waiting for approval reads as waiting, never ended', () => {
  const M = loadModel();
  const s = sess('w1', { ended: true, waiting: 1, quiet_seconds: 900 });
  assert.equal(M.state(s), 'waiting');
  assert.match(M.stateLine(s), /^waiting for approval/);
});

test('the same (session, host) alerts again only when a stronger reason arrives', () => {
  const { GA } = loadGuardian();
  const paste = Object.assign({}, ALERT, { reasons: ['share_host'] });
  assert.equal(GA._securityShow([paste]), true);
  GA._hideBubble();
  assert.equal(GA._securityShow([Object.assign({}, paste, { reasons: ['share_host', 'new_host'] })]), false, 'not stronger');
  const cred = Object.assign({}, paste, { reasons: ['cred_then_net', 'share_host'], text: 'Codex 4ad2e7c0 sent data to paste.example.test, a paste site, right after reading .env.' });
  assert.equal(GA._securityShow([cred]), true, 'a credential read escalates');
  GA._hideBubble();
  assert.equal(GA._securityShow([Object.assign({}, cred, { reasons: ['blocked', 'cred_then_net', 'share_host'] })]), false, 'already at the top');
  // an entry saved by the older format (a plain time) counts as strength 1
  assert.equal(GA._seenS(12345), 1);
  assert.equal(GA._egressPick([cred], { [cred.id]: 12345 }).length, 1);
});

test('the Guardian speaks from the shell watcher when it is there', () => {
  const { GA, win } = loadGuardian();
  win.EgressAlertWatch = { latest: () => [ALERT] };
  return GA._securityTick().then((spoke) => {
    assert.equal(spoke, true);
    assert.equal(GA._bubbleEl.dataset.kind, 'security');
  });
});
