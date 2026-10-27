/** Agent Sessions opened by a network address: no terminals API call, no
 *  socket, a plain note in place of the raw refusal. Localhost unchanged. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');
const RAW = 'Terminals: request not authorised';

function makeEl() {
  return { innerHTML: '', textContent: '', hidden: false, style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, setAttribute() {}, appendChild() {} };
}

function load(hostname, request) {
  const calls = [];
  const sockets = [];
  const window = { location: { hostname, reload() {} } };
  const sandbox = {
    window, console: { warn() {}, error() {}, log() {} }, URLSearchParams,
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} },
    WebSocket: function () { sockets.push(1); },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: async () => { calls.push('fetch'); throw new Error('no network'); },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('js/api.js') + '\nthis.API = API; window.API = API;', sandbox);
  sandbox.API.request = async (url) => { calls.push(url); return request ? request(url) : {}; };
  vm.runInContext(read('js/pages/terminals-layout.js'), sandbox);
  vm.runInContext(read('js/pages/terminals.js'), sandbox);
  return { API: sandbox.API, page: window.TerminalsPage, calls, sockets };
}

test('remote host: the API never asks the terminals routes and says the short note', async () => {
  const { API, calls } = load('192.168.1.20');
  assert.equal(API.terminalsRemote(), true);
  assert.equal(API.terminalsLocked(), true);
  await assert.rejects(API.terminalsTasks(), (e) => e.message === API.TERMINALS_LOCAL_NOTE && e.terminalsLocal === true);
  await assert.rejects(API.terminalsExecutors(), /only when the app is opened on this machine/);
  await assert.rejects(API.terminalsDriftFeedback('t1'), /only when the app is opened on this machine/);
  await assert.rejects(API.terminalsWorktreeRemove('t1'), /only when the app is opened on this machine/);
  assert.equal(calls.length, 0, 'no request, no UI token, no fetch');
  assert.equal(API.terminalsRefused, true);
  assert.doesNotMatch(API.TERMINALS_LOCAL_NOTE, /—|not authorised/);
});

test('remote host: the page renders the info state with no terminals call or socket', async () => {
  const { page, calls, sockets } = load('10.0.0.5"><img src=x>');
  const container = makeEl();
  await page.render(container);
  assert.match(container.innerHTML, /Agent Sessions run on this machine only/);
  assert.match(container.innerHTML, /opened by its network address \(10\.0\.0\.5&quot;&gt;&lt;img src=x&gt;\)/);
  assert.match(container.innerHTML, /Remote access to sessions is not enabled\./);
  assert.match(container.innerHTML, /You can still watch runs, governance and costs in/);
  assert.match(container.innerHTML, /data-act="open-runs">Observability</);
  assert.doesNotMatch(container.innerHTML, /not authorised|<img|—/);
  assert.equal(calls.length, 0);
  assert.equal(sockets.length, 0);
  assert.equal(page._pollTimer, null);
});

test('localhost: the session is asked for as today; a refusal becomes the note', async () => {
  const { API, calls } = load('127.0.0.1', (url) => { if (/session$/.test(url)) return {}; throw new Error(RAW); });
  assert.equal(API.terminalsRemote(), false);
  assert.equal(API.terminalsLocked(), false);
  await assert.rejects(API.terminalsTasks(), (e) => e.message === API.TERMINALS_LOCAL_NOTE);
  assert.ok(calls.length >= 2, 'session and tasks were requested');
  assert.equal(API.terminalsRefused, true);
  const ok = load('localhost', () => ({ items: [] }));
  const r = await ok.API.terminalsTasks();
  assert.equal(r.items.length, 0);
  assert.equal(ok.API.terminalsRefused, false);
  for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1']) assert.equal(load(h).API.terminalsRemote(), false, h);
});

test('localhost page path is unchanged: it builds the board, not the note', async () => {
  const src = read('js/pages/terminals.js');
  assert.match(src, /if \(window\.API && API\.terminalsLocked && API\.terminalsLocked\(\)\) \{ this\._renderLocalOnly\(container\); return; \}\n\s*container\.innerHTML = `\n\s*<div class="terminals-page">/);
  const side = read('js/components/sidebar.js');
  assert.match(side, /if \(API\.terminalsLocked && API\.terminalsLocked\(\)\) \{ this\._agentTaskViewsLoaded = true; return; \}/);
  assert.match(side, /Works only when the app is opened on this machine \(localhost\)/);
});
