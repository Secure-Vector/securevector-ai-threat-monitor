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

from ai_threat_monitor.models.analysis_result import (
    AnalysisResult,
    DetectionMethod,
    ThreatDetection,
)
from ai_threat_monitor.models.config_models import APIModeConfig
from utils.exceptions import APIError, AuthenticationError, RateLimitError
from utils.logger import get_logger
from utils.security import mask_sensitive_value


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
                "Authorization": f"Bearer {config.api_key}",
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
            f"API analyzer initialized for {config.api_url}{config.endpoint} "
            f"with API key: {mask_sensitive_value(config.api_key)}"
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

        # Prepare request payload
        payload = {"prompt": prompt, "timestamp": datetime.utcnow().isoformat(), "options": kwargs}

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

        # Prepare batch request payload
        payload = {
            "prompts": prompts,
            "timestamp": datetime.utcnow().isoformat(),
            "options": kwargs,
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

            # Create analysis result
            result = AnalysisResult(
                is_threat=data.get("is_threat", False),
                risk_score=data.get("risk_score", 0),
                confidence=data.get("confidence", 0.0),
                detections=detections,
                analysis_time_ms=analysis_time_ms,
                detection_method=DetectionMethod.API_ENHANCED,
                metadata=data.get("metadata", {}),
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
                # Parse individual result similar to single response
                detections = []
                for detection_data in result_data.get("detections", []):
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

                result = AnalysisResult(
                    is_threat=result_data.get("is_threat", False),
                    risk_score=result_data.get("risk_score", 0),
                    confidence=result_data.get("confidence", 0.0),
                    detections=detections,
                    analysis_time_ms=result_data.get("analysis_time_ms", 0.0),
                    detection_method=DetectionMethod.API_ENHANCED,
                    metadata=result_data.get("metadata", {}),
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
        self.session.headers.update({"Authorization": f"Bearer {config.api_key}"})

        # Update timeout
        self.timeout = (config.timeout_ms / 1000, config.timeout_ms / 1000)

        self.logger.info("API analyzer configuration updated")

    def close(self) -> None:
        """Clean up resources"""
        if self.session:
            self.session.close()

        self.logger.debug("API analyzer closed")
