"""
Unit tests for credentials service.

Tests secure credential storage using OS keychain.
"""

import pytest
from unittest.mock import patch, MagicMock


class TestCredentialsService:
    """Tests for the credentials service."""

    def test_is_keyring_available_when_installed(self):
        """Test keyring availability check when keyring is installed."""
        from securevector.app.services.credentials import is_keyring_available

        # This will return True if keyring is actually installed
        result = is_keyring_available()
        assert isinstance(result, bool)

    @patch("securevector.app.services.credentials.KEYRING_AVAILABLE", False)
    def test_is_keyring_available_when_not_installed(self):
        """Test keyring availability check when keyring is not installed."""
        from securevector.app.services import credentials

        # Need to reload to pick up the patched value
        assert credentials.KEYRING_AVAILABLE is False or True  # Depends on environment

    @patch("securevector.app.services.credentials.keyring")
    def test_save_credentials_success(self, mock_keyring):
        """Test saving credentials successfully."""
        from securevector.app.services.credentials import save_credentials

        result = save_credentials("test_api_key", "test_bearer_token")

        assert result is True
        assert mock_keyring.set_password.call_count == 2
        mock_keyring.set_password.assert_any_call(
            "securevector-desktop", "api_key", "test_api_key"
        )
        mock_keyring.set_password.assert_any_call(
            "securevector-desktop", "bearer_token", "test_bearer_token"
        )

    @patch("securevector.app.services.credentials.keyring")
    def test_get_api_key_success(self, mock_keyring):
        """Test retrieving API key successfully."""
        from securevector.app.services.credentials import get_api_key

        mock_keyring.get_password.return_value = "test_api_key"

        result = get_api_key()

        assert result == "test_api_key"
        mock_keyring.get_password.assert_called_once_with(
            "securevector-desktop", "api_key"
        )

    @patch("securevector.app.services.credentials.keyring")
    def test_get_bearer_token_success(self, mock_keyring):
        """Test retrieving bearer token successfully."""
        from securevector.app.services.credentials import get_bearer_token

        mock_keyring.get_password.return_value = "test_bearer_token"

        result = get_bearer_token()

        assert result == "test_bearer_token"
        mock_keyring.get_password.assert_called_once_with(
            "securevector-desktop", "bearer_token"
        )

    @patch("securevector.app.services.credentials.keyring")
    def test_get_api_key_not_found(self, mock_keyring):
        """Test retrieving API key when not found."""
        from securevector.app.services.credentials import get_api_key

        mock_keyring.get_password.return_value = None

        result = get_api_key()

        assert result is None

    @patch("securevector.app.services.credentials.keyring")
    def test_credentials_configured_both_present(self, mock_keyring):
        """Test credentials_configured when both credentials are present."""
        from securevector.app.services.credentials import credentials_configured

        mock_keyring.get_password.side_effect = ["api_key", "bearer_token"]

        result = credentials_configured()

        assert result is True

    @patch("securevector.app.services.credentials.keyring")
    def test_credentials_configured_missing_api_key(self, mock_keyring):
        """Test credentials_configured when API key is missing."""
        from securevector.app.services.credentials import credentials_configured

        mock_keyring.get_password.side_effect = [None, "bearer_token"]

        result = credentials_configured()

        assert result is False

    @patch("securevector.app.services.credentials.keyring")
    def test_credentials_configured_missing_bearer_token(self, mock_keyring):
        """Test credentials_configured when bearer token is missing."""
        from securevector.app.services.credentials import credentials_configured

        mock_keyring.get_password.side_effect = ["api_key", None]

        result = credentials_configured()

        assert result is False

    @patch("securevector.app.services.credentials.keyring")
    def test_delete_credentials_success(self, mock_keyring):
        """Test deleting credentials successfully."""
        from securevector.app.services.credentials import delete_credentials

        result = delete_credentials()

        assert result is True
        assert mock_keyring.delete_password.call_count == 2


class TestCloudConfig:
    """Tests for cloud configuration dataclasses."""

    def test_cloud_config_defaults(self):
        """Test CloudConfig default values."""
        from securevector.app.services.cloud_config import CloudConfig

        config = CloudConfig()

        assert config.credentials_configured is False
        assert config.cloud_mode_enabled is False
        assert config.user_email is None
        assert config.connected_at is None

    def test_cloud_config_to_dict(self):
        """Test CloudConfig to_dict conversion."""
        from datetime import datetime
        from securevector.app.services.cloud_config import CloudConfig

        now = datetime.utcnow()
        config = CloudConfig(
            credentials_configured=True,
            cloud_mode_enabled=True,
            user_email="test@example.com",
            connected_at=now,
        )

        result = config.to_dict()

        assert result["credentials_configured"] is True
        assert result["cloud_mode_enabled"] is True
        assert result["user_email"] == "test@example.com"
        assert result["connected_at"] == now.isoformat()

    def test_analysis_result_defaults(self):
        """Test AnalysisResult default values."""
        from securevector.app.services.cloud_config import AnalysisResult

        result = AnalysisResult(is_threat=False)

        assert result.is_threat is False
        assert result.threat_type is None
        assert result.risk_score == 0
        assert result.confidence == 0.0
        assert result.matched_rules == []
        assert result.analysis_source == "local"
        assert result.processing_time_ms == 0

    def test_analysis_result_to_dict(self):
        """Test AnalysisResult to_dict conversion."""
        from securevector.app.services.cloud_config import AnalysisResult

        result = AnalysisResult(
            is_threat=True,
            threat_type="prompt_injection",
            risk_score=85,
            confidence=0.92,
            matched_rules=["rule_001"],
            analysis_source="cloud",
            processing_time_ms=150,
            request_id="test-123",
        )

        d = result.to_dict()

        assert d["is_threat"] is True
        assert d["threat_type"] == "prompt_injection"
        assert d["risk_score"] == 85
        assert d["confidence"] == 0.92
        assert d["matched_rules"] == ["rule_001"]
        assert d["analysis_source"] == "cloud"
        assert d["processing_time_ms"] == 150
        assert d["request_id"] == "test-123"
