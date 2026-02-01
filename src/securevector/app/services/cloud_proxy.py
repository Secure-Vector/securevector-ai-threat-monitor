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
  - /api/analyze: X-Api-Key header
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

        Uses X-Api-Key header for /api/analyze endpoint.

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
            payload = {"text": text}
            if metadata:
                payload["metadata"] = metadata

            response = await client.post(
                "/api/analyze",
                json=payload,
                headers={"X-Api-Key": api_key},
            )

            if response.status_code == 200:
                result = response.json()
                result["analysis_source"] = "cloud"
                return result
            elif response.status_code == 401:
                raise CloudProxyError("Invalid API key")
            else:
                raise CloudProxyError(f"Cloud API error: {response.status_code}")

        except httpx.TimeoutException:
            logger.warning("Cloud API timeout, will fallback to local")
            raise CloudProxyError("timeout")
        except httpx.ConnectError:
            logger.warning("Cloud API connection error, will fallback to local")
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
            payload = {"text": text}
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

    async def get_rules(self) -> Dict[str, Any]:
        """
        Proxy rules request to cloud API.

        Uses Authorization: Bearer header for /api/rules endpoint.

        Returns:
            Rules from cloud API.

        Raises:
            CloudProxyError: On connection/timeout errors.
        """
        bearer_token = get_bearer_token()
        if not bearer_token:
            raise CloudProxyError("Bearer token not configured")

        try:
            client = await self._get_client()
            response = await client.get(
                "/api/rules",
                headers={"Authorization": f"Bearer {bearer_token}"},
            )

            if response.status_code == 200:
                result = response.json()
                result["source"] = "cloud"
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


# Global singleton instance
_cloud_proxy: Optional[CloudProxyService] = None


def get_cloud_proxy() -> CloudProxyService:
    """Get the global cloud proxy service instance."""
    global _cloud_proxy
    if _cloud_proxy is None:
        _cloud_proxy = CloudProxyService()
    return _cloud_proxy
