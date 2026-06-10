"""SecureVector app integration adapter.

Returns model inference in the EXACT shape of the local app's ``/analyze``
endpoint (``AnalysisResult``), so securevector-app can call Guardian as a
drop-in inference source — in-process or over a tiny loopback HTTP server.

Response shape (matches the SecureVector local app's /analyze endpoint):

    {
      "is_threat": bool,
      "threat_type": str | None,          # canonical category, e.g. "prompt_injection"
      "risk_score": int,                  # 0..100
      "confidence": float,                # 0..1
      "matched_rules": [ {rule_id, rule_name, category, severity,
                          source, matched_patterns, confidence,
                          mitre_techniques} ],
      "analysis_id": None,
      "processing_time_ms": int,
      "request_id": str | None,
      "analysis_source": "model",
      "llm_review": None,
      "redacted_text": None,
      "action_taken": "logged"
    }
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # type-only; avoids importing sklearn/joblib at runtime
    from .model.infer import Guardian

# Severity buckets mirror the app engine (critical 90 / high 75 / medium 50 / low 25).
_SEVERITY_FLOOR = [(90, "critical"), (75, "high"), (50, "medium"), (0, "low")]

_MODEL_RULE_ID = "sv_guardian_model"
_MODEL_RULE_NAME = "SecureVector Guardian (ML)"


def _severity(risk_score: int) -> str:
    for floor, name in _SEVERITY_FLOOR:
        if risk_score >= floor:
            return name
    return "low"


def analyze(text: str, guardian: "Guardian", *, request_id: str | None = None,
            direction: str = "outgoing") -> dict:
    """Classify ``text`` and return an ``AnalysisResult``-shaped dict.

    Long inputs (emails, PDFs, webpages, RAG context) are windowed so a short
    malicious span buried in a large benign body is still caught."""
    from .window import predict_windowed

    t0 = time.perf_counter()
    pred = predict_windowed(guardian, text)
    elapsed_ms = int((time.perf_counter() - t0) * 1000)

    is_threat = pred["verdict"] == "malicious"
    threat_type = pred["category"] if is_threat else None
    # Risk = malicious probability mass scaled to 0..100.
    risk_score = int(round(pred["malicious_score"] * 100))
    confidence = float(pred["malicious_score"]) if is_threat else float(1.0 - pred["malicious_score"])

    matched_rules = []
    if is_threat:
        matched_rules.append({
            "rule_id": _MODEL_RULE_ID,
            "rule_name": _MODEL_RULE_NAME,
            "category": threat_type,
            "severity": _severity(risk_score),
            "source": "model",
            "matched_patterns": [],
            "confidence": round(float(pred["malicious_score"]), 4),
            "mitre_techniques": [],
        })

    return {
        "is_threat": is_threat,
        "threat_type": threat_type,
        "risk_score": max(0, min(100, risk_score)),
        "confidence": round(max(0.0, min(1.0, confidence)), 4),
        "matched_rules": matched_rules,
        "analysis_id": None,
        "processing_time_ms": elapsed_ms,
        "request_id": request_id,
        "analysis_source": "model",
        "llm_review": None,
        "redacted_text": None,
        "action_taken": "logged",
    }
