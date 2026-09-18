/** Observed web egress in the Terminals Egress section.
 *
 * Codex's built-in web tool fires no hook, so nothing governs it and the rows
 * for it arrive from the local transcript after the fact. The panel has to say
 * so: no status colour on a row no policy decided, the word "observed" in the
 * meta, and, when transcript reading is off, a line saying the list is empty
 * because nothing was read rather than because nothing happened.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

function makeEl() {
  return {
    innerHTML: '',
    textContent: '',
    hidden: false,
    dataset: {},
    className: '',
    classList: { add() {}, remove() {}, contains: () => false },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function loadTerminalsPage(elements, api) {
  const src = read('js/pages/terminals.js');
  const window = {};
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

function pageWith(payload, task) {
  const elements = { 'terminals-egress': makeEl(), 'terminals-egress-count': makeEl() };
  const Page = loadTerminalsPage(elements, {
    getEgressSessionDestinations: async () => payload,
  });
  Page._tasks = [Object.assign(
    { id: 'task-1', session_id: 'sess-1', executor_id: 'codex' }, task || {})];
  Page._attached = 'task-1';
  return { Page, el: elements['terminals-egress'], badge: elements['terminals-egress-count'] };
}

test('an observed-only row carries no status colour and says it is not governed', async () => {
  const { Page, el } = pageWith({
    transcript_consent: true,
    observed_calls: 2,
    destinations: [{ host: 'docs.example.com', calls: 2, blocked: 0, observed: 2, writes: 0 }],
  });
  await Page._renderEgress();
  assert.match(el.innerHTML, /terminals-egress-observed/);
  assert.match(el.innerHTML, /observed, not governed/);
  assert.ok(!el.innerHTML.includes('sv-status-green'),
    'an observed row must not be coloured as if a policy allowed it');
  assert.ok(!el.innerHTML.includes('sv-status-red'));
});

test('the search pseudo-host renders as Codex web search with its count', async () => {
  const { Page, el } = pageWith({
    transcript_consent: true,
    destinations: [{ host: 'web-search', calls: 3, blocked: 0, observed: 3, writes: 0 }],
  });
  await Page._renderEgress();
  assert.match(el.innerHTML, /Codex web search/);
  assert.match(el.innerHTML, /3 calls/);
});

test('a governed row keeps its verdict colour and gains no observed wording', async () => {
  const { Page, el } = pageWith({
    transcript_consent: true,
    destinations: [
      { host: 'bad.example.com', calls: 1, blocked: 1, observed: 0, writes: 0 },
      { host: 'api.example.com', calls: 4, blocked: 0, observed: 0, writes: 1 },
    ],
  });
  await Page._renderEgress();
  assert.match(el.innerHTML, /sv-status-red/);
  assert.match(el.innerHTML, /sv-status-green/);
  assert.ok(!el.innerHTML.includes('observed, not governed'));
});

test('a host with both governed and observed calls stays a governed row', async () => {
  const { Page, el } = pageWith({
    transcript_consent: true,
    destinations: [{ host: 'api.example.com', calls: 5, blocked: 0, observed: 2, writes: 0 }],
  });
  await Page._renderEgress();
  assert.match(el.innerHTML, /sv-status-green/);
  assert.ok(!el.innerHTML.includes('observed, not governed'));
});

test('a Codex task gets the after-the-fact note under the rows', async () => {
  const { Page, el } = pageWith({
    transcript_consent: true,
    destinations: [{ host: 'web-search', calls: 1, blocked: 0, observed: 1, writes: 0 }],
  });
  await Page._renderEgress();
  assert.match(el.innerHTML, /terminals-egress-note/);
  assert.match(el.innerHTML, /built-in web search is not hookable/);
  assert.match(el.innerHTML, /after the fact from the local transcript/);
});

test('a non-Codex task gets no Codex note', async () => {
  const { Page, el } = pageWith({
    transcript_consent: true,
    destinations: [{ host: 'api.example.com', calls: 1, blocked: 0, observed: 0, writes: 0 }],
  }, { executor_id: 'claude-code' });
  await Page._renderEgress();
  assert.ok(!el.innerHTML.includes('terminals-egress-note'));
});

test('consent off says nothing was read, not that nothing happened', async () => {
  const { Page, el } = pageWith({
    transcript_consent: false, observed_calls: 0, destinations: [],
  });
  await Page._renderEgress();
  assert.match(el.innerHTML, /Turn on transcript reading in Cost &amp; Tokens to list Codex web activity\./);
  assert.ok(!el.innerHTML.includes('after the fact from the local transcript'));
});

test('an empty governed list still carries the Codex note', async () => {
  const { Page, el } = pageWith({
    transcript_consent: true, observed_calls: 0, destinations: [],
  });
  await Page._renderEgress();
  assert.match(el.innerHTML, /No egress recorded yet\./);
  assert.match(el.innerHTML, /terminals-egress-note/);
});

test('an observed row re-renders when the consent flag flips', async () => {
  const elements = { 'terminals-egress': makeEl(), 'terminals-egress-count': makeEl() };
  let consent = false;
  const Page = loadTerminalsPage(elements, {
    getEgressSessionDestinations: async () => ({
      transcript_consent: consent, destinations: [],
    }),
  });
  Page._tasks = [{ id: 'task-1', session_id: 'sess-1', executor_id: 'codex' }];
  Page._attached = 'task-1';
  await Page._renderEgress();
  assert.match(elements['terminals-egress'].innerHTML, /Turn on transcript reading/);
  consent = true;
  Page._egressAt = 0;
  await Page._renderEgress();
  assert.match(elements['terminals-egress'].innerHTML, /not hookable/);
});

test('styles.css styles the observed note as muted, not as a status colour', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-egress-note\s*\{[^}]*color:\s*var\(--text-muted\)/);
});

test('the Codex Guard card tells the user how to bring web access under the Guard', () => {
  const src = read('js/pages/integrations.js');
  assert.match(src, /Web search inside Codex is not hookable\./);
  assert.match(src, /web_search = false/);
  assert.match(src, /codex-web-search-hint/);
});

test('index.html pins the bumped cache versions', () => {
  const html = read('index.html');
  assert.match(html, /terminals\.js\?v=43/);
  assert.match(html, /styles\.css\?v=422/);
  assert.match(html, /integrations\.js\?v=50/);
});
