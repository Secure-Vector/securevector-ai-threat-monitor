/** The task avatar is the Guardian as a small sphere, one per task: the
 * head is shaded as a sphere, the pods and eye glow carry a stable per-task
 * colour, the eyes carry the state, and the figure idles with a bob. */
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

test('color() is fixed per harness and falls back to the id hash for unknown harnesses', () => {
  const TaskAvatar = loadTaskAvatar();
  assert.strictEqual(TaskAvatar.color('task-1', 'claude-code'), TaskAvatar.HARNESS_COLORS['claude-code']);
  assert.strictEqual(TaskAvatar.color('task-2', 'claude-code'), TaskAvatar.color('task-9', 'claude-code'), 'every task of one harness shares its colour');
  assert.notStrictEqual(TaskAvatar.color('task-1', 'codex'), TaskAvatar.color('task-1', 'claude-code'));
  assert.notStrictEqual(TaskAvatar.color('task-1', 'openclaw'), TaskAvatar.color('task-1', 'cursor'));
  assert.strictEqual(TaskAvatar.color('task-1', 'unknown-harness'), TaskAvatar.color('task-1'));
  const out = TaskAvatar.html({ id: 'task-1', harness: 'codex', state: 'active' });
  assert.ok(out.includes(`--sv-bot-accent:${TaskAvatar.HARNESS_COLORS.codex}`));
});

