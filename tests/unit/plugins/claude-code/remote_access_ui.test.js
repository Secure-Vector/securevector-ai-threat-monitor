/** Remote access mode (6.1.0, phase 1), browser side: the sign-in button
 *  shows only by a network address with the mode on; approvals and Stop are
 *  offered only when signed in; a remote approval offers Allow once (or the
 *  device allowance) and never a device-only rule; Agent Sessions lists
 *  sessions with Stop and the phase 1 note; the Settings section's states;
 *  the session travels in X-SV-Remote-Session from sessionStorage only. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');
const SID = 'a'.repeat(64);
const PHASE1 = 'Launching, linking and typing into sessions work only on this machine (localhost) in this release.';

function storage(initial) {
  const m = new Map(Object.entries(initial || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

/** api.js + remote-access.js (+ run-trace.js) in one sandbox. */
function load(hostname, { session, fetchLog, state } = {}) {
  const ss = storage(session ? { sv_remote_session: session } : {});
  const ls = storage();
  const window = { location: { hostname, reload() {} }, sessionStorage: ss, localStorage: ls };
  const sandbox = {
    window, console: { warn() {}, error() {}, log() {} }, URLSearchParams,
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    sessionStorage: ss, localStorage: ls, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: async (url, config) => {
      if (fetchLog) fetchLog.push({ url, config });
      return { ok: true, status: 200, json: async () => ({}) };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('js/api.js') + '\nthis.API = API; window.API = API;', sandbox);
  vm.runInContext(read('js/components/remote-access.js'), sandbox);
  vm.runInContext(read('js/components/trace-steps.js'), sandbox);
  vm.runInContext(read('js/components/run-trace.js'), sandbox);
  const RA = window.RemoteAccess;
  if (state) Object.assign(RA.state, state);
  window.RunTrace._state = {};
  return { API: sandbox.API, RA, RT: window.RunTrace, ss, ls };
}

const T0 = Date.now() - 60000;
const at = (s) => new Date(T0 + s * 1000).toISOString();
function trace() {
  return {
    trace_id: 'tr-1', session_id: 's1', runtime_kind: 'claude-code', started_at: at(0), ended_at: at(20),
    spans: [{ span_kind: 'tool_call', span_id: 'c3', tool_id: 'Bash', function_name: 'Bash', action: 'block', called_at: at(13), args_preview: 'curl https://hooks.example.test' }],
  };
}
const pending = (extra = {}) => Object.assign({
  id: 'rq-1', session_id: 's1', trace_id: 'tr-1', tool_id: 'Bash', function_name: 'Bash', status: 'pending', rule_source: 'local',
  requested_at: at(13), expires_at: new Date(Date.now() + 300000).toISOString(), held_by: 'step_up',
  call_fingerprint: '9b41aa', call_preview: 'curl https://hooks.example.test',
}, extra);
function panel(RT, req) {
  const t = trace();
  const tree = RT.buildTree(t, { requests: [req] });
  return RT.spanPanelHtml({ trace: t, tree, expiryOf: (r) => r.expires_at }, RT.find(tree, 's:c3'));
}
const ON_SIGNED = { enabled: true, signedIn: true };

test('header: the sign-in button shows only by a network address with the mode on', () => {
  assert.equal(load('10.0.0.5').RA.headerHtml(), '', 'off: nothing');
  const remote = load('10.0.0.5', { state: { enabled: true } });
  assert.match(remote.RA.headerHtml(), /Remote access on/);
  assert.match(remote.RA.headerHtml(), /data-act="remote-sign-in">Sign in for remote access</);
  const local = load('127.0.0.1', { state: { enabled: true } });
  assert.match(local.RA.headerHtml(), /Remote access on/);
  assert.doesNotMatch(local.RA.headerHtml(), /Sign in/);
  const signed = load('10.0.0.5', { session: SID, state: ON_SIGNED });
  assert.match(signed.RA.headerHtml(), /Sign out/);
  assert.doesNotMatch(signed.RA.headerHtml(), /Sign in for remote access/);
  // Neutral badge, plain words, no em dashes.
  assert.doesNotMatch(read('js/components/remote-access.js'), /—|firewall|Mission Control/);
});

test('controls: enabled by a network address only when signed in', () => {
  assert.equal(load('10.0.0.5').RT.controlsLocked(), true);
  assert.equal(load('10.0.0.5', { state: { enabled: true } }).RT.controlsLocked(), true, 'on, not signed in');
  assert.equal(load('10.0.0.5', { state: ON_SIGNED }).RT.controlsLocked(), true, 'no session in storage');
  const s = load('10.0.0.5', { session: SID, state: ON_SIGNED });
  assert.equal(s.RT.controlsLocked(), false);
  s.API.terminalsRefused = true;
  assert.equal(s.RT.controlsLocked(), false, 'a signed-in session is not undone by the terminals lock');
  const html = panel(s.RT, pending());
  assert.match(html, /data-act="approve"/);
  assert.match(html, /data-act="deny"/);
  assert.doesNotMatch(html, /work only when the app is opened on this machine/);
  const locked = panel(load('10.0.0.5', { state: { enabled: true } }).RT, pending());
  assert.doesNotMatch(locked, /data-act="approve"/);
});

test('durations: Allow once only from another machine, unless the device allowance permits more', () => {
  const s = load('10.0.0.5', { session: SID, state: ON_SIGNED });
  assert.deepEqual(Array.from(s.RT.durations(pending()), d => d[0]), ['once']);
  const html = panel(s.RT, pending());
  assert.match(html, /data-dur="once"/);
  assert.doesNotMatch(html, /data-dur="15m"|data-dur="1h"|data-dur="session"/);
  s.RA.state.allowance = ['once', '15m'];
  assert.deepEqual(Array.from(s.RT.durations(pending()), d => d[0]), ['once', '15m']);
  // On this machine: every duration, as before.
  assert.deepEqual(Array.from(load('127.0.0.1').RT.durations(pending()), d => d[0]), ['once', '15m', '1h', 'session']);
});

test('device-only rules: Deny plus "Approve this on the machine itself", no approve buttons', () => {
  const s = load('10.0.0.5', { session: SID, state: ON_SIGNED });
  for (const rule of ['cred_then_net', 'outside_then_reach']) {
    const html = panel(s.RT, pending({ held_by: rule }));
    assert.match(html, /Approve this on the machine itself\./);
    assert.match(html, /data-act="deny"/);
    assert.doesNotMatch(html, /data-act="approve"/);
  }
  // On this machine the same request keeps its buttons.
  assert.match(panel(load('127.0.0.1').RT, pending({ held_by: 'cred_then_net' })), /data-act="approve"/);
});

test('trace: a remote decision reads "approved from another machine by <address>"', () => {
  const RT = load('127.0.0.1').RT;
  const html = panel(RT, pending({ status: 'approved', decision_source: 'remote', decided_by: 'remote:203.0.113.7' }));
  assert.match(html, /approved from another machine by 203\.0\.113\.7/);
  const denied = panel(RT, pending({ status: 'denied', decision_source: 'remote', decided_by: 'remote:<img src=x>' }));
  assert.match(denied, /denied from another machine by &lt;img/);
  assert.doesNotMatch(denied, /<img src=x>/);
});

test('X-SV-Remote-Session header: attached from sessionStorage only, never localStorage or a cookie', async () => {
  const log = [];
  const s = load('10.0.0.5', { session: SID, fetchLog: log });
  await s.API.request('/api/traces');
  assert.equal(log[0].config.headers['X-SV-Remote-Session'], SID);
  assert.equal(log[0].config.headers.Authorization, undefined, 'Authorization stays free for an ingress token');
  assert.equal(log[0].config.credentials, undefined);
  const none = [];
  const n = load('10.0.0.5', { fetchLog: none });
  n.ls.setItem('sv_remote_session', SID);
  await n.API.request('/api/traces');
  assert.equal(none[0].config.headers['X-SV-Remote-Session'], undefined);
  // Not a well-formed id: not sent.
  const bad = [];
  await load('10.0.0.5', { session: 'x"; y', fetchLog: bad }).API.request('/api/traces');
  assert.equal(bad[0].config.headers['X-SV-Remote-Session'], undefined);
  const src = read('js/components/remote-access.js');
  assert.doesNotMatch(src, /localStorage\.|document\.cookie/);
});

test('remote decisions skip the UI token; approve and revoke ask for the token again when stale', async () => {
  const log = [];
  const s = load('10.0.0.5', { session: SID, state: ON_SIGNED, fetchLog: log });
  const asked = [];
  s.RA.askToken = async (title) => { asked.push(title); return 'svra_token'; };
  s.RA.state.reauthAt = Date.now();
  await s.API.approveJitRequest('rq-1', 'once');
  assert.equal(asked.length, 0, 'fresh: no prompt');
  assert.equal(log[0].config.headers['X-SV-UI-Token'], undefined);
  assert.match(log[0].url, /requests\/rq-1\/approve$/);
  s.RA.state.reauthAt = Date.now() - 11 * 60 * 1000;
  await s.API.denyJitRequest('rq-1');
  assert.equal(asked.length, 0, 'deny never asks');
  await s.API.revokeJitGrant('g1');
  assert.equal(asked.length, 1);
  assert.ok(log.some(c => /remote-access\/reauth$/.test(c.url)));
});

test('Agent Sessions signed in remotely: the list with Stop and the phase 1 note, no launch or terminal', async () => {
  const calls = [];
  const s = load('10.0.0.5', { session: SID, state: ON_SIGNED });
  const ctx = vm.createContext({
    window: { location: { hostname: '10.0.0.5' }, RemoteAccess: s.RA, API: s.API },
    console, setInterval: () => 1, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
  });
  ctx.API = s.API;
  ctx.RemoteAccess = s.RA;
  s.API.request = async (url) => { calls.push(url); if (/remote-access$/.test(url)) return { enabled: true, signed_in: true, local: false }; return { items: [{ id: 't1', title: 'Fix <b>bug</b>', executor_id: 'claude-code', status: 'working' }, { id: 't2', executor_id: 'codex', status: 'done' }] }; };
  vm.runInContext(read('js/pages/terminals-layout.js'), ctx);
  vm.runInContext(read('js/pages/terminals.js'), ctx);
  const page = ctx.window.TerminalsPage;
  const el = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  await page.render(el);
  assert.ok(el.innerHTML.includes(PHASE1));
  assert.match(el.innerHTML, /data-act="remote-stop" data-task="t1">Stop</);
  assert.doesNotMatch(el.innerHTML, /data-task="t2"/, 'no Stop on a finished session');
  assert.match(el.innerHTML, /Fix &lt;b&gt;bug&lt;\/b&gt;/);
  assert.doesNotMatch(el.innerHTML, /\+ Launch|terminals-launch|Link a running session|xterm|terminal-view/);
  assert.ok(calls.some(u => /\/tasks$/.test(u)));
  // Mode on, not signed in: the this-machine note offers sign-in instead.
  s.RA.state.signedIn = false;
  const html = page._localOnlyHtml('10.0.0.5');
  assert.match(html, /Remote access is on: sign in/);
  assert.match(html, /data-act="remote-sign-in"/);
  s.RA.state.enabled = false;
  assert.match(page._localOnlyHtml('10.0.0.5'), /Remote access to sessions is not enabled\./);
});

test('settings: disabled on a localhost-only bind, read-only by network address, guided enable', () => {
  const RA = load('127.0.0.1').RA;
  const base = { enabled: false, local: true, bound_loopback_only: false, proxy_address: [] };
  const off = RA.settingsHtml(base, {});
  assert.match(off, />Off</);
  assert.match(off, />On</);
  assert.ok(off.includes(RA.TURN_ON_HERE));
  assert.doesNotMatch(off, / disabled/);
  const loop = RA.settingsHtml(Object.assign({}, base, { bound_loopback_only: true }), {});
  assert.match(loop, /data-act="remote-on" aria-pressed="false" disabled/);
  assert.match(loop, /Not needed here: you are on this machine\./);
  const remote = RA.settingsHtml({ enabled: true, local: false }, {});
  assert.match(remote, /Change this on the machine itself\./);
  assert.match(remote, /data-act="remote-off" aria-pressed="false" disabled/);
  assert.doesNotMatch(remote, /remote-rotate|remote-enable/);
  const editing = RA.settingsHtml(base, { editing: true });
  assert.match(editing, /id="remote-allowed"/);
  assert.match(editing, /id="remote-proxy"/);
  assert.match(editing, /data-act="remote-enable"/);
  const shown = RA.settingsHtml(Object.assign({}, base, { enabled: true, allowed_address: 'https://sv.example.com', proxy_address: ['10.0.0.2/32'] }), { token: 'svra_<x>' });
  assert.match(shown, /svra_&lt;x&gt;/);
  assert.match(shown, /data-act="remote-copy"/);
  assert.match(shown, /This token is shown once\. Store it in your password manager\./);
  assert.match(shown, /data-act="remote-rotate">Rotate token</);
  assert.match(shown, /This signs out every remote browser\./);
  assert.match(shown, /aria-pressed="true">On</);
  assert.doesNotMatch(read('js/components/remote-access.js'), /—/);
});

test('index.html loads remote-access.js after api.js and before the header', () => {
  const html = read('index.html');
  const i = html.indexOf('/js/components/remote-access.js?v=');
  assert.ok(i > html.indexOf('/js/api.js?v=') && i < html.indexOf('/js/components/header.js?v='));
  assert.match(read('js/components/header.js'), /remote-access-slot/);
  assert.match(read('js/pages/settings.js'), /'Remote access'/);
});

test('mode reported off: the session is dropped from sessionStorage and no longer sent', async () => {
  const log = [];
  const s = load('10.0.0.5', { session: SID, state: ON_SIGNED, fetchLog: log });
  s.API.request = async () => ({ enabled: false, signed_in: true, local: false });
  await s.RA.refresh();
  assert.equal(s.ss.getItem('sv_remote_session'), null);
  assert.equal(s.RA.authHeader(), '');
  assert.equal(s.RA.signedIn(), false);
});

test('settings: the guided enable names the proxy Host requirement', () => {
  const RA = load('127.0.0.1').RA;
  const html = RA.settingsHtml({ enabled: false, local: true, bound_loopback_only: false, proxy_address: [] }, { editing: true });
  assert.match(html, /Pass the original Host \(nginx: proxy_set_header Host \$host\)\./);
});

test('settings by a network address: only Off is offered when signed in', () => {
  const s = load('10.0.0.5', { session: SID, state: ON_SIGNED });
  const html = s.RA.settingsHtml({ enabled: true, local: false }, {});
  assert.match(html, /data-act="remote-off" aria-pressed="false">Off</);
  assert.match(html, /data-act="remote-on" aria-pressed="true" disabled>On</);
  assert.doesNotMatch(html, /counts as remote/);
  const out = load('10.0.0.5', { state: { enabled: true } }).RA.settingsHtml({ enabled: true, local: false }, {});
  assert.match(out, /data-act="remote-off" aria-pressed="false" disabled>Off</);
});

test('background polls send X-SV-Poll: 1; other requests do not', async () => {
  const log = [];
  const s = load('10.0.0.5', { session: SID, fetchLog: log });
  await s.API.asPoll(() => s.API.request('/api/traces'));
  await s.API.request('/api/traces');
  assert.equal(log[0].config.headers['X-SV-Poll'], '1');
  assert.equal(log[1].config.headers['X-SV-Poll'], undefined);
  for (const f of ['js/pages/terminals.js', 'js/components/sidebar.js', 'js/pages/live-grid.js', 'js/pages/agent-runs.js', 'js/components/egress-alert-watch.js']) {
    assert.match(read(f), /asPoll\(/, f);
  }
});

test('settings: the guided enable explains a proxy on this machine (private IP, not 127.0.0.1)', () => {
  const RA = load('127.0.0.1').RA;
  const html = RA.settingsHtml({ enabled: false, local: true, bound_loopback_only: false, proxy_address: [] }, { editing: true });
  // No port from the server and none on the page: the default.
  assert.match(html, /proxy_pass http:\/\/&lt;private-ip&gt;:8741/);
  const served = RA.settingsHtml({ enabled: false, local: true, bound_loopback_only: false, proxy_address: [], web_port: 9100 }, { editing: true });
  assert.match(served, /proxy_pass http:\/\/&lt;private-ip&gt;:9100;/);
  assert.match(served, /reverse_proxy &lt;private-ip&gt;:9100/);
  assert.doesNotMatch(served, /8742/);
});
