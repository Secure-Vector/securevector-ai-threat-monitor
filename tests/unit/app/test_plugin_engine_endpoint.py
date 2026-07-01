"""Drift guard: every native-plugin hook resolves the engine endpoint via the
unified SECUREVECTOR_ENGINE_ENDPOINT var (#190), with the legacy SV_BASE_URL /
SECUREVECTOR_URL names kept only as fallbacks.

The engine endpoint is HOP 1 (agent -> engine, local app or self-host). It is
NOT the SecureVector cloud. This test fails if a hook is added/edited that reads
the legacy var without the unified var in front — the bug that would silently
leave a plugin un-pointable at a remote Terraform engine.
"""
from __future__ import annotations

import pathlib
import re

import pytest

PLUGINS = pathlib.Path(__file__).resolve().parents[3] / "src" / "securevector" / "plugins"

# JS hooks: any file that resolves a base URL from SV_BASE_URL
JS_HOOKS = sorted(
    p for p in PLUGINS.rglob("*.js")
    if "SV_BASE_URL || DEFAULT_BASE_URL" in p.read_text()
)

UNIFIED_JS = re.compile(
    r"process\.env\.SECUREVECTOR_ENGINE_ENDPOINT\s*\|\|\s*process\.env\.SV_BASE_URL\s*\|\|\s*DEFAULT_BASE_URL"
)


def test_js_hooks_present():
    # Sanity: we actually found the hook files (guards against a path typo
    # making the parametrized test vacuously pass).
    assert len(JS_HOOKS) >= 20, f"expected >=20 hook files, found {len(JS_HOOKS)}"


@pytest.mark.parametrize("hook", JS_HOOKS, ids=lambda p: str(p.relative_to(PLUGINS)))
def test_js_hook_uses_unified_engine_endpoint(hook):
    src = hook.read_text()
    assert UNIFIED_JS.search(src), (
        f"{hook.relative_to(PLUGINS)} resolves a base URL but not via "
        f"SECUREVECTOR_ENGINE_ENDPOINT || SV_BASE_URL || DEFAULT_BASE_URL"
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
