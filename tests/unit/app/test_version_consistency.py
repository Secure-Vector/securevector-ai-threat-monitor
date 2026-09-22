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


def test_nothing_reports_a_version_of_its_own():
    """No module may declare a version literal that is not the package's.

    The original version of this file pinned the three declarations it knew
    about. It did not look for others, so two more sat there for five releases:
    the MCP subpackage said 3.4.0 and the MCP server told every client it was
    version 1.0.0, both because a literal is a thing nobody remembers to bump
    and nothing was checking.

    This looks instead. Any `__version__ = "..."` or `version: str = "..."`
    under src/securevector must either be the real version or be derived, and
    a new one fails here rather than in a client's logs.

    One exemption, and it is a real distinction rather than a convenience: a
    security policy document carries its own schema version, which has nothing
    to do with which release of SecureVector is reading it and must NOT move
    when the product does. Those live in one module and are named here.
    """
    import re

    root = ROOT / "src" / "securevector"
    expected = declared(ROOT / "src/securevector/__init__.py")

    # Versions that describe something other than this package.
    NOT_THE_PRODUCT = {"models/policy_models.py"}

    offenders = []
    for path in sorted(root.rglob("*.py")):
        rel = path.relative_to(root)
        if rel.as_posix() in NOT_THE_PRODUCT:
            continue
        text = path.read_text(encoding="utf-8")
        for match in re.finditer(
            r'^\s*(?:__version__|version)\s*(?::\s*str\s*)?=\s*["\']([^"\']+)["\']',
            text,
            re.M,
        ):
            literal = match.group(1)
            if literal == expected:
                continue
            line = text[: match.start()].count("\n") + 1
            offenders.append(f"{rel}:{line} declares version {literal!r}")

    assert not offenders, (
        "these declare a version literal that is not "
        f"{expected!r}; derive it from securevector.__version__ instead:\n  "
        + "\n  ".join(offenders)
    )
