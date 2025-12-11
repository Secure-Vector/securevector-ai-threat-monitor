"""
MCP Tool: Batch Analysis

This module provides the batch_analyze MCP tool for SecureVector AI Threat Monitor,
enabling efficient analysis of multiple prompts simultaneously through MCP.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import asyncio
import time
from typing import Any, Dict, List, Optional, Union, TYPE_CHECKING

try:
    from mcp.server.fastmcp import FastMCP, Context
    from mcp.server.session import ServerSession
    from mcp import types
    MCP_AVAILABLE = True
except ImportError:
    MCP_AVAILABLE = False
    Context = None  # type: ignore

from securevector.utils.logger import get_logger
from securevector.utils.exceptions import SecurityException, APIError

if TYPE_CHECKING:
    from securevector.mcp.server import SecureVectorMCPServer


logger = get_logger(__name__)


def setup_batch_analysis_tool(mcp: "FastMCP", server: "SecureVectorMCPServer"):
    """Setup the batch_analyze MCP tool."""

    @mcp.tool()
    async def batch_analyze(
        prompts: List[str],
        mode: str = "auto",
        batch_size: Optional[int] = None,
        include_summary: bool = True,
        include_details: bool = False,
        parallel_processing: bool = True,
        timeout: Optional[int] = None,
        ctx: Optional[Context] = None  # Optional context for SSE/HTTP mode
    ) -> Dict[str, Any]:
        """
        Analyze multiple prompts for AI security threats in batch.

        This tool efficiently processes multiple prompts using SecureVector's threat
        detection engine, with options for parallel processing and result aggregation.

        Args:
            prompts: List of text prompts to analyze
            mode: Analysis mode - "auto", "local", "api", or "hybrid" (default: "auto")
            batch_size: Maximum number of prompts to process at once (optional)
            include_summary: Include aggregated summary statistics (default: True)
            include_details: Include detailed analysis for each prompt (default: False)
            parallel_processing: Process prompts in parallel when possible (default: True)
            timeout: Request timeout in seconds (optional)

        Returns:
            Dict containing:
            - total_prompts: Total number of prompts analyzed
            - results: List of individual analysis results
            - summary: Aggregated statistics (if include_summary=True)
            - processing_time_ms: Total processing time
            - batch_id: Unique identifier for this batch

        Summary includes:
            - threat_count: Number of prompts identified as threats
            - safe_count: Number of prompts identified as safe
            - average_risk_score: Average risk score across all prompts
            - threat_type_distribution: Count of each threat type detected
            - highest_risk_prompt: Index of prompt with highest risk score

        Example:
            {
                "total_prompts": 10,
                "results": [
                    {
                        "index": 0,
                        "is_threat": false,
                        "risk_score": 15,
                        "threat_types": []
                    },
                    ...
                ],
                "summary": {
                    "threat_count": 3,
                    "safe_count": 7,
                    "average_risk_score": 32.5,
                    "threat_type_distribution": {
                        "prompt_injection": 2,
                        "data_exfiltration": 1
                    },
                    "highest_risk_prompt": 5
                },
                "processing_time_ms": 234,
                "batch_id": "batch_1703123456"
            }

        Raises:
            SecurityException: If the request is invalid or unauthorized
            APIError: If batch processing fails due to service issues
        """
        start_time = time.time()
        batch_id = f"batch_{int(time.time())}"

        # Extract client identifier from context (for multi-tenant support)
        # Priority: 1) session_id from query params, 2) client IP
        client_id = "mcp_client"  # Default for stdio mode
        client_ip = None
        session_id = None

        if ctx is not None:
            # Extract client info from request context (SSE/HTTP mode)
            try:
                if hasattr(ctx, 'request_context') and ctx.request_context:
                    request_ctx = ctx.request_context

                    # Try to extract session_id from query parameters first (most unique)
                    if hasattr(request_ctx, 'scope'):
                        scope = request_ctx.scope
                        query_string = scope.get("query_string", b"").decode("utf-8")
                        if query_string and "session_id=" in query_string:
                            from urllib.parse import parse_qs
                            params = parse_qs(query_string)
                            if "session_id" in params and params["session_id"]:
                                session_id = params["session_id"][0]
                                client_id = session_id
                                logger.debug(f"Extracted session_id from query: {session_id}")

                    # Fallback to client IP if no session_id
                    if not session_id:
                        if hasattr(request_ctx, 'client') and request_ctx.client:
                            client_ip = request_ctx.client[0] if isinstance(request_ctx.client, (tuple, list)) else str(request_ctx.client)
                            client_id = client_ip
                            logger.debug(f"Extracted client IP from context: {client_ip}")
                        elif hasattr(request_ctx, 'scope'):
                            scope = request_ctx.scope
                            client_tuple = scope.get('client', ('unknown', 0))
                            client_ip = client_tuple[0]
                            client_id = client_ip
                            logger.debug(f"Extracted client IP from ASGI scope: {client_ip}")
            except Exception as e:
                logger.warning(f"Failed to extract client info from context: {e}")

        # Retrieve API key from session store (SSE/HTTP) or None (stdio)
        api_key = server.get_session_api_key(client_id)

        if api_key:
            logger.info(f"🔑 Retrieved API key from session store for client: {client_id}")
        else:
            if server.session_api_keys:
                logger.warning(
                    f"⚠️ API key NOT found for client '{client_id}'. "
                    f"Available sessions: {list(server.session_api_keys.keys())}"
                )
            else:
                logger.debug("No API key in session store - stdio mode or local mode")

        try:
            # Validate request
            await server.validate_request(client_id, "batch_analyze", {
                "prompts": prompts,
                "mode": mode,
                "batch_size": batch_size
            }, api_key=api_key)

            # Log the request
            server.audit_logger.log_request(client_id, "batch_analyze", {
                "prompt_count": len(prompts),
                "mode": mode,
                "batch_size": batch_size,
                "parallel_processing": parallel_processing
            })

            # Set processing parameters
            effective_batch_size = min(
                batch_size or server.config.security.max_batch_size,
                server.config.security.max_batch_size,
                len(prompts)
            )
            _  = timeout or server.config.performance.request_timeout_seconds

            logger.info(f"Starting batch analysis: {len(prompts)} prompts, batch_size={effective_batch_size}")

            # Process prompts
            results = []
            if parallel_processing and len(prompts) <= server.config.performance.max_concurrent_requests:
                # Process all prompts in parallel
                results = await _process_prompts_parallel(
                    prompts, server, mode, include_details, api_key
                )
            else:
                # Process in batches
                results = await _process_prompts_batched(
                    prompts, server, mode, include_details, effective_batch_size, api_key
                )

            # Build response
            response = {
                "total_prompts": len(prompts),
                "results": results,
                "processing_time_ms": round((time.time() - start_time) * 1000, 2),
                "batch_id": batch_id,
            }

            # Add summary if requested
            if include_summary:
                response["summary"] = _generate_batch_summary(results)

            # Update server statistics
            response_time = time.time() - start_time
            server.update_stats(success=True, response_time=response_time)

            # Log successful response
            server.audit_logger.log_response(
                client_id, "batch_analyze", True, response_time
            )

            logger.info(f"Batch analysis completed: {len(prompts)} prompts in {response_time:.2f}s")

            return response

        except (SecurityException, APIError) as e:
            # Handle known errors
            response_time = time.time() - start_time
            server.update_stats(success=False, response_time=response_time)
            server.audit_logger.log_response(
                client_id, "batch_analyze", False, response_time, str(e)
            )
            raise

        except Exception as e:
            # Handle unexpected errors
            error_msg = f"Unexpected error in batch_analyze: {str(e)}"
            logger.error(error_msg)
            response_time = time.time() - start_time
            server.update_stats(success=False, response_time=response_time)
            server.audit_logger.log_response(
                client_id, "batch_analyze", False, response_time, error_msg
            )
            raise APIError(error_msg, error_code="BATCH_PROCESSING_FAILED")


async def _process_prompts_parallel(
    prompts: List[str],
    server: "SecureVectorMCPServer",
    mode: str,
    include_details: bool,
    api_key: Optional[str] = None
) -> List[Dict[str, Any]]:
    """Process prompts in parallel."""
    tasks = []
    for i, prompt in enumerate(prompts):
        task = _analyze_single_prompt(server, i, prompt, mode, include_details, api_key)
        tasks.append(task)

    return await asyncio.gather(*tasks, return_exceptions=True)


async def _process_prompts_batched(
    prompts: List[str],
    server: "SecureVectorMCPServer",
    mode: str,
    include_details: bool,
    batch_size: int,
    api_key: Optional[str] = None
) -> List[Dict[str, Any]]:
    """Process prompts in sequential batches."""
    results = []

    for i in range(0, len(prompts), batch_size):
        batch = prompts[i:i + batch_size]
        batch_tasks = []

        for j, prompt in enumerate(batch):
            prompt_index = i + j
            task = _analyze_single_prompt(server, prompt_index, prompt, mode, include_details, api_key)
            batch_tasks.append(task)

        batch_results = await asyncio.gather(*batch_tasks, return_exceptions=True)
        results.extend(batch_results)

        # Small delay between batches to prevent overwhelming the system
        if i + batch_size < len(prompts):
            await asyncio.sleep(0.1)

    return results


async def _analyze_single_prompt(
    server: "SecureVectorMCPServer",
    index: int,
    prompt: str,
    mode: str,
    include_details: bool,
    api_key: Optional[str] = None
) -> Dict[str, Any]:
    """Analyze a single prompt and return structured result."""
    try:
        # If we retrieved an API key from session, use it to create a configured client
        # This enables remote API calls instead of local-only mode
        if api_key and api_key != server.config.security.api_key:
            # Use the retrieved API key to create a client for this request
            logger.debug(f"Creating SecureVector client with session API key for prompt {index}")
            from securevector import AsyncSecureVectorClient
            from securevector.models.config_models import OperationMode

            # Create client config with the retrieved API key
            request_client_config = {
                "api_key": api_key,
                "mode": OperationMode.AUTO,  # AUTO will use HYBRID with API key
                "raise_on_threat": False
            }

            # Create a temporary client for this request
            request_client = AsyncSecureVectorClient(**request_client_config)
            result = await request_client.analyze(prompt, mode=mode)
        elif hasattr(server.async_client, 'analyze'):
            # Use server's default async client if available
            result = await server.async_client.analyze(prompt, mode=mode)
        else:
            # Fall back to sync client
            result = server.sync_client.analyze(prompt, mode=mode)

        # Determine action based on risk score
        if result.is_threat:
            if result.risk_score >= 75:
                action_recommended = "block"
            elif result.risk_score >= 60:
                action_recommended = "review"
            else:
                action_recommended = "warn"
        else:
            action_recommended = "allow"

        # Build response
        response = {
            "index": index,
            "is_threat": result.is_threat,
            "risk_score": result.risk_score,
            "threat_types": result.threat_types,  # Already strings
            "action_recommended": action_recommended,
            "analysis_successful": True,
        }

        # Add review/block messages
        if action_recommended == "block":
            threat_summary = ", ".join(result.threat_types) if result.threat_types else "unknown threat"
            response["blocked"] = True
            response["block_reason"] = (
                f"⛔ THREAT BLOCKED: {threat_summary} (Risk: {result.risk_score}/100). "
                f"High-risk security threat detected."
            )
        elif action_recommended == "review":
            threat_summary = ", ".join(result.threat_types) if result.threat_types else "potential threat"
            response["requires_user_approval"] = True
            response["review_message"] = (
                f"⚠️ SECURITY REVIEW REQUIRED: Detected {threat_summary} "
                f"(Risk: {result.risk_score}/100)"
            )

        if include_details:
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
                    detection.threat_type: detection.description  # Already a string
                    for detection in result.detections
                }

        return response

    except SecurityException as e:
        # Convert security exception to threat result
        return {
            "index": index,
            "is_threat": True,
            "risk_score": getattr(e, 'risk_score', 100),
            "threat_types": getattr(e, 'threat_types', ['unknown']),
            "analysis_successful": True,
            "blocked_reason": str(e),
        }

    except Exception as e:
        # Handle analysis error
        logger.error(f"Error analyzing prompt {index}: {e}")
        return {
            "index": index,
            "is_threat": False,
            "risk_score": 0,
            "threat_types": [],
            "analysis_successful": False,
            "error": str(e),
        }


def _generate_batch_summary(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Generate summary statistics for batch results."""
    successful_results = [r for r in results if r.get("analysis_successful", False)]

    if not successful_results:
        return {
            "threat_count": 0,
            "safe_count": 0,
            "average_risk_score": 0,
            "threat_type_distribution": {},
            "highest_risk_prompt": None,
            "analysis_success_rate": 0.0,
        }

    threat_count = sum(1 for r in successful_results if r.get("is_threat", False))
    safe_count = len(successful_results) - threat_count

    # Count actions
    blocked_count = sum(1 for r in successful_results if r.get("blocked", False))
    review_count = sum(1 for r in successful_results if r.get("requires_user_approval", False))
    warn_count = sum(1 for r in successful_results if r.get("action_recommended") == "warn")

    risk_scores = [r.get("risk_score", 0) for r in successful_results]
    average_risk_score = sum(risk_scores) / len(risk_scores) if risk_scores else 0

    # Threat type distribution
    threat_type_distribution = {}
    for result in successful_results:
        for threat_type in result.get("threat_types", []):
            threat_type_distribution[threat_type] = threat_type_distribution.get(threat_type, 0) + 1

    # Find highest risk prompt
    highest_risk_prompt = None
    highest_risk_score = -1
    for result in successful_results:
        risk_score = result.get("risk_score", 0)
        if risk_score > highest_risk_score:
            highest_risk_score = risk_score
            highest_risk_prompt = result.get("index")

    return {
        "threat_count": threat_count,
        "safe_count": safe_count,
        "blocked_count": blocked_count,
        "review_count": review_count,
        "warn_count": warn_count,
        "average_risk_score": round(average_risk_score, 2),
        "threat_type_distribution": threat_type_distribution,
        "highest_risk_prompt": highest_risk_prompt,
        "analysis_success_rate": round(len(successful_results) / len(results), 3),
    }


