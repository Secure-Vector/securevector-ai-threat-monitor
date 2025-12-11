"""
SecureVector MCP Server Implementation

This module provides the main MCP server implementation for SecureVector AI Threat Monitor,
using FastMCP to expose threat analysis capabilities to LLMs through the Model Context Protocol.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import asyncio
import logging
import time
from typing import Any, Dict, List, Optional, Union
from datetime import datetime, timedelta
from collections import defaultdict, deque

try:
    from mcp.server.fastmcp import FastMCP
    from mcp.server.session import ServerSession
    from mcp.server.transport_security import TransportSecuritySettings
    from mcp import types
    MCP_AVAILABLE = True
except ImportError:
    MCP_AVAILABLE = False
    # Create dummy classes
    FastMCP = None
    ServerSession = None
    TransportSecuritySettings = None
    types = None

from securevector import SecureVectorClient, AsyncSecureVectorClient
from securevector.models.config_models import OperationMode
from securevector.models.policy_models import SecurityPolicy, PolicyAction
from securevector.utils.logger import get_logger
from securevector.utils.exceptions import SecurityException, APIError, ConfigurationError

from .config.server_config import MCPServerConfig, create_default_config
from .auth_validator import AuthValidator


class RateLimiter:
    """Simple rate limiter for MCP requests."""

    def __init__(self, requests_per_minute: int = 60, burst_size: int = 10):
        self.requests_per_minute = requests_per_minute
        self.burst_size = burst_size
        self.client_requests = defaultdict(deque)
        self.logger = get_logger(__name__)

    def is_allowed(self, client_id: str) -> bool:
        """Check if request is allowed for client."""
        now = time.time()
        minute_ago = now - 60

        # Clean old requests
        client_queue = self.client_requests[client_id]
        while client_queue and client_queue[0] < minute_ago:
            client_queue.popleft()

        # Check rate limit
        if len(client_queue) >= self.requests_per_minute:
            self.logger.warning(f"Rate limit exceeded for client {client_id}")
            return False

        # Check burst limit
        recent_requests = sum(1 for req_time in client_queue if req_time > now - 10)
        if recent_requests >= self.burst_size:
            self.logger.warning(f"Burst limit exceeded for client {client_id}")
            return False

        # Allow request and record it
        client_queue.append(now)
        return True


class AuditLogger:
    """Audit logger for MCP server operations."""

    def __init__(self, enabled: bool = True, log_path: Optional[str] = None):
        self.enabled = enabled
        self.logger = logging.getLogger("securevector.mcp.audit")

        if enabled and log_path:
            handler = logging.FileHandler(log_path)
            formatter = logging.Formatter(
                '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
            )
            handler.setFormatter(formatter)
            self.logger.addHandler(handler)
            self.logger.setLevel(logging.INFO)

    def log_request(self, client_id: str, tool_name: str, args: Dict[str, Any], user_email: Optional[str] = None):
        """Log MCP tool request."""
        if self.enabled:
            user_info = f"user={user_email}" if user_email else f"client={client_id}"
            self.logger.info(
                f"MCP_REQUEST {user_info} tool={tool_name} "
                f"args_keys={list(args.keys())}"
            )

    def log_response(self, client_id: str, tool_name: str, success: bool,
                    response_time: float, error: Optional[str] = None):
        """Log MCP tool response."""
        if self.enabled:
            status = "SUCCESS" if success else "ERROR"
            error_msg = f" error={error}" if error else ""
            self.logger.info(
                f"MCP_RESPONSE client={client_id} tool={tool_name} "
                f"status={status} time={response_time:.3f}s{error_msg}"
            )


class SecureVectorMCPServer:
    """
    SecureVector MCP Server implementation.

    Provides MCP tools, resources, and prompts for AI threat analysis
    using the SecureVector AI Threat Monitor SDK.
    """

    def __init__(
        self,
        name: str = "SecureVector AI Threat Monitor",
        config: Optional[MCPServerConfig] = None,
        api_key: Optional[str] = None,
        **kwargs
    ):
        """
        Initialize SecureVector MCP Server.

        Args:
            name: Server name for MCP identification
            config: MCP server configuration
            api_key: Optional API key for SecureVector client
            **kwargs: Additional configuration options
        """
        if not MCP_AVAILABLE:
            raise ImportError(
                "MCP dependencies not available. Install with: "
                "pip install securevector-ai-monitor[mcp]"
            )

        # Configuration
        if config is None:
            # Extract mode parameter if provided and convert to securevector_mode
            config_kwargs = kwargs.copy()
            if 'mode' in config_kwargs:
                mode_value = config_kwargs.pop('mode')
                # Convert OperationMode enum to string if needed
                if hasattr(mode_value, 'value'):
                    config_kwargs['securevector_mode'] = mode_value.value
                else:
                    config_kwargs['securevector_mode'] = str(mode_value).lower()

            # Create default config and set the provided name
            self.config = create_default_config(api_key=api_key, **config_kwargs)
            self.config.name = name
        else:
            # Use provided config as-is
            self.config = config

        self.logger = get_logger(__name__)

        # Initialize FastMCP server with transport security settings
        # Allow Render.com and other cloud hosting domains
        transport_security = TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=[
                "*.onrender.com",                                    # Render.com wildcard
                "*.render.com",                                      # Render.com alternative
                "securevector-mcp-server-latest-dev.onrender.com",  # Render.com dev
                "securevector-mcp-server-latest.onrender.com",      # Render.com prod
                "*.securevector.io",                                 # SecureVector custom domains
                "securevector.io",                                   # SecureVector root domain
                "localhost",                                         # Local development
                "127.0.0.1",                                        # Local development
                "0.0.0.0",                                          # Docker/container binding
            ],
            allowed_origins=["*"]  # Allow all origins for now
        )
        self.mcp = FastMCP(name, transport_security=transport_security)

        # Initialize SecureVector clients
        self._init_securevector_clients(api_key)

        # Initialize security components
        self.rate_limiter = RateLimiter(
            requests_per_minute=self.config.security.requests_per_minute,
            burst_size=self.config.security.burst_requests
        )
        self.audit_logger = AuditLogger(
            enabled=self.config.security.enable_audit_logging,
            log_path=self.config.security.audit_log_path
        )

        # Store transport mode to determine auth requirements later
        self._transport_mode = None  # Will be set when server starts

        # Initialize auth validator for Phase 1 API key validation (OPTIONAL)
        # Only initialize if identity_service_url is explicitly provided
        identity_service_url = kwargs.get('identity_service_url') or \
                              (self.config.get('identity_service_url') if hasattr(self.config, 'get') else None)

        # Check if identity service URL is provided and not the default localhost
        # Skip auth validator for local development (no identity service required)
        if identity_service_url and identity_service_url != "http://localhost:8000":
            self.auth_validator = AuthValidator(identity_service_url=identity_service_url)
            self.logger.info(f"AuthValidator enabled with identity service: {identity_service_url}")
        else:
            self.auth_validator = None
            self.logger.info("AuthValidator disabled - running in local mode without identity service")

        # Store validated user context (populated on first request)
        self.user_context: Optional[Dict[str, Any]] = None

        # Performance tracking
        self.request_stats = {
            "total_requests": 0,
            "successful_requests": 0,
            "failed_requests": 0,
            "avg_response_time": 0.0,
            "last_request_time": None,
        }

        # Track local mode usage for smart upgrade message display
        self.local_mode_prompts_analyzed = 0

        # Session store for API keys (SSE/HTTP transport)
        # Maps session_id -> api_key
        self.session_api_keys: Dict[str, str] = {}

        # Setup MCP components
        self._setup_tools()
        self._setup_resources()
        self._setup_prompts()

        self.logger.info(f"SecureVector MCP Server initialized: {name}")

    def should_show_upgrade_message(self) -> bool:
        """
        Determine if upgrade message should be shown based on prompt count.

        Shows at: 1, 5, 15, 20, 40, 60, 80, 100, and then every prompt after 100.

        Returns:
            bool: True if upgrade message should be displayed
        """
        count = self.local_mode_prompts_analyzed

        # Show at specific milestones
        if count in [1, 5, 15, 20, 40, 60, 80, 100]:
            return True

        # After 100, show every time
        if count > 100:
            return True

        return False

    def increment_local_mode_count(self) -> int:
        """
        Increment and return the local mode prompt counter.

        Returns:
            int: Current count after increment
        """
        self.local_mode_prompts_analyzed += 1
        return self.local_mode_prompts_analyzed

    def get_session_api_key(self, client_id: Optional[str] = None) -> Optional[str]:
        """
        Retrieve API key from session store.

        For SSE/HTTP transports, API keys are captured from connection headers
        and stored in session_api_keys dict. This method retrieves them.

        Args:
            client_id: Optional client identifier to look up session

        Returns:
            API key if found, None otherwise
        """
        # No sessions at all
        if not self.session_api_keys:
            self.logger.debug("No sessions in API key store")
            return None

        # If we only have one session, return that API key
        if len(self.session_api_keys) == 1:
            api_key = list(self.session_api_keys.values())[0]
            session_id = list(self.session_api_keys.keys())[0]
            self.logger.debug(f"Retrieved API key from single session: {session_id}")
            return api_key

        # Multiple sessions - check if all have the same API key
        # This handles cases where client connects to multiple endpoints (/sse, /messages)
        unique_keys = set(self.session_api_keys.values())
        if len(unique_keys) == 1:
            api_key = list(unique_keys)[0]
            self.logger.debug(
                f"Retrieved API key from {len(self.session_api_keys)} sessions "
                f"(all have same key)"
            )
            return api_key

        # Multiple different API keys - try to find by exact client_id match
        if client_id and client_id in self.session_api_keys:
            api_key = self.session_api_keys[client_id]
            self.logger.debug(f"Retrieved API key for client: {client_id}")
            return api_key

        # Try to find by IP address (client_id prefix match)
        # Session IDs are format: "IP:path", so we match by IP prefix
        # This handles multi-tenant scenarios where each client has their own IP
        if client_id:
            matching_sessions = {}
            for session_id, api_key in self.session_api_keys.items():
                # Match if session_id starts with client IP (e.g., "99.120.219.15:/sse")
                if session_id.startswith(client_id + ":"):
                    matching_sessions[session_id] = api_key

            # If we found sessions for this IP, check if they all have the same key
            if matching_sessions:
                unique_keys_for_ip = set(matching_sessions.values())
                if len(unique_keys_for_ip) == 1:
                    api_key = list(unique_keys_for_ip)[0]
                    self.logger.debug(
                        f"Retrieved API key for IP {client_id} "
                        f"(matched {len(matching_sessions)} sessions)"
                    )
                    return api_key
                else:
                    self.logger.error(
                        f"Multiple different API keys found for IP {client_id}! "
                        f"This should not happen. Sessions: {matching_sessions}"
                    )
                    # Return the most recent one (arbitrary choice)
                    return list(matching_sessions.values())[-1]

        # No match found
        self.logger.warning(
            f"No API key found for client_id='{client_id}'. "
            f"Available sessions: {list(self.session_api_keys.keys())}"
        )
        return None

    def _init_securevector_clients(self, api_key: Optional[str]):
        """Initialize SecureVector clients following SDK mode selection pattern."""
        client_config = self.config.securevector_config.copy()

        # Determine API key from multiple sources
        final_api_key = None
        if api_key:
            final_api_key = api_key
        elif self.config.security.api_key:
            final_api_key = self.config.security.api_key

        # Add API key to config if available
        if final_api_key:
            client_config["api_key"] = final_api_key

        # Set mode following SDK pattern:
        # - If no specific mode set in config, use AUTO (like SDK default)
        # - AUTO mode with API key -> HYBRID mode (best of both worlds)
        # - AUTO mode without API key -> LOCAL mode (offline operation)
        if "mode" not in client_config:
            client_config["mode"] = self.config.securevector_mode if self.config.securevector_mode != "auto" else OperationMode.AUTO

        # IMPORTANT: MCP tools handle exceptions themselves, so disable client-side exceptions
        # This allows the tools to implement custom blocking/review logic
        client_config["raise_on_threat"] = False

        # Create a WARN policy so tools can handle blocking logic
        mcp_policy = SecurityPolicy(
            name="mcp_tool_policy",
            description="MCP server policy - allows tools to handle blocking logic",
            default_action=PolicyAction.WARN  # Don't block, let tools decide
        )
        client_config["policy"] = mcp_policy

        try:
            # Initialize clients - they will automatically select appropriate mode
            self.sync_client = SecureVectorClient(**client_config)
            self.async_client = AsyncSecureVectorClient(**client_config)

            # Log the actual mode being used
            actual_mode = self.sync_client.mode_handler.__class__.__name__.replace('Mode', '').lower()
            if final_api_key:
                self.logger.info(f"SecureVector clients initialized in {actual_mode} mode with API key")
            else:
                self.logger.info(f"SecureVector clients initialized in {actual_mode} mode (local-only, no API key)")

        except Exception as e:
            self.logger.error(f"Failed to initialize SecureVector clients: {e}")
            # If client initialization fails, it's likely a configuration issue
            # Don't fail completely - fallback to basic functionality
            self.logger.warning("Attempting fallback initialization in local mode")
            try:
                fallback_config = {"mode": OperationMode.LOCAL}
                self.sync_client = SecureVectorClient(**fallback_config)
                self.async_client = AsyncSecureVectorClient(**fallback_config)
                self.logger.info("SecureVector clients initialized in fallback local mode")
            except Exception as fallback_error:
                self.logger.error(f"Fallback initialization also failed: {fallback_error}")
                raise ConfigurationError(f"SecureVector client initialization failed: {e}");

    def _setup_tools(self):
        """Setup MCP tools."""
        if not self.config.enable_tools:
            return

        # Import and register tools
        from .tools.analyze_prompt import setup_analyze_prompt_tool
        from .tools.batch_analysis import setup_batch_analysis_tool
        from .tools.threat_stats import setup_threat_stats_tool

        if "analyze_prompt" in self.config.enabled_tools:
            setup_analyze_prompt_tool(self.mcp, self)

        if "batch_analyze" in self.config.enabled_tools:
            setup_batch_analysis_tool(self.mcp, self)

        if "get_threat_statistics" in self.config.enabled_tools:
            setup_threat_stats_tool(self.mcp, self)

        self.logger.info(f"MCP tools enabled: {self.config.enabled_tools}")

    def run_direct(self, transport: str = "stdio"):
        """
        Run FastMCP server directly (synchronous entry point).

        This method should be used when you want FastMCP to handle
        the entire server lifecycle, including stdio transport.
        This is the recommended approach for simple integrations.

        Args:
            transport: Transport protocol (stdio, http, sse)
        """
        self.logger.info(f"Running FastMCP server directly with {transport} transport")

        try:
            # Let FastMCP handle everything
            self.mcp.run(transport=transport)
        except Exception as e:
            self.logger.error(f"FastMCP direct run failed: {e}")
            raise

    def _setup_resources(self):
        """Setup MCP resources."""
        if not self.config.enable_resources:

            return

        # Import and register resources
        from .resources.rules import setup_rules_resource
        from .resources.policies import setup_policies_resource

        if "rules" in self.config.enabled_resources:
            setup_rules_resource(self.mcp, self)

        if "policies" in self.config.enabled_resources:
            setup_policies_resource(self.mcp, self)

        self.logger.info(f"MCP resources enabled: {self.config.enabled_resources}")

    def _setup_prompts(self):
        """Setup MCP prompts."""
        if not self.config.enable_prompts:
            return

        # Import and register prompts
        from .prompts.templates import setup_prompt_templates

        setup_prompt_templates(self.mcp, self, self.config.enabled_prompts)

        self.logger.info(f"MCP prompts enabled: {self.config.enabled_prompts}")

    async def validate_request(self, client_id: str, tool_name: str, args: Dict[str, Any], api_key: Optional[str] = None) -> bool:
        """
        Validate incoming MCP request.

        Args:
            client_id: Client identifier
            tool_name: Name of the tool being called
            args: Tool arguments
            api_key: API key from request headers (if provided)

        Returns:
            True if request is valid, False otherwise

        Raises:
            SecurityException: If request is invalid or unauthorized
        """
        # Rate limiting
        if not self.rate_limiter.is_allowed(client_id):
            raise SecurityException(
                "Rate limit exceeded",
                error_code="RATE_LIMIT_EXCEEDED",
                details={"client_id": client_id, "tool": tool_name}
            )

        # ========================================================================
        # PHASE 1 AUTHENTICATION: Validate API key via identity-service
        # ========================================================================
        # This happens ONCE per session (cached in self.user_context).
        # Tools don't need to handle authentication - it's automatic!
        # ========================================================================
        if self.config.security.require_authentication:
            # Get API key from multiple sources (header or config)
            auth_key = api_key or self.config.security.api_key

            if not auth_key:
                raise SecurityException(
                    "Authentication required - API key not provided",
                    error_code="AUTH_REQUIRED",
                    details={"message": "Please provide x-api-key header or configure API key"}
                )

            # Validate ONCE per session (subsequent calls use cached context)
            # Skip validation if AuthValidator is not initialized (local mode)
            if not self.user_context:
                if self.auth_validator is not None:
                    # Identity service available - validate API key
                    self.logger.debug("Validating API key via identity-service...")
                    validation_result = await self.auth_validator.validate_api_key(auth_key)

                    if not validation_result or not validation_result.get("valid"):
                        raise SecurityException(
                            "Invalid or expired API key",
                            error_code="INVALID_API_KEY",
                            details={"message": "Please check your API key or create a new one at https://securevector.io"}
                        )

                    # Cache user context for this session (no more validation needed!)
                    self.user_context = validation_result
                    self.logger.info(
                        f"✅ User authenticated: {validation_result['user']['email']} "
                        f"(plan: {validation_result['subscription']['plan']})"
                    )
                else:
                    # No identity service - skip validation (local/development mode)
                    self.logger.debug("Skipping identity service validation (running in local mode)")
                    # Create minimal user context for local mode
                    self.user_context = {
                        "valid": True,
                        "user": {
                            "user_id": "local-user",
                            "email": "local@development"
                        },
                        "subscription": {
                            "plan": "local-development",
                            "status": "active"
                        }
                    }
            else:
                # Already validated - using cached context
                if self.auth_validator is not None:
                    self.logger.debug(f"Using cached auth context for {self.user_context['user']['email']}")
                else:
                    self.logger.debug("Using local development context (no identity service)")

            # Check subscription status (optional - for future features)
            subscription = self.user_context.get("subscription", {})
            if subscription.get("status") != "active":
                self.logger.warning(f"User has inactive subscription: {subscription.get('status')}")
                # For Phase 1, we'll allow it but log a warning
                # In Phase 2, you could enforce subscription requirements

        # Input validation
        if "prompt" in args:
            prompt = args["prompt"]
            if len(prompt) > self.config.security.max_prompt_length:
                raise SecurityException(
                    f"Prompt too long: {len(prompt)} > {self.config.security.max_prompt_length}",
                    error_code="PROMPT_TOO_LONG",
                    details={"length": len(prompt), "max_length": self.config.security.max_prompt_length}
                )

        if "prompts" in args:
            prompts = args["prompts"]
            if len(prompts) > self.config.security.max_batch_size:
                raise SecurityException(
                    f"Batch too large: {len(prompts)} > {self.config.security.max_batch_size}",
                    error_code="BATCH_TOO_LARGE",
                    details={"size": len(prompts), "max_size": self.config.security.max_batch_size}
                )

        return True

    def update_stats(self, success: bool, response_time: float):
        """Update performance statistics."""
        self.request_stats["total_requests"] += 1
        self.request_stats["last_request_time"] = datetime.now()

        if success:
            self.request_stats["successful_requests"] += 1
        else:
            self.request_stats["failed_requests"] += 1

        # Update average response time
        total = self.request_stats["total_requests"]
        current_avg = self.request_stats["avg_response_time"]
        self.request_stats["avg_response_time"] = (
            (current_avg * (total - 1) + response_time) / total
        )

    def get_server_info(self) -> Dict[str, Any]:
        """Get server information and statistics."""
        return {
            "name": self.config.name,
            "version": self.config.version,
            "description": self.config.description,
            "config": self.config.to_dict(),
            "stats": self.request_stats,
            "uptime": time.time(),  # Will be calculated by client
            "status": "running",
        }

    async def run(self, transport: str = "stdio"):
        """
        Run the MCP server.

        Args:
            transport: Transport protocol (stdio, sse, http)
        """
        transport = transport or self.config.transport
        self._transport_mode = transport  # Store for auth checks

        # Auto-disable authentication for stdio mode only (local usage)
        # Remote transports (sse, http) MUST have API key authentication
        if transport == "stdio":
            if not self.config.security.api_key:
                if self.config.security.require_authentication:
                    self.logger.info("Stdio transport detected - disabling authentication requirement (local mode)")
                    self.config.security.require_authentication = False
        else:
            # Remote transport (sse/http) - ensure authentication is enabled
            if not self.config.security.require_authentication:
                self.logger.warning(f"Remote transport ({transport}) detected - enabling authentication requirement")
                self.config.security.require_authentication = True

        self.logger.info(f"Starting SecureVector MCP Server with {transport} transport")

        try:
            if transport == "stdio":
                await self._run_stdio()
            elif transport == "http":
                await self._run_http()
            elif transport == "sse":
                await self._run_sse()
            else:
                raise ValueError(f"Unsupported transport: {transport}")
        except Exception as e:
            self.logger.error(f"MCP Server error: {e}")
            raise

    async def _run_stdio(self):
        """Run server with stdio transport using FastMCP async support."""
        self.logger.info("MCP Server starting with stdio transport (async mode)")

        try:
            # Use FastMCP's built-in async stdio support
            self.logger.info("Starting FastMCP async stdio server...")

            # Use the correct FastMCP async method
            await self.mcp.run_stdio_async()

        except Exception as e:
            self.logger.error(f"Failed to start stdio server: {e}")
            import traceback
            self.logger.error(f"Traceback: {traceback.format_exc()}")

            # Try fallback to direct mode
            self.logger.warning("Attempting direct FastMCP run as fallback")
            try:
                # This runs synchronously - no await needed
                self.mcp.run(transport="stdio")
            except Exception as fallback_error:
                self.logger.error(f"Direct FastMCP run also failed: {fallback_error}")
                raise

    async def _run_http(self):
        """Run server with HTTP transport (streamable-http) using Uvicorn directly for proper host/port binding."""
        self.logger.info(f"Starting HTTP server on {self.config.host}:{self.config.port}")

        try:
            # Import uvicorn and get ASGI app from FastMCP
            import uvicorn

            # Get the ASGI app from FastMCP for streamable HTTP
            app = self.mcp.streamable_http_app()

            # Configure Uvicorn with our host/port settings
            config = uvicorn.Config(
                app=app,
                host=self.config.host,
                port=self.config.port,
                log_level="info",
                access_log=True,
                forwarded_allow_ips="*"  # Trust proxy headers from Render.com/CloudFlare
            )

            server = uvicorn.Server(config)

            self.logger.info(f"MCP Server running with HTTP transport on {self.config.host}:{self.config.port}")

            # Run server - this keeps the event loop alive
            await server.serve()

        except Exception as e:
            self.logger.error(f"HTTP transport failed: {e}")
            import traceback
            self.logger.error(f"Traceback: {traceback.format_exc()}")
            raise

    async def _run_sse(self):
        """Run server with SSE transport using Uvicorn directly for proper host/port binding."""
        self.logger.info(f"Starting SSE server on {self.config.host}:{self.config.port}")
        self.logger.info(f"SSE endpoint will be available at http://{self.config.host}:{self.config.port}/sse")

        try:
            # Import uvicorn and get ASGI app from FastMCP
            import uvicorn

            # Get the ASGI app from FastMCP for SSE transport
            # sse_app() is a method that returns a Starlette ASGI app
            base_asgi_app = self.mcp.sse_app()

            # Wrap with middleware to capture API keys from headers
            class APIKeyMiddleware:
                """ASGI middleware to capture x-api-key from SSE connection headers."""

                def __init__(self, app, server_instance):
                    self.app = app
                    self.server = server_instance

                async def __call__(self, scope, receive, send):
                    if scope["type"] == "http":
                        # Extract headers
                        headers = dict(scope.get("headers", []))
                        api_key = headers.get(b"x-api-key", b"").decode("utf-8") or None

                        if api_key:
                            # Generate a session ID from the request
                            # Priority: 1) session_id query param, 2) client_ip
                            session_id = None

                            # Try to extract session_id from query string
                            query_string = scope.get("query_string", b"").decode("utf-8")
                            if query_string and "session_id=" in query_string:
                                # Parse query string to get session_id
                                from urllib.parse import parse_qs
                                params = parse_qs(query_string)
                                if "session_id" in params and params["session_id"]:
                                    session_id = params["session_id"][0]
                                    self.server.logger.debug(f"Extracted session_id from query: {session_id}")

                            # Fallback to client IP if no session_id in query
                            if not session_id:
                                client_host = scope.get("client", ["unknown", 0])[0]
                                path = scope.get("path", "")
                                session_id = f"{client_host}:{path}"

                            # Store API key for this session (will update if same session_id)
                            self.server.session_api_keys[session_id] = api_key
                            self.server.logger.info(f"🔑 Captured API key for session: {session_id}")

                    # Call the original app
                    await self.app(scope, receive, send)

            # Wrap the base app with middleware
            app = APIKeyMiddleware(base_asgi_app, self)

            # Configure Uvicorn with our host/port settings
            config = uvicorn.Config(
                app=app,
                host=self.config.host,
                port=self.config.port,
                log_level="info",
                access_log=True,
                forwarded_allow_ips="*"  # Trust proxy headers from Render.com/CloudFlare
            )

            server = uvicorn.Server(config)

            self.logger.info(f"MCP Server running with SSE transport on {self.config.host}:{self.config.port}")

            # Run server - this keeps the event loop alive
            await server.serve()

        except Exception as e:
            self.logger.error(f"SSE transport failed: {e}")
            import traceback
            self.logger.error(f"Traceback: {traceback.format_exc()}")
            raise

    def _setup_mcp_handlers(self, session: "ServerSession"):
        """
        Legacy method for manual MCP handler setup.

        This method is kept for compatibility but is no longer used
        since FastMCP handles all protocol interactions automatically.
        """
        self.logger.warning("_setup_mcp_handlers called but FastMCP handles this automatically")
        pass

    # All MCP protocol handling is now done automatically by FastMCP
    # Tools, resources, and prompts are registered via decorators and setup methods

    async def shutdown(self):
        """Shutdown the MCP server gracefully."""
        self.logger.info("Shutting down SecureVector MCP Server")
        # Cleanup resources
        if hasattr(self.async_client, 'close'):
            await self.async_client.close()


def create_server(
    name: str = "SecureVector AI Threat Monitor",
    api_key: Optional[str] = None,
    config: Optional[MCPServerConfig] = None,
    **kwargs
) -> SecureVectorMCPServer:
    """
    Create a SecureVector MCP server instance.

    Args:
        name: Server name
        api_key: Optional API key
        config: Optional configuration
        **kwargs: Additional configuration options

    Returns:
        SecureVectorMCPServer instance
    """
    return SecureVectorMCPServer(
        name=name,
        config=config,
        api_key=api_key,
        **kwargs
    )
