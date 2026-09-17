/** The task avatar is the Guardian figure on a round badge shared by the rail rows
 * and the Agent Tasks board: colour is task identity, state rides the ring,
 * eyes, and (for failed) an error badge. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

function loadTaskAvatar() {
  const src = read('js/components/task-avatar.js');
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  return sandbox.window.TaskAvatar;
}

test('color() is deterministic, palette-bound, and spreads across the palette', () => {
  const TaskAvatar = loadTaskAvatar();
  const first = TaskAvatar.color('task-42');
  const second = TaskAvatar.color('task-42');
  assert.strictEqual(first, second, 'the same id must always hash to the same colour');
  assert.ok(TaskAvatar.PALETTE.includes(first), 'colour must come from the palette');
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(TaskAvatar.color(`task-${i}`));
  assert.ok(seen.size >= 5, `expected at least 5 distinct colours across 40 ids, got ${seen.size}`);
});

test('color() falls back to the first palette entry for an empty id', () => {
  const TaskAvatar = loadTaskAvatar();
  assert.strictEqual(TaskAvatar.color(''), TaskAvatar.PALETTE[0]);
  assert.strictEqual(TaskAvatar.color(undefined), TaskAvatar.PALETTE[0]);
});

test('html() renders the requested state and falls back to active for an unknown one', () => {
  const TaskAvatar = loadTaskAvatar();
  const approval = TaskAvatar.html({ id: 'task-1', state: 'approval', label: 'Deploy check' });
  assert.match(approval, /sv-task-avatar-approval/);
  const unknown = TaskAvatar.html({ id: 'task-1', state: 'not-a-real-state', label: 'Deploy check' });
  assert.match(unknown, /sv-task-avatar-active/);
});

test('html() carries the task colour as a CSS variable and the Guardian-style markup', () => {
  const TaskAvatar = loadTaskAvatar();
  const out = TaskAvatar.html({ id: 'task-7', state: 'active', label: 'Refactor' });
  const color = TaskAvatar.color('task-7');
  assert.ok(out.includes(`--sv-task-hue:${color}`), 'the task colour must be set as a CSS variable');
  assert.match(out, /<circle class="sv-ta-tile" cx="12" cy="12" r="11"\/>/, 'the badge must be a circle');
  assert.ok(!/<rect class="sv-ta-tile"/.test(out), 'no square tile behind the Guardian');
  const eyeCount = (out.match(/class="sv-ta-eye"/g) || []).length;
  assert.strictEqual(eyeCount, 2, 'exactly two eyes');
});

test('html() escapes the label', () => {
  const TaskAvatar = loadTaskAvatar();
  const out = TaskAvatar.html({ id: 'task-9', state: 'active', label: '<script>alert(1)</script>' });
  assert.ok(!out.includes('<script>'), 'a raw label must never reach the DOM unescaped');
  assert.match(out, /&lt;script&gt;/);
});

test('sidebar.js draws the avatar in the task-row branch and refreshes the rail on a timer', () => {
  const sidebar = read('js/components/sidebar.js');
  assert.match(sidebar, /if \(view\.taskId\) \{[\s\S]*?TaskAvatar\.el\([\s\S]*?\}/,
    'the task-row branch must draw the shared avatar when TaskAvatar is available');
  assert.ok(sidebar.includes('TaskAvatar.el({ id: view.taskId'),
    'the rail row avatar must be keyed by the task id');
  assert.match(sidebar, /_agentTaskTimer/,
    'the rail rows must poll for state changes like the JIT badge does');
});

test('terminals.js draws the avatar on task cards and signals the rail to refresh', () => {
  const terminals = read('js/pages/terminals.js');
  assert.match(terminals, /TaskAvatar\.html\(/,
    'task cards must render the shared avatar');
  assert.match(terminals, /_railSig/,
    'a signature must gate unnecessary rail refreshes');
});

test('terminals.js enters a focused single-task mode on attach and leaves it on detach', () => {
  const terminals = read('js/pages/terminals.js');
  assert.match(terminals, /classList\.add\('is-focused'\)/,
    'attaching must enter the focused single-task mode');
  assert.match(terminals, /classList\.remove\('is-focused'\)/,
    'detaching must leave the focused single-task mode');
  assert.match(terminals, /sessionStorage\.setItem\('sv-agent-task-id', id\);\s*\n\s*if \(window\.Sidebar\?\.setActive\) Sidebar\.setActive\('terminals'\)/,
    'attaching must re-highlight the rail right after claiming the stored task id');
  assert.match(terminals, /\} else if \(!this\._error && requested && !this\._tasks\.some\(task => task\.id === requested\)\) \{/,
    'a fetch failure must not be mistaken for a vanished task and clear the stored id');
  assert.match(terminals, /terminals-all-tasks-btn/,
    'the attached head must offer a way back to the all-tasks view');
});

test('index.html loads task-avatar.js before sidebar.js', () => {
  const html = read('index.html');
  const avatar = html.indexOf('task-avatar.js');
  const sidebar = html.indexOf('sidebar.js');
  assert.ok(avatar > 0 && sidebar > 0 && avatar < sidebar,
    'TaskAvatar must be defined before sidebar.js uses it');
});

test('styles.css hides the task list while a task is focused', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.terminals-page\.is-focused \.terminals-tasks\s*\{\s*display:\s*none;\s*\}/);
});

test('html() renders the error badge for a failed task', () => {
  const TaskAvatar = loadTaskAvatar();
  const out = TaskAvatar.html({ id: 'task-1', state: 'failed' });
  assert.match(out, /class="sv-ta-err"/);
});

test('html() renders both happy-eye paths for a completed task', () => {
  const TaskAvatar = loadTaskAvatar();
  const out = TaskAvatar.html({ id: 'task-1', state: 'completed' });
  const happyCount = (out.match(/class="sv-ta-happy"/g) || []).length;
  assert.strictEqual(happyCount, 2, 'a completed task must show both happy-eye paths');
});

test('html() honours a valid explicit size', () => {
  const TaskAvatar = loadTaskAvatar();
  const out = TaskAvatar.html({ id: 'task-1', state: 'active', size: 30 });
  assert.match(out, /width:30px/);
  assert.match(out, /height:30px/);
});

test('html() is decorative and hidden from assistive tech when no label is given', () => {
  const TaskAvatar = loadTaskAvatar();
  const out = TaskAvatar.html({ id: 'task-1', state: 'active' });
  assert.match(out, /aria-hidden="true"/);
  assert.ok(!out.includes('role="img"'), 'a decorative avatar must not carry role="img"');
  assert.ok(!out.includes('aria-label='), 'a decorative avatar must not carry aria-label');
});

test('html() falls back to size 22 for a non-numeric size', () => {
  const TaskAvatar = loadTaskAvatar();
  const out = TaskAvatar.html({ id: 'task-1', state: 'active', size: 'x' });
  assert.match(out, /width:22px/);
  assert.match(out, /height:22px/);
});

test('styles.css scopes failed and rail-specific avatar rules', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.sv-task-avatar-failed \.sv-ta-err/,
    'the failed state must reveal the error badge');
  assert.match(css, /\.nav-item\.nav-view \.sv-task-avatar svg/,
    'the rail must override the generic nav svg sizing for the avatar');
  assert.match(css, /\.nav-item\.nav-view > span\.sv-task-avatar:first-of-type \{ flex: 0 0 auto/,
    'the rail avatar must beat the span:first-of-type flex:1 rule or it stretches');
  assert.match(css, /\.nav-item\.nav-view > \.sv-task-avatar \+ span \{ flex: 1/,
    'the label after the avatar must take the remaining row width');
});

test('the avatar mirrors the Guardian bot figure: head, two pods, one visor', () => {
  const TaskAvatar = loadTaskAvatar();
  const out = TaskAvatar.html({ id: 'task-1', state: 'active' });
  assert.match(out, /class="sv-ta-head"/, 'the Guardian head shape must be drawn');
  assert.strictEqual((out.match(/class="sv-ta-pod"/g) || []).length, 2,
    'the bot has one side pod per ear');
  assert.strictEqual((out.match(/class="sv-ta-visor"/g) || []).length, 1,
    'one dark visor carries the eyes');
});

test('styles.css keeps the avatar round and carries light-theme state rings', () => {
  const css = read('css/styles.css');
  assert.match(css, /\.sv-task-avatar \{[^}]*border-radius: 50%/, 'the state ring must follow the round badge');
  for (const state of ['approval', 'completed', 'interrupted']) {
    assert.match(css, new RegExp(`\\[data-theme="light"\\] \\.sv-task-avatar-${state} \\{ box-shadow`),
      `the ${state} ring needs a light-theme shade`);
  }
  assert.match(css, /\[data-theme="light"\] \.sv-task-avatar-blocked, \[data-theme="light"\] \.sv-task-avatar-failed \{ box-shadow/);
});

test('the eyes are static: nothing breathes, blinks, or wanders', () => {
  const css = read('css/styles.css');
  assert.ok(!css.includes('sv-task-avatar-breathe'),
    'the avatar eyes must not animate');
  const bot = read('js/components/guardian-bot.js');
  assert.ok(!bot.includes('gb-blink'), 'the Guardian bot must not blink');
  assert.ok(!bot.includes('gb-wander'), 'the Guardian bot pupils must not wander');
});
