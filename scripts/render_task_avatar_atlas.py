#!/usr/bin/env python3
"""Render the Guardian task avatar as a real 3D model into a sprite atlas.

The task avatar is the Guardian in miniature, one badge per agent task. It is
drawn at 18-44px in dozens of places at once (rail rows, board cards, pane
tabs), so a live WebGL context per badge is not an option: browsers cap live
contexts at roughly 8-16, and the desktop shell is WKWebView where WebGL is
the least reliable. The model is therefore rendered OFFLINE, here, into one
transparent PNG atlas that the component shows as a background sprite.

The model is built the way the hero renderer in `js/components/guardian-3d.js`
builds one: MeshPhysicalMaterial primitives, a darker flattened body pushed
forward as the visor, capsule ear pods on a CLONED material so they can carry
the accent independently, emissive eye pills with a soft halo sprite. The
proportions come from the owner's design reference rather than from that file:
a wide tapered OVOID head seen three-quarter on, a glass panel large enough to
dominate the face and wrap the curvature, big bright rounded-pill eyes, and a
hard specular response so it reads as a polished object. Nothing here is
fetched: three.js is the vendored copy under `js/vendor/`.

There is no baked bloom in the cells. The luminous halo is a CSS dual
drop-shadow on the avatar element (the technique the floating Guardian FAB
uses, `js/components/guardian-assistant.js` ~line 2017), which follows the
sprite's alpha silhouette, cannot be clipped by the cell edge, costs no atlas
bytes and is tintable at runtime, so it works for the flat SVG fallback too.

HOW TO RE-RUN
-------------
    cd <repo root>
    python3 scripts/render_task_avatar_atlas.py

    # verify the committed atlas still matches a fresh render
    python3 scripts/render_task_avatar_atlas.py --check

    # one large render, for judging the model against a design reference
    python3 scripts/render_task_avatar_atlas.py --match /tmp/one.png \
        --match-state interrupted --match-harness codex

Requirements are already in the dev environment: Playwright (with a Chromium
download) and Pillow + numpy. No new dependency is introduced.

ATLAS LAYOUT
------------
Columns are states, in `TaskAvatar.STATES` order. Rows are harnesses, in
`TaskAvatar.HARNESS_COLORS` key order, repeated twice: the first block is the
dark-theme shell, the second block the light-theme shell (the SVG badge flips
its shell per theme for contrast and the 3D model must do the same).
Both orders are read out of `js/components/task-avatar.js` so the component
stays the single source of truth.

Cells are 132px: 3x the largest place the avatar is used (44px). Each cell is
supersampled at 4x with multisampling OFF and box-downsampled, then the result
is un-premultiplied, so the transparent edge carries the figure's true colour
and no dark fringe on either theme.
"""

from __future__ import annotations

import argparse
import base64
import http.server
import json
import re
import socketserver
import sys
import threading
from contextlib import contextmanager
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[1]
WEB = REPO / "src" / "securevector" / "app" / "assets" / "web"
COMPONENT = WEB / "js" / "components" / "task-avatar.js"
THREE_JS = WEB / "js" / "vendor" / "three.module.min.js"
ATLAS = WEB / "images" / "task-avatar-atlas.png"
SPIN = WEB / "images" / "task-avatar-spin.png"

# Cells are cut to the FIGURE's aspect, not to a square. The badge element is
# square, but the bot is a wide ovoid: a square cell spent a third of its
# height on empty pixels that still had to be encoded and downloaded. 132 x 90
# and 66 x 46 are the same 33:23, so both sheets scale into the same layer box
# with no distortion and no drift between them.
CELL = 132          # 3x the largest use (44px)
CELL_H = 92
SUPERSAMPLE = 4     # render at 4x and box-downsample
CAMERA_DIST = 5.94  # fitted against the WIDEST frame of the rotation, not the rest pose
MAX_BYTES = 400 * 1024
# The rotation sheet gets a larger ceiling than the static one, and only
# because it is fetched lazily: a page with no running task never pays for it.
# The frames are what the extra room is spent on, because frames per second is
# the only thing that decides whether a turn reads as turning.
SPIN_MAX_BYTES = 700 * 1024

# The rotation sheet is a SECOND atlas, and a second download. Only `active`
# spins: a dormant, blocked or failed bot holding still is the signal that
# nothing is happening, and a board where everything moves says nothing. The
# component fetches this one lazily, so a page with no running task never asks
# for it. Cells are 2x the largest use rather than 3x, because motion hides the
# detail that the extra resolution would buy and this is the bigger asset.
SPIN_STATE = "active"
# 1.5x the largest use rather than 2x. This sheet exists to convey MOTION, and
# motion hides detail; the pixels it gives up buy frames, which is the only
# thing that makes a turn read as a turn. 66 x 45 is still above the largest
# size the badge is ever drawn at (44px x SPRITE_SCALE = 52px), so no cell is
# ever upscaled, and 66:46 is the same 33:23 as the static cell.
SPIN_CELL = 66
SPIN_CELL_H = 46
SPIN_SUPERSAMPLE = 4
SPIN_FRAMES = 48

