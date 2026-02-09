"""
Unit tests for credentials service.

Tests secure credential storage using file-based storage.
"""

import json
import os
import pytest
from unittest.mock import patch, MagicMock
from pathlib import Path


class TestCredentialsService:
    """Tests for the credentials service."""

    @patch("securevector.app.services.credentials._get_credentials_file")
    def test_save_credentials_success(self, mock_get_file, tmp_path):
        """Test saving credentials successfully."""
        from securevector.app.services.credentials import save_credentials

        creds_file = tmp_path / ".credentials"
        mock_get_file.return_value = creds_file

        result = save_credentials("test_api_key")

        assert result is True
        assert creds_file.exists()
        data = json.loads(creds_file.read_text())
        assert data["api_key"] == "test_api_key"
        assert data["v"] == 1
        # Check file permissions (owner read/write only)
        assert oct(creds_file.stat().st_mode & 0o777) == "0o600"

    @patch("securevector.app.services.credentials._get_credentials_file")
    def test_get_api_key_success(self, mock_get_file, tmp_path):
        """Test retrieving API key successfully."""
        from securevector.app.services.credentials import get_api_key

        creds_file = tmp_path / ".credentials"
        creds_file.write_text(json.dumps({"api_key": "test_api_key", "v": 1}))
        mock_get_file.return_value = creds_file

        result = get_api_key()

        assert result == "test_api_key"

    @patch("securevector.app.services.credentials._get_credentials_file")
    def test_get_api_key_not_found(self, mock_get_file, tmp_path):
        """Test retrieving API key when file doesn't exist."""
        from securevector.app.services.credentials import get_api_key

        creds_file = tmp_path / ".credentials"
        mock_get_file.return_value = creds_file

        result = get_api_key()

        assert result is None

    @patch("securevector.app.services.credentials._get_credentials_file")
    def test_get_bearer_token_returns_api_key(self, mock_get_file, tmp_path):
        """Test that get_bearer_token returns the API key."""
        from securevector.app.services.credentials import get_bearer_token

        creds_file = tmp_path / ".credentials"
        creds_file.write_text(json.dumps({"api_key": "test_key", "v": 1}))
        mock_get_file.return_value = creds_file

        result = get_bearer_token()

        assert result == "test_key"

    @patch("securevector.app.services.credentials._get_credentials_file")
    def test_credentials_configured_true(self, mock_get_file, tmp_path):
        """Test credentials_configured when key is present."""
        from securevector.app.services.credentials import credentials_configured

        creds_file = tmp_path / ".credentials"
        creds_file.write_text(json.dumps({"api_key": "test_key", "v": 1}))
        mock_get_file.return_value = creds_file

        assert credentials_configured() is True

    @patch("securevector.app.services.credentials._get_credentials_file")
    def test_credentials_configured_false(self, mock_get_file, tmp_path):
        """Test credentials_configured when no file exists."""
        from securevector.app.services.credentials import credentials_configured

        creds_file = tmp_path / ".credentials"
        mock_get_file.return_value = creds_file

        assert credentials_configured() is False

    @patch("securevector.app.services.credentials._get_credentials_file")
    def test_delete_credentials_success(self, mock_get_file, tmp_path):
        """Test deleting credentials successfully."""
        from securevector.app.services.credentials import delete_credentials

        creds_file = tmp_path / ".credentials"
        creds_file.write_text(json.dumps({"api_key": "test_key", "v": 1}))
        mock_get_file.return_value = creds_file

        result = delete_credentials()

        assert result is True
        assert not creds_file.exists()

    @patch("securevector.app.services.credentials._get_credentials_file")
    def test_delete_credentials_no_file(self, mock_get_file, tmp_path):
        """Test deleting credentials when file doesn't exist."""
        from securevector.app.services.credentials import delete_credentials

        creds_file = tmp_path / ".credentials"
        mock_get_file.return_value = creds_file

        result = delete_credentials()

        assert result is True


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
