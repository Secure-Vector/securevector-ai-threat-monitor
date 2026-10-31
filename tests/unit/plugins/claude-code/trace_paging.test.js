/** Paged run traces: the tree view client (js/api.js getTraceTree,
 *  getTraceSpan, shared in-flight fetches) and RunTrace's page merge,
 *  totals, turn numbers, span hydration and the "Show 200 more" row. Also
 *  the Claude Code statusline's shared stats cache. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const WEB = path.join(ROOT, 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');
const plain = (x) => JSON.parse(JSON.stringify(x));

function loadApi(fetchImpl) {
  const src = read('js/api.js');
  const end = src.indexOf('window.API = API;') + 'window.API = API;'.length;
  const window = {};
  const sandbox = { window, console: { error() {} }, fetch: fetchImpl, URLSearchParams, Map, Promise, Date };
  vm.runInNewContext(src.slice(0, end), sandbox);
  return window.API;
}

function loadRunTrace(api) {
  const window = { API: api };
  const sandbox = { window, console };
  vm.runInNewContext(read('js/components/trace-steps.js'), sandbox);
  vm.runInNewContext(read('js/components/run-trace.js'), sandbox);
  window.RunTrace._state = {};
  return window.RunTrace;
}

const okJson = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

test('getTraceTree asks for the tree view with its cursor, and shares one fetch in flight', async () => {
  const urls = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const API = loadApi((url) => { urls.push(url); return gate.then(() => okJson({ spans: [], page: {} })); });
  const a = API.getTraceTree('t 1', { before: '2026|t:5' });
  const b = API.getTraceTree('t 1', { before: '2026|t:5' });
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(urls.length, 1);
  assert.equal(ra, rb);
  const u = new URL(urls[0], 'http://x');
  assert.equal(u.pathname, '/api/traces/t%201');
  assert.equal(u.searchParams.get('view'), 'tree');
  assert.equal(u.searchParams.get('limit'), '200');
  assert.equal(u.searchParams.get('before'), '2026|t:5');
  await API.getTraceTree('t 1', { before: '2026|t:5' });
  assert.equal(urls.length, 2, 'a finished fetch is not reused');
  await API.getTraceFull('t 1');
  assert.match(urls[2], /\?view=full$/);
});

test('getTraceSpan caches one span briefly and keeps failures out of the cache', async () => {
  const urls = [];
  let fail = true;
  const API = loadApi((url) => {
    urls.push(url);
    if (fail) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ detail: 'span not found' }) });
    return okJson({ sk: 't:3', span: { args_preview: 'full' } });
  });
  assert.equal(await API.getTraceSpan('tr', 't:3'), null);
  fail = false;
  const one = await API.getTraceSpan('tr', 't:3');
  const two = await API.getTraceSpan('tr', 't:3');
  assert.equal(one.span.args_preview, 'full');
  assert.equal(one, two);
  assert.equal(urls.length, 2);
  assert.equal(urls[1], '/api/traces/tr/spans/t%3A3');
});

const T0 = Date.parse('2026-10-23T14:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const g = (n, s) => ({ span_kind: 'generation', sk: `g:${n}`, span_id: `g${n}`, called_at: at(s), model: 'm', gen_no: n });
const c = (n, s, extra = {}) => Object.assign({ span_kind: 'tool_call', sk: `t:${n}`, span_id: `c${n}`, tool_id: 'Bash', action: 'allow', called_at: at(s) }, extra);
const page = (spans, p, extra = {}) => Object.assign({ trace_id: 'tr', span_count: 50, tool_call_count: 40, spans, page: p }, extra);

test('mergePage folds older and newer pages, once per span, with the newest totals', () => {
  const RT = loadRunTrace({});
  const first = page([g(5, 50), c(41, 51), c(42, 52)], { has_more: true, next_before: 'x|g:5', newest: 'y|t:42' });
  const older = page([g(4, 40), c(40, 41)], { has_more: false, next_before: null }, { span_count: 99 });
  const m1 = RT.mergePage(first, older, 'older');
  assert.deepEqual(m1.spans.map(s => s.sk), ['g:4', 't:40', 'g:5', 't:41', 't:42']);
  assert.equal(m1.page.has_more, false);
  assert.equal(m1.page.newest, 'y|t:42');
  assert.equal(m1.span_count, 50, 'an older page does not move the run totals');
  const newer = page([c(42, 52, { duration_ms: 9 }), c(43, 53)], { newest: 'z|t:43' }, { span_count: 52, blocked: 1 });
  const m2 = RT.mergePage(m1, newer, 'newer');
  assert.deepEqual(m2.spans.map(s => s.sk), ['g:4', 't:40', 'g:5', 't:41', 't:42', 't:43']);
  assert.equal(m2.spans[4].duration_ms, 9, 'the re-sent newest span replaces the old copy');
  assert.equal(m2.page.newest, 'z|t:43');
  assert.equal(m2.span_count, 52);
  assert.equal(m2.blocked, 1);
  assert.equal(RT.mergePage(m2, first, 'first'), first, 'anything else replaces');
});

test('a paged trace counts the run, numbers turns from the run, and offers the older page', () => {
  const RT = loadRunTrace({ TRACE_PAGE: 200 });
  const tr = page([g(7, 50), c(41, 51), g(8, 60), c(42, 61)], { has_more: true, next_before: 'x|g:7' }, { span_count: 450 });
  assert.equal(RT.spanTotal(tr), 450);
  assert.equal(RT.spanTotal({ spans: [1, 2] }), 2, 'a full trace counts its spans');
  assert.equal(RT.olderLeft(tr), 446);
  const tree = RT.buildTree(tr, {});
  assert.deepEqual(plain(tree.children.map(n => n.turn)), [7, 8]);
  assert.match(RT.olderHtml(tr), /data-act="older">Show 200 more<\/button>/);
  assert.match(RT.olderHtml(tr), /446 older/);
  assert.equal(RT.olderHtml(Object.assign({}, tr, { page: { has_more: false } })), '');
});

test('hydrate loads a slim span in place once; a full span is left alone', async () => {
  let calls = 0;
  const RT = loadRunTrace({
    getTraceSpan: (tid, key) => { calls++; return Promise.resolve({ sk: key, span: { args_preview: 'x'.repeat(5000), sk: key } }); },
  });
  const s = c(1, 1, { args_preview: 'x'.repeat(300), _cut: true, _slim: true });
  assert.match(RT.hydratingHtml(s), /Loading full detail/);
  const [a, b] = await Promise.all([RT.hydrate('tr', s), RT.hydrate('tr', s)]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(calls, 1);
  assert.equal(s.args_preview.length, 5000);
  assert.equal(s._cut, false);
  assert.equal(RT.hydratingHtml(s), '');
  assert.equal(await RT.hydrate('tr', s), false);
  assert.equal(calls, 1);
});

test('fullCtx fetches the run in full for export and copy; a full trace is used as is', async () => {
  let asked = 0;
  const full = { trace_id: 'tr', spans: [g(1, 1), c(1, 2, { args_preview: 'long' })] };
  const RT = loadRunTrace({ getTraceFull: () => { asked++; return Promise.resolve(full); } });
  const ctx = { trace: page([c(1, 2)], { has_more: false }) };
  const fc = await RT.fullCtx(ctx);
  assert.equal(asked, 1);
  assert.equal(fc.trace, full);
  assert.equal(fc.tree.children.length, 1);
  const plainCtx = { trace: full };
  assert.equal(await RT.fullCtx(plainCtx), plainCtx);
  assert.equal(asked, 1);
});

test('statusline serves stats from the shared cache without asking the app', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-statusline-'));
  try {
    const dir = path.join(home, '.securevector');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'statusline-live.json'), JSON.stringify({
      ts: Date.now(), stats: { total: 5, allowed: 3, blocked: 2 }, timeline: { items: [{ kind: 'scan' }] },
    }));
    // A fresh token cache too, so no background refresh is spawned.
    fs.writeFileSync(path.join(dir, 'statusline-tokens.json'), JSON.stringify({ ts: Date.now(), value: { daily: [] } }));
    const script = path.join(ROOT, 'src', 'securevector', 'plugins', 'claude-code', 'hooks', 'statusline.js');
    // Port 9 (discard) on loopback: any request would fail; the line must
    // still print, from the cache.
    const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, SECUREVECTOR_URL: 'http://127.0.0.1:9' });
    delete env.SECUREVECTOR_ENGINE_ENDPOINT; delete env.SV_BASE_URL;
    const r = spawnSync(process.execPath, [script], { input: '{}', env, encoding: 'utf8', timeout: 10000 });
    assert.match(r.stdout, /5 tool calls/);
    assert.match(r.stdout, /1 threats detected/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('sidebar status pollers: 30 s when idle, paused when hidden, one request per URL in flight', async () => {
  const src = read('js/components/sidebar.js');
  assert.match(src, /STATUS_IDLE_MS: 30000/);
  assert.doesNotMatch(src, /visible \? 10000 : 2000/);
  assert.equal((src.match(/visible \? 10000 : this\.STATUS_IDLE_MS/g) || []).length, 5);
  for (const ep of ['proxy/status', 'siem-forwarders/global-settings', 'siem-forwarders', 'hooks/claude-code/status',
    'hooks/copilot-cli/status', 'hooks/opencode/status', 'hooks/antigravity/status', 'hooks/codex/status']) {
    assert.ok(src.includes(`this._sharedFetch('/api/${ep}')`), ep);
    assert.ok(!src.includes(`fetch('/api/${ep}')`.replace(/^/, ' ')), `${ep} has no raw fetch left`);
  }
  for (const [timer, fn] of [['_proxyStatusTimer', 'checkProxyStatus'], ['_siemStatusTimer', 'checkSiemStatus']]) {
    const m = src.slice(src.indexOf(`    async ${fn}() {`));
    assert.match(m.slice(0, 400), /if \(document\.visibilityState === 'hidden'\) return;/, fn);
    assert.match(src, new RegExp(`this\\.${timer} = setTimeout\\(\\(\\) => this\\.${fn}\\(\\), this\\.STATUS_IDLE_MS\\);`), fn);
  }
  // _sharedFetch itself: two callers, one fetch, both read the body.
  const body = src.slice(src.indexOf('    _sharedFetch(url) {'), src.indexOf('    async checkProxyStatus() {'));
  let calls = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  const sandbox = { fetch: () => { calls++; return gate.then(() => ({ ok: true, status: 200, json: () => Promise.resolve({ running: true }) })); }, Map };
  const obj = vm.runInNewContext(`({ _statusInflight: null, ${body} })`, sandbox);
  const a = obj._sharedFetch('/api/proxy/status');
  const b = obj._sharedFetch('/api/proxy/status');
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.deepEqual(plain(await ra.json()), { running: true });
  assert.deepEqual(plain(await rb.json()), { running: true });
  await obj._sharedFetch('/api/proxy/status');
  assert.equal(calls, 2);
});

test('badge filters ask the server for the whole run; hash search is one lookup', async () => {
  const urls = [];
  const API = loadApi((url) => { urls.push(url); return okJson({ trace_id: 'tr', sk: 't:3' }); });
  await API.getTraceTree('tr', { decision: 'block' });
  assert.equal(new URL(urls[0], 'http://x').searchParams.get('decision'), 'block');
  await API.lookupSpanHash('abcdef12');
  assert.equal(urls[1], '/api/trace-spans/lookup?hash=abcdef12');
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /SPAN_FILTER_DECISION: \{ blocked: 'block', error: 'error', waiting: 'waiting', recorded: 'log_only' \}/);
  const find = src.slice(src.indexOf('    async _findSpanHash(hash) {'), src.indexOf('    async selectRun(traceId, opts) {'));
  assert.match(find, /API\.lookupSpanHash\(q\)/);
  assert.doesNotMatch(find, /API\.getTrace\(/);
  const RT = loadRunTrace({});
  assert.equal(RT.olderLeft({ spans: [1], page: { has_more: true, older: 7 } }), 7);
});

test('a paged run row and header count the whole run, not the page', () => {
  const RT = loadRunTrace({});
  const tr = page([g(7, 50), c(41, 51, { action: 'block' })], { has_more: true }, { span_count: 450,
    totals: { tokens: 2300000, cost: 10.5, block: 83 } });
  const tree = RT.buildTree(tr, {});
  assert.equal(RT.nodeTokens(tree), 2300000);
  assert.equal(RT.nodeCost(tree), 10.5);
  const html = RT.headerHtml({ trace: tr, tree });
  assert.match(html, /83 blocked/);
  assert.match(html, /450 spans/);
});

test('the Live grid reads runs a page at a time and never fetches the full run', async () => {
  const calls = [];
  const stub = {
    getSessionGovernance: () => Promise.resolve({ runs: { trace_ids: ['tr'] } }),
    getTrace: () => { calls.push('full'); throw new Error('full run fetched'); },
    getTraceFull: () => { calls.push('full'); throw new Error('full run fetched'); },
    getTraceTree: (tid, opts = {}) => {
      calls.push(opts.after ? 'after' : 'first');
      if (opts.after) return Promise.resolve(page([c(2, 2), c(3, 3)], { newest: 'z|t:3' }, { span_count: 3 }));
      return Promise.resolve(page([g(1, 0), c(2, 2)], { has_more: false, newest: 'y|t:2' }, { span_count: 2 }));
    },
    getTraceSpan: (tid, key) => { calls.push('span:' + key); return Promise.resolve({ sk: key, span: { args_preview: 'full args' } }); },
  };
  const window = { API: stub };
  const sandbox = { window, API: stub, console, document: { getElementById: () => null } };
  vm.runInNewContext(read('js/components/trace-steps.js'), sandbox);
  vm.runInNewContext(read('js/components/run-trace.js'), sandbox);
  vm.runInNewContext(read('js/pages/live-grid.js'), sandbox);
  sandbox.RunTrace = window.RunTrace;
  const LG = window.LiveGridPage;
  const [, d1] = await LG._detailOf('s1');
  const [, d2] = await LG._detailOf('s1');
  assert.deepEqual(calls, ['first', 'after']);
  assert.deepEqual(d2.spans.map(s => s.sk), ['g:1', 't:2', 't:3']);
  assert.equal(d1.traceId, 'tr');
  // An opened slim call loads only itself.
  const span = d2.spans[2];
  span._cut = true;
  LG.details = { s1: d2 };
  LG._mounted = () => false;
  LG._hydrateOpen('s1', { resolved: { found: { node: { span } } } });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(span.args_preview, 'full args');
  assert.ok(!calls.includes('full'));
  assert.ok(!read('js/pages/live-grid.js').includes('API.getTrace('), 'no full-run fetch left in the grid');
});
