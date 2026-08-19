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

    /** One hidden SVG with every gradient/filter, injected once — SVG url()
     *  references resolve document-wide, so N bots share one set of defs
     *  instead of duplicating gradient nodes per instance. */
    _injectDefs() {
        if (document.getElementById('sv-gbot-defs')) return;
        const host = document.createElement('div');
        host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;';
        host.innerHTML =
            '<svg id="sv-gbot-defs" aria-hidden="true"><defs>' +
            // head: lit from the upper left, falling into shadow lower right
            '<linearGradient id="gb3d-head" x1="0" y1="0" x2="0.6" y2="1">' +
            '<stop offset="0" stop-color="#4a5462"/><stop offset="0.55" stop-color="#333c48"/>' +
            '<stop offset="1" stop-color="#212831"/></linearGradient>' +
            // shield body: slightly darker range than the head
            '<linearGradient id="gb3d-shield" x1="0" y1="0" x2="0.5" y2="1">' +
            '<stop offset="0" stop-color="#3d4653"/><stop offset="1" stop-color="#1a212a"/>' +
            '</linearGradient>' +
            // visor: near-black glass with a cool bottom bounce
            '<linearGradient id="gb3d-visor" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="#0a0e14"/><stop offset="0.75" stop-color="#10161e"/>' +
            '<stop offset="1" stop-color="#1a2430"/></linearGradient>' +
            // eyes: white spheres
            '<radialGradient id="gb3d-eye" cx="0.35" cy="0.3" r="1">' +
            '<stop offset="0" stop-color="#ffffff"/><stop offset="0.7" stop-color="#e8edf2"/>' +
            '<stop offset="1" stop-color="#c3ccd6"/></radialGradient>' +
            // antenna tip: teal core with falloff
            '<radialGradient id="gb3d-tip" cx="0.4" cy="0.35" r="1">' +
            '<stop offset="0" stop-color="#9fd8de"/><stop offset="0.5" stop-color="#5eadb8"/>' +
            '<stop offset="1" stop-color="#39707a"/></radialGradient>' +
            // soft blur for the ground shadow + the antenna glow halo
            '<filter id="gb3d-soft" x="-60%" y="-60%" width="220%" height="220%">' +
            '<feGaussianBlur stdDeviation="1.6"/></filter>' +
            '<filter id="gb3d-glow" x="-120%" y="-120%" width="340%" height="340%">' +
            '<feGaussianBlur stdDeviation="2.4"/></filter>' +
            '</defs></svg>';
        document.body.appendChild(host);
    },

    el(opts = {}) {
        this._injectStyle();
        this._injectDefs();
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
        // Shaded solid forms (volume from gradients, speculars for gloss),
        // arranged back-to-front. The silhouette is unchanged from the flat
        // version: antenna, visor head with ears, shield body.
        wrap.innerHTML =
            '<svg viewBox="0 0 64 72" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
            // ground shadow (blurred; its own layer so the bob plays against it)
            '<ellipse class="gb-shadow" cx="32" cy="67" rx="12.5" ry="2.5" filter="url(#gb3d-soft)"/>' +
            '<g class="gb-body">' +
            // antenna: short and cute, with a glowing teal bead
            '<line x1="32" y1="10.5" x2="32" y2="14.5" stroke="#4a5462" stroke-width="2.2"/>' +
            '<circle class="gb-tip-halo" cx="32" cy="8" r="3.2" fill="#5eadb8" filter="url(#gb3d-glow)"/>' +
            '<circle class="gb-tip" cx="32" cy="8" r="2.5" fill="url(#gb3d-tip)"/>' +
            // ears: soft pods tucked against the head
            '<rect x="8.5" y="22.5" width="5" height="11" rx="2.5" fill="url(#gb3d-shield)"/>' +
            '<rect x="50.5" y="22.5" width="5" height="11" rx="2.5" fill="url(#gb3d-shield)"/>' +
            // head: a soft capsule, lit from the upper left
            '<rect x="13" y="14" width="38" height="28" rx="13" fill="url(#gb3d-head)"/>' +
            // key-light sheen: a big soft highlight hugging the top curve
            '<ellipse cx="26" cy="18.5" rx="12" ry="4" fill="rgba(255,255,255,0.13)" filter="url(#gb3d-soft)"/>' +
            // cool rim bounce on the right edge (screen light)
            '<path d="M48.5 21c1.6 2.6 1.6 9.4 0 12" stroke="rgba(94,173,184,0.35)" stroke-width="1.6"/>' +
            // visor: one wide glass capsule, the face lives inside it
            '<rect class="gb-visor" x="17.5" y="20" width="29" height="16" rx="8" fill="url(#gb3d-visor)"/>' +
            // glass glare: an angled streak across the visor's top
            '<path d="M22 23.5c6.5 -2 13.5 -2 20 0" stroke="rgba(255,255,255,0.16)" stroke-width="2.4"/>' +
            // eyes: big white spheres with pin-light speculars
            '<g class="gb-eye gb-eye-l"><circle cx="26" cy="28" r="4.1" fill="url(#gb3d-eye)"/>' +
            '<g class="gb-pupil"><circle cx="26" cy="28" r="1.7" fill="#10161e"/>' +
            '<circle cx="26.7" cy="27.3" r="0.6" fill="#ffffff"/></g></g>' +
            '<g class="gb-eye gb-eye-r"><circle cx="38" cy="28" r="4.1" fill="url(#gb3d-eye)"/>' +
            '<g class="gb-pupil"><circle cx="38" cy="28" r="1.7" fill="#10161e"/>' +
            '<circle cx="38.7" cy="27.3" r="0.6" fill="#ffffff"/></g></g>' +
            // ok eyes (happy arcs, only in ok state)
            '<path class="gb-happy" d="M22.5 29q3.5 -4.2 7 0"/>' +
            '<path class="gb-happy" d="M34.5 29q3.5 -4.2 7 0"/>' +
            // scan beam (sweeps the visor, only in scan state)
            '<g class="gb-beam"><line x1="22" y1="22.5" x2="22" y2="33.5" stroke="#5eadb8" ' +
            'stroke-width="4.5" opacity="0.5" filter="url(#gb3d-glow)"/>' +
            '<line x1="22" y1="22.5" x2="22" y2="33.5" stroke="#bfe6ea" stroke-width="1.8"/></g>' +
            // shield body: soft-shouldered, with a lit crest and keel
            '<path d="M20.5 45.5q11.5 -4.6 23 0v6.5c0 7 -5.3 11.3 -11.5 13.8c-6.2 -2.5 -11.5 -6.8 -11.5 -13.8z" fill="url(#gb3d-shield)"/>' +
            '<path d="M21.5 45.2q10.5 -4 21 0" stroke="rgba(255,255,255,0.22)" stroke-width="1.4" fill="none"/>' +
            '<line x1="32" y1="47.5" x2="32" y2="61.5" stroke="rgba(255,255,255,0.16)" stroke-width="1.8"/>' +
            // neck shadow: the head sits ON the body (ambient occlusion)
            '<ellipse cx="32" cy="43.6" rx="8" ry="1.5" fill="rgba(0,0,0,0.30)" filter="url(#gb3d-soft)"/>' +
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
.sv-gbot { display: inline-block; flex-shrink: 0; perspective: 260px; }
.sv-gbot svg { width: 100%; height: 100%; overflow: visible; transform-style: preserve-3d; }
.sv-gbot .gb-shadow { fill: rgba(0, 0, 0, 0.38); }
.sv-gbot .gb-happy { stroke: #f4f7fa; stroke-width: 2.6; }
.sv-gbot .gb-beam line { stroke-linecap: round; }

/* state visibility: spheres for idle/scan, arcs for ok, beam for scan */
.sv-gbot .gb-happy { display: none; }
.sv-gbot .gb-beam { display: none; }
.sv-gbot-ok .gb-eye { display: none; }
.sv-gbot-ok .gb-happy { display: block; }
.sv-gbot-scan .gb-beam { display: block; }

@media (prefers-reduced-motion: no-preference) {
  /* the 3D read: a slow perspective sway on the whole figure, and the body
     bobbing against its ground shadow */
  .sv-gbot svg { animation: gb-sway 9s ease-in-out infinite; }
  .sv-gbot .gb-body { animation: gb-bob 4s ease-in-out infinite; transform-origin: 32px 40px; }
  .sv-gbot .gb-shadow { animation: gb-shade 4s ease-in-out infinite; transform-origin: 32px 67px; }
  .sv-gbot .gb-tip-halo { animation: gb-pulse 2.6s ease-in-out infinite; }
  .sv-gbot-idle .gb-eye, .sv-gbot-scan .gb-eye { animation: gb-blink 5.2s infinite; transform-origin: center; transform-box: fill-box; }
  .sv-gbot .gb-pupil { animation: gb-wander 7s ease-in-out infinite; }
  .sv-gbot .gb-eye-r .gb-pupil { animation-delay: 0.06s; }
  .sv-gbot-scan .gb-beam { animation: gb-sweep 1.6s ease-in-out infinite; }
  .sv-gbot-scan .gb-tip-halo { animation: gb-pulse 0.9s ease-in-out infinite; }
  .sv-gbot-ok .gb-body { animation: gb-bob 4s ease-in-out infinite, gb-nod 0.9s ease-in-out 1; }
}
@keyframes gb-sway { 0%, 100% { transform: rotateY(-7deg); } 50% { transform: rotateY(7deg); } }
@keyframes gb-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2.5px); } }
@keyframes gb-shade { 0%, 100% { transform: scaleX(1); opacity: 1; } 50% { transform: scaleX(0.86); opacity: 0.7; } }
@keyframes gb-pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 0.9; } }
@keyframes gb-blink { 0%, 91%, 100% { transform: scaleY(1); } 94% { transform: scaleY(0.12); } 97% { transform: scaleY(1); } }
/* the pupils look around: right, hold, left, up, back to center */
@keyframes gb-wander {
  0%, 18%, 100% { transform: translate(0, 0); }
  24%, 38% { transform: translate(1.2px, 0.2px); }
  46%, 60% { transform: translate(-1.2px, 0.3px); }
  70%, 80% { transform: translate(0.2px, -1px); }
}
@keyframes gb-sweep { 0%, 100% { transform: translateX(0); } 50% { transform: translateX(20px); } }
@keyframes gb-nod { 0%, 100% { transform: translateY(0); } 40% { transform: translateY(-5px); } 70% { transform: translateY(-1px); } }
`;
        document.head.appendChild(st);
    },
};

window.GuardianBot = GuardianBot;
