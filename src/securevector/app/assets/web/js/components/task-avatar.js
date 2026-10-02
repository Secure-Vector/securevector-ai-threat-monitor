// Task Avatar — the Guardian figure in miniature on a round badge in the task
// hue, identifying one agent task across the rail and the Agent Sessions board.
// Same proportions as the Guardian bot (head rounded to about a third of its
// height, a side pod each ear, a top-left sheen, a dark glass visor and two
// LED eyes), drawn fresh rather than by reusing the bot's markup.
// Colour is harness identity; a stable task-id hash is used only for an
// unknown harness. State is carried by the eyes, matching the
// task-row and task-card state vocabulary already used elsewhere (active,
// approval, blocked, completed, interrupted, failed). The eyes are static:
// nothing here blinks, wanders or breathes.
//
// The state vocabulary splits in two. A task that is NOT running closes its
// eyes: `completed` into content arcs, `interrupted` into flat lids. A task
// that is running but unhappy keeps them OPEN: `blocked` narrows them to
// bright slits, `failed` angles them and drops the head. Open versus closed
// is a silhouette difference, and at 18px that is the only kind that reads.
//
// The figure is a REAL 3D render, not flat vector shading. It is not rendered
// live: a badge appears once per task row, board card and pane tab, and a
// browser caps live WebGL contexts at roughly 8 to 16 (the desktop shell's
// WKWebView is the least forgiving of all). So the same Guardian the hero
// renderer builds in guardian-3d.js is rendered offline by
// scripts/render_task_avatar_atlas.py into one transparent sprite atlas, and
// each badge shows the cell for its {harness, state} at its theme.
//
// The flat SVG below stays, for three jobs: it paints while the atlas is
// still decoding so a badge never flashes empty; it is the fallback if the
// atlas fails to load; and it is the only renderer for an unknown harness,
// which has no baked cell because its colour is a hash of the task id.
//
// The luminous halo is NOT baked into the cells. It is the dual drop-shadow
// the floating Guardian uses (guardian-assistant.js, _injectStyle): an offset
// dark shadow for depth plus a zero-offset halo in the harness accent. A
// drop-shadow follows the element's alpha silhouette, so it hugs the figure
// on the sprite and on the SVG alike, costs no atlas bytes, cannot be clipped
// by a cell edge, and is tintable at runtime, which is what lets an unknown
// harness on the SVG fallback still glow in its hashed colour.

