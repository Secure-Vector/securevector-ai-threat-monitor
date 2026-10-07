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

// ---------------------------------------------------------------------------
// The 3D sprite. The figure is a real three.js render baked offline by
// scripts/render_task_avatar_atlas.py; the flat SVG above stays as the
// decode-time paint, the load failure fallback, and the only renderer for an
// unknown harness (whose colour is a hash, so no sheet can hold it).
// ---------------------------------------------------------------------------

const ATLAS_REL = 'images/task-avatar-atlas.png';

// The sprite and halo rules are generated, not literal source text, so they
// are asserted against the stylesheet the component actually emits.
function injectedStyle() {
  const src = read('js/components/task-avatar.js');
  const created = [];
  const ids = new Set();
  const mk = () => {
    const el = {
      style: {},
      set innerHTML(v) { this._html = v; this.firstElementChild = { id: /id="([^"]+)"/.exec(v)?.[1] }; },
      get textContent() { return this._t; },
      set textContent(v) { this._t = v; },
    };
    created.push(el);
    return el;
  };
  const sandbox = { window: {}, document: {
    getElementById: (id) => (ids.has(id) ? {} : null),
    createElement: () => mk(),
    head: { appendChild: (el) => { ids.add(el.id); } },
    body: { appendChild: (el) => { ids.add(el.id); } },
    documentElement: { setAttribute() {}, appendChild() {} },
  } };
  vm.runInNewContext(src, sandbox);
  sandbox.window.TaskAvatar.html({ id: 'a', harness: 'codex', state: 'active' });
  const style = created.find((e) => e.id === 'sv-task-avatar-style');
  assert.ok(style && style.textContent, 'the component must inject a stylesheet');
  return style.textContent;
}

function pngSize(buf) {
  assert.strictEqual(buf.toString('ascii', 1, 4), 'PNG', 'the atlas must be a PNG');
  assert.strictEqual(buf.toString('ascii', 12, 16), 'IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('every harness and state resolves to a sprite cell inside the sheet', () => {
  const TaskAvatar = loadTaskAvatar();
  const harnesses = Object.keys(TaskAvatar.HARNESS_COLORS);
  assert.strictEqual(TaskAvatar.ATLAS_COLS, TaskAvatar.STATES.length);
  assert.strictEqual(TaskAvatar.ATLAS_THEME_ROWS, harnesses.length);
  assert.strictEqual(TaskAvatar.ATLAS_ROWS, harnesses.length * 2,
    'one block of rows per theme: the shell tone flips like the SVG head does');
  const seen = new Set();
  for (const harness of harnesses) {
    for (const state of TaskAvatar.STATES) {
      const cell = TaskAvatar.atlasCell(harness, state);
      assert.ok(cell, `${harness}/${state} must have a baked cell`);
      assert.ok(cell.col >= 0 && cell.col < TaskAvatar.ATLAS_COLS, 'column inside the sheet');
      assert.ok(cell.row >= 0 && cell.row < TaskAvatar.ATLAS_THEME_ROWS, 'row inside the theme block');
      seen.add(`${cell.col},${cell.row}`);
      const out = TaskAvatar.html({ id: 't', harness, state, size: 22 });
      const classes = /class="([^"]*)"/.exec(out)[1].split(/\s+/);
      assert.ok(classes.includes('sv-task-avatar-sprite'),
        `a harness with a baked cell is marked as a sprite (got "${classes.join(' ')}")`);
      assert.ok(classes.includes('sv-task-avatar'), 'and keeps the base class');
      assert.ok(out.includes(`--ta-col:${cell.col};--ta-row:${cell.row}`),
        `${harness}/${state} must point the sprite at its own cell`);
    }
  }
  assert.strictEqual(seen.size, harnesses.length * TaskAvatar.STATES.length,
    'no two harness/state pairs may share a cell');
});

test('an unknown harness has no sprite cell and keeps the flat figure in its hashed colour', () => {
  const TaskAvatar = loadTaskAvatar();
  assert.strictEqual(TaskAvatar.atlasCell('not-a-harness', 'active'), null);
  assert.strictEqual(TaskAvatar.atlasCell(undefined, 'active'), null);
  const out = TaskAvatar.html({ id: 'task-7', harness: 'not-a-harness', state: 'active' });
  assert.ok(!out.includes('sv-task-avatar-sprite'), 'an unknown harness never claims a cell');
  assert.ok(!out.includes('ta-sprite'), 'and never carries a sprite layer');
  assert.ok(out.includes(`--sv-bot-accent:${TaskAvatar.color('task-7')}`),
    'it keeps the stable per-id hash colour, which is why it cannot be baked');
  assert.match(out, /<circle class="ta-head" cx="32" cy="34" r="24"\/>/, 'and it draws the flat sphere');
});

