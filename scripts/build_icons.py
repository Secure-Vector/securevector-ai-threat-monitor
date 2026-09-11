#!/usr/bin/env python3
"""Build the desktop application icons from the master favicon artwork.

Produces, next to the source artwork (``src/securevector/app/assets`` by
default):

* ``app-icon-1024.png``  square 1024px master (RGBA)
* ``app-icon-256.png``   256px PNG for Linux desktop entries and AppImage
* ``app-icon.icns``      macOS icon set, 16 through 1024 including @2x
* ``app-icon.ico``       Windows icon, 16 / 24 / 32 / 48 / 64 / 128 / 256

The web favicon files (``favicon.svg``, ``favicon.png``, ``favicon.ico``)
are inputs only and are never modified.

The master favicon is drawn as a 42px raster wrapped in ``favicon.svg``, so
there is no vector path to rasterize. To keep the mark identical while making
it sharp at Dock / Alt-Tab / Explorer sizes the script separates the artwork
into layers, upscales each the way it wants to be upscaled, and recomposes:

* background: the rounded-square gradient, which is smooth, so a bicubic
  upscale of the gradient (with the white mark inpainted away) is exact;
* mark: the white shield and V, whose coverage mask is upscaled and then
  re-sharpened so edges are crisp instead of blurry;
* alpha: the rounded square, whose corner radius is measured from the source
  and rendered analytically.

Downsampling the result back to 42px reproduces the original favicon to
within a couple of grey levels, which is the fidelity check the unit test
enforces.

If ``favicon.svg`` ever becomes a real vector drawing, the script rasterizes
it directly instead, using ``cairosvg`` (``pip install cairosvg``) or
``rsvg-convert`` (``brew install librsvg`` / ``apt install librsvg2-bin``).

Requirements: Pillow and numpy (both present in the dev environment; install
with ``pip install pillow numpy`` otherwise). ``iconutil`` is used for the
``.icns`` when available (macOS); elsewhere Pillow writes the ``.icns``.

Usage::

    python3 scripts/build_icons.py                # regenerate into assets/
    python3 scripts/build_icons.py --out-dir /tmp/icons
"""

from __future__ import annotations

import argparse
import base64
import io
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import numpy as np
    from PIL import Image, ImageDraw
except ImportError as exc:  # pragma: no cover - environment dependent
    sys.exit(f"build_icons needs Pillow and numpy: pip install pillow numpy ({exc})")

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = REPO_ROOT / "src" / "securevector" / "app" / "assets" / "favicon.svg"

MASTER_SIZE = 1024
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
# (point size, scale) pairs Apple expects in an iconset.
ICNS_SET = (
    (16, 1), (16, 2),
    (32, 1), (32, 2),
    (128, 1), (128, 2),
    (256, 1), (256, 2),
    (512, 1), (512, 2),
)

_VECTOR_TAGS = ("path", "rect", "circle", "ellipse", "polygon", "polyline", "line", "text")
_DATA_URI_RE = re.compile(r'href="data:image/(png|jpeg|jpg);base64,([^"]+)"')


# --------------------------------------------------------------------------
# Source loading
# --------------------------------------------------------------------------

def svg_has_vector_content(svg_text: str) -> bool:
    """True when the SVG draws with real shapes rather than an embedded bitmap."""
    return any(re.search(rf"<{tag}\b", svg_text) for tag in _VECTOR_TAGS)


def embedded_raster(svg_text: str) -> Image.Image | None:
    """Return the bitmap embedded in ``<image href="data:...">``, if any."""
    match = _DATA_URI_RE.search(svg_text)
    if not match:
        return None
    return Image.open(io.BytesIO(base64.b64decode(match.group(2)))).convert("RGBA")


def rasterize_vector_svg(svg_path: Path, size: int) -> Image.Image:
    """Rasterize a vector SVG at ``size`` px using cairosvg or rsvg-convert."""
    try:
        import cairosvg  # type: ignore

        png = cairosvg.svg2png(url=str(svg_path), output_width=size, output_height=size)
        return Image.open(io.BytesIO(png)).convert("RGBA")
    except Exception:  # noqa: BLE001 - fall through to rsvg-convert
        pass
    rsvg = shutil.which("rsvg-convert")
    if rsvg:
        png = subprocess.run(
            [rsvg, "-w", str(size), "-h", str(size), "-f", "png", str(svg_path)],
            check=True, capture_output=True,
        ).stdout
        return Image.open(io.BytesIO(png)).convert("RGBA")
    sys.exit(
        "favicon.svg contains vector shapes but no rasterizer is available. "
        "Install one: pip install cairosvg  (or)  brew install librsvg"
    )


