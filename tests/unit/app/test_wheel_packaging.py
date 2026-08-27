"""Wheel packaging — the Claude Code plugin tree must ship with the package.

Config-level test: verifies the two packaging touch-points (MANIFEST.in for
sdist, setup.py's package_data for wheel) reference the plugin tree. Does
NOT invoke `python -m build` — that requires the `build` distribution and
runs ~10s, which is excessive for a unit test. The DoD's `python -m build
--wheel` + `unzip -l` verification is run manually as part of the Task 13
push gate.
"""
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PLUGIN_TREE = REPO / "src" / "securevector" / "plugins" / "claude-code"

PLUGIN_FILES = [
    ".claude-plugin/plugin.json",
    "hooks/hooks.json",
    "hooks/pre-tool-use.js",
    "hooks/post-tool-use.js",
    "lib/normalize.js",
    "lib/client.js",
    "README.md",
    "LICENSE",
    "PRIVACY.md",
]


def test_plugin_tree_intact_on_disk():
    """Sanity: source files exist before we worry about packaging."""
    for rel in PLUGIN_FILES:
        assert (PLUGIN_TREE / rel).is_file(), f"missing plugin file: {rel}"


def test_manifest_in_pulls_plugin_tree_into_sdist():
    manifest = (REPO / "MANIFEST.in").read_text()
    pattern = r"recursive-include\s+src/securevector/plugins/claude-code\s+\*"
    assert re.search(pattern, manifest), (
        "MANIFEST.in is missing: recursive-include src/securevector/plugins/claude-code *"
    )


def test_manifest_in_explicitly_includes_dot_claude_plugin_dir():
    """distutils' `recursive-include … *` does NOT match dot-prefixed dirs,
    so .claude-plugin/ must be listed separately or plugin.json gets dropped."""
    manifest = (REPO / "MANIFEST.in").read_text()
    pattern = r"recursive-include\s+src/securevector/plugins/claude-code/\.claude-plugin\s+\*"
    assert re.search(pattern, manifest), (
        "MANIFEST.in is missing the explicit .claude-plugin/ recursive-include — "
        "plugin.json would be excluded from the sdist."
    )


def test_setup_py_package_data_globs_plugin_tree():
    """setup.py's `securevector` package_data must glob the plugin tree
    recursively (`**/*`) — single-`*` would miss the nested
    hooks/ and lib/ subdirs."""
    setup_py = (REPO / "setup.py").read_text()
    assert "plugins/claude-code/**/*" in setup_py, (
        'setup.py package_data is missing "plugins/claude-code/**/*"'
    )


def test_setup_py_package_data_explicit_dot_claude_plugin_glob():
    """setuptools' `**/*` glob skips dot-prefixed directories (documented
    behaviour, pypa/setuptools#3350), so .claude-plugin/ must have its own
    pattern. Without this, plugin.json — which Claude Code reads to discover
    the plugin — is silently dropped from the wheel."""
    setup_py = (REPO / "setup.py").read_text()
    assert "plugins/claude-code/.claude-plugin/*" in setup_py, (
        'setup.py package_data is missing explicit "plugins/claude-code/.claude-plugin/*" '
        "glob — plugin.json would be excluded from the wheel."
    )


def test_manifest_and_package_data_include_cursor_plugin():
    """The Cursor plugin's non-Python assets must ship in the wheel — a
    missing glob reproduces the install-route 500 ("staging produced 0
    files") on pip-installed apps. Same defense as the claude-code checks."""
    manifest = (REPO / "MANIFEST.in").read_text()
    assert re.search(r"recursive-include\s+src/securevector/plugins/cursor\s+\*", manifest), (
        "MANIFEST.in is missing: recursive-include src/securevector/plugins/cursor *"
    )
    # The Cursor manifest lives in .cursor-plugin/ (a dot-dir). setuptools'
    # `**/*` glob skips dot-prefixed dirs (pypa/setuptools#3350), so without an
    # explicit listing the wheel ships the plugin WITHOUT its plugin.json and
    # Cursor never discovers it. Same defense as the claude-code/codex checks.
    assert re.search(r"recursive-include\s+src/securevector/plugins/cursor/\.cursor-plugin\s+\*", manifest), (
        "MANIFEST.in is missing the explicit .cursor-plugin/ recursive-include — "
        "setuptools `**/*` skips dot-dirs, so .cursor-plugin/plugin.json would be dropped"
    )
    setup_py = (REPO / "setup.py").read_text()
    assert "plugins/cursor/**/*" in setup_py, (
        'setup.py package_data is missing "plugins/cursor/**/*"'
    )
    assert "plugins/cursor/.cursor-plugin/*" in setup_py, (
        'setup.py package_data is missing explicit "plugins/cursor/.cursor-plugin/*" '
        "(the `**/*` glob skips the dot-dir, dropping the manifest)"
    )


def test_manifest_and_package_data_include_opencode_plugin():
    """The OpenCode plugin's non-Python assets must ship in the wheel.

    This one matters more than most: OpenCode imports the staged directory as
    an ES module, and `package.json` is what makes that directory resolvable as
    a plugin target at all (src/plugin/shared.ts::resolvePathPluginTarget). If
    packaging drops it, the install route stages an unimportable tree and
    OpenCode fails with "missing package.json or index file" — the OpenCode
    flavour of the "staging produced 0 files" install-route 500.
    """
    manifest = (REPO / "MANIFEST.in").read_text()
    assert re.search(r"recursive-include\s+src/securevector/plugins/opencode\s+\*", manifest), (
        "MANIFEST.in is missing: recursive-include src/securevector/plugins/opencode *"
    )
    setup_py = (REPO / "setup.py").read_text()
    assert "plugins/opencode/**/*" in setup_py, (
        'setup.py package_data is missing "plugins/opencode/**/*"'
    )


def test_opencode_plugin_tree_intact_on_disk():
    """Every file the OpenCode install handler stages must exist in source."""
    from securevector.app.server.routes.hooks_opencode import PLUGIN_FILES as OC_FILES

    tree = REPO / "src" / "securevector" / "plugins" / "opencode"
    for rel in OC_FILES:
        assert (tree / rel).is_file(), f"missing OpenCode plugin file: {rel}"
    # package.json is load-bearing for module resolution — assert it explicitly
    # so a future file-list edit can't quietly drop it.
    assert "package.json" in OC_FILES
