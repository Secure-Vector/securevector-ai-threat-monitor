'use strict';

// Cost / Token Optimizer UI (v5.2.0, #202) — source-text assertions, same
// technique as agent_runs_page.test.js: the pages/ render code runs inside
// pywebview and isn't easily unit-testable, so these guard the wiring and the
// copy contracts (estimate labelling, privacy, consent) at the source level.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

test('costs declares the Optimizer tab in the Overview · Optimizer · History order', () => {
  const src = read('js/pages/costs.js');
  const m = src.match(/_TABS:\s*\[([\s\S]*?)\],\n\n/);
  assert.ok(m, 'could not locate CostsPage._TABS');
  const ids = [...m[1].matchAll(/id:\s*'([a-z]+)'/g)].map(x => x[1]);
  assert.deepEqual(ids, ['overview', 'optimizer', 'history']);
  assert.match(src, /_loadAndRenderOptimizer\(/);
  assert.match(src, /sv-tab-seen-costs-/);
});

test('optimizer scan is consent-gated and states the privacy contract', () => {
  const src = read('js/pages/costs.js');
  assert.match(src, /consent: true/);
  assert.match(src, /Nothing is uploaded/);
  assert.match(src, /no prompt text, no tool arguments/);
});

test('the comparison strip is labelled a modeled estimate and never claims an invoice', () => {
  const src = read('js/pages/costs.js');
  assert.match(src, /modeled estimate/);
  assert.match(src, /not an invoice/i);
  assert.match(src, /Nothing here claims your invoice will change/);
});

test('share card exports aggregate numbers with the label baked in, no session content', () => {
  const src = read('js/pages/costs.js');
  assert.match(src, /_optShareCard/);
  assert.match(src, /MODELED ESTIMATE · LIST-PRICE TOKENS, NOT AN INVOICE/);
  assert.match(src, /MEASURED · LIKE-FOR-LIKE WINDOWS/);
  // the canvas draw path must never touch session identifiers or evidence text
  const draw = src.slice(src.indexOf('async _optShareCard'), src.indexOf('_esc(s)'));
  assert.doesNotMatch(draw, /session_id|evidence|input_hash|observed\)/);
  assert.match(draw, /toBlob/);
  assert.match(draw, /ClipboardItem/);
});

test('findings deep-link into Traces and disclose the 1500-run view cap', () => {
  const src = read('js/pages/costs.js');
  assert.match(src, /AgentRunsPage\._pendingTrace/);
  assert.match(src, /AgentRunsPage\._pendingGenRid/);
  assert.match(src, /1500-run view/);
});

test('recommendations are offered, not imposed, and reversible in Cost Settings', () => {
  const src = read('js/pages/costs.js');
  assert.match(src, /Want recommendations on how to fix these\?/);
  assert.match(src, /recommend_enabled/);
  assert.match(src, /_renderOptimizerPrefsCard/);
});

test('traces waterfall annotates optimizer turns and consumes the gen jump', () => {
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /_annotateOptimizer\(/);
  assert.match(src, /_consumePendingGenJump\(/);
  assert.match(src, /cost-optimizer\/report/);
});

test('spotlight is one-time, native, upgrade-only, and wired into index + app', () => {
  const src = read('js/components/optimizer-spotlight.js');
  assert.match(src, /sv-optimizer-spotlight-acked/);
  assert.match(src, /sv-welcome-seen-v2/);
  assert.match(src, /Illustrative example, not your data/);
  assert.doesNotMatch(src, /<img|src="[^"]*\.png/i); // native DOM, no bundled image assets
  const idx = read('index.html');
  assert.match(idx, /optimizer-spotlight\.js/);
  const app = read('js/app.js');
  assert.match(app, /OptimizerSpotlight\.maybeShow\(\)/);
});

test('what\'s-new banner is bumped to 5.2.0 and lands on the Optimizer', () => {
  const src = read('js/components/global-banners.js');
  assert.match(src, /WHATS_NEW_VERSION: '5\.2\.0'/);
  assert.match(src, /Cost \/ Token Optimizer/);
  assert.match(src, /_pendingTab = 'optimizer'/);
});

test('tour includes an Optimizer step targeting Cost & Tokens', () => {
  const src = read('js/components/tour.js');
  assert.match(src, /nav: 'costs', go: 'costs', expand: 'agent-activity', sub: true/);
  assert.match(src, /Cost \/ Token Optimizer/);
});

test('API client exposes the optimizer endpoints with degrading reads', () => {
  const src = read('js/api.js');
  assert.match(src, /getOptimizerStatus/);
  assert.match(src, /getOptimizerReport/);
  assert.match(src, /runOptimizer/);
  assert.match(src, /setOptimizerPrefs/);
  assert.match(src, /deleteOptimizerReport/);
});