test('an unknown state still lands on a real cell rather than off the sheet', () => {
  const TaskAvatar = loadTaskAvatar();
  const cell = TaskAvatar.atlasCell('codex', 'not-a-real-state');
  assert.deepStrictEqual(cell, TaskAvatar.atlasCell('codex', 'active'),
    'an unknown state falls back to active, exactly as html() does');
});

test('the flat SVG figure is rendered underneath every sprite, and only hides once the atlas loads', () => {
  const TaskAvatar = loadTaskAvatar();
  const out = TaskAvatar.html({ id: 'task-1', harness: 'codex', state: 'active' });
  assert.match(out, /class="ta-head"/, 'the fallback figure is always in the DOM');
  assert.strictEqual((out.match(/class="ta-eye"/g) || []).length, 2, 'fallback eyes included');
  assert.strictEqual((out.match(/class="ta-pod"/g) || []).length, 2, 'fallback pods included');
  assert.ok(out.indexOf('</svg>') < out.indexOf('ta-sprite'),
    'the sprite layer sits over the SVG, so the flat figure paints during the decode');
  const css = injectedStyle();
  const src = read('js/components/task-avatar.js');
  assert.match(css, /\[data-sv-ta-atlas="ready"\] \.sv-task-avatar-sprite svg \{ visibility: hidden; \}/,
    'the SVG is only hidden once the atlas has actually loaded');
  assert.match(css, /\[data-sv-ta-atlas="ready"\] \.sv-task-avatar-sprite \.ta-sprite \{ display: block; \}/,
    'and the sprite only shows then, so a failed load leaves the SVG on screen');
  assert.match(src, /img\.onerror = \(\)/, 'a failed atlas load must be handled, not thrown');
});

test('the atlas ships on disk at the size the component addresses and stays under 400KB', () => {
  const TaskAvatar = loadTaskAvatar();
  const file = path.join(WEB, ATLAS_REL);
  assert.ok(fs.existsSync(file), 'the baked atlas must be committed alongside the component');
  const buf = fs.readFileSync(file);
  const { width, height } = pngSize(buf);
  assert.strictEqual(width, TaskAvatar.ATLAS_COLS * TaskAvatar.ATLAS_CELL_W,
    'one 132px column per state (3x the largest use)');
  assert.strictEqual(height, TaskAvatar.ATLAS_ROWS * TaskAvatar.ATLAS_CELL_H,
    'one row per harness, per theme, cut to the figure aspect rather than square');
  assert.strictEqual(TaskAvatar.ATLAS_CELL_W, 132, 'the cell width stays 3x the largest use');
  assert.ok(TaskAvatar.ATLAS_CELL_H < TaskAvatar.ATLAS_CELL_W,
    'the cell is cut to the wide figure, so no dead band is encoded');
  assert.ok(buf.length <= 400 * 1024, `atlas is ${buf.length} bytes, budget is ${400 * 1024}`);
  assert.ok(TaskAvatar.ATLAS_SRC.startsWith(`/${ATLAS_REL}?v=`),
    'the atlas URL must carry its own cache pin');
});

test('the sprite is positioned by cell and flips to the light-theme block of rows', () => {
  const TaskAvatar = loadTaskAvatar();
  const src = injectedStyle();
  const cols = TaskAvatar.ATLAS_COLS, rows = TaskAvatar.ATLAS_ROWS;
  assert.ok(src.includes(`background-size: ${cols * 100}% ${rows * 100}%`),
    'the sheet is scaled so one cell fills the badge');
  assert.ok(src.includes(`calc(var(--ta-col) / ${cols - 1} * 100%) calc(var(--ta-row) / ${rows - 1} * 100%)`),
    'the dark-theme cell is addressed straight from the row');
  assert.ok(src.includes(`calc((var(--ta-row) + ${TaskAvatar.ATLAS_THEME_ROWS}) / ${rows - 1} * 100%)`),
    'the light theme reads the second block of rows');
});

