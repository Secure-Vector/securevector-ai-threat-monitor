"""
Test cases for SecureVector MCP Server

These tests verify the functionality of the SecureVector MCP server implementation,
including tools, resources, prompts, and configuration.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import asyncio
import pytest
import sys
from unittest.mock import Mock, patch
from typing import Dict, Any

# Add src to path for testing
sys.path.insert(0, 'src')

try:
    from securevector.mcp import (
        SecureVectorMCPServer,
        create_mcp_server,
        check_mcp_dependencies,
        MCP_AVAILABLE
    )
    from securevector.mcp.config.server_config import (
        create_default_config,
        create_development_config
    )
    SECUREVECTOR_MCP_AVAILABLE = True
except ImportError:
    SECUREVECTOR_MCP_AVAILABLE = False


@pytest.mark.skipif(not SECUREVECTOR_MCP_AVAILABLE, reason="MCP dependencies not available")
class TestMCPServer:
    """Test cases for SecureVector MCP Server."""

    @pytest.fixture
    def test_server(self):
        """Create a test MCP server instance."""
        config = create_development_config()
        server = SecureVectorMCPServer(config=config)
        return server

    def test_mcp_dependencies_check(self):
        """Test MCP dependencies availability check."""
        # This should return True if we're running these tests
        assert check_mcp_dependencies() == SECUREVECTOR_MCP_AVAILABLE

    def test_server_creation(self):
        """Test basic server creation."""
        config = create_development_config()
        server = SecureVectorMCPServer(config=config)

        assert server is not None
        assert server.config.name == "SecureVector AI Threat Monitor"
        assert server.config.version == "1.0.0"

    def test_server_configuration(self, test_server):
        """Test server configuration."""
        config = test_server.config

        # Check development mode settings
        assert config.security.require_authentication == False
        assert config.security.requests_per_minute == 1000
        assert config.performance.enable_caching == False

        # Check enabled components
        assert "analyze_prompt" in config.enabled_tools
        assert "batch_analyze" in config.enabled_tools
        assert "get_threat_statistics" in config.enabled_tools

    def test_server_info(self, test_server):
        """Test server information retrieval."""
        info = test_server.get_server_info()

        assert "name" in info
        assert "version" in info
        assert "config" in info
        assert "stats" in info
        assert info["status"] == "running"

    @pytest.mark.asyncio
    async def test_request_validation(self, test_server):
        """Test request validation functionality."""
        # Valid request should pass
        result = await test_server.validate_request(
            "test_client", "analyze_prompt", {"prompt": "Hello world"}
        )
        assert result == True

        # Request with too long prompt should fail
        with pytest.raises(Exception):
            await test_server.validate_request(
                "test_client", "analyze_prompt",
                {"prompt": "x" * (test_server.config.security.max_prompt_length + 1)}
            )

    def test_rate_limiter(self, test_server):
        """Test rate limiting functionality."""
        rate_limiter = test_server.rate_limiter

        # First request should be allowed
        assert rate_limiter.is_allowed("test_client") == True

        # Requests within limit should be allowed (9 more = 10 total within burst_size)
        for _ in range(9):
            assert rate_limiter.is_allowed("test_client") == True

    def test_audit_logger(self, test_server):
        """Test audit logging functionality."""
        audit_logger = test_server.audit_logger

        # Should not raise errors
        audit_logger.log_request("test_client", "analyze_prompt", {"prompt": "test"})
        audit_logger.log_response("test_client", "analyze_prompt", True, 0.1)

    def test_stats_tracking(self, test_server):
        """Test statistics tracking."""
        initial_requests = test_server.request_stats["total_requests"]

        # Update stats
        test_server.update_stats(True, 0.1)

        assert test_server.request_stats["total_requests"] == initial_requests + 1
        assert test_server.request_stats["successful_requests"] == 1

        # Update with failure
        test_server.update_stats(False, 0.2)

        assert test_server.request_stats["total_requests"] == initial_requests + 2
        assert test_server.request_stats["failed_requests"] == 1


@pytest.mark.skipif(not SECUREVECTOR_MCP_AVAILABLE, reason="MCP dependencies not available")
class TestMCPTools:
    """Test cases for MCP tools."""

    @pytest.fixture
    def test_server(self):
        """Create a test server for tools testing."""
        config = create_development_config()
        return SecureVectorMCPServer(config=config)

    @pytest.mark.asyncio
    async def test_analyze_prompt_tool(self, test_server):
        """Test the analyze_prompt tool."""
        from securevector.mcp.tools.analyze_prompt import AnalyzePromptTool

        tool = AnalyzePromptTool(test_server)
        result = await tool.analyze("Hello world")

        assert "analysis_successful" in result
        assert "is_threat" in result
        assert "risk_score" in result

    @pytest.mark.asyncio
    async def test_batch_analysis_tool(self, test_server):
        """Test the batch_analyze tool."""
        from securevector.mcp.tools.batch_analysis import BatchAnalysisTool

        tool = BatchAnalysisTool(test_server)
        prompts = ["Hello world", "What is AI?", "How are you?"]

        result = await tool.analyze_batch(prompts)

        assert "total_prompts" in result
        assert "results" in result
        assert len(result["results"]) == len(prompts)

    def test_threat_statistics_tool(self, test_server):
        """Test the threat statistics tool."""
        from securevector.mcp.tools.threat_stats import ThreatStatisticsTool

        tool = ThreatStatisticsTool(test_server)
        stats = tool.get_basic_stats()

        assert "total_requests" in stats
        assert "server_info" in stats


@pytest.mark.skipif(not SECUREVECTOR_MCP_AVAILABLE, reason="MCP dependencies not available")
class TestMCPResources:
    """Test cases for MCP resources."""

    @pytest.fixture
    def test_server(self):
        """Create a test server for resources testing."""
        config = create_development_config()
        return SecureVectorMCPServer(config=config)

    @pytest.mark.asyncio
    async def test_rules_resource(self, test_server):
        """Test the rules resource."""
        from securevector.mcp.resources.rules import RulesResource

        resource = RulesResource(test_server)
        rules = await resource.get_category_rules("prompt_injection")

        assert "rules" in rules
        assert isinstance(rules["rules"], list)

    @pytest.mark.asyncio
    async def test_rules_summary(self, test_server):
        """Test rules summary generation."""
        from securevector.mcp.resources.rules import RulesResource

        resource = RulesResource(test_server)
        summary = await resource.get_rules_summary()

        assert "rules_index" in summary

    def test_policies_resource(self, test_server):
        """Test the policies resource."""
        from securevector.mcp.resources.policies import PoliciesResource

        resource = PoliciesResource(test_server)

        # Test template retrieval
        template = resource.get_template("balanced")
        assert "policy" in template

        # Test configuration retrieval
        config = resource.get_config("threat_actions")
        assert isinstance(config, dict)

        # Test available templates
        templates = resource.list_templates()
        assert "balanced" in templates
        assert "strict" in templates


@pytest.mark.skipif(not SECUREVECTOR_MCP_AVAILABLE, reason="MCP dependencies not available")
class TestMCPPrompts:
    """Test cases for MCP prompt templates."""

    @pytest.fixture
    def test_server(self):
        """Create a test server for prompts testing."""
        config = create_development_config()
        return SecureVectorMCPServer(config=config)

    def test_threat_analysis_template(self, test_server):
        """Test threat analysis template generation."""
        from securevector.mcp.prompts.templates import ThreatAnalysisTemplate

        template = ThreatAnalysisTemplate(test_server)
        workflow = template.generate_workflow("enterprise", "comprehensive")

        assert "AI Threat Analysis Workflow" in workflow
        assert "Phase 1" in workflow
        assert "enterprise" in workflow.lower()

    def test_security_audit_template(self, test_server):
        """Test security audit template generation."""
        from securevector.mcp.prompts.templates import SecurityAuditTemplate

        template = SecurityAuditTemplate(test_server)
        checklist = template.generate_checklist("full", "soc2")

        assert "Security Audit Checklist" in checklist
        assert "SOC 2" in checklist

    def test_risk_assessment_template(self, test_server):
        """Test risk assessment template generation."""
        from securevector.mcp.prompts.templates import RiskAssessmentTemplate

        template = RiskAssessmentTemplate(test_server)
        guide = template.generate_guide("detailed", "low")

        assert "Risk Assessment Guide" in guide
        assert "Risk Identification" in guide


@pytest.mark.skipif(not SECUREVECTOR_MCP_AVAILABLE, reason="MCP dependencies not available")
class TestMCPConfiguration:
    """Test cases for MCP configuration."""

    def test_default_config_creation(self):
        """Test default configuration creation."""
        config = create_default_config()

        assert config.name == "SecureVector AI Threat Monitor"
        assert config.version == "1.0.0"
        assert config.transport == "stdio"

    def test_development_config_creation(self):
        """Test development configuration creation."""
        config = create_development_config()

        assert config.security.require_authentication == False
        assert config.security.requests_per_minute == 1000
        assert config.performance.enable_caching == False

    def test_config_validation(self):
        """Test configuration validation."""
        config = create_default_config()

        # Valid config should not raise
        config._validate_config()

        # Invalid port should raise
        config.port = -1
        with pytest.raises(ValueError):
            config._validate_config()

    def test_config_environment_setup(self):
        """Test environment variable configuration."""
        import os

        # Set test environment variable
        os.environ["SECUREVECTOR_MCP_HOST"] = "test-host"

        config = create_default_config()
        config._setup_from_environment()

        assert config.host == "test-host"

        # Clean up
        del os.environ["SECUREVECTOR_MCP_HOST"]

    def test_config_to_dict(self):
        """Test configuration serialization."""
        config = create_default_config()
        config_dict = config.to_dict()

        assert "name" in config_dict
        assert "version" in config_dict
        assert "security" in config_dict
        assert "performance" in config_dict


@pytest.mark.skipif(not SECUREVECTOR_MCP_AVAILABLE, reason="MCP dependencies not available")
class TestMCPIntegration:
    """Integration tests for MCP server."""

    def test_create_mcp_server_function(self):
        """Test the create_mcp_server convenience function."""
        server = create_mcp_server(name="Test Server")

        assert server is not None
        assert server.config.name == "Test Server"

    def test_mcp_server_with_api_key(self):
        """Test MCP server creation with API key."""
        server = create_mcp_server(api_key="test-key")

        assert server is not None
        # Note: In development mode, API key might not be strictly required

    @pytest.mark.asyncio
    async def test_server_lifecycle(self):
        """Test basic server lifecycle operations."""
        config = create_development_config()
        server = SecureVectorMCPServer(config=config)

        # Server should be created without error
        assert server is not None

        # Should be able to get server info
        info = server.get_server_info()
        assert info["status"] == "running"

        # Should be able to shutdown
        await server.shutdown()


# Test runner for when executed directly
if __name__ == "__main__":
    # Check if MCP is available
    if not SECUREVECTOR_MCP_AVAILABLE:
        print("❌ SecureVector MCP dependencies not available")
        print("Install with: pip install securevector-ai-monitor[mcp]")
        sys.exit(1)

    # Run tests
    pytest.main([__file__, "-v"])