# Shell tone per theme, same counterpoint the SVG badge and the hero renderer
# use: a light shell on the dark themes, a dark slate shell on the light one.
THEMES = [
    ("dark", 0xE8EEF4),
    ("light", 0x54626F),
]


# --------------------------------------------------------------------------
# the component is the single source of truth for harnesses and states
# --------------------------------------------------------------------------
def read_layout() -> tuple[list[tuple[str, str]], list[str]]:
    src = COMPONENT.read_text(encoding="utf-8")
    block = re.search(r"HARNESS_COLORS:\s*\{(.*?)\}", src, re.S)
    if not block:
        raise SystemExit("could not find HARNESS_COLORS in task-avatar.js")
    harnesses = re.findall(r"'?([a-z-]+)'?:\s*'(#[0-9a-fA-F]{6})'", block.group(1))
    if not harnesses:
        raise SystemExit("HARNESS_COLORS parsed empty")
    states_m = re.search(r"STATES:\s*\[(.*?)\]", src, re.S)
    if not states_m:
        raise SystemExit("could not find STATES in task-avatar.js")
    states = re.findall(r"'([a-z]+)'", states_m.group(1))
    if not states:
        raise SystemExit("STATES parsed empty")
    return harnesses, states


# --------------------------------------------------------------------------
# the render page
# --------------------------------------------------------------------------
PAGE = """<!doctype html><meta charset="utf-8"><title>atlas</title>
<style>html,body{margin:0;background:#000}</style>
<script type="module">
import * as THREE from '/three.module.min.js';

const SIZE_W = __SIZE_W__, SIZE_H = __SIZE_H__;

// A soft radial sprite, drawn on a canvas so nothing is fetched. Same trick
// as glowTexture() in guardian-3d.js.
function glowTexture(inner, outer) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 3, 64, 64, 62);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// antialias:false is deliberate. An MSAA resolve averages the covered
// samples with the transparent clear value, so an edge pixel comes back with
// its colour crushed toward black while alpha only records coverage. That is
// the classic dark fringe: invisible on the dark theme, a dirty outline on
// the light one, and it does not survive an un-premultiply cleanly (measured: a
// silhouette pixel resolved to rgb 2 at alpha 64 where the true colour was
// 68). Supersampling instead keeps every rendered sample fully opaque with
// its true colour, so the box downsample below is an exact coverage average
// and the un-premultiply afterwards is lossless.
// preserveDrawingBuffer lets us read the raw pixels back rather than going
// through a 2D canvas, which would recompose and re-darken the edge again.
const renderer = new THREE.WebGLRenderer({
  alpha: true, antialias: false,
  premultipliedAlpha: false, preserveDrawingBuffer: true,
});
renderer.setPixelRatio(1);
renderer.setSize(SIZE_W, SIZE_H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x000000, 0);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// The cell is cut to the figure's own aspect, so there is no dead band above
// and below to pay for. The camera is fitted against the WIDEST frame of the
// rotation, not the rest pose: the sweep is what clipped the cell last time.
// The glow is a CSS drop-shadow on the element, so no bloom margin is
// reserved here.
const camera = new THREE.PerspectiveCamera(22, SIZE_W / SIZE_H, 0.1, 40);
camera.position.set(0, 0.0, __DIST__);
camera.lookAt(0, -0.02, 0);

const ambient = new THREE.AmbientLight(0xdfe8f0, 0.62);
scene.add(ambient);
// key upper-left: the same direction the SVG badge puts its sheen
const key = new THREE.DirectionalLight(0xffffff, 1.95);
key.position.set(-3, 4, 5);
scene.add(key);
const fill = new THREE.DirectionalLight(0xbfd0dd, 0.46);
fill.position.set(2, -1.2, 4);
scene.add(fill);
// A tight, bright specular source. The reference is a polished object: what
// sells that is not more light overall but one small hard highlight raking
// across the shell and another across the glass.
const spec = new THREE.PointLight(0xffffff, 26, 34);
spec.position.set(-2.4, 3.6, 5.4);
scene.add(spec);
const spec2 = new THREE.PointLight(0xeaf2ff, 7, 28);
spec2.position.set(2.2, 2.2, 5.0);
scene.add(spec2);
// rim in the harness accent: a second, larger place the identity colour
// lands, so the badge is not relying on two small pods at 18px
const rim = new THREE.PointLight(0xffffff, 9, 24);
rim.position.set(3.4, 0.5, 2.0);
scene.add(rim);

const shell = new THREE.MeshPhysicalMaterial({
  color: 0xe8eef4, roughness: 0.17, metalness: 0.0,
  clearcoat: 1.0, clearcoatRoughness: 0.045,
  sheen: 0.4, sheenRoughness: 0.5, sheenColor: 0xffffff,
});
// Near-mirror glass. The roughness is low on purpose: a tight highlight is a
// thin streak near the top edge, where a softer one spreads a bright lobe
// right across the middle and swallows whatever the eyes are doing.
const dark = new THREE.MeshPhysicalMaterial({
  color: 0x05070b, roughness: 0.018, metalness: 0.0,
  clearcoat: 1.0, clearcoatRoughness: 0.006,
  reflectivity: 1.0,
});
const eyeMat = new THREE.MeshStandardMaterial({
  color: 0xffffff, emissive: 0xf4f8fc, emissiveIntensity: 1.7, roughness: 0.3,
});
const podMat = shell.clone();

/** An egg, not a ball: a sphere stretched wide, squashed in height, and
 *  tapered so the top is a little narrower than the bottom. The reference is
 *  an ovoid seen three-quarter on, and the silhouette is most of what makes
 *  it that character rather than a generic ball. Deterministic: a fixed
 *  tessellation walked in order, no randomness anywhere. */
function ovoid(rx, ry, rz, taper) {
  const g = new THREE.SphereGeometry(1, 96, 64);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 - taper * y;
    p.setXYZ(i, x * rx * k, y * ry, z * rz * k);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

const root = new THREE.Group();
const body = new THREE.Group();
root.add(body);
const headGroup = new THREE.Group();

const HEAD_X = 1.34, HEAD_Y = 1.06, HEAD_Z = 1.14;
const head = new THREE.Mesh(ovoid(HEAD_X, HEAD_Y, HEAD_Z, 0.07), shell);
headGroup.add(head);

// The visor is a second ovoid, wider and deeper than the head but much
// flatter, pushed forward. Where it swells past the head it cuts a big
// elliptical panel that follows the curvature instead of sitting on it as a
// flat plate, which is what makes the reference's glass wrap the face.
const VIS_X = HEAD_X * 0.63, VIS_Y = HEAD_Y * 0.435, VIS_Z = 0.42, VIS_OFF = 0.90;
const visor = new THREE.Mesh(ovoid(VIS_X, VIS_Y, VIS_Z, 0.05), dark);
visor.position.set(0, -0.02, VIS_OFF);
headGroup.add(visor);
// Where the glass surface actually is at a given x, so the eyes sit ON it and
// follow its curve instead of floating in front of or sinking behind it.
const visorZ = (x) => {
  const u = Math.min(0.999, Math.abs(x) / VIS_X);
  return VIS_Z * Math.sqrt(1 - u * u) + VIS_OFF;
};

// pods: one per ear, on a cloned material so they carry the accent alone
const podGeo = new THREE.CapsuleGeometry(0.17, 0.40, 10, 20);
const podL = new THREE.Mesh(podGeo, podMat);
podL.position.set(-HEAD_X - 0.01, -0.02, 0.18);
const podR = podL.clone();
podR.position.x = HEAD_X + 0.01;
headGroup.add(podL, podR);

// Eyes: big bright rounded pills, taller than wide, well separated, each with
// a soft bloom. In the reference they are the only truly white thing in the
// glass, and they are large relative to the visor; that ratio is most of what
// makes the face read.
const EYE_R = 0.125, EYE_LEN = 0.130;
const eyeGeo = new THREE.CapsuleGeometry(EYE_R, EYE_LEN, 10, 24);
// A shut eyelid. Three things make it read as a lid rather than a smear:
// it is NARROWER than the open pill (0.195 against 0.25), not edge to edge;
// it has real thickness (0.09, about a quarter of the open eye's height), not
// a hairline; and it SAGS in the middle instead of being a dead-straight bar.
// A capsule spanning the full open width was the stretched look.
const LID_CHORD = 0.205, LID_ARC = 1.4;
const LID_R = LID_CHORD / (2 * Math.sin(LID_ARC / 2));
const lidGeo = new THREE.TorusGeometry(LID_R, 0.062, 10, 28, LID_ARC);
lidGeo.rotateZ(-Math.PI / 2 - LID_ARC / 2);   // swing the arc under the axis: a sag
lidGeo.translate(0, LID_R * (1 + Math.cos(LID_ARC / 2)) / 2, 0);   // recentre on the eye
// The content, finished face: eyes closed and curved UP, the opposite bow to
// the lid, so the two shut states never read as each other. Sized to the open
// pill's width too.
const arcGeo = new THREE.TorusGeometry(0.115, 0.050, 10, 30, Math.PI);
const eyes = [];
const halos = [];
for (const x of [-0.36, 0.36]) {
  const g = new THREE.Group();
  const pill = new THREE.Mesh(eyeGeo, eyeMat);
  const lid = new THREE.Mesh(lidGeo, eyeMat);
  lid.visible = false;
  const arc = new THREE.Mesh(arcGeo, eyeMat);
  arc.visible = false;
  // Additive, so it reads as bloom spilling off a lit eye. A normal alpha
  // sprite is drawn in the transparent pass AFTER the opaque pill and simply
  // covered it with a grey disc.
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('rgba(255,255,255,0.70)', 'rgba(255,255,255,0)'),
    transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.AdditiveBlending,
  }));
  halo.scale.set(0.56, 0.56, 1);
  halo.position.z = 0.08;
  g.add(halo, pill, lid, arc);
  g.position.set(x, -0.02, visorZ(x) - 0.03);
  headGroup.add(g);
  eyes.push({ g, pill, lid, arc });
  halos.push(halo);
}
body.add(headGroup);
scene.add(root);
// The three-quarter attitude of the reference: a small yaw so one eye sits
// near the silhouette, and a little roll so the head is not square to camera.
// Square to camera. The three-quarter pose came from the design reference
// photo; front-on is what the badge wants: symmetric, both pods equal and
// level, the visor centred, and no diagonal bounding box eating the cell.
// The only survivor is a hair of pitch, which shows a sliver of the top dome
// and stops the ovoid reading as a flat disc.
const BASE_YAW = 0, BASE_ROLL = 0, BASE_PITCH = 0.035;

// The constant, gentle rotation, baked one frame per cell for the one state
// that means work is happening. The amplitude is deliberately small: at twelve
// frames (all the byte budget allows for a second sheet) a bigger sweep would
// move the eyes more than a pixel per step and read as stepping rather than
// turning. This way the largest step is under a pixel at 44px. Every term is a sine of an INTEGER multiple of
// 2*pi*t, so t=1 lands exactly on t=0: the loop is seamless by construction,
// and render_spin_atlas() also measures the wrap step against the inner ones.
// Rotation only, about the head's own centre, so nothing drifts across the
// cell. The yaw swing is small enough that the eyes never leave the glass.
const SPIN_YAW = 0.09, SPIN_ROLL = 0.030, SPIN_PITCH = 0.018;
function applySpin(t) {
  const w = Math.PI * 2 * t;
  root.rotation.set(
    BASE_PITCH + SPIN_PITCH * Math.sin(2 * w + 0.6),
    BASE_YAW + SPIN_YAW * Math.sin(w),
    BASE_ROLL + SPIN_ROLL * Math.sin(w + 1.9),
  );
}
applySpin(0);

const hex = (n) => new THREE.Color().setHex(n);

// State lives in the eyes. Same six names the rail and the board already
// use; nothing new is invented here.
//
// The vocabulary splits in two. A task that is NOT running closes its eyes:
// `completed` shuts them into content arcs, `interrupted` shuts them into
// flat lids. A task that is running but unhappy keeps them OPEN: `blocked`
// narrows them to bright vertical slits, `failed` angles them and lets the
// light go out of them. Open versus closed is a silhouette difference, which
// is the only kind that survives 18px.
function applyState(state, accent) {
  headGroup.rotation.set(0, 0, 0);
  body.rotation.set(0, 0, 0);
  for (const e of eyes) {
    e.g.scale.set(1, 1, 1);
    e.g.rotation.set(0, 0, 0);
    e.g.position.y = -0.02;
    e.pill.visible = true;
    e.lid.visible = false;
    e.arc.visible = false;
  }
  eyeMat.emissive.setHex(0xf4f8fc);
  eyeMat.emissiveIntensity = 1.7;
  eyeMat.color.setHex(0xffffff);
  shell.color.setHex(window.__shell);
  halos.forEach((h) => { h.material.color.setHex(accent); h.material.opacity = 0.62; h.visible = true; });

  if (state === 'active') {
    // wide open and brightest: work is happening
  } else if (state === 'approval') {
    // listening: an extra head tilt on top of the base attitude, the
    // universal "go on" posture
    headGroup.rotation.z = 0.20;
    eyeMat.emissiveIntensity = 1.85;
  } else if (state === 'blocked') {
    // awake and unhappy, NOT asleep: the eyes stay full height and bright and
    // narrow horizontally into slits, and the whole bot leans in
    for (const e of eyes) e.g.scale.set(0.62, 0.96, 1);
    body.rotation.x = 0.12;
    halos.forEach((h) => { h.material.opacity = 0.34; });
  } else if (state === 'failed') {
    // also awake, also unhappy, but the light has gone out of it. Angled AND
    // clearly dimmer than blocked, because at 18px a brightness step reads
    // where a two-pixel rotation does not.
    eyes[0].g.rotation.z = -0.62;
    eyes[1].g.rotation.z = 0.62;
    for (const e of eyes) e.g.scale.set(0.86, 0.50, 1);
    // and the head drops. A visor that sits low in the silhouette with a broad
    // forehead above it is a whole-shape change, and at a three-pixel face that
    // is the only difference big enough to survive.
    headGroup.rotation.x = 0.20;
    // dimmer than blocked, but the glass behind is near black: an eye that
    // drops much below this stops existing rather than reading as dulled
    eyeMat.emissiveIntensity = 1.1;
    eyeMat.emissive.setHex(0xd2dde7);
    eyeMat.color.setHex(0xc4cfda);
    halos.forEach((h) => { h.material.opacity = 0.26; });
  } else if (state === 'completed') {
    // eyes closed and content: the badge's happy arcs, as real geometry
    for (const e of eyes) { e.pill.visible = false; e.arc.visible = true; }
    eyeMat.emissiveIntensity = 1.62;
    halos.forEach((h) => { h.visible = false; });
    headGroup.rotation.x = 0.08;
  } else if (state === 'interrupted') {
    // Eyes shut. A lid bar the full width of the open eye, dim, level: the
    // bot is asleep, not staring with tiny eyes.
    //
    // Dormant, NOT faded. The old flat badge dropped the whole element to
    // 0.55 opacity; on a near-black rail a shaded 3D render treated that way
    // collapses into a muddy blob. The shell keeps its own contrast (only a
    // small step down) and the closed eyes carry the meaning.
    for (const e of eyes) { e.pill.visible = false; e.lid.visible = true; e.g.position.y = -0.06; }
    // The lid stays properly LIT. Dormancy is carried by the shape (a shut,
    // sagging lid) and by the shell stepping down, not by dimming the only
    // bright feature the badge has: measured on the real rail, dimming it is
    // what drops the badge's peak contrast and starts the slide back toward
    // the muddy blob this whole state was rebuilt to avoid.
    eyeMat.emissive.setHex(0xeaf2f9);
    eyeMat.emissiveIntensity = 1.68;
    eyeMat.color.setHex(0xe4ecf4);
    shell.color.setHex(window.__shellQuiet);
    halos.forEach((h) => { h.visible = false; });
  }
}

window.renderCell = (accentHex, shellHex, shellQuietHex, state, spinT) => {
  window.__shell = shellHex;
  window.__shellQuiet = shellQuietHex;
  podMat.color.setHex(accentHex);
  rim.color.setHex(accentHex);
  applySpin(spinT || 0);
  applyState(state, accentHex);
  renderer.render(scene, camera);
  const gl = renderer.getContext();
  const buf = new Uint8Array(SIZE_W * SIZE_H * 4);
  gl.readPixels(0, 0, SIZE_W, SIZE_H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) {
    s += String.fromCharCode.apply(null, buf.subarray(i, Math.min(i + CH, buf.length)));
  }
  return btoa(s);
};
window.__ready = true;
</script>
"""