test('the sprite idles like the SVG and stops for reduced motion', () => {
  const src = injectedStyle();
  assert.match(src, /\.sv-task-avatar \.ta-sprite \{[^}]*animation: sv-ta-sway/, 'the sprite sways');
  assert.match(src, /\.sv-task-avatar \.ta-sprite > i \{[^}]*animation: sv-ta-bob-sprite/, 'and bobs');
  assert.match(src, /@keyframes sv-ta-bob-sprite \{[\s\S]*?50% \{ transform: translateY\(-3\.8%\); \}/,
    'the sprite bob is proportional, not the SVG user units, so it holds from 18px to 44px');
  assert.match(src, /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.sv-task-avatar \.ta-sprite[^}]*animation: none/,
    'reduced motion stops the sprite too');
  assert.match(src, /\.sv-task-avatar-interrupted \.ta-sprite[^{]*\{ animation: none; \}/,
    'an interrupted task stops moving, sprite included');
});

test('the halo is a dual drop-shadow in the harness accent that scales with the badge', () => {
  const src = injectedStyle();
  assert.match(src, /filter: drop-shadow\(0 calc\(var\(--sv-ta-size, 22px\) \* 0\.05\) calc\(var\(--sv-ta-size, 22px\) \* 0\.13\) var\(--sv-ta-cast\)\) drop-shadow\(0 0 calc\(var\(--sv-ta-size, 22px\) \* 0\.2\) var\(--sv-ta-halo\)\)/,
    'an offset dark shadow for depth plus a zero-offset halo, both scaled by the badge size');
  assert.match(src, /--sv-ta-halo: color-mix\(in srgb, var\(--sv-bot-accent, #5eadb8\) var\(--sv-ta-mix\), transparent\)/,
    'the halo is the harness accent and no other colour');
  assert.match(src, /\[data-theme="light"\] \.sv-task-avatar \{ --sv-ta-mix: 46%/,
    'light backgrounds swallow a faint glow, so the light theme mixes stronger');
  const out = loadTaskAvatar().html({ id: 'task-1', harness: 'codex', state: 'active', size: 18 });
  assert.match(out, /--sv-ta-size:18px/, 'the badge size reaches the filter as a length');
});

test('only live work looks lit: the quiet states drop or damp the halo', () => {
  const src = injectedStyle();
  assert.match(src, /\.sv-task-avatar-blocked, \.sv-task-avatar-failed, \.sv-task-avatar-completed \{ --sv-ta-halo: transparent; \}/,
    'blocked, failed and completed keep depth but stop glowing');
  assert.match(src, /\.sv-task-avatar-interrupted \{ --sv-ta-mix: 18%; \}/,
    'interrupted keeps a trace of halo so a dormant badge is still findable on the dark rail');
  assert.ok(!/\.sv-task-avatar-active \{ --sv-ta-halo: transparent/.test(src),
    'active must stay lit');
});

test('the 3D badge does not inherit the flat badge fade that made interrupted illegible', () => {
  const src = injectedStyle();
  assert.match(src, /\.sv-task-avatar-interrupted \{ opacity: \.55; \}/,
    'the flat fallback keeps its fade');
  assert.match(src, /\[data-sv-ta-atlas="ready"\] \.sv-task-avatar-sprite\.sv-task-avatar-interrupted \{ opacity: 1; \}/,
    'but a shaded 3D render is never faded on the near-black rail: dormancy is baked into the cell');
});

test('the render script is re-runnable, offline, and checkable', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'scripts', 'render_task_avatar_atlas.py'), 'utf8');
  assert.match(script, /HOW TO RE-RUN/, 'the script documents how to re-run it at the top');
  assert.match(script, /python3 scripts\/render_task_avatar_atlas\.py --check/,
    'and documents the check mode');
  assert.match(script, /"--check", action="store_true"/, 'the check mode exists');
  assert.match(script, /js\/vendor\/three\.module\.min\.js|THREE_JS = WEB/,
    'it renders with the vendored three.js, nothing fetched');
  assert.ok(!/pip install|npm install/.test(script), 'no new dependency may be introduced');
});

test('a task that is not running closes its eyes, and an unhappy one does not', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'scripts', 'render_task_avatar_atlas.py'), 'utf8');
  // Split applyState's chain into one block per state: simpler and far less
  // brittle than one regexp per branch.
  const blocks = {};
  script.split(/if \(state === '/).slice(1).forEach((chunk) => {
    const name = chunk.slice(0, chunk.indexOf("'"));
    blocks[name] = chunk.split('} else if (state === ')[0];
  });
  const state = (name) => {
    assert.ok(blocks[name], `the render script must handle the ${name} state`);
    return blocks[name];
  };
  // shut: a lid bar the full width of the open eye, or a content arc. Never a
  // shrunken pill, which reads as a small OPEN eye.
  assert.match(state('interrupted'), /lid\.visible = true/, 'interrupted shuts its eyes with lids');
  assert.match(state('interrupted'), /pill\.visible = false/, 'and the open pill is gone');
  assert.match(state('completed'), /arc\.visible = true/, 'completed shuts its eyes into arcs');
  assert.match(state('completed'), /pill\.visible = false/, 'and the open pill is gone');
  // The lid's proportions, measured rather than pattern-matched. A closed eye
  // that spans the full open width reads as a stretched smear; a dot reads as
  // a small OPEN eye. It has to sit between the two, and it has to curve.
  const num = (re, what) => {
    const m = re.exec(script);
    assert.ok(m, `could not read ${what} out of the render script`);
    return Number(m[1]);
  };
  const eyeR = num(/const EYE_R = ([\d.]+)/, 'the open eye radius');
  const lidChord = num(/const LID_CHORD = ([\d.]+)/, 'the lid chord');
  const lidArc = num(/LID_ARC = ([\d.]+)/, 'the lid arc');
  const lidTube = num(/const lidGeo = new THREE\.TorusGeometry\(LID_R, ([\d.]+)/, 'the lid thickness');
  const openWidth = eyeR * 2;
  assert.ok(lidChord < openWidth * 0.92,
    `the lid must be narrower than the open eye (${lidChord} vs ${openWidth})`);
  assert.ok(lidChord > openWidth * 0.55,
    `but not a dot (${lidChord} vs ${openWidth})`);
  assert.ok(lidTube * 2 >= 0.07, `the lid needs real thickness, got ${lidTube * 2}`);
  assert.ok(lidArc > 0.5, `the lid must curve, not be a straight bar (arc ${lidArc})`);
  assert.match(script, /lidGeo\.rotateZ\(-Math\.PI \/ 2 - LID_ARC \/ 2\)/,
    'and the curve must sag downward, the opposite bow to the completed arc');
  const arcR = num(/const arcGeo = new THREE\.TorusGeometry\(([\d.]+)/, 'the completed arc radius');
  assert.ok(arcR * 2 <= openWidth * 1.05,
    `the completed arc must not be stretched wider than the open eye (${arcR * 2} vs ${openWidth})`);
  // awake: blocked and failed must keep the open pill, whatever else they do
  for (const name of ['blocked', 'failed']) {
    const body = state(name);
    assert.ok(!/lid\.visible = true/.test(body), `${name} must not read as asleep`);
    assert.ok(!/pill\.visible = false/.test(body), `${name} keeps its eyes open`);
  }
  // and they are separated by opposite whole-head moves, not eye angle alone
  assert.match(state('blocked'), /body\.rotation\.x = 0\.\d+/, 'blocked leans in');
  assert.match(state('failed'), /headGroup\.rotation\.x = 0\.\d+/, 'failed drops its head');
});

test('the model is the reference ovoid, not a ball', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'scripts', 'render_task_avatar_atlas.py'), 'utf8');
  assert.match(script, /function ovoid\(rx, ry, rz, taper\)/,
    'the head is a tapered ovoid built from a sphere, not a sphere');
  const head = /const HEAD_X = ([\d.]+), HEAD_Y = ([\d.]+)/.exec(script);
  assert.ok(head, 'the head half-extents must be named');
  assert.ok(Number(head[1]) > Number(head[2]) * 1.2,
    `the head must be clearly wider than tall (got ${head[1]} x ${head[2]})`);
  const visor = /const VIS_X = HEAD_X \* ([\d.]+)/.exec(script);
  assert.ok(visor && Number(visor[1]) > 0.55,
    'the visor must dominate the face, not sit on it as a small panel');
  const att = /const BASE_YAW = (-?[\d.]+), BASE_ROLL = (-?[\d.]+), BASE_PITCH = (-?[\d.]+)/.exec(script);
  assert.ok(att, 'the base attitude must be named');
  assert.strictEqual(Number(att[1]), 0, 'the badge faces straight on: no yaw');
  assert.strictEqual(Number(att[2]), 0, 'and is level: no roll, so both pods sit equal');
  assert.ok(Math.abs(Number(att[3])) <= 0.06,
    `at most a hair of pitch to keep the ovoid from reading flat (got ${att[3]})`);
  // the poses that CARRY meaning are not part of that: they stay
  assert.match(script, /state === 'blocked'\)[\s\S]*?body\.rotation\.x = 0\.\d+/,
    'blocked still leans in');
  assert.match(script, /state === 'failed'\)[\s\S]*?headGroup\.rotation\.x = 0\.\d+/,
    'failed still drops its head');
});

