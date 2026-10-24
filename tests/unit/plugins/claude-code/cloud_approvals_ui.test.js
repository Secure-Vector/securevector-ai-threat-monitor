/** Approvals from SecureVector Cloud, local UI: the span panel names a
 *  cloud decision and who made it, the Settings section reads in plain
 *  words, and the inbox grant row names the cloud approver. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

function load() {
  const window = {};
  const sandbox = { window, console };
  vm.runInNewContext(read('js/components/trace-steps.js'), sandbox);
  vm.runInNewContext(read('js/components/run-trace.js'), sandbox);
  window.RunTrace._state = {};
  return window.RunTrace;
}

const T0 = Date.parse('2026-10-23T14:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();

function trace() {
  return {
    trace_id: 'tr-1', session_id: 'sess-abcdef12', runtime_kind: 'claude-code', started_at: at(0), ended_at: at(60),
    spans: [{ span_kind: 'tool_call', span_id: 'c3', tool_id: 'Bash', function_name: 'Bash', action: 'block', called_at: at(13), args_preview: 'curl https://hooks.example.test/up' }],
  };
}
const req = (extra = {}) => Object.assign({
  id: 'rq-1', session_id: 'sess-abcdef12', tool_id: 'Bash', function_name: 'Bash', status: 'approved', rule_source: 'local',
  requested_at: at(13), held_by: 'step_up', call_fingerprint: '9b41aa', call_preview: 'curl https://hooks.example.test/up',
}, extra);

function panel(r) {
  const RT = load();
  const t = trace();
  const tree = RT.buildTree(t, { requests: [r] });
  return RT.spanPanelHtml({ trace: t, tree, coverage: null }, RT.find(tree, 's:c3'));
}

test('span panel: a cloud decision reads "approved from the cloud by <user>"', () => {
  assert.match(panel(req({ decision_source: 'cloud', decided_by: 'owner@example.com' })), /approved from the cloud by owner@example\.com/);
  assert.match(panel(req({ status: 'denied', decision_source: 'cloud', decided_by: 'ops@example.com' })), /denied from the cloud by ops@example\.com/);
  assert.doesNotMatch(panel(req({ decided_by: 'local-user' })), /from the cloud/);
});

test('span panel: the cloud user name is escaped', () => {
  assert.doesNotMatch(panel(req({ decision_source: 'cloud', decided_by: '<img src=x>' })), /<img src=x>/);
});

test('settings: the section is off by default text, plain words, no em dashes', () => {
  const src = read('js/pages/settings.js');
  const start = src.indexOf('async renderCloudApprovals(');
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf('createSection(title, description, badgeText) {', start));
  assert.match(src, /'Approvals from SecureVector Cloud'/);
  assert.match(body, /Allow approvals from SecureVector Cloud/);
  assert.match(body, /Deny from the cloud always works while this is on/);
  assert.match(body, /Approve on this computer only/);
  assert.match(body, /API\.setCloudApprovals\(/);
  assert.doesNotMatch(body, /—/);
});

test('api: the setting is written through the UI-token decision path', () => {
  const src = read('js/api.js');
  assert.match(src, /setCloudApprovals\(body\) \{\s*return this\._jitDecision\('\/api\/settings\/cloud-approvals', body, 'PUT'\);/);
});

test('inbox: a cloud grant names its approver', () => {
  const src = read('js/pages/tool-permissions.js');
  assert.match(src, /g\.decision_source === 'cloud' \? ` · approved from the cloud by \$\{/);
});

test('settings: a paused poller is named in plain words', () => {
  const src = read('js/pages/settings.js');
  assert.match(src, /if \(cfg\.paused\) \{/);
  assert.match(src, /Cloud approvals paused: sign-in to Cloud Connect failed/);
});
