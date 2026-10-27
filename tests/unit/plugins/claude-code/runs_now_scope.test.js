/** Observability > Runs, running session header: Blocked counts the
 *  session's runs in the selected range (the same runs the summary line
 *  counts); egress is red only for a blocked or flagged destination, never
 *  for loopback; and the list fits narrow widths (low-priority columns give
 *  way, the "now" segment wraps onto its own line, no page scroll). */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');
const NOW = Date.parse('2026-10-26T14:30:00Z');

function loadAll() {
  const window = {};
  const sandbox = { window, console };
  vm.createContext(sandbox);
  vm.runInContext(read('js/components/trace-steps.js'), sandbox);
  sandbox.TraceSteps = window.TraceSteps;
  vm.runInContext(read('js/components/run-trace.js'), sandbox);
  vm.runInContext(read('js/components/runs-list.js'), sandbox);
  vm.runInContext(read('js/components/live-grid-model.js'), sandbox);
  return { RL: window.RunsList, LGM: window.LiveGridModel, RT: window.RunTrace };
}

const live = (over) => Object.assign({
  session_id: 's1', blocked: 11, waiting: 0, quiet_seconds: 1080,
  egress_visible: true, last_egress: { host: 'localhost', action: 'allow' },
}, over || {});

// ------------------------------------------------- 1. blocked count scope

test('header Blocked counts the session runs in range, not the live all-time total', () => {
  const { RL, LGM, RT } = loadAll();
  const n = RL.sessionNow(live(), NOW, LGM, RT, { blocked: 1, rangeKey: '24h' });
  assert.equal(n.gov.text, 'Blocked 1');
  assert.equal(n.gov.key, 'blocked');
  assert.equal(n.gov.title, '1 blocked call in this session, last 24h');
});

test('header shows Governed when the session has no blocked calls in range', () => {
  const { RL, LGM, RT } = loadAll();
  const n = RL.sessionNow(live({ blocked: 11 }), NOW, LGM, RT, { blocked: 0, rangeKey: '7d' });
  assert.equal(n.gov.text, 'Governed');
  assert.equal(n.gov.title, '0 blocked calls in this session, last 7 days');
});

test('without a scope the live row count is kept (other callers unchanged)', () => {
  const { RL, LGM, RT } = loadAll();
  assert.equal(RL.sessionNow(live(), NOW, LGM, RT).gov.text, 'Blocked 11');
});

test('header totals and the summary refused count agree when all runs are listed', () => {
  const { RL, LGM, RT } = loadAll();
  const runs = [
    { trace_id: 'a', session_id: 's1', blocked: 1 }, { trace_id: 'b', session_id: 's1', blocked: 0 },
    { trace_id: 'c', session_id: 's2', blocked: 2 },
  ];
  const refused = RL.summaryItems(runs, { now: NOW, live: {} }, '24h', { decision: [] }, null).find(i => i.key === 'refused').n;
  const perSession = ['s1', 's2'].map(sid => {
    const mine = runs.filter(r => r.session_id === sid);
    const n = RL.sessionNow(live({ session_id: sid }), NOW, LGM, RT,
      { blocked: mine.reduce((a, r) => a + Number(r.blocked || 0), 0), rangeKey: '24h' });
    return Number(n.gov.text.replace(/\D+/g, '')) || 0;
  });
  assert.equal(perSession.reduce((a, b) => a + b, 0), refused);
  assert.equal(refused, 3);
});

test('the Runs page passes the session runs in range to the now segment', () => {
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /this\._sessionNowHtml\(first\.session_id, sessRuns\)/);
  assert.match(src, /runs\.reduce\(\(a, r\) => a \+ Number\(r\.blocked \|\| 0\), 0\), rangeKey: this\.range,/);
  assert.match(src, /filtered: !!\(this\.filters && Array\.isArray\(this\.filters\.decision\) && this\.filters\.decision\.length\)/);
  assert.doesNotMatch(src, /--rl-now-x/);
  assert.match(src, /n\.gov\.title \? ` title="\$\{this\._esc\(n\.gov\.title\)\}"`/);
});

// ------------------------------------------------------- 3. egress colour

test('loopback egress is neutral, even when the call to it was blocked', () => {
  const { LGM } = loadAll();
  for (const host of ['localhost', 'LOCALHOST.', ' localhost:8741 ', '127.0.0.1', '127.8.9.10', '127.255.255.255', '::1', '[::1]:8741']) {
    for (const action of ['allow', 'block', 'observed']) {
      const es = LGM.egressState(live({ last_egress: { host, action } }), null);
      assert.equal(es.key, 'host', `${host} ${action}`);
    }
  }
});

