"""Per-plugin LICENSE / PRIVACY consistency.

Each Guard plugin is an independently-distributed artifact — only its own
directory ships on install (`copilot plugin install`, the Claude/Codex cache,
a marketplace pull), so the license must physically live inside it (same reason
every npm / PyPI / VS Code package carries its own LICENSE).

Copying is the correct practice; the only risk is the copies drifting. These
tests are that guard:

  * every per-plugin LICENSE is byte-identical to the repo-root canonical
    Apache-2.0, and
  * the three hook-based CLI plugins each ship LICENSE + PRIVACY.md.

PRIVACY.md is intentionally NOT byte-checked — it is tailored per harness
(names the specific host + that host's hook surfaces).
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
ROOT_LICENSE = REPO / "LICENSE"
PLUGINS_DIR = REPO / "src" / "securevector" / "plugins"

# Hook-based CLI plugins that ship as self-contained distributables. openclaw is
# excluded: it's a TypeScript gateway (compiled), a different distribution model.
SELF_CONTAINED_PLUGINS = ["claude-code", "codex", "copilot-cli"]


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_root_license_exists():
    assert ROOT_LICENSE.is_file(), "repo-root LICENSE (the canonical source) is missing"


@pytest.mark.parametrize("plugin", SELF_CONTAINED_PLUGINS)
def test_plugin_ships_license_and_privacy(plugin):
    """Each self-contained plugin must carry its own LICENSE + PRIVACY.md so it
    is legally complete + marketplace-ready when installed in isolation."""
    pdir = PLUGINS_DIR / plugin
    assert (pdir / "LICENSE").is_file(), f"{plugin} is missing its LICENSE"
    assert (pdir / "PRIVACY.md").is_file(), f"{plugin} is missing its PRIVACY.md"


@pytest.mark.parametrize("plugin", SELF_CONTAINED_PLUGINS)
def test_plugin_license_byte_identical_to_root(plugin):
    """No drift: every bundled LICENSE must equal the canonical repo-root one."""
    plugin_license = PLUGINS_DIR / plugin / "LICENSE"
    assert plugin_license.is_file(), f"{plugin}/LICENSE missing"
    assert _sha(plugin_license) == _sha(ROOT_LICENSE), (
        f"{plugin}/LICENSE has drifted from the repo-root canonical LICENSE. "
        f"Re-copy it: cp LICENSE src/securevector/plugins/{plugin}/LICENSE"
    )


def test_all_discovered_plugin_licenses_match_root():
    """Belt-and-suspenders: ANY LICENSE found under plugins/ (even a future one)
    must match the canonical root — catches a new plugin added without updating
    SELF_CONTAINED_PLUGINS above."""
    root_sha = _sha(ROOT_LICENSE)
    found = sorted(PLUGINS_DIR.glob("*/LICENSE"))
    assert found, "expected at least one per-plugin LICENSE"
    drifted = [str(p.relative_to(REPO)) for p in found if _sha(p) != root_sha]
    assert not drifted, f"these plugin LICENSE files differ from the root: {drifted}"