test('all supported harnesses have a deliberate identity colour and task motion is phase-shifted', () => {
  const TaskAvatar = loadTaskAvatar();
  for (const harness of ['claude-code', 'codex', 'copilot-cli', 'opencode', 'openclaw', 'cursor']) {
    assert.ok(TaskAvatar.HARNESS_COLORS[harness], `${harness} has a harness colour`);
  }
  assert.notStrictEqual(TaskAvatar._delay('task-1'), TaskAvatar._delay('task-2'));
  assert.match(TaskAvatar.html({ id: 'task-1' }), /--sv-bot-delay:-[\d.]+s/);
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

test('html() carries the task colour and draws the sphere figure', () => {
  const TaskAvatar = loadTaskAvatar();
  const out = TaskAvatar.html({ id: 'task-7', state: 'active', label: 'Refactor' });
  const color = TaskAvatar.color('task-7');
  assert.ok(out.includes(`--sv-bot-accent:${color}`), 'the task colour rides the accent variable the Guardian uses');
  assert.ok(!out.includes('sv-ta-tile'), 'no badge of any shape behind the figure');
  assert.match(out, /<circle class="ta-head" cx="32" cy="34" r="24"\/>/, 'the head is a sphere');
  const eyeCount = (out.match(/class="ta-eye"/g) || []).length;
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
  assert.ok(sidebar.includes('TaskAvatar.el({ id: view.taskId, harness: view.harness'),
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
  assert.match(terminals, /sessionStorage\.setItem\('sv-agent-task-id', rec\.taskId\);[^]{0,90}if \(window\.Sidebar\?\.setActive\) Sidebar\.setActive\('terminals'\)/,
    'focusing a pane must re-highlight the rail right after claiming the stored task id');
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
  assert.match(out, /sv-task-avatar-failed/);
  assert.match(out, /sv-task-avatar-posture-concerned/, 'failed narrows the eyes');
});

test('html() renders both happy-eye paths for a completed task', () => {
  const TaskAvatar = loadTaskAvatar();
  const out = TaskAvatar.html({ id: 'task-1', state: 'completed' });
  const happyCount = (out.match(/class="ta-happy"/g) || []).length;
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

test('html() drops the blur filters below 24px and survives a missing document.body', () => {
  const src = read('js/components/task-avatar.js');
  const appended = [];
  const sandbox = { window: {}, document: {
    getElementById: () => null,
    createElement: () => ({ style: {}, set innerHTML(v) { this.firstElementChild = { id: 'sv-task-avatar-defs' }; }, set textContent(v) { this._t = v; }, get textContent() { return this._t; } }),
    head: { appendChild: (el) => appended.push('head') },
    body: null,
    documentElement: { appendChild: (el) => appended.push('root') },
  } };
  vm.runInNewContext(src, sandbox);
  const TA = sandbox.window.TaskAvatar;
  const small = TA.html({ id: 'x', state: 'active', size: 18 });
  assert.match(small, /sv-task-avatar-tiny/, 'tiny avatars get the flat treatment');
  assert.ok(!/sv-task-avatar-tiny/.test(TA.html({ id: 'x', state: 'active', size: 30 })));
  assert.ok(appended.includes('root'), 'defs fall back to documentElement when body is missing');
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

test('the avatar is the Guardian figure: sphere head, two pods, one visor, glowing eyes', () => {
  const TaskAvatar = loadTaskAvatar();
  const out = TaskAvatar.html({ id: 'task-1', state: 'active' });
  assert.match(out, /class="ta-head"/, 'the head must be drawn');
  assert.strictEqual((out.match(/class="ta-pod"/g) || []).length, 2,
    'the bot has one side pod per ear');
  assert.strictEqual((out.match(/class="ta-visor"/g) || []).length, 1,
    'one dark visor carries the eyes');
  assert.strictEqual((out.match(/class="ta-halo"/g) || []).length, 2,
    'each eye glows in the task colour');
});

test('styles.css draws no badge or ring around the figure', () => {
  const css = read('css/styles.css');
  assert.ok(!css.includes('.sv-ta-tile'), 'no tile rule may remain');
  assert.ok(!/\.sv-task-avatar[^{]*\{[^}]*box-shadow/.test(css), 'no state ring around the figure');
});

test('html() injects its defs and style once per document and idles with a bob', () => {
  const src = read('js/components/task-avatar.js');
  const created = [];
  const ids = new Set();
  const mk = () => {
    const el = { style: {}, children: [], set innerHTML(v) { this._html = v; this.firstElementChild = { id: /id="([^"]+)"/.exec(v)?.[1] }; }, get textContent() { return this._t; }, set textContent(v) { this._t = v; } };
    created.push(el);
    return el;
  };
  const sandbox = { window: {}, document: {
    getElementById: (id) => (ids.has(id) ? {} : null),
    createElement: () => mk(),
    head: { appendChild: (el) => { ids.add(el.id); } },
    body: { appendChild: (el) => { ids.add(el.id); } },
  } };
  vm.runInNewContext(src, sandbox);
  const TA = sandbox.window.TaskAvatar;
  TA.html({ id: 'a', state: 'active' });
  TA.html({ id: 'b', state: 'completed' });
  assert.ok(ids.has('sv-task-avatar-style'), 'the style block is injected');
  assert.ok(ids.has('sv-task-avatar-defs'), 'the shared defs block is injected');
  const style = created.find(e => e.id === 'sv-task-avatar-style');
  assert.match(style.textContent, /@keyframes sv-ta-bob/, 'the figure bobs');
  assert.match(style.textContent, /@keyframes sv-ta-sway/, 'the figure sways');
  assert.match(style.textContent, /prefers-reduced-motion: reduce/, 'motion respects the OS setting');
  assert.match(style.textContent, /\.sv-task-avatar \.ta-pod \{ fill: var\(--sv-bot-accent/, 'the pods carry the task colour');
  assert.match(style.textContent, /\[data-theme="light"\] \.sv-task-avatar \.ta-head/, 'the sphere has a light-theme shade');
});

test('the eyes are static: nothing breathes, blinks, or wanders', () => {
  const css = read('css/styles.css');
  const avatar = read('js/components/task-avatar.js');
  const eyeRule = /\.sv-task-avatar \.ta-eye \{([^}]*)\}/.exec(avatar);
  assert.ok(eyeRule && !/animation/.test(eyeRule[1]), 'the eyes themselves never animate');
  assert.ok(!avatar.includes('sv-ta-blink'), 'no blink keyframes');
  const bot = read('js/components/guardian-bot.js');
  assert.ok(!bot.includes('gb-blink'), 'the Guardian bot must not blink');
  assert.ok(!bot.includes('gb-wander'), 'the Guardian bot pupils must not wander');
});