test('an ordinary allowed host is neutral; a blocked one is red', () => {
  const { LGM } = loadAll();
  assert.equal(LGM.egressState(live({ last_egress: { host: 'api.github.com', action: 'allow' } }), null).key, 'host');
  assert.equal(LGM.egressState(live({ last_egress: { host: 'paste.example', action: 'block' } }), null).key, 'blocked');
  // 127.x lookalikes are not loopback.
  assert.equal(LGM.egressState(live({ last_egress: { host: '127.0.0.1.evil.example', action: 'block' } }), null).key, 'blocked');
});

test('a destination flagged by the suspicious-egress rules is red', () => {
  const { LGM } = loadAll();
  const s = live({ last_egress: { host: 'x.trycloudflare.com', action: 'allow' }, alert: { host: 'x.trycloudflare.com', label: 'tunnel' } });
  assert.equal(LGM.egressState(s, null).key, 'blocked');
  // An alert on another host wins: the flagged host shows, in red.
  const t = live({ last_egress: { host: 'api.github.com', action: 'allow' }, alert: { host: 'x.trycloudflare.com' } });
  assert.equal(LGM.egressState(t, null).key, 'blocked');
  assert.equal(LGM.egressState(t, null).text, 'x.trycloudflare.com');
});

test('the live grid uses the same rule (governance host list)', () => {
  const { LGM } = loadAll();
  const gov = { egress: { visible: true, hosts: [{ host: '127.0.0.1', status: 'blocked' }] } };
  assert.equal(LGM.egressState({ last_egress: null }, gov).key, 'host');
  const gov2 = { egress: { visible: true, hosts: [{ host: 'evil.example', status: 'blocked' }] } };
  assert.equal(LGM.egressState({ last_egress: null }, gov2).key, 'blocked');
});

test('Runs header: "Egress localhost" is not red', () => {
  const { RL, LGM, RT } = loadAll();
  const n = RL.sessionNow(live({ last_egress: { host: 'localhost', action: 'block' } }), NOW, LGM, RT, { blocked: 2, rangeKey: '24h' });
  assert.equal(n.egress.text, 'Egress localhost');
  assert.notEqual(n.egress.key, 'blocked');
});

// ------------------------------------------- 2 and 4. narrow-width layout

function cssOf() {
  return read('js/pages/agent-runs.js');
}

function block(css, at) {
  const i = css.indexOf(at);
  assert.ok(i >= 0, `missing ${at}`);
  let depth = 0, j = css.indexOf('{', i);
  const start = j;
  for (; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}' && --depth === 0) break;
  }
  return css.slice(start, j + 1);
}

test('the list box is a size container that still scrolls inside itself', () => {
  const css = cssOf();
  assert.match(css, /\.rl-tablewrap \{[^}]*overflow-x:auto/);
  assert.match(css, /\.rl-tablewrap \{ container-type:inline-size; max-width:100%; \}/);
});

test('under 800px: Duration, Tokens and Cost give way and the table drops its floor', () => {
  const b = block(cssOf(), '@container (max-width:800px)');
  assert.match(b, /\.ar-runlist\.rl-table, \.ar-runlist\.rl-table\.rl-flatlist \{ min-width:0; \}/);
  assert.match(b, /\.rl-hd > \.rl-c:nth-last-child\(-n\+3\), \.rl-row > \.rl-c:nth-last-child\(-n\+3\) \{ display:none; \}/);
  // Grouped: 7 columns become 4; flat: 9 become 6.
  const cols = [...b.matchAll(/--rl-cols:([^;]+);/g)].map(m => m[1].trim().split(/\s+(?![^(]*\))/).length);
  assert.deepEqual(cols, [4, 6]);
  assert.match(b, /\.rl-hd \.rl-c \{ white-space:normal; \}/);
});

