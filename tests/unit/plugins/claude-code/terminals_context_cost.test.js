/** Governance activity: "Context & cost" and "Egress".
 *
 * Context & cost is the only governance section with an action in it, so the
 * action is the part worth pinning: Compact now is a keystroke. It travels the
 * same audited WebSocket input path the keyboard uses, which is why it cannot
 * be sent while the socket is shut and why there is no second write path to
 * the PTY for it to take. Egress answers the question the terminal cannot:
 * where the task in front of you actually reached.
 *
 * DOM stub mirrors terminals_pane.test.js / terminals_guard_banner.test.js.
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
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
    isConnected: true,
  }, extra);
}

function loadPage(elements, api = {}, extra = {}) {
  const src = read('js/pages/terminals.js');
  const window = {};
  const sandbox = Object.assign({
    window,
    document: { getElementById: (id) => elements[id] || (elements[id] = makeEl()) },
    API: api,
    URLSearchParams,
    WebSocket: { OPEN: 1, CLOSED: 3 },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console: { warn() {}, error() {} },
  }, extra);
  vm.runInNewContext(src, sandbox);
  return sandbox.window.TerminalsPage;
}

function govEls() {
  return {
    'terminals-context': makeEl(),
    'terminals-context-stage': makeEl(),
    'terminals-context-note': makeEl(),
    'terminals-compact-btn': makeEl(),
    'terminals-optimizer-btn': makeEl(),
    'terminals-egress': makeEl(),
    'terminals-egress-count': makeEl(),
    'terminals-egress-more': makeEl(),
  };
}

const TASK = { id: 't1', executor_id: 'claude-code', status: 'working', session_id: 'sess-1' };

function session(over = {}) {
  return Object.assign({
    session_id: 'sess-1',
    harness: 'claude-code',
    model: 'a-model',
    context_tokens_now: 120000,
    context_window: 200000,
    fill_pct: 60,
    compact_stage: 'heads_up',
    advisories: [],
  }, over);
}

function attach(Page, task = TASK) {
  Page._tasks = [task];
  Page._attached = task.id;
}

// ---------------------------------------------------------------- template

test('the governance drawer ships a Context & cost section first and an Egress section after Traces', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /id="terminals-gov-context"/);
  assert.match(src, /id="terminals-context-stage"/);
  assert.match(src, /id="terminals-context"/);
  assert.match(src, /id="terminals-egress-count"/);
  assert.match(src, /id="terminals-egress"/);
  // Context & cost leads because it is the section with an action in it.
  assert.ok(src.indexOf('id="terminals-gov-context"') < src.indexOf('id="terminals-verdicts-count"'),
    'Context & cost sits above Tool calls');
  assert.ok(src.indexOf('id="terminals-traces-count"') < src.indexOf('id="terminals-egress-count"')
    && src.indexOf('id="terminals-egress-count"') < src.indexOf('id="terminals-approvals-count"'),
    'Egress sits between Traces and the Approval inbox');
});

// ------------------------------------------------------------ context fill

test('the fill line and stage badge come from the live advisor', async () => {
  const els = govEls();
  const Page = loadPage(els, { getOptimizerLive: async () => ({ sessions: [session()] }) });
  attach(Page);

  await Page._renderContextCost();

  assert.match(els['terminals-context'].innerHTML, /terminals-context-bar/);
  assert.match(els['terminals-context'].innerHTML, /width:60%/);
  assert.match(els['terminals-context'].innerHTML, /60% of 200K context · 120K tokens · a-model/);
  assert.strictEqual(els['terminals-context-stage'].textContent, 'heads up');
  assert.match(els['terminals-context-stage'].className, /is-amber/);
});

test('advisories are listed, capped at four', async () => {
  const els = govEls();
  const advisories = [
    { type: 'tool_result_carry', tool: 'Read', tokens: 40000 },
    { type: 'duplicate_calls', tool: 'Grep', count: 5 },
    { type: 'failure_loop', streak: 4 },
    { type: 'long_session' },
    { type: 'resend_growth', from_tokens: 10000, to_tokens: 90000 },
  ];
  const Page = loadPage(els, { getOptimizerLive: async () => ({ sessions: [session({ advisories })] }) });
  attach(Page);

  await Page._renderContextCost();

  const html = els['terminals-context'].innerHTML;
  assert.match(html, /terminals-context-advice/);
  assert.strictEqual((html.match(/<li>/g) || []).length, 4, 'at most four advisories are shown');
  assert.match(html, /Grep call ran 5 times in a row/);
});

test('an attached task with no session id says so instead of showing a gauge', async () => {
  const els = govEls();
  let called = false;
  const Page = loadPage(els, { getOptimizerLive: async () => { called = true; return { sessions: [session()] }; } });
  attach(Page, Object.assign({}, TASK, { session_id: null }));

  await Page._renderContextCost();

  assert.match(els['terminals-context'].innerHTML,
    /No context data yet\. The Guard reports context use once the harness starts working\./);
  assert.ok(!/terminals-compact-btn/.test(els['terminals-context'].innerHTML),
    'there is no action to offer without a session');
  assert.strictEqual(els['terminals-context-stage'].textContent, '');
  assert.ok(called, 'the advisor is still consulted; the task simply is not in it yet');
});

test('with nothing attached the section is empty and the badge is cleared', async () => {
  const els = govEls();
  const Page = loadPage(els, { getOptimizerLive: async () => ({ sessions: [session()] }) });
  Page._tasks = [];
  Page._attached = null;

  await Page._renderContextCost();

  assert.match(els['terminals-context'].innerHTML, /No task attached\./);
  assert.strictEqual(els['terminals-context-stage'].textContent, '');
});

test('the stage badge and the bar share a colour, and only above the quiet stage', async () => {
  for (const [stage, text, cls] of [
    ['quiet', '', ''],
    ['heads_up', 'heads up', 'is-amber'],
    ['act_now', 'compact soon', 'is-amber'],
    ['last_call', 'compact now', 'is-red'],
  ]) {
    const els = govEls();
    const Page = loadPage(els, {
      getOptimizerLive: async () => ({ sessions: [session({ compact_stage: stage, fill_pct: 92 })] }),
    });
    attach(Page);
    await Page._renderContextCost();
    assert.strictEqual(els['terminals-context-stage'].textContent, text, `badge text for ${stage}`);
    if (cls) {
      assert.match(els['terminals-context-stage'].className, new RegExp(cls), `badge colour for ${stage}`);
      assert.match(els['terminals-context'].innerHTML, new RegExp(`<i class="${cls}"`), `bar colour for ${stage}`);
    } else {
      assert.match(els['terminals-context'].innerHTML, /<i class="" /, 'a quiet session keeps the neutral bar');
    }
  }
});

// -------------------------------------------------------------- compact now

test('Compact now types /compact through the audited WebSocket input path', async () => {
  const els = govEls();
  const sent = [];
  const Page = loadPage(els, { getOptimizerLive: async () => ({ sessions: [session()] }) });
  attach(Page);
  Page._ws = { readyState: 1, send: (f) => sent.push(f) };

  await Page._renderContextCost();
  assert.match(els['terminals-context'].innerHTML, /id="terminals-compact-btn"/);
  Page._sendCompact();

  assert.strictEqual(sent.length, 1, 'exactly one frame, and it is an input frame');
  const frame = JSON.parse(sent[0]);
  assert.strictEqual(frame.t, 'input');
  assert.strictEqual(frame.data, Buffer.from('/compact\r', 'binary').toString('base64'));
  assert.strictEqual(els['terminals-context-note'].textContent,
    'Sent /compact to the terminal. The audit trail records it as a typed line.');
  assert.strictEqual(els['terminals-compact-btn'].disabled, true, 'the button holds for a moment after sending');
});

test('nothing is written to the PTY while the socket is shut', async () => {
  const els = govEls();
  const sent = [];
  const Page = loadPage(els, { getOptimizerLive: async () => ({ sessions: [session()] }) });
  attach(Page);
  Page._ws = { readyState: 3, send: (f) => sent.push(f) };

  await Page._renderContextCost();
  Page._sendCompact();

  assert.deepStrictEqual(sent, []);
  assert.strictEqual(els['terminals-context-note'].textContent, 'Attach the task first.');
});

test('the terminal has exactly one way to write to the PTY', () => {
  const src = read('js/pages/terminals.js');
  const sends = src.match(/\.send\(JSON\.stringify\(\{ t: 'input'/g) || [];
  assert.strictEqual(sends.length, 2,
    'the keyboard and Compact now, and nothing else, may send an input frame');
});

test('Copilot CLI gets a note instead of a button it cannot honour', async () => {
  const els = govEls();
  const Page = loadPage(els, { getOptimizerLive: async () => ({ sessions: [session({ harness: 'copilot-cli' })] }) });
  attach(Page, Object.assign({}, TASK, { executor_id: 'copilot-cli' }));

  await Page._renderContextCost();

  const html = els['terminals-context'].innerHTML;
  assert.ok(!/id="terminals-compact-btn"/.test(html), 'no Compact now button for this harness');
  assert.match(html, /Compact from inside the Copilot CLI session; SecureVector cannot send it for this harness\./);
  assert.match(html, /id="terminals-optimizer-btn"/, 'the Cost Optimizer link stays');
});

test('Open Cost Optimizer navigates to the Cost & Tokens page', () => {
  const src = read('js/pages/terminals.js');
  const fn = src.slice(src.indexOf('async _renderContextCost()'), src.indexOf('_sendCompact()'));
  assert.match(fn, /Sidebar\.navigate\('costs'\)/);
});

// ------------------------------------------------------------------ egress

test('egress rows render per host with call, write, and blocked counts', async () => {
  const els = govEls();
  const Page = loadPage(els, {
    getEgressSessionDestinations: async () => ({
      destinations: [
        { host: 'bad.example.com', calls: 2, blocked: 2, writes: 0 },
        { host: 'api.example.com', calls: 5, blocked: 0, writes: 1 },
      ],
    }),
  });
  attach(Page);

  await Page._renderEgress();

  const html = els['terminals-egress'].innerHTML;
  assert.match(html, /sv-status-red[\s\S]*?bad\.example\.com/, 'a blocked host gets the red dot');
  assert.match(html, /sv-status-green[\s\S]*?api\.example\.com/, 'an allowed host gets the green dot');
  assert.match(html, /2 calls · 2 blocked/);
  assert.match(html, /5 calls · 1 write/);
  assert.strictEqual(els['terminals-egress-count'].textContent, '2', 'the badge counts distinct hosts');
  assert.match(els['terminals-egress-count'].className, /is-warn/, 'a blocked host warns on the badge');
});

test('with nothing blocked the egress badge stays neutral', async () => {
  const els = govEls();
  const Page = loadPage(els, {
    getEgressSessionDestinations: async () => ({
      destinations: [{ host: 'api.example.com', calls: 1, blocked: 0, writes: 0 }],
    }),
  });
  attach(Page);

  await Page._renderEgress();

  assert.strictEqual(els['terminals-egress-count'].textContent, '1');
  assert.ok(!/is-warn/.test(els['terminals-egress-count'].className));
  assert.match(els['terminals-egress'].innerHTML, /1 call</, 'one call is not "1 calls"');
});

test('past twelve hosts the rest are behind a link to the Egress page', async () => {
  const els = govEls();
  const rows = Array.from({ length: 15 }, (_, i) => ({
    host: `h${i}.example.com`, calls: 1, blocked: 0, writes: 0,
  }));
  const Page = loadPage(els, { getEgressSessionDestinations: async () => ({ destinations: rows }) });
  attach(Page);

  await Page._renderEgress();

  const html = els['terminals-egress'].innerHTML;
  assert.strictEqual((html.match(/terminals-egress-row/g) || []).length, 12);
  assert.match(html, /terminals-egress-more[^>]*>\+3 more</);
  const src = read('js/pages/terminals.js');
  const fn = src.slice(src.indexOf('async _renderEgress()'));
  assert.match(fn, /Sidebar\.navigate\('egress'\)/);
});

test('egress states: no task, no session, and no rows each say so', async () => {
  const els = govEls();
  const Page = loadPage(els, { getEgressSessionDestinations: async () => ({ destinations: [] }) });

  Page._tasks = [];
  Page._attached = null;
  await Page._renderEgress();
  assert.match(els['terminals-egress'].innerHTML, /No task attached\./);

  attach(Page, Object.assign({}, TASK, { session_id: null }));
  await Page._renderEgress();
  assert.match(els['terminals-egress'].innerHTML, /No egress recorded yet\./);

  attach(Page);
  await Page._renderEgress();
  assert.match(els['terminals-egress'].innerHTML, /No egress recorded yet\./);
  assert.strictEqual(els['terminals-egress-count'].textContent, '');
});

test('the host is escaped, never interpolated raw', () => {
  const src = read('js/pages/terminals.js');
  const tail = src.slice(src.indexOf('async _renderEgress()'));
  const rowTpl = tail.slice(tail.indexOf('el.innerHTML = shown.map'), tail.indexOf('}).join(\'\')'));
  assert.match(rowTpl, /this\._esc\(r\.host\)/);
  assert.ok(!/\$\{r\.host\}/.test(rowTpl), 'no unescaped host reaches innerHTML');
  assert.ok(!/\$\{meta\}/.test(rowTpl), 'the meta line is escaped too');
});

test('api.js reaches the per-session destinations route with an encoded id', () => {
  const api = read('js/api.js');
  assert.match(api, /getEgressSessionDestinations\(sessionId\)/);
  assert.match(api, /\/api\/egress\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/destinations/);
});

// --------------------------------------------------------------------- css

test('the sections carry their styles, and colour only says state', () => {
  const css = read('css/styles.css');
  for (const rule of [
    '.terminals-gov-stage.is-amber',
    '.terminals-gov-stage.is-red',
    '.terminals-context-bar i.is-amber',
    '.terminals-context-bar i.is-red',
    '.terminals-context-advice',
    '.terminals-context-actions',
    '.terminals-context-note',
    '.terminals-egress-row',
    '.terminals-egress-host',
    '.terminals-egress-meta',
    '.terminals-egress-more',
  ]) {
    assert.ok(css.includes(rule), `${rule} must be defined`);
  }
  assert.match(css, /\[data-theme="light"\] \.terminals-gov-stage\.is-amber/);
  assert.match(css, /\[data-theme="light"\] \.terminals-gov-stage\.is-red/);
  const bar = css.slice(css.indexOf('.terminals-context-bar {'), css.indexOf('.terminals-context-advice'));
  assert.ok(!/2dd4bf|var\(--accent-primary/.test(bar),
    'the fill bar never borrows the teal accent; teal is reserved');
});

// -------------------------------------------------------- governance hero

function heroEls() {
  const bodyClasses = new Set();
  return {
    'terminals-gov-hero': makeEl({ hidden: true }),
    'terminals-governance-body': makeEl({
      classList: {
        add: (c) => bodyClasses.add(c),
        remove: (c) => bodyClasses.delete(c),
        contains: (c) => bodyClasses.has(c),
      },
    }),
    'terminals-gov-hero-bot': makeEl(),
    'terminals-gov-hero-title': makeEl(),
    'terminals-gov-hero-text': makeEl(),
    'terminals-governance-summary': makeEl(),
  };
}

test('the drawer ships one hero empty state, hidden, ahead of the sections', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /id="terminals-gov-hero" hidden/);
  assert.match(src, /id="terminals-governance-body"/);
  assert.ok(src.indexOf('id="terminals-gov-hero"') < src.indexOf('id="terminals-gov-context"'),
    'the hero sits above the sections it replaces');
  for (const k of ['Tool calls', 'Traces', 'Egress', 'Context &amp; cost']) {
    assert.ok(src.includes(`terminals-gov-hero-k">${k}</span>`), `${k} is named in the hero list`);
  }
});

test('an attached session with nothing yet shows the hero and hides every section', () => {
  const els = heroEls();
  const Page = loadPage(els);
  attach(Page);
  Page._executors = [{ id: 'claude-code', label: 'Claude Code', governed: true }];
  Page._govHas = {};

  Page._renderGovHero();

  assert.strictEqual(els['terminals-gov-hero'].hidden, false);
  assert.ok(els['terminals-governance-body'].classList.contains('is-empty'),
    'the body carries the class the CSS hides the sections with');
  assert.strictEqual(els['terminals-gov-hero-title'].textContent, 'Governed session, listening');
  assert.strictEqual(els['terminals-gov-hero-text'].textContent,
    'The first tool call lands here with its verdict. Traces, egress, and context follow.');
  assert.strictEqual(els['terminals-governance-summary'].textContent, 'listening');
});

test('the first tool call puts the sections back', () => {
  const els = heroEls();
  const Page = loadPage(els);
  attach(Page);
  Page._govHas = { verdicts: true };

  Page._renderGovHero();

  assert.strictEqual(els['terminals-gov-hero'].hidden, true);
  assert.ok(!els['terminals-governance-body'].classList.contains('is-empty'));
});

test('any one of the five signals is enough to show the sections', () => {
  for (const key of ['verdicts', 'traces', 'egress', 'context', 'approvals']) {
    const els = heroEls();
    const Page = loadPage(els);
    attach(Page);
    Page._govHas = { [key]: true };
    Page._renderGovHero();
    assert.strictEqual(els['terminals-gov-hero'].hidden, true, `${key} alone must reveal the sections`);
  }
});

test('an ungoverned session is a different empty, and does not claim to be listening', () => {
  const els = heroEls();
  const Page = loadPage(els);
  attach(Page, Object.assign({}, TASK, { session_id: null }));
  Page._executors = [{ id: 'claude-code', label: 'Claude Code', governed: false }];
  Page._govHas = {};

  Page._renderGovHero();

  assert.strictEqual(els['terminals-gov-hero-title'].textContent, 'Running without SecureVector Guard');
  assert.strictEqual(els['terminals-gov-hero-text'].textContent,
    'Install it from the banner above; governance starts the moment the Guard reports in.');
});

test('with no task attached the hero asks for one and shows no bot', () => {
  const els = heroEls();
  const Page = loadPage(els);
  Page._tasks = [];
  Page._attached = null;
  Page._govHas = {};

  Page._renderGovHero();

  assert.strictEqual(els['terminals-gov-hero'].hidden, false);
  assert.strictEqual(els['terminals-gov-hero-title'].textContent, 'Pick a task');
  assert.strictEqual(els['terminals-gov-hero-text'].textContent,
    'Its verdicts, traces, egress, and context show here.');
  assert.strictEqual(els['terminals-gov-hero-bot'].innerHTML, '');
});

test('the hero carries its styles, with the teal ring as the only accent', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-governance-body\.is-empty \.terminals-gov-section \{ display: none; \}/);
  assert.match(css, /@keyframes sv-gov-listen/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.terminals-gov-hero-bot::before/);
  const hero = css.slice(css.indexOf('.terminals-gov-hero {'), css.indexOf('.terminals-gov-hero-k'));
  assert.strictEqual((hero.match(/--accent-primary/g) || []).length, 1,
    'the listening ring is the single accent in the hero');
});

// ------------------------------------------------- review fixes: freshness

test('a failed egress fetch keeps the last good rows and says the reading is stale', async () => {
  const els = govEls();
  let fail = false;
  const Page = loadPage(els, {
    getEgressSessionDestinations: async () => {
      if (fail) throw new Error('offline');
      return { destinations: [{ host: 'api.example.com', calls: 3, blocked: 0, writes: 0 }] };
    },
  });
  attach(Page);

  await Page._renderEgress();
  assert.match(els['terminals-egress'].innerHTML, /api\.example\.com/);
  const goodAt = Page._egressAt;

  fail = true;
  Page._egressAt = 0; // force the next poll past the 10 s throttle
  await Page._renderEgress();

  const html = els['terminals-egress'].innerHTML;
  assert.match(html, /api\.example\.com/, 'the last good rows stay on screen');
  assert.match(html, /Egress unavailable right now\./);
  assert.ok(!/No egress recorded yet\./.test(html),
    'a failed fetch must never be reported as "this task reached nothing"');
  assert.strictEqual(Page._egressAt, 0,
    'a failure is not stamped into the cache, so the next poll retries');
  assert.ok(goodAt > 0, 'a successful fetch is stamped');
});

test('a failed egress fetch with nothing cached says unavailable, not empty', async () => {
  const els = govEls();
  const Page = loadPage(els, {
    getEgressSessionDestinations: async () => { throw new Error('offline'); },
  });
  attach(Page);

  await Page._renderEgress();

  assert.match(els['terminals-egress'].innerHTML, /Egress unavailable right now\./);
  assert.ok(!/No egress recorded yet\./.test(els['terminals-egress'].innerHTML));
});

test('the compact cooldown is a deadline on the page, so a re-render cannot re-enable the button', async () => {
  const els = govEls();
  const sent = [];
  const Page = loadPage(els, { getOptimizerLive: async () => ({ sessions: [session()] }) });
  attach(Page);
  Page._ws = { readyState: 1, send: (f) => sent.push(f) };

  await Page._renderContextCost();
  Page._sendCompact();
  assert.strictEqual(sent.length, 1);
  assert.ok(Page._compactUntil > Date.now(), 'the cooldown deadline is recorded on the page');

  // The 4 s poll re-renders the section while the cooldown is still running.
  Page._contextSig = null;
  await Page._renderContextCost();
  assert.match(els['terminals-context'].innerHTML, /id="terminals-compact-btn" disabled/,
    're-rendering inside the cooldown must repaint a disabled button');

  Page._sendCompact();
  assert.strictEqual(sent.length, 1, 'a second send inside the cooldown is refused');

  Page._compactUntil = 0;
  Page._contextSig = null;
  await Page._renderContextCost();
  assert.ok(!/id="terminals-compact-btn" disabled/.test(els['terminals-context'].innerHTML),
    'the button comes back once the cooldown has passed');
});

test('attaching a task clears the previous task context gauge and hosts', async () => {
  const els = govEls();
  const Page = loadPage(els, { getOptimizerLive: async () => ({ sessions: [session()] }) });
  attach(Page);
  await Page._renderContextCost();
  assert.match(els['terminals-context'].innerHTML, /60% of 200K context/);
  Page._egress = { destinations: [{ host: 'old.example.com', calls: 1, blocked: 0, writes: 0 }] };
  Page._egressSid = 'sess-1';
  Page._egressAt = Date.now();
  els['terminals-egress'].innerHTML = 'old.example.com';
  els['terminals-egress-count'].textContent = '1';
  Page._compactUntil = Date.now() + 15000;

  Page._resetSessionPanels();

  assert.strictEqual(Page._optLive, null);
  assert.strictEqual(Page._optLiveAt, 0);
  assert.strictEqual(Page._egress, null);
  assert.strictEqual(Page._egressAt, 0);
  assert.strictEqual(Page._egressSid, null);
  assert.strictEqual(Page._compactUntil, 0, 'a cooldown belongs to the session that started it');
  assert.ok(!/60% of 200K context/.test(els['terminals-context'].innerHTML),
    'the previous gauge must not sit under the new task name');
  assert.ok(!/old\.example\.com/.test(els['terminals-egress'].innerHTML));
  assert.strictEqual(els['terminals-egress-count'].textContent, '');
  assert.strictEqual(els['terminals-context-stage'].textContent, '');
});

test('_attach and _detach both clear the per-session panels', () => {
  const src = read('js/pages/terminals.js');
  const attachFn = src.slice(src.indexOf('_attach(id) {'), src.indexOf('_resetSessionPanels() {'));
  assert.match(attachFn, /this\._resetSessionPanels\(\);/);
  const detachFn = src.slice(src.indexOf('_detach() {'), src.indexOf('_banner(text) {'));
  assert.match(detachFn, /this\._resetSessionPanels\(\);/);
});

test('a transient traces failure keeps the hero away from live sections', async () => {
  const els = Object.assign(govEls(), heroEls(), {
    'terminals-verdicts': makeEl(),
    'terminals-traces': makeEl(),
    'terminals-approvals': makeEl(),
    'terminals-attention': makeEl(),
    'terminals-verdicts-count': makeEl(),
    'terminals-traces-count': makeEl(),
    'terminals-approvals-count': makeEl(),
  });
  const Page = loadPage(els, {
    terminalsVerdicts: async () => ({ items: [], session_id: 'sess-1' }),
    getJitRequests: async () => ({ items: [] }),
    getOptimizerLive: async () => ({ sessions: [] }),
    getEgressSessionDestinations: async () => ({ destinations: [] }),
  });
  attach(Page);
  Page._renderPaneFoot = () => {};
  Page._fetchTraceRuns = async () => ({ runs: [{ trace_id: 'tr1', session_id: 'sess-1', spans: 2 }] });

  await Page._refreshRail();
  assert.strictEqual(Page._govHas.traces, true);
  assert.strictEqual(els['terminals-gov-hero'].hidden, true);

  // Next poll: the traces endpoint is briefly unreachable.
  Page._tracesCache = null;
  Page._fetchTraceRuns = async () => { throw new Error('offline'); };
  await Page._refreshRail();

  assert.strictEqual(Page._govHas.traces, true,
    'a failed fetch must not be recorded as "no traces"');
  assert.strictEqual(els['terminals-gov-hero'].hidden, true,
    'the hero must not pop over live sections mid-poll');
});
