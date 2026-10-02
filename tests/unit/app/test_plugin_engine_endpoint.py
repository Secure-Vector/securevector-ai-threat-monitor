"""Drift guard: every native plugin resolves the engine endpoint the same way.

The engine endpoint is HOP 1 (agent -> engine, local app or self-host). It is
NOT the SecureVector cloud. The unified SECUREVECTOR_ENGINE_ENDPOINT var (#190)
wins, with the legacy SV_BASE_URL / SECUREVECTOR_URL names kept only as
fallbacks, and a plugin that reads the legacy name without the unified one in
front is silently un-pointable at a remote Terraform engine.

This used to scan for the resolution expression inline in each hook, because
that is where it lived: twenty-one copies of one line. It now lives once per
plugin, in `lib/client.js`, so that the host can also be checked and announced
before tool arguments are sent to it. So the check moved with it. The stronger
half is the second test: no hook may read the environment variable for itself,
which is what keeps the count from creeping back up.
"""
from __future__ import annotations

import pathlib
import re

import pytest

PLUGINS = pathlib.Path(__file__).resolve().parents[3] / "src" / "securevector" / "plugins"

# One resolver per plugin, in the client each plugin's hooks already import.
RESOLVERS = sorted(p for p in PLUGINS.glob("*/lib/client.js"))

UNIFIED_JS = re.compile(
    r"process\.env\.SECUREVECTOR_ENGINE_ENDPOINT\s*\|\|\s*process\.env\.SV_BASE_URL"
)

# Everything that runs inside an agent and could read the endpoint itself.
#
# Every source extension, not just .js. The first version of this globbed
# "*.js" and therefore could not see `openclaw/config.ts`, which read the
# variable inline with no loopback check while this test reported that nothing
# did. A guard that cannot see the file it guards is worse than no guard: it
# reads as evidence.
SOURCE_SUFFIXES = (".js", ".mjs", ".cjs", ".ts", ".mts", ".cts")

# The files allowed to read it, by RELATIVE PATH, not basename. Exempting
# "config.ts" anywhere would silently exempt a future
# plugins/foo/hooks/config.ts, which is the same blindness that hid a reader
# twice already: once behind a .js-only glob, once behind a bare-name match.
def _resolver_paths() -> set[str]:
    allowed = {f"{d.name}/lib/client.js" for d in PLUGINS.iterdir() if d.is_dir()}
    allowed.add("openclaw/config.ts")
    return allowed


RESOLVER_PATHS = _resolver_paths()

PLUGIN_SOURCES = sorted(
    p
    for p in PLUGINS.rglob("*")
    if p.is_file()
    and p.suffix in SOURCE_SUFFIXES
    and str(p.relative_to(PLUGINS)) not in RESOLVER_PATHS
)


def test_every_plugin_has_a_resolver():
    # Sanity: the glob really found them, so the parametrized test below
    # cannot pass by matching nothing.
    assert len(RESOLVERS) >= 5, f"expected >=5 plugin clients, found {len(RESOLVERS)}"


def test_the_source_sweep_actually_sees_typescript():
    """The sweep below is only evidence if it can see every source file.

    Pinned because the omission that made it blind was invisible: it globbed
    "*.js", found nothing wrong, and passed.
    """
    suffixes = {p.suffix for p in PLUGIN_SOURCES}
    assert ".ts" in suffixes, (
        f"the source sweep sees only {sorted(suffixes)}; a TypeScript plugin "
        "reader would be invisible to it"
    )
    assert len(PLUGIN_SOURCES) >= 25, f"only swept {len(PLUGIN_SOURCES)} files"


@pytest.mark.parametrize("client", RESOLVERS, ids=lambda p: str(p.relative_to(PLUGINS)))
def test_resolver_uses_unified_engine_endpoint(client):
    src = client.read_text()
    assert "function resolveBaseUrl()" in src, (
        f"{client.relative_to(PLUGINS)} has no resolveBaseUrl"
    )
    assert UNIFIED_JS.search(src), (
        f"{client.relative_to(PLUGINS)} resolves a base URL but not via "
        f"SECUREVECTOR_ENGINE_ENDPOINT || SV_BASE_URL"
    )


@pytest.mark.parametrize("source", PLUGIN_SOURCES, ids=lambda p: str(p.relative_to(PLUGINS)))
def test_nothing_else_reads_the_endpoint_variable(source):
    """One reader, so the host can be checked once and announced once.

    A second reader is not a style problem: it is a path that sends tool
    arguments to whatever the variable names without the warning that says so.
    """
    src = source.read_text()
    # A READ, not a mention: matching the bare name also matched the comment
    # explaining why a read had been removed, which would have made the only
    # way to pass be to stop explaining. The shapes below are the ones someone
    # writes without meaning to reintroduce a silent reader: plain access,
    # optional chaining, index access, and destructuring. Deliberate evasion
    # (building the name by concatenation) is out of scope; this guards
    # against the accident, not against someone who wants past it.
    for name in ("SECUREVECTOR_ENGINE_ENDPOINT", "SV_BASE_URL", "SECUREVECTOR_URL"):
        reads = {
            "directly": rf"process\.env\??\.{name}\b",
            "by index": rf"""process\.env\[\s*["'`]{name}["'`]""",
            "by destructuring": rf"\{{[^}}]*\b{name}\b[^}}]*\}}\s*=\s*process\.env",
        }
        for how, pattern in reads.items():
            assert not re.search(pattern, src), (
                f"{source.relative_to(PLUGINS)} reads {name} {how}; call "
                "resolveBaseUrl() from lib/client.js instead"
            )


def test_openclaw_config_prefers_engine_endpoint():
    cfg = (PLUGINS / "openclaw" / "config.ts").read_text()
    # unified var must appear, and before the legacy SECUREVECTOR_URL in the
    # url resolution chain.
    assert "SECUREVECTOR_ENGINE_ENDPOINT" in cfg
    # the resolution line (not the `url: string` interface decl) — it reads from
    # the environment.
    url_line = next(
        l for l in cfg.splitlines()
        if l.strip().startswith("url:") and "process.env" in l
    )
    assert url_line.index("SECUREVECTOR_ENGINE_ENDPOINT") < url_line.index("SECUREVECTOR_URL"), (
        "openclaw must prefer SECUREVECTOR_ENGINE_ENDPOINT over the legacy SECUREVECTOR_URL"
    )
