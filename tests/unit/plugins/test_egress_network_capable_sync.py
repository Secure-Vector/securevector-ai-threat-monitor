"""
The JS `NETWORK_CAPABLE` sets must stay a superset of the Python one.

Why this test exists: each Guard plugin decides client-side whether a tool
*could* reach the network, and only then pays for the egress round-trip. If a
runtime's shell tool name is missing from its JS set, the hook short-circuits
and **egress is silently not enforced for that runtime** — no error, no log,
no failing test anywhere else. That drift was caught by hand once (Cursor
names its shell tool `shell`, which the Python set did not originally list);
it should not need catching by hand again.

Direction of the check matters. The JS set may be a strict superset: a name
the server cannot route just costs one wasted round-trip and returns
`network_capable: false`. A name missing from JS is a silent enforcement hole.
"""

import re
from pathlib import Path

import pytest

from securevector.core.egress.destinations import NETWORK_CAPABLE_BUILTINS

PLUGIN_ROOT = Path(__file__).resolve().parents[3] / "src" / "securevector" / "plugins"

# (plugin, path relative to the plugin dir) for every plugin that gates the
# egress call behind a client-side network-capability check.
JS_SOURCES = [
    ("claude-code", "hooks/pre-tool-use.js"),
    ("codex", "hooks/pre-tool-use.js"),
    ("copilot-cli", "hooks/pre-tool-use.js"),
    ("openclaw", "index.ts"),
]

_SET_RE = re.compile(r"NETWORK_CAPABLE\s*=\s*new Set\(\[(.*?)\]\)", re.DOTALL)
_ENTRY_RE = re.compile(r"""['"]([a-z0-9_]+)['"]""")


def _js_set(path: Path):
    match = _SET_RE.search(path.read_text(encoding="utf-8"))
    assert match, f"NETWORK_CAPABLE set literal not found in {path}"
    return {e.lower() for e in _ENTRY_RE.findall(match.group(1))}


@pytest.mark.parametrize("plugin,relpath", JS_SOURCES)
def test_js_set_covers_every_python_name(plugin, relpath):
    path = PLUGIN_ROOT / plugin / relpath
    missing = NETWORK_CAPABLE_BUILTINS - _js_set(path)
    assert not missing, (
        f"{plugin} would silently skip egress evaluation for {sorted(missing)}. "
        "A name missing from the JS set is an enforcement hole, not a perf tweak."
    )


def test_shell_aliases_are_covered():
    """Runtimes disagree on what the shell tool is called.

    Cursor fires `beforeShellExecution` against a synthesized `shell` id;
    others use `bash`, `exec`, or `run_terminal_cmd`. All must route.
    """
    for alias in ("bash", "shell", "exec", "run_terminal_cmd"):
        assert alias in NETWORK_CAPABLE_BUILTINS


@pytest.mark.parametrize("plugin,relpath", JS_SOURCES)
def test_mcp_prefix_is_always_treated_as_network_capable(plugin, relpath):
    """A remote MCP server is an egress proxy and must never short-circuit."""
    source = (PLUGIN_ROOT / plugin / relpath).read_text(encoding="utf-8")
    assert "startsWith('mcp__')" in source or 'startsWith("mcp__")' in source, (
        f"{plugin} does not route mcp__ tools to egress evaluation"
    )
