"""The full harness list, pinned in one place.

Agent Runs (/api/detection/agents) lists every harness, and each surface that
names a harness by its runtime_kind carries the same set. Hermes and GovRun
joined in 6.2.0. A new harness fails here until every list below has it.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

import pytest

WEB = Path(__file__).resolve().parents[3] / "src" / "securevector" / "app" / "assets" / "web" / "js"

HARNESSES = {
    "claude-code": "Claude Code",
    "codex": "Codex",
    "copilot-cli": "GitHub Copilot CLI",
    "cursor": "Cursor",
    "opencode": "OpenCode",
    "antigravity": "Antigravity",
    "openclaw": "OpenClaw / ClawdBot",
    "hermes": "Hermes",
    "govrun": "GovRun",
}


def _js(rel: str) -> str:
    return (WEB / rel).read_text(encoding="utf-8")


def _block(src: str, start: str, end: str = "};") -> str:
    i = src.index(start)
    return src[i:src.index(end, i)]


def test_detection_lists_every_harness_in_order():
    from securevector.app.server.routes import detection

    assert {h["slug"]: h["label"] for h in detection._HARNESSES} == HARNESSES
    assert [h["slug"] for h in detection._HARNESSES] == list(HARNESSES)
    assert set(HARNESSES) <= detection._HARNESS_RUNTIME_KINDS


def test_detect_agents_returns_hermes_and_govrun(tmp_path, monkeypatch):
    from securevector.app.server.routes import detection

    monkeypatch.setattr(detection, "_home", lambda: tmp_path)
    monkeypatch.setattr(detection.Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))
    monkeypatch.setenv("GOVRUN_HOME", str(tmp_path / "govrun-home"))
    (tmp_path / "hermes-home").mkdir()
    (tmp_path / "govrun-home").mkdir()

    async def audited(window_days):
        return {"hermes": {"calls": 3, "blocked": 0, "last_used": None},
                "govrun": {"calls": 2, "blocked": 1, "last_used": None}}

    async def protected():
        return {}

    monkeypatch.setattr(detection, "_audited_runtimes", audited)
    monkeypatch.setattr(detection, "_protected_sessions", protected)
    out = asyncio.run(detection.detect_agents(active_minutes=30, window_days=30))
    by = {h["slug"]: h for h in out["harnesses"]}
    assert list(by) == list(HARNESSES)
    for slug in ("hermes", "govrun"):
        assert by[slug]["detected"] is True and by[slug]["plugin_connected"] is True
        assert by[slug]["home"] == str(tmp_path / f"{slug}-home")
    assert (by["hermes"]["calls"], by["govrun"]["blocked"]) == (3, 1)
    # A harness is never also listed as a framework.
    assert not {f["runtime_kind"] for f in out["frameworks"]} & set(HARNESSES)


def test_govrun_home_defaults_per_platform(tmp_path, monkeypatch):
    from securevector.app.server.routes import detection

    monkeypatch.delenv("GOVRUN_HOME", raising=False)
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    monkeypatch.setattr(detection, "_home", lambda: tmp_path)
    monkeypatch.setattr(detection.platform, "system", lambda: "Darwin")
    assert detection._govrun_home() == tmp_path / "Library" / "Application Support" / "govrun"
    monkeypatch.setattr(detection.platform, "system", lambda: "Linux")
    assert detection._govrun_home() == tmp_path / ".local" / "share" / "govrun"


def test_backend_label_maps_carry_every_harness():
    from securevector.app.server.routes.tool_permissions import _RUNTIME_LABELS
    from securevector.app.services import harness_coverage
    from securevector.app.services.governance_gaps import HARNESS_LABELS
    from securevector.app.terminals.store import RUNTIME_TO_EXECUTOR

    for slug in HARNESSES:
        assert slug in _RUNTIME_LABELS, slug
        assert slug in HARNESS_LABELS, slug
        assert slug in harness_coverage.COVERAGE, slug
    for slug in ("hermes", "govrun"):
        assert RUNTIME_TO_EXECUTOR[slug] == slug
        assert _RUNTIME_LABELS[slug] == HARNESSES[slug]


@pytest.mark.parametrize("rel, start", [
    ("components/live-grid-model.js", "HARNESS_WORDS"),
    ("pages/agent-runs.js", "const RUNTIME_COLOR = {"),
    ("pages/agent-timeline.js", "const TL_RUNTIME_COLOR = {"),
    ("pages/storylines.js", "const STORY_RUNTIME_COLOR = {"),
    ("pages/storylines.js", "const STORY_RUNTIME_LABEL = {"),
    ("pages/tool-permissions.js", "_JIT_RUNTIME_LABEL: {"),
    ("pages/redactions.js", "_runtimeLabel(slug) {"),
    ("pages/agent-map.js", "const HARNESS_FIXED = {"),
])
def test_web_maps_carry_every_harness(rel, start):
    block = _block(_js(rel), start)
    for slug in HARNESSES:
        if slug == "copilot-cli" and rel == "pages/agent-map.js":
            continue  # the Map keys on audit kinds it draws; Copilot falls to the palette
        assert re.search(rf"['\"]?{re.escape(slug)}['\"]?\s*:", block), (rel, slug)


def test_tool_call_audit_labels_and_filter_name_hermes_and_govrun():
    src = _js("pages/tool-permissions.js")
    assert "['govrun', 'GovRun only']" in src and "['hermes', 'Hermes only']" in src
    assert src.count("(rt === 'govrun') ? 'GovRun'") == 2
    assert src.count("(rt === 'hermes') ? 'Hermes'") == 2


def test_connect_agents_treats_the_govrun_guard_as_built_in():
    src = _js("pages/guide-connect-agents.js")
    assert "if (slug === 'govrun') return 'builtin';" in src
    assert "h.slug !== 'govrun'" in src