// ---------------------------------------------------------------------------
// The rotation sheet. Only the active badge moves, it is a second lazily
// fetched atlas, and the frames are stepped by CSS with no script loop.
// ---------------------------------------------------------------------------

const SPIN_REL = 'images/task-avatar-spin.png';

test('only the active badge spins, and only for a harness with a baked row', () => {
  const TaskAvatar = loadTaskAvatar();
  assert.strictEqual(TaskAvatar.SPIN_STATE, 'active');
  for (const harness of Object.keys(TaskAvatar.HARNESS_COLORS)) {
    const spin = TaskAvatar.spinCell(harness, 'active');
    assert.ok(spin, `${harness} must have a rotation row`);
    assert.strictEqual(spin.row, TaskAvatar.atlasCell(harness, 'active').row,
      'the rotation sheet uses the same row order as the static sheet');
    for (const state of TaskAvatar.STATES.filter(s => s !== 'active')) {
      assert.strictEqual(TaskAvatar.spinCell(harness, state), null,
        `${state} must hold still: stillness is the signal that nothing is happening`);
    }
  }
  assert.strictEqual(TaskAvatar.spinCell('not-a-harness', 'active'), null,
    'an unknown harness has no baked row and so never spins');
});

test('html() marks the spinning badge, carries its row, and leaves the others alone', () => {
  const TaskAvatar = loadTaskAvatar();
  const active = TaskAvatar.html({ id: 't', harness: 'codex', state: 'active' });
  const classes = /class="([^"]*)"/.exec(active)[1].split(/\s+/);
  assert.ok(classes.includes('sv-task-avatar-spin'), 'an active badge is marked as spinning');
  assert.match(active, /<i class="ta-spin" aria-hidden="true" style="--ta-row:1"><i><\/i><\/i>/,
    'and carries a rotation layer pointed at its own row');
  assert.ok(active.indexOf('ta-sprite') < active.indexOf('ta-spin'),
    'the static cell paints underneath, so there is no empty frame while the sheet loads');
  for (const state of ['approval', 'blocked', 'completed', 'interrupted', 'failed']) {
    const out = TaskAvatar.html({ id: 't', harness: 'codex', state });
    assert.ok(!out.includes('ta-spin'), `${state} must not carry a rotation layer`);
    assert.ok(!out.includes('sv-task-avatar-spin'), `${state} must not be marked as spinning`);
  }
  assert.ok(!TaskAvatar.html({ id: 't', harness: 'nope', state: 'active' }).includes('ta-spin'),
    'an unknown harness stays on the flat SVG with no rotation');
});