def load_master(source: Path, size: int = MASTER_SIZE) -> Image.Image:
    """Build the square ``size`` px RGBA master from the SVG or PNG source."""
    if source.suffix.lower() == ".svg":
        text = source.read_text(encoding="utf-8")
        raster = embedded_raster(text)
        if raster is None or svg_has_vector_content(text):
            return rasterize_vector_svg(source, size)
    else:
        raster = Image.open(source).convert("RGBA")
    if raster.width != raster.height:
        sys.exit(f"source artwork must be square, got {raster.width}x{raster.height}")
    return faithful_upscale(raster, size)


# --------------------------------------------------------------------------
# Faithful raster upscale
# --------------------------------------------------------------------------

def _resize_float(arr: np.ndarray, size: int) -> np.ndarray:
    img = Image.fromarray(arr.astype(np.float32), "F")
    return np.asarray(img.resize((size, size), Image.Resampling.BICUBIC), dtype=np.float64)


def _gaussian(arr: np.ndarray, sigma: float) -> np.ndarray:
    if sigma <= 0:
        return arr
    radius = int(3 * sigma)
    x = np.arange(-radius, radius + 1, dtype=np.float64)
    kernel = np.exp(-x * x / (2 * sigma * sigma))
    kernel /= kernel.sum()
    padded = np.pad(arr, ((radius, radius), (radius, radius)), mode="edge")
    rows = np.apply_along_axis(lambda v: np.convolve(v, kernel, mode="valid"), 1, padded)
    return np.apply_along_axis(lambda v: np.convolve(v, kernel, mode="valid"), 0, rows)


def _local_min3(arr: np.ndarray) -> np.ndarray:
    padded = np.pad(arr, 1, mode="edge")
    stack = [padded[dy:dy + arr.shape[0], dx:dx + arr.shape[1]] for dy in range(3) for dx in range(3)]
    return np.min(np.stack(stack), axis=0)


def _diffusion_fill(rgb: np.ndarray, known: np.ndarray, max_iter: int = 5000) -> np.ndarray:
    """Fill the unknown pixels of ``rgb`` by iterative averaging of neighbours."""
    filled = rgb.copy()
    unknown = ~known
    for _ in range(max_iter):
        p = np.pad(filled, ((1, 1), (1, 1), (0, 0)), mode="edge")
        neighbours = (p[:-2, 1:-1] + p[2:, 1:-1] + p[1:-1, :-2] + p[1:-1, 2:]) / 4.0
        nxt = filled.copy()
        nxt[unknown] = neighbours[unknown]
        delta = np.abs(nxt - filled).max()
        filled = nxt
        if delta < 1e-3:
            break
    return filled


def measure_corner_radius(alpha: np.ndarray) -> float:
    """Return the rounded-square corner radius as a fraction of the side length."""
    n = alpha.shape[0]
    best_err, best_r = None, 0.0
    ss = 8
    for r10 in range(0, n * 5, 1):
        r = r10 / 10.0
        big = Image.new("L", (n * ss, n * ss), 0)
        ImageDraw.Draw(big).rounded_rectangle((0, 0, n * ss - 1, n * ss - 1), radius=r * ss, fill=255)
        mask = np.asarray(big.resize((n, n), Image.Resampling.BOX), dtype=np.float64) / 255.0
        err = float(np.abs(mask - alpha).sum())
        if best_err is None or err < best_err:
            best_err, best_r = err, r
    return best_r / n


def render_rounded_square(size: int, radius_fraction: float) -> np.ndarray:
    ss = 4
    big = Image.new("L", (size * ss, size * ss), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, size * ss - 1, size * ss - 1), radius=radius_fraction * size * ss, fill=255
    )
    return np.asarray(big.resize((size, size), Image.Resampling.BOX), dtype=np.float64) / 255.0


