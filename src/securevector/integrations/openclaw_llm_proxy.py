#!/usr/bin/env python3
"""
SecureVector OpenClaw LLM Proxy

Sits between OpenClaw (or any LLM client) and the LLM provider (OpenAI, Anthropic, etc.).
Scans all messages before they reach the LLM and scans responses for data leakage.

This captures ALL traffic regardless of client (TUI, Telegram, API, etc.).

Usage:
    python -m securevector.integrations.openclaw_llm_proxy --provider openai --port 8742

    Then configure OpenClaw to use http://localhost:8742 as the API base URL:
    OPENAI_BASE_URL=http://localhost:8742 openclaw gateway
"""

import argparse
import asyncio
import json
import logging
import os
import re
import sys
from typing import Optional
from urllib.parse import urlparse

try:
    import httpx
    from fastapi import FastAPI, Request, Response, HTTPException
    from fastapi.responses import StreamingResponse
    import uvicorn
except ImportError:
    print("Missing dependencies. Install with:")
    print("  pip install httpx fastapi uvicorn")
    sys.exit(1)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Completely disable httpx logging to prevent API keys from appearing in logs
logging.getLogger("httpx").setLevel(logging.CRITICAL)
logging.getLogger("httpx").propagate = False


# Security: Allowed hosts for target URLs (prevents SSRF to internal services)
ALLOWED_TARGET_HOSTS = {
    # Known LLM providers
    "api.openai.com",
    "api.anthropic.com",
    "api.groq.com",
    "api.cerebras.ai",
    "api.mistral.ai",
    "api.x.ai",
    "generativelanguage.googleapis.com",
    "api.moonshot.ai",
    "api.minimax.chat",
    "api.deepseek.com",
    "api.together.xyz",
    "api.cohere.ai",
    # Local development
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
}

# Security: Allowed hosts for SecureVector URL
ALLOWED_SECUREVECTOR_HOSTS = {
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "scan.securevector.io",  # Cloud API
}


def validate_url(url: str, allowed_hosts: set, url_type: str) -> str:
    """Validate URL against allowed hosts to prevent SSRF.

    Args:
        url: The URL to validate
        allowed_hosts: Set of allowed hostnames
        url_type: Description for error messages (e.g., "target URL")

    Returns:
        The validated URL

    Raises:
        ValueError: If URL is invalid or host not allowed
    """
    try:
        parsed = urlparse(url)
    except Exception as e:
        raise ValueError(f"Invalid {url_type}: {e}")

    if not parsed.scheme:
        raise ValueError(f"Invalid {url_type}: missing scheme (http/https)")

    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Invalid {url_type}: scheme must be http or https")

    if not parsed.hostname:
        raise ValueError(f"Invalid {url_type}: missing hostname")

    hostname = parsed.hostname.lower()

    if hostname in allowed_hosts:
        return url

    # Check if it's a private IP (SSRF protection)
    import ipaddress
    try:
        ip = ipaddress.ip_address(hostname)
        if ip.is_private:
            raise ValueError(
                f"Invalid {url_type}: private IP addresses not allowed ({hostname}). "
                f"Use localhost or 127.0.0.1 for local services."
            )
    except ValueError:
        # Not an IP address, it's a hostname - check against allowlist
        if hostname not in allowed_hosts:
            raise ValueError(
                f"Invalid {url_type}: host '{hostname}' not in allowed list. "
                f"Allowed: {', '.join(sorted(allowed_hosts))}"
            )

    return url