test('the rotation sheet is fetched lazily, only when an active badge is drawn', () => {
  const src = read('js/components/task-avatar.js');
  const mk = () => ({ style: {}, set innerHTML(v) { this.firstElementChild = { id: /id="([^"]+)"/.exec(v)?.[1] }; },
    get textContent() { return this._t; }, set textContent(v) { this._t = v; } });
  const run = (state) => {
    const loaded = [];
    const sandbox = { window: {}, document: {
      getElementById: () => null, createElement: () => mk(),
      head: { appendChild() {} }, body: { appendChild() {} },
      documentElement: { setAttribute() {} },
    }, Image: function () { const self = this; Object.defineProperty(this, 'src', { set(v) { loaded.push(v); } }); return self; } };
    vm.runInNewContext(src, sandbox);
    sandbox.window.TaskAvatar.html({ id: 't', harness: 'codex', state });
    return loaded;
  };
  const idle = run('interrupted');
  assert.ok(idle.some(u => u.includes('task-avatar-atlas.png')), 'the static atlas is always fetched');
  assert.ok(!idle.some(u => u.includes('task-avatar-spin.png')),
    'a page with no running task must never download the rotation sheet');
  const busy = run('active');
  assert.ok(busy.some(u => u.includes('task-avatar-spin.png')),
    'an active badge does fetch it');
  assert.match(src, /_ensureSpin\(\)[\s\S]*?if \(this\._spinPending\) return;/,
    'and it is fetched at most once per document');
});

