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


# Security: Allowed hosts for target URLs (prevents SSRF to internal services)
ALLOWED_TARGET_HOSTS = {
    # Known LLM providers
    "api.openai.com",
    "api.anthropic.com",
    "api.groq.com",
    "openrouter.ai",
    "api.cerebras.ai",
    "api.mistral.ai",
    "api.x.ai",
    "generativelanguage.googleapis.com",
    "api.moonshot.ai",
    "api.minimax.chat",
    "api.deepseek.com",
    "api.together.xyz",
    "api.fireworks.ai",
    "api.perplexity.ai",
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

    # Allow any Azure OpenAI endpoint (*.openai.azure.com)
    if hostname.endswith(".openai.azure.com"):
        return url

    # Allow any local network for Ollama/LM Studio (user's choice)
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
        "ollama": "http://localhost:11434",
        "groq": "https://api.groq.com/openai",
        "openrouter": "https://openrouter.ai/api",
        "cerebras": "https://api.cerebras.ai",
        "mistral": "https://api.mistral.ai",
        "xai": "https://api.x.ai",
        "gemini": "https://generativelanguage.googleapis.com",
        "azure": "https://YOUR-RESOURCE.openai.azure.com",
        "lmstudio": "http://localhost:1234",
        "litellm": "http://localhost:4000",
        "moonshot": "https://api.moonshot.ai",
        "minimax": "https://api.minimax.chat",
        "deepseek": "https://api.deepseek.com",
        "together": "https://api.together.xyz",
        "fireworks": "https://api.fireworks.ai/inference",
        "perplexity": "https://api.perplexity.ai",
        "cohere": "https://api.cohere.ai",
    }

    # API version prefix each provider expects (auto-prepended if missing from request)
    API_PREFIXES = {
        "openai": "/v1",
        "anthropic": "",
        "ollama": "/v1",
        "groq": "/v1",
        "openrouter": "/v1",
        "cerebras": "/v1",
        "mistral": "/v1",
        "xai": "/v1",
        "gemini": "/v1beta",
        "azure": "",
        "lmstudio": "/v1",
        "litellm": "/v1",
        "moonshot": "/v1",
        "minimax": "/v1",
        "deepseek": "/v1",
        "together": "/v1",
        "fireworks": "/v1",
        "perplexity": "/v1",
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
        self._settings_checked_at: float = 0

    def _truncate(self, text: str, max_len: int = 100) -> str:
        """Truncate text for logging."""
        if len(text) <= max_len:
            return text
        return text[:max_len] + f"... ({len(text)} chars)"

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
            }

        try:
            client = await self.get_http_client()
            response = await client.get(self.settings_url)
            if response.status_code == 200:
                settings = response.json()
                self._output_scan_enabled = settings.get("scan_llm_responses", True)
                self._block_threats_enabled = settings.get("block_threats", False)
                self._settings_checked_at = now
                return {
                    "scan_llm_responses": self._output_scan_enabled,
                    "block_threats": self._block_threats_enabled,
                }
        except Exception as e:
            if self.verbose:
                logger.warning(f"Could not check settings: {e}")

        return {"scan_llm_responses": True, "block_threats": self.block_threats}

    async def scan_message(self, text: str, is_llm_response: bool = False, action_taken: str = "logged") -> dict:
        """Scan a message with SecureVector API.

        On scan failure: if block mode is ON, fails closed (treats as threat)
        to prevent unscanned content from passing through. If block mode is
        OFF, fails open (treats as clean) for availability.
        """
        if not text:
            return {"is_threat": False}

        scan_payload = {
            "text": text,
            "llm_response": is_llm_response,
            "metadata": {
                "source": "llm-proxy",
                "target": self.target_url,
                "scan_type": "output" if is_llm_response else "input",
                "action_taken": action_taken,
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
                    timeout=5.0,
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
        body_text = body_bytes.decode("utf-8") if body_bytes else ""

        print(f"[llm-proxy] → {method} {path}")

        # Parse body for scanning
        body_dict = {}
        if body_text:
            try:
                body_dict = json.loads(body_text)
            except json.JSONDecodeError:
                pass

        # Scan input messages
        if body_dict and method == "POST":
            input_text = self.extract_messages_text(body_dict)
            if input_text:
                self.stats["scanned"] += 1
                preview = input_text[:80].replace('\n', ' ')
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

        # Auto-prepend API version prefix if missing from path
        # e.g. /responses → /v1/responses for OpenAI
        if self.api_prefix and not path.startswith(self.api_prefix):
            path = self.api_prefix + path
            if self.verbose:
                print(f"[llm-proxy] Auto-prepended {self.api_prefix} → {path}")

        # Forward request to LLM provider
        target = f"{self.target_url}{path}"
        if request.url.query:
            target += f"?{request.url.query}"

        try:
            client = await self.get_http_client()

            # Check if streaming
            is_streaming = body_dict.get("stream", False)

            if is_streaming:
                # Handle streaming response
                return await self.handle_streaming_request(
                    client, method, target, headers, body_bytes
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
                                will_block = settings.get("block_threats", False)
                                action = "blocked" if will_block else "logged"
                                result = await self.scan_message(output_text, is_llm_response=True, action_taken=action)
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
                    except json.JSONDecodeError:
                        pass

                return Response(
                    content=response.content,
                    status_code=response.status_code,
                    headers=dict(response.headers),
                )

        except httpx.RequestError as e:
            logger.error(f"[llm-proxy] Request error: {e}")
            return Response(
                content=json.dumps({"error": {"message": "Failed to connect to LLM provider"}}),
                status_code=502,
                media_type="application/json",
            )

    async def handle_streaming_request(
        self, client: httpx.AsyncClient, method: str, url: str,
        headers: dict, body: bytes
    ) -> Response:
        """Handle streaming LLM response.

        When output scanning is ON: buffers the full response, scans it,
        then delivers or blocks based on block mode setting.

        When output scanning is OFF: streams through in real-time without scanning.
        """
        settings = await self.check_settings()
        should_scan = settings.get("scan_llm_responses")

        if should_scan:
            # SCAN MODE: Buffer full response, scan, then deliver or block
            return await self._handle_streaming_buffered(client, method, url, headers, body)
        else:
            # PASSTHROUGH MODE: Stream through without scanning
            return await self._handle_streaming_passthrough(client, method, url, headers, body)

    async def _handle_streaming_buffered(
        self, client: httpx.AsyncClient, method: str, url: str,
        headers: dict, body: bytes
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

        # Scan accumulated text
        if accumulated_text:
            action = "blocked" if will_block else "logged"
            result = await self.scan_message(accumulated_text, is_llm_response=True, action_taken=action)
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
        headers: dict, body: bytes
    ) -> StreamingResponse:
        """Stream through in real-time, scan at end for logging."""
        accumulated_text = ""

        async def stream_generator():
            nonlocal accumulated_text

            async with client.stream(method, url, headers=headers, content=body) as response:
                async for chunk in response.aiter_bytes():
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

            # Scan accumulated text after stream completes (logging only)
            if accumulated_text:
                settings = await self.check_settings()
                if settings.get("scan_llm_responses"):
                    result = await self.scan_message(accumulated_text, is_llm_response=True)
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

        providers_list = ", ".join(LLMProxy.PROVIDERS.keys())
        print(f"""
╔═══════════════════════════════════════════════════════════════════╗
║            SecureVector Multi-Provider LLM Proxy                  ║
╠═══════════════════════════════════════════════════════════════════╣
║  Listening on:      http://{args.host}:{args.port:<5}                             ║
║  SecureVector:      {args.securevector_url:<30}          ║
║  Block threats:     {str(args.block):<5}                                        ║
╠═══════════════════════════════════════════════════════════════════╣
║  Multi-provider routing enabled!                                  ║
║                                                                   ║
║  LangChain / Any OpenAI-compatible:                               ║
║    base_url="http://{args.host}:{args.port}/openai/v1"                        ║
║    base_url="http://{args.host}:{args.port}/ollama/v1"                        ║
║    base_url="http://{args.host}:{args.port}/groq/v1"                          ║
║                                                                   ║
║  Anthropic:                                                       ║
║    base_url="http://{args.host}:{args.port}/anthropic"                        ║
║                                                                   ║
║  Available providers: {providers_list[:45]:<45}║
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