class LLMProxy:
    """Universal proxy for any LLM API that scans all messages.

    Works with ANY provider - just set the target URL.
    Auth headers are passed through from the client.
    """

    # Common providers with defaults (but proxy works with ANY URL)
    PROVIDERS = {
        "openai": "https://api.openai.com",
        "anthropic": "https://api.anthropic.com",
        "groq": "https://api.groq.com/openai",
        "cerebras": "https://api.cerebras.ai",
        "mistral": "https://api.mistral.ai",
        "xai": "https://api.x.ai",
        "gemini": "https://generativelanguage.googleapis.com",
        "moonshot": "https://api.moonshot.ai",
        "minimax": "https://api.minimax.chat",
        "deepseek": "https://api.deepseek.com",
        "together": "https://api.together.xyz",
        "cohere": "https://api.cohere.ai",
    }

    # API version prefix each provider expects (auto-prepended if missing from request)
    API_PREFIXES = {
        "openai": "/v1",
        "anthropic": "",
        "groq": "/v1",
        "cerebras": "/v1",
        "mistral": "/v1",
        "xai": "/v1",
        "gemini": "/v1beta",
        "moonshot": "/v1",
        "minimax": "/v1",
        "deepseek": "/v1",
        "together": "/v1",
        "cohere": "/v1",
    }

    def __init__(
        self,
        target_url: str = "https://api.openai.com",
        securevector_url: str = "http://127.0.0.1:8741",
        block_threats: bool = False,
        verbose: bool = False,
        provider: str = "openai",
        skip_url_validation: bool = False,
    ):
        # Security: Validate URLs to prevent SSRF attacks
        if not skip_url_validation:
            target_url = validate_url(target_url, ALLOWED_TARGET_HOSTS, "target URL")
            securevector_url = validate_url(securevector_url, ALLOWED_SECUREVECTOR_HOSTS, "SecureVector URL")

        self.target_url = target_url.rstrip("/")
        self.securevector_url = securevector_url
        self.analyze_url = f"{securevector_url}/analyze"
        self.settings_url = f"{securevector_url}/api/settings"
        self.block_threats = block_threats
        self.verbose = verbose
        self.provider = provider
        self.api_prefix = self.API_PREFIXES.get(provider, "/v1")
        self.stats = {"scanned": 0, "blocked": 0, "threats_detected": 0, "passed": 0}
        self._http_client: Optional[httpx.AsyncClient] = None

        # Cache for settings
        self._output_scan_enabled: Optional[bool] = None
        self._block_threats_enabled: Optional[bool] = None
        self._cloud_mode_enabled: Optional[bool] = None
        self._cloud_api_key: Optional[str] = None
        self._tool_permissions_enabled: Optional[bool] = None
        self._settings_checked_at: float = 0

        # Tool permissions engine (lazy-loaded)
        self._essential_registry: Optional[dict] = None
        self._tool_overrides: Optional[dict] = None
        self._tool_overrides_checked_at: float = 0
        self._custom_tools_registry: Optional[dict] = None
        self._custom_tools_checked_at: float = 0

        # Rate limiting
        self._request_counter: int = 0

        # Cost recording (lazy-init)
        self._cost_recorder_instance = None
        self._cost_db = None

        # Budget check cache: agent_id → (status_dict, checked_at)
        self._budget_cache: dict = {}
        self._budget_cache_ttl: float = 10.0  # Short TTL; cache is also invalidated after each recorded cost

    def _truncate(self, text: str, max_len: int = 100) -> str:
        """Truncate text for logging."""
        if len(text) <= max_len:
            return text
        return text[:max_len] + f"... ({len(text)} chars)"

    def _extract_agent_id(self, request: Request) -> str:
        """Extract agent ID from X-Agent-ID header, or auto-generate one."""
        agent_id = request.headers.get("x-agent-id", "").strip()
        if agent_id:
            return agent_id[:128]  # Cap length
        # Fall back to client IP (not port — port is ephemeral per-connection)
        client = getattr(request, "client", None)
        if client:
            return f"client:{client.host}"
        return "unknown-agent"

    async def _get_cost_recorder(self):
        """Lazy-init CostRecorder using local SecureVector database."""
        if self._cost_recorder_instance is not None:
            return self._cost_recorder_instance
        try:
            from securevector.app.database.connection import get_database
            from securevector.app.services.cost_recorder import CostRecorder
            db = get_database()
            if db._connection is None:
                await db.connect()
            self._cost_db = db
            self._cost_recorder_instance = CostRecorder(db)
            logger.info("[llm-proxy] CostRecorder initialized")
        except Exception as e:
            logger.warning(f"[llm-proxy] CostRecorder init failed: {e}")
            return None
        return self._cost_recorder_instance

    async def _record_cost(self, provider: str, agent_id: str, response_body: bytes) -> None:
        """Fire-and-forget cost recording. Never raises.

        For SSE streaming bodies, scans chunks in reverse to find the last
        data line that contains token usage fields.
        """
        try:
            recorder = await self._get_cost_recorder()
            if not recorder:
                logger.debug("[llm-proxy] cost recording skipped: no recorder")
                return

            # Detect SSE format: bodies starting with "data:" or "event:" (e.g. Responses API)
            body_bytes = response_body
            stripped = body_bytes.lstrip() if body_bytes else b""
            if body_bytes and (stripped.startswith(b"data:") or stripped.startswith(b"event:")):
                body_bytes = self._extract_sse_usage_chunk(response_body, provider=provider)
                if not body_bytes:
                    logger.debug("[llm-proxy] cost recording skipped: no usage in SSE stream")
                    return

            await recorder.record(provider=provider, agent_id=agent_id, response_body=body_bytes)
            logger.info(f"[llm-proxy] cost recorded for agent={agent_id} provider={provider}")
            # Invalidate budget cache so the next request re-checks against updated spend
            self._budget_cache.pop(agent_id, None)
        except Exception as e:
            logger.warning(f"[llm-proxy] cost recording failed: {e}")

    async def _check_budget(self, agent_id: str) -> dict:
        """Check if agent is within its daily budget. Returns budget status dict.

        Cached for 30s to avoid DB hit on every request.
        Never raises — returns permissive defaults on error.
        """
        import time
        now = time.monotonic()
        cached = self._budget_cache.get(agent_id)
        if cached:
            status, checked_at = cached
            if (now - checked_at) < self._budget_cache_ttl:
                return status

        try:
            client = await self.get_http_client()
            response = await client.get(
                f"{self.securevector_url}/api/costs/budget-status",
                params={"agent_id": agent_id},
                timeout=2.0,
            )
            if response.status_code == 200:
                status = response.json()
                logger.info(
                    f"[llm-proxy] Budget check: agent={agent_id} "
                    f"spend=${status.get('today_spend_usd', 0):.6f} "
                    f"limit=${status.get('effective_budget_usd')} "
                    f"over={status.get('over_budget')}"
                )
                self._budget_cache[agent_id] = (status, now)
                return status
            else:
                logger.warning(f"[llm-proxy] Budget check returned HTTP {response.status_code}: {response.text[:200]}")
        except Exception as e:
            logger.warning(f"[llm-proxy] Budget check failed: {e}")

        # Default: no budget limits
        return {"over_budget": False, "effective_budget_usd": None, "budget_action": "warn"}

    def _extract_sse_usage_chunk(self, sse_body: bytes, provider: str = "") -> Optional[bytes]:
        """Extract token usage from an SSE response body.

        For Anthropic: merges input tokens (message_start) + output tokens (message_delta)
        since they arrive in separate events.

        For all others: reverse-scans for the last data line with usage fields
        (OpenAI's final chunk or response.completed event contains full usage).
        Returns synthesised JSON bytes, or None if no usage found.
        """
        import json as _json
        try:
            text = sse_body.decode("utf-8", errors="replace")
            lines = text.splitlines()

            if provider == "anthropic":
                # Anthropic SSE splits usage across two events:
                #   message_start → input_tokens, cache_read_input_tokens, model
                #   message_delta → output_tokens
                # Scan all lines and merge.
                input_tokens = 0
                output_tokens = 0
                cached_tokens = 0
                model_id = ""
                for line in lines:
                    if not line.startswith("data: "):
                        continue
                    try:
                        chunk = _json.loads(line[6:])
                        t = chunk.get("type", "")
                        if t == "message_start":
                            msg = chunk.get("message", {})
                            model_id = msg.get("model", model_id)
                            usage = msg.get("usage", {})
                            input_tokens = usage.get("input_tokens", input_tokens)
                            cached_tokens = usage.get("cache_read_input_tokens", cached_tokens)
                        elif t == "message_delta":
                            usage = chunk.get("usage", {})
                            output_tokens = usage.get("output_tokens", output_tokens)
                    except Exception:
                        pass
                if input_tokens or output_tokens:
                    return _json.dumps({
                        "model": model_id,
                        "usage": {
                            "input_tokens": input_tokens,
                            "output_tokens": output_tokens,
                            "cache_read_input_tokens": cached_tokens,
                        },
                    }).encode()
                return None

            # Default: reverse-scan for last data line with usage fields.
            # Works for OpenAI Chat (final chunk), OpenAI Responses API
            # (response.completed event), Gemini, Groq, Mistral, Cohere, Ollama.
            usage_keys = ("prompt_tokens", "input_tokens", "output_tokens", "usageMetadata", "prompt_eval_count", "response.completed")
            for line in reversed(lines):
                if line.startswith("data: ") and line != "data: [DONE]":
                    json_str = line[6:]
                    if any(k in json_str for k in usage_keys):
                        return json_str.encode("utf-8")
        except Exception:
            pass
        return None

    async def get_http_client(self) -> httpx.AsyncClient:
        """Get or create shared HTTP client."""
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(
                timeout=120.0,  # LLM calls can be slow
                headers={"User-Agent": "SecureVector-LLM-Proxy/1.0"}
            )
        return self._http_client

    async def check_settings(self) -> dict:
        """Check SecureVector settings (cached for 10s)."""
        import time
        now = time.time()
        if self._output_scan_enabled is not None and (now - self._settings_checked_at) < 10:
            return {
                "scan_llm_responses": self._output_scan_enabled,
                "block_threats": self._block_threats_enabled or self.block_threats,
                "cloud_mode_enabled": self._cloud_mode_enabled or False,
                "cloud_api_key": self._cloud_api_key,
                "tool_permissions_enabled": self._tool_permissions_enabled or False,
            }

        try:
            client = await self.get_http_client()
            response = await client.get(self.settings_url)
            if response.status_code == 200:
                settings = response.json()
                self._output_scan_enabled = settings.get("scan_llm_responses", True)
                self._block_threats_enabled = settings.get("block_threats", False)
                self._tool_permissions_enabled = settings.get("tool_permissions_enabled", False)
                self._settings_checked_at = now

            # Check cloud mode and get API key directly from credentials file
            try:
                cloud_resp = await client.get(f"{self.securevector_url}/api/settings/cloud")
                if cloud_resp.status_code == 200:
                    cloud_settings = cloud_resp.json()
                    self._cloud_mode_enabled = cloud_settings.get("cloud_mode_enabled", False)
                    if self._cloud_mode_enabled and cloud_settings.get("credentials_configured"):
                        from securevector.app.services.credentials import get_api_key
                        self._cloud_api_key = get_api_key()
            except Exception:
                pass

            return {
                "scan_llm_responses": self._output_scan_enabled,
                "block_threats": self._block_threats_enabled,
                "cloud_mode_enabled": self._cloud_mode_enabled or False,
                "cloud_api_key": self._cloud_api_key,
                "tool_permissions_enabled": self._tool_permissions_enabled or False,
            }
        except Exception as e:
            if self.verbose:
                logger.warning(f"Could not check settings: {e}")

        return {"scan_llm_responses": True, "block_threats": self.block_threats, "cloud_mode_enabled": False, "cloud_api_key": None, "tool_permissions_enabled": False}

    async def _scan_cloud_direct(self, text: str, api_key: str, action_taken: str = "logged") -> Optional[dict]:
        """Scan directly via cloud API (scan.securevector.io), skipping localhost hop.

        Returns scan result dict on success, None on failure (caller should fallback to local).
        """
        try:
            client = await self.get_http_client()
            payload = {"prompt": text, "user_tier": "professional"}
            response = await client.post(
                "https://scan.securevector.io/analyze",
                json=payload,
                headers={"X-Api-Key": api_key},
                timeout=5.0,
            )
            if response.status_code == 200:
                raw = response.json()
                # Map cloud response to local format
                verdict = raw.get("verdict", "").upper()
                is_threat = verdict in ("BLOCK", "WARN", "REVIEW")
                threat_score = raw.get("threat_score", 0)
                risk_score = int(threat_score * 100) if threat_score <= 1 else int(threat_score)

                threat_type = None
                analysis = raw.get("analysis", {})
                if analysis.get("ml_category"):
                    threat_type = analysis["ml_category"]
                elif raw.get("matched_rules"):
                    threat_type = raw["matched_rules"][0].get("category")

                result = {
                    "is_threat": is_threat,
                    "threat_type": threat_type or raw.get("threat_level"),
                    "risk_score": risk_score,
                    "confidence": raw.get("confidence_score", 0.0),
                    "action_taken": action_taken,
                    "analysis_source": "cloud",
                }

                # Store threat in local DB via /analyze (fire-and-forget for recording only)
                if is_threat:
                    try:
                        scan_payload = {
                            "text": text,
                            "metadata": {
                                "source": "llm-proxy",
                                "target": self.target_url,
                                "scan_type": "input",
                                "action_taken": action_taken,
                            }
                        }
                        await client.post(self.analyze_url, json=scan_payload, timeout=3.0)
                    except Exception:
                        pass  # Recording failure is non-critical

                return result
            elif response.status_code == 401:
                logger.warning("[llm-proxy] Cloud API key invalid, falling back to local")
                return None
            else:
                logger.warning(f"[llm-proxy] Cloud API error {response.status_code}, falling back to local")
                return None
        except Exception as e:
            logger.warning(f"[llm-proxy] Cloud direct scan failed ({type(e).__name__}), falling back to local")
            return None

    async def scan_message(self, text: str, is_llm_response: bool = False, action_taken: str = "logged") -> dict:
        """Scan a message with SecureVector API.

        When cloud mode is enabled, scans directly via cloud API (skipping localhost hop).
        Falls back to local /analyze if cloud fails.

        On scan failure: if block mode is ON, fails closed (treats as threat)
        to prevent unscanned content from passing through. If block mode is
        OFF, fails open (treats as clean) for availability.
        """
        if not text:
            return {"is_threat": False}

        # Strip metadata prefix to avoid false positives (user IDs trigger PII detection)
        scan_text = self._strip_metadata_prefix(text)

        # Truncate if text exceeds analyzer's limit (102,400 chars)
        MAX_SCAN_LENGTH = 102400
        if len(scan_text) > MAX_SCAN_LENGTH:
            if self.verbose:
                logger.info(f"[llm-proxy] Text too long ({len(scan_text)} chars), truncating to {MAX_SCAN_LENGTH} for scan")
            scan_text = scan_text[:MAX_SCAN_LENGTH]

        # When cloud mode is on, scan directly via cloud API (no localhost hop)
        settings = await self.check_settings()
        skip_cloud = False
        cloud_api_key = settings.get("cloud_api_key")
        if settings.get("cloud_mode_enabled") and cloud_api_key and not is_llm_response:
            cloud_result = await self._scan_cloud_direct(scan_text, cloud_api_key, action_taken)
            if cloud_result is not None:
                return cloud_result
            # Cloud failed — fall through to local scan (skip cloud in /analyze to avoid double timeout)
            logger.info("[llm-proxy] Cloud direct scan failed, falling back to local /analyze")
            skip_cloud = True

        scan_payload = {
            "text": scan_text,
            "llm_response": is_llm_response,
            "metadata": {
                "source": "llm-proxy",
                "target": self.target_url,
                "scan_type": "output" if is_llm_response else "input",
                "action_taken": action_taken,
                "skip_cloud": skip_cloud,
            }
        }

        # Try scan with one retry on failure
        last_error = None
        for attempt in range(2):
            try:
                client = await self.get_http_client()
                response = await client.post(
                    self.analyze_url,
                    json=scan_payload,
                    timeout=10.0,
                )
                if response.status_code == 200:
                    return response.json()
                else:
                    last_error = f"HTTP {response.status_code}: {response.text[:200]}"
            except httpx.ConnectError:
                last_error = f"cannot connect to {self.analyze_url} - is securevector-app running?"
            except Exception as e:
                last_error = f"{type(e).__name__}: {e or repr(e)}"

            if attempt == 0:
                # Brief pause before retry
                await asyncio.sleep(0.3)

        # Both attempts failed
        logger.warning(f"SecureVector scan error (after retry): {last_error}")

        # Fail-closed when block mode is ON: treat scan failure as threat
        if not settings:
            settings = await self.check_settings()
        if settings.get("block_threats"):
            logger.warning("[llm-proxy] Block mode ON + scan failed → failing closed (blocking)")
            return {
                "is_threat": True,
                "threat_type": "scan_unavailable",
                "risk_score": 100,
                "scan_error": True,
            }

        # Fail-open when block mode is OFF: log only, allow through
        return {"is_threat": False}

    @staticmethod
    def _strip_metadata_prefix(text: str) -> str:
        """Strip OpenClaw metadata prefix from message text.

        OpenClaw wraps messages like: [Telegram Username id:123456 +2m 2026-02-09 16:05 CST] actual message
        The metadata (user IDs, timestamps) can trigger false positive PII detection.
        Returns the actual message content without the prefix.
        """
        import re
        # Match [Platform Username id:NNNNN ...] prefix
        stripped = re.sub(r'^\[(?:Telegram|Discord|Slack|WhatsApp|Web)\s+.*?\]\s*', '', text, count=1)
        return stripped if stripped else text

    def _extract_content_parts(self, content) -> list:
        """Extract text from content that can be a string or structured list."""
        texts = []
        if isinstance(content, str):
            texts.append(content)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, str):
                    texts.append(part)
                elif isinstance(part, dict):
                    # Covers: {type: "text", text: "..."} (OpenAI/Anthropic)
                    #         {type: "input_text", text: "..."} (Responses API)
                    if part.get("type") in ("text", "input_text"):
                        texts.append(part.get("text", ""))
                    # Gemini: {text: "..."}
                    elif "text" in part and "type" not in part:
                        texts.append(part["text"])
        return texts

    # --- Sensitive token patterns for context-aware output scanning ---
    _SENSITIVE_TOKEN_PATTERNS = re.compile(
        r'|'.join([
            r'sk-[a-zA-Z0-9]{20,}',                         # OpenAI keys
            r'sk_(?:test|live)_[a-zA-Z0-9]{20,}',           # Stripe keys
            r'pk_(?:test|live)_[a-zA-Z0-9]{20,}',           # Stripe public keys
            r'rk_(?:test|live)_[a-zA-Z0-9]{20,}',           # Stripe restricted keys
            r'ghp_[a-zA-Z0-9]{36}',                          # GitHub PAT
            r'gho_[a-zA-Z0-9]{36}',                          # GitHub OAuth
            r'github_pat_[a-zA-Z0-9_]{22,}',                 # GitHub fine-grained PAT
            r'xox[baprs]-[a-zA-Z0-9\-]{10,}',               # Slack tokens
            r'AKIA[A-Z0-9]{16}',                              # AWS access key
            r'AIza[a-zA-Z0-9_\-]{35}',                       # Google API key
            r'eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}',   # JWT tokens
            r'(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token)[:\s]*[\'"]?[a-zA-Z0-9_\-]{20,}',
            r'(?:password|passwd|pwd)\s*(?:[:=]|\bis\b)[:\s]*[\'"]?[^\s\'"]{8,64}[\'"]?',
            r'bearer\s+[a-zA-Z0-9_\-\.]{20,}',
        ]),
        re.IGNORECASE,
    )

    def extract_all_context_text(self, body: dict) -> str:
        """Extract ALL text from the full request body (all messages, system prompt, etc.).

        Used for context-aware output scanning: tokens already present in the
        conversation input should not trigger output leakage alerts.
        """
        texts = []

        # System prompt
        if "system" in body and isinstance(body["system"], str):
            texts.append(body["system"])

        # All messages (full conversation history)
        if "messages" in body:
            for msg in body["messages"]:
                if isinstance(msg, dict):
                    texts.extend(self._extract_content_parts(msg.get("content", "")))

        # OpenAI Responses API
        elif "input" in body:
            inp = body["input"]
            if isinstance(inp, str):
                texts.append(inp)
            elif isinstance(inp, list):
                for item in inp:
                    if isinstance(item, str):
                        texts.append(item)
                    elif isinstance(item, dict):
                        texts.extend(self._extract_content_parts(item.get("content", "")))

        # Google Gemini
        elif "contents" in body:
            for content_item in body["contents"]:
                if isinstance(content_item, dict):
                    for part in content_item.get("parts", []):
                        if isinstance(part, dict) and "text" in part:
                            texts.append(part["text"])

        # Cohere chat_history
        if "chat_history" in body:
            for msg in body["chat_history"]:
                if isinstance(msg, dict) and "message" in msg:
                    texts.append(msg["message"])

        # Single message fields
        for key in ("message", "prompt", "text"):
            if key in body and isinstance(body[key], str):
                texts.append(body[key])

        return "\n".join(t for t in texts if t)

    def strip_echoed_sensitive_tokens(self, output_text: str, input_context: str) -> str:
        """Remove sensitive tokens from output that already exist in the input context.

        This prevents false positives when the LLM echoes back API keys, passwords,
        or other sensitive patterns that were already present in the conversation
        history. Only NEW sensitive tokens (not in input) should be flagged.
        """
        if not input_context or not output_text:
            return output_text

        # Find all sensitive tokens in the input context
        input_tokens = set(self._SENSITIVE_TOKEN_PATTERNS.findall(input_context))
        if not input_tokens:
            return output_text

        # Remove those same tokens from output before scanning
        cleaned = output_text
        for token in input_tokens:
            cleaned = cleaned.replace(token, "[CONTEXT]")

        return cleaned

    def extract_messages_text(self, body: dict) -> str:
        """Extract the LAST user message from any LLM API request body.

        Only scans the incoming user prompt, not the system prompt or
        conversation history. This keeps scans fast and focused on the
        actual new input.
        """
        texts = []

        # --- OpenAI Chat Completions / Anthropic Messages / Mistral / Groq / xAI / DeepSeek etc. ---
        if "messages" in body:
            # Find the last user message only
            for msg in reversed(body["messages"]):
                if isinstance(msg, dict) and msg.get("role") == "user":
                    texts.extend(self._extract_content_parts(msg.get("content", "")))
                    break

        # --- OpenAI Responses API ---
        elif "input" in body:
            inp = body["input"]
            if isinstance(inp, str):
                texts.append(inp)
            elif isinstance(inp, list):
                # Find the last user item
                for item in reversed(inp):
                    if isinstance(item, str):
                        texts.append(item)
                        break
                    elif isinstance(item, dict) and item.get("role") == "user":
                        texts.extend(self._extract_content_parts(item.get("content", "")))
                        break

        # --- Google Gemini ---
        elif "contents" in body:
            # Find the last user turn
            for content_item in reversed(body["contents"]):
                if isinstance(content_item, dict) and content_item.get("role") == "user":
                    for part in content_item.get("parts", []):
                        if isinstance(part, dict) and "text" in part:
                            texts.append(part["text"])
                    break

        # --- Cohere ---
        elif "message" in body and isinstance(body["message"], str):
            texts.append(body["message"])

        # --- Ollama / Legacy Anthropic ---
        elif "prompt" in body and isinstance(body["prompt"], str):
            texts.append(body["prompt"])

        # --- Direct text ---
        elif "text" in body and isinstance(body["text"], str):
            texts.append(body["text"])

        return "\n".join(t for t in texts if t)

    async def _load_tool_overrides(self) -> dict:
        """Fetch essential tool overrides from SecureVector API (cached for 5s)."""
        import time
        now = time.time()
        if self._tool_overrides is not None and (now - self._tool_overrides_checked_at) < 5:
            return self._tool_overrides

        try:
            client = await self.get_http_client()
            response = await client.get(
                f"{self.securevector_url}/api/tool-permissions/overrides",
                timeout=3.0,
            )
            if response.status_code == 200:
                from securevector.core.tool_permissions.engine import get_essential_overrides
                overrides_list = response.json().get("overrides", [])
                self._tool_overrides = get_essential_overrides(overrides_list)
                self._tool_overrides_checked_at = now
                return self._tool_overrides
        except Exception as e:
            if self.verbose:
                logger.warning(f"[llm-proxy] Could not fetch tool overrides: {e}")

        return self._tool_overrides or {}

    def _load_essential_registry(self) -> dict:
        """Lazy-load the essential tool registry."""
        if self._essential_registry is None:
            from securevector.core.tool_permissions.engine import load_essential_registry
            self._essential_registry = load_essential_registry()
        return self._essential_registry

    async def _load_custom_tools_registry(self) -> dict:
        """Fetch custom tools from SecureVector API (cached for 5s)."""
        import time
        now = time.time()
        if self._custom_tools_registry is not None and (now - self._custom_tools_checked_at) < 5:
            return self._custom_tools_registry

        try:
            client = await self.get_http_client()
            response = await client.get(
                f"{self.securevector_url}/api/tool-permissions/custom",
                timeout=3.0,
            )
            if response.status_code == 200:
                tools_list = response.json().get("tools", [])
                self._custom_tools_registry = {
                    t["tool_id"]: t for t in tools_list if "tool_id" in t
                }
                self._custom_tools_checked_at = now
                return self._custom_tools_registry
        except Exception as e:
            if self.verbose:
                logger.warning(f"[llm-proxy] Could not fetch custom tools: {e}")

        return self._custom_tools_registry or {}

    async def _evaluate_tool_permissions(self, response_dict: dict, settings: dict) -> tuple:
        """Evaluate tool call permissions in an LLM response.

        Returns:
            Tuple of (modified_response_dict, blocked_tools, decisions).
            modified_response_dict has blocked tool calls stripped.
            blocked_tools is a list of blocked tool names.
            decisions is a list of all PermissionDecision objects.
        """
        from securevector.core.tool_permissions.parser import extract_tool_calls
        from securevector.core.tool_permissions.engine import (
            evaluate_tool_call, get_risk_score,
        )

        tool_calls = extract_tool_calls(response_dict)
        if not tool_calls:
            return response_dict, [], []

        registry = self._load_essential_registry()
        overrides = await self._load_tool_overrides()
        custom_registry = await self._load_custom_tools_registry()

        decisions = []
        blocked_tools = []
        blocked_indices_openai = set()  # (choice_idx, tc_idx) for OpenAI
        blocked_indices_anthropic = set()  # content block indices for Anthropic

        for tc in tool_calls:
            decision = evaluate_tool_call(tc.function_name, registry, overrides, custom_registry)

            # Rate limit check for allowed tools (essential + custom)
            if decision.action == "allow":
                max_calls = None
                window_secs = None
                rate_limit_api_prefix = None

                if decision.is_essential:
                    # Essential tools: rate limits stored in overrides (fetched via API)
                    rate_limit_api_prefix = f"/api/tool-permissions/overrides/{tc.function_name}"
                elif custom_registry:
                    custom_tool = custom_registry.get(tc.function_name)
                    if custom_tool:
                        max_calls = custom_tool.get("rate_limit_max_calls")
                        window_secs = custom_tool.get("rate_limit_window_seconds")
                        rate_limit_api_prefix = f"/api/tool-permissions/custom/{tc.function_name}"

                # Check rate limit via API (works for both essential and custom)
                if rate_limit_api_prefix:
                    try:
                        client = await self.get_http_client()
                        count_resp = await client.get(
                            f"{self.securevector_url}{rate_limit_api_prefix}/rate-limit",
                            timeout=3.0,
                        )
                        if count_resp.status_code == 200:
                            rl_data = count_resp.json()
                            # Use API response for authoritative rate limit data
                            rl_max = rl_data.get("max_calls")
                            rl_window = rl_data.get("window_seconds")
                            current_count = rl_data.get("current_count", 0)

                            if rl_max and rl_window and current_count >= rl_max:
                                if rl_window >= 3600:
                                    window_display = f"{rl_window // 3600} hour(s)"
                                elif rl_window >= 60:
                                    window_display = f"{rl_window // 60} minute(s)"
                                else:
                                    window_display = f"{rl_window} seconds"

                                decision.action = "block"
                                decision.reason = (
                                    f"Rate limited: {current_count}/{rl_max} calls "
                                    f"in the last {window_display}"
                                )
                    except Exception as e:
                        if self.verbose:
                            logger.warning(f"[llm-proxy] Rate limit check failed for {tc.function_name}: {e}")

            decisions.append(decision)

            if decision.action == "block":
                blocked_tools.append(tc.function_name)
                if tc.provider_format == "openai":
                    blocked_indices_openai.add(tc.index)
                elif tc.provider_format == "anthropic":
                    blocked_indices_anthropic.add(tc.index)

                args_preview = (tc.arguments or "")[:200]
                print(f"[llm-proxy] ┌─ 🔒 BLOCKED ──────────────────────────────────────")
                print(f"[llm-proxy] │  tool   : {tc.function_name}")
                print(f"[llm-proxy] │  reason : {decision.reason}")
                print(f"[llm-proxy] │  args   : {args_preview}")
                print(f"[llm-proxy] └────────────────────────────────────────────────────")
            else:
                # Log allowed tool calls for rate limiting (essential + custom)
                if decision.action == "allow" and decision.tool_name:
                    log_prefix = (
                        f"/api/tool-permissions/overrides/{tc.function_name}"
                        if decision.is_essential
                        else f"/api/tool-permissions/custom/{tc.function_name}"
                    )
                    try:
                        client = await self.get_http_client()
                        await client.post(
                            f"{self.securevector_url}{log_prefix}/log-call",
                            timeout=3.0,
                        )
                    except Exception:
                        pass  # Logging failure is non-critical

                action_label = "allowed" if decision.action == "allow" else "logged"
                if decision.is_essential or (decision.tool_name and decision.action == "allow"):
                    args_preview = (tc.arguments or "")[:200]
                    print(f"[llm-proxy] ┌─ ✓ {action_label.upper()} ──────────────────────────────────────")
                    print(f"[llm-proxy] │  tool   : {tc.function_name}")
                    print(f"[llm-proxy] │  args   : {args_preview}")
                    print(f"[llm-proxy] └────────────────────────────────────────────────────")

        # Log ALL tool call decisions (block + allow + log_only) to audit log
        for tc, decision in zip(tool_calls, decisions):
            try:
                audit_payload = {
                    "tool_id":       decision.tool_name or decision.function_name,
                    "function_name": decision.function_name,
                    "action":        decision.action,
                    "risk":          decision.risk,
                    "reason":        decision.reason,
                    "is_essential":  decision.is_essential,
                    "args_preview":  (tc.arguments or "")[:200],
                }
                client = await self.get_http_client()
                await client.post(
                    f"{self.securevector_url}/api/tool-permissions/call-audit",
                    json=audit_payload,
                    timeout=3.0,
                )
            except Exception:
                pass  # Audit logging failure is non-critical

        # Periodic cleanup of old call log entries (every 100 requests)
        self._request_counter += 1
        if self._request_counter % 100 == 0:
            try:
                client = await self.get_http_client()
                await client.post(
                    f"{self.securevector_url}/api/tool-permissions/cleanup-call-log",
                    timeout=3.0,
                )
            except Exception:
                pass

        # If ALL tool calls are blocked, replace with text denial
        if blocked_tools and len(blocked_tools) == len(tool_calls):
            # Build denial message — include rate limit details when applicable
            rate_limited = [d for d in decisions if "Rate limited" in d.reason]
            if rate_limited:
                rl = rate_limited[0]
                denial_msg = (
                    f"[SecureVector] Tool '{rl.function_name}' rate limited: {rl.reason}. "
                    f"Retry after the window resets. This limit protects against provider TOS violations."
                )
            else:
                names = ", ".join(blocked_tools)
                denial_msg = (
                    f"[SecureVector] Tool call blocked by policy: {names}. "
                    f"This is a security policy decision — not a capability limitation. "
                    f"The tool can be enabled in SecureVector settings."
                )
            # Replace response with text-only message
            if "choices" in response_dict:
                for choice in response_dict.get("choices", []):
                    if isinstance(choice, dict) and "message" in choice:
                        choice["message"] = {
                            "role": "assistant",
                            "content": denial_msg,
                        }
            elif "content" in response_dict and isinstance(response_dict["content"], list):
                response_dict["content"] = [
                    {"type": "text", "text": denial_msg}
                ]
            return response_dict, blocked_tools, decisions

        # Strip only blocked tool calls (partial block)
        if blocked_indices_openai:
            for choice in response_dict.get("choices", []):
                if isinstance(choice, dict) and "message" in choice:
                    msg = choice["message"]
                    if isinstance(msg, dict) and "tool_calls" in msg:
                        msg["tool_calls"] = [
                            tc for i, tc in enumerate(msg["tool_calls"])
                            if i not in blocked_indices_openai
                        ]
                        if not msg["tool_calls"]:
                            del msg["tool_calls"]

        if blocked_indices_anthropic:
            content = response_dict.get("content", [])
            if isinstance(content, list):
                response_dict["content"] = [
                    block for i, block in enumerate(content)
                    if i not in blocked_indices_anthropic
                ]

        return response_dict, blocked_tools, decisions

    def extract_response_text(self, body: dict) -> str:
        """Extract text content from any LLM API response body.

        Handles both non-streaming (full response) and streaming (SSE chunk)
        formats for all providers.
        """
        texts = []

        # --- OpenAI Chat Completions / Mistral / Groq / xAI / DeepSeek etc. ---
        # Non-streaming: {"choices": [{"message": {"content": "..."}}]}
        # Streaming:     {"choices": [{"delta": {"content": "..."}}]}
        if "choices" in body:
            for choice in body["choices"]:
                if isinstance(choice, dict):
                    msg = choice.get("message", {})
                    if isinstance(msg, dict) and msg.get("content"):
                        texts.append(msg["content"])
                    delta = choice.get("delta", {})
                    if isinstance(delta, dict) and delta.get("content"):
                        texts.append(delta["content"])

        # --- OpenAI Responses API ---
        # Non-streaming: {"output": [{"type": "message", "content": [{"type": "output_text", "text": "..."}]}]}
        # Streaming:     {"type": "response.output_text.delta", "delta": "..."} (delta is a STRING)
        if "output" in body:
            for item in body.get("output", []):
                if isinstance(item, dict):
                    if item.get("type") == "output_text":
                        texts.append(item.get("text", ""))
                    if item.get("type") == "message":
                        for part in item.get("content", []):
                            if isinstance(part, dict) and part.get("type") == "output_text":
                                texts.append(part.get("text", ""))

        # Responses API streaming delta (delta is a string, not dict)
        if "delta" in body and isinstance(body.get("delta"), str):
            texts.append(body["delta"])

        # --- Anthropic Messages API ---
        # Non-streaming: {"content": [{"type": "text", "text": "..."}]}
        # Streaming:     {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "..."}}
        if "content" in body and isinstance(body["content"], list) and "output" not in body and "choices" not in body:
            for item in body["content"]:
                if isinstance(item, dict) and item.get("type") == "text":
                    texts.append(item.get("text", ""))

        # Anthropic streaming: delta is a DICT with type "text_delta"
        if "delta" in body and isinstance(body.get("delta"), dict):
            delta = body["delta"]
            if delta.get("type") == "text_delta" and delta.get("text"):
                texts.append(delta["text"])

        # --- Google Gemini ---
        # Non-streaming & streaming: {"candidates": [{"content": {"parts": [{"text": "..."}]}}]}
        if "candidates" in body:
            for candidate in body["candidates"]:
                if isinstance(candidate, dict):
                    content = candidate.get("content", {})
                    if isinstance(content, dict):
                        for part in content.get("parts", []):
                            if isinstance(part, dict) and "text" in part:
                                texts.append(part["text"])

        # --- Cohere ---
        # {"text": "..."}
        if "text" in body and isinstance(body["text"], str) and "choices" not in body and "candidates" not in body:
            texts.append(body["text"])

        # --- Ollama ---
        # Generate: {"response": "..."}
        # Chat:     {"message": {"content": "..."}}
        if "response" in body and isinstance(body["response"], str):
            texts.append(body["response"])
        if "message" in body and isinstance(body["message"], dict):
            content = body["message"].get("content", "")
            if content:
                texts.append(content)

        # --- Legacy Anthropic ---
        # {"completion": "..."}
        if "completion" in body:
            texts.append(body["completion"])

        return "\n".join(t for t in texts if t)

    async def handle_request(self, request: Request) -> Response:
        """Handle incoming request, scan, and forward to LLM provider."""
        agent_id = self._extract_agent_id(request)
        path = request.url.path
        method = request.method

        # Clean up path: remove extra spaces, normalize slashes
        path = path.replace("  ", "/").replace(" /", "/").replace("/ ", "/")

        # Strip provider prefix if present (e.g., /ollama/v1/models → /v1/models)
        # This handles cases where client includes provider in path
        provider_prefix = f"/{self.provider}"
        if path.startswith(provider_prefix):
            path = path[len(provider_prefix):]
            if not path.startswith("/"):
                path = "/" + path

        # Remove double slashes
        while "//" in path:
            path = path.replace("//", "/")

        # Read request body
        body_bytes = await request.body()
        body_text = body_bytes.decode("utf-8", errors="replace") if body_bytes else ""

        # Refine agent_id if no explicit x-agent-id was provided (still an IP fallback)
        if agent_id.startswith("client:"):
            ua = request.headers.get("user-agent", "").lower()
            if "openclaw" in ua or "clawdbot" in ua:
                agent_id = "openclaw"
            elif body_bytes:
                try:
                    model = json.loads(body_bytes).get("model", "")
                    if model:
                        agent_id = model
                except Exception:
                    pass
            if agent_id.startswith("client:"):
                agent_id = "local-agent"

        print(f"[llm-proxy] → {method} {path}")

        # Budget check (only for POST to LLM endpoints)
        if method == "POST":
            budget_status = await self._check_budget(agent_id)
            if budget_status.get("over_budget") and budget_status.get("effective_budget_usd") is not None:
                budget_action = budget_status.get("budget_action", "warn")
                spend = budget_status.get("today_spend_usd", 0)
                limit = budget_status.get("effective_budget_usd", 0)
                msg = f"Daily budget of ${limit:.4f} exceeded (spent ${spend:.4f} today)"
                if budget_action == "block":
                    print(f"[llm-proxy] 💸 BUDGET EXCEEDED — blocking: {msg}")
                    # Invalidate cache so next check re-evaluates
                    self._budget_cache.pop(agent_id, None)
                    return Response(
                        content=json.dumps({
                            "error": {
                                "message": f"[SecureVector] {msg}. Request blocked.",
                                "type": "budget_exceeded",
                                "code": "budget_exceeded",
                            }
                        }),
                        status_code=429,
                        media_type="application/json",
                    )
                else:
                    print(f"[llm-proxy] ⚠️  BUDGET WARNING: {msg}")

        # Parse body for scanning
        body_dict = {}
        if body_text:
            try:
                body_dict = json.loads(body_text)
            except json.JSONDecodeError:
                pass

        # Extract full conversation context for context-aware output scanning
        input_context = self.extract_all_context_text(body_dict) if body_dict else ""

        # Scan input messages
        if body_dict and method == "POST":
            input_text = self.extract_messages_text(body_dict)
            # Strip client metadata tags (e.g. OpenClaw [message_id: ...]) to avoid false positives
            input_text = re.sub(r'\[message_id:\s*[^\]]+\]', '', input_text).strip()
            if input_text:
                self.stats["scanned"] += 1
                preview = input_text[:200].replace('\n', ' ')
                print(f"[llm-proxy] 🔍 Scanning input ({len(input_text)} chars): {preview}...")

                # Check block mode first to record correct action
                settings = await self.check_settings()
                will_block = settings.get("block_threats", False)
                action = "blocked" if will_block else "logged"

                result = await self.scan_message(input_text, is_llm_response=False, action_taken=action)

                if result.get("is_threat"):
                    self.stats["threats_detected"] += 1
                    threat_type = result.get("threat_type", "unknown")
                    risk_score = result.get("risk_score", 0)

                    if result.get("scan_error"):
                        print(f"[llm-proxy] ⚠️  SCAN FAILED - blocking (fail-closed, block mode ON)")
                    else:
                        print(f"[llm-proxy] ⚠️  THREAT DETECTED: {threat_type} (risk: {risk_score}%)")

                    # Block if enabled
                    if will_block:
                        self.stats["blocked"] += 1
                        print(f"[llm-proxy] 🚫 BLOCKED - not forwarding to LLM")

                        if result.get("scan_error"):
                            msg = "Request blocked by SecureVector: scan service unavailable (fail-closed mode)"
                            code = "scan_unavailable_blocked"
                        else:
                            msg = f"Request blocked by SecureVector: {threat_type} detected (risk: {risk_score}%)"
                            code = "blocked_by_securevector"

                        error_response = {
                            "error": {
                                "message": msg,
                                "type": "security_error",
                                "code": code,
                            }
                        }
                        return Response(
                            content=json.dumps(error_response),
                            status_code=400,
                            media_type="application/json",
                        )
                else:
                    print(f"[llm-proxy] ✓ Input clean - forwarding to {self.target_url}")
        else:
            if self.verbose:
                logger.info(f"[llm-proxy] Non-POST request, skipping scan")

        # Build headers for upstream request
        # Pass through all headers including auth (OpenClaw sends them)
        headers = dict(request.headers)
        headers.pop("host", None)
        headers.pop("content-length", None)

        # Debug: log auth headers (masked)
        auth_keys = [k for k in headers if k.lower() in ("x-api-key", "authorization")]
        for k in auth_keys:
            val = headers[k]
            masked = val[:12] + "..." + val[-4:] if len(val) > 20 else "(short/empty)"
            print(f"[llm-proxy] Auth header: {k}={masked}")

        # Auto-prepend API version prefix if missing from path
        # e.g. /responses → /v1/responses for OpenAI
        if self.api_prefix and not path.startswith(self.api_prefix):
            path = self.api_prefix + path
            if self.verbose:
                print(f"[llm-proxy] Auto-prepended {self.api_prefix} → {path}")

        # Forward request to LLM provider
        target = f"{self.target_url}{path}"

        # Special handling for Gemini: API key must be in query parameter, not header
        if self.provider == "gemini":
            api_key = None

            # Try to get API key from Authorization header first
            auth_header = headers.get("authorization", "")
            if auth_header.startswith("Bearer "):
                api_key = auth_header[7:]  # Remove "Bearer " prefix
            elif auth_header.startswith("bearer "):
                api_key = auth_header[7:]  # Handle lowercase

            # Fall back to environment variables
            if not api_key:
                api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")

            # Append API key as query parameter (required by Gemini)
            if api_key:
                separator = "&" if "?" in target or request.url.query else "?"
                target += f"{separator}key={api_key}"
                # Remove Authorization header - Gemini doesn't use it
                headers.pop("authorization", None)
            else:
                logger.warning("[llm-proxy] No Gemini API key found. Set GEMINI_API_KEY or GOOGLE_API_KEY environment variable, or pass via Authorization header.")

        # Add original query string for non-Gemini providers
        if request.url.query and self.provider != "gemini":
            target += f"?{request.url.query}"

        try:
            client = await self.get_http_client()

            # Check if streaming
            is_streaming = body_dict.get("stream", False)

            if is_streaming:
                # Handle streaming response
                return await self.handle_streaming_request(
                    client, method, target, headers, body_bytes,
                    input_context=input_context,
                    agent_id=agent_id,
                )
            else:
                # Handle regular request
                response = await client.request(
                    method=method,
                    url=target,
                    headers=headers,
                    content=body_bytes,
                )

                # Scan response for output threats
                response_text = response.text
                if response.status_code == 200 and response_text:
                    try:
                        response_dict = json.loads(response_text)
                        output_text = self.extract_response_text(response_dict)
                        if output_text:
                            settings = await self.check_settings()
                            if settings.get("scan_llm_responses"):
                                # Strip sensitive tokens that are echoed from input context
                                scan_text = self.strip_echoed_sensitive_tokens(output_text, input_context)
                                will_block = settings.get("block_threats", False)
                                action = "blocked" if will_block else "logged"
                                result = await self.scan_message(scan_text, is_llm_response=True, action_taken=action)
                                if result.get("is_threat"):
                                    threat_type = result.get("threat_type", "unknown")
                                    risk_score = result.get("risk_score", 0)
                                    print(f"[llm-proxy] ⚠️ OUTPUT THREAT: {threat_type} (risk: {risk_score}%)")

                                    # Block output if block mode is enabled
                                    if will_block:
                                        self.stats["blocked"] += 1
                                        print(f"[llm-proxy] 🚫 OUTPUT BLOCKED - not delivering to client")
                                        error_response = {
                                            "error": {
                                                "message": f"Response blocked by SecureVector: {threat_type} detected in LLM output (risk: {risk_score}%)",
                                                "type": "security_error",
                                                "code": "output_blocked_by_securevector",
                                            }
                                        }
                                        return Response(
                                            content=json.dumps(error_response),
                                            status_code=400,
                                            media_type="application/json",
                                        )
                        # Tool permission enforcement (after output scan)
                        settings = await self.check_settings()
                        if settings.get("tool_permissions_enabled"):
                            response_dict, blocked, _ = await self._evaluate_tool_permissions(
                                response_dict, settings
                            )
                            if blocked:
                                # Return modified response with blocked tools stripped
                                modified_content = json.dumps(response_dict)
                                return Response(
                                    content=modified_content.encode(),
                                    status_code=response.status_code,
                                    headers=dict(response.headers),
                                )
                    except json.JSONDecodeError:
                        pass

                # Record cost (fire-and-forget, never blocks the response)
                if response.status_code == 200 and response.content:
                    asyncio.create_task(
                        self._record_cost(self.provider, agent_id, response.content)
                    )

                # Strip encoding headers: httpx auto-decompresses the body
                # but keeps content-encoding in headers; forwarding both
                # causes downstream clients to try double-decompression.
                resp_headers = dict(response.headers)
                resp_headers.pop("content-encoding", None)
                resp_headers.pop("content-length", None)
                resp_headers.pop("transfer-encoding", None)

                return Response(
                    content=response.content,
                    status_code=response.status_code,
                    headers=resp_headers,
                )

        except httpx.RequestError as e:
            # Log type only — avoid exposing full URL which may contain API keys (e.g. Gemini key= param)
            logger.error(f"[llm-proxy] Request error ({type(e).__name__}): failed to connect to LLM provider")
            return Response(
                content=json.dumps({"error": {"message": "Failed to connect to LLM provider"}}),
                status_code=502,
                media_type="application/json",
            )

    async def handle_streaming_request(
        self, client: httpx.AsyncClient, method: str, url: str,
        headers: dict, body: bytes, input_context: str = "", agent_id: str = "unknown-agent"
    ) -> Response:
        """Handle streaming LLM response.

        When output scanning is ON: buffers the full response, scans it,
        then delivers or blocks based on block mode setting.

        When output scanning is OFF: streams through in real-time without scanning.
        """
        settings = await self.check_settings()
        should_scan = settings.get("scan_llm_responses")
        should_check_tools = settings.get("tool_permissions_enabled")

        if should_scan or should_check_tools:
            # Buffer full response to scan output and/or enforce tool permissions
            return await self._handle_streaming_buffered(client, method, url, headers, body, input_context, agent_id)
        else:
            # PASSTHROUGH MODE: Stream through without buffering
            return await self._handle_streaming_passthrough(client, method, url, headers, body, input_context, agent_id)

    async def _handle_streaming_buffered(
        self, client: httpx.AsyncClient, method: str, url: str,
        headers: dict, body: bytes, input_context: str = "", agent_id: str = "unknown-agent"
    ) -> Response:
        """Buffer streaming response, scan, then deliver or block."""
        accumulated_text = ""
        all_chunks = []

        settings = await self.check_settings()
        will_block = settings.get("block_threats", False)

        print("[llm-proxy] 🛡️ Buffering stream for output scan...")

        async with client.stream(method, url, headers=headers, content=body) as response:
            async for chunk in response.aiter_bytes():
                all_chunks.append(chunk)
                try:
                    chunk_str = chunk.decode("utf-8")
                    for line in chunk_str.split("\n"):
                        if line.startswith("data: ") and line != "data: [DONE]":
                            data = json.loads(line[6:])
                            text = self.extract_response_text(data)
                            if text:
                                accumulated_text += text
                except:
                    pass

        # Scan accumulated text (strip echoed sensitive tokens from input context)
        if accumulated_text:
            scan_text = self.strip_echoed_sensitive_tokens(accumulated_text, input_context)
            action = "blocked" if will_block else "logged"
            result = await self.scan_message(scan_text, is_llm_response=True, action_taken=action)
            if result.get("is_threat"):
                threat_type = result.get("threat_type", "unknown")
                risk_score = result.get("risk_score", 0)
                print(f"[llm-proxy] ⚠️ OUTPUT THREAT: {threat_type} (risk: {risk_score}%)")

                if will_block:
                    self.stats["blocked"] += 1
                    print(f"[llm-proxy] 🚫 OUTPUT BLOCKED (streamed): {threat_type} (risk: {risk_score}%)")
                    error_response = {
                        "error": {
                            "message": f"Response blocked by SecureVector: {threat_type} detected in LLM output (risk: {risk_score}%)",
                            "type": "security_error",
                            "code": "output_blocked_by_securevector",
                        }
                    }
                    return Response(
                        content=json.dumps(error_response),
                        status_code=400,
                        media_type="application/json",
                    )
            else:
                print("[llm-proxy] ✓ Output clean")

        # Tool permission enforcement on buffered stream
        if settings.get("tool_permissions_enabled"):
            from securevector.core.tool_permissions.parser import extract_tool_calls

            # Join ALL chunks before parsing — httpx may split a single SSE event
            # across multiple byte chunks, causing json.loads to fail on fragments
            full_stream = b"".join(all_chunks).decode("utf-8", errors="replace")
            found_tool_calls = []
            for line in full_stream.split("\n"):
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                try:
                    data = json.loads(line[6:])
                    found_tool_calls.extend(extract_tool_calls(data))
                except Exception:
                    continue

            if found_tool_calls:
                # Build a synthetic complete-format response so _evaluate_tool_permissions
                # can apply its full logic (rate limiting, logging, denial construction).
                # Streaming tool_use inputs may be empty ({}) since the full input arrives
                # via content_block_delta — the tool name alone is enough to block.
                is_anthropic = any(tc.provider_format == "anthropic" for tc in found_tool_calls)
                if is_anthropic:
                    synthetic = {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "tool_use",
                                "id": tc.tool_call_id or f"toolu_{i}",
                                "name": tc.function_name,
                                "input": json.loads(tc.arguments) if tc.arguments and tc.arguments != "{}" else {},
                            }
                            for i, tc in enumerate(found_tool_calls)
                        ],
                    }
                else:
                    synthetic = {
                        "choices": [{
                            "message": {
                                "role": "assistant",
                                "tool_calls": [
                                    {
                                        "id": tc.tool_call_id or f"call_{i}",
                                        "type": "function",
                                        "function": {
                                            "name": tc.function_name,
                                            "arguments": tc.arguments or "{}",
                                        },
                                    }
                                    for i, tc in enumerate(found_tool_calls)
                                ],
                            }
                        }]
                    }

                modified, blocked, _ = await self._evaluate_tool_permissions(synthetic, settings)
                if blocked:
                    # Return denial as non-streaming response — stream is already buffered
                    return Response(
                        content=json.dumps(modified).encode(),
                        status_code=200,
                        media_type="application/json",
                    )

        # Record cost from buffered stream (use last non-empty chunk that has usage data)
        if all_chunks:
            full_body = b"".join(all_chunks)
            asyncio.create_task(
                self._record_cost(self.provider, agent_id, full_body)
            )

        # Deliver buffered stream
        async def replay_chunks():
            for chunk in all_chunks:
                yield chunk

        return StreamingResponse(
            replay_chunks(),
            media_type="text/event-stream",
        )

    async def _handle_streaming_passthrough(
        self, client: httpx.AsyncClient, method: str, url: str,
        headers: dict, body: bytes, input_context: str = "",
        agent_id: str = "unknown-agent",
    ) -> StreamingResponse:
        """Stream through in real-time; record cost and scan after stream exhausts."""
        accumulated_text = ""
        all_chunks: list[bytes] = []

        async def stream_generator():
            nonlocal accumulated_text

            async with client.stream(method, url, headers=headers, content=body) as response:
                async for chunk in response.aiter_bytes():
                    all_chunks.append(chunk)
                    try:
                        chunk_str = chunk.decode("utf-8")
                        for line in chunk_str.split("\n"):
                            if line.startswith("data: ") and line != "data: [DONE]":
                                data = json.loads(line[6:])
                                text = self.extract_response_text(data)
                                if text:
                                    accumulated_text += text
                    except:
                        pass

                    yield chunk

            # After stream is fully consumed — record cost then scan
            if all_chunks:
                full_body = b"".join(all_chunks)
                asyncio.create_task(
                    self._record_cost(self.provider, agent_id, full_body)
                )

            # Scan accumulated text after stream completes (logging only)
            if accumulated_text:
                settings = await self.check_settings()
                if settings.get("scan_llm_responses"):
                    scan_text = self.strip_echoed_sensitive_tokens(accumulated_text, input_context)
                    result = await self.scan_message(scan_text, is_llm_response=True)
                    if result.get("is_threat"):
                        threat_type = result.get("threat_type", "unknown")
                        print(f"[llm-proxy] ⚠️ OUTPUT THREAT (streamed): {threat_type}")

        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream",
        )

    def create_app(self) -> FastAPI:
        """Create FastAPI application."""
        app = FastAPI(title="SecureVector LLM Proxy")

        @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
        async def proxy_all(request: Request, path: str):
            return await self.handle_request(request)

        @app.get("/")
        async def root():
            return {
                "service": "SecureVector LLM Proxy",
                "target": self.target_url,
                "stats": self.stats,
            }

        return app

    async def cleanup(self):
        """Clean up resources."""
        if self._http_client:
            await self._http_client.aclose()


