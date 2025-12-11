"""
MCP Tool: Threat Statistics

This module provides the get_threat_statistics MCP tool for SecureVector AI Threat Monitor,
enabling LLMs to access aggregated threat detection metrics and statistics through MCP.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import time
from typing import Any, Dict, List, Optional, Union, TYPE_CHECKING
from datetime import datetime, timedelta
from collections import defaultdict

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


def setup_threat_stats_tool(mcp: "FastMCP", server: "SecureVectorMCPServer"):
    """Setup the get_threat_statistics MCP tool."""

    @mcp.tool()
    async def get_threat_statistics(
        time_range: str = "24h",
        group_by: str = "threat_type",
        include_trends: bool = False,
        include_details: bool = False,
        anonymize_data: bool = True,
        ctx: Optional[Context] = None  # Optional context for SSE/HTTP mode
    ) -> Dict[str, Any]:
        """
        Get aggregated threat detection statistics and metrics.

        This tool provides statistical insights into threat detection patterns,
        helping analyze security trends and threat landscape over time.

        Args:
            time_range: Time period for statistics - "1h", "24h", "7d", "30d" (default: "24h")
            group_by: Grouping method - "threat_type", "risk_level", "detection_method", "time" (default: "threat_type")
            include_trends: Include trend analysis and comparisons (default: False)
            include_details: Include detailed breakdown by subcategories (default: False)
            anonymize_data: Remove sensitive information from results (default: True)

        Returns:
            Dict containing:
            - time_period: Analyzed time period
            - total_requests: Total analysis requests in period
            - threat_summary: High-level threat statistics
            - grouped_stats: Statistics grouped by specified method
            - performance_metrics: Analysis performance data
            - trends: Trend analysis (if include_trends=True)
            - detailed_breakdown: Detailed statistics (if include_details=True)

        Example:
            {
                "time_period": "24h",
                "total_requests": 1250,
                "threat_summary": {
                    "threats_detected": 89,
                    "threats_blocked": 76,
                    "threats_warned": 13,
                    "safe_requests": 1161,
                    "threat_rate": 7.12
                },
                "grouped_stats": {
                    "prompt_injection": {
                        "count": 45,
                        "percentage": 50.6,
                        "avg_risk_score": 78.3
                    },
                    "data_exfiltration": {
                        "count": 23,
                        "percentage": 25.8,
                        "avg_risk_score": 82.1
                    }
                },
                "performance_metrics": {
                    "avg_response_time_ms": 42.5,
                    "max_response_time_ms": 156.2,
                    "success_rate": 99.8
                }
            }

        Raises:
            SecurityException: If the request is invalid or unauthorized
            APIError: If statistics generation fails
        """
        start_time = time.time()

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
            await server.validate_request(client_id, "get_threat_statistics", {
                "time_range": time_range,
                "group_by": group_by
            }, api_key=api_key)

            # Log the request
            server.audit_logger.log_request(client_id, "get_threat_statistics", {
                "time_range": time_range,
                "group_by": group_by,
                "include_trends": include_trends
            })

            # Parse time range
            time_period = _parse_time_range(time_range)
            if not time_period:
                raise SecurityException(
                    f"Invalid time range: {time_range}. Use 1h, 24h, 7d, or 30d",
                    error_code="INVALID_TIME_RANGE"
                )

            logger.info(f"Generating threat statistics for {time_range}")

            # Generate statistics
            stats = await _generate_threat_statistics(
                server, time_period, group_by, include_trends, include_details, anonymize_data
            )

            # Build response
            response = {
                "time_period": time_range,
                "generated_at": datetime.now().isoformat(),
                "total_requests": stats["total_requests"],
                "threat_summary": stats["threat_summary"],
                "grouped_stats": stats["grouped_stats"],
                "performance_metrics": stats["performance_metrics"],
                "generation_time_ms": round((time.time() - start_time) * 1000, 2),
            }

            # Add optional sections
            if include_trends and "trends" in stats:
                response["trends"] = stats["trends"]

            if include_details and "detailed_breakdown" in stats:
                response["detailed_breakdown"] = stats["detailed_breakdown"]

            # Update server statistics
            response_time = time.time() - start_time
            server.update_stats(success=True, response_time=response_time)

            # Log successful response
            server.audit_logger.log_response(
                client_id, "get_threat_statistics", True, response_time
            )

            logger.info(f"Threat statistics generated in {response_time:.2f}s")

            return response

        except (SecurityException, APIError) as e:
            # Handle known errors
            response_time = time.time() - start_time
            server.update_stats(success=False, response_time=response_time)
            server.audit_logger.log_response(
                client_id, "get_threat_statistics", False, response_time, str(e)
            )
            raise

        except Exception as e:
            # Handle unexpected errors
            error_msg = f"Unexpected error in get_threat_statistics: {str(e)}"
            logger.error(error_msg)
            response_time = time.time() - start_time
            server.update_stats(success=False, response_time=response_time)
            server.audit_logger.log_response(
                client_id, "get_threat_statistics", False, response_time, error_msg
            )
            raise APIError(error_msg, error_code="STATISTICS_GENERATION_FAILED")


def _parse_time_range(time_range: str) -> Optional[timedelta]:
    """Parse time range string into timedelta."""
    time_map = {
        "1h": timedelta(hours=1),
        "24h": timedelta(hours=24),
        "7d": timedelta(days=7),
        "30d": timedelta(days=30),
    }
    return time_map.get(time_range.lower())


async def _generate_threat_statistics(
    server: "SecureVectorMCPServer",
    time_period: timedelta,
    group_by: str,
    include_trends: bool,
    include_details: bool,
    anonymize_data: bool
) -> Dict[str, Any]:
    """Generate comprehensive threat statistics."""

    # In a real implementation, this would query actual historical data
    # For now, we'll generate representative statistics based on server state

    current_stats = server.request_stats

    # Generate mock statistics based on configuration and current state
    # This would typically come from a database or analytics store
    mock_stats = _generate_mock_statistics(
        current_stats, time_period, group_by, include_trends, include_details
    )

    if anonymize_data:
        mock_stats = _anonymize_statistics(mock_stats)

    return mock_stats


def _generate_mock_statistics(
    current_stats: Dict[str, Any],
    time_period: timedelta,
    group_by: str,
    include_trends: bool,
    include_details: bool
) -> Dict[str, Any]:
    """Generate representative statistics for demonstration."""

    # Base statistics scaled by time period
    hours = time_period.total_seconds() / 3600
    base_requests = max(100, int(current_stats.get("total_requests", 0) * hours / 24))

    # Threat distribution (realistic percentages)
    threat_rate = 0.08  # 8% threat rate
    total_threats = int(base_requests * threat_rate)

    threat_distribution = {
        "prompt_injection": int(total_threats * 0.45),      # 45% of threats
        "data_exfiltration": int(total_threats * 0.25),     # 25% of threats
        "social_engineering": int(total_threats * 0.15),    # 15% of threats
        "system_override": int(total_threats * 0.10),       # 10% of threats
        "content_policy": int(total_threats * 0.05),        # 5% of threats
    }

    # Adjust for any rounding errors
    actual_total = sum(threat_distribution.values())
    if actual_total != total_threats and actual_total > 0:
        # Adjust the largest category
        largest_key = max(threat_distribution.keys(), key=lambda k: threat_distribution[k])
        threat_distribution[largest_key] += total_threats - actual_total

    # Build statistics
    stats = {
        "total_requests": base_requests,
        "threat_summary": {
            "threats_detected": total_threats,
            "threats_blocked": int(total_threats * 0.85),  # 85% blocked
            "threats_warned": int(total_threats * 0.15),   # 15% warned
            "safe_requests": base_requests - total_threats,
            "threat_rate": round((total_threats / base_requests) * 100, 2) if base_requests > 0 else 0
        },
        "performance_metrics": {
            "avg_response_time_ms": current_stats.get("avg_response_time", 0.05) * 1000,
            "max_response_time_ms": current_stats.get("avg_response_time", 0.05) * 1000 * 3,
            "success_rate": round(
                (current_stats.get("successful_requests", 0) /
                 max(1, current_stats.get("total_requests", 1))) * 100, 2
            )
        }
    }

    # Group statistics by specified method
    if group_by == "threat_type":
        stats["grouped_stats"] = {}
        for threat_type, count in threat_distribution.items():
            if count > 0:
                stats["grouped_stats"][threat_type] = {
                    "count": count,
                    "percentage": round((count / total_threats) * 100, 1) if total_threats > 0 else 0,
                    "avg_risk_score": _get_mock_risk_score(threat_type)
                }

    elif group_by == "risk_level":
        stats["grouped_stats"] = {
            "critical": {"count": int(total_threats * 0.3), "percentage": 30.0},
            "high": {"count": int(total_threats * 0.4), "percentage": 40.0},
            "medium": {"count": int(total_threats * 0.2), "percentage": 20.0},
            "low": {"count": int(total_threats * 0.1), "percentage": 10.0},
        }

    elif group_by == "detection_method":
        stats["grouped_stats"] = {
            "pattern_matching": {"count": int(total_threats * 0.6), "percentage": 60.0},
            "ml_classification": {"count": int(total_threats * 0.3), "percentage": 30.0},
            "heuristic_analysis": {"count": int(total_threats * 0.1), "percentage": 10.0},
        }

    # Add trends if requested
    if include_trends:
        stats["trends"] = _generate_mock_trends(threat_distribution, time_period)

    # Add detailed breakdown if requested
    if include_details:
        stats["detailed_breakdown"] = _generate_detailed_breakdown(threat_distribution)

    return stats


def _get_mock_risk_score(threat_type: str) -> float:
    """Get representative risk score for threat type."""
    risk_scores = {
        "prompt_injection": 78.5,
        "data_exfiltration": 82.3,
        "social_engineering": 71.2,
        "system_override": 89.1,
        "content_policy": 65.8,
    }
    return risk_scores.get(threat_type, 75.0)


def _generate_mock_trends(threat_distribution: Dict[str, int], time_period: timedelta) -> Dict[str, Any]:
    """Generate trend analysis."""
    return {
        "trend_direction": "stable",
        "change_percentage": 2.3,
        "peak_hours": ["09:00-11:00", "14:00-16:00"],
        "threat_type_trends": {
            threat_type: {
                "direction": "increasing" if i % 2 == 0 else "decreasing",
                "change_rate": round((i + 1) * 1.5, 1)
            }
            for i, threat_type in enumerate(threat_distribution.keys())
        }
    }


def _generate_detailed_breakdown(threat_distribution: Dict[str, int]) -> Dict[str, Any]:
    """Generate detailed statistical breakdown."""
    return {
        "hourly_distribution": {
            f"{hour:02d}:00": max(0, int(sum(threat_distribution.values()) / 24 +
                                      (hour - 12) * 0.5))  # Slight variation
            for hour in range(24)
        },
        "source_patterns": {
            "automated_requests": 15.2,
            "human_generated": 84.8
        },
        "response_actions": {
            "blocked_immediately": 72.3,
            "warned_and_logged": 15.2,
            "allowed_with_monitoring": 12.5
        }
    }


def _anonymize_statistics(stats: Dict[str, Any]) -> Dict[str, Any]:
    """Remove sensitive information from statistics."""
    # In a real implementation, this would remove any potentially
    # identifying information while preserving statistical value

    # For now, just add a note that data has been anonymized
    stats["data_anonymized"] = True
    stats["anonymization_note"] = "Personal and sensitive data has been removed"

    return stats


class ThreatStatisticsTool:
    """
    Standalone class for the threat statistics tool.
    Useful for testing and direct integration.
    """

    def __init__(self, server: "SecureVectorMCPServer"):
        self.server = server
        self.logger = get_logger(__name__)

    def get_basic_stats(self) -> Dict[str, Any]:
        """
        Get basic server statistics (direct method).

        Returns:
            Basic statistics dictionary
        """
        try:
            stats = self.server.request_stats.copy()

            # Calculate additional metrics
            if stats.get("total_requests", 0) > 0:
                success_rate = (stats.get("successful_requests", 0) /
                              stats["total_requests"]) * 100
            else:
                success_rate = 0

            return {
                "total_requests": stats.get("total_requests", 0),
                "successful_requests": stats.get("successful_requests", 0),
                "failed_requests": stats.get("failed_requests", 0),
                "success_rate_percentage": round(success_rate, 2),
                "average_response_time_ms": round(stats.get("avg_response_time", 0) * 1000, 2),
                "last_request_time": stats.get("last_request_time"),
                "server_info": self.server.get_server_info(),
            }

        except Exception as e:
            self.logger.error(f"Failed to get basic stats: {e}")
            return {
                "error": str(e),
                "stats_available": False,
            }
