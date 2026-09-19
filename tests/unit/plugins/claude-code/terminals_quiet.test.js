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
  assert.match(css, /\.terminals-page \.terminals-task \{ display: block/,
    'all tasks shows cards, so a task is a block and not a flex line');
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
  assert.match(html, /terminals\.js\?v=48/);
  assert.match(html, /styles\.css\?v=426/);
});

test('with nothing attached the board is the whole page', () => {
  assert.match(css, /\.terminals-page:not\(\.is-focused\) \{ grid-template-rows: minmax\(0, 1fr\); \}/,
    'the board takes the page when no task is attached');
  assert.match(css, /\.terminals-page:not\(\.is-focused\) \.terminals-workspace \{ display: none; \}/,
    'an empty stage and a governance panel with no task say nothing worth the room');
  assert.match(css, /\.terminals-page \.terminals-task-list \{ flex: 1 1 auto; min-height: 0; overflow-y: auto; \}/,
    'the list owns the scroll; the section around it clips');
  assert.match(css, /\.terminals-page \.terminals-tasks \{ display: flex; flex-direction: column; min-height: 0; \}/,
    'and the section has to let it shrink, or the scroll never engages');
});

test('all tasks is a wrapping board of cards', () => {
  assert.match(css, /\.terminals-page \.terminals-group \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(282px, 1fr\)\)/,
    'the group lays its tasks out as a card grid');
  assert.match(css, /\.terminals-page \.terminals-task \{[^\n]*border-radius: 8px/,
    'a card has its own frame');
  assert.match(css, /\.terminals-page \.terminals-task-select \{ display: flex; flex-direction: column/,
    'the card stacks its bot, title, harness and clock');
});

test('the tab strip styles the controls a lone pane hands up to it', () => {
  assert.match(css, /\.terminals-head-pane-gov \{/);
  assert.match(css, /\.terminals-head-pane-gov:empty \{ display: none; \}/,
    'no chip yet must not leave a gap in the strip');
  assert.match(css, /\.terminals-head-pane-acts \{/);
});

test('the board is a dashboard of tasks, and only the gap gets colour', () => {
  assert.match(page, /_guardState\(t\) \{/,
    'a card has to answer whether the task is being checked');
  assert.match(page, /terminals-task-guard terminals-guard-\$\{guard\.kind\}/,
    'and carry that state on the card itself, not only in the attached view');
  assert.match(page, /terminals-task-doing/,
    'and say what the agent is doing now, so a board of five needs no clicks');
  assert.match(page, /_renderBoardSummary\(shown\)/,
    'one line of state over the whole board');
  assert.match(page, /cell\(ungoverned, 'not governed', 'is-amber'/,
    'the summary counts the tasks nobody is watching');

  assert.match(css, /\.terminals-guard-ungoverned \{ border-color: rgba\(245, 158, 11/,
    'a governance gap is amber');
  assert.doesNotMatch(css, /\.terminals-guard-governed \{/,
    'governed is the quiet default and must not spend the accent on good news');
});
