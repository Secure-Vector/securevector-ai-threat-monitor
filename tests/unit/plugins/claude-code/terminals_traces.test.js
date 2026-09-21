/** Traces inside the Terminals governance drawer: attached task's trace runs,
 * filtered to its session, deep-linking into the Traces page. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

// --- vm sandbox for behavioural _refreshRail() tests --------------------

function makeEl() {
  return {
    innerHTML: '',
    textContent: '',
    hidden: false,
    dataset: {},
    classList: { add() {}, remove() {}, contains: () => false },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function loadTerminalsPage(elements, api, extra = {}) {
  const src = read('js/pages/terminals.js');
  const window = { AgentRunsPage: extra.AgentRunsPage, Sidebar: extra.Sidebar };
  const document = { getElementById: (id) => elements[id] || makeEl() };
  const sandbox = {
    window, document, API: api, URLSearchParams,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  // The page reads its pane tree from the layout model, so the sandbox needs
  // both scripts, exactly as index.html loads them.
  vm.runInNewContext(read('js/pages/terminals-layout.js'), sandbox);
  vm.runInNewContext(src, sandbox);
  return sandbox.window.TerminalsPage;
}

function traceElements() {
  return {
    'terminals-verdicts': makeEl(),
    'terminals-approvals': makeEl(),
    'terminals-traces': makeEl(),
    'terminals-attention': makeEl(),
    'terminals-governance-summary': makeEl(),
  };
}

test('terminals.js template has the traces section ids', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /id="terminals-traces"/);
  assert.match(src, /id="terminals-traces-all"/);
});

test('terminals.js filters trace runs by session_id', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /\.filter\(\s*r\s*=>\s*r\.session_id === sessionId\)/);
});

test('terminals.js deep-links trace details into the Traces page', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /AgentRunsPage\._pendingTrace/);
  assert.match(src, /Sidebar\.navigate\('agent-runs'\)/);
});

test('terminals.js keeps the attach guard after the traces fetch', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /_fetchTraceRuns\([\s\S]*?if \(this\._attached !== id\) return;/);
});

test('the trace id opens the same trace details as the Details control', () => {
  const src = read('js/pages/terminals.js');
  // Same data attribute the Details button carries, so the shared handler
  // reads the trace id off either control.
  assert.match(src, /<button type="button" class="terminals-trace-id" data-trace-id="\$\{this\._esc\(r\.trace_id\)\}" title="Open trace and nested spans">/);
  assert.match(src, /querySelectorAll\('\.terminals-trace-open, button\.terminals-trace-id'\)/);
  const css = read('css/styles.css');
  assert.match(css, /button\.terminals-trace-id\s*\{[^}]*cursor:\s*pointer/);
  assert.match(css, /button\.terminals-trace-id:hover,\s*button\.terminals-trace-id:focus-visible\s*\{[^}]*text-decoration:\s*underline/);
});

test('terminals.js caps trace rows at 6', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /slice\(0, 6\)/);
});

test('terminals.js throttles trace fetches to once per 12s per task', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /12000/);
  assert.match(src, /_tracesCache/);
});

test('styles.css gives the Terminals page a mono terminal look', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-page\s*\{[^}]*font-family:\s*var\(--font-mono\)/);
  assert.match(css, /\.terminals-trace-open\s*\{/);
  assert.match(css, /@keyframes terminals-blink/);
});

test('index.html pins the bumped cache versions', () => {
  const html = read('index.html');
  assert.match(html, /styles\.css\?v=450/);
  assert.match(html, /terminals\.js\?v=77/);
  assert.match(html, /agent-runs\.js\?v=361/);
});

test('terminals.js coerces run counters with Number() before interpolating', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /Number\(r\.spans\)\s*\|\|\s*0/);
  assert.match(src, /Number\(r\.blocked\)\s*\|\|\s*0/);
  assert.match(src, /Number\(r\.detections\)\s*\|\|\s*0/);
});

test('terminals.js clears AgentRunsPage._pendingTrace before the All traces jump', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /tracesAll\.onclick = \(e\) => \{[\s\S]*?AgentRunsPage\._pendingTrace = null;[\s\S]*?Sidebar\.navigate\('agent-runs'\);/);
});

test('terminals.js gives the trace status dot an aria-label and role=img', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /terminals-dot sv-status-\$\{risk\}" role="img" aria-label="/);
});

test('terminals.js moves the All traces link out of the Traces <h3>', () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /<h3>Traces<\/h3><a href="#" class="terminals-traces-all"/);
});

test('_refreshRail() filters trace runs to the attached session and sorts newest first', async () => {
  const elements = traceElements();
  let requestCalls = 0;
  const api = {
    terminalsVerdicts: async () => ({ items: [], session_id: 'sess-1' }),
    getJitRequests: async () => ({ items: [] }),
    request: async () => {
      requestCalls++;
      return {
        runs: [
          { trace_id: 'aaaaaaaaaaaa1111', session_id: 'sess-1', started_at: '2026-01-01T00:00:00Z', spans: 3, blocked: 0, detections: 1 },
          { trace_id: 'bbbbbbbbbbbb2222', session_id: 'sess-1', started_at: '2026-01-02T00:00:00Z', spans: 2, blocked: 1, detections: 0 },
          { trace_id: 'cccccccccccc3333', session_id: 'other-session', started_at: '2026-01-03T00:00:00Z', spans: 9, blocked: 9, detections: 9 },
        ],
      };
    },
  };
  const Page = loadTerminalsPage(elements, api);
  Page._attached = 'task-1';
  await Page._refreshRail();

  assert.strictEqual(requestCalls, 1);
  const html = elements['terminals-traces'].innerHTML;
  assert.ok(!html.includes('cccccccccccc3333'), 'a run from a different session must be excluded');
  assert.match(html, /data-trace-id="bbbbbbbbbbbb2222"/);
  assert.match(html, /data-trace-id="aaaaaaaaaaaa1111"/);
  assert.ok(html.indexOf('bbbbbbbbbbbb2222') < html.indexOf('aaaaaaaaaaaa1111'),
    'the newer run (Jan 2) must render before the older one (Jan 1)');
});

test('_refreshRail() throttles: a second call within 12s does not re-fetch traces', async () => {
  const elements = traceElements();
  let requestCalls = 0;
  const api = {
    terminalsVerdicts: async () => ({ items: [], session_id: 'sess-1' }),
    getJitRequests: async () => ({ items: [] }),
    request: async () => {
      requestCalls++;
      return { runs: [{ trace_id: 'trace-once', session_id: 'sess-1', started_at: '2026-01-01T00:00:00Z', spans: 1, blocked: 0, detections: 0 }] };
    },
  };
  const Page = loadTerminalsPage(elements, api);
  Page._attached = 'task-1';
  await Page._refreshRail();
  await Page._refreshRail();

  assert.strictEqual(requestCalls, 1, 'the throttled second call must reuse the cache, not fetch again');
  assert.match(elements['terminals-traces'].innerHTML, /data-trace-id="trace-once"/);
});

test('_refreshRail() writes nothing to the traces panel if the task is detached mid-fetch, and does not leave the cache stuck pending', async () => {
  const elements = traceElements();
  elements['terminals-traces'].innerHTML = '<span class="sentinel">unchanged</span>';
  let requestCalls = 0;
  let resolveRequest;
  const api = {
    terminalsVerdicts: async () => ({ items: [], session_id: 'sess-1' }),
    getJitRequests: async () => ({ items: [] }),
    request: () => {
      requestCalls += 1;
      return new Promise((resolve) => { resolveRequest = resolve; });
    },
  };
  const Page = loadTerminalsPage(elements, api);
  Page._attached = 'task-1';
  const pending = Page._refreshRail();

  // Let the microtask chain run up to the point where _fetchTraceRuns has
  // called API.request() and captured its resolver, then detach/re-attach
  // elsewhere while that fetch is still in flight.
  for (let i = 0; i < 20 && !resolveRequest; i++) await Promise.resolve();
  assert.ok(resolveRequest, 'the fetch must have started before we simulate the attach change');
  Page._attached = 'task-2';
  resolveRequest({ runs: [{ trace_id: 'late-run', session_id: 'sess-1', started_at: '2026-01-01T00:00:00Z' }] });
  await pending;

  assert.strictEqual(elements['terminals-traces'].innerHTML, '<span class="sentinel">unchanged</span>',
    'a stale fetch resolving after the attached task changed must not touch the DOM');
  assert.strictEqual(requestCalls, 1, 'only the original fetch should have fired so far');
  assert.ok(!(Page._tracesCache && Page._tracesCache.pending),
    'a fetch resolving after detach must not leave the cache stuck in a pending state');

  // Re-attach to the same task/session id and refresh again: since the
  // stale in-flight result was discarded rather than cached, this must
  // trigger a genuinely new fetch rather than serving (or hanging on) the
  // stuck pending entry from before.
  resolveRequest = undefined;
  Page._attached = 'task-1';
  const secondPending = Page._refreshRail();
  for (let i = 0; i < 20 && !resolveRequest; i++) await Promise.resolve();
  assert.strictEqual(requestCalls, 2, 're-attaching to the same task/session must trigger a new fetch, not reuse a stuck cache entry');
  resolveRequest({ runs: [] });
  await secondPending;
});

test('no section is opened by the markup; the state comes from what was remembered', () => {
  // The markup carries no `open` at all. _applyGovSections puts each section
  // where the person last left it, falling back to GOV_SECTION_DEFAULTS only
  // on a first run. A hardcoded `open` here would fight the remembered value
  // on every render, which is the bug both defaults were papering over.
  const src = read('js/pages/terminals.js');
  const sections = src.match(/<details class="terminals-gov-section[^>]*>/g) || [];
  assert.strictEqual(sections.length, 5, 'all five sections are still there');
  for (const tag of sections) {
    assert.ok(!/\bopen\b/.test(tag), `a section still opens from the markup: ${tag}`);
    assert.match(tag, /id="terminals-gov-[a-z]+"/, 'and each one is addressable');
  }
});

test('an approval waiting still opens its own section when Review is pressed', () => {
  // The one case that overrides the collapsed default: the task is paused and
  // the person just asked to see what is blocking it.
  const src = read('js/pages/terminals.js');
  assert.match(src, /this\._expandGovDock\(\);\s*const sec = aEl\.closest\('details'\);\s*if \(sec\) sec\.open = true;/);
});

test('each governance section collapses on its own, and rows are cards not glyph lines', () => {
  const src = read('js/pages/terminals.js');
  assert.strictEqual((src.match(/class="terminals-gov-section/g) || []).length, 5,
    'context, tool calls, traces, egress and approvals each get their own disclosure');
  const css = read('css/styles.css');
  assert.ok(!css.includes("content: '// '"),
    'the section headers must not carry a comment glyph');
  assert.ok(!css.includes("content: '# '"),
    'the drawer summary must not carry a hash glyph');
  assert.match(src, /tracesAll\.onclick = \(e\) => \{\s*e\.preventDefault\(\);/,
    'the All traces link must not toggle the section it sits in');
});
