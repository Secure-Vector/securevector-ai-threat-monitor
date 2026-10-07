"""No installed plugin may ship the stock loopback port.

The hooks default to ``http://127.0.0.1:8741``. When the app is running on any
other port, install rewrites that default in the staged tree, and a file the
rewrite misses is a file whose hooks post their audit rows into the void. The
failure is silent: the agent keeps working, the plugin keeps running, and
nothing appears in the app.

This is asserted over the whole staged tree per harness rather than against a
named file. The default used to live in each hook and now lives in each
plugin's ``lib/client.js``; a test naming the old file would have gone on
passing against whatever url happened to remain there. The property is about
the tree, so the test is too.

The substitution itself is exercised through ``stage_files``, the same call
every install route makes, so this covers the six harnesses without needing a
running app or a per-harness install fixture.
"""

from __future__ import annotations

import pathlib
import re

import pytest

from securevector.app.server.routes import _hooks_common

PLUGINS = pathlib.Path(__file__).resolve().parents[3] / "src" / "securevector" / "plugins"

STOCK = ("http://127.0.0.1:8741", "http://localhost:8741")
RELOCATED = "http://127.0.0.1:9911"

TEXT_SUFFIXES = {".js", ".mjs", ".cjs", ".ts", ".json"}


def _harnesses() -> list[str]:
    found = sorted(
        d.name for d in PLUGINS.iterdir()
        if d.is_dir() and any(d.rglob("*.js"))
    )
    assert len(found) >= 6, f"expected at least six plugin trees, found {found}"
    return found


def _source_files(root: pathlib.Path) -> list[pathlib.Path]:
    return sorted(
        p for p in root.rglob("*")
        if p.is_file() and p.suffix in TEXT_SUFFIXES and "node_modules" not in p.parts
    )


@pytest.mark.parametrize("harness", _harnesses())
def test_the_stock_port_is_substituted_out_of_the_whole_tree(harness, tmp_path):
    source = PLUGINS / harness
    files = [str(p.relative_to(source)) for p in _source_files(source)]
    assert files, f"{harness} has no source files to stage"

    staging = tmp_path / harness
    written = _hooks_common.stage_files(
        staging_dir=staging,
        source_dir=source,
        files=files,
        substitutions={s: RELOCATED for s in STOCK},
    )
    assert written, f"{harness} staged nothing"

    leftovers = [
        str(p.relative_to(staging))
        for p in _source_files(staging)
        if any(s in p.read_text(encoding="utf-8", errors="replace") for s in STOCK)
    ]
    assert not leftovers, (
        f"{harness} would ship the stock port in {leftovers}; on a relocated "
        "install those hooks post into the void"
    )


# The default as it is ASSIGNED, not merely mentioned. A first version of the
# check below accepted any occurrence of the url and was therefore satisfied by
# the doc comment two lines above the real assignment: obfuscating the actual
# default into a concatenation left the comment behind and the test passed.
ASSIGNMENT = re.compile(
    r"""=\s*["'](?:http://127\.0\.0\.1:8741|http://localhost:8741)["']"""
)


@pytest.mark.parametrize("harness", _harnesses())
def test_every_tree_assigns_the_default_somewhere(harness):
    """Guards the test above against passing because nothing was there.

    A plugin whose default was deleted rather than substituted satisfies "no
    stock port present" while having no endpoint to fall back to at all, and a
    plugin whose default is built by concatenation is invisible to the string
    substitution that install performs, which is the same failure wearing a
    different hat.
    """
    source = PLUGINS / harness
    carriers = [
        str(p.relative_to(source))
        for p in _source_files(source)
        if ASSIGNMENT.search(p.read_text(encoding="utf-8", errors="replace"))
    ]
    assert carriers, (
        f"{harness} assigns the local app url nowhere as a plain literal, so "
        "there is nothing for install to substitute and its hooks would post "
        "to the stock port on a relocated install"
    )