test('the frames are stepped by CSS, staggered per task, and frozen for reduced motion', () => {
  const TaskAvatar = loadTaskAvatar();
  const css = injectedStyle();
  const n = TaskAvatar.SPIN_FRAMES;
  // The defect this guards: frames alone say nothing. 13 frames over 5.2s is
  // 2.5fps and reads as stepping however small each step is. Perceptually
  // continuous motion needs roughly 12fps, so the RATE is what gets asserted.
  const seconds = Number(/^([\d.]+)s$/.exec(TaskAvatar.SPIN_DURATION)[1]);
  const fps = n / seconds;
  assert.ok(fps >= 12,
    `the rotation must run at 12fps or better to read as motion, got ${n} frames over ${seconds}s = ${fps.toFixed(1)}fps`);
  // and the cycle itself must stay unhurried. Both owner complaints, "not
  // smooth" and "too fast", were the same low-rate snap; the fix is frames,
  // never a shorter loop or a smaller sweep.
  assert.ok(seconds >= 3,
    `the turn must be slow, not merely smooth, got a ${seconds}s cycle`);
  assert.ok(seconds <= 6, `but still a loop, not a drift, got ${seconds}s`);
  assert.ok(css.includes(`background-size: ${n * 100}% ${TaskAvatar.SPIN_ROWS * 100}%`),
    'the sheet is scaled so one frame fills the badge');
  assert.ok(css.includes(`animation: sv-ta-spin ${TaskAvatar.SPIN_DURATION} steps(${n}, end) var(--sv-bot-delay, 0s) infinite`),
    'playback is CSS steps(), staggered by the same per-id delay the bob uses');
  // steps(N, end) over [0, N/(N-1)] must land exactly on k/(N-1), k = 0..N-1
  const end = Number(/background-position-x: ([\d.]+)%; \} \}/.exec(
    /@keyframes sv-ta-spin \{[\s\S]*?\}\s*\}/.exec(css)[0])[1]);
  assert.ok(Math.abs(end - (n / (n - 1)) * 100) < 0.001,
    `the keyframe end must be N/(N-1) of the sheet, got ${end}%`);
  for (let k = 0; k < n; k++) {
    const landed = (Math.floor((k / n) * n) / n) * end;
    assert.ok(Math.abs(landed - (k / (n - 1)) * 100) < 0.001,
      `step ${k} must land exactly on frame ${k}`);
  }
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.sv-task-avatar \.ta-spin > i[^}]*animation: none/,
    'reduced motion stops the frame stepping');
  assert.match(css, /\.sv-task-avatar \.ta-spin > i \{[^}]*background-position-x: 0%/,
    'so it freezes on frame 0 rather than sticking mid-turn');
  assert.ok(!/(requestAnimationFrame|setInterval|setTimeout)\s*\(/.test(read('js/components/task-avatar.js')),
    'no script loop may drive the rotation');
});

