"""
MCP Tool: Analyze Prompt

This module provides the analyze_prompt MCP tool for SecureVector AI Threat Monitor,
enabling LLMs to analyze individual prompts for security threats through MCP.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import time
from typing import Any, Dict, Optional, Union

try:
    from mcp.server.fastmcp import FastMCP
    from mcp.server.session import ServerSession
    from mcp import types
    MCP_AVAILABLE = True
except ImportError:
    MCP_AVAILABLE = False

from securevector.utils.logger import get_logger
from securevector.utils.exceptions import SecurityException, APIError


logger = get_logger(__name__)


def setup_analyze_prompt_tool(mcp: "FastMCP", server: "SecureVectorMCPServer"):
    """Setup the analyze_prompt MCP tool."""

    @mcp.tool()
    async def analyze_prompt(
        prompt: str,
        mode: str = "auto",
        include_details: bool = False,
        include_confidence: bool = True,
        timeout: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Analyze a prompt for AI security threats and vulnerabilities.

        This tool uses SecureVector's AI threat detection engine to analyze text prompts
        for various security threats including prompt injection, data exfiltration attempts,
        jailbreak attempts, and other malicious patterns.

        Args:
            prompt: The text prompt to analyze for threats
            mode: Analysis mode - "auto", "local", "api", or "hybrid" (default: "auto")
            include_details: Include detailed threat analysis information (default: False)
            include_confidence: Include confidence scores in results (default: True)
            timeout: Request timeout in seconds (optional)

        Returns:
            Dict containing:
            - is_threat: Boolean indicating if threats were detected
            - risk_score: Numerical risk score (0-100)
            - threat_types: List of detected threat categories
            - action_recommended: Recommended action (allow/warn/block)
            - analysis_time_ms: Time taken for analysis
            - detection_methods: Methods used for detection (if include_details=True)
            - confidence_score: Confidence in the analysis (if include_confidence=True)
            - threat_descriptions: Detailed threat descriptions (if include_details=True)

        Example:
            {
                "is_threat": true,
                "risk_score": 85,
                "threat_types": ["prompt_injection", "system_override"],
                "action_recommended": "block",
                "analysis_time_ms": 45,
                "confidence_score": 0.92,
                "detection_methods": ["pattern_matching", "ml_classification"],
                "threat_descriptions": {
                    "prompt_injection": "Detected attempt to override system instructions"
                }
            }

        Raises:
            SecurityException: If the request is invalid or unauthorized
            APIError: If the analysis fails due to service issues
        """
        start_time = time.time()
        client_id = "mcp_client"  # In a real implementation, this would be extracted from context

        try:
            # Validate request
            await server.validate_request(client_id, "analyze_prompt", {
                "prompt": prompt,
                "mode": mode,
                "include_details": include_details
            })

            # Log the request
            server.audit_logger.log_request(client_id, "analyze_prompt", {
                "prompt_length": len(prompt),
                "mode": mode,
                "include_details": include_details
            })

            # Set timeout
            analysis_timeout = timeout or server.config.performance.analysis_timeout_seconds

            # Perform analysis using SecureVector client
            try:
                if hasattr(server.async_client, 'analyze'):
                    # Use async client if available
                    result = await server.async_client.analyze(prompt, mode=mode)
                else:
                    # Fall back to sync client
                    result = server.sync_client.analyze(prompt, mode=mode)

            except SecurityException as e:
                # This is expected for threats - convert to successful response
                result = e.to_analysis_result()

            except Exception as e:
                # Unexpected analysis error
                error_msg = f"Analysis failed: {str(e)}"
                logger.error(error_msg)
                raise APIError(error_msg, error_code="ANALYSIS_FAILED")

            # Build response
            response = {
                "is_threat": result.is_threat,
                "risk_score": result.risk_score,
                "threat_types": [threat.value for threat in result.threat_types],
                "action_recommended": result.policy_action.value if hasattr(result, 'policy_action') else "allow",
                "analysis_time_ms": round((time.time() - start_time) * 1000, 2),
            }

            # Add optional fields
            if include_confidence and hasattr(result, 'confidence'):
                response["confidence_score"] = result.confidence

            if include_details:
                response["detection_methods"] = [
                    method.value for method in getattr(result, 'detection_methods', [])
                ]

                if hasattr(result, 'detections') and result.detections:
                    response["threat_descriptions"] = {
                        detection.threat_type.value: detection.description
                        for detection in result.detections
                    }

                if hasattr(result, 'metadata'):
                    response["metadata"] = result.metadata

            # Update server statistics
            response_time = time.time() - start_time
            server.update_stats(success=True, response_time=response_time)

            # Log successful response
            server.audit_logger.log_response(
                client_id, "analyze_prompt", True, response_time
            )

            return response

        except (SecurityException, APIError) as e:
            # Handle known errors
            response_time = time.time() - start_time
            server.update_stats(success=False, response_time=response_time)
            server.audit_logger.log_response(
                client_id, "analyze_prompt", False, response_time, str(e)
            )
            raise

        except Exception as e:
            # Handle unexpected errors
            error_msg = f"Unexpected error in analyze_prompt: {str(e)}"
            logger.error(error_msg)
            response_time = time.time() - start_time
            server.update_stats(success=False, response_time=response_time)
            server.audit_logger.log_response(
                client_id, "analyze_prompt", False, response_time, error_msg
            )
            raise APIError(error_msg, error_code="INTERNAL_ERROR")


class AnalyzePromptTool:
    """
    Standalone class for the analyze_prompt tool.
    Useful for testing and direct integration.
    """

    def __init__(self, server: "SecureVectorMCPServer"):
        self.server = server
        self.logger = get_logger(__name__)

    async def analyze(
        self,
        prompt: str,
        mode: str = "auto",
        include_details: bool = False,
        include_confidence: bool = True,
        timeout: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Analyze a prompt for threats (direct method).

        Args:
            prompt: Text to analyze
            mode: Analysis mode
            include_details: Include detailed information
            include_confidence: Include confidence scores
            timeout: Request timeout

        Returns:
            Analysis result dictionary
        """
        # This would call the same logic as the MCP tool
        # For now, delegate to the server's sync client
        try:
            result = self.server.sync_client.analyze(prompt, mode=mode)

            return {
                "is_threat": result.is_threat,
                "risk_score": result.risk_score,
                "threat_types": [threat.value for threat in result.threat_types],
                "analysis_successful": True,
            }

        except SecurityException as e:
            # Convert security exception to result
            return {
                "is_threat": True,
                "risk_score": getattr(e, 'risk_score', 100),
                "threat_types": getattr(e, 'threat_types', ['unknown']),
                "analysis_successful": True,
                "blocked_reason": str(e),
            }

        except Exception as e:
            self.logger.error(f"Analysis failed: {e}")
            return {
                "is_threat": False,
                "risk_score": 0,
                "threat_types": [],
                "analysis_successful": False,
                "error": str(e),
            }