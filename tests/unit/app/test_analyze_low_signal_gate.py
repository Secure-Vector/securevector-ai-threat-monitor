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


# --- The two loose heuristic regex fragments straight from the credential
#     leak rule. A match whose only matched_patterns are these must NOT be
#     recorded. The structured patterns (ghp_/AKIA/sk-/JWT/api_key:…) must be.
_LOOSE_BULLET_PATTERN = (
    r"(?:^|\n)\s{0,4}(?:[•\-\*]|\d+[\.)\]])\s*`?"
    r"(?=[^\s]*[A-Za-z])(?=[^\s]*[0-9])(?=[^\s]*[!@#$%^&*_#])[^\s/:.@]{8,}`?"
)
_LOOSE_PASSWORD_SHAPE_PATTERN = r"[A-Za-z]{2,15}[0-9]{1,6}[!@#$%^&*_][A-Za-z0-9!@#$%^&*_]{1,15}"
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
                    _LOOSE_PASSWORD_SHAPE_PATTERN,
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
                    _LOOSE_PASSWORD_SHAPE_PATTERN,
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
