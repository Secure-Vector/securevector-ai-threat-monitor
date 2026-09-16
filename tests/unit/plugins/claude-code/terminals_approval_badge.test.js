/** The task rail must make an actionable JIT approval distinct from running. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(
  __dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web', 'js', 'pages', 'terminals.js'
), 'utf8');

test('a task row labels only session-matched pending JIT requests as waiting for approval', () => {
  assert.match(page, /API\.getJitRequests\('pending'\)/,
    'the existing approval inbox must supply task-row state');
  assert.match(page, /_pendingApprovalSessions = new Set\([\s\S]*?\.map\(r => r\.session_id\)\.filter\(Boolean\)/,
    'pending approval sessions must be indexed without a new backend route');
  assert.match(page, /_hasPendingApproval\(t\)[\s\S]*?t\.session_id[\s\S]*?_pendingApprovalSessions\.has\(t\.session_id\)/,
    'the badge must match the terminal task to its own session');
  assert.match(page, /kind: 'approval', label: 'Waiting approval'/,
    'waiting approval must be explicit on the task row');
});

test('finished tasks can be relaunched without replacing their original session', () => {
  assert.match(page, /const canRelaunch = t\.status === 'done'/,
    'only a finished task should expose the relaunch affordance');
  assert.match(page, /terminals-task-relaunch[\s\S]*?Relaunch/,
    'finished task cards must offer a visible Relaunch action');
  assert.match(page, /API\.terminalsLaunch\(task\.executor_id, task\.workspace, task\.title \|\| ''\)/,
    'relaunch must retain the harness, workspace, and title when creating a fresh task');
  assert.match(page, /await this\._refreshTasks\(\);[\s\S]*?this\._attach\(fresh\.id\)/,
    'the freshly-created task should be shown and attached after relaunch');
});

test('the page presents task sessions as a card-first governed workspace', () => {
  assert.match(page, /terminals-eyebrow">Governed workspace/);
  assert.match(page, /terminals-stage-empty/,
    'an unattached terminal should show a useful workspace state instead of a blank pane');
  assert.match(page, /terminals-task-select/,
    'cards retain an explicit task-open control separate from their relaunch action');
});
