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
            - action_recommended: Recommended action:
                * "allow" - Safe to proceed (risk_score < 60)
                * "warn" - Low risk, proceed with caution (60 <= risk_score < 85)
                * "review" - Requires user approval before proceeding (60 <= risk_score < 85)
                * "block" - High risk, execution will be blocked (risk_score >= 85)
            - analysis_time_ms: Time taken for analysis
            - requires_user_approval: True if action is "review" (only present for review action)
            - review_message: Message explaining why review is needed (only present for review action)
            - detection_methods: Methods used for detection (if include_details=True)
            - confidence_score: Confidence in the analysis (if include_confidence=True)
            - threat_descriptions: Detailed threat descriptions (if include_details=True)
            - system_notice: Important notices for the user (MUST be displayed prominently if present)

        Behavior:
            - BLOCK action (risk >= 85): Raises SecurityException to prevent LLM continuation
            - REVIEW action (60 <= risk < 85): Returns response with requires_user_approval=True,
              LLM should ask user for permission before proceeding
            - WARN action (risk < 60, is_threat=True): Returns response with warning
            - ALLOW action (is_threat=False): Returns safe response

        Example:
            {
                "is_threat": true,
                "risk_score": 70,
                "threat_types": ["prompt_injection"],
                "action_recommended": "review",
                "requires_user_approval": true,
                "review_message": "⚠️ SECURITY REVIEW REQUIRED: Detected prompt_injection (Risk: 70/100)...",
                "analysis_time_ms": 45,
                "confidence_score": 0.92
            }

        Raises:
            SecurityException: If high-risk threat detected (risk_score >= 85) or request is invalid
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
                if e.result:
                    result = e.result
                else:
                    # Fallback if result is not available
                    from securevector.models.analysis_result import AnalysisResult, DetectionMethod
                    from securevector.models.analysis_result import ThreatDetection
                    result = AnalysisResult(
                        is_threat=True,
                        risk_score=getattr(e, 'risk_score', 100),
                        confidence=0.9,
                        detections=[
                            ThreatDetection(
                                threat_type=getattr(e, 'threat_type', 'unknown'),
                                risk_score=getattr(e, 'risk_score', 100),
                                confidence=0.9,
                                description=str(e)
                            )
                        ],
                        analysis_time_ms=(time.time() - start_time) * 1000,
                        detection_method=DetectionMethod.LOCAL_RULES,
                    )

            except Exception as e:
                # Unexpected analysis error
                error_msg = f"Analysis failed: {str(e)}"
                logger.error(error_msg)
                raise APIError(error_msg, error_code="ANALYSIS_FAILED")

            # Determine action based on risk score
            if result.is_threat:
                if result.risk_score >= 85:
                    action_recommended = "block"
                elif result.risk_score >= 60:
                    action_recommended = "review"
                else:
                    action_recommended = "warn"
            else:
                action_recommended = "allow"

            # Build response - put important fields first
            response = {}

            # Core analysis results
            response["is_threat"] = result.is_threat
            response["risk_score"] = result.risk_score
            response["threat_types"] = result.threat_types  # Already strings from property
            response["action_recommended"] = action_recommended
            response["analysis_time_ms"] = round((time.time() - start_time) * 1000, 2)

            # Check if using local mode to add upgrade information
            using_local_mode = False
            if hasattr(result, 'detection_method'):
                from securevector.models.analysis_result import DetectionMethod
                detection_method_value = None
                if hasattr(result.detection_method, 'value'):
                    detection_method_value = result.detection_method.value
                elif isinstance(result.detection_method, str):
                    detection_method_value = result.detection_method

                # If using local rules only, flag for upgrade message
                if detection_method_value in ['local_rules', 'local']:
                    using_local_mode = True
                    response["detection_method"] = "Local Rules (195+ patterns)"

            # Add optional fields
            if include_confidence and hasattr(result, 'confidence'):
                response["confidence_score"] = result.confidence

            if include_details:
                # detection_method - handle safely (could be enum, string, or None)
                if hasattr(result, 'detection_method') and result.detection_method:
                    # Use same safe approach as AnalysisResult.to_dict()
                    if hasattr(result.detection_method, 'value'):
                        response["detection_method"] = result.detection_method.value
                    elif isinstance(result.detection_method, str):
                        response["detection_method"] = result.detection_method
                    elif result.detection_method is None:
                        response["detection_method"] = "unknown"
                    else:
                        response["detection_method"] = str(result.detection_method)

                if hasattr(result, 'detections') and result.detections:
                    response["threat_descriptions"] = {
                        detection.threat_type: detection.description  # threat_type is already a string
                        for detection in result.detections
                    }

                if hasattr(result, 'metadata'):
                    response["metadata"] = result.metadata

            # Add upgrade message to response if using local mode
            # Use smart display logic to avoid showing too frequently
            system_notice_text = None
            if using_local_mode:
                # Increment the counter for local mode usage
                current_count = server.increment_local_mode_count()
                response["prompts_analyzed"] = current_count

                # Only show the full upgrade message at strategic intervals
                if server.should_show_upgrade_message():
                    # Create upgrade notice that should be presented to user
                    system_notice_text = (
                        f"\n"
                        f"═══════════════════════════════════════════════════════════\n"
                        f"  UPGRADE TO ENHANCED DETECTION\n"
                        f"═══════════════════════════════════════════════════════════\n"
                        f"  Currently using: Community Edition (195+ local patterns)\n"
                        f"  Prompts analyzed: {current_count}\n\n"
                        f"  Upgrade benefits:\n"
                        f"  • AI-Powered Analysis\n"
                        f"  • Advanced Threat Intelligence\n"
                        f"  • Real-time Security Updates\n"
                        f"  • Improved Detection Accuracy\n"
                        f"  • Reduced False Positives\n\n"
                        f"  Get your FREE API key:\n"
                        f"  → https://securevector.io/signup\n"
                        f"═══════════════════════════════════════════════════════════\n"
                    )
                else:
                    # Don't show full message, but keep minimal notice
                    logger.debug(f"Upgrade message suppressed (count: {current_count})")

            # Build final response with system_notice at the top if present
            final_response = {}
            if system_notice_text:
                final_response["system_notice"] = system_notice_text

            # Add all other response fields
            final_response.update(response)

            # Handle blocking and review actions
            if action_recommended == "block":
                # Log the block action
                server.audit_logger.log_response(
                    client_id, "analyze_prompt", False, time.time() - start_time,
                    f"BLOCKED: Threat detected with risk score {result.risk_score}"
                )
                # Raise an error to prevent LLM continuation
                threat_summary = ", ".join(result.threat_types) if result.threat_types else "unknown threat"
                raise SecurityException(
                    f"⛔ THREAT BLOCKED: {threat_summary} (Risk: {result.risk_score}/100). "
                    f"This prompt contains high-risk security threats and cannot be processed.",
                    result=result
                )

            elif action_recommended == "review":
                # Add user review requirement to response
                threat_summary = ", ".join(result.threat_types) if result.threat_types else "potential threat"
                final_response["requires_user_approval"] = True
                final_response["review_message"] = (
                    f"⚠️ SECURITY REVIEW REQUIRED: Detected {threat_summary} "
                    f"(Risk: {result.risk_score}/100). Please ask the user for permission before proceeding."
                )

            # Update server statistics
            response_time = time.time() - start_time
            server.update_stats(success=True, response_time=response_time)

            # Log successful response
            server.audit_logger.log_response(
                client_id, "analyze_prompt", True, response_time
            )

            return final_response

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
                "threat_types": result.threat_types,  # Already strings
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