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
  // follow-through lives in the "Fixes you copied" band, rendered with the
  // sessions it measures (the Before-vs-after card was removed in its favor)
  assert.match(src, /_optFixesSec\(/);
  assert.match(src, /Fixes you copied/);
  assert.doesNotMatch(src, /Before vs after your change/);
  const svc = fs.readFileSync(path.resolve(WEB, '..', '..', 'services', 'cost_optimizer.py'), 'utf8');
  assert.match(svc, /no comparison will be shown/);
  assert.match(svc, /below_noise/);
  assert.match(svc, /receipt_min_improvement/);
});

test('guardian 3d: vendored libs, CSP-safe module, assistant-only, SVG fallback', () => {
  const fs2 = require('node:fs');
  assert.ok(fs2.existsSync(path.join(WEB, 'js', 'vendor', 'three.module.min.js')));
  assert.ok(fs2.existsSync(path.join(WEB, 'js', 'vendor', 'gsap.min.js')));
  const g3d = read('js/components/guardian-3d.js');
  assert.match(g3d, /from '\/js\/vendor\/three\.module\.min\.js'/); // self-hosted, never CDN
  assert.match(g3d, /prefers-reduced-motion/);
  assert.doesNotMatch(g3d, /https?:\/\//); // no network fetches anywhere
  const ga = read('js/components/guardian-assistant.js');
  assert.match(ga, /Guardian3D\.available\(\)/);
  assert.match(ga, /if \(!this\._bot3d\) fab\.appendChild\(GuardianBot\.el/); // SVG fallback
  const idx = read('index.html');
  assert.match(idx, /type="module" src="\/js\/components\/guardian-3d\.js/);
  assert.match(idx, /js\/vendor\/gsap\.min\.js/);
});

// ---------------------------------------------------------------------------
// v5.2.x follow-ups: sessions-first optimizer + the Guardian sentinel
// ---------------------------------------------------------------------------

test('optimizer leads with sessions: live cards, collapsed recent rows', () => {
  const src = read('js/pages/costs.js');
  assert.match(src, /_optSessionsSec\(/);
  assert.match(src, /getOptimizerSessions/);
  assert.match(src, /svo-live-badge/);
  assert.match(src, /Why it cost what it did/);
  assert.match(src, /What to change/);
  // inactive sessions collapse to rows; findings wall collapses by default
  assert.match(src, /_optSessionRow\(/);
  assert.match(src, /_optFindingsOpen/);
  // live guidance names concrete lossless actions and never recommends
  // compaction (product stance: compaction drops context, so it is shown
  // as a mechanism, never as advice)
  assert.match(src, /continue in a fresh session/);
  assert.doesNotMatch(src, /run \/compact/);
});

test('copy-fix buttons fill the clipboard; nothing is sent to a session', () => {
  const src = fs.readFileSync(path.join(WEB, 'js/pages/costs.js'), 'utf8');
  // paste-ready snippets exist for the types where pasting helps
  assert.match(src, /_optFixSnippet\(/);
  assert.match(src, /Copy state note template/);
  assert.match(src, /Copy trim request/);
  assert.match(src, /Copy brevity request/);
  // the affordance is clipboard-only: no fetch/POST to any session, and the
  // title copy states the human pastes it themselves
  assert.match(src, /navigator\.clipboard\.writeText/);
  assert.match(src, /SecureVector never sends anything to a session/);
  assert.match(src, /svo-copyfix/);
});

test('playbook scorecard: industry practices scored on the user\'s own data', () => {
  const src = fs.readFileSync(path.join(WEB, 'js/pages/costs.js'), 'utf8');
  assert.match(src, /_optPlaybook\(/);
  assert.match(src, /Good practice, scored on your data/);
  // scored against findings, not quoted as generic advice
  assert.match(src, /checked against your own transcripts/);
  assert.match(src, /looks healthy/);
  assert.match(src, /seen here/);
  // batch endpoints are an API-billing practice only, and never claimed measurable
  assert.match(src, /mode === 'api'/);
  assert.match(src, /beyond local visibility/);
  // informative depth renders below the sessions section
  const view = src.slice(src.indexOf('_optReportView(host, rep, st) {'), src.indexOf('_optStrip(rep, mode) {'));
  assert.ok(view.indexOf('_optSessionsSec') < view.indexOf('_optTrimLedger'), 'trim ledger sits below sessions');
  assert.ok(view.indexOf('_optTrimLedger') < view.indexOf('_optPlaybook'), 'playbook sits below the trim ledger');
  assert.ok(view.indexOf('_optPlaybook') < view.indexOf('_optFindings'), 'findings wall stays last');
});

test('session activity endpoint exists and stays local + cheap', () => {
  const REPO = path.resolve(WEB, '..', '..', '..', '..', '..');
  const route = fs.readFileSync(
    path.join(REPO, 'src/securevector/app/server/routes/cost_optimizer.py'), 'utf8');
  assert.match(route, /cost-optimizer\/sessions/);
  const svc = fs.readFileSync(
    path.join(REPO, 'src/securevector/app/services/cost_optimizer.py'), 'utf8');
  assert.match(svc, /_tail_context_tokens/);
  assert.match(svc, /ACTIVE_SESSION_SECONDS/);
});

test('guardian sentinel: templated speech only, muteable, baselined', () => {
  const src = read('js/components/guardian-assistant.js');
  assert.match(src, /_sentinelTick/);
  assert.match(src, /sv-guardian-quiet/);
  assert.match(src, /baselined/);          // first tick observes, never speaks
  assert.match(src, /BUBBLE_COOLDOWN_MS/); // per-category cooldowns
  assert.match(src, /one at a time/);
  // recap speaks in tokens, never dollars
  assert.match(src, /tokens of context re-sent on every turn/);
  assert.doesNotMatch(src, /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  // no em dashes in bot copy (comments may use them; check template lines)
  const lines = src.split('\n').filter(l => /text:/.test(l));
  lines.forEach(l => assert.ok(!l.includes('—'), 'em dash in bot copy: ' + l));
});

test('guardian 3d adapts to theme and idles calmly', () => {
  const bot = read('js/components/guardian-3d.js');
  assert.match(bot, /SHELL_ON_LIGHT/);
  assert.match(bot, /data-theme/);
  assert.match(bot, /MutationObserver/);
  // "idles calmly" used to be asserted against a comment describing the
  // breathing tweens. Those are gone: idle is now procedural and decays to a
  // floor after a quiet spell, which is a stronger version of the same
  // promise. guardian_presence.test.js owns the detail.
  assert.match(bot, /const LIFE_FLOOR = /);
  assert.match(bot, /const settleCheck = \(\) => \{/);
});

test('request history empty state explains where plugin data lives', () => {
  const src = read('js/pages/costs.js');
  assert.match(src, /No metered requests yet/);
  assert.match(src, /their per-request\s+/);
  assert.match(src, /View session requests in Traces/);
});

test('live advisor: the bot watches live sessions and every alert ends in a copy fix', () => {
  const ga = read('js/components/guardian-assistant.js');
  // poll loop + endpoint
  assert.match(ga, /_liveStart\(\)/);
  assert.match(ga, /getOptimizerLive\(\)/);
  // staged compact advice follows the doc: heads-up, act-now, last-call
  // Each line names the agent it is about: "a live session" is unusable when
  // several are running, because the user has to know which window to act in.
  assert.match(ga, /heads_up: `\$\{who\} is \$\{pct\}% full\. Finish the current step, write a state note, then compact\.`/);
  assert.match(ga, /act_now: `\$\{who\} is \$\{pct\}% full\. Compact at the next stopping point/);
  assert.match(ga, /last_call: `\$\{who\} is \$\{pct\}% full\. Auto-compact is imminent/);
  // each stage speaks once per session; audible cues are rare and optional
  assert.match(ga, /each stage speaks once per session/);
  assert.match(ga, /LIVE_BEEP_COOLDOWN_MS: 10 \* 60 \* 1000/);
  assert.match(ga, /sounds_enabled !== false\) this\._beep\(\)/);
  // clipboard only, never a write into a session
  assert.match(ga, /never writes into a session/);
  assert.match(ga, /navigator\.clipboard\.writeText/);
  assert.match(ga, /Copy state note \+ compact step/);
  assert.match(ga, /\/compact keep the current task/);
  // unread badge on the FAB, cleared by reading the panel
  assert.match(ga, /_badgeSet\(unread\)/);
  assert.match(ga, /this\._badgeSet\(0\)/);
});

test('live advisor backend: tail-only reads, staged thresholds, advisory shape', () => {
  const py = fs.readFileSync(path.resolve(WEB, '..', '..', 'services', 'cost_optimizer.py'), 'utf8');
  assert.match(py, /LIVE_THRESHOLD_DEFAULTS = \{/);
  assert.match(py, /"stage_heads_up": 60/);
  assert.match(py, /"stage_act_now": 75/);
  assert.match(py, /"stage_last_call": 90/);
  assert.match(py, /def analyze_live_tail\(/);
  assert.match(py, /def live_advisor\(self\)/);
  assert.match(py, /nothing is ever\s+sent into a session/i);
  const routes = fs.readFileSync(path.resolve(WEB, '..', '..', 'server', 'routes', 'cost_optimizer.py'), 'utf8');
  assert.match(routes, /cost-optimizer\/live/);
  assert.match(routes, /live_advisor_enabled/);
});

test('optimizer page: live band leads, sparkline, deep links', () => {
  const src = read('js/pages/costs.js');
  // live band renders right after the strip and is labelled a gauge
  const strip = src.indexOf('host.appendChild(this._optStrip(rep, mode))');
  const liveBand = src.indexOf('this._optLiveSec()');
  assert.ok(strip > -1 && liveBand > strip, 'live band follows the strip');
  assert.match(src, /live gauge, not a receipt/);
  // the top-3 digest is gone on purpose: it restated what the session cards
  // and the findings wall already rank, and saying it twice made the page huge
  assert.ok(!src.includes('_optTopFixes'), 'no separate do-this-first digest');
  assert.ok(!src.includes('Do these'), 'no digest header copy left behind');
  // compact nudges never carry a savings figure (grep proves absence of one)
  const liveSec = src.slice(src.indexOf('_optLiveSec()'), src.indexOf('_optSessionsSec(host'));
  assert.ok(!/Saves|Gets back/.test(liveSec), 'no savings claims in live band');
  // sparkline over exact per-day sums
  assert.match(src, /rep\.daily \|\| \[\]/);
  assert.match(src, /tokens per day across the window/);
  // guardian deep link lands on the session row
  assert.match(src, /_pendingScrollSid/);
  assert.match(src, /data-live-sid/);
  const ga = read('js/components/guardian-assistant.js');
  assert.match(ga, /CostsPage\._pendingScrollSid = s\.session_id/);
});

test('live band refreshes with the bot, so the page and the bot never disagree', () => {
  const src = read('js/pages/costs.js');
  // the optimizer poll re-reads the live endpoint, not just session activity
  const poll = src.slice(src.indexOf('async _refreshOptSessions()'),
    src.indexOf('async _refreshOptSessions()') + 600);
  assert.match(poll, /await this\._refreshLiveBand\(\)/);
  assert.match(src, /async _refreshLiveBand\(\)/);
  // a stage or advisory change forces the full rebuild; rates patch in place
  assert.match(src, /key\(now\) !== key\(before\)/);
  assert.match(src, /this\._loadAndRenderOptimizer\(\)/);
  assert.match(src, /\.svo-live-fill i/);
});

test('live advisor settings: on by default, sounds and thresholds are the user\'s', () => {
  const src = read('js/pages/costs.js');
  assert.match(src, /Watch live sessions/);
  assert.match(src, /Advisor sounds/);
  assert.match(src, /Compact nudges at \(% full\)/);
  assert.match(src, /Big tool result \(tokens\)/);
  assert.match(src, /live_advisor_enabled: ev\.target\.value === '1'/);
  assert.match(src, /nothing is ever sent into a session/);
  const api = read('js/api.js');
  assert.match(api, /getOptimizerLive\(\)/);
});

// ---- density and plain language (v5.2.0 review pass) -----------------------
// The page said the live story three times and buried the one block that
// answers "what do I do". These guard the shape that fixed it.

test('the live story is told once: session rows stay closed while the band is up', () => {
  const src = read('js/pages/costs.js');
  assert.match(src, /const bandShown = !!\(this\._optLive/);
  assert.match(src, /r\.a\.active && !bandShown/);
  assert.match(src, /setOpen\(!!autoOpen\)/);
  // and the band names sessions the way the list below does, in the same order
  assert.match(src, /Agent #\$\{num\} · \$\{shortId\}/);
  assert.match(src, /const rank = \(x\) => \{ const i = liveIds\.indexOf/);
});

test('sessions lead the report; depth cards stay below them', () => {
  const src = read('js/pages/costs.js');
  const start = src.indexOf('\n    _optReportView(host, rep, st) {');
  assert.ok(start > -1, 'could not locate _optReportView');
  const view = src.slice(start, start + 2600);
  const sessions = view.indexOf('this._optSessionsSec(host, rep, st)');
  const ledger = view.indexOf('const ledger = this._optTrimLedger');
  assert.ok(sessions > -1 && ledger > -1);
  assert.ok(sessions < ledger, 'depth cards stay below the sessions list');
});

test('the strip leads with numbers: method and caveats are one click away', () => {
  const src = read('js/pages/costs.js');
  assert.match(src, /class="svo-strip-why" aria-expanded="false">How this number is built/);
  // the live poll rebuilds the strip, so the toggle has to survive a re-render
  assert.match(src, /this\._optStripMoreOpen \? '' : ' hidden'/);
  assert.match(src, /setMore\(!!this\._optStripMoreOpen\)/);
  assert.match(src, /svo-strip-caveat/);
  // the caveats still exist, they are just not always-on prose
  assert.match(src, /Token counts are exact; dollar figures are list-price estimates/);
});

test('numbers carry an anchor and causes are phrased as changes a person makes', () => {
  const src = read('js/pages/costs.js');
  // a row used to sum both buckets into one "avoidable" figure, so a single
  // row read 3.8B while the headline promised 143.8M. Split, they reconcile.
  assert.match(src, /'lossless ' \+ lossV\.lead/);
  assert.match(src, /'session length ' \+ histV\.lead/);
  assert.match(src, /if \(f\.type === QT\) \{ histTok \+=/);
  assert.match(src, /const histPct = histTok > 0 && sessTotal > 0/);
  assert.match(src, /% of everything it sent and received/);
  assert.match(src, /not in last scan/);
  // the list is ordered by the number the row leads with, and says so
  assert.match(src, /\(y\.lossless - x\.lossless\) \|\| \(y\.wasted - x\.wasted\)/);
  assert.match(src, /recent, most fixable first/);
  // the biggest bar is the one excluded from the headline: say so on the row
  assert.match(src, /Not in the headline above: getting this back costs context/);
});

test('a row counts exactly what the headline subtracts, and never claims clean', () => {
  const src = read('js/pages/costs.js');
  // splitting off repeated_context was not enough: the row still summed
  // duplicate_llm and retry_loop, which `modeled_lossless` never subtracts,
  // so nine rows totalled 174.1M against a 143.8M headline. A duplicate
  // turn's tokens_wasted is its whole prompt, which overlaps the re-sent
  // context, so the headline cannot widen: the row narrows instead.
  assert.match(src, /_OPT_LOSSLESS_TYPES: \{ tool_result_carry: 1, low_cache_utilization: 1 \}/);
  assert.match(src, /else if \(this\._OPT_LOSSLESS_TYPES\[f\.type\]\)/);
  // the sort key uses the same set as the cell, so order matches the number
  assert.match(src, /this\._OPT_LOSSLESS_TYPES\[f\.type\] \? \(f\.tokens_wasted \|\| 0\) : 0/);
  // narrowing the number must not let a session with duplicate calls read
  // "clean": the other findings keep a count of their own
  assert.match(src, /otherN \+ \(otherN === 1 \? ' other finding' : ' other findings'\)/);
  assert.match(src, /this session has findings of other kinds, such as duplicate or retried calls/);
  const cleanIdx = src.indexOf("            : 'clean')}<");
  assert.ok(cleanIdx > 0, "the 'clean' label survives only as the last fallback");
});

test('the Guardian fades only over real text, and never all the way out', () => {
  const ga = read('js/components/guardian-assistant.js');
  assert.match(ga, /_coversInk\(rect, tally\)/);
  assert.match(ga, /range\.selectNodeContents\(n\)/);
  assert.match(ga, /getClientRects\(\)/);
  // subtrees that cannot reach the bot are rejected whole, so the walk budget
  // is never spent off-screen
  assert.match(ga, /NodeFilter\.FILTER_REJECT/);
  assert.match(ga, /SHOW_TEXT \| NodeFilter\.SHOW_ELEMENT, filter\)/);
  assert.doesNotMatch(ga, /under\.innerText/);
  // The floor used to be 0.25, on the reasoning that a ghosted bot should
  // still be visible. Seen on screen, 0.25+ over body copy is a legible grey
  // shape that reads as a smudge or a rendering fault, not as a character
  // politely out of the way. Standing overlap is now prevented outright
  // (edge anchors + _unstick), so this state only catches a scroll bringing
  // text under a bot that was clear when it landed: it should be barely
  // there, but never zero, since vanishing entirely was its own old bug.
  const ghost = ga.match(/\.sv-ga-fab\.sv-ga-ghost \{ opacity: ([0-9.]+); \}/);
  const o = ghost && Number(ghost[1]);
  assert.ok(o > 0, 'the bot must not vanish completely');
  assert.ok(o <= 0.2, 'a ghosted bot must not read as a solid shape over text');
  // idle life: one small glance, skipped while the cursor is live
  assert.match(ga, /_glanceStart\(\)/);
  assert.match(ga, /this\._bot3d\.glance\(\)/);
  const bot = read('js/components/guardian-3d.js');
  assert.match(bot, /glance\(\) \{/);
  assert.match(bot, /performance\.now\(\) - lastMove < 4000/);
});

test('the live-poll rebuild never steals the scroll position', () => {
  const src = read('js/pages/costs.js');
  // the optimizer tab is wiped and re-fetched when a session flips live/idle;
  // the old height is held and the scroll restored so a reader who is deep in
  // the page is not yanked back to the top mid-read
  assert.match(src, /const scroller = content\.closest\('\.page-content'\) \|\| document\.scrollingElement/);
  assert.match(src, /content\.style\.minHeight = keepH \+ 'px'/);
  assert.match(src, /content\.style\.minHeight = ''/);
  assert.match(src, /scroller\.scrollTop = Math\.min\(/);
  // the follow-through band renders with the sessions it measures
  const sess = src.indexOf('this._optSessionsSec(host, rep, st);');
  const fixes = src.indexOf('const fixSec = this._optFixesSec();');
  assert.ok(sess !== -1 && fixes > sess, 'Fixes you copied renders after the session cards');
});