test('the rotation sheet ships on disk, seamless, and inside its own budget', () => {
  const TaskAvatar = loadTaskAvatar();
  const file = path.join(WEB, SPIN_REL);
  assert.ok(fs.existsSync(file), 'the baked rotation sheet must be committed');
  const buf = fs.readFileSync(file);
  const { width, height } = pngSize(buf);
  assert.strictEqual(width, TaskAvatar.SPIN_FRAMES * TaskAvatar.SPIN_CELL_W,
    'one 88px column per frame (2x the largest use)');
  assert.strictEqual(height, TaskAvatar.SPIN_ROWS * TaskAvatar.SPIN_CELL_H,
    'one row per harness, per theme');
  // The rotation sheet trades resolution for frames, but never so far that a
  // cell has to be UPSCALED at the largest size the badge is drawn.
  const drawnAt44 = 44 * TaskAvatar.SPRITE_SCALE;
  assert.ok(TaskAvatar.SPIN_CELL_W >= drawnAt44,
    `the rotation cell (${TaskAvatar.SPIN_CELL_W}px) must not be upscaled at the largest draw (${drawnAt44.toFixed(1)}px)`);
  assert.ok(TaskAvatar.SPIN_CELL_W < TaskAvatar.ATLAS_CELL_W,
    'and it is allowed to be smaller than the static cell, which is what pays for the frames');
  // both sheets must share one aspect or the two layers would not line up
  assert.ok(Math.abs((TaskAvatar.ATLAS_CELL_W / TaskAvatar.ATLAS_CELL_H)
    - (TaskAvatar.SPIN_CELL_W / TaskAvatar.SPIN_CELL_H)) < 1e-9,
    'the static and rotation cells must have exactly the same aspect');
  // A larger ceiling than the static sheet, and only because this one is
  // fetched lazily: a page with no running task never pays for it.
  assert.ok(buf.length <= 700 * 1024,
    `rotation sheet is ${buf.length} bytes, budget is ${700 * 1024}`);
  const staticBytes = fs.readFileSync(path.join(WEB, ATLAS_REL)).length;
  assert.ok(staticBytes <= 400 * 1024,
    `the always-fetched static sheet keeps the tighter budget, got ${staticBytes}`);
  assert.ok(buf.length > staticBytes,
    'and the frames are what the extra ceiling was spent on');
  assert.ok(TaskAvatar.SPIN_SRC.startsWith(`/${SPIN_REL}?v=`), 'it carries its own cache pin');
  const script = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'scripts', 'render_task_avatar_atlas.py'), 'utf8');
  // seamless by construction: every term is a sine of an integer multiple of
  // the loop, so t = 1 lands exactly on t = 0
  assert.match(script, /function applySpin\(t\) \{[\s\S]*?Math\.PI \* 2 \* t/,
    'the phase must run over a whole number of periods');
  assert.match(script, /raw = render\(accent, shell_hex, quiet, SPIN_STATE, f \/ SPIN_FRAMES\)/,
    'frames walk f / N, so the last is one step short of the wrap');
  // and measured: the wrap step must sit inside the spread of the inner steps
  assert.match(script, /def seam_report\(/, 'the render script measures the wrap step');
  assert.match(script, /"seamless": bool\(worst_wrap <= worst_inner \* 1\.25\)/,
    'and fails the build when the wrap costs more than an ordinary step');
});

test('the shell is tinted per harness, derived from the accent and never overriding it', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'scripts', 'render_task_avatar_atlas.py'), 'utf8');
  assert.match(script, /def _shell_tint\(accent: int \| None, theme_index: int\) -> int:/,
    'the shell tint must be derived, not a second hard-coded table');
  assert.match(script, /full = _blend\(neutral, accent, target\)/,
    'it is the neutral shell pulled toward the existing accent');
  assert.match(script, /target, floor = SHELL_TINT\[theme_index\], SHELL_MIN_LUM\[theme_index\]/,
    'at this theme\'s strength and floor');
  assert.match(script, /if accent is None:\n {8}return neutral/,
    'and the neutral case still has to work');
  const mix = /SHELL_TINT = \(([\d.]+), ([\d.]+)\)/.exec(script);
  assert.ok(mix, 'the tint strength must be named');
  for (const v of [Number(mix[1]), Number(mix[2])]) {
    assert.ok(v >= 0.55, `the bot must read as BEING its harness colour, not tinted (got ${v})`);
    assert.ok(v <= 0.85, `but not a flat repaint of the accent: the shell is still shaded (got ${v})`);
  }
  // a dark accent taken to full strength would stop separating from the
  // near-black visor, so the tint is floored by luminance, per theme
  const floor = /SHELL_MIN_LUM = \(([\d.]+), ([\d.]+)\)/.exec(script);
  assert.ok(floor, 'the tint must be floored by luminance, not left to go dark');
  assert.match(script, /def _srgb_lum\(rgb: int\) -> float:/, 'and the floor is a real luminance');
  assert.match(script, /if _srgb_lum\(full\) >= floor:\n {8}return full/,
    'full strength is used whenever it clears the floor');
  assert.match(script, /lo, hi = 0\.0, target\n {4}for _ in range\(24\):/,
    'and a clamped harness is bisected back, keeping its hue and losing only saturation');
  assert.match(script, /def shell_report\(/,
    'the script must be able to report what every harness actually got');
  const TaskAvatar = loadTaskAvatar();
  // spread into this realm: the component is loaded in a vm sandbox, so the
  // object's prototype is not the one deepStrictEqual would compare against
  assert.deepStrictEqual({ ...TaskAvatar.HARNESS_COLORS }, {
    // claude-code is Claude Code's own brand terracotta. opencode was pushed
    // deeper and more saturated when that landed: the two were neighbouring
    // warm oranges and collapsed to 6.63 RMS apart at 18px, worse than any
    // pair had ever been. Same orange family, 20.15 apart now.
    'claude-code': '#d97757', codex: '#3b7ddd', 'copilot-cli': '#b8478f',
    opencode: '#1bc548', openclaw: '#2f8f9d', cursor: '#6b8f2a',
  }, 'the harness colours themselves must not drift');
  // the guard that would have caught that collision before it shipped
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const names = Object.keys(TaskAvatar.HARNESS_COLORS);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = rgb(TaskAvatar.HARNESS_COLORS[names[i]]);
      const b = rgb(TaskAvatar.HARNESS_COLORS[names[j]]);
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      assert.ok(dist >= 60,
        `${names[i]} and ${names[j]} are only ${dist.toFixed(1)} apart in sRGB; `
        + 'neighbouring harness colours are unreadable at 18px');
    }
  }
  // and the per-id hash palette is a SEPARATE list: it may still hold a colour
  // no harness uses, and changing a harness must not silently change it
  assert.ok(TaskAvatar.PALETTE.includes('#7b61ff'),
    'the hash palette keeps its own entries, independent of HARNESS_COLORS');
});

