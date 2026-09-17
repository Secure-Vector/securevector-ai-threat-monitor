// Task Avatar — the Guardian figure in miniature on a round badge in the task
// hue, identifying one agent task across the rail and the Agent Tasks board.
// Same proportions as the Guardian bot (head rounded to about a third of its
// height, a side pod each ear, a top-left sheen, a dark glass visor and two
// LED eyes), drawn fresh rather than by reusing the bot's markup.
// Colour is task identity (a stable hash of the task id into an eight-colour
// palette that excludes red/amber/green, those stay reserved for state);
// state is carried by a ring around the badge and by the eyes, matching the
// task-row and task-card state vocabulary already used elsewhere (active,
// approval, blocked, completed, interrupted, failed). The eyes are static:
// nothing here blinks, wanders or breathes.

const TaskAvatar = {
    PALETTE: ['#7b61ff', '#3b7ddd', '#b8478f', '#d3673a', '#6b8f2a', '#8a5a3c', '#2f8f9d', '#5c6f83'],

    STATES: ['active', 'approval', 'blocked', 'completed', 'interrupted', 'failed'],

    color(id) {
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

    _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    html(opts) {
        const o = opts || {};
        const state = this.STATES.includes(o.state) ? o.state : 'active';
        const size = Number(o.size) > 0 ? Number(o.size) : 22;
        const hue = this.color(o.id);
        const hasLabel = o.label != null && o.label !== '';
        const label = this._esc(o.label || '');
        const a11y = hasLabel ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
        return `<span class="sv-task-avatar sv-task-avatar-${state}" ${a11y} style="--sv-task-hue:${hue};width:${size}px;height:${size}px">` +
            `<svg viewBox="0 0 24 24">` +
            `<circle class="sv-ta-tile" cx="12" cy="12" r="11"/>` +
            `<rect class="sv-ta-pod" x="2.4" y="10" width="2.2" height="5.2" rx="1.1"/>` +
            `<rect class="sv-ta-pod" x="19.4" y="10" width="2.2" height="5.2" rx="1.1"/>` +
            `<rect class="sv-ta-head" x="4.6" y="5.8" width="14.8" height="12.4" rx="5.6"/>` +
            `<ellipse class="sv-ta-sheen" cx="9.6" cy="7.9" rx="3.8" ry="1.25"/>` +
            `<rect class="sv-ta-visor" x="6.6" y="8.6" width="10.8" height="7.2" rx="3.6"/>` +
            `<ellipse class="sv-ta-eye" cx="9.85" cy="12.2" rx="1.25" ry="1.7"/>` +
            `<ellipse class="sv-ta-eye" cx="14.15" cy="12.2" rx="1.25" ry="1.7"/>` +
            `<path class="sv-ta-happy" d="M8.45 12.7q1.4 -1.9 2.8 0"/>` +
            `<path class="sv-ta-happy" d="M12.75 12.7q1.4 -1.9 2.8 0"/>` +
            `<circle class="sv-ta-err" cx="19" cy="5" r="3.4"/>` +
            `<rect class="sv-ta-err" x="18.4" y="2.9" width="1.2" height="2.6" rx=".6"/>` +
            `<rect class="sv-ta-err" x="18.4" y="6.1" width="1.2" height="1.2" rx=".6"/>` +
            `</svg>` +
            `</span>`;
    },

    el(opts) {
        const tpl = document.createElement('span');
        tpl.innerHTML = this.html(opts);
        return tpl.firstElementChild;
    },
};

if (typeof window !== 'undefined') window.TaskAvatar = TaskAvatar;
