"""
Authentication validator for SecureVector MCP Server

This module validates API keys against the identity-service and caches
the results for performance.
"""

import httpx
import logging
from typing import Optional, Dict, Any
from datetime import datetime, timedelta
import os

logger = logging.getLogger(__name__)


class AuthValidator:
    """Validates API keys via identity-service"""

    def __init__(self, identity_service_url: Optional[str] = None):
        """
        Initialize the auth validator

        Args:
            identity_service_url: URL of the identity service (e.g., https://auth.securevector.io)
                                 If not provided, uses IDENTITY_SERVICE_URL environment variable
        """
        self.identity_service_url = identity_service_url or os.getenv(
            "IDENTITY_SERVICE_URL",
            "http://localhost:8000"  # Default for local development
        )

        # Cache to avoid validating the same key repeatedly
        # Format: {api_key: (validation_result, expiry_time)}
        self._cache: Dict[str, tuple[Dict[str, Any], datetime]] = {}
        self._cache_ttl = timedelta(minutes=5)  # Cache for 5 minutes

        logger.info(f"AuthValidator initialized with identity service: {self.identity_service_url}")

    async def validate_api_key(self, api_key: str) -> Optional[Dict[str, Any]]:
        """
        Validate an API key via identity-service

        Args:
            api_key: The API key to validate

        Returns:
            Dict with user info, subscription, etc. if valid, None otherwise
        """
        # Check cache first
        cached = self._get_from_cache(api_key)
        if cached:
            logger.debug("API key validation result retrieved from cache")
            return cached

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    f"{self.identity_service_url}/api-keys/validate",
                    headers={"x-api-key": api_key}
                )

                if response.status_code == 200:
                    result = response.json()
                    if result.get("valid"):
                        # Cache the result
                        self._add_to_cache(api_key, result)
                        logger.info(f"API key validated successfully for user {result['user']['user_id']}")
                        return result

                elif response.status_code == 401:
                    logger.warning("Invalid API key provided")
                    return None

                elif response.status_code == 429:
                    logger.error("Rate limit exceeded for API key validation")
                    # Return cached value even if expired, rather than blocking
                    cached_expired = self._get_from_cache(api_key, allow_expired=True)
                    if cached_expired:
                        logger.warning("Using expired cache due to rate limit")
                        return cached_expired
                    return None

                else:
                    logger.error(f"Unexpected response from identity service: {response.status_code}")
                    return None

        except httpx.TimeoutException:
            logger.error("Timeout connecting to identity service")
            # Try to use cached value even if expired
            cached_expired = self._get_from_cache(api_key, allow_expired=True)
            if cached_expired:
                logger.warning("Using expired cache due to timeout")
                return cached_expired
            return None

        except Exception as e:
            logger.error(f"Error validating API key: {e}")
            return None

    def _get_from_cache(self, api_key: str, allow_expired: bool = False) -> Optional[Dict[str, Any]]:
        """Get validation result from cache"""
        if api_key in self._cache:
            result, expiry = self._cache[api_key]
            if allow_expired or datetime.now() < expiry:
                return result
            else:
                # Remove expired entry
                del self._cache[api_key]
        return None

    def _add_to_cache(self, api_key: str, result: Dict[str, Any]):
        """Add validation result to cache"""
        expiry = datetime.now() + self._cache_ttl
        self._cache[api_key] = (result, expiry)

        # Clean up old cache entries (simple approach)
        if len(self._cache) > 1000:  # Arbitrary limit
            self._cleanup_cache()

    def _cleanup_cache(self):
        """Remove expired entries from cache"""
        now = datetime.now()
        expired_keys = [
            key for key, (_, expiry) in self._cache.items()
            if expiry < now
        ]
        for key in expired_keys:
            del self._cache[key]

        logger.debug(f"Cleaned up {len(expired_keys)} expired cache entries")

    def invalidate_cache(self, api_key: Optional[str] = None):
        """
        Invalidate cache for a specific key or all keys

        Args:
            api_key: Specific key to invalidate, or None to clear all
        """
        if api_key:
            if api_key in self._cache:
                del self._cache[api_key]
                logger.debug(f"Invalidated cache for API key")
        else:
            self._cache.clear()
            logger.info("Cleared entire API key validation cache")