const TaskAvatar = {
    PALETTE: ['#7b61ff', '#3b7ddd', '#b8478f', '#d3673a', '#6b8f2a', '#8a5a3c', '#2f8f9d', '#5c6f83'],

    STATES: ['active', 'approval', 'blocked', 'completed', 'interrupted', 'failed'],

    // One colour per harness, so every Claude Code task wears the same
    // pods and every Codex task another. Unknown harnesses fall back to
    // a stable hash of the task id.
    HARNESS_COLORS: {
        'claude-code': '#d97757',
        codex: '#3b7ddd',
        'copilot-cli': '#b8478f',
        opencode: '#1bc548',
        openclaw: '#2f8f9d',
        cursor: '#6b8f2a',
    },

    // The baked sprite sheet. Columns are STATES in order; rows are the
    // HARNESS_COLORS keys in order, once for the dark-theme shell and again
    // for the light-theme shell, because the badge flips its shell tone per
    // theme exactly as the flat SVG does. Re-render with
    // `python3 scripts/render_task_avatar_atlas.py` after touching either list.
    ATLAS_SRC: '/images/task-avatar-atlas.png?v=7',

    // Cells are cut to the FIGURE's aspect, not to a square. The badge box is
    // square but the bot is a wide ovoid, so a square cell spent a third of
    // its height encoding and downloading empty pixels. Both sheets use the
    // same 22:15, so they scale into the same layer box with no distortion.
    ATLAS_CELL_W: 132,
    ATLAS_CELL_H: 92,

    // How wide the sprite is drawn, as a fraction of the badge's layout box.
    // Over 1 on purpose: the figure is drawn a little larger than the box it
    // occupies in layout, the way the halo already paints outside it. The
    // pods are 12% of the figure's width and they carry harness identity, so
    // the alternative (shrinking them to give the head a bigger share) would
    // buy size with the thing that is hardest to read at 18px.
    SPRITE_SCALE: 1.3,

    get ATLAS_COLS() { return this.STATES.length; },
    get ATLAS_THEME_ROWS() { return Object.keys(this.HARNESS_COLORS).length; },
    get ATLAS_ROWS() { return this.ATLAS_THEME_ROWS * 2; },

    // The rotation sheet: the same rows, one column per frame, and only for
    // the one state that means work is happening. It is a second download, so
    // it is fetched lazily and ONLY once an active avatar is actually drawn: a
    // page with no running task never asks for it. Until it arrives (or if it
    // never does) the static active cell is already on screen underneath.
    SPIN_SRC: '/images/task-avatar-spin.png?v=7',
    SPIN_STATE: 'active',
    // Frames over loop seconds is the frame RATE, and that is what decides
    // whether a turn reads as turning or as a series of snaps. Below roughly
    // 12fps the eye sees each change land, so the badge sits still, lurches,
    // and sits still again: that one artefact reads as BOTH jerky and too
    // fast, however unhurried the cycle is. Shrinking the movement does not
    // help, because a small step at 2.5fps is still 2.5fps.
    //
    // Slow and smooth are not in tension, they just both come out of the same
    // equation: a slow loop needs MANY frames. Four seconds at 12fps is 48.
    // The sweep itself stays tiny; the amplitude is what makes it calm.
    SPIN_FRAMES: 48,
    SPIN_DURATION: '4s',   // 12fps
    // 1.5x the largest use, where the static cells are 3x. This sheet only has
    // to convey motion, and motion hides detail; the pixels buy frames.
    SPIN_CELL_W: 66,
    SPIN_CELL_H: 46,
    get SPIN_ROWS() { return this.ATLAS_ROWS; },

    // Which row of the rotation sheet, or null when this badge does not spin.
    // Stillness is the signal that nothing is happening, so every other state
    // stays a single static cell.
    spinCell(harness, state) {
        if (state !== this.SPIN_STATE) return null;
        return this.atlasCell(harness, state);
    },

    // Which cell a badge shows, or null when there is no baked cell. An
    // unknown harness is deliberately null: its colour is a per-id hash, so
    // no finite sheet can hold it and it stays on the flat SVG.
    atlasCell(harness, state) {
        const row = Object.keys(this.HARNESS_COLORS).indexOf(harness);
        if (row < 0) return null;
        const col = this.STATES.indexOf(this.STATES.includes(state) ? state : 'active');
        return { col, row };
    },

    // One <img> decode per document. Until it resolves (or if it never does)
    // nothing is stamped and every badge keeps painting its SVG.
    _ensureAtlas() {
        if (typeof document === 'undefined' || typeof Image === 'undefined') return;
        if (this._atlasPending) return;
        this._atlasPending = true;
        try {
            const img = new Image();
            img.onload = () => {
                const root = document.documentElement;
                if (root && root.setAttribute) root.setAttribute('data-sv-ta-atlas', 'ready');
            };
            img.onerror = () => { /* the SVG below is already on screen */ };
            img.src = this.ATLAS_SRC;
        } catch (_) { /* no atlas, no problem: the SVG stands in */ }
    },

    // Same one-decode-per-document contract for the rotation sheet, but only
    // reached from html() when an active badge is actually being drawn.
    _ensureSpin() {
        if (typeof document === 'undefined' || typeof Image === 'undefined') return;
        if (this._spinPending) return;
        this._spinPending = true;
        try {
            const img = new Image();
            img.onload = () => {
                const root = document.documentElement;
                if (root && root.setAttribute) root.setAttribute('data-sv-ta-spin', 'ready');
            };
            img.onerror = () => { /* the static active cell keeps the badge */ };
            img.src = this.SPIN_SRC;
        } catch (_) { /* no rotation, just a still badge */ }
    },

    color(id, harness) {
        if (harness && this.HARNESS_COLORS[harness]) return this.HARNESS_COLORS[harness];
        const str = String(id || '');
        if (!str) return this.PALETTE[0];
        let hash = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            hash ^= str.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
        const idx = (hash >>> 0) % this.PALETTE.length;
        return this.PALETTE[idx];
    },

    // A stable negative delay keeps a board of agents from bobbing as one
    // mechanical row. It is visual only; harness identity still owns colour.
    _delay(id) {
        const str = String(id || 'task');
        let hash = 0;
        for (let i = 0; i < str.length; i++) hash = ((hash * 31) + str.charCodeAt(i)) | 0;
        return -((Math.abs(hash) % 32) / 10).toFixed(1);
    },

    _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    // Task state -> posture of the figure. Same vocabulary as the Guardian.
    POSTURE: { active: 'idle', approval: 'listening', blocked: 'concerned', failed: 'concerned', completed: 'ok', interrupted: 'idle' },

    // One shared <defs> block per document: the sphere shading, the visor
    // glass, the eye glow and the blur filters. Ids are namespaced "ta-".
    _injectDefs() {
        if (typeof document === 'undefined' || document.getElementById('sv-task-avatar-defs')) return;
        const holder = document.createElement('div');
        holder.innerHTML =
            '<svg id="sv-task-avatar-defs" aria-hidden="true" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden"><defs>' +
            '<radialGradient id="ta-shell-d" cx="36%" cy="30%" r="72%"><stop offset="0" stop-color="#f7fafc"/><stop offset=".55" stop-color="#c2ccd6"/><stop offset="1" stop-color="#6f7c8a"/></radialGradient>' +
            '<radialGradient id="ta-shell-l" cx="36%" cy="30%" r="72%"><stop offset="0" stop-color="#5b6775"/><stop offset=".55" stop-color="#3a4552"/><stop offset="1" stop-color="#1c232c"/></radialGradient>' +
            '<linearGradient id="ta-visor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2430"/><stop offset="1" stop-color="#05080c"/></linearGradient>' +
            '<radialGradient id="ta-eye" cx="50%" cy="45%" r="60%"><stop offset="0" stop-color="#ffffff"/><stop offset=".7" stop-color="#eef6fa"/><stop offset="1" stop-color="#cfe6ee"/></radialGradient>' +
            '<filter id="ta-soft" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.6"/></filter>' +
            '<filter id="ta-glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="2.4"/></filter>' +
            '</defs></svg>';
        (document.body || document.documentElement).appendChild(holder.firstElementChild);
    },

    _injectStyle() {
        if (typeof document === 'undefined' || document.getElementById('sv-task-avatar-style')) return;
        const style = document.createElement('style');
        style.id = 'sv-task-avatar-style';
        const lastCol = this.ATLAS_COLS - 1;
        const lastRow = this.ATLAS_ROWS - 1;
        const themeRows = this.ATLAS_THEME_ROWS;
        const size = 'var(--sv-ta-size, 22px)';
        // The halo is the harness accent the pods already wear, kept low so it
        // reads as presence rather than decoration. Light backgrounds swallow
        // a faint glow, so the light theme mixes stronger rather than shifting
        // hue, the same compromise the floating Guardian makes.
        const halo = () => 'color-mix(in srgb, var(--sv-bot-accent, #5eadb8) var(--sv-ta-mix), transparent)';
        // One box for both sheets, sized to the cell aspect so neither is
        // stretched. Percentages are all relative to the badge's WIDTH, which
        // is what a percentage margin resolves against, so the layer stays
        // centred without a transform the sway would have to fight.
        const lw = this.SPRITE_SCALE * 100;
        const lh = lw * this.ATLAS_CELL_H / this.ATLAS_CELL_W;
        const box = `position: absolute; left: ${((100 - lw) / 2).toFixed(4)}%; width: ${lw.toFixed(4)}%; `
            + `top: 50%; margin-top: ${(-lh / 2).toFixed(4)}%; height: ${lh.toFixed(4)}%;`;
        style.textContent =
            '.sv-task-avatar svg { width: 100%; height: 100%; overflow: visible; display: block; }' +
            '.sv-task-avatar .ta-body { animation: sv-ta-bob 3.2s ease-in-out var(--sv-bot-delay, 0s) infinite; transform-origin: 32px 34px; }' +
            '.sv-task-avatar svg { animation: sv-ta-sway 7s ease-in-out var(--sv-bot-delay, 0s) infinite; transform-origin: 50% 60%; }' +
            '.sv-task-avatar .ta-shadow { fill: rgba(0,0,0,.38); animation: sv-ta-shade 3.2s ease-in-out var(--sv-bot-delay, 0s) infinite; transform-origin: 32px 58px; }' +
            '.sv-task-avatar .ta-head { fill: url(#ta-shell-d); }' +
            '[data-theme="light"] .sv-task-avatar .ta-head { fill: url(#ta-shell-l); }' +
            '[data-theme="light"] .sv-task-avatar .ta-shadow { fill: rgba(20,26,34,.25); }' +
            '.sv-task-avatar .ta-pod { fill: var(--sv-bot-accent, #5eadb8); }' +
            '.sv-task-avatar .ta-sheen { fill: rgba(255,255,255,.55); }' +
            '[data-theme="light"] .sv-task-avatar .ta-sheen { fill: rgba(255,255,255,.18); }' +
            '.sv-task-avatar .ta-visor { fill: url(#ta-visor); }' +
            '.sv-task-avatar .ta-glare { stroke: rgba(255,255,255,.16); stroke-width: 2.4; fill: none; stroke-linecap: round; }' +
            '.sv-task-avatar .ta-halo { fill: var(--sv-bot-accent, #5eadb8); opacity: .55; }' +
            '.sv-task-avatar .ta-eye { fill: url(#ta-eye); }' +
            '.sv-task-avatar .ta-happy { display: none; fill: none; stroke: var(--sv-bot-accent, #5eadb8); stroke-width: 2.6; stroke-linecap: round; }' +
            '.sv-task-avatar-completed .ta-eye, .sv-task-avatar-completed .ta-halo { display: none; }' +
            '.sv-task-avatar-completed .ta-happy { display: block; }' +
            '.sv-task-avatar-blocked .ta-eye, .sv-task-avatar-failed .ta-eye { transform: scaleY(.6); transform-origin: center; transform-box: fill-box; }' +
            '.sv-task-avatar-interrupted { opacity: .55; }' +
            '.sv-task-avatar-interrupted .ta-body, .sv-task-avatar-interrupted svg, .sv-task-avatar-interrupted .ta-shadow { animation: none; }' +
            /* ---- the 3D sprite ------------------------------------------ */
            /* Positioned over the SVG rather than replacing it, so the flat
               figure is what paints during the atlas decode and what stays if
               the decode never finishes. */
            '.sv-task-avatar { position: relative; }' +
            /* Two elements so the sprite can idle the way the SVG does: the
               outer sways, the inner bobs. One element cannot run both, since
               they are different durations writing the same transform. The
               bob is a percentage, not the SVG's 2.4 user units, so it stays
               proportional from 18px to 44px. */
            `.sv-task-avatar .ta-sprite { display: none; ${box} animation: sv-ta-sway 7s ease-in-out var(--sv-bot-delay, 0s) infinite; transform-origin: 50% 60%; }` +
            `.sv-task-avatar .ta-sprite > i { display: block; width: 100%; height: 100%; background-image: url("${this.ATLAS_SRC}"); background-repeat: no-repeat; background-size: ${this.ATLAS_COLS * 100}% ${this.ATLAS_ROWS * 100}%; background-position: calc(var(--ta-col) / ${lastCol} * 100%) calc(var(--ta-row) / ${lastRow} * 100%); animation: sv-ta-bob-sprite 3.2s ease-in-out var(--sv-bot-delay, 0s) infinite; }` +
            `[data-theme="light"] .sv-task-avatar .ta-sprite > i { background-position: calc(var(--ta-col) / ${lastCol} * 100%) calc((var(--ta-row) + ${themeRows}) / ${lastRow} * 100%); }` +
            '@keyframes sv-ta-bob-sprite { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3.8%); } }' +
            '[data-sv-ta-atlas="ready"] .sv-task-avatar-sprite .ta-sprite { display: block; }' +
            '[data-sv-ta-atlas="ready"] .sv-task-avatar-sprite svg { visibility: hidden; }' +
            '.sv-task-avatar-interrupted .ta-sprite, .sv-task-avatar-interrupted .ta-sprite > i { animation: none; }' +
            /* ---- the rotation ------------------------------------------- */
            /* Only the active badge spins, and only once its sheet has loaded.
               The frames are stepped by CSS, never by a script: a rail of
               avatars must not cost a requestAnimationFrame loop each. The
               baked yaw replaces the CSS sway here (two rotations fighting
               read as a wobble), so this layer keeps the bob alone. */
            `.sv-task-avatar .ta-spin { display: none; ${box} animation: sv-ta-bob-sprite 3.2s ease-in-out var(--sv-bot-delay, 0s) infinite; }` +
            `.sv-task-avatar .ta-spin > i { display: block; width: 100%; height: 100%; background-image: url("${this.SPIN_SRC}"); background-repeat: no-repeat; background-size: ${this.SPIN_FRAMES * 100}% ${this.SPIN_ROWS * 100}%; background-position-x: 0%; background-position-y: calc(var(--ta-row) / ${lastRow} * 100%); animation: sv-ta-spin ${this.SPIN_DURATION} steps(${this.SPIN_FRAMES}, end) var(--sv-bot-delay, 0s) infinite; }` +
            `[data-theme="light"] .sv-task-avatar .ta-spin > i { background-position-y: calc((var(--ta-row) + ${themeRows}) / ${lastRow} * 100%); }` +
            /* steps(N, end) over [0, N/(N-1)] lands exactly on k/(N-1) for
               k = 0..N-1, which is frame k and nothing in between. */
            `@keyframes sv-ta-spin { from { background-position-x: 0%; } to { background-position-x: ${(this.SPIN_FRAMES / (this.SPIN_FRAMES - 1) * 100).toFixed(4)}%; } }` +
            '[data-sv-ta-spin="ready"] .sv-task-avatar-spin .ta-spin { display: block; }' +
            '[data-sv-ta-spin="ready"] .sv-task-avatar-spin svg, [data-sv-ta-spin="ready"] .sv-task-avatar-spin .ta-sprite { visibility: hidden; }' +
            /* The flat badge fades the whole element when a task is
               interrupted. Doing that to a shaded 3D render on the near-black
               rail turned it into a muddy blob, so the sprite carries dormancy
               inside the cell instead (eyes at rest, shell a step down) and
               keeps full opacity. */
            '[data-sv-ta-atlas="ready"] .sv-task-avatar-sprite.sv-task-avatar-interrupted { opacity: 1; }' +
            /* ---- the halo ----------------------------------------------- */
            /* Dual drop-shadow, as on the floating Guardian: offset dark for
               depth, zero-offset accent for presence. Both radii scale with
               the badge, since these render from 18px to 44px where the
               floating one is several times larger; a radius tuned for that
               would swamp an 18px badge and blur the face. */
            `.sv-task-avatar { --sv-ta-mix: 34%; --sv-ta-cast: rgba(0,0,0,.42); --sv-ta-halo: ${halo()}; filter: drop-shadow(0 calc(${size} * 0.05) calc(${size} * 0.13) var(--sv-ta-cast)) drop-shadow(0 0 calc(${size} * 0.2) var(--sv-ta-halo)); }` +
            '[data-theme="light"] .sv-task-avatar { --sv-ta-mix: 46%; --sv-ta-cast: rgba(20,26,34,.3); }' +
            /* Only live work looks lit. Blocked, failed and completed have
               finished asking for attention, so they keep depth and drop the
               halo; interrupted keeps a trace of it, which is what makes a
               dormant badge findable on the dark rail. */
            '.sv-task-avatar-blocked, .sv-task-avatar-failed, .sv-task-avatar-completed { --sv-ta-halo: transparent; }' +
            '.sv-task-avatar-interrupted { --sv-ta-mix: 18%; }' +
            '[data-theme="light"] .sv-task-avatar-interrupted { --sv-ta-mix: 26%; }' +
            /* Below 24px the blur filters cost more than they show: flat glow, no shadow. */
            '.sv-task-avatar-tiny .ta-halo { filter: none; opacity: .4; }' +
            '.sv-task-avatar-tiny .ta-shadow, .sv-task-avatar-tiny .ta-sheen { display: none; }' +
            '@keyframes sv-ta-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2.4px); } }' +
            '@keyframes sv-ta-sway { 0%, 100% { transform: rotate(-2.2deg); } 50% { transform: rotate(2.2deg); } }' +
            '@keyframes sv-ta-shade { 0%, 100% { transform: scaleX(1); opacity: 1; } 50% { transform: scaleX(.86); opacity: .7; } }' +
            /* Reduced motion stops the frame stepping too, which leaves
               background-position-x at its declared 0%: one static frame, not
               a badge stuck mid-turn. */
            '@media (prefers-reduced-motion: reduce) { .sv-task-avatar .ta-body, .sv-task-avatar svg, .sv-task-avatar .ta-shadow, .sv-task-avatar .ta-sprite, .sv-task-avatar .ta-sprite > i, .sv-task-avatar .ta-spin, .sv-task-avatar .ta-spin > i { animation: none; } }';
        document.head.appendChild(style);
    },

    // The figure: a sphere head (radial shading), side pods in the task
    // colour, a glossy visor with two glowing eyes. Bob and sway idle.
    _figure() {
        return '<svg viewBox="0 0 64 64">' +
            '<ellipse class="ta-shadow" cx="32" cy="58" rx="14" ry="2.6" filter="url(#ta-soft)"/>' +
            '<g class="ta-body">' +
            '<rect class="ta-pod" x="3" y="27" width="7" height="15" rx="3.5"/>' +
            '<rect class="ta-pod" x="54" y="27" width="7" height="15" rx="3.5"/>' +
            '<circle class="ta-head" cx="32" cy="34" r="24"/>' +
            '<ellipse class="ta-sheen" cx="23" cy="19" rx="10" ry="4.6" filter="url(#ta-soft)"/>' +
            '<rect class="ta-visor" x="13" y="25" width="38" height="20" rx="10"/>' +
            '<path class="ta-glare" d="M19 29c8 -2.6 18 -2.6 26 0"/>' +
            '<ellipse class="ta-halo" cx="24.5" cy="35" rx="4.2" ry="5.4" filter="url(#ta-glow)"/>' +
            '<ellipse class="ta-halo" cx="39.5" cy="35" rx="4.2" ry="5.4" filter="url(#ta-glow)"/>' +
            '<ellipse class="ta-eye" cx="24.5" cy="35" rx="3.3" ry="4.4"/>' +
            '<ellipse class="ta-eye" cx="39.5" cy="35" rx="3.3" ry="4.4"/>' +
            '<path class="ta-happy" d="M20.5 36q4 -4.6 8 0"/>' +
            '<path class="ta-happy" d="M35.5 36q4 -4.6 8 0"/>' +
            '</g></svg>';
    },

    html(opts) {
        const o = opts || {};
        const state = this.STATES.includes(o.state) ? o.state : 'active';
        const size = Number(o.size) > 0 ? Number(o.size) : 22;
        const hue = this.color(o.id, o.harness);
        const hasLabel = o.label != null && o.label !== '';
        const label = this._esc(o.label || '');
        const a11y = hasLabel ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
        this._injectDefs();
        this._injectStyle();
        this._ensureAtlas();
        const tiny = size < 24 ? ' sv-task-avatar-tiny' : '';
        // No baked cell (an unknown harness) means no sprite class, so the
        // flat figure below is the final render and keeps its hashed colour.
        const cell = this.atlasCell(o.harness, state);
        const sprite = cell ? ' sv-task-avatar-sprite' : '';
        const spriteEl = cell
            ? `<i class="ta-sprite" aria-hidden="true" style="--ta-col:${cell.col};--ta-row:${cell.row}"><i></i></i>`
            : '';
        // The rotation sheet is only fetched from here, so it is never
        // downloaded by a page that is not showing a running task.
        const spin = this.spinCell(o.harness, state);
        if (spin) this._ensureSpin();
        const spinEl = spin
            ? `<i class="ta-spin" aria-hidden="true" style="--ta-row:${spin.row}"><i></i></i>`
            : '';
        return `<span class="sv-task-avatar sv-task-avatar-${state} sv-task-avatar-posture-${this.POSTURE[state]}${tiny}${sprite}${spin ? ' sv-task-avatar-spin' : ''}" ${a11y} style="--sv-bot-accent:${hue};--sv-bot-delay:${this._delay(o.id)}s;--sv-ta-size:${size}px;width:${size}px;height:${size}px">` +
            this._figure() + spriteEl + spinEl + '</span>';
    },

    el(opts) {
        const tpl = document.createElement('span');
        tpl.innerHTML = this.html(opts);
        return tpl.firstElementChild;
    },
};

if (typeof window !== 'undefined') window.TaskAvatar = TaskAvatar;
