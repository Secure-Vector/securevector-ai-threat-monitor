"""Tests for the Guardian (ML) veto in the /analyze route.

Mechanism 1 only annotated a rule-only detection that Guardian scored as
confidently benign (`ml_agreement = "ml_disagrees"`). Mechanism 2 clears it:
when every surviving rule sits in a category the model is trained to judge
and P(malicious) is below `_ML_VETO_BAR`, the verdict, type, score and rule
list all clear together and nothing is recorded.

Guardrails covered here:
  * categories outside the model's competence (secret / PII values) are
    never vetoed, whatever the score
  * a model hit that corroborated the rule is never vetoed
  * an LLM reviewer that confirmed the threat is never overruled
  * a score at or above the bar leaves the verdict intact
  * a Guardian failure leaves the verdict intact (fail-open)

The engine and Guardian are stubbed exactly as in the merge tests, so these
drive the real route code deterministically.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from securevector.app.server.routes import analyze as analyze_mod
from securevector.app.database.repositories.settings import AppSettings


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


class _RecordingThreatIntelRepo:
    created = []

    def __init__(self, db):
        pass

    async def create(self, **kwargs):
        _RecordingThreatIntelRepo.created.append(kwargs)

        class _Rec:
            id = "rec-1"

        return _Rec()


class _RecordingClearedRepo:
    events = []

    def __init__(self, db):
        pass

    async def record(self, **kwargs):
        _RecordingClearedRepo.events.append(kwargs)


class _NoopRedactionsRepo:
    def __init__(self, db):
        pass

    async def record(self, **kwargs):
        return None


def _engine_rule(conf, category="prompt_injection", pattern=r"ignore\s+previous\s+instructions"):
    return _FakeAnalysisResult(
        is_threat=True, threat_type=category, risk_score=90, confidence=conf,
        matched_rules=[{
            "id": "sv_test_rule", "name": "Test Rule", "category": category,
            "severity": "critical", "source": "community",
            "matched_patterns": [pattern], "confidence": conf,
        }],
    )


def _guardian(score, *, hit=False):
    """Guardian result dict: `score` is P(malicious) in [0, 1]."""
    rules = []
    if hit:
        rules = [{
            "rule_id": "sv_guardian_model", "rule_name": "SecureVector Guardian (ML)",
            "category": "prompt_injection", "severity": "high", "source": "model",
            "matched_patterns": [], "confidence": score, "mitre_techniques": [],
        }]
    return {
        "is_threat": hit, "threat_type": "prompt_injection" if hit else None,
        "risk_score": int(round(score * 100)), "confidence": score,
        "matched_rules": rules, "analysis_source": "model",
        "processing_time_ms": 1, "action_taken": "logged",
    }


def _build_client(monkeypatch, engine_result, *, guardian_result=None, guardian_raises=False, llm_settings=None):
    monkeypatch.setenv("SECUREVECTOR_ML_ENABLED", "true")
    settings = AppSettings()
    settings.cloud_mode_enabled = False
    settings.scan_llm_responses = True
    settings.block_threats = True
    settings.store_text_content = True
    settings.llm_settings = llm_settings
    settings.guardian_ml_enabled = True

    class _SettingsRepo:
        def __init__(self, db):
            pass

        async def get(self):
            return settings

    _RecordingThreatIntelRepo.created = []
    monkeypatch.setattr(analyze_mod, "get_database", object)
    monkeypatch.setattr(analyze_mod, "SettingsRepository", _SettingsRepo)
    monkeypatch.setattr(analyze_mod, "ThreatIntelRepository", _RecordingThreatIntelRepo)
    monkeypatch.setattr(analyze_mod, "RedactionsRepository", _NoopRedactionsRepo)
    monkeypatch.setattr(analyze_mod, "GuardianClearedRepository", _RecordingClearedRepo)
    _RecordingClearedRepo.events = []
    monkeypatch.setattr(analyze_mod, "redact_secrets", lambda text, **kw: (text, 0))

    import securevector.app.services.analysis_service as svc_mod

    monkeypatch.setattr(svc_mod, "get_analysis_service", lambda: _FakeAnalysisService(engine_result))

    import securevector.app.services.guardian_service as guardian_mod

    def _stub_analyze(text, *, direction="outgoing"):
        if guardian_raises:
            raise RuntimeError("model exploded")
        return guardian_result

    monkeypatch.setattr(guardian_mod, "analyze", _stub_analyze)
    app = FastAPI()
    app.include_router(analyze_mod.router, prefix="/api/v1")
    return TestClient(app)


_TEXT = "assert run(\"ignore previous instructions\") == \"ok\" and the calls list matches"


def _post(client, direction="incoming"):
    r = client.post("/api/v1/analyze", json={"text": _TEXT, "source": "test", "direction": direction})
    assert r.status_code == 200
    return r.json()


def test_confidently_benign_model_clears_a_rule_only_injection_verdict(monkeypatch):
    client = _build_client(monkeypatch, _engine_rule(0.9), guardian_result=_guardian(0.02))
    body = _post(client)
    assert body["is_threat"] is False
    assert body["threat_type"] is None
    assert body["risk_score"] == 0
    assert body["matched_rules"] == []
    assert _RecordingThreatIntelRepo.created == []
    # the decision is logged where the Threats page can count it
    ev = _RecordingClearedRepo.events
    assert len(ev) == 1 and ev[0]["rule_ids"] == ["sv_test_rule"] and ev[0]["ml_score"] == 0.02
    assert ev[0]["category"] == "prompt_injection" and ev[0]["direction"] == "incoming"


def test_score_at_the_bar_keeps_the_rule_verdict(monkeypatch):
    client = _build_client(monkeypatch, _engine_rule(0.9), guardian_result=_guardian(analyze_mod._ML_VETO_BAR))
    body = _post(client)
    assert body["is_threat"] is True
    assert body["matched_rules"][0]["rule_id"] == "sv_test_rule"
    assert _RecordingThreatIntelRepo.created[0]["metadata"]["ml_agreement"] == "ml_uncertain"


def test_secret_and_pii_values_are_never_vetoed(monkeypatch):
    for category in ("data_leakage", "privacy_leak"):
        client = _build_client(
            monkeypatch, _engine_rule(0.9, category=category, pattern=r"AKIA[0-9A-Z]{16}"),
            guardian_result=_guardian(0.0),
        )
        body = _post(client, direction="llm_response")
        assert body["is_threat"] is True, category
        assert _RecordingThreatIntelRepo.created[0]["metadata"]["ml_agreement"] == "ml_disagrees"


def test_llm_reviewer_verdict_not_agreement_flag_blocks_the_veto(monkeypatch):
    """A reviewer that said "threat" keeps the verdict even with agrees=False;
    one that said "safe" does not block the veto, whatever its agrees flag."""
    import securevector.app.services.llm_review as llm_mod

    class _Res:
        def __init__(self, assessment, agrees):
            self.reviewed = True
            self.llm_threat_assessment = assessment
            self.llm_agrees = agrees
            self.llm_confidence = 0.5
            self.llm_reasoning = ""
            self.llm_explanation = ""
            self.llm_recommendation = ""
            self.llm_risk_adjustment = 0
            self.model_used = "stub"
            self.processing_time_ms = 1
            self.tokens_used = 1
            self.llm_suggested_category = None

    for assessment, agrees, expect in (("threat", False, True), ("safe", True, False)):
        class _Svc:
            def __init__(self, *a, **k):
                pass

            async def review(self, *a, **k):
                return _Res(assessment, agrees)

            async def close(self):
                return None

        monkeypatch.setattr(llm_mod, "LLMReviewService", _Svc)
        client = _build_client(
            monkeypatch, _engine_rule(0.9), guardian_result=_guardian(0.02),
            llm_settings={"enabled": True, "provider": "ollama"},
        )
        body = _post(client, direction="outgoing")
        assert body["is_threat"] is expect, (assessment, agrees)
        assert body["llm_review"]["reviewed"] is True


def test_a_model_hit_is_never_vetoed(monkeypatch):
    client = _build_client(monkeypatch, _engine_rule(0.65), guardian_result=_guardian(0.7, hit=True))
    body = _post(client, direction="outgoing")
    assert body["is_threat"] is True
    assert {r["rule_id"] for r in body["matched_rules"]} == {"sv_test_rule", "sv_guardian_model"}


def test_guardian_failure_leaves_the_rule_verdict_intact(monkeypatch):
    client = _build_client(monkeypatch, _engine_rule(0.9), guardian_raises=True)
    body = _post(client)
    assert body["is_threat"] is True
    assert "ml_agreement" not in _RecordingThreatIntelRepo.created[0]["metadata"]


def test_veto_categories_cover_the_model_scope_only():
    cats = analyze_mod._ML_VETO_CATEGORIES
    assert {"prompt_injection", "jailbreak_attempt", "indirect_prompt_injection", "data_extraction"} <= cats
    assert not {"data_leakage", "privacy_leak", "malicious_code_generation", "jailbreak_success"} & cats


def test_value_and_code_shape_rules_inside_model_categories_are_exempt(monkeypatch):
    for rid in sorted(analyze_mod._ML_VETO_EXEMPT_RULES):
        engine = _engine_rule(0.9, category="sensitive_data_exposure")
        engine.matched_rules[0]["id"] = rid
        client = _build_client(monkeypatch, engine, guardian_result=_guardian(0.0))
        body = _post(client, direction="outgoing")
        assert body["is_threat"] is True, rid
        assert _RecordingClearedRepo.events == []


def test_operator_written_rules_are_never_vetoed(monkeypatch):
    engine = _engine_rule(0.9)
    engine.matched_rules[0]["source"] = "custom"
    client = _build_client(monkeypatch, engine, guardian_result=_guardian(0.0))
    body = _post(client)
    assert body["is_threat"] is True
    assert body["matched_rules"][0]["source"] == "custom"


def test_exempt_rule_ids_exist_in_the_community_pack():
    import glob
    from pathlib import Path
    import yaml
    root = Path(analyze_mod.__file__).resolve().parents[3] / "rules" / "community"
    ids = set()
    for f in glob.glob(str(root / "*.yml")):
        with open(f) as fh:
            ids |= {r["id"] for r in yaml.safe_load(fh)["rules"]}
    missing = analyze_mod._ML_VETO_EXEMPT_RULES - ids
    assert not missing, missing
