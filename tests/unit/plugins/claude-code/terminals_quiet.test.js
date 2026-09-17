/** The Terminals page reads as one quiet workspace: slim toolbar, compact
 * task rows, hairline frames, no hero copy competing with the terminal. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(
  __dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web', 'js', 'pages', 'terminals.js'
), 'utf8');
const css = fs.readFileSync(path.join(
  __dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web', 'css', 'styles.css'
), 'utf8');
const railCss = css;
const html = fs.readFileSync(path.join(
  __dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web', 'index.html'
), 'utf8');

test('the tasks head drops the hero copy and keeps only the toolbar actions', () => {
  assert.doesNotMatch(page, /terminals-eyebrow/,
    'the eyebrow span must be gone');
  assert.doesNotMatch(page, /<h2>Agent Tasks<\/h2>/,
    'the hero heading must be gone');
  assert.doesNotMatch(page, /Every harness call is checked, recorded, and ready for approval/,
    'the hero blurb must be gone');
  assert.match(page, /terminals-task-search/,
    'the search input stays in the slim head');
  assert.match(page, /terminals-launch-btn/,
    'the launch button stays in the slim head');
});

test('task rows are compact one-line entries with a sub label and elapsed time', () => {
  assert.match(page, /terminals-task-sub/,
    'each row must render a muted harness / state sub line');
  assert.match(page, /terminals-task-when/,
    'each row must render a muted elapsed-time span');
  assert.doesNotMatch(page, /Open task/,
    'the "Open task ->" text must be dropped; the whole row is the button');
  assert.match(page, /is-attached/,
    'the attached row state marker stays');
});

test('folder grouping hides its heading when there is only one group', () => {
  assert.match(page, /isSingleGroup \? ' is-single' : ''/,
    'single-folder boards must mark the group so its heading can be hidden');
});

test('the empty stage keeps the heading and blurb without the SV mark tile', () => {
  assert.doesNotMatch(page, /terminals-stage-mark/,
    'the SV mark tile markup must be dropped from the empty stage');
  assert.match(page, /Your governed agent workspace/);
});

test('styles carry the quiet-workspace frame and rail tightening rules', () => {
  assert.match(css, /\.terminals-page \.terminals-task \{ display: flex/,
    'task rows must be flattened to a single flex line');
  assert.match(css, /\.terminals-page \.terminals-centre \{ border: 1px solid var\(--border-default/,
    'the centre surface keeps a hairline frame with no shadow');
  assert.match(css, /\.terminals-page \.terminals-tasks,[^\n]*box-shadow: none/,
    'the quiet-workspace rules must drop card shadows');
  assert.match(railCss, /\.nav-views\.nav-views-tasks \.nav-item\.nav-view \{ padding: 4px 14px 4px 22px/,
    'the rail task rows must be tightened');
  assert.match(railCss, /\.nav-views\.nav-views-tasks \.nav-tasks-group \{/,
    'the rail group label must be quieted');
});

test('pins are bumped for the touched assets', () => {
  assert.match(html, /terminals\.js\?v=20/);
  assert.match(html, /styles\.css\?v=396/);
});

test('the compact task list scrolls inside itself instead of pushing the terminal off screen', () => {
  assert.match(css, /\.terminals-page \.terminals-task-list \{ max-height: 38vh; overflow-y: auto; \}/);
});
