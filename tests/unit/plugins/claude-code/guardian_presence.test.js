'use strict';

// Guardian Presence (v5.2.0, #202) — source-text assertions, same technique as
// costs_optimizer_page.test.js: the component render code runs inside pywebview
// and isn't easily unit-testable, so these guard the invariants that a future
// polish pass would otherwise erode without anyone noticing.
//
// The invariants, in one line each:
//   1. idle motion is caused, not perpetual (the settle)
//   2. gaze targets are real events, and a missing target is a no-op
//   3. the 2D and 3D bots carry the SAME state vocabulary
//   4. no state depends on hue (colour means security state, nothing else)
//   5. every new behaviour stays behind prefers-reduced-motion
//   6. a blocked tool call does not get a friendly greeting

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

const THREE_D = 'js/components/guardian-3d.js';
const TWO_D = 'js/components/guardian-bot.js';
const ASSISTANT = 'js/components/guardian-assistant.js';

test('idle motion settles, so movement is a signal rather than a screensaver', () => {
  const src = read(THREE_D);
  // the infinite yoyo tweens are gone: they ran identically whether the
  // machine was quiet or an agent had just been blocked
  assert.ok(!/gsap\.to\(G\.body\.position, \{ y: 0\.03[^)]*repeat: -1/.test(src),
    'body bob must not run on an infinite yoyo tween');
  assert.ok(!/gsap\.to\(G\.shadow\.scale[^)]*repeat: -1/.test(src),
    'shadow pulse must not run on an infinite yoyo tween');
  // procedural drive, scaled by a life value that decays after quiet
  assert.match(src, /const LIFE_FLOOR = /);
  assert.match(src, /const QUIET_MS = /);
  assert.match(src, /const settleCheck = \(\) => \{/);
  assert.match(src, /G\.body\.position\.y = .*life|const a = life\.v/);
  // the floor is a floor, not zero: asleep, never switched off
  const floor = Number((src.match(/const LIFE_FLOOR = ([\d.]+)/) || [])[1]);
  assert.ok(floor > 0 && floor < 0.5, `LIFE_FLOOR should be a small positive floor, got ${floor}`);
  // blinking survives the settle — a still character that never blinks reads
  // as frozen rather than calm
  assert.match(src, /blink survives the settle/i);
});

test('every caused motion wakes the bot, so a reaction is never played at a floor amplitude', () => {
  const src = read(THREE_D);
  // anchor on the method definitions, not on mentions in the doc comment
  for (const fn of ['look', 'glance', 'wave', 'setState', 'react']) {
    const m = src.match(new RegExp(`\\n            ${fn}\\(`));
    assert.ok(m, `missing controller method ${fn}()`);
    const body = src.slice(m.index);
    assert.ok(/wake\(\)/.test(body.slice(0, 900)), `${fn}() must call wake()`);
  }
});

test('a caused gaze needs a real on-screen target, and outranks cursor tracking', () => {
  const src = read(THREE_D);
  assert.match(src, /function pointOf\(target\)/);
  // an element with no box, or no element at all, must not produce a stare
  assert.match(src, /if \(!r\.width && !r\.height\) return null;/);
  assert.match(src, /const pt = pointOf\(target\);\s*\n\s*if \(!pt\) return 0;/);
  // while a deliberate look holds, the cursor must not drag the head away
  assert.match(src, /let gazeUntil = 0;/);
  assert.match(src, /if \(performance\.now\(\) < gazeUntil\) return;/);
  // the assistant only aims at nav entries that are actually rendered and
  // in the viewport: looking at nothing is worse than not looking
  const a = read(ASSISTANT);
  assert.match(a, /_navAnchor\(page\) \{/);
  assert.match(a, /r\.bottom >= 0 && r\.top <= window\.innerHeight/);
  // Threats / Secret Detections / Blocked Actions are sub-items of a
  // collapsible section and have NO box while it is closed, which is exactly
  // the case for the events that matter most. Verified live: the section
  // header is the fallback, so the gaze still points the right way.
  assert.match(a, /const group = el\.closest\('\.nav-sub-items'\);/);
  assert.match(a, /parent\.classList\.contains\('nav-item'\)/);
});

test('the 2D fallback carries the same state vocabulary as the 3D Guardian', () => {
  const three = read(THREE_D);
  const two = read(TWO_D);
  const list = (src, re) => {
    const m = src.match(re);
    assert.ok(m, `could not find the STATES list in ${re}`);
    return [...m[1].matchAll(/'([a-z]+)'/g)].map(x => x[1]).sort();
  };
  const a = list(three, /const STATES = \[([^\]]*)\]/);
  const b = list(two, /STATES: \[([^\]]*)\]/);
  assert.deepEqual(a, b, 'the 3D and 2D bots must expose identical state names');
  // and the vocabulary is more than an ornament: two states is decoration
  assert.ok(a.length >= 5, `expected a real vocabulary, got ${a.join(', ')}`);
  for (const s of ['idle', 'scan', 'listening', 'concerned', 'ok']) {
    assert.ok(a.includes(s), `missing state: ${s}`);
  }
});

test('no state is expressed in colour, and each reads with motion disabled', () => {
  const two = read(TWO_D);
  // the posture states must exist as static CSS, outside the
  // prefers-reduced-motion block, so they survive with animation off
  const mq = two.indexOf('@media (prefers-reduced-motion: no-preference)');
  assert.ok(mq > 0, 'expected the reduced-motion guard to exist');
  const staticCss = two.slice(0, mq);
  assert.match(staticCss, /\.sv-gbot-listening \.gb-body \{ transform: rotate/);
  assert.match(staticCss, /\.sv-gbot-concerned \.gb-body \{ transform:/);
  assert.match(staticCss, /\.sv-gbot-concerned \.gb-eye ellipse \{ transform: scaleY/);
  // amber/red belong to real security state and must not leak into the
  // character's own states
  // strip comments first: "prefers-reduced-motion" contains "red"
  const posture = staticCss
    .slice(staticCss.indexOf('.sv-gbot-listening'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-f]{3,8}\b|\b(red|crimson|amber|orange|tomato)\b/i.test(posture),
    'posture states must not introduce colour');
  // the 3D concerned state is posture + eye shape, never an emissive colour ramp
  const three = read(THREE_D);
  const concerned = three.slice(three.indexOf('const worried ='), three.indexOf('react(kind)'));
  assert.ok(!/emissive/.test(concerned), 'concerned must not be signalled with emissive colour');
});

test('every new behaviour stays behind prefers-reduced-motion', () => {
  const src = read(THREE_D);
  for (const fn of ['look(target, opts = {})', 'react(kind)']) {
    const i = src.indexOf(fn);
    assert.ok(i > 0, `missing ${fn}`);
    assert.match(src.slice(i, i + 200), /if \(!gsap \|\| REDUCED/,
      `${fn} must bail out under prefers-reduced-motion`);
  }
  // the procedural idle drive is inside the same guard
  assert.match(src, /if \(gsap && !REDUCED\) \{\s*\n\s*settleCheck\(\);/);
});

test('a blocked tool call does not get a friendly greeting', () => {
  const a = read(ASSISTANT);
  // _speak used to wave at everything, including a denial
  assert.ok(!/if \(this\._bot3d\) this\._bot3d\.wave\(\);\s*\n\s*else if \(this\._fab && window\.GuardianBot\)/.test(a),
    '_speak must not wave unconditionally');
  assert.match(a, /_react\(mood, page\) \{/);
  assert.match(a, /this\._react\(mood, page\);/);
  // wave survives only as a greeting, on open
  assert.match(a, /this\._bot3d\.wave\(\); \/\/ greets while the panel opens/);
  // the security events carry the alert register, the cost ones concern
  // anchor on the _speak call sites (a page id alone also appears in panel rows)
  for (const cta of ["See it', page: 'threats'", "See what', page: 'redactions'",
                     "See them', page: 'blocked-ledger'"]) {
    const i = a.indexOf(cta);
    assert.ok(i > 0, `no _speak call for ${cta}`);
    assert.match(a.slice(i, i + 90), /mood: 'alert'/, `${cta} should react in the alert register`);
  }
  assert.match(a, /tab: 'optimizer', mood: 'concerned'/);
  assert.match(a, /tab: 'overview', mood: 'concerned'/);
});

test('the reaction rides the existing per-category cooldown, not a new timer', () => {
  const a = read(ASSISTANT);
  // _react is only ever reached through _speak, which is already rate-limited
  // by BUBBLE_COOLDOWN_MS and the one-bubble-at-a-time guard. A second,
  // independent trigger would let a busy fleet strobe the character.
  const calls = [...a.matchAll(/this\._react\(/g)];
  assert.equal(calls.length, 1, 'the Guardian must react from exactly one call site');
  assert.match(a, /BUBBLE_COOLDOWN_MS/);
  const speak = a.slice(a.indexOf('_speak({ text, cta, page, tab, mood, act })'));
  assert.match(speak.slice(0, 400), /if \(this\._bubbleEl && this\._bubbleEl\.isConnected\) return false;/);
});

test('the cache-busting versions were bumped with the components', () => {
  const html = read('index.html');
  assert.match(html, /guardian-bot\.js\?v=11/);
  assert.match(html, /guardian-3d\.js\?v=16/);
  assert.match(html, /guardian-assistant\.js\?v=39/);
});

test('a live card says which agent it means, and the copy button says where it goes', () => {
  const a = read(ASSISTANT);
  // "a live session" is unusable advice with four agents running
  assert.match(a, /_liveWho\(s\) \{/);
  assert.match(a, /num > 0 \? `Agent #\$\{num\} · \$\{shortId\}` : `Session \$\{shortId\}`/);
  // the number comes from the same activity list the Optimizer numbers from,
  // so one session cannot end up with two different names across the app
  assert.match(a, /this\._activityIds/);
  assert.match(a, /\.filter\(a => a\.active\)\.map\(a => a\.session_id\)/);
  // the human handle: runtime, model, and how long ago it moved
  assert.match(a, /\[s\.harness, s\.model, this\._ago\(s\.last_activity\)\]/);
  assert.match(a, /_ago\(iso\) \{/);
  // the spoken lines name the agent too, not just the card
  assert.match(a, /const who = this\._liveWho\(s\)\.title;/);
  assert.match(a, /heads_up: `\$\{who\} is \$\{pct\}% full/);
  // and the copy confirmation names the destination
  assert.match(a, /_copy\(btn, text, into, meta\)/);
  assert.match(a, /into \? `Copied, paste into \$\{into\}`/);
  assert.match(a, /this\._copy\(btn, fix\.text, who\.title,/);
});

test('the advisory disclaimer prints last and stays one line on screen', () => {
  const a = read(ASSISTANT);
  // the promise is printed, not assumed, but printed at the BOTTOM: the
  // cards are what the user opened the panel for, so the fine print yields
  assert.match(a, /sv-ga-live-note/);
  assert.match(a, /Advisory only: you copy, you paste, nothing is ever '\n\s*\+ 'typed into a session\./);
  const noteAt = a.indexOf("note.textContent = 'Advisory only");
  const cardsAt = a.indexOf("body.appendChild(card);");
  assert.ok(cardsAt > -1 && noteAt > cardsAt, 'note renders after the live cards');
  // the full contract survives on hover: measured vs modeled stays separated
  const block = a.slice(noteAt, a.indexOf('body.appendChild(note);'));
  assert.match(block, /never types into a session and never edits/);
  assert.match(block, /Context figures are measured from/);
  assert.match(block, /everything else is a modeled estimate/);
  assert.match(block, /watches that same local transcript/);
  // product copy carries no em dashes
  assert.ok(!block.includes('\u2014'), 'UI copy must not use em dashes');
});

// The identity logic runs without a DOM, so it can be exercised for real
// rather than matched as source text.
const loadAssistant = () => {
  const sandbox = {
    window: {}, document: {}, console,
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window.localStorage = sandbox.localStorage;
  vm.createContext(sandbox);
  vm.runInContext(read(ASSISTANT), sandbox);
  return sandbox.window.GuardianAssistant;
};

test('agent identity: numbered when known, never guessed when not', () => {
  const GA = loadAssistant();
  const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
  GA._activityIds = ['aaaa1111-x', 'bbbb2222-y'];

  const first = GA._liveWho({
    session_id: 'aaaa1111-x', harness: 'claude-code',
    model: 'claude-opus-5', last_activity: ago(12),
  });
  assert.equal(first.title, 'Agent #1 · aaaa1111');
  assert.equal(first.sub, 'claude-code · claude-opus-5 · active 12s ago');

  const second = GA._liveWho({
    session_id: 'bbbb2222-y', harness: 'codex', model: 'gpt-5', last_activity: ago(240),
  });
  assert.equal(second.title, 'Agent #2 · bbbb2222');
  assert.match(second.sub, /active 4m ago$/);

  // not in the activity list: stays unnumbered rather than taking a number
  // that would disagree with the Optimizer's session list
  const unknown = GA._liveWho({
    session_id: 'cccc3333-z', harness: 'cursor', model: 'sonnet', last_activity: ago(9000),
  });
  assert.equal(unknown.title, 'Session cccc3333');
  assert.match(unknown.sub, /active 3h ago$/);

  // no metadata at all: the sub-line is empty so the card omits it entirely
  assert.equal(GA._liveWho({ session_id: 'dddd4444-w' }).sub, '');
});

test('recency degrades quietly on missing, malformed and future timestamps', () => {
  const GA = loadAssistant();
  assert.equal(GA._ago(null), '');
  assert.equal(GA._ago('not-a-date'), '');
  // a clock skew must not render "active -60s ago"
  assert.equal(GA._ago(new Date(Date.now() + 60000).toISOString()), '');
});

test('the Guardian docks: it never relocates itself onto the page', () => {
  const a = read(ASSISTANT);
  // Seen on screen: wandering parked it on the Dashboard banner copy, where it
  // faded to a grey shape that reads as a rendering fault, and mid-column on
  // the Optimizer where it read as a misplaced asset. A smarter picker does
  // not save it, because a dense page has no empty space to move to.
  assert.ok(!/_wanderTarget/.test(a), 'the wander picker must be gone');
  assert.ok(!/for \(let i = 0; i < 8; i\+\+\)/.test(a),
    'the unchecked random-fallback wander must be gone');
  assert.ok(!/Math\.random\(\) \* Math\.max\(1, window\.innerWidth/.test(a),
    'nothing may target arbitrary viewport points');
  // the only automatic movement left is getting off text
  assert.match(a, /this\._unstick\(\);\s*\n\s*\}, this\.WANDER_MS\);/);
  // drag-to-pin still works: docking is the default, not a cage. The hover
  // hint that used to prove this is gone (people can see a draggable
  // character), so assert the capability itself.
  assert.match(a, /\.sv-ga-fab \{ cursor: grab; touch-action: none; \}/);
  assert.match(a, /\.sv-ga-fab\.sv-ga-drag \{ cursor: grabbing;/);
});

test('a pinned bot still gets off the text, without losing the pin', () => {
  const a = read(ASSISTANT);
  // The real machine had the bot PINNED on the dashboard banner at (966,82),
  // so wandering never applied and it sat there as a grey shape indefinitely.
  assert.match(a, /_unstick\(\) \{/);
  assert.match(a, /const here = this\._inkCount\(r\);\s*\n\s*if \(!here\) return;/);
  // nearest clear anchor, and the corrected spot is remembered
  // Measured: requiring a perfectly clear anchor failed on the dashboard,
  // where every edge anchor covers something, so the bot gave up and stayed
  // on the banner. Least ink wins, nearest breaks the tie.
  assert.match(a, /_inkCount\(rect\) \{ return this\._coversInk\(rect, true\); \}/);
  assert.match(a, /\.sort\(\(p, q\) => \(p\.ink - q\.ink\) \|\| \(dist\(p\.a\) - dist\(q\.a\)\)\)/);
  assert.match(a, /if \(!best \|\| best\.ink >= here\) return;/);
  assert.match(a, /if \(this\._pinned\(\)\) \{[\s\S]{0,200}sv-guardian-pos/);
  // checked once on mount, then only on the slow wander beat: never while
  // the user is reading or dragging
  // measured: with requestAnimationFrame the check ran before the page had
  // painted, found no ink on an empty screen, and left a bad pin in place
  // until the 26s wander beat
  assert.ok(!/requestAnimationFrame\(\(\) => this\._unstick\(\)\)/.test(a),
    'the mount check must not run before first paint');
  assert.match(a, /setTimeout\(\(\) => this\._unstick\(\), 1200\);/);
  // the slow beat now does nothing BUT unstick, pinned or not
  assert.match(a, /this\._unstick\(\);\s*\n\s*\}, this\.WANDER_MS\);/);
  assert.match(a, /if \(!fab \|\| this\._dragging \|\| this\._open\) return;/);
  // a deliberate placement that works is never overridden
  assert.match(a, /Does nothing when the current spot is already clear/);
  // a docked bot is never dragged off its home corner: content scrolling
  // under it is expected, and the fade is what handles that
  assert.match(a, /if \(!this\._pinned\(\)\) return;/);
  // measured: the fade only ran on scroll or after a move, so on first load
  // the bot sat fully opaque on top of the "Open the Optimizer" button
  assert.match(a, /setTimeout\(\(\) => this\._ghostCheck\(\), 1200\);/);
});

test('a control counts as ink even when it holds no text', () => {
  const a = read(ASSISTANT);
  // Measured on the dashboard: the bot moved to an anchor _coversInk called
  // clear and landed on the Guardian ML switch, because the app's toggles are
  // `label.toggle > span.toggle-slider` with a zero-size input inside and the
  // selector only listed button/a/input/select/textarea/img/svg.
  const ink = a.match(/const INK = '([^;]*)';/s);
  assert.ok(ink, 'could not find the INK selector');
  for (const sel of ['label', '[role="switch"]', '[role="checkbox"]', 'canvas']) {
    assert.ok(ink[1].includes(sel), `INK must include ${sel}`);
  }
});

test('the Guardian panel drags by its header and reopens where it was left', () => {
  const a = read(ASSISTANT);
  assert.match(a, /_initPanelMoves\(panel\) \{/);
  assert.match(a, /this\._initPanelMoves\(panel\);/);
  // header only: the body scrolls and is full of click targets
  assert.match(a, /const head = panel\.querySelector\('\.sv-ga-head'\);/);
  // the close control stays a click, never the start of a drag
  assert.match(a, /ev\.target\.closest\('\.sv-ga-close'\)\)\) return;/);
  // a click is not a drag
  assert.match(a, /if \(!moved && Math\.hypot\(dx, dy\) < 6\) return;/);
  // position survives close/reopen, and is re-clamped into the current
  // viewport so a spot saved in a wider window cannot put the close button
  // out of reach
  assert.match(a, /sv-guardian-panel-pos/);
  // Measured: open() restored the saved spot and then _placeNear snapped the
  // panel back to the bot, so the drag looked like it had not worked at all.
  // A moved panel wins; an untouched one still follows the bot.
  assert.match(a, /if \(!this\._panelRestore\(\)\) this\._placeNear\(this\._panel\);/);
  assert.match(a, /this\._panelPlace\(p\.x, p\.y\);\s*\n\s*return true;/);
  assert.match(a, /Math\.max\(8, Math\.min\(x, window\.innerWidth - w - 8\)\)/);
  assert.match(a, /window\.addEventListener\('resize'[\s\S]{0,220}_panelPlace/);
  // pointercancel ends a drag too: a lost pointer must not leave it stuck
  assert.match(a, /head\.addEventListener\('pointercancel', end\);/);
  // and the header advertises that it moves
  const css = a.slice(a.indexOf('.sv-ga-head {'));
  assert.match(css.slice(0, 300), /cursor: move/);
  assert.match(css.slice(0, 300), /user-select: none/);
  assert.match(css.slice(0, 400), /touch-action: none/);
});

// ---------------------------------------------------------------------------
// Follow-through and personality (v5.2.0, #202)
//
// Two invariants worth pinning hard:
//   7. a paste is never celebrated; only a measured change is
//   8. humour lives in the idle cloud only, and never carries a state colour

test('only a measured win is celebrated, never a paste', () => {
  const a = read(ASSISTANT);
  // wins come from the service, which resolves them from transcript evidence
  assert.match(a, /live\.fixes && live\.fixes\.wins/);
  assert.match(a, /_nextWin\(live, st\) \{/);
  // and each spoken win names what actually moved
  assert.match(a, /went from \$\{this\._fmtTok\(before\)\} to/);
  assert.ok(!/paste[^.]*\bwell done\b/i.test(a), 'a paste alone must not be praised');
  // the celebration is reached only from the win branch
  const winBlock = a.slice(a.indexOf('const win = this._nextWin'),
    a.indexOf('if (toSpeak && !this._quiet())', a.indexOf('const win = this._nextWin')));
  assert.match(winBlock, /this\._celebrate\(\);/);
});

test('the win lap spins 270 degrees and its colour carries no meaning', () => {
  const three = read(THREE_D);
  assert.match(three, /celebrate\(\) \{/);
  // 270 degrees, expressed as three half-pi quarters
  assert.match(three, /Math\.PI \* 1\.5/);
  // the Guardian's own materials are never touched: hue on the bot means
  // security state, so the colour lives in the DOM puff ring instead
  const block = three.slice(three.indexOf('celebrate() {'), three.indexOf('dispose() {'));
  assert.ok(!/setHSL|\.color|emissive/.test(block),
    'celebrate must not recolour anything on the bot');
  assert.ok(!/G\.shell/.test(block) && !/G\.dark/.test(block),
    'celebrate must not recolour the bot itself');
  // and it never runs under reduced motion
  assert.match(block, /if \(!gsap \|\| REDUCED \|\| disposed\) return 0;/);
  // the flat renderer gets the same beat, also motion-guarded
  const a = read(ASSISTANT);
  assert.match(a, /sv-ga-lap/);
  assert.match(a, /prefers-reduced-motion: reduce\) \{\n  \.sv-ga-fab \{ animation: none; \}\n  \.sv-ga-fab\.sv-ga-lap \{ animation: none; \}/);
});

test('the bot has a theme-aware halo and a bigger stage', () => {
  const a = read(ASSISTANT);
  // no hover hint: a draggable, clickable character needs no instructions,
  // and the hint sat inside the fab's drop-shadow, so the halo lit the
  // tooltip instead of the bot
  assert.ok(!a.includes('Drag me anywhere'), 'no drag tooltip on the bot');
  assert.ok(!a.includes('attr(data-tip)'), 'no tooltip pseudo-element');
  // the lap ring still owns ::after
  assert.match(a, /\.sv-ga-fab\.sv-ga-lap::after, \.sv-ga-fab\.sv-ga-puffs::after \{/);
  // 104 up from 94: at 94 the bot read as an icon, not a character
  assert.match(a, /Guardian3D\.mount\(fab, \{ size: 104 \}\)/);
  assert.match(a, /GuardianBot\.el\(\{ state: 'idle', size: 84, label: '' \}\)/);
  // the halo is the product's single accent via tokens, both themes defined,
  // light mixing stronger because light backgrounds swallow a faint glow
  assert.match(a, /--sv-ga-glow: color-mix\(in srgb, var\(--accent-primary\) 30%, transparent\);/);
  assert.match(a, /\[data-theme="light"\] \{ --sv-ga-ink: #2a323c;\n  --sv-ga-glow: color-mix\(in srgb, var\(--accent-primary\) 42%, transparent\);/);
  assert.match(a, /drop-shadow\(0 0 11px var\(--sv-ga-glow\)\)/);
  // the breathe is real motion, so reduced motion turns it off
  assert.match(a, /animation: sv-ga-breathe 5\.4s ease-in-out infinite;/);
  assert.match(a, /reduced-motion: reduce\) \{\n  \.sv-ga-fab \{ animation: none; \}/);
});

test('the Guardian paces itself: rare thoughts, one shared clock', () => {
  const a = read(ASSISTANT);
  // dots wait for real work; a sub-second poll never blinks the cloud
  assert.match(a, /DOTS_AFTER_MS: 700,/);
  assert.match(a, /this\._dotsDelay = setTimeout\(/);
  // thoughts respect a minimum gap since the last word, with backoff so a
  // long shift gets a quieter companion, not a chattier one
  assert.match(a, /THOUGHT_GAP_MS: 5 \* 60 \* 1000,/);
  assert.match(a, /Math\.min\(4, 1 \+ \(this\._thoughtCount \|\| 0\) \* 0\.5\)/);
  // a settle-in grace before the first musing
  assert.match(a, /THOUGHT_SETTLE_MS: 2 \* 60 \* 1000,/);
  // every bubble pushes the next thought back: one clock for the whole voice
  assert.match(a, /this\._spokeAt = Date\.now\(\); \/\/ thoughts wait their turn after any bubble/);
  // an orientation never lands on top of something just said
  assert.match(a, /if \(Date\.now\(\) - \(this\._spokeAt \|\| 0\) < 30000\) return; \/\/ let the last word land/);
  // dots never clip a thought mid-read
  assert.match(a, /if \(!text && t\.classList\.contains\('show'\) && t\.dataset\.mode === 'text'\) return;/);
  // the resting drift is real motion, so reduced motion turns it off
  assert.match(a, /\.sv-ga-thought\.show \{ transform: none; animation: none; \}/);
});

test('the thought cloud is honest: dots mean real work, thoughts mean idle', () => {
  const a = read(ASSISTANT);
  // dots go up before the request and come down after it
  assert.match(a, /this\._think\(true\);/);
  assert.match(a, /\.finally\(\(\) => this\._think\(false\)\)/);
  // and the cloud yields to anything that needs attention
  assert.match(a, /if \(this\._quiet\(\) \|\| this\._open \|\| this\._bubbleEl \|\| !this\._fab\) return;/);
  // every colour is a theme token, so the cloud follows light / black /
  // azure / ember / slate without a single per-theme rule, and the only
  // accent it can reach for is the product's one teal
  const css = a.slice(a.indexOf('.sv-ga-thought {'), a.indexOf('@keyframes sv-ga-think'));
  // the only literals allowed are the two --sv-ga-ink definitions: the bot's
  // own ink, white on dark and the visor tone on light
  const literals = css.replace(/--sv-ga-ink: #[0-9a-f]{3,8};/gi, '');
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(literals), 'no literal colours in the cloud');
  assert.match(css, /:root \{ --sv-ga-ink: #ffffff;/);
  assert.match(css, /\[data-theme="light"\] \{ --sv-ga-ink: #[0-9a-f]{6};/);
  assert.match(css, /var\(--bg-elevated\)/);
  assert.match(css, /var\(--sv-ga-ink\)/);
  assert.ok(!/var\(--(danger|warning|success|error|critical)[a-z-]*\)/i.test(css),
    'no state colour in an ambient decoration');
  // and the shine is motion, so it goes away under reduced motion
  assert.match(a, /\.sv-ga-thought-t \{ animation: none; background-image: none;/);
});

test('the Guardian has one documented personality, and it stays clean', () => {
  const a = read(ASSISTANT);
  assert.match(a, /PERSONA: \{/);
  assert.match(a, /traits: \['calm', 'precise', 'modest', 'kind', 'dry'\]/);
  const persona = a.slice(a.indexOf('PERSONA: {'), a.indexOf('_thoughtEl()'));
  // every line short enough to read at a glance
  const lines = [...persona.matchAll(/'([^'\n]{6,})'/g)].map(m => m[1])
    .filter(l => l.includes(' '));
  assert.ok(lines.length > 15, 'the pools should be varied enough not to repeat');
  for (const l of lines) {
    assert.ok(l.length <= 44, `thought too long to be a thought: ${l}`);
    assert.ok(!/[!?]{2}|[A-Z]{3}/.test(l), `not calm: ${l}`);
  }
  // no scolding, and nothing crude
  assert.ok(!/\b(stupid|idiot|dumb|damn|hell|crap|lazy|sloppy)\b/i.test(persona),
    'the Guardian never insults the user or swears');
});

test('a long stretch or a long silence gets a remark, not a warning', () => {
  const a = read(ASSISTANT);
  assert.match(a, /stamina: \[/);
  assert.match(a, /when: stretch >= 2,/);
  // the quiet clock is reset by anything actually happening
  assert.match(a, /this\._lastEventAt = Date\.now\(\); \/\/ something happened/);
  assert.match(a, /when: quietMins >= 20,/);
  assert.match(a, /quietMins >= 60/);
});

test('copying a fix starts the follow-through clock', () => {
  const a = read(ASSISTANT);
  assert.match(a, /API\.optimizerFixCopied\(\{/);
  const costs = read('js/pages/costs.js');
  assert.match(costs, /async _optCopyText\(btn, text, meta\)/);
  // every copy button on the page carries a type, or the loop cannot close
  const calls = [...costs.matchAll(/_optCopyText\(([^;]*?)\);/gs)].map(m => m[1]);
  assert.ok(calls.length >= 4, 'expected every copy site to be wired');
  for (const c of calls) {
    if (c.startsWith('btn, text')) continue; // the definition itself
    assert.match(c, /type:/, `copy site without a fix type: ${c.slice(0, 60)}`);
  }
  // and the receipt strip distinguishes pasted from worked
  assert.match(costs, /copied, not pasted yet/);
  assert.match(costs, /pasted into \$\{who\}\. Watching the next few turns/);
});

test('one-shot moves survive the idle drive instead of being clobbered', () => {
  const src = read(THREE_D);
  // The render loop ASSIGNS body.y and root.rotation.y every frame. Any tween
  // that writes those same properties is wiped before it can be seen, which is
  // exactly how the win spin came out looking like nothing happened.
  assert.match(src, /const pose = \{ spin: 0, hop: 0 \};/);
  assert.match(src, /G\.root\.rotation\.y = .*\+ pose\.spin;/);
  assert.match(src, /G\.body\.position\.y = .*\+ pose\.hop;/);
  const block = src.slice(src.indexOf('celebrate() {'), src.indexOf('dispose() {'));
  assert.ok(!/tl\.to\(G\.root\.rotation/.test(block),
    'celebrate must drive the pose offset, not the property the loop overwrites');
  assert.match(block, /tl\.to\(pose, \{ spin: Math\.PI \* 1\.5/);
});

test('the thought cloud never makes a claim about the user data', () => {
  const a = read(ASSISTANT);
  // The cloud cannot be clicked, so it cannot carry a finding. Anything about
  // sessions, tokens, tools or findings belongs in _speak(), which comes with
  // the number and a button to the page that owns it. A line like "a tool
  // result is misbehaving somewhere" is a finding with no evidence attached.
  const pools = a.slice(a.indexOf('PERSONA: {'), a.indexOf('_thoughtEl()'))
    + a.slice(a.indexOf('_scenarios(live) {'), a.indexOf('_thoughtPick() {'));
  const lines = [...pools.matchAll(/'([^'\n]{6,})'/g)].map(m => m[1])
    .filter(l => l.includes(' '));
  const forbidden = /\b(token|tool|session|agent|context|finding|result|cost|threat|window)s?\b/i;
  for (const l of lines) {
    assert.ok(!forbidden.test(l), `unlinked claim about user data: "${l}"`);
  }
  // and the cloud is genuinely not clickable, which is why the rule exists
  assert.match(a, /\.sv-ga-thought \{ position: fixed; z-index: 899; pointer-events: none;/);
});

test('the page-aware offer is an offer, not an interception', () => {
  const a = read(ASSISTANT);
  // it reacts to a real expand, detected generically rather than by a list of
  // per-page selectors that every page would have to remember to update
  assert.match(a, /'\[aria-expanded="true"\], details\[open\], \.expanded, \.open'/);
  assert.match(a, /if \(this\._openCount\(\) > before\) this\._orient\(\);/);
  // hard caps so it can never become chatty
  assert.match(a, /ORIENT_MAX: 3,/);
  assert.match(a, /if \(this\._orientCount >= this\.ORIENT_MAX\) return;/);
  assert.match(a, /if \(!b \|\| this\._oriented\[page\]\) return;/);
  // it yields to anything that actually needs attention
  assert.match(a, /_orient\(\) \{\n\s+if \(this\._quiet\(\) \|\| this\._open \|\| this\._bubbleEl\) return;/);
  // and every line ends by handing control back
  assert.match(a, /Or ignore me and carry on\./);
  // the briefs explain the product, never the user's data: a claim about what
  // is on screen could be wrong, an explanation of the view cannot be
  const briefs = a.slice(a.indexOf('PAGE_BRIEFS: {'), a.indexOf('_currentPage()'));
  assert.ok(!/\$\{/.test(briefs), 'briefs must be static copy, not interpolated data');
});

test('the traces-page CTA answers on the traces page, not on the Optimizer', () => {
  const a = read(ASSISTANT);
  // "Show me the costliest trace", offered while the user is looking at
  // traces, must resolve in place. Shipping them to another page breaks the
  // promise the button text makes.
  const brief = a.slice(a.indexOf("'agent-runs': {"), a.indexOf("threats: {"));
  assert.match(brief, /act: 'costliest-trace'/);
  assert.ok(!/page: 'costs'/.test(brief), 'traces brief must not navigate to costs');
  // The action selects the trace on this page (no accordion-collapse on
  // re-click), and when nothing is rankable it says so instead of going mute.
  assert.match(a, /_act\(name\)/);
  assert.match(a, /selectRun\(best\.trace_id, \{ refresh: true \}\)/);
  assert.match(a, /cannot rank these traces yet/);
  // The bubble handler runs the action INSTEAD of navigating.
  assert.match(a, /if \(act\) \{ this\._act\(act\); return; \}/);
});
