/** Uninstalling a Guard plugin while that harness still has live sessions is
 * refused by the server with HTTP 409 and a `detail` naming the sessions. The
 * Integrations page has to show that refusal as written, and offer a second,
 * deliberate click to go ahead anyway. A 409 body has no `ok` field, so a bare
 * `result.ok` check turns a specific refusal into a generic failure.
 *
 * Exercised through IntegrationPage's helpers rather than a live POST: the
 * endpoint is destructive and removes real plugins from the running install.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const SOURCE = fs.readFileSync(path.join(WEB, 'js', 'pages', 'integrations.js'), 'utf8');

const HARNESSES = ['claude-code', 'copilot-cli', 'opencode', 'codex'];

/** Minimal element: enough for the confirm row, nothing more. */
function makeEl(tag) {
  const el = {
    tagName: tag,
    type: '',
    textContent: '',
    disabled: false,
    onclick: null,
    parentNode: null,
    children: [],
    style: { cssText: '', display: '', background: '', border: '', color: '' },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
  };
  return el;
}

/** Load the page module with just the globals it touches at load time. */
function loadPage(fetchImpl) {
  const timers = new Map();
  let nextTimer = 1;
  const sandbox = {
    window: {},
    console,
    fetch: fetchImpl,
    document: { createElement: (tag) => makeEl(tag) },
    setTimeout: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'integrations.js' });
  return { page: sandbox.window.IntegrationPage, timers, makeEl: () => makeEl('div') };
}

/** A harness card's result area plus the showResult it owns. */
function makeSurface() {
  const resultArea = makeEl('div');
  const shown = [];
  const showResult = (kind, message) => {
    resultArea.children.length = 0;
    resultArea.textContent = message;
    shown.push({ kind, message });
  };
  return { resultArea, showResult, shown };
}

const DETAIL = '1 session of this harness is still running (5a3fe01a6e2d). '
  + 'Stop them first, or they keep running with nothing watching them.';

const refusal = () => ({ status: 409, json: async () => ({ detail: DETAIL }) });
const removed = () => ({ status: 200, json: async () => ({ ok: true }) });

test('a 409 shows the server detail verbatim and does not report removal', async () => {
  const calls = [];
  const { page } = loadPage(async (url, init) => { calls.push({ url, init }); return refusal(); });
  const { resultArea, showResult, shown } = makeSurface();
  const button = makeEl('button');
  let removedCalled = false;

  await page.runPluginUninstall({
    url: '/api/hooks/claude-code/uninstall',
    button,
    resultArea,
    showResult,
    onRemoved: () => { removedCalled = true; },
  });

  assert.equal(removedCalled, false, 'a refused uninstall must not claim the plugin was removed');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].message, DETAIL, 'the refusal is shown as the server wrote it');
  assert.equal(shown[0].kind, 'warning');
  assert.equal(button.disabled, false, 'the button is usable again after the refusal');
  assert.equal(button.textContent, 'Uninstall');
  assert.equal(calls.length, 1, 'the refusal is not retried on its own');
});

test('the non-forced call sends an empty JSON body, never ?force= in the URL', async () => {
  const calls = [];
  const { page } = loadPage(async (url, init) => { calls.push({ url, init }); return removed(); });
  const { resultArea, showResult } = makeSurface();
  const button = makeEl('button');

  await page.runPluginUninstall({
    url: '/api/hooks/codex/uninstall',
    button,
    resultArea,
    showResult,
    onRemoved: () => {},
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/hooks/codex/uninstall');
  assert.ok(!calls[0].url.includes('force'), 'force does not travel in the query string');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), {});
});

test('going ahead anyway is a second click, and it sends force in the body', async () => {
  const calls = [];
  const { page } = loadPage(async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? refusal() : removed();
  });
  const { resultArea, showResult } = makeSurface();
  const button = makeEl('button');
  let removedCalled = false;

  await page.runPluginUninstall({
    url: '/api/hooks/opencode/uninstall',
    button,
    resultArea,
    showResult,
    onRemoved: () => { removedCalled = true; },
  });

  const buttons = resultArea.children[0].children.filter((c) => c.tagName === 'button');
  assert.equal(buttons.length, 2, 'a way out and a way through, both explicit');
  const keep = buttons[0];
  const force = buttons[1];
  assert.equal(keep.textContent, 'Keep the plugin');
  assert.match(force.textContent, /Remove anyway/);
  assert.ok(!/force/i.test(force.textContent), 'the label names the consequence, not the flag');
  assert.equal(calls.length, 1, 'showing the refusal does not remove anything');

  force.onclick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].init.body), { force: true });
  assert.equal(calls[1].init.headers['Content-Type'], 'application/json');
  assert.equal(removedCalled, true);
  assert.equal(resultArea.children.length, 0, 'the confirm row goes once it is used');
});

test('keeping the plugin disarms the confirm and sends nothing', async () => {
  const calls = [];
  const { page } = loadPage(async (url, init) => { calls.push({ url, init }); return refusal(); });
  const { resultArea, showResult } = makeSurface();
  const button = makeEl('button');

  await page.runPluginUninstall({
    url: '/api/hooks/copilot-cli/uninstall',
    button,
    resultArea,
    showResult,
    onRemoved: () => {},
  });

  const row = resultArea.children[0];
  const keep = row.children.filter((c) => c.tagName === 'button')[0];
  keep.onclick();

  assert.equal(resultArea.children.length, 0);
  assert.equal(calls.length, 1, 'Keep is not a second uninstall');
});

test('a forgotten confirm disarms itself', async () => {
  const { page, timers } = loadPage(async () => refusal());
  const { resultArea, showResult } = makeSurface();
  const button = makeEl('button');

  await page.runPluginUninstall({
    url: '/api/hooks/claude-code/uninstall',
    button,
    resultArea,
    showResult,
    onRemoved: () => {},
  });

  assert.equal(resultArea.children.length, 1);
  assert.equal(timers.size, 1, 'the confirm arms a timeout, like the board does');
  for (const fn of timers.values()) fn();
  assert.equal(resultArea.children.length, 0);
});

test('a 409 with an unreadable body still explains itself', async () => {
  const { page } = loadPage(async () => ({ status: 409, json: async () => { throw new Error('not json'); } }));
  const { resultArea, showResult, shown } = makeSurface();

  await page.runPluginUninstall({
    url: '/api/hooks/codex/uninstall',
    button: makeEl('button'),
    resultArea,
    showResult,
    onRemoved: () => { throw new Error('must not report removal'); },
  });

  assert.equal(shown[0].kind, 'warning');
  assert.match(shown[0].message, /still running/);
});

test('every Guard uninstall button goes through the shared helper', () => {
  for (const harness of HARNESSES) {
    const url = `/api/hooks/${harness}/uninstall`;
    assert.ok(
      !SOURCE.includes(`fetch('${url}', { method: 'POST' })`),
      `${harness} still uninstalls with a bare POST that drops the 409 refusal`,
    );
    assert.ok(
      SOURCE.includes(`IntegrationPage.runPluginUninstall({\n            url: '${url}',`),
      `${harness} does not use runPluginUninstall`,
    );
  }
  assert.ok(!SOURCE.includes('force=true'), 'force is a body field, not a query parameter');
});
