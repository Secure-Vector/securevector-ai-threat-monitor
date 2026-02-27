"""
Unit tests for cloud proxy service.

Tests proxying requests to SecureVector cloud API.
"""

import pytest
from unittest.mock import patch, MagicMock, AsyncMock


class TestCloudProxyService:
    """Tests for the CloudProxyService class."""

    @pytest.fixture
    def proxy_service(self):
        """Create a fresh proxy service instance."""
        from securevector.app.services.cloud_proxy import CloudProxyService

        return CloudProxyService()

    @pytest.mark.asyncio
    @patch("securevector.app.services.cloud_proxy.get_api_key")
    @patch("securevector.app.services.cloud_proxy.httpx.AsyncClient")
    async def test_analyze_success(self, mock_client_class, mock_get_api_key, proxy_service):
        """Test successful analysis request to cloud."""
        mock_get_api_key.return_value = "test_api_key"

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "verdict": "BLOCK",
            "threat_level": "prompt_injection",
            "threat_score": 0.85,
        }

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.is_closed = False
        mock_client_class.return_value = mock_client

        result = await proxy_service.analyze("test text")

        assert result["is_threat"] is True
        assert result["threat_type"] == "prompt_injection"
        assert result["risk_score"] == 85
        assert result["analysis_source"] == "cloud"

    @pytest.mark.asyncio
    @patch("securevector.app.services.cloud_proxy.get_api_key")
    async def test_analyze_no_api_key(self, mock_get_api_key, proxy_service):
        """Test analyze fails when no API key configured."""
        from securevector.app.services.cloud_proxy import CloudProxyError

        mock_get_api_key.return_value = None

        with pytest.raises(CloudProxyError) as exc_info:
            await proxy_service.analyze("test text")

        assert "API key not configured" in str(exc_info.value)

    @pytest.mark.asyncio
    @patch("securevector.app.services.cloud_proxy.get_bearer_token")
    @patch("securevector.app.services.cloud_proxy.httpx.AsyncClient")
    async def test_threat_analytics_success(
        self, mock_client_class, mock_get_bearer_token, proxy_service
    ):
        """Test successful threat analytics request to cloud."""
        mock_get_bearer_token.return_value = "test_bearer_token"

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "is_threat": True,
            "threat_type": "data_exfiltration",
            "risk_score": 90,
            "confidence": 0.95,
        }

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.is_closed = False
        mock_client_class.return_value = mock_client

        result = await proxy_service.threat_analytics("test text")

        assert result["is_threat"] is True
        assert result["threat_type"] == "data_exfiltration"
        assert result["analysis_source"] == "cloud"

    @pytest.mark.asyncio
    @patch("securevector.app.services.cloud_proxy.get_bearer_token")
    async def test_threat_analytics_no_bearer_token(
        self, mock_get_bearer_token, proxy_service
    ):
        """Test threat_analytics fails when no bearer token configured."""
        from securevector.app.services.cloud_proxy import CloudProxyError

        mock_get_bearer_token.return_value = None

        with pytest.raises(CloudProxyError) as exc_info:
            await proxy_service.threat_analytics("test text")

        assert "Bearer token not configured" in str(exc_info.value)

    @pytest.mark.asyncio
    @patch("securevector.app.services.cloud_proxy.get_bearer_token")
    @patch("securevector.app.services.cloud_proxy.httpx.AsyncClient")
    async def test_get_rules_success(
        self, mock_client_class, mock_get_bearer_token, proxy_service
    ):
        """Test successful rules request to cloud."""
        mock_get_bearer_token.return_value = "test_bearer_token"

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "rules": [
                {"id": "rule_001", "name": "Test Rule", "category": "test"},
            ],
            "count": 1,
        }

        mock_client = AsyncMock()
        mock_client.get.return_value = mock_response
        mock_client.is_closed = False
        mock_client_class.return_value = mock_client

        result = await proxy_service.get_rules()

        assert len(result["rules"]) == 1
        assert result["rules"][0]["id"] == "rule_001"
        assert result["source"] == "cloud"

    @pytest.mark.asyncio
    @patch("securevector.app.services.cloud_proxy.httpx.AsyncClient")
    async def test_validate_credentials_success(self, mock_client_class, proxy_service):
        """Test successful credential validation."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "email": "test@example.com",
            "plan": "pro",
        }

        mock_client = AsyncMock()
        mock_client.get.return_value = mock_response
        mock_client.is_closed = False
        mock_client_class.return_value = mock_client

        result = await proxy_service.validate_credentials("test_bearer_token")

        assert result is not None
        assert result["email"] == "test@example.com"

    @pytest.mark.asyncio
    @patch("securevector.app.services.cloud_proxy.httpx.AsyncClient")
    async def test_validate_credentials_invalid(self, mock_client_class, proxy_service):
        """Test credential validation with invalid credentials."""
        mock_response = MagicMock()
        mock_response.status_code = 401

        mock_client = AsyncMock()
        mock_client.get.return_value = mock_response
        mock_client.is_closed = False
        mock_client_class.return_value = mock_client

        result = await proxy_service.validate_credentials("invalid_token")

        assert result is None

    @pytest.mark.asyncio
    @patch("securevector.app.services.cloud_proxy.get_api_key")
    @patch("securevector.app.services.cloud_proxy.httpx.AsyncClient")
    async def test_analyze_timeout(self, mock_client_class, mock_get_api_key, proxy_service):
        """Test analyze handles timeout gracefully."""
        import httpx
        from securevector.app.services.cloud_proxy import CloudProxyError

        mock_get_api_key.return_value = "test_api_key"

        mock_client = AsyncMock()
        mock_client.post.side_effect = httpx.TimeoutException("timeout")
        mock_client.is_closed = False
        mock_client_class.return_value = mock_client

        with pytest.raises(CloudProxyError) as exc_info:
            await proxy_service.analyze("test text")

        assert "timeout" in str(exc_info.value)

    @pytest.mark.asyncio
    @patch("securevector.app.services.cloud_proxy.get_api_key")
    @patch("securevector.app.services.cloud_proxy.httpx.AsyncClient")
    async def test_analyze_connection_error(
        self, mock_client_class, mock_get_api_key, proxy_service
    ):
        """Test analyze handles connection error gracefully."""
        import httpx
        from securevector.app.services.cloud_proxy import CloudProxyError

        mock_get_api_key.return_value = "test_api_key"

        mock_client = AsyncMock()
        mock_client.post.side_effect = httpx.ConnectError("connection failed")
        mock_client.is_closed = False
        mock_client_class.return_value = mock_client

        with pytest.raises(CloudProxyError) as exc_info:
            await proxy_service.analyze("test text")

        assert "connection_error" in str(exc_info.value)


class TestCloudProxySingleton:
    """Tests for the cloud proxy singleton."""

    def test_get_cloud_proxy_returns_instance(self):
        """Test get_cloud_proxy returns a CloudProxyService instance."""
        from securevector.app.services.cloud_proxy import (
            get_cloud_proxy,
            CloudProxyService,
        )

        proxy = get_cloud_proxy()

        assert isinstance(proxy, CloudProxyService)

    def test_get_cloud_proxy_returns_same_instance(self):
        """Test get_cloud_proxy returns the same instance."""
        from securevector.app.services.cloud_proxy import get_cloud_proxy

        proxy1 = get_cloud_proxy()
        proxy2 = get_cloud_proxy()

        assert proxy1 is proxy2
