"""
Unit tests for SecureVector AI Threat Monitor Client
"""
import pytest
import os
from unittest.mock import patch, MagicMock

from ai_threat_monitor import SecureVectorClient
from ai_threat_monitor.models.config_models import OperationMode
from ai_threat_monitor.models.analysis_result import AnalysisResult


class TestSecureVectorClient:
    """Test cases for SecureVectorClient"""
    
    def test_client_initialization_local_mode(self):
        """Test client initialization in local mode"""
        client = SecureVectorClient(mode=OperationMode.LOCAL)
        assert client is not None
        assert client.config.mode == OperationMode.LOCAL
    
    def test_client_initialization_hybrid_mode(self, mock_api_key):
        """Test client initialization in hybrid mode"""
        client = SecureVectorClient(
            mode=OperationMode.HYBRID,
            api_key=mock_api_key
        )
        assert client is not None
        assert client.config.mode == OperationMode.HYBRID
    
    def test_client_initialization_api_mode(self, mock_api_key):
        """Test client initialization in API mode"""
        client = SecureVectorClient(
            mode=OperationMode.API,
            api_key=mock_api_key
        )
        assert client is not None
        assert client.config.mode == OperationMode.API
    
    def test_client_initialization_without_api_key_fails(self):
        """Test that API mode fails without API key"""
        with pytest.raises(ValueError):
            SecureVectorClient(mode=OperationMode.API)
    
    @patch('ai_threat_monitor.client.SecureVectorClient.analyze')
    def test_analyze_safe_prompt(self, mock_analyze, sample_prompts):
        """Test analysis of safe prompts"""
        # Mock the analyze method to return a safe result
        mock_result = AnalysisResult(
            is_threat=False,
            risk_score=0.1,
            threat_types=[],
            confidence=0.95,
            analysis_time_ms=15.0
        )
        mock_analyze.return_value = mock_result
        
        client = SecureVectorClient(mode=OperationMode.LOCAL)
        
        for prompt in sample_prompts['safe']:
            result = client.analyze(prompt)
            assert result.is_threat is False
            assert result.risk_score < 0.5
            assert result.confidence > 0.8
    
    @patch('ai_threat_monitor.client.SecureVectorClient.analyze')
    def test_analyze_threat_prompt(self, mock_analyze, sample_prompts):
        """Test analysis of threat prompts"""
        # Mock the analyze method to return a threat result
        mock_result = AnalysisResult(
            is_threat=True,
            risk_score=0.9,
            threat_types=['prompt_injection'],
            confidence=0.95,
            analysis_time_ms=20.0
        )
        mock_analyze.return_value = mock_result
        
        client = SecureVectorClient(mode=OperationMode.LOCAL)
        
        for prompt in sample_prompts['threats']:
            result = client.analyze(prompt)
            assert result.is_threat is True
            assert result.risk_score > 0.7
            assert len(result.threat_types) > 0
    
    def test_analyze_empty_prompt(self):
        """Test analysis of empty prompt"""
        client = SecureVectorClient(mode=OperationMode.LOCAL)
        
        with pytest.raises(ValueError):
            client.analyze("")
    
    def test_analyze_none_prompt(self):
        """Test analysis of None prompt"""
        client = SecureVectorClient(mode=OperationMode.LOCAL)
        
        with pytest.raises(ValueError):
            client.analyze(None)
    
    @patch('ai_threat_monitor.client.SecureVectorClient.analyze_batch')
    def test_analyze_batch(self, mock_analyze_batch, sample_prompts):
        """Test batch analysis"""
        # Mock batch analysis results
        mock_results = [
            AnalysisResult(
                is_threat=False,
                risk_score=0.1,
                threat_types=[],
                confidence=0.95,
                analysis_time_ms=15.0
            ) for _ in sample_prompts['safe']
        ]
        mock_analyze_batch.return_value = mock_results
        
        client = SecureVectorClient(mode=OperationMode.LOCAL)
        results = client.analyze_batch(sample_prompts['safe'])
        
        assert len(results) == len(sample_prompts['safe'])
        for result in results:
            assert isinstance(result, AnalysisResult)
    
    def test_analyze_batch_empty_list(self):
        """Test batch analysis with empty list"""
        client = SecureVectorClient(mode=OperationMode.LOCAL)
        
        results = client.analyze_batch([])
        assert results == []
    
    def test_client_context_manager(self):
        """Test client as context manager"""
        with SecureVectorClient(mode=OperationMode.LOCAL) as client:
            assert client is not None
    
    def test_client_configuration_validation(self, client_config):
        """Test client configuration validation"""
        client = SecureVectorClient(
            mode=OperationMode.LOCAL,
            **client_config
        )
        assert client is not None
        # Add more specific configuration tests here

