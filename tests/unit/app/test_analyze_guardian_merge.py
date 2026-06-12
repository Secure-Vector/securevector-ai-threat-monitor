"""Tests for the Guardian (ML) verdict merge in the /analyze route.

The route runs SecureVector Guardian in parallel with the regex engine and
folds its result into the calibrated gate ADDITIVELY at two bars:

* ML ALONE (no rule survived)        → needs confidence ≥ _ML_ALONE_BAR (0.90)
* ML CORROBORATES a surviving rule   → needs confidence ≥ _ML_CORROBORATE_BAR (0.60)

It is gated on BOTH the persisted Settings toggle (app_settings.
guardian_ml_enabled, default ON) and the SECUREVECTOR_ML_ENABLED env
kill-switch, and is fail-open: a Guardian error must never affect the rule
verdict.

These tests stub `guardian_service.analyze` (the real model never loads), so
they exercise the merge policy in `routes/analyze.py` deterministically.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from securevector.app.server.routes import analyze as analyze_mod
from securevector.app.database.repositories.settings import AppSettings

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


class _NoopThreatIntelRepo:
    def __init__(self, db):
        pass

    async def create(self, **kwargs):
        class _Rec:
            id = "rec-1"

        return _Rec()


class _NoopRedactionsRepo:
    def __init__(self, db):
        pass

    async def record(self, **kwargs):
        return None


def _engine_clean():
    """Engine result: nothing matched."""
    return _FakeAnalysisResult(
        is_threat=False, threat_type=None, risk_score=0,
        confidence=0.0, matched_rules=[],
    )


def _engine_rule(conf):
    """Engine result: one surviving rule at the given confidence."""
    return _FakeAnalysisResult(
        is_threat=True, threat_type="data_leakage", risk_score=90,
        confidence=conf,
        matched_rules=[{
            "id": "sv_test_rule",
            "name": "Test Rule",
            "category": "data_leakage",
            "severity": "critical",
            "source": "community",
            "matched_patterns": [_STRUCTURED_GHP_PATTERN],
            "confidence": conf,
        }],
    )


def _guardian_hit(conf, category="prompt_injection"):
    """Guardian analyze() result dict in the /analyze shape."""
    return {
        "is_threat": True,
        "threat_type": category,
        "risk_score": int(conf * 100),
        "confidence": conf,
        "matched_rules": [{
            "rule_id": "sv_guardian_model",
            "rule_name": "SecureVector Guardian (ML)",
            "category": category,
            "severity": "high",
            "source": "model",
            "matched_patterns": [],
            "confidence": conf,
            "mitre_techniques": [],
        }],
        "analysis_source": "model",
        "processing_time_ms": 1,
        "action_taken": "logged",
    }


def _build_client(monkeypatch, engine_result, *, guardian_result=None,
                  guardian_raises=False, ui_enabled=True, env_enabled=True):
    """Wire the analyze router with the engine stubbed and Guardian spied.

    Returns (client, guardian_calls) — guardian_calls records every text the
    Guardian stub was invoked with, so tests can assert it was skipped.
    """
    monkeypatch.setenv("SECUREVECTOR_ML_ENABLED", "true" if env_enabled else "false")

    settings = AppSettings()
    settings.cloud_mode_enabled = False
    settings.scan_llm_responses = True
    settings.block_threats = False
    settings.store_text_content = True
    settings.llm_settings = None
    settings.guardian_ml_enabled = ui_enabled

    class _SettingsRepo:
        def __init__(self, db):
            pass

        async def get(self):
            return settings

    monkeypatch.setattr(analyze_mod, "get_database", object)
    monkeypatch.setattr(analyze_mod, "SettingsRepository", _SettingsRepo)
    monkeypatch.setattr(analyze_mod, "ThreatIntelRepository", _NoopThreatIntelRepo)
    monkeypatch.setattr(analyze_mod, "RedactionsRepository", _NoopRedactionsRepo)
    monkeypatch.setattr(analyze_mod, "redact_secrets", lambda text, **kw: (text, 0))

    import securevector.app.services.analysis_service as svc_mod

    monkeypatch.setattr(
        svc_mod, "get_analysis_service", lambda: _FakeAnalysisService(engine_result)
    )

    # Stub the Guardian service (sync fn run via asyncio.to_thread) so the
    # real model bundle never loads and results are deterministic.
    import securevector.app.services.guardian_service as guardian_mod

    guardian_calls = []

    def _stub_analyze(text, *, direction="outgoing"):
        guardian_calls.append(text)
        if guardian_raises:
            raise RuntimeError("model exploded")
        return guardian_result

    monkeypatch.setattr(guardian_mod, "analyze", _stub_analyze)

    app = FastAPI()
    app.include_router(analyze_mod.router, prefix="/api/v1")
    return TestClient(app), guardian_calls


def _post(client, text="hello world"):
    r = client.post("/api/v1/analyze", json={"text": text, "source": "test"})
    assert r.status_code == 200
    return r.json()


# --- ML-alone bar (0.90) ---------------------------------------------------

def test_ml_alone_above_bar_blocks(monkeypatch):
    """No rule fired; Guardian at 0.92 clears the alone bar → threat."""
    client, _ = _build_client(
        monkeypatch, _engine_clean(), guardian_result=_guardian_hit(0.92)
    )
    body = _post(client)
    assert body["is_threat"] is True
    assert len(body["matched_rules"]) == 1
    assert body["matched_rules"][0]["source"] == "model"
    assert body["matched_rules"][0]["rule_id"] == "sv_guardian_model"


def test_ml_alone_below_bar_stays_quiet(monkeypatch):
    """No rule fired; Guardian at 0.85 is under the alone bar → no threat."""
    client, _ = _build_client(
        monkeypatch, _engine_clean(), guardian_result=_guardian_hit(0.85)
    )
    body = _post(client)
    assert body["is_threat"] is False
    assert body["matched_rules"] == []


# --- Corroborate bar (0.60) ------------------------------------------------

def test_ml_corroborates_lone_medium_rule(monkeypatch):
    """A lone 0.65 rule wouldn't alarm; Guardian at 0.65 corroborates → threat."""
    client, _ = _build_client(
        monkeypatch, _engine_rule(0.65), guardian_result=_guardian_hit(0.65)
    )
    body = _post(client)
    assert body["is_threat"] is True
    sources = {r["source"] for r in body["matched_rules"]}
    assert sources == {"community", "model"}


