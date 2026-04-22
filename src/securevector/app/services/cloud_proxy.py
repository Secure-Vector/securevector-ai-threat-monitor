"""
Cloud API proxy service for SecureVector desktop app.

Proxies requests to the SecureVector cloud API (api.securevector.io) when
cloud mode is enabled. Stores SecureVector Cloud webapp credentials securely
in the OS keychain for authentication.

Features:
- Async HTTP client using httpx
- Automatic timeout handling (5 seconds)
- Fallback to local analysis on errors
- Correct authentication headers per endpoint:
  - /analyze: X-Api-Key header
  - /api/threat-analytics/: Authorization: Bearer header
  - /api/rules: Authorization: Bearer header
"""

import logging
from typing import Any, Dict, Optional

try:
    import httpx

    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False

from securevector.app.services.cloud_config import (
    CLOUD_API_BASE_URL,
    CLOUD_API_TIMEOUT,
    CLOUD_API_URL,
    CLOUD_RULES_SYNC_TIMEOUT,
)
from securevector.app.services.credentials import get_api_key, get_bearer_token

logger = logging.getLogger(__name__)


class CloudProxyError(Exception):
    """Error during cloud API proxy operation."""

    pass


class CloudProxyService:
    """
    Service for proxying requests to SecureVector cloud API.

    Uses credentials stored in OS keychain (from SecureVector Cloud webapp)
    to authenticate with the cloud API.
    """

    def __init__(self) -> None:
        """Initialize the cloud proxy service."""
        self._client: Optional["httpx.AsyncClient"] = None

    async def _get_client(self) -> "httpx.AsyncClient":
        """Get or create the async HTTP client."""
        if not HTTPX_AVAILABLE:
            raise CloudProxyError("httpx is not installed")

        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=CLOUD_API_BASE_URL,
                timeout=CLOUD_API_TIMEOUT,
            )
        return self._client

    async def close(self) -> None:
        """Close the HTTP client."""
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    async def validate_credentials(self, bearer_token: str) -> Optional[Dict[str, Any]]:
        """
        Validate credentials with cloud API.

        Args:
            bearer_token: The bearer token to validate.

        Returns:
            User info dict if valid, None if invalid.
        """
        try:
            client = await self._get_client()
            response = await client.get(
                "/api/user/me",
                headers={"Authorization": f"Bearer {bearer_token}"},
            )

            if response.status_code == 200:
                return response.json()
            elif response.status_code == 401:
                logger.warning("Invalid or expired credentials")
                return None
            else:
                logger.error(f"Unexpected status code: {response.status_code}")
                return None

        except httpx.TimeoutException:
            logger.error("Timeout validating credentials")
            raise CloudProxyError("Connection timeout")
        except httpx.ConnectError:
            logger.error("Connection error validating credentials")
            raise CloudProxyError("Connection failed")
        except Exception as e:
            logger.error(f"Error validating credentials: {e}")
            raise CloudProxyError(str(e))

    async def analyze(self, text: str, metadata: Optional[Dict] = None) -> Dict[str, Any]:
        """
        Proxy analysis request to cloud API.

        Uses X-Api-Key header for /analyze endpoint.

        Args:
            text: Text to analyze.
            metadata: Optional metadata to include.

        Returns:
            Analysis result from cloud API.

        Raises:
            CloudProxyError: On connection/timeout errors.
        """
        api_key = get_api_key()
        if not api_key:
            raise CloudProxyError("API key not configured")

        try:
            client = await self._get_client()
            payload = {
                "prompt": text,
                "user_tier": "professional",
            }
            if metadata:
                payload["metadata"] = metadata

            response = await client.post(
                "/analyze",
                json=payload,
                headers={"X-Api-Key": api_key},
            )

            if response.status_code == 200:
                raw = response.json()
                logger.debug(f"Cloud API raw response: {raw}")

                # Map cloud API fields to local format
                verdict = raw.get("verdict", "").upper()
                is_threat = verdict in ("BLOCK", "WARN", "REVIEW")
                threat_score = raw.get("threat_score", 0)
                risk_score = int(threat_score * 100) if threat_score <= 1 else int(threat_score)

                # Get threat type from analysis.ml_category or matched_rules
                threat_type = None
                analysis = raw.get("analysis", {})
                if analysis.get("ml_category"):
                    threat_type = analysis["ml_category"]
                elif raw.get("matched_rules"):
                    threat_type = raw["matched_rules"][0].get("category")

                result = {
                    "is_threat": is_threat,
                    "threat_type": threat_type or raw.get("threat_level"),
                    "risk_score": risk_score,
                    "confidence": raw.get("confidence_score", 0.0),
                    "matched_rules": raw.get("matched_rules", []),
                    "recommendation": raw.get("recommendation"),
                    "verdict": verdict,
                    "analysis_source": "cloud",
                }
                return result
            elif response.status_code == 401:
                raise CloudProxyError("Invalid API key")
            elif response.status_code == 422:
                # Validation error - log details
                try:
                    error_detail = response.json()
                    logger.error(f"Cloud API validation error: {error_detail}")
                except Exception:
                    logger.error(f"Cloud API validation error: {response.text}")
                raise CloudProxyError(f"Cloud API validation error: {response.status_code}")
            else:
                raise CloudProxyError(f"Cloud API error: {response.status_code}")

        except httpx.TimeoutException:
            logger.warning("Cloud API timeout, will fallback to local")
            raise CloudProxyError("timeout")
        except httpx.ConnectError:
            logger.warning("Cloud API connection error, will fallback to local")
            raise CloudProxyError("connection_error")

    async def analyze_output(
        self,
        output_text: str,
        *,
        metadata: Optional[Dict] = None,
        scan_types: Optional[list[str]] = None,
        enable_masking: bool = True,
        enable_ml_validation: bool = True,
        model_id: Optional[str] = None,
        conversation_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Proxy an LLM-output scan to the cloud ``POST /analyze/output``.

        **Only invoked when Cloud Connect is on.** The caller
        (``routes/analyze.py``) gates every cloud call on
        ``settings.cloud_mode_enabled`` — this method will never fire if
        the toggle is off. With Cloud Connect off, LLM-output scans fall
        through to the local regex ruleset and this method is not reached.

        Distinct from ``analyze()`` which hits ``/analyze`` (input prompts).
        Output scans look for data-leakage patterns the input-scan ruleset
        does not cover (PII in responses, credit cards, API keys leaked by
        the model, injection artifacts echoed back) and surface differently
        on the cloud dashboard's Output Analysis page.

        Payload matches LSE's ``OutputScanRequest``:
            output, tier, metadata, output_format, scan_types,
            enable_masking, enable_ml_validation, model_id, conversation_id.

        Returns a dict shaped like ``analyze()`` so the caller can treat
        input and output scans uniformly at the edge.
        """
        api_key = get_api_key()
        if not api_key:
            raise CloudProxyError("API key not configured")

        try:
            client = await self._get_client()
            payload: Dict[str, Any] = {
                "output": output_text,
                "tier": "professional",
                "output_format": "text",
                "scan_types": scan_types or ["pii", "secrets", "injection"],
                "enable_masking": enable_masking,
                "enable_ml_validation": enable_ml_validation,
            }
            if metadata:
                payload["metadata"] = metadata
            if model_id:
                payload["model_id"] = model_id
            if conversation_id:
                payload["conversation_id"] = conversation_id

            response = await client.post(
                "/analyze/output",
                json=payload,
                headers={"X-Api-Key": api_key},
            )

            if response.status_code == 200:
                raw = response.json()
                logger.debug(f"Cloud /analyze/output raw response: {raw}")

                verdict = str(raw.get("verdict", "")).upper()
                is_threat = verdict in ("BLOCK", "WARN", "REVIEW")
                threat_score = raw.get("threat_score", 0)
                risk_score = (
                    int(threat_score * 100) if threat_score <= 1 else int(threat_score)
                )

                # Prefer the dominant detected type for output scans
                threat_type: Optional[str] = None
                detected_items = raw.get("detected_items") or []
                if detected_items:
                    threat_type = detected_items[0].get("type")
                if not threat_type:
                    detected_types = raw.get("detected_types") or []
                    if detected_types:
                        threat_type = detected_types[0]
                if threat_type and not threat_type.startswith("output_"):
                    threat_type = f"output_{threat_type}"

                return {
                    "is_threat": is_threat,
                    "threat_type": threat_type or raw.get("risk_level"),
                    "risk_score": risk_score,
                    "confidence": raw.get("confidence_score", 0.0),
                    # detected_items intentionally NOT forwarded to the edge —
                    # keep the local surface consistent with the cloud's
                    # post-002 metadata-only shape.
                    "matched_rules": [],
                    "recommendation": (raw.get("recommendations") or [None])[0],
                    "verdict": verdict,
                    "analysis_source": "cloud",
                    "scan_id": raw.get("scan_id"),
                    "detected_items_count": len(detected_items),
                    "detected_types": raw.get("detected_types", []),
                    "risk_level": raw.get("risk_level"),
                    "ml_status": raw.get("ml_status"),
                    "scan_duration_ms": raw.get("scan_duration_ms"),
                }
            elif response.status_code == 401:
                raise CloudProxyError("Invalid API key")
            elif response.status_code == 422:
                try:
                    error_detail = response.json()
                    logger.error(f"Cloud /analyze/output validation error: {error_detail}")
                except Exception:
                    logger.error(f"Cloud /analyze/output validation error: {response.text}")
                raise CloudProxyError(
                    f"Cloud API validation error: {response.status_code}"
                )
            elif response.status_code == 428:
                raise CloudProxyError(
                    "Output-scan TOS not accepted. Enable it in the dashboard."
                )
            else:
                raise CloudProxyError(f"Cloud API error: {response.status_code}")

        except httpx.TimeoutException:
            logger.warning("Cloud /analyze/output timeout, will fallback to local")
            raise CloudProxyError("timeout")
        except httpx.ConnectError:
            logger.warning("Cloud /analyze/output connection error, will fallback to local")
            raise CloudProxyError("connection_error")

    async def threat_analytics(
        self, text: str, metadata: Optional[Dict] = None
    ) -> Dict[str, Any]:
        """
        Proxy threat analytics request to cloud API.

        Uses Authorization: Bearer header for /api/threat-analytics/ endpoint.

        Args:
            text: Text to analyze.
            metadata: Optional metadata to include.

        Returns:
            Analysis result from cloud API.

        Raises:
            CloudProxyError: On connection/timeout errors.
        """
        bearer_token = get_bearer_token()
        if not bearer_token:
            raise CloudProxyError("Bearer token not configured")

        try:
            client = await self._get_client()
            payload = {"prompt": text}
            if metadata:
                payload["metadata"] = metadata

            response = await client.post(
                "/api/threat-analytics/",
                json=payload,
                headers={"Authorization": f"Bearer {bearer_token}"},
            )

            if response.status_code == 200:
                result = response.json()
                result["analysis_source"] = "cloud"
                return result
            elif response.status_code == 401:
                raise CloudProxyError("Invalid bearer token")
            else:
                raise CloudProxyError(f"Cloud API error: {response.status_code}")

        except httpx.TimeoutException:
            logger.warning("Cloud API timeout, will fallback to local")
            raise CloudProxyError("timeout")
        except httpx.ConnectError:
            logger.warning("Cloud API connection error, will fallback to local")
            raise CloudProxyError("connection_error")

    async def get_rules(self, tier: Optional[str] = None) -> Dict[str, Any]:
        """
        Fetch the customer's tier-filtered rule bundle from ai-sentinel.

        POSTs to ``{CLOUD_API_URL}/api/rules/sync`` — the rules intel
        service (``security-rules-intel-service``) — not the scan engine
        and not llm-rules-intel. ai-sentinel is the customer-facing
        rule server; it owns the per-user bundle (tier filter + user
        overrides applied) and the auth flow.

        Authentication:
          Sends BOTH ``X-Api-Key`` and ``Authorization: Bearer`` when
          the respective credentials are present in keychain. The server
          accepts either — X-Api-Key takes precedence; Bearer is tried
          against Supabase JWT / OAuth / api_keys in order.

        Args:
            tier: Optional tier downgrade ("community" | "professional" |
                "enterprise"). The server will NEVER return a higher
                tier than the user's subscription — escalations are
                silently capped.

        Returns:
            Bundle dict with keys: ``rules`` (list), ``total``,
            ``effective_tier``, ``bundle_version``, ``compiled_at``,
            ``included_tiers``, ``subscription_tier``, ``user_id``.

        Raises:
            CloudProxyError: On connection/timeout/auth errors.
        """
        if not HTTPX_AVAILABLE:
            raise CloudProxyError("httpx is not installed")

        headers: Dict[str, str] = {"Content-Type": "application/json"}
        api_key = get_api_key()
        if api_key:
            headers["X-Api-Key"] = api_key
        bearer_token = get_bearer_token()
        if bearer_token:
            headers["Authorization"] = f"Bearer {bearer_token}"

        if not api_key and not bearer_token:
            raise CloudProxyError(
                "No credentials configured — enable Cloud Connect first"
            )

        body: Dict[str, Any] = {}
        if tier:
            body["tier"] = tier

        url = f"{CLOUD_API_URL.rstrip('/')}/api/rules/sync"

        try:
            async with httpx.AsyncClient(timeout=CLOUD_RULES_SYNC_TIMEOUT) as client:
                response = await client.post(url, headers=headers, json=body)

            if response.status_code == 200:
                result = response.json()
                if not isinstance(result, dict):
                    raise CloudProxyError("rules-intel returned non-object body")
                result.setdefault("source", "rules-intel")
                return result
            if response.status_code == 401:
                raise CloudProxyError("Invalid credentials for rules-intel")
            if response.status_code == 403:
                raise CloudProxyError(
                    "Credentials not authorized for rule sync (tier/entitlement)"
                )
            if response.status_code == 503:
                raise CloudProxyError(
                    "Rule bundle not yet compiled on the server — try again in a few minutes"
                )
            raise CloudProxyError(
                f"rules-intel error: {response.status_code} {response.text[:200]}"
            )

        except httpx.TimeoutException:
            logger.warning(f"rules-intel timeout at {url}")
            raise CloudProxyError("timeout")
        except httpx.ConnectError:
            logger.warning(f"rules-intel connection error at {url}")
            raise CloudProxyError("connection_error")


# Global singleton instance
_cloud_proxy: Optional[CloudProxyService] = None


def get_cloud_proxy() -> CloudProxyService:
    """Get the global cloud proxy service instance."""
    global _cloud_proxy
    if _cloud_proxy is None:
        _cloud_proxy = CloudProxyService()
    return _cloud_proxy
