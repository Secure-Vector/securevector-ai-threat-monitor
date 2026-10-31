'use strict';

// The shell watcher for suspicious egress: alerts are never lost when the
// Guardian is hidden or the tab was in the background (owner, 6.1).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

function el(tag) {
  const e = {
    tag, kids: [], attrs: {}, hidden: false, textContent: '', className: '', innerHTML: '', title: '',
    appendChild(k) { this.kids.push(k); k.parent = this; return k; },
    setAttribute(k, v) { this.attrs[k] = v; },
    querySelector(sel) {
      if (sel === '.sv-alert-count') return this.kids.find(k => /sv-alert-count/.test(k.className)) || null;
      if (sel === '.sv-eaw-yes' || sel === '.sv-eaw-no') {
        this._btn = this._btn || {};
        if (!this._btn[sel]) this._btn[sel] = { addEventListener: (t, fn) => { this._btn[sel].fn = fn; } };
        return this._btn[sel];
      }
      return null;
    },
    addEventListener() {},
    remove() { this.removed = true; },
  };
  return e;
}

function load(opts = {}) {
  const store = new Map(Object.entries(opts.store || {}));
  const tab = el('button');
  const nav = el('div');
  const body = el('body');
  const notes = [];
  const sandbox = {
    console, setTimeout, clearTimeout,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    document: {
      hidden: false, body, head: el('head'),
      createElement: (t) => el(t),
      getElementById: () => null,
      querySelectorAll: (sel) => (sel.includes('live-grid') ? [tab] : sel.includes('agent-runs') ? [nav] : []),
    },
  };
  if (opts.permission) {
    const N = function (title, o) { notes.push({ title, body: o.body, tag: o.tag }); };
    N.permission = opts.permission;
    N.requestPermission = () => { N.asked = true; return Promise.resolve('granted'); };
    sandbox.Notification = N;
  }
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('js/components/egress-alert-watch.js'), sandbox);
  return { W: sandbox.EgressAlertWatch, store, tab, nav, body, notes, sb: sandbox };
}

const A = (id, reasons, extra = {}) => Object.assign({ id, session_id: id.split('|')[0], host: id.split('|')[1],
  reasons, label: 'x', text: `Codex ${id} alert.` }, extra);
const NOW = Date.parse('2026-10-25T12:00:00Z');

test('new alerts are kept until acknowledged and counted on both badges', () => {
  const { W, tab, nav } = load();
  const fresh = W.ingest([A('s1|paste.ee', ['share_host']), A('s2|h.example.test', ['new_host'])], NOW);
  assert.equal(fresh.length, 2);
  assert.equal(W.count(), 2);
  const b = tab.kids.find(k => /sv-alert-count/.test(k.className));
  assert.equal(b.textContent, '2');
  assert.equal(b.attrs['aria-label'], '2 security alerts on the Live grid');
  assert.equal(nav.kids[0].textContent, '2');
  // the same poll again adds nothing
  assert.equal(W.ingest([A('s1|paste.ee', ['share_host'])], NOW).length, 0);
  W.acknowledge(['s1|paste.ee']);
  assert.equal(W.count(), 1);
  W.acknowledge();
  assert.equal(W.count(), 0);
  assert.equal(b.hidden, true);
  // acknowledged stays quiet, a stronger reason comes back
  assert.equal(W.ingest([A('s1|paste.ee', ['share_host'])], NOW).length, 0);
  assert.equal(W.ingest([A('s1|paste.ee', ['blocked', 'share_host'])], NOW).length, 1);
});