def test_ml_below_corroborate_bar_does_not_tip(monkeypatch):
    """Guardian at 0.55 is under the corroborate bar → lone medium rule stays non-threat."""
    client, _ = _build_client(
        monkeypatch, _engine_rule(0.65), guardian_result=_guardian_hit(0.55)
    )
    body = _post(client)
    assert body["is_threat"] is False
    assert all(r["source"] != "model" for r in body["matched_rules"])


# --- Gating: Settings toggle + env kill-switch ------------------------------

def test_settings_toggle_off_skips_guardian(monkeypatch):
    """guardian_ml_enabled=False in app settings → Guardian never invoked."""
    client, calls = _build_client(
        monkeypatch, _engine_clean(),
        guardian_result=_guardian_hit(0.99), ui_enabled=False,
    )
    body = _post(client)
    assert calls == []
    assert body["is_threat"] is False


def test_env_killswitch_overrides_ui_toggle(monkeypatch):
    """SECUREVECTOR_ML_ENABLED=false force-disables even with the UI toggle on."""
    client, calls = _build_client(
        monkeypatch, _engine_clean(),
        guardian_result=_guardian_hit(0.99), env_enabled=False,
    )
    body = _post(client)
    assert calls == []
    assert body["is_threat"] is False


# --- Fail-open / additive guarantees ----------------------------------------

def test_guardian_error_leaves_rule_verdict_intact(monkeypatch):
    """Guardian raising mid-flight must not affect a high-confidence rule verdict."""
    client, calls = _build_client(
        monkeypatch, _engine_rule(0.95), guardian_raises=True
    )
    body = _post(client)
    assert len(calls) == 1  # it ran (and blew up) — and was ignored
    assert body["is_threat"] is True
    assert [r["source"] for r in body["matched_rules"]] == ["community"]


def test_guardian_benign_never_suppresses_rules(monkeypatch):
    """A benign Guardian result is purely additive — strong rule still alarms."""
    benign = {"is_threat": False, "threat_type": None, "risk_score": 0,
              "confidence": 0.1, "matched_rules": []}
    client, _ = _build_client(
        monkeypatch, _engine_rule(0.95), guardian_result=benign
    )
    body = _post(client)
    assert body["is_threat"] is True
    assert [r["source"] for r in body["matched_rules"]] == ["community"]