test('under 800px the session header wraps and the now segment takes its own line', () => {
  const b = block(cssOf(), '@container (max-width:800px)');
  assert.match(b, /\.rl-sh, \.rl-sh\.rl-sh-wait \{ flex-wrap:wrap; \}/);
  assert.match(b, /\.rl-sh \.rl-now, \.rl-sh\.rl-sh-wait \.rl-now \{ order:1; flex:1 1 100%; max-width:100%; padding-left:75px;/);
});

test('under 520px the grouped list drops Started; the flat list scrolls in its own box', () => {
  const b = block(cssOf(), '@container (max-width:520px)');
  assert.match(b, /\.rl-table:not\(\.rl-flatlist\) \{ --rl-cols:minmax\(0,1fr\) minmax\(0,1\.1fr\) 96px; \}/);
  assert.match(b, /:nth-child\(1 of \.rl-c\)[^{]*\{ display:none; \}/);
  assert.match(b, /\.ar-runlist\.rl-table\.rl-flatlist \{ min-width:600px; \}/);
});

test('row cells end with Duration, Tokens, Cost so nth-last-child hides exactly those', () => {
  const src = cssOf();
  // Run rows and inline span rows: the last three cells pushed are duration, tokens, cost.
  assert.match(src, /cells\.push\(`<span class="rl-c rl-r rl-sub">\$\{this\._esc\(this\._fmtDur\(RL\.shownDuration\(r, ctx\)\)\)\}<\/span>`\);\n\s+cells\.push\(`<span class="rl-c rl-r">\$\{this\._esc\(RunsList\.tokensText\(r\.tokens\)/);
  assert.match(src, /\['duration', 'Duration', true\], \['tokens', 'Tokens', true\], \['cost', 'Cost', true\]\]\)\);/);
  assert.match(src, /\+ cells\.join\(''\);/);
});

// ------------------------------------------------- review follow-ups

test('Blocked title names the Decision filter when one is on', () => {
  const { RL, LGM, RT } = loadAll();
  const n = RL.sessionNow(live(), NOW, LGM, RT, { blocked: 2, rangeKey: '24h', filtered: true });
  assert.equal(n.gov.title, '2 blocked calls in this session, last 24h with the current filters');
  const g = RL.sessionNow(live(), NOW, LGM, RT, { blocked: 0, rangeKey: '24h', filtered: true });
  assert.equal(g.gov.title, '0 blocked calls in this session, last 24h with the current filters');
});

test('alert and egress hosts compare after the same normalisation', () => {
  const { LGM } = loadAll();
  assert.equal(LGM.normHost(' [X.Trycloudflare.COM.]:443 '), 'x.trycloudflare.com');
  assert.equal(LGM.normHost('X.trycloudflare.com.:443'), 'x.trycloudflare.com');
  const pairs = [['X.Trycloudflare.com.', 'x.trycloudflare.com'], ['x.trycloudflare.com:443', ' X.TRYCLOUDFLARE.COM '], ['[2001:db8::1]', '2001:db8::1']];
  for (const [eg, al] of pairs) {
    assert.equal(LGM.egressRed({ alert: { host: al } }, eg, false), true, `${eg} vs ${al}`);
  }
  assert.equal(LGM.egressRed({ alert: { host: 'a.example' } }, 'b.example', false), false);
});

test('a flagged host wins over a different last egress host, in red', () => {
  const { LGM, RL, RT } = loadAll();
  const s = live({ last_egress: { host: 'localhost', action: 'allow' }, alert: { host: 'x.trycloudflare.com', label: 'tunnel' } });
  const es = LGM.egressState(s, null);
  assert.equal(es.key, 'blocked');
  assert.equal(es.text, 'x.trycloudflare.com');
  const n = RL.sessionNow(s, NOW, LGM, RT, { blocked: 0, rangeKey: '24h' });
  assert.equal(n.egress.text, 'Egress x.trycloudflare.com');
  assert.equal(n.egress.key, 'blocked');
  // Governance host list: the alert host still leads.
  const gov = { egress: { visible: true, hosts: [{ host: 'api.github.com', status: 'allowed' }] } };
  assert.equal(LGM.egressState({ alert: { host: 'x.trycloudflare.com' } }, gov).text, 'x.trycloudflare.com');
});

test('loopback is exactly localhost, 127.0.0.0/8 with valid octets, or ::1', () => {
  const { LGM } = loadAll();
  for (const h of ['localhost', 'LocalHost.', '127.0.0.1', '127.0.0.0', '127.255.255.255', '[127.0.0.1]', '::1', '[::1]:8741'])
    assert.equal(LGM.isLoopback(h), true, h);
  for (const h of ['app.localhost', 'foo.localhost', 'ip6-localhost', 'localhost.evil.example', '127.0.0.256', '127.999.0.1',
    '127.0.0', '127.0.0.1.evil.example', '0:0:0:0:0:0:0:1', '128.0.0.1', '::2', ''])
    assert.equal(LGM.isLoopback(h), false, h);
  // A blocked *.localhost host is not loopback, so it stays red.
  assert.equal(LGM.egressState(live({ last_egress: { host: 'app.localhost', action: 'block' } }), null).key, 'blocked');
});
