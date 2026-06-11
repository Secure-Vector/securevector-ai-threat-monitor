"""Classify a persisted ``matched_rules`` list into a detection-source label.

A threat can be caught by the regex rules, by the Guardian ML model, or by
both. The Guardian model appears inside ``matched_rules`` as an entry with
``source == "model"`` (rule_id ``sv_guardian_model``); its ``confidence`` is the
ML score. This helper turns that into a single ``rule`` / ``ml`` / ``rule_ml``
label plus the ML score and the matched rule names, so the Threats, Agent Map,
and Agent Runs views all read identical semantics (mirrors the frontend
``DetectionLabel`` helper).
"""

from __future__ import annotations

import json
from typing import Optional

ML_RULE_ID = "sv_guardian_model"


def _is_ml(rule: dict) -> bool:
    return bool(rule) and (
        rule.get("source") == "model" or rule.get("rule_id") == ML_RULE_ID
    )


def classify_matched_rules(matched_rules) -> Optional[dict]:
    """Classify a matched_rules list (or its JSON string form).

    Returns ``{"source": "rule"|"ml"|"rule_ml", "ml_score": float|None,
    "rules": [str, ...]}`` or ``None`` when nothing matched. ``rules`` holds the
    non-ML rule names, for the "Detected by rules (…)" tooltip.
    """
    if isinstance(matched_rules, str):
        try:
            matched_rules = json.loads(matched_rules)
        except (ValueError, TypeError):
            return None
    if not isinstance(matched_rules, list):
        return None

    rules = [r for r in matched_rules if isinstance(r, dict)]
    ml = next((r for r in rules if _is_ml(r)), None)
    rule_hits = [r for r in rules if not _is_ml(r)]
    has_ml = ml is not None
    has_rule = len(rule_hits) > 0
    if not has_ml and not has_rule:
        return None

    ml_score = None
    if has_ml:
        conf = ml.get("confidence")
        if isinstance(conf, (int, float)):
            ml_score = round(float(conf), 3)

    names = [r.get("rule_name") or r.get("name") or r.get("rule_id") for r in rule_hits]
    names = [n for n in names if n]

    if has_ml and has_rule:
        source = "rule_ml"
    elif has_ml:
        source = "ml"
    else:
        source = "rule"

    return {"source": source, "ml_score": ml_score, "rules": names}
