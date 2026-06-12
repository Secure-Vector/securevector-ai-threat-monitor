"""Regression tests for the /analyze low-signal threat-recording gate.

Background / root cause being guarded against
---------------------------------------------
The local analysis engine (`analysis_service.analyze`) hardcodes the verdict
confidence to a flat 0.8 for ANY regex hit and never emits a per-rule
confidence. As a result the `_MIN_RULE_CONFIDENCE` floor in the /analyze
route could never fire for a local match, and SHAPE-only heuristic matches
from the "Output Credential Leakage Detection" rule
(`sv_community_output_001_credential_leak`) were minted as `data_leakage`
threat_intel rows at confidence 0.8 (rendered "0.8%" in the UI).

The route now drops a rule match whose ONLY matched patterns are loose
heuristic shapes (bulleted-token / `Word##!sym`), which demotes the verdict
to non-threat and prevents the threat_intel record — while a structured
secret pattern (e.g. `ghp_…`) still records.

These tests drive the real `/analyze` route with the analysis service and
repositories stubbed, so they exercise the actual gate code in
`routes/analyze.py` without needing a live DB.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from securevector.app.server.routes import analyze as analyze_mod
from securevector.app.database.repositories.settings import AppSettings


# --- Loose heuristic regex patterns straight from the CURRENT credential
#     leak rule (`sv_community_output_001_credential_leak`). A match whose
#     only matched_patterns are loose shapes must NOT be recorded; the
#     structured patterns (ghp_/AKIA/sk-/JWT/api_key:…) must be.
#
# These mirror the verbatim YAML so the realigned
# `_LOOSE_HEURISTIC_PATTERN_FRAGMENTS` in analyze.py (the special-char
# lookahead + the `[^\s/:.@_]{8,}` token body) are genuine substrings of
# them — keeping the low-signal filter LIVE. If the YAML bulleted pattern
# changes, update both it and these constants together.
_LOOSE_BULLET_PATTERN = (
    r"(?:^|\n)\s{0,4}(?:[•\-\*]|\d+[\.)\]])\s*`?"
    r"(?=[^\s]*[A-Za-z])(?=[^\s]*[0-9])(?=[^\s]*[!@#$%^&*])[^\s/:.@_]{8,}`?"
)
# A second loose-shape stand-in carrying only the token-body fragment, used
# to prove a multi-pattern heuristic-only hit is still classified low-signal.
_LOOSE_TOKEN_BODY_PATTERN = r"`?[^\s/:.@_]{8,}`?"
_STRUCTURED_GHP_PATTERN = r"ghp_[a-zA-Z0-9]{36}"


class _FakeAnalysisResult:
    def __init__(self, *, is_threat, threat_type, risk_score, confidence, matched_rules):
        self.is_threat = is_threat
        self.threat_type = threat_type
        self.risk_score = risk_score
        self.confidence = confidence
        self.matched_rules = matched_rules
        self.processing_time_ms = 1


class _FakeAnalysisService:
    def __init__(self, result):
        self._result = result

    async def analyze(self, text, direction=None):
        return self._result


class _SpyThreatIntelRepo:
    """Records create() calls so tests can assert whether a row was written."""

    created: list[dict] = []

    def __init__(self, db):
        pass

    async def create(self, **kwargs):
        _SpyThreatIntelRepo.created.append(kwargs)

        class _Rec:
            id = "rec-1"

        return _Rec()


class _NoopRedactionsRepo:
    def __init__(self, db):
        pass

    async def record(self, **kwargs):
        return None


def _build_client(monkeypatch, engine_result):
    """Wire a FastAPI app around the analyze router with everything stubbed."""
    _SpyThreatIntelRepo.created = []

    # These tests exercise the low-signal RULE gate in isolation. Force the
    # Guardian ML layer off via its env kill-switch — otherwise the real
    # model also scores the sample secrets and appends its own matched rule,
    # coupling these assertions to model behaviour. The ML merge policy has
    # its own suite (test_analyze_guardian_merge.py).
    monkeypatch.setenv("SECUREVECTOR_ML_ENABLED", "false")

    settings = AppSettings()
    settings.cloud_mode_enabled = False
    settings.scan_llm_responses = True
    settings.block_threats = False
    settings.store_text_content = True
    settings.llm_settings = None

    class _SettingsRepo:
        def __init__(self, db):
            pass

        async def get(self):
            return settings

    # `object` is itself the zero-arg callable returning a fresh sentinel —
    # `get_database()` only needs to return *something* truthy for the repos
    # we stub below. Pass it directly rather than wrapping in a lambda
    # (CodeQL py/unnecessary-lambda).
    monkeypatch.setattr(analyze_mod, "get_database", object)
    monkeypatch.setattr(analyze_mod, "SettingsRepository", _SettingsRepo)
    monkeypatch.setattr(analyze_mod, "ThreatIntelRepository", _SpyThreatIntelRepo)
    monkeypatch.setattr(analyze_mod, "RedactionsRepository", _NoopRedactionsRepo)
    # Redaction is independent of the threat gate; neutralise it.
    monkeypatch.setattr(analyze_mod, "redact_secrets", lambda text, **kw: (text, 0))

    # Patch the lazily-imported analysis service factory.
    import securevector.app.services.analysis_service as svc_mod

    monkeypatch.setattr(
        svc_mod, "get_analysis_service", lambda: _FakeAnalysisService(engine_result)
    )

    app = FastAPI()
    app.include_router(analyze_mod.router, prefix="/api/v1")
    return TestClient(app)


def test_low_signal_heuristic_only_match_is_not_recorded(monkeypatch):
    """A hit whose only matched patterns are loose shapes → no record, is_threat False."""
    engine_result = _FakeAnalysisResult(
        is_threat=True,
        threat_type="data_leakage",
        risk_score=90,
        confidence=0.8,  # engine's hardcoded flat confidence
        matched_rules=[
            {
                "id": "sv_community_output_001_credential_leak",
                "name": "Output Credential Leakage Detection",
                "category": "data_leakage",
                "severity": "critical",
                "source": "community",
                "matched_patterns": [
                    _LOOSE_BULLET_PATTERN,
                    _LOOSE_TOKEN_BODY_PATTERN,
                ],
            }
        ],
    )
    client = _build_client(monkeypatch, engine_result)

    r = client.post(
        "/api/v1/analyze",
        json={"text": "1. Hello2World!", "source": "claude-code-plugin"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["is_threat"] is False
    assert body["matched_rules"] == []
    assert _SpyThreatIntelRepo.created == []


def test_real_secret_high_signal_match_is_recorded(monkeypatch):
    """A structured-secret pattern hit → threat_intel record IS created."""
    engine_result = _FakeAnalysisResult(
        is_threat=True,
        threat_type="data_leakage",
        risk_score=90,
        confidence=0.8,
        matched_rules=[
            {
                "id": "sv_community_output_001_credential_leak",
                "name": "Output Credential Leakage Detection",
                "category": "data_leakage",
                "severity": "critical",
                "source": "community",
                "matched_patterns": [_STRUCTURED_GHP_PATTERN],
            }
        ],
    )
    client = _build_client(monkeypatch, engine_result)

    r = client.post(
        "/api/v1/analyze",
        json={
            "text": "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "source": "claude-code-plugin",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["is_threat"] is True
    assert len(body["matched_rules"]) == 1
    assert len(_SpyThreatIntelRepo.created) == 1
    assert _SpyThreatIntelRepo.created[0]["is_threat"] is True


def test_mixed_match_keeps_structured_pattern(monkeypatch):
    """When both a loose and a structured pattern hit on the same rule, keep it."""
    engine_result = _FakeAnalysisResult(
        is_threat=True,
        threat_type="data_leakage",
        risk_score=90,
        confidence=0.8,
        matched_rules=[
            {
                "id": "sv_community_output_001_credential_leak",
                "name": "Output Credential Leakage Detection",
                "category": "data_leakage",
                "severity": "critical",
                "source": "community",
                "matched_patterns": [
                    _LOOSE_TOKEN_BODY_PATTERN,
                    _STRUCTURED_GHP_PATTERN,
                ],
            }
        ],
    )
    client = _build_client(monkeypatch, engine_result)

    r = client.post(
        "/api/v1/analyze",
        json={"text": "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "source": "claude-code-plugin"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["is_threat"] is True
    assert len(_SpyThreatIntelRepo.created) == 1


# ---------------------------------------------------------------------------
# Calibrated verdict + per-rule confidence floor (issue #136). These drive the
# real route with a per-rule `confidence` now flowing from the (faked) engine,
# proving the verdict no longer treats "any rule matched" as a threat and that
# the _MIN_RULE_CONFIDENCE floor is finally live. All rules below use a
# STRUCTURED pattern so the low-signal heuristic gate keeps them.
# ---------------------------------------------------------------------------

def _rule(conf, rid="sv_test_rule"):
    return {
        "id": rid,
        "name": "Test Rule",
        "category": "data_leakage",
        "severity": "critical",
        "source": "community",
        "matched_patterns": [_STRUCTURED_GHP_PATTERN],
        "confidence": conf,
    }


def test_lone_medium_confidence_rule_does_not_alarm(monkeypatch):
    """A single medium-confidence (0.6) hit informs the score but must not alarm."""
    engine_result = _FakeAnalysisResult(
        is_threat=True, threat_type="data_leakage", risk_score=90,
        confidence=0.6, matched_rules=[_rule(0.6)],
    )
    client = _build_client(monkeypatch, engine_result)
    body = client.post("/api/v1/analyze", json={"text": "x", "source": "t"}).json()
    assert body["is_threat"] is False
    assert _SpyThreatIntelRepo.created == []


def test_two_medium_confidence_rules_corroborate(monkeypatch):
    """Two medium-confidence hits corroborate → threat."""
    engine_result = _FakeAnalysisResult(
        is_threat=True, threat_type="data_leakage", risk_score=90,
        confidence=0.6,
        matched_rules=[_rule(0.6, "rule_a"), _rule(0.6, "rule_b")],
    )
    client = _build_client(monkeypatch, engine_result)
    body = client.post("/api/v1/analyze", json={"text": "x", "source": "t"}).json()
    assert body["is_threat"] is True
    assert len(_SpyThreatIntelRepo.created) == 1


def test_high_confidence_rule_alarms_alone(monkeypatch):
    """A single high-confidence (0.9) hit alarms on its own."""
    engine_result = _FakeAnalysisResult(
        is_threat=True, threat_type="data_leakage", risk_score=90,
        confidence=0.9, matched_rules=[_rule(0.9)],
    )
    client = _build_client(monkeypatch, engine_result)
    body = client.post("/api/v1/analyze", json={"text": "x", "source": "t"}).json()
    assert body["is_threat"] is True
    assert len(_SpyThreatIntelRepo.created) == 1


def test_subfloor_confidence_rule_is_dropped(monkeypatch):
    """A rule below _MIN_RULE_CONFIDENCE (0.1 < 0.25) is filtered out — the
    floor is now live because real per-rule confidence flows."""
    engine_result = _FakeAnalysisResult(
        is_threat=True, threat_type="data_leakage", risk_score=90,
        confidence=0.1, matched_rules=[_rule(0.1)],
    )
    client = _build_client(monkeypatch, engine_result)
    body = client.post("/api/v1/analyze", json={"text": "x", "source": "t"}).json()
    assert body["is_threat"] is False
    assert body["matched_rules"] == []
    assert _SpyThreatIntelRepo.created == []
