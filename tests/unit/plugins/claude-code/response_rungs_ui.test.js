/** Response rungs UI: facts chip, summary row, Settings card. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

function load() {
  const window = {};
  const sandbox = { window, document: {}, console };
  vm.runInNewContext(read('js/components/response-rungs.js') + '\nwindow.__R = ResponseRungs;', sandbox);
  return window.__R;
}

// Minimal DOM host: records innerHTML and hands out clickable stubs by selector.
function fakeHost() {
  const els = {};
  const host = {
    innerHTML: '',
    querySelector(sel) { return els[sel] || (els[sel] = { onclick: null, attrs: {}, hidden: false, textContent: '', getAttribute(k) { return this.attrs[k]; }, querySelector() { return { onclick: null }; } }); },
    querySelectorAll() { return []; },
  };
  return { host, els };
}

test('chip words and colours', () => {
  const R = load();
  assert.strictEqual(R.chipHtml({}), '');
  const cases = [
    [{ rung_word: 'observe', rung_mode: 'shadow' }, 'observe', 'is-observe'],
    [{ rung_word: 'flag', rung_mode: 'shadow' }, 'flag', 'is-flag'],
    [{ rung_word: 'step-up', rung_mode: 'active' }, 'step-up', 'is-stepup'],
    [{ rung_word: 'step-up', rung_mode: 'shadow' }, 'step-up, shadow', 'is-stepup-shadow'],
  ];
  for (const [t, word, cls] of cases) {
    const html = R.chipHtml(t);
    assert.ok(html.includes('>' + word + '<'), html);
    assert.ok(html.includes(cls), html);
  }
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-task-rung\.is-flag[^{]*\{ color: var\(--warning/);
  assert.match(css, /\.terminals-task-rung\.is-stepup[^{]*\{ color: var\(--danger/);
});

test('terminals page puts the chip in the facts line and the row under Drift', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /ResponseRungs\.chipHtml\(t\)/);
  assert.ok(src.indexOf("row('Drift'") < src.indexOf("row('Response'"));
});

test('summary row words, reasons and buttons', () => {
  const R = load();
  const d = R.summaryData({ word: 'step-up', rung: 3, mode: 'shadow', reasons: ['drift', 'deny'], would_ask: 3 });
  const html = R.summaryHtml(d, false);
  assert.match(html, /drift band, retried after a denial/);
  assert.match(html, /would need approval for 3 calls/);
  for (const a of ['data-rung-release', 'data-rung-notneeded', 'data-rung-stop']) assert.ok(html.includes(a), a);
  assert.ok(!R.summaryHtml(d, true).includes('data-rung-stop'));
  const flag = R.summaryHtml(R.summaryData({ word: 'flag', rung: 2, mode: 'shadow', reasons: ['config'] }), false);
  assert.match(flag, /setup change/);
  assert.ok(!flag.includes('data-rung-stop'));
});

test('buttons call the right routes', async () => {
  const R = load();
  const calls = [];
  const api = {
    terminalsRungRelease: async (id) => { calls.push(['release', id]); return { word: 'observe', rung: 1, mode: 'shadow', reasons: [] }; },
    terminalsRungFeedback: async (id, f) => { calls.push(['feedback', id, f]); },
  };
  const { host, els } = fakeHost();
  const d = R.summaryData({ word: 'flag', rung: 2, mode: 'shadow', reasons: ['drift'] });
  R.wire(host, { id: 't1' }, d, api, async () => calls.push(['stop']));
  await els['[data-rung-release]'].onclick();
  await els['[data-rung-notneeded]'].onclick();
  await els['[data-rung-stop]'].onclick();
  assert.deepStrictEqual(calls, [['release', 't1'], ['feedback', 't1', 'not_needed'], ['stop']]);
});

test('API sends the UI token on rung writes', async () => {
  const src = read('js/api.js');
  const m = src.match(/async _terminalsUiWrite[\s\S]*?\n    \},\n/);
  assert.ok(m && m[0].includes("'X-SV-UI-Token': await this._getJitToken()"));
  assert.match(src, /rung\/release/);
  assert.match(src, /rung\/feedback/);
  assert.match(src, /\/api\/terminals\/rungs\/modes\/\$\{encodeURIComponent\(harness\)\}`, body/);
});

test('Turn on is disabled until shadow is complete', () => {
  const R = load();
  const base = { harness: 'claude-code', mode: 'shadow', sessions: 8, sessions_needed: 10, days: 5, days_needed: 7, unintended: 0, complete: false, early_ended: false, can_activate: false };
  const off = R.modeRowHtml(base);
  assert.match(off, /data-rung-on="claude-code" disabled/);
  assert.match(off, /8 of 10 sessions, 5 of 7 days, 0 unintended/);
  assert.match(off, /data-rung-early/);
  assert.match(off, /data-rung-shadow/);
  const on = R.modeRowHtml(Object.assign({}, base, { complete: true, can_activate: true }));
  assert.ok(!/data-rung-on="claude-code" disabled/.test(on));
});

test('early-end confirm lists what shadow would have stepped up', () => {
  const R = load();
  const t = R.wouldHaveText({ count: 2, top_reasons: [{ signal: 'drift', sessions: 2 }] });
  assert.match(t, /2 sessions/);
  assert.match(t, /drift band \(2\)/);
});

test('no em dashes or banned words in the new UI strings', () => {
  const banned = /—|\bADR\b|firewall|Mission Control|GovRun/i;
  const src = read('js/components/response-rungs.js');
  assert.ok(!banned.test(src));
  const R = load();
  const html = R.summaryHtml(R.summaryData({ word: 'step-up', rung: 3, mode: 'active', reasons: ['drift'] }), false)
    + R.modeRowHtml({ harness: 'codex', mode: 'active', sessions: 10, sessions_needed: 10, days: 7, days_needed: 7, unintended: 0, complete: true, can_activate: true })
    + R.wouldHaveText({ count: 1, top_reasons: [] });
  assert.ok(!banned.test(html));
});

test('Stop session from a rung card sends origin rung', () => {
  const api = read('js/api.js');
  assert.match(api, /terminalsStopFromRung[\s\S]*?stop\?origin=rung/);
  assert.match(read('js/pages/terminals.js'), /terminalsStopFromRung \|\| API\.terminalsStop/);
});
