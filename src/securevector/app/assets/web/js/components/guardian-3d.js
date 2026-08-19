/**
 * Guardian 3D — the same original Guardian character as a real 3D model.
 *
 * Three.js (vendored, MIT) builds the figure from primitives — no external
 * model files, no third-party art: capsule-ish head with a glossy dark
 * visor, emissive eyes, teal antenna bead, extruded shield body, capsule
 * arms with mitten hands. GSAP (vendored, GreenSock standard license)
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

function buildGuardian() {
    const root = new THREE.Group();
    const body = new THREE.Group(); // everything that bobs
    root.add(body);

    const shell = new THREE.MeshPhysicalMaterial({
        color: 0xe8eef4, roughness: 0.32, metalness: 0.05,
        clearcoat: 1.0, clearcoatRoughness: 0.22,
    });
    const dark = new THREE.MeshPhysicalMaterial({
        color: 0x10161e, roughness: 0.12, metalness: 0.1,
        clearcoat: 1.0, clearcoatRoughness: 0.08,
    });
    const tealGlow = new THREE.MeshStandardMaterial({
        color: TEAL, emissive: TEAL, emissiveIntensity: 1.6,
        roughness: 0.4,
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
    // antenna
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.42, 12), shell);
    stem.position.set(0, 1.12, 0);
    const bead = new THREE.Mesh(new THREE.SphereGeometry(0.14, 24, 16), tealGlow);
    bead.position.set(0, 1.4, 0);
    const beadHalo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture('rgba(94,173,184,0.85)', 'rgba(94,173,184,0)'),
        transparent: true, depthWrite: false,
    }));
    beadHalo.scale.set(0.85, 0.85, 1);
    beadHalo.position.copy(bead.position);
    headGroup.add(stem, bead, beadHalo);

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
    headGroup.position.y = 1.02;
    body.add(headGroup);
    // neck: the head sits ON the body, not above it
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.35, 20), dark);
    neck.position.y = 0.12;
    body.add(neck);

    // shield body: the product mark, extruded with a bevel
    const shieldShape = new THREE.Shape();
    shieldShape.moveTo(-0.85, 0.55);
    shieldShape.quadraticCurveTo(0, 0.88, 0.85, 0.55);
    shieldShape.lineTo(0.85, 0.02);
    shieldShape.bezierCurveTo(0.85, -0.62, 0.45, -1.02, 0, -1.22);
    shieldShape.bezierCurveTo(-0.45, -1.02, -0.85, -0.62, -0.85, 0.02);
    shieldShape.closePath();
    const shield = new THREE.Mesh(new THREE.ExtrudeGeometry(shieldShape, {
        depth: 0.5, bevelEnabled: true, bevelThickness: 0.14,
        bevelSize: 0.12, bevelSegments: 5, curveSegments: 24,
    }), shell);
    shield.position.set(0, -0.5, -0.25);
    body.add(shield);
    // keel: the mark's center line, faint teal
    const keel = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.85, 6, 10),
        new THREE.MeshStandardMaterial({
            color: TEAL, emissive: TEAL, emissiveIntensity: 0.35, roughness: 0.5,
        }));
    keel.position.set(0, -0.82, 0.42);
    body.add(keel);

    // arms: capsules with mitten hands, pivoted at the shoulders
    const mkArm = (side) => {
        const pivot = new THREE.Group();
        pivot.position.set(1.0 * side, -0.3, 0);
        const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 0.5, 8, 16), shell);
        arm.position.set(0.16 * side, -0.42, 0);
        arm.rotation.z = -0.28 * side;
        const hand = new THREE.Mesh(new THREE.SphereGeometry(0.19, 24, 16), shell);
        hand.position.set(0.28 * side, -0.78, 0);
        pivot.add(arm, hand);
        body.add(pivot);
        return pivot;
    };
    const armL = mkArm(-1);
    const armR = mkArm(1);

    // ground shadow: a dark radial sprite (cheap, no shadow maps)
    const shadow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture('rgba(0,0,0,0.42)', 'rgba(0,0,0,0)'),
        transparent: true, depthWrite: false,
    }));
    shadow.scale.set(2.2, 0.55, 1);
    shadow.position.y = -2.15;
    root.add(shadow);

    return { root, body, headGroup, eyes, eyeL, eyeR, bead, beadHalo, armL, armR, shadow };
}

const Guardian3D = {
    available: () => webglAvailable(),

    /** Mount the hero Guardian into `el`. Returns a controller:
     *  { wave(), setState('idle'|'scan'), dispose() }. */
    mount(el, opts = {}) {
        const size = Number(opts.size) || 128;
        const W = size, H = Math.round(size * 1.18);
        const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(W, H);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        el.appendChild(renderer.domElement);
        renderer.domElement.style.display = 'block';

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(32, W / H, 0.1, 30);
        camera.position.set(0, 0.4, 8.5);
        camera.lookAt(0, -0.08, 0);

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
        G.root.rotation.x = 0.04;
        G.root.position.y = -0.12;

        const gsap = window.gsap;
        const tweens = [];
        let raf = null;
        let disposed = false;
        const state = { scan: false };

        if (gsap && !REDUCED) {
            // idle life: bob against the shadow, slow sway, blinks, pulse
            tweens.push(gsap.to(G.body.position, { y: 0.09, duration: 2, ease: 'sine.inOut', yoyo: true, repeat: -1 }));
            tweens.push(gsap.to(G.root.rotation, { y: 0.16, duration: 4.5, ease: 'sine.inOut', yoyo: true, repeat: -1 }));
            tweens.push(gsap.to(G.shadow.scale, { x: 1.9, duration: 2, ease: 'sine.inOut', yoyo: true, repeat: -1 }));
            [G.eyeL, G.eyeR].forEach(e => {
                const blink = gsap.timeline({ repeat: -1, repeatDelay: 4.6 });
                blink.to(e.scale, { y: 0.08, duration: 0.09, ease: 'power2.in' })
                     .to(e.scale, { y: 1, duration: 0.14, ease: 'power2.out' });
                tweens.push(blink);
            });
            tweens.push(gsap.to(G.bead.material, { emissiveIntensity: 0.5, duration: 1.3, yoyo: true, repeat: -1, ease: 'sine.inOut' }));
            tweens.push(gsap.to(G.beadHalo.material, { opacity: 0.35, duration: 1.3, yoyo: true, repeat: -1, ease: 'sine.inOut' }));
        }

        // pointer tracking: the head (and eyes, slightly more) follow the
        // cursor anywhere on the page — the "it sees you" moment
        const yawTo = gsap && !REDUCED ? gsap.quickTo(G.headGroup.rotation, 'y', { duration: 0.5, ease: 'power3.out' }) : null;
        const pitchTo = gsap && !REDUCED ? gsap.quickTo(G.headGroup.rotation, 'x', { duration: 0.5, ease: 'power3.out' }) : null;
        const eyesTo = gsap && !REDUCED ? gsap.quickTo(G.eyes.position, 'x', { duration: 0.4, ease: 'power3.out' }) : null;
        const onMove = (ev) => {
            if (disposed || !yawTo) return;
            const r = renderer.domElement.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            const dx = (ev.clientX - cx) / window.innerWidth;
            const dy = (ev.clientY - cy) / window.innerHeight;
            yawTo(THREE.MathUtils.clamp(dx * 1.4, -0.42, 0.42));
            pitchTo(THREE.MathUtils.clamp(dy * 0.7, -0.16, 0.22));
            eyesTo(THREE.MathUtils.clamp(dx * 0.5, -0.16, 0.16));
        };
        if (yawTo) window.addEventListener('mousemove', onMove, { passive: true });

        const render = () => {
            if (disposed) return;
            renderer.render(scene, camera);
            raf = requestAnimationFrame(render);
        };
        if (REDUCED) renderer.render(scene, camera); // one static frame
        else render();

        return {
            el: renderer.domElement,
            wave() {
                if (!gsap || REDUCED) return 0;
                const tl = gsap.timeline();
                tl.to(G.armR.rotation, { z: -2.1, duration: 0.28, ease: 'power2.out' })
                  .to(G.armR.rotation, { z: -1.5, duration: 0.16, yoyo: true, repeat: 3, ease: 'sine.inOut' })
                  .to(G.armR.rotation, { z: 0, duration: 0.3, ease: 'power2.in' });
                return tl.duration() * 1000;
            },
            setState(s) {
                state.scan = s === 'scan';
                if (!gsap || REDUCED) return;
                // scanning: the bead works harder and the eyes cool toward teal
                gsap.to(G.bead.material, { emissiveIntensity: state.scan ? 2.6 : 1.6, duration: 0.4 });
                [G.eyeL, G.eyeR].forEach(e => {
                    const m = e.children[0].material;
                    gsap.to(m.emissive, {
                        r: state.scan ? 0.55 : 0.95, g: state.scan ? 0.85 : 0.97,
                        b: state.scan ? 0.9 : 0.98, duration: 0.4,
                    });
                });
            },
            dispose() {
                disposed = true;
                if (raf) cancelAnimationFrame(raf);
                tweens.forEach(t => t.kill && t.kill());
                window.removeEventListener('mousemove', onMove);
                renderer.dispose();
                renderer.domElement.remove();
            },
        };
    },
};

window.Guardian3D = Guardian3D;