test('both sprite layers share one box, cut to the cell aspect so nothing is stretched', () => {
  const TaskAvatar = loadTaskAvatar();
  const css = injectedStyle();
  const boxes = [...css.matchAll(/\.sv-task-avatar \.(ta-sprite|ta-spin) \{ display: none; position: absolute; left: (-?[\d.]+)%; width: ([\d.]+)%; top: 50%; margin-top: (-[\d.]+)%; height: ([\d.]+)%;/g)];
  assert.strictEqual(boxes.length, 2, 'the static and rotation layers must both be boxed');
  const aspect = TaskAvatar.ATLAS_CELL_W / TaskAvatar.ATLAS_CELL_H;
  for (const [, name, left, width, marginTop, height] of boxes) {
    const w = Number(width), h = Number(height);
    assert.ok(Math.abs(w / h - aspect) < 1e-3,
      `${name} must match the cell aspect or the figure is stretched (got ${(w / h).toFixed(4)}, want ${aspect.toFixed(4)})`);
    assert.ok(Math.abs(Number(left) - (100 - w) / 2) < 1e-3, `${name} must stay horizontally centred`);
    assert.ok(Math.abs(Number(marginTop) + h / 2) < 1e-3, `${name} must stay vertically centred`);
    assert.ok(Math.abs(w - TaskAvatar.SPRITE_SCALE * 100) < 1e-3,
      `${name} must be drawn at SPRITE_SCALE`);
  }
  assert.ok(TaskAvatar.SPRITE_SCALE >= 1,
    'the figure is drawn at least as large as its layout box, never smaller');
  assert.ok(TaskAvatar.SPRITE_SCALE <= 1.3,
    'but not so far past it that a rail row collides with its neighbour');
  // The overflow must stay HORIZONTAL only. Rail rows stack vertically with
  // little gap, so a sprite taller than its badge box would run into the row
  // above and below; sideways it only ever meets its own label, which sits
  // behind a flex gap. Measured in the app at 1.3: the drawn sprite is 90.6%
  // of the badge's height and clears the label by 5.3px at 18px, 3.4px at
  // 44px and 2.7px at 22px.
  const drawnHeightPct = TaskAvatar.SPRITE_SCALE * 100 * TaskAvatar.ATLAS_CELL_H / TaskAvatar.ATLAS_CELL_W;
  assert.ok(drawnHeightPct <= 100,
    `the sprite must never be taller than its badge box (got ${drawnHeightPct.toFixed(1)}%)`);
});

test('the render script fits the camera against the widest rotation frame', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'scripts', 'render_task_avatar_atlas.py'), 'utf8');
  assert.match(script, /^CAMERA_DIST = [\d.]+/m, 'the camera distance must be a named constant');
  assert.match(script, /_assert_no_clipping\(out, cols, rows, cw=SPIN_CELL, ch=SPIN_CELL_H\)/,
    'every rotation frame is checked for clipping, not just the rest pose');
  assert.match(script, /def _assert_no_clipping\([\s\S]*?raise SystemExit\(/,
    'and a clipped cell fails the render rather than shipping cropped');
});
