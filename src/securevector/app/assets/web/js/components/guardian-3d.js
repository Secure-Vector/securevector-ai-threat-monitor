/**
 * Guardian 3D — the same original Guardian character as a real 3D model.
 *
 * Three.js (vendored, MIT) builds the figure from primitives — no external
 * model files, no third-party art: capsule-ish head with a glossy dark
 * visor, emissive eyes and ear pods.
 * GSAP (vendored, GreenSock standard license)
 * drives the life: idle bob and sway, blinks, pointer-tracked head and
 * eyes, and a wave gesture on demand.
 *
 * This is the HERO renderer, used only where a showpiece earns its cost
 * (the floating assistant). Everywhere else the lightweight SVG GuardianBot
 * remains, and it is also the automatic fallback here when WebGL is
 * unavailable. prefers-reduced-motion renders the static pose: no tweens,
 * no tracking. CSP-safe: everything ships from 'self', nothing is fetched.
 */

import * as THREE from '/js/vendor/three.module.min.js';

const TEAL = 0x5eadb8;
// Theme counterpoint, mirroring the SVG bot: light shell on dark themes,
// dark slate shell on the light theme. Read live so theme switches retint
// the materials in place (see applyTheme in mount()).
const SHELL_ON_DARK = 0xe8eef4;
const SHELL_ON_LIGHT = 0x54626f;
// The shared state vocabulary. GuardianBot (2D) carries the same names, so
// nothing a state expresses is lost when WebGL is unavailable.
const STATES = ['idle', 'scan', 'listening', 'concerned', 'ok'];
const isLightTheme = () =>
    (document.documentElement.getAttribute('data-theme') || '') === 'light';
const REDUCED = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function webglAvailable() {
    try {
        const c = document.createElement('canvas');
        return !!(window.WebGLRenderingContext
            && (c.getContext('webgl2') || c.getContext('webgl')));
    } catch (_) { return false; }
}

/** Soft radial sprite texture (canvas-drawn: no image assets, CSP-clean). */
function glowTexture(inner, outer) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
    grad.addColorStop(0, inner);
    grad.addColorStop(1, outer);
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

/** Resolve a gaze target to a viewport point. Accepts an element, a CSS
 *  selector, or a {x, y} client point. Returns null when the target is
 *  missing or has no box, so a caused look at something that is not on
 *  screen is a no-op rather than a stare into a corner. */
function pointOf(target) {
    if (!target) return null;
    let t = target;
    if (typeof t === 'string') t = document.querySelector(t);
    if (t && t.nodeType === 1) {
        const r = t.getBoundingClientRect();
        if (!r.width && !r.height) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    if (t && typeof t.x === 'number' && typeof t.y === 'number') return t;
    return null;
}

function buildGuardian() {
    const root = new THREE.Group();
    const body = new THREE.Group(); // everything that bobs
    root.add(body);

    const shell = new THREE.MeshPhysicalMaterial({
        color: isLightTheme() ? SHELL_ON_LIGHT : SHELL_ON_DARK,
        roughness: 0.32, metalness: 0.05,
        clearcoat: 1.0, clearcoatRoughness: 0.22,
    });
    const dark = new THREE.MeshPhysicalMaterial({
        color: 0x10161e, roughness: 0.12, metalness: 0.1,
        clearcoat: 1.0, clearcoatRoughness: 0.08,
    });
    const eyeMat = new THREE.MeshStandardMaterial({
        color: 0xffffff, emissive: 0xf2f7fb, emissiveIntensity: 1.35,
        roughness: 0.35,
    });

    // head: a softly squashed sphere reads as the SVG's capsule head
    const headGroup = new THREE.Group();
    const head = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), shell);
    head.scale.set(1.28, 0.98, 0.95);
    headGroup.add(head);
    // visor: a darker inner sphere pushed forward and flattened into a panel
    const visor = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), dark);
    visor.scale.set(0.98, 0.62, 0.55);
    visor.position.set(0, -0.02, 0.52);
    headGroup.add(visor);
    // ears
    const earGeo = new THREE.CapsuleGeometry(0.13, 0.28, 8, 16);
    const earL = new THREE.Mesh(earGeo, shell);
    earL.position.set(-1.34, -0.02, 0);
    earL.rotation.z = Math.PI / 2 * 0; // vertical pods
    const earR = earL.clone();
    earR.position.x = 1.34;
    headGroup.add(earL, earR);

    // eyes: emissive pills inside the visor, each with a soft halo
    const eyes = new THREE.Group();
    const eyeGeo = new THREE.CapsuleGeometry(0.15, 0.12, 8, 16);
    const mkEye = (x) => {
        const g = new THREE.Group();
        const e = new THREE.Mesh(eyeGeo, eyeMat);
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({
            map: glowTexture('rgba(244,248,251,0.55)', 'rgba(244,248,251,0)'),
            transparent: true, depthWrite: false,
        }));
        halo.scale.set(0.62, 0.62, 1);
        halo.position.z = 0.12;
        g.add(e, halo);
        g.position.set(x, -0.02, 1.18);
        return g;
    };
    const eyeL = mkEye(-0.42);
    const eyeR = mkEye(0.42);
    eyes.add(eyeL, eyeR);
    headGroup.add(eyes);
    headGroup.position.y = 0;
    body.add(headGroup);

    // ground shadow: a dark radial sprite (cheap, no shadow maps)
    const shadow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture('rgba(0,0,0,0.42)', 'rgba(0,0,0,0)'),
        transparent: true, depthWrite: false,
    }));
    shadow.scale.set(2.1, 0.5, 1);
    shadow.position.y = -1.55;
    root.add(shadow);

    return { root, body, headGroup, eyes, eyeL, eyeR, shadow, shell, dark };
}