class BatchAnalysisTool:
    """
    Standalone class for the batch_analyze tool.
    Useful for testing and direct integration.
    """

    def __init__(self, server: "SecureVectorMCPServer"):
        self.server = server
        self.logger = get_logger(__name__)

    async def analyze_batch(
        self,
        prompts: List[str],
        mode: str = "auto",
        parallel: bool = True
    ) -> Dict[str, Any]:
        """
        Analyze a batch of prompts (direct method).

        Args:
            prompts: List of prompts to analyze
            mode: Analysis mode
            parallel: Use parallel processing

        Returns:
            Batch analysis result dictionary
        """
        start_time = time.time()
        results = []

        try:
            if parallel:
                # Process in parallel
                tasks = [
                    self._analyze_single(i, prompt, mode)
                    for i, prompt in enumerate(prompts)
                ]
                results = await asyncio.gather(*tasks, return_exceptions=True)
            else:
                # Process sequentially
                for i, prompt in enumerate(prompts):
                    result = await self._analyze_single(i, prompt, mode)
                    results.append(result)

            return {
                "total_prompts": len(prompts),
                "results": results,
                "processing_time_ms": round((time.time() - start_time) * 1000, 2),
                "summary": _generate_batch_summary(results),
            }

        except Exception as e:
            self.logger.error(f"Batch analysis failed: {e}")
            return {
                "total_prompts": len(prompts),
                "results": [],
                "processing_time_ms": round((time.time() - start_time) * 1000, 2),
                "error": str(e),
            }

    async def _analyze_single(self, index: int, prompt: str, mode: str) -> Dict[str, Any]:
        """Analyze a single prompt."""
        try:
            result = self.server.sync_client.analyze(prompt, mode=mode)
            return {
                "index": index,
                "is_threat": result.is_threat,
                "risk_score": result.risk_score,
                "threat_types": result.threat_types,  # Already strings
                "analysis_successful": True,
            }
        except Exception as e:
            return {
                "index": index,
                "is_threat": False,
                "risk_score": 0,
                "threat_types": [],
                "analysis_successful": False,
                "error": str(e),
            }
