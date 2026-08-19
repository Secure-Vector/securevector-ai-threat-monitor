/**
 * Guardian Bot — SecureVector's animated sentinel character.
 *
 * An original evolution of the app's existing Guardian robot glyph (the
 * monoline rounded-square head used on Traces and the header): same stroke
 * language, now a full character with a shield body, a visor, and life.
 *
 * Design rules it must never break:
 * - SOC color discipline: the body is neutral; teal is the ONLY accent and
 *   marks activity (visor, antenna). Amber/red are reserved for real
 *   security states and are deliberately not part of this component's
 *   default states.
 * - Motion is ambient, slow and small (a 4s bob, a blink every few seconds,
 *   a visor sweep while scanning). Under prefers-reduced-motion every
 *   animation stops; states still read via static shapes.
 * - Decorative placement is rationed: the bot appears where the app is
 *   DOING something (scanning, empty states inviting a first action,
 *   one-time modals) — never as a standing dashboard ornament.
 *
 * API:
 *   GuardianBot.el({ state: 'idle'|'scan'|'ok', size: 96, label })  -> HTMLElement
 *   GuardianBot.set(el, state)   // flip an existing bot's state in place
 */

const GuardianBot = {
    STATES: ['idle', 'scan', 'ok'],

    el(opts = {}) {
        this._injectStyle();
        const state = this.STATES.includes(opts.state) ? opts.state : 'idle';
        const size = Number(opts.size) || 96;
        const wrap = document.createElement('div');
        wrap.className = 'sv-gbot sv-gbot-' + state;
        wrap.style.width = size + 'px';
        wrap.style.height = Math.round(size * 1.12) + 'px';
        wrap.setAttribute('role', 'img');
        wrap.setAttribute('aria-label', opts.label || 'SecureVector Guardian');
        // One inline SVG, stroke-based like every icon in the app. The head is
        // the established Guardian glyph; the body is a shield — the product.
        wrap.innerHTML =
            '<svg viewBox="0 0 64 72" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
            // ground shadow (its own layer so the bob can play against it)
            '<ellipse class="gb-shadow" cx="32" cy="67" rx="14" ry="3"/>' +
            '<g class="gb-body">' +
            // antenna + pulsing tip
            '<line class="gb-line" x1="32" y1="8" x2="32" y2="13"/>' +
            '<circle class="gb-tip" cx="32" cy="6" r="2.6"/>' +
            // head: the Guardian glyph, grown up
            '<rect class="gb-line" x="14" y="13" width="36" height="26" rx="7"/>' +
            // ears
            '<line class="gb-line" x1="10" y1="22" x2="10" y2="30"/>' +
            '<line class="gb-line" x1="54" y1="22" x2="54" y2="30"/>' +
            // visor slot (dark, so the white eyes carry the face)
            '<rect class="gb-visor" x="19" y="19" width="26" height="14" rx="7"/>' +
            // idle/scan eyes: white and round, with pupils that look around
            '<g class="gb-eye gb-eye-l"><circle class="gb-white" cx="27" cy="26" r="3.4"/>' +
            '<circle class="gb-pupil" cx="27" cy="26" r="1.4"/></g>' +
            '<g class="gb-eye gb-eye-r"><circle class="gb-white" cx="37" cy="26" r="3.4"/>' +
            '<circle class="gb-pupil" cx="37" cy="26" r="1.4"/></g>' +
            // ok eyes (happy arcs, only in ok state)
            '<path class="gb-happy" d="M24 27q3 -3.6 6 0"/>' +
            '<path class="gb-happy" d="M34 27q3 -3.6 6 0"/>' +
            // scan beam (sweeps the visor, only in scan state)
            '<line class="gb-beam" x1="23" y1="21.5" x2="23" y2="30.5"/>' +
            // shield body
            '<path class="gb-line gb-shield" d="M20 44l12 -3l12 3v7c0 7 -5.5 11.5 -12 14c-6.5 -2.5 -12 -7 -12 -14z"/>' +
            // shield keel (the product mark's center line)
            '<line class="gb-line gb-keel" x1="32" y1="46" x2="32" y2="60"/>' +
            '</g></svg>';
        return wrap;
    },

    set(el, state) {
        if (!el || !this.STATES.includes(state)) return;
        this.STATES.forEach(s => el.classList.remove('sv-gbot-' + s));
        el.classList.add('sv-gbot-' + state);
    },

    _injectStyle() {
        if (document.getElementById('sv-guardian-bot-style')) return;
        const st = document.createElement('style');
        st.id = 'sv-guardian-bot-style';
        st.textContent = `
.sv-gbot { display: inline-block; flex-shrink: 0; }
.sv-gbot svg { width: 100%; height: 100%; overflow: visible; }
.sv-gbot .gb-line { stroke: var(--text-secondary, #aeb7c2); stroke-width: 2.4; }
.sv-gbot .gb-shadow { fill: color-mix(in srgb, var(--text-muted, #7f8a97) 22%, transparent); }
.sv-gbot .gb-visor { stroke: var(--text-secondary, #aeb7c2); stroke-width: 2;
  fill: #141a22; }
.sv-gbot .gb-tip { fill: var(--accent-primary, #5eadb8); }
.sv-gbot .gb-white { fill: #f4f7fa; }
.sv-gbot .gb-pupil { fill: #141a22; }
.sv-gbot .gb-happy { stroke: #f4f7fa; stroke-width: 2.6; }
.sv-gbot .gb-beam { stroke: var(--accent-primary, #5eadb8); stroke-width: 2.6; opacity: 0.9; }
.sv-gbot .gb-keel { stroke-width: 2; opacity: 0.55; }

/* state visibility: dots for idle/scan-off, arcs for ok, beam for scan */
.sv-gbot .gb-happy { display: none; }
.sv-gbot .gb-beam { display: none; }
.sv-gbot-ok .gb-eye { display: none; }
.sv-gbot-ok .gb-happy { display: block; }
.sv-gbot-scan .gb-beam { display: block; mix-blend-mode: screen; }

@media (prefers-reduced-motion: no-preference) {
  .sv-gbot .gb-body { animation: gb-bob 4s ease-in-out infinite; transform-origin: 32px 40px; }
  .sv-gbot .gb-shadow { animation: gb-shade 4s ease-in-out infinite; transform-origin: 32px 67px; }
  .sv-gbot .gb-tip { animation: gb-pulse 2.6s ease-in-out infinite; }
  .sv-gbot-idle .gb-eye, .sv-gbot-scan .gb-eye { animation: gb-blink 5.2s infinite; transform-origin: center; transform-box: fill-box; }
  .sv-gbot .gb-pupil { animation: gb-wander 7s ease-in-out infinite; }
  .sv-gbot .gb-eye-r .gb-pupil { animation-delay: 0.06s; }
  .sv-gbot-scan .gb-beam { animation: gb-sweep 1.6s ease-in-out infinite; }
  .sv-gbot-scan .gb-tip { animation: gb-pulse 0.9s ease-in-out infinite; }
  .sv-gbot-ok .gb-body { animation: gb-bob 4s ease-in-out infinite, gb-nod 0.9s ease-in-out 1; }
}
@keyframes gb-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2.5px); } }
@keyframes gb-shade { 0%, 100% { transform: scaleX(1); opacity: 1; } 50% { transform: scaleX(0.88); opacity: 0.75; } }
@keyframes gb-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@keyframes gb-blink { 0%, 91%, 100% { transform: scaleY(1); } 94% { transform: scaleY(0.12); } 97% { transform: scaleY(1); } }
/* the pupils look around: right, hold, left, up, back to center */
@keyframes gb-wander {
  0%, 18%, 100% { transform: translate(0, 0); }
  24%, 38% { transform: translate(1.1px, 0.2px); }
  46%, 60% { transform: translate(-1.1px, 0.3px); }
  70%, 80% { transform: translate(0.2px, -0.9px); }
}
@keyframes gb-sweep { 0%, 100% { transform: translateX(0); } 50% { transform: translateX(18px); } }
@keyframes gb-nod { 0%, 100% { transform: translateY(0); } 40% { transform: translateY(-5px); } 70% { transform: translateY(-1px); } }
`;
        document.head.appendChild(st);
    },
};

window.GuardianBot = GuardianBot;
