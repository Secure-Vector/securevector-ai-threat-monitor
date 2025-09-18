"""
Testing assertions for the SecureVector AI Threat Monitor SDK.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

from typing import List, Optional, Union

from securevector.models.analysis_result import AnalysisResult


class AssertionError(Exception):
    """Custom assertion error for SDK testing"""

    pass


def assert_is_threat(result: AnalysisResult, message: Optional[str] = None):
    """
    Assert that the analysis result indicates a threat.

    Args:
        result: AnalysisResult to check
        message: Optional custom error message

    Raises:
        AssertionError: If result does not indicate a threat
    """
    if not result.is_threat:
        error_msg = message or (
            f"Expected threat detection but got safe result. "
            f"Risk score: {result.risk_score}, Confidence: {result.confidence}"
        )
        raise AssertionError(error_msg)


def assert_is_safe(result: AnalysisResult, message: Optional[str] = None):
    """
    Assert that the analysis result indicates a safe prompt.

    Args:
        result: AnalysisResult to check
        message: Optional custom error message

    Raises:
        AssertionError: If result indicates a threat
    """
    if result.is_threat:
        error_msg = message or (
            f"Expected safe result but got threat detection. "
            f"Risk score: {result.risk_score}, Threats: {result.threat_types}"
        )
        raise AssertionError(error_msg)


def assert_risk_score(
    result: AnalysisResult,
    min_score: Optional[int] = None,
    max_score: Optional[int] = None,
    exact_score: Optional[int] = None,
    message: Optional[str] = None,
):
    """
    Assert that the risk score meets specified criteria.

    Args:
        result: AnalysisResult to check
        min_score: Minimum expected risk score
        max_score: Maximum expected risk score
        exact_score: Exact expected risk score
        message: Optional custom error message

    Raises:
        AssertionError: If risk score doesn't meet criteria
    """
    actual_score = result.risk_score

    if exact_score is not None:
        if actual_score != exact_score:
            error_msg = message or f"Expected risk score {exact_score}, got {actual_score}"
            raise AssertionError(error_msg)
        return

    if min_score is not None and actual_score < min_score:
        error_msg = message or f"Risk score {actual_score} is below minimum {min_score}"
        raise AssertionError(error_msg)

    if max_score is not None and actual_score > max_score:
        error_msg = message or f"Risk score {actual_score} is above maximum {max_score}"
        raise AssertionError(error_msg)


def assert_threat_types(
    result: AnalysisResult,
    expected_types: List[str],
    exact_match: bool = False,
    message: Optional[str] = None,
):
    """
    Assert that the result contains expected threat types.

    Args:
        result: AnalysisResult to check
        expected_types: List of expected threat types
        exact_match: If True, threat types must match exactly
        message: Optional custom error message

    Raises:
        AssertionError: If threat types don't match expectations
    """
    actual_types = result.threat_types or []

    if exact_match:
        if set(actual_types) != set(expected_types):
            error_msg = message or (
                f"Expected exact threat types {expected_types}, " f"got {actual_types}"
            )
            raise AssertionError(error_msg)
    else:
        missing_types = set(expected_types) - set(actual_types)
        if missing_types:
            error_msg = message or (
                f"Missing expected threat types: {list(missing_types)}. " f"Got: {actual_types}"
            )
            raise AssertionError(error_msg)


def assert_confidence(
    result: AnalysisResult,
    min_confidence: Optional[float] = None,
    max_confidence: Optional[float] = None,
    message: Optional[str] = None,
):
    """
    Assert that the confidence level meets specified criteria.

    Args:
        result: AnalysisResult to check
        min_confidence: Minimum expected confidence (0.0-1.0)
        max_confidence: Maximum expected confidence (0.0-1.0)
        message: Optional custom error message

    Raises:
        AssertionError: If confidence doesn't meet criteria
    """
    actual_confidence = result.confidence

    if min_confidence is not None and actual_confidence < min_confidence:
        error_msg = message or (f"Confidence {actual_confidence} is below minimum {min_confidence}")
        raise AssertionError(error_msg)

    if max_confidence is not None and actual_confidence > max_confidence:
        error_msg = message or (f"Confidence {actual_confidence} is above maximum {max_confidence}")
        raise AssertionError(error_msg)


def assert_analysis_time(
    result: AnalysisResult,
    max_time_ms: Optional[float] = None,
    min_time_ms: Optional[float] = None,
    message: Optional[str] = None,
):
    """
    Assert that the analysis time meets performance criteria.

    Args:
        result: AnalysisResult to check
        max_time_ms: Maximum expected analysis time in milliseconds
        min_time_ms: Minimum expected analysis time in milliseconds
        message: Optional custom error message

    Raises:
        AssertionError: If analysis time doesn't meet criteria
    """
    actual_time = result.analysis_time_ms

    if max_time_ms is not None and actual_time > max_time_ms:
        error_msg = message or (f"Analysis time {actual_time}ms exceeds maximum {max_time_ms}ms")
        raise AssertionError(error_msg)

    if min_time_ms is not None and actual_time < min_time_ms:
        error_msg = message or (f"Analysis time {actual_time}ms is below minimum {min_time_ms}ms")
        raise AssertionError(error_msg)


def assert_batch_results(
    results: List[AnalysisResult],
    expected_count: Optional[int] = None,
    min_threat_rate: Optional[float] = None,
    max_threat_rate: Optional[float] = None,
    message: Optional[str] = None,
):
    """
    Assert properties of batch analysis results.

    Args:
        results: List of AnalysisResult to check
        expected_count: Expected number of results
        min_threat_rate: Minimum expected threat detection rate (0.0-1.0)
        max_threat_rate: Maximum expected threat detection rate (0.0-1.0)
        message: Optional custom error message

    Raises:
        AssertionError: If batch results don't meet criteria
    """
    actual_count = len(results)

    if expected_count is not None and actual_count != expected_count:
        error_msg = message or f"Expected {expected_count} results, got {actual_count}"
        raise AssertionError(error_msg)

    if actual_count == 0:
        return

    threat_count = sum(1 for r in results if r.is_threat)
    threat_rate = threat_count / actual_count

    if min_threat_rate is not None and threat_rate < min_threat_rate:
        error_msg = message or (
            f"Threat rate {threat_rate:.2%} is below minimum {min_threat_rate:.2%}"
        )
        raise AssertionError(error_msg)

    if max_threat_rate is not None and threat_rate > max_threat_rate:
        error_msg = message or (
            f"Threat rate {threat_rate:.2%} is above maximum {max_threat_rate:.2%}"
        )
        raise AssertionError(error_msg)


def assert_detection_method(
    result: AnalysisResult, expected_method: str, message: Optional[str] = None
):
    """
    Assert that the result uses the expected detection method.

    Args:
        result: AnalysisResult to check
        expected_method: Expected detection method
        message: Optional custom error message

    Raises:
        AssertionError: If detection method doesn't match
    """
    actual_method = result.detection_method.value if result.detection_method else None

    if actual_method != expected_method:
        error_msg = message or (
            f"Expected detection method '{expected_method}', got '{actual_method}'"
        )
        raise AssertionError(error_msg)


def assert_has_detections(
    result: AnalysisResult,
    min_detections: Optional[int] = None,
    max_detections: Optional[int] = None,
    message: Optional[str] = None,
):
    """
    Assert that the result has the expected number of threat detections.

    Args:
        result: AnalysisResult to check
        min_detections: Minimum expected number of detections
        max_detections: Maximum expected number of detections
        message: Optional custom error message

    Raises:
        AssertionError: If detection count doesn't meet criteria
    """
    detection_count = len(result.detections) if result.detections else 0

    if min_detections is not None and detection_count < min_detections:
        error_msg = message or (
            f"Expected at least {min_detections} detections, got {detection_count}"
        )
        raise AssertionError(error_msg)

    if max_detections is not None and detection_count > max_detections:
        error_msg = message or (
            f"Expected at most {max_detections} detections, got {detection_count}"
        )
        raise AssertionError(error_msg)
