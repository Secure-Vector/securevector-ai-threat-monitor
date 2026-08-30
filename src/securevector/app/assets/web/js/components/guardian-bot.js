/**
 * Guardian Bot — SecureVector's animated sentinel character.
 *
 * An original evolution of the app's existing Guardian robot glyph (the
 * monoline rounded-square head used on Traces and the header): same stroke
 * language, head-only like the 3D Guardian: a visor head with ears, alive.
 *
 * Design rules it must never break:
 * - SOC color discipline: the body is neutral; teal is the ONLY accent and
 *   marks activity (visor, scan beam). Amber/red are reserved for real
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
 *   GuardianBot.el({ state, size: 96, label })  -> HTMLElement
 *   GuardianBot.set(el, state)   // flip an existing bot's state in place
 *
 * States are the same five names the 3D Guardian carries, so whatever a
 * state expresses there survives when WebGL is unavailable. Each one is
 * legible from static shape alone — no state depends on animation, and no
 * state depends on hue, because colour here means security state only:
 *   idle       resting pose
 *   scan       visor beam
 *   listening  head tilt
 *   concerned  narrowed eyes, leaning in
 *   ok         happy arcs
 */

const GuardianBot = {
    STATES: ['idle', 'scan', 'listening', 'concerned', 'ok'],

    /** One hidden SVG with every gradient/filter, injected once — SVG url()
     *  references resolve document-wide, so N bots share one set of defs
     *  instead of duplicating gradient nodes per instance. */
    _injectDefs() {
        if (document.getElementById('sv-gbot-defs')) return;
        const host = document.createElement('div');
        host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;';
        host.innerHTML =
            '<svg id="sv-gbot-defs" aria-hidden="true"><defs>' +
            // head + shield, DARK body palette (used on the light theme)
            '<linearGradient id="gb3d-head-d" x1="0" y1="0" x2="0.6" y2="1">' +
            '<stop offset="0" stop-color="#4a5462"/><stop offset="0.55" stop-color="#333c48"/>' +
            '<stop offset="1" stop-color="#212831"/></linearGradient>' +
            '<linearGradient id="gb3d-shield-d" x1="0" y1="0" x2="0.5" y2="1">' +
            '<stop offset="0" stop-color="#3d4653"/><stop offset="1" stop-color="#1a212a"/>' +
            '</linearGradient>' +
            // head + shield, LIGHT body palette (used on the dark themes)
            '<linearGradient id="gb3d-head-l" x1="0" y1="0" x2="0.6" y2="1">' +
            '<stop offset="0" stop-color="#fbfdfe"/><stop offset="0.55" stop-color="#dde4eb"/>' +
            '<stop offset="1" stop-color="#b7c2cd"/></linearGradient>' +
            '<linearGradient id="gb3d-shield-l" x1="0" y1="0" x2="0.5" y2="1">' +
            '<stop offset="0" stop-color="#e9eef3"/><stop offset="1" stop-color="#a9b6c2"/>' +
            '</linearGradient>' +
            // visor: near-black glass with a cool bottom bounce
            '<linearGradient id="gb3d-visor" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="#0a0e14"/><stop offset="0.75" stop-color="#10161e"/>' +
            '<stop offset="1" stop-color="#1a2430"/></linearGradient>' +
            // eyes: soft glowing LED ovals (no pupil contrast — friendly)
            '<radialGradient id="gb3d-eye" cx="0.5" cy="0.42" r="0.75">' +
            '<stop offset="0" stop-color="#ffffff"/><stop offset="0.65" stop-color="#eef4f8"/>' +
            '<stop offset="1" stop-color="#cfdbe4"/></radialGradient>' +
            // soft blur for the ground shadow + the scan-beam glow
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
        wrap.style.height = Math.round(size * 0.78) + 'px';
        wrap.setAttribute('role', 'img');
        wrap.setAttribute('aria-label', opts.label || 'SecureVector Guardian');
        // One inline SVG, stroke-based like every icon in the app. Head-only,
        // matching the 3D Guardian: visor head with ears, no antenna, no
        // jewel, no torso. Shaded solid forms (volume from gradients,
        // speculars for gloss), arranged back-to-front.
        wrap.innerHTML =
            '<svg viewBox="4 11 56 42" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
            // ground shadow (blurred; its own layer so the bob plays against it)
            '<ellipse class="gb-shadow" cx="32" cy="48.5" rx="13" ry="2.4" filter="url(#gb3d-soft)"/>' +
            '<g class="gb-body">' +
            // ears: soft pods tucked against the head
            '<rect class="gb-pod" x="8.5" y="22.5" width="5" height="11" rx="2.5"/>' +
            '<rect class="gb-pod" x="50.5" y="22.5" width="5" height="11" rx="2.5"/>' +
            // head: a soft capsule, lit from the upper left
            '<rect class="gb-head" x="13" y="14" width="38" height="28" rx="13"/>' +
            // key-light sheen: a big soft highlight hugging the top curve
            '<ellipse class="gb-sheen" cx="26" cy="18.5" rx="12" ry="4" filter="url(#gb3d-soft)"/>' +
            // cool rim bounce on the right edge (screen light)
            '<path class="gb-arc" d="M48.5 21c1.6 2.6 1.6 9.4 0 12" stroke="rgba(94,173,184,0.35)" stroke-width="1.6"/>' +
            // visor: one wide glass capsule, the face lives inside it
            '<rect class="gb-visor" x="17.5" y="20" width="29" height="16" rx="8" fill="url(#gb3d-visor)"/>' +
            // glass glare: an angled streak across the visor's top
            '<path d="M22 23.5c6.5 -2 13.5 -2 20 0" stroke="rgba(255,255,255,0.16)" stroke-width="2.4"/>' +
            // eyes: tall glowing ovals, softly haloed — expressive, never staring
            '<g class="gb-eye gb-eye-l"><g class="gb-look">' +
            '<ellipse cx="26" cy="28" rx="3.1" ry="4" fill="#eef4f8" opacity="0.35" filter="url(#gb3d-soft)"/>' +
            '<ellipse cx="26" cy="28" rx="2.7" ry="3.6" fill="url(#gb3d-eye)"/></g></g>' +
            '<g class="gb-eye gb-eye-r"><g class="gb-look">' +
            '<ellipse cx="38" cy="28" rx="3.1" ry="4" fill="#eef4f8" opacity="0.35" filter="url(#gb3d-soft)"/>' +
            '<ellipse cx="38" cy="28" rx="2.7" ry="3.6" fill="url(#gb3d-eye)"/></g></g>' +
            // ok eyes (happy arcs, only in ok state)
            '<path class="gb-happy" d="M22.5 29q3.5 -4.2 7 0"/>' +
            '<path class="gb-happy" d="M34.5 29q3.5 -4.2 7 0"/>' +
            // scan beam (sweeps the visor, only in scan state)
            '<g class="gb-beam"><line x1="22" y1="22.5" x2="22" y2="33.5" stroke="#5eadb8" ' +
            'stroke-width="4.5" opacity="0.5" filter="url(#gb3d-glow)"/>' +
            '<line x1="22" y1="22.5" x2="22" y2="33.5" stroke="#bfe6ea" stroke-width="1.8"/></g>' +
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
/* Theme-adaptive body: light (white) figure on the dark themes for contrast,
   dark figure on the light theme. The visor stays dark glass in both so the
   glowing eyes always have a home. */
.sv-gbot .gb-head { fill: url(#gb3d-head-l); }
.sv-gbot .gb-pod { fill: url(#gb3d-shield-l); }
.sv-gbot .gb-sheen { fill: rgba(255, 255, 255, 0.5); }
[data-theme="light"] .sv-gbot .gb-head { fill: url(#gb3d-head-d); }
[data-theme="light"] .sv-gbot .gb-pod { fill: url(#gb3d-shield-d); }
[data-theme="light"] .sv-gbot .gb-sheen { fill: rgba(255, 255, 255, 0.13); }
[data-theme="light"] .sv-gbot .gb-shadow { fill: rgba(20, 26, 34, 0.25); }
.sv-gbot .gb-happy { stroke: #f4f7fa; stroke-width: 2.6; }
.sv-gbot .gb-beam line { stroke-linecap: round; }

/* Accent: the bot's personal color, chosen in the Guardian panel and stamped
   as data-bot-accent on <html>. Scoped to the bot on purpose: the app's UI
   accent stays teal (SOC color discipline), only the mascot dresses up.
   Every accent carries a light-theme shade so contrast survives the switch. */
:root { --sv-bot-accent: #5eadb8; --sv-bot-accent-soft: rgba(94, 173, 184, 0.35); }
[data-theme="light"] { --sv-bot-accent: #2b8a97; --sv-bot-accent-soft: rgba(43, 138, 151, 0.4); }
[data-bot-accent="azure"] { --sv-bot-accent: #6aa6ff; --sv-bot-accent-soft: rgba(106, 166, 255, 0.35); }
[data-theme="light"][data-bot-accent="azure"] { --sv-bot-accent: #2e6fd8; --sv-bot-accent-soft: rgba(46, 111, 216, 0.4); }
[data-bot-accent="violet"] { --sv-bot-accent: #a78bfa; --sv-bot-accent-soft: rgba(167, 139, 250, 0.35); }
[data-theme="light"][data-bot-accent="violet"] { --sv-bot-accent: #7c5cd6; --sv-bot-accent-soft: rgba(124, 92, 214, 0.4); }
[data-bot-accent="rose"] { --sv-bot-accent: #f27fa5; --sv-bot-accent-soft: rgba(242, 127, 165, 0.35); }
[data-theme="light"][data-bot-accent="rose"] { --sv-bot-accent: #d64f7e; --sv-bot-accent-soft: rgba(214, 79, 126, 0.4); }
[data-bot-accent="amber"] { --sv-bot-accent: #e8b45a; --sv-bot-accent-soft: rgba(232, 180, 90, 0.35); }
[data-theme="light"][data-bot-accent="amber"] { --sv-bot-accent: #b97f1f; --sv-bot-accent-soft: rgba(185, 127, 31, 0.4); }
[data-bot-accent="jade"] { --sv-bot-accent: #63c493; --sv-bot-accent-soft: rgba(99, 196, 147, 0.35); }
[data-theme="light"][data-bot-accent="jade"] { --sv-bot-accent: #2f9d64; --sv-bot-accent-soft: rgba(47, 157, 100, 0.4); }
.sv-gbot .gb-arc { stroke: var(--sv-bot-accent-soft, rgba(94, 173, 184, 0.35)); }
.sv-gbot .gb-beam line:first-child { stroke: var(--sv-bot-accent, #5eadb8); }
/* A chosen accent must be SEEN. When the stamp is present the pods and the
   eye halos wear it (after the theme rules on purpose: same specificity,
   source order decides). No stamp keeps the classic neutral figure. */
[data-bot-accent] .sv-gbot .gb-pod { fill: var(--sv-bot-accent); }
[data-bot-accent] .sv-gbot .gb-eye ellipse:first-child { fill: var(--sv-bot-accent); }
[data-bot-accent] .sv-gbot .gb-happy { stroke: var(--sv-bot-accent); }

/* state visibility: spheres for idle/scan, arcs for ok, beam for scan */
.sv-gbot .gb-happy { display: none; }
.sv-gbot .gb-beam { display: none; }
.sv-gbot-ok .gb-eye { display: none; }
.sv-gbot-ok .gb-happy { display: block; }
.sv-gbot-scan .gb-beam { display: block; }
/* listening: the head tilts. Static transform, so it survives
   prefers-reduced-motion and reads with every animation stopped. */
.sv-gbot-listening .gb-body { transform: rotate(-7deg); transform-origin: 32px 34px; }
/* concerned: leans in and narrows its eyes. Posture and shape only —
   no red, no glow, nothing that borrows the palette reserved for
   real security state. */
.sv-gbot-concerned .gb-body { transform: translateY(1px) scale(1.03); transform-origin: 32px 40px; }
.sv-gbot-concerned .gb-eye ellipse { transform: scaleY(0.6); transform-origin: center; transform-box: fill-box; }

@media (prefers-reduced-motion: no-preference) {
  /* the 3D read: a slow perspective sway on the whole figure, and the body
     bobbing against its ground shadow */
  .sv-gbot svg { animation: gb-sway 9s ease-in-out infinite; }
  .sv-gbot .gb-body { animation: gb-bob 4s ease-in-out infinite; transform-origin: 32px 28px; }
  .sv-gbot .gb-shadow { animation: gb-shade 4s ease-in-out infinite; transform-origin: 32px 48.5px; }
  .sv-gbot-idle .gb-eye, .sv-gbot-scan .gb-eye { animation: gb-blink 5.2s infinite; transform-origin: center; transform-box: fill-box; }
  .sv-gbot .gb-look { animation: gb-wander 7s ease-in-out infinite; }
  .sv-gbot .gb-eye-r .gb-look { animation-delay: 0.06s; }
  .sv-gbot-scan .gb-beam { animation: gb-sweep 1.6s ease-in-out infinite; }
  .sv-gbot-ok .gb-body { animation: gb-bob 4s ease-in-out infinite, gb-nod 0.9s ease-in-out 1; }
  /* The posture states bake the tilt/lean into their own bob, because a
     keyframed transform would otherwise overwrite the static rule above. */
  .sv-gbot-listening .gb-body { animation: gb-bob-tilt 4s ease-in-out infinite; transform-origin: 32px 34px; }
  .sv-gbot-concerned .gb-body { animation: gb-bob-lean 4.6s ease-in-out infinite; transform-origin: 32px 40px; }
}
@keyframes gb-sway { 0%, 100% { transform: rotateY(-7deg); } 50% { transform: rotateY(7deg); } }
@keyframes gb-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2.5px); } }
@keyframes gb-shade { 0%, 100% { transform: scaleX(1); opacity: 1; } 50% { transform: scaleX(0.86); opacity: 0.7; } }
@keyframes gb-blink { 0%, 91%, 100% { transform: scaleY(1); } 94% { transform: scaleY(0.12); } 97% { transform: scaleY(1); } }
/* the pupils look around: right, hold, left, up, back to center */
@keyframes gb-wander {
  0%, 18%, 100% { transform: translate(0, 0); }
  24%, 38% { transform: translate(0.9px, 0.15px); }
  46%, 60% { transform: translate(-0.9px, 0.2px); }
  70%, 80% { transform: translate(0.15px, -0.7px); }
}
@keyframes gb-sweep { 0%, 100% { transform: translateX(0); } 50% { transform: translateX(20px); } }
@keyframes gb-nod { 0%, 100% { transform: translateY(0); } 40% { transform: translateY(-5px); } 70% { transform: translateY(-1px); } }
@keyframes gb-bob-tilt {
  0%, 100% { transform: rotate(-7deg) translateY(0); }
  50% { transform: rotate(-8.5deg) translateY(-2px); }
}
@keyframes gb-bob-lean {
  0%, 100% { transform: translateY(1px) scale(1.03); }
  50% { transform: translateY(-0.5px) scale(1.035); }
}
`;
        document.head.appendChild(st);
    },
};

window.GuardianBot = GuardianBot;
