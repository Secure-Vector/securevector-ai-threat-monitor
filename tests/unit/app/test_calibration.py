"""Unit tests for the calibration primitives (issue #136)."""

from securevector.app.services.analysis_service import (
    CALIBRATED_HIGH_CONFIDENCE,
    CALIBRATED_MED_CONFIDENCE,
    calibrate_confidence,
    calibrated_verdict,
    direction_applies,
    resolve_direction,
)


def test_authored_confidence_wins_and_clamps():
    assert calibrate_confidence("low", 0.95) == 0.95
    assert calibrate_confidence("critical", 0.1) == 0.1
    assert calibrate_confidence("high", 2.0) == 1.0   # clamp high
    assert calibrate_confidence("high", -1.0) == 0.0  # clamp low


def test_severity_default_when_unauthored():
    assert calibrate_confidence("critical") == 0.9
    assert calibrate_confidence("high") == 0.75
    assert calibrate_confidence("medium") == 0.6
    assert calibrate_confidence("low") == 0.4
    assert calibrate_confidence("unknown-severity") == 0.6  # fallback


def test_non_numeric_authored_falls_back_to_severity():
    assert calibrate_confidence("critical", "not-a-number") == 0.9
    assert calibrate_confidence("medium", None) == 0.6


def test_calibrated_verdict_single_high_alarms():
    assert calibrated_verdict([CALIBRATED_HIGH_CONFIDENCE]) is True
    assert calibrated_verdict([0.95]) is True


def test_calibrated_verdict_lone_medium_does_not_alarm():
    assert calibrated_verdict([CALIBRATED_MED_CONFIDENCE]) is False
    assert calibrated_verdict([0.6]) is False


def test_calibrated_verdict_two_mediums_corroborate():
    assert calibrated_verdict([CALIBRATED_MED_CONFIDENCE, CALIBRATED_MED_CONFIDENCE]) is True


def test_calibrated_verdict_low_and_empty():
    assert calibrated_verdict([0.4]) is False
    assert calibrated_verdict([0.4, 0.4, 0.4]) is False  # below medium bar
    assert calibrated_verdict([]) is False


def test_calibrated_verdict_ignores_non_numeric():
    assert calibrated_verdict([None, "x", 0.9]) is True
    assert calibrated_verdict([None, "x"]) is False


# --- direction resolution + applicability (issue #136 Phase 3) -------------

def test_resolve_direction_explicit_tag_wins():
    assert resolve_direction("any_id", "data_leakage", "outgoing") == "outgoing"
    assert resolve_direction("any_id", "data_leakage", "incoming") == "incoming"
    assert resolve_direction("any_id", "data_leakage", "both") == "both"


def test_resolve_direction_legacy_values_normalize_to_both():
    # input/output/llm_response were dead config → treated as unset → both.
    assert resolve_direction("sv_x_001", "prompt_injection", "input") == "both"
    assert resolve_direction("sv_x_001", "data_leakage", "output") == "both"
    assert resolve_direction("sv_x_001", "data_leakage", None) == "both"


def test_resolve_direction_evasion_id_defaults_outgoing():
    # Reproduces the route's historical `"_evasion_" in id` incoming-suppression.
    assert resolve_direction("sv_community_075_evasion_leetspeak", "x", None) == "outgoing"


def test_direction_applies_both_always():
    for scan in ("incoming", "outgoing", "llm_response", None):
        assert direction_applies("both", scan) is True


def test_direction_applies_outgoing_rule_suppressed_on_incoming():
    assert direction_applies("outgoing", "incoming") is False
    assert direction_applies("outgoing", "outgoing") is True
    assert direction_applies("outgoing", "llm_response") is True
    assert direction_applies("outgoing", None) is True  # unspecified → applies


def test_direction_applies_incoming_only_rule():
    assert direction_applies("incoming", "incoming") is True
    assert direction_applies("incoming", "outgoing") is False
    assert direction_applies("incoming", "llm_response") is False
