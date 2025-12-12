"""
API analyzer for enhanced threat detection via SecureVector API.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import json
import logging
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

import requests

from securevector.models.analysis_result import (
    AnalysisResult,
    DetectionMethod,
    ThreatDetection,
)
from securevector.models.config_models import APIModeConfig
from securevector.utils.exceptions import APIError, AuthenticationError, RateLimitError
from securevector.utils.logger import get_logger


class APIAnalyzer:
    """
    API analyzer for enhanced threat detection using SecureVector's cloud service.

    Communicates with api.securevector.io to perform advanced ML-based threat detection
    with extended rule sets and cloud-based analysis capabilities.
    """

    def __init__(self, config: APIModeConfig):
        self.config = config
        self.logger = get_logger(__name__)

        # Setup HTTP session with security hardening
        self.session = requests.Session()

        # Disable HTTP logging to prevent API key exposure
        logging.getLogger("requests").setLevel(logging.WARNING)
        logging.getLogger("urllib3").setLevel(logging.WARNING)

        # Configure secure HTTP adapter with connection pooling and SSL settings
        from requests.adapters import HTTPAdapter
        from urllib3.util.retry import Retry

        # Configure retry strategy with exponential backoff
        retry_strategy = Retry(
            total=config.retry_attempts,
            backoff_factor=1,  # Exponential backoff
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["POST", "GET"],
            raise_on_status=False,
        )

        # Setup adapter with connection pooling
        adapter = HTTPAdapter(
            pool_connections=10,  # Number of connection pools
            pool_maxsize=20,  # Max connections per pool
            max_retries=retry_strategy,
            pool_block=False,  # Don't block on pool exhaustion
        )

        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)

        # Security headers
        self.session.headers.update(
            {
                "X-Api-Key": config.api_key,
                "Content-Type": "application/json",
                "User-Agent": "SecureVector-SDK/1.0.0",
                "Accept": "application/json",
                "Accept-Encoding": "gzip, deflate",
                "Connection": "keep-alive",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache",
            }
        )

        # Configure SSL/TLS security
        self.session.verify = True  # Always verify SSL certificates

        # Set secure timeouts (connect, read)
        self.timeout = (
            min(config.timeout_ms / 1000, 10.0),  # Max 10s connect timeout
            min(config.timeout_ms / 1000, 30.0),  # Max 30s read timeout
        )

        # Rate limiting state
        self._last_request_time = 0.0
        self._request_count = 0
        self._rate_limit_reset_time = 0.0

        # Connection health
        self._last_health_check = 0.0
        self._is_healthy = True
        self._last_error = None

        self.logger.info(
            f"API analyzer initialized for {config.api_url}{config.endpoint}"
        )

    def analyze_prompt(self, prompt: str, **kwargs) -> AnalysisResult:
        """
        Analyze a prompt using the SecureVector API.

        Args:
            prompt: The prompt text to analyze
            **kwargs: Additional analysis options

        Returns:
            AnalysisResult: Enhanced analysis result from API

        Raises:
            APIError: If API request fails
            AuthenticationError: If API key is invalid
            RateLimitError: If rate limit is exceeded
        """
        start_time = time.time()

        # Check rate limiting
        self._check_rate_limit()

        # Prepare request payload according to API specification
        payload = {
            "prompt": prompt,
            "user_tier": self.config.user_tier
        }

        try:
            # Make API request
            url = f"{self.config.api_url}{self.config.endpoint}"
            response = self.session.post(url, json=payload, timeout=self.timeout)

            # Update rate limiting state
            self._update_rate_limit_state(response)

            # Handle response
            if response.status_code == 200:
                return self._parse_success_response(response, start_time)
            elif response.status_code == 401:
                raise AuthenticationError("Invalid API key")
            elif response.status_code == 429:
                raise RateLimitError("API rate limit exceeded")
            elif response.status_code == 413:
                raise APIError("Request payload too large")
            else:
                raise APIError(
                    f"API request failed with status {response.status_code}: {response.text}",
                    status_code=response.status_code,
                    response_body=response.text,
                )

        except requests.exceptions.Timeout:
            self._last_error = "Request timeout"
            self._is_healthy = False
            raise APIError(f"API request timed out after {self.config.timeout_ms}ms")

        except requests.exceptions.ConnectionError as e:
            self._last_error = f"Connection error: {e}"
            self._is_healthy = False
            raise APIError(f"Failed to connect to API: {e}")

        except requests.exceptions.RequestException as e:
            self._last_error = f"Request error: {e}"
            self._is_healthy = False
            raise APIError(f"API request failed: {e}")

    def analyze_batch(self, prompts: List[str], **kwargs) -> List[AnalysisResult]:
        """
        Analyze multiple prompts in a single API call.

        Args:
            prompts: List of prompt strings to analyze
            **kwargs: Additional analysis options

        Returns:
            List[AnalysisResult]: Analysis results for each prompt
        """
        start_time = time.time()

        # Check rate limiting
        self._check_rate_limit()

        # Prepare batch request payload according to API specification
        payload = {
            "prompts": prompts,
            "user_tier": self.config.user_tier
        }

        try:
            # Make batch API request
            url = f"{self.config.api_url}{self.config.endpoint}/batch"
            response = self.session.post(
                url,
                json=payload,
                timeout=(self.timeout[0], self.timeout[1] * 2),  # Longer timeout for batch
            )

            # Update rate limiting state
            self._update_rate_limit_state(response)

            # Handle response
            if response.status_code == 200:
                return self._parse_batch_response(response, start_time)
            elif response.status_code == 401:
                raise AuthenticationError("Invalid API key")
            elif response.status_code == 429:
                raise RateLimitError("API rate limit exceeded")
            else:
                raise APIError(
                    f"Batch API request failed with status {response.status_code}: {response.text}",
                    status_code=response.status_code,
                    response_body=response.text,
                )

        except requests.exceptions.RequestException as e:
            self._last_error = f"Batch request error: {e}"
            self._is_healthy = False
            raise APIError(f"Batch API request failed: {e}")

    def _parse_success_response(
        self, response: requests.Response, start_time: float
    ) -> AnalysisResult:
        """Parse successful API response into AnalysisResult"""
        try:
            data = response.json()
            analysis_time_ms = (time.time() - start_time) * 1000

            # Handle both old format (is_threat, risk_score, detections) and new format (verdict, threat_score, matched_rules)
            # Check if this is the new API format
            if "verdict" in data:
                # New API format
                verdict = data.get("verdict", "").upper()
                # Map verdict to is_threat: REVIEW or BLOCK = threat, ALLOW = no threat
                is_threat = verdict in ("REVIEW", "BLOCK")

                # Convert threat_score (0-1 float) to risk_score (0-100 int)
                threat_score = data.get("threat_score", 0.0)
                risk_score = int(min(max(threat_score * 100, 0), 100))

                # Map confidence_score to confidence
                confidence = data.get("confidence_score", 0.0)

                # Parse matched_rules into detections
                detections = []
                matched_rules = data.get("matched_rules", [])
                threat_level = data.get("threat_level", "unknown")

                # If there are matched rules, create detections from them
                for rule_data in matched_rules:
                    if isinstance(rule_data, dict):
                        detection = ThreatDetection(
                            threat_type=rule_data.get("threat_type", "unknown"),
                            risk_score=int(min(max(rule_data.get("risk_score", threat_score) * 100, 0), 100)),
                            confidence=rule_data.get("confidence", confidence),
                            description=rule_data.get("description", ""),
                            rule_id=rule_data.get("rule_id"),
                            pattern_matched=rule_data.get("pattern_matched"),
                            severity=rule_data.get("severity", threat_level.lower()),
                        )
                        detections.append(detection)

                # Extract analysis data
                analysis = data.get("analysis", {})

                # If no matched rules but there's a threat, create a detection from the analysis
                if is_threat and not detections:
                    # Extract ML category from analysis if available
                    ml_category = analysis.get("ml_category", "unknown")
                    ml_reasoning = analysis.get("ml_reasoning", "")

                    detection = ThreatDetection(
                        threat_type=ml_category.lower().replace(" - ", "_").replace(" ", "_") if ml_category else "unknown",
                        risk_score=risk_score,
                        confidence=confidence,
                        description=ml_reasoning or f"Threat detected: {verdict}",
                        rule_id=None,
                        pattern_matched=None,
                        severity=threat_level.lower(),
                    )
                    detections.append(detection)

                # Build metadata with essential security fields prioritized
                #
                # FIELD SELECTION RATIONALE (Security & Product Expert Analysis):
                #
                # ESSENTIAL (Always included):
                # - verdict: Core security decision (BLOCK/REVIEW/ALLOW) - required for policy enforcement
                # - threat_level: Severity classification - needed for risk prioritization
                # - recommendation: User guidance - important for actionable responses
                #
                # IMPORTANT (Conditionally included):
                # - ml_invoked, ml_category, ml_reasoning: CRITICAL when ML detects threats
                #   * Needed to understand ML-based detection reasoning
                #   * Essential for false positive analysis and model improvement
                # - reviewer_invoked, reviewer_reasoning: Important when reviewer is invoked
                #   * Explains why reviewer was called and what it determined
                # - reviewer_adjusted_confidence: Only if significantly different from main confidence
                #   * Reduces noise while preserving important adjustments
                # - ml_error, reviewer_error: Only if errors occurred
                #   * Critical for debugging and understanding failures
                # - rules_matched: Only if rules were matched
                #   * Useful for understanding detection coverage
                #
                # NOT INCLUDED (Performance/Internal metrics - not needed for security decisions):
                # - scan_duration_ms, stage*_duration_ms: Performance metrics, not security-relevant
                # - stages_executed, early_exit: Internal implementation details
                # - rules_evaluated: Statistic, less useful than rules_matched
                # - bundle_version, engine_version: Version info, only needed for debugging
                # - original_response: Full duplicate (can be enabled for advanced debugging if needed)
                #
                essential_fields = {
                    "verdict": verdict,
                    "threat_level": threat_level,
                    "recommendation": data.get("recommendation"),
                }

                # Important: Analysis fields needed for security context and debugging
                analysis_fields = {}
                if analysis:
                    # ML detection info - CRITICAL for understanding ML-based threats
                    if analysis.get("ml_invoked"):
                        analysis_fields["ml_invoked"] = True
                        analysis_fields["ml_category"] = analysis.get("ml_category")
                        analysis_fields["ml_reasoning"] = analysis.get("ml_reasoning")
                        if analysis.get("ml_error"):
                            analysis_fields["ml_error"] = analysis.get("ml_error")

                    # Reviewer info - Important when reviewer is invoked
                    if analysis.get("reviewer_invoked"):
                        analysis_fields["reviewer_invoked"] = True
                        analysis_fields["reviewer_reasoning"] = analysis.get("reviewer_reasoning")
                        # Only include adjusted confidence if it differs from main confidence
                        reviewer_confidence = analysis.get("reviewer_adjusted_confidence")
                        if reviewer_confidence is not None and abs(reviewer_confidence - confidence) > 0.01:
                            analysis_fields["reviewer_adjusted_confidence"] = reviewer_confidence
                        if analysis.get("reviewer_error"):
                            analysis_fields["reviewer_error"] = analysis.get("reviewer_error")

                    # Rule statistics - Useful for understanding detection coverage
                    if analysis.get("rules_matched", 0) > 0:
                        analysis_fields["rules_matched"] = analysis.get("rules_matched")

                # Combine metadata (essential + important analysis fields)
                metadata = {**essential_fields}
                if analysis_fields:
                    metadata["analysis"] = analysis_fields

                # Debug fields: Only include full response if needed for advanced debugging
                # (Can be enabled via config or removed entirely to reduce payload size)
                # metadata["_debug"] = {"full_response": data}  # Commented out - enable if needed
            else:
                # Old API format (backward compatibility)
                is_threat = data.get("is_threat", False)
                risk_score = data.get("risk_score", 0)
                confidence = data.get("confidence", 0.0)

                # Parse threat detections
                detections = []
                for detection_data in data.get("detections", []):
                    detection = ThreatDetection(
                        threat_type=detection_data.get("threat_type", "unknown"),
                        risk_score=detection_data.get("risk_score", 0),
                        confidence=detection_data.get("confidence", 0.0),
                        description=detection_data.get("description", ""),
                        rule_id=detection_data.get("rule_id"),
                        pattern_matched=detection_data.get("pattern_matched"),
                        severity=detection_data.get("severity"),
                    )
                    detections.append(detection)

                metadata = data.get("metadata", {})

            # Create analysis result
            result = AnalysisResult(
                is_threat=is_threat,
                risk_score=risk_score,
                confidence=confidence,
                detections=detections,
                analysis_time_ms=analysis_time_ms,
                detection_method=DetectionMethod.API_ENHANCED,
                metadata=metadata,
            )

            self._is_healthy = True
            self._last_error = None

            return result

        except (json.JSONDecodeError, KeyError) as e:
            raise APIError(f"Invalid API response format: {e}")

    def _parse_batch_response(
        self, response: requests.Response, start_time: float
    ) -> List[AnalysisResult]:
        """Parse batch API response into list of AnalysisResult"""
        try:
            data = response.json()
            results = []

            for result_data in data.get("results", []):
                # Use the same parsing logic as single response
                # Create a mock response object to reuse parsing logic
                class MockResponse:
                    def json(self):
                        return result_data

                # Parse using the same method as single responses
                result = self._parse_success_response(
                    MockResponse(),  # type: ignore
                    start_time
                )
                results.append(result)

            self._is_healthy = True
            self._last_error = None

            return results

        except (json.JSONDecodeError, KeyError) as e:
            raise APIError(f"Invalid batch API response format: {e}")

    def _check_rate_limit(self) -> None:
        """Check and enforce rate limiting"""
        current_time = time.time()

        # Reset rate limit counter if window has passed
        if current_time > self._rate_limit_reset_time:
            self._request_count = 0
            self._rate_limit_reset_time = current_time + self.config.rate_limit_window_seconds

        # Check if we've exceeded the rate limit
        if self._request_count >= self.config.rate_limit_requests:
            wait_time = self._rate_limit_reset_time - current_time
            raise RateLimitError(f"Rate limit exceeded. Try again in {wait_time:.1f} seconds")

        self._request_count += 1
        self._last_request_time = current_time

    def _update_rate_limit_state(self, response: requests.Response) -> None:
        """Update rate limiting state from response headers"""
        # Check for rate limit headers
        remaining = response.headers.get("X-RateLimit-Remaining")
        reset_time = response.headers.get("X-RateLimit-Reset")

        if remaining is not None:
            try:
                remaining_requests = int(remaining)
                if remaining_requests == 0:
                    self._request_count = self.config.rate_limit_requests
            except ValueError:
                pass

        if reset_time is not None:
            try:
                self._rate_limit_reset_time = float(reset_time)
            except ValueError:
                pass

    def test_connection(self) -> Dict[str, Any]:
        """Test connection to the API"""
        try:
            url = f"{self.config.api_url}/health"
            response = self.session.get(url, timeout=self.timeout)

            if response.status_code == 200:
                self._is_healthy = True
                self._last_error = None
                return {
                    "status": "healthy",
                    "response_time_ms": response.elapsed.total_seconds() * 1000,
                    "api_version": response.headers.get("X-API-Version", "unknown"),
                }
            else:
                self._is_healthy = False
                self._last_error = f"Health check failed: {response.status_code}"
                return {
                    "status": "unhealthy",
                    "error": f"HTTP {response.status_code}: {response.text}",
                }

        except Exception as e:
            self._is_healthy = False
            self._last_error = str(e)
            return {"status": "error", "error": str(e)}

    def get_api_info(self) -> Dict[str, Any]:
        """Get information about the API service"""
        try:
            url = f"{self.config.api_url}/info"
            response = self.session.get(url, timeout=self.timeout)

            if response.status_code == 200:
                return response.json()
            else:
                return {"error": f"Failed to get API info: {response.status_code}"}

        except Exception as e:
            return {"error": f"Failed to get API info: {e}"}

    def get_health_status(self) -> Dict[str, Any]:
        """Get health status of the API analyzer"""
        # Perform health check if it's been a while
        current_time = time.time()
        if current_time - self._last_health_check > 60:  # Check every minute
            self.test_connection()
            self._last_health_check = current_time

        return {
            "status": "healthy" if self._is_healthy else "unhealthy",
            "last_error": self._last_error,
            "last_health_check": self._last_health_check,
            "api_endpoint": f"{self.config.api_url}{self.config.endpoint}",
        }

    def get_stats(self) -> Dict[str, Any]:
        """Get API analyzer statistics"""
        return {
            "api_endpoint": f"{self.config.api_url}{self.config.endpoint}",
            "request_count": self._request_count,
            "rate_limit_window": self.config.rate_limit_window_seconds,
            "rate_limit_requests": self.config.rate_limit_requests,
            "last_request_time": self._last_request_time,
            "is_healthy": self._is_healthy,
            "last_error": self._last_error,
        }

    def update_config(self, config: APIModeConfig) -> None:
        """Update API analyzer configuration"""
        self.config = config

        # Update session headers
        self.session.headers.update({"X-Api-Key": config.api_key})

        # Update timeout
        self.timeout = (config.timeout_ms / 1000, config.timeout_ms / 1000)

        self.logger.info("API analyzer configuration updated")

    def close(self) -> None:
        """Clean up resources"""
        if self.session:
            self.session.close()

        self.logger.debug("API analyzer closed")