const Guardian3D = {
    available: () => webglAvailable(),

    /** Mount the hero Guardian into `el`. Returns a controller:
     *  {
     *    look(target, {hold}),   caused gaze at an element / selector / point
     *    react('blocked'|'ok'),  one-shot reaction to something that happened
     *    setState(name),         persistent posture, see STATES
     *    glance(), wave(),       idle beat, and the greeting
     *    celebrate(),          the 270-degree win spin, puffs and all
     *    dispose(),
     *  } */
    mount(el, opts = {}) {
        const size = Number(opts.size) || 128;
        const W = size, H = Math.round(size * 0.94);
        const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(W, H);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        el.appendChild(renderer.domElement);
        renderer.domElement.style.display = 'block';

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(32, W / H, 0.1, 30);
        camera.position.set(0, 0.16, 6.6);
        camera.lookAt(0, -0.04, 0);

        // studio lighting: warm key upper-left, cool teal rim right, soft fill
        scene.add(new THREE.AmbientLight(0xdfe8f0, 0.75));
        const key = new THREE.DirectionalLight(0xffffff, 1.9);
        key.position.set(-3, 4, 5);
        scene.add(key);
        const rim = new THREE.PointLight(TEAL, 9, 20);
        rim.position.set(3.4, 0.6, 2.2);
        scene.add(rim);
        const fill = new THREE.DirectionalLight(0xbfd0dd, 0.5);
        fill.position.set(2, -1, 4);
        scene.add(fill);

        const G = buildGuardian();
        scene.add(G.root);
        // Retint on theme switches: the app stamps data-theme on <html>.
        const applyTheme = () => {
            G.shell.color.setHex(isLightTheme() ? SHELL_ON_LIGHT : SHELL_ON_DARK);
        };
        applyTheme();
        const themeObs = new MutationObserver(() => {
            applyTheme();
            if (REDUCED) renderer.render(scene, camera); // static frame retints too
        });
        themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        G.root.rotation.x = 0.04;
        G.root.position.y = 0.1;

        const gsap = window.gsap;
        const tweens = [];
        let raf = null;
        let disposed = false;
        const state = { scan: false, name: 'idle' };

        // ---- stillness ---------------------------------------------------
        // Idle motion used to run on infinite yoyo tweens, so the bot moved
        // identically whether the machine was quiet or an agent had just been
        // blocked. Perpetual motion is a screensaver: it makes movement mean
        // nothing. The idle drive is procedural instead, scaled by `life`,
        // which decays to a floor after QUIET_MS of nothing happening. Once
        // it has settled, ANY movement is a signal that something real
        // occurred, and that contrast is what reads as attention. Every
        // caused motion below calls wake().
        const LIFE_FLOOR = 0.14;   // asleep, never switched off
        const QUIET_MS = 6000;     // how long "nothing happened" lasts
        const life = { v: 1 };
        let lastEvent = performance.now();
        let lifeTween = null;
        const wake = () => {
            lastEvent = performance.now();
            if (!gsap || REDUCED || life.v > 0.98) return;
            if (lifeTween) lifeTween.kill();
            lifeTween = gsap.to(life, { v: 1, duration: 0.35, ease: 'power2.out' });
        };
        const settleCheck = () => {
            if (!gsap || REDUCED) return;
            if (performance.now() - lastEvent < QUIET_MS) return;
            if (life.v <= LIFE_FLOOR + 0.01) return;
            if (lifeTween) lifeTween.kill();
            lifeTween = gsap.to(life, { v: LIFE_FLOOR, duration: 2.6, ease: 'sine.inOut' });
        };

        if (gsap && !REDUCED) {
            // The blink survives the settle. A still character that blinks
            // reads as calm; one that never blinks reads as frozen.
            [G.eyeL, G.eyeR].forEach(e => {
                const blink = gsap.timeline({ repeat: -1, repeatDelay: 4.6 });
                blink.to(e.scale, { y: 0.08, duration: 0.09, ease: 'power2.in' })
                     .to(e.scale, { y: 1, duration: 0.14, ease: 'power2.out' });
                tweens.push(blink);
            });
        }

        // pointer tracking: the head (and eyes, slightly more) follow the
        // cursor anywhere on the page — the "it sees you" moment
        const yawTo = gsap && !REDUCED ? gsap.quickTo(G.headGroup.rotation, 'y', { duration: 0.5, ease: 'power3.out' }) : null;
        const pitchTo = gsap && !REDUCED ? gsap.quickTo(G.headGroup.rotation, 'x', { duration: 0.5, ease: 'power3.out' }) : null;
        const eyesTo = gsap && !REDUCED ? gsap.quickTo(G.eyes.position, 'x', { duration: 0.4, ease: 'power3.out' }) : null;
        let lastMove = -1e9;
        // While a caused gaze is holding, the cursor must not drag the head
        // off its target: a deliberate look outranks ambient tracking.
        let gazeUntil = 0;
        const onMove = (ev) => {
            if (disposed || !yawTo) return;
            if (performance.now() < gazeUntil) return;
            lastMove = performance.now();
            wake();
            const r = renderer.domElement.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            const dx = (ev.clientX - cx) / window.innerWidth;
            const dy = (ev.clientY - cy) / window.innerHeight;
            yawTo(THREE.MathUtils.clamp(dx * 1.4, -0.42, 0.42));
            pitchTo(THREE.MathUtils.clamp(dy * 0.7, -0.16, 0.22));
            eyesTo(THREE.MathUtils.clamp(dx * 0.5, -0.16, 0.16));
        };
        if (yawTo) window.addEventListener('mousemove', onMove, { passive: true });

        // The idle drive ASSIGNS these every frame, so any tween that writes
        // the same properties is wiped before it can be seen. One-shot moves
        // therefore tween these offsets, and the drive adds them in.
        const pose = { spin: 0, hop: 0 };

        const t0 = performance.now();
        const render = () => {
            if (disposed) return;
            if (gsap && !REDUCED) {
                settleCheck();
                const t = (performance.now() - t0) / 1000;
                const a = life.v;
                // same amplitudes the yoyo tweens used, now gated by `life`
                G.body.position.y = (Math.sin(t * 1.85) * 0.5 + 0.5) * 0.03 * a + pose.hop;
                G.root.rotation.y = (Math.sin(t * 0.9) * 0.5 + 0.5) * 0.05 * a + pose.spin;
                G.shadow.scale.x = 2.1 - (Math.sin(t * 1.85) * 0.5 + 0.5) * 0.05 * a;
            }
            renderer.render(scene, camera);
            raf = requestAnimationFrame(render);
        };
        if (REDUCED) renderer.render(scene, camera); // one static frame
        else render();

        return {
            el: renderer.domElement,
            /** Idle glance: the sentinel looks off to one side and back.
             *  Small on purpose, and skipped while the cursor is live, since
             *  the head is already tracking it and a second motion would
             *  fight it. This is the only unprompted movement. */
            /** Caused gaze: point the head at something real on the page.
             *  `target` is an element, a selector, or a {x, y} client point.
             *  Unlike cursor tracking this is deliberate — it snaps, holds,
             *  then returns — so a blocked call or a first-time destination
             *  pulls the Guardian's attention a beat before the user's.
             *  Returns the sequence length in ms, or 0 if it did not run. */
            look(target, opts = {}) {
                if (!gsap || REDUCED || disposed) return 0;
                const pt = pointOf(target);
                if (!pt) return 0;
                wake();
                const r = renderer.domElement.getBoundingClientRect();
                const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
                const dx = (pt.x - cx) / Math.max(1, window.innerWidth);
                const dy = (pt.y - cy) / Math.max(1, window.innerHeight);
                const hold = Math.max(0, Number(opts.hold) || 1100);
                gazeUntil = performance.now() + hold + 700;
                const tl = gsap.timeline();
                tl.to(G.headGroup.rotation, {
                    y: THREE.MathUtils.clamp(dx * 1.9, -0.5, 0.5),
                    x: THREE.MathUtils.clamp(dy * 0.9, -0.2, 0.28),
                    duration: 0.26, ease: 'power4.out',
                })
                  .to(G.eyes.position, {
                      x: THREE.MathUtils.clamp(dx * 0.6, -0.18, 0.18),
                      duration: 0.2, ease: 'power3.out',
                  }, '<')
                  .to({}, { duration: hold / 1000 })
                  .to(G.headGroup.rotation, { y: 0, x: 0, duration: 0.7, ease: 'sine.inOut' })
                  .to(G.eyes.position, { x: 0, duration: 0.5, ease: 'power2.out' }, '<');
                return tl.duration() * 1000;
            },
            glance() {
                if (!gsap || REDUCED || state.scan) return 0;
                if (performance.now() - lastMove < 4000) return 0;
                if (performance.now() < gazeUntil) return 0;
                wake();
                const dir = Math.random() < 0.5 ? -1 : 1;
                const tl = gsap.timeline();
                tl.to(G.headGroup.rotation, { y: dir * 0.3, x: -0.04, duration: 0.55, ease: 'sine.inOut' })
                  .to(G.eyes.position, { x: dir * 0.1, duration: 0.4, ease: 'power2.out' }, '<')
                  .to(G.headGroup.rotation, { y: 0, x: 0, duration: 0.8, ease: 'sine.inOut' }, '+=0.5')
                  .to(G.eyes.position, { x: 0, duration: 0.5, ease: 'power2.out' }, '<');
                return tl.duration() * 1000;
            },
            wave() {
                if (!gsap || REDUCED) return 0;
                wake();
                // no arms on a head-only sentinel: a friendly nod
                const tl = gsap.timeline();
                tl.to(G.headGroup.rotation, { x: 0.2, duration: 0.22, ease: 'power2.out' })
                  .to(G.headGroup.rotation, { x: -0.06, duration: 0.16, yoyo: true, repeat: 3, ease: 'sine.inOut' })
                  .to(G.headGroup.rotation, { x: 0, duration: 0.26, ease: 'power2.in' });
                return tl.duration() * 1000;
            },
            /** Persistent posture. Every state is legible from silhouette and
             *  luminance alone: none of them depends on hue, because colour
             *  in this product means security state and nothing else. */
            setState(s) {
                const name = STATES.indexOf(s) >= 0 ? s : 'idle';
                state.name = name;
                state.scan = name === 'scan';
                if (!gsap || REDUCED) return;
                wake();
                // scanning: the eyes cool toward teal and burn brighter
                gsap.to(G.eyeL.children[0].material, { emissiveIntensity: state.scan ? 2.0 : 1.35, duration: 0.4 });
                [G.eyeL, G.eyeR].forEach(e => {
                    const m = e.children[0].material;
                    gsap.to(m.emissive, {
                        r: state.scan ? 0.55 : 0.95, g: state.scan ? 0.85 : 0.97,
                        b: state.scan ? 0.9 : 0.98, duration: 0.4,
                    });
                });
                // listening: a head tilt, the universal "go on" posture.
                gsap.to(G.headGroup.rotation, {
                    z: name === 'listening' ? 0.14 : 0,
                    duration: 0.5, ease: 'power2.out',
                });
                // concerned: leans in and narrows its eyes. No red, no glow.
                const worried = name === 'concerned';
                gsap.to(G.body.rotation, { x: worried ? 0.11 : 0, duration: 0.6, ease: 'power2.out' });
                [G.eyeL, G.eyeR].forEach(e => {
                    gsap.to(e.scale, { y: worried ? 0.62 : 1, duration: 0.45, ease: 'power2.out' });
                });
            },
            /** One-shot reactions. These are the moments that must be caused
             *  by something real: a denial, or a clean result. */
            react(kind) {
                if (!gsap || REDUCED || disposed) return 0;
                wake();
                const tl = gsap.timeline();
                if (kind === 'blocked') {
                    // a sharp refusal, then a deliberate beat of stillness.
                    // The pause is the point: it is what a decision looks like.
                    tl.to(G.headGroup.rotation, { y: -0.26, duration: 0.1, ease: 'power4.out' })
                      .to(G.headGroup.rotation, { y: 0.22, duration: 0.12, ease: 'power2.inOut' })
                      .to(G.headGroup.rotation, { y: 0, duration: 0.14, ease: 'power2.out' })
                      .to(G.body.rotation, { x: 0.08, duration: 0.18, ease: 'power2.out' }, '<')
                      .to({}, { duration: 0.75 })
                      .to(G.body.rotation, { x: 0, duration: 0.6, ease: 'sine.inOut' });
                } else if (kind === 'ok') {
                    // the eyes squash into arcs: the 2D bot's `ok` face,
                    // which never made it into three dimensions until now
                    [G.eyeL, G.eyeR].forEach((e, i) => {
                        tl.to(e.scale, { y: 0.42, x: 1.18, duration: 0.22, ease: 'power2.out' }, i ? '<' : 0)
                          .to(e.scale, { y: 1, x: 1, duration: 0.3, ease: 'power2.inOut' }, '>+0.5');
                    });
                    tl.to(G.headGroup.rotation, { x: 0.1, duration: 0.22, ease: 'power2.out' }, 0)
                      .to(G.headGroup.rotation, { x: 0, duration: 0.4, ease: 'sine.inOut' }, '>+0.3');
                } else {
                    return 0;
                }
                gazeUntil = performance.now() + tl.duration() * 1000;
                return tl.duration() * 1000;
            },
            /** The one showy moment in the whole product: a full 270-degree
             *  turn inside a ring of drifting puffs. Reserved for a verified
             *  win, because a celebration that fires on nothing teaches the
             *  user to ignore it.
             *
             *  Colour note: the Guardian's own materials never change here.
             *  Hue on the bot means security state, so the colour lives
             *  entirely in the transient puffs, which carry no state at all
             *  and are gone in under two seconds. */
            /** The one showy moment in the whole product: a full turn on the
             *  vertical axis, then a short unwind back to front. Reserved for
             *  a verified win, because a celebration that fires on nothing
             *  teaches the user to ignore it.
             *
             *  The colour half of this lives in the DOM, not here. A ring of
             *  puffs drawn in the scene sits at the edge of a 94px canvas and
             *  gets clipped to nothing, so the assistant draws it around the
             *  button instead and this method owns only the spin. */
            celebrate() {
                if (!gsap || REDUCED || disposed) return 0;
                wake();
                const tl = gsap.timeline({
                    onComplete: () => { pose.spin = 0; pose.hop = 0; },
                });
                // 270 degrees, then home: stopping three-quarters round and
                // easing back reads as a flourish, where a flat 360 just looks
                // like a dropped frame.
                pose.spin = 0;
                tl.to(pose, { spin: Math.PI * 1.5, duration: 1.05, ease: 'power2.inOut' }, 0)
                  .to(pose, { spin: Math.PI * 2, duration: 0.45, ease: 'power2.out' }, 1.15);
                tl.to(pose, { hop: 0.16, duration: 0.34, ease: 'power2.out' }, 0)
                  .to(pose, { hop: 0, duration: 0.5, ease: 'bounce.out' }, 0.34);
                return tl.duration() * 1000;
            },
            dispose() {
                disposed = true;
                if (raf) cancelAnimationFrame(raf);
                tweens.forEach(t => t.kill && t.kill());
                themeObs.disconnect();
                window.removeEventListener('mousemove', onMove);
                renderer.dispose();
                renderer.domElement.remove();
            },
        };
    },
};

window.Guardian3D = Guardian3D;