test('the badge works with the Guardian hidden: nothing here depends on it', () => {
  const { W, tab } = load({ store: { 'sv-guardian-hidden': '1', 'sv-guardian-quiet': '1' } });
  W.ingest([A('s1|paste.ee', ['share_host'])], NOW);
  assert.equal(tab.kids[0].textContent, '1');
  assert.ok(!/GuardianAssistant/.test(read('js/components/egress-alert-watch.js').replace(/\/\*\*[\s\S]*?\*\//, '')));
});

test('turning "Alert me on suspicious egress" off hides the badge and sends nothing', () => {
  const { W, tab, notes } = load({ store: { 'sv-guardian-egress-alerts': '0' }, permission: 'granted' });
  W.ingest([A('s1|paste.ee', ['share_host'])], NOW);
  assert.equal(W.count(), 0);
  assert.equal(notes.length, 0);
  assert.equal(tab.kids.length, 0);
});

test('a hidden tab catches up from the last look, never more than a day back', () => {
  const { W } = load();
  assert.equal(W.sinceFor(null, NOW), null);
  assert.equal(W.sinceFor(new Date(NOW - 5 * 60000).toISOString(), NOW), null);
  assert.equal(W.sinceFor(new Date(NOW - 3 * 3600000).toISOString(), NOW), new Date(NOW - 3 * 3600000).toISOString());
  assert.equal(W.sinceFor(new Date(NOW - 72 * 3600000).toISOString(), NOW), new Date(NOW - 24 * 3600000).toISOString());
  const calls = [];
  const w2 = load();
  w2.store.set('sv-egress-watch', JSON.stringify({ ack: {}, pending: [], lastSeenAt: new Date(Date.now() - 2 * 3600000).toISOString() }));
  w2.sb.API = { getEgressAlerts: (p) => { calls.push(p); return Promise.resolve({ alerts: [A('s9|paste.ee', ['share_host'])] }); } };
  return w2.W.tick().then((fresh) => {
    assert.ok(calls[0].since, 'asked with since');
    assert.equal(fresh.length, 1);
    assert.equal(w2.W.count(), 1);
  });
});

test('a system notification per new alert when allowed; asked once, with a plain prompt, when undecided', () => {
  const g = load({ permission: 'granted' });
  g.W.ingest([A('s1|paste.ee', ['share_host'], { text: 'Codex s1 sent data to paste.ee, a paste site.' })], NOW);
  assert.deepEqual(JSON.parse(JSON.stringify(g.notes)), [{ title: 'SecureVector security alert', body: 'Codex s1 sent data to paste.ee, a paste site.', tag: 's1|paste.ee' }]);

  const d = load({ permission: 'default' });
  d.W.ingest([A('s1|paste.ee', ['share_host'])], NOW);
  const box = d.body.kids.find(k => k.className === 'sv-eaw-ask');
  assert.ok(box, 'prompt shown');
  assert.match(box.innerHTML, /Get a desktop notification when an agent sends data somewhere suspicious\?/);
  assert.equal(d.store.get('sv-egress-notify-asked'), '1');
  box._btn['.sv-eaw-yes'].fn();
  assert.equal(d.sb.Notification.asked, true);
  d.W.ingest([A('s2|paste.ee', ['share_host'])], NOW);
  assert.equal(d.body.kids.filter(k => k.className === 'sv-eaw-ask').length, 1, 'never asked twice');

  const n = load({ permission: 'denied' });
  n.W.ingest([A('s1|paste.ee', ['share_host'])], NOW);
  assert.equal(n.W.count(), 1, 'denied: the badge stays');
  assert.equal(n.body.kids.length, 0);

  const none = load();
  none.W.ingest([A('s1|paste.ee', ['share_host'])], NOW);
  assert.equal(none.W.count(), 1, 'no Notification API: the badge stays');
});

test('opening the Live grid acknowledges, and the shell starts the watcher', () => {
  const w = load();
  w.sb.App = { currentPage: 'live-grid' };
  w.W.ingest([A('s1|paste.ee', ['share_host'])], NOW);
  assert.equal(w.W.count(), 0);
  assert.match(read('js/app.js'), /if \(window\.EgressAlertWatch\) EgressAlertWatch\.start\(\);/);
  assert.match(read('js/pages/live-grid.js'), /if \(window\.EgressAlertWatch\) EgressAlertWatch\.acknowledge\(\);/);
  const html = read('index.html');
  assert.match(html, /egress-alert-watch\.js\?v=2/);
  assert.match(html, /app\.js\?v=80/);
  assert.ok(html.indexOf('egress-alert-watch.js') < html.indexOf('/js/app.js'));
  assert.ok(!/—/.test(read('js/components/egress-alert-watch.js')), 'no em dashes');
});

test('polling continues while hidden, once a minute', () => {
  const { W } = load();
  assert.equal(W.POLL_MS, 20000);
  assert.equal(W.HIDDEN_POLL_MS, 60000);
  W._lastPoll = NOW;
  assert.equal(W.due(false, NOW + 20000), true, 'visible: every beat');
  assert.equal(W.due(true, NOW + 20000), false, 'hidden: not yet');
  assert.equal(W.due(true, NOW + 40000), false);
  assert.equal(W.due(true, NOW + 60000), true, 'hidden: a minute later');
  const src = read('js/components/egress-alert-watch.js');
  assert.match(src, /every 60 s while it is hidden/);
});