class _Handler(http.server.BaseHTTPRequestHandler):
    page = b""

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/three.module.min.js"):
            data = THREE_JS.read_bytes()
            ctype = "text/javascript"
        elif self.path in ("/", "/index.html"):
            data = self.page
            ctype = "text/html; charset=utf-8"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):  # silence
        return


def _page(w: int, h: int) -> str:
    """The render page, sized for one cell."""
    return (PAGE.replace("__SIZE_W__", str(w))
                .replace("__SIZE_H__", str(h))
                .replace("__DIST__", str(CAMERA_DIST)))


def _serve(page_html: str):
    _Handler.page = page_html.encode("utf-8")
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _Handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


# --------------------------------------------------------------------------
# pixel work
# --------------------------------------------------------------------------
def _cell_from_raw(b64: str, w: int, h: int) -> np.ndarray:
    raw = np.frombuffer(base64.b64decode(b64), dtype=np.uint8)
    img = raw.reshape(h, w, 4)[::-1]  # WebGL reads bottom-up
    return img.astype(np.float32)


def _downsample(img: np.ndarray, factor: int) -> np.ndarray:
    h, w, c = img.shape
    return img.reshape(h // factor, factor, w // factor, factor, c).mean(axis=(1, 3))


def _unpremultiply(img: np.ndarray) -> np.ndarray:
    """Undo the coverage weighting the MSAA resolve bakes into RGB.

    A partly covered edge pixel comes back as coverage*colour with alpha =
    coverage, i.e. premultiplied. Written straight to a PNG that is a dark
    fringe: invisible on the dark theme, a dirty outline on the light one.
    Dividing RGB back out by alpha restores the true edge colour.
    """
    out = img.copy()
    a = out[:, :, 3:4] / 255.0
    safe = np.where(a > 1e-4, a, 1.0)
    out[:, :, :3] = np.clip(out[:, :, :3] / safe, 0, 255)
    out[:, :, :3] = np.where(a > 1e-4, out[:, :, :3], 0)
    return out


# How much of the harness accent the shell IS. Not a wash: the bot reads as
# being its harness colour. HARNESS_COLORS itself is never touched, the tint is
# derived from it.
SHELL_TINT = (0.72, 0.66)   # dark theme, light theme

# The floor that keeps the character intact. The visor is near black, so a
# shell that goes too dark stops separating from it and the whole badge
# collapses into one blob. Any harness whose accent is too dark to take the
# full strength is pulled back toward the neutral shell until it clears this,
# which keeps its hue and only gives up saturation.
#
# Per theme, because the two neutrals are not the same kind of object: the
# dark theme's shell is light (luminance 0.79) and can afford a high floor,
# while the light theme's is already a dark slate (0.118) and a floor above
# that would forbid every tint. Each is set just under its own neutral, so the
# rule is "a tinted shell may not be darker than the untinted one was".
SHELL_MIN_LUM = (0.17, 0.105)


def _srgb_lum(rgb: int) -> float:
    """Relative luminance, WCAG definition."""
    out = 0.0
    for shift, k in ((16, 0.2126), (8, 0.7152), (0, 0.0722)):
        c = ((rgb >> shift) & 0xFF) / 255.0
        out += k * (c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return out


def _shell_tint(accent: int | None, theme_index: int) -> int:
    """The harness shell: the neutral shell pulled most of the way to the accent.

    Returns the strongest tint at or below SHELL_TINT whose luminance still
    clears this theme's SHELL_MIN_LUM, found by bisection so the result is
    deterministic.
    """
    neutral = THEMES[theme_index][1]
    if accent is None:
        return neutral
    target, floor = SHELL_TINT[theme_index], SHELL_MIN_LUM[theme_index]
    full = _blend(neutral, accent, target)
    if _srgb_lum(full) >= floor:
        return full
    lo, hi = 0.0, target
    for _ in range(24):
        mid = (lo + hi) / 2
        if _srgb_lum(_blend(neutral, accent, mid)) >= floor:
            lo = mid
        else:
            hi = mid
    return _blend(neutral, accent, lo)


def shell_report() -> list[dict]:
    """What every harness actually ended up with, and whether it was clamped."""
    harnesses, _ = read_layout()
    rows = []
    for name, color in harnesses:
        accent = int(color[1:], 16)
        for ti, (theme, _n) in enumerate(THEMES):
            shell = _shell_tint(accent, ti)
            full = _blend(THEMES[ti][1], accent, SHELL_TINT[ti])
            rows.append({
                "harness": name, "theme": theme, "accent": color,
                "shell": f"#{shell:06x}", "lum": round(_srgb_lum(shell), 4),
                "clamped": shell != full,
            })
    return rows


def _quiet_shell(theme_index: int, shell_hex: int) -> int:
    """The dormant shell: one small step toward the theme's own background.

    Never a fade of the whole figure, which is what made `interrupted`
    illegible on the near-black rail.
    """
    # Kept small on purpose. The closed lids already say "stopped", and the
    # measured cost of a bigger step is the badge's peak contrast against the
    # near-black rail, which is the thing that must not regress.
    if theme_index == 0:
        return _blend(shell_hex, 0x9AA5B1, 0.16)
    return _blend(shell_hex, 0x7C8894, 0.30)


@contextmanager
def _renderer(w: int, h: int):
    """Serve the render page at w x h px and yield a render(...) callable."""
    from playwright.sync_api import sync_playwright

    httpd = _serve(_page(w, h))
    port = httpd.server_address[1]
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=[
                "--enable-unsafe-swiftshader",
                "--use-gl=angle",
                "--force-device-scale-factor=1",
                "--hide-scrollbars",
            ])
            page = browser.new_page(viewport={"width": w + 40, "height": h + 40})
            page.goto(f"http://127.0.0.1:{port}/", wait_until="load")
            page.wait_for_function("window.__ready === true", timeout=30000)

            def render(accent: int, shell_hex: int, quiet_hex: int, state: str,
                       spin_t: float = 0.0) -> np.ndarray:
                b64 = page.evaluate(
                    "a => window.renderCell(a[0], a[1], a[2], a[3], a[4])",
                    [accent, shell_hex, quiet_hex, state, spin_t],
                )
                return _cell_from_raw(b64, w, h)

            yield render
            browser.close()
    finally:
        httpd.shutdown()


def render_atlas() -> Image.Image:
    harnesses, states = read_layout()
    w, h = CELL * SUPERSAMPLE, CELL_H * SUPERSAMPLE
    cols, rows = len(states), len(harnesses) * len(THEMES)
    atlas = np.zeros((rows * CELL_H, cols * CELL, 4), dtype=np.float32)

    with _renderer(w, h) as render:
        for ti, (_theme, _neutral) in enumerate(THEMES):
            for hi, (_name, color) in enumerate(harnesses):
                accent = int(color[1:], 16)
                shell_hex = _shell_tint(accent, ti)
                quiet = _quiet_shell(ti, shell_hex)
                for si, state in enumerate(states):
                    raw = render(accent, shell_hex, quiet, state)
                    cell = _downsample(raw, SUPERSAMPLE)
                    r = ti * len(harnesses) + hi
                    atlas[r * CELL_H:(r + 1) * CELL_H, si * CELL:(si + 1) * CELL] = cell

    out = _unpremultiply(atlas)
    _assert_no_clipping(out, cols, rows)
    return Image.fromarray(np.rint(out).astype(np.uint8), "RGBA")


def render_spin_atlas() -> Image.Image:
    """The rotation sheet: one row per harness per theme, one column per frame.

    Only SPIN_STATE is rendered. The frames walk t = i / SPIN_FRAMES over one
    full period of the oscillation, so the last frame is one step short of
    t = 1 and wraps onto frame 0 exactly.
    """
    harnesses, _states = read_layout()
    w, h = SPIN_CELL * SPIN_SUPERSAMPLE, SPIN_CELL_H * SPIN_SUPERSAMPLE
    cols, rows = SPIN_FRAMES, len(harnesses) * len(THEMES)
    atlas = np.zeros((rows * SPIN_CELL_H, cols * SPIN_CELL, 4), dtype=np.float32)

    with _renderer(w, h) as render:
        for ti, (_theme, _neutral) in enumerate(THEMES):
            for hi, (_name, color) in enumerate(harnesses):
                accent = int(color[1:], 16)
                shell_hex = _shell_tint(accent, ti)
                quiet = _quiet_shell(ti, shell_hex)
                r = ti * len(harnesses) + hi
                for f in range(SPIN_FRAMES):
                    raw = render(accent, shell_hex, quiet, SPIN_STATE, f / SPIN_FRAMES)
                    cell = _downsample(raw, SPIN_SUPERSAMPLE)
                    atlas[r * SPIN_CELL_H:(r + 1) * SPIN_CELL_H,
                          f * SPIN_CELL:(f + 1) * SPIN_CELL] = cell

    out = _unpremultiply(atlas)
    _assert_no_clipping(out, cols, rows, cw=SPIN_CELL, ch=SPIN_CELL_H)
    return Image.fromarray(np.rint(out).astype(np.uint8), "RGBA")


def seam_report(img: Image.Image, frames: int = SPIN_FRAMES) -> dict:
    """Measure the wrap step against the inner steps, in the decoded PNG.

    A loop is seamless when going from the last frame back to the first costs
    no more than any other step. Anything much larger than the inner steps is
    the pop you would see once per cycle.
    """
    a = np.asarray(img).astype(np.float32)
    rows = a.shape[0] // SPIN_CELL_H
    inner, wrap = [], []
    for r in range(rows):
        band = a[r * SPIN_CELL_H:(r + 1) * SPIN_CELL_H]
        cells = [band[:, f * SPIN_CELL:(f + 1) * SPIN_CELL] for f in range(frames)]
        for f in range(frames):
            step = float(np.sqrt(((cells[f] - cells[(f + 1) % frames]) ** 2).mean()))
            (wrap if f == frames - 1 else inner).append(step)
    worst_inner = max(inner)
    worst_wrap = max(wrap)
    return {
        "frames": frames,
        "mean_inner_step": round(float(np.mean(inner)), 4),
        "max_inner_step": round(worst_inner, 4),
        "max_wrap_step": round(worst_wrap, 4),
        "wrap_over_max_inner": round(worst_wrap / worst_inner, 4) if worst_inner else None,
        "seamless": bool(worst_wrap <= worst_inner * 1.25),
    }


def render_match(path: Path, px: int = 420, state: str = "active",
                 harness: str | None = None) -> Image.Image:
    """One large cell, for eyeballing the model against a design reference.

    Not part of the shipped atlas: the cells are only ever seen at 18 to 44px,
    so a big render is the only way to judge silhouette, visor wrap and gloss.
    """
    harnesses, _states = read_layout()
    color = dict(harnesses).get(harness or "")
    accent = int(color[1:], 16) if color else 0xE8EEF4
    # no harness named: the neutral shell, which is also what an unknown
    # harness would look like if it had a cell at all
    shell_hex = _shell_tint(int(color[1:], 16) if color else None, 0)
    ph = int(round(px * CELL_H / CELL))
    with _renderer(px * 2, ph * 2) as render:
        raw = render(accent, shell_hex, _quiet_shell(0, shell_hex), state)
    img = _unpremultiply(_downsample(raw, 2))
    out = Image.fromarray(np.rint(img).astype(np.uint8), "RGBA")
    out.save(path)
    return out


def _assert_no_clipping(atlas: np.ndarray, cols: int, rows: int,
                       cw: int = CELL, ch: int = CELL_H) -> None:
    """No cell may touch its own border, or a neighbour bleeds into it."""
    worst = 0
    for r in range(rows):
        for c in range(cols):
            box = atlas[r * ch:(r + 1) * ch, c * cw:(c + 1) * cw, 3]
            edge = np.concatenate([box[0], box[-1], box[:, 0], box[:, -1]])
            worst = max(worst, int(edge.max()))
    if worst:
        raise SystemExit(f"a cell touches its border (max edge alpha {worst}); pull the camera back")


def _blend(a: int, b: int, t: float) -> int:
    out = 0
    for sh in (16, 8, 0):
        ca, cb = (a >> sh) & 0xFF, (b >> sh) & 0xFF
        out |= int(round(ca + (cb - ca) * t)) << sh
    return out


def _png(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True, compress_level=9)
    return buf.getvalue()


def _encode(img: Image.Image, budget: int = MAX_BYTES) -> tuple[bytes, int]:
    """PNG the atlas, trimming interior colour depth only as far as needed.

    Seventy-two shaded spheres of smooth gradient is exactly what PNG is worst
    at, and full 8-bit RGBA lands over the 400KB budget. Colour depth is
    dropped one bit at a time and ONLY for fully opaque pixels: every pixel on
    the silhouette keeps its full precision, so nothing here can reintroduce
    an edge fringe. The cells are never displayed above 44px (a 3x downscale),
    which is why the banding this trades away is not visible in use.

    Returns (png bytes, bits kept in the interior; 8 means untouched).
    """
    data = _png(img)
    if len(data) <= budget:
        return data, 8
    src = np.asarray(img)
    opaque = src[:, :, 3] == 255
    for bits in (6, 5, 4, 3):
        a = src.astype(np.int16).copy()
        step = 1 << (8 - bits)
        quant = np.clip((a[:, :, :3] // step) * step + step // 2, 0, 255)
        a[:, :, :3] = np.where(opaque[:, :, None], quant, a[:, :, :3])
        data = _png(Image.fromarray(a.astype(np.uint8), "RGBA"))
        if len(data) <= budget:
            return data, bits
    return data, 3


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true",
                    help="re-render and compare against the committed atlas instead of writing it")
    ap.add_argument("--match", metavar="PATH",
                    help="render ONE large cell to PATH instead of the atlas, for comparing the "
                         "model against a design reference (the shipped cells are only ever seen "
                         "at 18 to 44px)")
    ap.add_argument("--match-state", default="active", help="--match: which state to render")
    ap.add_argument("--match-harness", default=None, help="--match: whose accent to use")
    ap.add_argument("--match-px", type=int, default=420, help="--match: output size in px")
    ap.add_argument("--tolerance", type=float, default=2.0,
                    help="--check: allowed mean absolute channel difference (GPU rasterisers "
                         "are not bit-identical across machines)")
    args = ap.parse_args()

    harnesses, states = read_layout()

    if args.match:
        out = render_match(Path(args.match), px=args.match_px,
                           state=args.match_state, harness=args.match_harness)
        print(json.dumps({"match": args.match, "size": list(out.size),
                          "state": args.match_state, "harness": args.match_harness}))
        return 0

    img = render_atlas()
    data, bits = _encode(img)
    spin_img = render_spin_atlas()
    spin_data, spin_bits = _encode(spin_img, SPIN_MAX_BYTES)
    seam = seam_report(Image.open(BytesIO(spin_data)).convert("RGBA"))

    if args.check:
        rc = 0
        report = {"check": "pass"}
        for name, path, fresh_bytes in (("atlas", ATLAS, data), ("spin", SPIN, spin_data)):
            if not path.exists():
                print(f"FAIL: {path} is missing")
                return 1
            have = Image.open(path).convert("RGBA")
            fresh = Image.open(BytesIO(fresh_bytes)).convert("RGBA")
            if have.size != fresh.size:
                print(f"FAIL: committed {name} is {have.size}, fresh render is {fresh.size}")
                return 1
            diff = np.abs(np.asarray(have, np.float32) - np.asarray(fresh, np.float32))
            mean = float(diff.mean())
            report[name] = {"size": list(fresh.size), "mean_abs_diff": round(mean, 4),
                            "max_abs_diff": round(float(diff.max()), 1)}
            if mean > args.tolerance:
                report["check"] = "fail"
                rc = 1
        report["tolerance"] = args.tolerance
        report["seam"] = seam
        if not seam["seamless"]:
            report["check"] = "fail"
            rc = 1
        print(json.dumps(report))
        return rc

    ATLAS.parent.mkdir(parents=True, exist_ok=True)
    ATLAS.write_bytes(data)
    SPIN.write_bytes(spin_data)
    over = len(data) > MAX_BYTES or len(spin_data) > SPIN_MAX_BYTES
    print(json.dumps({
        "atlas": str(ATLAS.relative_to(REPO)),
        "cols": len(states), "rows": len(harnesses) * len(THEMES),
        "cell": CELL, "size": list(img.size),
        "bytes": len(data), "interior_bits": bits,
        "spin": str(SPIN.relative_to(REPO)),
        "spin_state": SPIN_STATE, "spin_frames": SPIN_FRAMES,
        "spin_cell": SPIN_CELL, "spin_size": list(spin_img.size),
        "spin_bytes": len(spin_data), "spin_interior_bits": spin_bits,
        "seam": seam,
        "limit": MAX_BYTES, "spin_limit": SPIN_MAX_BYTES, "under_limit": not over,
        "states": states, "harnesses": [h for h, _ in harnesses],
        "themes": [t for t, _ in THEMES],
    }, indent=1))
    if not seam["seamless"]:
        print("FAIL: the rotation loop is not seamless", file=sys.stderr)
        return 1
    return 1 if over else 0


if __name__ == "__main__":
    sys.exit(main())
