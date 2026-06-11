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

# Threat types and rule-name fragments that mean a credential / secret / PII
# was exposed. Used to light the Agent Map's lock badge from the detection
# pipeline (a leaked secret on an *allowed* call never reaches the audit
# row's ``reason``, so the legacy reason-LIKE heuristic alone misses it).
_SECRET_THREAT_TYPES = frozenset(
    {
        "data_leakage",
        "secret_exposure",
        "credential_exfil",
        "credential_exfiltration",
        "pii_exposure",
        "sensitive_data",
        "sensitive_information_disclosure",
    }
)
_SECRET_RULE_FRAGMENTS = (
    "credential",
    "secret",
    "api key",
    "api_key",
    "sensitive information",
    "data leak",
    "exfil",
    "pii",
)


def is_secret_detection(threat_type, rules) -> bool:
    """True when a detection represents a leaked credential / secret / PII.

    Matches on the threat type first, then falls back to scanning the matched
    rule names for secret/credential fragments — so a leak caught purely by a
    credential rule still lights the lock even if the coarse ``threat_type``
    is something generic.
    """
    if isinstance(threat_type, str) and threat_type.strip().lower() in _SECRET_THREAT_TYPES:
        return True
    for name in rules or []:
        if not name:
            continue
        low = str(name).lower()
        if any(frag in low for frag in _SECRET_RULE_FRAGMENTS):
            return True
    return False


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

    # A rule that matched several spans is recorded once per match, so the raw
    # list repeats names ("System-prompt extraction ×3"). Dedupe, preserving
    # first-seen order, so the UI shows each rule once.
    _seen: set = set()
    names = []
    for r in rule_hits:
        n = r.get("rule_name") or r.get("name") or r.get("rule_id")
        if n and n not in _seen:
            _seen.add(n)
            names.append(n)

    if has_ml and has_rule:
        source = "rule_ml"
    elif has_ml:
        source = "ml"
    else:
        source = "rule"

    return {"source": source, "ml_score": ml_score, "rules": names}
