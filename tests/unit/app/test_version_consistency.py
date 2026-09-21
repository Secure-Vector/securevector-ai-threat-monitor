"""One product, one version number, in every place that prints one.

`sv-monitor --version` printed "SecureVector AI Threat Monitor 1.0.0" while the
package was 5.3.0, for as long as nobody looked: a hardcoded string has no
reason to move when the release does. It surfaced only because the npm launcher
ran the real CLI and the two numbers disagreed on screen.

These tests pin the three declarations to each other and, more importantly, pin
the CLI to deriving its version rather than repeating it.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def declared(path: Path) -> str:
    m = re.search(r'__version__\s*=\s*"([^"]+)"', path.read_text(encoding="utf-8"))
    assert m, f"no __version__ in {path}"
    return m.group(1)


def test_the_package_and_the_app_agree():
    """Two declarations that must move together on every release bump; the
    app one carries a comment saying so, which is not the same as a check."""
    assert declared(ROOT / "src/securevector/__init__.py") == declared(
        ROOT / "src/securevector/app/__init__.py"
    )


def test_the_npm_launcher_agrees():
    """The launcher installs `securevector-ai-monitor==<its own version>`. If
    it drifts it pins a PyPI release that does not exist, and the failure lands
    on a user rather than in CI."""
    npm = json.loads((ROOT / "npm/package.json").read_text(encoding="utf-8"))
    assert npm["version"] == declared(ROOT / "src/securevector/__init__.py")


def test_the_cli_derives_its_version_rather_than_repeating_it():
    """The actual fix. Matching numbers today is worth little if the next bump
    can leave one behind, so the CLI must not contain a version literal at all."""
    src = (ROOT / "src/securevector/cli.py").read_text(encoding="utf-8")
    assert "from securevector import __version__" in src
    assert "{__version__}" in src, "the --version string must interpolate, not hardcode"
    assert not re.search(r'version="SecureVector[^"]*\d+\.\d+\.\d+', src), (
        "a literal version string is back in cli.py"
    )


def test_the_cli_actually_prints_the_declared_version():
    """End to end, because the two tests above can both pass while the wiring
    is broken."""
    out = subprocess.run(
        [sys.executable, "-m", "securevector.cli", "--version"],
        capture_output=True,
        text=True,
        cwd=ROOT,
        env={"PYTHONPATH": str(ROOT / "src"), "PATH": "/usr/bin:/bin"},
        timeout=60,
    )
    printed = (out.stdout + out.stderr).strip()
    assert declared(ROOT / "src/securevector/__init__.py") in printed, printed