class MultiProviderProxy:
    """Multi-provider proxy with path-based routing.

    Routes requests based on path prefix:
      /openai/v1/chat/completions → https://api.openai.com/v1/chat/completions
      /anthropic/v1/messages → https://api.anthropic.com/v1/messages
      /ollama/v1/chat/completions → http://localhost:11434/v1/chat/completions

    Usage:
      OPENAI_BASE_URL=http://localhost:8742/openai python app.py
      ANTHROPIC_BASE_URL=http://localhost:8742/anthropic python app.py
    """

    def __init__(
        self,
        securevector_url: str = "http://127.0.0.1:8741",
        block_threats: bool = False,
        verbose: bool = False,
    ):
        self.securevector_url = securevector_url
        self.block_threats = block_threats
        self.verbose = verbose
        self._proxies: dict[str, LLMProxy] = {}

    def get_proxy(self, provider: str) -> LLMProxy:
        """Get or create proxy for a provider."""
        if provider not in self._proxies:
            target_url = LLMProxy.PROVIDERS.get(provider)
            if not target_url:
                raise ValueError(f"Unknown provider: {provider}")

            self._proxies[provider] = LLMProxy(
                target_url=target_url,
                securevector_url=self.securevector_url,
                block_threats=self.block_threats,
                verbose=self.verbose,
                provider=provider,
                skip_url_validation=True,  # Already validated in PROVIDERS
            )
            if self.verbose:
                print(f"[multi-proxy] Created proxy for {provider} → {target_url}")

        return self._proxies[provider]

    def create_app(self) -> FastAPI:
        """Create FastAPI application with multi-provider routing."""
        app = FastAPI(title="SecureVector Multi-Provider LLM Proxy")

        @app.api_route("/{provider}/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
        async def proxy_with_provider(request: Request, provider: str, path: str):
            """Route request to appropriate provider based on path prefix."""
            # Normalize provider name (lowercase, strip spaces)
            provider = provider.lower().strip()

            if provider not in LLMProxy.PROVIDERS:
                return Response(
                    content=json.dumps({
                        "error": f"Unknown provider: {provider}",
                        "available": list(LLMProxy.PROVIDERS.keys())
                    }),
                    status_code=400,
                    media_type="application/json",
                )

            proxy = self.get_proxy(provider)

            # Normalize path: remove provider prefix, clean up any extra spaces/slashes
            # e.g., "/ollama/v1/models" → "/v1/models"
            new_path = f"/{path}".replace("  ", "/").replace(" /", "/").replace("/ ", "/")
            # Remove double slashes
            while "//" in new_path:
                new_path = new_path.replace("//", "/")

            # Create a new scope with modified path and raw_path
            scope = dict(request.scope)
            scope["path"] = new_path
            scope["raw_path"] = new_path.encode("utf-8")
            if "query_string" not in scope:
                scope["query_string"] = b""
            modified_request = Request(scope, request.receive)

            return await proxy.handle_request(modified_request)

        @app.get("/")
        async def root():
            return {
                "service": "SecureVector Multi-Provider LLM Proxy",
                "providers": list(LLMProxy.PROVIDERS.keys()),
                "usage": {
                    "openai": "OPENAI_BASE_URL=http://localhost:8742/openai/v1",
                    "anthropic": "ANTHROPIC_BASE_URL=http://localhost:8742/anthropic",
                    "ollama": "OPENAI_BASE_URL=http://localhost:8742/ollama/v1",
                },
                "active_proxies": list(self._proxies.keys()),
            }

        return app

    async def cleanup(self):
        """Clean up all proxy resources."""
        for proxy in self._proxies.values():
            await proxy.cleanup()


def print_logo():
    """Print the SecureVector ASCII art logo."""
    logo = r"""
╔═══════════════════════════════════════════════════════════════════╗
║                                                                   ║
║   ███████╗ ███████╗  ██████╗ ██╗   ██╗ ██████╗  ███████╗          ║
║   ██╔════╝ ██╔════╝ ██╔════╝ ██║   ██║ ██╔══██╗ ██╔════╝          ║
║   ███████╗ █████╗   ██║      ██║   ██║ ██████╔╝ █████╗            ║
║   ╚════██║ ██╔══╝   ██║      ██║   ██║ ██╔══██╗ ██╔══╝            ║
║   ███████║ ███████╗ ╚██████╗ ╚██████╔╝ ██║  ██║ ███████╗          ║
║   ╚══════╝ ╚══════╝  ╚═════╝  ╚═════╝  ╚═╝  ╚═╝ ╚══════╝          ║
║                                                                   ║
║      ██╗   ██╗ ███████╗  ██████╗ ████████╗  ██████╗  ██████╗      ║
║      ██║   ██║ ██╔════╝ ██╔════╝ ╚══██╔══╝ ██╔═══██╗ ██╔══██╗     ║
║      ██║   ██║ █████╗   ██║         ██║    ██║   ██║ ██████╔╝     ║
║      ╚██╗ ██╔╝ ██╔══╝   ██║         ██║    ██║   ██║ ██╔══██╗     ║
║       ╚████╔╝  ███████╗ ╚██████╗    ██║    ╚██████╔╝ ██║  ██║     ║
║        ╚═══╝   ╚══════╝  ╚═════╝    ╚═╝     ╚═════╝  ╚═╝  ╚═╝     ║
║                                                                   ║
║              Runtime Firewall for AI Agents & LLMs                ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
"""
    print(logo)


def main():
    parser = argparse.ArgumentParser(
        description="SecureVector LLM API Proxy - scans all LLM traffic for threats"
    )
    parser.add_argument(
        "--port", "-p",
        type=int,
        default=8742,
        help="Proxy listen port (default: 8742)"
    )
    parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="Proxy listen host (default: 127.0.0.1)"
    )
    parser.add_argument(
        "--provider",
        type=str,
        choices=list(LLMProxy.PROVIDERS.keys()),
        default="openai",
        help="LLM provider (default: openai). Ignored if --multi is set."
    )
    parser.add_argument(
        "--multi",
        action="store_true",
        help="Enable multi-provider mode with path-based routing"
    )
    parser.add_argument(
        "--target-url",
        type=str,
        default=None,
        help="Override target LLM API URL (single provider mode only)"
    )
    parser.add_argument(
        "--securevector-url",
        type=str,
        default="http://127.0.0.1:8741",
        help="SecureVector API URL (default: http://127.0.0.1:8741)"
    )
    parser.add_argument(
        "--block",
        action="store_true",
        help="Block detected threats (default: log only)"
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Verbose logging"
    )

    args = parser.parse_args()

    if args.multi:
        # Multi-provider mode with path-based routing
        proxy = MultiProviderProxy(
            securevector_url=args.securevector_url,
            block_threats=args.block,
            verbose=args.verbose,
        )

        providers = list(LLMProxy.PROVIDERS.keys())
        # Format providers in rows of 6
        provider_lines = []
        for i in range(0, len(providers), 6):
            row = ", ".join(providers[i:i+6])
            provider_lines.append(f"║    {row:<63}║")

        provider_block = "\n".join(provider_lines)
        print_logo()
        print(f"""
╔═══════════════════════════════════════════════════════════════════╗
║            SecureVector Multi-Provider LLM Proxy                  ║
╠═══════════════════════════════════════════════════════════════════╣
║  Listening on:      http://{args.host}:{args.port:<5}                             ║
║  SecureVector:      {args.securevector_url:<30}          ║
║  Block threats:     {str(args.block):<5}                                        ║
╠═══════════════════════════════════════════════════════════════════╣
║  Multi-provider routing enabled!                                  ║
║  All {len(providers)} providers ready — no configuration needed.              ║
║                                                                   ║
║  Usage:                                                           ║
║    base_url="http://{args.host}:{args.port}/{{provider}}/v1"                    ║
║                                                                   ║
║  Examples:                                                        ║
║    http://{args.host}:{args.port}/openai/v1     (OpenAI, LangChain)             ║
║    http://{args.host}:{args.port}/anthropic      (Anthropic/Claude)              ║
║    http://{args.host}:{args.port}/ollama/v1     (Ollama local)                  ║
║    http://{args.host}:{args.port}/groq/v1       (Groq)                          ║
║    http://{args.host}:{args.port}/deepseek/v1   (DeepSeek)                      ║
║                                                                   ║
║  All supported providers:                                         ║
{provider_block}
╚═══════════════════════════════════════════════════════════════════╝
""")
    else:
        # Single provider mode
        target_url = args.target_url
        if not target_url:
            target_url = LLMProxy.PROVIDERS.get(args.provider, "https://api.openai.com")

        # Create proxy with URL validation
        try:
            proxy = LLMProxy(
                target_url=target_url,
                securevector_url=args.securevector_url,
                block_threats=args.block,
                verbose=args.verbose,
                provider=args.provider,
            )
        except ValueError as e:
            print(f"\n[ERROR] {e}")
            print("\nFor custom URLs, ensure the host is in the allowed list.")
            print("Known LLM providers are automatically allowed.")
            sys.exit(1)

        print_logo()
        print(f"""
╔═══════════════════════════════════════════════════════════════╗
║                 SecureVector LLM Proxy                        ║
╠═══════════════════════════════════════════════════════════════╣
║  Listening on:         http://{args.host}:{args.port:<5}                      ║
║  Forwarding to:        {proxy.target_url[:35]:<35} ║
║  SecureVector:         {args.securevector_url:<25}       ║
║  Block threats:        {str(args.block):<5}                                 ║
╠═══════════════════════════════════════════════════════════════╣
║  Start OpenClaw with:                                         ║
║    OPENAI_BASE_URL=http://{args.host}:{args.port} openclaw gateway          ║
║                                                               ║
║  For Anthropic:                                               ║
║    ANTHROPIC_BASE_URL=http://{args.host}:{args.port} openclaw gateway       ║
╚═══════════════════════════════════════════════════════════════╝
""")

    app = proxy.create_app()

    try:
        uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    except KeyboardInterrupt:
        print("\n[llm-proxy] Shutting down...")
    finally:
        asyncio.run(proxy.cleanup())


if __name__ == "__main__":
    main()
