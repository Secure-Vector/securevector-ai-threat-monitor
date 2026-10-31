/** Observability opened by the app's network address: the Live grid and the
 *  session governance read /api/observability (same access as the trace
 *  reads), and approvals and session controls are hidden with a plain note
 *  when the page is not on this machine or the terminals API refused it. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

const NOTE = 'Approvals and session controls work only when the app is opened on this machine (localhost).';
const T0 = Date.now() - 60000;
const at = (s) => new Date(T0 + s * 1000).toISOString();
const call = (id, name, s, extra = {}) => Object.assign({ span_kind: 'tool_call', span_id: id, tool_id: name, function_name: name, action: 'allow', called_at: at(s) }, extra);

function trace() {
  return {
    trace_id: 'tr-1', session_id: 's1', runtime_kind: 'claude-code', started_at: at(0), ended_at: at(20),
    spans: [call('c1', 'Read', 3), call('c3', 'Bash', 13, { action: 'block', args_preview: 'curl https://hooks.example.test' })],
  };
}

const pending = () => ({
  id: 'rq-1', session_id: 's1', trace_id: 'tr-1', tool_id: 'Bash', function_name: 'Bash', status: 'pending', rule_source: 'local',
  requested_at: at(13), expires_at: new Date(Date.now() + 300000).toISOString(), held_by: 'cred_then_net',
  call_fingerprint: '9b41aa', call_preview: 'curl https://hooks.example.test', justification: 'Held by rule',
});

function loadRT(win) {
  const window = Object.assign({}, win);
  const sandbox = { window, console };
  vm.runInNewContext(read('js/components/trace-steps.js'), sandbox);
  vm.runInNewContext(read('js/components/run-trace.js'), sandbox);
  window.RunTrace._state = {};
  return window.RunTrace;
}

function panel(RT) {
  const t = trace();
  const tree = RT.buildTree(t, { requests: [pending()] });
  return RT.spanPanelHtml({ trace: t, tree, expiryOf: (r) => r.expires_at }, RT.find(tree, 's:c3'));
}

test('loopback names: localhost, 127.0.0.0/8, ::1; anything else is not this machine', () => {
  const RT = loadRT();
  for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'LOCALHOST']) assert.equal(RT.isLocalHost(h), true, h);
  for (const h of ['10.0.0.5', '192.168.1.4', 'my-box.local', '127.0.0.1.example.test', '0.0.0.0', '']) assert.equal(RT.isLocalHost(h), false, h);
});

test('on loopback the waiting call keeps Allow and Deny, no note', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const html = panel(loadRT({ location: { hostname: host } }));
    assert.match(html, /data-act="deny"/, host);
    assert.match(html, /data-act="approve"/, host);
    assert.ok(!html.includes(NOTE), host);
  }
});

test('opened by network address: Allow and Deny hidden, the note shown, waiting and expiry kept', () => {
  const RT = loadRT({ location: { hostname: '10.0.0.5' } });
  assert.equal(RT.controlsLocked(), true);
  const html = panel(RT);
  assert.doesNotMatch(html, /data-act="deny"|data-act="approve"/);
  assert.ok(html.includes(NOTE));
  assert.match(html, /expires /);
  // Stop and Revoke are controls too.
  const src = read('js/components/run-trace.js');
  assert.match(src, /ctx\.canStop && !this\.controlsLocked\(\)/);
  assert.match(src, /g\.state === 'active' && !this\.controlsLocked\(\)/);
  assert.match(src, /case 'stop': if \(ctx\.onStop && !this\.controlsLocked\(\)\)/);
});

test('a refusal from the terminals API locks the controls even on loopback', () => {
  const RT = loadRT({ location: { hostname: '127.0.0.1' }, API: { terminalsRefused: true } });
  assert.equal(RT.controlsLocked(), true);
  const html = panel(RT);
  assert.doesNotMatch(html, /data-act="approve"/);
  assert.ok(html.includes(NOTE));
});

test('api.js: the four observability reads use the plain request helper under /api/observability', () => {
  const api = read('js/api.js');
  const block = api.slice(api.indexOf('async getObservabilityCoverage()'), api.indexOf('async terminalsExecutors()'));
  assert.ok(block.length > 100);
  assert.doesNotMatch(block, /_terminalsRead|\/api\/terminals/);
  assert.match(block, /this\.request\('\/api\/observability\/coverage'\)/);
  assert.match(block, /this\.request\(`\/api\/observability\/live/);
  assert.match(block, /this\.request\(`\/api\/observability\/egress-alerts/);
  assert.match(block, /this\.request\(`\/api\/observability\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/governance`\)/);
  // A refused terminals session is remembered, so controls hide.
  assert.match(api, /if \(this\._terminalsIsAuthError\(err\)\) this\.terminalsRefused = true;/);
});

test('a refused UI token locks the controls, with no reload and no retry', async () => {
  const reloads = [];
  const window = {
    location: { hostname: '127.0.0.1', reload: () => reloads.push(1) },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  const sandbox = { window, console, setTimeout, clearTimeout, URLSearchParams };
  vm.createContext(sandbox);
  vm.runInContext(read('js/api.js') + '\nthis.API = API;', sandbox);
  const API = sandbox.API;
  let asked = 0;
  API.request = async () => { asked += 1; throw new Error('Approvals answer only on this machine (localhost)'); };
  await assert.rejects(API._getJitToken(), /only on this machine/);
  assert.equal(asked, 1);
  assert.equal(API.terminalsRefused, true);
  assert.equal(reloads.length, 0);
  // RunTrace reads the same flag.
  window.API = API;
  vm.runInContext(read('js/components/trace-steps.js'), sandbox);
  vm.runInContext(read('js/components/run-trace.js'), sandbox);
  assert.equal(window.RunTrace.controlsLocked(), true);
});

function gridPage(hostname, refused) {
  const body = { innerHTML: '', contains: () => false, querySelectorAll: () => [], querySelector: () => null };
  const document = {
    hidden: false, activeElement: null,
    getElementById: (id) => (id === 'lg-body' ? body : id === 'lg-root' ? {} : null),
    querySelectorAll: () => [], querySelector: () => null,
  };
  const deny = () => Promise.reject(new Error('Terminals: request not authorised'));
  const calls = [];
  const API = {
    terminalsRefused: refused,
    getObservabilityLive: async () => {
      calls.push('live');
      return { sessions: [{ session_id: 's1', harness: 'claude-code', project: 'proj', quiet_seconds: 5, waiting: 1,
        oldest_waiting_expires_at: pending().expires_at, blocked: 0, score: null, cost_usd: null, tokens: 0,
        coverage_level: 'partial', tool_calls: { total: 2, allowed: 1, logged: 0, waiting: 1, blocked: 0 },
        egress_visible: true, last_egress: null, last_call: null }], counters: { running: 1, ended: 0 } };
    },
    getSessionGovernance: async () => { calls.push('gov'); return { runs: { trace_ids: ['tr-1'] }, approvals: { pending: [pending()], grants: [] } }; },
    getTraceTree: async () => trace(),
    getJitRequests: async () => ({ items: [pending()] }),
    terminalsSession: deny, terminalsTasks: deny, terminalsExecutors: deny, terminalsStop: deny,
    approveJitRequest: async () => { calls.push('approve'); }, denyJitRequest: async () => { calls.push('deny'); },
  };
  const window = { location: { hostname } };
  const sandbox = { window, document, console, API, localStorage: { getItem: () => null, setItem() {} }, setTimeout, clearTimeout };
  window.API = API;
  vm.createContext(sandbox);
  vm.runInContext(read('js/components/trace-steps.js'), sandbox);
  vm.runInContext(read('js/components/run-trace.js'), sandbox);
  vm.runInContext(read('js/components/live-grid-model.js'), sandbox);
  vm.runInContext(read('js/pages/live-grid.js') + '\nthis.LiveGridPage = LiveGridPage;', sandbox);
  sandbox.RunTrace = window.RunTrace;
  window.RunTrace._state = {};
  const P = sandbox.LiveGridPage;
  P.st = window.LiveGridModel.defaults([]);
  P._open = ['s1'];
  P._det = { s1: { key: null, req: 'rq-1', wait: true } };
  return { P, body, calls };
}

test('Live grid by network address with the terminals API refusing: rows render, the note replaces the buttons, no retry text', async () => {
  const { P, body, calls } = gridPage('10.0.0.5', true);
  await P.refresh({ force: true });
  assert.ok(calls.includes('live') && calls.includes('gov'));
  assert.match(body.innerHTML, /data-tsid="s1"/);
  assert.doesNotMatch(body.innerHTML, /could not be loaded|Retrying/);
  assert.ok(body.innerHTML.includes(NOTE));
  assert.doesNotMatch(body.innerHTML, /data-act="approve"|data-act="deny"/);
  // A decision cannot be sent from here either.
  await P._decide('s1', 'approve', 'rq-1', 'once');
  assert.ok(!calls.includes('approve'));
});

test('Live grid on loopback: the waiting call offers Allow and Deny', async () => {
  const { P, body } = gridPage('127.0.0.1', false);
  await P.refresh({ force: true });
  assert.match(body.innerHTML, /data-tsid="s1"/);
  assert.match(body.innerHTML, /data-act="approve"/);
  assert.ok(!body.innerHTML.includes(NOTE));
});
