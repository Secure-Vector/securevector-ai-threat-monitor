// Task Avatar — the Guardian figure in miniature on a round badge in the task
// hue, identifying one agent task across the rail and the Agent Tasks board.
// Same proportions as the Guardian bot (head rounded to about a third of its
// height, a side pod each ear, a top-left sheen, a dark glass visor and two
// LED eyes), drawn fresh rather than by reusing the bot's markup.
// Colour is harness identity; a stable task-id hash is used only for an
// unknown harness. State is carried by the eyes, matching the
// task-row and task-card state vocabulary already used elsewhere (active,
// approval, blocked, completed, interrupted, failed). The eyes are static:
// nothing here blinks, wanders or breathes.

const TaskAvatar = {
    PALETTE: ['#7b61ff', '#3b7ddd', '#b8478f', '#d3673a', '#6b8f2a', '#8a5a3c', '#2f8f9d', '#5c6f83'],

    STATES: ['active', 'approval', 'blocked', 'completed', 'interrupted', 'failed'],

    // One colour per harness, so every Claude Code task wears the same
    // pods and every Codex task another. Unknown harnesses fall back to
    // a stable hash of the task id.
    HARNESS_COLORS: {
        'claude-code': '#7b61ff',
        codex: '#3b7ddd',
        'copilot-cli': '#b8478f',
        opencode: '#d3673a',
        openclaw: '#2f8f9d',
        cursor: '#6b8f2a',
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
            /* Below 24px the blur filters cost more than they show: flat glow, no shadow. */
            '.sv-task-avatar-tiny .ta-halo { filter: none; opacity: .4; }' +
            '.sv-task-avatar-tiny .ta-shadow, .sv-task-avatar-tiny .ta-sheen { display: none; }' +
            '@keyframes sv-ta-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2.4px); } }' +
            '@keyframes sv-ta-sway { 0%, 100% { transform: rotate(-2.2deg); } 50% { transform: rotate(2.2deg); } }' +
            '@keyframes sv-ta-shade { 0%, 100% { transform: scaleX(1); opacity: 1; } 50% { transform: scaleX(.86); opacity: .7; } }' +
            '@media (prefers-reduced-motion: reduce) { .sv-task-avatar .ta-body, .sv-task-avatar svg, .sv-task-avatar .ta-shadow { animation: none; } }';
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
        const tiny = size < 24 ? ' sv-task-avatar-tiny' : '';
        return `<span class="sv-task-avatar sv-task-avatar-${state} sv-task-avatar-posture-${this.POSTURE[state]}${tiny}" ${a11y} style="--sv-bot-accent:${hue};--sv-bot-delay:${this._delay(o.id)}s;width:${size}px;height:${size}px">` +
            this._figure() + '</span>';
    },

    el(opts) {
        const tpl = document.createElement('span');
        tpl.innerHTML = this.html(opts);
        return tpl.firstElementChild;
    },
};

if (typeof window !== 'undefined') window.TaskAvatar = TaskAvatar;
