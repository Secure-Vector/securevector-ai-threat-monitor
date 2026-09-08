"""Tests for scripts/build_icons.py, the desktop app icon generator."""

import importlib.util
import shutil
import subprocess
from pathlib import Path

import pytest

pytest.importorskip("numpy")
Image = pytest.importorskip("PIL.Image")

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "build_icons.py"
ASSETS = REPO_ROOT / "src" / "securevector" / "app" / "assets"
FAVICON_SVG = ASSETS / "favicon.svg"
FAVICON_PNG = ASSETS / "favicon.png"


def _load_module():
    spec = importlib.util.spec_from_file_location("build_icons", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def build_icons():
    return _load_module()


@pytest.fixture(scope="module")
def outputs(build_icons, tmp_path_factory):
    out_dir = tmp_path_factory.mktemp("icons")
    return build_icons.build_all(FAVICON_SVG, out_dir)


def test_svg_content_detection(build_icons):
    assert build_icons.svg_has_vector_content('<svg><path d="M0 0h1"/></svg>')
    assert not build_icons.svg_has_vector_content(FAVICON_SVG.read_text(encoding="utf-8"))
    embedded = build_icons.embedded_raster(FAVICON_SVG.read_text(encoding="utf-8"))
    assert embedded is not None
    assert embedded.size == (42, 42)


def test_master_is_1024_rgba_rounded_square(outputs):
    master = Image.open(outputs["master"])
    assert master.size == (1024, 1024)
    assert master.mode == "RGBA"
    # Rounded corners are transparent, edges and centre are opaque.
    for corner in ((0, 0), (1023, 0), (0, 1023), (1023, 1023)):
        assert master.getpixel(corner)[3] == 0
    assert master.getpixel((512, 0))[3] == 255
    assert master.getpixel((0, 512))[3] == 255
    # The centre of the V is solid white.
    assert master.getpixel((512, 512))[:3] == (255, 255, 255)


def test_master_reproduces_the_favicon_when_downsampled(outputs):
    """The high-res icon must be the same mark: shrinking it back to 42px
    has to land within a few grey levels of the original favicon."""
    import numpy as np

    original = np.asarray(Image.open(FAVICON_PNG).convert("RGBA"), dtype=float)
    master = Image.open(outputs["master"])
    roundtrip = np.asarray(master.resize((42, 42), Image.Resampling.LANCZOS), dtype=float)
    colour_diff = np.abs(roundtrip[..., :3] - original[..., :3]).mean()
    assert colour_diff < 8.0, f"mean colour difference {colour_diff:.2f} too high"
    alpha_diff = np.abs(roundtrip[..., 3] - original[..., 3]).mean()
    assert alpha_diff < 8.0, f"mean alpha difference {alpha_diff:.2f} too high"


def test_ico_has_every_windows_size(outputs):
    ico = Image.open(outputs["ico"])
    sizes = sorted(ico.ico.sizes())
    assert sizes == [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def test_png256(outputs):
    png = Image.open(outputs["png256"])
    assert png.size == (256, 256)
    assert png.mode == "RGBA"


def test_icns_has_full_size_set(outputs, tmp_path):
    icns = outputs["icns"]
    assert icns.read_bytes()[:4] == b"icns"
    iconutil = shutil.which("iconutil")
    if iconutil:
        iconset = tmp_path / "check.iconset"
        subprocess.run([iconutil, "-c", "iconset", str(icns), "-o", str(iconset)], check=True)
        names = sorted(p.name for p in iconset.iterdir())
        expected = sorted(
            f"icon_{pt}x{pt}{'' if scale == 1 else f'@{scale}x'}.png"
            for pt, scale in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2),
                              (256, 1), (256, 2), (512, 1), (512, 2)]
        )
        assert names == expected
        assert Image.open(iconset / "icon_512x512@2x.png").size == (1024, 1024)
    else:
        image = Image.open(icns)
        sizes = {(w, h, s) for w, h, s in image.info["sizes"]}
        assert (512, 512, 2) in sizes
        assert (16, 16, 2) in sizes


def test_committed_assets_are_present_and_well_formed():
    """The generated files checked into assets/ are what the build consumes."""
    ico = Image.open(ASSETS / "app-icon.ico")
    assert (256, 256) in ico.ico.sizes() and (16, 16) in ico.ico.sizes()
    assert (ASSETS / "app-icon.icns").read_bytes()[:4] == b"icns"
    assert Image.open(ASSETS / "app-icon-1024.png").size == (1024, 1024)
    assert Image.open(ASSETS / "app-icon-256.png").size == (256, 256)
    # The web favicon files are inputs and stay untouched.
    assert Image.open(ASSETS / "favicon.png").size == (42, 42)
    assert sorted(Image.open(ASSETS / "favicon.ico").ico.sizes()) == [(32, 32)]