test('optimizer UI is theme-aware and emoji-free', () => {
  const src = read('js/pages/costs.js');
  const opt = src.slice(src.indexOf('= Cost / Token Optimizer tab'));
  assert.match(opt, /var\(--bg-card/);
  assert.doesNotMatch(opt, /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  const spot = read('js/components/optimizer-spotlight.js');
  assert.doesNotMatch(spot, /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
});

test('no finding surfaces on the dashboard', () => {
  const dash = read('js/pages/dashboard.js');
  assert.doesNotMatch(dash, /cost-optimizer|Optimizer finding/);
});

test('optimizer is the landing tab; order stays Overview-Optimizer-History', () => {
  const app = read('js/app.js');
  assert.match(app, /costs:\s*\{ render: \(c\) => \{ CostsPage\.mode = 'monitor';\s*CostsPage\.activeTab = 'optimizer'/);
});

test('dashboard carries the optimizer tile, outside the hero strip', () => {
  const dash = read('js/pages/dashboard.js');
  assert.match(dash, /_renderOptimizerTile/);
  assert.match(dash, /never\s+in the hero strip/);
  assert.match(dash, /modeled estimate/i);
});

test('findings digest: by-type filter chips over the ranked list', () => {
  const src = read('js/pages/costs.js');
  assert.match(src, /svo-typebar/);
  assert.match(src, /_optTypeFilter/);
});

test('guardian bot: generic assistant only — absent from optimizer surfaces', () => {
  const bot = read('js/components/guardian-bot.js');
  assert.match(bot, /prefers-reduced-motion: no-preference/);
  assert.match(bot, /GuardianBot/);
  assert.doesNotMatch(bot, /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  const idx = read('index.html');
  assert.match(idx, /guardian-bot\.js/);
  // the bot is the app-wide Guardian: it lives in the floating assistant and
  // nowhere inside the Cost/Token Optimizer's own surfaces
  assert.match(read('js/components/guardian-assistant.js'), /GuardianBot\.el/);
  assert.doesNotMatch(read('js/pages/costs.js'), /GuardianBot\.el/);
  assert.doesNotMatch(read('js/components/optimizer-spotlight.js'), /GuardianBot/);
  assert.doesNotMatch(read('js/pages/dashboard.js'), /GuardianBot\.el/);
});

test('guardian assistant replaces the chat: FAB, triage rows, no TryItChat', () => {
  const ga = read('js/components/guardian-assistant.js');
  assert.match(ga, /GuardianAssistant/);
  assert.match(ga, /Cost first\. Threats always\./);
  assert.match(ga, /Blocked permission checks/);
  const sidebar = read('js/components/sidebar.js');
  assert.doesNotMatch(sidebar, /TryItChat/);
  const css = read('css/styles.css');
  assert.doesNotMatch(css, /tryit-chat/);
  const app = read('js/app.js');
  assert.match(app, /GuardianAssistant\.mount\(\)/);
  const idx = read('index.html');
  assert.match(idx, /guardian-assistant\.js/);
});

test('cost summary redesign: hero strip, runtime card, fixed budget field', () => {
  const src = read('js/pages/costs.js');
  assert.match(src, /_renderRuntimeTokensCard/);
  assert.match(src, /Session Tokens by Runtime/);
  assert.match(src, /svc-strip/);
  // the budget bar must read the field the API actually returns
  assert.match(src, /budget\.daily_budget_usd/);
  assert.doesNotMatch(src, /budget\.budget_usd/);
  // the four stacked pre-tab panels are gone
  assert.doesNotMatch(src, /_renderCcCostGapNote/);
  // token formatter reaches billions (real cache-read totals get there)
  assert.match(src, /toFixed\(1\)\}B/);
});

test('receipts are proof cards: prediction vs measured vs quality, no faulty comparisons', () => {
  const src = read('js/pages/costs.js');
  assert.match(src, /frozen when the finding first appeared/);
  assert.match(src, /Output quality/);
  assert.match(src, /Medians across real same-harness sessions/);
  assert.match(src, /semantic quality is not judged and no model is involved/);
  // a comparison we will not show is always explained, never silently absent:
  // the backend words the refusal, the UI renders every pending reason verbatim
  assert.match(src, /reopened/);
  assert.match(src, /\$\{label\}: \$\{p\.reason\}/);
  const svc = fs.readFileSync(path.resolve(WEB, '..', '..', 'services', 'cost_optimizer.py'), 'utf8');
  assert.match(svc, /no comparison will be shown/);
  assert.match(svc, /below_noise/);
  assert.match(svc, /receipt_min_improvement/);
});