def faithful_upscale(source: Image.Image, size: int) -> Image.Image:
    """Upscale the 42px favicon to ``size`` px without changing the mark."""
    src = np.asarray(source.convert("RGBA"), dtype=np.float64)
    rgb, alpha = src[..., :3], src[..., 3] / 255.0
    scale = size / src.shape[0]

    # Background = pixels no lighter than their 3x3 neighbourhood minimum
    # (plus a small tolerance for the gradient slope). Anti-aliased edge
    # pixels of the white mark are lighter than their neighbours, so they
    # are excluded and inpainted from the surrounding gradient instead.
    min_channel = rgb.min(axis=2)
    background = (alpha > 0.99) & (min_channel - _local_min3(min_channel) <= 12)
    # The outermost ring of the source was flattened against a dark page
    # backdrop before its hard alpha was applied. Bicubic upscaling would
    # smear that 1px rim into a wide dark band, so inpaint it from inside.
    interior = np.pad(alpha[1:-1, 1:-1] > 0.99, 1, constant_values=False)
    interior &= _local_min3(alpha) > 0.99
    background &= interior
    bg = _diffusion_fill(rgb, background)

    # Coverage of the white mark per source pixel, relative to the inpainted
    # background beneath it.
    headroom = np.clip(255.0 - bg, 1.0, None)
    coverage = np.clip(((rgb - bg) / headroom).mean(axis=2), 0.0, 1.0)
    coverage[alpha < 0.01] = 0.0

    bg_up = np.stack([_resize_float(bg[..., c], size) for c in range(3)], axis=2)

    # Upscale the mask, smooth away the pixel-grid ripple, then compress the
    # transition back to about 3px so edges are crisp at 1024.
    mask = _gaussian(_resize_float(coverage, size), sigma=scale * 0.4)
    gain = scale / 3.0
    mask = np.clip((mask - 0.5) * gain + 0.5, 0.0, 1.0)
    mask = mask * mask * (3.0 - 2.0 * mask)

    alpha_up = render_rounded_square(size, measure_corner_radius(alpha))

    out = np.empty((size, size, 4), dtype=np.float64)
    out[..., :3] = bg_up * (1.0 - mask[..., None]) + 255.0 * mask[..., None]
    out[..., 3] = alpha_up * 255.0
    return Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), "RGBA")


# --------------------------------------------------------------------------
# Output formats
# --------------------------------------------------------------------------

def downsample(master: Image.Image, size: int) -> Image.Image:
    if size == master.width:
        return master.copy()
    return master.resize((size, size), Image.Resampling.LANCZOS)


def write_ico(master: Image.Image, path: Path, sizes=ICO_SIZES) -> None:
    frames = [downsample(master, s) for s in sizes]
    frames[-1].save(path, format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1])


def write_icns(master: Image.Image, path: Path) -> str:
    """Write the .icns; returns which tool produced it ("iconutil" or "pillow")."""
    iconutil = shutil.which("iconutil")
    if iconutil:
        with tempfile.TemporaryDirectory() as tmp:
            iconset = Path(tmp) / "app-icon.iconset"
            iconset.mkdir()
            for points, scale in ICNS_SET:
                suffix = "" if scale == 1 else f"@{scale}x"
                downsample(master, points * scale).save(iconset / f"icon_{points}x{points}{suffix}.png")
            subprocess.run([iconutil, "-c", "icns", str(iconset), "-o", str(path)], check=True)
        return "iconutil"
    pixel_sizes = sorted({points * scale for points, scale in ICNS_SET})
    frames = [downsample(master, s) for s in pixel_sizes]
    master.save(path, format="ICNS", append_images=frames)
    return "pillow"


def build_all(source: Path, out_dir: Path, master_size: int = MASTER_SIZE) -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    master = load_master(source, master_size)
    outputs = {
        "master": out_dir / f"app-icon-{master_size}.png",
        "png256": out_dir / "app-icon-256.png",
        "ico": out_dir / "app-icon.ico",
        "icns": out_dir / "app-icon.icns",
    }
    master.save(outputs["master"], optimize=True)
    downsample(master, 256).save(outputs["png256"], optimize=True)
    write_ico(master, outputs["ico"])
    write_icns(master, outputs["icns"])
    return outputs


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="favicon.svg or a square PNG")
    parser.add_argument("--out-dir", type=Path, default=None, help="defaults to the source directory")
    parser.add_argument("--size", type=int, default=MASTER_SIZE, help="master PNG size (default 1024)")
    args = parser.parse_args(argv)

    source = args.source.resolve()
    if not source.exists():
        parser.error(f"source not found: {source}")
    outputs = build_all(source, (args.out_dir or source.parent).resolve(), args.size)
    for key, path in outputs.items():
        print(f"{key:>7}: {path} ({path.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
